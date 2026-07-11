/**
 * Diagrama de cromaticidade CIE 1931 xy — modo instantâneo.
 *
 * Desenha o "horseshoe" do lócus espectral, os triângulos de gamut de
 * referência (Rec.709/sRGB, DCI-P3, Rec.2020) e sobrepõe a nuvem de
 * cromaticidade dos pixels do FRAME ATUAL (sem acumular histórico —
 * cada amostragem substitui a anterior, como um osciloscópio).
 *
 * Limitação (documentada na UI): os pixels vêm do canvas 8-bit já
 * tone-mapped pelo navegador — o gráfico mostra a cromaticidade do
 * resultado renderizado, não o dado mestre wide-gamut antes do
 * tone-mapping.
 */
'use strict';

/** Lócus espectral CIE 1931 (2°), coordenadas xy aproximadas a cada 10nm. */
const SPECTRAL_LOCUS = [
  [380, 0.1741, 0.0050], [390, 0.1738, 0.0049], [400, 0.1733, 0.0048], [410, 0.1726, 0.0048],
  [420, 0.1714, 0.0051], [430, 0.1689, 0.0069], [440, 0.1644, 0.0109], [450, 0.1566, 0.0177],
  [460, 0.1440, 0.0297], [470, 0.1241, 0.0578], [480, 0.0913, 0.1327], [490, 0.0454, 0.2950],
  [500, 0.0082, 0.5384], [510, 0.0139, 0.7502], [520, 0.0743, 0.8338], [530, 0.1547, 0.8059],
  [540, 0.2296, 0.7543], [550, 0.3016, 0.6923], [560, 0.3731, 0.6245], [570, 0.4441, 0.5547],
  [580, 0.5125, 0.4866], [590, 0.5752, 0.4242], [600, 0.6270, 0.3725], [610, 0.6658, 0.3340],
  [620, 0.6915, 0.3083], [630, 0.7079, 0.2920], [640, 0.7190, 0.2809], [650, 0.7260, 0.2739],
  [660, 0.7300, 0.2700], [670, 0.7320, 0.2680], [680, 0.7334, 0.2666], [690, 0.7344, 0.2656],
  [700, 0.7340, 0.2660],
];

const D65 = [0.3127, 0.3290];

const GAMUTS = [
  { key: 'rec709', label: 'Rec.709 / sRGB', colorVar: '--series-1',
    primaries: [[0.640, 0.330], [0.300, 0.600], [0.150, 0.060]], white: D65 },
  { key: 'p3', label: 'DCI-P3', colorVar: '--series-3',
    primaries: [[0.680, 0.320], [0.265, 0.690], [0.150, 0.060]], white: D65 },
  { key: 'rec2020', label: 'Rec.2020', colorVar: '--series-5',
    primaries: [[0.708, 0.292], [0.170, 0.797], [0.131, 0.046]], white: D65 },
];

/* ================================================================ *
 * Colorimetria
 * ================================================================ */

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c) {
  c = Math.min(1, Math.max(0, c));
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** sRGB 8-bit → xy de cromaticidade (matriz sRGB/Rec.709 D65). Null se luminância ~0. */
function rgb8ToXy(r, g, b) {
  const R = srgbToLinear(r / 255), G = srgbToLinear(g / 255), B = srgbToLinear(b / 255);
  const X = 0.4124564 * R + 0.3575761 * G + 0.1804375 * B;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.0721750 * B;
  const Z = 0.0193339 * R + 0.1191920 * G + 0.9503041 * B;
  const sum = X + Y + Z;
  if (sum < 1e-4) return null; // preto/quase-preto: cromaticidade indefinida
  return { x: X / sum, y: Y / sum, Y };
}

/** xy (com Y assumido) → sRGB 8-bit aproximado, com clamp para fora do gamut. */
function xyToRgb8(x, y, Yb) {
  const Y = Yb == null ? 0.6 : Yb;
  if (y < 1e-6) return null;
  const X = (x / y) * Y, Z = ((1 - x - y) / y) * Y;
  const R = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  const G = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
  const B = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  const max = Math.max(R, G, B, 1e-6);
  const scale = max > 1 ? 1 / max : 1; // preserva matiz quando estoura o gamut de exibição
  return [
    Math.round(linearToSrgb(Math.max(0, R * scale)) * 255),
    Math.round(linearToSrgb(Math.max(0, G * scale)) * 255),
    Math.round(linearToSrgb(Math.max(0, B * scale)) * 255),
  ];
}

function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    const intersect = (yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInTriangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/* ================================================================ *
 * Componente visual
 * ================================================================ */

class ChromaticityChart {
  constructor(container, opts) {
    this.container = container;
    this.opts = Object.assign({ height: 320 }, opts);
    this.domain = { xMin: 0, xMax: 0.8, yMin: 0, yMax: 0.9 };
    this.points = [];
    this.bg = null; // canvas offscreen com o horseshoe colorido (cacheado)

    container.classList.add('chroma-box');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'chart-canvas';
    this.canvas.style.height = this.opts.height + 'px';
    container.appendChild(this.canvas);

    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    for (const g of GAMUTS) {
      const item = document.createElement('span');
      item.className = 'chart-legend-item';
      const sw = document.createElement('span');
      sw.className = 'chart-swatch';
      sw.dataset.colorVar = g.colorVar;
      item.appendChild(sw);
      item.appendChild(document.createTextNode(g.label));
      legend.appendChild(item);
    }
    const swPt = document.createElement('span');
    swPt.className = 'chart-legend-item';
    const dotSw = document.createElement('span');
    dotSw.className = 'chart-swatch chroma-dot-swatch';
    swPt.appendChild(dotSw);
    swPt.appendChild(document.createTextNode('Pixels do frame atual (cor real)'));
    legend.appendChild(swPt);
    container.appendChild(legend);
    this.legend = legend;

    const tiles = document.createElement('div');
    tiles.className = 'tiles chroma-tiles';
    this.tileEls = {};
    for (const g of GAMUTS) {
      const tile = document.createElement('div');
      tile.className = 'tile';
      const label = document.createElement('span');
      label.className = 'tile-label';
      label.textContent = 'Dentro de ' + g.label;
      const value = document.createElement('span');
      value.className = 'tile-value';
      value.textContent = '—';
      tile.append(label, value);
      tiles.appendChild(tile);
      this.tileEls[g.key] = value;
    }
    container.appendChild(tiles);

    this.ctx = this.canvas.getContext('2d');
    this._ro = new ResizeObserver(() => this.draw());
    this._ro.observe(container);
    this._mq = matchMedia('(prefers-color-scheme: dark)');
    this._mqHandler = () => { this.bg = null; this.draw(); };
    this._mq.addEventListener('change', this._mqHandler);
    this.draw();
  }

  destroy() {
    this._ro.disconnect();
    this._mq.removeEventListener('change', this._mqHandler);
    this.container.innerHTML = '';
    this.container.classList.remove('chroma-box');
  }

  /** Substitui a nuvem de pontos (instantâneo — sem acumular). */
  setPoints(points) {
    this.points = points;
    this._updateCoverage();
    this.scheduleDraw();
  }

  _updateCoverage() {
    for (const g of GAMUTS) {
      if (!this.points.length) { this.tileEls[g.key].textContent = '—'; continue; }
      let inside = 0;
      for (const p of this.points) if (pointInTriangle(p.x, p.y, g.primaries[0], g.primaries[1], g.primaries[2])) inside++;
      this.tileEls[g.key].textContent = ((inside / this.points.length) * 100).toFixed(1).replace('.', ',') + '%';
    }
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
      this.bg = null; // recalcula o fundo no novo tamanho
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pad = 34;
    return { w, h, pad, plotW: w - pad * 2, plotH: h - pad * 1.5 - 10 };
  }

  _buildBackground(L) {
    const off = document.createElement('canvas');
    off.width = Math.round(L.plotW);
    off.height = Math.round(L.plotH);
    const octx = off.getContext('2d');
    const img = octx.createImageData(off.width, off.height);
    const locusPoly = SPECTRAL_LOCUS.map(([, x, y]) => [x, y]);
    const D = this.domain;
    const step = 2; // amostra a cada 2px para custo razoável
    for (let py = 0; py < off.height; py += step) {
      const y = D.yMax - (py / off.height) * (D.yMax - D.yMin);
      for (let px = 0; px < off.width; px += step) {
        const x = D.xMin + (px / off.width) * (D.xMax - D.xMin);
        if (!pointInPolygon(x, y, locusPoly)) continue;
        const rgb = xyToRgb8(x, y, 0.75);
        if (!rgb) continue;
        for (let dy = 0; dy < step && py + dy < off.height; dy++) {
          for (let dx = 0; dx < step && px + dx < off.width; dx++) {
            const idx = ((py + dy) * off.width + (px + dx)) * 4;
            img.data[idx] = rgb[0]; img.data[idx + 1] = rgb[1]; img.data[idx + 2] = rgb[2]; img.data[idx + 3] = 130;
          }
        }
      }
    }
    octx.putImageData(img, 0, 0);
    this.bg = off;
  }

  draw() {
    const L = this._layout();
    const ctx = this.ctx;
    const D = this.domain;
    const grid = cssVar('--grid');
    const axis = cssVar('--baseline');
    const muted = cssVar('--text-muted');

    ctx.clearRect(0, 0, L.w, L.h);
    ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';

    const X = (x) => L.pad + ((x - D.xMin) / (D.xMax - D.xMin)) * L.plotW;
    const Y = (y) => 10 + (1 - (y - D.yMin) / (D.yMax - D.yMin)) * L.plotH;

    if (!this.bg) this._buildBackground(L);
    ctx.drawImage(this.bg, L.pad, 10, L.plotW, L.plotH);

    // grade + ticks
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = muted;
    for (let v = 0; v <= D.xMax + 1e-9; v += 0.1) {
      const x = Math.round(X(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 10); ctx.lineTo(x, L.h - L.pad * 0.5); ctx.stroke();
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(v.toFixed(1), x, L.h - L.pad * 0.5 + 4);
    }
    for (let v = 0; v <= D.yMax + 1e-9; v += 0.1) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(L.pad, y); ctx.lineTo(L.w - 10, y); ctx.stroke();
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(v.toFixed(1), L.pad - 6, y);
    }
    ctx.strokeStyle = axis;
    ctx.strokeRect(L.pad, 10, L.plotW, L.plotH);

    // lócus espectral (contorno)
    ctx.strokeStyle = muted;
    ctx.lineWidth = 1;
    ctx.beginPath();
    SPECTRAL_LOCUS.forEach(([, x, y], i) => { i === 0 ? ctx.moveTo(X(x), Y(y)) : ctx.lineTo(X(x), Y(y)); });
    ctx.closePath();
    ctx.stroke();

    // triângulos de gamut
    for (const g of GAMUTS) {
      ctx.strokeStyle = cssVar(g.colorVar);
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      g.primaries.forEach(([x, y], i) => { i === 0 ? ctx.moveTo(X(x), Y(y)) : ctx.lineTo(X(x), Y(y)); });
      ctx.closePath();
      ctx.stroke();
    }

    // ponto branco D65
    ctx.fillStyle = muted;
    ctx.beginPath(); ctx.arc(X(D65[0]), Y(D65[1]), 3, 0, Math.PI * 2); ctx.fill();

    // nuvem de pontos do frame atual
    for (const p of this.points) {
      if (p.x < D.xMin || p.x > D.xMax || p.y < D.yMin || p.y > D.yMax) continue;
      ctx.fillStyle = `rgb(${p.r},${p.g},${p.b})`;
      ctx.beginPath();
      ctx.arc(X(p.x), Y(p.y), 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    if (this.legend) {
      for (const sw of this.legend.querySelectorAll('.chart-swatch:not(.chroma-dot-swatch)')) {
        sw.style.background = cssVar(sw.dataset.colorVar);
      }
    }
  }
}

window.StreamChromaticity = { ChromaticityChart, rgb8ToXy };
