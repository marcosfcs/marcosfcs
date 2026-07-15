/**
 * Análise de qualidade com referência — PSNR e SSIM reais (NÃO é VMAF).
 *
 * PSNR/SSIM exigem uma referência (o conteúdo-fonte antes da codificação)
 * alinhada frame a frame com a variante do stream sendo inspecionado. Só
 * fazem sentido quando a referência é o MESMO conteúdo usado para codificar
 * o stream — comparar Big Buck Bunny contra um telejornal ao vivo produz
 * números sem significado (diferença de conteúdo, não de qualidade).
 *
 * VMAF de verdade (modelo treinado da Netflix: VIF+DLM+motion via SVM) não
 * está implementado — exigiria libvmaf via ffmpeg, um processo offline,
 * não tempo real no navegador. Ver README para gerar o comando ffmpeg.
 *
 * Presets: filmes da Blender Foundation (CC-BY), H.264, tocáveis direto no
 * <video> sem conversão. Não existe hoje um acervo livre equivalente para
 * esporte/telejornalismo em qualidade moderna pronto para navegador — as
 * sequências de teste da Xiph.org (Crowd Run, Park Joy etc.), o substituto
 * mais próximo, são distribuídas em Y4M cru e precisariam de conversão
 * prévia (ffmpeg) para tocar aqui. Para esses casos, use "Arquivo local".
 *
 * URLs não verificadas a partir deste ambiente (rede do sandbox bloqueia
 * download.blender.org) — confirme/ajuste na sua máquina se o link mudou.
 */
'use strict';

const REFERENCE_PRESETS = [
  { id: 'bbb-1080', label: 'Big Buck Bunny — 1080p H.264 (24fps)', category: 'Entretenimento (animação)',
    resolution: '1920x1080', fps: 24,
    url: 'https://download.blender.org/peach/bigbuckbunny_movies/big_buck_bunny_1080p_h264.mov' },
  { id: 'bbb-480', label: 'Big Buck Bunny — 480p H.264 (24fps)', category: 'Entretenimento (animação)',
    resolution: '854x480', fps: 24,
    url: 'https://download.blender.org/peach/bigbuckbunny_movies/big_buck_bunny_480p_h264.mp4' },
  { id: 'sintel-1080', label: 'Sintel — 1080p surround (24fps)', category: 'Entretenimento (animação, ação)',
    resolution: '1920x1080', fps: 24,
    url: 'https://download.blender.org/durian/movies/sintel-1024-surround.mp4' },
  { id: 'tos-1080', label: 'Tears of Steel — 1080p (24fps)', category: 'Entretenimento (live-action, sci-fi)',
    resolution: '1920x1080', fps: 24,
    url: 'https://download.blender.org/mango/movies/tears_of_steel_1080p.mov' },
];

/* ================================================================ *
 * Métricas
 * ================================================================ */

function frameToLuma(ctx, w, h) {
  const { data } = ctx.getImageData(0, 0, w, h);
  const luma = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    luma[p] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  return luma;
}

function computePsnr(a, b) {
  let mse = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; mse += d * d; }
  mse /= a.length;
  if (mse <= 1e-6) return 99; // praticamente idêntico
  return Math.min(99, 10 * Math.log10((255 * 255) / mse));
}

/** SSIM em blocos 8x8 sobre a luminância — aproximação padrão da literatura. */
function computeSsim(a, b, w, h) {
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  const block = 8;
  let sum = 0, count = 0;
  for (let by = 0; by + block <= h; by += block) {
    for (let bx = 0; bx + block <= w; bx += block) {
      let sumA = 0, sumB = 0, sumA2 = 0, sumB2 = 0, sumAB = 0;
      const n = block * block;
      for (let y = 0; y < block; y++) {
        for (let x = 0; x < block; x++) {
          const idx = (by + y) * w + (bx + x);
          const va = a[idx], vb = b[idx];
          sumA += va; sumB += vb; sumA2 += va * va; sumB2 += vb * vb; sumAB += va * vb;
        }
      }
      const meanA = sumA / n, meanB = sumB / n;
      const varA = sumA2 / n - meanA * meanA, varB = sumB2 / n - meanB * meanB;
      const covAB = sumAB / n - meanA * meanB;
      const ssim = ((2 * meanA * meanB + C1) * (2 * covAB + C2)) /
        ((meanA * meanA + meanB * meanB + C1) * (varA + varB + C2));
      sum += ssim; count++;
    }
  }
  return count ? sum / count : 1;
}

/* ================================================================ *
 * Motor de comparação — amostra os dois <video> e sincroniza
 * ================================================================ */

class QualityCompare {
  constructor(refVideo, distVideo, opts) {
    this.ref = refVideo;
    this.dist = distVideo;
    this.w = (opts && opts.width) || 320;
    this.h = (opts && opts.height) || 180;
    this.refCanvas = document.createElement('canvas');
    this.distCanvas = document.createElement('canvas');
    this.refCanvas.width = this.distCanvas.width = this.w;
    this.refCanvas.height = this.distCanvas.height = this.h;
    this.refCtx = this.refCanvas.getContext('2d', { willReadFrequently: true });
    this.distCtx = this.distCanvas.getContext('2d', { willReadFrequently: true });
  }

  /** Ressincroniza o mais atrasado se o desvio passar do limiar (streams com buffers diferentes driftam). */
  maybeResync(thresholdSec) {
    const th = thresholdSec || 0.3;
    if (this.ref.readyState < 1 || this.dist.readyState < 1) return;
    const drift = this.dist.currentTime - this.ref.currentTime;
    if (Math.abs(drift) > th) {
      if (drift > 0) this.ref.currentTime = this.dist.currentTime;
      else this.dist.currentTime = this.ref.currentTime;
    }
  }

  /** Amostra um par de frames. Retorna null se algum vídeo não está pronto; {blocked:true} se CORS/DRM impedir leitura. */
  sample() {
    if (this.ref.readyState < 2 || this.dist.readyState < 2) return null;
    try {
      this.refCtx.drawImage(this.ref, 0, 0, this.w, this.h);
      this.distCtx.drawImage(this.dist, 0, 0, this.w, this.h);
      var a = frameToLuma(this.refCtx, this.w, this.h);
      var b = frameToLuma(this.distCtx, this.w, this.h);
    } catch (e) {
      return { blocked: true, error: e.name };
    }
    return { blocked: false, psnr: computePsnr(a, b), ssim: computeSsim(a, b, this.w, this.h) };
  }
}

window.StreamQuality = { REFERENCE_PRESETS, QualityCompare };
