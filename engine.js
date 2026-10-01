'use strict';
// カタン基本セットのルール・盤面・得点計算（画面・音・localStorage に触らない）。
// ブラウザ（main.js が import）からのみ使う。状態は 1 つのオブジェクト game に持たせ、
// 操作はすべて game を直接書き換える関数として export する（イミュータブルにはしない。1 台で交代するだけの試作のため）。
// 音を鳴らすべきこと（サイコロ・建設・盗みなど）は game.events に積む。鳴らすかどうかは main.js が決める。

export const RESOURCES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
export const RESOURCE_LABEL = { wood: '木材', brick: '土', sheep: '羊', wheat: '麦', ore: '鉄' };
export const TERRAIN_LABEL = { forest: '森', hills: '丘', pasture: '牧草', field: '畑', mountains: '山', desert: '砂漠', water: '海', gold: '金の川' };
const TERRAIN_RESOURCE = { forest: 'wood', hills: 'brick', pasture: 'sheep', field: 'wheat', mountains: 'ore', desert: null, water: null, gold: null };
const TERRAIN_COUNTS = { forest: 4, hills: 3, pasture: 4, field: 4, mountains: 3, desert: 1 };
const NUMBER_TOKENS = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];
const PORT_TYPES = ['3:1', '3:1', '3:1', '3:1', 'wood', 'brick', 'sheep', 'wheat', 'ore'];
const BANK_START = 19; // 資源1種あたりの銀行の枚数

// ---- 5〜6人拡張（公式ルール） ----
// 盤30マス（3-4-5-6-5-4-3列）・数字チップ28枚・港11か所・銀行24枚・発展カード34枚。
// 他の拡張（航海者版など）を後で足すときも、同じ createGame の options.expansions に名前を足していく形にする。
const TERRAIN_COUNTS_56 = { forest: 6, hills: 5, pasture: 6, field: 6, mountains: 5, desert: 2 };
const NUMBER_TOKENS_56 = [2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 8, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 11, 12, 12];
const PORT_TYPES_56 = ['3:1', '3:1', '3:1', '3:1', '3:1', 'wood', 'brick', 'sheep', 'wheat', 'ore', 'sheep'];
const BANK_START_56 = 24;
const DEV_COUNTS_56 = { knight: 20, vp: 5, roadBuilding: 3, yearOfPlenty: 3, monopoly: 3 };
const MAX_ROADS = 15, MAX_SETTLEMENTS = 5, MAX_CITIES = 4, MAX_SHIPS = 15;

// ---- 航海者版（公式ルールの「新しい島へ」シナリオを簡略化） ----
// 本島は3〜4人用と同じ19マス。周りを海で1周し、海の向こうに2マスずつの小島を3つ置く。
// 金の川（gold）マスは、出目が合えば持ち主が好きな資源を1枚ずつ選べる（通常の資源は出さない）。
const SEAFARERS_TERRAIN_COUNTS = { forest: 3, hills: 3, pasture: 4, field: 4, mountains: 3, desert: 1, gold: 1 }; // 19マス
const SEAFARERS_ISLAND_TERRAIN = ['pasture', 'field', 'hills', 'mountains', 'forest', 'field']; // 小島3つ×2マス
const SEAFARERS_NUMBER_EXTRA = [3, 4, 5, 9, 10, 11]; // 小島6マスぶんの数字チップ（本島分18枚に足す）
const SEAFARERS_ISLANDS = [
  [{ q: 5, r: -2 }, { q: 5, r: -3 }],
  [{ q: -3, r: 5 }, { q: -4, r: 5 }],
  [{ q: -2, r: -3 }, { q: -3, r: -2 }],
];

export const COSTS = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { wheat: 2, ore: 3 },
  dev: { sheep: 1, wheat: 1, ore: 1 },
  ship: { wood: 1, sheep: 1 },
};
const DEV_COUNTS = { knight: 14, vp: 5, roadBuilding: 2, yearOfPlenty: 2, monopoly: 2 };
export const DEV_LABEL = { knight: '騎士', vp: '勝利点', roadBuilding: '街道建設', yearOfPlenty: '収穫', monopoly: '独占' };

export const PLAYER_COLORS = ['#e0553f', '#3f7ee0', '#f0c43c', '#46a86a', '#8a5cc9', '#2bb0b0'];

const HEX_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]; // 隣の軸座標の差

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function round3(n) { return Math.round(n * 1000) / 1000; }
function emptyResources() { return { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 }; }
function sumRes(o) { return RESOURCES.reduce((a, k) => a + (o[k] || 0), 0); }
function canAfford(res, cost) { return Object.entries(cost).every(([k, v]) => (res[k] || 0) >= v); }
function payCost(res, cost) { Object.entries(cost).forEach(([k, v]) => { res[k] -= v; }); }

// ================================================================
// 盤面の生成: 軸座標の六角形（半径2 = 19枚）。頂点・辺は六角形の角の座標を
// 丸めてキーにし、隣り合うタイルで同じ頂点・辺を共有させる（重複させない）。
// ================================================================
function hexCorner(cx, cy, i) {
  const deg = 60 * i - 30; // pointy-top（頂点が上下にくる向き）
  const rad = (Math.PI / 180) * deg;
  return [round3(cx + Math.cos(rad)), round3(cy + Math.sin(rad))];
}
function hexCenter(q, r) { return [round3(Math.sqrt(3) * (q + r / 2)), round3(1.5 * r)]; }

function buildGeometry(hexes) {
  const vKeyToId = new Map();
  const vertices = [];
  const eKeyToId = new Map();
  const edges = [];
  function vertexAt(cx, cy, i) {
    const [x, y] = hexCorner(cx, cy, i);
    const key = `${x},${y}`;
    let id = vKeyToId.get(key);
    if (id == null) {
      id = vertices.length;
      vKeyToId.set(key, id);
      vertices.push({ id, x, y, hexIds: [], edgeIds: [], neighbors: [], port: null, building: null });
    }
    return id;
  }
  function edgeBetween(va, vb, hexId) {
    const key = va < vb ? `${va}-${vb}` : `${vb}-${va}`;
    let id = eKeyToId.get(key);
    if (id == null) {
      id = edges.length;
      eKeyToId.set(key, id);
      edges.push({ id, v1: va, v2: vb, hexIds: [], road: null, ship: null, shipPlacedTurn: null });
      vertices[va].edgeIds.push(id);
      vertices[vb].edgeIds.push(id);
      vertices[va].neighbors.push(vb);
      vertices[vb].neighbors.push(va);
    }
    edges[id].hexIds.push(hexId);
    return id;
  }
  hexes.forEach((hex) => {
    const [cx, cy] = hexCenter(hex.q, hex.r);
    const corners = [0, 1, 2, 3, 4, 5].map((i) => vertexAt(cx, cy, i));
    corners.forEach((va, i) => {
      const vb = corners[(i + 1) % 6];
      const eId = edgeBetween(va, vb, hex.id);
      hex.edgeIds.push(eId);
    });
    corners.forEach((vid) => { if (!vertices[vid].hexIds.includes(hex.id)) vertices[vid].hexIds.push(hex.id); });
    hex.vertexIds = corners;
  });
  return { vertices, edges };
}

// 外周の辺を、頂点でつながる順に並べる（港をだいたい等間隔に置くため）
function orderedBoundary(edges) {
  const boundary = edges.filter((e) => e.hexIds.length === 1);
  const byVertex = new Map();
  boundary.forEach((e) => {
    [e.v1, e.v2].forEach((v) => { if (!byVertex.has(v)) byVertex.set(v, []); byVertex.get(v).push(e.id); });
  });
  const order = [];
  const seen = new Set();
  let cur = boundary[0];
  let fromVertex = cur.v1;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    order.push(cur.id);
    const nextVertex = cur.v1 === fromVertex ? cur.v2 : cur.v1;
    const candidates = byVertex.get(nextVertex).filter((id) => id !== cur.id);
    const nextId = candidates[0];
    cur = boundary.find((e) => e.id === nextId);
    fromVertex = nextVertex;
  }
  return order;
}

// 3〜4人は半径2の六角形（19マス）。5〜6人拡張は3-4-5-6-5-4-3列の縦長の盤（30マス）。
function boardCoords(ext) {
  const coords = [];
  if (!ext) {
    for (let q = -2; q <= 2; q++) for (let r = -2; r <= 2; r++) if (q + r >= -2 && q + r <= 2) coords.push({ q, r });
    return coords;
  }
  for (let r = -3; r <= 3; r++) {
    const n = 6 - Math.abs(r);
    const qStart = r <= 0 ? -3 - r : -3; // 各列を左右対称に並べる
    for (let i = 0; i < n; i++) coords.push({ q: qStart + i, r });
  }
  return coords;
}

function buildBoard(rng, ext) {
  const coords = boardCoords(ext);
  const terrainCounts = ext ? TERRAIN_COUNTS_56 : TERRAIN_COUNTS;
  const numberTokens = ext ? NUMBER_TOKENS_56 : NUMBER_TOKENS;
  const portSet = ext ? PORT_TYPES_56 : PORT_TYPES;
  const terrainPool = shuffle(Object.entries(terrainCounts).flatMap(([t, n]) => Array(n).fill(t)), rng);
  const hexes = coords.map((c, i) => ({
    id: i, q: c.q, r: c.r, terrain: terrainPool[i], number: null, edgeIds: [], vertexIds: [],
  }));
  const byCoord = new Map(hexes.map((h) => [`${h.q},${h.r}`, h]));
  const neighborsOf = (h) => HEX_DIRS.map(([dq, dr]) => byCoord.get(`${h.q + dq},${h.r + dr}`)).filter(Boolean);

  const nonDesert = hexes.filter((h) => h.terrain !== 'desert');
  let attempt = 0;
  for (;;) {
    const nums = shuffle(numberTokens, rng);
    nonDesert.forEach((h, i) => { h.number = nums[i]; });
    const bad = nonDesert.some((h) => (h.number === 6 || h.number === 8)
      && neighborsOf(h).some((n) => n.number === 6 || n.number === 8));
    if (!bad || ++attempt > 500) break; // 500回試してもだめならそのまま受け入れる（実際はまず起きない）
  }
  const desert = hexes.find((h) => h.terrain === 'desert');

  const { vertices, edges } = buildGeometry(hexes);
  const boundary = orderedBoundary(edges);
  const portTypes = shuffle(portSet, rng);
  const portEdgeIds = [];
  portTypes.forEach((type, i) => {
    const edgeId = boundary[Math.round((i * boundary.length) / portTypes.length)];
    const edge = edges[edgeId];
    vertices[edge.v1].port = type;
    vertices[edge.v2].port = type;
    portEdgeIds.push(edgeId);
  });
  return { hexes, vertices, edges, robberHex: desert.id, portEdgeIds };
}

function buildDevDeck(rng, ext) {
  const counts = ext ? DEV_COUNTS_56 : DEV_COUNTS;
  return shuffle(Object.entries(counts).flatMap(([t, n]) => Array(n).fill(t)), rng);
}

// 辺が陸（道を置ける）か、海（船を置ける）かの判定。
// 陸=隣り合うマスのどれかが水以外。海=隣り合うマスのどれかが水、またはその方角にマスがない（盤の外＝外海）。
function edgeTouchesLand(edge, hexes) { return edge.hexIds.some((id) => hexes[id].terrain !== 'water'); }
function edgeTouchesSea(edge, hexes) { return edge.hexIds.length < 2 || edge.hexIds.some((id) => hexes[id].terrain === 'water'); }

// 中心から軸座標で距離 dist にある六角形の輪（本島を囲む海の輪に使う）
function ringCoords(dist) {
  const coords = [];
  for (let q = -dist; q <= dist; q++) {
    for (let r = -dist; r <= dist; r++) {
      const s = -q - r;
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(s)) === dist) coords.push({ q, r });
    }
  }
  return coords;
}

function buildSeafarersBoard(rng) {
  const mainCoords = boardCoords(false); // 本島は3〜4人用と同じ19マスの並び
  const waterCoords = ringCoords(3); // 本島を1周する海（18マス）
  const islandCoords = SEAFARERS_ISLANDS.flat(); // 小島3つ×2マス（本島から離れた外海に浮かぶ）
  let nextId = 0;
  const hexes = [];
  const landPool = shuffle(Object.entries(SEAFARERS_TERRAIN_COUNTS).flatMap(([t, n]) => Array(n).fill(t)), rng);
  mainCoords.forEach((c, i) => hexes.push({ id: nextId++, q: c.q, r: c.r, terrain: landPool[i], number: null, edgeIds: [], vertexIds: [] }));
  waterCoords.forEach((c) => hexes.push({ id: nextId++, q: c.q, r: c.r, terrain: 'water', number: null, edgeIds: [], vertexIds: [] }));
  const islandPool = shuffle(SEAFARERS_ISLAND_TERRAIN, rng);
  const islandHexIds = new Set();
  islandCoords.forEach((c, i) => { const id = nextId++; hexes.push({ id, q: c.q, r: c.r, terrain: islandPool[i], number: null, edgeIds: [], vertexIds: [] }); islandHexIds.add(id); });

  const byCoord = new Map(hexes.map((h) => [`${h.q},${h.r}`, h]));
  const neighborsOf = (h) => HEX_DIRS.map(([dq, dr]) => byCoord.get(`${h.q + dq},${h.r + dr}`)).filter(Boolean);
  const nonDesert = hexes.filter((h) => h.terrain !== 'desert' && h.terrain !== 'water');
  const numberPool = NUMBER_TOKENS.concat(SEAFARERS_NUMBER_EXTRA); // 本島18 + 小島6 = 24
  let attempt = 0;
  for (;;) {
    const nums = shuffle(numberPool, rng);
    nonDesert.forEach((h, i) => { h.number = nums[i]; });
    const bad = nonDesert.some((h) => (h.number === 6 || h.number === 8)
      && neighborsOf(h).some((n) => n.number === 6 || n.number === 8));
    if (!bad || ++attempt > 500) break;
  }
  const desert = hexes.find((h) => h.terrain === 'desert');

  const { vertices, edges } = buildGeometry(hexes);

  // 港: 陸と海の両方に接する辺（本島の海ぎわ・小島のまわり）から、頂点が重ならないように選ぶ
  const candidates = shuffle(edges.filter((e) => edgeTouchesLand(e, hexes) && edgeTouchesSea(e, hexes)), rng);
  const portTypes = shuffle(PORT_TYPES, rng);
  const portEdgeIds = [];
  const usedVertices = new Set();
  for (const e of candidates) {
    if (portEdgeIds.length >= portTypes.length) break;
    if (usedVertices.has(e.v1) || usedVertices.has(e.v2)) continue;
    const type = portTypes[portEdgeIds.length];
    vertices[e.v1].port = type; vertices[e.v2].port = type;
    usedVertices.add(e.v1); usedVertices.add(e.v2);
    portEdgeIds.push(e.id);
  }

  const waterHexes = hexes.filter((h) => h.terrain === 'water');
  const pirateHex = waterHexes[Math.floor(rng() * waterHexes.length)].id;
  return { hexes, vertices, edges, robberHex: desert.id, pirateHex, portEdgeIds, islandHexIds };
}

// ================================================================
// ゲームの作成
// options.expansions: 使う拡張の名前の配列（今は '5-6player' だけ実装。5〜6人を選ぶと自動で足される）。
// 航海者版・都市と騎士・交易と略奪を足すときも、ここに名前を増やしていく。
// ================================================================
export function createGame(playerCount, rng = Math.random, options = {}) {
  const expansions = options.expansions || (playerCount >= 5 ? ['5-6player'] : []);
  const ext = expansions.includes('5-6player');
  const seafarers = expansions.includes('seafarers');
  const board = seafarers ? buildSeafarersBoard(rng) : buildBoard(rng, ext);
  const bankStart = ext ? BANK_START_56 : BANK_START;
  const players = Array.from({ length: playerCount }, (_, i) => ({
    idx: i,
    color: PLAYER_COLORS[i],
    resources: emptyResources(),
    roads: [], settlements: [], cities: [], ships: [],
    devCards: [], // { type, boughtTurn, played }
    knightsPlayed: 0,
    roadLength: 0,
    islandBonus: false, // 航海者版: 小島に初めて開拓地を建てたら true（+2点）
  }));
  const setupOrder = Array.from({ length: playerCount }, (_, i) => i); // 1周目は順に。2周目は setup2 で逆順にする
  return {
    playerCount,
    expansions,
    players,
    board,
    bank: {
      resources: { wood: bankStart, brick: bankStart, sheep: bankStart, wheat: bankStart, ore: bankStart },
      devDeck: buildDevDeck(rng, ext),
    },
    phase: 'setup1', // setup1 → setup2 → roll → main / discard / goldPick / moveRobber / specialBuilding → gameOver
    setupOrder,
    setupIndex: 0,
    setupPending: 'settlement', // 'settlement' | 'road'
    setupLastVertex: null,
    turn: setupOrder[0],
    turnNumber: 1,
    diceLast: null,
    devCardPlayedThisTurn: false,
    shipMovedThisTurn: false, // 航海者版: 手番に船を動かせるのは1回だけ
    winTarget: seafarers ? 14 : 10,
    pendingDiscards: [], // [{ player, count }]
    pendingGoldPicks: [], // 航海者版: 金の川マスで選べる資源 [{ player, count }]
    specialBuildQueue: [], // 5〜6人拡張の特別建設フェイズ: 手番を終えた人以外が順に並ぶ
    specialBuildIdx: 0,
    longestRoadPlayer: null,
    largestArmyPlayer: null,
    winner: null,
    events: [], // 音・演出のきっかけ。main.js が読んで clear する
    log: [],
  };
}

export function currentPlayer(game) {
  if (game.phase === 'setup1' || game.phase === 'setup2') return game.setupOrder[game.setupIndex];
  if (game.phase === 'specialBuilding') return game.specialBuildQueue[game.specialBuildIdx];
  return game.turn;
}

function log(game, text) { game.log.push(text); if (game.log.length > 200) game.log.shift(); }
function fire(game, evt) { game.events.push(evt); }

// ---- 得点 ----
export function devVpCount(player) { return player.devCards.filter((c) => c.type === 'vp').length; }
export function playerScore(game, idx) {
  const p = game.players[idx];
  return p.settlements.length + p.cities.length * 2
    + (game.longestRoadPlayer === idx ? 2 : 0)
    + (game.largestArmyPlayer === idx ? 2 : 0)
    + devVpCount(p)
    + (p.islandBonus ? 2 : 0);
}
function checkWin(game, idx) {
  if (game.winner != null) return;
  if (playerScore(game, idx) >= (game.winTarget || 10)) { game.winner = idx; game.phase = 'gameOver'; fire(game, 'win'); log(game, `プレイヤー${idx + 1}の勝ち！`); }
}
// 航海者版: 小島（本島でも海でもないマス）に初めて開拓地を建てたら+2点
function markIslandBonus(game, idx, vertexId) {
  if (!game.board.islandHexIds || game.players[idx].islandBonus) return;
  const v = game.board.vertices[vertexId];
  if (!v.hexIds.some((h) => game.board.islandHexIds.has(h))) return;
  game.players[idx].islandBonus = true;
  log(game, `プレイヤー${idx + 1}が新しい島に開拓地を建てた（+2点）`);
  checkWin(game, idx);
}

// ---- 建設できる場所 ----
export function canPlaceSettlement(game, vertexId, playerIdx, isSetup) {
  const v = game.board.vertices[vertexId];
  if (v.building) return false;
  if (v.neighbors.some((n) => game.board.vertices[n].building)) return false; // 距離ルール
  if (!v.hexIds.some((h) => game.board.hexes[h].terrain !== 'water')) return false; // 海のど真ん中には置けない
  if (isSetup) return true;
  return v.edgeIds.some((eId) => { const e = game.board.edges[eId]; return e.road === playerIdx || e.ship === playerIdx; });
}
export function availableSettlementVertices(game, playerIdx, isSetup) {
  return game.board.vertices.filter((v) => canPlaceSettlement(game, v.id, playerIdx, isSetup)).map((v) => v.id);
}
export function availableCityVertices(game, playerIdx) {
  return game.players[playerIdx].settlements.slice();
}
export function canPlaceRoad(game, edgeId, playerIdx) {
  const e = game.board.edges[edgeId];
  if (e.road != null || e.ship != null) return false;
  if (!edgeTouchesLand(e, game.board.hexes)) return false;
  return [e.v1, e.v2].some((vid) => {
    const v = game.board.vertices[vid];
    if (v.building && v.building.owner === playerIdx) return true;
    return v.edgeIds.some((other) => other !== edgeId && game.board.edges[other].road === playerIdx);
  });
}
export function availableRoadEdges(game, playerIdx) {
  return game.board.edges.filter((e) => canPlaceRoad(game, e.id, playerIdx)).map((e) => e.id);
}

// ---- 船（航海者版）----
function pirateAdjacent(game, edgeId) {
  if (game.board.pirateHex == null) return false;
  return game.board.hexes[game.board.pirateHex].edgeIds.includes(edgeId);
}
export function canPlaceShip(game, edgeId, playerIdx) {
  if (game.board.pirateHex == null) return false; // 航海者版でなければ船は使わない
  const e = game.board.edges[edgeId];
  if (e.road != null || e.ship != null) return false;
  if (!edgeTouchesSea(e, game.board.hexes)) return false;
  if (pirateAdjacent(game, edgeId)) return false; // 海賊の隣には置けない
  return [e.v1, e.v2].some((vid) => {
    const v = game.board.vertices[vid];
    if (v.building && v.building.owner === playerIdx) return true;
    return v.edgeIds.some((other) => other !== edgeId && game.board.edges[other].ship === playerIdx);
  });
}
export function availableShipEdges(game, playerIdx) {
  if (game.board.pirateHex == null) return [];
  return game.board.edges.filter((e) => canPlaceShip(game, e.id, playerIdx)).map((e) => e.id);
}
export function buildShip(game, edgeId) {
  if (!canBuildNow(game)) return false;
  const idx = currentPlayer(game);
  const p = game.players[idx];
  if (p.ships.length >= MAX_SHIPS) return false;
  if (!canPlaceShip(game, edgeId, idx)) return false;
  if (!canAfford(p.resources, COSTS.ship)) return false;
  payCost(p.resources, COSTS.ship);
  RESOURCES.forEach((r) => { game.bank.resources[r] += COSTS.ship[r] || 0; });
  const e = game.board.edges[edgeId];
  e.ship = idx; e.shipPlacedTurn = game.turnNumber;
  p.ships.push(edgeId);
  fire(game, 'build');
  recalcLongestRoad(game);
  checkWin(game, idx);
  return true;
}
// 船が交易路の端にあるか（片方の頂点に、自分の他の船がなく、どちらの持ち主の建物もない）
function isShipEnd(game, edgeId, playerIdx) {
  const e = game.board.edges[edgeId];
  return [e.v1, e.v2].some((vid) => {
    const v = game.board.vertices[vid];
    if (v.building) return false;
    return !v.edgeIds.some((eid) => eid !== edgeId && game.board.edges[eid].ship === playerIdx);
  });
}
// 今動かせる自分の船（手番に1回・置いたばかりでない・列の端・海賊の隣でない）
export function movableShipEdges(game, playerIdx) {
  if (game.board.pirateHex == null || game.shipMovedThisTurn) return [];
  return game.players[playerIdx].ships.filter((eId) => {
    const e = game.board.edges[eId];
    return e.shipPlacedTurn !== game.turnNumber && isShipEnd(game, eId, playerIdx) && !pirateAdjacent(game, eId);
  });
}
// 自分の船を1隻、まだ動かしていなければ別の海の辺へ動かす（手番に1回だけ、置いたばかりの船は不可）
export function moveShip(game, fromEdgeId, toEdgeId) {
  if (!canBuildNow(game)) return false;
  const idx = currentPlayer(game);
  if (game.shipMovedThisTurn) return false;
  const e = game.board.edges[fromEdgeId];
  if (e.ship !== idx) return false;
  if (e.shipPlacedTurn === game.turnNumber) return false;
  if (!isShipEnd(game, fromEdgeId, idx)) return false;
  if (pirateAdjacent(game, fromEdgeId)) return false;
  const to = game.board.edges[toEdgeId];
  if (to.road != null || to.ship != null) return false;
  if (!edgeTouchesSea(to, game.board.hexes)) return false;
  if (pirateAdjacent(game, toEdgeId)) return false;
  const stillConnected = [to.v1, to.v2].some((vid) => {
    const v = game.board.vertices[vid];
    if (v.building && v.building.owner === idx) return true;
    return v.edgeIds.some((other) => other !== fromEdgeId && other !== toEdgeId && game.board.edges[other].ship === idx);
  });
  if (!stillConnected) return false;
  e.ship = null; e.shipPlacedTurn = null;
  to.ship = idx; to.shipPlacedTurn = game.turnNumber;
  const i = game.players[idx].ships.indexOf(fromEdgeId);
  if (i >= 0) game.players[idx].ships[i] = toEdgeId;
  game.shipMovedThisTurn = true;
  fire(game, 'build');
  recalcLongestRoad(game);
  return true;
}

// ---- セットアップ（最初の開拓地と道を2周） ----
export function setupPlaceSettlement(game, vertexId) {
  const idx = currentPlayer(game);
  if (game.phase !== 'setup1' && game.phase !== 'setup2') return false;
  if (game.setupPending !== 'settlement') return false;
  if (!canPlaceSettlement(game, vertexId, idx, true)) return false;
  game.board.vertices[vertexId].building = { owner: idx, type: 'settlement' };
  game.players[idx].settlements.push(vertexId);
  markIslandBonus(game, idx, vertexId);
  game.setupLastVertex = vertexId;
  game.setupPending = 'road';
  fire(game, 'build');
  log(game, `プレイヤー${idx + 1}が開拓地を置いた`);
  return true;
}
export function setupPlaceRoad(game, edgeId) {
  const idx = currentPlayer(game);
  if (game.phase !== 'setup1' && game.phase !== 'setup2') return false;
  if (game.setupPending !== 'road') return false;
  const e = game.board.edges[edgeId];
  if (e.road != null) return false;
  if (e.v1 !== game.setupLastVertex && e.v2 !== game.setupLastVertex) return false;
  e.road = idx;
  game.players[idx].roads.push(edgeId);
  fire(game, 'build');
  if (game.phase === 'setup2') {
    const v = game.board.vertices[game.setupLastVertex];
    v.hexIds.forEach((hId) => {
      const hex = game.board.hexes[hId];
      const res = TERRAIN_RESOURCE[hex.terrain];
      if (res) game.players[idx].resources[res]++;
    });
  }
  game.setupIndex++;
  if (game.setupIndex >= game.setupOrder.length) {
    if (game.phase === 'setup1') {
      game.phase = 'setup2';
      game.setupOrder = game.setupOrder.slice().reverse();
      game.setupIndex = 0;
    } else {
      game.phase = 'roll'; // セットアップが終わったら、最初のプレイヤー（setup1を始めた人）から通常手番
      game.turn = 0;
    }
  }
  game.setupPending = 'settlement';
  return true;
}
function advanceIdx(game, idx) { return (idx + 1) % game.playerCount; }

// ---- 資源の産出 ----
function distributeResources(game, total) {
  const demand = emptyResources();
  const contributions = [];
  const goldDemand = {}; // 金の川マス: 資源は確定させず、あとで本人に選ばせる（player → 枚数）
  game.board.hexes.forEach((hex) => {
    if (hex.number !== total || hex.id === game.board.robberHex) return;
    if (hex.terrain === 'gold') {
      hex.vertexIds.forEach((vid) => {
        const v = game.board.vertices[vid];
        if (!v.building) return;
        const amt = v.building.type === 'city' ? 2 : 1;
        goldDemand[v.building.owner] = (goldDemand[v.building.owner] || 0) + amt;
      });
      return;
    }
    const res = TERRAIN_RESOURCE[hex.terrain];
    if (!res) return;
    hex.vertexIds.forEach((vid) => {
      const v = game.board.vertices[vid];
      if (!v.building) return;
      const amt = v.building.type === 'city' ? 2 : 1;
      contributions.push({ player: v.building.owner, res, amt, hex: hex.id });
      demand[res] += amt;
    });
  });
  RESOURCES.forEach((res) => {
    if (demand[res] === 0) return;
    if (demand[res] > game.bank.resources[res]) { fire(game, 'shortage'); return; } // 銀行不足なら誰ももらえない
    contributions.filter((c) => c.res === res).forEach((c) => {
      game.players[c.player].resources[res] += c.amt;
      (game.gains ||= []).push(c); // 演出のきっかけ。main.js が読んで clear する
    });
    game.bank.resources[res] -= demand[res];
  });
  game.pendingGoldPicks = Object.entries(goldDemand).map(([player, count]) => ({ player: Number(player), count }));
}

// 金の川マスの枚数ぶん、好きな資源を選んで受け取る
export function pickGold(game, playerIdx, resources) {
  const pending = game.pendingGoldPicks.find((d) => d.player === playerIdx);
  if (!pending) return false;
  // 銀行にその資源がなければ、権利より少ない枚数しか選べない（公式ルール: 足りなければそのぶんは諦める）
  if (!Array.isArray(resources) || resources.length > pending.count) return false;
  if (resources.some((r) => !RESOURCES.includes(r))) return false;
  const need = emptyResources();
  resources.forEach((r) => { need[r]++; });
  if (!canAfford(game.bank.resources, need)) return false; // 銀行に足りなければ選び直し
  payCost(game.bank.resources, need);
  resources.forEach((r) => { game.players[playerIdx].resources[r]++; });
  game.pendingGoldPicks = game.pendingGoldPicks.filter((d) => d.player !== playerIdx);
  if (!game.pendingGoldPicks.length) game.phase = 'main';
  fire(game, 'build');
  return true;
}

export function rollDice(game, rng = Math.random) {
  if (game.phase !== 'roll') return null;
  const d1 = 1 + Math.floor(rng() * 6);
  const d2 = 1 + Math.floor(rng() * 6);
  const total = d1 + d2;
  game.diceLast = [d1, d2];
  fire(game, 'dice');
  log(game, `サイコロ: ${d1} + ${d2} = ${total}`);
  if (total === 7) {
    game.pendingDiscards = game.players
      .filter((p) => sumRes(p.resources) > 7)
      .map((p) => ({ player: game.players.indexOf(p), count: Math.floor(sumRes(p.resources) / 2) }));
    game.phase = game.pendingDiscards.length ? 'discard' : 'moveRobber';
  } else {
    distributeResources(game, total);
    game.phase = game.pendingGoldPicks.length ? 'goldPick' : 'main';
  }
  return total;
}

export function discardCards(game, playerIdx, discardObj) {
  const pending = game.pendingDiscards.find((d) => d.player === playerIdx);
  if (!pending) return false;
  const total = sumRes(discardObj);
  if (total !== pending.count) return false;
  const p = game.players[playerIdx];
  if (!canAfford(p.resources, discardObj)) return false;
  payCost(p.resources, discardObj);
  RESOURCES.forEach((r) => { game.bank.resources[r] += discardObj[r] || 0; });
  game.pendingDiscards = game.pendingDiscards.filter((d) => d.player !== playerIdx);
  if (game.pendingDiscards.length === 0) game.phase = 'moveRobber';
  return true;
}

export function robberTargets(game, hexId, playerIdx) {
  const hex = game.board.hexes[hexId];
  const owners = new Set();
  hex.vertexIds.forEach((vid) => {
    const b = game.board.vertices[vid].building;
    if (b && b.owner !== playerIdx) owners.add(b.owner);
  });
  return [...owners].filter((o) => sumRes(game.players[o].resources) > 0);
}
// 海賊（航海者版）: 隣の辺に自分以外の船がある人が対象
export function pirateTargets(game, hexId, playerIdx) {
  const hex = game.board.hexes[hexId];
  const owners = new Set();
  hex.edgeIds.forEach((eId) => {
    const e = game.board.edges[eId];
    if (e.ship != null && e.ship !== playerIdx) owners.add(e.ship);
  });
  return [...owners].filter((o) => sumRes(game.players[o].resources) > 0);
}
// マスが海なら海賊、陸なら盗賊の対象者を返す
export function banditTargets(game, hexId, playerIdx) {
  return game.board.hexes[hexId].terrain === 'water' ? pirateTargets(game, hexId, playerIdx) : robberTargets(game, hexId, playerIdx);
}
function stealFrom(game, fromIdx, toIdx) {
  const res = game.players[fromIdx].resources;
  const pool = RESOURCES.flatMap((r) => Array(res[r]).fill(r));
  if (!pool.length) return;
  const picked = pool[Math.floor(Math.random() * pool.length)];
  res[picked]--;
  game.players[toIdx].resources[picked]++;
}
export function moveRobber(game, hexId, targetPlayerIdx) {
  if (game.phase !== 'moveRobber') return false;
  const idx = currentPlayer(game);
  const hex = game.board.hexes[hexId];
  const isWater = hex.terrain === 'water';
  if (isWater && game.board.pirateHex == null) return false; // 航海者版でなければ海に動かせない
  const currentPos = isWater ? game.board.pirateHex : game.board.robberHex;
  if (hexId === currentPos) return false;
  const targets = isWater ? pirateTargets(game, hexId, idx) : robberTargets(game, hexId, idx);
  if (targets.length && !targets.includes(targetPlayerIdx)) return false;
  if (isWater) game.board.pirateHex = hexId; else game.board.robberHex = hexId;
  if (targets.length) { stealFrom(game, targetPlayerIdx, idx); log(game, `プレイヤー${idx + 1}がプレイヤー${targetPlayerIdx + 1}から1枚奪った`); }
  fire(game, 'rob');
  game.phase = 'main';
  return true;
}

// ---- 長い交易路（道と船の両方を数える） ----
function roadLengthForPlayer(game, playerIdx) {
  const edges = game.board.edges.filter((e) => e.road === playerIdx || e.ship === playerIdx);
  if (!edges.length) return 0;
  const byId = new Map(edges.map((e) => [e.id, e]));
  const kindOf = (e) => (e.road === playerIdx ? 'road' : 'ship');
  const adjacency = new Map();
  edges.forEach((e) => {
    [e.v1, e.v2].forEach((v) => { if (!adjacency.has(v)) adjacency.set(v, []); adjacency.get(v).push(e.id); });
  });
  const blocked = (vid) => {
    const b = game.board.vertices[vid].building;
    return b && b.owner !== playerIdx;
  };
  const ownBuilding = (vid) => {
    const b = game.board.vertices[vid].building;
    return b && b.owner === playerIdx;
  };
  const otherVertex = (edgeId, vid) => {
    const e = byId.get(edgeId);
    return e.v1 === vid ? e.v2 : e.v1;
  };
  function extend(vid, fromId, visited) {
    if (blocked(vid)) return 0;
    let best = 0;
    for (const eId of (adjacency.get(vid) || [])) {
      if (visited.has(eId)) continue;
      // 開拓地・都市をはさまない限り、道⇔船は乗り換えられない
      if (fromId != null && !ownBuilding(vid) && kindOf(byId.get(fromId)) !== kindOf(byId.get(eId))) continue;
      visited.add(eId);
      best = Math.max(best, 1 + extend(otherVertex(eId, vid), eId, visited));
      visited.delete(eId);
    }
    return best;
  }
  let max = 0;
  edges.forEach((e) => {
    [e.v1, e.v2].forEach((startV) => {
      const visited = new Set([e.id]);
      const len = 1 + extend(otherVertex(e.id, startV), e.id, visited);
      max = Math.max(max, len);
    });
  });
  return max;
}
function assignBonus(game, lens, threshold, key) {
  const max = Math.max(...lens);
  if (max < threshold) { game[key] = null; return; }
  const holders = lens.map((l, i) => (l === max ? i : -1)).filter((i) => i >= 0);
  if (holders.length === 1) game[key] = holders[0];
  else if (game[key] != null && holders.includes(game[key])) { /* 保持者そのまま */ }
  else game[key] = null;
}
export function recalcLongestRoad(game) {
  const lens = game.players.map((_, i) => roadLengthForPlayer(game, i));
  game.players.forEach((p, i) => { p.roadLength = lens[i]; });
  assignBonus(game, lens, 5, 'longestRoadPlayer');
}
function recalcLargestArmy(game) {
  const counts = game.players.map((p) => p.knightsPlayed);
  assignBonus(game, counts, 3, 'largestArmyPlayer');
}

// ---- 建設 ----
function canBuildNow(game) { return game.phase === 'main' || game.phase === 'specialBuilding'; }

export function buildRoad(game, edgeId, { free } = {}) {
  if (!free && !canBuildNow(game)) return false; // free はテスト用の道の直置き（長い交易路の検証など）。本来のフェイズ縛りは受けない
  const idx = currentPlayer(game);
  const p = game.players[idx];
  if (p.roads.length >= MAX_ROADS) return false;
  if (!canPlaceRoad(game, edgeId, idx)) return false;
  if (!free) { if (!canAfford(p.resources, COSTS.road)) return false; payCost(p.resources, COSTS.road); RESOURCES.forEach((r) => { game.bank.resources[r] += COSTS.road[r] || 0; }); }
  game.board.edges[edgeId].road = idx;
  p.roads.push(edgeId);
  fire(game, 'build');
  recalcLongestRoad(game);
  checkWin(game, idx);
  return true;
}
export function buildSettlement(game, vertexId) {
  const idx = currentPlayer(game);
  const p = game.players[idx];
  const isSetup = game.phase === 'setup1' || game.phase === 'setup2';
  if (isSetup) return setupPlaceSettlement(game, vertexId);
  if (!canBuildNow(game)) return false;
  if (p.settlements.length >= MAX_SETTLEMENTS) return false;
  if (!canPlaceSettlement(game, vertexId, idx, false)) return false;
  if (!canAfford(p.resources, COSTS.settlement)) return false;
  payCost(p.resources, COSTS.settlement);
  RESOURCES.forEach((r) => { game.bank.resources[r] += COSTS.settlement[r] || 0; });
  game.board.vertices[vertexId].building = { owner: idx, type: 'settlement' };
  p.settlements.push(vertexId);
  markIslandBonus(game, idx, vertexId);
  fire(game, 'build');
  recalcLongestRoad(game); // 相手の道を分断することがある
  checkWin(game, idx);
  return true;
}
export function buildCity(game, vertexId) {
  if (!canBuildNow(game)) return false;
  const idx = currentPlayer(game);
  const p = game.players[idx];
  const v = game.board.vertices[vertexId];
  if (!v.building || v.building.owner !== idx || v.building.type !== 'settlement') return false;
  if (p.cities.length >= MAX_CITIES) return false;
  if (!canAfford(p.resources, COSTS.city)) return false;
  payCost(p.resources, COSTS.city);
  RESOURCES.forEach((r) => { game.bank.resources[r] += COSTS.city[r] || 0; });
  v.building = { owner: idx, type: 'city' };
  p.settlements = p.settlements.filter((id) => id !== vertexId);
  p.cities.push(vertexId);
  fire(game, 'build');
  checkWin(game, idx);
  return true;
}

export function buyDevCard(game) {
  if (!canBuildNow(game)) return false;
  const idx = currentPlayer(game);
  const p = game.players[idx];
  if (!game.bank.devDeck.length) return false;
  if (!canAfford(p.resources, COSTS.dev)) return false;
  payCost(p.resources, COSTS.dev);
  RESOURCES.forEach((r) => { game.bank.resources[r] += COSTS.dev[r] || 0; });
  const type = game.bank.devDeck.pop();
  p.devCards.push({ type, boughtTurn: game.turnNumber, played: false });
  fire(game, 'buy-dev');
  checkWin(game, idx); // 勝利点カードで10点に届くことがある
  return true;
}

function canPlayDev(game, playerIdx, cardIdx) {
  if (game.phase !== 'main') return false; // 特別建設フェイズでは発展カードを使えない
  if (game.devCardPlayedThisTurn) return false;
  const p = game.players[playerIdx];
  const card = p.devCards[cardIdx];
  if (!card || card.played || card.type === 'vp') return false;
  return card.boughtTurn !== game.turnNumber;
}
function consumeDev(game, playerIdx, cardIdx) {
  game.players[playerIdx].devCards[cardIdx].played = true;
  game.devCardPlayedThisTurn = true;
}

export function playKnight(game, cardIdx, hexId, targetPlayerIdx) {
  const idx = currentPlayer(game);
  if (!canPlayDev(game, idx, cardIdx)) return false;
  const hex = game.board.hexes[hexId];
  const isWater = hex.terrain === 'water';
  if (isWater && game.board.pirateHex == null) return false;
  const currentPos = isWater ? game.board.pirateHex : game.board.robberHex;
  if (hexId === currentPos) return false;
  const targets = isWater ? pirateTargets(game, hexId, idx) : robberTargets(game, hexId, idx);
  if (targets.length && !targets.includes(targetPlayerIdx)) return false;
  consumeDev(game, idx, cardIdx);
  if (isWater) game.board.pirateHex = hexId; else game.board.robberHex = hexId;
  if (targets.length) stealFrom(game, targetPlayerIdx, idx);
  game.players[idx].knightsPlayed++;
  fire(game, 'rob');
  recalcLargestArmy(game);
  checkWin(game, idx);
  return true;
}
// items: 道なら辺IDのまま、船なら { id, kind: 'ship' } で渡す（航海者版: 道・船どちらでも2本）
export function playRoadBuilding(game, cardIdx, items) {
  const idx = currentPlayer(game);
  if (!canPlayDev(game, idx, cardIdx)) return false;
  consumeDev(game, idx, cardIdx);
  items.slice(0, 2).forEach((it) => {
    const id = typeof it === 'object' ? it.id : it;
    const wantShip = typeof it === 'object' && it.kind === 'ship';
    if (wantShip) {
      if (canPlaceShip(game, id, idx) && game.players[idx].ships.length < MAX_SHIPS) {
        const e = game.board.edges[id]; e.ship = idx; e.shipPlacedTurn = game.turnNumber; game.players[idx].ships.push(id);
      }
    } else if (canPlaceRoad(game, id, idx) && game.players[idx].roads.length < MAX_ROADS) {
      game.board.edges[id].road = idx; game.players[idx].roads.push(id);
    }
  });
  fire(game, 'build');
  recalcLongestRoad(game);
  checkWin(game, idx);
  return true;
}
export function playYearOfPlenty(game, cardIdx, res1, res2) {
  const idx = currentPlayer(game);
  if (!canPlayDev(game, idx, cardIdx)) return false;
  consumeDev(game, idx, cardIdx);
  [res1, res2].forEach((r) => { if (game.bank.resources[r] > 0) { game.bank.resources[r]--; game.players[idx].resources[r]++; } });
  fire(game, 'build');
  return true;
}
export function playMonopoly(game, cardIdx, res) {
  const idx = currentPlayer(game);
  if (!canPlayDev(game, idx, cardIdx)) return false;
  consumeDev(game, idx, cardIdx);
  game.players.forEach((p, i) => {
    if (i === idx) return;
    const amt = p.resources[res];
    p.resources[res] = 0;
    game.players[idx].resources[res] += amt;
  });
  fire(game, 'build');
  return true;
}

// ---- 交易 ----
export function playerPortRate(game, playerIdx, res) {
  const ports = new Set();
  const p = game.players[playerIdx];
  [...p.settlements, ...p.cities].forEach((vid) => { const port = game.board.vertices[vid].port; if (port) ports.add(port); });
  if (ports.has(res)) return 2;
  if (ports.has('3:1')) return 3;
  return 4;
}
export function bankTrade(game, giveRes, wantRes) {
  if (game.phase !== 'main') return false; // 特別建設フェイズでは交易できない
  const idx = currentPlayer(game);
  const p = game.players[idx];
  const rate = playerPortRate(game, idx, giveRes);
  if ((p.resources[giveRes] || 0) < rate) return false;
  if (game.bank.resources[wantRes] <= 0) return false;
  p.resources[giveRes] -= rate;
  game.bank.resources[giveRes] += rate;
  p.resources[wantRes]++;
  game.bank.resources[wantRes]--;
  fire(game, 'trade');
  return true;
}
export function playerTrade(game, otherIdx, give, get) {
  if (game.phase !== 'main') return false; // 特別建設フェイズでは交易できない
  const idx = currentPlayer(game);
  if (idx === otherIdx) return false;
  const a = game.players[idx], b = game.players[otherIdx];
  if (!canAfford(a.resources, give) || !canAfford(b.resources, get)) return false;
  payCost(a.resources, give); payCost(b.resources, get);
  Object.entries(give).forEach(([r, n]) => { b.resources[r] += n; });
  Object.entries(get).forEach(([r, n]) => { a.resources[r] += n; });
  fire(game, 'trade');
  return true;
}

// 手番を終えたあと、5〜6人拡張では「特別建設フェイズ」に入る。手番を終えた人以外が、
// 手番の順で1人ずつ、建てる・発展カードを買うことだけできる（交易・発展カードを使うのは不可）。
// 誰からも passSpecialBuild が来るまで続く。
function startSpecialBuilding(game) {
  const finished = game.turn;
  const queue = [];
  for (let i = 1; i < game.playerCount; i++) queue.push((finished + i) % game.playerCount);
  if (!queue.length) { advanceTurn(game); return; }
  game.specialBuildQueue = queue;
  game.specialBuildIdx = 0;
  game.phase = 'specialBuilding';
}
function advanceTurn(game) {
  game.turn = advanceIdx(game, game.turn);
  game.turnNumber++;
  game.phase = 'roll';
  game.diceLast = null;
  game.shipMovedThisTurn = false;
}
export function endTurn(game) {
  if (game.phase !== 'main') return false;
  game.devCardPlayedThisTurn = false;
  if (game.expansions && game.expansions.includes('5-6player')) startSpecialBuilding(game);
  else advanceTurn(game);
  return true;
}
export function passSpecialBuild(game) {
  if (game.phase !== 'specialBuilding') return false;
  game.specialBuildIdx++;
  if (game.specialBuildIdx >= game.specialBuildQueue.length) {
    game.turn = game.specialBuildQueue[0]; // 手番を終えた人の次の人から、普通の手番を始める
    game.specialBuildQueue = [];
    game.specialBuildIdx = 0;
    game.turnNumber++;
    game.phase = 'roll';
    game.diceLast = null;
    game.shipMovedThisTurn = false;
  }
  return true;
}
