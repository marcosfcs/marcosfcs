/**
 * Monitoração de rede/CDN por segmento e saúde do manifest live.
 *
 * Normaliza, por motor de playback, amostras de download de segmento:
 *   { ttfbMs, downloadMs, throughputMbps, bytes }
 *
 * Cobertura por motor:
 *   - hls.js:  FRAG_LOADED → frag.stats.loading{start,first,end} + total
 *              (TTFB e throughput exatos)
 *   - dash.js: getDashMetrics().getHttpRequests('video')
 *              (trequest/tresponse/_tfinish)
 *   - shaka:   response filter da networking engine — só o tempo total da
 *              requisição está disponível; TTFB não é reportado
 *
 * Também acompanha:
 *   - atualização do manifest em live (para o alerta de playlist estagnada)
 *   - PROGRAM-DATE-TIME do fragmento em reprodução (latência E2E no HLS)
 */
'use strict';

class NetMonitor {
  /**
   * @param {object} opts { onSample(sample), playerKind, player, hlsEvents }
   */
  constructor(player, playerKind, onSample) {
    this.player = player;
    this.playerKind = playerKind;
    this.onSample = onSample;
    this.lastManifestUpdate = performance.now();
    this.currentPdt = null;   // { pdtMs, fragStart } do fragmento em reprodução
    this._detach = [];

    if (playerKind === 'hls') this._attachHls(player);
    else if (playerKind === 'dash') this._attachDash(player);
    else if (playerKind === 'shaka') this._attachShaka(player);
  }

  destroy() {
    for (const fn of this._detach) { try { fn(); } catch { /* já removido */ } }
    this._detach = [];
  }

  _emit(sample) {
    if (sample.downloadMs <= 0 || !isFinite(sample.throughputMbps)) return;
    this.onSample(sample);
  }

  /* ---------------- hls.js ---------------- */
  _attachHls(hls) {
    const onFragLoaded = (_, data) => {
      const st = data.frag && data.frag.stats;
      if (!st || !st.loading) return;
      const ttfb = st.loading.first - st.loading.start;
      const download = st.loading.end - st.loading.first;
      const bytes = st.total || st.loaded || 0;
      this._emit({
        ttfbMs: Math.max(0, ttfb),
        downloadMs: Math.max(1, download),
        throughputMbps: (bytes * 8) / Math.max(1, download) / 1000, // bytes*8 / ms → kbps → /1000 Mbps
        bytes,
      });
    };
    const onLevelUpdated = () => { this.lastManifestUpdate = performance.now(); };
    const onFragChanged = (_, data) => {
      const f = data && data.frag;
      this.currentPdt = f && f.programDateTime ? { pdtMs: f.programDateTime, fragStart: f.start } : null;
    };
    hls.on(Hls.Events.FRAG_LOADED, onFragLoaded);
    hls.on(Hls.Events.LEVEL_UPDATED, onLevelUpdated);
    hls.on(Hls.Events.FRAG_CHANGED, onFragChanged);
    this._detach.push(() => hls.off(Hls.Events.FRAG_LOADED, onFragLoaded));
    this._detach.push(() => hls.off(Hls.Events.LEVEL_UPDATED, onLevelUpdated));
    this._detach.push(() => hls.off(Hls.Events.FRAG_CHANGED, onFragChanged));
  }

  /* ---------------- dash.js ---------------- */
  _attachDash(player) {
    this._seenDashRequests = new Set();
    this._dashPoll = setInterval(() => {
      let requests = [];
      try {
        requests = player.getDashMetrics().getHttpRequests('video') || [];
      } catch { return; }
      for (const r of requests.slice(-20)) {
        if (r.type !== 'MediaSegment' || !r._tfinish || !r.tresponse || !r.trequest) continue;
        const id = r.url + '|' + r.trequest.getTime();
        if (this._seenDashRequests.has(id)) continue;
        this._seenDashRequests.add(id);
        const ttfb = r.tresponse.getTime() - r.trequest.getTime();
        const download = r._tfinish.getTime() - r.tresponse.getTime();
        const bytes = (r.trace || []).reduce((s, tr) => s + (tr.b && tr.b[0] ? tr.b[0] : 0), 0);
        this._emit({
          ttfbMs: Math.max(0, ttfb),
          downloadMs: Math.max(1, download),
          throughputMbps: (bytes * 8) / Math.max(1, download) / 1000,
          bytes,
        });
      }
      if (this._seenDashRequests.size > 500) {
        this._seenDashRequests = new Set([...this._seenDashRequests].slice(-100));
      }
    }, 1000);
    this._detach.push(() => clearInterval(this._dashPoll));

    const onManifest = () => { this.lastManifestUpdate = performance.now(); };
    player.on(dashjs.MediaPlayer.events.MANIFEST_LOADED, onManifest);
    this._detach.push(() => player.off(dashjs.MediaPlayer.events.MANIFEST_LOADED, onManifest));
  }

  /* ---------------- shaka ---------------- */
  _attachShaka(player) {
    const RequestType = shaka.net.NetworkingEngine.RequestType;
    const filter = (type, response) => {
      if (type !== RequestType.SEGMENT) return;
      const bytes = response.data ? response.data.byteLength : 0;
      const total = response.timeMs || 0;
      // Shaka só expõe o tempo total (sem TTFB separado)
      this._emit({
        ttfbMs: null,
        downloadMs: Math.max(1, total),
        throughputMbps: (bytes * 8) / Math.max(1, total) / 1000,
        bytes,
      });
    };
    player.getNetworkingEngine().registerResponseFilter(filter);
    this._detach.push(() => player.getNetworkingEngine().unregisterResponseFilter(filter));

    const onManifestUpdated = () => { this.lastManifestUpdate = performance.now(); };
    player.addEventListener('manifestupdated', onManifestUpdated);
    this._detach.push(() => player.removeEventListener('manifestupdated', onManifestUpdated));
  }

  /** Segundos desde a última atualização de manifest (para o alerta de estagnação). */
  manifestAgeSec() {
    return (performance.now() - this.lastManifestUpdate) / 1000;
  }

  /** Latência ponta-a-ponta via PROGRAM-DATE-TIME (HLS), em segundos. Null se indisponível. */
  e2eLatencySec(video) {
    if (!this.currentPdt) return null;
    const wallOfCurrent = this.currentPdt.pdtMs + (video.currentTime - this.currentPdt.fragStart) * 1000;
    const lat = (Date.now() - wallOfCurrent) / 1000;
    return lat > -60 && lat < 3600 ? lat : null; // descarta PDT sem sincronia plausível
  }
}

/* ================================================================ *
 * Resource Timing API — rede real, independente do motor de playback
 * ================================================================ */

const SEGMENT_URL_RE = /\.(ts|m4s|mp4|m4a|aac|webm|cmfv|cmfa)(\?|$)/i;
function looksLikeSegmentUrl(url) {
  return SEGMENT_URL_RE.test(url) || /\/p\/https?\//.test(url);
}

/**
 * Observa PerformanceResourceTiming para requisições de segmento —
 * funciona para QUALQUER motor (inclusive Shaka, que não expõe TTFB
 * via API própria, e o `<video src>` progressivo do YouTube, que não
 * tem nenhum hook de rede próprio).
 *
 * Limitação do próprio navegador: para origens cross-origin sem o
 * header `Timing-Allow-Origin`, a spec zera dns/tcp/tls/ttfb (só
 * duration e transferSize sobrevivem) — reportado como "detalhe
 * indisponível" em vez de zero enganoso.
 */
class ResourceTimingMonitor {
  constructor(onSample) {
    this.onSample = onSample;
    this.seen = new Set();
    this._obs = null;
    if (typeof PerformanceObserver === 'undefined') return;
    try {
      this._obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) this._maybeEmit(e);
      });
      this._obs.observe({ entryTypes: ['resource'] });
    } catch {
      this._obs = null;
    }
    // evita estourar o buffer padrão (~250 entradas) do navegador
    this._clearTimer = setInterval(() => {
      try { performance.clearResourceTimings(); } catch { /* não suportado */ }
    }, 15000);
  }

  destroy() {
    if (this._obs) this._obs.disconnect();
    if (this._clearTimer) clearInterval(this._clearTimer);
  }

  _maybeEmit(entry) {
    if (!looksLikeSegmentUrl(entry.name)) return;
    const id = entry.name + '|' + entry.startTime;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    if (this.seen.size > 1000) this.seen = new Set([...this.seen].slice(-300));

    const hasDetail = entry.domainLookupEnd > 0 || entry.connectEnd > 0 || entry.responseStart > 0;
    const dns = entry.domainLookupEnd > entry.domainLookupStart ? entry.domainLookupEnd - entry.domainLookupStart : 0;
    const tcp = entry.connectEnd > entry.connectStart ? entry.connectEnd - entry.connectStart : 0;
    const tls = entry.secureConnectionStart > 0 ? entry.connectEnd - entry.secureConnectionStart : 0;
    const ttfb = entry.responseStart > entry.requestStart ? entry.responseStart - entry.requestStart : null;
    const download = entry.responseEnd > entry.responseStart
      ? entry.responseEnd - entry.responseStart
      : entry.duration;
    const bytes = entry.transferSize || entry.encodedBodySize || 0;

    this.onSample({
      url: entry.name,
      detailAvailable: hasDetail,
      dnsMs: dns, tcpMs: tcp, tlsMs: tls,
      ttfbMs: ttfb,
      downloadMs: Math.max(1, download || entry.duration || 1),
      throughputMbps: bytes > 0 && download > 0 ? (bytes * 8) / download / 1000 : null,
      bytes,
      totalMs: entry.duration,
    });
  }
}

/* ================================================================ *
 * Captura de headers de CDN/edge (e CMSD) — apenas ASSINA o registro
 * global instalado por um <script> inline no <head> de index.html,
 * ANTES de hls.js/dash.js/shaka carregarem. Necessário porque essas
 * libs podem capturar uma referência a fetch/XMLHttpRequest no próprio
 * carregamento do script; um monkeypatch feito depois (ex.: só quando
 * o playback inicia) chegaria tarde demais para essa captura.
 * Funciona com qualquer motor, MAS não alcança o <video src> nativo do
 * progressivo do YouTube (o navegador busca por conta própria).
 * ================================================================ */

class HeaderSniffer {
  constructor(onHeaders) {
    this.onHeaders = onHeaders;
    this._unsubscribe = window.__cdnHeaderSubscribe
      ? window.__cdnHeaderSubscribe((url, headers) => this.onHeaders(url, headers))
      : null;
  }

  destroy() {
    if (this._unsubscribe) this._unsubscribe();
  }
}

/** Parseia CMSD-Static/CMSD-Dynamic (RFC "Structured Field Values", forma chave=valor,chave). */
function parseCmsd(value) {
  const out = {};
  for (const part of value.split(',')) {
    const m = part.trim().match(/^([a-z0-9_-]+)(?:=(.+))?$/i);
    if (m) out[m[1]] = m[2] !== undefined ? m[2].replace(/^"|"$/g, '') : true;
  }
  return out;
}

window.NetMonitor = NetMonitor;
window.ResourceTimingMonitor = ResourceTimingMonitor;
window.HeaderSniffer = HeaderSniffer;
window.parseCmsd = parseCmsd;
