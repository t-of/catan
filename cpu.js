'use strict';
// CPU（画面・音に触らない）。engine.js の公開関数だけを使って手を打つ。
// 使うのは step(game, level) と discardFor(game, playerIdx, level) の2つだけ。
// CPU は他の人の手札・発展カードの中身を見ない（robberTargets で見える「枚数」までは見てよい）。
import * as E from './engine.js';

export const LEVELS = [
  { id: 'weak', name: 'よわい' },
  { id: 'normal', name: 'ふつう' },
  { id: 'strong', name: 'つよい' },
];

// engine.js のタイル→資源の対応表（カードの強さを読むためだけの複製。ルールは曲げない）
const TERRAIN_RESOURCE = { forest: 'wood', hills: 'brick', pasture: 'sheep', field: 'wheat', mountains: 'ore', desert: null };

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rnd(arr.length)];
function affordable(res, cost) { return Object.entries(cost).every(([k, v]) => (res[k] || 0) >= v); }
function pip(n) { return n == null ? 0 : 6 - Math.abs(7 - n); }

// ---- 頂点・道の値打ち ----
function vertexValue(game, vid, level) {
  const v = game.board.vertices[vid];
  let score = 0;
  const resSet = new Set();
  v.hexIds.forEach((hId) => {
    const hex = game.board.hexes[hId];
    const res = TERRAIN_RESOURCE[hex.terrain];
    if (!res) return;
    score += pip(hex.number);
    resSet.add(res);
  });
  score += resSet.size * 1.5;
  if (level === 'strong' && v.port) score += v.port === '3:1' ? 0.8 : 1.5;
  return score;
}
// 道の先に、まだ誰も建てていない（距離ルールでも塞がれていない）頂点があるときだけ値打ちを付ける。
// 常に正の値を返すと、行き場のない方角にも道を延ばし続けて15本を使い切ってしまう（2人対局で詰まる原因だった）。
function roadValue(game, edgeId, idx, level) {
  const e = game.board.edges[edgeId];
  let best = 0;
  [e.v1, e.v2].forEach((vid) => {
    const v = game.board.vertices[vid];
    if (v.building) return;
    if (v.neighbors.some((n) => game.board.vertices[n].building)) return; // 距離ルールで永久に置けない
    best = Math.max(best, vertexValue(game, vid, level));
  });
  return best;
}

// ---- セットアップ（最初の開拓地と道を2周） ----
function cpuSetupStep(game, level) {
  const idx = E.currentPlayer(game);
  if (game.setupPending === 'settlement') {
    const options = E.availableSettlementVertices(game, idx, true);
    const v = level === 'weak' ? pick(options) : options.map((o) => ({ o, s: vertexValue(game, o, level) })).sort((a, b) => b.s - a.s)[0].o;
    return E.setupPlaceSettlement(game, v);
  }
  const options = game.board.vertices[game.setupLastVertex].edgeIds.filter((eId) => game.board.edges[eId].road == null);
  if (level === 'weak') return E.setupPlaceRoad(game, pick(options));
  const e = options.map((o) => ({ o, s: roadValue(game, o, idx, level) })).sort((a, b) => b.s - a.s)[0].o;
  return E.setupPlaceRoad(game, e);
}

// ---- 捨て札（7が出たとき） ----
export function discardFor(game, playerIdx, level) {
  const pending = game.pendingDiscards.find((d) => d.player === playerIdx);
  if (!pending) return false;
  const p = game.players[playerIdx];
  const obj = Object.fromEntries(E.RESOURCES.map((r) => [r, 0]));
  let remaining = pending.count;
  if (level === 'weak') {
    const pool = E.RESOURCES.flatMap((r) => Array(p.resources[r]).fill(r));
    for (let i = pool.length - 1; i > 0; i--) { const j = rnd(i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    for (let i = 0; i < remaining; i++) obj[pool[i]]++;
  } else {
    // 木・土から優先して捨て、麦・鉄（都市に要る）はなるべく残す
    const order = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
    while (remaining > 0) {
      let best = null, bestScore = -1;
      E.RESOURCES.forEach((r) => {
        const left = (p.resources[r] || 0) - obj[r];
        if (left <= 0) return;
        const score = left - order.indexOf(r) * 0.01;
        if (score > bestScore) { bestScore = score; best = r; }
      });
      if (!best) break;
      obj[best]++; remaining--;
    }
  }
  return E.discardCards(game, playerIdx, obj);
}

// ---- 盗賊 ----
function chooseRobberHex(game, idx, level) {
  const hexes = game.board.hexes.filter((h) => h.id !== game.board.robberHex);
  if (level === 'weak') return pick(hexes).id;
  const scored = hexes.map((h) => {
    let score = 0, hasOwn = false;
    const owners = new Set();
    h.vertexIds.forEach((vid) => {
      const b = game.board.vertices[vid].building;
      if (!b) return;
      if (b.owner === idx) { hasOwn = true; return; }
      owners.add(b.owner);
      score += pip(h.number) * (b.type === 'city' ? 2 : 1);
    });
    if (level === 'strong') owners.forEach((o) => { score += E.playerScore(game, o) * 1.5; });
    if (hasOwn) score -= 5;
    return { h, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].h.id;
}
function chooseRobberTarget(game, idx, hexId, level) {
  const targets = E.robberTargets(game, hexId, idx);
  if (!targets.length) return null;
  if (level === 'strong') return targets.reduce((best, t) => (E.playerScore(game, t) > E.playerScore(game, best) ? t : best));
  return pick(targets);
}

// ---- 発展カード（よわい用: ランダムに1枚使う） ----
function playableDev(game, c) { return !game.devCardPlayedThisTurn && !c.played && c.type !== 'vp' && c.boughtTurn !== game.turnNumber; }
function playRandomDev(game, idx, entries) {
  const { c, i } = pick(entries);
  if (c.type === 'knight') {
    const hex = chooseRobberHex(game, idx, 'weak');
    const target = chooseRobberTarget(game, idx, hex, 'weak');
    return E.playKnight(game, i, hex, target);
  }
  if (c.type === 'roadBuilding') return E.playRoadBuilding(game, i, E.availableRoadEdges(game, idx).slice(0, 2));
  if (c.type === 'yearOfPlenty') return E.playYearOfPlenty(game, i, pick(E.RESOURCES), pick(E.RESOURCES));
  if (c.type === 'monopoly') return E.playMonopoly(game, i, pick(E.RESOURCES));
  return false;
}

// 持っている資源で成立する銀行・港との交易（give, want の組）をすべて挙げる
function anyBankTrades(game, idx) {
  const p = game.players[idx];
  const out = [];
  E.RESOURCES.forEach((give) => {
    const rate = E.playerPortRate(game, idx, give);
    if ((p.resources[give] || 0) < rate) return;
    E.RESOURCES.forEach((want) => { if (want !== give && game.bank.resources[want] > 0) out.push([give, want]); });
  });
  return out;
}

// ---- よわい: 合法手からほぼでたらめ ----
function weakMainStep(game, idx) {
  const p = game.players[idx];
  const opts = [];
  if (p.roads.length < 15 && affordable(p.resources, E.COSTS.road) && E.availableRoadEdges(game, idx).length) opts.push('road');
  if (p.settlements.length < 5 && affordable(p.resources, E.COSTS.settlement) && E.availableSettlementVertices(game, idx, false).length) opts.push('settlement');
  if (p.cities.length < 4 && affordable(p.resources, E.COSTS.city) && E.availableCityVertices(game, idx).length) opts.push('city');
  if (game.bank.devDeck.length && affordable(p.resources, E.COSTS.dev)) opts.push('dev');
  const playable = p.devCards.map((c, i) => ({ c, i })).filter(({ c }) => playableDev(game, c));
  if (playable.length) opts.push('playdev');
  const trades = anyBankTrades(game, idx);
  if (trades.length) opts.push('trade');
  opts.push('end');
  const choice = pick(opts);
  if (choice === 'road') return E.buildRoad(game, pick(E.availableRoadEdges(game, idx)));
  if (choice === 'settlement') return E.buildSettlement(game, pick(E.availableSettlementVertices(game, idx, false)));
  if (choice === 'city') return E.buildCity(game, pick(E.availableCityVertices(game, idx)));
  if (choice === 'dev') return E.buyDevCard(game);
  if (choice === 'playdev') return playRandomDev(game, idx, playable);
  if (choice === 'trade') { const [give, want] = pick(trades); return E.bankTrade(game, give, want); }
  return E.endTurn(game);
}

// ---- ふつう・つよい共通: 建てられる中で一番得点に近いものを建てる貪欲 ----
function greedyBuild(game, idx, level) {
  const p = game.players[idx];
  const cityVs = E.availableCityVertices(game, idx);
  if (p.cities.length < 4 && cityVs.length && affordable(p.resources, E.COSTS.city)) {
    return E.buildCity(game, cityVs.slice().sort((a, b) => vertexValue(game, b, level) - vertexValue(game, a, level))[0]);
  }
  // 開拓地は、建てられる中で一番ましな場所でよい（必ず1点に近づくので、しきい値では足切りしない）
  const stlVs = E.availableSettlementVertices(game, idx, false);
  if (p.settlements.length < 5 && stlVs.length && affordable(p.resources, E.COSTS.settlement)) {
    const best = stlVs.slice().sort((a, b) => vertexValue(game, b, level) - vertexValue(game, a, level))[0];
    return E.buildSettlement(game, best);
  }
  // 道は、先にまだ誰も建てていない頂点があるときだけ（行き場のない方角には延ばさない）
  const edges = E.availableRoadEdges(game, idx);
  if (p.roads.length < 15 && edges.length && affordable(p.resources, E.COSTS.road)) {
    const scored = edges.map((e) => ({ e, s: roadValue(game, e, idx, level) })).sort((a, b) => b.s - a.s);
    if (scored[0].s > 0) return E.buildRoad(game, scored[0].e);
  }
  if (game.bank.devDeck.length && affordable(p.resources, E.COSTS.dev)) return E.buyDevCard(game);
  // ほかに何もできないときだけ、銀行・港と交易する（ふつうも、これがないと資源の偏りで詰まることがある）
  if (tryHelpfulTrade(game, idx)) return true;
  // 盤がほぼ埋まって新しい開拓地が見込めないときの最後の手: 長い交易路を狙って道だけは伸ばす
  if (p.roads.length < 15 && edges.length && affordable(p.resources, E.COSTS.road) && game.longestRoadPlayer !== idx) {
    return E.buildRoad(game, edges[0]);
  }
  return false;
}

// ---- つよい: 目標に向けて資源を貯める・港の交易・盗賊を首位へ ----
function pickTargetCost(game, idx) {
  if (E.availableCityVertices(game, idx).length) return E.COSTS.city;
  if (E.availableSettlementVertices(game, idx, false).length) return E.COSTS.settlement;
  if (E.availableRoadEdges(game, idx).length) return E.COSTS.road;
  return null;
}
function shouldPlayKnight(game, idx) {
  const p = game.players[idx];
  const robberHex = game.board.hexes[game.board.robberHex];
  if (robberHex.vertexIds.some((vid) => { const b = game.board.vertices[vid].building; return b && b.owner === idx; })) return true;
  if (p.knightsPlayed + 1 >= 3 && game.largestArmyPlayer !== idx) return true;
  const myScore = E.playerScore(game, idx);
  const leaderScore = Math.max(...game.players.map((_, i) => E.playerScore(game, i)));
  return leaderScore - myScore >= 3;
}
function bestMonopolyResource(game, idx) {
  let best = null, bestAmt = 0;
  E.RESOURCES.forEach((r) => {
    const mine = game.players[idx].resources[r] || 0;
    const others = game.players.reduce((a, pl, i) => (i === idx ? a : a + (pl.resources[r] || 0)), 0);
    if (others >= 4 && mine < 2 && others > bestAmt) { bestAmt = others; best = r; }
  });
  return best;
}
function tryHelpfulTrade(game, idx) {
  const p = game.players[idx];
  const cost = pickTargetCost(game, idx);
  if (!cost || affordable(p.resources, cost)) return false;
  const missing = Object.entries(cost).filter(([r, n]) => (p.resources[r] || 0) < n).map(([r]) => r);
  if (!missing.length) return false;
  const want = missing[0];
  for (const give of E.RESOURCES) {
    if (give === want) continue;
    const rate = E.playerPortRate(game, idx, give);
    const spare = (p.resources[give] || 0) - (cost[give] || 0);
    if (spare >= rate && game.bank.resources[want] > 0) return E.bankTrade(game, give, want);
  }
  return false;
}
// ---- 人からの交易を受けるかどうか ----
// 持っている資源と目標（pickTargetCost）に照らして、give（CPUがもらう）と get（CPUが出す）の値打ちを比べる。
// 人の手札の中身は見ない。首位に近い相手には厳しめに、よわいはほぼでたらめ（半々）。
function playerPips(game, idx, res) {
  let total = 0;
  game.board.hexes.forEach((h) => {
    if (TERRAIN_RESOURCE[h.terrain] !== res) return;
    h.vertexIds.forEach((vid) => {
      const b = game.board.vertices[vid].building;
      if (b && b.owner === idx) total += pip(h.number) * (b.type === 'city' ? 2 : 1);
    });
  });
  return total;
}
function resourceValue(game, idx, res) {
  const p = game.players[idx];
  let score = Math.max(0, 3 - playerPips(game, idx, res)); // 自分の産出が薄いほど欲しい
  const cost = pickTargetCost(game, idx);
  if (cost && cost[res] && (p.resources[res] || 0) < cost[res]) score += 2; // 今の目標に足りない分は価値が高い
  score -= Math.min(p.resources[res] || 0, 3) * 0.3; // すでに余っているほど手放しやすい
  return score;
}
export function acceptTrade(game, cpuIdx, give, get, level = 'normal') {
  const p = game.players[cpuIdx];
  if (!affordable(p.resources, get)) return false; // 持っていない資源は出せない
  if (level === 'weak') return Math.random() < 0.5;
  const gain = E.RESOURCES.reduce((a, r) => a + resourceValue(game, cpuIdx, r) * (give[r] || 0), 0);
  const cost = E.RESOURCES.reduce((a, r) => a + resourceValue(game, cpuIdx, r) * (get[r] || 0), 0);
  const proposer = E.currentPlayer(game);
  const leaderScore = Math.max(...game.players.map((_, i) => E.playerScore(game, i)));
  let margin = 0;
  if (E.playerScore(game, proposer) >= leaderScore) margin = 1.5; // 相手が首位（タイ含む）なら厳しめ
  else if (leaderScore - E.playerScore(game, proposer) <= 1) margin = 0.7;
  return gain - cost > margin;
}

function strongStep(game, idx) {
  const p = game.players[idx];
  const rb = p.devCards.findIndex((c) => c.type === 'roadBuilding' && playableDev(game, c));
  if (rb >= 0) {
    const edges = E.availableRoadEdges(game, idx);
    if (edges.length) {
      const picks = edges.map((e) => ({ e, s: roadValue(game, e, idx, 'strong') })).sort((a, b) => b.s - a.s).slice(0, 2).map((x) => x.e);
      return E.playRoadBuilding(game, rb, picks);
    }
  }
  const yop = p.devCards.findIndex((c) => c.type === 'yearOfPlenty' && playableDev(game, c));
  if (yop >= 0) {
    const cost = pickTargetCost(game, idx);
    const need = cost ? Object.entries(cost).filter(([r, n]) => (p.resources[r] || 0) < n).map(([r]) => r) : [];
    if (need.length) return E.playYearOfPlenty(game, yop, need[0], need[1] || need[0]);
  }
  const mono = p.devCards.findIndex((c) => c.type === 'monopoly' && playableDev(game, c));
  if (mono >= 0) {
    const r = bestMonopolyResource(game, idx);
    if (r) return E.playMonopoly(game, mono, r);
  }
  const knight = p.devCards.findIndex((c) => c.type === 'knight' && playableDev(game, c));
  if (knight >= 0 && shouldPlayKnight(game, idx)) {
    const hex = chooseRobberHex(game, idx, 'strong');
    const target = chooseRobberTarget(game, idx, hex, 'strong');
    return E.playKnight(game, knight, hex, target);
  }
  if (tryHelpfulTrade(game, idx)) return true;
  return false;
}

function mainStep(game, idx, level) {
  if (level === 'weak') return weakMainStep(game, idx);
  if (level === 'strong' && strongStep(game, idx)) return true;
  if (greedyBuild(game, idx, level)) return true;
  return E.endTurn(game);
}

// ---- 手番で次の1手を1つ進める。true なら何か起きた（main.js はこれを呼び続ける） ----
export function step(game, level = 'normal') {
  const phase = game.phase;
  if (phase === 'setup1' || phase === 'setup2') return cpuSetupStep(game, level);
  if (phase === 'roll') { E.rollDice(game, Math.random); return true; }
  if (phase === 'moveRobber') {
    const idx = E.currentPlayer(game);
    const hex = chooseRobberHex(game, idx, level);
    const target = chooseRobberTarget(game, idx, hex, level);
    return E.moveRobber(game, hex, target);
  }
  if (phase === 'main') return mainStep(game, E.currentPlayer(game), level);
  return false;
}
