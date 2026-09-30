'use strict';
// ルール・盤面・得点計算は engine.js（画面・音を持たない）。ここは見た目と入力だけ。
import * as E from './engine.js';

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
  playerCountPicker: document.getElementById('playerCountPicker'),
  startBtn: document.getElementById('startBtn'),
  board: document.getElementById('board'),
  banner: document.getElementById('banner'),
  playersBar: document.getElementById('playersBar'),
  handBar: document.getElementById('handBar'),
  panel: document.getElementById('panel'),
  actionBar: document.getElementById('actionBar'),
  diceBtn: document.getElementById('diceBtn'),
  buildBtn: document.getElementById('buildBtn'),
  tradeBtn: document.getElementById('tradeBtn'),
  devBtn: document.getElementById('devBtn'),
  endTurnBtn: document.getElementById('endTurnBtn'),
};

const SCALE = 44; // 1マス単位 → SVG座標のピクセル
const RES_ICON = { wood: '🌲', brick: '🧱', sheep: '🐑', wheat: '🌾', ore: '⛰️' };

let game = null;
let playerCount = load('playerCount', 3) === 4 ? 4 : 3;
let ui = { mode: 'idle', data: {} };

// ---- 人数選び ----
els.playerCountPicker.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-count]');
  if (!btn) return;
  playerCount = Number(btn.dataset.count);
  save('playerCount', playerCount);
  [...els.playerCountPicker.children].forEach((b) => b.classList.toggle('is-selected', b === btn));
});
els.startBtn.addEventListener('click', () => {
  game = E.createGame(playerCount, Math.random);
  ui = { mode: modeForPhase(), data: {} };
  els.setupPanel.hidden = true;
  els.gamePanel.hidden = false;
  save('game', game);
  renderAll();
});

// 保存データがあれば読み込む（続きから遊べるように）
const saved = load('game', null);
if (saved && saved.winner == null) {
  game = saved;
  els.setupPanel.hidden = true;
  els.gamePanel.hidden = false;
  ui = { mode: modeForPhase(), data: {} };
  renderAll();
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
// 盤面の描画
// ================================================================
function hexClass(terrain) { return `hex hex-${terrain}`; }
function hexCenterOf(hex) {
  const vs = hex.vertexIds.map((id) => game.board.vertices[id]);
  const x = vs.reduce((a, v) => a + v.x, 0) / vs.length;
  const y = vs.reduce((a, v) => a + v.y, 0) / vs.length;
  return [x * SCALE, y * SCALE];
}
const svgNS = 'http://www.w3.org/2000/svg';
function el(tag, attrs, parent) {
  const n = document.createElementNS(svgNS, tag);
  Object.entries(attrs || {}).forEach(([k, v]) => n.setAttribute(k, v));
  if (parent) parent.appendChild(n);
  return n;
}

function computeViewBox() {
  const xs = game.board.vertices.map((v) => v.x * SCALE);
  const ys = game.board.vertices.map((v) => v.y * SCALE);
  const margin = SCALE * 0.9;
  const minX = Math.min(...xs) - margin, maxX = Math.max(...xs) + margin;
  const minY = Math.min(...ys) - margin, maxY = Math.max(...ys) + margin;
  return `${minX} ${minY} ${maxX - minX} ${maxY - minY}`;
}

function renderBoard() {
  const svg = els.board;
  svg.innerHTML = '';
  svg.setAttribute('viewBox', computeViewBox());
  const idx = E.currentPlayer(game);

  // タイル
  game.board.hexes.forEach((hex) => {
    const pts = hex.vertexIds.map((id) => {
      const v = game.board.vertices[id];
      return `${v.x * SCALE},${v.y * SCALE}`;
    }).join(' ');
    el('polygon', { points: pts, class: hexClass(hex.terrain) }, svg);
    if (hex.number != null) {
      const [cx, cy] = hexCenterOf(hex);
      el('text', { x: cx, y: cy, class: `hex-number${hex.number === 6 || hex.number === 8 ? ' is-hot' : ''}` }, svg).textContent = hex.number;
    }
  });
  // 港ラベル（港の辺の中点を盤の中心から外向きに少し押し出す）
  game.board.portEdgeIds.forEach((eId) => {
    const e = game.board.edges[eId];
    const v1 = game.board.vertices[e.v1], v2 = game.board.vertices[e.v2];
    const mx = (v1.x + v2.x) / 2, my = (v1.y + v2.y) / 2;
    const len = Math.hypot(mx, my) || 1;
    const x = (mx + (mx / len) * 0.45) * SCALE, y = (my + (my / len) * 0.45) * SCALE;
    const type = v1.port;
    const text = type === '3:1' ? '3:1' : `${E.RESOURCE_LABEL[type][0]}2:1`;
    el('text', { x, y, class: 'port-label' }, svg).textContent = text;
  });
  // 盗賊
  {
    const hex = game.board.hexes[game.board.robberHex];
    const [cx, cy] = hexCenterOf(hex);
    el('circle', { cx, cy, r: SCALE * 0.28, class: 'robber' }, svg);
  }

  // 道（既存＋置ける場所）
  const buildableEdges = ui.mode === 'setupRoad' || ui.mode === 'buildRoad' || ui.mode === 'devRoad1' || ui.mode === 'devRoad2'
    ? new Set(edgeChoices()) : new Set();
  game.board.edges.forEach((edge) => {
    const v1 = game.board.vertices[edge.v1], v2 = game.board.vertices[edge.v2];
    const x1 = v1.x * SCALE, y1 = v1.y * SCALE, x2 = v2.x * SCALE, y2 = v2.y * SCALE;
    if (edge.road != null) {
      el('line', { x1, y1, x2, y2, class: 'road-line', stroke: game.players[edge.road].color, 'stroke-width': 6 }, svg);
    } else if (buildableEdges.has(edge.id)) {
      el('line', { x1, y1, x2, y2, class: 'road-line is-buildable' }, svg);
      el('line', { x1, y1, x2, y2, class: 'road-hit', 'data-edge': edge.id }, svg);
    } else {
      el('line', { x1, y1, x2, y2, class: 'road-line is-empty' }, svg);
    }
  });

  // 頂点（開拓地・都市・置ける場所）
  const buildableVerts = (ui.mode === 'setupSettlement' || ui.mode === 'buildSettlement')
    ? new Set(vertexChoices())
    : ui.mode === 'buildCity' ? new Set(E.availableCityVertices(game, idx)) : new Set();
  game.board.vertices.forEach((v) => {
    const x = v.x * SCALE, y = v.y * SCALE;
    if (v.building) {
      const color = game.players[v.building.owner].color;
      if (v.building.type === 'city') {
        el('rect', { x: x - 7, y: y - 7, width: 14, height: 14, fill: color, class: 'building-city' }, svg);
      } else {
        el('circle', { cx: x, cy: y, r: 6.5, fill: color, class: 'building-settlement' }, svg);
      }
    } else if (buildableVerts.has(v.id)) {
      el('circle', { cx: x, cy: y, r: 6, class: 'vertex-dot is-buildable' }, svg);
      el('circle', { cx: x, cy: y, r: 11, class: 'vertex-hit', 'data-vertex': v.id }, svg);
    }
  });
  // 盗賊を置ける場所（ハイライトはタイル自体をクリックできるようにする）
  if (ui.mode === 'moveRobber' || ui.mode === 'devKnightHex') {
    game.board.hexes.forEach((hex) => {
      if (hex.id === game.board.robberHex) return;
      const pts = hex.vertexIds.map((id) => { const v = game.board.vertices[id]; return `${v.x * SCALE},${v.y * SCALE}`; }).join(' ');
      el('polygon', { points: pts, fill: 'rgba(255,255,255,0.01)', stroke: 'var(--accent)', 'stroke-width': 3, 'data-hex': hex.id, style: 'cursor:pointer' }, svg);
    });
  }
}

function vertexChoices() {
  const idx = E.currentPlayer(game);
  const isSetup = game.phase === 'setup1' || game.phase === 'setup2';
  return E.availableSettlementVertices(game, idx, isSetup);
}
function edgeChoices() {
  const idx = E.currentPlayer(game);
  return E.availableRoadEdges(game, idx);
}

// ================================================================
// プレイヤー一覧・手札
// ================================================================
function renderPlayers() {
  const idx = E.currentPlayer(game);
  els.playersBar.innerHTML = '';
  game.players.forEach((p, i) => {
    const chip = document.createElement('div');
    chip.className = `player-chip${i === idx ? ' is-turn' : ''}`;
    const bonus = [];
    if (game.longestRoadPlayer === i) bonus.push('長路');
    if (game.largestArmyPlayer === i) bonus.push('騎士団');
    chip.innerHTML = `<span class="player-chip__dot" style="background:${p.color}"></span>`
      + `P${i + 1} <b>${E.playerScore(game, i)}</b>点 手札${E.RESOURCES.reduce((a, r) => a + p.resources[r], 0)}`
      + (bonus.length ? ` <span class="player-chip__star">★${bonus.join('')}</span>` : '');
    els.playersBar.appendChild(chip);
  });
}

function renderHand() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  els.handBar.innerHTML = '';
  E.RESOURCES.forEach((r) => {
    const span = document.createElement('span');
    span.className = 'hand__res';
    span.textContent = `${RES_ICON[r]}${p.resources[r]}`;
    els.handBar.appendChild(span);
  });
  const dev = document.createElement('span');
  dev.className = 'hand__res';
  dev.textContent = `🃏${p.devCards.filter((c) => !c.played).length}`;
  els.handBar.appendChild(dev);
  if (game.diceLast) {
    const dice = document.createElement('span');
    dice.className = 'hand__dice';
    dice.textContent = `🎲${game.diceLast[0]}+${game.diceLast[1]}`;
    els.handBar.appendChild(dice);
  }
}

function renderBanner() {
  const idx = E.currentPlayer(game);
  let text = '';
  if (game.winner != null) text = `プレイヤー${game.winner + 1}の勝ち！`;
  else if (game.phase === 'setup1' || game.phase === 'setup2') {
    text = `プレイヤー${idx + 1}: ${game.setupPending === 'road' ? '道を置く場所をタップ' : '開拓地を置く場所をタップ'}`;
  } else if (game.phase === 'roll') text = `プレイヤー${idx + 1}の手番: サイコロを振ってください`;
  else if (game.phase === 'discard') text = `プレイヤー${game.pendingDiscards[0].player + 1}は${game.pendingDiscards[0].count}枚捨ててください`;
  else if (game.phase === 'moveRobber') text = `プレイヤー${idx + 1}: 盗賊を動かすタイルをタップ`;
  else if (ui.mode === 'buildRoad') text = '道を置く場所をタップ';
  else if (ui.mode === 'buildSettlement') text = '開拓地を置く場所をタップ';
  else if (ui.mode === 'buildCity') text = '都市にする開拓地をタップ';
  else if (ui.mode === 'devKnightHex' || ui.mode === 'robberTargetForDev') text = '盗賊を動かすタイルをタップ';
  else if (ui.mode === 'devRoad1') text = '街道建設: 1本目の道を置く場所をタップ';
  else if (ui.mode === 'devRoad2') text = '街道建設: 2本目の道を置く場所をタップ（終わってもよい）';
  els.banner.textContent = text;
}

// ================================================================
// 下の操作シート（建設・交易・発展カード・捨てる・盗む相手選び などを差し替えて表示）
// ================================================================
function costText(cost) { return Object.entries(cost).map(([r, n]) => `${RES_ICON[r]}${n}`).join(' '); }

function renderPanel() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  els.panel.hidden = false;
  els.panel.onclick = null;

  if (ui.mode === 'discard' && game.phase === 'discard') {
    renderDiscardPanel();
    return;
  }
  if (ui.data.pendingHex != null) {
    renderRobberTargetPanel(ui.data.pendingHex, ui.data.forDev);
    return;
  }
  if (ui.mode === 'buildMenu') { renderBuildMenu(); return; }
  if (ui.mode === 'buildSettlement' || ui.mode === 'buildRoad' || ui.mode === 'buildCity'
    || ui.mode === 'devRoad1' || ui.mode === 'devRoad2' || ui.mode === 'moveRobber' || ui.mode === 'devKnightHex') {
    els.panel.innerHTML = `<p class="sheet__row">盤面をタップしてください。</p>
      <button class="ghost-btn" data-act="cancel">やめる</button>`;
    bindPanel({ cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); } });
    return;
  }
  if (ui.mode === 'tradeMenu') { renderTradeMenu(); return; }
  if (ui.mode === 'devMenu') { renderDevMenu(); return; }
  if (ui.mode === 'devYearOfPlenty') { renderYearOfPlentyPanel(); return; }
  if (ui.mode === 'devMonopoly') { renderMonopolyPanel(); return; }

  els.panel.hidden = true;
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
    + E.RESOURCES.map((r) => `<div class="sheet__row"><span>${RES_ICON[r]} 持ち${p.resources[r]}</span>
        <span class="stepper">
          <button data-act="dec" data-res="${r}">−</button><b>${picked[r]}</b>
          <button data-act="inc" data-res="${r}">＋</button>
        </span></div>`).join('')
    + `<button class="primary" data-act="confirm" ${total === d.count ? '' : 'disabled'}>捨てる</button>`;
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

function renderBuildMenu() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  const canRoad = p.roads.length < 15 && canAfford(p.resources, E.COSTS.road) && E.availableRoadEdges(game, idx).length;
  const canSettle = p.settlements.length < 5 && canAfford(p.resources, E.COSTS.settlement) && E.availableSettlementVertices(game, idx, false).length;
  const canCity = p.cities.length < 4 && canAfford(p.resources, E.COSTS.city) && E.availableCityVertices(game, idx).length;
  const canDev = game.bank.devDeck.length > 0 && canAfford(p.resources, E.COSTS.dev);
  els.panel.innerHTML = `<h2>建設</h2><div class="sheet__grid">
    <button class="card-btn" data-act="road" ${canRoad ? '' : 'disabled'}><span class="card-btn__title">道</span><span class="card-btn__sub">${costText(E.COSTS.road)}</span></button>
    <button class="card-btn" data-act="settlement" ${canSettle ? '' : 'disabled'}><span class="card-btn__title">開拓地</span><span class="card-btn__sub">${costText(E.COSTS.settlement)}</span></button>
    <button class="card-btn" data-act="city" ${canCity ? '' : 'disabled'}><span class="card-btn__title">都市</span><span class="card-btn__sub">${costText(E.COSTS.city)}</span></button>
    <button class="card-btn" data-act="dev" ${canDev ? '' : 'disabled'}><span class="card-btn__title">発展カードを買う</span><span class="card-btn__sub">${costText(E.COSTS.dev)}（残り${game.bank.devDeck.length}）</span></button>
  </div><button class="ghost-btn" data-act="cancel">やめる</button>`;
  bindPanel({
    road: () => { ui = { mode: 'buildRoad', data: {} }; renderAll(); },
    settlement: () => { ui = { mode: 'buildSettlement', data: {} }; renderAll(); },
    city: () => { ui = { mode: 'buildCity', data: {} }; renderAll(); },
    dev: () => { E.buyDevCard(game); ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}
function canAfford(res, cost) { return Object.entries(cost).every(([k, v]) => (res[k] || 0) >= v); }

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
    <div class="sheet__row"><span>出す（${rate}枚で1枚）</span><div class="res-pick">${E.RESOURCES.map((r) => `<button data-act="give" data-res="${r}" class="${r === give ? 'is-selected' : ''}">${RES_ICON[r]}${p.resources[r]}</button>`).join('')}</div></div>
    <div class="sheet__row"><span>もらう</span><div class="res-pick">${E.RESOURCES.map((r) => `<button data-act="want" data-res="${r}" class="${r === want ? 'is-selected' : ''}">${RES_ICON[r]}</button>`).join('')}</div></div>
    <button class="primary" data-act="bank" ${p.resources[give] >= rate && give !== want ? '' : 'disabled'}>${rate}:1で交易する</button>
    <hr style="border-color:rgba(255,255,255,0.15)">
    <h2>相手と交易</h2>
    <div class="sheet__row"><span>相手</span><div class="res-pick">${game.players.map((_, i) => i).filter((i) => i !== idx).map((i) => `<button data-act="other" data-p="${i}" class="${i === other ? 'is-selected' : ''}">プレイヤー${i + 1}</button>`).join('')}</div></div>
    <div class="sheet__row"><span>渡す</span><div class="res-pick">${E.RESOURCES.map((r) => `<span class="stepper">${RES_ICON[r]}<button data-act="pgdec" data-res="${r}">−</button><b>${pGive[r]}</b><button data-act="pginc" data-res="${r}">＋</button></span>`).join('')}</div></div>
    <div class="sheet__row"><span>もらう</span><div class="res-pick">${E.RESOURCES.map((r) => `<span class="stepper">${RES_ICON[r]}<button data-act="pwdec" data-res="${r}">−</button><b>${pGet[r]}</b><button data-act="pwinc" data-res="${r}">＋</button></span>`).join('')}</div></div>
    <button class="primary" data-act="playerTrade">この内容で成立させる</button>
    <button class="ghost-btn" data-act="cancel">やめる</button>`;
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
    <div class="res-pick">${E.RESOURCES.map((r) => `<button data-act="pick" data-res="${r}">${RES_ICON[r]}</button>`).join('')}</div>
    <p>選んだ: ${picked.map((r) => RES_ICON[r]).join(' ') || 'なし'}</p>
    <button class="primary" data-act="confirm" ${picked.length === 2 ? '' : 'disabled'}>受け取る</button>
    <button class="ghost-btn" data-act="cancel">やめる</button>`;
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
    <div class="res-pick">${E.RESOURCES.map((r) => `<button data-act="pick" data-res="${r}">${RES_ICON[r]}</button>`).join('')}</div>
    <button class="ghost-btn" data-act="cancel">やめる</button>`;
  bindPanel({
    pick: (b) => { E.playMonopoly(game, ui.data.cardIdx, b.dataset.res); ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}

// ================================================================
// 操作ボタン
// ================================================================
function renderActionBar() {
  const rollable = game.phase === 'roll';
  const buildable = game.phase === 'main';
  els.diceBtn.hidden = !rollable;
  els.buildBtn.disabled = !buildable;
  els.tradeBtn.disabled = !buildable;
  els.devBtn.disabled = !buildable;
  els.endTurnBtn.disabled = !buildable;
}
els.diceBtn.addEventListener('click', () => {
  if (game.phase !== 'roll') return;
  E.rollDice(game);
  ui = { mode: modeForPhase(), data: {} };
  playEvents();
  persistAndRender();
});
els.buildBtn.addEventListener('click', () => { ui = { mode: 'buildMenu', data: {} }; renderAll(); });
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

// devRoad2 で「終わってもよい」を押せるように、盤面ボタンの下に確定ボタンを足す
function renderDevRoadFinish() {
  if (ui.mode !== 'devRoad2') return;
  els.panel.hidden = false;
  els.panel.innerHTML = `<p class="sheet__row">2本目の道を置くか、ここで終わってください。</p>
    <button class="primary" data-act="finish">1本だけで終わる</button>
    <button class="ghost-btn" data-act="cancel">やめる</button>`;
  bindPanel({
    finish: () => { E.playRoadBuilding(game, ui.data.cardIdx, ui.data.edges); ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}

// ================================================================
// まとめて描画
// ================================================================
function renderAll() {
  if (!game) return;
  if (game.phase === 'moveRobber' && ui.mode !== 'moveRobber' && ui.mode !== 'robberTarget') ui = { mode: 'moveRobber', data: {} };
  if (game.phase === 'discard' && ui.mode !== 'discard') ui = { mode: 'discard', data: {} };
  renderBoard();
  renderPlayers();
  renderHand();
  renderBanner();
  renderActionBar();
  if (ui.mode === 'devRoad2' && !(ui.data.pendingHex != null)) renderDevRoadFinish();
  else renderPanel();
}
