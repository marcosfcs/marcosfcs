/**
 * Espaço de cor REALMENTE decodificado, via WebCodecs (MediaStreamTrackProcessor).
 *
 * Diferente dos histogramas de analyzer.js (que leem um canvas 2D 8-bit já
 * tone-mapped pelo navegador), aqui lemos o VideoFrame como o decodificador
 * de fato produziu — primaries/transfer/matrix/fullRange corretos, sem
 * intermediário de canvas. É a confirmação mais forte de HDR real vs. o
 * que o manifest apenas declara.
 *
 * Além do painel de metadados, este módulo também extrai uma amostra real de
 * pixels (via `frame.copyTo()`) para alimentar o diagrama de cromaticidade —
 * o canvas 2D usado em analyzer.js/chromaticity.js sempre entrega bytes já
 * convertidos para sRGB pelo compositor do navegador, então qualquer conteúdo
 * HDR/wide-gamut aparece preso dentro do triângulo Rec.709 ali, não importa a
 * matriz de conversão usada depois. Amostrando o VideoFrame bruto e aplicando
 * a matriz YUV→RGB, a EOTF inversa e a matriz de primárias→XYZ corretas (a
 * partir do `colorSpace` real do frame), os pontos refletem o gamut de
 * verdade do conteúdo decodificado.
 *
 * Limitação: MediaStreamTrackProcessor é Chromium-only no momento — feature
 * detection explícito, com nota de indisponibilidade nos demais navegadores
 * (mesmo padrão de honestidade usado no resto do projeto).
 */
'use strict';

const TRANSFER_NAMES = {
  'bt709': 'BT.709 (SDR)', 'smpte170m': 'BT.601 (SDR)', 'bt470bg': 'BT.601 PAL (SDR)',
  'pq': 'PQ / SMPTE 2084 (HDR10)', 'hlg': 'HLG (HDR)', 'linear': 'Linear', 'iec61966-2-1': 'sRGB',
};
const PRIMARIES_NAMES = {
  'bt709': 'BT.709', 'bt470bg': 'BT.601 PAL', 'smpte170m': 'BT.601 NTSC', 'bt2020': 'BT.2020/BT.2100',
  'smpte432': 'DCI-P3 (D65)',
};
const MATRIX_NAMES = { 'rgb': 'RGB', 'bt709': 'BT.709', 'bt470bg': 'BT.601', 'smpte170m': 'BT.601', 'bt2020-ncl': 'BT.2020 NCL' };

/* ================================================================ *
 * Conversão de cor a partir do VideoFrame bruto (sem canvas)
 * ================================================================ */

/** Coeficientes Kr/Kb da matriz YUV→RGB por VideoMatrixCoefficients. */
const YUV_KRB = {
  'bt709': { kr: 0.2126, kb: 0.0722 },
  'bt470bg': { kr: 0.299, kb: 0.114 },
  'smpte170m': { kr: 0.299, kb: 0.114 },
  'bt2020-ncl': { kr: 0.2627, kb: 0.0593 },
};

/** Matrizes RGB linear (primárias reais) → XYZ (D65), por VideoColorPrimaries. */
const PRIMARIES_TO_XYZ = {
  'bt709': [
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.0721750],
    [0.0193339, 0.1191920, 0.9503041],
  ],
  'smpte432': [ // DCI-P3 D65
    [0.4865709, 0.2656677, 0.1982173],
    [0.2289746, 0.6917385, 0.0792869],
    [0.0000000, 0.0451134, 1.0439444],
  ],
  'bt2020': [
    [0.6369580, 0.1446169, 0.1688810],
    [0.2627002, 0.6779981, 0.0593017],
    [0.0000000, 0.0280727, 1.0609851],
  ],
};

function bt709InverseOetf(v) {
  return v < 0.081 ? v / 4.5 : Math.pow((v + 0.099) / 1.099, 1 / 0.45);
}
function srgbInverseEotf(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function pqInverseEotf(v) {
  const m1 = 0.1593017578125, m2 = 78.84375, c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875;
  const vp = Math.pow(Math.max(v, 0), 1 / m2);
  const num = Math.max(vp - c1, 0);
  const den = c2 - c3 * vp;
  return den <= 0 ? 0 : Math.pow(num / den, 1 / m1);
}
function hlgInverseOetf(v) {
  const a = 0.17883277, b = 1 - 4 * a, c = 0.5 - a * Math.log(4 * a);
  return v <= 0.5 ? (v * v) / 3 : (Math.exp((v - c) / a) + b) / 12;
}
function inverseEotfFor(transfer) {
  if (transfer === 'pq') return pqInverseEotf;
  if (transfer === 'hlg') return hlgInverseOetf;
  if (transfer === 'iec61966-2-1' || transfer === 'linear') return transfer === 'linear' ? (v) => v : srgbInverseEotf;
  return bt709InverseOetf; // bt709 / smpte170m / bt470bg / desconhecido — curva mais próxima
}
function linearToSrgb8(v) {
  const c = Math.min(1, Math.max(0, v));
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, s)) * 255);
}

/**
 * Layout de planos suportado por `frame.format` (WebCodecs `VideoPixelFormat`).
 * Formatos "P10"/"P12" (comuns em HDR10 real — o decoder frequentemente NÃO
 * reduz a 8 bits) guardam cada amostra em 16 bits (little-endian), valor nos
 * bits baixos — por isso são tratados à parte, com `bitDepth` e leitura de
 * 2 bytes/amostra em vez de 1.
 */
const PLANAR_YUV_BASE = new Set(['I420', 'I420A', 'I422', 'I444']);
const NV_FORMATS = new Set(['NV12']);
const PACKED_RGB_FORMATS = { RGBA: 'rgb', RGBX: 'rgb', BGRA: 'bgr', BGRX: 'bgr' };

/** Detecta formato base (I420/I422/I444) + profundidade de bits (8/10/12) a partir do nome WebCodecs. */
function parsePlanarFormat(format) {
  const m = /^(I420A?|I422|I444)(P(10|12))?$/.exec(format);
  if (!m) return null;
  return { base: m[1].replace('A', ''), bitDepth: m[3] ? Number(m[3]) : 8 };
}

/**
 * Amostra ~`count` posições espalhadas pelo frame bruto e converte cada uma
 * para xy de cromaticidade usando a matriz/EOTF/primárias REAIS do frame.
 * Retorna { supported, points }. `supported=false` quando o formato do
 * frame não é um dos suportados (fallback explícito, sem tentar adivinhar).
 */
async function samplePixelsFromFrame(frame, cs, count) {
  const format = frame.format;
  if (!format) return { supported: false, points: [] };

  const planarInfo = PLANAR_YUV_BASE.has(format) ? { base: format, bitDepth: 8 } : parsePlanarFormat(format);
  const isPlanarYuv = !!planarInfo && PLANAR_YUV_BASE.has(planarInfo.base);
  const isNv = NV_FORMATS.has(format);
  const rgbOrder = PACKED_RGB_FORMATS[format];
  if (!isPlanarYuv && !isNv && !rgbOrder) return { supported: false, points: [] };
  const bitDepth = isPlanarYuv ? planarInfo.bitDepth : 8;
  const maxVal = Math.pow(2, bitDepth) - 1;
  const bytesPerSample = bitDepth > 8 ? 2 : 1;
  const readSample = bytesPerSample === 2
    ? (off) => buf[off] | (buf[off + 1] << 8)
    : (off) => buf[off];

  let layout;
  let buf;
  try {
    const size = frame.allocationSize();
    buf = new Uint8Array(size);
    layout = await frame.copyTo(buf);
  } catch (e) {
    return { supported: false, points: [] };
  }

  const vr = frame.visibleRect || { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
  const fullRange = !!cs.fullRange;
  const krb = YUV_KRB[cs.matrix] || YUV_KRB['bt709'];
  const primMatrix = PRIMARIES_TO_XYZ[cs.primaries] || PRIMARIES_TO_XYZ['bt709'];
  const toLinear = inverseEotfFor(cs.transfer);

  const points = [];
  const cols = Math.ceil(Math.sqrt(count * (vr.width / vr.height || 1)));
  const rows = Math.max(1, Math.round(count / cols));
  const stepX = Math.max(1, Math.floor(vr.width / cols));
  const stepY = Math.max(1, Math.floor(vr.height / rows));

  for (let py = 0; py < vr.height; py += stepY) {
    for (let px = 0; px < vr.width; px += stepX) {
      const cx = vr.x + px, cy = vr.y + py;
      let r8, g8, b8;

      if (rgbOrder) {
        const pl = layout[0];
        const off = pl.offset + cy * pl.stride + cx * 4;
        if (rgbOrder === 'rgb') { r8 = buf[off]; g8 = buf[off + 1]; b8 = buf[off + 2]; }
        else { b8 = buf[off]; g8 = buf[off + 1]; r8 = buf[off + 2]; }
      } else {
        const yPl = layout[0];
        const Y = readSample(yPl.offset + cy * yPl.stride + cx * bytesPerSample);
        let U, V;
        if (isNv) {
          const uvPl = layout[1];
          const ccx = px >> 1, ccy = py >> 1;
          const off = uvPl.offset + ccy * uvPl.stride + ccx * 2;
          U = buf[off]; V = buf[off + 1];
        } else {
          const uPl = layout[1], vPl = layout[2];
          const ccx = planarInfo.base === 'I444' ? px : px >> 1;
          const ccy = planarInfo.base === 'I422' || planarInfo.base === 'I444' ? py : py >> 1;
          U = readSample(uPl.offset + ccy * uPl.stride + ccx * bytesPerSample);
          V = readSample(vPl.offset + ccy * vPl.stride + ccx * bytesPerSample);
        }
        // normaliza para faixa (escalando black/white/meio de acordo com a
        // profundidade de bits real) e converte YUV -> RGB (ainda no domínio
        // gamma do transfer do frame)
        const rangeScale = (maxVal + 1) / 256;
        const mid = 128 * rangeScale;
        let yN, uN, vN;
        if (fullRange) { yN = Y / maxVal; uN = (U - mid) / maxVal; vN = (V - mid) / maxVal; }
        else {
          yN = (Y - 16 * rangeScale) / (219 * rangeScale);
          uN = (U - mid) / (224 * rangeScale);
          vN = (V - mid) / (224 * rangeScale);
        }
        const kg = 1 - krb.kr - krb.kb;
        const rN = yN + 2 * (1 - krb.kr) * vN;
        const bN = yN + 2 * (1 - krb.kb) * uN;
        const gN = (yN - krb.kr * rN - krb.kb * bN) / kg;
        r8 = Math.round(Math.min(1, Math.max(0, rN)) * 255);
        g8 = Math.round(Math.min(1, Math.max(0, gN)) * 255);
        b8 = Math.round(Math.min(1, Math.max(0, bN)) * 255);
      }

      // linearizar com a EOTF inversa real (sRGB/bt709/PQ/HLG) e projetar nas
      // primárias reais → XYZ (escala absoluta não importa: xy é invariante)
      const R = toLinear(r8 / 255), G = toLinear(g8 / 255), B = toLinear(b8 / 255);
      const [mx, my, mz] = primMatrix;
      const X = mx[0] * R + mx[1] * G + mx[2] * B;
      const Yl = my[0] * R + my[1] * G + my[2] * B;
      const Z = mz[0] * R + mz[1] * G + mz[2] * B;
      const sum = X + Yl + Z;
      if (sum < 1e-6) continue;
      points.push({
        x: X / sum, y: Yl / sum,
        r: linearToSrgb8(R), g: linearToSrgb8(G), b: linearToSrgb8(B),
      });
      if (points.length >= count) break;
    }
    if (points.length >= count) break;
  }
  return { supported: true, points };
}

class ColorSpaceProbe {
  constructor(video) {
    this.ok = false;
    this.error = null;
    this._reading = false;
    if (typeof MediaStreamTrackProcessor === 'undefined') {
      this.error = 'MediaStreamTrackProcessor não suportado neste navegador (hoje só Chromium/Edge).';
      return;
    }
    try {
      const stream = video.captureStream ? video.captureStream() : video.mozCaptureStream();
      const track = stream.getVideoTracks()[0];
      if (!track) { this.error = 'Sem track de vídeo para capturar.'; return; }
      this.processor = new MediaStreamTrackProcessor({ track });
      this.reader = this.processor.readable.getReader();
      this.ok = true;
    } catch (e) {
      this.error = e.message;
    }
  }

  /**
   * Lê UM frame e devolve seu colorSpace (fecha o frame imediatamente —
   * obrigatório p/ não vazar). Com `opts.withPixels`, também extrai uma
   * amostra de pixels reais (ver `samplePixelsFromFrame`) — usa o mesmo
   * frame, sem abrir um segundo consumidor do reader.
   */
  async sample(opts) {
    if (!this.ok || this._reading) return null;
    this._reading = true;
    try {
      const { value: frame, done } = await this.reader.read();
      if (done || !frame) return null;
      const cs = frame.colorSpace || {};
      const result = {
        primaries: cs.primaries ? (PRIMARIES_NAMES[cs.primaries] || cs.primaries) : '—',
        transfer: cs.transfer ? (TRANSFER_NAMES[cs.transfer] || cs.transfer) : '—',
        matrix: cs.matrix ? (MATRIX_NAMES[cs.matrix] || cs.matrix) : '—',
        fullRange: cs.fullRange,
        hdr: cs.transfer === 'pq' || cs.transfer === 'hlg',
        codedWidth: frame.codedWidth, codedHeight: frame.codedHeight,
      };
      if (opts && opts.withPixels) {
        try {
          const { supported, points } = await samplePixelsFromFrame(frame, cs, opts.count || 400);
          result.pixelsSupported = supported;
          result.chromaPoints = points;
        } catch (e) {
          result.pixelsSupported = false;
          result.chromaPoints = [];
        }
      }
      frame.close(); // crítico: VideoFrame não fechado vaza memória de decodificador
      return result;
    } catch (e) {
      this.error = e.message;
      return null;
    } finally {
      this._reading = false;
    }
  }

  destroy() {
    if (this.reader) { try { this.reader.cancel(); } catch { /* já encerrado */ } }
  }
}

window.ColorSpaceProbe = ColorSpaceProbe;
