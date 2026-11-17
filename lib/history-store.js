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
 *
 * A lógica de histórico (pesquisa, rótulos, herança, poda) é única e fica em
 * HistoryOps; cada banco só implementa três primitivas:
 *   _query(sql, params) → linhas      _run(sql, params) → { insertId }      ready()
 * O histórico guarda no máximo algumas centenas de linhas, então a pesquisa
 * roda em JS sobre as colunas leves (sem o summary_json): isso dá o mesmo
 * resultado nos dois bancos, ignorando maiúsculas e acentos (o LIKE do SQLite
 * não ignora acentos).
 * ================================================================ */

const LIGHT_COLS = 'id, ts, url, protocol, live, video_variants, audio_tracks, hdr, drm, name, platform';
const FULL_COLS = LIGHT_COLS + ', summary_json';
const NAME_MAX = 160;
const PLATFORM_MAX = 80;

/** Minúsculas e sem acentos — chave de comparação para pesquisa e agrupamento. */
function fold(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Texto digitado pelo usuário: apara, junta espaços repetidos, vazio vira null. */
function cleanLabel(v, max) {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim().slice(0, max);
  return s || null;
}

function rowToItem(r) {
  const item = {
    id: Number(r.id), ts: Number(r.ts), url: r.url, protocol: r.protocol,
    live: !!r.live, videoVariants: r.video_variants, audioTracks: r.audio_tracks,
    hdr: r.hdr, drm: r.drm, name: r.name || null, platform: r.platform || null,
  };
  if (r.summary_json != null) item.summary = JSON.parse(r.summary_json);
  return item;
}

/** Plataformas distintas (sem diferenciar maiúsculas/acentos), com a grafia mais recente e a contagem. */
function collectPlatforms(items) {
  const byKey = new Map();
  for (const it of items) { // items já vêm do mais recente para o mais antigo
    if (!it.platform) continue;
    const k = fold(it.platform);
    const cur = byKey.get(k);
    if (cur) cur.count++;
    else byKey.set(k, { name: it.platform, count: 1 });
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

class HistoryOps {
  /**
   * Lista com pesquisa/filtros. Retorna { items, total, all, platforms }:
   * items = no máximo `limit` itens SEM o summary (use get(id) para o resumo);
   * total = quantos casaram; all = quantos existem; platforms = para filtro/sugestões.
   */
  async list(opts) {
    opts = opts || {};
    await this.ready();
    const rows = await this._query(`SELECT ${LIGHT_COLS} FROM inspections ORDER BY ts DESC, id DESC`, []);
    const all = rows.map(rowToItem);
    const terms = fold(opts.q).split(/\s+/).filter(Boolean);
    const wantLive = opts.live === 'live' ? true : opts.live === 'vod' ? false : null;
    const platKey = opts.platform ? fold(opts.platform) : null;
    const matched = all.filter((it) => {
      if (wantLive !== null && it.live !== wantLive) return false;
      if (platKey && fold(it.platform) !== platKey) return false;
      if (!terms.length) return true;
      const hay = fold([it.name, it.platform, it.protocol, it.url].filter(Boolean).join(' '));
      return terms.every((t) => hay.includes(t));
    });
    const limit = Math.max(1, Math.min(100, Number(opts.limit) || 20));
    return { items: matched.slice(0, limit), total: matched.length, all: all.length, platforms: collectPlatforms(all) };
  }

  /** Um teste pelo id (com o summary por padrão) ou null. */
  async get(id, withSummary) {
    await this.ready();
    const cols = withSummary === false ? LIGHT_COLS : FULL_COLS;
    const rows = await this._query(`SELECT ${cols} FROM inspections WHERE id = ?`, [id]);
    return rows.length ? rowToItem(rows[0]) : null;
  }

  /** Rótulo mais recente já dado a esta mesma URL (já mascarada), ou null. */
  async _findLabel(url) {
    const rows = await this._query(
      `SELECT name, platform FROM inspections
       WHERE url = ? AND (name IS NOT NULL OR platform IS NOT NULL)
       ORDER BY ts DESC, id DESC LIMIT 1`, [url]);
    return rows.length ? { name: rows[0].name || null, platform: rows[0].platform || null } : null;
  }

  /** Grava uma inspeção. Herda nome/plataforma de um teste anterior da mesma URL. */
  async save(row) {
    await this.ready();
    const label = await this._findLabel(row.url);
    const name = label ? label.name : null;
    const platform = label ? label.platform : null;
    const r = await this._run(
      `INSERT INTO inspections (ts, url, protocol, live, video_variants, audio_tracks, hdr, drm, name, platform, summary_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.ts, row.url, row.protocol && String(row.protocol).slice(0, 16), row.live, row.videoVariants, row.audioTracks,
        row.hdr && String(row.hdr).slice(0, 64), row.drm && String(row.drm).slice(0, 255), name, platform, row.summaryJson]);
    await this._prune();
    return { id: Number(r.insertId), name, platform };
  }

  /**
   * Atualiza o rótulo. patch: { name?, platform?, live? } (só o que vier é alterado).
   * Retorna o item atualizado (sem summary) ou null se o id não existe.
   */
  async update(id, patch) {
    await this.ready();
    if (!(await this.get(id, false))) return null;
    const sets = [];
    const vals = [];
    if ('name' in patch) { sets.push('name = ?'); vals.push(cleanLabel(patch.name, NAME_MAX)); }
    if ('platform' in patch) {
      let platform = cleanLabel(patch.platform, PLATFORM_MAX);
      if (platform) {
        // "globoplay" e "Globoplay" são a mesma plataforma: reaproveita a grafia já existente
        const { platforms } = await this.list({ limit: 1 });
        const hit = platforms.find((p) => fold(p.name) === fold(platform));
        if (hit) platform = hit.name;
      }
      sets.push('platform = ?'); vals.push(platform);
    }
    if (typeof patch.live === 'boolean') { sets.push('live = ?'); vals.push(patch.live ? 1 : 0); }
    if (sets.length) await this._run(`UPDATE inspections SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
    return this.get(id, false);
  }

  /**
   * Mantém o teto de linhas, removendo primeiro as mais antigas SEM rótulo: dar
   * nome a um teste é trabalho do usuário e não deve sumir só porque houve
   * muitas inspeções depois.
   */
  async _prune() {
    const [{ n }] = await this._query('SELECT COUNT(*) AS n FROM inspections', []);
    const excess = Number(n) - this.maxRows;
    if (excess <= 0) return;
    // derived table: o MySQL não aceita LIMIT direto dentro de "IN (subquery)"
    await this._run(
      `DELETE FROM inspections WHERE id IN (
         SELECT id FROM (
           SELECT id FROM inspections
           ORDER BY (CASE WHEN name IS NULL AND platform IS NULL THEN 0 ELSE 1 END) ASC, ts ASC, id ASC
           LIMIT ?
         ) AS oldest
       )`, [excess]);
  }
}

class SqliteStore extends HistoryOps {
  constructor(opts) {
    super();
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
          name TEXT,
          platform TEXT,
          summary_json TEXT NOT NULL
        )
      `);
      // bancos criados antes dos rótulos não têm as colunas novas
      const cols = new Set(this.db.prepare('PRAGMA table_info(inspections)').all().map((c) => c.name));
      for (const col of ['platform', 'name']) {
        if (!cols.has(col)) this.db.exec(`ALTER TABLE inspections ADD COLUMN ${col} TEXT`);
      }
    } catch (e) {
      this.db = null;
      this.error = 'node:sqlite indisponível: ' + e.message;
    }
  }

  async ready() { if (!this.db) throw new Error(this.error); }
  async _query(sql, params) { return this.db.prepare(sql).all(...params); }
  async _run(sql, params) { return { insertId: Number(this.db.prepare(sql).run(...params).lastInsertRowid) }; }

  describe() {
    return { backend: this.backend, ok: !!this.db, error: this.error, persistent: false };
  }
}

const MYSQL_RETRY_MS = 10000; // não martela o banco a cada requisição enquanto ele está fora

class MysqlStore extends HistoryOps {
  constructor(cfg, opts) {
    super();
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
        name VARCHAR(${NAME_MAX}) NULL,
        platform VARCHAR(${PLATFORM_MAX}) NULL,
        summary_json MEDIUMTEXT NOT NULL,
        INDEX idx_inspections_ts (ts)
      ) DEFAULT CHARSET=utf8mb4
    `);
    // tabelas criadas antes dos rótulos: o MySQL 8 não tem ADD COLUMN IF NOT EXISTS,
    // então confere antes. Colunas nulas — linhas antigas e versões antigas seguem valendo.
    for (const [col, ddl] of [['platform', `VARCHAR(${PLATFORM_MAX}) NULL`], ['name', `VARCHAR(${NAME_MAX}) NULL`]]) {
      const [found] = await this.pool.query('SHOW COLUMNS FROM inspections LIKE ?', [col]);
      if (!found.length) await this.pool.query(`ALTER TABLE inspections ADD COLUMN ${col} ${ddl}`);
    }
  }

  async _query(sql, params) { const [rows] = await this.pool.query(sql, params); return rows; }
  async _run(sql, params) { const [res] = await this.pool.query(sql, params); return { insertId: res.insertId }; }

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

module.exports = { openHistoryStore, resolveMysqlConfig, parseEndpoint, describeConnection, maskUrl, maskDeep, fold, cleanLabel };
