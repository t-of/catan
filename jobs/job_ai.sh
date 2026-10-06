#!/bin/bash
# 本番: 世代ごとに「自己対局 → PPO → 評価」を回す。止まっても同じコマンドで続きから（runs/<名前>/ に世代ごとの重みと log.jsonl）。
# usage: cd ~/catan && sbatch -t 12:00:00 jobs/job_ai.sh <名前> <世代数> [loop.py の追加の引数...]
#   例: sbatch -t 12:00:00 jobs/job_ai.sh run1 120                        模倣から始める（世代 0 が模倣）
#       sbatch -t 12:00:00 jobs/job_ai.sh zero1 120 --init zero           ゼロから
# 環境変数: TORCH_THREADS（学習のスレッド、既定 8）、GAMES（1 世代の局数、既定 8000）、MAXMIN（この分数に収まらなそうなら世代の前で止める。既定 660 = 11 時間）
# 1 世代 8000 局 × 125 世代 ≒ 100 万局。-t の枠は DEF の上限（sinfo）以下にして、MAXMIN は枠より 40 分ほど短く。
#SBATCH -J catan
#SBATCH -p DEF
#SBATCH -N 1
#SBATCH -n 64
#SBATCH -o logs/%x-%j.out
#SBATCH -e logs/%x-%j.out
name=$1; gens=${2:-120}; shift 2
cd "$SLURM_SUBMIT_DIR"
export PATH=$HOME/node-v22.11.0-linux-x64/bin:$HOME/opt/node/bin:$PATH PYTHONUNBUFFERED=1
set -eo pipefail
mkdir -p logs
NC=${SLURM_NTASKS:-$(nproc)}
export TORCH_THREADS=${TORCH_THREADS:-8}   # deck-builder の bench で 8 スレッドが 64 の 5 倍速かった
echo "$(date) start $name gens=$gens NC=$NC host=$(hostname)"
python3 ai/py/loop.py --run runs/$name --gens $gens --games ${GAMES:-8000} --keep 0.05 --procs $NC --imitate-games 3000 --imitate-epochs 4 \
  --eval-games 200 --max-minutes ${MAXMIN:-660} "$@"
echo "$(date) end $name"; tail -2 runs/$name/log.jsonl | cut -c1-400
