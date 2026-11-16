/**
 * Teste headless do mascaramento de credenciais do histórico e da resolução
 * da configuração de banco (lib/history-store.js). Node puro, sem navegador
 * e sem banco: `node scripts/history-mask-test.js`.
 */
'use strict';

const { maskUrl, maskDeep, resolveMysqlConfig } = require('../lib/history-store');

let failed = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.error(`FALHOU: ${name}\n  obtido:   ${JSON.stringify(got)}\n  esperado: ${JSON.stringify(want)}`); }
  else console.log(`ok  ${name}`);
}

// ── maskUrl ──
eq('URL sem query fica intacta',
  maskUrl('https://cdn.example.com/live/master.m3u8'), 'https://cdn.example.com/live/master.m3u8');
eq('parâmetros comuns são preservados',
  maskUrl('https://cdn.example.com/a.mpd?start=10&profile=hd'), 'https://cdn.example.com/a.mpd?start=10&profile=hd');
eq('token por nome',
  maskUrl('https://cdn.example.com/a.m3u8?token=abc&x=1'), 'https://cdn.example.com/a.m3u8?token=***&x=1');
eq('CloudFront assinado',
  maskUrl('https://d1.cloudfront.net/v.m3u8?Policy=eyJTdGF0&Signature=Zm9v&Key-Pair-Id=K2ABC'),
  'https://d1.cloudfront.net/v.m3u8?Policy=***&Signature=***&Key-Pair-Id=***');
eq('S3 pré-assinado',
  maskUrl('https://b.s3.amazonaws.com/v.mp4?X-Amz-Algorithm=AWS4&X-Amz-Signature=deadbeef&versionId=3'),
  'https://b.s3.amazonaws.com/v.mp4?X-Amz-Algorithm=***&X-Amz-Signature=***&versionId=3');
eq('Akamai hdnts na query',
  maskUrl('https://a.akamaized.net/m.m3u8?hdnts=exp=1700~acl=/*~hmac=abcdef'), 'https://a.akamaized.net/m.m3u8?hdnts=***');
eq('Akamai hdnea no caminho',
  maskUrl('https://a.akamaihd.net/hdnea=st=1~exp=2~hmac=ff/live/master.m3u8'), 'https://a.akamaihd.net/hdnea=***/live/master.m3u8');
eq('valor longo e opaco, nome neutro',
  maskUrl('https://x.example.com/a.m3u8?h=0123456789abcdef0123456789abcdef&v=2'), 'https://x.example.com/a.m3u8?h=***&v=2');
eq('credenciais user:pass@',
  maskUrl('https://user:s3nha@cdn.example.com/a.m3u8'), 'https://cdn.example.com/a.m3u8');
eq('fragmento preservado',
  maskUrl('https://x.example.com/a.m3u8?jwt=aaa#t=10'), 'https://x.example.com/a.m3u8?jwt=***#t=10');
eq('caminho relativo também é mascarado', maskUrl('/samples/master.m3u8?token=abc&v=1'), '/samples/master.m3u8?token=***&v=1');
eq('caminho relativo sem query fica intacto', maskUrl('/samples/master.m3u8'), '/samples/master.m3u8');
eq('texto com barra e espaço não é URL', maskUrl('/ não é url ?token=abc'), '/ não é url ?token=abc');
eq('texto comum não é tocado', maskUrl('HLS (HTTP Live Streaming)'), 'HLS (HTTP Live Streaming)');
eq('não-string volta igual', maskUrl(42), 42);

// ── maskDeep ──
eq('resumo aninhado',
  maskDeep({ overview: { URL: 'https://c.example.com/m.m3u8?token=zzz', Protocolo: 'HLS' },
    video: [{ id: '#1', uri: 'https://c.example.com/v1.m3u8?sig=q', bandwidth: 5 }], n: null }),
  { overview: { URL: 'https://c.example.com/m.m3u8?token=***', Protocolo: 'HLS' },
    video: [{ id: '#1', uri: 'https://c.example.com/v1.m3u8?sig=***', bandwidth: 5 }], n: null });

// ── resolveMysqlConfig ──
eq('sem variáveis → null (SQLite local)', resolveMysqlConfig({}), null);
eq('override manual tem prioridade',
  resolveMysqlConfig({ HISTORY_DATABASE_URL: 'mysql://a:b@h/db', DBAAS_MYSQL_ENDPOINT: 'mysql://c:d@h2/db2' }),
  { source: 'HISTORY_DATABASE_URL', options: { uri: 'mysql://a:b@h/db' } });
eq('endpoint do DBaaS',
  resolveMysqlConfig({ DBAAS_MYSQL_ENDPOINT: 'mysql://c:d@h2:3306/db2' }),
  { source: 'DBAAS_MYSQL_ENDPOINT', options: { uri: 'mysql://c:d@h2:3306/db2' } });
eq('DATABASE_URL de outro banco é ignorada',
  resolveMysqlConfig({ DATABASE_URL: 'postgres://a:b@h/db' }), null);
eq('variáveis discretas',
  resolveMysqlConfig({ MYSQL_HOST: 'h', MYSQL_USER: 'u', MYSQL_PASSWORD: 'p', MYSQL_DATABASE_NAME: 'd' }),
  { source: 'MYSQL_HOST', options: { host: 'h', port: 3306, user: 'u', password: 'p', database: 'd' } });
eq('endpoint inválido vira erro explícito',
  resolveMysqlConfig({ DBAAS_MYSQL_ENDPOINT: 'h2:3306' }),
  { source: 'DBAAS_MYSQL_ENDPOINT', error: 'DBAAS_MYSQL_ENDPOINT não é uma URL mysql://' });

if (failed) { console.error(`\n${failed} TESTE(S) FALHARAM`); process.exit(1); }
console.log('\nTODOS OS TESTES PASSARAM');
