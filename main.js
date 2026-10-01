'use strict';
// ルール・盤面・得点計算は engine.js（画面・音を持たない）。イラストの絵の部品は illust.js。
// ここは見た目の組み立てと入力だけ。
import * as E from './engine.js';
import * as I from './illust.js';
import * as CPU from './cpu.js';

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
  expansionRow: document.getElementById('expansionRow'),
  expansionPicker: document.getElementById('expansionPicker'),
  expansionNote: document.getElementById('expansionNote'),
  scenarioRow: document.getElementById('scenarioRow'),
  scenarioPicker: document.getElementById('scenarioPicker'),
  seatsPanel: document.getElementById('seatsPanel'),
  startBtn: document.getElementById('startBtn'),
  continueBtn: document.getElementById('continueBtn'),
  turnNum: document.getElementById('turnNum'),
  board: document.getElementById('board'),
  diceBox: document.getElementById('diceBox'),
  hint: document.getElementById('hint'),
  banner: document.getElementById('banner'),
  playersBar: document.getElementById('playersBar'),
  bankPanel: document.getElementById('bankPanel'),
  ckPanel: document.getElementById('ckPanel'),
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
  else if (key === 'ship' || key === 'moveShip') I.ship(shapes, 14, 18, key === 'moveShip' ? -20 : 0, color);
  else if (key === 'dev') { I.add(shapes, I.rect(6, 3, 16, 22), '#f6eedb', 1, '#1b1612', 1.5); I.add(shapes, I.rect(9, 6, 10, 10), '#7a5bb8', 0.85); }
  else if (key === 'knight' || key === 'warKnight') I.robber(shapes, 14, 18, 1);
  else if (key === 'wall') { I.add(shapes, I.rect(3, 15, 22, 7), color, 1, '#1b1612', 1.5); I.add(shapes, I.rect(5, 10, 6, 6), color, 1, '#1b1612', 1.2); I.add(shapes, I.rect(13, 10, 6, 6), color, 1, '#1b1612', 1.2); }
  else if (key === 'improve') { I.add(shapes, I.poly([[14, 2], [25, 9], [25, 19], [14, 26], [3, 19], [3, 9]]), I.tint(color, 0.1), 1, '#1b1612', 1.5); }
  shapes.forEach((s) => svg.appendChild(pathEl(s)));
  return svg;
}
function dieEl(value, rotateDeg) {
  const wrap = document.createElement('div');
  wrap.className = 'die';
  wrap.style.transform = `rotate(${rotateDeg}deg)`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', 40); svg.setAttribute('height', 40); svg.setAttribute('viewBox', '0 0 46 46');
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
let robberMovedAt = 0, lastRobberHex = null; // 盗賊が動いた時刻（動いた直後に点滅させる）
let pirateMovedAt = 0, lastPirateHex = null; // 海賊版（航海者版のみ使う）
let rolling = false; // サイコロを振るアニメの途中。この間は目の表示をアニメに任せる
let playerCount = load('playerCount', 3);
if (![3, 4, 5, 6].includes(playerCount)) playerCount = 3;
let ui = { mode: 'idle', data: {} };

// ---- 人数選び ----
els.playerCountPicker.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-count]');
  if (!btn) return;
  playerCount = Number(btn.dataset.count);
  save('playerCount', playerCount);
  syncCountPicker();
  renderSeatsPanel();
  syncExpansionPicker();
});
function syncCountPicker() {
  [...els.playerCountPicker.children].forEach((b) => b.classList.toggle('is-selected', Number(b.dataset.count) === playerCount));
}
syncCountPicker();

// ---- 拡張選び（3〜4人だけ選べる。5〜6人は自動で5〜6人拡張） ----
// 他の拡張（都市と騎士・交易と略奪）も、ここに data-expansion の選択肢を足していくだけで並べられる形にする。
let expansion = load('expansion', 'none');
if (!['none', 'seafarers', 'cities-knights', 'traders-barbarians'].includes(expansion)) expansion = 'none';
let scenario = load('scenario', 'fishermen');
if (!E.TB_SCENARIOS.includes(scenario)) scenario = 'fishermen';
els.expansionPicker.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-expansion]');
  if (!btn) return;
  expansion = btn.dataset.expansion;
  save('expansion', expansion);
  syncExpansionPicker();
});
els.scenarioPicker.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-scenario]');
  if (!btn) return;
  scenario = btn.dataset.scenario;
  save('scenario', scenario);
  syncExpansionPicker();
});
function syncExpansionPicker() {
  const choosable = playerCount <= 4;
  els.expansionPicker.hidden = !choosable;
  els.expansionNote.hidden = choosable;
  els.scenarioRow.hidden = !choosable || expansion !== 'traders-barbarians';
  if (!choosable) return;
  [...els.expansionPicker.children].forEach((b) => b.classList.toggle('is-selected', b.dataset.expansion === expansion));
  [...els.scenarioPicker.children].forEach((b) => b.classList.toggle('is-selected', b.dataset.scenario === scenario));
}
syncExpansionPicker();

// ---- 席ごとの人／CPU選び ----
// uiSeats: タイトル画面で編集中の下書き（4席ぶん持っておき、人数に合わせて先頭から使う）。
// seats: 今プレイ中（続きから、を含む）の対局で実際に使っている席の設定。古い保存（席の情報がない）は全員「人」として引き継ぐ。
function defaultSeat(i) { return { type: i === 0 ? 'human' : 'cpu', level: 'normal' }; }
const SEAT_SLOTS = [0, 1, 2, 3, 4, 5];
let uiSeats = load('seats', null) || SEAT_SLOTS.map(defaultSeat);
if (!Array.isArray(uiSeats) || uiSeats.length < 6) uiSeats = SEAT_SLOTS.map((i) => uiSeats[i] || defaultSeat(i));
let seats = uiSeats.slice(0, playerCount).map((s) => ({ ...s }));

function isCpuSeat(i) { return !!(seats[i] && seats[i].type === 'cpu'); }
function seatLevel(i) { return (seats[i] && seats[i].level) || 'normal'; }

function renderSeatsPanel() {
  els.seatsPanel.innerHTML = '';
  for (let i = 0; i < playerCount; i++) {
    const seat = uiSeats[i];
    const row = document.createElement('div');
    row.className = 'seat-row';
    row.innerHTML = `<span class="seat-row__name">P${i + 1}</span>
      <div class="segmented seat-row__type">
        <button class="btn" data-i="${i}" data-type="human">人</button>
        <button class="btn" data-i="${i}" data-type="cpu">CPU</button>
      </div>
      <div class="segmented seat-row__level"${seat.type === 'cpu' ? '' : ' hidden'}>
        ${CPU.LEVELS.map((l) => `<button class="btn" data-i="${i}" data-level="${l.id}">${l.name}</button>`).join('')}
      </div>`;
    row.querySelector('[data-type="human"]').classList.toggle('is-selected', seat.type === 'human');
    row.querySelector('[data-type="cpu"]').classList.toggle('is-selected', seat.type === 'cpu');
    row.querySelectorAll('[data-level]').forEach((b) => b.classList.toggle('is-selected', b.dataset.level === seat.level));
    els.seatsPanel.appendChild(row);
  }
}
els.seatsPanel.addEventListener('click', (e) => {
  const typeBtn = e.target.closest('[data-type]');
  const levelBtn = e.target.closest('[data-level]');
  if (typeBtn) uiSeats[Number(typeBtn.dataset.i)].type = typeBtn.dataset.type;
  else if (levelBtn) uiSeats[Number(levelBtn.dataset.i)].level = levelBtn.dataset.level;
  else return;
  save('seats', uiSeats);
  renderSeatsPanel();
});
renderSeatsPanel();

els.startBtn.addEventListener('click', () => {
  seats = uiSeats.slice(0, playerCount).map((s) => ({ ...s }));
  const expansions = playerCount <= 4 && expansion !== 'none' ? [expansion] : [];
  game = E.createGame(playerCount, Math.random, { expansions, scenario });
  ui = { mode: modeForPhase(), data: {} };
  showGame();
  save('game', game);
  save('gameSeats', seats);
  renderAll();
});
// 古い保存（航海者版より前）には ships・pendingGoldPicks などがないので、引き継ぎで補う
function migrateGame(g) {
  g.winTarget = g.winTarget || 10;
  g.pendingGoldPicks = g.pendingGoldPicks || [];
  g.pendingScienceBonus = g.pendingScienceBonus || [];
  g.shipMovedThisTurn = !!g.shipMovedThisTurn;
  g.players.forEach((p) => { p.ships = p.ships || []; p.islandBonus = !!p.islandBonus; });
  // 古い保存（交易と略奪より前）には scenario などがないので、「なし」として引き継ぐ
  g.scenario = g.scenario || null;
  g.richPlayer = g.richPlayer ?? null;
  g.oldBootHolder = g.oldBootHolder ?? null;
  // 古い保存の poorPlayer（1人だけ）・fish（数）は、今の形（poorPlayers配列・fishTokens配列）に合わせ直す
  if (g.poorPlayer !== undefined) { g.poorPlayers = g.poorPlayer == null ? [] : [g.poorPlayer]; delete g.poorPlayer; }
  g.poorPlayers = g.poorPlayers || [];
  g.players.forEach((p) => {
    if (typeof p.fish === 'number') { p.fishTokens = []; delete p.fish; }
    if (p.fishTokens === undefined) p.fishTokens = g.scenario === 'fishermen' ? [] : null;
    if (p.gold == null) p.gold = (g.scenario === 'rivers' || g.scenario === 'barbarians') ? 0 : null;
    if (p.goldSpendsThisTurn == null) p.goldSpendsThisTurn = 0;
    if (p.bridges == null) p.bridges = 0;
    if (p.warKnights === undefined) p.warKnights = g.scenario === 'barbarians' ? [] : null;
    if (p.prisoners == null) p.prisoners = 0;
    if (p.pendingCamelBuilds == null) p.pendingCamelBuilds = 0;
  });
  if (g.scenario === 'fishermen') { g.fishBag = g.fishBag || []; g.fishUsed = g.fishUsed || []; }
  if (g.scenario === 'caravans' && g.board.camelEdgeA !== undefined) {
    // 古い（投票より前の）隊商の保存は、盤の形が変わっているので続きからは諦めて空のキャラバンとして引き継ぐ
    g.board.caravans = g.board.caravans || [[], [], []];
    g.board.oasisHexId = g.board.oasisHexId ?? g.board.camelHexId ?? 0;
    g.board.camelStartEdges = g.board.camelStartEdges || g.board.hexes[g.board.oasisHexId].edgeIds.filter((_, i) => i % 2 === 0);
  }
  return g;
}
els.continueBtn.addEventListener('click', () => {
  const saved = load('game', null);
  if (!saved || saved.winner != null) return;
  game = migrateGame(saved);
  const savedSeats = load('gameSeats', null);
  seats = (savedSeats && savedSeats.length === game.playerCount) ? savedSeats : Array.from({ length: game.playerCount }, () => ({ type: 'human', level: 'normal' }));
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
  if (game.phase === 'goldPick') return 'goldPick';
  if (game.phase === 'scienceBonus') return 'scienceBonus';
  if (game.phase === 'moveRobber') return 'moveRobber';
  return 'idle';
}

function persistAndRender() { save('game', game); renderAll(); }

function playEvents() {
  if (!game) return;
  const evts = game.events.splice(0, game.events.length);
  evts.forEach((e) => { if (SOUND[e]) SOUND[e](); });
  if (lastRobberHex != null && game.board.robberHex !== lastRobberHex) {
    robberMovedAt = Date.now();
    setTimeout(() => { if (game) renderAll(); }, 3100); // 点滅を止める
  }
  lastRobberHex = game.board.robberHex;
  if (game.board.pirateHex != null && lastPirateHex != null && game.board.pirateHex !== lastPirateHex) {
    pirateMovedAt = Date.now();
    setTimeout(() => { if (game) renderAll(); }, 3100);
  }
  lastPirateHex = game.board.pirateHex;
  flyGains((game.gains || []).splice(0));
}

// もらった資源を、マスから手札（手番の人）かプレイヤー欄（ほかの人）へ飛ばす
function flyGains(gains) {
  if (!gains.length || document.documentElement.classList.contains('motion-off')) return;
  const ctm = els.board.getScreenCTM();
  if (!ctm) return;
  const cur = E.currentPlayer(game);
  gains.forEach((gn, k) => {
    const [hx, hy] = hexCenterPx(game, game.board.hexes[gn.hex]);
    const from = new DOMPoint(hx, hy).matrixTransform(ctm);
    const target = gn.player === cur ? els.handBar.children[E.RESOURCES.indexOf(gn.res)] : els.playersBar.children[gn.player];
    if (!target) return;
    const r = target.getBoundingClientRect();
    for (let n = 0; n < gn.amt; n++) {
      const icon = resIcon(gn.res);
      icon.classList.add('fly-res');
      icon.style.left = `${from.x - 16}px`; icon.style.top = `${from.y - 16}px`;
      document.body.appendChild(icon);
      const dx = r.left + r.width / 2 - from.x, dy = r.top + r.height / 2 - from.y;
      icon.animate([
        { transform: 'translate(0, 0) scale(0.4)', opacity: 0 },
        { transform: 'translate(0, -24px) scale(1.3)', opacity: 1, offset: 0.25 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.8)`, opacity: 0.9 },
      ], { duration: 900, delay: (k + n) * 120, easing: 'cubic-bezier(.5,0,.4,1)', fill: 'backwards' }).finished
        .then(() => icon.remove(), () => icon.remove());
    }
  });
}

// ================================================================
// CPU の自動進行。人が追えるよう、手ごとに少し間をあけて1手ずつ進める（cpu.js の公開関数だけを呼ぶ）。
// ================================================================
// CPU の速さ。テストプレイ用に速くできる（ヘッダーのボタンで順に切り替え）。
const CPU_SPEEDS = [['ふつう', 650], ['はやい', 150], ['最速', 0]];
const cpuSpeedBtn = document.getElementById('cpuSpeedBtn');
let cpuSpeed = load('cpuSpeed', 0);
if (!CPU_SPEEDS[cpuSpeed]) cpuSpeed = 0;
function showCpuSpeed() { cpuSpeedBtn.textContent = 'CPU ' + CPU_SPEEDS[cpuSpeed][0]; }
showCpuSpeed();
cpuSpeedBtn.addEventListener('click', () => {
  cpuSpeed = (cpuSpeed + 1) % CPU_SPEEDS.length;
  save('cpuSpeed', cpuSpeed);
  showCpuSpeed();
});
let cpuTimer = null;
// 次にCPUがすべきこと（捨て札はcurrentPlayerと無関係に、席がCPUの人から片付ける）を1つ返す。無ければ人の番。
function nextCpuJob() {
  if (!game || game.winner != null) return null;
  if (game.phase === 'discard') {
    const d = game.pendingDiscards.find((x) => isCpuSeat(x.player));
    return d ? { kind: 'discard', player: d.player } : null;
  }
  if (game.phase === 'goldPick') {
    const d = game.pendingGoldPicks.find((x) => isCpuSeat(x.player));
    return d ? { kind: 'goldPick', player: d.player } : null;
  }
  if (game.phase === 'scienceBonus') {
    const p = game.pendingScienceBonus.find((x) => isCpuSeat(x));
    return p != null ? { kind: 'scienceBonus', player: p } : null;
  }
  return isCpuSeat(E.actingPlayer(game)) ? { kind: 'step' } : null;
}
function scheduleCpu() {
  if (cpuTimer || !game) return;
  const job = nextCpuJob();
  if (!job) return;
  cpuTimer = setTimeout(() => {
    cpuTimer = null;
    if (job.kind === 'discard') CPU.discardFor(game, job.player, seatLevel(job.player));
    else if (job.kind === 'goldPick') CPU.pickGoldFor(game, job.player);
    else if (job.kind === 'scienceBonus') CPU.pickScienceBonusFor(game, job.player);
    else CPU.step(game, seatLevel(E.actingPlayer(game)));
    ui = { mode: modeForPhase(), data: {} };
    playEvents();
    save('game', game);
    renderAll();
    scheduleCpu();
  }, CPU_SPEEDS[cpuSpeed][1]);
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
    // 札は、マスの両どなりの辺を海へ延ばした線が交わる所（辺を底にした正三角形の頂点）に置く
    const [hx, hy] = hexCenterPx(g, g.board.hexes[e.hexIds[0]]);
    const nx = mx - hx, ny = my - hy, len = Math.hypot(nx, ny) || 1;
    const px = mx + (nx / len) * (SCALE * Math.sqrt(3) / 2), py = my + (ny / len) * (SCALE * Math.sqrt(3) / 2);
    const type = v1.port;
    const isAny = type === '3:1';
    const bg = isAny ? '#f6eedb' : RES_COLOR[type];
    // 実物と同じく、使える2つの角それぞれから桟橋を出す
    [v1, v2].forEach((v) => {
      I.add(S, I.line(v.x * SCALE, v.y * SCALE, px, py), 'none', 1, '#6e5436', 7);
      I.add(S, I.line(v.x * SCALE, v.y * SCALE, px, py), 'none', 1, '#9a7a52', 3);
    });
    I.add(S, I.ell(px, py + 2, 18, 18), '#000', 0.25);
    I.add(S, I.ell(px, py, 18, 18), '#f6eedb', 1, isAny ? '#b9a980' : bg, 3);
    labels.push({ x: px, y: isAny ? py : py - 4, t: isAny ? '3:1' : '2:1', f: '#2a211b', s: 13, w: 700 });
    if (!isAny) labels.push({ x: px, y: py + 8, t: RES_LABEL[type], f: bg, s: 10, w: 700 });
  });

  // 交易と略奪: 漁場（外周の3つの頂点のまん中あたりに出目の札）。湖の出目は盤の中の湖タイルに4つ出す
  if (g.board.fisheries) {
    g.board.fisheries.forEach((fsh) => {
      const vs = fsh.vertices.map((vid) => g.board.vertices[vid]);
      const mx = vs.reduce((a, v) => a + v.x, 0) / vs.length * SCALE;
      const my = vs.reduce((a, v) => a + v.y, 0) / vs.length * SCALE;
      const [hx, hy] = hexCenterPx(g, g.board.hexes[0]);
      const nx = mx - hx, ny = my - hy, len = Math.hypot(nx, ny) || 1;
      const px = mx + (nx / len) * (SCALE * 0.55), py = my + (ny / len) * (SCALE * 0.55);
      I.add(S, I.ell(px, py + 2, 15, 15), '#000', 0.25);
      I.add(S, I.ell(px, py, 15, 15), '#dff3f4', 1, '#2a8aa0', 2.5);
      labels.push({ x: px, y: py, t: String(fsh.number), f: '#114f62', s: 13, w: 700 });
    });
  }
  const lakeHex = g.board.hexes.find((h) => h.terrain === 'lake');
  if (lakeHex) {
    const [cx, cy] = hexCenterPx(g, lakeHex);
    [[-20, -18], [20, -18], [-20, 18], [20, 18]].forEach(([dx, dy], i) => {
      I.add(S, I.ell(cx + dx, cy + dy, 13, 13), '#dff3f4', 1, '#2a8aa0', 2);
      labels.push({ x: cx + dx, y: cy + dy, t: String(lakeHex.lakeNumbers[i]), f: '#114f62', s: 11, w: 700 });
    });
  }
  // 交易と略奪: 川（真ん中の列を横切る水色の帯。橋を架けないと道を通せない）
  if (g.board.riverEdgeIds) {
    g.board.riverEdgeIds.forEach((eId) => {
      const e = g.board.edges[eId];
      const v1 = g.board.vertices[e.v1], v2 = g.board.vertices[e.v2];
      const x1 = v1.x * SCALE, y1 = v1.y * SCALE, x2 = v2.x * SCALE, y2 = v2.y * SCALE;
      I.add(S, I.line(x1, y1, x2, y2), 'none', 0.9, '#1d6e86', 11);
      I.add(S, I.line(x1, y1, x2, y2), 'none', 0.6, '#bfe6ee', 4);
    });
  }
  // 交易と略奪: 隊商のラクダ（オアシスから伸びる3本のキャラバンを黄土色の帯で表す）
  if (g.board.caravans) {
    g.board.caravans.forEach((chain) => {
      chain.forEach((eId) => {
        const e = g.board.edges[eId];
        const v1 = g.board.vertices[e.v1], v2 = g.board.vertices[e.v2];
        I.add(S, I.line(v1.x * SCALE, v1.y * SCALE, v2.x * SCALE, v2.y * SCALE), 'none', 0.9, '#caa34a', 9);
      });
    });
  }
  // 交易と略奪: 蛮族の襲撃の騎士（辺の上に小さな駒として置く）
  if (g.board.castleHexId != null) {
    g.players.forEach((pl) => {
      (pl.warKnights || []).forEach((k) => {
        const e = g.board.edges[k.edgeId];
        const v1 = g.board.vertices[e.v1], v2 = g.board.vertices[e.v2];
        const x = (v1.x + v2.x) / 2 * SCALE, y = (v1.y + v2.y) / 2 * SCALE;
        I.add(S, I.ell(x, y, 9, 9), pl.color, 1, '#1b1612', 1.6);
      });
    });
  }
  // 交易と略奪: 蛮族の襲撃（砦・沿岸マスの蛮族の数。征服されたマスは暗く表示）
  if (g.board.castleHexId != null) {
    g.board.hexes.forEach((hex) => {
      if (hex.id === g.board.castleHexId) return;
      if (hex.conquered) {
        const pts = hexPointsPx(g, hex);
        I.add(S, I.poly(pts), '#1a1410', 0.45);
      }
      if (hex.barbarians > 0) {
        const [cx, cy] = hexCenterPx(g, hex);
        I.add(S, I.ell(cx, cy - 26, 11, 11), '#2b1d10', 1, '#120c06', 1.2);
        labels.push({ x: cx, y: cy - 26, t: String(hex.barbarians), f: '#f0cf85', s: 12, w: 700 });
      }
    });
  }

  // 道・船（既存＋置ける/動かせる場所）
  const buildableEdges = uiState && (uiState.mode === 'setupRoad' || uiState.mode === 'buildRoad' || uiState.mode === 'buildShip' || uiState.mode === 'devRoad1' || uiState.mode === 'devRoad2'
    || uiState.mode === 'progressEdge1' || uiState.mode === 'progressEdge2' || uiState.mode === 'buildWarKnight' || uiState.mode === 'fishRoadPick')
    ? new Set(edgeChoices()) : new Set();
  const pickableShips = uiState && uiState.mode === 'moveShip1' ? new Set(E.movableShipEdges(g, idx)) : new Set();
  const shipTargets = uiState && uiState.mode === 'moveShip2' ? new Set(E.availableShipEdges(g, idx)) : new Set();
  const pickableKnights = uiState && uiState.mode === 'moveWarKnight1'
    ? new Set(g.players[idx].warKnights.filter((k) => E.movableWarKnightEdges(g, idx, k.id, false).length).map((k) => k.edgeId)) : new Set();
  const knightTargets = uiState && uiState.mode === 'moveWarKnight2'
    ? new Set(E.movableWarKnightEdges(g, idx, uiState.data.knightId, false)) : new Set();
  g.board.edges.forEach((edge) => {
    const v1 = g.board.vertices[edge.v1], v2 = g.board.vertices[edge.v2];
    const x1 = v1.x * SCALE, y1 = v1.y * SCALE, x2 = v2.x * SCALE, y2 = v2.y * SCALE;
    const tx1 = x1 + (x2 - x1) * 0.1, ty1 = y1 + (y2 - y1) * 0.1;
    const tx2 = x1 + (x2 - x1) * 0.9, ty2 = y1 + (y2 - y1) * 0.9;
    if (edge.ship != null) {
      const color = g.players[edge.ship].color;
      const mx = (tx1 + tx2) / 2, my = (ty1 + ty2) / 2;
      const ang = Math.atan2(ty2 - ty1, tx2 - tx1) * 180 / Math.PI;
      I.ship(S, mx, my, ang, color);
      if (pickableShips.has(edge.id)) queue('line', { x1, y1, x2, y2, class: 'road-hit', 'data-edge': edge.id });
    } else if (edge.road != null) {
      const color = g.players[edge.road].color;
      I.add(S, I.line(tx1 + 1, ty1 + 3, tx2 + 1, ty2 + 3), 'none', 0.3, '#000', 10);
      I.add(S, I.line(tx1, ty1, tx2, ty2), 'none', 1, '#1b1612', 10);
      I.add(S, I.line(tx1, ty1, tx2, ty2), 'none', 1, color, 6);
      I.add(S, I.line(tx1, ty1 - 1, tx2, ty2 - 1), 'none', 0.35, '#ffffff', 1.5);
    } else if (buildableEdges.has(edge.id) || shipTargets.has(edge.id) || knightTargets.has(edge.id)) {
      I.add(S, I.line(tx1, ty1, tx2, ty2), 'none', 1, '#1b1612', 9);
      I.add(S, I.line(tx1, ty1, tx2, ty2), 'none', 0.85, 'var(--accent)', 5);
      queue('line', { x1, y1, x2, y2, class: 'road-hit', 'data-edge': edge.id });
    } else {
      if (pickableKnights.has(edge.id)) queue('line', { x1, y1, x2, y2, class: 'road-hit', 'data-edge': edge.id });
      queue('line', { x1, y1, x2, y2, stroke: 'rgba(255,255,255,0.14)', 'stroke-width': 2.5 });
    }
  });

  // 頂点（開拓地・都市・置ける場所）
  const buildableVerts = uiState && (uiState.mode === 'setupSettlement' || uiState.mode === 'buildSettlement')
    ? new Set(vertexChoices())
    : uiState && uiState.mode === 'buildCity' ? new Set(E.availableCityVertices(g, idx))
    : uiState && uiState.mode === 'buildKnight' ? new Set(E.availableKnightVertices(g, idx))
    : uiState && uiState.mode === 'progressVertex' ? new Set(E.availableKnightVertices(g, idx))
    : uiState && uiState.mode === 'moveKnightTo' ? new Set(E.movableKnightVertices(g, idx, uiState.data.knightId))
    : new Set();
  g.board.vertices.forEach((v) => {
    const x = v.x * SCALE, y = v.y * SCALE;
    if (v.building) {
      const color = g.players[v.building.owner].color;
      const dark = I.tint(color, -0.4), light = I.tint(color, 0.35);
      if (v.building.type === 'city') I.city(S, x, y, color, dark, light);
      else I.house(S, x, y, color, dark, light);
      if (g.metropolis && E.TRACKS.some((t) => g.metropolis[t] === v.id)) labels.push({ x, y: y - 20, t: '★', f: '#f6dc9c', s: 16, w: 700 });
    } else if (buildableVerts.has(v.id)) {
      I.add(S, I.ell(x, y, 15, 15), '#f0cf85', 0.3);
      I.add(S, I.ell(x, y, 9, 9), '#f0cf85', 0.6, '#fff3cf', 2.5);
      queue('circle', { cx: x, cy: y, r: 12, class: 'vertex-hit', 'data-vertex': v.id });
    }
  });
  // 騎士（都市と騎士。頂点に小さな駒として置く。起動中は明るい色、休み中は暗い色）
  if (g.players[0].knights) {
    g.players.forEach((pl) => {
      pl.knights.forEach((k) => {
        const v = g.board.vertices[k.vertexId];
        const x = v.x * SCALE, y = v.y * SCALE;
        const color = k.active ? pl.color : I.tint(pl.color, -0.35);
        I.add(S, I.ell(x, y, 10, 10), color, 1, '#1b1612', 1.6);
        labels.push({ x, y: y + 1, t: String(k.level), f: '#fffaf0', s: 11, w: 700 });
      });
    });
  }

  // 盗賊・海賊（点滅させるので、ほかの絵とは別の <g> に入れる）
  const robberShapes = [];
  let robberBlink = false;
  // 漁師: 魚2匹で盗賊を盤外へ出せる間は robberHex が null になり、盗賊は描かない
  if (g.board.robberHex != null) {
    const [cx, cy] = hexCenterPx(g, g.board.hexes[g.board.robberHex]);
    I.robber(robberShapes, cx + 2, cy + 14, 1.15);
    // 7が出て動かすとき・動いた直後は、光る輪を付けて点滅させる
    robberBlink = svg === els.board && (g.phase === 'moveRobber' || (uiState && uiState.mode === 'devKnightHex')
      || Date.now() < robberMovedAt + 3000);
    if (robberBlink) I.add(robberShapes, I.ell(cx + 2, cy + 2, 26, 26), 'none', 1, '#ffd84a', 4);
  }
  const pirateShapes = [];
  let pirateBlink = false;
  if (g.board.pirateHex != null) {
    const [cx, cy] = hexCenterPx(g, g.board.hexes[g.board.pirateHex]);
    I.pirate(pirateShapes, cx, cy, 1.15);
    pirateBlink = svg === els.board && (g.phase === 'moveRobber' || (uiState && uiState.mode === 'devKnightHex')
      || Date.now() < pirateMovedAt + 3000);
    if (pirateBlink) I.add(pirateShapes, I.ell(cx, cy + 4, 26, 18), 'none', 1, '#ffd84a', 4);
  }

  // 隊商: ラクダを置ける場所（投票で決まった人の番のときだけ。手番の人でなく camelDecider が決める）
  if (g.phase === 'camelPlace' && !isCpuSeat(g.camelDecider)) {
    E.camelPlacementOptions(g).forEach((eId) => {
      const e = g.board.edges[eId];
      const v1 = g.board.vertices[e.v1], v2 = g.board.vertices[e.v2];
      queue('line', { x1: v1.x * SCALE, y1: v1.y * SCALE, x2: v2.x * SCALE, y2: v2.y * SCALE, class: 'road-hit', 'data-edge': eId });
    });
  }
  // 盗賊・海賊を置ける場所（タイル自体をタップできるようにする）
  if (uiState && (uiState.mode === 'moveRobber' || uiState.mode === 'devKnightHex')) {
    g.board.hexes.forEach((hex) => {
      const isWater = hex.terrain === 'water';
      if (isWater ? hex.id === g.board.pirateHex || g.board.pirateHex == null : hex.id === g.board.robberHex) return;
      const pts = hexPointsPx(g, hex).map(([x, y]) => `${x},${y}`).join(' ');
      queue('polygon', { points: pts, class: 'hex-target', 'data-hex': hex.id });
    });
  }
  // 発明家（進歩カード）: 数字チップのあるマスをどれでも2つ選べる
  if (uiState && (uiState.mode === 'progressHexA' || uiState.mode === 'progressHexB')) {
    g.board.hexes.forEach((hex) => {
      if (hex.number == null || hex.id === uiState.data.hexA) return;
      const pts = hexPointsPx(g, hex).map(([x, y]) => `${x},${y}`).join(' ');
      queue('polygon', { points: pts, class: 'hex-target', 'data-hex': hex.id });
    });
  }

  S.forEach((s) => svg.appendChild(pathEl(s)));
  const robberG = el('g', { class: robberBlink ? 'robber-blink' : '' });
  robberShapes.forEach((s) => robberG.appendChild(pathEl(s)));
  svg.appendChild(robberG);
  if (pirateShapes.length) {
    const pirateG = el('g', { class: pirateBlink ? 'robber-blink' : '' });
    pirateShapes.forEach((s) => pirateG.appendChild(pathEl(s)));
    svg.appendChild(pirateG);
  }
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
  if (ui.mode === 'buildShip') return E.availableShipEdges(game, idx);
  if ((ui.mode === 'devRoad1' || ui.mode === 'devRoad2') && game.board.pirateHex != null) {
    return [...new Set([...E.availableRoadEdges(game, idx), ...E.availableShipEdges(game, idx)])];
  }
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
    const cpuTag = isCpuSeat(i) ? `CPU・${CPU.LEVELS.find((l) => l.id === seatLevel(i))?.name || ''}` : '人';
    body.innerHTML = `<div class="player-card__name">P${i + 1}${i === idx ? '<span class="player-card__cur">手番</span>' : ''}</div>`
      + `<div class="player-card__sub">${cpuTag}・手札 ${E.RESOURCES.reduce((a, r) => a + p.resources[r], 0)}・騎士 ${p.knightsPlayed}</div>`
      + `<div class="player-card__extra">${bonus.join(' ')}</div>`;
    const vp = document.createElement('div');
    vp.className = 'player-card__vp';
    vp.innerHTML = `<b>${E.playerScore(game, i)}</b><span>点</span>`;
    card.append(dot, body, vp);
    els.playersBar.appendChild(card);
  });
}

function renderBank() {
  const ck = !!game.bank.commodities;
  const deckLabel = ck
    ? `進歩カード 残り ${E.TRACKS.map((t) => game.progressDecks[t].length).reduce((a, b) => a + b, 0)}`
    : `発展カード 残り ${game.bank.devDeck.length}`;
  els.bankPanel.innerHTML = `<div class="bank__head"><span>銀行</span><span>${deckLabel}</span></div>`;
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
  if (ck) {
    E.COMMODITIES.forEach((c) => {
      const cell = document.createElement('div');
      cell.className = 'bank__res';
      cell.appendChild(resIcon(c));
      const b = document.createElement('b');
      b.textContent = game.bank.commodities[c];
      cell.appendChild(b);
      grid.appendChild(cell);
    });
  }
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
  if (!p.progressCards) { // 都市と騎士では発展カードを使わないので、この行は出さない
    const extra = document.createElement('div');
    extra.className = 'hand__extra';
    extra.textContent = `発展カード ${p.devCards.filter((c) => !c.played).length}枚`;
    els.handBar.appendChild(extra);
  }
  els.handCount.textContent = `${E.RESOURCES.reduce((a, r) => a + p.resources[r], 0)} 枚`;
}

// ================================================================
// 都市と騎士: サイドの要約（商品・都市の発展段階・騎士・蛮族の進み・事件のサイコロ）
// ================================================================
const EVENT_FACE_LABEL = { barbarian: '蛮族の船', trade: '交易の城門', politics: '政治の城門', science: '科学の城門' };
function renderCk() {
  if (!game.players[E.currentPlayer(game)].cityImprovements) { els.ckPanel.hidden = true; return; }
  els.ckPanel.hidden = false;
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  els.ckPanel.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'panel__head';
  head.innerHTML = `<span>都市と騎士</span><span>蛮族 ${game.barbarianProgress}/7${game.eventDie ? '・前回 ' + EVENT_FACE_LABEL[game.eventDie] : ''}</span>`;
  els.ckPanel.appendChild(head);
  const comRow = document.createElement('div');
  comRow.className = 'ck-row';
  E.COMMODITIES.forEach((c) => {
    const cell = document.createElement('span');
    cell.className = 'ck-chip';
    cell.appendChild(resIcon(c));
    const b = document.createElement('b'); b.textContent = `×${p.commodities[c]}`;
    cell.appendChild(b);
    comRow.appendChild(cell);
  });
  els.ckPanel.appendChild(comRow);
  const trackRow = document.createElement('div');
  trackRow.className = 'ck-row';
  E.TRACKS.forEach((t) => {
    const cell = document.createElement('span');
    cell.className = 'ck-chip';
    const star = E.metropolisOwner(game, t) === idx ? '★' : '';
    cell.textContent = `${E.TRACK_LABEL[t]} ${p.cityImprovements[t]}/5${star}`;
    trackRow.appendChild(cell);
  });
  els.ckPanel.appendChild(trackRow);
  const knightLine = document.createElement('div');
  knightLine.className = 'ck-row';
  if (p.knights.length) {
    p.knights.forEach((k) => {
      const cell = document.createElement('span');
      cell.className = `ck-chip${k.active ? ' is-active' : ''}`;
      cell.textContent = `${E.KNIGHT_LEVEL_LABEL[k.level]}${k.active ? '(起動)' : '(休み)'}`;
      knightLine.appendChild(cell);
    });
  } else {
    const cell = document.createElement('span');
    cell.className = 'ck-chip';
    cell.textContent = '騎士: まだいない';
    knightLine.appendChild(cell);
  }
  els.ckPanel.appendChild(knightLine);
  const manage = document.createElement('button');
  manage.className = 'btn btn--small';
  manage.textContent = '騎士を操作';
  manage.disabled = !humansTurn() || !(game.phase === 'main' || game.phase === 'specialBuilding') || !p.knights.length;
  manage.addEventListener('click', () => { ui = { mode: 'knightMenu', data: {} }; renderAll(); });
  els.ckPanel.appendChild(manage);
  if (p.cityImprovements.trade >= 3) {
    const tradeBtn = document.createElement('button');
    tradeBtn.className = 'btn btn--small';
    tradeBtn.textContent = '商品を交易（2:1）';
    tradeBtn.disabled = !humansTurn() || game.phase !== 'main' || !E.COMMODITIES.some((c) => (p.commodities[c] || 0) >= 2);
    tradeBtn.addEventListener('click', () => { ui = { mode: 'tradeCommodity', data: {} }; renderAll(); });
    els.ckPanel.appendChild(tradeBtn);
  }
}

function renderDice() {
  if (rolling) return;
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
  else if (game.phase === 'goldPick') { main = `プレイヤー${game.pendingGoldPicks[0].player + 1}は金の川で${game.pendingGoldPicks[0].count}枚選びます。`; hint = '窓で好きな資源を選んでください。'; }
  else if (game.phase === 'scienceBonus') { main = `プレイヤー${game.pendingScienceBonus[0] + 1}は科学の力で資源を1枚選びます。`; hint = '窓で好きな資源を選んでください。'; }
  else if (game.phase === 'moveRobber') { main = `プレイヤー${idx + 1}の番。`; hint = '盗賊か海賊を動かすタイルをタップ。'; }
  else if (game.phase === 'specialBuilding') { main = `特別建設フェイズ: プレイヤー${idx + 1}の番。`; hint = '建てるか、パスしてください（交易・発展カードは使えません）。'; }
  else if (game.diceLast) main = `サイコロ ${game.diceLast[0]}＋${game.diceLast[1]}＝${game.diceLast[0] + game.diceLast[1]}。`;
  if (game.winner == null && game.phase !== 'discard' && isCpuSeat(idx)) hint = `CPU（${CPU.LEVELS.find((l) => l.id === seatLevel(idx))?.name || ''}）が考えています…`;
  if (ui.mode === 'buildRoad') hint = '道を置く場所をタップ。';
  else if (ui.mode === 'buildSettlement') hint = '開拓地を置く場所をタップ。';
  else if (ui.mode === 'buildCity') hint = '都市にする開拓地をタップ。';
  else if (ui.mode === 'buildShip') hint = '船を置く場所をタップ。';
  else if (ui.mode === 'moveShip1') hint = '動かす自分の船をタップ（端にあるものだけ）。';
  else if (ui.mode === 'moveShip2') hint = '移す先の海の辺をタップ。';
  else if (ui.mode === 'devKnightHex' || ui.mode === 'robberTargetForDev') hint = '盗賊か海賊を動かすタイルをタップ。';
  else if (ui.mode === 'devRoad1') hint = '街道建設: 1本目の道を置く場所をタップ。';
  else if (ui.mode === 'devRoad2') hint = '街道建設: 2本目の道を置く場所をタップ（終わってもよい）。';
  else if (ui.mode === 'buildKnight') hint = '騎士を置く場所（自分の道が届く所）をタップ。';
  else if (ui.mode === 'moveKnightTo') hint = '騎士を移す先の頂点をタップ。';
  else if (ui.mode === 'progressVertex') hint = '騎士を置く場所をタップ。';
  else if (ui.mode === 'progressEdge1') hint = '道を置く場所をタップ。';
  else if (ui.mode === 'progressEdge2') hint = `道を置く場所をタップ（${(ui.data.edges || []).length}/2）。`;
  else if (ui.mode === 'progressHexA') hint = '発明家: 1つめのマスをタップ。';
  else if (ui.mode === 'progressHexB') hint = '発明家: 2つめのマスをタップ（数字チップを入れ替えます）。';
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
    const pair = document.createElement('span');
    pair.className = 'cost-pair';
    pair.appendChild(resIcon(r));
    const s = document.createElement('span');
    s.textContent = `×${n}`;
    pair.appendChild(s);
    wrap.appendChild(pair);
  });
  return wrap;
}
function canAfford(res, cost) { return Object.entries(cost).every(([k, v]) => (res[k] || 0) >= v); }

const BUILD_MODE = { road: 'buildRoad', settlement: 'buildSettlement', city: 'buildCity', ship: 'buildShip', knight: 'buildKnight', warKnight: 'buildWarKnight' };
function renderBuildGrid() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  const inMain = (game.phase === 'main' || game.phase === 'specialBuilding') && humansTurn();
  const seafarers = game.board.pirateHex != null;
  const ck = !!p.cityImprovements;
  const defs = [
    { key: 'road', label: '道', cost: E.COSTS.road, ok: inMain && p.roads.length < 15 && canAfford(p.resources, E.COSTS.road) && E.availableRoadEdges(game, idx).length },
  ];
  if (seafarers) defs.push({ key: 'ship', label: '船', cost: E.COSTS.ship, ok: inMain && p.ships.length < 15 && canAfford(p.resources, E.COSTS.ship) && E.availableShipEdges(game, idx).length });
  defs.push(
    { key: 'settlement', label: '開拓地', cost: E.COSTS.settlement, ok: inMain && p.settlements.length < 5 && canAfford(p.resources, E.COSTS.settlement) && E.availableSettlementVertices(game, idx, false).length },
    { key: 'city', label: '都市', cost: E.COSTS.city, ok: inMain && p.cities.length < 4 && canAfford(p.resources, E.COSTS.city) && E.availableCityVertices(game, idx).length },
  );
  if (ck) {
    defs.push(
      { key: 'knight', label: '騎士', cost: E.KNIGHT_COST, ok: inMain && canAfford(p.resources, E.KNIGHT_COST) && E.availableKnightVertices(game, idx).length },
      { key: 'wall', label: '都市壁', cost: E.WALL_COST, ok: false }, // クリックで即建てる（下のハンドラで特別扱い）
      { key: 'improve', label: '都市の発展', cost: {}, ok: inMain && E.TRACKS.some((t) => E.canImproveCity(game, idx, t)) },
    );
  } else {
    defs.push({ key: 'dev', label: '発展カード', cost: E.COSTS.dev, ok: inMain && game.bank.devDeck.length > 0 && canAfford(p.resources, E.COSTS.dev) });
  }
  if (game.scenario === 'barbarians') {
    defs.push({ key: 'warKnight', label: '騎士', cost: E.WAR_KNIGHT_COST, ok: inMain && canAfford(p.resources, E.WAR_KNIGHT_COST) && E.availableWarKnightEdges(game, idx).length });
  }
  els.buildGrid.innerHTML = '';
  defs.forEach((d) => {
    if (d.key === 'wall') d.ok = E.canBuildWall(game, idx);
    const btn = document.createElement('button');
    const active = ui.mode === BUILD_MODE[d.key];
    btn.className = `build-btn${active ? ' is-selected' : ''}`;
    btn.disabled = !d.ok;
    btn.appendChild(buildIcon(d.key, p.color));
    const label = document.createElement('span');
    label.className = 'build-btn__label';
    label.textContent = d.label;
    btn.appendChild(label);
    if (d.key !== 'improve') btn.appendChild(costRow(d.cost));
    btn.addEventListener('click', () => {
      if (d.key === 'dev') { E.buyDevCard(game); playEvents(); persistAndRender(); return; }
      if (d.key === 'wall') { E.buildWall(game); playEvents(); persistAndRender(); return; }
      if (d.key === 'improve') { ui = { mode: 'cityImprove', data: {} }; renderAll(); return; }
      if (active) { ui = { mode: 'idle', data: {} }; renderAll(); return; }
      ui = { mode: BUILD_MODE[d.key], data: {} };
      renderAll();
    });
    els.buildGrid.appendChild(btn);
  });
  // 船を動かす（航海者版・手番に1回だけ）
  if (seafarers) {
    const movable = E.movableShipEdges(game, idx);
    const btn = document.createElement('button');
    const active = ui.mode === 'moveShip1' || ui.mode === 'moveShip2';
    btn.className = `build-btn${active ? ' is-selected' : ''}`;
    btn.disabled = !(inMain && movable.length);
    btn.appendChild(buildIcon('moveShip', p.color));
    const label = document.createElement('span');
    label.className = 'build-btn__label';
    label.textContent = '船を動かす';
    btn.appendChild(label);
    btn.addEventListener('click', () => {
      if (active) { ui = { mode: 'idle', data: {} }; renderAll(); return; }
      ui = { mode: 'moveShip1', data: {} };
      renderAll();
    });
    els.buildGrid.appendChild(btn);
  }
  // 騎士を動かす（蛮族の襲撃・手番に1回ずつ）
  if (game.scenario === 'barbarians') {
    const movable = p.warKnights.filter((k) => E.movableWarKnightEdges(game, idx, k.id, false).length);
    const btn = document.createElement('button');
    const active = ui.mode === 'moveWarKnight1' || ui.mode === 'moveWarKnight2';
    btn.className = `build-btn${active ? ' is-selected' : ''}`;
    btn.disabled = !(inMain && movable.length);
    btn.appendChild(buildIcon('warKnight', p.color));
    const label = document.createElement('span');
    label.className = 'build-btn__label';
    label.textContent = '騎士を動かす';
    btn.appendChild(label);
    btn.addEventListener('click', () => {
      if (active) { ui = { mode: 'idle', data: {} }; renderAll(); return; }
      ui = { mode: 'moveWarKnight1', data: {} };
      renderAll();
    });
    els.buildGrid.appendChild(btn);
  }
}

// ================================================================
// 操作パネル（画面中央の窓。交易・捨てる・盗む相手選び・発展カードなど）
// ================================================================
function openPanel() { els.panelOverlay.hidden = false; }
function closePanel() { els.panelOverlay.hidden = true; els.panel.innerHTML = ''; }

function renderPanel() {
  // 捨て札はCPUの分を先に片付けてよいので、人が窓で捨てるのは「人の席でまだ残っている分」だけ
  if (ui.mode === 'discard' && game.phase === 'discard') {
    const d = game.pendingDiscards.find((x) => !isCpuSeat(x.player));
    if (d) { openPanel(); renderDiscardPanel(d); }
    else closePanel();
    return;
  }
  if (ui.mode === 'goldPick' && game.phase === 'goldPick') {
    const d = game.pendingGoldPicks.find((x) => !isCpuSeat(x.player));
    if (d) { openPanel(); renderGoldPickPanel(d); }
    else closePanel();
    return;
  }
  if (ui.mode === 'scienceBonus' && game.phase === 'scienceBonus') {
    const p = game.pendingScienceBonus.find((x) => !isCpuSeat(x));
    if (p != null) { openPanel(); renderScienceBonusPanel(p); }
    else closePanel();
    return;
  }
  if (game.phase === 'camelVote' && game.pendingCamelVote) {
    const acting = game.pendingCamelVote.order[game.pendingCamelVote.idx];
    if (isCpuSeat(acting)) { closePanel(); return; }
    openPanel(); renderCamelVotePanel(acting); return;
  }
  if (game.phase === 'barbarianSteal') {
    const idx = E.currentPlayer(game);
    if (isCpuSeat(idx)) { closePanel(); return; }
    openPanel(); renderBarbarianStealPanel(idx); return;
  }
  if (ui.data.pendingHex != null) { openPanel(); renderRobberTargetPanel(ui.data.pendingHex, ui.data.forDev); return; }
  if (ui.data.pendingEdge != null) { openPanel(); renderDevRoadKindPanel(ui.data.pendingEdge); return; }
  if (ui.mode === 'tradeMenu') { openPanel(); renderTradeMenu(); return; }
  if (ui.mode === 'devMenu') { openPanel(); renderDevMenu(); return; }
  if (ui.mode === 'devYearOfPlenty') { openPanel(); renderYearOfPlentyPanel(); return; }
  if (ui.mode === 'devMonopoly') { openPanel(); renderMonopolyPanel(); return; }
  if (ui.mode === 'devRoad2') { openPanel(); renderDevRoadFinish(); return; }
  if (ui.mode === 'knightMenu') { openPanel(); renderKnightMenu(); return; }
  if (ui.mode === 'tradeCommodity') { openPanel(); renderCommodityTradePanel(); return; }
  if (ui.mode === 'knightExpelTarget') { openPanel(); renderKnightExpelPanel(); return; }
  if (ui.mode === 'cityImprove') { openPanel(); renderCityImprovePanel(); return; }
  if (ui.mode === 'progressMenu') { openPanel(); renderProgressMenu(); return; }
  if (ui.mode === 'progressRes1') { openPanel(); renderProgressRes1Panel(); return; }
  if (ui.mode === 'progressRes2') { openPanel(); renderProgressRes2Panel(); return; }
  if (ui.mode === 'progressCom1') { openPanel(); renderProgressCom1Panel(); return; }
  if (ui.mode === 'progressTrade1' || ui.mode === 'progressTrade2') { openPanel(); renderProgressTradePanel(); return; }
  if (ui.mode === 'progressKnightOwn') { openPanel(); renderProgressKnightOwnPanel(); return; }
  if (ui.mode === 'progressKnightTarget') { openPanel(); renderProgressKnightTargetPanel(); return; }
  if (game.winner != null) { openPanel(); renderWinPanel(); return; }
  closePanel();
}

function renderWinPanel() {
  els.panel.innerHTML = `<h2>プレイヤー${game.winner + 1}の勝ち！</h2><p>${E.winTargetFor(game, game.winner)}点に到達しました。</p>
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

function renderDiscardPanel(d) {
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
      if (game.phase !== 'discard') ui = { mode: 'moveRobber', data: {} };
      persistAndRender(); // 捨て札が残っていればCPUの分を自動で進め、人の分が残っていれば窓を出し直す
    },
  });
}

function renderGoldPickPanel(d) {
  const picked = ui.data.goldPicked || (ui.data.goldPicked = []);
  els.panel.innerHTML = `<h2>プレイヤー${d.player + 1}: 金の川で好きな資源を${d.count}枚選ぶ（あと${d.count - picked.length}枚）</h2>
    <div class="res-pick" data-row="pick"></div>
    <p>選んだ: ${picked.length ? '' : 'なし'}</p>
    <button class="btn btn--accent" data-act="confirm" ${picked.length === d.count ? '' : 'disabled'}>受け取る</button>`;
  fillResPick(els.panel.querySelector('[data-row="pick"]'), E.RESOURCES, () => false, (r, b) => {
    b.appendChild(resIcon(r));
    const s = document.createElement('span'); s.textContent = `残り${game.bank.resources[r]}`; b.appendChild(s);
    if (game.bank.resources[r] - picked.filter((x) => x === r).length <= 0) b.disabled = true;
  }, 'pick');
  const p = els.panel.querySelector('p');
  picked.forEach((r) => p.appendChild(resIcon(r)));
  bindPanel({
    pick: (b) => { if (picked.length < d.count) { picked.push(b.dataset.res); renderPanel(); } },
    confirm: () => {
      E.pickGold(game, d.player, picked);
      ui.data.goldPicked = null;
      if (game.phase !== 'goldPick') ui = { mode: 'idle', data: {} };
      persistAndRender();
    },
  });
}

// 都市と騎士(科学3段階目): この目で何も入らなかった人が、好きな資源を1枚選ぶ
function renderScienceBonusPanel(playerIdx) {
  els.panel.innerHTML = `<h2>プレイヤー${playerIdx + 1}: 科学の力で好きな資源を1枚選ぶ</h2>
    <div class="res-pick" data-row="pick"></div>`;
  fillResPick(els.panel.querySelector('[data-row="pick"]'), E.RESOURCES, () => false, (r, b) => {
    b.appendChild(resIcon(r));
    const s = document.createElement('span'); s.textContent = `残り${game.bank.resources[r]}`; b.appendChild(s);
    if (game.bank.resources[r] <= 0) b.disabled = true;
  }, 'pick');
  bindPanel({
    pick: (b) => {
      E.pickScienceBonus(game, playerIdx, b.dataset.res);
      if (game.phase !== 'scienceBonus') ui = { mode: 'idle', data: {} };
      persistAndRender();
    },
  });
}

// 隊商: 羊・麦を出してラクダの投票に参加する
function renderCamelVotePanel(playerIdx) {
  const p = game.players[playerIdx];
  const bid = ui.data.camelBid || (ui.data.camelBid = { wheat: 0, sheep: 0 });
  els.panel.innerHTML = `<h2>プレイヤー${playerIdx + 1}の投票（ラクダの置き場所）</h2>
    <p style="opacity:.8">羊・麦を出すほど、その人の意見が通りやすくなります。出さなくても参加できます。</p>
    <div class="sheet__row"><span>麦</span><div class="stepper">
      <button class="ghost-btn" data-act="wdec">−</button><b>${bid.wheat}</b><button class="ghost-btn" data-act="winc" ${bid.wheat < p.resources.wheat ? '' : 'disabled'}>＋</button>
    </div></div>
    <div class="sheet__row"><span>羊</span><div class="stepper">
      <button class="ghost-btn" data-act="sdec">−</button><b>${bid.sheep}</b><button class="ghost-btn" data-act="sinc" ${bid.sheep < p.resources.sheep ? '' : 'disabled'}>＋</button>
    </div></div>
    <button class="btn btn--accent" data-act="bid">この内容で投票する</button>`;
  bindPanel({
    winc: () => { bid.wheat++; renderPanel(); },
    wdec: () => { if (bid.wheat > 0) { bid.wheat--; renderPanel(); } },
    sinc: () => { bid.sheep++; renderPanel(); },
    sdec: () => { if (bid.sheep > 0) { bid.sheep--; renderPanel(); } },
    bid: () => {
      E.submitCamelBid(game, playerIdx, bid);
      ui.data.camelBid = null;
      playEvents(); persistAndRender(); renderPanel();
    },
  });
}
// 蛮族の襲撃: 7が出たら、盗賊の代わりに相手を選んで1枚奪う
function renderBarbarianStealPanel(idx) {
  const targets = E.barbarianStealTargets(game, idx);
  els.panel.innerHTML = `<h2>誰から奪う？</h2>`
    + (targets.length ? targets.map((t) => `<button class="card-btn" data-act="pick" data-target="${t}">プレイヤー${t + 1}（手札${E.RESOURCES.reduce((a, r) => a + game.players[t].resources[r], 0)}枚）</button>`).join('')
      : `<button class="card-btn" data-act="pick" data-target="">誰も奪えない</button>`);
  bindPanel({
    pick: (b) => {
      const target = b.dataset.target === '' ? null : Number(b.dataset.target);
      E.resolveBarbarianSteal(game, target);
      playEvents(); persistAndRender();
    },
  });
}

function renderRobberTargetPanel(hexId, forDev) {
  const idx = E.currentPlayer(game);
  const targets = E.banditTargets(game, hexId, idx);
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
  const fishOther = ui.data.fishOther == null ? (idx + 1) % game.playerCount : ui.data.fishOther;
  const fishRes = ui.data.fishRes || (ui.data.fishRes = E.RESOURCES[0]);
  const goldRes = ui.data.goldRes || (ui.data.goldRes = E.RESOURCES[0]);
  const gold2Res = ui.data.gold2Res || (ui.data.gold2Res = E.RESOURCES[0]);
  let scenarioHtml = '';
  if (game.scenario === 'fishermen') {
    const fishTotal = (p.fishTokens || []).reduce((a, b) => a + b, 0);
    const canGive = game.oldBootHolder === idx && game.players.some((_, i) => i !== idx && E.canGiveOldBoot(game, i));
    scenarioHtml = `<hr style="border-color:rgba(255,255,255,0.15)">
      <h2>漁師（魚 ${(p.fishTokens || []).join('・') || 'なし'}＝合計${fishTotal}匹${game.oldBootHolder === idx ? '・古い靴あり（勝利点+1点多く要る）' : ''}）</h2>
      <div class="sheet__row"><button class="ghost-btn" data-act="fishRobber" ${E.canUseFishTrade(game, idx, 'robberAway') ? '' : 'disabled'}>魚2匹: 盗賊を盤外へ</button></div>
      <div class="sheet__row"><span>相手</span><div class="res-pick" data-row="fishOther"></div>
        <button class="ghost-btn" data-act="fishSteal" ${E.canUseFishTrade(game, idx, 'steal') ? '' : 'disabled'}>魚3匹: 資源を奪う</button></div>
      <div class="sheet__row"><span>資源</span><div class="res-pick" data-row="fishRes"></div>
        <button class="ghost-btn" data-act="fishResource" ${E.canUseFishTrade(game, idx, 'resource') ? '' : 'disabled'}>魚4匹: 資源1枚</button></div>
      <div class="sheet__row"><button class="ghost-btn" data-act="fishRoadStart" ${E.canUseFishTrade(game, idx, 'road') && E.availableRoadEdges(game, idx).length ? '' : 'disabled'}>魚5匹: 道を1本（置く場所を選ぶ）</button></div>
      <div class="sheet__row"><button class="ghost-btn" data-act="fishDev" ${E.canUseFishTrade(game, idx, 'devcard') && game.bank.devDeck.length ? '' : 'disabled'}>魚7匹: 発展カード1枚</button></div>
      ${canGive ? `<div class="sheet__row"><span>古い靴を渡す相手</span><div class="res-pick" data-row="bootOther"></div>
        <button class="ghost-btn" data-act="giveBoot">渡す</button></div>` : ''}`;
  } else if (game.scenario === 'rivers') {
    scenarioHtml = `<hr style="border-color:rgba(255,255,255,0.15)">
      <h2>川（金貨 ${p.gold || 0}枚${game.richPlayer === idx ? '・富豪+1点' : ''}${(game.poorPlayers || []).includes(idx) ? '・貧者-2点' : ''}・橋${p.bridges || 0}/3）</h2>
      <div class="sheet__row"><span>資源</span><div class="res-pick" data-row="goldRes"></div>
        <button class="ghost-btn" data-act="goldTrade" ${E.canTradeGold(game, idx) && (p.gold || 0) >= 2 ? '' : 'disabled'}>金貨2枚: 資源1枚（手番に${p.goldSpendsThisTurn || 0}/2回使用）</button></div>
      <div class="sheet__row"><span>資源</span><div class="res-pick" data-row="gold2Res"></div>
        <button class="ghost-btn" data-act="resForGold">資源→金貨1枚（港なしは4枚、3:1港は3枚）</button></div>`;
  }

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
    ${scenarioHtml}
    <button class="ghost-btn" data-act="cancel">やめる</button>`;

  fillResPick(els.panel.querySelector('[data-row="give"]'), E.RESOURCES, (r) => r === give, (r, b) => {
    b.appendChild(resIcon(r)); const s = document.createElement('span'); s.textContent = `×${p.resources[r]}`; b.appendChild(s);
  }, 'give');
  fillResPick(els.panel.querySelector('[data-row="want"]'), E.RESOURCES, (r) => r === want, (r, b) => b.appendChild(resIcon(r)), 'want');
  fillOtherPick(els.panel.querySelector('[data-row="other"]'), other);
  fillStepperRow(els.panel.querySelector('[data-row="pgive"]'), pGive, (r) => p.resources[r], 'pg');
  fillStepperRow(els.panel.querySelector('[data-row="pget"]'), pGet, (r) => game.players[other].resources[r], 'pw');
  if (game.scenario === 'fishermen') {
    fillOtherPick(els.panel.querySelector('[data-row="fishOther"]'), fishOther, 'fishOther');
    fillResPick(els.panel.querySelector('[data-row="fishRes"]'), E.RESOURCES, (r) => r === fishRes, (r, b) => b.appendChild(resIcon(r)), 'fishRes');
    if (els.panel.querySelector('[data-row="bootOther"]')) {
      const bootOther = ui.data.bootOther == null ? (idx + 1) % game.playerCount : ui.data.bootOther;
      fillOtherPick(els.panel.querySelector('[data-row="bootOther"]'), bootOther, 'bootOther');
    }
  } else if (game.scenario === 'rivers') {
    fillResPick(els.panel.querySelector('[data-row="goldRes"]'), E.RESOURCES, (r) => r === goldRes, (r, b) => b.appendChild(resIcon(r)), 'goldRes');
    fillResPick(els.panel.querySelector('[data-row="gold2Res"]'), E.RESOURCES, (r) => r === gold2Res, (r, b) => b.appendChild(resIcon(r)), 'gold2Res');
  }

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
      if (isCpuSeat(other)) {
        // CPUが相手のときは、成立させる前に受けるか断るかを決める（人の手札は見ず、今回の内容だけで判断）
        if (CPU.acceptTrade(game, other, pGive, pGet, seatLevel(other))) {
          E.playerTrade(game, other, pGive, pGet);
          game.log.push(`プレイヤー${other + 1}が交易を受けました`);
        } else {
          game.log.push(`プレイヤー${other + 1}は交易を断りました`);
        }
      } else {
        E.playerTrade(game, other, pGive, pGet);
      }
      ui.data.pGive = null; ui.data.pGet = null;
      playEvents(); persistAndRender(); renderPanel();
    },
    fishOther: (b) => { ui.data.fishOther = Number(b.dataset.p); renderPanel(); },
    bootOther: (b) => { ui.data.bootOther = Number(b.dataset.p); renderPanel(); },
    fishRes: (b) => { ui.data.fishRes = b.dataset.res; renderPanel(); },
    goldRes: (b) => { ui.data.goldRes = b.dataset.res; renderPanel(); },
    gold2Res: (b) => { ui.data.gold2Res = b.dataset.res; renderPanel(); },
    fishRobber: () => { E.fishRobberAway(game); playEvents(); persistAndRender(); renderPanel(); },
    fishSteal: () => { E.fishSteal(game, fishOther); playEvents(); persistAndRender(); renderPanel(); },
    fishResource: () => { E.fishResource(game, fishRes); playEvents(); persistAndRender(); renderPanel(); },
    fishRoadStart: () => { ui = { mode: 'fishRoadPick', data: {} }; renderAll(); },
    fishDev: () => { E.fishDevCard(game); playEvents(); persistAndRender(); renderPanel(); },
    giveBoot: () => { E.giveOldBoot(game, ui.data.bootOther == null ? (idx + 1) % game.playerCount : ui.data.bootOther); playEvents(); persistAndRender(); renderPanel(); },
    goldTrade: () => { E.tradeGold(game, goldRes); playEvents(); persistAndRender(); renderPanel(); },
    resForGold: () => { E.tradeResourceForGold(game, gold2Res); playEvents(); persistAndRender(); renderPanel(); },
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
function fillOtherPick(container, other, act) {
  const idx = E.currentPlayer(game);
  game.players.forEach((_, i) => {
    if (i === idx) return;
    const b = document.createElement('button');
    b.dataset.act = act || 'other'; b.dataset.p = i;
    if (i === other) b.classList.add('is-selected');
    b.textContent = `プレイヤー${i + 1}` + (isCpuSeat(i) ? '（CPU）' : '');
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

// 街道建設: 道・船どちらにも置ける辺をタップしたとき、どちらにするか選ばせる窓
function renderDevRoadKindPanel(eid) {
  els.panel.innerHTML = `<h2>街道建設</h2><p class="sheet__row">道にしますか、船にしますか。</p>
    <button class="btn btn--accent" data-act="road">道にする</button>
    <button class="btn btn--accent" data-act="ship">船にする</button>
    <button class="ghost-btn" data-act="cancel">やめる</button>`;
  bindPanel({
    road: () => resolveDevRoadPick(eid, 'road'),
    ship: () => resolveDevRoadPick(eid, 'ship'),
    cancel: () => { ui.data.pendingEdge = null; renderAll(); },
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
// 都市と騎士の窓（騎士を操作・都市の発展・進歩カード）
// ================================================================
// 都市と騎士(交易3段階目): 商品2枚で、銀行から好きな資源か商品を1枚もらう
function renderCommodityTradePanel() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  const giving = ui.data.give;
  if (!giving) {
    const rows = E.COMMODITIES.filter((c) => (p.commodities[c] || 0) >= 2)
      .map((c) => `<button class="card-btn" data-act="give" data-c="${c}">${E.COMMODITY_LABEL[c]}を2枚渡す（持っている ${p.commodities[c]}枚）</button>`).join('')
      || '<p>2枚ある商品がありません</p>';
    els.panel.innerHTML = `<h2>商品を交易（2:1）</h2>${rows}<button class="ghost-btn" data-act="cancel">やめる</button>`;
    bindPanel({
      give: (b) => { ui.data.give = b.dataset.c; renderPanel(); },
      cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
    });
    return;
  }
  els.panel.innerHTML = `<h2>もらうものを選ぶ</h2>
    <div class="res-pick" data-row="res"></div>
    <div class="res-pick" data-row="com"></div>
    <button class="ghost-btn" data-act="cancel">やめる</button>`;
  fillResPick(els.panel.querySelector('[data-row="res"]'), E.RESOURCES, () => false, (r, b) => b.appendChild(resIcon(r)), 'res');
  fillResPick(els.panel.querySelector('[data-row="com"]'), E.COMMODITIES, () => false, (c, b) => b.appendChild(resIcon(c)), 'com');
  bindPanel({
    res: (b) => { if (E.tradeCommodity(game, giving, 'resource', b.dataset.res)) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } },
    com: (b) => { if (E.tradeCommodity(game, giving, 'commodity', b.dataset.res)) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}
function renderKnightMenu() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  const rows = p.knights.map((k) => `<div class="sheet__row">
      <span>${E.KNIGHT_LEVEL_LABEL[k.level]}${k.active ? '（起動中）' : '（休み）'}</span>
      <span>
        <button class="ghost-btn" data-act="activate" data-k="${k.id}" ${E.canActivateKnight(game, idx, k.id) ? '' : 'disabled'}>起動</button>
        <button class="ghost-btn" data-act="upgrade" data-k="${k.id}" ${E.canUpgradeKnight(game, idx, k.id) ? '' : 'disabled'}>昇格</button>
        <button class="ghost-btn" data-act="move" data-k="${k.id}" ${E.movableKnightVertices(game, idx, k.id).length ? '' : 'disabled'}>移動</button>
        <button class="ghost-btn" data-act="expel" data-k="${k.id}" ${E.expellableTargets(game, idx, k.id).length ? '' : 'disabled'}>追い出す</button>
        <button class="ghost-btn" data-act="chase" data-k="${k.id}" ${E.canChaseRobber(game, idx, k.id) ? '' : 'disabled'}>盗賊払い</button>
      </span>
    </div>`).join('') || '<p>騎士はいません</p>';
  els.panel.innerHTML = `<h2>騎士を操作</h2>${rows}<button class="ghost-btn" data-act="cancel">戻る</button>`;
  bindPanel({
    activate: (b) => { E.activateKnight(game, Number(b.dataset.k)); playEvents(); persistAndRender(); },
    upgrade: (b) => { E.upgradeKnight(game, Number(b.dataset.k)); playEvents(); persistAndRender(); },
    move: (b) => { ui = { mode: 'moveKnightTo', data: { knightId: Number(b.dataset.k) } }; renderAll(); },
    expel: (b) => { ui = { mode: 'knightExpelTarget', data: { knightId: Number(b.dataset.k) } }; renderAll(); },
    chase: (b) => { E.chaseRobber(game, Number(b.dataset.k)); playEvents(); persistAndRender(); },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}
function renderKnightExpelPanel() {
  const idx = E.currentPlayer(game);
  const targets = E.expellableTargets(game, idx, ui.data.knightId);
  const rows = targets.map((t, i) => {
    const k = game.players[t.ownerIdx].knights.find((x) => x.id === t.knightId);
    return `<button class="card-btn" data-act="pick" data-i="${i}">プレイヤー${t.ownerIdx + 1}の${E.KNIGHT_LEVEL_LABEL[k.level]}</button>`;
  }).join('') || '<p>追い出せる騎士がいません</p>';
  els.panel.innerHTML = `<h2>騎士を追い出す</h2>${rows}<button class="ghost-btn" data-act="cancel">戻る</button>`;
  bindPanel({
    pick: (b) => {
      const t = targets[Number(b.dataset.i)];
      E.expelKnight(game, ui.data.knightId, t.ownerIdx, t.knightId);
      ui = { mode: 'knightMenu', data: {} };
      playEvents(); persistAndRender();
    },
    cancel: () => { ui = { mode: 'knightMenu', data: {} }; renderAll(); },
  });
}

function renderCityImprovePanel() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  const rows = E.TRACKS.map((t) => {
    const lv = p.cityImprovements[t];
    const costText = lv < 5 ? `商品${E.cityImprovementCost(lv + 1)}枚（${E.COMMODITY_LABEL[E.TRACK_COMMODITY[t]]}）` : '最大';
    const star = E.metropolisOwner(game, t) === idx ? '★大都市' : '';
    return `<div class="sheet__row"><span>${E.TRACK_LABEL[t]} ${lv}/5 ${star}</span><span>${costText}</span>
      <button class="ghost-btn" data-act="up" data-t="${t}" ${E.canImproveCity(game, idx, t) ? '' : 'disabled'}>上げる</button></div>`;
  }).join('');
  els.panel.innerHTML = `<h2>都市の発展</h2>${rows}<button class="ghost-btn" data-act="cancel">戻る</button>`;
  bindPanel({
    up: (b) => { E.improveCity(game, b.dataset.t); playEvents(); persistAndRender(); },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}

// 使うと即座に終わる進歩カード（相手の選び・置き場所などが要らないもの）
const PROGRESS_NO_PARAM = new Set(['tr_vp', 'po_vp', 'sc_vp', 'tr_bankgift', 'tr_cardsteal', 'po_cardsteal', 'sc_cardsteal', 'po_activateall', 'po_wallfree', 'sc_irrigation', 'sc_mining', 'sc_research']);
const PROGRESS_PARAM_MODE = {
  tr_resource1: 'progressRes1', sc_resource1: 'progressRes1', po_resource1: 'progressRes1',
  tr_resource2: 'progressRes2', sc_resource2: 'progressRes2',
  tr_commodity1: 'progressCom1', po_commodity1: 'progressCom1', sc_commodity1: 'progressCom1',
  tr_stealres: 'progressRes1',
  tr_trade21: 'progressTrade1', tr_trade21x2: 'progressTrade2',
  tr_roadfree: 'progressEdge1', sc_roadfree2: 'progressEdge2',
  po_knightfree: 'progressVertex',
  po_upgradefree: 'progressKnightOwn',
  po_deserter: 'progressKnightTarget', po_intrigue: 'progressKnightTarget',
  sc_inventor: 'progressHexA',
};
function renderProgressMenu() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  const rows = p.progressCards.map((c, i) => `<div class="sheet__row"><span>${E.PROGRESS_LABEL[c.id]}</span>
    <button class="ghost-btn" data-act="use" data-i="${i}">使う</button></div>`).join('') || '<p>持っていません</p>';
  els.panel.innerHTML = `<h2>進歩カード（手札上限4）</h2>${rows}<button class="ghost-btn" data-act="cancel">戻る</button>`;
  bindPanel({
    use: (b) => {
      const i = Number(b.dataset.i);
      const card = p.progressCards[i];
      if (PROGRESS_NO_PARAM.has(card.id)) { E.playProgressCard(game, i, {}); playEvents(); persistAndRender(); return; }
      const mode = PROGRESS_PARAM_MODE[card.id];
      if (!mode) return;
      ui = { mode, data: { cardIdx: i, picked: [], edges: [], trades: [], pendingGive: null } };
      renderAll();
    },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}
function renderProgressRes1Panel() {
  els.panel.innerHTML = '<h2>資源を1つ選ぶ</h2><div class="res-pick" data-row="pick"></div><button class="ghost-btn" data-act="cancel">やめる</button>';
  fillResPick(els.panel.querySelector('[data-row="pick"]'), E.RESOURCES, () => false, (r, b) => b.appendChild(resIcon(r)), 'pick');
  bindPanel({
    pick: (b) => { E.playProgressCard(game, ui.data.cardIdx, { res: b.dataset.res }); ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}
function renderProgressRes2Panel() {
  const picked = ui.data.picked;
  els.panel.innerHTML = `<h2>資源を2つ選ぶ（${picked.length}/2）</h2><div class="res-pick" data-row="pick"></div>
    <p>選んだ: ${picked.length ? '' : 'なし'}</p>
    <button class="btn btn--accent" data-act="confirm" ${picked.length === 2 ? '' : 'disabled'}>受け取る</button>
    <button class="ghost-btn" data-act="cancel">やめる</button>`;
  fillResPick(els.panel.querySelector('[data-row="pick"]'), E.RESOURCES, () => false, (r, b) => b.appendChild(resIcon(r)), 'pick');
  const p = els.panel.querySelector('p');
  picked.forEach((r) => p.appendChild(resIcon(r)));
  bindPanel({
    pick: (b) => { if (picked.length < 2) { picked.push(b.dataset.res); renderPanel(); } },
    confirm: () => { E.playProgressCard(game, ui.data.cardIdx, { res: picked }); ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}
function renderProgressCom1Panel() {
  els.panel.innerHTML = '<h2>商品を1つ選ぶ</h2><div class="res-pick" data-row="pick"></div><button class="ghost-btn" data-act="cancel">やめる</button>';
  fillResPick(els.panel.querySelector('[data-row="pick"]'), E.COMMODITIES, () => false, (c, b) => b.appendChild(resIcon(c)), 'pick');
  bindPanel({
    pick: (b) => { E.playProgressCard(game, ui.data.cardIdx, { com: b.dataset.res }); ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}
function renderProgressTradePanel() {
  const times = ui.mode === 'progressTrade2' ? 2 : 1;
  const trades = ui.data.trades;
  const giving = ui.data.pendingGive;
  els.panel.innerHTML = giving == null
    ? `<h2>2:1で渡す資源を選ぶ（${trades.length + 1}/${times}）</h2><div class="res-pick" data-row="give"></div><button class="ghost-btn" data-act="cancel">やめる</button>`
    : '<h2>もらう資源を選ぶ</h2><div class="res-pick" data-row="want"></div><button class="ghost-btn" data-act="cancel">やめる</button>';
  if (giving == null) {
    fillResPick(els.panel.querySelector('[data-row="give"]'), E.RESOURCES, () => false, (r, b) => b.appendChild(resIcon(r)), 'give');
  } else {
    fillResPick(els.panel.querySelector('[data-row="want"]'), E.RESOURCES.filter((r) => r !== giving), () => false, (r, b) => b.appendChild(resIcon(r)), 'want');
  }
  bindPanel({
    give: (b) => { ui.data.pendingGive = b.dataset.res; renderPanel(); },
    want: (b) => {
      trades.push([ui.data.pendingGive, b.dataset.res]);
      ui.data.pendingGive = null;
      if (trades.length >= times) { E.playProgressCard(game, ui.data.cardIdx, { trades }); ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } else renderPanel();
    },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}
function renderProgressKnightOwnPanel() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  const list = p.knights.filter((k) => k.level < 3 && !(k.level === 2 && (p.cityImprovements.politics || 0) < 3)
    && p.knights.filter((x) => x.level === k.level + 1).length < E.MAX_KNIGHTS_PER_LEVEL);
  const rows = list.map((k) => `<button class="card-btn" data-act="pick" data-k="${k.id}">${E.KNIGHT_LEVEL_LABEL[k.level]} → ${E.KNIGHT_LEVEL_LABEL[k.level + 1]}</button>`).join('') || '<p>昇格できる騎士がいません</p>';
  els.panel.innerHTML = `<h2>騎士を1体、只で昇格</h2>${rows}<button class="ghost-btn" data-act="cancel">やめる</button>`;
  bindPanel({
    pick: (b) => { E.playProgressCard(game, ui.data.cardIdx, { knightId: Number(b.dataset.k) }); ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}
function renderProgressKnightTargetPanel() {
  const idx = E.currentPlayer(game);
  const card = game.players[idx].progressCards[ui.data.cardIdx];
  const isIntrigue = card.id === 'po_intrigue';
  const list = [];
  game.players.forEach((op, oi) => {
    if (oi === idx) return;
    op.knights.forEach((k) => {
      if (isIntrigue) {
        const near = game.players[idx].knights.some((mk) => game.board.vertices[mk.vertexId].neighbors.includes(k.vertexId));
        if (!near) return;
      }
      list.push({ ownerIdx: oi, knightId: k.id, level: k.level });
    });
  });
  const rows = list.map((t, i) => `<button class="card-btn" data-act="pick" data-i="${i}">プレイヤー${t.ownerIdx + 1}の${E.KNIGHT_LEVEL_LABEL[t.level]}</button>`).join('') || '<p>対象がいません</p>';
  els.panel.innerHTML = `<h2>${E.PROGRESS_LABEL[card.id]}</h2>${rows}<button class="ghost-btn" data-act="cancel">やめる</button>`;
  bindPanel({
    pick: (b) => {
      const t = list[Number(b.dataset.i)];
      E.playProgressCard(game, ui.data.cardIdx, { ownerIdx: t.ownerIdx, knightId: t.knightId });
      ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender();
    },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}

// ================================================================
// 操作ボタン
// ================================================================
// CPU の手番・捨て札の最中は、盤やボタンを人が触っても動かない（CPUの手として誤って進んでしまうのを防ぐ）
function humansTurn() {
  if (!game) return false;
  if (game.phase === 'discard') return game.pendingDiscards.some((d) => !isCpuSeat(d.player));
  if (game.phase === 'goldPick') return game.pendingGoldPicks.some((d) => !isCpuSeat(d.player));
  if (game.phase === 'scienceBonus') return game.pendingScienceBonus.some((p) => !isCpuSeat(p));
  if (game.phase === 'camelPlace') return !isCpuSeat(game.camelDecider);
  return !isCpuSeat(E.currentPlayer(game));
}
function renderActionBar() {
  const rollable = game.phase === 'roll' && humansTurn();
  const inSBP = game.phase === 'specialBuilding'; // 特別建設フェイズ: 建てる・発展カードを買うだけできる（交易・発展カードを使うのは不可）
  const buildable = (game.phase === 'main' || inSBP) && humansTurn();
  els.diceBtn.disabled = !rollable || rolling;
  els.tradeBtn.disabled = !buildable || inSBP;
  els.devBtn.disabled = !buildable || inSBP;
  const ckPlayer = game.players[E.currentPlayer(game)];
  if (ckPlayer.progressCards) {
    const n = ckPlayer.progressCards.length;
    els.devBtn.textContent = `進歩カード${n ? ` ${n}` : ''}`;
  } else {
    const n = ckPlayer.devCards.filter((c) => !c.played).length;
    els.devBtn.textContent = `発展カード${n ? ` ${n}` : ''}`;
  }
  els.endTurnBtn.disabled = !buildable;
  els.endTurnBtn.textContent = inSBP ? 'パス' : '手番を終える';
}
els.diceBtn.addEventListener('click', () => {
  if (rolling || game.phase !== 'roll' || !humansTurn()) return;
  const finish = () => {
    rolling = false;
    E.rollDice(game);
    ui = { mode: modeForPhase(), data: {} };
    playEvents();
    persistAndRender();
  };
  if (document.documentElement.classList.contains('motion-off')) { finish(); return; }
  // ルーレットのように目を入れ替え、だんだん遅くして止める
  rolling = true;
  els.diceBtn.disabled = true;
  const face = () => 1 + Math.floor(Math.random() * 6);
  let delay = 40;
  const spin = () => {
    els.diceBox.innerHTML = '';
    els.diceBox.appendChild(dieEl(face(), Math.random() * 60 - 30));
    els.diceBox.appendChild(dieEl(face(), Math.random() * 60 - 30));
    beep(500 + Math.random() * 300, 0.03);
    delay *= 1.25;
    if (delay < 260) setTimeout(spin, delay); else finish();
  };
  spin();
});
els.tradeBtn.addEventListener('click', () => { if (!humansTurn()) return; ui = { mode: 'tradeMenu', data: {} }; renderAll(); });
els.devBtn.addEventListener('click', () => {
  if (!humansTurn()) return;
  const p = game.players[E.currentPlayer(game)];
  ui = { mode: p.progressCards ? 'progressMenu' : 'devMenu', data: {} };
  renderAll();
});
els.endTurnBtn.addEventListener('click', () => {
  if (!humansTurn()) return;
  if (game.phase === 'specialBuilding') E.passSpecialBuild(game); else E.endTurn(game);
  ui = { mode: 'idle', data: {} };
  persistAndRender();
});

// ================================================================
// 盤面のタップ
// ================================================================
els.board.addEventListener('click', (e) => {
  if (!humansTurn()) return;
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
  if (ui.mode === 'buildKnight') { if (E.buildKnight(game, vid)) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } return; }
  if (ui.mode === 'moveKnightTo') {
    if (E.moveKnight(game, ui.data.knightId, vid)) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); }
    return;
  }
  if (ui.mode === 'progressVertex') {
    if (E.playProgressCard(game, ui.data.cardIdx, { vertex: vid })) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); }
    return;
  }
}
function onEdgeTap(eid) {
  if (game.phase === 'camelPlace') { if (E.placeCamel(game, eid)) { playEvents(); persistAndRender(); } return; }
  if (ui.mode === 'setupRoad') { E.setupPlaceRoad(game, eid); ui = { mode: modeForPhase(), data: {} }; playEvents(); persistAndRender(); return; }
  if (ui.mode === 'buildRoad') { if (E.buildRoad(game, eid)) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } return; }
  if (ui.mode === 'buildShip') { if (E.buildShip(game, eid)) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } return; }
  if (ui.mode === 'moveShip1') {
    const idx = E.currentPlayer(game);
    if (E.movableShipEdges(game, idx).includes(eid)) { ui = { mode: 'moveShip2', data: { from: eid } }; renderAll(); }
    return;
  }
  if (ui.mode === 'moveShip2') { if (E.moveShip(game, ui.data.from, eid)) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } return; }
  if (ui.mode === 'buildWarKnight') { if (E.buildWarKnight(game, eid)) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } return; }
  if (ui.mode === 'fishRoadPick') { if (E.fishRoad(game, eid)) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } return; }
  if (ui.mode === 'moveWarKnight1') {
    const idx = E.currentPlayer(game);
    const k = game.players[idx].warKnights.find((x) => x.edgeId === eid && E.movableWarKnightEdges(game, idx, x.id, false).length);
    if (k) { ui = { mode: 'moveWarKnight2', data: { knightId: k.id } }; renderAll(); }
    return;
  }
  if (ui.mode === 'moveWarKnight2') { if (E.moveWarKnight(game, ui.data.knightId, eid, false)) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } return; }
  if (ui.mode === 'devRoad1' || ui.mode === 'devRoad2') { onDevRoadEdgeTap(eid); return; }
  if (ui.mode === 'progressEdge1') {
    if (!E.canPlaceRoad(game, eid, E.currentPlayer(game))) return;
    if (E.playProgressCard(game, ui.data.cardIdx, { edge: eid })) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); }
    return;
  }
  if (ui.mode === 'progressEdge2') {
    if (!E.canPlaceRoad(game, eid, E.currentPlayer(game)) || ui.data.edges.includes(eid)) return;
    ui.data.edges.push(eid);
    if (ui.data.edges.length >= 2) {
      if (E.playProgressCard(game, ui.data.cardIdx, { edges: ui.data.edges })) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); }
    } else renderAll();
  }
}
// 街道建設: 道だけに置ける／船だけに置けるならそのまま進む。どちらも置ける辺（海沿い）なら窓で選ばせる。
function onDevRoadEdgeTap(eid) {
  const idx = E.currentPlayer(game);
  const canRoad = E.canPlaceRoad(game, eid, idx);
  const canShip = game.board.pirateHex != null && E.canPlaceShip(game, eid, idx);
  if (!canRoad && !canShip) return;
  if (canRoad && canShip) { ui.data.pendingEdge = eid; renderAll(); return; }
  resolveDevRoadPick(eid, canShip ? 'ship' : 'road');
}
function resolveDevRoadPick(eid, kind) {
  const item = kind === 'ship' ? { id: eid, kind: 'ship' } : eid;
  if (ui.mode === 'devRoad1') {
    ui.data.edges = [item];
    ui.mode = 'devRoad2';
    ui.data.pendingEdge = null;
    renderAll();
  } else {
    const picked = [...ui.data.edges, item];
    E.playRoadBuilding(game, ui.data.cardIdx, picked);
    ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender();
  }
}
function hexCurrentPos(hid) { return game.board.hexes[hid].terrain === 'water' ? game.board.pirateHex : game.board.robberHex; }
function onHexTap(hid) {
  if (ui.mode === 'moveRobber') {
    if (hid === hexCurrentPos(hid)) return;
    const idx = E.currentPlayer(game);
    const targets = E.banditTargets(game, hid, idx);
    if (targets.length > 1) { ui.data.pendingHex = hid; ui.data.forDev = null; renderAll(); }
    else { E.moveRobber(game, hid, targets[0] ?? null); ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); }
    return;
  }
  if (ui.mode === 'devKnightHex') {
    if (hid === hexCurrentPos(hid)) return;
    const idx = E.currentPlayer(game);
    const targets = E.banditTargets(game, hid, idx);
    if (targets.length > 1) { ui.data.pendingHex = hid; ui.data.forDev = ui.data.cardIdx; renderAll(); }
    else { E.playKnight(game, ui.data.cardIdx, hid, targets[0] ?? null); ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); }
    return;
  }
  if (ui.mode === 'progressHexA') {
    if (game.board.hexes[hid].number == null) return;
    ui.data.hexA = hid; ui.mode = 'progressHexB'; renderAll();
    return;
  }
  if (ui.mode === 'progressHexB') {
    if (game.board.hexes[hid].number == null || hid === ui.data.hexA) return;
    if (E.playProgressCard(game, ui.data.cardIdx, { hexA: ui.data.hexA, hexB: hid })) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); }
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
  if (game.phase === 'goldPick' && ui.mode !== 'goldPick') ui = { mode: 'goldPick', data: {} };
  if (game.phase === 'scienceBonus' && ui.mode !== 'scienceBonus') ui = { mode: 'scienceBonus', data: {} };
  renderBoardInto(els.board, game, ui);
  renderDice();
  renderPlayers();
  renderBank();
  renderHand();
  renderCk();
  renderBuildGrid();
  renderBanner();
  renderActionBar();
  renderPanel();
  scheduleCpu(); // CPUの番なら、ここで自動進行の予約をする（renderAllはすべての操作の後に呼ばれる）
}
