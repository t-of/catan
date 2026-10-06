#!/bin/bash
# HAKUSAN に持っていくものだけを hakusan-catan.tar.gz にまとめる
cd "$(dirname "$0")/.." && COPYFILE_DISABLE=1 tar --no-xattrs -czf hakusan-catan.tar.gz --exclude=ai/runs --exclude=ai/.venv --exclude=__pycache__ --exclude=ai/test.mjs --exclude=.DS_Store engine.js cpu.js package.json ai jobs README_hakusan.md && ls -lh hakusan-catan.tar.gz
