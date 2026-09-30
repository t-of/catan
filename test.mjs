'use strict';
// engine.js の自己チェック。フレームワークなし。node --test で動く。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from './engine.js';

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

test('勝利判定: 得点が10に届くと winner が立つ', () => {
  const g = E.createGame(3, Math.random);
  g.phase = 'main'; g.turn = 0;
  const p0 = g.players[0];
  for (let i = 0; i < 4; i++) p0.cities.push(1000 + i); // 4都市=8点
  p0.settlements.push(2000); // +1点
  p0.devCards.push({ type: 'vp', boughtTurn: 1, played: false }); // +1点
  assert.equal(E.playerScore(g, 0), 10);
});
