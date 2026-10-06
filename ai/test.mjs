// ai/actions.js と自己対局の自己チェック。node --test ai/test.mjs（npm test に入っている）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../engine.js';
import * as CPU from '../cpu.js';
import { newAi, legalMask, applyAction, advance, decider, ACTION_COUNT, OFF } from './actions.js';
import { playGame, mulberry32 } from './selfplay.mjs';

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
