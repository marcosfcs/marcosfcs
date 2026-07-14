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
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_REDIRECTS = 5;
const MANIFEST_MAX_BYTES = 20 * 1024 * 1024; // manifests são pequenos; limite de segurança

// Teste de rede: limite de banda aplicado aos SEGMENTOS servidos pelo proxy
// (manifests ficam de fora para não gerar falso positivo de playlist
// estagnada). 0 = sem limite. Controlado pela UI via GET /throttle?kbps=N.
let throttleKbps = 0;

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
      res.writeHead(err.status || 502, {
        'content-type': 'text/plain; charset=utf-8',
        'access-control-allow-origin': '*',
      });
      return res.end(`Erro ao buscar ${targetUrl}\n${err.message}`);
    }

    const contentType = upstream.headers['content-type'] || '';
    const baseHeaders = {
      'access-control-allow-origin': '*',
      'access-control-expose-headers': '*',
      'cache-control': 'no-store',
      'x-final-url': finalUrl,
    };
    if (contentType) baseHeaders['content-type'] = contentType;

    const rewritable = isM3U8(finalUrl, contentType) || isMPD(finalUrl, contentType);
    if (!rewritable) {
      const passthrough = { ...baseHeaders };
      for (const h of ['content-length', 'content-range', 'accept-ranges']) {
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
 * O sistema não decodifica assinaturas do YouTube — delega ao yt-dlp,
 * que o usuário instala (pip install yt-dlp). Restrito a hosts do
 * YouTube para não virar um resolvedor/downloader genérico.
 */
const YT_HOSTS = /^(?:www\.|m\.)?(?:youtube\.com|youtube-nocookie\.com|youtu\.be)$/i;

function handleResolve(res, search) {
  const m = (search || '').match(/[?&]url=([^&]+)/);
  const url = m ? decodeURIComponent(m[1]) : '';
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

function handleStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, rel);
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

const server = http.createServer((req, res) => {
  const qIdx = req.url.indexOf('?');
  const urlPath = qIdx === -1 ? req.url : req.url.slice(0, qIdx);
  const search = qIdx === -1 ? '' : req.url.slice(qIdx);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': '*',
    });
    return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end('Método não permitido');
  }

  if (urlPath.startsWith('/p/')) return handleProxy(req, res, urlPath, search);
  if (urlPath === '/throttle') return handleThrottle(res, search);
  if (urlPath === '/resolve') return handleResolve(res, search);
  return handleStatic(req, res, urlPath);
});

server.listen(PORT, HOST, () => {
  console.log(`Stream Inspector rodando em http://localhost:${PORT}`);
  console.log(`Proxy de CORS ativo em /p/<scheme>/<host>/<caminho>`);
});
