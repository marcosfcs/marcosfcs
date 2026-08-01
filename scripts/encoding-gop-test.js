/**
 * Teste headless dos parsers de codificação de vídeo (keyframe/GOP) de
 * public/js/container.js — sem navegador, sem mídia real. Roda com
 * `node scripts/encoding-gop-test.js`.
 *
 * Constrói buffers sintéticos (um fragmento fMP4 moof/traf/tfhd/trun, e um
 * clipe MPEG-TS mínimo) com valores conhecidos à mão e confere que
 * parseFmp4MediaSegment/parseTsVideoFrames/computeGopStats produzem
 * exatamente o esperado — é a única forma de validar a matemática de
 * offset/flags de box, já que este ambiente não decodifica vídeo real.
 */
'use strict';

global.window = {};
require(require('path').join(__dirname, '..', 'public', 'js', 'container.js'));
const C = window.StreamContainer;

let fails = 0;
function check(name, cond) {
  if (!cond) { fails++; console.log(`FALHOU: ${name}`); }
  else console.log(`ok: ${name}`);
}

function box(type, body) {
  const buf = Buffer.alloc(8 + body.length);
  buf.writeUInt32BE(8 + body.length, 0);
  buf.write(type, 4, 'ascii');
  body.copy(buf, 8);
  return buf;
}
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }
function toArrayBuffer(buf) { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length); }

// Padrão comum aos dois testes: K,P,P,K,P,P — 2 keyframes, 1 GOP de 3 frames medido.
const PATTERN = [
  { size: 5000, keyframe: true }, { size: 800, keyframe: false }, { size: 800, keyframe: false },
  { size: 5000, keyframe: true }, { size: 800, keyframe: false }, { size: 800, keyframe: false },
];

console.log('=== fMP4 fragmentado (moof/traf/tfhd/trun) ===');
{
  const tfhd = box('tfhd', Buffer.concat([u32(0x00000038), u32(1), u32(1001), u32(1000), u32(0x01000000)]));
  const trunBody = [u32(0x00000700), u32(PATTERN.length)];
  for (const s of PATTERN) trunBody.push(u32(1001), u32(s.size), u32(s.keyframe ? 0x02000000 : 0x01000000));
  const trun = box('trun', Buffer.concat(trunBody));
  const traf = box('traf', Buffer.concat([tfhd, trun]));
  const moof = box('moof', traf);

  const samples = C.parseFmp4MediaSegment(toArrayBuffer(moof), 1);
  const stats = C.computeGopStats(samples, 30000);

  check('6 amostras extraídas', samples.length === 6);
  check('keyframes nas posições certas (0 e 3)', samples[0].keyframe && samples[3].keyframe &&
    !samples[1].keyframe && !samples[2].keyframe && !samples[4].keyframe && !samples[5].keyframe);
  check('startsWithKeyframe === true', stats.startsWithKeyframe === true);
  check('gopCount === 1, avgGopFrames === 3', stats.gopCount === 1 && stats.avgGopFrames === 3);
  check('avgGopSeconds ≈ 0,1001 (3×1001/30000)', Math.abs(stats.avgGopSeconds - 0.1001) < 1e-6);
  check('avgKeyframeSize === 5000, avgNonKeyframeSize === 800',
    stats.avgKeyframeSize === 5000 && stats.avgNonKeyframeSize === 800);
  check('track_ID diferente descarta a amostra (filtro de track)',
    C.parseFmp4MediaSegment(toArrayBuffer(moof), 999).length === 0);
}

console.log('\n=== MPEG-TS (PUSI + random_access_indicator + PTS) ===');
{
  function writePts5(pts, leadingNibble) {
    const high = Math.floor(pts / 1073741824) & 0x07;
    const mid = Math.floor((pts % 1073741824) / 32768) & 0x7fff;
    const low = pts % 32768;
    return Buffer.from([
      (leadingNibble << 4) | (high << 1) | 1,
      (mid >> 7) & 0xff, ((mid & 0x7f) << 1) | 1,
      (low >> 7) & 0xff, ((low & 0x7f) << 1) | 1,
    ]);
  }
  const PID = 0x100;
  function tsPacket({ afc, randomAccess, continuity, payload }) {
    const pkt = Buffer.alloc(188, 0xff);
    pkt[0] = 0x47;
    pkt[1] = 0x40 | ((PID >> 8) & 0x1f); // PUSI sempre setado (1 pacote = 1 "frame" neste teste)
    pkt[2] = PID & 0xff;
    pkt[3] = (afc << 4) | (continuity & 0x0f);
    let p = 4;
    if (afc === 2 || afc === 3) { pkt[4] = 1; pkt[5] = randomAccess ? 0x40 : 0x00; p = 6; }
    if (afc !== 2 && payload) payload.copy(pkt, p);
    return pkt;
  }
  function pesHeader(pts) {
    return Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0xE0, 0x00, 0x00, 0x80, 0x80, 0x05]), writePts5(pts, 0x2)]);
  }
  const pts = [90000, 93000, 96000, 99000, 102000, 105000];
  const packets = PATTERN.map((f, i) => tsPacket({
    afc: f.keyframe ? 3 : 1, randomAccess: f.keyframe, continuity: i, payload: pesHeader(pts[i]),
  }));
  const buf = Buffer.concat(packets);

  const frames = C.parseTsVideoFrames(toArrayBuffer(buf), PID);
  const samples = C.framesToSamples(frames);
  const stats = C.computeGopStats(samples, 90000);

  check('6 frames extraídos do PID de vídeo', frames.length === 6);
  check('PTS decodificado corretamente (90000, depois 93000...)', frames[0].pts === 90000 && frames[1].pts === 93000);
  check('keyframeCount === 2 via random_access_indicator', stats.keyframeCount === 2);
  check('gopCount === 1, avgGopFrames === 3', stats.gopCount === 1 && stats.avgGopFrames === 3);
  check('avgGopSeconds === 0,1 (9000 ticks / 90000 Hz)', Math.abs(stats.avgGopSeconds - 0.1) < 1e-9);
  check('tamanho de payload exclui overhead de TS/adaptation field (182 vs 184 bytes)',
    samples[0].size === 182 && samples[1].size === 184);
}

console.log(`\n${fails === 0 ? 'TODOS OS TESTES PASSARAM' : fails + ' TESTE(S) FALHARAM'}`);
process.exit(fails === 0 ? 0 : 1);
