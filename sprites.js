'use strict';
// ドット絵の素材（色・スプライトの図形）と、ラスタ化して矩形リストに変換する小さな関数。
// 見た目のデータだけを持つ。DOM やゲームの状態には触らない。
//
// 資源・建物・盗賊は「0〜1 の正方形の中の図形（四角・円・多角形）」として持つ（.audit/catan-design/FineBoard.dc.html のお手本）。
// raster() が好きな細かさ（RES マス/1マス）でドットの色の表に変換する。文字グリッドの8x8だった頃より2倍細かい。

export const INK = '#1a1420';
export const CREAM = '#fbf5e4';
export const RES = 2; // ドットの細かさ（1マスを RES x RES ドットで塗る。以前の文字グリッドの2倍）

// スプライト・盤で使う色の表（文字 → 色）。'c'/'C' は建物の色を差し込む場所（paletteFor）。
export const PAL = {
  k: INK, w: CREAM, g: '#63c35e', G: '#2c7236', h: '#9be38a', t: '#8a5a30', T: '#5c3718',
  r: '#e0835a', R: '#9a4226', l: '#f4ab86', m: '#f6d2b4', y: '#fff08a', Y: '#b8862a',
  s: '#8a90a2', S: '#565c70', b: '#f4f7ff', n: '#d6cfbd', c: '#4f8a34', d: '#35652a',
  K: '#2a2233', e: '#ffd35c',
};

// 図形を作る小さな関数（座標は 0〜1 の正方形の中）
function rect(x, y, w, h, c) { return { t: 'r', x, y, w, h, c }; }
function circ(x, y, r, c) { return { t: 'c', x, y, r, c }; }
function poly(pts, c) { return { t: 'p', p: pts, c }; }

const brick = [];
[{ y: 0.3, a: 0.26, b: 0.74 }, { y: 0.52, a: 0.12, b: 0.88 }, { y: 0.74, a: 0, b: 1 }].forEach((row, i) => {
  brick.push(rect(row.a, row.y, row.b - row.a, 0.22, 'm'));
  const off = i % 2 ? 0.12 : 0;
  for (let bx = row.a + 0.02 - off; bx < row.b; bx += 0.25) {
    const a = Math.max(bx, row.a + 0.02), b = Math.min(bx + 0.22, row.b - 0.02);
    if (b - a > 0.05) {
      brick.push(rect(a, row.y + 0.02, b - a, 0.18, 'r'));
      brick.push(rect(a, row.y + 0.15, b - a, 0.05, 'R'));
      brick.push(rect(a, row.y + 0.02, b - a, 0.03, 'l'));
    }
  }
});
const wheat = [];
[0.22, 0.5, 0.78].forEach((x) => {
  wheat.push(rect(x - 0.03, 0.45, 0.06, 0.55, 'Y'));
  for (let i = 0; i < 5; i++) {
    const y = 0.08 + i * 0.08;
    wheat.push(circ(x - 0.06, y + 0.04, 0.06, 'y'), circ(x + 0.06, y, 0.06, 'y'), circ(x + 0.07, y + 0.02, 0.03, 'Y'));
  }
  wheat.push(circ(x, 0.05, 0.05, 'y'));
});

// 資源・建物・盗賊の図形
export const SHAPES = {
  wood: [
    rect(0.42, 0.7, 0.16, 0.3, 't'), rect(0.5, 0.7, 0.08, 0.3, 'T'),
    poly([[0.5, 0.2], [0.98, 0.76], [0.02, 0.76]], 'g'), poly([[0.5, 0.2], [0.98, 0.76], [0.5, 0.76]], 'G'),
    poly([[0.5, 0], [0.84, 0.42], [0.16, 0.42]], 'g'), poly([[0.5, 0], [0.84, 0.42], [0.5, 0.42]], 'G'),
    circ(0.32, 0.6, 0.05, 'h'), circ(0.4, 0.3, 0.04, 'h'), circ(0.22, 0.68, 0.03, 'h'), circ(0.62, 0.62, 0.03, 'h'),
  ],
  brick,
  sheep: [
    rect(0.24, 0.66, 0.08, 0.3, 'k'), rect(0.44, 0.66, 0.08, 0.3, 'k'), rect(0.62, 0.66, 0.08, 0.3, 'k'),
    circ(0.34, 0.56, 0.2, 'n'), circ(0.56, 0.58, 0.2, 'n'),
    circ(0.3, 0.46, 0.19, 'w'), circ(0.5, 0.38, 0.2, 'w'), circ(0.66, 0.48, 0.18, 'w'), circ(0.44, 0.52, 0.2, 'w'),
    circ(0.4, 0.36, 0.03, 'n'), circ(0.58, 0.44, 0.03, 'n'), circ(0.3, 0.5, 0.03, 'n'), circ(0.5, 0.56, 0.03, 'n'),
    circ(0.84, 0.42, 0.13, 'k'), poly([[0.72, 0.28], [0.8, 0.34], [0.7, 0.4]], 'k'), circ(0.88, 0.38, 0.025, 'w'),
  ],
  wheat,
  peak: [
    poly([[0.24, 0.3], [0.52, 0.84], [0, 0.84]], 'S'),
    poly([[0.52, 0.06], [1, 0.84], [0.06, 0.84]], 's'), poly([[0.52, 0.06], [1, 0.84], [0.6, 0.84]], 'S'),
    poly([[0.52, 0.06], [0.66, 0.3], [0.58, 0.26], [0.52, 0.33], [0.45, 0.25], [0.38, 0.3]], 'b'),
    circ(0.34, 0.66, 0.03, 'b'), circ(0.74, 0.6, 0.025, 's'),
  ],
  cactus: [
    rect(0.42, 0.14, 0.16, 0.84, 'c'), circ(0.5, 0.14, 0.08, 'c'), rect(0.52, 0.14, 0.06, 0.84, 'd'),
    rect(0.16, 0.42, 0.3, 0.1, 'c'), rect(0.16, 0.24, 0.1, 0.26, 'c'), circ(0.21, 0.24, 0.05, 'c'),
    rect(0.54, 0.52, 0.3, 0.1, 'c'), rect(0.74, 0.32, 0.1, 0.28, 'c'), circ(0.79, 0.32, 0.05, 'c'),
  ],
  robber: [
    poly([[0.5, 0.2], [0.92, 1], [0.08, 1]], 'K'), circ(0.5, 0.28, 0.22, 'K'),
    rect(0.36, 0.26, 0.1, 0.07, 'e'), rect(0.54, 0.26, 0.1, 0.07, 'e'),
  ],
  settle: [
    poly([[0.5, 0], [1, 0.5], [0, 0.5]], 'c'), rect(0.08, 0.5, 0.84, 0.5, 'C'),
    rect(0.4, 0.66, 0.2, 0.34, 'k'), rect(0.16, 0.6, 0.14, 0.14, 'y'),
  ],
  city: [
    rect(0, 0.08, 0.28, 0.92, 'C'), poly([[0.14, 0], [0.3, 0.14], [-0.02, 0.14]], 'c'), rect(0.08, 0.3, 0.12, 0.14, 'y'),
    poly([[0.64, 0.12], [1, 0.5], [0.28, 0.5]], 'c'), rect(0.28, 0.5, 0.72, 0.5, 'C'),
    rect(0.56, 0.66, 0.14, 0.34, 'k'), rect(0.36, 0.6, 0.12, 0.14, 'y'), rect(0.8, 0.6, 0.12, 0.14, 'y'),
  ],
};
SHAPES.ore = SHAPES.peak; // 手札の「鉄」アイコンは山の図形をそのまま使う

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

// 図形 → nx x ny マスの色の表（'.' の代わりに null）。outline を渡すと、ふちの1マスをその色にする。
function inPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function hitShape(s, u, v) {
  if (s.t === 'r') return u >= s.x && u < s.x + s.w && v >= s.y && v < s.y + s.h;
  if (s.t === 'c') return (u - s.x) ** 2 + (v - s.y) ** 2 <= s.r * s.r;
  return inPoly(s.p, u, v);
}
export function raster(shapes, nx, ny, outline) {
  const g = [];
  for (let j = 0; j < ny; j++) {
    const row = [];
    for (let i = 0; i < nx; i++) {
      const u = (i + 0.5) / nx, v = (j + 0.5) / ny;
      let col = null;
      for (const s of shapes) if (hitShape(s, u, v)) col = s.c;
      row.push(col);
    }
    g.push(row);
  }
  if (!outline) return g;
  return g.map((row, j) => row.map((col, i) => {
    if (!col) return col;
    const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !(g[j + dy] && g[j + dy][i + dx]));
    return edge ? outline : col;
  }));
}

// スプライトのラスタ結果はキャッシュする（図形は変わらないので毎回描き直さなくてよい）
const sprCache = {};
export function spr(name, nx, ny, outline) {
  const key = `${name}:${nx}x${ny}:${outline || ''}`;
  if (!sprCache[key]) sprCache[key] = raster(SHAPES[name] || SHAPES.wood, nx * RES, ny * RES, outline);
  return sprCache[key];
}

// 色の表（2次元配列、null は透明） → 矩形のリスト（同じ色が横に並ぶ分はまとめて1個にする）
export function blitRects(grid, x0, y0, cell, pal, out) {
  grid.forEach((row, j) => {
    for (let i = 0; i < row.length;) {
      const ch = row[i];
      let n = 1;
      while (row[i + n] === ch) n++;
      if (ch) out.push({ x: x0 + i * cell, y: y0 + j * cell, w: n * cell, h: cell, f: pal[ch] });
      i += n;
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

// サイコロの目（10x10、枠つき）。文字グリッドのまま（今まで通りの細かさでよい）
function dieRows(v) {
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
// 文字グリッド → 矩形のリスト（サイコロ専用。同じ色が横に並ぶ分はまとめる）
function stampRects(rows, x0, y0, s, pal, out) {
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

// 建物の色は、資材のパレットに c（濃い色）・C（陰）を足して差し込む
export function paletteFor(color) { return Object.assign({}, PAL, { c: color, C: shade(color) }); }

// 資源・カード・サイコロなどの独立したドットアイコンを、指定の色数で 1 枚の <svg> に描く
// cell は「1マスあたりの大きさ」（今までと同じ意味）。中身は RES 倍細かいドットで塗る。
export function iconSvg(kind, cell, color) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  const rects = [];
  let w, h;
  if (kind.startsWith('die')) {
    const rows = dieRows(Number(kind.slice(3)));
    stampRects(rows, 0, 0, cell, PAL, rects);
    w = rows[0].length * cell; h = rows.length * cell;
  } else {
    const pal = color ? paletteFor(color) : PAL;
    blitRects(spr(kind, 8, 8, null), 0, 0, cell / RES, pal, rects);
    w = 8 * cell; h = 8 * cell;
  }
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
