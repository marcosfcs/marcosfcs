/**
 * Análise de cor por frame para avaliação SDR/HDR.
 *
 * Amostra frames do <video> em um canvas reduzido e calcula:
 *   - histogramas por canal R, G, B (curvas de cor, 256 bins)
 *   - histograma de luminância (Rec.709)
 *   - luminância média (APL), percentual de pixels esmagados em
 *     sombras (Y ≤ 4) e estourados em realces (Y ≥ 251)
 *
 * Limitação importante (exibida na UI): o canvas 2D entrega valores
 * 8-bit já tone-mapped pelo navegador. Para conteúdo HDR (PQ/HLG) as
 * curvas refletem o sinal APÓS o tone-mapping para SDR do navegador;
 * a sinalização HDR verdadeira vem do manifest (VIDEO-RANGE / CICP).
 */
'use strict';

class ColorAnalyzer {
  constructor(video) {
    this.video = video;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.W = 320;
    this.H = 180;
    this.canvas.width = this.W;
    this.canvas.height = this.H;
  }

  /** Retorna null se ainda não há frame decodificado. */
  sample() {
    const v = this.video;
    if (!v.videoWidth || v.readyState < 2) return null;
    // mantém a proporção do vídeo dentro do canvas de análise
    const ar = v.videoWidth / v.videoHeight;
    const w = ar >= this.W / this.H ? this.W : Math.round(this.H * ar);
    const h = ar >= this.W / this.H ? Math.round(this.W / ar) : this.H;
    let img;
    try {
      this.ctx.drawImage(v, 0, 0, w, h);
      img = this.ctx.getImageData(0, 0, w, h).data;
    } catch (e) {
      // vídeo com proteção (tainted canvas / DRM) — análise indisponível
      return { blocked: true, error: e.name };
    }

    const histR = new Float32Array(256);
    const histG = new Float32Array(256);
    const histB = new Float32Array(256);
    const histY = new Float32Array(256);
    let sumY = 0, clipLow = 0, clipHigh = 0;
    const n = w * h;

    // amostragem esparsa para o diagrama de cromaticidade (instantâneo,
    // custo de conversão xy é maior que o do histograma)
    const rgbToXy = window.StreamChromaticity && window.StreamChromaticity.rgb8ToXy;
    const chromaPoints = [];
    const chromaStride = Math.max(1, Math.floor(n / 400)); // ~400 pontos por amostragem
    let pixelIndex = 0;

    for (let i = 0; i < n * 4; i += 4) {
      const r = img[i], g = img[i + 1], b = img[i + 2];
      histR[r]++; histG[g]++; histB[b]++;
      const y = Math.min(255, Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b));
      histY[y]++;
      sumY += y;
      if (y <= 4) clipLow++;
      else if (y >= 251) clipHigh++;

      if (rgbToXy && pixelIndex % chromaStride === 0) {
        const xy = rgbToXy(r, g, b);
        if (xy) chromaPoints.push({ x: xy.x, y: xy.y, r, g, b });
      }
      pixelIndex++;
    }

    return {
      blocked: false,
      pixels: n,
      histR: smoothNormalize(histR, n),
      histG: smoothNormalize(histG, n),
      histB: smoothNormalize(histB, n),
      histY: smoothNormalize(histY, n),
      avgLuma: (sumY / n / 255) * 100,          // % da faixa
      clipLowPct: (clipLow / n) * 100,
      clipHighPct: (clipHigh / n) * 100,
      chromaPoints,
    };
  }
}

/**
 * Suaviza (box blur raio 2) e normaliza para % de pixels por bin —
 * curvas comparáveis entre frames e resoluções.
 */
function smoothNormalize(hist, total) {
  const out = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(255, i + 2); j++) { s += hist[j]; c++; }
    out[i] = (s / c / total) * 100;
  }
  return out;
}

/** Capacidades HDR do ambiente de exibição atual. */
function displayHdrInfo() {
  const dynamicRange = matchMedia('(dynamic-range: high)').matches;
  const gamutP3 = matchMedia('(color-gamut: p3)').matches;
  const gamutRec2020 = matchMedia('(color-gamut: rec2020)').matches;
  return {
    'Faixa dinâmica do display': dynamicRange ? 'Alta (HDR disponível)' : 'Padrão (SDR)',
    'Gama de cores do display': gamutRec2020 ? 'Rec.2020' : gamutP3 ? 'Display-P3' : 'sRGB',
    'Profundidade de cor reportada': (screen.colorDepth || 24) + ' bits',
  };
}

window.ColorAnalyzer = ColorAnalyzer;
window.displayHdrInfo = displayHdrInfo;
