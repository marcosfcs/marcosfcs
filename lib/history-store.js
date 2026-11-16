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

// Variáveis que podem trazer o endereço do banco, em ordem de prioridade.
// O DBaaS da Globo injeta DBAAS_MYSQL_ENDPOINT (+ _USER/_PASSWORD/_PORT/_HOSTS
// separados); as demais cobrem overrides manuais e convenções comuns.
const ENDPOINT_ENV_VARS = ['HISTORY_DATABASE_URL', 'DBAAS_MYSQL_ENDPOINT', 'DATABASE_URL', 'MYSQL_URL'];
const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const DEFAULT_DATABASE = 'stream_inspector';

/**
 * Lê um endereço de banco em qualquer um dos formatos vistos na prática:
 * `mysql://user:pass@host:port/db`, `mysql://host:port`, `host:port`, `host`.
 * Se vier uma lista separada por vírgula, usa o primeiro item.
 * Devolve { host, port, user, password, database } (campos ausentes = null)
 * ou null se não houver host reconhecível.
 */
function parseEndpoint(raw) {
  let v = String(raw || '').trim().split(',')[0].trim();
  if (!v) return null;
  if (/^mysql:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      if (!u.hostname) return null;
      return {
        host: u.hostname,
        port: u.port ? Number(u.port) : null,
        user: u.username ? safeDecode(u.username) : null,
        password: u.password ? safeDecode(u.password) : null,
        database: u.pathname && u.pathname.length > 1 ? safeDecode(u.pathname.slice(1)) : null,
      };
    } catch { return null; }
  }
  v = v.replace(/^\w+:\/\//, ''); // tcp://host:porta etc.
  const m = /^([^:/\s]+)(?::(\d+))?(?:\/(\S*))?$/.exec(v);
  if (!m) return null;
  return { host: m[1], port: m[2] ? Number(m[2]) : null, user: null, password: null, database: m[3] || null };
}

/**
 * Descobre a conexão MySQL a partir do ambiente. Retorna
 *   { source, options: { host, port, user, password, database|null, ssl? } }
 * `source` é só o NOME da variável usada (nunca o valor, que pode conter a
 * senha). `options.database` nulo significa "descobrir na subida" (ver
 * MysqlStore). Retorna { source, error } se a variável existe mas não dá para
 * interpretá-la, e null quando não há banco configurado.
 */
function resolveMysqlConfig(env) {
  env = env || process.env;
  const pick = (...names) => { for (const n of names) if ((env[n] || '').trim()) return env[n].trim(); return null; };

  let source = null;
  let parsed = null;
  for (const name of ENDPOINT_ENV_VARS) {
    const v = (env[name] || '').trim();
    if (!v) continue;
    // DATABASE_URL genérica pode apontar para outro tipo de banco (postgres://…)
    if (name === 'DATABASE_URL' && !/^mysql:\/\//i.test(v)) continue;
    source = name;
    parsed = parseEndpoint(v);
    if (!parsed) return { source, error: `${name} não tem um endereço reconhecível (esperado host:porta ou mysql://…)` };
    break;
  }
  if (!source) {
    // sem endpoint: variáveis discretas (MYSQL_HOST) ou a lista de nós do DBaaS
    const host = pick('MYSQL_HOST');
    const hosts = pick('DBAAS_MYSQL_HOSTS');
    if (host) { source = 'MYSQL_HOST'; parsed = parseEndpoint(host); }
    else if (hosts && pick('DBAAS_MYSQL_USER')) { source = 'DBAAS_MYSQL_HOSTS'; parsed = parseEndpoint(hosts); }
    if (!source) return null;
    if (!parsed) return { source, error: `${source} não tem um endereço reconhecível` };
  }

  // a URL, quando traz usuário/senha/porta/banco, tem prioridade sobre as variáveis soltas
  const options = {
    host: parsed.host,
    port: parsed.port || Number(pick('DBAAS_MYSQL_PORT', 'MYSQL_PORT')) || 3306,
    user: parsed.user || pick('DBAAS_MYSQL_USER', 'MYSQL_USER'),
    password: parsed.password || pick('DBAAS_MYSQL_PASSWORD', 'MYSQL_PASSWORD'),
    database: pick('HISTORY_DATABASE_NAME') || parsed.database ||
      pick('DBAAS_MYSQL_DATABASE', 'MYSQL_DATABASE_NAME', 'MYSQL_DATABASE'),
  };
  if (/^(1|true|yes)$/i.test(env.HISTORY_DATABASE_SSL || '')) options.ssl = { rejectUnauthorized: false };
  return { source, options };
}

/** Resumo da conexão para diagnóstico: tudo, menos a senha. */
function describeConnection(options) {
  if (!options) return null;
  return { host: options.host, port: options.port, user: options.user || null, database: options.database || null, tls: !!options.ssl };
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
      .catch((e) => {
        let msg = e.code ? `${e.code}: ${e.message}` : e.message;
        // servidor que exige conexão cifrada: dica acionável em vez de erro críptico
        if (!this.options.ssl && /ssl|secure connection|require_secure_transport|tls/i.test(msg)) {
          msg += ' (o servidor pode exigir TLS: defina HISTORY_DATABASE_SSL=1)';
        }
        this.error = msg;
        throw new Error(msg);
      })
      .finally(() => { this.pending = null; });
    return this.pending;
  }

  /**
   * O bind do DBaaS não informa o nome do banco. Conecta sem schema e escolhe:
   * exatamente um banco de usuário visível → usa; nenhum → cria
   * `stream_inspector`; vários → não adivinha, lista os candidatos no erro
   * (o operador define HISTORY_DATABASE_NAME).
   */
  async _discoverDatabase(mysql) {
    const { database, ...noDb } = this.options;
    const conn = await mysql.createConnection({ ...noDb, connectTimeout: 8000 });
    try {
      const [rows] = await conn.query('SHOW DATABASES');
      const names = rows.map((r) => r.Database || r.database || Object.values(r)[0])
        .filter((n) => n && !SYSTEM_SCHEMAS.has(String(n).toLowerCase()));
      if (names.length === 1) return names[0];
      if (names.length === 0) {
        await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DEFAULT_DATABASE}\` DEFAULT CHARACTER SET utf8mb4`);
        return DEFAULT_DATABASE;
      }
      throw new Error(`vários bancos visíveis (${names.join(', ')}); defina HISTORY_DATABASE_NAME`);
    } finally {
      conn.end().catch(() => {});
    }
  }

  async _init() {
    let mysql;
    try { mysql = require('mysql2/promise'); } catch {
      throw new Error('dependência mysql2 ausente — rode "npm install"');
    }
    if (!this.options.database) this.options.database = await this._discoverDatabase(mysql);
    if (!this.pool) {
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
    return {
      backend: this.backend, ok: this.schemaOk, error: this.error, persistent: true,
      configuredBy: this.source, connection: describeConnection(this.options),
    };
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

module.exports = { openHistoryStore, resolveMysqlConfig, parseEndpoint, describeConnection, maskUrl, maskDeep };
