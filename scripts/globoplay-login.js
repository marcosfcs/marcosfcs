#!/usr/bin/env node
/**
 * Login único no Globoplay para a resolução automática de manifest funcionar.
 *
 * O conteúdo ao vivo do Globoplay exige uma conta logada (gratuita ou
 * assinante). Este script abre um Chromium REAL E VISÍVEL, deixa você fazer
 * login manualmente como faria normalmente, e salva a sessão (cookies +
 * localStorage) em ~/.stream-inspector/globoplay-session.json — o server.js
 * reaproveita esse arquivo depois, em modo headless, para resolver URLs do
 * Globoplay sem pedir login de novo (até a sessão expirar, aí é só rodar
 * este script de novo). Fica FORA da pasta do repositório de propósito: um
 * `git clone`/checkout novo nunca apaga essa sessão (mesmo caminho usado
 * pelo server.js — ver DATA_DIR ali).
 *
 * Uso:
 *   node scripts/globoplay-login.js
 *
 * A sessão fica só na sua máquina (fora do repo, nunca vai pro git) — nunca
 * é enviada a lugar nenhum além do próprio Globoplay.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');

const DATA_DIR = process.env.STREAM_INSPECTOR_DATA_DIR || path.join(os.homedir(), '.stream-inspector');
const SESSION_PATH = path.join(DATA_DIR, 'globoplay-session.json');

function waitForEnter(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, () => { rl.close(); resolve(); }));
}

async function main() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    console.error('Playwright não está instalado. Rode "npm install" e depois "npx playwright install chromium" antes deste script.');
    process.exit(1);
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log('Abrindo um Chromium visível — faça login no Globoplay normalmente na janela que vai abrir.');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://globoplay.globo.com/', { waitUntil: 'domcontentloaded' });

  await waitForEnter('\nDepois de terminar o login no navegador, volte aqui e aperte Enter para salvar a sessão... ');

  await context.storageState({ path: SESSION_PATH });
  await browser.close();

  // O arquivo guarda cookies de autenticação em texto puro — restringe a
  // leitura ao dono para outros usuários locais não conseguirem lê-lo.
  try { fs.chmodSync(SESSION_PATH, 0o600); } catch { /* SO sem suporte a chmod (ex.: Windows) */ }

  console.log(`Sessão salva em ${SESSION_PATH} (modo 600 — contém credenciais, não compartilhe).`);
  console.log('Pronto — o app já pode resolver URLs do Globoplay automaticamente até essa sessão expirar.');
}

main().catch((e) => { console.error('Erro:', e.message); process.exit(1); });
