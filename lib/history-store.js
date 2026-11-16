/**
 * Histórico persistente de inspeções — armazenamento com dois backends:
 *
 *  - MySQL, quando há um banco configurado por variável de ambiente (é o que
 *    um `tsuru service instance bind` do DBaaS injeta no app). É o modo de
 *    produção: o disco do container é efêmero e cada unidade teria o seu
 *    próprio arquivo, então SQLite local não persiste lá.
 *  - SQLite (`node:sqlite`, Node 22+), quando não há banco configurado. É o
 *    modo local: `node server.js` segue funcionando sem `npm install`.
 *
 * Se o MySQL está configurado mas indisponível, o histórico fica indisponível
 * e diz por quê — de propósito NÃO cai para o SQLite efêmero, que esconderia
 * o problema (os testes "sumiriam" de novo no próximo deploy).
 *
 * Também mora aqui o mascaramento de credenciais (`maskUrl`/`maskDeep`): o
 * histórico é compartilhado por todos que abrem o app, e URLs de stream
 * costumam carregar tokens de acesso.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/* ================================================================ *
 * Mascaramento de credenciais em URLs
 * ================================================================ */

const MASK = '***';
const SECRET_PARAM_RE = /token|^sig$|signature|hdnts|hdnea|hmac|policy|key-pair-id|auth|jwt|secret|passw|pwd|api[-_]?key|access[-_]?key|credential|session|^x-(amz|goog)-/i;
const OPAQUE_VALUE_MIN = 32; // valor longo e opaco: quase sempre assinatura/token

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * Remove o que tem cara de credencial de uma URL, preservando o
 * resto (host, caminho, parâmetros comuns) para o histórico continuar legível.
 * Qualquer outra string volta intacta.
 */
function maskUrl(input) {
  // http(s) absoluta ou caminho relativo do próprio app (/samples/…?token=…)
  if (typeof input !== 'string' || !/^(https?:\/\/|\/)\S*$/i.test(input)) return input;
  const hashAt = input.indexOf('#');
  const hash = hashAt >= 0 ? input.slice(hashAt) : '';
  const noHash = hashAt >= 0 ? input.slice(0, hashAt) : input;
  const qAt = noHash.indexOf('?');
  let base = qAt >= 0 ? noHash.slice(0, qAt) : noHash;
  const query = qAt >= 0 ? noHash.slice(qAt + 1) : null;

  // user:pass@host
  base = base.replace(/^(https?:\/\/)[^/@]*@/i, '$1');
  // tokens Akamai embutidos no caminho: /hdnts=exp=...~hmac=.../
  base = base.replace(/\b(hdnts|hdnea)=[^/]*/gi, `$1=${MASK}`);

  if (query == null) return base + hash;
  const masked = query.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq < 0) return pair;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (!value) return pair;
    if (SECRET_PARAM_RE.test(safeDecode(key)) || safeDecode(value).length >= OPAQUE_VALUE_MIN) {
      return `${key}=${MASK}`;
    }
    return pair;
  }).join('&');
  return `${base}?${masked}${hash}`;
}

/** Aplica maskUrl a toda string dentro de um valor JSON (objetos/arrays). */
function maskDeep(value, depth) {
  depth = depth || 0;
  if (typeof value === 'string') return maskUrl(value);
  if (depth > 12 || value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = maskDeep(v, depth + 1);
  return out;
}

/* ================================================================ *
 * Resolução da configuração de banco (binding)
 * ================================================================ */

const URL_ENV_VARS = ['HISTORY_DATABASE_URL', 'DBAAS_MYSQL_ENDPOINT', 'DATABASE_URL', 'MYSQL_URL'];

/**
 * Descobre a conexão MySQL a partir do ambiente. Retorna
 * { source, options } — `source` é só o NOME da variável usada (nunca o
 * valor, que contém a senha) — ou null quando não há banco configurado.
 */
function resolveMysqlConfig(env) {
  env = env || process.env;
  for (const name of URL_ENV_VARS) {
    const v = (env[name] || '').trim();
    if (!v) continue;
    // DATABASE_URL/MYSQL_URL genéricas podem apontar para outro tipo de banco
    if (!/^mysql:\/\//i.test(v)) {
      if (name === 'DATABASE_URL') continue;
      return { source: name, error: `${name} não é uma URL mysql://` };
    }
    return { source: name, options: { uri: v } };
  }
  if (env.MYSQL_HOST) {
    return {
      source: 'MYSQL_HOST',
      options: {
        host: env.MYSQL_HOST,
        port: Number(env.MYSQL_PORT) || 3306,
        user: env.MYSQL_USER,
        password: env.MYSQL_PASSWORD,
        database: env.MYSQL_DATABASE_NAME || env.MYSQL_DATABASE,
      },
    };
  }
  return null;
}

/* ================================================================ *
 * Backends
 * ================================================================ */

function rowToItem(r) {
  return {
    id: Number(r.id), ts: Number(r.ts), url: r.url, protocol: r.protocol,
    live: !!r.live, videoVariants: r.video_variants, audioTracks: r.audio_tracks,
    hdr: r.hdr, drm: r.drm, summary: JSON.parse(r.summary_json),
  };
}

class SqliteStore {
  constructor(opts) {
    this.backend = 'sqlite';
    this.maxRows = opts.maxRows;
    this.error = null;
    this.db = null;
    try {
      const { DatabaseSync } = require('node:sqlite');
      const dir = process.env.STREAM_INSPECTOR_DATA_DIR || path.join(os.homedir(), '.stream-inspector');
      fs.mkdirSync(dir, { recursive: true });
      this.db = new DatabaseSync(path.join(dir, 'history.sqlite'));
      this.db.exec(`
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
      this.error = 'node:sqlite indisponível: ' + e.message;
    }
  }

  async ready() { if (!this.db) throw new Error(this.error); }

  async save(row) {
    await this.ready();
    const info = this.db.prepare(`
      INSERT INTO inspections (ts, url, protocol, live, video_variants, audio_tracks, hdr, drm, summary_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.ts, row.url, row.protocol, row.live, row.videoVariants, row.audioTracks, row.hdr, row.drm, row.summaryJson);
    this.db.prepare(
      'DELETE FROM inspections WHERE id NOT IN (SELECT id FROM inspections ORDER BY ts DESC, id DESC LIMIT ?)'
    ).run(this.maxRows);
    return Number(info.lastInsertRowid);
  }

  async list(limit) {
    await this.ready();
    return this.db.prepare(`
      SELECT id, ts, url, protocol, live, video_variants, audio_tracks, hdr, drm, summary_json
      FROM inspections ORDER BY ts DESC, id DESC LIMIT ?
    `).all(limit).map(rowToItem);
  }

  describe() {
    return { backend: this.backend, ok: !!this.db, error: this.error, persistent: false };
  }
}

const MYSQL_RETRY_MS = 10000; // não martela o banco a cada requisição enquanto ele está fora

class MysqlStore {
  constructor(cfg, opts) {
    this.backend = 'mysql';
    this.source = cfg.source;
    this.maxRows = opts.maxRows;
    this.options = cfg.options;
    this.error = cfg.error || null;
    this.pool = null;
    this.schemaOk = false;
    this.lastAttempt = 0;
    this.pending = null;
    if (!this.error) this.ready().catch(() => {}); // tenta já na subida; falha fica em this.error
  }

  /** Garante pool + tabela. Reexecutável: se o banco estava fora, tenta de novo depois. */
  ready() {
    if (this.schemaOk) return Promise.resolve();
    if (!this.options) return Promise.reject(new Error(this.error));
    if (this.pending) return this.pending;
    if (this.error && Date.now() - this.lastAttempt < MYSQL_RETRY_MS) return Promise.reject(new Error(this.error));
    this.lastAttempt = Date.now();
    this.pending = this._init()
      .then(() => { this.schemaOk = true; this.error = null; })
      .catch((e) => { this.error = e.code ? `${e.code}: ${e.message}` : e.message; throw new Error(this.error); })
      .finally(() => { this.pending = null; });
    return this.pending;
  }

  async _init() {
    if (!this.pool) {
      let mysql;
      try { mysql = require('mysql2/promise'); } catch {
        throw new Error('dependência mysql2 ausente — rode "npm install"');
      }
      this.pool = mysql.createPool({
        ...this.options,
        connectionLimit: 3,
        waitForConnections: true,
        connectTimeout: 8000,
        enableKeepAlive: true,
        charset: 'utf8mb4',
      });
    }
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS inspections (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        ts BIGINT NOT NULL,
        url VARCHAR(2000) NOT NULL,
        protocol VARCHAR(16) NULL,
        live TINYINT NULL,
        video_variants INT NULL,
        audio_tracks INT NULL,
        hdr VARCHAR(64) NULL,
        drm VARCHAR(255) NULL,
        summary_json MEDIUMTEXT NOT NULL,
        INDEX idx_inspections_ts (ts)
      ) DEFAULT CHARSET=utf8mb4
    `);
  }

  async save(row) {
    await this.ready();
    const [res] = await this.pool.query(
      `INSERT INTO inspections (ts, url, protocol, live, video_variants, audio_tracks, hdr, drm, summary_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.ts, row.url, row.protocol && row.protocol.slice(0, 16), row.live, row.videoVariants, row.audioTracks,
        row.hdr && row.hdr.slice(0, 64), row.drm && row.drm.slice(0, 255), row.summaryJson]
    );
    // poda: apaga do (maxRows+1)-ésimo mais recente para trás. MySQL não aceita
    // LIMIT dentro de "IN (subquery)", daí a tabela derivada.
    await this.pool.query(
      `DELETE FROM inspections WHERE id <= (
         SELECT id FROM (SELECT id FROM inspections ORDER BY id DESC LIMIT 1 OFFSET ?) AS cut
       )`,
      [this.maxRows]
    );
    return Number(res.insertId);
  }

  async list(limit) {
    await this.ready();
    const [rows] = await this.pool.query(
      `SELECT id, ts, url, protocol, live, video_variants, audio_tracks, hdr, drm, summary_json
       FROM inspections ORDER BY ts DESC, id DESC LIMIT ?`,
      [limit]
    );
    return rows.map(rowToItem);
  }

  describe() {
    return { backend: this.backend, ok: this.schemaOk, error: this.error, persistent: true, configuredBy: this.source };
  }
}

/**
 * Cria o store conforme o ambiente. opts: { maxRows }.
 * Sempre retorna um store; indisponibilidade aparece em describe()/nas chamadas.
 */
function openHistoryStore(opts) {
  const cfg = resolveMysqlConfig(process.env);
  return cfg ? new MysqlStore(cfg, opts) : new SqliteStore(opts);
}

module.exports = { openHistoryStore, resolveMysqlConfig, maskUrl, maskDeep };
