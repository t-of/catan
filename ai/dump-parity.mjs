// JS と PyTorch の順伝播の一致テスト用に、重みと局面（特徴量・マスク・出力）を書き出す。ai/py/parity.py が呼ぶ。
// 使い方: node ai/dump-parity.mjs 出力.json 重み.bin [局面の数=40]
// 重みは乱数に、偏り（b）にも乱数を足したもの（0 のままだと偏りの扱いの違いが見えないため）。
import { writeFileSync } from 'node:fs';
import { playGame, mulberry32 } from './selfplay.mjs';
import { legalMask } from './actions.js';
import { makeFeatures } from './features.js';
import { createNet, initWeights, encodeWeights } from './net.js';

const [out, wpath, n = '40'] = process.argv.slice(2);
const rng = mulberry32(5);
const w = initWeights(rng);
for (const [k, t] of Object.entries(w.tensors)) if (k.endsWith('.b')) for (let i = 0; i < t.length; i++) t[i] = (rng() - 0.5) * 0.2;
writeFileSync(wpath, Buffer.from(encodeWeights(w)));
const net = createNet(w);
const samples = [];
let c = 0;
playGame({ seed: 21, maxTurns: 3000, onStep: (g, ai) => {
  if (++c % 11 || samples.length >= +n || g.phase === 'gameOver') return;
  const mask = legalMask(g, ai), f = makeFeatures(g, ai, mask), { logits, probs, value } = net.forward(f, mask);
  samples.push({ v: [...f.v], e: [...f.e], h: [...f.h], g: [...f.g], mask: [...mask], logits: [...logits], probs: [...probs], value: [...value] });
} });
writeFileSync(out, JSON.stringify(samples));
console.log(`${samples.length} 局面`);
