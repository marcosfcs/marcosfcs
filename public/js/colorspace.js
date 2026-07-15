/**
 * Espaço de cor REALMENTE decodificado, via WebCodecs (MediaStreamTrackProcessor).
 *
 * Diferente dos histogramas de analyzer.js (que leem um canvas 2D 8-bit já
 * tone-mapped pelo navegador), aqui lemos o VideoFrame como o decodificador
 * de fato produziu — primaries/transfer/matrix/fullRange corretos, sem
 * intermediário de canvas. É a confirmação mais forte de HDR real vs. o
 * que o manifest apenas declara.
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
};
const MATRIX_NAMES = { 'rgb': 'RGB', 'bt709': 'BT.709', 'bt470bg': 'BT.601', 'smpte170m': 'BT.601', 'bt2020-ncl': 'BT.2020 NCL' };

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

  /** Lê UM frame e devolve seu colorSpace (fecha o frame imediatamente — obrigatório p/ não vazar). */
  async sample() {
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
