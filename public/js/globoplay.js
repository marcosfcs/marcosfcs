/**
 * Suporte a URLs do Globoplay via resolvedor local yt-dlp (mesmo endpoint
 * /resolve do server.js já usado para YouTube). O sistema NÃO decodifica
 * DRM/tokens do Globoplay — apenas consome o JSON que o yt-dlp (instalado
 * pelo usuário) produz, procura a URL do manifest HLS/DASH ali dentro e
 * entrega para o pipeline normal de inspeção (paridade total: segmentação,
 * container, telemetria reais).
 *
 * Ao contrário do YouTube, aqui não existe um modelo "progressivo" próprio:
 * conteúdo de emissora costuma sempre expor um manifest de verdade (ao vivo
 * ou VOD), então o caminho é sempre "ache o manifest → chame inspect() com
 * ele". Se o conteúdo exigir login/assinatura ou estiver protegido por DRM,
 * o yt-dlp normalmente já falha ao resolver ou não retorna manifest_url —
 * nesse caso a UI mostra isso claramente, sem tentar contornar.
 */
'use strict';

function isGloboplayUrl(url) {
  try {
    const h = new URL(url).hostname;
    return /^(?:www\.)?globoplay\.globo\.com$/i.test(h);
  } catch {
    return false;
  }
}

/** Acha a melhor URL de manifest (HLS > DASH > progressivo) nos formatos do yt-dlp. */
function pickManifestUrl(info) {
  const fmts = info.formats || [];
  const hls = fmts.find((f) => f.manifest_url && /m3u8/i.test(f.protocol || ''));
  if (hls) return hls.manifest_url;
  const dash = fmts.find((f) => f.manifest_url && /dash/i.test(f.protocol || ''));
  if (dash) return dash.manifest_url;
  const anyManifest = fmts.find((f) => f.manifest_url);
  if (anyManifest) return anyManifest.manifest_url;
  const best = fmts.filter((f) => f.url).sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0];
  return best ? best.url : null;
}

window.StreamGloboplay = { isGloboplayUrl, pickManifestUrl };
