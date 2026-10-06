#!/bin/bash
# 環境の確認だけ（入れない）。usage: bash jobs/setup.sh
# Node は ~/node-v22.11.0-linux-x64 か ~/opt/node（carcassonne・deck-builder と共用）、PyTorch は pip --user で入れたもの。
export PATH=$HOME/node-v22.11.0-linux-x64/bin:$HOME/opt/node/bin:$PATH
ok=1
node -v || { echo "node がない: README_hakusan.md の 1"; ok=0; }
python3 -c "import torch,numpy;print('torch',torch.__version__,'numpy',numpy.__version__)" || {
  echo "PyTorch がない: pip install --user --break-system-packages torch --index-url https://download.pytorch.org/whl/cpu"; ok=0; }
nproc
[ $ok = 1 ] && echo OK
