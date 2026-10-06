// 自己対局ドライバ（基本ルール・4 人）。席ごとに 'random'（合法マスクから一様）か cpu.js の強さ（'weak' | 'normal' | 'strong'）。
// 使い方: node ai/selfplay.mjs [局数=100] [席の並び=random,random,random,random] [種=1] [打ち切りターン=300]
//   例: node ai/selfplay.mjs 100 strong,normal,normal,normal 7
// 種を固定すると、random だけの席なら同じ局が再現できる（cpu.js は Math.random を使うので再現しない）。
import * as E from '../engine.js';
import * as CPU from '../cpu.js';
import { newAi, legalMask, applyAction, advance, decider, ACTION_COUNT } from './actions.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 1 局。{ game, winner（打ち切りは null）, turns, steps }
export function playGame({ seats = ['random', 'random', 'random', 'random'], seed = 1, maxTurns = 300, onStep } = {}) {
  const rng = mulberry32(seed);
  E.setRng(rng);
  try {
    const game = E.createGame(seats.length, rng);
    const ai = newAi();
    let steps = 0;
    while (game.phase !== 'gameOver' && game.turnNumber <= maxTurns) {
      advance(game, rng);
      if (game.phase === 'gameOver') break;
      const idx = decider(game);
      const seat = seats[idx];
      if (seat === 'random') {
        const mask = legalMask(game, ai);
        const legal = [];
        for (let i = 0; i < ACTION_COUNT; i++) if (mask[i]) legal.push(i);
        if (!legal.length) throw new Error(`合法手がない phase=${game.phase} seed=${seed}`);
        const a = legal[Math.floor(rng() * legal.length)];
        if (onStep) onStep(game, ai, idx, a);
        if (!applyAction(game, ai, a)) throw new Error(`合法マスクの手が打てない a=${a} phase=${game.phase} seed=${seed}`);
      } else {
        const ok = game.phase === 'discard' ? CPU.discardFor(game, idx, seat) : CPU.step(game, seat);
        if (!ok) throw new Error(`cpu が進めない phase=${game.phase} seat=${idx} seed=${seed}`);
      }
      steps++;
    }
    return { game, winner: game.winner, turns: game.turnNumber, steps };
  } finally { E.setRng(null); }
}

// CLI
if (process.argv[1] && process.argv[1].endsWith('selfplay.mjs')) {
  const n = +(process.argv[2] || 100);
  const seats = (process.argv[3] || 'random,random,random,random').split(',');
  const seed0 = +(process.argv[4] || 1);
  const maxTurns = +(process.argv[5] || 300);
  const wins = seats.map(() => 0);
  let draws = 0, turns = 0, steps = 0;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    // 席の並びを毎局ずらして先手の差を消す
    const rot = i % seats.length;
    const rs = seats.map((_, j) => seats[(j + rot) % seats.length]);
    const r = playGame({ seats: rs, seed: seed0 + i, maxTurns });
    if (r.winner == null) draws++; else wins[(r.winner + rot) % seats.length]++;
    turns += r.turns; steps += r.steps;
  }
  const ms = performance.now() - t0;
  console.log(`${n} 局 席=${seats.join(',')} 打ち切り=${draws} 勝ち(席ごと)=${wins.join('/')} 平均ターン=${(turns / n).toFixed(1)} 平均手数=${(steps / n).toFixed(0)} 1局=${(ms / n).toFixed(1)}ms`);
}
