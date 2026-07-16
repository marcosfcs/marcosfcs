/**
 * Parsers de manifests de streaming: HLS (M3U8) e MPEG-DASH (MPD).
 * Produzem um modelo normalizado consumido pela UI:
 *
 * {
 *   protocol: 'HLS' | 'DASH',
 *   kind: 'master' | 'media' (HLS),
 *   overview: { ...pares chave/valor },
 *   video:   [ { id, bandwidth, avgBandwidth, resolution, codecs[],
 *                frameRate, videoRange, hdr, audioGroup, subtitleGroup, uri } ],
 *   audio:   [ { name, lang, groupId, channels, codecs, default, autoselect, uri } ],
 *   subtitles: [ { name, lang, groupId, kind, forced, default, uri } ],
 *   drm:     [ { system, details } ],
 *   segments: { source, targetDuration, count, totalDuration, live,
 *               list: [ { n, start, duration, uri, discontinuity, pdt } ] }
 * }
 */
'use strict';

/* ================================================================ *
 * Utilidades comuns
 * ================================================================ */

const CODEC_NAMES = [
  [/^avc[13]/i, (c) => 'H.264/AVC' + avcProfile(c)],
  [/^hvc1\.|^hev1\./i, (c) => 'H.265/HEVC' + hevcProfile(c)],
  [/^hvc1$|^hev1$/i, () => 'H.265/HEVC'],
  [/^dvh[1e]/i, () => 'Dolby Vision (HEVC)'],
  [/^dav1/i, () => 'Dolby Vision (AV1)'],
  [/^av01/i, (c) => 'AV1' + av1Profile(c)],
  [/^vp0?9/i, () => 'VP9'],
  [/^mp4a\.40\.2\b/i, () => 'AAC-LC'],
  [/^mp4a\.40\.5\b/i, () => 'HE-AAC'],
  [/^mp4a\.40\.29\b/i, () => 'HE-AACv2'],
  [/^mp4a\.40\.34\b/i, () => 'MP3'],
  [/^mp4a/i, () => 'AAC'],
  [/^ac-3/i, () => 'Dolby Digital (AC-3)'],
  [/^ec-3/i, () => 'Dolby Digital+ (E-AC-3)'],
  [/^ac-4/i, () => 'Dolby AC-4'],
  [/^opus/i, () => 'Opus'],
  [/^fla?c/i, () => 'FLAC'],
  [/^stpp/i, () => 'TTML/IMSC (stpp)'],
  [/^wvtt/i, () => 'WebVTT (wvtt)'],
];

function avcProfile(c) {
  const m = c.match(/^avc[13]\.([0-9a-f]{2})/i);
  if (!m) return '';
  const p = { '42': 'Baseline', '4d': 'Main', '58': 'Extended', '64': 'High', '6e': 'High 10' }[m[1].toLowerCase()];
  return p ? ` (${p})` : '';
}

function hevcProfile(c) {
  const m = c.match(/^h[ve][vc]1\.(\d+)/i);
  if (!m) return '';
  const p = { 1: 'Main', 2: 'Main 10' }[m[1]];
  return p ? ` (${p})` : '';
}

function av1Profile(c) {
  const m = c.match(/^av01\.(\d)\.(\d+)[MH]\.(\d+)/i);
  if (!m) return '';
  return ` (${m[3]}-bit)`;
}

function codecName(codec) {
  const c = (codec || '').trim();
  for (const [re, fn] of CODEC_NAMES) if (re.test(c)) return fn(c);
  return c || '—';
}

function isVideoCodec(c) {
  return /^(avc|hvc|hev|dvh|dav1|av01|vp0?9|mp4v)/i.test(c.trim());
}
function isAudioCodec(c) {
  return /^(mp4a|ac-3|ec-3|ac-4|opus|flac|fLaC|mp3)/i.test(c.trim());
}

/** Deduz sinalização HDR a partir do codec quando não há atributo explícito. */
function hdrFromCodec(codecs) {
  const j = (codecs || []).join(' ');
  if (/dvh[1e]|dav1/i.test(j)) return { hdr: true, format: 'Dolby Vision' };
  return null;
}

function fmtBits(bps) {
  if (bps == null || isNaN(bps)) return '—';
  if (bps >= 1e6) return (bps / 1e6).toFixed(2).replace('.', ',') + ' Mbps';
  if (bps >= 1e3) return (bps / 1e3).toFixed(0) + ' kbps';
  return bps + ' bps';
}

function fmtDur(sec) {
  if (sec == null || isNaN(sec)) return '—';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m ${String(r).padStart(2, '0')}s`;
  if (m) return `${m}m ${String(r).padStart(2, '0')}s`;
  return sec.toFixed(sec < 10 ? 2 : 0).replace('.', ',') + 's';
}

/* ================================================================ *
 * HLS — M3U8
 * ================================================================ */

/** Parseia lista de atributos HLS respeitando aspas: A=1,B="x,y" */
function parseAttrs(str) {
  const out = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  }
  return out;
}

function resolveUrl(uri, base) {
  try { return new URL(uri, base).href; } catch { return uri; }
}

function parseM3U8(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  if (!lines[0] || !lines[0].trim().startsWith('#EXTM3U')) {
    throw new Error('Não é um M3U8 válido (falta #EXTM3U na primeira linha)');
  }
  const isMaster = /#EXT-X-STREAM-INF/.test(text);
  return isMaster ? parseMaster(lines, baseUrl) : parseMediaPlaylist(lines, baseUrl);
}

function parseMaster(lines, baseUrl) {
  const model = {
    protocol: 'HLS', kind: 'master',
    version: null, independentSegments: false,
    video: [], audio: [], subtitles: [], closedCaptions: [],
    iframeStreams: [], drm: [], sessionData: [],
  };
  let pending = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-VERSION:')) {
      model.version = line.split(':')[1];
    } else if (line.startsWith('#EXT-X-INDEPENDENT-SEGMENTS')) {
      model.independentSegments = true;
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(line.slice('#EXT-X-MEDIA:'.length));
      const entry = {
        type: a.TYPE, groupId: a['GROUP-ID'], name: a.NAME || '—',
        lang: a.LANGUAGE || '—', default: a.DEFAULT === 'YES',
        autoselect: a.AUTOSELECT === 'YES', forced: a.FORCED === 'YES',
        channels: a.CHANNELS || null, characteristics: a.CHARACTERISTICS || null,
        instreamId: a['INSTREAM-ID'] || null,
        uri: a.URI ? resolveUrl(a.URI, baseUrl) : null,
      };
      if (a.TYPE === 'AUDIO') model.audio.push(entry);
      else if (a.TYPE === 'SUBTITLES') model.subtitles.push(entry);
      else if (a.TYPE === 'CLOSED-CAPTIONS') model.closedCaptions.push(entry);
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = parseAttrs(line.slice('#EXT-X-STREAM-INF:'.length));
    } else if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
      const a = parseAttrs(line.slice('#EXT-X-I-FRAME-STREAM-INF:'.length));
      model.iframeStreams.push({
        bandwidth: Number(a.BANDWIDTH) || null,
        resolution: a.RESOLUTION || '—',
        codecs: a.CODECS ? a.CODECS.split(',').map((s) => s.trim()) : [],
        uri: a.URI ? resolveUrl(a.URI, baseUrl) : null,
      });
    } else if (line.startsWith('#EXT-X-SESSION-KEY:') || line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(line.replace(/^#EXT-X(-SESSION)?-KEY:/, ''));
      model.drm.push(hlsKeyToDrm(a));
    } else if (line.startsWith('#EXT-X-SESSION-DATA:')) {
      const a = parseAttrs(line.slice('#EXT-X-SESSION-DATA:'.length));
      model.sessionData.push({ id: a['DATA-ID'], value: a.VALUE || a.URI || '' });
    } else if (!line.startsWith('#')) {
      if (pending) {
        const codecs = pending.CODECS ? pending.CODECS.split(',').map((s) => s.trim()) : [];
        const range = pending['VIDEO-RANGE'] || null;
        const codecHdr = hdrFromCodec(codecs);
        model.video.push({
          id: `#${model.video.length + 1}`,
          bandwidth: Number(pending.BANDWIDTH) || null,
          avgBandwidth: Number(pending['AVERAGE-BANDWIDTH']) || null,
          resolution: pending.RESOLUTION || '—',
          frameRate: pending['FRAME-RATE'] ? Number(pending['FRAME-RATE']) : null,
          codecs,
          videoRange: range || (codecHdr ? codecHdr.format : 'SDR (presumido)'),
          hdr: range ? range !== 'SDR' : !!codecHdr,
          hdcp: pending['HDCP-LEVEL'] || null,
          audioGroup: pending.AUDIO || null,
          subtitleGroup: pending.SUBTITLES || null,
          ccGroup: pending['CLOSED-CAPTIONS'] || null,
          score: pending.SCORE ? Number(pending.SCORE) : null,
          uri: resolveUrl(line, baseUrl),
        });
        pending = null;
      }
    }
  }

  // EXT-X-MEDIA não declara codec; herda dos codecs de áudio das variantes
  // que referenciam o grupo.
  for (const a of model.audio) {
    if (a.codecs) continue;
    const variant = model.video.find((v) => v.audioGroup === a.groupId);
    if (variant) {
      const ac = variant.codecs.filter(isAudioCodec);
      if (ac.length) a.codecs = ac.join(',');
    }
  }

  // Sem EXT-X-MEDIA de áudio: comum em simulcast de canais lineares, onde o
  // áudio vem muxado no próprio stream de vídeo (mesmo .ts), sem faixa
  // selecionável à parte. Sintetiza uma linha informativa em vez de deixar
  // a tabela de Áudio vazia (o que sugeriria ausência de áudio).
  if (model.audio.length === 0) {
    const muxed = new Map();
    for (const v of model.video) {
      const ac = v.codecs.filter(isAudioCodec);
      if (!ac.length) continue;
      const key = ac.join(',');
      if (!muxed.has(key)) muxed.set(key, new Set());
      muxed.get(key).add(v.resolution);
    }
    for (const [codecs, resolutions] of muxed) {
      model.audio.push({
        name: 'Áudio embutido no vídeo (muxado)', lang: '—', groupId: '—',
        channels: null, codecs, default: true, autoselect: true, muxed: true,
        resolutions: [...resolutions].join(', '),
      });
    }
  }

  model.overview = {
    'Protocolo': 'HLS (HTTP Live Streaming)',
    'Tipo de manifest': 'Master playlist (multi-variante)',
    'Versão HLS': model.version || '—',
    'Variantes de vídeo': String(model.video.length),
    'Faixas de áudio': String(model.audio.length),
    'Faixas de legendas': String(model.subtitles.length + model.closedCaptions.length),
    'Segmentos independentes': model.independentSegments ? 'Sim' : 'Não declarado',
    'Criptografia (sessão)': model.drm.length ? model.drm.map((d) => d.system).join(', ') : 'Nenhuma declarada no master',
  };
  return model;
}

function hlsKeyToDrm(a) {
  const method = a.METHOD || 'NONE';
  const kf = a.KEYFORMAT || 'identity';
  let system = method === 'NONE' ? 'Sem criptografia' : `AES (${method})`;
  if (/com\.apple\.streamingkeydelivery/i.test(kf)) system = 'FairPlay Streaming';
  else if (/com\.widevine/i.test(kf) || /edef8ba9/i.test(kf)) system = 'Widevine';
  else if (/com\.microsoft\.playready/i.test(kf) || /9a04f079/i.test(kf)) system = 'PlayReady';
  return {
    system,
    details: [
      `método: ${method}`,
      kf !== 'identity' ? `keyformat: ${kf}` : null,
      a.URI ? `uri: ${a.URI.slice(0, 80)}${a.URI.length > 80 ? '…' : ''}` : null,
    ].filter(Boolean).join(' · '),
  };
}

function parseMediaPlaylist(lines, baseUrl) {
  const model = {
    protocol: 'HLS', kind: 'media',
    version: null, targetDuration: null, mediaSequence: 0,
    playlistType: null, live: true, drm: [], maps: [],
    segments: [], lowLatency: null, adBreaks: [], partsSeen: 0,
  };
  let segAttrs = { duration: null, title: null, discontinuity: false, pdt: null, byterange: null };
  let currentKey = null;
  let discontinuities = 0;
  let start = 0;
  let cueOutOpen = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-VERSION:')) model.version = line.split(':')[1];
    else if (line.startsWith('#EXT-X-TARGETDURATION:')) model.targetDuration = Number(line.split(':')[1]);
    else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) model.mediaSequence = Number(line.split(':')[1]);
    else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) model.playlistType = line.split(':')[1];
    else if (line.startsWith('#EXT-X-ENDLIST')) model.live = false;
    else if (line.startsWith('#EXT-X-DISCONTINUITY') && !line.startsWith('#EXT-X-DISCONTINUITY-SEQ')) {
      segAttrs.discontinuity = true; discontinuities++;
    } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      segAttrs.pdt = line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length);
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(line.slice('#EXT-X-KEY:'.length));
      currentKey = hlsKeyToDrm(a);
      if (!model.drm.some((d) => d.system === currentKey.system && d.details === currentKey.details)) {
        model.drm.push(currentKey);
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(line.slice('#EXT-X-MAP:'.length));
      model.maps.push(resolveUrl(a.URI, baseUrl));
    } else if (line.startsWith('#EXT-X-SERVER-CONTROL:')) {
      const a = parseAttrs(line.slice('#EXT-X-SERVER-CONTROL:'.length));
      model.lowLatency = {
        canBlockReload: a['CAN-BLOCK-RELOAD'] === 'YES',
        partHoldBack: a['PART-HOLD-BACK'] ? Number(a['PART-HOLD-BACK']) : null,
        canSkipUntil: a['CAN-SKIP-UNTIL'] ? Number(a['CAN-SKIP-UNTIL']) : null,
      };
    } else if (line.startsWith('#EXT-X-PART:')) {
      model.partsSeen++;
    } else if (line.startsWith('#EXT-X-PRELOAD-HINT:')) {
      if (!model.lowLatency) model.lowLatency = {};
      model.lowLatency.preloadHint = true;
    } else if (line.startsWith('#EXT-X-SKIP:')) {
      const a = parseAttrs(line.slice('#EXT-X-SKIP:'.length));
      if (!model.lowLatency) model.lowLatency = {};
      model.lowLatency.skippedSegments = Number(a['SKIPPED-SEGMENTS']) || 0;
    } else if (line.startsWith('#EXT-X-DATERANGE:')) {
      const a = parseAttrs(line.slice('#EXT-X-DATERANGE:'.length));
      if (a['SCTE35-OUT'] || a['SCTE35-IN'] || /ad|interstitial|scte/i.test(a.CLASS || '')) {
        model.adBreaks.push({
          id: a.ID || '—', start: a['START-DATE'] || '—',
          duration: a.DURATION ? Number(a.DURATION) : (a['PLANNED-DURATION'] ? Number(a['PLANNED-DURATION']) : null),
          type: a['SCTE35-OUT'] ? 'SCTE35-OUT' : (a['SCTE35-IN'] ? 'SCTE35-IN' : a.CLASS),
          source: 'EXT-X-DATERANGE',
        });
      }
    } else if (line.startsWith('#EXT-X-CUE-OUT-CONT')) {
      // continuação de um break já aberto — nada a fazer além de manter o estado
    } else if (line.startsWith('#EXT-X-CUE-OUT')) {
      const durMatch = line.match(/CUE-OUT:?\s*([\d.]+)?/);
      cueOutOpen = { start: start, duration: durMatch && durMatch[1] ? Number(durMatch[1]) : null };
    } else if (line.startsWith('#EXT-X-CUE-IN')) {
      if (cueOutOpen) {
        model.adBreaks.push({
          id: '—', start: fmtDur(cueOutOpen.start),
          duration: cueOutOpen.duration ?? (start - cueOutOpen.start),
          type: 'CUE-OUT/CUE-IN', source: 'EXT-X-CUE',
        });
        cueOutOpen = null;
      }
    } else if (line.startsWith('#EXTINF:')) {
      const body = line.slice('#EXTINF:'.length);
      const comma = body.indexOf(',');
      segAttrs.duration = parseFloat(comma === -1 ? body : body.slice(0, comma));
      segAttrs.title = comma === -1 ? null : body.slice(comma + 1).trim() || null;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      segAttrs.byterange = line.split(':')[1];
    } else if (!line.startsWith('#') && segAttrs.duration != null) {
      model.segments.push({
        n: model.mediaSequence + model.segments.length,
        start,
        duration: segAttrs.duration,
        uri: resolveUrl(line, baseUrl),
        discontinuity: segAttrs.discontinuity,
        pdt: segAttrs.pdt,
        byterange: segAttrs.byterange,
        encrypted: !!(currentKey && currentKey.system !== 'Sem criptografia'),
      });
      start += segAttrs.duration;
      segAttrs = { duration: null, title: null, discontinuity: false, pdt: null, byterange: null };
    }
  }

  const total = model.segments.reduce((s, x) => s + x.duration, 0);
  model.totalDuration = total;
  model.discontinuities = discontinuities;
  model.overview = {
    'Protocolo': 'HLS (HTTP Live Streaming)',
    'Tipo de manifest': 'Media playlist (faixa única)',
    'Versão HLS': model.version || '—',
    'Transmissão': model.live ? 'AO VIVO (sem EXT-X-ENDLIST)' : 'VOD (finalizada)',
    'Tipo de playlist': model.playlistType || (model.live ? 'live/event' : '—'),
    'Duração alvo do segmento': model.targetDuration ? model.targetDuration + 's' : '—',
    'Segmentos na janela': String(model.segments.length),
    'Duração total': fmtDur(total),
    'Descontinuidades': String(discontinuities),
    'Criptografia': model.drm.length ? model.drm.map((d) => d.system).join(', ') : 'Nenhuma',
    'Low-Latency HLS': lowLatencySummary(model.lowLatency, model.partsSeen),
    'SCTE-35': scte35Summary(model.adBreaks),
  };
  return model;
}

function scte35Summary(adBreaks) {
  const n = adBreaks ? adBreaks.length : 0;
  return n ? `Presente (${n} marcador${n > 1 ? 'es' : ''})` : 'Não detectado';
}

function lowLatencySummary(ll, partsSeen) {
  if (!ll && !partsSeen) return 'Não detectado';
  const bits = [];
  if (ll && ll.canBlockReload) bits.push('blocking reload');
  if (partsSeen) bits.push(`${partsSeen} partes`);
  if (ll && ll.partHoldBack) bits.push(`hold-back ${ll.partHoldBack}s`);
  if (ll && ll.preloadHint) bits.push('preload hint');
  if (ll && ll.skippedSegments) bits.push(`delta update (${ll.skippedSegments} pulados)`);
  return bits.length ? 'Sim — ' + bits.join(', ') : 'Sim';
}

/* ================================================================ *
 * DASH — MPD
 * ================================================================ */

const DRM_UUIDS = {
  'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'Widevine',
  '9a04f079-9840-4286-ab92-e65be0885f95': 'PlayReady',
  '94ce86fb-07ff-4f43-adb8-93d2fa968ca2': 'FairPlay',
  'e2719d58-a985-b3c9-781a-b030af78d30e': 'ClearKey',
  '5e629af5-38da-4063-8977-97ffbd9902d4': 'Marlin',
  'adb41c24-2dbf-4a6d-958b-4457c0d27b95': 'Nagra',
  '9a27dd82-fde2-4725-8cbc-4234aa06ec09': 'Verimatrix',
  '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b': 'W3C ClearKey (cenc)',
};

/** ISO-8601 duration → segundos */
function parseISODuration(str) {
  if (!str) return null;
  const m = str.match(/^-?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map((v) => (v ? parseFloat(v) : 0));
  return ((y * 365 + mo * 30 + d) * 24 + h) * 3600 + mi * 60 + s;
}

const CICP_TRANSFER = { 1: 'BT.709 (SDR)', 6: 'BT.601 (SDR)', 14: 'BT.2020 (SDR)', 15: 'BT.2020 12-bit (SDR)', 16: 'PQ / SMPTE 2084 (HDR10)', 18: 'HLG / ARIB B67' };
const CICP_PRIMARIES = { 1: 'BT.709', 5: 'BT.601 PAL', 6: 'BT.601 NTSC', 9: 'BT.2020/BT.2100' };

function firstAttr(el, name) { return el.getAttribute(name); }

function inheritedAttr(repEl, asEl, name) {
  return repEl.getAttribute(name) || (asEl ? asEl.getAttribute(name) : null);
}

function parseMPD(xmlText, baseUrl) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('XML do MPD inválido: ' + err.textContent.slice(0, 200));
  const mpd = doc.documentElement;
  if (mpd.tagName !== 'MPD') throw new Error('Documento não é um MPD (raiz: ' + mpd.tagName + ')');

  const model = {
    protocol: 'DASH', kind: 'master',
    type: firstAttr(mpd, 'type') || 'static',
    video: [], audio: [], subtitles: [], closedCaptions: [], drm: [],
    periods: [], adBreaks: [], lowLatency: null,
  };
  const live = model.type === 'dynamic';
  const mediaDuration = parseISODuration(firstAttr(mpd, 'mediaPresentationDuration'));
  const drmSeen = new Map();

  const svcDesc = mpd.querySelector('ServiceDescription > Latency');
  if (svcDesc) {
    model.lowLatency = {
      target: svcDesc.getAttribute('target') ? Number(svcDesc.getAttribute('target')) / 1000 : null,
      min: svcDesc.getAttribute('min') ? Number(svcDesc.getAttribute('min')) / 1000 : null,
      max: svcDesc.getAttribute('max') ? Number(svcDesc.getAttribute('max')) / 1000 : null,
    };
  }

  const periods = Array.from(mpd.getElementsByTagName('Period'));
  periods.forEach((periodEl, pi) => {
    const period = {
      id: firstAttr(periodEl, 'id') || `period-${pi + 1}`,
      start: parseISODuration(firstAttr(periodEl, 'start')),
      duration: parseISODuration(firstAttr(periodEl, 'duration')),
      adaptationSets: 0,
    };
    model.periods.push(period);

    for (const esEl of Array.from(periodEl.getElementsByTagName('EventStream'))) {
      const scheme = (esEl.getAttribute('schemeIdUri') || '').toLowerCase();
      if (!/scte35|dash:event/i.test(scheme)) continue;
      const timescale = Number(esEl.getAttribute('timescale')) || 1;
      for (const evEl of Array.from(esEl.getElementsByTagName('Event'))) {
        const presentationTime = Number(evEl.getAttribute('presentationTime') || 0) / timescale;
        const duration = evEl.getAttribute('duration') ? Number(evEl.getAttribute('duration')) / timescale : null;
        model.adBreaks.push({
          id: evEl.getAttribute('id') || '—',
          start: fmtDur((period.start || 0) + presentationTime),
          duration, type: 'EventStream (SCTE-35)', source: 'DASH EventStream',
        });
      }
    }

    for (const asEl of Array.from(periodEl.getElementsByTagName('AdaptationSet'))) {
      period.adaptationSets++;
      const mime = firstAttr(asEl, 'mimeType') || '';
      const contentType = firstAttr(asEl, 'contentType') ||
        (mime.startsWith('video') ? 'video' : mime.startsWith('audio') ? 'audio' : mime.startsWith('text') || /ttml|vtt/.test(mime) ? 'text' : '');
      const lang = firstAttr(asEl, 'lang') || '—';
      const roles = Array.from(asEl.getElementsByTagName('Role')).map((r) => r.getAttribute('value')).filter(Boolean);

      // DRM
      for (const cp of Array.from(asEl.getElementsByTagName('ContentProtection'))) {
        const scheme = (cp.getAttribute('schemeIdUri') || '').toLowerCase();
        const uuid = (scheme.match(/urn:uuid:([0-9a-f-]{36})/) || [])[1];
        let system = null;
        if (uuid) system = DRM_UUIDS[uuid] || `UUID ${uuid}`;
        else if (scheme.includes('mp4protection')) {
          system = `Common Encryption (${cp.getAttribute('value') || 'cenc'})`;
        }
        if (system) {
          const kid = cp.getAttributeNS('urn:mpeg:cenc:2013', 'default_KID') || cp.getAttribute('cenc:default_KID');
          const key = system + (kid || '');
          if (!drmSeen.has(key)) {
            drmSeen.set(key, { system, details: kid ? `default_KID: ${kid}` : (cp.getAttribute('value') || '') });
          }
        }
      }

      // HDR via CICP (no AdaptationSet ou Representation)
      const cicpOf = (el) => {
        let transfer = null, primaries = null;
        for (const prop of Array.from(el.querySelectorAll(':scope > EssentialProperty, :scope > SupplementalProperty'))) {
          const s = prop.getAttribute('schemeIdUri') || '';
          if (/TransferCharacteristics/i.test(s)) transfer = Number(prop.getAttribute('value'));
          if (/ColourPrimaries/i.test(s)) primaries = Number(prop.getAttribute('value'));
        }
        return { transfer, primaries };
      };
      const asCicp = cicpOf(asEl);

      // Info de segmentação (para o gráfico estático)
      const segInfo = extractSegmentInfo(asEl);

      for (const repEl of Array.from(asEl.getElementsByTagName('Representation'))) {
        const codecs = (inheritedAttr(repEl, asEl, 'codecs') || '').split(',').map((s) => s.trim()).filter(Boolean);
        const bw = Number(repEl.getAttribute('bandwidth')) || null;
        const id = repEl.getAttribute('id') || '—';

        if (contentType === 'video' || codecs.some(isVideoCodec)) {
          const repCicp = cicpOf(repEl);
          const transfer = repCicp.transfer ?? asCicp.transfer;
          const primaries = repCicp.primaries ?? asCicp.primaries;
          const codecHdr = hdrFromCodec(codecs);
          const isHdr = transfer === 16 || transfer === 18 || !!codecHdr;
          const w = Number(inheritedAttr(repEl, asEl, 'width')) || null;
          const h = Number(inheritedAttr(repEl, asEl, 'height')) || null;
          model.video.push({
            id, bandwidth: bw, avgBandwidth: null,
            resolution: w && h ? `${w}x${h}` : '—',
            frameRate: parseFrameRate(inheritedAttr(repEl, asEl, 'frameRate')),
            codecs,
            videoRange: transfer != null ? (CICP_TRANSFER[transfer] || `CICP ${transfer}`)
              : codecHdr ? codecHdr.format : 'SDR (presumido)',
            hdr: isHdr,
            primaries: primaries != null ? (CICP_PRIMARIES[primaries] || `CICP ${primaries}`) : null,
            period: period.id,
            scanType: inheritedAttr(repEl, asEl, 'scanType'),
            sar: inheritedAttr(repEl, asEl, 'sar'),
            segInfo,
            initUrl: resolveInitUrl(segInfo, id, bw, baseUrl),
          });
        } else if (contentType === 'audio' || codecs.some(isAudioCodec)) {
          const ch = repEl.querySelector('AudioChannelConfiguration') || asEl.querySelector('AudioChannelConfiguration');
          model.audio.push({
            name: id, lang, groupId: firstAttr(asEl, 'id') || '—',
            channels: ch ? ch.getAttribute('value') : null,
            samplingRate: inheritedAttr(repEl, asEl, 'audioSamplingRate'),
            codecs: codecs.join(','),
            bandwidth: bw,
            default: roles.includes('main'),
            roles: roles.join(', ') || '—',
            period: period.id,
          });
        } else if (contentType === 'text' || /stpp|wvtt/.test(codecs.join())) {
          model.subtitles.push({
            name: id, lang, groupId: firstAttr(asEl, 'id') || '—',
            kind: roles.includes('caption') ? 'closed captions' : 'legenda',
            forced: roles.includes('forced-subtitle') || roles.includes('forced_subtitle'),
            default: roles.includes('main'),
            codecs: codecs.join(',') || mime,
            bandwidth: bw,
            period: period.id,
          });
        }
      }
    }
  });

  model.drm = Array.from(drmSeen.values());

  // Segmentos estimados a partir da primeira variante de vídeo (SegmentTimeline/Template)
  model.segments = segmentsFromDash(model.video[0] && model.video[0].segInfo, mediaDuration, live);

  const minBuffer = parseISODuration(firstAttr(mpd, 'minBufferTime'));
  model.overview = {
    'Protocolo': 'MPEG-DASH',
    'Tipo de manifest': model.type === 'dynamic' ? 'MPD dinâmico' : 'MPD estático',
    'Transmissão': live ? 'AO VIVO (dynamic)' : 'VOD (static)',
    'Perfis': (firstAttr(mpd, 'profiles') || '—').replace(/urn:mpeg:dash:profile:/g, ''),
    'Duração da apresentação': mediaDuration != null ? fmtDur(mediaDuration) : (live ? 'contínua (live)' : '—'),
    'Buffer mínimo': minBuffer != null ? fmtDur(minBuffer) : '—',
    'Períodos': String(model.periods.length),
    'Variantes de vídeo': String(model.video.length),
    'Faixas de áudio': String(model.audio.length),
    'Faixas de legendas': String(model.subtitles.length),
    'Atualização mínima (live)': firstAttr(mpd, 'minimumUpdatePeriod') ? fmtDur(parseISODuration(firstAttr(mpd, 'minimumUpdatePeriod'))) : '—',
    'Publicado em': firstAttr(mpd, 'publishTime') || '—',
    'DRM': model.drm.length ? model.drm.map((d) => d.system).join(', ') : 'Nenhum declarado',
    'Low-Latency DASH': model.lowLatency
      ? `Sim — alvo ${model.lowLatency.target ?? '—'}s (min ${model.lowLatency.min ?? '—'}s / max ${model.lowLatency.max ?? '—'}s)`
      : 'Não detectado',
    'SCTE-35': scte35Summary(model.adBreaks),
  };
  return model;
}

function parseFrameRate(fr) {
  if (!fr) return null;
  const m = fr.match(/^(\d+)(?:\/(\d+))?$/);
  if (!m) return null;
  return m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1]);
}

function extractSegmentInfo(asEl) {
  const tpl = asEl.querySelector('SegmentTemplate');
  if (tpl) {
    const timescale = Number(tpl.getAttribute('timescale')) || 1;
    const timeline = tpl.querySelector('SegmentTimeline');
    const entries = [];
    if (timeline) {
      for (const s of Array.from(timeline.getElementsByTagName('S'))) {
        entries.push({
          t: s.getAttribute('t') != null ? Number(s.getAttribute('t')) : null,
          d: Number(s.getAttribute('d')),
          r: Number(s.getAttribute('r') || 0),
        });
      }
    }
    return {
      mode: timeline ? 'SegmentTemplate + SegmentTimeline' : 'SegmentTemplate (numeração fixa)',
      timescale,
      duration: tpl.getAttribute('duration') ? Number(tpl.getAttribute('duration')) / timescale : null,
      startNumber: Number(tpl.getAttribute('startNumber') || 1),
      timeline: entries,
      initTemplate: tpl.getAttribute('initialization') || null,
    };
  }
  const segList = asEl.querySelector('SegmentList');
  if (segList) {
    const initEl = segList.querySelector('Initialization');
    return { mode: 'SegmentList', initUrlList: initEl ? initEl.getAttribute('sourceURL') : null };
  }
  const segBase = asEl.querySelector('SegmentBase');
  if (segBase) {
    const initEl = segBase.querySelector('Initialization');
    return { mode: 'SegmentBase (arquivo único indexado)', initRange: initEl ? initEl.getAttribute('range') : null };
  }
  return { mode: '—' };
}

/** Substitui $RepresentationID$/$Bandwidth$ num template de SegmentTemplate e resolve contra baseUrl. */
function resolveInitUrl(segInfo, repId, bandwidth, baseUrl) {
  if (!segInfo) return null;
  if (segInfo.initTemplate) {
    const uri = segInfo.initTemplate
      .replace(/\$RepresentationID\$/g, repId)
      .replace(/\$Bandwidth\$/g, bandwidth != null ? String(bandwidth) : '');
    return resolveUrl(uri, baseUrl);
  }
  if (segInfo.initUrlList) return resolveUrl(segInfo.initUrlList, baseUrl);
  if (segInfo.initRange) return { sameFile: true, range: segInfo.initRange };
  return null;
}

function segmentsFromDash(segInfo, mediaDuration, live) {
  if (!segInfo) return null;
  const list = [];
  if (segInfo.timeline && segInfo.timeline.length) {
    let t = 0, n = segInfo.startNumber || 1;
    for (const e of segInfo.timeline) {
      if (e.t != null) t = e.t / segInfo.timescale;
      for (let i = 0; i <= e.r && list.length < 4000; i++) {
        const d = e.d / segInfo.timescale;
        list.push({ n: n++, start: t, duration: d });
        t += d;
      }
    }
  } else if (segInfo.duration && mediaDuration) {
    const count = Math.ceil(mediaDuration / segInfo.duration);
    for (let i = 0; i < Math.min(count, 4000); i++) {
      list.push({ n: (segInfo.startNumber || 1) + i, start: i * segInfo.duration, duration: segInfo.duration });
    }
  }
  if (!list.length) return { source: segInfo.mode, count: null, list: [] };
  const total = list.reduce((s, x) => s + x.duration, 0);
  return {
    source: segInfo.mode,
    targetDuration: Math.max(...list.map((s) => s.duration)),
    count: list.length,
    totalDuration: total,
    live,
    list,
  };
}

window.StreamParsers = { parseM3U8, parseMPD, codecName, fmtBits, fmtDur, parseAttrs };
