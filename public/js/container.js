/**
 * Inspeção binária de containers de mídia — vai além do que o manifest
 * declara e lê a estrutura real de um segmento.
 *
 *   - MPEG-TS (.ts, legado HLS): parseia PAT → PMT e lista os streams
 *     elementares de verdade (PID, stream_type, idioma, formato).
 *   - fMP4/CMAF (.mp4/.m4s init segment): percorre a árvore de boxes
 *     ISOBMFF (moov → trak → mdia → stsd) e extrai track por track:
 *     codec, idioma, canais/resolução e, quando presente, o esquema de
 *     criptografia (CENC/CBCS) e o KID direto de dentro do `tenc`/`pssh`
 *     — funciona mesmo quando o manifest não declara `ContentProtection`,
 *     porque a `moov` nunca é criptografada (só as amostras em `mdat`).
 *
 * Ambos operam sobre um ArrayBuffer com os primeiros bytes do segmento
 * (não é preciso baixar o segmento inteiro).
 */
'use strict';

/* ================================================================ *
 * Detecção do tipo de container
 * ================================================================ */

/** Retorna 'ts' | 'fmp4' | 'unknown'. */
function sniffContainer(buf) {
  const b = new Uint8Array(buf);
  if (b.length >= 4) {
    const type = String.fromCharCode(b[4], b[5], b[6], b[7]);
    if (['ftyp', 'styp', 'moov', 'moof', 'free', 'skip', 'wide'].includes(type)) return 'fmp4';
  }
  if (b.length >= 189 && b[0] === 0x47 && b[188] === 0x47) return 'ts';
  if (b.length >= 196 && b[4] === 0x47 && b[196] === 0x47) return 'ts'; // M2TS (192 bytes, prefixo de timecode)
  return 'unknown';
}

/* ================================================================ *
 * MPEG-TS — PAT/PMT
 * ================================================================ */

const TS_STREAM_TYPES = {
  0x01: 'MPEG-1 Video', 0x02: 'MPEG-2 Video',
  0x03: 'MPEG-1 Audio', 0x04: 'MPEG-2 Audio',
  0x06: 'Dados privados (PES) — ver descritores', 0x0f: 'AAC (ADTS)', 0x11: 'AAC (LATM)',
  0x1b: 'H.264/AVC', 0x24: 'H.265/HEVC', 0x25: 'H.265/HEVC (temporal)',
  0x81: 'AC-3 (ATSC)', 0x87: 'E-AC-3 (ATSC)', 0x82: 'DTS', 0x86: 'SCTE-35 (marcação de anúncios)',
  0x05: 'Dados privados (seção)',
};

const DESCRIPTOR_TAGS = {
  0x0a: 'idioma (ISO 639)', 0x05: 'registro de formato', 0x09: 'acesso condicional (CA)',
  0x59: 'legendas DVB', 0x6a: 'AC-3 (descritor DVB)', 0x7a: 'E-AC-3 (descritor DVB)',
};

function parseTsContainer(buf) {
  const b = new Uint8Array(buf);
  let packetSize = 188, offset = 0;
  if (!(b[0] === 0x47 && b.length > 188 && b[188] === 0x47)) {
    if (b.length > 196 && b[4] === 0x47 && b[196] === 0x47) { packetSize = 192; offset = 4; }
  }

  let pmtPid = null;
  const programs = [];
  const streams = new Map(); // pid -> info
  let scrambledPackets = 0, totalPackets = 0;
  let pmtParsed = false;

  for (; offset + packetSize <= b.length; offset += packetSize) {
    const p = offset + (packetSize === 192 ? 4 : 0); // pula prefixo de timecode M2TS
    if (b[p] !== 0x47) continue;
    totalPackets++;
    const pusi = !!(b[p + 1] & 0x40);
    const pid = ((b[p + 1] & 0x1f) << 8) | b[p + 2];
    const scrambling = (b[p + 3] & 0xc0) >> 6;
    const afc = (b[p + 3] & 0x30) >> 4;
    if (scrambling !== 0) scrambledPackets++;
    if (afc === 0) continue; // reservado/inválido
    let payloadStart = p + 4;
    if (afc === 2) continue; // só adaptation field, sem payload
    if (afc === 3) {
      const adaptLen = b[p + 4];
      payloadStart = p + 5 + adaptLen;
    }
    if (payloadStart >= p + packetSize) continue;
    if (!pusi) continue; // só nos interessam pacotes que iniciam uma seção PSI

    const pointer = b[payloadStart];
    const sectionStart = payloadStart + 1 + pointer;
    if (sectionStart + 8 > b.length) continue;

    if (pid === 0 && !pmtPid) {
      const tableId = b[sectionStart];
      if (tableId !== 0x00) continue;
      const sectionLength = ((b[sectionStart + 1] & 0x0f) << 8) | b[sectionStart + 2];
      const end = sectionStart + 3 + sectionLength - 4; // -4 = CRC32
      let i = sectionStart + 8; // após transport_stream_id, version/current_next, section/last_section_number
      while (i + 4 <= end && i + 4 <= b.length) {
        const programNumber = (b[i] << 8) | b[i + 1];
        const progPid = ((b[i + 2] & 0x1f) << 8) | b[i + 3];
        if (programNumber !== 0) { programs.push({ programNumber, pid: progPid }); if (!pmtPid) pmtPid = progPid; }
        i += 4;
      }
    } else if (pmtPid && pid === pmtPid && !pmtParsed) {
      const tableId = b[sectionStart];
      if (tableId !== 0x02) continue;
      const sectionLength = ((b[sectionStart + 1] & 0x0f) << 8) | b[sectionStart + 2];
      const end = sectionStart + 3 + sectionLength - 4;
      if (end > b.length) continue; // seção truncada nos bytes que baixamos
      const pcrPid = ((b[sectionStart + 8] & 0x1f) << 8) | b[sectionStart + 9];
      const programInfoLength = ((b[sectionStart + 10] & 0x0f) << 8) | b[sectionStart + 11];
      let i = sectionStart + 12 + programInfoLength;
      while (i + 5 <= end) {
        const streamType = b[i];
        const pid2 = ((b[i + 1] & 0x1f) << 8) | b[i + 2];
        const esInfoLength = ((b[i + 3] & 0x0f) << 8) | b[i + 4];
        const descriptors = parseDescriptors(b, i + 5, i + 5 + esInfoLength);
        streams.set(pid2, {
          pid: pid2, streamType, streamTypeName: TS_STREAM_TYPES[streamType] || `desconhecido (0x${streamType.toString(16)})`,
          language: descriptors.language || null,
          formatHint: descriptors.formatHint || null,
          conditionalAccess: descriptors.ca || false,
          descriptorTags: descriptors.tags,
        });
        i += 5 + esInfoLength;
      }
      pmtParsed = true;
    }
    if (pmtParsed) break;
  }

  return {
    packetSize,
    totalPacketsRead: totalPackets,
    scrambledPackets,
    structureReadable: totalPackets > 0,
    pmtFound: pmtParsed,
    programs,
    streams: [...streams.values()],
  };
}

function parseDescriptors(b, start, end) {
  const tags = [];
  let language = null, formatHint = null, ca = false;
  let i = start;
  while (i + 2 <= end && i + 2 <= b.length) {
    const tag = b[i], len = b[i + 1];
    const dataStart = i + 2, dataEnd = Math.min(dataStart + len, b.length);
    tags.push(DESCRIPTOR_TAGS[tag] || `tag 0x${tag.toString(16)}`);
    if (tag === 0x0a && dataEnd - dataStart >= 3) {
      language = String.fromCharCode(b[dataStart], b[dataStart + 1], b[dataStart + 2]);
    } else if (tag === 0x05 && dataEnd > dataStart) {
      formatHint = String.fromCharCode(...b.slice(dataStart, dataEnd)).replace(/\0/g, '');
    } else if (tag === 0x09 || tag === 0x6a || tag === 0x7a) {
      ca = true;
      if (tag === 0x6a) formatHint = formatHint || 'AC-3';
      if (tag === 0x7a) formatHint = formatHint || 'E-AC-3';
    }
    i = dataEnd;
  }
  return { language, formatHint, ca, tags };
}

/* ================================================================ *
 * fMP4 / ISOBMFF — árvore de boxes
 * ================================================================ */

const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'edts', 'dinf', 'sinf', 'schi']);
const CONTAINER_DRM_UUIDS = {
  'edef8ba979d64acea3c827dcd51d21ed': 'Widevine',
  '9a04f07998404286ab92e65be0885f95': 'PlayReady',
  '94ce86fb07ff4f43adb893d2fa968ca2': 'FairPlay',
  'e2719d58a985b3c9781ab030af78d30e': 'ClearKey',
  '1077efecc0b24d02ace33c1e52e2fb4b': 'W3C ClearKey (cenc)',
};

function readBoxes(view, start, end) {
  const boxes = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(view.getUint8(offset + 4), view.getUint8(offset + 5), view.getUint8(offset + 6), view.getUint8(offset + 7));
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      const hi = view.getUint32(offset + 8), lo = view.getUint32(offset + 12);
      size = hi * 4294967296 + lo;
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end || !/^[a-zA-Z0-9 ]{4}$/.test(type)) break;
    boxes.push({ type, start: offset, bodyStart: offset + headerSize, end: offset + size });
    offset += size;
  }
  return boxes;
}

function findBox(boxes, type) { return boxes.find((b) => b.type === type); }
function childBoxes(view, box) { return readBoxes(view, box.bodyStart, box.end); }

function fourcc(view, offset) {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

function readLang(view, offset) {
  const packed = view.getUint16(offset);
  if (packed === 0x55c4) return 'und';
  const c1 = ((packed >> 10) & 0x1f) + 0x60, c2 = ((packed >> 5) & 0x1f) + 0x60, c3 = (packed & 0x1f) + 0x60;
  const s = String.fromCharCode(c1, c2, c3);
  return /^[a-z]{3}$/.test(s) ? s : 'und';
}

function parseSinf(view, sinfBox) {
  const kids = childBoxes(view, sinfBox);
  const frma = findBox(kids, 'frma');
  const schm = findBox(kids, 'schm');
  const schi = findBox(kids, 'schi');
  let originalFormat = frma ? fourcc(view, frma.bodyStart) : null;
  let schemeType = schm ? fourcc(view, schm.bodyStart + 4) : null;
  let defaultKid = null;
  if (schi) {
    const schiKids = childBoxes(view, schi);
    const tenc = findBox(schiKids, 'tenc');
    if (tenc && tenc.end - tenc.bodyStart >= 20) {
      const kidStart = tenc.bodyStart + 4; // versão(1)+flags(3), depois reserved/isProtected/ivsize, KID nos 16 bytes seguintes
      const kidOffset = tenc.end - 16 >= kidStart ? tenc.end - 16 : kidStart + 4;
      const bytes = [];
      for (let i = 0; i < 16; i++) bytes.push(view.getUint8(kidOffset + i).toString(16).padStart(2, '0'));
      defaultKid = bytes.join('');
    }
  }
  return { originalFormat, schemeType, defaultKid };
}

function parsePssh(view, box) {
  const version = view.getUint8(box.bodyStart);
  const sysIdBytes = [];
  for (let i = 0; i < 16; i++) sysIdBytes.push(view.getUint8(box.bodyStart + 4 + i).toString(16).padStart(2, '0'));
  const sysId = sysIdBytes.join('');
  return { system: CONTAINER_DRM_UUIDS[sysId] || `UUID ${sysId}`, version };
}

function parseStsd(view, stsdBox) {
  const entryStart = stsdBox.bodyStart + 8; // fullbox header(4) + entry_count(4)
  if (entryStart + 8 > stsdBox.end) return null;
  const size = view.getUint32(entryStart);
  const codec = fourcc(view, entryStart + 4);
  const entryEnd = Math.min(entryStart + size, stsdBox.end);
  const fixedStart = entryStart + 16; // após size+type+reserved(6)+data_reference_index(2)

  const result = { codec, protection: null };
  const isVideo = /^(avc1|avc3|hvc1|hev1|encv|dvh1|dvhe|vp09|av01)$/.test(codec);
  const isAudio = /^(mp4a|enca|ac-3|ec-3|ac-4|opus|fLaC)$/.test(codec);

  let nestedStart = fixedStart;
  if (isVideo && fixedStart + 70 <= entryEnd) {
    // VisualSampleEntry específico: pre_defined(2)+reserved(2)+pre_defined[3](12) antes de width/height
    result.width = view.getUint16(fixedStart + 16);
    result.height = view.getUint16(fixedStart + 18);
    nestedStart = fixedStart + 70;
  } else if (isAudio && fixedStart + 20 <= entryEnd) {
    result.channels = view.getUint16(fixedStart + 8);
    result.sampleRate = view.getUint32(fixedStart + 16) >>> 16;
    nestedStart = fixedStart + 20;
  }

  if (codec === 'encv' || codec === 'enca') {
    const nested = readBoxes(view, nestedStart, entryEnd);
    const sinf = findBox(nested, 'sinf');
    if (sinf) {
      const info = parseSinf(view, sinf);
      result.protection = info;
      result.effectiveCodec = info.originalFormat;
    }
  } else {
    result.effectiveCodec = codec;
  }
  return result;
}

function parseFmp4Container(buf) {
  const view = new DataView(buf);
  const top = readBoxes(view, 0, buf.byteLength);
  const ftyp = findBox(top, 'ftyp') || findBox(top, 'styp');
  const brand = ftyp ? fourcc(view, ftyp.bodyStart) : null;
  const moov = findBox(top, 'moov');
  const psshList = [];
  for (const b of top) if (b.type === 'pssh') psshList.push(parsePssh(view, b));

  if (!moov) {
    return { brand, hasMoov: false, tracks: [], pssh: psshList, note: 'Nenhuma caixa "moov" encontrada nos bytes lidos (pode ser um fragmento de mídia sem segmento de inicialização, ou o buffer foi truncado).' };
  }

  const moovKids = childBoxes(view, moov);
  for (const b of moovKids) if (b.type === 'pssh') psshList.push(parsePssh(view, b));

  const tracks = [];
  for (const trak of moovKids.filter((b) => b.type === 'trak')) {
    const trakKids = childBoxes(view, trak);
    const tkhd = findBox(trakKids, 'tkhd');
    const mdia = findBox(trakKids, 'mdia');
    if (!mdia) continue;
    const mdiaKids = childBoxes(view, mdia);
    const mdhd = findBox(mdiaKids, 'mdhd');
    const hdlr = findBox(mdiaKids, 'hdlr');
    const minf = findBox(mdiaKids, 'minf');

    let trackId = null;
    if (tkhd) {
      const version = view.getUint8(tkhd.bodyStart);
      trackId = version === 1 ? view.getUint32(tkhd.bodyStart + 20) : view.getUint32(tkhd.bodyStart + 12);
    }
    let language = 'und';
    if (mdhd) {
      const version = view.getUint8(mdhd.bodyStart);
      // fullbox(4: version+flags) + creation+modification+timescale+duration
      // (4 bytes cada na v0; creation/modification/duration em 8 bytes na v1)
      language = readLang(view, mdhd.bodyStart + (version === 1 ? 4 + 8 + 8 + 4 + 8 : 4 + 4 + 4 + 4 + 4));
    }
    let handlerType = null;
    if (hdlr) handlerType = fourcc(view, hdlr.bodyStart + 8);

    let sampleInfo = null;
    if (minf) {
      const minfKids = childBoxes(view, minf);
      const stbl = findBox(minfKids, 'stbl');
      if (stbl) {
        const stsd = findBox(childBoxes(view, stbl), 'stsd');
        if (stsd) sampleInfo = parseStsd(view, stsd);
      }
    }

    tracks.push({
      trackId, language,
      handlerType,
      handlerName: { vide: 'vídeo', soun: 'áudio', sbtl: 'legenda', subt: 'legenda', text: 'texto' }[handlerType] || handlerType || '—',
      codec: sampleInfo ? sampleInfo.codec : null,
      effectiveCodec: sampleInfo ? (sampleInfo.effectiveCodec || sampleInfo.codec) : null,
      width: sampleInfo ? sampleInfo.width : null,
      height: sampleInfo ? sampleInfo.height : null,
      channels: sampleInfo ? sampleInfo.channels : null,
      sampleRate: sampleInfo ? sampleInfo.sampleRate : null,
      protection: sampleInfo ? sampleInfo.protection : null,
    });
  }

  return { brand, hasMoov: true, tracks, pssh: psshList };
}

window.StreamContainer = { sniffContainer, parseTsContainer, parseFmp4Container };
