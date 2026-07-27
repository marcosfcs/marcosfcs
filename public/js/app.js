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
  player: null,        // instância Hls ou shaka.Player (a real, obtida via Clappr)
  playerKind: null,    // 'hls' | 'shaka' | 'progressive'
  engine: 'hls-1.5.14',      // chave de ENGINE_BUNDLES — motor+versão atual
  engineManuallySet: false,  // true depois que o usuário troca no combo-box (não sobrescreve mais por tipo de manifest)
  clapprPlayer: null,  // instância Clappr.Player que envelopa o <video> real
  timer: null,
  analyzer: null,
  t0: 0,
  forcedLevel: -1,     // -1 = ABR automático; >=0 = nível travado manualmente
  lastDropped: 0,
  lastTotalFrames: 0,
  lastQuality: null,   // último getVideoPlaybackQuality() (stash de updateTiles)
  dropAccum: 0,        // frames descartados acumulados desde o último log
  lastDropLogT: 0,     // throttle do log de dropped frames
  lastDropRate: null,  // taxa de descarte do tick corrente (p/ alerta highDropRate)
  drmBlocked: false,
  lastPlay: null,      // { type, url, model, isLive } — p/ trocar de motor sem re-inspecionar

  // telemetria avançada
  audioMeter: null,
  vuTimer: null,
  qoe: null,
  netmon: null,
  alertEngine: null,
  lastThumb: null,
  lastFreezeDiff: null,
  lastCurrentTime: 0,
  timeAdvancing: false,
  lastAudio: null,     // última leitura do AudioMeter
  lastColor: null,     // última amostra do ColorAnalyzer
  sessionUrl: null,
  sessionOverview: null,
  targetDuration: 6,   // p/ alerta de playlist estagnada

  // frentes novas: rede real, CDN/edge, colorSpace
  resTimingMon: null,
  headerSniffer: null,
  colorSpaceProbe: null,
  cdnHeaders: {},      // header -> valor (última amostra vista)
  lufsIntegrated: null,
  truePeak: null,      // máximo entre truePeakL/truePeakR (dBTP)

  // análise de qualidade PSNR/SSIM
  qualityCompare: null,
  qualityTimer: null,
  qualityPlayer: null,
  qualityStartTimeout: null,
  _qualityCleanupListeners: null,
};

/* ================================================================ *
 * Clappr + motores (hls.js/Shaka) sob demanda
 *
 * hls.js e Shaka são carregados dinamicamente (não mais via <script>
 * estático) porque agora existem 2 versões de cada um lado a lado
 * (a "da Globo", usada em produção, e a mais recente do GitHub) e só uma
 * pode ocupar window.Hls/window.shaka por vez. Trocar de motor no
 * combo-box troca esse global e reexecuta o plugin de playback do Clappr
 * (hlsjs-playback/dash-shaka-playback), que capturam window.Hls/window.shaka
 * no momento em que o próprio script deles roda — por isso a ordem de
 * carregamento importa (engine primeiro, plugin depois).
 * ================================================================ */

const ENGINE_BUNDLES = {
  'hls-1.5.14': { kind: 'hls', src: 'vendor/hls-1.5.14.min.js', label: 'HLS.js 1.5.14 (Globo)' },
  'hls-1.6.16': { kind: 'hls', src: 'vendor/hls-1.6.16.min.js', label: 'HLS.js 1.6.16 (mais recente)' },
  'shaka-3.1.8': { kind: 'shaka', src: 'vendor/shaka-3.1.8.compiled.js', label: 'Shaka Player 3.1.8 (Globo)' },
  'shaka-5.2.2': { kind: 'shaka', src: 'vendor/shaka-5.2.2.compiled.js', label: 'Shaka Player 5.2.2 (mais recente)' },
};

/** Qual caminho leu os pixels do frame p/ a nuvem de cromaticidade — ver colorspace.js. */
const PIXEL_METHOD_LABEL = {
  'raw': 'Bruta — planos do VideoFrame (dado mestre, sem tone-mapping)',
  'rgba-p3': 'Conversão RGBA/Display-P3 pelo navegador (já tone-mapped)',
  'rgba-srgb': 'Conversão RGBA/sRGB pelo navegador (já tone-mapped)',
  'none': 'Falhou — sem leitura direta',
};
const CHROMA_NOTE = {
  'raw': (out) => 'Amostragem via WebCodecs (VideoFrame bruto) — gamut real do conteúdo decodificado, ' +
    `sem tone-mapping de canvas. Saída: ${out === 'display-p3' ? 'Display-P3' : 'sRGB'}.`,
  'rgba-p3': () => 'Amostragem via conversão RGBA/Display-P3 feita pelo próprio navegador — o formato bruto ' +
    'do frame não pôde ser lido diretamente. As cores já passaram pelo tone-mapping do navegador: não são o dado mestre.',
  'rgba-srgb': () => 'Amostragem via conversão RGBA/sRGB feita pelo próprio navegador — já tone-mapped, limitada ao gamut sRGB.',
};

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Falha ao carregar ' + src));
    document.body.appendChild(s);
  });
}

let _loadedEngineKey = null;

/** Garante que window.Hls/window.shaka (versão pedida) e o respectivo
 * plugin de playback do Clappr estejam carregados. Retorna 'hls'|'shaka'. */
async function ensureEngineLoaded(key) {
  const cfg = ENGINE_BUNDLES[key];
  if (_loadedEngineKey === key) return cfg.kind;
  await loadScriptOnce(cfg.src);
  if (cfg.kind === 'hls') {
    await loadScriptOnce('vendor/clappr/hlsjs-playback.external.min.js');
  } else {
    if (shaka.polyfill && shaka.polyfill.installAll) shaka.polyfill.installAll();
    await loadScriptOnce('vendor/clappr/dash-shaka-playback.external.min.js');
  }
  _loadedEngineKey = key;
  return cfg.kind;
}

/** window.Hls "cru" (fora do Clappr) usado só pela comparação de qualidade
 * PSNR/SSIM (attachLockedVariant) — garante que exista mesmo se o motor
 * principal escolhido for Shaka (nesse caso window.Hls nunca foi carregado). */
async function ensureHlsGlobal() {
  if (window.Hls) return;
  await loadScriptOnce(ENGINE_BUNDLES['hls-1.5.14'].src);
}

/** O <video> real é criado pelo próprio Clappr (Core/Container/Playback),
 * não existe mais um <video id="video"> estático no HTML — todo o resto do
 * app (VU meter, WebCodecs, telemetria, alertas, QoE) lê o elemento por
 * aqui em vez de document.querySelector('#video') direto. */
function videoEl() {
  const p = state.clapprPlayer;
  return (p && p.core && p.core.activePlayback && p.core.activePlayback.el) || null;
}

/** Espera até `_hls`/`shakaPlayerInstance` (a instância real por baixo do
 * plugin de playback do Clappr) ficar disponível — Clappr não expõe um
 * evento síncrono e estável entre versões pra isso, então faz polling curto
 * em vez de depender do nome exato de um evento interno. */
function waitForEngineInstance(clapprPlayer, kind, timeoutMs) {
  const timeout = timeoutMs || 8000;
  return new Promise((resolve, reject) => {
    const start = performance.now();
    (function poll() {
      const pb = clapprPlayer.core && clapprPlayer.core.activePlayback;
      const instance = pb && (kind === 'hls' ? pb._hls : (pb.shakaPlayerInstance || pb._player));
      if (instance) return resolve(instance);
      if (performance.now() - start > timeout) return reject(new Error('Timeout esperando o motor de playback inicializar.'));
      requestAnimationFrame(poll);
    })();
  });
}

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
  { label: 'Codec de vídeo', get: (v) => v.codecs.filter((c) => isVideo(c)).map(P.codecName).join(', ') || v.codecs.map(P.codecName).join(', ') },
  { label: 'Codec de áudio', get: (v) => v.codecs.filter((c) => isAudio(c)).map(P.codecName).join(', ') || '—' },
  { label: 'String de codec', get: (v) => v.codecs.join(', '), mono: true },
  { label: 'Curva de Cor', get: (v) => rangeCell(v) },
  { label: 'Extras', get: (v) => videoExtras(v) },
];

function isVideo(c) { return /^(avc|hvc|hev|dvh|dav1|av01|vp0?9)/i.test(c); }
function isAudio(c) { return /^(mp4a|ac-3|ec-3|ac-4|opus|flac|mp3)/i.test(c); }

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

  const recent = seg.list.slice(-3);
  const older = seg.list.slice(-63, -3);
  renderTable($('#seg-table'), SEG_COLUMNS, recent, '');

  const olderWrap = $('#seg-table-older-wrap');
  if (older.length) {
    olderWrap.hidden = false;
    $('#seg-table-older-summary').textContent = `Ver os demais ${older.length} segmentos`;
    renderTable($('#seg-table-older'), SEG_COLUMNS, older, '');
  } else {
    olderWrap.hidden = true;
    $('#seg-table-older').innerHTML = '';
  }

  $('#seg-table-note').textContent =
    seg.list.length > 63 ? `Exibindo os últimos 63 de ${seg.list.length} segmentos (3 em execução + demais no dropdown).` : '';
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
  if (protocol === 'directUrl' && hlsMediaModel) {
    sampleUrl = hlsMediaModel;   // string com a URL de mídia direta (YouTube progressivo)
    kindHint = 'fmp4';
  } else if (protocol === 'HLS' && hlsMediaModel) {
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
  if (state.vuTimer) { clearInterval(state.vuTimer); state.vuTimer = null; }
  if (state.audioMeter) { state.audioMeter.destroy(); state.audioMeter = null; }
  if (state.qoe) { state.qoe.destroy(); state.qoe = null; }
  if (state.netmon) { state.netmon.destroy(); state.netmon = null; }
  if (state.resTimingMon) { state.resTimingMon.destroy(); state.resTimingMon = null; }
  if (state.headerSniffer) { state.headerSniffer.destroy(); state.headerSniffer = null; }
  if (state.colorSpaceProbe) { state.colorSpaceProbe.destroy(); state.colorSpaceProbe = null; }
  stopQualityCompare();
  state.lastThumb = null;
  state.lastFreezeDiff = null;
  state.lastAudio = null;
  state.lastColor = null;
  // Clappr.destroy() já derruba o motor real por baixo (Playback.destroy()
  // chama _hls.destroy()/shakaPlayerInstance.destroy()) e remove o <video>
  // que ele mesmo criou — não precisa mais destruir state.player à parte.
  if (state.clapprPlayer) {
    try { state.clapprPlayer.destroy(); } catch { /* já destruído */ }
    state.clapprPlayer = null;
  }
  state.player = null;
  state.playerKind = null;
}

function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function setupTelemetryCharts(isLive) {
  // única origem do eixo X (wall-clock) para todos os gráficos temporais desta
  // sessão de inspeção — reseta aqui (inspeção nova), não em startTelemetry(),
  // para que uma troca de motor no meio da sessão preserve a continuidade.
  state.t0 = performance.now();
  destroyChart('buffer'); destroyChart('bitrate'); destroyChart('lumaT');
  destroyChart('rgb'); destroyChart('luma');
  destroyChart('audioLevel'); destroyChart('spectrum'); destroyChart('lufs');
  destroyChart('ttfb'); destroyChart('throughput');
  destroyChart('bufferTimeline');

  state.charts.bufferTimeline = new BufferTimeline($('#buffer-timeline'), { height: 46 });
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
  state.charts.chroma = new StreamChromaticity.Chromaticity3DChart($('#chart-chroma'), { fillHeight: true });
  destroyChart('chroma3d');
  state.charts.chroma3d = new StreamChromaticity.Chromaticity3DChart($('#chart-chroma-3d'), { height: 340 });

  // áudio
  state.charts.audioLevel = new LineChart($('#chart-audio-level'), {
    series: [
      { key: 'l', label: 'Canal esquerdo (RMS)', colorVar: '--series-1' },
      { key: 'r', label: 'Canal direito (RMS)', colorVar: '--series-2' },
    ],
    yFormat: (v) => v.toFixed(0) + ' dBFS',
    xFormat: fmtClock, windowSec: 120, height: 180, yMin: -60, yMax: 0,
  });
  state.charts.spectrum = new LineChart($('#chart-spectrum'), {
    series: [{ key: 's', label: 'Espectro', colorVar: '--series-2', fill: true }],
    yFormat: (v) => (v * 100).toFixed(0) + '%',
    xFormat: (v) => (v * (state.audioBinHz || 250) / 1000).toFixed(1) + ' kHz',
    xMin: 0, xMax: 95, height: 160, yMin: 0, yMax: 1,
  });
  state.charts.lufs = new LineChart($('#chart-lufs'), {
    series: [
      { key: 'm', label: 'Momentary', colorVar: '--series-2' },
      { key: 's', label: 'Short-term', colorVar: '--series-1' },
      { key: 'i', label: 'Integrated', colorVar: '--series-5' },
    ],
    yFormat: (v) => v.toFixed(1).replace('.', ',') + ' LUFS',
    xFormat: fmtClock, windowSec: 120, height: 200, yMin: -40, yMax: 0,
  });
  $('#network-breakdown-table').innerHTML = '';
  $('#cdn-table').innerHTML = '';
  $('#cmcd-overview').innerHTML = '';
  $('#adbreaks-table').innerHTML = '';
  state.cdnHeaders = {};
  state._netBreakdownRows = [];
  state.lufsIntegrated = null;
  state.truePeak = null;

  // rede
  state.charts.ttfb = new LineChart($('#chart-ttfb'), {
    series: [{ key: 'ttfb', label: 'TTFB do segmento', colorVar: '--series-3' }],
    yFormat: (v) => v.toFixed(0) + ' ms',
    xFormat: fmtClock, windowSec: 120, height: 160, yMin: 0,
  });
  state.charts.throughput = new LineChart($('#chart-throughput'), {
    series: [{ key: 'tp', label: 'Throughput do segmento', colorVar: '--series-2' }],
    yFormat: (v) => v.toFixed(1).replace('.', ',') + ' Mbps',
    xFormat: fmtClock, windowSec: 120, height: 160, yMin: 0,
  });

  $('#tile-latency-box').hidden = !isLive;
  $('#tile-e2e-box').hidden = true;
}

function updateTiles(t) {
  const video = videoEl();
  $('#tile-time').textContent = fmtClock(video.currentTime || 0);
  $('#tile-res').textContent = video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : '—';
  const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
  state.lastQuality = q; // reaproveitado pelo tick para o delta/log de dropped frames
  if (q) $('#tile-dropped').textContent = `${q.droppedVideoFrames} / ${q.totalVideoFrames}`;
  const states = video.paused ? 'pausado' : video.readyState < 3 ? 'carregando' : 'reproduzindo';
  $('#tile-state').textContent = states;
}

// Tolerância de ±2 dB em torno do alvo integrado é definida pela própria
// norma (ABNT NBR 15602 / ATSC A/85) — não é configurável pelo usuário.
const LUFS_TOLERANCE_DB = 2;

function readThresholds() {
  return {
    silenceDbfs: Number($('#th-silence').value) || -50,
    freezeSec: Number($('#th-freeze').value) || 5,
    bufferSec: Number($('#th-buffer').value) || 2,
    lufsTarget: Number($('#th-lufs').value) || -24,
    truePeakMax: Number($('#th-truepeak').value) || -2,
  };
}

function setupAlertEngine(model, isLive) {
  const video = videoEl();
  const engine = new AlertEngine({
    listEl: $('#alert-list'),
    onLog: logEvent,
    thresholds: readThresholds(),
  });
  const th = () => engine.thresholds;
  const playing = () => !video.paused && video.readyState >= 3 && !video.ended;

  engine.register('freeze', {
    label: 'Possível congelamento de vídeo (frame estático com tempo avançando)',
    severity: 'critical',
    get sustainSec() { return th().freezeSec; },
    test: (c) => {
      if (!playing() || !c.timeAdvancing || c.freezeDiff == null) return null;
      return c.freezeDiff < 0.5;
    },
  });
  // Stall (stale): o relógio de mídia PAROU enquanto o player deveria estar
  // tocando — diferente do freeze (frame estático COM o tempo avançando) e do
  // rebuffering (readyState cai <3, então playing() vira false e não conta).
  engine.register('stall', {
    label: 'Reprodução travada (relógio de mídia parado / stall)',
    severity: 'critical',
    sustainSec: 1,
    test: (c) => {
      if (!playing()) return null;
      return c.timeAdvancing === false;
    },
  });
  // Só dispara com tela preta E sem áudio ao mesmo tempo — tela preta com
  // áudio tocando normalmente costuma ser conteúdo legítimo (fade/tela de
  // abertura), não uma falha real de playback.
  engine.register('black', {
    label: 'Tela preta prolongada sem áudio',
    severity: 'critical',
    sustainSec: 3,
    test: (c) => {
      if (!playing() || c.avgLuma == null) return null;
      if (c.avgLuma >= 2) return false; // tela não está preta
      if (c.dbfsMax == null || c.audioTainted) return null; // preta, mas sem leitura confiável de áudio
      return c.dbfsMax < th().silenceDbfs; // preta E sem áudio
    },
  });
  engine.register('silence', {
    label: 'Silêncio de áudio prolongado',
    severity: 'critical',
    sustainSec: 5,
    test: (c) => {
      if (!playing() || c.dbfsMax == null || c.audioTainted) return null;
      return c.dbfsMax < th().silenceDbfs;
    },
  });
  engine.register('lowBuffer', {
    label: 'Buffer de reprodução baixo',
    severity: 'warning',
    sustainSec: 3,
    test: (c) => {
      if (!playing() || c.buffer == null) return null;
      return c.buffer < th().bufferSec;
    },
  });
  engine.register('lowBandwidth', {
    label: 'Banda estimada abaixo do bitrate do nível ativo',
    severity: 'warning',
    sustainSec: 10,
    test: (c) => {
      if (c.bwMbps == null || c.levelMbps == null) return null;
      return c.bwMbps < c.levelMbps;
    },
  });
  engine.register('lowFps', {
    label: 'FPS de apresentação abaixo de 50% do nominal',
    severity: 'warning',
    sustainSec: 10,
    test: (c) => {
      if (!playing() || c.fps == null || !c.nominalFps) return null;
      return c.fps < c.nominalFps * 0.5;
    },
  });
  // Descarte de frames PERSISTENTE (>5% dos frames do tick) — bursts isolados
  // saem só como linha de log throttled; aqui só entra o descarte sustentado.
  engine.register('highDropRate', {
    label: 'Taxa alta de descarte de frames (decoder/CPU sobrecarregado)',
    severity: 'warning',
    sustainSec: 10,
    test: (c) => {
      if (!playing() || c.dropRate == null) return null;
      return c.dropRate > 0.05;
    },
  });
  engine.register('loudness', {
    label: 'Loudness (Integrated) fora da faixa de compliance ABNT NBR 15602 (±2 dB do alvo)',
    severity: 'warning',
    sustainSec: 5,
    test: (c) => {
      if (!playing() || c.lufsIntegrated == null) return null;
      const target = th().lufsTarget;
      return c.lufsIntegrated > target + LUFS_TOLERANCE_DB || c.lufsIntegrated < target - LUFS_TOLERANCE_DB;
    },
  });
  engine.register('truePeak', {
    label: 'True Peak acima do limite de compliance ABNT NBR 15602',
    severity: 'warning',
    sustainSec: 5,
    test: (c) => {
      if (!playing() || c.truePeak == null) return null;
      return c.truePeak > th().truePeakMax;
    },
  });
  if (isLive) {
    engine.register('stalePlaylist', {
      label: 'Playlist/manifest live estagnado (sem atualização)',
      severity: 'critical',
      sustainSec: 0,
      test: (c) => {
        if (c.manifestAgeSec == null) return null;
        return c.manifestAgeSec > 3 * (state.targetDuration || 6);
      },
    });
  }
  return engine;
}

function startTelemetry(model, isLive) {
  const video = videoEl();
  state.analyzer = new ColorAnalyzer(video);
  // state.t0 é definido em setupTelemetryCharts() (só numa inspeção nova) e
  // propositalmente NÃO é resetado aqui — startTelemetry() também roda numa
  // troca de motor (hls.js ↔ Shaka) em cima da mesma sessão de inspeção, e
  // resetar o t0 nesse caso faria os gráficos temporais "voltarem ao zero"
  // sem limpar os dados antigos (setupTelemetryCharts não é chamado na troca
  // de motor), sobrepondo pontos novos em cima dos antigos.
  if (state.t0 == null) state.t0 = performance.now();
  state.lastDropped = 0;
  state.lastTotalFrames = 0;
  state.lastQuality = null;
  state.dropAccum = 0;
  state.lastDropLogT = 0;
  state.lastDropRate = null;
  state.lastCurrentTime = video.currentTime;
  let colorTick = 0;

  // módulos de telemetria avançada
  const nominalFps = (model.video || []).map((v) => v.frameRate).find((f) => f) || null;
  state.qoe = new StreamQoe.QoeSession(video, { nominalFps });
  state.audioMeter = new AudioMeter(video);
  if (!state.audioMeter.ok) {
    $('#audio-note').textContent = 'Medição de áudio indisponível: ' + (state.audioMeter.error || 'Web Audio não suportado');
  } else {
    $('#audio-note').textContent = '';
  }
  if (state.player && state.playerKind) {
    state.netmon = new NetMonitor(state.player, state.playerKind, (s) => {
      const t = (performance.now() - state.t0) / 1000;
      if (s.ttfbMs != null) state.charts.ttfb && state.charts.ttfb.push(t, { ttfb: s.ttfbMs });
      state.charts.throughput && state.charts.throughput.push(t, { tp: s.throughputMbps });
      $('#tile-lastseg').textContent =
        `${(s.bytes / 1024 / 1024).toFixed(2).replace('.', ',')} MB @ ${s.throughputMbps.toFixed(0)} Mbps`;
    });
  }
  state.alertEngine = setupAlertEngine(model, isLive);

  // Rede real via Resource Timing API — independente do motor, cobre a
  // lacuna do Shaka (sem TTFB próprio) e o progressivo do YouTube.
  state.resTimingMon = new ResourceTimingMonitor((s) => {
    const t = (performance.now() - state.t0) / 1000;
    if (s.detailAvailable) {
      if (s.ttfbMs != null && !state.netmon) state.charts.ttfb && state.charts.ttfb.push(t, { ttfb: s.ttfbMs });
      if (s.throughputMbps != null && !state.netmon) state.charts.throughput && state.charts.throughput.push(t, { tp: s.throughputMbps });
    }
    addNetworkBreakdownRow(s);
  });

  // Headers de CDN/edge (+ eco de CMCD/CMSD) — só chega dado quando o
  // tráfego passa pelo proxy local ou a origem expõe via CORS; não
  // alcança o <video src> nativo do progressivo do YouTube.
  state.headerSniffer = new HeaderSniffer((url, headers) => {
    state.cdnHeaders = headers;
    renderCdnTable(url, headers);
    if (headers['cmsd-static'] || headers['cmsd-dynamic']) renderCmsd(headers);
    if (!state._cmcdShown) { maybeShowEmittedCmcd(url); if (state._cmcdKv) state._cmcdShown = true; }
  });

  // Espaço de cor real decodificado (WebCodecs) — Chromium-only hoje
  state.colorSpaceProbe = new ColorSpaceProbe(video);
  if (!state.colorSpaceProbe.ok) {
    renderKV($('#colorspace-overview'), { 'Status': state.colorSpaceProbe.error });
  }

  // VU meter em cadência própria (150 ms) para resposta visual adequada
  state.vuTimer = setInterval(() => {
    if (!state.audioMeter || !state.audioMeter.ok) return;
    const a = state.audioMeter.sample();
    if (!a) return;
    state.lastAudio = a;
    state.audioBinHz = a.binHz;
    updateVuMeter('l', a.dbfsL, a.peakL);
    updateVuMeter('r', a.dbfsR, a.peakR);
    if (a.taintedSuspect) {
      $('#audio-note').textContent =
        'Sinal de áudio permanentemente zerado com o vídeo em reprodução — provável bloqueio de CORS ' +
        '(mídia "tainted"): use o proxy local para liberar a medição.';
    }
  }, 150);

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
    state.charts.bufferTimeline && state.charts.bufferTimeline.update(video.buffered, video.currentTime, video.duration);

    // bitrate do nível ativo + banda estimada
    let level = null, bw = null, latency = null;
    if (state.playerKind === 'hls' && state.player) {
      const lv = state.player.levels && state.player.levels[state.player.currentLevel];
      if (lv) level = lv.bitrate / 1e6;
      if (state.player.bandwidthEstimate) bw = state.player.bandwidthEstimate / 1e6;
      if (isLive) latency = state.player.latency;
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
    refreshLadderActive(); // atualiza a marcação de nível ativo/travado nas pills
    if (level != null) $('#tile-bitrate').textContent = level.toFixed(2).replace('.', ',') + ' Mbps';
    if (bw != null) $('#tile-bw').textContent = bw.toFixed(1).replace('.', ',') + ' Mbps';
    if (latency != null && !isNaN(latency)) $('#tile-latency').textContent = latency.toFixed(1).replace('.', ',') + 's';

    updateTiles(t);

    // avanço do relógio de mídia (para distinguir freeze de pausa/stall)
    state.timeAdvancing = video.currentTime > state.lastCurrentTime + 0.01;
    state.lastCurrentTime = video.currentTime;

    // frames descartados (dropped): delta desde o último tick → log agregado e
    // throttled (~2s), e taxa do tick p/ o alerta highDropRate. Usa o
    // getVideoPlaybackQuality() já lido em updateTiles (state.lastQuality).
    const q = state.lastQuality;
    if (q) {
      const dDrop = Math.max(0, q.droppedVideoFrames - state.lastDropped);
      const dTotal = Math.max(0, q.totalVideoFrames - state.lastTotalFrames);
      state.lastDropRate = dTotal > 0 ? dDrop / dTotal : (dDrop > 0 ? 1 : 0);
      state.dropAccum += dDrop;
      if (state.dropAccum > 0 && t - state.lastDropLogT >= 2) {
        const pct = q.totalVideoFrames > 0
          ? ((q.droppedVideoFrames / q.totalVideoFrames) * 100).toFixed(1).replace('.', ',')
          : '—';
        logEvent(`Descartou ${state.dropAccum} frame(s) de vídeo (dropped) — total ` +
          `${q.droppedVideoFrames}/${q.totalVideoFrames} (${pct}%)`);
        state.dropAccum = 0;
        state.lastDropLogT = t;
      }
      state.lastDropped = q.droppedVideoFrames;
      state.lastTotalFrames = q.totalVideoFrames;
    }

    // áudio → série temporal
    if (state.lastAudio) {
      state.charts.audioLevel && state.charts.audioLevel.push(t, { l: state.lastAudio.dbfsL, r: state.lastAudio.dbfsR });
      if (state.charts.spectrum) {
        state.charts.spectrum.setSeriesData('s', Array.from(state.lastAudio.spectrum, (v, i) => [i, v]));
      }
      state.truePeak = Math.max(state.lastAudio.truePeakL, state.lastAudio.truePeakR);
      $('#tile-truepeak').textContent = state.truePeak.toFixed(1).replace('.', ',') + ' dBTP';
      const lu = state.lastAudio.lufs;
      if (lu) {
        state.charts.lufs && state.charts.lufs.push(t, { m: lu.momentary, s: lu.shortTerm, i: lu.integrated });
        $('#tile-lufs-m').textContent = lu.momentary.toFixed(1).replace('.', ',');
        if (lu.shortTerm != null) $('#tile-lufs-s').textContent = lu.shortTerm.toFixed(1).replace('.', ',');
        if (lu.integrated != null) {
          $('#tile-lufs-i').textContent = lu.integrated.toFixed(1).replace('.', ',');
          state.lufsIntegrated = lu.integrated;
        }
      } else if (state.audioMeter && state.audioMeter.ok && !state.audioMeter.lufsOk) {
        $('#lufs-note').textContent = 'LUFS indisponível: ' + (state.audioMeter.lufsError || 'IIRFilterNode não suportado');
      }
    }

    // QoE
    if (state.qoe) {
      state.qoe.tick();
      if (level != null) state.qoe.noteBitrate(level);
      if (state.qoe.fps != null) {
        $('#tile-fps').textContent = state.qoe.fps.toFixed(1).replace('.', ',') +
          (state.qoe.nominalFps ? ` / ${state.qoe.nominalFps}` : '');
      }
      if (Math.round(t * 2) % 4 === 0) updateQoeTiles(); // a cada ~2s
    }

    // latência E2E via PROGRAM-DATE-TIME
    if (state.netmon) {
      const e2e = state.netmon.e2eLatencySec(video);
      if (e2e != null) {
        $('#tile-e2e-box').hidden = false;
        $('#tile-e2e').textContent = e2e.toFixed(1).replace('.', ',') + 's';
      }
    }

    // alertas
    if (state.alertEngine) {
      state.alertEngine.evaluate(t, {
        buffer: buf,
        bwMbps: bw,
        levelMbps: level,
        dbfsMax: state.lastAudio ? Math.max(state.lastAudio.dbfsL, state.lastAudio.dbfsR) : null,
        audioTainted: state.lastAudio ? state.lastAudio.taintedSuspect : false,
        avgLuma: state.lastColor ? state.lastColor.avgLuma : null,
        freezeDiff: state.lastFreezeDiff,
        timeAdvancing: state.timeAdvancing,
        dropRate: state.lastDropRate,
        fps: state.qoe ? state.qoe.fps : null,
        nominalFps: state.qoe ? state.qoe.nominalFps : null,
        manifestAgeSec: state.netmon && isLive ? state.netmon.manifestAgeSec() : null,
        lufsIntegrated: state.lufsIntegrated,
        truePeak: state.truePeak,
      });
    }

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
        $('#tile-apl').textContent = s.avgLuma.toFixed(1).replace('.', ',') + '%';

        // cromaticidade: usa WebCodecs (gamut real, sem canvas) quando disponível;
        // senão cai no canvas 2D (aproximação sempre em Rec.709/SDR, documentada na UI)
        const chartOutput = state.charts.chroma ? state.charts.chroma.colorSpace : 'srgb';
        if (state.colorSpaceProbe && state.colorSpaceProbe.ok) {
          state.colorSpaceProbe.sample({ withPixels: true, output: chartOutput }).then((cs) => {
            if (!cs) return;
            const disp = window.displayHdrInfo();
            renderKV($('#colorspace-overview'), {
              'Primárias (decodificado)': cs.primaries,
              'Transferência (decodificado)': cs.transfer,
              'Matriz (decodificado)': cs.matrix,
              'Faixa completa (full range)': cs.fullRange == null ? '—' : (cs.fullRange ? 'Sim' : 'Não (limited/studio)'),
              'HDR real (decoder)': cs.hdr ? 'Sim' : 'Não — SDR',
              'Resolução codificada': `${cs.codedWidth}x${cs.codedHeight}`,
              'Leitura de pixels (cromaticidade)': PIXEL_METHOD_LABEL[cs.pixelMethod] || '—',
              'Gamut de saída do gráfico': chartOutput === 'display-p3'
                ? 'Display-P3 (canvas wide-gamut concedido)' : 'sRGB (canvas padrão)',
              'Display do usuário': `${disp['Faixa dinâmica do display']} · ${disp['Gama de cores do display']} · ${disp['Profundidade de cor reportada']}`,
            });
            if (cs.pixelsSupported && cs.chromaPoints && cs.chromaPoints.length) {
              state.charts.chroma.setPoints(cs.chromaPoints);
              state.charts.chroma3d.setPoints(cs.chromaPoints);
              $('#chroma-method-note').textContent = CHROMA_NOTE[cs.pixelMethod]
                ? CHROMA_NOTE[cs.pixelMethod](chartOutput)
                : CHROMA_NOTE.raw(chartOutput);
            } else {
              state.charts.chroma.setPoints(s.chromaPoints);
              state.charts.chroma3d.setPoints(s.chromaPoints);
              $('#chroma-method-note').textContent =
                'Amostragem via canvas 2D (aproximação) — formato de frame não suportado para leitura direta; limitada a Rec.709/SDR.';
            }
          }).catch(() => { /* frame indisponível nesse instante — mantém os pontos anteriores */ });
        } else {
          state.charts.chroma.setPoints(s.chromaPoints);
          state.charts.chroma3d.setPoints(s.chromaPoints);
          $('#chroma-method-note').textContent =
            'Amostragem via canvas 2D (aproximação) — WebCodecs indisponível neste navegador; limitada a Rec.709/SDR.';
        }

        // assinatura do frame para detecção de congelamento
        state.lastColor = s;
        state.lastFreezeDiff = window.thumbDiff(state.lastThumb, s.thumb);
        state.lastThumb = s.thumb;
      }
    }
  }, 500);
}

const NET_BREAKDOWN_COLUMNS = [
  { label: 'Segmento', get: (r) => r.name, mono: true },
  { label: 'DNS', get: (r) => fmtMsOrDash(r.dnsMs, r.detailAvailable) },
  { label: 'TCP', get: (r) => fmtMsOrDash(r.tcpMs, r.detailAvailable) },
  { label: 'TLS', get: (r) => fmtMsOrDash(r.tlsMs, r.detailAvailable) },
  { label: 'TTFB', get: (r) => fmtMsOrDash(r.ttfbMs, r.detailAvailable) },
  { label: 'Download', get: (r) => r.downloadMs.toFixed(0) + ' ms', num: true },
  { label: 'Bytes', get: (r) => r.bytes ? (r.bytes / 1024).toFixed(0) + ' KB' : '—', num: true },
];

function fmtMsOrDash(ms, detailAvailable) {
  if (!detailAvailable) return 'sem detalhe (cross-origin)';
  return ms.toFixed(0) + ' ms';
}

/** Acumula e renderiza o breakdown de rede por segmento (Resource Timing). */
function addNetworkBreakdownRow(s) {
  if (!state._netBreakdownRows) state._netBreakdownRows = [];
  state._netBreakdownRows.unshift({ ...s, name: s.url.split('/').pop().split('?')[0].slice(0, 40) });
  if (state._netBreakdownRows.length > 30) state._netBreakdownRows.length = 30;
  renderTable($('#network-breakdown-table'), NET_BREAKDOWN_COLUMNS, state._netBreakdownRows, 'Aguardando segmentos…');
  if (!state._cmcdShown) { maybeShowEmittedCmcd(s.url); if (state._cmcdKv) state._cmcdShown = true; }
}

const CDN_COLUMNS = [
  { label: 'Header', get: (r) => r.k, mono: true },
  { label: 'Valor', get: (r) => r.v, mono: true },
];

function renderCdnTable(url, headers) {
  const rows = Object.entries(headers)
    .filter(([k]) => !/^cmsd-|^cmcd/i.test(k))
    .map(([k, v]) => ({ k, v }));
  if (!rows.length) return;
  renderTable($('#cdn-table'), CDN_COLUMNS, rows, '');
}

function renderCmsd(headers) {
  const parts = {};
  if (headers['cmsd-static']) parts['CMSD-Static (resposta do CDN)'] = window.parseCmsd(headers['cmsd-static']);
  if (headers['cmsd-dynamic']) parts['CMSD-Dynamic (resposta do CDN)'] = window.parseCmsd(headers['cmsd-dynamic']);
  const kv = {};
  for (const [group, obj] of Object.entries(parts)) {
    for (const [k, v] of Object.entries(obj)) kv[`${group}: ${k}`] = String(v);
  }
  if (Object.keys(kv).length) { state._cmsdKv = kv; renderKV($('#cmcd-overview'), { ...state._cmcdKv, ...kv }); }
}

/** CMCD por padrão viaja como query string ?CMCD=chave=valor,chave=valor,... (RFC 8941-like). */
function maybeShowEmittedCmcd(url) {
  const m = url.match(/[?&]CMCD=([^&]+)/);
  if (!m) return;
  const decoded = decodeURIComponent(m[1]);
  const kv = {};
  for (const [k, v] of Object.entries(window.parseCmsd(decoded))) kv[`CMCD (enviado): ${k}`] = String(v);
  state._cmcdKv = kv;
  renderKV($('#cmcd-overview'), { ...kv, ...(state._cmsdKv || {}) });
}

/** Atualiza uma barra do VU meter (ch = 'l'|'r'); dBFS -60..0 → 0..100%. */
function updateVuMeter(ch, dbfs, peak) {
  const pct = Math.max(0, Math.min(100, ((dbfs + 60) / 60) * 100));
  const peakPct = Math.max(0, Math.min(100, ((peak + 60) / 60) * 100));
  const cover = $(`#vu-${ch} .vu-cover`);
  const marker = $(`#vu-${ch} .vu-peak`);
  const label = $(`#vu-${ch} .vu-db`);
  if (cover) cover.style.width = (100 - pct) + '%';
  if (marker) marker.style.left = peakPct + '%';
  if (label) label.textContent = dbfs <= -60 ? '−∞' : dbfs.toFixed(1).replace('.', ',') + ' dBFS';
}

function updateQoeTiles() {
  if (!state.qoe) return;
  const s = state.qoe.summary();
  $('#qoe-startup').textContent = s.startupMs != null ? (s.startupMs / 1000).toFixed(2).replace('.', ',') + 's' : '—';
  $('#qoe-watch').textContent = fmtClock(s.watchTimeSec);
  $('#qoe-rebuffers').textContent = `${s.rebufferCount} (${s.rebufferTotalSec.toFixed(1).replace('.', ',')}s)`;
  $('#qoe-ratio').textContent = s.rebufferRatioPct.toFixed(2).replace('.', ',') + '%';
  $('#qoe-switches').textContent = String(s.abrSwitches);
  $('#qoe-avgbitrate').textContent = s.avgBitrateMbps != null ? s.avgBitrateMbps.toFixed(2).replace('.', ',') + ' Mbps' : '—';
  $('#qoe-fps').textContent = s.fps != null ? s.fps.toFixed(1).replace('.', ',') + (s.nominalFps ? ` / ${s.nominalFps}` : '') : '—';
  $('#qoe-dropped').textContent = s.droppedFrames != null ? `${s.droppedFrames} / ${s.totalFrames}` : '—';
}

function exportSession(format) {
  const exp = StreamQoe.buildSessionExport({
    url: state.sessionUrl,
    overview: state.sessionOverview,
    qoe: state.qoe ? state.qoe.summary() : null,
    alerts: state.alertEngine ? state.alertEngine.snapshot() : [],
    events: Array.from($('#event-log').children).map((li) => li.textContent),
    charts: state.charts,
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  if (format === 'json') {
    StreamQoe.downloadBlob(JSON.stringify(exp, null, 2), `stream-inspector-${stamp}.json`, 'application/json');
  } else {
    StreamQoe.downloadBlob(StreamQoe.sessionToCsv(exp), `stream-inspector-${stamp}.csv`, 'text/csv');
  }
  logEvent(`Sessão exportada em ${format.toUpperCase()}.`);
}

let _cmcdSessionId = null;
/** Um sessionId de CMCD por sessão de inspeção (estável entre trocas de motor). */
function cmcdSessionId() {
  if (!_cmcdSessionId) _cmcdSessionId = 'si-' + Math.random().toString(36).slice(2, 12);
  return _cmcdSessionId;
}
function cmcdContentId() {
  return state.sessionUrl ? state.sessionUrl.split('/').pop().slice(0, 64) : 'stream-inspector';
}

/* ================================================================ *
 * Seleção manual de ladder (variantes) — desliga o ABR do motor
 * ================================================================ */

/**
 * Lê o ladder de vídeo do motor ATIVO, normalizado:
 *   { levels: [{ i, width, height, bitrate }], activeIndex, auto }
 * `i` é o índice que setLadder() usa (específico do motor). Retorna null
 * enquanto o motor ainda não conhece os níveis (antes de MANIFEST_PARSED etc.).
 */
function getLadder() {
  const p = state.player;
  if (!p) return null;
  try {
    if (state.playerKind === 'hls') {
      const levels = (p.levels || []).map((lv, i) => ({ i, width: lv.width, height: lv.height, bitrate: lv.bitrate }));
      if (!levels.length) return null;
      return { levels, activeIndex: p.currentLevel, auto: p.autoLevelEnabled };
    }
    if (state.playerKind === 'shaka') {
      const tracks = p.getVariantTracks().filter((t) => t.type === 'variant');
      // agrupa por resolução/bitrate de vídeo (uma pill por variante de vídeo)
      const seen = new Map();
      for (const t of tracks) {
        const key = `${t.width}x${t.height}@${t.videoBandwidth || t.bandwidth}`;
        if (!seen.has(key)) seen.set(key, { i: t.id, width: t.width, height: t.height, bitrate: t.videoBandwidth || t.bandwidth });
      }
      const levels = Array.from(seen.values());
      if (!levels.length) return null;
      const active = tracks.find((t) => t.active);
      let auto = true;
      try { auto = p.getConfiguration().abr.enabled !== false; } catch { /* default */ }
      return { levels, activeIndex: auto ? -1 : (active ? active.id : -1), auto };
    }
  } catch { /* motor ainda inicializando */ }
  return null;
}

/** Trava o motor no nível `idx` (índice do getLadder), ou volta ao ABR se idx===-1. */
function setLadder(idx) {
  const p = state.player;
  if (!p) return;
  state.forcedLevel = idx;
  try {
    if (state.playerKind === 'hls') {
      p.currentLevel = idx; // -1 reativa o ABR do hls.js
    } else if (state.playerKind === 'shaka') {
      if (idx === -1) {
        p.configure({ abr: { enabled: true } });
      } else {
        p.configure({ abr: { enabled: false } });
        const track = p.getVariantTracks().find((t) => t.id === idx);
        if (track) p.selectVariantTrack(track, /* clearBuffer */ true);
      }
    }
  } catch (e) {
    logEvent('Não foi possível trocar o ladder manualmente: ' + e.message);
    return;
  }
  if (idx === -1) {
    logEvent('Ladder: ABR automático reativado.');
  } else {
    const lad = getLadder();
    const lv = lad && lad.levels.find((l) => l.i === idx);
    logEvent(`Ladder travado manualmente → ${lv ? `${lv.width}×${lv.height} @ ${P.fmtBits(lv.bitrate)}` : 'nível ' + idx} (ABR desligado).`);
  }
  renderLadderPills();
}

/** (Re)desenha o combo-box do ladder a partir do motor ativo. */
function renderLadderPills() {
  const picker = $('#ladder-picker');
  const select = $('#ladder-select');
  if (!picker || !select) return;

  // progressivo (YouTube VOD) ou motor sem níveis: esconde o seletor
  if (state.playerKind === 'progressive') { picker.hidden = true; return; }
  const lad = getLadder();
  if (!lad) { picker.hidden = true; return; }
  picker.hidden = false;

  select.innerHTML = '';
  const ordered = lad.levels.slice().sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  const autoOpt = document.createElement('option');
  autoOpt.value = '-1';
  autoOpt.textContent = ladderAutoLabel(lad, ordered);
  select.appendChild(autoOpt);

  for (const lv of ordered) {
    const opt = document.createElement('option');
    opt.value = String(lv.i);
    opt.textContent = `${lv.height ? lv.height + 'p' : (lv.width || '?')} · ${P.fmtBits(lv.bitrate)}`;
    opt.title = `${lv.width || '?'}×${lv.height || '?'} @ ${P.fmtBits(lv.bitrate)}`;
    select.appendChild(opt);
  }

  const forced = state.forcedLevel != null && state.forcedLevel !== -1;
  select.value = forced ? String(state.forcedLevel) : '-1';
  select.onchange = () => setLadder(Number(select.value));
}

/** Rótulo da option "Auto" — inclui o nível que o ABR está tocando agora,
 * já que um <select> só marca UMA option "selecionada" por vez (as pills
 * conseguiam mostrar "Auto" + o nível ativo simultaneamente via 2 classes). */
function ladderAutoLabel(lad, ordered) {
  if (lad.auto && lad.activeIndex != null && lad.activeIndex !== -1) {
    const active = ordered.find((lv) => lv.i === lad.activeIndex);
    if (active) {
      return `Auto (ABR) — atual: ${active.height ? active.height + 'p' : (active.width || '?')} · ${P.fmtBits(active.bitrate)}`;
    }
  }
  return 'Auto (ABR)';
}

/** Atualiza só a option "Auto" e o valor selecionado, sem reconstruir (chamado no tick). */
function refreshLadderActive() {
  const select = $('#ladder-select');
  if (!select || $('#ladder-picker').hidden) return;
  const lad = getLadder();
  if (!lad) return;
  const ordered = lad.levels.slice().sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  if (select.options.length) select.options[0].textContent = ladderAutoLabel(lad, ordered);
  const forced = state.forcedLevel != null && state.forcedLevel !== -1;
  const wantValue = forced ? String(state.forcedLevel) : '-1';
  if (select.value !== wantValue) select.value = wantValue;
}

/* ================================================================ *
 * Seleção de faixas de ÁUDIO e LEGENDAS/CC no player
 * ================================================================ */

/** Faixas de áudio do motor ativo: { tracks:[{ id, label }], activeId } ou null. */
function getAudioTracks() {
  const p = state.player;
  if (!p) return null;
  try {
    if (state.playerKind === 'hls') {
      const tracks = (p.audioTracks || []).map((a) => ({
        id: a.id, label: [a.name, a.lang, a.channels ? a.channels + 'ch' : null].filter(Boolean).join(' · ') || ('faixa ' + a.id),
      }));
      return tracks.length ? { tracks, activeId: p.audioTrack } : null;
    }
    if (state.playerKind === 'shaka') {
      const variants = p.getVariantTracks();
      const seen = new Map();
      for (const t of variants) {
        const key = `${t.language}|${(t.audioRoles || []).join('/')}|${t.audioId ?? ''}`;
        if (!seen.has(key)) seen.set(key, {
          id: key,
          label: [t.language, (t.audioRoles || []).join('/'), t.channelsCount ? t.channelsCount + 'ch' : null].filter(Boolean).join(' · ') || 'faixa',
          _lang: t.language, _roles: t.audioRoles || [],
        });
      }
      const tracks = Array.from(seen.values());
      const active = variants.find((t) => t.active);
      const activeId = active ? `${active.language}|${(active.audioRoles || []).join('/')}|${active.audioId ?? ''}` : null;
      return tracks.length ? { tracks, activeId } : null;
    }
  } catch { /* motor inicializando */ }
  return null;
}

/** Seleciona a faixa de áudio `id` (id no formato de getAudioTracks). */
function setAudioTrack(id) {
  const p = state.player;
  if (!p) return;
  try {
    if (state.playerKind === 'hls') {
      p.audioTrack = id;
    } else if (state.playerKind === 'shaka') {
      const info = (getAudioTracks() || { tracks: [] }).tracks.find((t) => t.id === id);
      if (info) p.selectAudioLanguage(info._lang, info._roles && info._roles.length ? info._roles[0] : undefined);
    }
  } catch (e) {
    logEvent('Não foi possível trocar a faixa de áudio: ' + e.message);
    return;
  }
  const info = (getAudioTracks() || { tracks: [] }).tracks.find((t) => t.id === id);
  logEvent(`Áudio → ${info ? info.label : 'faixa ' + id}.`);
  renderTrackPickers();
}

/** Legendas/CC do motor ativo: { tracks:[{ id, label }], activeId, visible } ou null. */
function getTextTracks() {
  const p = state.player;
  const video = videoEl();
  try {
    if (state.playerKind === 'hls' && p) {
      const tracks = (p.subtitleTracks || []).map((s) => ({
        id: 'h' + s.id, _hlsId: s.id,
        label: [s.name, s.lang].filter(Boolean).join(' · ') || ('legenda ' + s.id),
      }));
      // captions in-band (CEA-608/708) que o hls.js expõe como texttrack nativo
      // e não estão em subtitleTracks — cobre o "container"
      const seenLabels = new Set(tracks.map((t) => t.label.toLowerCase()));
      Array.from(video.textTracks || []).forEach((tt, i) => {
        if (tt.kind !== 'captions' && tt.kind !== 'subtitles') return;
        const label = (tt.label || tt.language || ('cc ' + i)).trim();
        if (seenLabels.has(label.toLowerCase())) return;
        tracks.push({ id: 'n' + i, _nativeIdx: i, label: label + (tt.kind === 'captions' ? ' (CC)' : '') });
      });
      const activeId = p.subtitleDisplay && p.subtitleTrack >= 0 ? 'h' + p.subtitleTrack : null;
      return tracks.length ? { tracks, activeId, visible: !!p.subtitleDisplay } : null;
    }
    if (state.playerKind === 'shaka' && p) {
      const list = p.getTextTracks() || [];
      const tracks = list.map((t) => ({ id: t.id, label: [t.language, (t.roles || []).join('/'), t.label].filter(Boolean).join(' · ') || ('legenda ' + t.id), _track: t }));
      const visible = p.isTextTrackVisible();
      const active = list.find((t) => t.active);
      return tracks.length ? { tracks, activeId: visible && active ? active.id : null, visible } : null;
    }
    // progressivo ou nativo: usa video.textTracks direto
    if (video && video.textTracks && video.textTracks.length) {
      const tracks = Array.from(video.textTracks).map((tt, i) => ({
        id: 'n' + i, _nativeIdx: i,
        label: (tt.label || tt.language || ('faixa ' + i)) + (tt.kind === 'captions' ? ' (CC)' : ''),
      }));
      const activeIdx = Array.from(video.textTracks).findIndex((tt) => tt.mode === 'showing');
      return { tracks, activeId: activeIdx >= 0 ? 'n' + activeIdx : null, visible: activeIdx >= 0 };
    }
  } catch { /* motor inicializando */ }
  return null;
}

/** Seleciona a legenda `id`, ou desliga com id === -1. */
function setTextTrack(id) {
  const p = state.player;
  const video = videoEl();
  const off = id === -1;
  try {
    if (state.playerKind === 'hls' && p) {
      if (off) { p.subtitleDisplay = false; p.subtitleTrack = -1; Array.from(video.textTracks || []).forEach((tt) => { tt.mode = 'disabled'; }); }
      else if (typeof id === 'string' && id[0] === 'h') { p.subtitleDisplay = true; p.subtitleTrack = Number(id.slice(1)); }
      else if (typeof id === 'string' && id[0] === 'n') {
        // caption nativo (in-band): liga via video.textTracks
        Array.from(video.textTracks).forEach((tt, i) => { tt.mode = i === Number(id.slice(1)) ? 'showing' : 'disabled'; });
      }
    } else if (state.playerKind === 'shaka' && p) {
      if (off) p.setTextTrackVisibility(false);
      else {
        const t = (p.getTextTracks() || []).find((x) => x.id === id);
        if (t) p.selectTextTrack(t);
        p.setTextTrackVisibility(true);
      }
    } else if (video && video.textTracks) {
      Array.from(video.textTracks).forEach((tt, i) => { tt.mode = (!off && id === 'n' + i) ? 'showing' : 'disabled'; });
    }
  } catch (e) {
    logEvent('Não foi possível trocar a legenda: ' + e.message);
    return;
  }
  if (off) logEvent('Legendas desligadas.');
  else {
    const info = (getTextTracks() || { tracks: [] }).tracks.find((t) => t.id === id);
    logEvent(`Legenda → ${info ? info.label : id}.`);
  }
  renderTrackPickers();
}

/** (Re)desenha os seletores de áudio e legendas a partir do motor ativo. */
function renderTrackPickers() {
  const audioPicker = $('#audio-picker'), audioSelect = $('#audio-select');
  const subsPicker = $('#subs-picker'), subsBox = $('#subs-pills');
  if (!audioPicker || !subsPicker) return;

  if (state.playerKind === 'progressive') {
    audioPicker.hidden = true; subsPicker.hidden = true; return;
  }

  // ---- Áudio: só mostra quando há mais de uma faixa ----
  const au = getAudioTracks();
  if (au && au.tracks.length > 1) {
    audioPicker.hidden = false;
    audioSelect.innerHTML = '';
    for (const tr of au.tracks) {
      const opt = document.createElement('option');
      opt.value = String(tr.id);
      opt.textContent = tr.label;
      audioSelect.appendChild(opt);
    }
    audioSelect.value = String(au.activeId);
    audioSelect.onchange = () => {
      // ids não-numéricos (Shaka usa uma chave composta lang|roles|audioId)
      // — devolve o id original correspondente em vez de forçar Number().
      const match = au.tracks.find((tr) => String(tr.id) === audioSelect.value);
      setAudioTrack(match ? match.id : audioSelect.value);
    };
  } else {
    audioPicker.hidden = true; audioSelect.innerHTML = '';
  }

  // ---- Legendas/CC: "Desligado" + uma pill por faixa (só se houver alguma) ----
  const tx = getTextTracks();
  if (tx && tx.tracks.length) {
    subsPicker.hidden = false;
    subsBox.innerHTML = '';
    const offPill = el('button', 'track-pill' + (!tx.visible ? ' forced' : ''), 'Desligado');
    offPill.type = 'button';
    offPill.addEventListener('click', () => setTextTrack(-1));
    subsBox.appendChild(offPill);
    for (const tr of tx.tracks) {
      const pill = el('button', 'track-pill' + (tx.visible && tr.id === tx.activeId ? ' forced' : ''), tr.label);
      pill.type = 'button';
      pill.addEventListener('click', () => setTextTrack(tr.id));
      subsBox.appendChild(pill);
    }
  } else {
    subsPicker.hidden = true; subsBox.innerHTML = '';
  }
}

/**
 * Monta o Clappr (envelopa tudo — controles, UI, tela de erro — exceto o
 * playback em si) com o motor/versão escolhido no combo-box. HLS usa
 * @clappr/hlsjs-playback (window.HlsjsPlayback); DASH usa dash-shaka-playback
 * (window.DashShakaPlayback), ambos "external" (leem window.Hls/window.shaka
 * já carregados — ver ensureEngineLoaded). Progressivo (YouTube VOD, arquivo
 * único) usa o HTML5Video padrão do próprio Clappr, sem plugin extra.
 *
 * Depois que o Clappr sobe, `waitForEngineInstance` pega a instância REAL de
 * Hls/shaka.Player por baixo do plugin (`_hls`/`shakaPlayerInstance`) e todo
 * o resto do arquivo (getLadder/setLadder/getAudioTracks/etc., telemetria)
 * continua falando com ela do jeito de sempre — só quem a criou mudou.
 */
async function startPlayback(type, url, model, isLive, progressiveMimeType) {
  state.drmBlocked = false;
  state.forcedLevel = -1; // toda nova sessão de playback começa em ABR automático
  $('#ladder-picker').hidden = true; $('#ladder-select').innerHTML = '';
  $('#audio-picker').hidden = true; $('#audio-select').innerHTML = '';
  $('#subs-picker').hidden = true; $('#subs-pills').innerHTML = '';
  $('#color-note-runtime').textContent = '';
  $('#chroma-method-note').textContent = '';
  state.lastPlay = { type, url, model, isLive, progressiveMimeType };

  // Default do motor por tipo de manifest (HLS→hls.js Globo, DASH→Shaka
  // Globo) — só na primeira vez; depois que o usuário troca manualmente no
  // combo-box (state.engineManuallySet), essa escolha é respeitada mesmo
  // trocando de URL/tipo.
  if (type !== 'progressive' && !state.engineManuallySet) {
    state.engine = type === 'hls' ? 'hls-1.5.14' : 'shaka-3.1.8';
    $('#engine-select').value = state.engine;
  }

  if (state.clapprPlayer) { try { state.clapprPlayer.destroy(); } catch { /* já destruído */ } state.clapprPlayer = null; }

  const clapprOpts = {
    source: url,
    parentId: '#clappr-mount',
    autoPlay: true,
    mute: true,
    width: '100%',
    height: '100%',
    plugins: { core: [window.ClapprPlugins.MediaControl] },
  };

  if (type === 'progressive') {
    // sem isso, o Clappr não acha nenhum playback pra fontes sem extensão
    // reconhecível na URL (caso do YouTube) e não cria vídeo nenhum
    clapprOpts.mimeType = progressiveMimeType || 'video/mp4';
  }

  let kind = 'progressive';
  if (type !== 'progressive') {
    try {
      kind = await ensureEngineLoaded(state.engine);
    } catch (e) {
      logEvent('Falha ao carregar o motor de playback: ' + e.message);
      return;
    }
    if (kind === 'hls') {
      clapprOpts.plugins.playback = [window.HlsjsPlayback];
      clapprOpts.playback = { hlsjsConfig: {
        enableWorker: true, capLevelToPlayerSize: false,
        cmcd: { sessionId: cmcdSessionId(), contentId: cmcdContentId() },
      } };
    } else {
      clapprOpts.plugins.playback = [window.DashShakaPlayback];
      clapprOpts.playback = { shakaConfiguration: {
        cmcd: { enabled: true, sessionId: cmcdSessionId(), contentId: cmcdContentId() },
      } };
    }
  }

  const clapprPlayer = new Clappr.Player(clapprOpts);
  state.clapprPlayer = clapprPlayer;

  if (type === 'progressive') {
    state.player = null;
    state.playerKind = 'progressive';
    startTelemetry(model, isLive);
    return;
  }

  let instance;
  try {
    instance = await waitForEngineInstance(clapprPlayer, kind);
  } catch (e) {
    logEvent(e.message);
    return;
  }
  state.player = instance;
  state.playerKind = kind;
  const video = videoEl();
  video.addEventListener('waiting', () => logEvent('Rebuffering (waiting)…'));

  if (kind === 'hls') {
    const hls = instance;
    hls.on(Hls.Events.MANIFEST_PARSED, () => { renderLadderPills(); renderTrackPickers(); });
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => renderTrackPickers());
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => renderTrackPickers());
    hls.on(Hls.Events.LEVEL_SWITCHED, (_, d) => {
      const lv = hls.levels[d.level];
      if (lv) {
        logEvent(`Troca de nível → ${lv.width}×${lv.height} @ ${P.fmtBits(lv.bitrate)}`);
        if (state.qoe) state.qoe.onLevelSwitch(lv.bitrate / 1e6);
      }
    });
    hls.on(Hls.Events.ERROR, (_, d) => {
      logEvent(`Erro hls.js [${d.type}/${d.details}]${d.fatal ? ' (FATAL)' : ''}`);
      if (d.fatal) {
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      }
    });
    // hls.js/dash-shaka já iniciaram o carregamento sozinhos ao instanciar o
    // Clappr.Player (source foi passado nas opções) — só falta garantir o mute.
    renderLadderPills();
    renderTrackPickers();
  } else {
    const shakaPlayer = instance;
    shakaPlayer.addEventListener('error', (e) => {
      const detail = e.detail || {};
      logEvent(`Erro Shaka [código ${detail.code}]${detail.severity >= 2 ? ' (FATAL)' : ''}`);
    });
    shakaPlayer.addEventListener('adaptation', () => {
      const active = shakaPlayer.getVariantTracks().find((t) => t.active);
      if (active && active.width) {
        logEvent(`Troca de nível → ${active.width}×${active.height} @ ${P.fmtBits(active.bandwidth)}`);
        if (state.qoe) state.qoe.onLevelSwitch(active.bandwidth / 1e6);
      }
    });
    shakaPlayer.addEventListener('buffering', (e) => { if (e.buffering) logEvent('Rebuffering (buffering)…'); });
    shakaPlayer.addEventListener('trackschanged', () => renderTrackPickers());
    shakaPlayer.addEventListener('texttrackvisibility', () => renderTrackPickers());
    renderLadderPills();
    renderTrackPickers();
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

const ADBREAK_COLUMNS = [
  { label: 'Início', get: (b) => b.start, mono: true },
  { label: 'Duração', get: (b) => (b.duration != null ? b.duration.toFixed(1).replace('.', ',') + 's' : '—'), num: true },
  { label: 'Tipo', get: (b) => b.type },
  { label: 'Fonte', get: (b) => b.source },
];

function renderAdBreaks(adBreaks) {
  const section = $('#sec-adbreaks');
  if (!adBreaks || !adBreaks.length) { section.hidden = true; return; }
  section.hidden = false;
  renderTable($('#adbreaks-table'), ADBREAK_COLUMNS, adBreaks, '');
}

/* ================================================================ *
 * Análise de qualidade — PSNR/SSIM com referência
 * ================================================================ */

/**
 * Variantes utilizáveis pela comparação de qualidade. `model.video` cobre o
 * caso normal (master HLS / MPD DASH com múltiplas representações); playlists
 * de mídia HLS inspecionadas diretamente (`kind: 'media'`) não têm variantes
 * — a própria URL inspecionada já É a única variante, por isso o fallback
 * para `model.qualityVariants` (preenchido em inspect()) nesse caso.
 */
function qualityVariantsOf(model) {
  return (model.video && model.video.length) ? model.video : (model.qualityVariants || []);
}

function populateQualityVariantSelect(model) {
  const sel = $('#quality-variant');
  sel.innerHTML = '';
  for (const [i, v] of qualityVariantsOf(model).entries()) {
    const opt = document.createElement('option');
    opt.value = String(i);
    const codec = (v.codecs || []).filter((c) => isVideo(c)).map(P.codecName).join(',') || (v.codecs || []).map(P.codecName).join(',');
    opt.textContent = codec ? `${v.resolution} · ${P.fmtBits(v.bandwidth)} · ${codec}` : `${v.resolution} · ${P.fmtBits(v.bandwidth)}`;
    sel.appendChild(opt);
  }
}

/**
 * Toca a variante ESPECÍFICA travada (sem ABR) no <video> oculto de comparação.
 * Rejeita a Promise em erro FATAL do player — antes o mesmo evento ERROR
 * genérico resolvia como se fosse sucesso, e o restante do fluxo seguia
 * tentando comparar um <video> que nunca de fato anexou mídia (readyState
 * nunca avançava, e sample() silenciosamente retornava null para sempre).
 */
async function attachLockedVariant(video, model, variant) {
  video.muted = true;
  if (model.protocol === 'HLS') {
    await ensureHlsGlobal(); // motor principal pode estar em Shaka — garante window.Hls mesmo assim
    const hls = new Hls({ enableWorker: true });
    state.qualityPlayer = hls;
    const url = state.lastPlay && state.lastPlay.url.startsWith('/p/') ? proxify(variant.uri) : variant.uri;
    hls.loadSource(url);
    hls.attachMedia(video);
    await new Promise((resolve, reject) => {
      hls.once(Hls.Events.MANIFEST_PARSED, resolve);
      hls.once(Hls.Events.ERROR, (_evt, data) => {
        if (data && data.fatal) reject(new Error('hls.js: ' + (data.details || data.type || 'erro fatal')));
      });
    });
  } else if (model.protocol === 'DASH') {
    const player = dashjs.MediaPlayer().create();
    state.qualityPlayer = player;
    try { player.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: false } } } }); } catch { /* ignore */ }
    player.initialize(video, state.lastPlay ? state.lastPlay.url : state.sessionUrl, true);
    // dash.js não tem .once() — remove os dois listeners manualmente ao disparar o primeiro
    await new Promise((resolve, reject) => {
      const onInit = () => { cleanup(); resolve(); };
      const onError = (e) => {
        cleanup();
        reject(new Error('dash.js: ' + ((e && (e.error && e.error.message || e.error)) || 'erro ao inicializar')));
      };
      const cleanup = () => {
        player.off(dashjs.MediaPlayer.events.STREAM_INITIALIZED, onInit);
        player.off(dashjs.MediaPlayer.events.ERROR, onError);
      };
      player.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, onInit);
      player.on(dashjs.MediaPlayer.events.ERROR, onError);
    });
    try {
      const list = player.getBitrateInfoListFor('video') || [];
      let bestIdx = 0, bestDiff = Infinity;
      list.forEach((b, i) => { const d = Math.abs(b.bitrate - (variant.bandwidth || 0)); if (d < bestDiff) { bestDiff = d; bestIdx = i; } });
      player.setQualityFor('video', bestIdx);
    } catch { /* ignore */ }
  } else {
    // progressivo (YouTube): só há um formato tocável — compara consigo mesmo
    video.src = variant.uri;
  }
  video.play().catch(() => { /* autoplay pode exigir gesto do usuário */ });
}

async function startQualityCompare() {
  const model = state.lastPlay ? state.lastPlay.model : null;
  const variants = model ? qualityVariantsOf(model) : [];
  if (!model || !variants.length) {
    $('#quality-status').textContent = 'Nenhuma variante de vídeo disponível para comparar.';
    return;
  }
  const idx = Number($('#quality-variant').value || 0);
  const variant = variants[idx];
  // HLS precisa da playlist própria da variante; DASH trava por bandwidth
  // dentro do MPD completo (não tem uma URL individual por representação)
  if (!variant || (model.protocol === 'HLS' && !variant.uri)) {
    $('#quality-status').textContent = 'Esta variante não tem uma URL própria para travar.';
    return;
  }

  let refUrl;
  const presetId = $('#quality-ref-preset').value;
  if (presetId === 'local') {
    const file = $('#quality-ref-file').files[0];
    if (!file) { $('#quality-status').textContent = 'Selecione um arquivo de referência.'; return; }
    refUrl = URL.createObjectURL(file);
  } else {
    const preset = StreamQuality.REFERENCE_PRESETS.find((p) => p.id === presetId);
    if (!preset) { $('#quality-status').textContent = 'Selecione um preset de referência.'; return; }
    refUrl = preset.url;
  }

  stopQualityCompare();
  $('#quality-status').textContent = 'Carregando referência e variante…';

  const refVideo = $('#video-reference');
  const distVideo = $('#video-distorted');

  // Antes, uma falha ao carregar (rede/CORS/URL inválida) não tinha NENHUM
  // sinal — o vídeo nunca avançava de readyState, sample() retornava null
  // pra sempre, e a UI ficava travada em "Comparando…" indefinidamente sem
  // erro nenhum. Agora: evento 'error' nativo do <video> encerra com uma
  // mensagem clara, e um timeout cobre o caso de nem erro nem sucesso (ex.:
  // requisição que trava sem nunca resolver).
  let settled = false;
  const fail = (msg) => {
    if (settled) return;
    settled = true;
    logEvent('Comparação de qualidade: ' + msg);
    stopQualityCompare();
    $('#quality-status').textContent = msg;
    $('#quality-status').classList.add('hint-error');
  };
  const onRefError = () => fail('Falha ao carregar o vídeo de referência (verifique a URL/conectividade).');
  const onDistError = () => fail('Falha ao carregar a variante travada (verifique a URL/conectividade).');
  refVideo.addEventListener('error', onRefError, { once: true });
  distVideo.addEventListener('error', onDistError, { once: true });
  state._qualityCleanupListeners = () => {
    refVideo.removeEventListener('error', onRefError);
    distVideo.removeEventListener('error', onDistError);
  };

  refVideo.src = refUrl;
  refVideo.muted = true;
  refVideo.play().catch(() => { /* segue mesmo assim; sample() aguarda readyState */ });

  try {
    await attachLockedVariant(distVideo, model, variant);
  } catch (e) {
    fail('Erro ao carregar a variante: ' + e.message);
    return;
  }
  if (settled) return; // já falhou via evento 'error' enquanto attachLockedVariant rodava

  destroyChart('qualityPsnr'); destroyChart('qualitySsim');
  state.charts.qualityPsnr = new LineChart($('#chart-quality-psnr'), {
    series: [{ key: 'psnr', label: 'PSNR', colorVar: '--series-1' }],
    yFormat: (v) => v.toFixed(1) + ' dB',
    xFormat: fmtClock, windowSec: 120, height: 180, yMin: 0, yMax: 60,
  });
  state.charts.qualitySsim = new LineChart($('#chart-quality-ssim'), {
    series: [{ key: 'ssim', label: 'SSIM', colorVar: '--series-2' }],
    yFormat: (v) => v.toFixed(3),
    xFormat: fmtClock, windowSec: 120, height: 180, yMin: 0, yMax: 1,
  });

  state.qualityCompare = new StreamQuality.QualityCompare(refVideo, distVideo, { width: 320, height: 180 });
  state.qualityT0 = performance.now();
  $('#quality-status').textContent = 'Comparando…';

  // se nem sucesso nem erro acontecerem (ex.: request que trava sem nunca
  // resolver, sem disparar 'error'), evita ficar preso em "Comparando…" pra
  // sempre — cancelado assim que a 1ª amostra real chegar, abaixo.
  state.qualityStartTimeout = setTimeout(() => {
    fail('Tempo esgotado aguardando referência/variante ficarem prontas para reprodução (timeout).');
  }, 10000);

  state.qualityTimer = setInterval(() => {
    const t = (performance.now() - state.qualityT0) / 1000;
    state.qualityCompare.maybeResync();
    const s = state.qualityCompare.sample();
    if (!s) return;
    if (state.qualityStartTimeout) { clearTimeout(state.qualityStartTimeout); state.qualityStartTimeout = null; }
    if (s.blocked) {
      fail('Bloqueado: leitura de pixels não permitida (CORS sem cabeçalhos, ou DRM).');
      return;
    }
    state.charts.qualityPsnr && state.charts.qualityPsnr.push(t, { psnr: s.psnr });
    state.charts.qualitySsim && state.charts.qualitySsim.push(t, { ssim: s.ssim });
    $('#tile-psnr').textContent = s.psnr.toFixed(1) + ' dB';
    $('#tile-ssim').textContent = s.ssim.toFixed(3);
  }, 1000);
}

function stopQualityCompare() {
  if (state.qualityTimer) { clearInterval(state.qualityTimer); state.qualityTimer = null; }
  if (state.qualityStartTimeout) { clearTimeout(state.qualityStartTimeout); state.qualityStartTimeout = null; }
  if (state._qualityCleanupListeners) { state._qualityCleanupListeners(); state._qualityCleanupListeners = null; }
  if (state.qualityPlayer) {
    try {
      if (state.qualityPlayer.destroy) state.qualityPlayer.destroy();
      else if (state.qualityPlayer.reset) state.qualityPlayer.reset();
    } catch { /* já destruído */ }
    state.qualityPlayer = null;
  }
  const refVideo = $('#video-reference'), distVideo = $('#video-distorted');
  if (refVideo) {
    if (refVideo.src && refVideo.src.startsWith('blob:')) URL.revokeObjectURL(refVideo.src);
    refVideo.removeAttribute('src'); refVideo.load();
  }
  if (distVideo) { distVideo.removeAttribute('src'); distVideo.load(); }
  state.qualityCompare = null;
  if ($('#quality-status')) { $('#quality-status').textContent = ''; $('#quality-status').classList.remove('hint-error'); }
}

function setStatus(msg, kind) {
  const s = $('#status');
  s.textContent = msg || '';
  s.className = 'status ' + (kind || '');
  s.hidden = !msg;
}

/**
 * Resolve uma URL do YouTube via /resolve (yt-dlp local) e alimenta o
 * pipeline. Retorna true se tratou a requisição (ao vivo → delega ao
 * fluxo de manifest normal; VOD → renderiza a partir do JSON do yt-dlp
 * e reproduz o melhor formato progressivo).
 */
async function inspectYouTube(url) {
  logEvent('URL do YouTube detectada — resolvendo via yt-dlp local (uso sujeito aos Termos do YouTube).');
  setStatus('Resolvendo com yt-dlp…', 'busy');

  let info;
  try {
    const r = await fetch('/resolve?url=' + encodeURIComponent(url));
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const hint = body.code === 'NO_YTDLP'
        ? ' Instale o yt-dlp e sirva a página por "node server.js".'
        : '';
      setStatus('Não foi possível resolver a URL do YouTube: ' + (body.error || `HTTP ${r.status}`) + hint, 'error');
      return true;
    }
    info = body;
  } catch (e) {
    setStatus('Falha ao chamar o resolvedor local (/resolve requer o server.js): ' + e.message, 'error');
    return true;
  }

  logEvent(`YouTube: "${info.title || info.id}"${info.uploader ? ' — ' + info.uploader : ''} (${info.is_live ? 'AO VIVO' : 'VOD'}).`);
  const src = StreamYouTube.pickPlaybackSource(info);
  if (!src) {
    setStatus('O yt-dlp não retornou um formato reproduzível para esta URL.', 'error');
    return true;
  }

  // Ao vivo (ou fallback HLS): delega ao pipeline de manifest normal —
  // paridade total (variantes, segmentação, container reais).
  if (src.kind === 'hls') {
    logEvent('YouTube ao vivo: master HLS resolvido — usando o pipeline de manifest completo.');
    await inspect(src.url);
    return true;
  }

  // VOD progressivo: tabelas a partir do JSON do yt-dlp + player no arquivo.
  const model = StreamYouTube.buildModelFromYtInfo(info);
  $('#results').hidden = false;
  renderBadges(model);
  renderKV($('#overview'), { ...model.overview, 'URL': url, 'Formato reproduzido': `${src.height || '—'}p (melhor progressivo combinado)` });
  $('#raw-manifest').textContent = JSON.stringify(info, null, 2).slice(0, 200000);

  renderTable($('#video-table'), VIDEO_COLUMNS, model.video || [], 'Nenhum formato de vídeo retornado.');
  populateQualityVariantSelect(model);
  renderTable($('#audio-table'), AUDIO_COLUMNS, model.audio || [], 'Nenhuma faixa de áudio separada (pode estar muxada nos formatos progressivos).');
  renderTable($('#subs-table'), SUB_COLUMNS, model.subtitles || [], 'Nenhuma legenda/closed caption retornada.');
  renderTable($('#drm-table'), DRM_COLUMNS, [], 'Mídia do YouTube — sem DRM aplicável nos formatos entregues pelo yt-dlp.');
  renderHdrPanel(model);
  renderSegments(null);

  state.sessionUrl = url;
  state.sessionOverview = { ...model.overview };
  state.targetDuration = 6;

  logEvent('Observação: o player usa o melhor formato combinado (progressivo, tipicamente ≤720p); as tabelas listam todos os formatos, inclusive 4K/HDR adaptativos.');

  probeContainer('directUrl', src.url, null);
  setupTelemetryCharts(false);
  setStatus('', '');
  startPlayback('progressive', proxify(src.url), model, false, StreamYouTube.mimeTypeForExt(src.ext));
  logEvent('Playback iniciado (mudo) a partir do formato progressivo do YouTube.');
  return true;
}

/**
 * Resolve uma URL do Globoplay via yt-dlp local (mesmo endpoint /resolve
 * usado para YouTube) e delega ao pipeline de manifest normal — diferente
 * do YouTube, aqui não há um modelo "progressivo" próprio: conteúdo de
 * emissora normalmente expõe um manifest HLS/DASH de verdade (ao vivo ou
 * VOD), então o caminho é sempre achar esse manifest e chamar inspect() com
 * ele (paridade total: variantes, segmentação, container e telemetria
 * reais). Se exigir login/assinatura ou tiver DRM que o yt-dlp não consiga
 * contornar, a resolução falha aqui mesmo — sem tentativa de bypass.
 */
async function inspectGloboplay(url) {
  logEvent('URL do Globoplay detectada — resolvendo via navegador headless local (Playwright).');
  setStatus('Abrindo um Chromium headless para localizar o manifest (pode levar alguns segundos)…', 'busy');

  let body;
  try {
    const r = await fetch('/resolve-globoplay?url=' + encodeURIComponent(url));
    body = await r.json().catch(() => ({}));
    if (!r.ok) {
      let hint = '';
      if (body.code === 'NO_SESSION' || body.code === 'SESSION_EXPIRED') {
        hint = ' Rode "node scripts/globoplay-login.js" (login manual único) e tente de novo.';
      } else if (body.code === 'NO_PLAYWRIGHT') {
        hint = ' Rode "npm install" e "npx playwright install chromium".';
      }
      setStatus((body.error || `HTTP ${r.status}`) + hint, 'error');
      return true;
    }
  } catch (e) {
    setStatus('Falha ao chamar o resolvedor local (/resolve-globoplay requer o server.js): ' + e.message, 'error');
    return true;
  }

  logEvent(`Globoplay: manifest ${body.type === 'dash' ? 'DASH' : 'HLS'} localizado — usando o pipeline de inspeção completo.`);
  await inspect(body.manifestUrl);
  return true;
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
  _cmcdSessionId = null;
  state._cmcdKv = null; state._cmsdKv = null; state._cmcdShown = false;
  $('#sec-adbreaks').hidden = true;

  try {
    // YouTube: resolve via yt-dlp local antes de tudo
    if (window.StreamYouTube && StreamYouTube.isYouTubeUrl(url)) {
      const handled = await inspectYouTube(url);
      if (handled) return;
    }
    // Globoplay: mesma ideia, mas sempre delega ao pipeline de manifest normal
    if (window.StreamGloboplay && StreamGloboplay.isGloboplayUrl(url)) {
      const handled = await inspectGloboplay(url);
      if (handled) return;
    }

    const { text, effectiveUrl, proxied } = await fetchManifest(url);
    const type = detectType(url, text);
    logEvent(`Manifest carregado ${proxied ? 'via proxy local' : 'diretamente'} (${text.length.toLocaleString('pt-BR')} bytes).`);

    const model = type === 'hls' ? P.parseM3U8(text, effectiveUrl) : P.parseMPD(text, effectiveUrl);
    // playlist de mídia HLS inspecionada diretamente não tem lista de variantes
    // (model.video) — a própria URL já É a única variante, só para o comparador
    // de qualidade (a tabela "Vídeo — variantes" continua vazia, corretamente)
    if (model.protocol === 'HLS' && model.kind === 'media') {
      model.qualityVariants = [{ id: '1', uri: url, resolution: 'Playlist única', bandwidth: null }];
    }

    $('#results').hidden = false;
    renderBadges(model);
    renderKV($('#overview'), { ...model.overview, 'SCTE-35': model.overview['SCTE-35'] || 'Verificando…', 'URL': url, 'Obtido via': proxied ? 'proxy local (/p/)' : 'fetch direto' });
    $('#raw-manifest').textContent = text.length > 200000 ? text.slice(0, 200000) + '\n… (truncado)' : text;

    renderTable($('#video-table'), VIDEO_COLUMNS, model.video || [], 'Nenhuma variante de vídeo declarada neste manifest.');
    populateQualityVariantSelect(model);
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
            model.overview['Duração total'] = P.fmtDur(mediaModel.totalDuration);
            model.overview['Low-Latency HLS'] = mediaModel.overview['Low-Latency HLS'];
            model.overview['SCTE-35'] = mediaModel.overview['SCTE-35'];
            renderBadges(model);
            renderSegments(
              { ...mediaModel, count: mediaModel.segments.length, list: mediaModel.segments, targetDuration: mediaModel.targetDuration, totalDuration: mediaModel.totalDuration },
              `playlist da variante ${top.resolution} @ ${P.fmtBits(top.bandwidth)}`
            );
            renderKV($('#overview'), {
              ...model.overview,
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

    // Marcadores de anúncio (SCTE-35) — do manifest (media playlist HLS ou MPD DASH)
    const adBreaks = (resolvedMediaModel && resolvedMediaModel.adBreaks) || model.adBreaks || [];
    renderAdBreaks(adBreaks);

    // contexto da sessão (exportação + alerta de playlist estagnada)
    state.sessionUrl = url;
    state.sessionOverview = { ...model.overview };
    state.targetDuration = (resolvedMediaModel && resolvedMediaModel.targetDuration) ||
      (model.segments && model.segments.targetDuration) || 6;

    saveHistoryEntry(url, model, adBreaks);

    // Playback + telemetria
    setupTelemetryCharts(isLive);
    const forceProxy = $('#force-proxy').checked;
    const playUrl = proxied || forceProxy ? proxify(url) : url;
    if (forceProxy && !proxied) logEvent('Playback forçado via proxy local (teste de rede habilitado).');
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
 * Histórico persistente de testes (SQLite via server.js /api/history)
 * ================================================================ */

/** Envia um resumo estático da inspeção — best-effort, não bloqueia a UI. */
function saveHistoryEntry(url, model, adBreaks) {
  const hdrVariants = (model.video || []).filter((v) => v.hdr);
  const summary = {
    protocol: model.protocol,
    overview: { ...model.overview, 'URL': url },
    video: model.video || [],
    audio: model.audio || [],
    subtitles: model.subtitles || [],
    closedCaptions: model.closedCaptions || [],
    drm: model.drm || [],
    adBreaks: adBreaks || [],
  };
  const body = {
    url,
    protocol: model.protocol,
    live: /AO VIVO/.test(model.overview['Transmissão'] || ''),
    videoVariants: (model.video || []).length,
    audioTracks: (model.audio || []).length,
    hdr: hdrVariants.length ? [...new Set(hdrVariants.map((v) => v.videoRange))].join(' / ') : 'SDR',
    drm: (model.drm || []).map((d) => d.system).join(', ') || 'Nenhuma',
    summary,
  };
  fetch('/api/history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then((r) => r.json())
    .then((r) => { if (r && r.ok) loadHistory(); })
    .catch(() => { /* histórico é best-effort — não interrompe a inspeção */ });
}

/** Só popula a lista — o painel de Histórico é um item de menu como
 * qualquer outro (seção 10, depois de QoE): fica quieto/oculto até o
 * usuário clicar nele, nunca abre nem toma espaço sozinho ao carregar a
 * página. */
async function loadHistory() {
  try {
    const res = await fetch('/api/history?limit=50'); // painel tem scroll (.history-list), então mostra mais que os últimos 10
    if (!res.ok) return;
    const { items } = await res.json();
    renderHistoryList(items || []);
  } catch { /* histórico é best-effort */ }
}

function renderHistoryList(items) {
  const list = $('#history-list');
  list.innerHTML = '';
  if (!items.length) return;
  $('#history-note').textContent = `${items.length} teste${items.length > 1 ? 's' : ''} recente${items.length > 1 ? 's' : ''} — clique para reabrir (somente leitura, sem player).`;
  for (const item of items) {
    const li = el('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'history-item';
    const time = el('span', 'hi-time', new Date(item.ts).toLocaleString('pt-BR'));
    const urlEl = el('span', 'hi-url', item.url);
    const tags = el('span', 'hi-tags');
    tags.appendChild(badge(item.protocol || '—', 'info'));
    tags.appendChild(badge(item.live ? 'AO VIVO' : 'VOD', item.live ? 'live' : 'ok'));
    if (item.hdr && item.hdr !== 'SDR') tags.appendChild(badge('HDR: ' + item.hdr, 'hdr'));
    if (item.drm && item.drm !== 'Nenhuma') tags.appendChild(badge('DRM', 'drm'));
    btn.append(time, urlEl, tags);
    btn.addEventListener('click', () => restoreHistoryEntry(item));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

/** Restaura só as seções estáticas de um teste antigo — sem player/telemetria
 * (o stream pode nem existir mais, especialmente ao vivo). */
function restoreHistoryEntry(item) {
  stopPlayback();
  state.lastPlay = null;
  for (const k of Object.keys(state.charts)) destroyChart(k);
  const model = item.summary;
  $('#results').hidden = false;
  // o painel de Histórico pode estar ativo no momento do clique — troca pra
  // Visão geral, que é quem acabou de ser (re)preenchido logo abaixo.
  if (window.selectCockpitPanel) window.selectCockpitPanel('overview');
  setStatus('Sessão histórica de ' + new Date(item.ts).toLocaleString('pt-BR') + ' — somente leitura, sem player.', 'busy');
  renderBadges(model);
  renderKV($('#overview'), model.overview);
  $('#raw-manifest').textContent = '(manifest bruto não é armazenado no histórico — apenas o resumo estático)';
  renderTable($('#video-table'), VIDEO_COLUMNS, model.video || [], 'Nenhuma variante de vídeo declarada neste manifest.');
  renderTable($('#audio-table'), AUDIO_COLUMNS, model.audio || [], 'Nenhuma faixa de áudio alternativa declarada (áudio pode estar muxado no vídeo).');
  renderTable($('#subs-table'), SUB_COLUMNS, [...(model.subtitles || []), ...(model.closedCaptions || [])], 'Nenhuma faixa de legendas/closed captions declarada.');
  renderTable($('#drm-table'), DRM_COLUMNS, (model.drm || []).length ? model.drm : [], 'Nenhum sistema de DRM/criptografia declarado no manifest.');
  renderHdrPanel(model);
  renderAdBreaks(model.adBreaks || []);
  $('#sec-segments').hidden = true;
  $('#sec-container').hidden = true;
  $('#event-log').innerHTML = '';
  logEvent('Sessão histórica reaberta (somente leitura): ' + model.overview['URL']);
}

/* ================================================================ *
 * Bootstrap
 * ================================================================ */

document.addEventListener('DOMContentLoaded', () => {
  loadHistory();

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

  // presets de referência para análise de qualidade (PSNR/SSIM)
  const presetGroup = $('#quality-ref-preset optgroup');
  for (const p of StreamQuality.REFERENCE_PRESETS) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.label} — ${p.category}`;
    presetGroup.appendChild(opt);
  }
  $('#quality-ref-preset').addEventListener('change', (e) => {
    $('#quality-ref-file').hidden = e.target.value !== 'local';
  });
  $('#quality-ref-file').addEventListener('change', () => {
    if ($('#quality-ref-file').files.length) $('#quality-status').textContent = 'Arquivo selecionado. Clique em "Iniciar comparação".';
  });
  $('#btn-quality-start').addEventListener('click', () => startQualityCompare());
  $('#btn-quality-stop').addEventListener('click', () => stopQualityCompare());

  $('#engine-select').addEventListener('change', (e) => {
    state.engine = e.target.value;
    state.engineManuallySet = true; // não deixa mais o default por tipo de manifest sobrescrever
    logEvent(`Motor de reprodução alterado para ${ENGINE_BUNDLES[state.engine].label}.`);
    if (state.lastPlay) {
      stopPlayback();
      const { type, url, model, isLive, progressiveMimeType } = state.lastPlay;
      startPlayback(type, url, model, isLive, progressiveMimeType);
    }
  });

  $('#chroma-color-mode').addEventListener('change', (e) => {
    if (state.charts.chroma) state.charts.chroma.setColorMode(e.target.value);
    if (state.charts.chroma3d) state.charts.chroma3d.setColorMode(e.target.value);
  });

  // exportação de sessão
  $('#btn-export-json').addEventListener('click', () => exportSession('json'));
  $('#btn-export-csv').addEventListener('click', () => exportSession('csv'));

  // thresholds de alerta aplicados ao vivo
  for (const id of ['th-silence', 'th-freeze', 'th-buffer', 'th-lufs']) {
    $('#' + id).addEventListener('change', () => {
      if (state.alertEngine) state.alertEngine.thresholds = readThresholds();
      logEvent('Thresholds de alerta atualizados.');
    });
  }

  // teste de rede: limite customizado em Mbps, aplicado em tempo real
  $('#btn-throttle-apply').addEventListener('click', () => {
    const raw = $('#throttle-mbps').value.trim().replace(',', '.');
    const mbps = parseFloat(raw);
    if (!raw || isNaN(mbps) || mbps <= 0) {
      logEvent('Teste de rede: informe um valor válido em Mbps (ex.: 2,5).');
      return;
    }
    applyThrottle(mbps);
  });
  $('#btn-throttle-off').addEventListener('click', () => applyThrottle(0));
  $('#throttle-mbps').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#btn-throttle-apply').click(); }
  });
});

/**
 * Aplica o limite de banda (mbps; 0 = remover) no proxy local e, se o
 * playback atual não passa pelo proxy, redireciona-o automaticamente —
 * sem isso o limite nunca alcançaria os segmentos (eles iriam direto à
 * CDN quando a origem tem CORS aberto).
 */
async function applyThrottle(mbps) {
  const kbps = Math.round(mbps * 1000);
  try {
    const r = await fetch('/throttle?kbps=' + kbps);
    if (!r.ok) throw new Error('HTTP ' + r.status);
  } catch (err) {
    logEvent('Falha ao configurar o limite de banda (a página precisa ser servida pelo server.js): ' + err.message);
    return;
  }

  const chip = $('#throttle-state');
  if (kbps > 0) {
    chip.textContent = `Limite ativo: ${mbps.toFixed(1).replace('.', ',')} Mbps`;
    chip.classList.add('badge-throttled');
    logEvent(`TESTE DE REDE: banda do proxy limitada a ${mbps.toFixed(1).replace('.', ',')} Mbps.`);
  } else {
    chip.textContent = 'Sem limite';
    chip.classList.remove('badge-throttled');
    logEvent('TESTE DE REDE: limite de banda removido.');
  }

  // redirecionamento automático do playback para o proxy
  if (kbps > 0 && state.lastPlay && !state.lastPlay.url.startsWith('/p/') && state.sessionUrl) {
    const proxied = proxify(state.sessionUrl);
    if (proxied !== state.lastPlay.url) {
      $('#force-proxy').checked = true;
      const { type, model, isLive, progressiveMimeType } = state.lastPlay;
      stopPlayback();
      startPlayback(type, proxied, model, isLive, progressiveMimeType);
      logEvent('TESTE DE REDE: playback redirecionado para o proxy local para aplicar o limite.');
      logEvent('Observação: a troca de perfil/ladder aparece quando o buffer do player drena (~10–30s) — comportamento normal do ABR.');
    }
  }
}
