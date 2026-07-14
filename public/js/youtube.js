/**
 * Suporte a URLs do YouTube via resolvedor local yt-dlp (endpoint
 * /resolve do server.js). O sistema NÃO decodifica assinaturas do
 * YouTube — apenas consome o JSON que o yt-dlp (instalado pelo usuário)
 * produz e o converte para o mesmo modelo usado pelos parsers de
 * manifest, reaproveitando os renderizadores de tabela existentes.
 *
 *   - Ao vivo: retorna a URL do master HLS → pipeline normal (paridade).
 *   - VOD: monta as tabelas a partir dos formatos do yt-dlp e reproduz
 *     o melhor formato combinado (progressivo) para telemetria/cor.
 */
'use strict';

const YTP = window.StreamParsers;

function isYouTubeUrl(url) {
  try {
    const h = new URL(url).hostname;
    return /^(?:www\.|m\.)?(?:youtube\.com|youtube-nocookie\.com|youtu\.be)$/i.test(h);
  } catch {
    return false;
  }
}

function dynamicRangeLabel(dr) {
  if (!dr || /sdr/i.test(dr)) return { text: 'SDR', hdr: false };
  if (/hlg/i.test(dr)) return { text: 'HLG', hdr: true };
  if (/hdr10\+?/i.test(dr)) return { text: dr.toUpperCase(), hdr: true };
  if (/hdr/i.test(dr)) return { text: 'HDR', hdr: true };
  if (/dv|dolby/i.test(dr)) return { text: 'Dolby Vision', hdr: true };
  return { text: dr, hdr: true };
}

/** JSON do yt-dlp → modelo compatível com renderKV/renderTable do app. */
function buildModelFromYtInfo(info) {
  const fmts = info.formats || [];
  const video = [];
  const audio = [];

  for (const f of fmts) {
    const hasV = f.vcodec && f.vcodec !== 'none';
    const hasA = f.acodec && f.acodec !== 'none';
    if (hasV) {
      const range = dynamicRangeLabel(f.dynamic_range);
      const vcodecs = [f.vcodec];
      if (hasA && f.acodec) vcodecs.push(f.acodec); // progressivo: mostra os dois
      video.push({
        id: f.format_id + (hasA ? ' (progressivo)' : ''),
        bandwidth: f.tbr ? Math.round(f.tbr * 1000) : (f.vbr ? Math.round(f.vbr * 1000) : null),
        avgBandwidth: f.vbr ? Math.round(f.vbr * 1000) : null,
        resolution: f.width && f.height ? `${f.width}x${f.height}` : '—',
        frameRate: f.fps || null,
        codecs: vcodecs,
        videoRange: range.text,
        hdr: range.hdr,
        hdcp: null,
        audioGroup: hasA ? 'muxado' : null,
        subtitleGroup: null,
        primaries: null,
        scanType: null,
        period: f.ext || null,
        uri: f.url || (f.manifest_url || null),
      });
    } else if (hasA) {
      audio.push({
        name: f.format_id,
        lang: f.language || '—',
        groupId: f.ext || '—',
        channels: f.audio_channels != null ? String(f.audio_channels) : null,
        samplingRate: f.asr || null,
        codecs: f.acodec,
        bandwidth: f.abr ? Math.round(f.abr * 1000) : (f.tbr ? Math.round(f.tbr * 1000) : null),
        default: false,
        roles: f.format_note || '—',
      });
    }
  }

  // ordena vídeo por bitrate desc (como um master ABR)
  video.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));

  const subtitles = [];
  for (const lang of info.subtitles || []) {
    subtitles.push({ name: lang, lang, kind: 'legenda', forced: false, default: false, codecs: 'YouTube (via yt-dlp)' });
  }
  for (const lang of info.automatic_captions || []) {
    subtitles.push({ name: lang, lang, kind: 'closed captions (auto)', forced: false, default: false, codecs: 'legenda automática' });
  }

  const live = !!info.is_live;
  const anyHdr = video.some((v) => v.hdr);
  const model = {
    protocol: 'YouTube', kind: live ? 'master' : 'progressive',
    video, audio, subtitles, closedCaptions: [], drm: [],
    overview: {
      'Origem': 'YouTube (resolvido via yt-dlp local)',
      'Título': info.title || '—',
      'Canal': info.uploader || '—',
      'Transmissão': live ? 'AO VIVO' : (info.was_live ? 'VOD (era ao vivo)' : 'VOD'),
      'Status': info.live_status || '—',
      'Duração': info.duration ? YTP.fmtDur(info.duration) : (live ? 'contínua (live)' : '—'),
      'Formatos de vídeo': String(video.length),
      'Faixas de áudio': String(audio.length),
      'Legendas (manuais / auto)': `${(info.subtitles || []).length} / ${(info.automatic_captions || []).length}`,
      'HDR disponível': anyHdr ? 'Sim' : 'Não — SDR',
      'DRM': 'Não aplicável (mídia do YouTube)',
    },
  };
  return model;
}

/**
 * Decide a fonte de reprodução:
 *   ao vivo → HLS master (pipeline normal, com segmentação/container reais)
 *   VOD     → melhor formato combinado progressivo (arquivo único tocável)
 */
function pickPlaybackSource(info) {
  const fmts = info.formats || [];

  if (info.is_live) {
    // formato HLS com manifest_url (protocol m3u8*)
    const hls = fmts.find((f) => /m3u8/i.test(f.protocol || '') && (f.manifest_url || f.url));
    if (hls) return { kind: 'hls', url: hls.manifest_url || hls.url };
  }

  // progressivo: vcodec e acodec presentes, maior resolução
  const progressive = fmts
    .filter((f) => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && f.url)
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0))[0];
  if (progressive) return { kind: 'progressive', url: progressive.url, height: progressive.height };

  // fallback: HLS mesmo em VOD, se existir
  const hls = fmts.find((f) => /m3u8/i.test(f.protocol || '') && (f.manifest_url || f.url));
  if (hls) return { kind: 'hls', url: hls.manifest_url || hls.url };

  return null;
}

window.StreamYouTube = { isYouTubeUrl, buildModelFromYtInfo, pickPlaybackSource };
