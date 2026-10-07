// ai/actions.js と自己対局の自己チェック。node --test ai/test.mjs（npm test に入っている）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../engine.js';
import * as CPU from '../cpu.js';
import { newAi, legalMask, applyAction, advance, decider, ACTION_COUNT, OFF } from './actions.js';
import { playGame, mulberry32 } from './selfplay.mjs';
import { makeFeatures, SIZES } from './features.js';
import { createNet, initWeights, encodeWeights, decodeWeights, paramCount } from './net.js';

const snapshot = (g) => JSON.stringify(g, (k, v) => (k === 'log' || k === 'events' ? undefined : v));

test('行動空間は 266 個で範囲が重ならない', () => {
  assert.equal(ACTION_COUNT, 266);
  assert.equal(OFF.end, 265);
  assert.equal(OFF.road + 72, OFF.settle);
  assert.equal(OFF.trade + 20, OFF.discard);
});

test('ランダムな合法手だけで 4 人が決着し、マスクで選んだ手は必ず打てる（playGame が打てなければ throw）', () => {
  let discard = 0, rb = 0;
  for (let s = 1; s <= 20; s++) {
    const r = playGame({ seed: s, maxTurns: 3000, onStep: (g, ai, idx, a) => { if (a >= OFF.discard && a < OFF.end) discard++; if (a === OFF.roadBuilding) rb++; } });
    assert.notEqual(r.winner, null, `seed ${s} が決着しない`);
    assert.ok(E.playerScore(r.game, r.winner) >= 10);
  }
  assert.ok(discard > 0 && rb > 0, `捨て札 ${discard} 回・街道建設 ${rb} 回を通っていない`);
});

test('種を固定すれば同じ局が再現できる（違う種なら違う局）', () => {
  const a = playGame({ seed: 5, maxTurns: 3000 }), b = playGame({ seed: 5, maxTurns: 3000 }), c = playGame({ seed: 6, maxTurns: 3000 });
  assert.equal(snapshot(a.game), snapshot(b.game));
  assert.equal(a.steps, b.steps);
  assert.notEqual(snapshot(a.game), snapshot(c.game));
});

test('cpu.js（つよい・ふつう混在）の 1 手は、legalActions のどれかを打った結果と一致する', () => {
  let checked = 0, rbSkipped = 0;
  for (let s = 1; s <= 3; s++) {
    const rng = mulberry32(s);
    E.setRng(rng);
    const g = E.createGame(4, rng);
    const levels = ['strong', 'normal', 'strong', 'normal'];
    while (g.phase !== 'gameOver' && g.turnNumber < 300) {
      advance(g, rng);
      if (g.phase === 'gameOver') break;
      const idx = decider(g);
      if (g.phase === 'discard') { CPU.discardFor(g, idx, levels[idx]); continue; }
      const before = JSON.stringify(g);
      const mask = legalMask(g, newAi());
      const robBefore = g.board.robberHex;
      E.setRng(mulberry32(s * 1000 + g.turnNumber)); // 奪う札を同じにする
      assert.ok(CPU.step(g, levels[idx]));
      const after = snapshot(g);
      const lax = (str) => JSON.stringify(JSON.parse(str), (k, v) => (k === 'resources' && typeof v.wood === 'number' ? undefined : k === 'lastSteal' ? undefined : v));
      const usedRB = JSON.parse(before).players[idx].devCards.some((c, i) => c.type === 'roadBuilding' && !c.played && g.players[idx].devCards[i].played);
      if (usedRB) { rbSkipped++; continue; }
      let hit = false;
      for (let a = 0; a < ACTION_COUNT && !hit; a++) {
        if (!mask[a]) continue;
        const c = JSON.parse(before);
        E.setRng(mulberry32(s * 1000 + c.turnNumber));
        if (!applyAction(c, newAi(), a)) continue;
        const cs = snapshot(c);
        hit = cs === after || (g.board.robberHex !== robBefore && lax(cs) === lax(after));
      }
      if (!hit && g.phase !== 'gameOver') assert.fail(`cpu の手が合法手に一致しない seed=${s} turn=${g.turnNumber} phase=${JSON.parse(before).phase}`);
      checked++;
    }
  }
  E.setRng(null);
  assert.ok(checked > 200, `確かめた手が少ない ${checked}`);
});

// ---- 特徴量とネット（段階 2）
// ランダムに打って、数手おきに (game, ai, mask) を渡す
function samplePositions(seed, every, fn) {
  playGame({ seed, maxTurns: 3000, onStep: (g, ai, idx, a) => {
    onStepCount++;
    if (onStepCount % every === 0 && g.phase !== 'gameOver') fn(g, ai);
  } });
}
let onStepCount = 0;

test('特徴量は長さと値域が一定（0〜1・有限）', () => {
  let n = 0;
  samplePositions(11, 7, (g, ai) => {
    const f = makeFeatures(g, ai, legalMask(g, ai));
    assert.equal(f.v.length, SIZES.NV * SIZES.FV); assert.equal(f.e.length, SIZES.NE * SIZES.FE);
    assert.equal(f.h.length, SIZES.NH * SIZES.FH); assert.equal(f.g.length, SIZES.FG);
    for (const a of [f.v, f.e, f.h, f.g]) for (const x of a) assert.ok(x >= 0 && x <= 1, `範囲外 ${x}`);
    n++;
  });
  assert.ok(n > 20);
});

test('他人の手札の中身・発展カードの種類・山札の並びが違っても、特徴量は同じ（隠し情報が入らない）', () => {
  let n = 0;
  samplePositions(12, 9, (g, ai) => {
    const me = decider(g);
    const mask = legalMask(g, ai);
    const a = makeFeatures(g, ai, mask);
    const c = JSON.parse(JSON.stringify(g));
    c.players.forEach((p, i) => {
      if (i === me) return;
      const v = E.RESOURCES.map((r) => p.resources[r]);
      E.RESOURCES.forEach((r, k) => { p.resources[r] = v[(k + 1) % 5]; }); // 枚数はそのままで中身だけ入れ替える
      p.devCards.forEach((d) => { if (!d.played) d.type = d.type === 'knight' ? 'vp' : 'knight'; });
    });
    c.bank.devDeck.reverse();
    const b = makeFeatures(c, ai, legalMask(c, ai));
    for (const k of ['v', 'e', 'h', 'g']) assert.deepEqual(a[k], b[k], `${k} が違う phase=${g.phase}`);
    n++;
  });
  assert.ok(n > 20);
});

test('順伝播の出力は有限で、確率は合法手にだけつき、重みは書き出して読み戻しても同じ出力', () => {
  const w = initWeights(mulberry32(5));
  const net = createNet(w), net2 = createNet(decodeWeights(encodeWeights(w)));
  assert.ok(paramCount() > 50000 && paramCount() < 130000);
  let n = 0;
  samplePositions(13, 5, (g, ai) => {
    const mask = legalMask(g, ai), f = makeFeatures(g, ai, mask);
    const { logits, probs, value } = net.forward(f, mask);
    assert.ok(logits.every(Number.isFinite) && value.every(Number.isFinite));
    let sum = 0;
    for (let i = 0; i < ACTION_COUNT; i++) { assert.ok(mask[i] ? probs[i] > 0 : probs[i] === 0); sum += probs[i]; }
    assert.ok(Math.abs(sum - 1) < 1e-4);
    assert.ok(Math.abs(value.reduce((a, b) => a + b) - 1) < 1e-4);
    assert.deepEqual(Array.from(net2.forward(f, mask).probs), Array.from(probs));
    n++;
  });
  assert.ok(n > 30);
});

test('乱数の重みのネット席が混ざっても 4 人が決着する', () => {
  const r = playGame({ seats: ['net', 'net#2', 'random', 'random'], seed: 3, maxTurns: 3000 });
  assert.notEqual(r.winner, null);
});

test('学習済みの重み（ai/model.bin）が読めて、AI 席（brain.aiMove）で 4 人の 1 局が最後まで進む。1 手の時間も出す', async () => {
  const { readFileSync } = await import('node:fs');
  globalThis.fetch = async (u) => { const b = readFileSync(new URL(u)); return { ok: true, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; };
  const { aiMove, aiCanPlay, aiSupported } = await import('./brain.js');
  const rng = mulberry32(11);
  E.setRng(rng);
  try {
    const g = E.createGame(4, rng);
    assert.ok(aiSupported(g) && !aiSupported(E.createGame(3, rng)) && !aiSupported(E.createGame(4, rng, { expansions: ['seafarers'] })));
    let ai = 0, ms = 0, n = 0;
    for (let i = 0; i < 20000 && g.phase !== 'gameOver' && g.turnNumber < 400; i++) {
      advance(g, rng);
      if (g.phase === 'gameOver') break;
      const seat = decider(g);
      if (seat === 0 && aiCanPlay(g, seat)) {
        const t = performance.now();
        assert.equal(await aiMove(g, seat), true);
        ms += performance.now() - t; n++; ai++;
      } else assert.ok(g.phase === 'discard' ? CPU.discardFor(g, seat, 'strong') : CPU.step(g, 'strong'));
    }
    assert.ok(ai > 30, `AI の手が少ない ${ai}`);
    console.log(`AI 席: ${ai} 手、1 手 ${(ms / n).toFixed(2)}ms（メインスレッド・特徴量づくりと打つまでを含む）、局の終わり=${g.phase}`);
    assert.equal(g.phase, 'gameOver');
  } finally { E.setRng(null); }
});
