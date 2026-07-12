/**
 * Medição de áudio em tempo real via Web Audio API.
 *
 * Grafo: MediaElementAudioSourceNode → ChannelSplitter → 2× AnalyserNode
 * (L/R) → Gain(0) → destination. O ganho zero mantém o monitoramento
 * silencioso sem usar video.muted — importante porque muted silencia a
 * ENTRADA do source node e os medidores leriam só zeros.
 *
 * Métricas por leitura (sample()):
 *   - RMS e pico por canal, em dBFS (nível RMS ≈ aproximação "momentary";
 *     não é LUFS/K-weighting)
 *   - espectro de frequências (bins normalizados 0..1)
 *
 * Limitações detectadas e reportadas:
 *   - origem sem CORS → o navegador entrega silêncio permanente (tainted);
 *     detectado por "vídeo tocando com sinal zerado por vários segundos"
 *   - AudioContext suspenso por política de autoplay → retomado no
 *     primeiro gesto do usuário
 */
'use strict';

class AudioMeter {
  constructor(video) {
    this.video = video;
    this.ok = false;
    this.error = null;
    this._zeroStreak = 0;
    this.taintedSuspect = false;

    try {
      // um MediaElementSourceNode por elemento — reusa entre sessões
      if (!video._audioMeterCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        video._audioMeterCtx = new Ctx();
        video._audioMeterSource = video._audioMeterCtx.createMediaElementSource(video);
      }
      this.ctx = video._audioMeterCtx;
      this.source = video._audioMeterSource;

      this.splitter = this.ctx.createChannelSplitter(2);
      this.analyserL = this.ctx.createAnalyser();
      this.analyserR = this.ctx.createAnalyser();
      this.analyserL.fftSize = 2048;
      this.analyserR.fftSize = 2048;
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0;

      this.source.connect(this.splitter);
      this.splitter.connect(this.analyserL, 0);
      this.splitter.connect(this.analyserR, 1);
      this.source.connect(this.gain);
      this.gain.connect(this.ctx.destination);

      this._timeL = new Float32Array(this.analyserL.fftSize);
      this._timeR = new Float32Array(this.analyserR.fftSize);
      this._freq = new Uint8Array(this.analyserL.frequencyBinCount);

      // silêncio garantido pelo gain=0; libera o elemento para alimentar o grafo
      video.muted = false;
      video.volume = 1;

      this._resume = () => { if (this.ctx.state === 'suspended') this.ctx.resume(); };
      document.addEventListener('click', this._resume);
      this._resume();
      this.ok = true;
    } catch (e) {
      this.error = e.message;
      video.muted = true; // fallback: comportamento antigo
    }
  }

  destroy() {
    if (!this.ok) return;
    document.removeEventListener('click', this._resume);
    try {
      this.source.disconnect(this.splitter);
      this.source.disconnect(this.gain);
      this.splitter.disconnect();
      this.gain.disconnect();
    } catch { /* grafo já desmontado */ }
    // ctx e source ficam no elemento para reuso (createMediaElementSource é único por elemento)
    this.video.muted = true;
  }

  /** Retorna null se indisponível. dBFS limitado a -60 no piso. */
  sample() {
    if (!this.ok) return null;
    this.analyserL.getFloatTimeDomainData(this._timeL);
    this.analyserR.getFloatTimeDomainData(this._timeR);
    const L = channelStats(this._timeL);
    const R = channelStats(this._timeR);
    this.analyserL.getByteFrequencyData(this._freq);

    // Suspeita de "tainted media" (CORS): sinal exatamente zero desde o
    // início, sem NUNCA ter havido amostra não-nula. Se já houve sinal,
    // zeros posteriores são silêncio legítimo (alarme de silêncio cuida).
    const playing = !this.video.paused && this.video.readyState >= 3;
    if (L.peak > 0 || R.peak > 0) this._everHadSignal = true;
    if (playing && !this._everHadSignal) this._zeroStreak++;
    this.taintedSuspect = !this._everHadSignal && this._zeroStreak > 30; // ~4,5s sem nunca haver sinal

    // espectro reduzido a ~96 bins (média de grupos), normalizado 0..1
    const bins = 96;
    const group = Math.floor(this._freq.length / bins);
    const spectrum = new Float32Array(bins);
    for (let i = 0; i < bins; i++) {
      let s = 0;
      for (let j = 0; j < group; j++) s += this._freq[i * group + j];
      spectrum[i] = s / group / 255;
    }
    const nyquist = this.ctx.sampleRate / 2;

    return {
      dbfsL: toDbfs(L.rms), dbfsR: toDbfs(R.rms),
      peakL: toDbfs(L.peak), peakR: toDbfs(R.peak),
      spectrum, binHz: nyquist / this._freq.length * group,
      contextState: this.ctx.state,
      taintedSuspect: this.taintedSuspect,
    };
  }
}

function channelStats(buf) {
  let sum = 0, peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  return { rms: Math.sqrt(sum / buf.length), peak };
}

function toDbfs(v) {
  if (v <= 0) return -60;
  return Math.max(-60, 20 * Math.log10(v));
}

window.AudioMeter = AudioMeter;
