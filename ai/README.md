# ai/ ... 学習する AI（段階 2 まで）

基本ルール・4 人・基本盤・銀行/港交易だけ。設計は [../docs/ai-design.md](../docs/ai-design.md)。

| ファイル | 中身 |
|---|---|
| actions.js | 行動 266 個・合法マスク・番号の手を打つ・手番ループ（段階 1） |
| features.js | 局面 → 特徴量（`viewFor` の範囲だけ）。盤のつながり `TOPO` |
| net.js | ネットの順伝播・乱数の重み・重みファイルの読み書き |
| selfplay.mjs | 自己対局。席は `random` / `net` / `net#種` / `net:重みファイル` / `weak` `normal` `strong` |
| test.mjs | `npm test` に入っている自己チェック |

## 特徴量（features.js）

`makeFeatures(game, ai, mask)` → `{ v, e, h, g }`（Float32Array、すべて 0〜1）。`mask` は `legalMask(game, ai)`。
判断する席 me = `decider(game)`。席は me を 0 にした相対順 `(席 - me + 4) % 4`。`viewFor(game, me)` の出力しか読まない。

- `v`: 頂点 54 × 22（行優先）: 0-7 建物（相対席 0..3 × [開拓地, 都市]）、8-12 接するマスの産出（木・土・羊・麦・鉄ごとに Σ確率点/5、上限 1）、13-18 港（木・土・羊・麦・鉄・3:1）、19 開拓地を置ける、20 都市にできる、21 盗賊が隣
- `e`: 辺 72 × 6: 0-3 街道（相対席）、4 道を置ける、5 港に面す
- `h`: マス 19 × 9: 0-5 資源（木・土・羊・麦・鉄・砂漠）、6 確率点/5、7 盗賊、8 盗賊/騎士の置き場として合法
- `g`: 全体 63: 手札 5（/8、街道建設の途中・捨て札の途中は捨てた分を引く）、未使用の発展カード 5（騎士・勝利点・街道建設・収穫・独占 /5）、今ターンに買った 1、自分の残り建物 3（道/15・開拓地/5・都市/4）、銀行 5（/19）、山札の残り 1（/25）、席ごと 4×5（点/10・手札枚数/20・騎士/14・最長路/15・未使用の発展カード/10）、最長路の持ち主 5・最大騎士の持ち主 5（なし, 相対席 0..3）、フェイズ 6（初期配置の開拓地・初期配置の道・ダイス前・手番・捨て札・盗賊）、今ターンに発展カードを使った 1、ターン/100、出目の和/12、出目が 7、街道建設の途中 1・置いた本数/2、捨てる残り枚数/10
- 盤のつながり `TOPO`（頂点→辺 `ve`・頂点→マス `vh`・辺→頂点 `ev`・辺→マス `eh`・マス→頂点 `hv`・マス→辺 `he`、それぞれ「先のノード番号 → つながる元ノード番号の列」）。基本盤は毎局同じ形。PyTorch 側へは `node -e "import('./ai/features.js').then(m=>console.log(JSON.stringify(m.TOPO)))"` で渡す

## ネットと重みの仕様（net.js ⇔ 段階 3 の PyTorch）

config = `{ D: 48, rounds: 3, H: 48 }`（D: ノードの次元、rounds: 情報の受け渡しの回数、H: 全体側の隠れ層）。LayerNorm・Dropout・BatchNorm はない。すべて Linear + ReLU + 平均 + 残差。
`Linear(x; w, b)` は `x · wᵀ + b`。w は **[出力, 入力] の行優先（nn.Linear.weight と同じ並び）**。ReLU は max(0, x)。T ∈ {v, e, h}。

1. `gemb = relu(Linear(g; gemb.w, gemb.b))`  … D
2. 各ノード（種類 T）: `hT = relu(Linear(xT; embed.T.w, embed.T.b) + gemb · (embed.T.g)ᵀ)`  （`embed.T.g` は bias なしの D×D。最後の項は全ノード共通）
3. 情報の受け渡しを rounds 回（r = 0..）。3 種類が **前の回の値**を読んで同時に更新: 相手の種類の並びは v:(e, h) / e:(v, h) / h:(v, e)。
   `aggT_S[i]` = ノード i につながる S 種ノードの `hS` の**平均**（TOPO。つながりが 0 個なら 0 ベクトル。基本盤では 0 個はない）。
   `hT ← hT + relu(Linear(concat[hT, aggT_S1, aggT_S2]; mp{r}.T.w, mp{r}.T.b))`（w は D × 3D）
4. `ctx = concat[mean_i hv, mean_i he, mean_i hh, gemb]`（4D）
5. 方策 logit（266）:
   - `pol.v`（Linear D→2、頂点ごと）→ [開拓地 → 72+頂点, 都市 → 126+頂点]
   - `pol.e`（D→1、辺ごと）→ 道 → 0+辺
   - `pol.h`（D→2、マスごと）→ [騎士 → 181+マス, 盗賊 → 200+マス]
   - `pol.g2(relu(pol.g1(ctx)))`（4D→H→48）→ 出力 0 が 180（買う）、出力 1..47 が 219..265（街道建設・収穫 15・独占 5・交易 20・捨て札 5・終了）
   - 合法マスクを掛けて softmax: 不合法の確率は 0（logit の最大は合法手の中で引く）。`logits` は不合法も含めた生の値
6. 価値（4 席・相対順 = 判断する席が 0）: `softmax(val.2(relu(val.1(ctx))))`（4D→H→4）

重みの名前と順（ファイルの並び。形は [出力, 入力]、b は [出力]）:
`gemb.w gemb.b` → T ごとに `embed.T.w embed.T.b embed.T.g`（T = v, e, h の順）→ r ごと・T ごとに `mp{r}.T.w mp{r}.T.b` → `pol.v.w pol.v.b pol.e.w pol.e.b pol.h.w pol.h.b pol.g1.w pol.g1.b pol.g2.w pol.g2.b val.1.w val.1.b val.2.w val.2.b`。
入力の次元: v 22・e 6・h 9・g 63。パラメータ数は `paramCount(config)`（既定で 95,865 個）。

初期化（`initWeights`）: w は N(0, (係数·√(2/入力))²)、b は 0。係数は mp が 0.5、出力の層（pol.v/e/h・pol.g2・val.2）が 0.1、ほかは 1。

### 重みファイル（.bin）

`"TOFN"`（4 バイト）| ヘッダ長 uint32 LE | JSON ヘッダ（`{ format, version: 1, config, tensors: [{ name, shape }...] }`、ASCII、4 の倍数に空白で埋める）| 重み Float32 LE を上の順に並べたもの。
`encodeWeights({ config, tensors })` / `decodeWeights(arrayBuffer)`（`tensors[name]` は Float32Array）。PyTorch 側は同じヘッダを書いて `state_dict` を同じ順に平らにして書けばよい。形が仕様と違えば読み込みで throw する。95,865 個 = 約 385KB（float32）。
ブラウザへ入れるときの float16 化（設計メモ 6）は段階 5 で別に決める。

### 段階 3 の一致テスト

同じ `feat`（`{v, e, h, g}`）と `mask` を JS（`createNet(...).forward(feat, mask)`）と PyTorch の両方に通し、`logits`・`value` の差が 1e-4 以下であること。入力は `makeFeatures` で作った局面をいくつか JSON に書き出して使う。
