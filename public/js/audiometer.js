/**
 * Medição de áudio em tempo real via Web Audio API.
 *
 * Grafo: MediaElementAudioSourceNode → ChannelSplitter → 2× AnalyserNode
 * (L/R) → Gain(1) → destination. createMediaElementSource() desvia
 * PERMANENTEMENTE a saída de áudio do <video> para o grafo do Web Audio —
 * a partir daí, o elemento só é ouvido através do que estiver conectado a
 * destination. Por isso o ganho precisa ser 1 (não 0): é o único caminho
 * que leva o áudio real de volta aos alto-falantes, e não afeta o ramo de
 * medição (splitter → analysers), que é independente. video.muted não é
 * usado para controlar isso porque muted silencia a ENTRADA do source
 * node e os medidores leriam só zeros.
 *
 * Métricas por leitura (sample()):
 *   - RMS e pico por canal, em dBFS (VU meter — resposta rápida, não é LUFS)
 *   - espectro de frequências (bins normalizados 0..1)
 *   - LUFS real (ITU-R BS.1770-4): caminho paralelo com filtro K-weighting
 *     exato (dois estágios IIR pelas coeficientes publicadas da norma,
 *     via IIRFilterNode) → Momentary/Short-term/Integrated com gating
 *     absoluto (-70 LUFS) e relativo (-10 LU). Aproximações assumidas:
 *     coeficientes calculados para 48kHz (não recalculados por sample
 *     rate) e hop de bloco ~150ms (a norma usa 100ms) — suficiente para
 *     monitoração, mas não certificação.
 *   - True Peak por canal (dBTP), aproximado por sobreamostragem 4x
 *     (interpolação linear simples sobre o buffer de tempo) em vez do
 *     filtro FIR polyphase exato do Anexo 2 da BS.1770 — suficiente para
 *     detectar estouro de intersample peak na prática, não para
 *     certificação formal.
 *
 * Limitações detectadas e reportadas:
 *   - origem sem CORS → o navegador entrega silêncio permanente (tainted);
 *     detectado por "vídeo tocando com sinal zerado por vários segundos"
 *   - AudioContext suspenso por política de autoplay → retomado no
 *     primeiro gesto do usuário
 *   - IIRFilterNode indisponível → LUFS fica desligado, VU/espectro seguem
 */
'use strict';

// Coeficientes K-weighting BS.1770-4 (48kHz) — feedforward (b) / feedback (a)
const KWEIGHT_STAGE1 = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [1.0, -1.69065929318241, 0.73248077421585] };
const KWEIGHT_STAGE2 = { b: [1.0, -2.0, 1.0], a: [1.0, -1.99004745483398, 0.99007225036621] };
const LUFS_ABS_GATE_POWER = Math.pow(10, (-70 + 0.691) / 10);

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
      this.gain.gain.value = 1;

      this.source.connect(this.splitter);
      this.splitter.connect(this.analyserL, 0);
      this.splitter.connect(this.analyserR, 1);
      this.source.connect(this.gain);
      this.gain.connect(this.ctx.destination);

      this._timeL = new Float32Array(this.analyserL.fftSize);
      this._timeR = new Float32Array(this.analyserR.fftSize);
      this._freq = new Uint8Array(this.analyserL.frequencyBinCount);

      // gain=1 leva o áudio real ao destino; libera o elemento para alimentar o grafo
      video.muted = false;
      video.volume = 1;

      this._resume = () => { if (this.ctx.state === 'suspended') this.ctx.resume(); };
      document.addEventListener('click', this._resume);
      this._resume();

      this.lufsOk = false;
      this._blockPowers = [];
      if (this.ctx.createIIRFilter) {
        try {
          this._setupLufsPath();
          this.lufsOk = true;
        } catch (e) {
          this.lufsError = e.message;
        }
      } else {
        this.lufsError = 'IIRFilterNode não suportado neste navegador';
      }

      this.ok = true;
    } catch (e) {
      this.error = e.message;
      video.muted = true; // fallback: comportamento antigo
    }
  }

  /** Monta o caminho K-weighted paralelo (não afeta o VU/espectro raw). */
  _setupLufsPath() {
    const mkChain = () => {
      const s1 = this.ctx.createIIRFilter(KWEIGHT_STAGE1.b, KWEIGHT_STAGE1.a);
      const s2 = this.ctx.createIIRFilter(KWEIGHT_STAGE2.b, KWEIGHT_STAGE2.a);
      s1.connect(s2);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 16384; // ~341ms @48kHz — aproxima o bloco momentary de 400ms
      s2.connect(analyser);
      return { input: s1, s1, s2, analyser };
    };
    this._lufsL = mkChain();
    this._lufsR = mkChain();
    this.splitter.connect(this._lufsL.input, 0);
    this.splitter.connect(this._lufsR.input, 1);
    this._lufsBufL = new Float32Array(this._lufsL.analyser.fftSize);
    this._lufsBufR = new Float32Array(this._lufsR.analyser.fftSize);
  }

  destroy() {
    if (!this.ok) return;
    document.removeEventListener('click', this._resume);
    try {
      this.source.disconnect(this.splitter);
      this.source.disconnect(this.gain);
      this.splitter.disconnect();
      this.gain.disconnect();
      if (this.lufsOk) {
        for (const chain of [this._lufsL, this._lufsR]) {
          chain.s1.disconnect(); chain.s2.disconnect(); chain.analyser.disconnect();
        }
      }
    } catch { /* grafo já desmontado */ }
    // ctx e source ficam no elemento para reuso (createMediaElementSource é único por elemento)
    this.video.muted = true;
  }

  /** Média de potência (domínio linear) dos blocos passando pelos dois gates da BS.1770-4. */
  _computeIntegrated() {
    if (!this._blockPowers.length) return null;
    const above = this._blockPowers.filter((b) => b.power > LUFS_ABS_GATE_POWER);
    if (!above.length) return null;
    const ungatedMean = above.reduce((s, b) => s + b.power, 0) / above.length;
    const relGatePower = ungatedMean / 10; // -10 LU em domínio de potência (10*log10(1/10) = -10)
    const gated = above.filter((b) => b.power > relGatePower);
    const finalMean = gated.length
      ? gated.reduce((s, b) => s + b.power, 0) / gated.length
      : ungatedMean;
    return powerToLufs(finalMean);
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

    let lufs = null;
    if (this.lufsOk) {
      this._lufsL.analyser.getFloatTimeDomainData(this._lufsBufL);
      this._lufsR.analyser.getFloatTimeDomainData(this._lufsBufR);
      const blockPower = meanSquare(this._lufsBufL) + meanSquare(this._lufsBufR); // pesos de canal L/R = 1.0
      const now = performance.now();
      this._blockPowers.push({ t: now, power: blockPower });
      if (this._blockPowers.length > 6000) this._blockPowers.shift(); // ~15min a 150ms/bloco

      const stCutoff = now - 3000;
      let stSum = 0, stCount = 0;
      for (let i = this._blockPowers.length - 1; i >= 0; i--) {
        if (this._blockPowers[i].t < stCutoff) break;
        stSum += this._blockPowers[i].power; stCount++;
      }

      lufs = {
        momentary: powerToLufs(blockPower),
        shortTerm: stCount ? powerToLufs(stSum / stCount) : null,
        integrated: this._computeIntegrated(),
      };
    }

    return {
      dbfsL: toDbfs(L.rms), dbfsR: toDbfs(R.rms),
      peakL: toDbfs(L.peak), peakR: toDbfs(R.peak),
      truePeakL: toDbfs(truePeakAbs(this._timeL)), truePeakR: toDbfs(truePeakAbs(this._timeR)),
      spectrum, binHz: nyquist / this._freq.length * group,
      contextState: this.ctx.state,
      taintedSuspect: this.taintedSuspect,
      lufs,
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

/** Pico verdadeiro (dBTP) aproximado: sobreamostragem 4x por interpolação
 * linear entre amostras consecutivas, para pegar picos de intersample que o
 * pico de amostra (channelStats().peak) não vê. Não é o FIR polyphase exato
 * do Anexo 2 da BS.1770, mas é suficiente para detectar estouro na prática. */
function truePeakAbs(buf) {
  let peak = 0;
  for (let i = 0; i < buf.length - 1; i++) {
    const a = buf[i], b = buf[i + 1];
    for (let k = 0; k < 4; k++) {
      const v = Math.abs(a + (b - a) * (k / 4));
      if (v > peak) peak = v;
    }
  }
  const last = Math.abs(buf[buf.length - 1]);
  if (last > peak) peak = last;
  return peak;
}

function toDbfs(v) {
  if (v <= 0) return -60;
  return Math.max(-60, 20 * Math.log10(v));
}

function meanSquare(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return s / buf.length;
}

function powerToLufs(power) {
  if (power <= 0) return -70;
  return Math.max(-70, -0.691 + 10 * Math.log10(power));
}

window.AudioMeter = AudioMeter;
