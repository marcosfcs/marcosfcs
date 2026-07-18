/**
 * Suporte a URLs do Globoplay via resolvedor local com Playwright (endpoint
 * /resolve-globoplay do server.js). Diferente do YouTube (yt-dlp), a URL do
 * manifest do Globoplay não está no HTML nem o yt-dlp sabe extraí-la — só
 * aparece numa requisição de rede depois que o player da página carrega e
 * roda seu próprio JS. Por isso o server.js abre um Chromium headless de
 * verdade (com uma sessão logada salva via scripts/globoplay-login.js) e
 * escuta a rede até achar a URL do manifest, entregando-a para o pipeline
 * normal de inspeção (paridade total: segmentação, container, telemetria
 * reais). O sistema não decodifica DRM/tokens — se a sessão expirar ou o
 * conteúdo não expuser o manifest, isso falha com um erro claro, sem tentar
 * contornar (ver inspectGloboplay() em app.js).
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

window.StreamGloboplay = { isGloboplayUrl };
