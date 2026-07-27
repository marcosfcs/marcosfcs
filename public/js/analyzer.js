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

    // Canvas SEPARADO, só para a nuvem de cromaticidade deste fallback
    // (usado quando WebCodecs está indisponível ou falhou). Medi que um
    // canvas display-p3 muda ligeiramente até a leitura pedida como 'srgb'
    // (diferenças de arredondamento internas antes da quantização pro
    // 8-bit) — por isso NÃO reaproveito `this.canvas`/`this.ctx` aqui: o
    // canvas principal, usado pelos histogramas/APL/clip/alerta de tela
    // preta, continua bit a bit igual ao de sempre.
    this.wideCanvas = document.createElement('canvas');
    this.wideCanvas.width = this.W;
    this.wideCanvas.height = this.H;
    try { this.wideCtx = this.wideCanvas.getContext('2d', { colorSpace: 'display-p3', willReadFrequently: true }); }
    catch { this.wideCtx = null; }
    this.wideGamut = !!(this.wideCtx && typeof this.wideCtx.getContextAttributes === 'function' &&
      this.wideCtx.getContextAttributes().colorSpace === 'display-p3');
  }

  /** Retorna null se ainda não há frame decodificado. */
  sample() {
    const v = this.video;
    if (!v.videoWidth || v.readyState < 2) return null;
    // mantém a proporção do vídeo dentro do canvas de análise
    const ar = v.videoWidth / v.videoHeight;
    const w = ar >= this.W / this.H ? this.W : Math.round(this.H * ar);
    const h = ar >= this.W / this.H ? Math.round(this.W / ar) : this.H;
    let img, imgWide;
    try {
      this.ctx.drawImage(v, 0, 0, w, h);
      img = this.ctx.getImageData(0, 0, w, h).data;
      if (this.wideGamut) {
        try {
          this.wideCtx.drawImage(v, 0, 0, w, h);
          imgWide = this.wideCtx.getImageData(0, 0, w, h, { colorSpace: 'display-p3' }).data;
        } catch { imgWide = null; }
      }
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
    // custo de conversão xy é maior que o do histograma). Quando o canvas
    // conseguiu Display-P3 (this.wideGamut) e a leitura P3 funcionou,
    // usa `imgWide` (bytes já no gamut P3) em vez dos bytes sRGB — mesmo
    // princípio do gráfico (Camada 3), aplicado aqui só à cromaticidade.
    const rgbToXy = window.StreamChromaticity && window.StreamChromaticity.rgb8ToXy;
    const p3Point = window.StreamColorMath ? makeP3PointBuilder() : null;
    const useWide = !!(imgWide && p3Point);
    const chromaPoints = [];
    const chromaStride = Math.max(1, Math.floor(n / 400)); // ~400 pontos por amostragem
    let pixelIndex = 0;

    // thumbnail 16×9 em escala de cinza — assinatura barata do frame para
    // detecção de congelamento (comparada entre amostras consecutivas)
    const TW = 16, TH = 9;
    const thumb = new Float32Array(TW * TH);
    const thumbCount = new Uint16Array(TW * TH);

    for (let i = 0; i < n * 4; i += 4) {
      const r = img[i], g = img[i + 1], b = img[i + 2];
      histR[r]++; histG[g]++; histB[b]++;
      const y = Math.min(255, Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b));
      histY[y]++;
      sumY += y;
      if (y <= 4) clipLow++;
      else if (y >= 251) clipHigh++;

      if (pixelIndex % chromaStride === 0) {
        if (useWide) {
          const p = p3Point(imgWide[i], imgWide[i + 1], imgWide[i + 2]);
          if (p) chromaPoints.push({ x: p.x, y: p.y, Y: Math.min(1, Math.max(0, p.Y)), r: p.r, g: p.g, b: p.b, disp: { tonemap: p.disp, vivid: p.disp, space: 'display-p3' } });
        } else if (rgbToXy) {
          const xy = rgbToXy(r, g, b);
          if (xy) chromaPoints.push({ x: xy.x, y: xy.y, Y: Math.min(1, Math.max(0, xy.Y)), r, g, b });
        }
      }
      const px = pixelIndex % w, py = (pixelIndex / w) | 0;
      const ti = Math.min(TH - 1, (py * TH / h) | 0) * TW + Math.min(TW - 1, (px * TW / w) | 0);
      thumb[ti] += y;
      thumbCount[ti]++;
      pixelIndex++;
    }
    for (let i = 0; i < thumb.length; i++) if (thumbCount[i]) thumb[i] /= thumbCount[i];

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
      thumb,
    };
  }
}

/**
 * Constrói os campos de cromaticidade a partir de bytes já lidos em
 * Display-P3 (mesma OETF do sRGB, primárias mais largas). Devolve tanto a
 * cor sRGB (`r,g,b`, pro fallback rgb() quando o gráfico não tem canvas
 * P3) quanto a P3 original (`disp`, pro `color(display-p3 …)`) — sem essa
 * distinção, um byte P3 pintado com `rgb()` seria lido como sRGB e sairia
 * com o matiz errado. Reaproveita as matrizes/EOTF de colorspace.js em vez
 * de duplicá-las aqui.
 */
function makeP3PointBuilder() {
  const M = window.StreamColorMath;
  const prim = M.PRIMARIES_TO_XYZ.smpte432; // DCI-P3 D65
  const toSrgb = M.XYZ_TO_OUT.srgb;
  return (r, g, b) => {
    const R = M.srgbInverseEotf(r / 255), G = M.srgbInverseEotf(g / 255), B = M.srgbInverseEotf(b / 255);
    const X = prim[0][0] * R + prim[0][1] * G + prim[0][2] * B;
    const Y = prim[1][0] * R + prim[1][1] * G + prim[1][2] * B;
    const Z = prim[2][0] * R + prim[2][1] * G + prim[2][2] * B;
    const sum = X + Y + Z;
    if (sum < 1e-4) return null;
    const srgbLin = M.desaturateIntoGamut([
      toSrgb[0][0] * X + toSrgb[0][1] * Y + toSrgb[0][2] * Z,
      toSrgb[1][0] * X + toSrgb[1][1] * Y + toSrgb[1][2] * Z,
      toSrgb[2][0] * X + toSrgb[2][1] * Y + toSrgb[2][2] * Z,
    ]);
    return {
      x: X / sum, y: Y / sum, Y,
      r: M.linearToSrgb8(srgbLin[0]), g: M.linearToSrgb8(srgbLin[1]), b: M.linearToSrgb8(srgbLin[2]),
      disp: { r: r / 255, g: g / 255, b: b / 255, space: 'display-p3' },
    };
  };
}

/** Diferença média absoluta entre dois thumbnails (0–255). */
function thumbDiff(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
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
window.thumbDiff = thumbDiff;
