/**
 * Espaço de cor REALMENTE decodificado, via WebCodecs (MediaStreamTrackProcessor).
 *
 * Diferente dos histogramas de analyzer.js (que leem um canvas 2D 8-bit já
 * tone-mapped pelo navegador), aqui lemos o VideoFrame como o decodificador
 * de fato produziu — primaries/transfer/matrix/fullRange corretos, sem
 * intermediário de canvas. É a confirmação mais forte de HDR real vs. o
 * que o manifest apenas declara.
 *
 * Além do painel de metadados, este módulo também extrai uma amostra real de
 * pixels (via `frame.copyTo()`) para alimentar o diagrama de cromaticidade —
 * o canvas 2D usado em analyzer.js/chromaticity.js sempre entrega bytes já
 * convertidos para sRGB pelo compositor do navegador, então qualquer conteúdo
 * HDR/wide-gamut aparece preso dentro do triângulo Rec.709 ali, não importa a
 * matriz de conversão usada depois. Amostrando o VideoFrame bruto e aplicando
 * a matriz YUV→RGB, a EOTF inversa e a matriz de primárias→XYZ corretas (a
 * partir do `colorSpace` real do frame), os pontos refletem o gamut de
 * verdade do conteúdo decodificado.
 *
 * Limitação: MediaStreamTrackProcessor é Chromium-only no momento — feature
 * detection explícito, com nota de indisponibilidade nos demais navegadores
 * (mesmo padrão de honestidade usado no resto do projeto).
 */
'use strict';

const TRANSFER_NAMES = {
  'bt709': 'BT.709 (SDR)', 'smpte170m': 'BT.601 (SDR)', 'bt470bg': 'BT.601 PAL (SDR)',
  'pq': 'PQ / SMPTE 2084 (HDR10)', 'hlg': 'HLG (HDR)', 'linear': 'Linear', 'iec61966-2-1': 'sRGB',
};
const PRIMARIES_NAMES = {
  'bt709': 'BT.709', 'bt470bg': 'BT.601 PAL', 'smpte170m': 'BT.601 NTSC', 'bt2020': 'BT.2020/BT.2100',
  'smpte432': 'DCI-P3 (D65)',
};
const MATRIX_NAMES = { 'rgb': 'RGB', 'bt709': 'BT.709', 'bt470bg': 'BT.601', 'smpte170m': 'BT.601', 'bt2020-ncl': 'BT.2020 NCL' };

/* ================================================================ *
 * Conversão de cor a partir do VideoFrame bruto (sem canvas)
 * ================================================================ */

/** Coeficientes Kr/Kb da matriz YUV→RGB por VideoMatrixCoefficients. */
const YUV_KRB = {
  'bt709': { kr: 0.2126, kb: 0.0722 },
  'bt470bg': { kr: 0.299, kb: 0.114 },
  'smpte170m': { kr: 0.299, kb: 0.114 },
  'bt2020-ncl': { kr: 0.2627, kb: 0.0593 },
};

/** Matrizes RGB linear (primárias reais) → XYZ (D65), por VideoColorPrimaries. */
const PRIMARIES_TO_XYZ = {
  'bt709': [
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.0721750],
    [0.0193339, 0.1191920, 0.9503041],
  ],
  'smpte432': [ // DCI-P3 D65
    [0.4865709, 0.2656677, 0.1982173],
    [0.2289746, 0.6917385, 0.0792869],
    [0.0000000, 0.0451134, 1.0439444],
  ],
  'bt2020': [
    [0.6369580, 0.1446169, 0.1688810],
    [0.2627002, 0.6779981, 0.0593017],
    [0.0000000, 0.0280727, 1.0609851],
  ],
};

function bt709InverseOetf(v) {
  return v < 0.081 ? v / 4.5 : Math.pow((v + 0.099) / 1.099, 1 / 0.45);
}
function srgbInverseEotf(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function pqInverseEotf(v) {
  const m1 = 0.1593017578125, m2 = 78.84375, c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875;
  const vp = Math.pow(Math.max(v, 0), 1 / m2);
  const num = Math.max(vp - c1, 0);
  const den = c2 - c3 * vp;
  return den <= 0 ? 0 : Math.pow(num / den, 1 / m1);
}
function hlgInverseOetf(v) {
  const a = 0.17883277, b = 1 - 4 * a, c = 0.5 - a * Math.log(4 * a);
  return v <= 0.5 ? (v * v) / 3 : (Math.exp((v - c) / a) + b) / 12;
}
function inverseEotfFor(transfer) {
  if (transfer === 'pq') return pqInverseEotf;
  if (transfer === 'hlg') return hlgInverseOetf;
  if (transfer === 'iec61966-2-1' || transfer === 'linear') return transfer === 'linear' ? (v) => v : srgbInverseEotf;
  return bt709InverseOetf; // bt709 / smpte170m / bt470bg / desconhecido — curva mais próxima
}
function linearToSrgb8(v) {
  const c = Math.min(1, Math.max(0, v));
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, s)) * 255);
}

/* ---------------------------------------------------------------- *
 * Linear (primárias do conteúdo) → cor de tela
 *
 * O que faltava aqui antes: a cor do ponto era `linearToSrgb8(R)` direto
 * sobre o valor linear NAS PRIMÁRIAS DO CONTEÚDO, sem normalizar a
 * luminância absoluta do PQ nem converter as primárias. Dois efeitos:
 *
 *  1. PQ é normalizado com 1.0 = 10.000 nits, mas o branco difuso do HDR10
 *     é 203 nits (ITU-R BT.2408) = 0,0203 linear → renderizava como RGB 39,
 *     quase preto. Uma cena HDR10 inteira cabia entre RGB 0 e 56.
 *  2. Sem a matriz de primárias, Rec.2020 (0,1,0) saía igual a sRGB
 *     (0,255,0) — gamut largo ficava visualmente idêntico a Rec.709.
 * ---------------------------------------------------------------- */

/** XYZ (D65) → RGB linear do espaço de saída. */
const XYZ_TO_OUT = {
  'srgb': [
    [3.2404542, -1.5371385, -0.4985314],
    [-0.9692660, 1.8760108, 0.0415560],
    [0.0556434, -0.2040259, 1.0572252],
  ],
  'display-p3': [
    [2.4934969, -0.9313836, -0.4027108],
    [-0.8294890, 1.7626641, 0.0236247],
    [0.0358458, -0.0761724, 0.9568845],
  ],
};

const HDR_REF_WHITE_NITS = 203;       // branco difuso HDR, ITU-R BT.2408
const HLG_DIFFUSE_LINEAR = 0.26496;   // hlgInverseOetf(0.75)
const TONEMAP_LW = 20;                // joelho ~4000 nits acima do branco de referência

/**
 * Ganho para levar o linear do conteúdo a display-referred (1.0 = branco difuso).
 * SDR já é display-referred por definição — daí o ganho 1.
 */
function hdrGainFor(transfer) {
  if (transfer === 'pq') return 10000 / HDR_REF_WHITE_NITS;
  if (transfer === 'hlg') return 1 / HLG_DIFFUSE_LINEAR;
  return 1;
}

/**
 * Cor fora do gamut de saída chega aqui com canal negativo. Em vez de
 * grampear em 0 (que torce o matiz), puxa a cor em direção ao eixo
 * acromático até o canal mais negativo encostar em zero — mantém o matiz e
 * só perde saturação, que é o compromisso certo para um diagrama de gamut.
 */
function desaturateIntoGamut(rgb) {
  const min = Math.min(rgb[0], rgb[1], rgb[2]);
  if (min >= 0) return rgb;
  const w = Math.max(0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2], 1e-6);
  const t = w / (w - min);
  return [w + (rgb[0] - w) * t, w + (rgb[1] - w) * t, w + (rgb[2] - w) * t];
}

/** Reinhard estendido: comprime realces sem grampear tudo em branco. */
function reinhardExt(L, Lw) {
  return L * (1 + L / (Lw * Lw)) / (1 + L);
}

/**
 * R,G,B lineares nas primárias do conteúdo → [r,g,b] 0-255 no espaço de saída.
 *
 * `mode`:
 *   'tonemap' — parece o vídeo (curva de tom fixa, estável entre frames).
 *   'vivid'   — normaliza pelo canal máximo, brilho total. A luminância real
 *               já está no eixo Y do gráfico 3D, então aqui a cor pode se
 *               dedicar só a mostrar cromaticidade/gamut.
 *
 * A curva de tom só entra em PQ/HLG: aplicá-la em SDR escureceria o que já
 * funciona (branco Rec.709 viraria 188 em vez de 255).
 */
function contentLinearToDisplay8(R, G, B, opts) {
  const o = opts || {};
  const out = XYZ_TO_OUT[o.out] ? o.out : 'srgb';
  const primMatrix = PRIMARIES_TO_XYZ[o.primaries] || PRIMARIES_TO_XYZ['bt709'];
  const gain = hdrGainFor(o.transfer);
  const isHdr = o.transfer === 'pq' || o.transfer === 'hlg';

  const lr = R * gain, lg = G * gain, lb = B * gain;
  const X = primMatrix[0][0] * lr + primMatrix[0][1] * lg + primMatrix[0][2] * lb;
  const Y = primMatrix[1][0] * lr + primMatrix[1][1] * lg + primMatrix[1][2] * lb;
  const Z = primMatrix[2][0] * lr + primMatrix[2][1] * lg + primMatrix[2][2] * lb;

  const M = XYZ_TO_OUT[out];
  let rgb = desaturateIntoGamut([
    M[0][0] * X + M[0][1] * Y + M[0][2] * Z,
    M[1][0] * X + M[1][1] * Y + M[1][2] * Z,
    M[2][0] * X + M[2][1] * Y + M[2][2] * Z,
  ]);

  const max = Math.max(rgb[0], rgb[1], rgb[2]);
  if (o.mode === 'vivid') {
    if (max > 1e-9) rgb = rgb.map((c) => c / max);
  } else if (isHdr && max > 0) {
    const s = reinhardExt(max, TONEMAP_LW) / max;
    rgb = rgb.map((c) => c * s);
  }

  return [
    linearToSrgb8(rgb[0]),
    linearToSrgb8(rgb[1]),
    linearToSrgb8(rgb[2]),
  ];
}

/**
 * Layout de planos suportado por `frame.format` (WebCodecs `VideoPixelFormat`).
 * Formatos "P10"/"P12" (comuns em HDR10 real — o decoder frequentemente NÃO
 * reduz a 8 bits) guardam cada amostra em 16 bits (little-endian), valor nos
 * bits baixos — por isso são tratados à parte, com `bitDepth` e leitura de
 * 2 bytes/amostra em vez de 1.
 */
const PLANAR_YUV_BASE = new Set(['I420', 'I422', 'I444']);
const NV_FORMATS = new Set(['NV12']);
const PACKED_RGB_FORMATS = { RGBA: 'rgb', RGBX: 'rgb', BGRA: 'bgr', BGRX: 'bgr' };

/**
 * Detecta formato base (I420/I422/I444) + profundidade de bits (8/10/12) a
 * partir do nome WebCodecs — cobre também as variantes com plano alfa
 * (I420A/I422A/I444A: plano extra à parte, não afeta o layout luma/croma
 * que lemos aqui) e P10/P12 (comuns em HDR10 real).
 */
function parsePlanarFormat(format) {
  const m = /^(I420|I422|I444)(A)?(P(10|12))?$/.exec(format);
  if (!m) return null;
  return { base: m[1], bitDepth: m[4] ? Number(m[4]) : 8 };
}

/**
 * Amostra ~`count` posições espalhadas pelo frame bruto e converte cada uma
 * para xy de cromaticidade usando a matriz/EOTF/primárias REAIS do frame.
 * Retorna { supported, points }. `supported=false` quando o formato do
 * frame não é um dos suportados (fallback explícito, sem tentar adivinhar).
 */
async function samplePixelsFromFrame(frame, cs, count, opts) {
  const format = frame.format;
  if (!format) return { supported: false, points: [] };
  const outSpace = opts && opts.output === 'display-p3' ? 'display-p3' : 'srgb';
  const gain = hdrGainFor(cs.transfer);

  const planarInfo = PLANAR_YUV_BASE.has(format) ? { base: format, bitDepth: 8 } : parsePlanarFormat(format);
  const isPlanarYuv = !!planarInfo && PLANAR_YUV_BASE.has(planarInfo.base);
  const isNv = NV_FORMATS.has(format);
  const rgbOrder = PACKED_RGB_FORMATS[format];
  if (!isPlanarYuv && !isNv && !rgbOrder) return { supported: false, points: [] };
  const bitDepth = isPlanarYuv ? planarInfo.bitDepth : 8;
  const maxVal = Math.pow(2, bitDepth) - 1;
  const bytesPerSample = bitDepth > 8 ? 2 : 1;
  const readSample = bytesPerSample === 2
    ? (off) => buf[off] | (buf[off + 1] << 8)
    : (off) => buf[off];

  let layout;
  let buf;
  try {
    const size = frame.allocationSize();
    buf = new Uint8Array(size);
    layout = await frame.copyTo(buf);
  } catch (e) {
    return { supported: false, points: [] };
  }

  const vr = frame.visibleRect || { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
  const fullRange = !!cs.fullRange;
  const krb = YUV_KRB[cs.matrix] || YUV_KRB['bt709'];
  const primMatrix = PRIMARIES_TO_XYZ[cs.primaries] || PRIMARIES_TO_XYZ['bt709'];
  const toLinear = inverseEotfFor(cs.transfer);

  const points = [];
  const cols = Math.ceil(Math.sqrt(count * (vr.width / vr.height || 1)));
  const rows = Math.max(1, Math.round(count / cols));
  const stepX = Math.max(1, Math.floor(vr.width / cols));
  const stepY = Math.max(1, Math.floor(vr.height / rows));

  for (let py = 0; py < vr.height; py += stepY) {
    for (let px = 0; px < vr.width; px += stepX) {
      const cx = vr.x + px, cy = vr.y + py;
      let rS, gS, bS; // sinal normalizado 0..1, ainda no domínio gamma do transfer do frame

      if (rgbOrder) {
        const pl = layout[0];
        const off = pl.offset + cy * pl.stride + cx * 4;
        if (rgbOrder === 'rgb') { rS = buf[off] / 255; gS = buf[off + 1] / 255; bS = buf[off + 2] / 255; }
        else { bS = buf[off] / 255; gS = buf[off + 1] / 255; rS = buf[off + 2] / 255; }
      } else {
        const yPl = layout[0];
        const Y = readSample(yPl.offset + cy * yPl.stride + cx * bytesPerSample);
        let U, V;
        if (isNv) {
          const uvPl = layout[1];
          const ccx = px >> 1, ccy = py >> 1;
          const off = uvPl.offset + ccy * uvPl.stride + ccx * 2 * bytesPerSample;
          U = readSample(off); V = readSample(off + bytesPerSample);
        } else {
          const uPl = layout[1], vPl = layout[2];
          const ccx = planarInfo.base === 'I444' ? px : px >> 1;
          const ccy = planarInfo.base === 'I422' || planarInfo.base === 'I444' ? py : py >> 1;
          U = readSample(uPl.offset + ccy * uPl.stride + ccx * bytesPerSample);
          V = readSample(vPl.offset + ccy * vPl.stride + ccx * bytesPerSample);
        }
        // normaliza para faixa (escalando black/white/meio de acordo com a
        // profundidade de bits real) e converte YUV -> RGB (ainda no domínio
        // gamma do transfer do frame)
        const rangeScale = (maxVal + 1) / 256;
        const mid = 128 * rangeScale;
        let yN, uN, vN;
        if (fullRange) { yN = Y / maxVal; uN = (U - mid) / maxVal; vN = (V - mid) / maxVal; }
        else {
          yN = (Y - 16 * rangeScale) / (219 * rangeScale);
          uN = (U - mid) / (224 * rangeScale);
          vN = (V - mid) / (224 * rangeScale);
        }
        const kg = 1 - krb.kr - krb.kb;
        const rN = yN + 2 * (1 - krb.kr) * vN;
        const bN = yN + 2 * (1 - krb.kb) * uN;
        const gN = (yN - krb.kr * rN - krb.kb * bN) / kg;
        // sem requantizar para 8 bits aqui: preserva os 10/12 bits reais lidos acima
        rS = Math.min(1, Math.max(0, rN));
        gS = Math.min(1, Math.max(0, gN));
        bS = Math.min(1, Math.max(0, bN));
      }

      // linearizar com a EOTF inversa real (sRGB/bt709/PQ/HLG) — ainda em
      // escala absoluta de cena (1,0 do PQ = 10000 cd/m², etc.)
      const R = toLinear(rS), G = toLinear(gS), B = toLinear(bS);

      // ganho de PQ/HLG -> luz referida ao display (branco difuso = 1,0),
      // aplicado ANTES de projetar em XYZ: x,y não mudam (invariante de
      // escala), mas Y (luminância, eixo do gráfico 3D) passa a refletir o
      // brilho de exibição em vez de ficar achatado perto de zero
      const gR = R * gain, gG = G * gain, gB = B * gain;
      const [mx, my, mz] = primMatrix;
      const X = mx[0] * gR + mx[1] * gG + mx[2] * gB;
      const Yl = my[0] * gR + my[1] * gG + my[2] * gB;
      const Z = mz[0] * gR + mz[1] * gG + mz[2] * gB;
      const sum = X + Yl + Z;
      if (sum < 1e-6) continue;
      // calcula os dois modos de cor de uma vez (custo desprezível p/ ~400
      // pontos) — o alternador de "tom mapeado"/"saturação máxima" no card
      // troca instantaneamente sem esperar a próxima amostragem (~1,5s)
      const [tr, tg, tb] = contentLinearToDisplay8(R, G, B, { primaries: cs.primaries, transfer: cs.transfer, out: 'srgb', mode: 'tonemap' });
      const [vr, vg, vb] = contentLinearToDisplay8(R, G, B, { primaries: cs.primaries, transfer: cs.transfer, out: 'srgb', mode: 'vivid' });
      const point = {
        x: X / sum, y: Yl / sum, Y: Math.min(1, Math.max(0, Yl)),
        r: tr, g: tg, b: tb,
        vivid: { r: vr, g: vg, b: vb },
      };
      if (outSpace === 'display-p3') {
        const [ptr, ptg, ptb] = contentLinearToDisplay8(R, G, B, { primaries: cs.primaries, transfer: cs.transfer, out: 'display-p3', mode: 'tonemap' });
        const [pvr, pvg, pvb] = contentLinearToDisplay8(R, G, B, { primaries: cs.primaries, transfer: cs.transfer, out: 'display-p3', mode: 'vivid' });
        point.disp = {
          tonemap: { r: ptr / 255, g: ptg / 255, b: ptb / 255 },
          vivid: { r: pvr / 255, g: pvg / 255, b: pvb / 255 },
          space: 'display-p3',
        };
      }
      points.push(point);
      if (points.length >= count) break;
    }
    if (points.length >= count) break;
  }
  return { supported: true, points };
}

/**
 * Fallback intermediário: quando o formato bruto do frame não é um dos
 * suportados acima, em vez de desistir direto para o canvas 2D sRGB, pede
 * ao PRÓPRIO navegador pra converter YUV→RGBA já no espaço de saída
 * desejado (suportado no Chrome). Ganha-se Display-P3 8-bit em vez de cair
 * até sRGB — mas o resultado JÁ passou pelo tone-mapping do navegador, não
 * é o dado mestre, então não normalizamos luminância de novo em cima (isso
 * seria uma dupla correção). Método fica marcado como 'rgba-p3'/'rgba-srgb'
 * pro note de diagnóstico avisar que a leitura não é a bruta.
 */
async function samplePixelsViaConversion(frame, count, output) {
  const space = output === 'display-p3' ? 'display-p3' : 'srgb';
  const copyOpts = { format: 'RGBA', colorSpace: space };
  let buf, layout;
  try {
    buf = new Uint8Array(frame.allocationSize(copyOpts));
    layout = await frame.copyTo(buf, copyOpts);
  } catch (e) {
    return { supported: false, points: [], method: 'none' };
  }
  const primKey = space === 'display-p3' ? 'smpte432' : 'bt709';
  const primMatrix = PRIMARIES_TO_XYZ[primKey];
  const vr = frame.visibleRect || { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
  const pl = layout[0];
  const points = [];
  const cols = Math.ceil(Math.sqrt(count * (vr.width / vr.height || 1)));
  const rows = Math.max(1, Math.round(count / cols));
  const stepX = Math.max(1, Math.floor(vr.width / cols));
  const stepY = Math.max(1, Math.floor(vr.height / rows));

  for (let py = 0; py < vr.height; py += stepY) {
    for (let px = 0; px < vr.width; px += stepX) {
      const off = pl.offset + (vr.y + py) * pl.stride + (vr.x + px) * 4;
      // já veio 8-bit gamma-encoded no espaço de saída (mesma OETF do sRGB
      // vale p/ display-p3) — sem EOTF de PQ/HLG pra desfazer aqui, o
      // navegador já tone-mapeou pra SDR na conversão
      const R = srgbInverseEotf(buf[off] / 255), G = srgbInverseEotf(buf[off + 1] / 255), B = srgbInverseEotf(buf[off + 2] / 255);
      const X = primMatrix[0][0] * R + primMatrix[0][1] * G + primMatrix[0][2] * B;
      const Yl = primMatrix[1][0] * R + primMatrix[1][1] * G + primMatrix[1][2] * B;
      const Z = primMatrix[2][0] * R + primMatrix[2][1] * G + primMatrix[2][2] * B;
      const sum = X + Yl + Z;
      if (sum < 1e-6) continue;
      const point = {
        x: X / sum, y: Yl / sum, Y: Math.min(1, Math.max(0, Yl)),
        r: buf[off], g: buf[off + 1], b: buf[off + 2],
        vivid: { r: buf[off], g: buf[off + 1], b: buf[off + 2] }, // já vem tone-mapped: sem 2º modo real
      };
      if (space === 'display-p3') {
        const disp = { r: buf[off] / 255, g: buf[off + 1] / 255, b: buf[off + 2] / 255, space: 'display-p3' };
        point.disp = { tonemap: disp, vivid: disp };
      }
      points.push(point);
      if (points.length >= count) break;
    }
    if (points.length >= count) break;
  }
  return { supported: true, points, method: space === 'display-p3' ? 'rgba-p3' : 'rgba-srgb' };
}

class ColorSpaceProbe {
  constructor(video) {
    this.ok = false;
    this.error = null;
    this._reading = false;
    if (typeof MediaStreamTrackProcessor === 'undefined') {
      this.error = 'MediaStreamTrackProcessor não suportado neste navegador (hoje só Chromium/Edge).';
      return;
    }
    try {
      const stream = video.captureStream ? video.captureStream() : video.mozCaptureStream();
      const track = stream.getVideoTracks()[0];
      if (!track) { this.error = 'Sem track de vídeo para capturar.'; return; }
      this.processor = new MediaStreamTrackProcessor({ track });
      this.reader = this.processor.readable.getReader();
      this.ok = true;
    } catch (e) {
      this.error = e.message;
    }
  }

  /**
   * Lê UM frame e devolve seu colorSpace (fecha o frame imediatamente —
   * obrigatório p/ não vazar). Com `opts.withPixels`, também extrai uma
   * amostra de pixels reais (ver `samplePixelsFromFrame`) — usa o mesmo
   * frame, sem abrir um segundo consumidor do reader.
   */
  async sample(opts) {
    if (!this.ok || this._reading) return null;
    this._reading = true;
    try {
      const { value: frame, done } = await this.reader.read();
      if (done || !frame) return null;
      const cs = frame.colorSpace || {};
      const result = {
        primaries: cs.primaries ? (PRIMARIES_NAMES[cs.primaries] || cs.primaries) : '—',
        transfer: cs.transfer ? (TRANSFER_NAMES[cs.transfer] || cs.transfer) : '—',
        matrix: cs.matrix ? (MATRIX_NAMES[cs.matrix] || cs.matrix) : '—',
        fullRange: cs.fullRange,
        hdr: cs.transfer === 'pq' || cs.transfer === 'hlg',
        codedWidth: frame.codedWidth, codedHeight: frame.codedHeight,
      };
      if (opts && opts.withPixels) {
        try {
          let px = await samplePixelsFromFrame(frame, cs, opts.count || 400, { output: opts.output });
          px.method = px.supported ? 'raw' : 'none';
          if (!px.supported) {
            // formato bruto ilegível (frame.format nulo, ou não coberto pelas
            // tabelas acima): tenta a conversão feita pelo próprio navegador
            // antes de cair até o canvas 2D sRGB — ver samplePixelsViaConversion
            px = await samplePixelsViaConversion(frame, opts.count || 400, opts.output);
          }
          result.pixelsSupported = px.supported;
          result.chromaPoints = px.points;
          result.pixelMethod = px.method || (px.supported ? 'raw' : 'none');
        } catch (e) {
          result.pixelsSupported = false;
          result.chromaPoints = [];
          result.pixelMethod = 'none';
        }
      }
      frame.close(); // crítico: VideoFrame não fechado vaza memória de decodificador
      return result;
    } catch (e) {
      this.error = e.message;
      return null;
    } finally {
      this._reading = false;
    }
  }

  destroy() {
    if (this.reader) { try { this.reader.cancel(); } catch { /* já encerrado */ } }
  }
}

window.ColorSpaceProbe = ColorSpaceProbe;

// Funções puras expostas p/ teste headless (sem WebCodecs/DOM) — ver
// scripts/color-math-test.js.
window.StreamColorMath = {
  HDR_REF_WHITE_NITS, HLG_DIFFUSE_LINEAR, TONEMAP_LW,
  PRIMARIES_TO_XYZ, XYZ_TO_OUT,
  pqInverseEotf, hlgInverseOetf, linearToSrgb8, srgbInverseEotf,
  hdrGainFor, desaturateIntoGamut, reinhardExt, contentLinearToDisplay8,
};
