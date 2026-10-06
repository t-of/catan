// 学習用データの生成（基本ルール・4 人）。1 プロセス 1 シャード。複数プロセスを並べて回す（ai/py/loop.py が呼ぶ）。
// 使い方: node ai/gen.mjs --weights W.bin --games 100 --seed 1 --shard 0 --out data/shard-0.bin
//   --mode play（既定。自己対局）| imitate（つよい CPU 4 人の手を全部記録。ネットは使わない）
//   --past P.bin    過去の世代の重み（なければ 'past' の局も自己対局にする）
//   --mix 0.6,0.2,0.2   局の種類の割合: 自己対局（4 席とも今の重み）・過去（今の重み 1 席 + 過去 3 席）・CPU（今の重み 1 席 + つよい 3 席）
//   --keep 0.1      記録する判断の割合（合法手が 2 つ以上の判断だけが対象）。--max-turns 300（超えたら引き分け）
// 出力ファイル（リトルエンディアン）: "TOFD" | 版 u32 | N u32 | NF u32 | ACT u32 | 特徴量 f16[N·NF] | 行動 u16[N] | 選ぶ前の対数確率 f32[N] | ネットの価値（自席の勝つ確率）f32[N]
//   | 結果 f32[N]（勝ち 1・それ以外 0）| 点差 f32[N]（(自席の点 − 4 人の平均)/10）| 勝者の相対席 u8[N]（引き分けは 255）| 合法マスク u8[N·266]
//   NF = v 54·22 + e 72·6 + h 19·9 + g 63 = 1854（v|e|h|g の順）。標準出力の最後の行に集計の JSON。
import * as E from '../engine.js';
import * as CPU from '../cpu.js';
import { writeFileSync } from 'node:fs';
import { newAi, legalMask, applyAction, advance, decider, ACTION_COUNT } from './actions.js';
import { makeFeatures } from './features.js';
import { netFor, mulberry32 } from './selfplay.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const weights = arg('weights'), past = arg('past'), out = arg('out');
const games = +arg('games', 10), seed0 = +arg('seed', 1) + +arg('shard', 0) * 100000;
const mode = arg('mode', 'play'), keep = +arg('keep', 0.1), maxTurns = +arg('max-turns', 300);
const mix = arg('mix', '0.6,0.2,0.2').split(',').map(Number);
const NF = 54 * 22 + 72 * 6 + 19 * 9 + 63;

// float32 → float16（0〜1 の値だけ。丸めは最近接）
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
function toHalf(x) {
  f32[0] = x; const b = u32[0], m = b & 0x7fffff; let e = ((b >>> 23) & 0xff) - 112;
  if (e <= 0) return e < -10 ? 0 : ((m | 0x800000) >> (1 - e)) + 0x1000 >> 13;
  return e >= 31 ? 0x7c00 : (e << 10) + ((m + 0x1000) >> 13);
}
function pack(f) {
  const o = new Uint16Array(NF); let k = 0;
  for (const a of [f.v, f.e, f.h, f.g]) for (let i = 0; i < a.length; i++) o[k++] = toHalf(a[i]);
  return o;
}

const samples = [];
let nDraw = 0, nTurns = 0, nGames = 0, miss = 0;

// つよい CPU の 1 手を、合法手のどれを打った結果かで突き止める（test.mjs の方法。街道建設は 1 手で 3 判断ぶんなので記録しない）
const snap = (g) => JSON.stringify(g, (k, v) => (k === 'log' || k === 'events' ? undefined : v));
const lax = (s) => JSON.stringify(JSON.parse(s), (k, v) => (k === 'resources' && typeof v.wood === 'number' ? undefined : k === 'lastSteal' ? undefined : v));
function imitateStep(game, idx, seed, rng) {
  const mask = legalMask(game, newAi()), feat = makeFeatures(game, newAi(), mask);
  const before = JSON.stringify(game), robBefore = game.board.robberHex, key = seed * 1000 + game.turnNumber;
  E.setRng(mulberry32(key));
  if (!CPU.step(game, 'strong')) throw new Error(`cpu が進めない phase=${game.phase} seed=${seed}`);
  E.setRng(rng);
  if (game.phase === 'gameOver') return;
  if (JSON.parse(before).players[idx].devCards.some((c, i) => c.type === 'roadBuilding' && !c.played && game.players[idx].devCards[i].played)) return;
  const after = snap(game);
  for (let a = 0; a < ACTION_COUNT; a++) {
    if (!mask[a]) continue;
    const c = JSON.parse(before);
    E.setRng(mulberry32(key));
    const ok = applyAction(c, newAi(), a);
    E.setRng(rng);
    if (!ok) continue;
    const cs = snap(c);
    if (cs === after || (game.board.robberHex !== robBefore && lax(cs) === lax(after))) { samples.push({ f: pack(feat), m: mask, a, lp: 0, vp: 0, seat: idx }); return; }
  }
  miss++;
}

// 1 局。seats: 席ごとの指定（'net:重み' か 'strong'）、rec: 席ごとに記録するか
function playOne(seats, rec, seed) {
  const rng = mulberry32(seed);
  E.setRng(rng);
  const game = E.createGame(4, rng), ai = newAi(), start = samples.length;
  try {
    while (game.phase !== 'gameOver' && game.turnNumber <= maxTurns) {
      advance(game, rng);
      if (game.phase === 'gameOver') break;
      const idx = decider(game), seat = seats[idx];
      if (seat === 'strong') {
        if (game.phase === 'discard') CPU.discardFor(game, idx, 'strong');
        else if (rec[idx]) imitateStep(game, idx, seed, rng);
        else if (!CPU.step(game, 'strong')) throw new Error(`cpu が進めない phase=${game.phase} seed=${seed}`);
        continue;
      }
      const mask = legalMask(game, ai);
      const legal = [];
      for (let i = 0; i < ACTION_COUNT; i++) if (mask[i]) legal.push(i);
      if (!legal.length) throw new Error(`合法手がない phase=${game.phase} seed=${seed}`);
      let a = legal[0];
      if (legal.length > 1 || rec[idx]) {
        const feat = makeFeatures(game, ai, mask), { probs, value } = netFor(seat).forward(feat, mask);
        const u = rng();
        let c = 0;
        for (const i of legal) { c += probs[i]; a = i; if (u < c) break; }
        if (rec[idx] && legal.length > 1 && rng() < keep) samples.push({ f: pack(feat), m: mask, a, lp: Math.log(Math.max(probs[a], 1e-12)), vp: value[0], seat: idx });
      }
      if (!applyAction(game, ai, a)) throw new Error(`合法マスクの手が打てない a=${a} phase=${game.phase} seed=${seed}`);
    }
  } finally { E.setRng(null); }
  const vp = game.players.map((_, i) => E.playerScore(game, i)), mean = vp.reduce((x, y) => x + y) / 4;
  for (let i = start; i < samples.length; i++) {
    const s = samples[i];
    s.ret = game.winner === s.seat ? 1 : 0; s.dvp = (vp[s.seat] - mean) / 10;
    s.win = game.winner == null ? 255 : (game.winner - s.seat + 4) % 4;
  }
  if (game.winner == null) nDraw++;
  nTurns += game.turnNumber; nGames++;
}

const cur = weights ? 'net:' + weights : null;
for (let k = 0; k < games; k++) {
  const seed = seed0 + k, r = mulberry32(seed * 7 + 3)(), me = k % 4;
  const seats = [0, 1, 2, 3].map(() => 'strong'), rec = [false, false, false, false];
  if (mode === 'imitate') rec.fill(true);
  else if (r < mix[0] || (r < mix[0] + mix[1] && !past)) { seats.fill(cur); rec.fill(true); }
  else if (r < mix[0] + mix[1]) { seats.fill('net:' + past); seats[me] = cur; rec[me] = true; }
  else { seats[me] = cur; rec[me] = true; }
  playOne(seats, rec, seed);
}

const N = samples.length, hd = new Uint32Array([0x44464f54, 1, N, NF, ACTION_COUNT]);
const feats = new Uint16Array(N * NF), mask = new Uint8Array(N * ACTION_COUNT), act = new Uint16Array(N);
const lp = new Float32Array(N), vp = new Float32Array(N), ret = new Float32Array(N), dvp = new Float32Array(N), win = new Uint8Array(N);
samples.forEach((s, i) => { feats.set(s.f, i * NF); mask.set(s.m, i * ACTION_COUNT); act[i] = s.a; lp[i] = s.lp; vp[i] = s.vp; ret[i] = s.ret; dvp[i] = s.dvp; win[i] = s.win; });
if (out) writeFileSync(out, Buffer.concat([hd, feats, act, lp, vp, ret, dvp, win, mask].map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength))));
console.log(JSON.stringify({ games: nGames, draws: nDraw, turns: nTurns, samples: N, miss }));
