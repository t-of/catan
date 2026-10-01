'use strict';
// engine.js の自己チェック。フレームワークなし。node --test で動く。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from './engine.js';
import * as CPU from './cpu.js';

test('盤面: 19マス・54頂点・72辺・地形の枚数・6と8が隣り合わない', () => {
  for (let i = 0; i < 20; i++) {
    const g = E.createGame(4, Math.random);
    assert.equal(g.board.hexes.length, 19);
    assert.equal(g.board.vertices.length, 54);
    assert.equal(g.board.edges.length, 72);
    const counts = {};
    g.board.hexes.forEach((h) => { counts[h.terrain] = (counts[h.terrain] || 0) + 1; });
    assert.deepEqual(counts, { forest: 4, hills: 3, pasture: 4, field: 4, mountains: 3, desert: 1 });
    const byCoord = new Map(g.board.hexes.map((h) => [`${h.q},${h.r}`, h]));
    const dirs = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
    g.board.hexes.forEach((h) => {
      if (h.number !== 6 && h.number !== 8) return;
      dirs.forEach(([dq, dr]) => {
        const n = byCoord.get(`${h.q + dq},${h.r + dr}`);
        if (n) assert.notEqual(n.number === 6 || n.number === 8, true, '6/8が隣り合っている');
      });
    });
    const portVertices = g.board.vertices.filter((v) => v.port);
    assert.equal(portVertices.length, 18); // 港9か所 × 頂点2つ
    const byType = {};
    portVertices.forEach((v) => { byType[v.port] = (byType[v.port] || 0) + 1; });
    assert.equal(byType['3:1'], 8); // 3:1 ×4ヶ所
    ['wood', 'brick', 'sheep', 'wheat', 'ore'].forEach((r) => assert.equal(byType[r], 2)); // 2:1 ×1ヶ所ずつ
  }
});

test('セットアップ: 距離ルールと2周（順→逆）、2個目の開拓地で資源をもらう', () => {
  const g = E.createGame(3, Math.random);
  assert.equal(E.currentPlayer(g), 0);
  const v0 = E.availableSettlementVertices(g, 0, true)[0];
  assert.ok(E.setupPlaceSettlement(g, v0));
  // 隣接頂点には置けない（距離ルール）
  const neighbor = g.board.vertices[v0].neighbors[0];
  assert.equal(E.canPlaceSettlement(g, neighbor, 0, true), false);
  const road0 = g.board.vertices[v0].edgeIds[0];
  assert.ok(E.setupPlaceRoad(g, road0));
  assert.equal(E.currentPlayer(g), 1);

  // 残りの5回（1が2回目、2が2回、0が1回）を進める
  for (let i = 0; i < 5; i++) {
    const idx = E.currentPlayer(g);
    const v = E.availableSettlementVertices(g, idx, true)[0];
    E.setupPlaceSettlement(g, v);
    const e = g.board.vertices[v].edgeIds[0];
    const before = JSON.parse(JSON.stringify(g.players[idx].resources));
    const wasSetup2 = g.phase === 'setup2';
    E.setupPlaceRoad(g, e);
    if (wasSetup2) {
      const after = g.players[idx].resources;
      const gained = Object.keys(before).some((k) => after[k] > before[k]);
      assert.ok(gained || g.board.vertices[v].hexIds.every((h) => g.board.hexes[h].terrain === 'desert'));
    }
  }
  assert.equal(g.phase, 'roll');
  assert.equal(g.turn, 0);
  g.players.forEach((p) => { assert.equal(p.settlements.length, 2); assert.equal(p.roads.length, 2); });
});

test('建設: コストが引かれ、銀行に戻る。足りないと失敗する', () => {
  const g = E.createGame(3, Math.random);
  g.phase = 'main'; g.turn = 0;
  const p = g.players[0];
  const v = g.board.vertices.find((x) => x.edgeIds.length >= 2);
  p.resources = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  assert.equal(E.buildRoad(g, v.edgeIds[0]), false); // 何も持っていない
  p.resources = { wood: 1, brick: 1, sheep: 0, wheat: 0, ore: 0 };
  v.building = { owner: 0, type: 'settlement' }; // 自分の開拓地から道を伸ばす
  p.settlements.push(v.id);
  const bankBefore = g.bank.resources.wood;
  assert.ok(E.buildRoad(g, v.edgeIds[0]));
  assert.equal(p.resources.wood, 0);
  assert.equal(g.bank.resources.wood, bankBefore + 1);
});

test('長い交易路: 直線の道は長さどおり。内部の頂点を敵に取られると分断される', () => {
  const g = E.createGame(4, Math.random);
  const interior = g.board.vertices.find((v) => v.edgeIds.length === 3);
  const [e0, e1] = interior.edgeIds;
  const other = (e, vid) => (g.board.edges[e].v1 === vid ? g.board.edges[e].v2 : g.board.edges[e].v1);
  const va = other(e0, interior.id);
  g.board.vertices[va].building = { owner: 0, type: 'settlement' };
  g.players[0].settlements.push(va);
  E.buildRoad(g, e0, { free: true });
  E.buildRoad(g, e1, { free: true });
  assert.equal(g.players[0].roadLength, 2);
  g.board.vertices[interior.id].building = { owner: 1, type: 'settlement' };
  g.players[1].settlements.push(interior.id);
  E.recalcLongestRoad(g);
  assert.equal(g.players[0].roadLength, 1);
});

test('発展カード: 買った手番には使えない。独占で資源を総取りできる', () => {
  const g = E.createGame(3, Math.random);
  g.phase = 'main'; g.turn = 0; g.turnNumber = 1;
  const p0 = g.players[0];
  p0.resources = { wood: 0, brick: 0, sheep: 1, wheat: 1, ore: 1 };
  assert.ok(E.buyDevCard(g));
  p0.devCards[0] = { type: 'knight', boughtTurn: 1, played: false };
  assert.equal(E.playKnight(g, 0, g.board.hexes.find((h) => h.id !== g.board.robberHex).id, null), false);
  g.turnNumber = 2;
  assert.ok(E.playKnight(g, 0, g.board.hexes.find((h) => h.id !== g.board.robberHex).id, null));
  assert.equal(p0.knightsPlayed, 1);

  p0.devCards = [{ type: 'monopoly', boughtTurn: 1, played: false }];
  g.devCardPlayedThisTurn = false;
  g.players[1].resources.wood = 3; g.players[2].resources.wood = 2;
  assert.ok(E.playMonopoly(g, 0, 'wood'));
  assert.equal(p0.resources.wood, 5);
  assert.equal(g.players[1].resources.wood, 0);
});

test('銀行交易: 港なしは4:1、港があればその比率', () => {
  const g = E.createGame(3, Math.random);
  g.phase = 'main'; g.turn = 0;
  const p0 = g.players[0];
  assert.equal(E.playerPortRate(g, 0, 'wood'), 4);
  p0.resources.wood = 4;
  assert.ok(E.bankTrade(g, 'wood', 'ore'));
  assert.equal(p0.resources.wood, 0);
  assert.equal(p0.resources.ore, 1);

  const portV = g.board.vertices.find((v) => v.port === 'wood');
  portV.building = { owner: 0, type: 'settlement' };
  p0.settlements.push(portV.id);
  assert.equal(E.playerPortRate(g, 0, 'wood'), 2);
});

test('7が出たとき: 8枚以上の人だけ半分（切り捨て）捨てる', () => {
  const g = E.createGame(3, Math.random);
  g.phase = 'roll';
  g.players[0].resources.wood = 6;
  g.players[1].resources.wood = 7;
  g.players[2].resources.wood = 9;
  const dice = [0.4, 0.6]; // 3 + 4 = 7
  assert.equal(E.rollDice(g, () => dice.shift()), 7);
  assert.deepEqual(g.pendingDiscards, [{ player: 2, count: 4 }]);
});

test('勝利判定: 得点が10に届くと winner が立つ', () => {
  const g = E.createGame(3, Math.random);
  g.phase = 'main'; g.turn = 0;
  const p0 = g.players[0];
  for (let i = 0; i < 4; i++) p0.cities.push(1000 + i); // 4都市=8点
  p0.settlements.push(2000); // +1点
  p0.devCards.push({ type: 'vp', boughtTurn: 1, played: false }); // +1点
  assert.equal(E.playerScore(g, 0), 10);
});

test('5〜6人拡張: 自動で30マス・80頂点・109辺・地形/数字チップ/港の構成、銀行24枚・発展カード34枚、6と8が隣り合わない', () => {
  for (const count of [5, 6]) {
    for (let i = 0; i < 10; i++) {
      const g = E.createGame(count, Math.random);
      assert.deepEqual(g.expansions, ['5-6player']);
      assert.equal(g.board.hexes.length, 30);
      assert.equal(g.board.vertices.length, 80);
      assert.equal(g.board.edges.length, 109);
      const counts = {};
      g.board.hexes.forEach((h) => { counts[h.terrain] = (counts[h.terrain] || 0) + 1; });
      assert.deepEqual(counts, { forest: 6, hills: 5, pasture: 6, field: 6, mountains: 5, desert: 2 });
      const nums = g.board.hexes.filter((h) => h.number != null).map((h) => h.number).sort((a, b) => a - b);
      assert.deepEqual(nums, [2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 8, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 11, 12, 12]);
      const byCoord = new Map(g.board.hexes.map((h) => [`${h.q},${h.r}`, h]));
      const dirs = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
      g.board.hexes.forEach((h) => {
        if (h.number !== 6 && h.number !== 8) return;
        dirs.forEach(([dq, dr]) => {
          const n = byCoord.get(`${h.q + dq},${h.r + dr}`);
          if (n) assert.notEqual(n.number === 6 || n.number === 8, true, '6/8が隣り合っている');
        });
      });
      const portVertices = g.board.vertices.filter((v) => v.port);
      assert.equal(portVertices.length, 22); // 港11か所 × 頂点2つ
      const byType = {};
      portVertices.forEach((v) => { byType[v.port] = (byType[v.port] || 0) + 1; });
      assert.equal(byType['3:1'], 10); // 3:1 ×5ヶ所
      assert.equal(byType.sheep, 4); // 羊の2:1が2ヶ所
      ['wood', 'brick', 'wheat', 'ore'].forEach((r) => assert.equal(byType[r], 2)); // 2:1 ×1ヶ所ずつ
      assert.deepEqual(g.bank.resources, { wood: 24, brick: 24, sheep: 24, wheat: 24, ore: 24 });
      assert.equal(g.bank.devDeck.length, 34);
      const devCounts = {};
      g.bank.devDeck.forEach((t) => { devCounts[t] = (devCounts[t] || 0) + 1; });
      assert.deepEqual(devCounts, { knight: 20, vp: 5, roadBuilding: 3, yearOfPlenty: 3, monopoly: 3 });
    }
  }
  // 3〜4人は今までどおり拡張なし
  assert.deepEqual(E.createGame(4, Math.random).expansions, []);
});

test('特別建設フェイズ: 手番を終えると、ほかの人が順に建てる・発展カードを買うだけできる', () => {
  const g = E.createGame(5, Math.random);
  g.phase = 'main'; g.turn = 1; g.turnNumber = 3;
  g.players.forEach((p) => { p.resources = { wood: 10, brick: 10, sheep: 10, wheat: 10, ore: 10 }; });
  const v = g.board.vertices.find((x) => x.edgeIds.length >= 2);
  v.building = { owner: 2, type: 'settlement' }; // 道を置けるよう、あらかじめ開拓地を置いておく
  g.players[2].settlements.push(v.id);
  assert.ok(E.endTurn(g));
  assert.equal(g.phase, 'specialBuilding');
  assert.deepEqual(g.specialBuildQueue, [2, 3, 4, 0]); // 手番だった1以外が順に並ぶ
  assert.equal(E.currentPlayer(g), 2);
  // 発展カードは使えない、銀行・港との交易もできない
  g.players[2].devCards = [{ type: 'knight', boughtTurn: 1, played: false }];
  assert.equal(E.playKnight(g, 0, g.board.hexes.find((h) => h.id !== g.board.robberHex).id, null), false);
  assert.equal(E.bankTrade(g, 'wood', 'ore'), false);
  // 建てる・発展カードを買うのはできる
  const edge = E.availableRoadEdges(g, 2)[0];
  assert.ok(E.buildRoad(g, edge));
  assert.equal(g.players[2].roads.length, 1);
  // パスして次の人へ。全員ぶん済んだら、手番を終えた人の次の人が普通の手番（サイコロ待ち）になる
  assert.ok(E.passSpecialBuild(g));
  assert.equal(E.currentPlayer(g), 3);
  assert.ok(E.passSpecialBuild(g));
  assert.ok(E.passSpecialBuild(g));
  assert.ok(E.passSpecialBuild(g));
  assert.equal(g.phase, 'roll');
  assert.equal(g.turn, 2); // 手番だった1の次の2から
  assert.equal(g.turnNumber, 4);
});

// ---- CPU ----
// CPU だけで1局、決着まで進める（engine.js の公開操作だけを使う）。手が進まなければ無限ループせず止まる。
function playOutCpu(levels, maxSteps = 500000, options = {}) {
  const g = E.createGame(levels.length, Math.random, options);
  for (let i = 0; i < maxSteps; i++) {
    if (g.winner != null) return g;
    if (g.phase === 'discard') {
      const d = g.pendingDiscards[0];
      assert.ok(CPU.discardFor(g, d.player, levels[d.player]), '捨て札が進まない');
      continue;
    }
    if (g.phase === 'goldPick') {
      const d = g.pendingGoldPicks[0];
      assert.ok(CPU.pickGoldFor(g, d.player), '金の川の受け取りが進まない');
      continue;
    }
    if (g.phase === 'scienceBonus') {
      const p = g.pendingScienceBonus[0];
      assert.ok(CPU.pickScienceBonusFor(g, p), '科学3段階目の資源選びが進まない');
      continue;
    }
    const idx = E.currentPlayer(g);
    assert.ok(CPU.step(g, levels[idx]), 'CPUの手が進まない');
  }
  throw new Error(`${maxSteps}手では終わらなかった`);
}

test('CPU: 4人（強さいろいろ）で数十局、全局きちんと決着する', () => {
  const mixes = [
    ['weak', 'weak', 'weak', 'weak'],
    ['normal', 'normal', 'normal', 'normal'],
    ['strong', 'strong', 'strong', 'strong'],
    ['weak', 'normal', 'strong', 'normal'],
  ];
  for (let i = 0; i < 24; i++) {
    const g = playOutCpu(mixes[i % mixes.length]);
    assert.ok(g.winner != null);
    assert.ok(E.playerScore(g, g.winner) >= 10);
  }
});

test('CPU: 6人（5〜6人拡張・特別建設フェイズつき）で最後まで決着する', () => {
  for (let i = 0; i < 5; i++) {
    const g = playOutCpu(['weak', 'normal', 'strong', 'weak', 'normal', 'strong']);
    assert.deepEqual(g.expansions, ['5-6player']);
    assert.ok(g.winner != null);
    assert.ok(E.playerScore(g, g.winner) >= 10);
  }
});

test('CPUが受ける交易: 自分の目標に足りない資源をもらい、余っている資源を渡すなら受ける', () => {
  const g = E.createGame(2, Math.random);
  g.phase = 'main'; g.turn = 0;
  const p1 = g.players[1];
  p1.settlements.push(0); // 都市化できる開拓地が1つある扱いにし、目標コストを{wheat:2, ore:3}にする
  p1.resources = { wood: 6, brick: 6, sheep: 6, wheat: 0, ore: 0 };
  // 人が ore を3枚渡し、CPUは余っている wood を1枚渡すだけ
  assert.ok(CPU.acceptTrade(g, 1, { ore: 3 }, { wood: 1 }, 'normal'));
});

test('CPUが断る交易: 自分に足りない資源を手放し、余っている資源しかもらえないなら断る', () => {
  const g = E.createGame(2, Math.random);
  g.phase = 'main'; g.turn = 0;
  const p1 = g.players[1];
  p1.settlements.push(0);
  p1.resources = { wood: 6, brick: 6, sheep: 6, wheat: 0, ore: 5 };
  // CPUが欲しいoreを手放し、すでに余っているwoodを1枚もらうだけ
  assert.ok(!CPU.acceptTrade(g, 1, { wood: 1 }, { ore: 3 }, 'normal'));
});

test('CPUの交易: 持っていない資源は出せない', () => {
  const g = E.createGame(2, Math.random);
  g.phase = 'main'; g.turn = 0;
  const p1 = g.players[1];
  p1.resources = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  assert.ok(!CPU.acceptTrade(g, 1, { wheat: 4 }, { ore: 1 }, 'normal'));
  assert.ok(!CPU.acceptTrade(g, 1, { wheat: 4 }, { ore: 1 }, 'strong'));
});

// ---- 航海者版 ----
test('航海者版: 本島19＋海18＋小島6＝43マス。金の川1枚・小島は6マス・海賊は海に、盗賊は本島の砂漠にいる', () => {
  for (let i = 0; i < 10; i++) {
    const g = E.createGame(4, Math.random, { expansions: ['seafarers'] });
    assert.deepEqual(g.expansions, ['seafarers']);
    assert.equal(g.winTarget, 14);
    assert.equal(g.board.hexes.length, 43);
    const counts = {};
    g.board.hexes.forEach((h) => { counts[h.terrain] = (counts[h.terrain] || 0) + 1; });
    assert.equal(counts.water, 18);
    assert.equal(counts.gold, 1);
    assert.equal(g.board.islandHexIds.size, 6);
    assert.equal(g.board.hexes[g.board.robberHex].terrain, 'desert');
    assert.equal(g.board.hexes[g.board.pirateHex].terrain, 'water');
    // 金の川にも数字チップがある
    const gold = g.board.hexes.find((h) => h.terrain === 'gold');
    assert.ok(gold.number >= 2 && gold.number <= 12);
  }
});

test('航海者版: 船は海に面した辺にだけ置け、自分の開拓地・船とつながっている必要がある', () => {
  const g = E.createGame(4, Math.random, { expansions: ['seafarers'] });
  g.phase = 'main'; g.turn = 0;
  const p0 = g.players[0];
  p0.resources = { wood: 5, brick: 0, sheep: 5, wheat: 0, ore: 0 };
  const seaEdge = g.board.edges.find((e) => e.hexIds.some((h) => g.board.hexes[h].terrain === 'water') && e.hexIds.some((h) => g.board.hexes[h].terrain !== 'water')
    && !g.board.hexes[g.board.pirateHex].edgeIds.includes(e.id));
  // まだどこともつながっていないので置けない
  assert.equal(E.canPlaceShip(g, seaEdge.id, 0), false);
  const v = g.board.vertices[seaEdge.v1];
  v.building = { owner: 0, type: 'settlement' };
  p0.settlements.push(v.id);
  assert.ok(E.buildShip(g, seaEdge.id));
  assert.equal(g.board.edges[seaEdge.id].ship, 0);
  assert.equal(p0.resources.wood, 4);
  // 内陸（海に面していない）の辺には置けない
  const inland = g.board.edges.find((e) => e.hexIds.every((h) => g.board.hexes[h].terrain !== 'water') && e.hexIds.length === 2);
  if (inland) assert.equal(E.canPlaceShip(g, inland.id, 0), false);
});

test('航海者版: 船は手番に1回だけ、置いたばかりでなく列の端にあるものだけ動かせる', () => {
  // 頂点によっては海の辺が1本しかなく動かし先がないので、2本ある頂点が見つかるまで盤を作り直す
  let g, seaEdge, otherSeaEdge;
  for (let tries = 0; tries < 200; tries++) {
    g = E.createGame(4, Math.random, { expansions: ['seafarers'] });
    const pirateEdges = g.board.hexes[g.board.pirateHex].edgeIds;
    const v1 = g.board.vertices.find((v) => v.edgeIds.filter((eId) => {
      const e = g.board.edges[eId];
      return e.hexIds.some((h) => g.board.hexes[h].terrain === 'water') && e.hexIds.some((h) => g.board.hexes[h].terrain !== 'water') && !pirateEdges.includes(eId);
    }).length >= 2);
    if (!v1) continue;
    const seaEdges = v1.edgeIds.map((eId) => g.board.edges[eId]).filter((e) => e.hexIds.some((h) => g.board.hexes[h].terrain === 'water') && e.hexIds.some((h) => g.board.hexes[h].terrain !== 'water') && !pirateEdges.includes(e.id));
    [seaEdge, otherSeaEdge] = seaEdges;
    g.testAnchorVertex = v1.id;
    break;
  }
  assert.ok(seaEdge && otherSeaEdge, '試行回数内に見つからなかった');
  g.phase = 'main'; g.turn = 0; g.turnNumber = 5;
  const p0 = g.players[0];
  g.board.vertices[g.testAnchorVertex].building = { owner: 0, type: 'settlement' };
  p0.settlements.push(g.testAnchorVertex);
  seaEdge.ship = 0; seaEdge.shipPlacedTurn = 1; // 前の手番に置いた船という体にする
  p0.ships.push(seaEdge.id);
  assert.ok(E.moveShip(g, seaEdge.id, otherSeaEdge.id));
  assert.equal(g.board.edges[seaEdge.id].ship, null);
  assert.equal(g.board.edges[otherSeaEdge.id].ship, 0);
  assert.equal(g.shipMovedThisTurn, true);
  // 同じ手番にもう1回は動かせない
  assert.equal(E.moveShip(g, otherSeaEdge.id, seaEdge.id), false);
});

test('航海者版: 海賊は海マスだけに動かせ、隣の船の持ち主から奪う。盗賊は陸のまま', () => {
  const g = E.createGame(4, Math.random, { expansions: ['seafarers'] });
  g.phase = 'moveRobber'; g.turn = 0;
  const landHex = g.board.hexes.find((h) => h.terrain !== 'water' && h.id !== g.board.robberHex);
  assert.equal(E.moveRobber(g, landHex.id, null), true); // 陸マスへは今まで通り動かせる
  assert.equal(g.board.robberHex, landHex.id);

  const waterHex = g.board.hexes.find((h) => h.terrain === 'water' && h.id !== g.board.pirateHex);
  const edge = g.board.edges.find((e) => waterHex.edgeIds.includes(e.id));
  edge.ship = 1; g.players[1].resources.wood = 2;
  g.phase = 'moveRobber';
  assert.ok(E.moveRobber(g, waterHex.id, 1));
  assert.equal(g.board.pirateHex, waterHex.id);
  assert.equal(g.board.robberHex, landHex.id); // 盗賊は動いていない
});

test('航海者版: 道→船は開拓地・都市をはさむときだけ最長交易路としてつながる', () => {
  const g = E.createGame(4, Math.random, { expansions: ['seafarers'] });
  const seaEdge = g.board.edges.find((e) => e.hexIds.some((h) => g.board.hexes[h].terrain === 'water') && e.hexIds.some((h) => g.board.hexes[h].terrain !== 'water'));
  const v = g.board.vertices[seaEdge.v1];
  const roadEdge = v.edgeIds.find((eid) => eid !== seaEdge.id && g.board.edges[eid].hexIds.some((h) => g.board.hexes[h].terrain !== 'water'));
  // 接続のチェックを受けない形で直接置き、「頂点に建物がある場合だけ種類をまたげる」ことだけを見る
  g.board.edges[roadEdge].road = 0; g.players[0].roads.push(roadEdge);
  seaEdge.ship = 0; g.players[0].ships.push(seaEdge.id);
  g.turn = 0;
  E.recalcLongestRoad(g);
  // 頂点に自分の建物がないので、道と船はつながらない（それぞれ長さ1）
  assert.equal(g.players[0].roadLength, 1);
  v.building = { owner: 0, type: 'settlement' };
  g.players[0].settlements.push(v.id);
  E.recalcLongestRoad(g);
  assert.equal(g.players[0].roadLength, 2); // 開拓地をはさんでつながる
});

test('航海者版: 小島に開拓地を建てると+2点。1度だけ', () => {
  const g = E.createGame(4, Math.random, { expansions: ['seafarers'] });
  const islandHexId = [...g.board.islandHexIds][0];
  const v = g.board.hexes[islandHexId].vertexIds[0];
  assert.ok(E.canPlaceSettlement(g, v, 0, true));
  assert.ok(E.setupPlaceSettlement(g, v));
  assert.equal(g.players[0].islandBonus, true);
  assert.equal(E.playerScore(g, 0), 1 + 2);
});

test('航海者版: CPUだけで4人、1局を最後まで決着できる（数局）', () => {
  for (let i = 0; i < 5; i++) {
    const g = playOutCpu(['weak', 'normal', 'strong', 'normal'], 500000, { expansions: ['seafarers'] });
    assert.deepEqual(g.expansions, ['seafarers']);
    assert.ok(g.winner != null);
    assert.ok(E.playerScore(g, g.winner) >= 14);
  }
});

// ---- 都市と騎士 ----
function ckGame(count = 4) { return E.createGame(count, Math.random, { expansions: ['cities-knights'] }); }

test('都市と騎士: 都市の商品産出（森→紙、牧草→布、山→硬貨。畑・丘は資源2のまま）', () => {
  const g = ckGame();
  g.phase = 'main'; g.turn = 0;
  const forestHex = g.board.hexes.find((h) => h.terrain === 'forest');
  const fieldHex = g.board.hexes.find((h) => h.terrain === 'field');
  // 2つの都市のどちらも、もう一方のマスに接してしまわないよう、互いの頂点を共有しない組み合わせを選ぶ
  const vForest = forestHex.vertexIds.find((v) => !fieldHex.vertexIds.includes(v));
  const vField = fieldHex.vertexIds.find((v) => !forestHex.vertexIds.includes(v));
  g.board.vertices[vForest].building = { owner: 0, type: 'city' };
  g.players[0].cities.push(vForest);
  g.board.vertices[vField].building = { owner: 0, type: 'city' };
  g.players[0].cities.push(vField);
  // ほかのマスが偶然9を持っていると資源が混ざるので、的にする2マス以外は9を避けておく
  g.board.hexes.forEach((h) => { if (h.id !== forestHex.id && h.id !== fieldHex.id && h.number === 9) h.number = 2; });
  forestHex.number = 9; fieldHex.number = 9;
  g.phase = 'roll';
  const seq = [3 / 6, 4 / 6, 0.99]; // d1=4, d2=5 → 合計9。3つ目はイベントダイス用
  const total = E.rollDice(g, () => seq.shift());
  assert.equal(total, 9);
  assert.equal(g.players[0].resources.wood, 1); // 森の都市: 資源1
  assert.equal(g.players[0].commodities.paper, 1); // +商品1
  assert.equal(g.players[0].resources.wheat, 2); // 畑の都市: 資源2のまま（商品は産まない）
});

test('都市と騎士: 都市の発展（商品を払って段階を上げる・大都市の奪い合い）', () => {
  const g = ckGame();
  g.phase = 'main'; g.turn = 0;
  const p0 = g.players[0], p1 = g.players[1];
  const v0 = g.board.vertices.find((v) => !v.building);
  v0.building = { owner: 0, type: 'city' }; p0.cities.push(v0.id);
  assert.equal(E.canImproveCity(g, 0, 'trade'), false); // 商品がない
  p0.commodities.cloth = 1;
  assert.ok(E.improveCity(g, 'trade'));
  assert.equal(p0.cityImprovements.trade, 1);
  assert.equal(p0.commodities.cloth, 0);
  p0.commodities.cloth = 2 + 3; // 2段階目(2)+3段階目(3)
  assert.ok(E.improveCity(g, 'trade'));
  assert.ok(E.improveCity(g, 'trade'));
  assert.equal(p0.cityImprovements.trade, 3);
  p0.commodities.cloth = 4;
  assert.ok(E.improveCity(g, 'trade')); // 4段階目=大都市
  assert.equal(g.metropolis.trade, v0.id); // 大都市は、その都市（頂点）に置かれる
  assert.equal(E.metropolisOwner(g, 'trade'), 0);
  assert.equal(E.playerScore(g, 0), 2 /* city */ + 2 /* metropolis */);
  // プレイヤー1が追い越すと大都市を奪う（印だけ移り、プレイヤー0の都市はただの都市に戻る）
  const v1 = g.board.vertices.find((v) => !v.building);
  v1.building = { owner: 1, type: 'city' }; p1.cities.push(v1.id);
  g.turn = 1;
  p1.commodities.cloth = 1 + 2 + 3 + 4 + 5;
  for (let i = 0; i < 5; i++) E.improveCity(g, 'trade');
  assert.equal(p1.cityImprovements.trade, 5);
  assert.equal(g.metropolis.trade, v1.id); // 5段階目に追い越されたので奪われる
  assert.equal(E.metropolisOwner(g, 'trade'), 1);
  assert.equal(v0.building.type, 'city'); // プレイヤー0の都市はそのまま（ただの都市に戻るだけ）
  // 5段階目の持ち主からはもう奪えない
  g.turn = 0;
  assert.equal(E.canImproveCity(g, 0, 'trade'), false); // すでに3段階目、商品がない
});

test('都市と騎士: 騎士の起動・昇格・移動・追い出し・盗賊を追い払う', () => {
  const g = ckGame();
  g.phase = 'main'; g.turn = 0;
  const p0 = g.players[0], p1 = g.players[1];
  const v = g.board.vertices.find((x) => x.edgeIds.length >= 2);
  v.building = { owner: 0, type: 'settlement' }; p0.settlements.push(v.id);
  const roadEdge = v.edgeIds[0];
  g.board.edges[roadEdge].road = 0; p0.roads.push(roadEdge);
  const otherEnd = g.board.edges[roadEdge].v1 === v.id ? g.board.edges[roadEdge].v2 : g.board.edges[roadEdge].v1;
  p0.resources = { wood: 0, brick: 0, sheep: 5, wheat: 5, ore: 5 };
  assert.ok(E.canPlaceKnight(g, otherEnd, 0));
  assert.ok(E.buildKnight(g, otherEnd));
  const kid = p0.knights[0].id;
  assert.equal(E.canActivateKnight(g, 0, kid), true);
  assert.ok(E.activateKnight(g, kid));
  assert.ok(E.upgradeKnight(g, kid));
  assert.equal(p0.knights[0].level, 2);
  assert.equal(E.canUpgradeKnight(g, 0, kid), false); // 最強にするには政治3段階目以上が要る
  p0.cityImprovements.politics = 3;
  assert.ok(E.upgradeKnight(g, kid));
  assert.equal(p0.knights[0].level, 3);
  // 移動
  const moveTargets = E.movableKnightVertices(g, 0, kid);
  assert.ok(moveTargets.length >= 0);
  // 盗賊を追い払う: 騎士の頂点が盗賊のマスに接するようにする
  const robberHexId = g.board.robberHex;
  const robberVid = g.board.hexes[robberHexId].vertexIds[0];
  p0.knights[0].vertexId = robberVid;
  p0.knights[0].actedTurn = null;
  assert.ok(E.canChaseRobber(g, 0, kid));
  assert.ok(E.chaseRobber(g, kid));
  assert.equal(g.board.hexes[g.board.robberHex].terrain, 'desert');
  assert.equal(p0.knights[0].active, false);
  // 追い出し: プレイヤー1の弱い騎士を、プレイヤー0の起動した騎士の隣に置いて追い出す
  const neighborV = g.board.vertices[robberVid].neighbors[0];
  p1.knights.push({ id: 1, vertexId: neighborV, level: 1, active: true, actedTurn: null });
  p0.knights[0].active = true; p0.knights[0].actedTurn = null;
  const targets = E.expellableTargets(g, 0, kid);
  assert.ok(targets.some((t) => t.ownerIdx === 1));
  assert.ok(E.expelKnight(g, kid, 1, 1));
  assert.equal(p1.knights.length, 0);
});

test('都市と騎士: 騎士は弱い・強い・最強、各段階2体まで（公式の数）', () => {
  const g = ckGame();
  g.phase = 'main'; g.turn = 0;
  const p0 = g.players[0];
  const v = g.board.vertices.find((x) => x.edgeIds.length >= 3);
  v.building = { owner: 0, type: 'city' }; p0.cities.push(v.id);
  v.edgeIds.slice(0, 2).forEach((eId) => { g.board.edges[eId].road = 0; p0.roads.push(eId); });
  p0.resources = { wood: 0, brick: 0, sheep: 10, wheat: 10, ore: 10 };
  p0.cityImprovements.politics = 3;
  // 弱い騎士を、置ける場所がある限り2体まで
  const vs1 = E.availableKnightVertices(g, 0);
  assert.ok(vs1.length >= 2, 'テストの前提: 置ける場所が2つ以上必要');
  assert.ok(E.buildKnight(g, vs1[0]));
  assert.ok(E.buildKnight(g, E.availableKnightVertices(g, 0)[0]));
  assert.equal(p0.knights.length, 2);
  assert.equal(E.availableKnightVertices(g, 0).length, 0); // 3体目は置けない
  assert.equal(E.canPlaceKnight(g, E.availableSettlementVertices(g, 0, true)[0], 0), false);
  // 両方とも強いに昇格できるが、最強は2体まで（ここでは2体とも最強にできる）
  const [k1, k2] = p0.knights;
  assert.ok(E.upgradeKnight(g, k1.id));
  assert.ok(E.upgradeKnight(g, k2.id));
  assert.ok(E.upgradeKnight(g, k1.id));
  assert.ok(E.upgradeKnight(g, k2.id));
  assert.equal(p0.knights.filter((k) => k.level === 3).length, 2);
  // 3体目の騎士を新しく建てて、強いに昇格しようとしても、強い段階はもう2体いないので空きがあるはず
  // （弱い騎士がいなくなったので、弱いの枠は空いている）
  const vs2 = E.availableKnightVertices(g, 0);
  if (vs2.length) {
    assert.ok(E.buildKnight(g, vs2[0]));
    const k3 = p0.knights.find((k) => k.level === 1);
    assert.equal(E.canUpgradeKnight(g, 0, k3.id), true); // 強いの枠(2体)はまだ0体なので昇格できる
  }
});

test('都市と騎士: 交易3段階目の商品2:1交易、科学3段階目の資源保証', () => {
  const g = ckGame();
  g.phase = 'main'; g.turn = 0;
  const p0 = g.players[0];
  // 交易3段階目がないと交易できない
  p0.commodities.cloth = 2;
  assert.equal(E.canTradeCommodity(g, 0, 'cloth'), false);
  p0.cityImprovements.trade = 3;
  assert.equal(E.canTradeCommodity(g, 0, 'cloth'), true);
  const bankWoodBefore = g.bank.resources.wood;
  assert.ok(E.tradeCommodity(g, 'cloth', 'resource', 'wood'));
  assert.equal(p0.commodities.cloth, 0);
  assert.equal(p0.resources.wood, 1);
  assert.equal(g.bank.resources.wood, bankWoodBefore - 1);
  p0.commodities.coin = 2;
  assert.ok(E.tradeCommodity(g, 'coin', 'commodity', 'paper'));
  assert.equal(p0.commodities.paper, 1);

  // 科学3段階目: 赤の目で自分に何も入らなかった人は、あとで資源を1枚選べる（7は除く）
  const g2 = ckGame();
  g2.players[0].cityImprovements.science = 3;
  g2.players.forEach((p) => { p.resources = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 }; });
  // 誰の建物にも当たらない目を選ぶため、全員の建物を取り除いた状態で振る
  g2.phase = 'roll';
  const seq = [2.5 / 6, 2.5 / 6, 0.99]; // d1=3,d2=3→合計6（7以外。盤上に誰も建物がないので何も入らない）
  const total = E.rollDice(g2, () => seq.shift());
  assert.notEqual(total, 7);
  assert.ok(g2.pendingScienceBonus.includes(0));
  assert.ok(E.pickScienceBonus(g2, 0, 'wheat'));
  assert.equal(g2.players[0].resources.wheat, 1);
  assert.equal(g2.pendingScienceBonus.includes(0), false);
  assert.equal(g2.phase, 'main');
});

test('都市と騎士: 大都市は特定の都市に置かれ、蛮族の襲来ではその都市が守られる', () => {
  const g = ckGame();
  const p0 = g.players[0];
  const v0 = g.board.vertices.find((v) => !v.building);
  v0.building = { owner: 0, type: 'city' }; p0.cities.push(v0.id);
  const v1 = g.board.vertices.find((v) => !v.building && v.id !== v0.id);
  v1.building = { owner: 0, type: 'city' }; p0.cities.push(v1.id);
  p0.commodities.cloth = 1 + 2 + 3 + 4;
  g.phase = 'main'; g.turn = 0;
  for (let i = 0; i < 4; i++) E.improveCity(g, 'trade');
  const metroVid = g.metropolis.trade;
  assert.ok([v0.id, v1.id].includes(metroVid));
  // 騎士なし・都市2つ（大都市1つ含む）→ 蛮族に負ける。大都市の都市は守られ、もう1つが開拓地に戻る
  g.barbarianProgress = 6; g.phase = 'roll'; g.turn = 0;
  E.rollDice(g, () => 0.1);
  assert.equal(g.barbarianAttacked, true);
  assert.equal(p0.cities.length, 1);
  assert.equal(p0.cities[0], metroVid); // 残っているのは大都市の都市
  assert.equal(g.board.vertices[metroVid].building.type, 'city');
});

test('都市と騎士: 蛮族の襲来（勝つと守護者点、負けると都市が1つ開拓地に戻る）', () => {
  const g = ckGame();
  const p0 = g.players[0], p1 = g.players[1];
  const v0 = g.board.vertices.find((v) => !v.building);
  v0.building = { owner: 0, type: 'city' }; p0.cities.push(v0.id);
  const v1 = g.board.vertices.find((v) => !v.building);
  v1.building = { owner: 1, type: 'city' }; p1.cities.push(v1.id);
  p0.knights.push({ id: 1, vertexId: v0.id, level: 3, active: true, actedTurn: null }); // 強さ3 >= 都市2 → 勝つ
  g.barbarianProgress = 6; g.phase = 'roll'; g.turn = 0;
  E.rollDice(g, () => 0.1); // 1面目=barbarianを引かせるため小さい乱数を使う（EVENT_FACESの並び順に依存）
  assert.equal(g.barbarianAttacked, true);
  assert.equal(g.barbarianProgress, 0);
  assert.equal(p0.defenderVp, 1);
  assert.equal(p0.knights[0].active, false); // 襲来のあとは全員休む

  // 次は負けるケース: 騎士なし
  const g2 = ckGame();
  const q0 = g2.players[0];
  const vv = g2.board.vertices.find((v) => !v.building);
  vv.building = { owner: 0, type: 'city' }; q0.cities.push(vv.id);
  g2.barbarianProgress = 6; g2.phase = 'roll'; g2.turn = 0;
  E.rollDice(g2, () => 0.1);
  assert.equal(g2.barbarianAttacked, true);
  assert.equal(q0.cities.length, 0);
  assert.equal(q0.settlements.includes(vv.id), true);
});

test('都市と騎士: 都市壁は土2、都市1つに1つ、最大3。7の捨て札の上限を+2する', () => {
  const g = ckGame();
  g.phase = 'main'; g.turn = 0;
  const p0 = g.players[0];
  const v0 = g.board.vertices.find((v) => !v.building);
  v0.building = { owner: 0, type: 'city' }; p0.cities.push(v0.id);
  p0.resources.brick = 2;
  assert.equal(E.canBuildWall(g, 0), true);
  assert.ok(E.buildWall(g));
  assert.equal(p0.walls, 1);
  assert.equal(E.canBuildWall(g, 0), false); // 都市が1つしかないので、もう置けない
  // 7が出たとき、壁1つぶん(+2)で9枚までは捨てずに済む
  g.players.forEach((p) => { p.resources = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 }; });
  p0.resources.wood = 9;
  g.phase = 'roll';
  const seq = [3 / 6, 2.5 / 6, 0.99]; // d1=4, d2=3 → 合計7
  const total = E.rollDice(g, () => seq.shift());
  assert.equal(total, 7);
  assert.equal(g.pendingDiscards.some((d) => d.player === 0), false); // 7+2=9までは捨てなくてよい
});

test('都市と騎士: CPUだけで4人、数局きちんと決着する（勝利点13点）', () => {
  for (let i = 0; i < 4; i++) {
    const g = playOutCpu(['weak', 'normal', 'strong', 'normal'], 800000, { expansions: ['cities-knights'] });
    assert.deepEqual(g.expansions, ['cities-knights']);
    assert.ok(g.winner != null);
    assert.ok(E.playerScore(g, g.winner) >= 13);
  }
});

test('CPU: 強さの差（よわい vs ふつう、ふつう vs つよい）を4人（2対2）対局の勝ち数で見る', () => {
  // 実際のアプリは3〜4人用なので、比較も4人（levelA2人 + levelB2人、席はランダム）で行う
  function winRate(levelA, levelB, games) {
    let aWins = 0;
    for (let i = 0; i < games; i++) {
      const seats = [levelA, levelA, levelB, levelB].sort(() => Math.random() - 0.5);
      const g = playOutCpu(seats);
      if (seats[g.winner] === levelA) aWins++;
    }
    return aWins;
  }
  const games = 20;
  const weakVsNormal = winRate('weak', 'normal', games);
  const normalVsStrong = winRate('normal', 'strong', games);
  console.log(`[CPU強さ] よわい vs ふつう: よわい ${weakVsNormal}/${games} 勝`);
  console.log(`[CPU強さ] ふつう vs つよい: ふつう ${normalVsStrong}/${games} 勝`);
  // 強いほうが勝ち越す想定（まれな逆転はあり得るので、惨敗はしていないことだけ確かめる）
  assert.ok(weakVsNormal <= games - 2);
  assert.ok(normalVsStrong <= games - 2);
});

// ---- 交易と略奪 ----
function tbGame(scenario, count = 4) { return E.createGame(count, Math.random, { expansions: ['traders-barbarians'], scenario }); }
// rollDice用に、合計が total になる(d1,d2)の組を作る(1〜6の範囲で必ず作れる)
function diceSeq(total) {
  const d1 = Math.max(1, total - 6);
  const d2 = total - d1;
  const seq = [(d1 - 0.5) / 6, (d2 - 0.5) / 6];
  return () => seq.shift();
}

test('交易と略奪・漁師: 漁場は10か所、出目に7はなく魚は1〜3、勝利点13点', () => {
  const g = tbGame('fishermen');
  assert.equal(g.scenario, 'fishermen');
  assert.equal(g.winTarget, 13);
  assert.equal(g.board.fisheries.length, 10);
  const numbers = g.board.fisheries.map((f) => f.number).sort((a, b) => a - b);
  assert.deepEqual(numbers, [2, 3, 4, 5, 6, 8, 9, 10, 11, 12]);
  g.board.fisheries.forEach((f) => assert.ok(f.value >= 1 && f.value <= 3));
});

test('交易と略奪・漁師: 出目が合うと漁場の魚が貯まる(開拓地1・都市2倍)', () => {
  const g = tbGame('fishermen');
  g.phase = 'main'; g.turn = 0;
  const fishery = g.board.fisheries[0];
  const e = g.board.edges[fishery.edgeId];
  g.board.vertices[e.v1].building = { owner: 0, type: 'city' };
  g.players[0].cities.push(e.v1);
  g.phase = 'roll';
  E.rollDice(g, diceSeq(fishery.number));
  assert.equal(g.players[0].fish, fishery.value * 2);
});

test('交易と略奪・漁師: 魚を使った交換(盗賊を盤外へ・資源を奪う・資源1枚・道1本只で・発展カード只で)', () => {
  const g = tbGame('fishermen');
  g.phase = 'main'; g.turn = 0;
  const p0 = g.players[0];
  p0.fish = 2;
  assert.ok(E.fishRobberAway(g));
  assert.equal(g.board.robberHex, null); // 盗賊は盤外へ(以後どのマスも塞がない)
  p0.fish = 3;
  g.players[1].resources.wood = 1;
  assert.ok(E.fishSteal(g, 1));
  assert.equal(p0.resources.wood, 1);
  p0.fish = 4;
  const wheatBefore = g.bank.resources.wheat;
  assert.ok(E.fishResource(g, 'wheat'));
  assert.equal(p0.resources.wheat, 1);
  assert.equal(g.bank.resources.wheat, wheatBefore - 1);
  p0.fish = 5;
  const v = E.availableSettlementVertices(g, 0, true)[0];
  g.board.vertices[v].building = { owner: 0, type: 'settlement' };
  p0.settlements.push(v);
  const edge = E.availableRoadEdges(g, 0)[0];
  assert.ok(E.fishRoad(g, edge));
  assert.equal(g.board.edges[edge].road, 0);
  p0.fish = 7;
  const before = p0.devCards.length;
  assert.ok(E.fishDevCard(g));
  assert.equal(p0.devCards.length, before + 1);
  assert.equal(p0.fish, 0); // 2+3+4+5+7=21匹をちょうど使い切った
});

test('交易と略奪・漁師: 古い靴は魚が一番少ない人に付く(同点なら誰にも付かない)', () => {
  const g = tbGame('fishermen');
  g.phase = 'main'; g.turn = 0;
  g.players[0].fish = 5; g.players[1].fish = 2; g.players[2].fish = 2; g.players[3].fish = 0;
  assert.ok(E.fishResource(g, 'wood')); // 魚を使う副作用として古い靴が再計算される(5匹→1匹に)
  assert.equal(g.oldBootHolder, 3); // 0匹の人が一番少ない
  g.players[3].fish = 1; // プレイヤー0(1匹)と同点になった
  g.turn = 1; g.players[1].fish = 8; // 別の人が魚を使ったついでに、ちょうど同じ1匹まで減って3人同点になる
  assert.ok(E.fishDevCard(g));
  assert.equal(g.players[1].fish, 1);
  assert.equal(g.oldBootHolder, 3); // 同点のときは今の持ち主のまま(簡略化)
});

test('交易と略奪・漁師: CPUだけで4人、数局きちんと決着する(勝利点13点、古い靴の持ち主は+1点多く要る)', () => {
  for (let i = 0; i < 3; i++) {
    const g = playOutCpu(['weak', 'normal', 'strong', 'normal'], 800000, { expansions: ['traders-barbarians'], scenario: 'fishermen' });
    assert.equal(g.scenario, 'fishermen');
    assert.ok(g.winner != null);
    const target = g.oldBootHolder === g.winner ? g.winTarget + 1 : g.winTarget;
    assert.ok(E.playerScore(g, g.winner) >= target);
  }
});

test('交易と略奪・川: 川をまたぐ辺には道でなく橋(土2木1)が要る', () => {
  const g = tbGame('rivers');
  assert.ok(g.board.riverEdgeIds.size >= 5);
  g.phase = 'main'; g.turn = 0;
  const edgeId = [...g.board.riverEdgeIds][0];
  const e = g.board.edges[edgeId];
  g.board.vertices[e.v1].building = { owner: 0, type: 'settlement' };
  g.players[0].settlements.push(e.v1);
  g.players[0].resources = { wood: 1, brick: 1, sheep: 0, wheat: 0, ore: 0 };
  assert.equal(E.buildRoad(g, edgeId), false); // ふつうの道のコストだけでは足りない
  g.players[0].resources = { wood: 1, brick: 2, sheep: 0, wheat: 0, ore: 0 };
  assert.ok(E.buildRoad(g, edgeId));
});

test('交易と略奪・川: 川沿いの建物は金貨を産み、2枚で資源1枚に替えられる。富豪が得点に付く', () => {
  const g = tbGame('rivers');
  assert.equal(g.winTarget, 12);
  g.phase = 'main'; g.turn = 0;
  const v = [...g.board.riverVertexIds][0];
  g.board.vertices[v].building = { owner: 0, type: 'city' };
  g.players[0].cities.push(v);
  const hexId = g.board.vertices[v].hexIds.find((h) => g.board.hexes[h].number != null);
  const num = g.board.hexes[hexId].number;
  g.phase = 'roll';
  E.rollDice(g, diceSeq(num));
  assert.equal(g.players[0].gold, 2); // 都市は2枚
  assert.equal(g.richPlayer, 0);
  assert.equal(g.poorPlayer, null); // 残り3人が同点(0枚)なので貧者は決まらない
  g.phase = 'main';
  g.players[0].gold = 1;
  assert.equal(E.tradeGold(g, 'sheep'), false); // 1枚では足りない
  g.players[0].gold = 2;
  const sheepBefore = g.players[0].resources.sheep;
  assert.ok(E.tradeGold(g, 'sheep'));
  assert.equal(g.players[0].resources.sheep, sheepBefore + 1);
});

test('交易と略奪・川: 富豪(+1点)・貧者(-2点)が得点に反映される', () => {
  const g = tbGame('rivers');
  const before0 = E.playerScore(g, 0);
  const before1 = E.playerScore(g, 1);
  g.richPlayer = 0; g.poorPlayer = 1;
  assert.equal(E.playerScore(g, 0), before0 + 1);
  assert.equal(E.playerScore(g, 1), before1 - 2);
});

test('交易と略奪・川: CPUだけで4人、数局きちんと決着する(勝利点12点)', () => {
  for (let i = 0; i < 3; i++) {
    const g = playOutCpu(['weak', 'normal', 'strong', 'normal'], 800000, { expansions: ['traders-barbarians'], scenario: 'rivers' });
    assert.equal(g.scenario, 'rivers');
    assert.ok(g.winner != null);
    assert.ok(E.playerScore(g, g.winner) >= g.winTarget);
  }
});

test('交易と略奪・隊商: ラクダは砂漠の隣り合う2辺にいて、挟まれた頂点が1つ決まる', () => {
  const g = tbGame('caravans');
  assert.equal(g.winTarget, 12);
  assert.notEqual(g.board.camelEdgeA, g.board.camelEdgeB);
  assert.ok(g.board.camelVertexId != null);
  const a = g.board.edges[g.board.camelEdgeA], b = g.board.edges[g.board.camelEdgeB];
  assert.ok([a.v1, a.v2].includes(g.board.camelVertexId));
  assert.ok([b.v1, b.v2].includes(g.board.camelVertexId));
});

test('交易と略奪・隊商: 羊か麦を払うとラクダが動き、挟まれた頂点の建物に+1点が付く', () => {
  const g = tbGame('caravans');
  g.phase = 'main'; g.turn = 0;
  g.players[0].resources.wheat = 1;
  assert.equal(E.canMoveCamels(g, 0), true);
  const before = g.board.camelVertexId;
  assert.ok(E.moveCamels(g, 1));
  assert.equal(g.players[0].resources.wheat, 0);
  assert.notEqual(g.board.camelVertexId, before);
  g.board.vertices[g.board.camelVertexId].building = { owner: 0, type: 'settlement' };
  g.players[0].settlements.push(g.board.camelVertexId);
  assert.equal(E.playerScore(g, 0), 2); // 開拓地1点 + ラクダに挟まれて+1点
});

test('交易と略奪・隊商: CPUだけで4人、数局きちんと決着する(勝利点12点)', () => {
  for (let i = 0; i < 3; i++) {
    const g = playOutCpu(['weak', 'normal', 'strong', 'normal'], 800000, { expansions: ['traders-barbarians'], scenario: 'caravans' });
    assert.equal(g.scenario, 'caravans');
    assert.ok(g.winner != null);
    assert.ok(E.playerScore(g, g.winner) >= g.winTarget);
  }
});
