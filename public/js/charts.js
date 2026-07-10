/**
 * Mini-biblioteca de gráficos em canvas para o Stream Inspector.
 * Um único componente LineChart cobre os três usos:
 *   - séries temporais dinâmicas (janela deslizante, .push())
 *   - curvas estáticas (histogramas de cor, .setSeriesData())
 *   - degraus (duração de segmentos, opção step)
 *
 * Especificações visuais: linhas 2px (round join), grid hairline sólido,
 * preenchimento de área a 10% de opacidade, legenda HTML para 2+ séries,
 * crosshair + tooltip no hover, texto sempre em tokens de texto.
 * Cores resolvidas de CSS custom properties em tempo de desenho
 * (troca automática light/dark).
 */
'use strict';

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback || '#888';
}

class LineChart {
  /**
   * @param {HTMLElement} container
   * @param {object} opts
   *   series: [{ key, label, colorVar, fill?, step? }]
   *   yFormat: (v) => string        formatação de ticks/tooltip
   *   xFormat: (x) => string
   *   xLabel, yLabel: string
   *   windowSec: number             janela deslizante (séries temporais)
   *   yMin, yMax: number            fixa o domínio Y (ex.: 0–100%)
   *   xMin, xMax: number            fixa o domínio X (ex.: 0–255)
   *   height: number (css px)
   */
  constructor(container, opts) {
    this.container = container;
    this.opts = Object.assign({ height: 220, windowSec: null }, opts);
    this.data = new Map(); // key -> [[x,y],...]
    for (const s of this.opts.series) this.data.set(s.key, []);
    this.hover = null;

    container.classList.add('chart-box');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'chart-canvas';
    this.canvas.style.height = this.opts.height + 'px';
    container.appendChild(this.canvas);

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'chart-tooltip';
    this.tooltip.hidden = true;
    container.appendChild(this.tooltip);

    if (this.opts.series.length >= 2) {
      const legend = document.createElement('div');
      legend.className = 'chart-legend';
      for (const s of this.opts.series) {
        const item = document.createElement('span');
        item.className = 'chart-legend-item';
        const sw = document.createElement('span');
        sw.className = 'chart-swatch';
        sw.dataset.colorVar = s.colorVar;
        item.appendChild(sw);
        item.appendChild(document.createTextNode(s.label));
        legend.appendChild(item);
      }
      container.appendChild(legend);
      this.legend = legend;
    }

    this.ctx = this.canvas.getContext('2d');
    this._ro = new ResizeObserver(() => this.draw());
    this._ro.observe(container);
    this._mq = matchMedia('(prefers-color-scheme: dark)');
    this._mqHandler = () => this.draw();
    this._mq.addEventListener('change', this._mqHandler);

    this.canvas.addEventListener('mousemove', (e) => this._onHover(e));
    this.canvas.addEventListener('mouseleave', () => { this.hover = null; this.tooltip.hidden = true; this.draw(); });
    this.draw();
  }

  destroy() {
    this._ro.disconnect();
    this._mq.removeEventListener('change', this._mqHandler);
    this.container.innerHTML = '';
    this.container.classList.remove('chart-box');
  }

  push(x, values) {
    for (const [key, v] of Object.entries(values)) {
      const arr = this.data.get(key);
      if (!arr || v == null || isNaN(v)) continue;
      arr.push([x, v]);
      if (this.opts.windowSec) {
        const cutoff = x - this.opts.windowSec * 1.2;
        while (arr.length && arr[0][0] < cutoff) arr.shift();
      }
    }
    this.scheduleDraw();
  }

  setSeriesData(key, points) {
    this.data.set(key, points);
    this.scheduleDraw();
  }

  scheduleDraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this.draw(); });
  }

  _layout() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.container.clientWidth;
    const h = this.opts.height;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = w + 'px';
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // padding esquerdo dimensionado pelo rótulo Y mais largo do último desenho
    const padL = Math.max(44, (this._maxYLabelW || 0) + 14), padR = 14, padT = 12, padB = 26;
    return { w, h, padL, padR, padT, padB, plotW: w - padL - padR, plotH: h - padT - padB };
  }

  _domains() {
    let xMin = this.opts.xMin, xMax = this.opts.xMax;
    let yMin = this.opts.yMin, yMax = this.opts.yMax;
    let dxMin = Infinity, dxMax = -Infinity, dyMin = Infinity, dyMax = -Infinity;
    for (const arr of this.data.values()) {
      for (const [x, y] of arr) {
        if (x < dxMin) dxMin = x;
        if (x > dxMax) dxMax = x;
        if (y < dyMin) dyMin = y;
        if (y > dyMax) dyMax = y;
      }
    }
    if (dxMin === Infinity) { dxMin = 0; dxMax = 1; dyMin = 0; dyMax = 1; }
    if (this.opts.windowSec != null && xMax == null) {
      xMax = dxMax;
      xMin = Math.max(dxMin, dxMax - this.opts.windowSec);
      if (xMax - xMin < this.opts.windowSec) xMax = xMin + this.opts.windowSec;
    }
    if (xMin == null) xMin = dxMin;
    if (xMax == null) xMax = dxMax;
    if (yMin == null) yMin = Math.min(0, dyMin);
    if (yMax == null) yMax = dyMax <= yMin ? yMin + 1 : dyMax * 1.08;
    if (xMax === xMin) xMax = xMin + 1;
    return { xMin, xMax, yMin, yMax };
  }

  _niceTicks(min, max, count) {
    const span = max - min;
    const step0 = span / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    let step = mag;
    for (const m of [1, 2, 2.5, 5, 10]) {
      if (mag * m >= step0) { step = mag * m; break; }
    }
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) {
      ticks.push(Math.round(v * 1e9) / 1e9);
    }
    return ticks;
  }

  draw() {
    const L = this._layout();
    const D = this._domains();
    const ctx = this.ctx;
    const grid = cssVar('--grid');
    const axis = cssVar('--baseline');
    const muted = cssVar('--text-muted');
    const surface = cssVar('--surface-1');

    ctx.clearRect(0, 0, L.w, L.h);
    ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';

    const X = (x) => L.padL + ((x - D.xMin) / (D.xMax - D.xMin)) * L.plotW;
    const Y = (y) => L.padT + (1 - (y - D.yMin) / (D.yMax - D.yMin)) * L.plotH;
    this._X = X; this._Y = Y; this._D = D; this._L = L;

    // grid horizontal + ticks Y
    const yTicks = this._niceTicks(D.yMin, D.yMax, 4);
    const maxW = Math.max(0, ...yTicks.map((t) =>
      ctx.measureText(this.opts.yFormat ? this.opts.yFormat(t) : String(t)).width));
    if (Math.abs(maxW - (this._maxYLabelW || 0)) > 2) {
      this._maxYLabelW = maxW;
      this.scheduleDraw(); // re-desenha com o padding correto
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const t of yTicks) {
      const y = Math.round(Y(t)) + 0.5;
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(L.padL, y); ctx.lineTo(L.w - L.padR, y); ctx.stroke();
      ctx.fillStyle = muted;
      ctx.fillText(this.opts.yFormat ? this.opts.yFormat(t) : String(t), L.padL - 8, y);
    }
    // baseline + ticks X
    ctx.strokeStyle = axis;
    ctx.beginPath();
    const by = Math.round(Y(Math.max(D.yMin, Math.min(0, D.yMax)))) + 0.5;
    ctx.moveTo(L.padL, by); ctx.lineTo(L.w - L.padR, by); ctx.stroke();
    const xTicks = this._niceTicks(D.xMin, D.xMax, Math.max(3, Math.floor(L.plotW / 90)));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = muted;
    for (const t of xTicks) {
      ctx.fillText(this.opts.xFormat ? this.opts.xFormat(t) : String(t), X(t), L.h - L.padB + 8);
    }

    // séries
    for (const s of this.opts.series) {
      const arr = this.data.get(s.key);
      if (!arr || arr.length === 0) continue;
      const color = cssVar(s.colorVar);
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = color;

      const path = new Path2D();
      let first = true;
      let prevY = null;
      for (const [x, y] of arr) {
        const px = X(x), py = Y(y);
        if (first) { path.moveTo(px, py); first = false; }
        else if (s.step) { path.lineTo(px, prevY); path.lineTo(px, py); }
        else path.lineTo(px, py);
        prevY = py;
      }
      if (s.fill) {
        const fillPath = new Path2D(path);
        const lastX = X(arr[arr.length - 1][0]);
        const firstX = X(arr[0][0]);
        fillPath.lineTo(lastX, Y(Math.max(D.yMin, 0)));
        fillPath.lineTo(firstX, Y(Math.max(D.yMin, 0)));
        fillPath.closePath();
        ctx.globalAlpha = 0.1;
        ctx.fillStyle = color;
        ctx.fill(fillPath);
        ctx.globalAlpha = 1;
      }
      ctx.stroke(path);
    }

    // atualiza cores da legenda (podem ter trocado com o tema)
    if (this.legend) {
      for (const sw of this.legend.querySelectorAll('.chart-swatch')) {
        sw.style.background = cssVar(sw.dataset.colorVar);
      }
    }

    // crosshair + marcadores de hover
    if (this.hover != null) {
      const hx = Math.round(X(this.hover)) + 0.5;
      ctx.strokeStyle = axis;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(hx, L.padT); ctx.lineTo(hx, L.h - L.padB); ctx.stroke();
      for (const s of this.opts.series) {
        const pt = this._nearest(s.key, this.hover);
        if (!pt) continue;
        ctx.beginPath();
        ctx.arc(X(pt[0]), Y(pt[1]), 4, 0, Math.PI * 2);
        ctx.fillStyle = cssVar(s.colorVar);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = surface;
        ctx.stroke();
      }
    }
  }

  _nearest(key, x) {
    const arr = this.data.get(key);
    if (!arr || !arr.length) return null;
    let lo = 0, hi = arr.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arr[mid][0] < x) lo = mid; else hi = mid;
    }
    const a = arr[lo], b = arr[hi];
    return Math.abs(a[0] - x) <= Math.abs(b[0] - x) ? a : b;
  }

  _onHover(e) {
    if (!this._X) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const D = this._D, L = this._L;
    if (px < L.padL || px > L.w - L.padR) { this.hover = null; this.tooltip.hidden = true; this.draw(); return; }
    const x = D.xMin + ((px - L.padL) / L.plotW) * (D.xMax - D.xMin);
    // trava no ponto mais próximo da primeira série com dados
    let snap = x;
    for (const s of this.opts.series) {
      const pt = this._nearest(s.key, x);
      if (pt) { snap = pt[0]; break; }
    }
    this.hover = snap;

    const rows = [];
    for (const s of this.opts.series) {
      const pt = this._nearest(s.key, snap);
      if (!pt || Math.abs(pt[0] - snap) > (D.xMax - D.xMin) * 0.05 + 1e-9) continue;
      const val = this.opts.yFormat ? this.opts.yFormat(pt[1]) : String(Math.round(pt[1] * 100) / 100);
      rows.push(
        `<div class="tt-row"><span class="chart-swatch" style="background:${cssVar(s.colorVar)}"></span>` +
        `<span class="tt-label">${s.label}</span><span class="tt-val">${val}</span></div>`
      );
    }
    if (!rows.length) { this.tooltip.hidden = true; this.draw(); return; }
    const head = this.opts.xFormat ? this.opts.xFormat(snap) : String(Math.round(snap * 100) / 100);
    this.tooltip.innerHTML = `<div class="tt-head">${head}</div>` + rows.join('');
    this.tooltip.hidden = false;
    const tx = Math.min(this._X(snap) + 12, L.w - this.tooltip.offsetWidth - 8);
    this.tooltip.style.left = Math.max(0, tx) + 'px';
    this.tooltip.style.top = L.padT + 6 + 'px';
    this.draw();
  }
}

window.LineChart = LineChart;
window.cssVar = cssVar;
