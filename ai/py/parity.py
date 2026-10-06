"""JS（ai/net.js）と PyTorch の順伝播が一致するか。使い方: python3 ai/py/parity.py（リポジトリのどこからでも）。差が 1e-4 を超えたら落ちる。"""
import json, os, subprocess, sys, tempfile
import numpy as np
import torch
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import catanai as C

with tempfile.TemporaryDirectory() as d:
    jp, wp, wp2 = f'{d}/s.json', f'{d}/w.bin', f'{d}/w2.bin'
    subprocess.check_call(['node', 'ai/dump-parity.mjs', jp, wp, '40'], cwd=C.ROOT)
    S = json.load(open(jp))
    net = C.load_weights(wp)
    C.save_weights(net, wp2)
    assert open(wp, 'rb').read() == open(wp2, 'rb').read(), 'Python が書いた重みが JS のと 1 バイトも同じでない'

t = lambda k: torch.tensor([s[k] for s in S], dtype=torch.float32)
x = {'v': t('v').reshape(-1, C.NV, C.FV), 'e': t('e').reshape(-1, C.NE, C.FE), 'h': t('h').reshape(-1, C.NH, C.FH), 'g': t('g')}
mask = t('mask') > 0
with torch.no_grad():
    logits, vlog = net(x)
    probs = torch.softmax(logits.masked_fill(~mask, -1e9), -1) * mask
    value = torch.softmax(vlog, -1)
d_l = (logits - t('logits')).abs().max().item()
d_p = (probs - t('probs')).abs().max().item()
d_v = (value - t('value')).abs().max().item()
print(f'{len(S)} 局面  logits 差 {d_l:.2e}  方策 {d_p:.2e}  価値 {d_v:.2e}')
assert max(d_l, d_p, d_v) < 1e-4, '一致しない'
print('一致')
