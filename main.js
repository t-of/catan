'use strict';
// ルール・盤面・得点計算は engine.js（画面・音を持たない）。見た目のドット素材は sprites.js。
// ここは見た目の組み立てと入力だけ。
import * as E from './engine.js';
import * as S from './sprites.js';

// localStorage はほかのアプリと共有される（同じ t-of.github.io のため）。キーは必ず 'catan.' で始める。
const STORE = 'catan.';
function load(key, fallback) {
  try {
    const v = localStorage.getItem(STORE + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(STORE + key, JSON.stringify(value)); } catch { /* 保存できなくても遊べる */ }
}

WebAppKit.init({ title: 'catan', text: '六角タイルの盤で資源を集め、道・開拓地・都市を建てて競う交代プレイの試作。' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// 音を使うときは、鳴らす前と音の設定を切り替えたときにこれを呼ぶ（RULES.md §5「音」）。
function setAudioSession(soundOn) {
  try { if (navigator.audioSession) navigator.audioSession.type = soundOn ? 'playback' : 'auto'; } catch { /* 対応していない */ }
}
let audioCtx = null;
function beep(freq, dur) {
  try {
    if (!audioCtx) { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); setAudioSession(true); }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + dur);
  } catch { /* 音が出せなくても遊べる */ }
}
const SOUND = {
  dice: () => beep(340, 0.12),
  build: () => beep(520, 0.1),
  'buy-dev': () => beep(600, 0.1),
  trade: () => beep(460, 0.1),
  rob: () => beep(220, 0.2),
  win: () => { beep(660, 0.15); setTimeout(() => beep(880, 0.25), 140); },
  shortage: () => beep(180, 0.08),
};

// ---- DOM ----
const els = {
  setupPanel: document.getElementById('setupPanel'),
  gamePanel: document.getElementById('gamePanel'),
  waves: document.getElementById('waves'),
  titleBoard: document.getElementById('titleBoard'),
  playerCountPicker: document.getElementById('playerCountPicker'),
  startBtn: document.getElementById('startBtn'),
  continueBtn: document.getElementById('continueBtn'),
  board: document.getElementById('board'),
  diceBox: document.getElementById('diceBox'),
  banner: document.getElementById('banner'),
  playersBar: document.getElementById('playersBar'),
  handBar: document.getElementById('handBar'),
  buildGrid: document.getElementById('buildGrid'),
  panelOverlay: document.getElementById('panelOverlay'),
  panel: document.getElementById('panel'),
  actionBar: document.getElementById('actionBar'),
  diceBtn: document.getElementById('diceBtn'),
  tradeBtn: document.getElementById('tradeBtn'),
  devBtn: document.getElementById('devBtn'),
  endTurnBtn: document.getElementById('endTurnBtn'),
};

const SCALE = 44; // 1マス単位 → SVG座標のピクセル
const RES_LABEL = { wood: '木', brick: '土', sheep: '羊', wheat: '麦', ore: '鉄' };
const RES_BG = { wood: 'var(--wood)', brick: 'var(--brick)', sheep: 'var(--sheep)', wheat: 'var(--wheat)', ore: 'var(--ore)' };

function icon(kind, cell, color) {
  const svg = S.iconSvg(kind, cell, color);
  return svg;
}

let game = null;
let playerCount = load('playerCount', 3) === 4 ? 4 : 3;
let ui = { mode: 'idle', data: {} };

// ---- 波（タイトル画面の飾り。毎回ランダムでよい） ----
(function renderWaves() {
  const svg = els.waves;
  svg.setAttribute('viewBox', '0 0 390 220');
  for (let k = 0; k < 40; k++) {
    const x = (k * 89 + 13) % 382;
    const y = (k * 47 + 7) % 214;
    const r1 = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r1.setAttribute('x', x); r1.setAttribute('y', y); r1.setAttribute('width', 8); r1.setAttribute('height', 2); r1.setAttribute('fill', '#3b62a6');
    svg.appendChild(r1);
    const r2 = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r2.setAttribute('x', x + 8); r2.setAttribute('y', y - 2); r2.setAttribute('width', 4); r2.setAttribute('height', 2); r2.setAttribute('fill', '#3b62a6');
    svg.appendChild(r2);
  }
})();

// ---- 人数選び ----
els.playerCountPicker.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-count]');
  if (!btn) return;
  playerCount = Number(btn.dataset.count);
  save('playerCount', playerCount);
  syncCountPicker();
});
function syncCountPicker() {
  [...els.playerCountPicker.children].forEach((b) => b.classList.toggle('is-selected', Number(b.dataset.count) === playerCount));
}
syncCountPicker();

els.startBtn.addEventListener('click', () => {
  game = E.createGame(playerCount, Math.random);
  ui = { mode: modeForPhase(), data: {} };
  showGame();
  save('game', game);
  renderAll();
});
els.continueBtn.addEventListener('click', () => {
  const saved = load('game', null);
  if (!saved || saved.winner != null) return;
  game = saved;
  ui = { mode: modeForPhase(), data: {} };
  showGame();
  renderAll();
});
function showGame() { els.setupPanel.hidden = true; els.gamePanel.hidden = false; }

// 続きがあれば「つづきから」を出す（自動では始めない。まずタイトルを見せる）
{
  const saved = load('game', null);
  if (saved && saved.winner == null) {
    els.continueBtn.hidden = false;
    els.continueBtn.textContent = `つづきから（ターン${saved.turnNumber}）`;
  }
}

function modeForPhase() {
  if (!game) return 'idle';
  if (game.phase === 'setup1' || game.phase === 'setup2') return game.setupPending === 'road' ? 'setupRoad' : 'setupSettlement';
  if (game.phase === 'discard') return 'discard';
  if (game.phase === 'moveRobber') return 'moveRobber';
  return 'idle';
}

function persistAndRender() { save('game', game); renderAll(); }

function playEvents() {
  if (!game) return;
  const evts = game.events.splice(0, game.events.length);
  evts.forEach((e) => { if (SOUND[e]) SOUND[e](); });
}

// ================================================================
// 盤面の描画（タイトルの飾りと、ゲーム中の盤の両方をこの関数で描く）
// ドットは画面の大きさの色の表（Int16Array）にまず塗り、行ごとに同じ色の続きを1本の path
// にまとめてから <path> を色の数だけ置く（2倍細かくすると矩形の数が増えるので、SVG の要素数を減らす）。
// ================================================================
const svgNS = 'http://www.w3.org/2000/svg';
function el(tag, attrs, parent) {
  const n = document.createElementNS(svgNS, tag);
  Object.entries(attrs || {}).forEach(([k, v]) => n.setAttribute(k, v));
  if (parent) parent.appendChild(n);
  return n;
}

function hexBBox(g, hex) {
  const vs = hex.vertexIds.map((id) => g.board.vertices[id]);
  const xs = vs.map((v) => v.x * SCALE), ys = vs.map((v) => v.y * SCALE);
  return {
    cx: (Math.min(...xs) + Math.max(...xs)) / 2,
    cy: (Math.min(...ys) + Math.max(...ys)) / 2,
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
}

function viewBoxOf(g) {
  const xs = g.board.vertices.map((v) => v.x * SCALE);
  const ys = g.board.vertices.map((v) => v.y * SCALE);
  const margin = SCALE * 0.9;
  const minX = Math.min(...xs) - margin, maxX = Math.max(...xs) + margin;
  const minY = Math.min(...ys) - margin, maxY = Math.max(...ys) + margin;
  return { minX, minY, w: maxX - minX, h: maxY - minY };
}

function renderBoardInto(svg, g, uiState) {
  svg.innerHTML = '';
  const idx = E.currentPlayer(g);
  const hexBoxes = g.board.hexes.map((h) => hexBBox(g, h));
  const k = (hexBoxes[0].w || 76) / 64; // Board.dc.html の W=64 を基準にした縮尺
  const CELL = 4 * k;       // アイコン全体の大きさの基準（今まで通り）
  const DOT = CELL / S.RES; // 1ドットの大きさ（今までの半分＝2倍細かい）

  const vb = viewBoxOf(g);
  svg.setAttribute('viewBox', `${vb.minX} ${vb.minY} ${vb.w} ${vb.h}`);

  // 色の表。ox,oy はグリッドの原点（viewBox の左上）。1 グリッド = 画面の 1 ドット。
  const ox = Math.floor(vb.minX), oy = Math.floor(vb.minY);
  const BW = Math.ceil(vb.w) + 2, BH = Math.ceil(vb.h) + 2;
  const grid = new Int16Array(BW * BH);
  const cols = [null]; // index 0 = 透明
  const cmap = new Map();
  function colorIndex(fill, opacity) {
    const key = fill + '|' + (opacity == null ? 1 : opacity);
    let i = cmap.get(key);
    if (i == null) { i = cols.push({ fill, opacity: opacity == null ? 1 : opacity }) - 1; cmap.set(key, i); }
    return i;
  }
  function fillPx(x, y, w, h, fill, opacity) {
    const ci = colorIndex(fill, opacity);
    const x0 = Math.max(0, Math.round(x) - ox), x1 = Math.min(BW, Math.round(x + w) - ox);
    const y0 = Math.max(0, Math.round(y) - oy), y1 = Math.min(BH, Math.round(y + h) - oy);
    if (x1 <= x0 || y1 <= y0) return;
    for (let yy = y0; yy < y1; yy++) grid.fill(ci, yy * BW + x0, yy * BW + x1);
  }
  const paint = (rects) => rects.forEach((r) => fillPx(r.x, r.y, r.w, r.h, r.f));
  // 数字・港の文字・タップ判定などの実要素は、色の表を塗り終えてから最後にまとめて足す（path の上に乗せるため）
  const overlay = [];
  const queue = (tag, attrs, text) => overlay.push({ tag, attrs, text });

  // 砂浜のふち（先に全タイル分を敷き、ふちを作る）
  const beach = [];
  hexBoxes.forEach(({ cx, cy, w, h }) => { S.hexBandRects(cx, cy, w + 20 * k, h + 20 * k, '#e9d9a6', DOT, beach); });
  hexBoxes.forEach(({ cx, cy, w, h }) => { S.hexBandRects(cx, cy + 4 * k, w + 12 * k, h + 8 * k, '#c9b37a', DOT, beach); });
  hexBoxes.forEach(({ cx, cy, w, h }) => { S.hexBandRects(cx, cy, w + 8 * k, h + 8 * k, S.INK, DOT, beach); });
  paint(beach);

  // タイル本体（地形の下地・スプライト・数字チップ）
  g.board.hexes.forEach((hex, i) => {
    const { cx, cy, w, h } = hexBoxes[i];
    const T = S.TER[hex.terrain];
    const rects = [];
    S.hexBandRects(cx, cy, w - 4 * k, h - 4 * k, T.shade, DOT, rects);
    S.hexBandRects(cx, cy - 4 * k, w - 12 * k, h - 12 * k, T.base, DOT, rects);
    S.blitRects(S.spr(T.spr, 8, 8, null), cx - 4 * CELL, cy - (hex.number != null ? 8 : 4) * CELL, DOT, S.PAL, rects);
    paint(rects);
    if (hex.number != null) {
      const hot = hex.number === 6 || hex.number === 8;
      const chip = [];
      S.discRects(cx, cy + 8 * k, 15 * k, S.INK, DOT, chip);
      S.discRects(cx, cy + 8 * k, 13 * k, S.CREAM, DOT, chip);
      paint(chip);
      queue('text', { x: cx, y: cy + 8 * k + 5 * k, class: 'hex-number', style: `font-family:'Press Start 2P',monospace;font-size:${14 * k}px;fill:${hot ? '#c8321e' : S.INK};text-anchor:middle;dominant-baseline:central` }, String(hex.number));
      const dots = 6 - Math.abs(7 - hex.number);
      const pip = [];
      const x0 = cx - Math.round(((dots * 3 - 1) / 2)) * k;
      for (let d = 0; d < dots; d++) pip.push({ x: x0 + d * 3 * k, y: cy + 16 * k, w: 2 * k, h: 2 * k, f: hot ? '#c8321e' : S.INK });
      paint(pip);
    }
  });

  // 道（既存＋置ける場所）
  const buildableEdges = uiState && (uiState.mode === 'setupRoad' || uiState.mode === 'buildRoad' || uiState.mode === 'devRoad1' || uiState.mode === 'devRoad2')
    ? new Set(edgeChoices()) : new Set();
  g.board.edges.forEach((edge) => {
    const v1 = g.board.vertices[edge.v1], v2 = g.board.vertices[edge.v2];
    const x1 = v1.x * SCALE, y1 = v1.y * SCALE, x2 = v2.x * SCALE, y2 = v2.y * SCALE;
    if (edge.road != null) {
      drawDottedLine(fillPx, x1, y1, x2, y2, g.players[edge.road].color, DOT);
    } else if (buildableEdges.has(edge.id)) {
      drawDottedLine(fillPx, x1, y1, x2, y2, 'var(--accent)', DOT, true);
      queue('line', { x1, y1, x2, y2, class: 'road-hit', 'data-edge': edge.id });
    } else {
      queue('line', { x1, y1, x2, y2, stroke: 'rgba(255,255,255,0.12)', 'stroke-width': 3 });
    }
  });

  // 頂点（開拓地・都市・置ける場所）
  const buildableVerts = uiState && (uiState.mode === 'setupSettlement' || uiState.mode === 'buildSettlement')
    ? new Set(vertexChoices())
    : uiState && uiState.mode === 'buildCity' ? new Set(E.availableCityVertices(g, idx)) : new Set();
  g.board.vertices.forEach((v) => {
    const x = v.x * SCALE, y = v.y * SCALE;
    if (v.building) {
      const color = g.players[v.building.owner].color;
      const pal = S.paletteFor(color);
      const isCity = v.building.type === 'city';
      const nx = isCity ? 12 : 10, ny = isCity ? 10 : 9;
      const bc = CELL * 0.55;
      const rects = [];
      S.blitRects(S.spr(isCity ? 'city' : 'settle', nx, ny, S.INK), x - (nx * bc) / 2, y - (ny * bc) / 2, bc / S.RES, pal, rects);
      paint(rects);
    } else if (buildableVerts.has(v.id)) {
      const hi = [];
      hi.push({ x: x - 8 * k, y: y - 8 * k, w: 16 * k, h: 16 * k, f: S.INK });
      hi.push({ x: x - 6 * k, y: y - 6 * k, w: 12 * k, h: 12 * k, f: '#ffd35c' });
      hi.push({ x: x - 3 * k, y: y - 3 * k, w: 6 * k, h: 6 * k, f: '#fff6c8' });
      paint(hi);
      queue('circle', { cx: x, cy: y, r: 11, class: 'vertex-hit', 'data-vertex': v.id });
    }
  });

  // 港（銀行との交換レートの札。頂点の上に乗ることがあるので、頂点より後に描く）
  g.board.portEdgeIds.forEach((eId) => {
    const e = g.board.edges[eId];
    const v1 = g.board.vertices[e.v1], v2 = g.board.vertices[e.v2];
    const mx = (v1.x + v2.x) / 2, my = (v1.y + v2.y) / 2;
    const len = Math.hypot(mx, my) || 1;
    const x = (mx + (mx / len) * 0.45) * SCALE, y = (my + (my / len) * 0.45) * SCALE;
    const type = v1.port;
    const isAny = type === '3:1';
    const bg = isAny ? S.CREAM : (PORT_TERRAIN[type] ? S.TER[PORT_TERRAIN[type]].base : S.CREAM);
    const plaque = [];
    plaque.push({ x: x - 17 * k, y: y - 9 * k, w: 34 * k, h: 18 * k, f: S.INK });
    plaque.push({ x: x - 15 * k, y: y - 7 * k, w: 30 * k, h: 14 * k, f: bg });
    plaque.push({ x: x - 15 * k, y: y + 5 * k, w: 30 * k, h: 2 * k, f: S.shade(bg) });
    paint(plaque);
    queue('text', { x, y: y + 4 * k, class: 'port-label', fill: isAny ? S.INK : '#fbf5e4' }, isAny ? '3:1' : '2:1');
  });

  // 盗賊
  {
    const { cx, cy } = hexBoxes[g.board.robberHex];
    paint(S.blitRects(S.spr('robber', 8, 8, null), cx - 4 * CELL, cy - 4 * CELL, DOT, S.PAL, []));
  }

  // 盗賊を置ける場所（タイル自体をタップできるようにする）
  if (uiState && (uiState.mode === 'moveRobber' || uiState.mode === 'devKnightHex')) {
    g.board.hexes.forEach((hex) => {
      if (hex.id === g.board.robberHex) return;
      const pts = hex.vertexIds.map((id) => { const v = g.board.vertices[id]; return `${v.x * SCALE},${v.y * SCALE}`; }).join(' ');
      queue('polygon', { points: pts, class: 'hex-target', 'data-hex': hex.id });
    });
  }

  // 色の表 → 行ごとに同じ色の続きを1本のpathにまとめ、色ごとに1つの<path>にする
  const runs = cols.map(() => []);
  for (let y = 0; y < BH; y++) {
    const row = y * BW;
    let x = 0;
    while (x < BW) {
      const ci = grid[row + x];
      let n = 1;
      while (x + n < BW && grid[row + x + n] === ci) n++;
      if (ci) runs[ci].push(`M${x + ox} ${y + oy}h${n}v1h-${n}z`);
      x += n;
    }
  }
  cols.forEach((c, i) => {
    if (!c || !runs[i].length) return;
    const attrs = { d: runs[i].join(''), fill: c.fill };
    if (c.opacity !== 1) attrs['fill-opacity'] = c.opacity;
    el('path', attrs, svg);
  });

  // 実要素（数字・港の文字・タップ判定）は path の上に
  overlay.forEach((o) => { const n = el(o.tag, o.attrs, svg); if (o.text != null) n.textContent = o.text; });
}
const PORT_TERRAIN = { wood: 'forest', brick: 'hills', sheep: 'pasture', wheat: 'field', ore: 'mountains' };

// 道のドット（12個。前より数を倍にして細かくつなぐ）
function drawDottedLine(fillPx, x1, y1, x2, y2, color, cell, light) {
  const n = 12;
  for (let i = 0; i < n; i++) {
    const t = 0.15 + i * (0.7 / (n - 1));
    const x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t;
    if (!light) fillPx(x - cell, y - cell, cell * 2, cell * 2, S.INK);
    fillPx(x - cell / 2, y - cell / 2, cell, cell, color, light ? 0.7 : 1);
  }
}

function vertexChoices() {
  const idx = E.currentPlayer(game);
  const isSetup = game.phase === 'setup1' || game.phase === 'setup2';
  return E.availableSettlementVertices(game, idx, isSetup);
}
function edgeChoices() {
  const idx = E.currentPlayer(game);
  const isSetup = game.phase === 'setup1' || game.phase === 'setup2';
  // セットアップ中は、直前に置いた開拓地につながる道しか置けない（engine.js の setupPlaceRoad と同じ条件）。
  // それ以外の道は E.availableRoadEdges だと「前から持っている開拓地」にもつながってしまい、選べるのに置けなくなる。
  if (isSetup) return game.board.vertices[game.setupLastVertex].edgeIds.filter((eId) => game.board.edges[eId].road == null);
  return E.availableRoadEdges(game, idx);
}

// ================================================================
// プレイヤー一覧
// ================================================================
function renderPlayers() {
  const idx = E.currentPlayer(game);
  els.playersBar.innerHTML = '';
  game.players.forEach((p, i) => {
    const chip = document.createElement('div');
    chip.className = `player-chip${i === idx ? ' is-turn' : ''}`;
    const bonus = [];
    if (game.longestRoadPlayer === i) bonus.push('最長路');
    if (game.largestArmyPlayer === i) bonus.push('騎士団');
    chip.innerHTML = `<div class="player-chip__head"><span class="player-chip__dot" style="background:${p.color}"></span>P${i + 1}${i === idx ? '<span class="player-chip__cur">▶</span>' : ''}</div>`
      + `<div class="player-chip__vp">${E.playerScore(game, i)}<span style="font-size:11px;color:var(--muted)"> 点</span></div>`
      + `<div class="player-chip__sub">手札 ${E.RESOURCES.reduce((a, r) => a + p.resources[r], 0)}</div>`
      + `<div class="player-chip__extra">${bonus.join(' ')}</div>`;
    els.playersBar.appendChild(chip);
  });
}

function renderHand() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  els.handBar.innerHTML = '';
  E.RESOURCES.forEach((r) => {
    const cell = document.createElement('div');
    cell.className = 'hand__res';
    cell.style.background = RES_BG[r];
    cell.appendChild(icon(r, 4));
    const b = document.createElement('b');
    b.textContent = `×${p.resources[r]}`;
    cell.appendChild(b);
    els.handBar.appendChild(cell);
  });
  const extra = document.createElement('div');
  extra.className = 'hand__extra';
  extra.innerHTML = `<span>🃏 発展カード ${p.devCards.filter((c) => !c.played).length}枚</span>`;
  els.handBar.appendChild(extra);
}

function renderDice() {
  els.diceBox.innerHTML = '';
  if (!game.diceLast) return;
  els.diceBox.appendChild(icon(`die${game.diceLast[0]}`, 3));
  els.diceBox.appendChild(icon(`die${game.diceLast[1]}`, 3));
}

function renderBanner() {
  const idx = E.currentPlayer(game);
  let main = '', hint = '';
  if (game.winner != null) main = `プレイヤー${game.winner + 1}の勝ち！`;
  else if (game.phase === 'setup1' || game.phase === 'setup2') {
    main = `プレイヤー${idx + 1}の番。`;
    hint = game.setupPending === 'road' ? '道を置く場所をタップ。' : '開拓地を置く場所をタップ。';
  } else if (game.phase === 'roll') { main = `プレイヤー${idx + 1}の手番。`; hint = 'サイコロを振ってください。'; }
  else if (game.phase === 'discard') { main = `プレイヤー${game.pendingDiscards[0].player + 1}は${game.pendingDiscards[0].count}枚捨てます。`; hint = '窓で捨てる資源を選んでください。'; }
  else if (game.phase === 'moveRobber') { main = `プレイヤー${idx + 1}の番。`; hint = '盗賊を動かすタイルをタップ。'; }
  else if (game.diceLast) main = `サイコロ ${game.diceLast[0]}＋${game.diceLast[1]}＝${game.diceLast[0] + game.diceLast[1]}。`;
  if (ui.mode === 'buildRoad') hint = '道を置く場所をタップ。';
  else if (ui.mode === 'buildSettlement') hint = '開拓地を置く場所をタップ。';
  else if (ui.mode === 'buildCity') hint = '都市にする開拓地をタップ。';
  else if (ui.mode === 'devKnightHex' || ui.mode === 'robberTargetForDev') hint = '盗賊を動かすタイルをタップ。';
  else if (ui.mode === 'devRoad1') hint = '街道建設: 1本目の道を置く場所をタップ。';
  else if (ui.mode === 'devRoad2') hint = '街道建設: 2本目の道を置く場所をタップ（終わってもよい）。';
  els.banner.innerHTML = `<div>${main}</div>` + (hint ? `<div class="message__hint">${hint}</div>` : '');
}

// ================================================================
// 建てるもの（常に4つ並べ、押したらその場で置く・買う）
// ================================================================
function costRow(cost) {
  const wrap = document.createElement('span');
  wrap.className = 'build-btn__cost';
  Object.entries(cost).forEach(([r, n]) => {
    wrap.appendChild(icon(r, 2));
    const s = document.createElement('span');
    s.textContent = `×${n}`;
    wrap.appendChild(s);
  });
  return wrap;
}
function canAfford(res, cost) { return Object.entries(cost).every(([k, v]) => (res[k] || 0) >= v); }

function renderBuildGrid() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  const inMain = game.phase === 'main';
  const defs = [
    { key: 'road', label: '道', cost: E.COSTS.road, ok: inMain && p.roads.length < 15 && canAfford(p.resources, E.COSTS.road) && E.availableRoadEdges(game, idx).length },
    { key: 'settlement', label: '開拓地', cost: E.COSTS.settlement, ok: inMain && p.settlements.length < 5 && canAfford(p.resources, E.COSTS.settlement) && E.availableSettlementVertices(game, idx, false).length },
    { key: 'city', label: '都市', cost: E.COSTS.city, ok: inMain && p.cities.length < 4 && canAfford(p.resources, E.COSTS.city) && E.availableCityVertices(game, idx).length },
    { key: 'dev', label: '発展カード', cost: E.COSTS.dev, ok: inMain && game.bank.devDeck.length > 0 && canAfford(p.resources, E.COSTS.dev) },
  ];
  els.buildGrid.innerHTML = '';
  defs.forEach((d) => {
    const btn = document.createElement('button');
    const active = (d.key === 'road' && ui.mode === 'buildRoad') || (d.key === 'settlement' && ui.mode === 'buildSettlement') || (d.key === 'city' && ui.mode === 'buildCity');
    btn.className = `pixel-btn build-btn${active ? ' is-selected' : ''}`;
    btn.disabled = !d.ok;
    const label = document.createElement('span');
    label.textContent = d.label;
    btn.appendChild(label);
    btn.appendChild(costRow(d.cost));
    btn.addEventListener('click', () => {
      if (d.key === 'dev') { E.buyDevCard(game); playEvents(); persistAndRender(); return; }
      if (active) { ui = { mode: 'idle', data: {} }; renderAll(); return; }
      ui = { mode: d.key === 'road' ? 'buildRoad' : d.key === 'settlement' ? 'buildSettlement' : 'buildCity', data: {} };
      renderAll();
    });
    els.buildGrid.appendChild(btn);
  });
}

// ================================================================
// 操作パネル（画面中央の窓。交易・捨てる・盗む相手選び・発展カードなど）
// ================================================================
function openPanel() { els.panelOverlay.hidden = false; }
function closePanel() { els.panelOverlay.hidden = true; els.panel.innerHTML = ''; }

function renderPanel() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];

  if (ui.mode === 'discard' && game.phase === 'discard') { openPanel(); renderDiscardPanel(); return; }
  if (ui.data.pendingHex != null) { openPanel(); renderRobberTargetPanel(ui.data.pendingHex, ui.data.forDev); return; }
  if (ui.mode === 'tradeMenu') { openPanel(); renderTradeMenu(); return; }
  if (ui.mode === 'devMenu') { openPanel(); renderDevMenu(); return; }
  if (ui.mode === 'devYearOfPlenty') { openPanel(); renderYearOfPlentyPanel(); return; }
  if (ui.mode === 'devMonopoly') { openPanel(); renderMonopolyPanel(); return; }
  if (ui.mode === 'devRoad2') { openPanel(); renderDevRoadFinish(); return; }
  closePanel();
}

function bindPanel(actions) {
  els.panel.onclick = (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const fn = actions[btn.dataset.act];
    if (fn) fn(btn);
  };
}

function renderDiscardPanel() {
  const d = game.pendingDiscards[0];
  const p = game.players[d.player];
  const picked = ui.data.discardPicked || (ui.data.discardPicked = E.RESOURCES.reduce((o, r) => ({ ...o, [r]: 0 }), {}));
  const total = Object.values(picked).reduce((a, b) => a + b, 0);
  els.panel.innerHTML = `<h2>プレイヤー${d.player + 1}: ${d.count}枚捨てる（あと${d.count - total}枚）</h2>`
    + E.RESOURCES.map((r) => `<div class="sheet__row"><span class="res-pick__label" data-row="${r}">持ち${p.resources[r]}</span>
        <span class="stepper">
          <button data-act="dec" data-res="${r}">−</button><b>${picked[r]}</b>
          <button data-act="inc" data-res="${r}">＋</button>
        </span></div>`).join('')
    + `<button class="pixel-btn pixel-btn--accent" data-act="confirm" ${total === d.count ? '' : 'disabled'}>捨てる</button>`;
  // 資源のアイコンを差し込む
  E.RESOURCES.forEach((r) => {
    const span = els.panel.querySelector(`[data-row="${r}"]`);
    span.prepend(icon(r, 2));
  });
  bindPanel({
    inc: (b) => { const r = b.dataset.res; if (picked[r] < p.resources[r] && total < d.count) { picked[r]++; renderPanel(); } },
    dec: (b) => { const r = b.dataset.res; if (picked[r] > 0) { picked[r]--; renderPanel(); } },
    confirm: () => {
      E.discardCards(game, d.player, picked);
      ui.data.discardPicked = null;
      if (game.phase === 'discard') { renderPanel(); } else { ui = { mode: 'moveRobber', data: {} }; persistAndRender(); }
    },
  });
}

function renderRobberTargetPanel(hexId, forDev) {
  const idx = E.currentPlayer(game);
  const targets = E.robberTargets(game, hexId, idx);
  els.panel.innerHTML = `<h2>誰から奪う？</h2>`
    + (targets.length ? targets.map((t) => `<button class="card-btn" data-act="pick" data-target="${t}">プレイヤー${t + 1}（手札${E.RESOURCES.reduce((a, r) => a + game.players[t].resources[r], 0)}枚）</button>`).join('')
      : `<button class="card-btn" data-act="pick" data-target="">誰も奪えない</button>`);
  bindPanel({
    pick: (b) => {
      const target = b.dataset.target === '' ? null : Number(b.dataset.target);
      if (forDev != null) E.playKnight(game, forDev, hexId, target);
      else E.moveRobber(game, hexId, target);
      ui = { mode: 'idle', data: {} };
      playEvents();
      persistAndRender();
    },
  });
}

function renderTradeMenu() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  const give = ui.data.tradeGive || (ui.data.tradeGive = E.RESOURCES[0]);
  const want = ui.data.tradeWant || (ui.data.tradeWant = E.RESOURCES[1]);
  const rate = E.playerPortRate(game, idx, give);
  const other = ui.data.tradeOther == null ? (idx + 1) % game.playerCount : ui.data.tradeOther;
  const pGive = ui.data.pGive || (ui.data.pGive = E.RESOURCES.reduce((o, r) => ({ ...o, [r]: 0 }), {}));
  const pGet = ui.data.pGet || (ui.data.pGet = E.RESOURCES.reduce((o, r) => ({ ...o, [r]: 0 }), {}));

  els.panel.innerHTML = `<h2>銀行・港と交易</h2>
    <div class="sheet__row"><span>出す（${rate}枚で1枚）</span><div class="res-pick" data-row="give"></div></div>
    <div class="sheet__row"><span>もらう</span><div class="res-pick" data-row="want"></div></div>
    <button class="pixel-btn pixel-btn--accent" data-act="bank" ${p.resources[give] >= rate && give !== want ? '' : 'disabled'}>${rate}:1で交易する</button>
    <hr style="border-color:rgba(255,255,255,0.15)">
    <h2>相手と交易</h2>
    <div class="sheet__row"><span>相手</span><div class="res-pick" data-row="other"></div></div>
    <div class="sheet__row"><span>渡す</span><div class="res-pick" data-row="pgive"></div></div>
    <div class="sheet__row"><span>もらう</span><div class="res-pick" data-row="pget"></div></div>
    <button class="pixel-btn pixel-btn--accent" data-act="playerTrade">この内容で成立させる</button>
    <button class="ghost-btn" data-act="cancel">やめる</button>`;

  fillResPick(els.panel.querySelector('[data-row="give"]'), E.RESOURCES, (r) => r === give, (r, b) => {
    b.appendChild(icon(r, 2)); const s = document.createElement('span'); s.textContent = `×${p.resources[r]}`; b.appendChild(s);
  }, 'give');
  fillResPick(els.panel.querySelector('[data-row="want"]'), E.RESOURCES, (r) => r === want, (r, b) => b.appendChild(icon(r, 2)), 'want');
  fillOtherPick(els.panel.querySelector('[data-row="other"]'), other);
  fillStepperRow(els.panel.querySelector('[data-row="pgive"]'), pGive, (r) => p.resources[r], 'pg');
  fillStepperRow(els.panel.querySelector('[data-row="pget"]'), pGet, (r) => game.players[other].resources[r], 'pw');

  bindPanel({
    give: (b) => { ui.data.tradeGive = b.dataset.res; renderPanel(); },
    want: (b) => { ui.data.tradeWant = b.dataset.res; renderPanel(); },
    other: (b) => { ui.data.tradeOther = Number(b.dataset.p); renderPanel(); },
    pginc: (b) => { const r = b.dataset.res; if (pGive[r] < p.resources[r]) { pGive[r]++; renderPanel(); } },
    pgdec: (b) => { const r = b.dataset.res; if (pGive[r] > 0) { pGive[r]--; renderPanel(); } },
    pwinc: (b) => { const r = b.dataset.res; if (pGet[r] < game.players[other].resources[r]) { pGet[r]++; renderPanel(); } },
    pwdec: (b) => { const r = b.dataset.res; if (pGet[r] > 0) { pGet[r]--; renderPanel(); } },
    bank: () => { E.bankTrade(game, give, want); ui.data.tradeGive = null; ui.data.tradeWant = null; playEvents(); persistAndRender(); renderPanel(); },
    playerTrade: () => {
      E.playerTrade(game, other, pGive, pGet);
      ui.data.pGive = null; ui.data.pGet = null;
      playEvents(); persistAndRender(); renderPanel();
    },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}
function fillResPick(container, list, isSelected, build, act) {
  list.forEach((r) => {
    const b = document.createElement('button');
    b.dataset.act = act; b.dataset.res = r;
    if (isSelected(r)) b.classList.add('is-selected');
    build(r, b);
    container.appendChild(b);
  });
}
function fillOtherPick(container, other) {
  const idx = E.currentPlayer(game);
  game.players.forEach((_, i) => {
    if (i === idx) return;
    const b = document.createElement('button');
    b.dataset.act = 'other'; b.dataset.p = i;
    if (i === other) b.classList.add('is-selected');
    b.textContent = `プレイヤー${i + 1}`;
    container.appendChild(b);
  });
}
function fillStepperRow(container, obj, max, prefix) {
  E.RESOURCES.forEach((r) => {
    const span = document.createElement('span');
    span.className = 'stepper';
    span.appendChild(icon(r, 2));
    const dec = document.createElement('button'); dec.dataset.act = `${prefix}dec`; dec.dataset.res = r; dec.textContent = '−';
    const b = document.createElement('b'); b.textContent = obj[r];
    const inc = document.createElement('button'); inc.dataset.act = `${prefix}inc`; inc.dataset.res = r; inc.textContent = '＋';
    span.append(dec, b, inc);
    container.appendChild(span);
  });
}

function renderDevMenu() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  const playable = (c) => !game.devCardPlayedThisTurn && !c.played && c.type !== 'vp' && c.boughtTurn !== game.turnNumber;
  const rows = p.devCards.map((c, i) => {
    if (c.played) return '';
    const label = E.DEV_LABEL[c.type];
    if (c.type === 'vp') return `<div class="sheet__row"><span>${label}</span><span>（そのまま得点）</span></div>`;
    return `<div class="sheet__row"><span>${label}</span><button class="ghost-btn" data-act="play" data-i="${i}" ${playable(c) ? '' : 'disabled'}>使う</button></div>`;
  }).join('') || '<p>持っていません</p>';
  els.panel.innerHTML = `<h2>発展カード</h2>${rows}<button class="ghost-btn" data-act="cancel">戻る</button>`;
  bindPanel({
    play: (b) => {
      const i = Number(b.dataset.i);
      const type = p.devCards[i].type;
      if (type === 'knight') ui = { mode: 'devKnightHex', data: { cardIdx: i } };
      else if (type === 'roadBuilding') ui = { mode: 'devRoad1', data: { cardIdx: i, edges: [] } };
      else if (type === 'yearOfPlenty') ui = { mode: 'devYearOfPlenty', data: { cardIdx: i, picked: [] } };
      else if (type === 'monopoly') ui = { mode: 'devMonopoly', data: { cardIdx: i } };
      renderAll();
    },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}

function renderYearOfPlentyPanel() {
  const picked = ui.data.picked;
  els.panel.innerHTML = `<h2>収穫: 好きな資源を2つ選ぶ（${picked.length}/2）</h2>
    <div class="res-pick" data-row="pick"></div>
    <p>選んだ: ${picked.length ? '' : 'なし'}</p>
    <button class="pixel-btn pixel-btn--accent" data-act="confirm" ${picked.length === 2 ? '' : 'disabled'}>受け取る</button>
    <button class="ghost-btn" data-act="cancel">やめる</button>`;
  fillResPick(els.panel.querySelector('[data-row="pick"]'), E.RESOURCES, () => false, (r, b) => b.appendChild(icon(r, 2)), 'pick');
  const p = els.panel.querySelector('p');
  picked.forEach((r) => p.appendChild(icon(r, 2)));
  bindPanel({
    pick: (b) => { if (picked.length < 2) { picked.push(b.dataset.res); renderPanel(); } },
    confirm: () => {
      E.playYearOfPlenty(game, ui.data.cardIdx, picked[0], picked[1]);
      ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender();
    },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}
function renderMonopolyPanel() {
  els.panel.innerHTML = `<h2>独占: 総取りする資源を選ぶ</h2>
    <div class="res-pick" data-row="pick"></div>
    <button class="ghost-btn" data-act="cancel">やめる</button>`;
  fillResPick(els.panel.querySelector('[data-row="pick"]'), E.RESOURCES, () => false, (r, b) => b.appendChild(icon(r, 2)), 'pick');
  bindPanel({
    pick: (b) => { E.playMonopoly(game, ui.data.cardIdx, b.dataset.res); ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}

// devRoad2 で「終わってもよい」を押せるように
function renderDevRoadFinish() {
  els.panel.innerHTML = `<h2>街道建設</h2><p class="sheet__row">2本目の道を置くか、ここで終わってください。</p>
    <button class="pixel-btn pixel-btn--accent" data-act="finish">1本だけで終わる</button>
    <button class="ghost-btn" data-act="cancel">やめる</button>`;
  bindPanel({
    finish: () => { E.playRoadBuilding(game, ui.data.cardIdx, ui.data.edges); ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}

// ================================================================
// 操作ボタン
// ================================================================
function renderActionBar() {
  const rollable = game.phase === 'roll';
  const buildable = game.phase === 'main';
  els.diceBtn.disabled = !rollable;
  els.diceBtn.textContent = rollable ? 'サイコロ' : (game.phase === 'main' ? 'サイコロ済' : 'サイコロ');
  els.tradeBtn.disabled = !buildable;
  els.devBtn.disabled = !buildable;
  { const n = game.players[E.currentPlayer(game)].devCards.filter((c) => !c.played).length; els.devBtn.textContent = `発展${n ? ` ${n}` : ''}`; }
  els.endTurnBtn.disabled = !buildable;
}
els.diceBtn.addEventListener('click', () => {
  if (game.phase !== 'roll') return;
  E.rollDice(game);
  ui = { mode: modeForPhase(), data: {} };
  playEvents();
  persistAndRender();
});
els.tradeBtn.addEventListener('click', () => { ui = { mode: 'tradeMenu', data: {} }; renderAll(); });
els.devBtn.addEventListener('click', () => { ui = { mode: 'devMenu', data: {} }; renderAll(); });
els.endTurnBtn.addEventListener('click', () => {
  E.endTurn(game);
  ui = { mode: 'idle', data: {} };
  persistAndRender();
});

// ================================================================
// 盤面のタップ
// ================================================================
els.board.addEventListener('click', (e) => {
  const vEl = e.target.closest('[data-vertex]');
  const eEl = e.target.closest('[data-edge]');
  const hEl = e.target.closest('[data-hex]');
  if (vEl) return onVertexTap(Number(vEl.dataset.vertex));
  if (eEl) return onEdgeTap(Number(eEl.dataset.edge));
  if (hEl) return onHexTap(Number(hEl.dataset.hex));
});

function onVertexTap(vid) {
  if (ui.mode === 'setupSettlement') { E.setupPlaceSettlement(game, vid); ui = { mode: modeForPhase(), data: {} }; playEvents(); persistAndRender(); return; }
  if (ui.mode === 'buildSettlement') { if (E.buildSettlement(game, vid)) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } return; }
  if (ui.mode === 'buildCity') { if (E.buildCity(game, vid)) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } return; }
}
function onEdgeTap(eid) {
  if (ui.mode === 'setupRoad') { E.setupPlaceRoad(game, eid); ui = { mode: modeForPhase(), data: {} }; playEvents(); persistAndRender(); return; }
  if (ui.mode === 'buildRoad') { if (E.buildRoad(game, eid)) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } return; }
  if (ui.mode === 'devRoad1') { if (E.canPlaceRoad(game, eid, E.currentPlayer(game))) { ui.data.edges = [eid]; ui.mode = 'devRoad2'; renderAll(); } return; }
  if (ui.mode === 'devRoad2') {
    const picked = [...ui.data.edges, eid];
    E.playRoadBuilding(game, ui.data.cardIdx, picked);
    ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender();
  }
}
function onHexTap(hid) {
  if (ui.mode === 'moveRobber') {
    if (hid === game.board.robberHex) return;
    const idx = E.currentPlayer(game);
    const targets = E.robberTargets(game, hid, idx);
    if (targets.length > 1) { ui.data.pendingHex = hid; ui.data.forDev = null; renderAll(); }
    else { E.moveRobber(game, hid, targets[0] ?? null); ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); }
    return;
  }
  if (ui.mode === 'devKnightHex') {
    if (hid === game.board.robberHex) return;
    const idx = E.currentPlayer(game);
    const targets = E.robberTargets(game, hid, idx);
    if (targets.length > 1) { ui.data.pendingHex = hid; ui.data.forDev = ui.data.cardIdx; renderAll(); }
    else { E.playKnight(game, ui.data.cardIdx, hid, targets[0] ?? null); ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); }
  }
}

// ================================================================
// まとめて描画
// ================================================================
// ---- タイトルの飾りの盤（操作できない、見た目だけ） ----
renderBoardInto(els.titleBoard, E.createGame(4, Math.random), null);

function renderAll() {
  if (!game) return;
  if (game.phase === 'moveRobber' && ui.mode !== 'moveRobber' && ui.mode !== 'robberTarget') ui = { mode: 'moveRobber', data: {} };
  if (game.phase === 'discard' && ui.mode !== 'discard') ui = { mode: 'discard', data: {} };
  renderBoardInto(els.board, game, ui);
  renderDice();
  renderPlayers();
  renderHand();
  renderBuildGrid();
  renderBanner();
  renderActionBar();
  renderPanel();
}
