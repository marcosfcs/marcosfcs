/**
 * Stream Inspector — orquestração da UI.
 *
 * Fluxo ao clicar em "Inspecionar":
 *   1. baixa o manifest (fetch direto; fallback automático para o proxy /p/ do server.js)
 *   2. detecta HLS × DASH e parseia (parsers.js)
 *   3. renderiza tabelas estáticas (visão geral, vídeo, áudio, legendas, DRM, segmentos)
 *   4. inicia playback mudo (hls.js / dash.js) e alimenta os gráficos temporais
 *      (buffer, bitrate, banda, luminância) e as curvas de cor (analyzer.js)
 */
'use strict';

const $ = (sel) => document.querySelector(sel);
const P = window.StreamParsers;
const C = window.StreamContainer;

const state = {
  charts: {},
  player: null,        // instância Hls, dashjs MediaPlayer ou shaka.Player
  playerKind: null,    // 'hls' | 'dash' | 'shaka'
  engine: 'hlsjs',     // 'hlsjs' (hls.js + dash.js) | 'shaka' (Shaka Player p/ ambos)
  timer: null,
  analyzer: null,
  t0: 0,
  lastDropped: 0,
  drmBlocked: false,
  lastPlay: null,      // { type, url, model, isLive } — p/ trocar de motor sem re-inspecionar
};

if (window.shaka && shaka.polyfill && shaka.polyfill.installAll) shaka.polyfill.installAll();

/* ================================================================ *
 * Utilidades de rede
 * ================================================================ */

function proxify(url) {
  try {
    const u = new URL(url);
    if (u.origin === location.origin) return url;
    return `/p/${u.protocol.replace(':', '')}/${u.host}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

async function fetchManifest(url) {
  let directError = null;
  try {
    const r = await fetch(url, { mode: 'cors' });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    return { text: await r.text(), effectiveUrl: r.url || url, proxied: false };
  } catch (e) {
    directError = e;
  }
  const p = proxify(url);
  if (p === url) throw directError;
  logEvent(`Fetch direto falhou (${directError.message || 'CORS/rede'}); tentando via proxy local…`);
  const r = await fetch(p);
  if (!r.ok) {
    throw new Error(
      `Falha direta (${directError.message || 'CORS/rede'}) e via proxy (HTTP ${r.status}). ` +
      `O proxy /p/ requer que a página seja servida por "node server.js".`
    );
  }
  return { text: await r.text(), effectiveUrl: new URL(p, location.href).href, proxied: true };
}

/**
 * Baixa até maxBytes de uma URL (Range quando o servidor suporta; corta o
 * stream cedo quando não suporta) — usado para sondar o container de um
 * segmento sem precisar baixá-lo inteiro. Mesmo fallback de proxy do
 * fetchManifest.
 */
async function fetchBytes(url, maxBytes) {
  const attempt = async (target) => {
    const r = await fetch(target, maxBytes ? { headers: { Range: `bytes=0-${maxBytes - 1}` } } : {});
    if (!r.ok && r.status !== 206) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    if (!maxBytes || !r.body) return await r.arrayBuffer();
    const reader = r.body.getReader();
    const chunks = [];
    let received = 0;
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
    }
    reader.cancel().catch(() => {});
    const out = new Uint8Array(Math.min(received, maxBytes));
    let pos = 0;
    for (const c of chunks) {
      const take = Math.min(c.length, out.length - pos);
      out.set(c.subarray(0, take), pos);
      pos += take;
      if (pos >= out.length) break;
    }
    return out.buffer;
  };
  try {
    return { buf: await attempt(url), proxied: false };
  } catch (e) {
    const p = proxify(url);
    if (p === url) throw e;
    return { buf: await attempt(p), proxied: true };
  }
}

function detectType(url, text) {
  const head = text.trimStart().slice(0, 500);
  if (head.startsWith('#EXTM3U')) return 'hls';
  if (head.includes('<MPD') || /\.mpd(\?|$)/i.test(url)) return 'dash';
  if (/\.m3u8(\?|$)/i.test(url)) return 'hls';
  throw new Error('Conteúdo não reconhecido como M3U8 nem MPD.');
}

/* ================================================================ *
 * Renderização de tabelas
 * ================================================================ */

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderKV(container, obj) {
  container.innerHTML = '';
  const table = el('table', 'kv-table');
  for (const [k, v] of Object.entries(obj)) {
    const tr = el('tr');
    tr.appendChild(el('th', null, k));
    tr.appendChild(el('td', null, v));
    table.appendChild(tr);
  }
  container.appendChild(table);
}

function renderTable(container, columns, rows, emptyMsg) {
  container.innerHTML = '';
  if (!rows.length) {
    container.appendChild(el('p', 'empty-note', emptyMsg));
    return;
  }
  const table = el('table', 'data-table');
  const thead = el('thead');
  const trh = el('tr');
  for (const c of columns) trh.appendChild(el('th', null, c.label));
  thead.appendChild(trh);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (const c of columns) {
      const td = el('td');
      const v = c.get(row);
      if (v instanceof Node) td.appendChild(v);
      else td.textContent = v == null || v === '' ? '—' : String(v);
      if (c.mono) td.classList.add('mono');
      if (c.num) td.classList.add('num');
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  const wrap = el('div', 'table-scroll');
  wrap.appendChild(table);
  container.appendChild(wrap);
}

function badge(text, kind) {
  return Object.assign(el('span', `badge badge-${kind || 'info'}`, text));
}

function renderBadges(model) {
  const box = $('#badges');
  box.innerHTML = '';
  box.appendChild(badge(model.protocol, 'info'));
  const live = /AO VIVO/.test(model.overview['Transmissão'] || '');
  if (model.overview['Transmissão']) box.appendChild(badge(live ? 'AO VIVO' : 'VOD', live ? 'live' : 'ok'));
  const hdrVariants = (model.video || []).filter((v) => v.hdr);
  if (hdrVariants.length) {
    const ranges = [...new Set(hdrVariants.map((v) => v.videoRange))];
    box.appendChild(badge('HDR: ' + ranges.join(' / '), 'hdr'));
  } else if ((model.video || []).length) {
    box.appendChild(badge('SDR', 'info'));
  }
  if ((model.drm || []).length && model.drm.some((d) => d.system !== 'Sem criptografia')) {
    box.appendChild(badge('DRM/Criptografia', 'drm'));
  }
}

const VIDEO_COLUMNS = [
  { label: 'ID', get: (v) => v.id },
  { label: 'Resolução', get: (v) => v.resolution, num: true },
  { label: 'Bitrate (pico)', get: (v) => P.fmtBits(v.bandwidth), num: true },
  { label: 'Bitrate (médio)', get: (v) => P.fmtBits(v.avgBandwidth), num: true },
  { label: 'FPS', get: (v) => (v.frameRate ? String(Math.round(v.frameRate * 100) / 100) : '—'), num: true },
  { label: 'Codec', get: (v) => v.codecs.filter((c) => isVideo(c)).map(P.codecName).join(', ') || v.codecs.map(P.codecName).join(', ') },
  { label: 'String de codec', get: (v) => v.codecs.join(', '), mono: true },
  { label: 'Faixa de vídeo', get: (v) => rangeCell(v) },
  { label: 'Extras', get: (v) => videoExtras(v) },
];

function isVideo(c) { return /^(avc|hvc|hev|dvh|dav1|av01|vp0?9)/i.test(c); }

function rangeCell(v) {
  const span = el('span', v.hdr ? 'range-hdr' : 'range-sdr', v.videoRange);
  return span;
}

function videoExtras(v) {
  const bits = [];
  if (v.primaries) bits.push('primárias: ' + v.primaries);
  if (v.hdcp) bits.push('HDCP: ' + v.hdcp);
  if (v.audioGroup) bits.push('áudio: ' + v.audioGroup);
  if (v.subtitleGroup) bits.push('legendas: ' + v.subtitleGroup);
  if (v.scanType) bits.push(v.scanType);
  if (v.period && v.period !== 'period-1') bits.push('período: ' + v.period);
  return bits.join(' · ') || '—';
}

const AUDIO_COLUMNS = [
  { label: 'Nome/ID', get: (a) => a.name },
  { label: 'Idioma', get: (a) => a.lang },
  { label: 'Grupo', get: (a) => a.groupId },
  { label: 'Canais', get: (a) => a.channels || '—', num: true },
  { label: 'Codec', get: (a) => (a.codecs ? a.codecs.split(',').map(P.codecName).join(', ') : '—') },
  { label: 'Amostragem', get: (a) => (a.samplingRate ? a.samplingRate + ' Hz' : '—'), num: true },
  { label: 'Bitrate', get: (a) => P.fmtBits(a.bandwidth), num: true },
  { label: 'Padrão', get: (a) => (a.default ? 'Sim' : 'Não') },
  { label: 'Papéis', get: (a) => (a.muxed ? `muxado (variantes: ${a.resolutions})` : a.roles || (a.autoselect ? 'autoselect' : '—')) },
];

const SUB_COLUMNS = [
  { label: 'Nome/ID', get: (s) => s.name },
  { label: 'Idioma', get: (s) => s.lang },
  { label: 'Tipo', get: (s) => s.kind || (s.instreamId ? `closed captions (${s.instreamId})` : 'legenda') },
  { label: 'Formato', get: (s) => (s.codecs ? s.codecs.split(',').map(P.codecName).join(', ') : s.uri ? 'WebVTT (playlist)' : 'CEA-608/708') },
  { label: 'Forçada', get: (s) => (s.forced ? 'Sim' : 'Não') },
  { label: 'Padrão', get: (s) => (s.default ? 'Sim' : 'Não') },
  { label: 'Características', get: (s) => s.characteristics || '—' },
];

const DRM_COLUMNS = [
  { label: 'Sistema', get: (d) => d.system },
  { label: 'Detalhes', get: (d) => d.details || '—', mono: true },
];

const SEG_COLUMNS = [
  { label: '#', get: (s) => s.n, num: true },
  { label: 'Início', get: (s) => P.fmtDur(s.start), num: true },
  { label: 'Duração', get: (s) => s.duration.toFixed(3).replace('.', ',') + 's', num: true },
  { label: 'Descontinuidade', get: (s) => (s.discontinuity ? 'SIM' : '') },
  { label: 'Criptografado', get: (s) => (s.encrypted ? 'Sim' : '') },
  { label: 'PDT', get: (s) => s.pdt || '', mono: true },
  { label: 'URI', get: (s) => (s.uri ? s.uri.split('/').pop().slice(0, 60) : '—'), mono: true },
];

/* ================================================================ *
 * Seção de segmentos (tabela + gráfico estático de durações)
 * ================================================================ */

function renderSegments(seg, sourceNote) {
  const section = $('#sec-segments');
  if (!seg || !seg.list || !seg.list.length) {
    if (seg && seg.source) {
      section.hidden = false;
      renderKV($('#seg-overview'), { 'Modo de segmentação': seg.source, 'Observação': 'Lista de segmentos não enumerável a partir do manifest.' });
      $('#seg-chart').innerHTML = '';
      $('#seg-table').innerHTML = '';
      return;
    }
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const durations = seg.list.map((s) => s.duration);
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  renderKV($('#seg-overview'), {
    'Fonte': sourceNote || seg.source || 'playlist de mídia',
    'Segmentos': String(seg.count ?? seg.list.length),
    'Duração alvo': seg.targetDuration ? seg.targetDuration.toFixed(2).replace('.', ',') + 's' : '—',
    'Duração média': avg.toFixed(2).replace('.', ',') + 's',
    'Mín / Máx': `${Math.min(...durations).toFixed(2)}s / ${Math.max(...durations).toFixed(2)}s`.replace(/\./g, ','),
    'Duração total': P.fmtDur(seg.totalDuration),
    'Descontinuidades': String(seg.list.filter((s) => s.discontinuity).length),
  });

  destroyChart('segments');
  const points = seg.list.slice(0, 2500).map((s) => [s.start, s.duration]);
  state.charts.segments = new LineChart($('#seg-chart'), {
    series: [{ key: 'dur', label: 'Duração do segmento', colorVar: '--series-1', step: true, fill: true }],
    yFormat: (v) => v.toFixed(1).replace('.', ',') + 's',
    xFormat: (v) => P.fmtDur(v),
    height: 180,
    yMin: 0,
  });
  state.charts.segments.setSeriesData('dur', points);

  renderTable($('#seg-table'), SEG_COLUMNS, seg.list.slice(0, 60), '');
  $('#seg-table-note').textContent =
    seg.list.length > 60 ? `Exibindo os primeiros 60 de ${seg.list.length} segmentos.` : '';
}

/* ================================================================ *
 * Container real — inspeção binária de um segmento de amostra
 * ================================================================ */

const TS_COLUMNS = [
  { label: 'PID', get: (s) => '0x' + s.pid.toString(16), mono: true },
  { label: 'Tipo', get: (s) => s.streamTypeName },
  { label: 'Idioma', get: (s) => s.language || '—' },
  { label: 'Formato (descritor)', get: (s) => s.formatHint || '—' },
  { label: 'Acesso condicional', get: (s) => (s.conditionalAccess ? 'SIM (CA)' : '—') },
  { label: 'Descritores', get: (s) => s.descriptorTags.join(', ') || '—' },
];

const FMP4_COLUMNS = [
  { label: 'Track', get: (t) => t.trackId ?? '—', num: true },
  { label: 'Tipo', get: (t) => t.handlerName },
  { label: 'Codec (sample entry)', get: (t) => t.codec || '—', mono: true },
  { label: 'Codec efetivo', get: (t) => P.codecName(t.effectiveCodec || t.codec || '') },
  { label: 'Idioma', get: (t) => t.language },
  { label: 'Resolução', get: (t) => (t.width ? `${t.width}x${t.height}` : '—') },
  { label: 'Áudio', get: (t) => (t.channels ? `${t.channels} ch · ${t.sampleRate} Hz` : '—') },
  { label: 'Proteção', get: (t) => fmp4Protection(t) },
];

function fmp4Protection(t) {
  if (!t.protection) return '—';
  const scheme = t.protection.schemeType ? t.protection.schemeType.toUpperCase() : 'protegido';
  return t.protection.defaultKid ? `${scheme} · KID ${t.protection.defaultKid}` : scheme;
}

/** Decide de onde tirar a amostra (segmento .ts ou init .mp4/.m4s) e sonda o container. */
async function probeContainer(protocol, hlsMediaModel, dashModel) {
  const section = $('#sec-container');
  section.hidden = false;
  renderKV($('#container-overview'), { 'Status': 'Buscando amostra de segmento…' });
  $('#container-table').innerHTML = '';
  $('#container-note').textContent = '';

  let sampleUrl = null, kindHint = null;
  if (protocol === 'HLS' && hlsMediaModel) {
    if (hlsMediaModel.maps && hlsMediaModel.maps.length) { sampleUrl = hlsMediaModel.maps[0]; kindHint = 'fmp4'; }
    else if (hlsMediaModel.segments && hlsMediaModel.segments.length) { sampleUrl = hlsMediaModel.segments[0].uri; kindHint = 'ts'; }
  } else if (protocol === 'DASH' && dashModel) {
    const v0 = (dashModel.video || [])[0];
    if (v0 && v0.initUrl && typeof v0.initUrl === 'string') { sampleUrl = v0.initUrl; kindHint = 'fmp4'; }
  }

  if (!sampleUrl) {
    renderKV($('#container-overview'), { 'Status': 'Não foi possível localizar uma URL de segmento/inicialização para inspecionar.' });
    return;
  }

  try {
    const maxBytes = kindHint === 'ts' ? 256 * 1024 : 2 * 1024 * 1024;
    const { buf, proxied } = await fetchBytes(sampleUrl, maxBytes);
    const detected = C.sniffContainer(buf);

    if (detected === 'ts') {
      const info = C.parseTsContainer(buf);
      renderKV($('#container-overview'), {
        'Amostra': sampleUrl.split('/').pop(),
        'Obtido via': proxied ? 'proxy local (/p/)' : 'fetch direto',
        'Bytes lidos': (buf.byteLength).toLocaleString('pt-BR'),
        'Container detectado': `MPEG-TS (pacotes de ${info.packetSize} bytes)`,
        'PAT/PMT decodificados': info.pmtFound ? 'Sim' : 'Não (seção não encontrada nos bytes lidos)',
        'Pacotes com scrambling': info.scrambledPackets > 0 ? `${info.scrambledPackets} de ${info.totalPacketsRead}` : 'Nenhum',
      });
      renderTable($('#container-table'), TS_COLUMNS, info.streams, 'PMT não encontrada — não foi possível listar os streams elementares.');
      $('#container-note').textContent =
        'Streams elementares lidos diretamente do PAT/PMT do segmento (não do manifest). ' +
        (info.scrambledPackets > 0 ? 'Atenção: pacotes com scrambling detectado no cabeçalho do TS (payload cifrado).' :
          'Estrutura totalmente legível — payload não está cifrado no nível do TS (uma eventual criptografia AES-128 de segmento inteiro tornaria a estrutura ilegível, o que não é o caso aqui).');
    } else if (detected === 'fmp4') {
      const info = C.parseFmp4Container(buf);
      renderKV($('#container-overview'), {
        'Amostra': sampleUrl.split('/').pop(),
        'Obtido via': proxied ? 'proxy local (/p/)' : 'fetch direto',
        'Bytes lidos': (buf.byteLength).toLocaleString('pt-BR'),
        'Container detectado': `fMP4/ISOBMFF${info.brand ? ' (brand: ' + info.brand + ')' : ''}`,
        'moov encontrada': info.hasMoov ? 'Sim' : 'Não',
        'DRM (pssh no init)': info.pssh.length ? [...new Set(info.pssh.map((p) => p.system))].join(', ') : 'Nenhum pssh encontrado',
      });
      renderTable($('#container-table'), FMP4_COLUMNS, info.tracks, info.note || 'Nenhuma track encontrada na moov.');
      $('#container-note').textContent =
        'Tracks e (quando presente) esquema de criptografia/KID lidos diretamente da caixa "moov" do segmento de ' +
        'inicialização — a moov nunca é criptografada, então esses dados são fidedignos mesmo quando o manifest ' +
        'não declara nada sobre codecs reais, idiomas ou DRM.';
    } else {
      renderKV($('#container-overview'), {
        'Amostra': sampleUrl.split('/').pop(),
        'Obtido via': proxied ? 'proxy local (/p/)' : 'fetch direto',
        'Bytes lidos': (buf.byteLength).toLocaleString('pt-BR'),
        'Container detectado': 'Não identificado',
      });
      $('#container-note').textContent =
        'A estrutura não bate com MPEG-TS nem com um box ISOBMFF válido logo no início do arquivo. ' +
        'Isso é esperado quando o segmento inteiro está cifrado (ex.: HLS AES-128 de segmento completo) — ' +
        'nesse caso os bytes são puro ciphertext e não há estrutura de container para ler sem a chave.';
    }
  } catch (e) {
    renderKV($('#container-overview'), { 'Status': 'Erro ao buscar/inspecionar a amostra: ' + e.message });
  }
}

/* ================================================================ *
 * Playback + telemetria
 * ================================================================ */

function destroyChart(key) {
  if (state.charts[key]) { state.charts[key].destroy(); delete state.charts[key]; }
}

function stopPlayback() {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  if (state.player) {
    try {
      if (state.playerKind === 'hls') state.player.destroy();
      else if (state.playerKind === 'shaka') { const p = state.player.destroy(); if (p && p.catch) p.catch(() => {}); }
      else state.player.reset();
    } catch { /* já destruído */ }
    state.player = null;
  }
  const video = $('#video');
  video.removeAttribute('src');
  video.load();
}

function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function setupTelemetryCharts(isLive) {
  destroyChart('buffer'); destroyChart('bitrate'); destroyChart('lumaT');
  destroyChart('rgb'); destroyChart('luma');

  state.charts.buffer = new LineChart($('#chart-buffer'), {
    series: [{ key: 'buf', label: 'Buffer à frente', colorVar: '--series-1', fill: true }],
    yFormat: (v) => v.toFixed(1).replace('.', ',') + 's',
    xFormat: fmtClock, windowSec: 120, height: 180, yMin: 0,
  });
  state.charts.bitrate = new LineChart($('#chart-bitrate'), {
    series: [
      { key: 'level', label: 'Bitrate do nível ativo', colorVar: '--series-1', step: true },
      { key: 'bw', label: 'Banda estimada', colorVar: '--series-2' },
    ],
    yFormat: (v) => v.toFixed(1).replace('.', ',') + ' Mbps',
    xFormat: fmtClock, windowSec: 120, height: 200, yMin: 0,
  });
  state.charts.lumaT = new LineChart($('#chart-luma-t'), {
    series: [
      { key: 'apl', label: 'Luminância média (APL %)', colorVar: '--series-5' },
      { key: 'clipH', label: 'Realces estourados (% px)', colorVar: '--series-3' },
      { key: 'clipL', label: 'Sombras esmagadas (% px)', colorVar: '--series-1' },
    ],
    yFormat: (v) => v.toFixed(1).replace('.', ',') + '%',
    xFormat: fmtClock, windowSec: 120, height: 200, yMin: 0,
  });
  state.charts.rgb = new LineChart($('#chart-rgb'), {
    series: [
      { key: 'r', label: 'Canal R', colorVar: '--ch-r', fill: true },
      { key: 'g', label: 'Canal G', colorVar: '--ch-g', fill: true },
      { key: 'b', label: 'Canal B', colorVar: '--ch-b', fill: true },
    ],
    yFormat: (v) => v.toFixed(2).replace('.', ',') + '%',
    xFormat: (v) => String(Math.round(v)),
    xMin: 0, xMax: 255, height: 220, yMin: 0,
  });
  state.charts.luma = new LineChart($('#chart-luma'), {
    series: [{ key: 'y', label: 'Luminância', colorVar: '--series-5', fill: true }],
    yFormat: (v) => v.toFixed(2).replace('.', ',') + '%',
    xFormat: (v) => String(Math.round(v)),
    xMin: 0, xMax: 255, height: 220, yMin: 0,
  });
  destroyChart('chroma');
  state.charts.chroma = new StreamChromaticity.ChromaticityChart($('#chart-chroma'), { height: 340 });
  $('#tile-latency-box').hidden = !isLive;
}

function updateTiles(t) {
  const video = $('#video');
  $('#tile-time').textContent = fmtClock(video.currentTime || 0);
  $('#tile-res').textContent = video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : '—';
  const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
  if (q) $('#tile-dropped').textContent = `${q.droppedVideoFrames} / ${q.totalVideoFrames}`;
  const states = video.paused ? 'pausado' : video.readyState < 3 ? 'carregando' : 'reproduzindo';
  $('#tile-state').textContent = states;
}

function startTelemetry(model, isLive) {
  const video = $('#video');
  state.analyzer = new ColorAnalyzer(video);
  state.t0 = performance.now();
  state.lastDropped = 0;
  let colorTick = 0;

  state.timer = setInterval(() => {
    const t = (performance.now() - state.t0) / 1000;

    // buffer à frente do cursor
    let buf = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= video.currentTime && video.currentTime <= video.buffered.end(i)) {
        buf = video.buffered.end(i) - video.currentTime;
        break;
      }
    }
    state.charts.buffer && state.charts.buffer.push(t, { buf });

    // bitrate do nível ativo + banda estimada
    let level = null, bw = null, latency = null;
    if (state.playerKind === 'hls' && state.player) {
      const lv = state.player.levels && state.player.levels[state.player.currentLevel];
      if (lv) level = lv.bitrate / 1e6;
      if (state.player.bandwidthEstimate) bw = state.player.bandwidthEstimate / 1e6;
      if (isLive) latency = state.player.latency;
    } else if (state.playerKind === 'dash' && state.player) {
      try {
        const list = state.player.getBitrateInfoListFor('video');
        const qi = state.player.getQualityFor('video');
        if (list && list[qi]) level = list[qi].bitrate / 1e6;
        const tp = state.player.getAverageThroughput('video');
        if (tp) bw = tp / 1000;
        if (isLive) latency = state.player.getCurrentLiveLatency();
      } catch { /* player ainda inicializando */ }
    } else if (state.playerKind === 'shaka' && state.player) {
      try {
        const stats = state.player.getStats();
        const active = state.player.getVariantTracks().find((tr) => tr.active);
        if (active && active.bandwidth) level = active.bandwidth / 1e6;
        if (stats && stats.estimatedBandwidth) bw = stats.estimatedBandwidth / 1e6;
        if (isLive) { const range = state.player.seekRange(); latency = range.end - video.currentTime; }
      } catch { /* player ainda inicializando */ }
    }
    state.charts.bitrate && state.charts.bitrate.push(t, { level, bw });
    if (level != null) $('#tile-bitrate').textContent = level.toFixed(2).replace('.', ',') + ' Mbps';
    if (bw != null) $('#tile-bw').textContent = bw.toFixed(1).replace('.', ',') + ' Mbps';
    if (latency != null && !isNaN(latency)) $('#tile-latency').textContent = latency.toFixed(1).replace('.', ',') + 's';

    updateTiles(t);

    // análise de cor a cada 3 ciclos (~1,5s)
    if (++colorTick % 3 === 0 && !state.drmBlocked) {
      const s = state.analyzer.sample();
      if (s && s.blocked) {
        state.drmBlocked = true;
        $('#color-note-runtime').textContent =
          'Análise de cor indisponível: o navegador bloqueou a leitura dos pixels (conteúdo protegido/DRM ou CORS sem cabeçalhos).';
      } else if (s) {
        const toPoints = (h) => Array.from(h, (v, i) => [i, v]);
        state.charts.rgb.setSeriesData('r', toPoints(s.histR));
        state.charts.rgb.setSeriesData('g', toPoints(s.histG));
        state.charts.rgb.setSeriesData('b', toPoints(s.histB));
        state.charts.luma.setSeriesData('y', toPoints(s.histY));
        state.charts.lumaT.push(t, { apl: s.avgLuma, clipH: s.clipHighPct, clipL: s.clipLowPct });
        state.charts.chroma.setPoints(s.chromaPoints);
        $('#tile-apl').textContent = s.avgLuma.toFixed(1).replace('.', ',') + '%';
      }
    }
  }, 500);
}

function startPlayback(type, url, model, isLive) {
  const video = $('#video');
  state.drmBlocked = false;
  $('#color-note-runtime').textContent = '';
  state.lastPlay = { type, url, model, isLive };

  if (state.engine === 'shaka') {
    startShakaPlayback(video, url, model, isLive);
    return;
  }

  if (type === 'hls') {
    if (!window.Hls || !Hls.isSupported()) {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
      } else {
        logEvent('hls.js não suportado neste navegador — playback desativado.');
        return;
      }
    } else {
      const hls = new Hls({ enableWorker: true, capLevelToPlayerSize: false });
      state.player = hls;
      state.playerKind = 'hls';
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.LEVEL_SWITCHED, (_, d) => {
        const lv = hls.levels[d.level];
        if (lv) logEvent(`Troca de nível → ${lv.width}×${lv.height} @ ${P.fmtBits(lv.bitrate)}`);
      });
      hls.on(Hls.Events.ERROR, (_, d) => {
        logEvent(`Erro hls.js [${d.type}/${d.details}]${d.fatal ? ' (FATAL)' : ''}`);
        if (d.fatal) {
          if (d.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
          else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        }
      });
    }
  } else {
    const player = dashjs.MediaPlayer().create();
    state.player = player;
    state.playerKind = 'dash';
    player.initialize(video, url, true);
    player.on(dashjs.MediaPlayer.events.QUALITY_CHANGE_RENDERED, (e) => {
      if (e.mediaType !== 'video') return;
      try {
        const info = player.getBitrateInfoListFor('video')[e.newQuality];
        if (info) logEvent(`Troca de nível → ${info.width}×${info.height} @ ${P.fmtBits(info.bitrate)}`);
      } catch { /* ignore */ }
    });
    player.on(dashjs.MediaPlayer.events.ERROR, (e) => {
      logEvent(`Erro dash.js: ${(e.error && (e.error.message || e.error.code)) || 'desconhecido'}`);
    });
  }

  video.muted = true;
  video.play().catch(() => logEvent('Autoplay bloqueado — clique no player para iniciar.'));
  video.addEventListener('waiting', () => logEvent('Rebuffering (waiting)…'), { once: false });

  startTelemetry(model, isLive);
}

async function startShakaPlayback(video, url, model, isLive) {
  if (!window.shaka || !shaka.Player.isBrowserSupported()) {
    logEvent('Shaka Player não suportado neste navegador.');
    return;
  }
  const player = new shaka.Player();
  state.player = player;
  state.playerKind = 'shaka';
  try {
    await player.attach(video);
  } catch (e) {
    logEvent('Erro ao anexar o Shaka Player ao vídeo: ' + e.message);
    return;
  }

  player.addEventListener('error', (e) => {
    const detail = e.detail || {};
    logEvent(`Erro Shaka [código ${detail.code}]${detail.severity >= 2 ? ' (FATAL)' : ''}`);
  });
  player.addEventListener('adaptation', () => {
    const active = player.getVariantTracks().find((t) => t.active);
    if (active && active.width) logEvent(`Troca de nível → ${active.width}×${active.height} @ ${P.fmtBits(active.bandwidth)}`);
  });
  player.addEventListener('buffering', (e) => { if (e.buffering) logEvent('Rebuffering (buffering)…'); });

  try {
    await player.load(url);
  } catch (e) {
    logEvent(`Erro ao carregar no Shaka Player [${e.code || '—'}]: ${e.message || e}`);
    return;
  }

  video.muted = true;
  video.play().catch(() => logEvent('Autoplay bloqueado — clique no player para iniciar.'));

  startTelemetry(model, isLive);
}

/* ================================================================ *
 * Painel SDR/HDR
 * ================================================================ */

function renderHdrPanel(model) {
  const ranges = [...new Set((model.video || []).map((v) => v.videoRange))];
  const hdr = (model.video || []).some((v) => v.hdr);
  const info = {
    'Sinalização no manifest': ranges.length ? ranges.join(' · ') : 'não declarada',
    'Conteúdo HDR': hdr ? 'Sim (' + (model.video || []).filter((v) => v.hdr).length + ' variante(s))' : 'Não — SDR',
    ...displayHdrInfo(),
  };
  renderKV($('#hdr-overview'), info);
  $('#color-note-hdr').textContent = hdr
    ? 'Atenção: as curvas abaixo são calculadas sobre os pixels APÓS o tone-mapping do navegador ' +
      '(canvas 8-bit). Para conteúdo PQ/HLG, use-as para avaliar a distribuição tonal do resultado ' +
      'renderizado; a sinalização HDR real é a do manifest, acima.'
    : 'Conteúdo SDR: as curvas refletem diretamente o sinal 8-bit decodificado.';
}

/* ================================================================ *
 * Log de eventos
 * ================================================================ */

function logEvent(msg) {
  const ul = $('#event-log');
  const li = el('li');
  li.appendChild(el('span', 'ev-time', new Date().toLocaleTimeString('pt-BR')));
  li.appendChild(el('span', null, ' ' + msg));
  ul.prepend(li);
  while (ul.children.length > 200) ul.removeChild(ul.lastChild);
}

/* ================================================================ *
 * Fluxo principal
 * ================================================================ */

function setStatus(msg, kind) {
  const s = $('#status');
  s.textContent = msg || '';
  s.className = 'status ' + (kind || '');
  s.hidden = !msg;
}

async function inspect(url) {
  const btn = $('#btn-run');
  btn.disabled = true;
  btn.textContent = 'Analisando…';
  setStatus('Baixando manifest…', 'busy');
  $('#event-log').innerHTML = '';
  stopPlayback();
  state.lastPlay = null;
  for (const k of Object.keys(state.charts)) destroyChart(k);

  try {
    const { text, effectiveUrl, proxied } = await fetchManifest(url);
    const type = detectType(url, text);
    logEvent(`Manifest carregado ${proxied ? 'via proxy local' : 'diretamente'} (${text.length.toLocaleString('pt-BR')} bytes).`);

    const model = type === 'hls' ? P.parseM3U8(text, effectiveUrl) : P.parseMPD(text, effectiveUrl);

    $('#results').hidden = false;
    renderBadges(model);
    renderKV($('#overview'), { ...model.overview, 'URL': url, 'Obtido via': proxied ? 'proxy local (/p/)' : 'fetch direto' });
    $('#raw-manifest').textContent = text.length > 200000 ? text.slice(0, 200000) + '\n… (truncado)' : text;

    renderTable($('#video-table'), VIDEO_COLUMNS, model.video || [], 'Nenhuma variante de vídeo declarada neste manifest.');
    renderTable($('#audio-table'), AUDIO_COLUMNS, model.audio || [], 'Nenhuma faixa de áudio alternativa declarada (áudio pode estar muxado no vídeo).');
    renderTable($('#subs-table'), SUB_COLUMNS, [...(model.subtitles || []), ...(model.closedCaptions || [])], 'Nenhuma faixa de legendas/closed captions declarada.');
    renderTable($('#drm-table'), DRM_COLUMNS, (model.drm || []).length ? model.drm : [], 'Nenhum sistema de DRM/criptografia declarado no manifest.');
    renderHdrPanel(model);

    let isLive = /AO VIVO/.test(model.overview['Transmissão'] || '');
    let resolvedMediaModel = null;

    // Segmentos
    if (model.protocol === 'HLS' && model.kind === 'master') {
      const withUri = (model.video || []).filter((v) => v.uri);
      if (withUri.length) {
        const top = withUri.reduce((a, b) => ((b.bandwidth || 0) > (a.bandwidth || 0) ? b : a));
        setStatus('Baixando playlist da variante de maior bitrate…', 'busy');
        try {
          const mp = await fetchManifest(top.uri);
          const mediaModel = P.parseM3U8(mp.text, mp.effectiveUrl);
          resolvedMediaModel = mediaModel;
          if (mediaModel.kind === 'media') {
            isLive = mediaModel.live;
            model.overview['Transmissão'] = mediaModel.live ? 'AO VIVO (sem EXT-X-ENDLIST)' : 'VOD (finalizada)';
            renderBadges(model);
            renderSegments(
              { ...mediaModel, count: mediaModel.segments.length, list: mediaModel.segments, targetDuration: mediaModel.targetDuration, totalDuration: mediaModel.totalDuration },
              `playlist da variante ${top.resolution} @ ${P.fmtBits(top.bandwidth)}`
            );
            renderKV($('#overview'), {
              ...model.overview,
              'Transmissão': mediaModel.live ? 'AO VIVO (sem EXT-X-ENDLIST)' : 'VOD (finalizada)',
              'Duração total': P.fmtDur(mediaModel.totalDuration),
              'URL': url,
              'Obtido via': proxied ? 'proxy local (/p/)' : 'fetch direto',
            });
            if (mediaModel.drm.length && !(model.drm || []).length) {
              renderTable($('#drm-table'), DRM_COLUMNS, mediaModel.drm, '');
            }
          }
        } catch (e) {
          logEvent('Não foi possível carregar a playlist da variante: ' + e.message);
          renderSegments(null);
        }
      }
    } else if (model.protocol === 'HLS' && model.kind === 'media') {
      renderSegments(
        { ...model, count: model.segments.length, list: model.segments, targetDuration: model.targetDuration, totalDuration: model.totalDuration },
        'playlist de mídia (URL informada)'
      );
      resolvedMediaModel = model;
    } else if (model.protocol === 'DASH') {
      renderSegments(model.segments, model.segments && model.segments.source);
    }

    // Container real — não bloqueia o restante da UI
    probeContainer(model.protocol, resolvedMediaModel, model.protocol === 'DASH' ? model : null);

    // Playback + telemetria
    setupTelemetryCharts(isLive);
    const playUrl = proxied ? proxify(url) : url;
    setStatus('', '');
    startPlayback(type, playUrl, model, isLive);
    logEvent('Playback iniciado (mudo) para telemetria e análise de cor.');
  } catch (e) {
    console.error(e);
    setStatus('Erro: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Inspecionar';
  }
}

/* ================================================================ *
 * Bootstrap
 * ================================================================ */

document.addEventListener('DOMContentLoaded', () => {
  $('#form').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('#url').value.trim();
    if (!url) return;
    inspect(url);
  });

  for (const b of document.querySelectorAll('[data-example]')) {
    b.addEventListener('click', () => {
      $('#url').value = b.dataset.example;
      inspect(b.dataset.example);
    });
  }

  for (const r of document.querySelectorAll('input[name="engine"]')) {
    r.addEventListener('change', (e) => {
      state.engine = e.target.value;
      logEvent(`Motor de reprodução alterado para ${state.engine === 'shaka' ? 'Shaka Player' : 'HLS.js'}.`);
      if (state.lastPlay) {
        stopPlayback();
        const { type, url, model, isLive } = state.lastPlay;
        startPlayback(type, url, model, isLive);
      }
    });
  }
});
