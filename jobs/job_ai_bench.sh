#!/bin/bash
# 計測ジョブ（数分）: 環境・1 局の時間・1 世代（模倣 → 自己対局 → PPO → 評価）の時間を測る。
# usage: cd ~/catan && sbatch jobs/job_ai_bench.sh        （-p DEF -n 64 は下の #SBATCH）
# 結果は logs/catanbench-<ジョブ番号>.out の「==== 結果」から下。それをそのまま貼る。
#SBATCH -J catanbench
#SBATCH -p DEF
#SBATCH -N 1
#SBATCH -n 64
#SBATCH -o logs/%x-%j.out
#SBATCH -e logs/%x-%j.out
cd "$SLURM_SUBMIT_DIR"
export PATH=$HOME/node-v22.11.0-linux-x64/bin:$HOME/opt/node/bin:$PATH PYTHONUNBUFFERED=1
set -eo pipefail
mkdir -p logs
NC=${SLURM_NTASKS:-$(nproc)}
export TORCH_THREADS=$NC
R=runs/bench; rm -rf $R; mkdir -p $R
echo "$(date) start bench NC=$NC host=$(hostname)"
node -v; python3 -c "import torch,numpy;print('torch',torch.__version__,'numpy',numpy.__version__, 'threads', torch.get_num_threads())"
python3 ai/py/parity.py
python3 ai/py/train.py init --out $R/init.bin

# 1 局の時間: 乱数の重みで 4 席ともネット（打ち切り 320）、NC プロセスが 2 局ずつ同時に
s=$SECONDS
seq 0 $((NC-1)) | xargs -P $NC -I{} node ai/gen.mjs --weights $R/init.bin --games 2 --seed 1 --shard {} --mix 1,0,0 --max-turns 320 --keep 0.1 --out $R/rnd{}.bin > $R/rnd.log
RND=$((SECONDS - s))
s=$SECONDS
seq 0 $((NC-1)) | xargs -P $NC -I{} node ai/gen.mjs --mode imitate --games 4 --seed 1 --shard {} --out $R/imi{}.bin > $R/imi.log
IMI=$((SECONDS - s))

# 1 世代: 模倣 128 局 → 自己対局 256 局 → PPO → 評価
python3 ai/py/loop.py --run $R/loop --gens 1 --games 256 --procs $NC --init imitate --imitate-games 128 --imitate-epochs 3 --eval-games 64 --keep-data

echo "==== 結果 (NC=$NC)"
echo "-- 乱数の重み・4 席ネット・NC プロセス × 2 局: ${RND} 秒（1 局あたり ≒ ${RND}/2 秒）"
tr -d '{}"' < $R/rnd.log | tr ',' '\n' | awk -F: '{a[$1]+=$2} END{print "局",a["games"],"引き分け",a["draws"],"平均ターン",a["turns"]/a["games"],"判断",a["samples"]}'
echo "-- つよい CPU 4 席の記録・NC プロセス × 4 局: ${IMI} 秒"
echo "-- 世代の記録（log.jsonl）"
cat $R/loop/log.jsonl
echo "-- データの大きさ"
du -sh $R/loop/data-0001 $R/loop/data-0000
echo "$(date) done bench"
