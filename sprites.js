'use strict';
// ドット絵の素材（色・スプライトの文字列）と、SVG の矩形リストに変換する小さな関数。
// 見た目のデータだけを持つ。DOM やゲームの状態には触らない。

export const INK = '#1a1420';
export const CREAM = '#fbf5e4';

// スプライトの文字列 → 色。Icon.dc.html / Board.dc.html のパレットをそのまま使う。
export const PAL = {
  k: INK, w: CREAM, g: '#63c35e', G: '#2c7236', t: '#8a5a30', T: '#5c3718',
  r: '#e0835a', R: '#9a4226', m: '#f6d2b4', y: '#fff08a', Y: '#d9a83a',
  s: '#9aa0b2', S: '#5f6578', b: '#f4f7ff', n: '#cfc6ad', K: '#2a2233', e: '#ffd35c',
};

// 資源・建物・カードのスプライト（8x8 〜 13x10 の文字グリッド。'.' は透明）
export const SPR = {
  wood: ['...gG...', '..ggGG..', '.gggGGG.', '..ggGG..', '.gggGGG.', 'ggggGGGG', '...tT...', '...tT...'],
  brick: ['........', '...rrR..', '..mmmmm.', '.rrRmrrR', '.mmmmmmm', 'rrRmrrRm', 'mmmmmmmm', '........'],
  sheep: ['........', '..wwww..', '.wwwwwkk', 'wwwwwwkk', 'wwwwwww.', '.wwwwww.', '.k.k.k..', '........'],
  wheat: ['..y..y..', '.yYy.yYy', '.yYy.yYy', '..y..y..', '...YY...', '..yYYy..', '.y.YY.y.', '...YY...'],
  ore: ['........', '...bs...', '..bssS..', '.bsssSS.', '.ssSsSS.', 'sssSSSSS', 'SSSSSSSS', '........'],
  robber: ['..KKKK..', '.KKKKKK.', '.KeKKeK.', '.KKKKKK.', '..KKKK..', '.KKKKKK.', 'KKKKKKKK', 'KKKKKKKK'],
  settle: ['....kk....', '...kcck...', '..kcccck..', '.kcccccck.', 'kkkkkkkkkk', '.kCCCCCCk.', '.kCCkkCCk.', '.kCCkkCCk.', '.kkkkkkkk.'],
  city: ['kkk.........', 'kck...kk....', 'kck..kcck...', 'kck.kcccck..', 'kckkcccccck.', 'kCkkkkkkkkkk', 'kCkCCCCCCCCk', 'kCkCCkkCCCCk', 'kCkCCkkCCCCk', 'kkkkkkkkkkkk'],
  card: ['.kkkkkk.', '.kwYYwk.', '.kwwwYk.', '.kwwYwk.', '.kwwwwk.', '.kwwYwk.', '.kkkkkk.', '........'],
  knight: ['......bb', '.....bwb', '....bwb.', 't..bwb..', '.tbwb...', '..tb....', '.t.t....', 't.......'],
};
// タイルの地形ごとのスプライト（岩山=peak、砂漠=cactus）
SPR.peak = ['...bS...', '..bsSS..', '..ssSS..', '.sssSSS.', '.ssSSSS.', 'sssSSSSS', '........', '........'];
SPR.cactus = ['...c....', '...c..c.', 'c..c..c.', 'c..cccc.', 'cccc....', '...c....', '...c....', '........'];

// engine.js の terrain 名 → 見た目（下地色・スプライト）
export const TER = {
  forest: { base: '#3d8a44', shade: '#27612f', spr: 'wood' },
  hills: { base: '#d0703f', shade: '#9c4a28', spr: 'brick' },
  pasture: { base: '#a6d86e', shade: '#72a948', spr: 'sheep' },
  field: { base: '#f0cc52', shade: '#c49a2c', spr: 'wheat' },
  mountains: { base: '#a3a9b8', shade: '#6d7384', spr: 'peak' },
  desert: { base: '#e8d6a0', shade: '#c4ae74', spr: 'cactus' },
};

export function shade(hex) {
  return '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.68).toString(16).padStart(2, '0')).join('');
}

// 文字グリッド → 矩形のリスト（同じ色が横に並ぶ分はまとめて1個の矩形にする）
export function stampRects(rows, x0, y0, s, pal, out) {
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const ch = row[x];
      let n = 1;
      while (row[x + n] === ch) n++;
      if (ch !== '.') out.push({ x: x0 + x * s, y: y0 + y * s, w: n * s, h: s, f: pal[ch] });
      x += n;
    }
  });
  return out;
}

// 六角形の下地を、水平の帯（ドットの横縞）で塗りつぶす
export function hexBandRects(cx, cy, w, h, f, cell, out) {
  for (let dy = -h / 2; dy < h / 2; dy += cell) {
    const m = Math.abs(dy + cell / 2);
    let hw = m <= h / 4 ? w / 2 : (w / 2) * (h / 2 - m) / (h / 4);
    hw = Math.round(hw / cell) * cell;
    if (hw > 0) out.push({ x: cx - hw, y: cy + dy, w: hw * 2, h: cell, f });
  }
  return out;
}

// 丸（数字チップ・港の下地）をドットの横縞で塗りつぶす
export function discRects(cx, cy, r, f, cell, out) {
  for (let dy = -r; dy < r; dy += cell / 2) {
    const m = Math.abs(dy + cell / 4);
    const hw = Math.round(Math.sqrt(Math.max(0, r * r - m * m)) / cell) * cell;
    if (hw > 0) out.push({ x: cx - hw, y: cy + dy, w: hw * 2, h: cell / 2, f });
  }
  return out;
}

// サイコロの目（10x10、枠つき）
export function dieRows(v) {
  const pips = {
    1: [[4, 4]], 2: [[2, 2], [6, 6]], 3: [[2, 2], [4, 4], [6, 6]],
    4: [[2, 2], [6, 2], [2, 6], [6, 6]], 5: [[2, 2], [6, 2], [4, 4], [2, 6], [6, 6]],
    6: [[2, 2], [6, 2], [2, 4], [6, 4], [2, 6], [6, 6]],
  }[v] || [];
  const g = [];
  for (let y = 0; y < 10; y++) {
    const row = [];
    for (let x = 0; x < 10; x++) row.push(x === 0 || y === 0 || x === 9 || y === 9 ? 'k' : (x === 8 || y === 8 ? 'n' : 'w'));
    g.push(row);
  }
  g[0][0] = g[0][9] = g[9][0] = g[9][9] = '.';
  pips.forEach(([x, y]) => { g[y][x] = g[y][x + 1] = g[y + 1][x] = g[y + 1][x + 1] = 'k'; });
  return g.map((r) => r.join(''));
}

// 建物の色は、資材のパレットに c（濃い色）・C（陰）を足して差し込む
export function paletteFor(color) { return Object.assign({}, PAL, { c: color, C: shade(color) }); }

// 資源・カード・サイコロなどの独立したドットアイコンを、指定の色数で 1 枚の <svg> に描く
export function iconSvg(kind, cell, color) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const rows = kind.startsWith('die') ? dieRows(Number(kind.slice(3))) : (SPR[kind] || SPR.wood);
  const pal = color ? paletteFor(color) : PAL;
  const rects = stampRects(rows, 0, 0, cell, pal, []);
  const w = rows[0].length * cell, h = rows.length * cell;
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  svg.setAttribute('class', 'pixel-icon');
  rects.forEach((r) => {
    const rect = document.createElementNS(svgNS, 'rect');
    rect.setAttribute('x', r.x); rect.setAttribute('y', r.y);
    rect.setAttribute('width', r.w); rect.setAttribute('height', r.h);
    rect.setAttribute('fill', r.f);
    svg.appendChild(rect);
  });
  return svg;
}
