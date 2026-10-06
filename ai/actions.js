// 自己対局・AI 用の行動空間。基本ルール・基本盤（頂点 54・辺 72・マス 19）だけを扱う。
// 局面から「合法マスク」（Uint8Array(266)）を作り、番号の手を engine.js の公開関数で打つ。設計は docs/ai-design.md の 2・3。
// 1 判断 = 1 選択。街道建設の 2 本・捨て札の 1 枚ずつは ai（newAi() の入れ物）に貯めて、そろったら engine に渡す。
import * as E from '../engine.js';

const R = E.RESOURCES;
// 番号の割り当て（各範囲の先頭）
export const OFF = {
  road: 0, settle: 72, city: 126, buy: 180, knight: 181, robber: 200,
  roadBuilding: 219, plenty: 220, monopoly: 235, trade: 240, discard: 260, end: 265,
};
export const ACTION_COUNT = 266;
const PLENTY = []; // 収穫: 資源 2 つの組（同じものを含む）15 通り
for (let i = 0; i < 5; i++) for (let j = i; j < 5; j++) PLENTY.push([R[i], R[j]]);

// 局面の外に持つ作業用の入れ物（街道建設の途中・捨て札の途中）
export function newAi() { return { rb: null, disc: null }; }

const can = (have, cost) => Object.entries(cost).every(([r, n]) => (have[r] || 0) >= n);
export const cardCount = (p) => R.reduce((a, r) => a + p.resources[r], 0);

// いま判断する席。7 の捨て札は手番の人以外も出すので、待っている先頭の人
export function decider(game) {
  if (game.phase === 'discard') return game.pendingDiscards[0].player;
  return E.currentPlayer(game);
}
// ダイスなど選ばない所を進める（運のノード）
export function advance(game, rng = Math.random) {
  while (game.phase === 'roll') E.rollDice(game, rng);
  game.events.length = 0; // 画面用の効果音の記録。自己対局では溜めない
}

// 使える発展カード（今のターンに買ったものと勝利点は使えない）の番号。なければ -1
function devIdx(game, p, type) {
  if (game.phase !== 'main' || game.devCardPlayedThisTurn) return -1;
  return p.devCards.findIndex((c) => c.type === type && !c.played && c.boughtTurn !== game.turnNumber);
}
// 奪う相手は規則で決める: 点が高く、札が多く、席が小さい人
export function robberTarget(game, hexId, idx) {
  const t = E.robberTargets(game, hexId, idx);
  if (!t.length) return undefined;
  t.sort((a, b) => E.playerScore(game, b) - E.playerScore(game, a) || cardCount(game.players[b]) - cardCount(game.players[a]) || a - b);
  return t[0];
}
// 辺の道が置けるか（作業中の 1 本目を置いたことにして調べるため、game をそのまま使う）
function roadEdges(game, idx) {
  const p = game.players[idx];
  return p.roads.length < 15 ? E.availableRoadEdges(game, idx) : [];
}

export function legalMask(game, ai) {
  const m = new Uint8Array(ACTION_COUNT);
  const ph = game.phase;
  if (ph === 'gameOver') return m;
  const idx = decider(game);
  const p = game.players[idx];
  if (ph === 'setup1' || ph === 'setup2') {
    if (game.setupPending === 'settlement') E.availableSettlementVertices(game, idx, true).forEach((v) => { m[OFF.settle + v] = 1; });
    else game.board.edges.forEach((e) => { if (e.road == null && (e.v1 === game.setupLastVertex || e.v2 === game.setupLastVertex)) m[OFF.road + e.id] = 1; });
    return m;
  }
  if (ph === 'discard') {
    const d = ai.disc || {};
    R.forEach((r, i) => { if (p.resources[r] - (d[r] || 0) > 0) m[OFF.discard + i] = 1; });
    return m;
  }
  if (ph === 'moveRobber') {
    game.board.hexes.forEach((h) => { if (h.id !== game.board.robberHex && h.terrain !== 'water') m[OFF.robber + h.id] = 1; });
    return m;
  }
  if (ph !== 'main') return m;
  if (ai.rb) { // 街道建設の続き（1 本目・2 本目）
    roadEdges(game, idx).forEach((e) => { m[OFF.road + e] = 1; });
    return m;
  }
  const res = p.resources;
  if (can(res, E.COSTS.road)) roadEdges(game, idx).forEach((e) => { m[OFF.road + e] = 1; });
  if (can(res, E.COSTS.settlement) && p.settlements.length < 5) E.availableSettlementVertices(game, idx, false).forEach((v) => { m[OFF.settle + v] = 1; });
  if (can(res, E.COSTS.city) && p.cities.length < 4) p.settlements.forEach((v) => { m[OFF.city + v] = 1; });
  if (can(res, E.COSTS.dev) && game.bank.devDeck.length) m[OFF.buy] = 1;
  if (devIdx(game, p, 'knight') >= 0) game.board.hexes.forEach((h) => { if (h.id !== game.board.robberHex && h.terrain !== 'water') m[OFF.knight + h.id] = 1; });
  if (devIdx(game, p, 'roadBuilding') >= 0 && roadEdges(game, idx).length) m[OFF.roadBuilding] = 1;
  if (devIdx(game, p, 'yearOfPlenty') >= 0) {
    PLENTY.forEach(([a, b], i) => {
      const need = { [a]: 1 }; need[b] = (need[b] || 0) + 1;
      if (can(game.bank.resources, need)) m[OFF.plenty + i] = 1;
    });
  }
  if (devIdx(game, p, 'monopoly') >= 0) R.forEach((_, i) => { m[OFF.monopoly + i] = 1; });
  R.forEach((g, gi) => {
    if (res[g] < E.playerPortRate(game, idx, g)) return;
    let k = 0;
    R.forEach((w, wi) => { if (wi === gi) return; if (game.bank.resources[w] > 0) m[OFF.trade + gi * 4 + k] = 1; k++; });
  });
  m[OFF.end] = 1;
  return m;
}

// 番号の手を打つ。打てなければ false（合法マスクで選んだ手は必ず true）。ダイスは advance で別に進める
export function applyAction(game, ai, a) {
  const idx = decider(game);
  const p = game.players[idx];
  const ph = game.phase;
  if (a < OFF.settle) { // 道
    const e = a - OFF.road;
    if (ph === 'setup1' || ph === 'setup2') return E.setupPlaceRoad(game, e);
    if (ai.rb) { // 街道建設: 1 本目は仮置き（2 本目の合法判定のため）、2 本目で engine にまとめて渡す
      const rb = ai.rb;
      if (!E.canPlaceRoad(game, e, idx)) return false;
      rb.roads.push(e);
      if (rb.roads.length === 1 && p.roads.length + 1 < 15) {
        game.board.edges[e].road = idx; p.roads.push(e);
        if (E.availableRoadEdges(game, idx).length) return true; // 2 本目を聞く
        game.board.edges[e].road = null; p.roads.pop(); // 続きの置き場がない: 1 本だけ
      } else if (rb.roads.length === 2) { game.board.edges[rb.roads[0]].road = null; p.roads.pop(); }
      else if (rb.roads.length === 1) { /* 15 本目: 1 本だけ */ }
      ai.rb = null;
      return E.playRoadBuilding(game, rb.card, rb.roads);
    }
    return E.buildRoad(game, e);
  }
  if (a < OFF.city) return E.buildSettlement(game, a - OFF.settle); // 初期配置は engine 側で setupPlaceSettlement に回る
  if (a < OFF.buy) return E.buildCity(game, a - OFF.city);
  if (a === OFF.buy) return E.buyDevCard(game);
  if (a < OFF.robber) {
    const h = a - OFF.knight;
    return E.playKnight(game, devIdx(game, p, 'knight'), h, robberTarget(game, h, idx));
  }
  if (a < OFF.roadBuilding) {
    const h = a - OFF.robber;
    return E.moveRobber(game, h, robberTarget(game, h, idx));
  }
  if (a === OFF.roadBuilding) {
    const card = devIdx(game, p, 'roadBuilding');
    if (card < 0) return false;
    ai.rb = { card, roads: [] };
    return true;
  }
  if (a < OFF.monopoly) { const [x, y] = PLENTY[a - OFF.plenty]; return E.playYearOfPlenty(game, devIdx(game, p, 'yearOfPlenty'), x, y); }
  if (a < OFF.trade) return E.playMonopoly(game, devIdx(game, p, 'monopoly'), R[a - OFF.monopoly]);
  if (a < OFF.discard) {
    const gi = Math.floor((a - OFF.trade) / 4);
    const wants = R.filter((_, i) => i !== gi);
    return E.bankTrade(game, R[gi], wants[(a - OFF.trade) % 4]);
  }
  if (a < OFF.end) {
    const r = R[a - OFF.discard];
    const d = ai.disc || (ai.disc = {});
    if (p.resources[r] - (d[r] || 0) <= 0) return false;
    d[r] = (d[r] || 0) + 1;
    const need = game.pendingDiscards[0].count;
    if (R.reduce((s, x) => s + (d[x] || 0), 0) < need) return true;
    ai.disc = null;
    return E.discardCards(game, idx, d);
  }
  return E.endTurn(game);
}
