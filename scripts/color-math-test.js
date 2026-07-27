/**
 * Teste headless da matemática de cor HDR de public/js/colorspace.js —
 * sem navegador, sem WebCodecs. Roda com `node scripts/color-math-test.js`.
 *
 * Existe porque este ambiente de desenvolvimento não decodifica HDR real
 * (nem H.264/HEVC) — a única forma de validar a fórmula é com entradas
 * sintéticas. A guarda mais importante aqui é a regressão de SDR: a curva
 * de tom só pode entrar em PQ/HLG, nunca em conteúdo SDR.
 */
'use strict';

global.window = {};
require(require('path').join(__dirname, '..', 'public', 'js', 'colorspace.js'));
const M = window.StreamColorMath;

let fails = 0;
function check(name, cond) {
  if (!cond) { fails++; console.log(`FALHOU: ${name}`); }
  else console.log(`ok: ${name}`);
}

function pqSignalForNits(nits) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) {
    const m = (lo + hi) / 2;
    (M.pqInverseEotf(m) * 10000 < nits) ? lo = m : hi = m;
  }
  return (lo + hi) / 2;
}

console.log('=== Regressão SDR (bt709 -> srgb) — deve ser idêntico ao comportamento anterior ===');
for (const [name, rgb, expected] of [
  ['branco', [1, 1, 1], [255, 255, 255]],
  ['cinza 50%', [0.2159, 0.2159, 0.2159], [128, 128, 128]],
  ['vermelho puro', [1, 0, 0], [255, 0, 0]],
  ['preto', [0, 0, 0], [0, 0, 0]],
]) {
  const out = M.contentLinearToDisplay8(rgb[0], rgb[1], rgb[2], { primaries: 'bt709', transfer: 'bt709', out: 'srgb', mode: 'tonemap' });
  check(`SDR ${name} -> ${JSON.stringify(out)}`, out.every((v, i) => Math.abs(v - expected[i]) <= 1));
}

console.log('\n=== PQ (HDR10) — branco difuso 203 nits não pode mais ser quase-preto ===');
for (const [nits, expectApprox] of [[10, 61], [100, 156], [203, 188], [1000, 236], [4000, 255]]) {
  const lin = M.pqInverseEotf(pqSignalForNits(nits));
  const out = M.contentLinearToDisplay8(lin, lin, lin, { primaries: 'bt2020', transfer: 'pq', out: 'srgb', mode: 'tonemap' });
  check(`PQ ${nits} nits -> ${JSON.stringify(out)} (esperado ~${expectApprox})`, Math.abs(out[0] - expectApprox) <= 3);
}

console.log('\n=== HLG ===');
const hlgWhite = M.hlgInverseOetf(0.75);
check(`HLG_DIFFUSE_LINEAR consistente com hlgInverseOetf(0.75)`, Math.abs(hlgWhite - M.HLG_DIFFUSE_LINEAR) < 1e-4);
const hlgOut = M.contentLinearToDisplay8(hlgWhite, hlgWhite, hlgWhite, { primaries: 'bt2020', transfer: 'hlg', out: 'srgb', mode: 'tonemap' });
check(`HLG branco difuso -> ${JSON.stringify(hlgOut)} (era 141, deve ser bem mais claro)`, hlgOut[0] > 180);

console.log('\n=== Conversão de primárias (Rec.2020 -> sRGB) — gamut largo não pode mais ser idêntico a sRGB ===');
const greenOut = M.contentLinearToDisplay8(0, 1, 0, { primaries: 'bt2020', transfer: 'bt709', out: 'srgb', mode: 'vivid' });
check(`Rec.2020 verde puro -> ${JSON.stringify(greenOut)} (não deve ser [0,255,0])`, !(greenOut[0] === 0 && greenOut[1] === 255 && greenOut[2] === 0));

console.log('\n=== Modo vivid vs tom mapeado ===');
const linLow = M.pqInverseEotf(pqSignalForNits(10));
const tonemapOut = M.contentLinearToDisplay8(linLow, linLow, linLow, { primaries: 'bt2020', transfer: 'pq', out: 'srgb', mode: 'tonemap' });
const vividOut = M.contentLinearToDisplay8(linLow, linLow, linLow, { primaries: 'bt2020', transfer: 'pq', out: 'srgb', mode: 'vivid' });
check(`vivid (${JSON.stringify(vividOut)}) >= tonemap (${JSON.stringify(tonemapOut)}) p/ sinal fraco`, vividOut[0] >= tonemapOut[0]);

console.log('\n=== Sanidade de matriz: XYZ_TO_OUT.srgb deve ser a inversa de PRIMARIES_TO_XYZ.bt709 ===');
function matMul(A, B) {
  const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) R[i][j] += A[i][k] * B[k][j];
  return R;
}
const I = matMul(M.XYZ_TO_OUT.srgb, M.PRIMARIES_TO_XYZ.bt709);
let maxOffDiag = 0, maxDiagErr = 0;
for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
  if (i === j) maxDiagErr = Math.max(maxDiagErr, Math.abs(I[i][j] - 1));
  else maxOffDiag = Math.max(maxOffDiag, Math.abs(I[i][j]));
}
check(`identidade (off-diag ${maxOffDiag.toExponential(2)}, diag err ${maxDiagErr.toExponential(2)})`, maxOffDiag < 1e-5 && maxDiagErr < 1e-5);

console.log(`\n${fails === 0 ? 'TODOS OS TESTES PASSARAM' : fails + ' TESTE(S) FALHARAM'}`);
process.exit(fails === 0 ? 0 : 1);
