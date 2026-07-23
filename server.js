#!/usr/bin/env node
/**
 * Stream Inspector — servidor estático + proxy de CORS.
 *
 * Sem dependências externas (apenas módulos nativos do Node).
 *
 *   node server.js            → http://localhost:8787
 *   PORT=3000 node server.js  → porta customizada
 *
 * Rotas:
 *   /                         → frontend (diretório public/)
 *   /p/<scheme>/<host>/<path> → proxy para <scheme>://<host>/<path>
 *
 * O formato de rota /p/... (em vez de /proxy?url=...) é intencional:
 * URLs RELATIVAS dentro de manifests HLS/DASH resolvem naturalmente
 * contra a URL do proxy, então segmentos, playlists de mídia e chaves
 * continuam passando pelo proxy sem reescrita. Apenas URLs ABSOLUTAS
 * dentro de manifests precisam ser reescritas (feito abaixo).
 *
 * Respeita HTTP_PROXY/HTTPS_PROXY (túnel CONNECT) quando presentes no
 * ambiente, para funcionar também atrás de proxies corporativos.
 */
'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const os = require('os');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT) || 8787;
// Escuta só em loopback por padrão: o proxy /p/ e os endpoints de resolução
// são poderosos (ver isBlockedTarget e os guards same-origin abaixo) e não
// devem ficar expostos à rede sem intenção explícita. Override consciente:
// HOST=0.0.0.0 node server.js (só em rede confiável).
const HOST = process.env.HOST || '127.0.0.1';
// Permite proxiar alvos internos/privados de propósito (streams de LAN).
// Desligado por padrão para não virar um SSRF drive-by.
const ALLOW_PRIVATE_PROXY = process.env.ALLOW_PRIVATE_PROXY === '1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_REDIRECTS = 5;
const MANIFEST_MAX_BYTES = 20 * 1024 * 1024; // manifests são pequenos; limite de segurança

// Teste de rede: limite de banda aplicado aos SEGMENTOS servidos pelo proxy
// (manifests ficam de fora para não gerar falso positivo de playlist
// estagnada). 0 = sem limite. Controlado pela UI via GET /throttle?kbps=N.
let throttleKbps = 0;

/**
 * Histórico persistente de inspeções — SQLite via `node:sqlite` (módulo
 * nativo do Node 22+, sem dependência externa nova). Guardado FORA da pasta
 * do repositório (por padrão em ~/.stream-inspector/, override via
 * STREAM_INSPECTOR_DATA_DIR) — de propósito: se ficasse dentro do clone
 * (ex.: <repo>/data/), um `git clone`/checkout novo sempre começaria com a
 * pasta vazia, apagando o histórico e a sessão salva do Globoplay a cada
 * clone. Também nunca é servido como arquivo estático (fora de public/) e
 * fica fora do git de qualquer forma. Se node:sqlite não estiver disponível
 * nesta versão do Node, o histórico é desabilitado de forma explícita
 * (mesmo padrão de honestidade usado para yt-dlp/WebCodecs ausentes).
 */
const DATA_DIR = process.env.STREAM_INSPECTOR_DATA_DIR || path.join(os.homedir(), '.stream-inspector');
let historyDb = null;
let historyError = null;
try {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  historyDb = new DatabaseSync(path.join(DATA_DIR, 'history.sqlite'));
  historyDb.exec(`
    CREATE TABLE IF NOT EXISTS inspections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      url TEXT NOT NULL,
      protocol TEXT,
      live INTEGER,
      video_variants INTEGER,
      audio_tracks INTEGER,
      hdr TEXT,
      drm TEXT,
      summary_json TEXT NOT NULL
    )
  `);
} catch (e) {
  historyError = e.message;
  console.warn('Histórico persistente desabilitado (node:sqlite indisponível):', historyError);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.vtt': 'text/vtt; charset=utf-8',
};

/* ---------------------------------------------------------------- *
 * Requisição upstream (com suporte a HTTP(S)_PROXY via CONNECT)
 * ---------------------------------------------------------------- */

function envProxyFor(targetUrl) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';
  const host = targetUrl.hostname;
  if (noProxy.split(',').some((h) => h && host.endsWith(h.trim()))) return null;
  const v =
    targetUrl.protocol === 'https:'
      ? process.env.HTTPS_PROXY || process.env.https_proxy
      : process.env.HTTP_PROXY || process.env.http_proxy;
  return v ? new URL(v) : null;
}

/** Um IP literal está numa faixa interna (loopback/link-local/privada/ULA)? */
function isInternalIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformado: bloqueia
    if (p[0] === 127) return true;                                   // 127.0.0.0/8 loopback
    if (p[0] === 10) return true;                                    // 10.0.0.0/8 privado
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;       // 172.16.0.0/12 privado
    if (p[0] === 192 && p[1] === 168) return true;                   // 192.168.0.0/16 privado
    if (p[0] === 169 && p[1] === 254) return true;                   // 169.254.0.0/16 link-local (metadata de nuvem)
    if (p[0] === 0) return true;                                     // 0.0.0.0/8
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;      // 100.64.0.0/10 CGNAT
    return false;
  }
  if (v === 6) {
    const a = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (a === '::1' || a === '::') return true;                      // loopback / unspecified
    if (a.startsWith('fe80')) return true;                          // fe80::/10 link-local
    if (a.startsWith('fc') || a.startsWith('fd')) return true;      // fc00::/7 ULA
    if (a.startsWith('::ffff:')) return isInternalIp(a.slice(7));   // IPv4 mapeado
    return false;
  }
  return true; // não é um IP reconhecível: trata como bloqueado por segurança
}

/**
 * Resolve o hostname do alvo e reprova se QUALQUER endereço cair numa faixa
 * interna — evita SSRF drive-by (o proxy é aberto, então sem isto qualquer
 * site poderia ler localhost/metadata de nuvem/serviços internos através
 * dele). Nomes óbvios de loopback também são barrados antes do DNS.
 * cb(blocked: boolean).
 */
function isBlockedTarget(hostname, cb) {
  if (ALLOW_PRIVATE_PROXY) return cb(false);
  const h = (hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return cb(true);
  if (net.isIP(h)) return cb(isInternalIp(h));
  dns.lookup(h, { all: true }, (err, addrs) => {
    if (err || !addrs || !addrs.length) return cb(true); // não resolveu: bloqueia
    cb(addrs.some((a) => isInternalIp(a.address)));
  });
}

/**
 * Faz GET em targetUrl (string), seguindo redirects, e chama
 * cb(err, upstreamResponse, finalUrl).
 */
function upstreamGet(targetUrl, clientHeaders, redirectsLeft, cb) {
  let target;
  try {
    target = new URL(targetUrl);
  } catch (e) {
    return cb(Object.assign(new Error('URL inválida: ' + targetUrl), { status: 400 }));
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return cb(Object.assign(new Error('Apenas http/https são suportados'), { status: 400 }));
  }

  // Bloqueia alvos internos ANTES de conectar. Isto roda também a cada
  // redirect (upstreamGet é recursivo em onResponse), cobrindo o caso de um
  // Location apontando para a rede interna.
  isBlockedTarget(target.hostname, (blocked) => {
    if (blocked) {
      return cb(Object.assign(
        new Error('Alvo interno/privado bloqueado (defina ALLOW_PRIVATE_PROXY=1 só em rede confiável)'),
        { status: 403 }));
    }
    doUpstreamRequest();
  });

  function doUpstreamRequest() {

  const headers = {
    'user-agent': clientHeaders['user-agent'] || 'stream-inspector/1.0',
    accept: '*/*',
    'accept-encoding': 'identity', // simplifica reescrita de manifests
  };
  if (clientHeaders.range) headers.range = clientHeaders.range;

  const onResponse = (res) => {
    const status = res.statusCode || 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (redirectsLeft <= 0) {
        return cb(Object.assign(new Error('Redirects em excesso'), { status: 502 }));
      }
      const next = new URL(res.headers.location, target).href;
      return upstreamGet(next, clientHeaders, redirectsLeft - 1, cb);
    }
    cb(null, res, target.href);
  };

  const proxy = envProxyFor(target);
  const isHttps = target.protocol === 'https:';

  if (!proxy) {
    const mod = isHttps ? https : http;
    const req = mod.request(target, { method: 'GET', headers }, onResponse);
    req.on('error', (e) => cb(Object.assign(e, { status: 502 })));
    req.end();
    return;
  }

  if (!isHttps) {
    // http via proxy: requisição com URL absoluta
    const req = http.request(
      {
        host: proxy.hostname,
        port: proxy.port || 80,
        method: 'GET',
        path: target.href,
        headers: { ...headers, host: target.host },
      },
      onResponse
    );
    req.on('error', (e) => cb(Object.assign(e, { status: 502 })));
    req.end();
    return;
  }

  // https via proxy: túnel CONNECT
  const connectReq = http.request({
    host: proxy.hostname,
    port: proxy.port || 80,
    method: 'CONNECT',
    path: `${target.hostname}:${target.port || 443}`,
    headers: { host: `${target.hostname}:${target.port || 443}` },
  });
  connectReq.on('connect', (res, socket) => {
    if (res.statusCode !== 200) {
      socket.destroy();
      return cb(Object.assign(new Error('Proxy CONNECT falhou: ' + res.statusCode), { status: 502 }));
    }
    const req = https.request(
      {
        host: target.hostname,
        port: target.port || 443,
        method: 'GET',
        path: target.pathname + target.search,
        headers,
        socket,
        agent: false,
        servername: target.hostname,
      },
      onResponse
    );
    req.on('error', (e) => cb(Object.assign(e, { status: 502 })));
    req.end();
  });
  connectReq.on('error', (e) => cb(Object.assign(e, { status: 502 })));
  connectReq.end();
  } // fim de doUpstreamRequest
}

/* ---------------------------------------------------------------- *
 * Reescrita de manifests (apenas URLs absolutas)
 * ---------------------------------------------------------------- */

function toProxyPath(absUrl) {
  try {
    const u = new URL(absUrl);
    return `/p/${u.protocol.replace(':', '')}/${u.host}${u.pathname}${u.search}`;
  } catch {
    return absUrl;
  }
}

function isM3U8(finalUrl, contentType) {
  return (
    /\.m3u8(\?|$)/i.test(finalUrl) ||
    /mpegurl/i.test(contentType || '')
  );
}

function isMPD(finalUrl, contentType) {
  return /\.mpd(\?|$)/i.test(finalUrl) || /dash\+xml/i.test(contentType || '');
}

function rewriteM3U8(text) {
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        // URI="https://..." dentro de EXT-X-MEDIA, EXT-X-KEY, EXT-X-MAP, etc.
        return line.replace(/URI="(https?:\/\/[^"]+)"/g, (_, u) => `URI="${toProxyPath(u)}"`);
      }
      if (/^https?:\/\//i.test(t)) return toProxyPath(t);
      return line; // URLs relativas resolvem sozinhas contra /p/...
    })
    .join('\n');
}

function rewriteMPD(text) {
  // Somente alvos que referenciam recursos; nunca schemeIdUri/xmlns,
  // que são identificadores comparados por string exata pelos players.
  return text
    .replace(/(<BaseURL[^>]*>)\s*(https?:\/\/[^<\s]+)\s*(<\/BaseURL>)/g,
      (_, open, u, close) => open + toProxyPath(u) + close)
    .replace(/\b(media|initialization|sourceURL|xlink:href)="(https?:\/\/[^"]+)"/g,
      (_, attr, u) => `${attr}="${toProxyPath(u)}"`);
}

/* ---------------------------------------------------------------- *
 * Handlers
 * ---------------------------------------------------------------- */

function handleProxy(req, res, urlPath, search) {
  // /p/<scheme>/<host>/<path...>
  const m = urlPath.match(/^\/p\/(https?)\/([^/]+)(\/.*)?$/);
  if (!m) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Rota de proxy: /p/<http|https>/<host>/<caminho>');
  }
  const targetUrl = `${m[1]}://${m[2]}${m[3] || '/'}${search || ''}`;

  upstreamGet(targetUrl, req.headers, MAX_REDIRECTS, (err, upstream, finalUrl) => {
    if (err) {
      res.writeHead(err.status || 502, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(`Erro ao buscar ${targetUrl}\n${err.message}`);
    }

    const contentType = upstream.headers['content-type'] || '';
    // Sem access-control-allow-origin aqui de propósito: o app é servido pela
    // MESMA origem deste servidor, então a inspeção normal (fetch same-origin)
    // não precisa de CORS. Anunciar ACAO:* transformaria o proxy num vetor de
    // leitura cross-origin para qualquer site (SSRF drive-by amplificado).
    const baseHeaders = {
      'cache-control': 'no-store',
      'x-final-url': finalUrl,
    };
    if (contentType) baseHeaders['content-type'] = contentType;

    const rewritable = isM3U8(finalUrl, contentType) || isMPD(finalUrl, contentType);
    if (!rewritable) {
      const passthrough = { ...baseHeaders };
      for (const h of [
        'content-length', 'content-range', 'accept-ranges',
        // identificação de CDN/edge + CMSD/CMCD-eco, repassados para o
        // painel "CDN / edge" do inspetor (só chegam aqui quando o
        // tráfego passa por este proxy)
        'x-cache', 'x-served-by', 'x-amz-cf-id', 'x-amz-cf-pop', 'cf-ray', 'cf-cache-status',
        'via', 'age', 'server', 'x-akamai-request-id', 'fastly-debug-digest',
        'cmsd-static', 'cmsd-dynamic',
      ]) {
        if (upstream.headers[h]) passthrough[h] = upstream.headers[h];
      }
      res.writeHead(upstream.statusCode || 200, passthrough);
      if (throttleKbps > 0) throttledPipe(upstream, res);
      else upstream.pipe(res);
      return;
    }

    // Manifest: bufferiza, reescreve URLs absolutas e responde
    const chunks = [];
    let size = 0;
    upstream.on('data', (c) => {
      size += c.length;
      if (size > MANIFEST_MAX_BYTES) {
        upstream.destroy();
        res.writeHead(502, baseHeaders);
        return res.end('Manifest excede o limite de tamanho');
      }
      chunks.push(c);
    });
    upstream.on('end', () => {
      let body = Buffer.concat(chunks).toString('utf8');
      body = isM3U8(finalUrl, contentType) ? rewriteM3U8(body) : rewriteMPD(body);
      res.writeHead(upstream.statusCode || 200, baseHeaders);
      res.end(body);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, baseHeaders);
      res.end();
    });
  });
}

/**
 * Repassa src→dst respeitando o throttleKbps VIGENTE a cada chunk —
 * mudar o limite no meio de um download em andamento tem efeito
 * imediato (inclusive removê-lo, kbps=0).
 */
function throttledPipe(src, dst) {
  src.on('data', (chunk) => {
    dst.write(chunk);
    if (throttleKbps <= 0) return; // limite removido durante o download
    src.pause();
    const bytesPerSec = (throttleKbps * 1000) / 8;
    const delayMs = (chunk.length / bytesPerSec) * 1000;
    setTimeout(() => { if (!src.destroyed) src.resume(); }, delayMs);
  });
  src.on('end', () => dst.end());
  src.on('error', () => dst.destroy());
  dst.on('close', () => src.destroy());
}

function handleThrottle(res, search) {
  const m = (search || '').match(/[?&]kbps=(\d+)/);
  const kbps = m ? Number(m[1]) : NaN;
  if (isNaN(kbps) || kbps < 0 || kbps > 1000000) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'kbps deve estar entre 0 (sem limite) e 1000000' }));
  }
  throttleKbps = kbps;
  console.log(kbps > 0 ? `Throttle: ${kbps} kbps` : 'Throttle: desligado');
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ throttleKbps }));
}

/**
 * Resolve uma URL do YouTube em manifest/mídia via yt-dlp LOCAL.
 * O sistema não decodifica assinaturas/DRM — delega inteiramente ao yt-dlp,
 * que o usuário instala (pip install yt-dlp). Restrito a uma allowlist de
 * hosts conhecidos para não virar um resolvedor/downloader genérico.
 * (Globoplay usa um resolvedor à parte — ver handleResolveGloboplay — porque
 * yt-dlp não tem suporte a esse conteúdo.)
 */
const YT_HOSTS = /^(?:www\.|m\.)?(?:youtube\.com|youtube-nocookie\.com|youtu\.be)$/i;

/** decodeURIComponent que nunca lança (retorna '' em %-encoding malformado). */
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return ''; }
}

function handleResolve(res, search) {
  const m = (search || '').match(/[?&]url=([^&]+)/);
  const url = m ? safeDecode(m[1]) : '';
  let host;
  try { host = new URL(url).hostname; } catch { host = null; }
  if (!host || !YT_HOSTS.test(host)) {
    res.writeHead(400, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify({ error: 'URL do YouTube inválida ou host não suportado.' }));
  }

  execFile(
    'yt-dlp',
    ['-J', '--no-warnings', '--no-playlist', url],
    { timeout: 30000, maxBuffer: 32 * 1024 * 1024 },
    (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') {
        res.writeHead(501, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        return res.end(JSON.stringify({
          error: 'yt-dlp não encontrado. Instale com "pip install yt-dlp" (ou "pipx install yt-dlp") na máquina que roda o server.js.',
          code: 'NO_YTDLP',
        }));
      }
      if (err) {
        res.writeHead(502, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        return res.end(JSON.stringify({
          error: 'yt-dlp falhou ao resolver a URL.',
          detail: String(stderr || err.message).split('\n').slice(-4).join(' ').slice(0, 400),
        }));
      }
      let info;
      try { info = JSON.parse(stdout); } catch (e) {
        res.writeHead(502, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        return res.end(JSON.stringify({ error: 'Saída do yt-dlp não é JSON válido.' }));
      }
      // repassa só o necessário (o JSON completo é enorme)
      const slim = {
        id: info.id, title: info.title, uploader: info.uploader,
        is_live: !!info.is_live, was_live: !!info.was_live,
        live_status: info.live_status || null,
        duration: info.duration || null,
        webpage_url: info.webpage_url || url,
        formats: (info.formats || []).map((f) => ({
          format_id: f.format_id, ext: f.ext, protocol: f.protocol,
          vcodec: f.vcodec, acodec: f.acodec,
          width: f.width, height: f.height, fps: f.fps,
          tbr: f.tbr, vbr: f.vbr, abr: f.abr,
          audio_channels: f.audio_channels, asr: f.asr,
          language: f.language, dynamic_range: f.dynamic_range,
          filesize: f.filesize || f.filesize_approx || null,
          manifest_url: f.manifest_url || null,
          url: f.url || null,
          format_note: f.format_note || null,
        })),
        subtitles: Object.keys(info.subtitles || {}),
        automatic_captions: Object.keys(info.automatic_captions || {}),
        chapters: (info.chapters || []).map((c) => ({ title: c.title, start_time: c.start_time })),
      };
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
      res.end(JSON.stringify(slim));
    }
  );
}

/**
 * Resolve uma URL do Globoplay achando a URL do manifest HLS/DASH REAL que o
 * player da página busca via JS — diferente do YouTube, isso não está
 * embutido estaticamente no HTML nem o yt-dlp sabe extrair, só aparece numa
 * requisição de rede depois que a página carrega e o player inicializa.
 *
 * Por isso a única forma é um navegador de verdade: Playwright headless
 * carrega a página, escuta as requisições, e pega a primeira que bater
 * .m3u8/.mpd. O conteúdo ao vivo exige login — reaproveita uma sessão salva
 * uma única vez via scripts/globoplay-login.js (browserContext.storageState),
 * nunca pede/guarda credenciais aqui.
 *
 * O sistema não tenta contornar DRM/paywall: se a sessão salva expirou (cai
 * numa tela de login) ou o conteúdo não expõe o manifest por algum outro
 * motivo, isso falha com um erro específico em vez de tentar burlar.
 */
const GLOBOPLAY_HOSTS = /^(?:www\.)?globoplay\.globo\.com$/i;
const GLOBOPLAY_SESSION_PATH = path.join(DATA_DIR, 'globoplay-session.json');
const GLOBOPLAY_RESOLVE_TIMEOUT_MS = 20000;
const MANIFEST_URL_RE = /\.(m3u8|mpd)(\?|$)/i;
// Cada resolução lança um Chromium headless inteiro — caro. Sem este guard,
// chamadas em rajada spawnariam navegadores até esgotar CPU/RAM da máquina.
let globoplayResolving = false;

async function handleResolveGloboplay(res, search) {
  const m = (search || '').match(/[?&]url=([^&]+)/);
  const url = m ? safeDecode(m[1]) : '';
  let host;
  try { host = new URL(url).hostname; } catch { host = null; }
  if (!host || !GLOBOPLAY_HOSTS.test(host)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'URL do Globoplay inválida ou host não suportado.' }));
  }
  if (globoplayResolving) {
    res.writeHead(429, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      error: 'Já há uma resolução do Globoplay em andamento. Aguarde alguns segundos e tente de novo.',
      code: 'BUSY',
    }));
  }
  if (!fs.existsSync(GLOBOPLAY_SESSION_PATH)) {
    res.writeHead(412, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      error: 'Nenhuma sessão do Globoplay salva. Rode "node scripts/globoplay-login.js" uma vez (faz login manual num navegador visível) antes de inspecionar URLs do Globoplay.',
      code: 'NO_SESSION',
    }));
  }

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    res.writeHead(501, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      error: 'Playwright não está instalado. Rode "npm install" e "npx playwright install chromium" na máquina que roda o server.js.',
      code: 'NO_PLAYWRIGHT',
    }));
  }

  let browser;
  globoplayResolving = true;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    });
    const context = await browser.newContext({ storageState: GLOBOPLAY_SESSION_PATH });
    const page = await context.newPage();

    const manifestUrl = await new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); fn(); };
      const onRequest = (req) => {
        const reqUrl = req.url();
        if (MANIFEST_URL_RE.test(reqUrl)) finish(() => resolve(reqUrl));
      };
      page.on('request', onRequest);
      const timer = setTimeout(() => {
        finish(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
      }, GLOBOPLAY_RESOLVE_TIMEOUT_MS);

      page.goto(url, { waitUntil: 'domcontentloaded', timeout: GLOBOPLAY_RESOLVE_TIMEOUT_MS }).then(() => {
        // sessão expirada normalmente redireciona pra uma URL de login
        const finalUrl = page.url();
        if (!done && /login|entrar|signin/i.test(finalUrl) && !MANIFEST_URL_RE.test(finalUrl)) {
          finish(() => reject(Object.assign(new Error('session expired'), { code: 'SESSION_EXPIRED' })));
        }
      }).catch(() => { /* navegação pode falhar mesmo com sucesso na captura da request — ignora aqui */ });
    });

    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ manifestUrl, type: /\.mpd/i.test(manifestUrl) ? 'dash' : 'hls' }));
  } catch (e) {
    if (e.code === 'SESSION_EXPIRED') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Sessão do Globoplay expirada (redirecionou para login). Rode "node scripts/globoplay-login.js" de novo.',
        code: 'SESSION_EXPIRED',
      }));
    } else if (e.code === 'TIMEOUT') {
      res.writeHead(504, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Não encontrou a URL do manifest a tempo — a página pode ter mudado de estrutura, ou o conteúdo pode estar bloqueado/indisponível.',
        code: 'TIMEOUT',
      }));
    } else {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Falha ao resolver via Playwright: ' + e.message }));
    }
  } finally {
    if (browser) { try { await browser.close(); } catch { /* já fechado */ } }
    globoplayResolving = false;
  }
}

const HISTORY_BODY_MAX_BYTES = 2 * 1024 * 1024; // resumo estático, não a telemetria inteira
const HISTORY_MAX_ROWS = 500; // teto de linhas guardadas (defesa em profundidade contra DoS de disco)

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error('Corpo da requisição excede o limite.')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('JSON inválido.')); }
    });
    req.on('error', reject);
  });
}

async function handleHistorySave(req, res) {
  if (!historyDb) {
    res.writeHead(501, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Histórico indisponível: ' + (historyError || 'node:sqlite não carregado') }));
  }
  let body;
  try { body = await readJsonBody(req, HISTORY_BODY_MAX_BYTES); } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: e.message }));
  }
  if (!body || typeof body.url !== 'string' || !body.summary) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Campos obrigatórios: url, summary.' }));
  }
  try {
    const stmt = historyDb.prepare(`
      INSERT INTO inspections (ts, url, protocol, live, video_variants, audio_tracks, hdr, drm, summary_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      Date.now(),
      body.url.slice(0, 2000),
      body.protocol || null,
      body.live ? 1 : 0,
      Number.isFinite(body.videoVariants) ? body.videoVariants : null,
      Number.isFinite(body.audioTracks) ? body.audioTracks : null,
      body.hdr || null,
      body.drm || null,
      JSON.stringify(body.summary)
    );
    // poda para as N mais recentes — limita o crescimento do arquivo mesmo se
    // o guard same-origin for contornado de algum modo
    historyDb.prepare(
      'DELETE FROM inspections WHERE id NOT IN (SELECT id FROM inspections ORDER BY ts DESC, id DESC LIMIT ?)'
    ).run(HISTORY_MAX_ROWS);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, id: Number(info.lastInsertRowid) }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Falha ao salvar no histórico: ' + e.message }));
  }
}

function handleHistoryList(res, search) {
  if (!historyDb) {
    res.writeHead(501, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Histórico indisponível: ' + (historyError || 'node:sqlite não carregado') }));
  }
  const m = (search || '').match(/[?&]limit=(\d+)/);
  const limit = Math.min(100, Math.max(1, m ? Number(m[1]) : 20));
  try {
    const rows = historyDb.prepare(`
      SELECT id, ts, url, protocol, live, video_variants, audio_tracks, hdr, drm, summary_json
      FROM inspections ORDER BY ts DESC LIMIT ?
    `).all(limit);
    const items = rows.map((r) => ({
      id: r.id, ts: r.ts, url: r.url, protocol: r.protocol,
      live: !!r.live, videoVariants: r.video_variants, audioTracks: r.audio_tracks,
      hdr: r.hdr, drm: r.drm, summary: JSON.parse(r.summary_json),
    }));
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ items }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Falha ao ler histórico: ' + e.message }));
  }
}

function handleStatic(req, res, urlPath) {
  let rel, filePath;
  try {
    // decodeURIComponent lança em %-encoding malformado (ex.: "/%"); path.join
    // lança em null byte ("/%00"). Antes esses erros propagavam de forma
    // síncrona e derrubavam o processo inteiro (uncaughtException). Agora
    // viram 400.
    rel = decodeURIComponent(urlPath);
    if (rel.includes('\0')) throw new Error('null byte'); // fs.stat lançaria de forma síncrona
    if (rel === '/') rel = '/index.html';
    filePath = path.join(PUBLIC_DIR, rel);
  } catch (e) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Caminho inválido');
  }
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403);
    return res.end('Proibido');
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Não encontrado: ' + rel);
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/**
 * Aprova requisições same-origin (o próprio app), ferramentas de linha de
 * comando e navegações diretas — que não mandam Origin, ou mandam um Origin
 * que bate com o host do servidor. Reprova só quando há um Origin/Referer de
 * uma ORIGEM EXTERNA explícita (um site aberto no navegador tentando acionar
 * os endpoints caros/de escrita). Não é uma fronteira de autenticação, é uma
 * defesa contra CSRF/abuso cross-origin num app single-user local.
 */
function isSameOrigin(req) {
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const src = origin || referer;
  if (!src) return true; // sem Origin/Referer: curl, navegação direta, same-origin simples
  let srcHost;
  try { srcHost = new URL(src).host; } catch { return false; }
  const selfHost = req.headers.host;
  return srcHost === selfHost;
}

function denyCrossOrigin(res) {
  res.writeHead(403, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'Requisição cross-origin recusada para este endpoint.' }));
}

/**
 * Preflight CORS restritivo: ecoa a origem SÓ quando ela é a própria (host do
 * servidor). Antes respondia access-control-allow-origin:* de forma global, o
 * que autorizava qualquer site a fazer POST/PUT cross-origin nos endpoints.
 */
function handlePreflight(req, res) {
  const headers = {
    'access-control-allow-methods': 'GET, HEAD, OPTIONS, POST',
    'access-control-allow-headers': 'content-type',
    vary: 'Origin',
  };
  if (isSameOrigin(req) && req.headers.origin) {
    headers['access-control-allow-origin'] = req.headers.origin;
  }
  res.writeHead(204, headers);
  res.end();
}

const server = http.createServer((req, res) => {
  // Rede de segurança: um throw síncrono no roteamento (ex.: entrada
  // malformada) NUNCA deve derrubar o processo — responde 500 e segue.
  try {
    routeRequest(req, res);
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Erro interno');
  }
});

function routeRequest(req, res) {
  const qIdx = req.url.indexOf('?');
  const urlPath = qIdx === -1 ? req.url : req.url.slice(0, qIdx);
  const search = qIdx === -1 ? '' : req.url.slice(qIdx);

  if (req.method === 'OPTIONS') return handlePreflight(req, res);

  if (req.method === 'POST' && urlPath === '/api/history') {
    if (!isSameOrigin(req)) return denyCrossOrigin(res);
    return handleHistorySave(req, res);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end('Método não permitido');
  }

  if (urlPath.startsWith('/p/')) return handleProxy(req, res, urlPath, search);
  // Endpoints caros / que mudam estado: barram origem externa explícita para
  // não serem acionados por um site aberto no navegador do usuário.
  if (urlPath === '/throttle') {
    if (!isSameOrigin(req)) return denyCrossOrigin(res);
    return handleThrottle(res, search);
  }
  if (urlPath === '/resolve') {
    if (!isSameOrigin(req)) return denyCrossOrigin(res);
    return handleResolve(res, search);
  }
  if (urlPath === '/resolve-globoplay') {
    if (!isSameOrigin(req)) return denyCrossOrigin(res);
    return handleResolveGloboplay(res, search);
  }
  if (urlPath === '/api/history') return handleHistoryList(res, search);
  return handleStatic(req, res, urlPath);
}

server.listen(PORT, HOST, () => {
  console.log(`Stream Inspector rodando em http://localhost:${PORT} (host: ${HOST})`);
  console.log(`Proxy de CORS ativo em /p/<scheme>/<host>/<caminho>`);
});

// Uma requisição malformada não pode tirar o servidor do ar — loga e segue.
process.on('uncaughtException', (e) => console.error('uncaughtException:', e && e.message));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e && (e.message || e)));
