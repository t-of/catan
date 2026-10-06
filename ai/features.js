// 特徴量。判断する席から見た局面を、頂点 54・辺 72・マス 19 のノード特徴と全体特徴にする（docs/ai-design.md の 4）。
// 基本ルール・4 人・基本盤だけ。隠し情報は viewFor(game, seat)（その席の画面で見える範囲）からしか読まない。
// 席は判断する人を 0 にした相対順（0=自分、1=次の手番、2、3）。値はすべて 0〜1 に収める。
import * as E from '../engine.js';
import { decider } from './actions.js';

const R = E.RESOURCES;
const NV = 54, NE = 72, NH = 19, SEATS = 4;
export const FV = 22, FE = 6, FH = 9, FG = 63; // 1 ノードあたりの特徴の数（FG は全体）
export const SIZES = { NV, NE, NH, FV, FE, FH, FG };

// 盤のつながり（基本盤は毎局同じ形）。adj[先][元] = 先のノードごとの、つながる元ノードの番号の列。ネットの情報の受け渡しに使う
const b0 = E.createGame(SEATS).board;
export const TOPO = {
  ve: b0.vertices.map((v) => v.edgeIds.slice()), vh: b0.vertices.map((v) => v.hexIds.slice()),
  ev: b0.edges.map((e) => [e.v1, e.v2]), eh: b0.edges.map((e) => e.hexIds.slice()),
  hv: b0.hexes.map((h) => h.vertexIds.slice()), he: b0.hexes.map((h) => h.edgeIds.slice()),
};

const TERRAIN = { forest: 0, hills: 1, pasture: 2, field: 3, mountains: 4, desert: 5 }; // 資源の順は E.RESOURCES（木・土・羊・麦・鉄）+ 砂漠
const pips = (n) => (n ? 6 - Math.abs(7 - n) : 0);
const f = (x, max) => Math.min(Math.max(x / max, 0), 1);
const rel = (i, me) => (i - me + SEATS) % SEATS;

// view: viewFor(game, me) の結果。mask: legalMask(game, ai)。ai: newAi()（街道建設・捨て札の途中の状態）
export function featuresFromView(view, me, mask, ai = {}) {
  if (view.players.length !== SEATS) throw new Error('4 人だけ');
  const bd = view.board, me_ = view.players[me];
  const v = new Float32Array(NV * FV), e = new Float32Array(NE * FE), h = new Float32Array(NH * FH), g = new Float32Array(FG);

  // マス: 資源 one-hot 6・数字の確率・盗賊・盗賊を置ける
  bd.hexes.forEach((x, i) => {
    const o = i * FH;
    h[o + TERRAIN[x.terrain]] = 1;
    h[o + 6] = pips(x.number) / 5;
    h[o + 7] = bd.robberHex === i ? 1 : 0;
    h[o + 8] = mask[200 + i] || mask[181 + i] ? 1 : 0;
  });
  // 頂点: 建物（4 席 × 開拓地/都市）8・接するマスの産出（資源ごと）5・港 6（5 資源 + 3:1）・置ける（開拓地・都市）2・盗賊が隣 1
  bd.vertices.forEach((x, i) => {
    const o = i * FV;
    if (x.building) v[o + rel(x.building.owner, me) * 2 + (x.building.type === 'city' ? 1 : 0)] = 1;
    x.hexIds.forEach((hid) => {
      const hx = bd.hexes[hid], ri = TERRAIN[hx.terrain];
      if (ri < 5) v[o + 8 + ri] = Math.min(v[o + 8 + ri] + pips(hx.number) / 5, 1);
      if (bd.robberHex === hid) v[o + 21] = 1;
    });
    if (x.port) v[o + 13 + (x.port === '3:1' ? 5 : R.indexOf(x.port))] = 1;
    v[o + 19] = mask[72 + i]; v[o + 20] = mask[126 + i];
  });
  // 辺: 街道（4 席）・置ける・港に面す
  bd.edges.forEach((x, i) => {
    const o = i * FE;
    if (x.road != null) e[o + rel(x.road, me)] = 1;
    e[o + 4] = mask[i];
    const p1 = bd.vertices[x.v1].port;
    e[o + 5] = p1 && p1 === bd.vertices[x.v2].port ? 1 : 0;
  });

  // 全体
  let k = 0;
  const disc = ai.disc || {};
  R.forEach((r) => { g[k++] = f(me_.resources[r] - (disc[r] || 0), 8); }); // 5 自分の手札（捨てた分は引く）
  const dev = { knight: 0, vp: 0, roadBuilding: 0, yearOfPlenty: 0, monopoly: 0 };
  let fresh = 0;
  me_.devCards.forEach((c) => { if (c.played) return; dev[c.type]++; if (c.boughtTurn === view.turnNumber) fresh++; });
  Object.keys(dev).forEach((t) => { g[k++] = f(dev[t], 5); }); // 5 未使用の発展カード
  g[k++] = f(fresh, 5); // 1 今ターンに買った（まだ使えない）
  g[k++] = f(15 - me_.roads.length, 15); g[k++] = f(5 - me_.settlements.length, 5); g[k++] = f(4 - me_.cities.length, 4); // 3 残りの建物
  R.forEach((r) => { g[k++] = f(view.bank.resources[r], 19); }); // 5 銀行の在庫
  g[k++] = f(view.bank.devDeck.length, 25); // 1 山札の残り枚数
  for (let s = 0; s < SEATS; s++) { // 20 席ごと（相対順）: 点・手札枚数・使った騎士・街道の長さ・未使用の発展カード枚数
    const pi = (me + s) % SEATS, p = view.players[pi];
    g[k++] = f(E.playerScore(view, pi), 10);
    g[k++] = f(pi === me ? R.reduce((a, r) => a + p.resources[r], 0) : p.handCount, 20);
    g[k++] = f(p.knightsPlayed, 14);
    g[k++] = f(p.roadLength, 15);
    g[k++] = f(p.devCards.filter((c) => !c.played).length, 10);
  }
  for (const owner of [view.longestRoadPlayer, view.largestArmyPlayer]) { // 10 最長路・最大騎士の持ち主（なし + 4 席）
    g[k + (owner == null ? 0 : 1 + rel(owner, me))] = 1; k += 5;
  }
  const ph = view.phase; // 6 フェイズ
  g[k + (ph === 'setup1' || ph === 'setup2' ? (view.setupPending === 'road' ? 1 : 0) : ph === 'roll' ? 2 : ph === 'main' ? 3 : ph === 'discard' ? 4 : 5)] = 1; k += 6;
  g[k++] = view.devCardPlayedThisTurn ? 1 : 0;
  g[k++] = f(view.turnNumber, 100);
  g[k++] = view.diceLast ? (view.diceLast[0] + view.diceLast[1]) / 12 : 0;
  g[k++] = view.diceLast && view.diceLast[0] + view.diceLast[1] === 7 ? 1 : 0;
  g[k++] = ai.rb ? 1 : 0; g[k++] = ai.rb ? f(ai.rb.roads.length, 2) : 0; // 街道建設の途中・置いた本数
  g[k++] = ph === 'discard' ? f(view.pendingDiscards[0].count - R.reduce((a, r) => a + (disc[r] || 0), 0), 10) : 0; // 捨てる残り枚数
  if (k !== FG) throw new Error(`FG が合わない ${k}`);
  return { v, e, h, g };
}

// game から、判断する席（decider）の見える範囲だけで作る
export function makeFeatures(game, ai, mask) {
  const me = decider(game);
  return featuresFromView(E.viewFor(game, me), me, mask, ai);
}
