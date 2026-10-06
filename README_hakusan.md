# カタンの AI を HAKUSAN で学習する

計算は HAKUSAN（Slurm）で回す。手元の Mac では回さない。ジョブは 64 コア（`-p DEF -n 64`）。設計は [docs/ai-design.md](docs/ai-design.md)、ai/ の中身は [ai/README.md](ai/README.md)。
Node と PyTorch は carcassonne・deck-builder と共用（入れ方は下の 1）。`<…>` は自分の値に置き換える。

## 0. 手元で固める

```sh
cd ~/GitHub/tof/apps/catan
npm test
python3 ai/py/parity.py     # JS と PyTorch の順伝播の一致（「一致」と出る）
npm run pack:hakusan        # hakusan-catan.tar.gz ができる
```

## 1. 環境（初回だけ。すでにあれば何もしない）

hakusan1 で:

```sh
bash ~/catan/jobs/setup.sh    # 2 で展開したあとに。node と torch が出れば OK
```

無いときだけ:
- Node: carcassonne の README_hakusan.md の 1（`~/node-v22.11.0-linux-x64`）。ジョブは `~/node-v22.11.0-linux-x64/bin` と `~/opt/node/bin` のどちらも PATH に足す。
- PyTorch（CPU 版。venv は使わない）: `pip install --user --break-system-packages torch --index-url https://download.pytorch.org/whl/cpu`（numpy が無ければ `pip install --user --break-system-packages numpy`）。外に出られなければ Mac で wheel を落として scp。

## 2. 送って展開する

Mac で:

```sh
scp ~/GitHub/tof/apps/catan/hakusan-catan.tar.gz hakusan1:~/
```

hakusan1 で:

```sh
mkdir -p ~/catan && cd ~/catan
tar xzf ~/hakusan-catan.tar.gz
bash jobs/setup.sh
```

コードを直して送り直しても `runs/` と `logs/` は消えない（tar に入っていない）。

## 3. お試し（数分。環境・1 局の時間・1 世代が回るか）

```sh
cd ~/catan
sbatch jobs/job_ai_bench.sh
squeue -u $USER
tail -f logs/catanbench-*.out       # 止めるのは Ctrl+C
```

終わったら `logs/catanbench-<番号>.out` の「==== 結果」から下を貼る（1 局の時間・世代の記録・データの大きさ）。見込みは 5 分前後。

## 4. 本番（100 万局ぶん）

```sh
cd ~/catan
sbatch -t 12:00:00 jobs/job_ai.sh run1 125                  # 模倣で始める。1 世代 8000 局 × 125 世代 ≒ 100 万局
sbatch -t 12:00:00 jobs/job_ai.sh zero1 125 --init zero     # ゼロから（比べる用）
squeue -u $USER
tail -f logs/catan-*.out
cat runs/run1/log.jsonl | tail -3                           # 世代ごとの記録（勝率は eval に入っている）
```

- 枠 `-t` は `sinfo` で DEF の TIMELIMIT を見て、それ以下にする。学習は「`MAXMIN`（既定 660 分）に次の世代が収まらなそうなら世代の前で止まる」ので、枠を変えるときは `MAXMIN=<分> sbatch ...` で枠より 40 分ほど短くする。
- 世代ごとに `runs/run1/gen-NNNN.bin`（重み）と `log.jsonl` に書くので、止まったら（または時間切れの後）**同じコマンドを打てば続きから**進む。世代数 125 に着くまで繰り返す。
- 1 世代 8000 局の見込みは 64 コアで 5〜8 分（自己対局 3〜5 分 + PPO 2 分 + 評価 1 分）。125 世代で 11〜16 時間 ＝ 12 時間枠で 1〜2 回の投入。お試しの数字で直す。
- 局数・設定を変えるなら末尾に足す（`--games`、`--epochs`、`--keep` など。`python3 ai/py/loop.py -h`）。`GAMES=4000 sbatch ...` でも 1 世代の局数を変えられる。

## 5. 持ち帰る

hakusan1 で（重みと記録だけ。データは世代ごとに消える）:

```sh
cd ~/catan && tar czf catan-run1.tgz runs/run1/log.jsonl runs/run1/gen-*.bin
```

Mac で:

```sh
scp hakusan1:~/catan/catan-run1.tgz ~/GitHub/tof/apps/catan/ && cd ~/GitHub/tof/apps/catan && tar xzf catan-run1.tgz
node ai/selfplay.mjs 200 net:runs/run1/gen-0125.bin,strong,strong,strong 1     # 手元で強さを見る（先頭が AI の勝ち）
```

`runs/` は git に入らない。
