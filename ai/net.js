// 小さなグラフネットの順伝播（素の JS・Float32Array・依存は features.js の盤のつながりだけ）。ブラウザと Node の両方で import できる。
// 層の並び・計算順・重みの形式は ai/README.md の「ネットと重みの仕様」。PyTorch 側（段階 3）はこの仕様どおりに書き出す。
import { SIZES, TOPO } from './features.js';

const { NV, NE, NH, FV, FE, FH, FG } = SIZES;
export const DEFAULT_CONFIG = { D: 48, rounds: 3, H: 48 }; // ノードの次元・情報の受け渡しの回数・全体ベクトルの隠れ層
const TYPES = ['v', 'e', 'h'];
const COUNT = { v: NV, e: NE, h: NH };
const FEAT = { v: FV, e: FE, h: FH };
const NBR = { v: ['e', 'h'], e: ['v', 'h'], h: ['v', 'e'] }; // 受け渡しの順（自分の次に足す相手の種類）
const GLOBAL_OUT = 48; // 全体ベクトルから出す logit: [買う, 街道建設, 収穫 15, 独占 5, 交易 20, 捨て札 5, 終了]
const ACTIONS = 266;

// 重みの名前と形。w は [出力, 入力] の行優先（PyTorch の nn.Linear.weight と同じ並び）
export function tensorSpecs({ D, rounds, H }) {
  const s = [['gemb.w', [D, FG]], ['gemb.b', [D]]];
  for (const t of TYPES) s.push([`embed.${t}.w`, [D, FEAT[t]]], [`embed.${t}.b`, [D]], [`embed.${t}.g`, [D, D]]);
  for (let r = 0; r < rounds; r++) for (const t of TYPES) s.push([`mp${r}.${t}.w`, [D, 3 * D]], [`mp${r}.${t}.b`, [D]]);
  s.push(['pol.v.w', [2, D]], ['pol.v.b', [2]], ['pol.e.w', [1, D]], ['pol.e.b', [1]], ['pol.h.w', [2, D]], ['pol.h.b', [2]]);
  s.push(['pol.g1.w', [H, 4 * D]], ['pol.g1.b', [H]], ['pol.g2.w', [GLOBAL_OUT, H]], ['pol.g2.b', [GLOBAL_OUT]]);
  s.push(['val.1.w', [H, 4 * D]], ['val.1.b', [H]], ['val.2.w', [SEATS_OUT, H]], ['val.2.b', [SEATS_OUT]]);
  return s;
}
const SEATS_OUT = 4;
const size = (shape) => shape.reduce((a, b) => a * b, 1);
export const paramCount = (config = DEFAULT_CONFIG) => tensorSpecs(config).reduce((a, [, sh]) => a + size(sh), 0);

// 乱数の重み。relu の層は √(2/入力)、情報の受け渡しは残差の枝なので小さめ、出力の層は小さく（最初はほぼ一様な方策）。rng は 0〜1 の乱数関数
export function initWeights(rng = Math.random, config = DEFAULT_CONFIG) {
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
  const tensors = {};
  for (const [name, shape] of tensorSpecs(config)) {
    const a = new Float32Array(size(shape));
    if (name.endsWith('.w') || name.endsWith('.g')) {
      const scale = name.startsWith('mp') ? 0.5 : /^(pol\.[veh]|pol\.g2|val\.2)/.test(name) ? 0.1 : 1;
      const sd = scale * Math.sqrt(2 / shape[1]);
      for (let i = 0; i < a.length; i++) a[i] = gauss() * sd;
    }
    tensors[name] = a;
  }
  return { config: { ...config }, tensors };
}

// ファイル形式: "TOFN"(4 バイト) | ヘッダの長さ uint32 LE | JSON ヘッダ（UTF-8、4 の倍数に空白で埋める） | Float32 LE の重みを仕様の順に並べたもの
export function encodeWeights({ config, tensors }) {
  const specs = tensorSpecs(config);
  const head = JSON.stringify({ format: 'tofn', version: 1, config, tensors: specs.map(([name, shape]) => ({ name, shape })) });
  const hb = new TextEncoder().encode(head + ' '.repeat((4 - (head.length % 4)) % 4)); // ヘッダは ASCII だけなので文字数 = バイト数
  const n = specs.reduce((a, [, sh]) => a + size(sh), 0);
  const buf = new ArrayBuffer(8 + hb.length + n * 4);
  new Uint8Array(buf, 0, 4).set([84, 79, 70, 78]);
  new DataView(buf).setUint32(4, hb.length, true);
  new Uint8Array(buf, 8, hb.length).set(hb);
  const out = new Float32Array(buf, 8 + hb.length, n); // 8 + 4 の倍数なので 4 バイト境界に合う
  let o = 0;
  for (const [name] of specs) { out.set(tensors[name], o); o += tensors[name].length; }
  return buf;
}
export function decodeWeights(buf) {
  const u8 = new Uint8Array(buf);
  if (String.fromCharCode(...u8.subarray(0, 4)) !== 'TOFN') throw new Error('重みのファイルではない');
  const hl = new DataView(buf).getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hl)));
  if (head.version !== 1) throw new Error(`重みの版が違う ${head.version}`);
  const specs = tensorSpecs(head.config);
  if (specs.length !== head.tensors.length || specs.some(([n, sh], i) => n !== head.tensors[i].name || size(sh) !== size(head.tensors[i].shape))) throw new Error('重みの形が仕様と合わない');
  const all = new Float32Array(buf.slice(8 + hl)); // 切り出して境界をそろえる
  const tensors = {};
  let o = 0;
  for (const [name, shape] of specs) { tensors[name] = all.subarray(o, o + size(shape)); o += size(shape); }
  return { config: head.config, tensors };
}

// out[i][o] += Σk x[i][k] · W[o][wOff+k]（W は行優先 [出力, 入力全体]。inN は W の 1 行の長さ）。出力 4 つずつまとめて足す（速い）
function mm(out, x, n, kIn, W, inN, wOff, nOut) {
  for (let i = 0; i < n; i++) {
    const xi = i * kIn, oi = i * nOut;
    let o = 0;
    for (; o + 3 < nOut; o += 4) {
      const w0 = o * inN + wOff, w1 = w0 + inN, w2 = w1 + inN, w3 = w2 + inN;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let k = 0; k < kIn; k++) {
        const xv = x[xi + k];
        s0 += xv * W[w0 + k]; s1 += xv * W[w1 + k]; s2 += xv * W[w2 + k]; s3 += xv * W[w3 + k];
      }
      out[oi + o] += s0; out[oi + o + 1] += s1; out[oi + o + 2] += s2; out[oi + o + 3] += s3;
    }
    for (; o < nOut; o++) {
      const wi = o * inN + wOff;
      let sum = 0;
      for (let k = 0; k < kIn; k++) sum += x[xi + k] * W[wi + k];
      out[oi + o] += sum;
    }
  }
}
function fillBias(out, n, b) { for (let i = 0; i < n; i++) out.set(b, i * b.length); }
function relu(a) { for (let i = 0; i < a.length; i++) if (a[i] < 0) a[i] = 0; }
// 先ノードごとに、つながる元ノードの平均（つながりがなければ 0）
function meanAgg(out, src, adj, D) {
  for (let i = 0; i < adj.length; i++) {
    const nb = adj[i], oi = i * D;
    for (let o = 0; o < D; o++) out[oi + o] = 0;
    for (let j = 0; j < nb.length; j++) { const si = nb[j] * D; for (let o = 0; o < D; o++) out[oi + o] += src[si + o]; }
    if (nb.length > 1) for (let o = 0; o < D; o++) out[oi + o] /= nb.length;
  }
}

// ネット。forward(feat, mask) → { logits(266), probs(266。合法手だけ softmax)、value(4。席の相対順で勝つ確率) }。返す配列は次の呼び出しで上書きされる
export function createNet({ config, tensors: T }) {
  const { D, rounds, H } = config;
  const hs = {}, nx = {}, agg = {};
  for (const t of TYPES) { hs[t] = new Float32Array(COUNT[t] * D); nx[t] = new Float32Array(COUNT[t] * D); }
  for (const t of TYPES) for (const s of NBR[t]) agg[t + s] = new Float32Array(COUNT[t] * D);
  const gemb = new Float32Array(D), inj = new Float32Array(D), ctx = new Float32Array(4 * D);
  const hid = new Float32Array(H), pg = new Float32Array(GLOBAL_OUT), vh = new Float32Array(H), val = new Float32Array(SEATS_OUT);
  const logits = new Float32Array(ACTIONS), probs = new Float32Array(ACTIONS), tmp = new Float32Array(2 * NV);
  const adj = { ve: TOPO.ve, vh: TOPO.vh, ev: TOPO.ev, eh: TOPO.eh, hv: TOPO.hv, he: TOPO.he };

  function forward(feat, mask) {
    // 1. 全体ベクトル gemb = relu(g · gemb.w + gemb.b)
    gemb.set(T['gemb.b']); mm(gemb, feat.g, 1, FG, T['gemb.w'], FG, 0, D); relu(gemb);
    // 2. ノードの埋め込み h_t = relu(x_t · embed.t.w + embed.t.b + gemb · embed.t.g)（最後の項は全ノードに同じものを足す）
    for (const t of TYPES) {
      inj.fill(0); mm(inj, gemb, 1, D, T[`embed.${t}.g`], D, 0, D);
      const bias = new Float32Array(D); for (let o = 0; o < D; o++) bias[o] = T[`embed.${t}.b`][o] + inj[o];
      fillBias(hs[t], COUNT[t], bias);
      mm(hs[t], feat[t], COUNT[t], FEAT[t], T[`embed.${t}.w`], FEAT[t], 0, D); relu(hs[t]);
    }
    // 3. 情報の受け渡し（rounds 回。3 種類が前の回の値を読んで同時に更新）: h_t ← h_t + relu([h_t | 平均(相手1) | 平均(相手2)] · mp.w + mp.b)
    for (let r = 0; r < rounds; r++) {
      for (const t of TYPES) {
        const [s1, s2] = NBR[t];
        meanAgg(agg[t + s1], hs[s1], adj[t + s1], D); meanAgg(agg[t + s2], hs[s2], adj[t + s2], D);
        const W = T[`mp${r}.${t}.w`], n = COUNT[t];
        fillBias(nx[t], n, T[`mp${r}.${t}.b`]);
        mm(nx[t], hs[t], n, D, W, 3 * D, 0, D); mm(nx[t], agg[t + s1], n, D, W, 3 * D, D, D); mm(nx[t], agg[t + s2], n, D, W, 3 * D, 2 * D, D);
        relu(nx[t]);
      }
      for (const t of TYPES) { const a = hs[t], b = nx[t]; for (let i = 0; i < a.length; i++) a[i] += b[i]; }
    }
    // 4. 文脈 ctx = [頂点の平均 | 辺の平均 | マスの平均 | gemb]
    ctx.fill(0);
    TYPES.forEach((t, ti) => {
      const a = hs[t], n = COUNT[t];
      for (let i = 0; i < n; i++) for (let o = 0; o < D; o++) ctx[ti * D + o] += a[i * D + o];
      for (let o = 0; o < D; o++) ctx[ti * D + o] /= n;
    });
    ctx.set(gemb, 3 * D);
    // 5. 方策の logit: 頂点 → [開拓地 72.., 都市 126..]、辺 → 道 0..、マス → [騎士 181.., 盗賊 200..]、全体 → 買う 180・219..265
    fillBias(tmp, NV, T['pol.v.b']); mm(tmp, hs.v, NV, D, T['pol.v.w'], D, 0, 2);
    for (let i = 0; i < NV; i++) { logits[72 + i] = tmp[i * 2]; logits[126 + i] = tmp[i * 2 + 1]; }
    fillBias(tmp, NE, T['pol.e.b']); mm(tmp, hs.e, NE, D, T['pol.e.w'], D, 0, 1);
    for (let i = 0; i < NE; i++) logits[i] = tmp[i];
    fillBias(tmp, NH, T['pol.h.b']); mm(tmp, hs.h, NH, D, T['pol.h.w'], D, 0, 2);
    for (let i = 0; i < NH; i++) { logits[181 + i] = tmp[i * 2]; logits[200 + i] = tmp[i * 2 + 1]; }
    hid.set(T['pol.g1.b']); mm(hid, ctx, 1, 4 * D, T['pol.g1.w'], 4 * D, 0, H); relu(hid);
    pg.set(T['pol.g2.b']); mm(pg, hid, 1, H, T['pol.g2.w'], H, 0, GLOBAL_OUT);
    logits[180] = pg[0];
    for (let i = 1; i < GLOBAL_OUT; i++) logits[218 + i] = pg[i];
    // 6. 合法マスクを掛けた softmax
    let mx = -Infinity;
    for (let i = 0; i < ACTIONS; i++) if (mask[i] && logits[i] > mx) mx = logits[i];
    let sum = 0;
    for (let i = 0; i < ACTIONS; i++) { const p = mask[i] ? Math.exp(logits[i] - mx) : 0; probs[i] = p; sum += p; }
    if (sum > 0) for (let i = 0; i < ACTIONS; i++) probs[i] /= sum;
    // 7. 価値: relu(ctx · val.1.w + val.1.b) → val.2 → 4 席の softmax
    vh.set(T['val.1.b']); mm(vh, ctx, 1, 4 * D, T['val.1.w'], 4 * D, 0, H); relu(vh);
    val.set(T['val.2.b']); mm(val, vh, 1, H, T['val.2.w'], H, 0, SEATS_OUT);
    let vm = -Infinity; for (let i = 0; i < SEATS_OUT; i++) if (val[i] > vm) vm = val[i];
    let vs = 0; for (let i = 0; i < SEATS_OUT; i++) { val[i] = Math.exp(val[i] - vm); vs += val[i]; }
    for (let i = 0; i < SEATS_OUT; i++) val[i] /= vs;
    return { logits, probs, value: val };
  }
  return { forward, config };
}
