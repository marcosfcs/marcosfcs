/**
 * Teste headless do histórico com rótulos, pesquisa e poda (lib/history-store.js).
 * Por padrão roda contra o backend SQLite em diretório temporário (Node 22+, sem
 * navegador e sem banco externo): `node scripts/history-store-test.js`.
 *
 * Para rodar o MESMO roteiro contra um MySQL/MariaDB (inclui a migração de uma
 * tabela criada antes dos rótulos), aponte um banco DESCARTÁVEL — a tabela
 * `inspections` dele é apagada:
 *   HISTORY_TEST_MYSQL_URL=mysql://usuario:senha@host:porta/banco node scripts/history-store-test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-test-'));
process.env.STREAM_INSPECTOR_DATA_DIR = dir;
for (const k of Object.keys(process.env)) if (/^(HISTORY_DATABASE|DBAAS_MYSQL|MYSQL_|DATABASE_URL)/.test(k)) delete process.env[k];

const MYSQL_URL = process.env.HISTORY_TEST_MYSQL_URL || '';
if (MYSQL_URL) process.env.HISTORY_DATABASE_URL = MYSQL_URL;

const { openHistoryStore, fold, cleanLabel } = require('../lib/history-store');

let failed = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.error(`FALHOU: ${name}\n  obtido:   ${JSON.stringify(got)}\n  esperado: ${JSON.stringify(want)}`); }
  else console.log(`ok  ${name}`);
}

let t = 1000;
const row = (url, extra) => ({
  ts: t++, url, protocol: 'HLS', live: 0, videoVariants: 3, audioTracks: 1, hdr: 'SDR', drm: 'Nenhuma',
  summaryJson: JSON.stringify({ overview: { URL: url } }), ...extra,
});
const urls = (r) => r.items.map((i) => i.url);

(async () => {
  // ── funções puras ──
  eq('fold: acentos e caixa', fold('Ação ÉPICA'), 'acao epica');
  eq('cleanLabel: apara e junta espaços', cleanLabel('  Globo   Play ', 80), 'Globo Play');
  eq('cleanLabel: vazio → null', cleanLabel('   ', 80), null);
  eq('cleanLabel: limite de tamanho', cleanLabel('x'.repeat(500), 160).length, 160);

  let mysqlConn = null;
  if (MYSQL_URL) {
    mysqlConn = await require('mysql2/promise').createConnection(MYSQL_URL);
    await mysqlConn.query('DROP TABLE IF EXISTS inspections');
  }
  const store = openHistoryStore({ maxRows: 6 });
  await store.ready();
  eq(`backend ${MYSQL_URL ? 'mysql' : 'sqlite'} ok`, [store.describe().backend, store.describe().ok], [MYSQL_URL ? 'mysql' : 'sqlite', true]);

  // ── salvar / listar ──
  const a = await store.save(row('https://live.example.com/globo/master.m3u8', { live: 1 }));
  const b = await store.save(row('https://vod.example.com/novela/manifest.mpd', { protocol: 'DASH' }));
  const c = await store.save(row('https://cdn.example.com/esporte/index.m3u8?token=***'));
  eq('save devolve id e rótulo vazio', { name: a.name, platform: a.platform, idIsNumber: typeof a.id === 'number' }, { name: null, platform: null, idIsNumber: true });
  let l = await store.list({ limit: 10 });
  eq('lista do mais recente ao mais antigo', urls(l).map((u) => u.split('/')[3]), ['esporte', 'novela', 'globo']);
  eq('lista sem summary (leve)', l.items.every((i) => i.summary === undefined), true);
  eq('totais', { total: l.total, all: l.all }, { total: 3, all: 3 });
  eq('get traz o summary', (await store.get(a.id)).summary, { overview: { URL: 'https://live.example.com/globo/master.m3u8' } });
  eq('get sem summary', (await store.get(a.id, false)).summary, undefined);
  eq('get de id inexistente', await store.get(9999), null);

  // ── rótulos ──
  const u1 = await store.update(a.id, { name: '  Globo   SP  ', platform: 'Globoplay', live: true });
  eq('update normaliza o nome', u1.name, 'Globo SP');
  eq('update grava a plataforma', u1.platform, 'Globoplay');
  eq('update de id inexistente → null', await store.update(9999, { name: 'x' }), null);
  const u2 = await store.update(b.id, { name: 'Novela das 9', platform: 'globoplay' });
  eq('plataforma reaproveita a grafia existente (ignora caixa)', u2.platform, 'Globoplay');
  const u3 = await store.update(c.id, { name: 'Campeonato', platform: 'Cartola' });
  eq('plataforma nova mantém a grafia digitada', u3.platform, 'Cartola');
  eq('patch parcial não mexe no resto', (await store.update(c.id, { live: false })).name, 'Campeonato');
  eq('limpar o nome com vazio', (await store.update(c.id, { name: '' })).name, null);
  await store.update(c.id, { name: 'Campeonato' });
  eq('live editado vale na lista', (await store.update(b.id, { live: true })).live, true);
  await store.update(b.id, { live: false });
  eq('live não-booleano é ignorado', (await store.update(b.id, { live: 'sim' })).live, false);

  // ── pesquisa ──
  l = await store.list({ limit: 10, q: 'globo' });
  eq('pesquisa por plataforma/nome/URL (sem duplicar)', urls(l).map((u) => u.split('/')[3]), ['novela', 'globo']);
  eq('pesquisa ignora acento e caixa', urls(await store.list({ q: 'NOVELA das 9' })).length, 1);
  eq('pesquisa por termo de URL', urls(await store.list({ q: 'esporte' })).length, 1);
  eq('vários termos: todos precisam casar', urls(await store.list({ q: 'globo sp' })).length, 1);
  eq('pesquisa por protocolo', urls(await store.list({ q: 'dash' })).length, 1);
  eq('sem resultado', (await store.list({ q: 'inexistente' })).total, 0);
  eq('%/_ são literais', (await store.list({ q: '%' })).total, 0);
  eq('filtro live', urls(await store.list({ live: 'live' })).length, 1);
  eq('filtro vod', urls(await store.list({ live: 'vod' })).length, 2);
  eq('filtro de plataforma', urls(await store.list({ platform: 'GLOBOPLAY' })).length, 2);
  eq('filtros combinados', urls(await store.list({ platform: 'globoplay', live: 'vod', q: 'novela' })).length, 1);
  l = await store.list({ limit: 1 });
  eq('limit corta, total não', { n: l.items.length, total: l.total }, { n: 1, total: 3 });
  eq('plataformas com contagem', (await store.list({})).platforms, [{ name: 'Cartola', count: 1 }, { name: 'Globoplay', count: 2 }]);

  // ── herança de rótulo na mesma URL ──
  const again = await store.save(row('https://live.example.com/globo/master.m3u8', { live: 1 }));
  eq('reinspecionar a mesma URL herda o rótulo', { name: again.name, platform: again.platform }, { name: 'Globo SP', platform: 'Globoplay' });
  eq('o item novo já nasce rotulado', (await store.get(again.id, false)).name, 'Globo SP');
  const other = await store.save(row('https://outra.example.com/x.m3u8'));
  eq('URL sem rótulo anterior fica sem rótulo', other.name, null);

  // ── poda: teto 6, sem rótulo sai primeiro ──
  // hoje há 5 linhas (a, b, c, again, other); a, b, c e again têm rótulo
  for (let i = 0; i < 4; i++) await store.save(row(`https://filler.example.com/${i}.m3u8`));
  l = await store.list({ limit: 100 });
  eq('teto respeitado', l.all, 6);
  eq('rotuladas sobrevivem à poda', l.items.filter((i) => i.name).length, 4);
  eq('as sem rótulo mais antigas saíram primeiro', urls(l).filter((u) => u.includes('filler')).length, 2);
  eq('a mais antiga sem rótulo (other) saiu', urls(l).includes('https://outra.example.com/x.m3u8'), false);

  // ── migração de um banco criado antes dos rótulos ──
  let oldDir = null;
  let migrated;
  if (MYSQL_URL) {
    await mysqlConn.query('DROP TABLE IF EXISTS inspections');
    await mysqlConn.query(`CREATE TABLE inspections (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, ts BIGINT NOT NULL, url VARCHAR(2000) NOT NULL,
      protocol VARCHAR(16) NULL, live TINYINT NULL, video_variants INT NULL, audio_tracks INT NULL,
      hdr VARCHAR(64) NULL, drm VARCHAR(255) NULL, summary_json MEDIUMTEXT NOT NULL, INDEX idx_inspections_ts (ts)
    ) DEFAULT CHARSET=utf8mb4`);
    await mysqlConn.query('INSERT INTO inspections (ts, url, protocol, live, summary_json) VALUES (1, ?, ?, 0, ?)',
      ['https://antigo.example.com/a.m3u8', 'HLS', '{"overview":{}}']);
    migrated = openHistoryStore({ maxRows: 10 });
  } else {
    oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-old-'));
    const { DatabaseSync } = require('node:sqlite');
    const old = new DatabaseSync(path.join(oldDir, 'history.sqlite'));
    old.exec(`CREATE TABLE inspections (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, url TEXT NOT NULL,
      protocol TEXT, live INTEGER, video_variants INTEGER, audio_tracks INTEGER, hdr TEXT, drm TEXT, summary_json TEXT NOT NULL)`);
    old.prepare('INSERT INTO inspections (ts, url, protocol, live, summary_json) VALUES (?, ?, ?, ?, ?)')
      .run(1, 'https://antigo.example.com/a.m3u8', 'HLS', 0, '{"overview":{}}');
    old.close();
    process.env.STREAM_INSPECTOR_DATA_DIR = oldDir;
    migrated = openHistoryStore({ maxRows: 10 });
  }
  const m = await migrated.list({});
  eq('migração: linha antiga preservada e sem rótulo', { total: m.total, name: m.items[0].name, platform: m.items[0].platform }, { total: 1, name: null, platform: null });
  eq('migração: dá para rotular a linha antiga', (await migrated.update(m.items[0].id, { name: 'Antigo', platform: 'ge' })).platform, 'ge');
  const reopened = openHistoryStore({ maxRows: 10 });
  eq('migração é idempotente (reabrir não falha)', (await reopened.list({})).items[0].name, 'Antigo');
  if (MYSQL_URL) await mysqlConn.query('DROP TABLE IF EXISTS inspections');

  fs.rmSync(dir, { recursive: true, force: true });
  if (oldDir) fs.rmSync(oldDir, { recursive: true, force: true });
  if (failed) { console.error(`\n${failed} TESTE(S) FALHARAM`); process.exit(1); }
  console.log('\nTODOS OS TESTES PASSARAM');
  process.exit(0); // pools do MySQL manteriam o processo vivo
})().catch((e) => { console.error(e); process.exit(1); });
