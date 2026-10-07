// 画面（main.js）から AI 席の 1 手を打つ入口。推論は Worker → メインスレッド → あきらめ（呼んだ側がつよい CPU で打つ）の順。
// ネットに渡すのは makeFeatures の出力（viewFor の範囲だけ）と合法マスクだけ。Worker に game 全体は渡さない。
import { newAi, legalMask, applyAction, decider, ACTION_COUNT } from './actions.js';
import { makeFeatures } from './features.js';
import { loadNet } from './net.js';

const MODEL = new URL('./model.bin', import.meta.url);
const work = new WeakMap(); // game → 街道建設・捨て札の途中の状態（newAi）
let mode = typeof Worker === 'function' ? 'worker' : 'main';
let wk = null, net = null;

// AI が扱えるのは基本ルール・4 人・基本盤だけ
export const aiSupported = (game) => game.players.length === 4 && !(game.expansions && game.expansions.length);
// AI が自分で選ぶ局面（ダイスは CPU と同じ、手番の人以外の捨て札などは呼んだ側が CPU に任せる）
export const aiCanPlay = (game, seat) => aiSupported(game) && ['setup1', 'setup2', 'main', 'moveRobber', 'discard'].includes(game.phase) && decider(game) === seat;

function viaWorker() {
  const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  let n = 0;
  const pend = new Map();
  w.onmessage = ({ data }) => { const p = pend.get(data.id); pend.delete(data.id); if (p) data.error ? p.rej(new Error(data.error)) : p.res(data.probs); };
  w.onerror = () => { pend.forEach((p) => p.rej(new Error('worker'))); pend.clear(); };
  return (feat, mask) => new Promise((res, rej) => {
    const id = ++n;
    pend.set(id, { res, rej });
    setTimeout(() => { if (pend.delete(id)) rej(new Error('timeout')); }, 15000);
    w.postMessage({ id, feat, mask });
  });
}

async function infer(feat, mask) {
  if (mode === 'worker') {
    try { wk = wk || viaWorker(); return await wk(feat, mask); } catch { mode = 'main'; }
  }
  if (mode === 'main') {
    try { net = net || await loadNet(MODEL); return net.forward(feat, mask).probs.slice(); } catch { mode = 'off'; }
  }
  throw new Error('AI の推論が使えない');
}

// game の decider(seat) の 1 手を打つ。打ったら true、stale() が真になっていたら 'stale'（何もしない）。失敗は throw（呼んだ側がつよい CPU で打つ）
export async function aiMove(game, seat, stale = () => false) {
  let ai = work.get(game);
  if (!ai) work.set(game, ai = newAi());
  const mask = legalMask(game, ai);
  const legal = [];
  for (let i = 0; i < ACTION_COUNT; i++) if (mask[i]) legal.push(i);
  if (!legal.length) throw new Error('合法手がない');
  let a = legal[0];
  if (legal.length > 1) {
    const probs = await infer(makeFeatures(game, ai, mask), mask);
    if (stale()) return 'stale';
    let u = Math.random(), c = 0;
    for (const i of legal) { c += probs[i]; a = i; if (u < c) break; }
  }
  if (!applyAction(game, ai, a)) { work.delete(game); throw new Error(`打てない手 ${a}`); }
  return true;
}
