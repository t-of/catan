'use strict';
// ルール・盤面・得点計算は engine.js（画面・音を持たない）。イラストの絵の部品は illust.js。
// ここは見た目の組み立てと入力だけ。
import * as E from './engine.js';
import * as I from './illust.js';

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

// 盤の動き（波・木・羊など）のオン・オフ。動きを減らす設定の端末では、はじめはオフ。
const motionBtn = document.getElementById('motionBtn');
function setMotion(on) {
  document.documentElement.classList.toggle('motion-off', !on);
  motionBtn.setAttribute('aria-pressed', String(on));
  motionBtn.textContent = on ? '動き オン' : '動き オフ';
  save('motion', on);
}
setMotion(load('motion', !matchMedia('(prefers-reduced-motion: reduce)').matches));
motionBtn.addEventListener('click', () => setMotion(motionBtn.getAttribute('aria-pressed') !== 'true'));

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
  titleBoard: document.getElementById('titleBoard'),
  playerCountPicker: document.getElementById('playerCountPicker'),
  startBtn: document.getElementById('startBtn'),
  continueBtn: document.getElementById('continueBtn'),
  turnNum: document.getElementById('turnNum'),
  board: document.getElementById('board'),
  diceBox: document.getElementById('diceBox'),
  hint: document.getElementById('hint'),
  banner: document.getElementById('banner'),
  playersBar: document.getElementById('playersBar'),
  bankPanel: document.getElementById('bankPanel'),
  handBar: document.getElementById('handBar'),
  handCount: document.getElementById('handCount'),
  buildGrid: document.getElementById('buildGrid'),
  panelOverlay: document.getElementById('panelOverlay'),
  panel: document.getElementById('panel'),
  actionBar: document.getElementById('actionBar'),
  diceBtn: document.getElementById('diceBtn'),
  tradeBtn: document.getElementById('tradeBtn'),
  devBtn: document.getElementById('devBtn'),
  endTurnBtn: document.getElementById('endTurnBtn'),
};

const SCALE = 66; // 1マス単位(外接円半径1) → SVG座標のピクセル。illust.js の地形の絵は R=66 に合わせて置いてある。
const RES_LABEL = { wood: '木', brick: '土', sheep: '羊', wheat: '麦', ore: '鉄' };
const RES_COLOR = { wood: '#3f8a4a', brick: '#c0643a', sheep: '#8cc063', wheat: '#e0b440', ore: '#8a92a3' };
const PORT_TERRAIN = { wood: 'forest', brick: 'hills', sheep: 'pasture', wheat: 'field', ore: 'mountains' };

// 資源・建物などの小さなアイコン（40x40 の viewBox。svg は CSS の幅・高さで好きな大きさに拡大できる）
function resIcon(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('class', 'res-icon');
  const shapes = [];
  I.resourceIcon(shapes, kind);
  shapes.forEach((s) => svg.appendChild(pathEl(s)));
  return svg;
}
function pathEl(s) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  n.setAttribute('d', s.d);
  n.setAttribute('fill', s.f);
  let st = `opacity:${s.o};stroke:${s.sk};stroke-width:${s.sw}px;stroke-linejoin:round;stroke-linecap:round`;
  if (s.c) {
    n.setAttribute('class', s.c);
    // 盤は操作のたびに描き直すので、ページを開いた時刻からの経過ぶん遅らせて、動きが毎回頭から始まらないようにする
    st += `;transform-origin:${s.ox}px ${s.oy}px;animation-delay:${(s.dl - performance.now() / 1000).toFixed(2)}s`;
  }
  n.setAttribute('style', st);
  return n;
}
function buildIcon(key, color) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 28 28');
  svg.setAttribute('class', 'build-btn__icon');
  const shapes = [];
  const dark = I.tint(color, -0.4), light = I.tint(color, 0.35);
  if (key === 'road') { I.add(shapes, I.line(5, 21, 23, 7), 'none', 1, '#1b1612', 8); I.add(shapes, I.line(5, 21, 23, 7), 'none', 1, color, 4.5); }
  else if (key === 'settlement') I.house(shapes, 14, 17, color, dark, light);
  else if (key === 'city') I.city(shapes, 14, 17, color, dark, light);
  else if (key === 'dev') { I.add(shapes, I.rect(6, 3, 16, 22), '#f6eedb', 1, '#1b1612', 1.5); I.add(shapes, I.rect(9, 6, 10, 10), '#7a5bb8', 0.85); }
  shapes.forEach((s) => svg.appendChild(pathEl(s)));
  return svg;
}
function dieEl(value, rotateDeg) {
  const wrap = document.createElement('div');
  wrap.className = 'die';
  wrap.style.transform = `rotate(${rotateDeg}deg)`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', 46); svg.setAttribute('height', 46);
  const PIPS = {
    1: [[23, 23]], 2: [[14, 14], [32, 32]], 3: [[13, 13], [23, 23], [33, 33]],
    4: [[14, 14], [32, 14], [14, 32], [32, 32]], 5: [[13, 13], [33, 13], [23, 23], [13, 33], [33, 33]],
    6: [[14, 12], [32, 12], [14, 23], [32, 23], [14, 34], [32, 34]],
  }[value] || [];
  PIPS.forEach(([x, y]) => {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', 4.2); c.setAttribute('fill', '#2a211b');
    svg.appendChild(c);
  });
  wrap.appendChild(svg);
  return wrap;
}

let game = null;
let playerCount = load('playerCount', 3) === 4 ? 4 : 3;
let ui = { mode: 'idle', data: {} };

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
// illust.js の図形（パス文字列と塗り色）をゲームの状態（タイル・道・建物・盗賊・置ける場所）に
// 合わせて並べ、<path>・<text> として SVG に足す。<defs>（タイルのグラデーション）だけは
// 毎回の再描画で消さずに使い回す。
// ================================================================
const svgNS = 'http://www.w3.org/2000/svg';
function el(tag, attrs, parent) {
  const n = document.createElementNS(svgNS, tag);
  Object.entries(attrs || {}).forEach(([k, v]) => n.setAttribute(k, v));
  if (parent) parent.appendChild(n);
  return n;
}
function ensureDefs(svg) {
  let defs = svg.querySelector('defs');
  if (!defs) { defs = el('defs', {}); defs.innerHTML = I.defsMarkup(svg.id); svg.appendChild(defs); }
  return defs;
}

function hexCenterPx(g, hex) {
  const vs = hex.vertexIds.map((id) => g.board.vertices[id]);
  const cx = vs.reduce((a, v) => a + v.x, 0) / vs.length;
  const cy = vs.reduce((a, v) => a + v.y, 0) / vs.length;
  return [cx * SCALE, cy * SCALE];
}
function hexPointsPx(g, hex) {
  return hex.vertexIds.map((id) => { const v = g.board.vertices[id]; return [v.x * SCALE, v.y * SCALE]; });
}
function viewBoxOf(g) {
  const xs = g.board.vertices.map((v) => v.x * SCALE);
  const ys = g.board.vertices.map((v) => v.y * SCALE);
  const margin = SCALE * 1.15;
  const minX = Math.min(...xs) - margin, maxX = Math.max(...xs) + margin;
  const minY = Math.min(...ys) - margin, maxY = Math.max(...ys) + margin;
  return { minX, minY, w: maxX - minX, h: maxY - minY };
}

function renderBoardInto(svg, g, uiState) {
  const defs = ensureDefs(svg);
  [...svg.children].forEach((c) => { if (c !== defs) c.remove(); });
  const idx = E.currentPlayer(g);
  const vb = viewBoxOf(g);
  svg.setAttribute('viewBox', `${vb.minX} ${vb.minY} ${vb.w} ${vb.h}`);

  const S = []; // 塗りの図形（順に描く）
  const labels = []; // 文字
  const overlay = []; // タップ判定・盤ハイライトの実要素（色の図形より後に乗せる）
  const queue = (tag, attrs) => overlay.push({ tag, attrs });

  // 波（飾り。毎回同じ並びでよい）
  for (let k = 0; k < 26; k++) {
    const x = vb.minX + ((k * 137 + 40) % Math.max(1, vb.w));
    const y = vb.minY + ((k * 71 + 20) % Math.max(1, vb.h));
    I.add(S, `M${x},${y} q7,-5 14,0 t14,0`, 'none', 0.18, '#bfe6ee', 1.5);
    I.tag(S, S.length - 1, 'a-wave', x, y, -k * 0.6);
  }

  // 浅瀬と砂浜のふち
  const allHexPath = g.board.hexes.map((h) => I.poly(hexPointsPx(g, h))).join(' ');
  I.add(S, allHexPath, '#5fb7b5', 0.25, '#5fb7b5', 66);
  I.tag(S, S.length - 1, 'a-surf', 0, 0, 0);
  I.add(S, allHexPath, '#e7d3a1', 1, '#e7d3a1', 30);
  I.add(S, allHexPath, '#cdb683', 1, '#cdb683', 12);

  // タイル本体
  g.board.hexes.forEach((hex) => {
    const [cx, cy] = hexCenterPx(g, hex);
    const pts = hexPointsPx(g, hex);
    const style = I.TERRAIN_STYLE[hex.terrain];
    const shrink = (p, k) => p.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
    I.add(S, I.poly(shrink(pts, 0.98)), style.edge);
    I.add(S, I.poly(shrink(pts, 0.94)), `url(#${svg.id}-g-${style.grad})`);
    I.add(S, I.poly(shrink(pts, 0.88)), 'none', 0.22, '#ffffff', 1.5);
    I.terrainDecor(S, hex.terrain, cx, cy);
    if (hex.number != null) {
      const hot = hex.number === 6 || hex.number === 8;
      I.add(S, I.ell(cx + 1, cy + 3, 19, 19), '#000', 0.28);
      I.add(S, I.ell(cx, cy, 18, 18), `url(#${svg.id}-g-token)`, 1, '#c7b58b', 1.2);
      labels.push({ x: cx, y: cy - 3, t: String(hex.number), f: hot ? '#b8321f' : '#2a211b', s: hot ? 21 : 19, w: 700 });
      const dots = 6 - Math.abs(7 - hex.number);
      for (let d = 0; d < dots; d++) I.add(S, I.ell(cx - (dots - 1) * 2.4 + d * 4.8, cy + 10, 1.3, 1.3), hot ? '#b8321f' : '#2a211b');
    }
  });

  // 港（銀行との交換レートの札）
  g.board.portEdgeIds.forEach((eId) => {
    const e = g.board.edges[eId];
    const v1 = g.board.vertices[e.v1], v2 = g.board.vertices[e.v2];
    const mx = (v1.x + v2.x) / 2 * SCALE, my = (v1.y + v2.y) / 2 * SCALE;
    const len = Math.hypot(mx, my) || 1;
    const px = mx + (mx / len) * (SCALE * 0.55), py = my + (my / len) * (SCALE * 0.55);
    const type = v1.port;
    const isAny = type === '3:1';
    const bg = isAny ? '#f6eedb' : RES_COLOR[type];
    I.add(S, I.line(mx, my, px, py), 'none', 1, '#6e5436', 7);
    I.add(S, I.line(mx, my, px, py), 'none', 1, '#9a7a52', 3);
    I.add(S, I.ell(px, py + 2, 18, 18), '#000', 0.25);
    I.add(S, I.ell(px, py, 18, 18), '#f6eedb', 1, isAny ? '#b9a980' : bg, 3);
    labels.push({ x: px, y: isAny ? py + 5 : py + 1, t: isAny ? '3:1' : '2:1', f: '#2a211b', s: 13, w: 700 });
    if (!isAny) labels.push({ x: px, y: py + 13, t: RES_LABEL[type], f: bg, s: 10, w: 700 });
  });

  // 道（既存＋置ける場所）
  const buildableEdges = uiState && (uiState.mode === 'setupRoad' || uiState.mode === 'buildRoad' || uiState.mode === 'devRoad1' || uiState.mode === 'devRoad2')
    ? new Set(edgeChoices()) : new Set();
  g.board.edges.forEach((edge) => {
    const v1 = g.board.vertices[edge.v1], v2 = g.board.vertices[edge.v2];
    const x1 = v1.x * SCALE, y1 = v1.y * SCALE, x2 = v2.x * SCALE, y2 = v2.y * SCALE;
    const tx1 = x1 + (x2 - x1) * 0.1, ty1 = y1 + (y2 - y1) * 0.1;
    const tx2 = x1 + (x2 - x1) * 0.9, ty2 = y1 + (y2 - y1) * 0.9;
    if (edge.road != null) {
      const color = g.players[edge.road].color;
      I.add(S, I.line(tx1 + 1, ty1 + 3, tx2 + 1, ty2 + 3), 'none', 0.3, '#000', 10);
      I.add(S, I.line(tx1, ty1, tx2, ty2), 'none', 1, '#1b1612', 10);
      I.add(S, I.line(tx1, ty1, tx2, ty2), 'none', 1, color, 6);
      I.add(S, I.line(tx1, ty1 - 1, tx2, ty2 - 1), 'none', 0.35, '#ffffff', 1.5);
    } else if (buildableEdges.has(edge.id)) {
      I.add(S, I.line(tx1, ty1, tx2, ty2), 'none', 1, '#1b1612', 9);
      I.add(S, I.line(tx1, ty1, tx2, ty2), 'none', 0.85, 'var(--accent)', 5);
      queue('line', { x1, y1, x2, y2, class: 'road-hit', 'data-edge': edge.id });
    } else {
      queue('line', { x1, y1, x2, y2, stroke: 'rgba(255,255,255,0.14)', 'stroke-width': 2.5 });
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
      const dark = I.tint(color, -0.4), light = I.tint(color, 0.35);
      if (v.building.type === 'city') I.city(S, x, y, color, dark, light);
      else I.house(S, x, y, color, dark, light);
    } else if (buildableVerts.has(v.id)) {
      I.add(S, I.ell(x, y, 15, 15), '#f0cf85', 0.3);
      I.add(S, I.ell(x, y, 9, 9), '#f0cf85', 0.6, '#fff3cf', 2.5);
      queue('circle', { cx: x, cy: y, r: 12, class: 'vertex-hit', 'data-vertex': v.id });
    }
  });

  // 盗賊
  {
    const [cx, cy] = hexCenterPx(g, g.board.hexes[g.board.robberHex]);
    I.robber(S, cx + 2, cy + 14, 1.15);
  }

  // 盗賊を置ける場所（タイル自体をタップできるようにする）
  if (uiState && (uiState.mode === 'moveRobber' || uiState.mode === 'devKnightHex')) {
    g.board.hexes.forEach((hex) => {
      if (hex.id === g.board.robberHex) return;
      const pts = hexPointsPx(g, hex).map(([x, y]) => `${x},${y}`).join(' ');
      queue('polygon', { points: pts, class: 'hex-target', 'data-hex': hex.id });
    });
  }

  S.forEach((s) => svg.appendChild(pathEl(s)));
  labels.forEach((l) => {
    const n = el('text', {
      x: l.x, y: l.y, fill: l.f, class: 'hex-number',
      style: `font-family:'Fraunces',serif;font-size:${l.s}px;font-weight:${l.w};text-anchor:middle;dominant-baseline:central`,
    }, svg);
    n.textContent = l.t;
  });
  overlay.forEach((o) => el(o.tag, o.attrs, svg));
}

// 数字チップ・港の文字の位置は port-label と同じ Fraunces を使う

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
// プレイヤー一覧・銀行
// ================================================================
function renderPlayers() {
  const idx = E.currentPlayer(game);
  els.playersBar.innerHTML = '';
  game.players.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = `player-card${i === idx ? ' is-turn' : ''}`;
    const light = I.tint(p.color, 0.45), dark = I.tint(p.color, -0.35);
    const dot = document.createElement('div');
    dot.className = 'player-card__dot';
    dot.style.background = `radial-gradient(circle at 35% 30%, ${light}, ${p.color} 60%, ${dark})`;
    dot.textContent = String(i + 1);
    const body = document.createElement('div');
    body.className = 'player-card__body';
    const bonus = [];
    if (game.longestRoadPlayer === i) bonus.push('最長路');
    if (game.largestArmyPlayer === i) bonus.push('騎士団');
    body.innerHTML = `<div class="player-card__name">P${i + 1}${i === idx ? '<span class="player-card__cur">手番</span>' : ''}</div>`
      + `<div class="player-card__sub">手札 ${E.RESOURCES.reduce((a, r) => a + p.resources[r], 0)}・騎士 ${p.knightsPlayed}</div>`
      + `<div class="player-card__extra">${bonus.join(' ')}</div>`;
    const vp = document.createElement('div');
    vp.className = 'player-card__vp';
    vp.innerHTML = `<b>${E.playerScore(game, i)}</b><span>点</span>`;
    card.append(dot, body, vp);
    els.playersBar.appendChild(card);
  });
}

function renderBank() {
  els.bankPanel.innerHTML = `<div class="bank__head"><span>銀行</span><span>発展カード 残り ${game.bank.devDeck.length}</span></div>`;
  const grid = document.createElement('div');
  grid.className = 'bank__grid';
  E.RESOURCES.forEach((r) => {
    const cell = document.createElement('div');
    cell.className = 'bank__res';
    cell.appendChild(resIcon(r));
    const b = document.createElement('b');
    b.textContent = game.bank.resources[r];
    cell.appendChild(b);
    grid.appendChild(cell);
  });
  els.bankPanel.appendChild(grid);
}

function renderHand() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  els.handBar.innerHTML = '';
  E.RESOURCES.forEach((r) => {
    const cell = document.createElement('div');
    cell.className = 'hand__res';
    cell.appendChild(resIcon(r));
    const b = document.createElement('b');
    b.textContent = `×${p.resources[r]}`;
    cell.appendChild(b);
    els.handBar.appendChild(cell);
  });
  const extra = document.createElement('div');
  extra.className = 'hand__extra';
  extra.textContent = `発展カード ${p.devCards.filter((c) => !c.played).length}枚`;
  els.handBar.appendChild(extra);
  els.handCount.textContent = `${E.RESOURCES.reduce((a, r) => a + p.resources[r], 0)} 枚`;
}

function renderDice() {
  els.diceBox.innerHTML = '';
  if (!game.diceLast) return;
  els.diceBox.appendChild(dieEl(game.diceLast[0], -8));
  els.diceBox.appendChild(dieEl(game.diceLast[1], 7));
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
  els.hint.textContent = hint;
  const lastLog = game.log[game.log.length - 1];
  els.banner.innerHTML = `<div>${main}</div>` + (lastLog ? `<div class="message__log">ひとつ前: ${lastLog}</div>` : '');
  els.turnNum.textContent = String(game.turnNumber);
}

// ================================================================
// 建てるもの（常に4つ並べ、押したらその場で置く・買う）
// ================================================================
function costRow(cost) {
  const wrap = document.createElement('span');
  wrap.className = 'build-btn__cost';
  Object.entries(cost).forEach(([r, n]) => {
    wrap.appendChild(resIcon(r));
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
    btn.className = `build-btn${active ? ' is-selected' : ''}`;
    btn.disabled = !d.ok;
    btn.appendChild(buildIcon(d.key, p.color));
    const label = document.createElement('span');
    label.className = 'build-btn__label';
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
  if (ui.mode === 'discard' && game.phase === 'discard') { openPanel(); renderDiscardPanel(); return; }
  if (ui.data.pendingHex != null) { openPanel(); renderRobberTargetPanel(ui.data.pendingHex, ui.data.forDev); return; }
  if (ui.mode === 'tradeMenu') { openPanel(); renderTradeMenu(); return; }
  if (ui.mode === 'devMenu') { openPanel(); renderDevMenu(); return; }
  if (ui.mode === 'devYearOfPlenty') { openPanel(); renderYearOfPlentyPanel(); return; }
  if (ui.mode === 'devMonopoly') { openPanel(); renderMonopolyPanel(); return; }
  if (ui.mode === 'devRoad2') { openPanel(); renderDevRoadFinish(); return; }
  if (game.winner != null) { openPanel(); renderWinPanel(); return; }
  closePanel();
}

function renderWinPanel() {
  els.panel.innerHTML = `<h2>プレイヤー${game.winner + 1}の勝ち！</h2><p>10点に到達しました。</p>
    <button class="btn btn--accent" data-act="close">とじる</button>`;
  bindPanel({ close: () => { closePanel(); } });
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
    + `<button class="btn btn--accent" data-act="confirm" ${total === d.count ? '' : 'disabled'}>捨てる</button>`;
  // 資源のアイコンを差し込む
  E.RESOURCES.forEach((r) => {
    const span = els.panel.querySelector(`[data-row="${r}"]`);
    span.prepend(resIcon(r));
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
    <button class="btn btn--accent" data-act="bank" ${p.resources[give] >= rate && give !== want ? '' : 'disabled'}>${rate}:1で交易する</button>
    <hr style="border-color:rgba(255,255,255,0.15)">
    <h2>相手と交易</h2>
    <div class="sheet__row"><span>相手</span><div class="res-pick" data-row="other"></div></div>
    <div class="sheet__row"><span>渡す</span><div class="res-pick" data-row="pgive"></div></div>
    <div class="sheet__row"><span>もらう</span><div class="res-pick" data-row="pget"></div></div>
    <button class="btn btn--accent" data-act="playerTrade">この内容で成立させる</button>
    <button class="ghost-btn" data-act="cancel">やめる</button>`;

  fillResPick(els.panel.querySelector('[data-row="give"]'), E.RESOURCES, (r) => r === give, (r, b) => {
    b.appendChild(resIcon(r)); const s = document.createElement('span'); s.textContent = `×${p.resources[r]}`; b.appendChild(s);
  }, 'give');
  fillResPick(els.panel.querySelector('[data-row="want"]'), E.RESOURCES, (r) => r === want, (r, b) => b.appendChild(resIcon(r)), 'want');
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
    span.appendChild(resIcon(r));
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
    <button class="btn btn--accent" data-act="confirm" ${picked.length === 2 ? '' : 'disabled'}>受け取る</button>
    <button class="ghost-btn" data-act="cancel">やめる</button>`;
  fillResPick(els.panel.querySelector('[data-row="pick"]'), E.RESOURCES, () => false, (r, b) => b.appendChild(resIcon(r)), 'pick');
  const p = els.panel.querySelector('p');
  picked.forEach((r) => p.appendChild(resIcon(r)));
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
  fillResPick(els.panel.querySelector('[data-row="pick"]'), E.RESOURCES, () => false, (r, b) => b.appendChild(resIcon(r)), 'pick');
  bindPanel({
    pick: (b) => { E.playMonopoly(game, ui.data.cardIdx, b.dataset.res); ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}

// devRoad2 で「終わってもよい」を押せるように
function renderDevRoadFinish() {
  els.panel.innerHTML = `<h2>街道建設</h2><p class="sheet__row">2本目の道を置くか、ここで終わってください。</p>
    <button class="btn btn--accent" data-act="finish">1本だけで終わる</button>
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
  els.tradeBtn.disabled = !buildable;
  els.devBtn.disabled = !buildable;
  { const n = game.players[E.currentPlayer(game)].devCards.filter((c) => !c.played).length; els.devBtn.textContent = `発展カード${n ? ` ${n}` : ''}`; }
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
  renderBank();
  renderHand();
  renderBuildGrid();
  renderBanner();
  renderActionBar();
  renderPanel();
}
