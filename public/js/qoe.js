/**
 * Métricas de QoE (qualidade de experiência) da sessão de playback,
 * no espírito de CTA-2066: startup, rebuffering, comportamento ABR
 * e bitrate médio ponderado por tempo. Também concentra a exportação
 * da sessão completa (séries + eventos + alertas) em JSON/CSV.
 */
'use strict';

class QoeSession {
  constructor(video, opts) {
    this.video = video;
    this.nominalFps = (opts && opts.nominalFps) || null;
    this.t0 = performance.now();
    this.startupMs = null;          // até o primeiro frame apresentado
    this.rebuffers = [];            // {startT, endT|null}
    this.abrSwitches = 0;
    this.bitrateHistory = [];       // [tSeconds, mbps] a cada mudança
    this.watchStartT = null;

    // FPS real via requestVideoFrameCallback (fallback: playbackQuality)
    this.fps = null;
    this._frameCount = 0;
    this._fpsWindowStart = null;
    this._rvfcSupported = typeof video.requestVideoFrameCallback === 'function';
    if (this._rvfcSupported) {
      const onFrame = (now) => {
        if (this.startupMs === null) this.startupMs = performance.now() - this.t0;
        if (this._fpsWindowStart === null) this._fpsWindowStart = now;
        this._frameCount++;
        if (now - this._fpsWindowStart >= 1000) {
          this.fps = this._frameCount / ((now - this._fpsWindowStart) / 1000);
          this._frameCount = 0;
          this._fpsWindowStart = now;
        }
        if (!this._destroyed) video.requestVideoFrameCallback(onFrame);
      };
      video.requestVideoFrameCallback(onFrame);
    } else {
      this._lastQ = null;
    }

    this._onWaiting = () => {
      const t = this.elapsed();
      // ignora waiting antes do primeiro frame (faz parte do startup)
      if (this.startupMs === null) return;
      if (!this.rebuffers.length || this.rebuffers[this.rebuffers.length - 1].endT !== null) {
        this.rebuffers.push({ startT: t, endT: null });
      }
    };
    this._onPlaying = () => {
      const t = this.elapsed();
      if (this.watchStartT === null) this.watchStartT = t;
      if (this.startupMs === null && !this._rvfcSupported) this.startupMs = performance.now() - this.t0;
      const last = this.rebuffers[this.rebuffers.length - 1];
      if (last && last.endT === null) last.endT = t;
    };
    video.addEventListener('waiting', this._onWaiting);
    video.addEventListener('playing', this._onPlaying);
  }

  destroy() {
    this._destroyed = true;
    this.video.removeEventListener('waiting', this._onWaiting);
    this.video.removeEventListener('playing', this._onPlaying);
  }

  elapsed() { return (performance.now() - this.t0) / 1000; }

  /** Chamar a cada troca de nível ABR. */
  onLevelSwitch(mbps) {
    this.abrSwitches++;
    this.bitrateHistory.push([this.elapsed(), mbps]);
  }

  /** Registra o bitrate corrente mesmo sem troca (primeira medição). */
  noteBitrate(mbps) {
    if (mbps != null && !this.bitrateHistory.length) {
      this.bitrateHistory.push([this.elapsed(), mbps]);
    }
  }

  /** Tick do loop: atualiza FPS por fallback quando não há rVFC. */
  tick() {
    if (!this._rvfcSupported && this.video.getVideoPlaybackQuality) {
      const q = this.video.getVideoPlaybackQuality();
      const now = performance.now();
      if (this._lastQ) {
        const dt = (now - this._lastQ.t) / 1000;
        if (dt >= 1) {
          this.fps = (q.totalVideoFrames - this._lastQ.total) / dt;
          this._lastQ = { t: now, total: q.totalVideoFrames };
        }
      } else {
        this._lastQ = { t: now, total: q.totalVideoFrames };
      }
    }
  }

  summary() {
    const t = this.elapsed();
    let rebufferTotal = 0;
    let rebufferCount = 0;
    for (const r of this.rebuffers) {
      rebufferCount++;
      rebufferTotal += (r.endT === null ? t : r.endT) - r.startT;
    }
    const watch = this.watchStartT === null ? 0 : t - this.watchStartT;
    const ratio = watch + rebufferTotal > 0 ? (rebufferTotal / (watch + rebufferTotal)) * 100 : 0;

    // bitrate médio ponderado por tempo
    let avgBitrate = null;
    if (this.bitrateHistory.length) {
      let acc = 0, dur = 0;
      for (let i = 0; i < this.bitrateHistory.length; i++) {
        const [ts, mbps] = this.bitrateHistory[i];
        const te = i + 1 < this.bitrateHistory.length ? this.bitrateHistory[i + 1][0] : t;
        acc += mbps * (te - ts);
        dur += te - ts;
      }
      avgBitrate = dur > 0 ? acc / dur : this.bitrateHistory[0][1];
    }

    const q = this.video.getVideoPlaybackQuality ? this.video.getVideoPlaybackQuality() : null;

    return {
      startupMs: this.startupMs,
      watchTimeSec: watch,
      rebufferCount,
      rebufferTotalSec: rebufferTotal,
      rebufferRatioPct: ratio,
      abrSwitches: this.abrSwitches,
      avgBitrateMbps: avgBitrate,
      fps: this.fps,
      nominalFps: this.nominalFps,
      droppedFrames: q ? q.droppedVideoFrames : null,
      totalFrames: q ? q.totalVideoFrames : null,
    };
  }
}

/* ================================================================ *
 * Exportação da sessão
 * ================================================================ */

/**
 * Monta o objeto de exportação a partir do estado global da aplicação.
 * charts: { nome: LineChart } — extrai todas as séries (Map key→pontos).
 */
function buildSessionExport({ url, overview, qoe, alerts, events, charts }) {
  const series = {};
  for (const [chartName, chart] of Object.entries(charts || {})) {
    if (!chart || !chart.data) continue;
    for (const [key, pts] of chart.data) {
      series[`${chartName}.${key}`] = pts.map(([x, y]) => [round3(x), round3(y)]);
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    url,
    manifestOverview: overview || null,
    qoe: qoe || null,
    alerts: alerts || [],
    events: events || [],
    series,
  };
}

function sessionToCsv(exp) {
  const lines = ['t;metrica;valor'];
  for (const [name, pts] of Object.entries(exp.series)) {
    for (const [x, y] of pts) lines.push(`${x};${name};${y}`);
  }
  return lines.join('\n');
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function round3(v) { return Math.round(v * 1000) / 1000; }

window.StreamQoe = { QoeSession, buildSessionExport, sessionToCsv, downloadBlob };
