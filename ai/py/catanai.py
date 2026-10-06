"""PyTorch 版のネット（ai/net.js と同じ計算。仕様は ai/README.md）・TOFN 重みの読み書き・gen.mjs のデータの読み込み。"""
import json, os, struct, subprocess
import numpy as np
import torch
import torch.nn as nn

AI = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(AI)
NV, NE, NH = 54, 72, 19
FV, FE, FH, FG = 22, 6, 9, 63
NF = NV * FV + NE * FE + NH * FH + FG  # 1854
ACT = 266
TYPES = ('v', 'e', 'h')
COUNT = {'v': NV, 'e': NE, 'h': NH}
FEAT = {'v': FV, 'e': FE, 'h': FH}
NBR = {'v': ('e', 'h'), 'e': ('v', 'h'), 'h': ('v', 'e')}
DEFAULT_CONFIG = {'D': 48, 'rounds': 3, 'H': 48}
GLOBAL_OUT = 48


def topo():
    """盤のつながり TOPO を features.js から取る（node が要る）"""
    out = subprocess.check_output(['node', '-e', "import('./ai/features.js').then(m=>console.log(JSON.stringify(m.TOPO)))"], cwd=ROOT)
    return json.loads(out)


def tensor_specs(cfg):
    D, rounds, H = cfg['D'], cfg['rounds'], cfg['H']
    s = [('gemb.w', [D, FG]), ('gemb.b', [D])]
    for t in TYPES:
        s += [(f'embed.{t}.w', [D, FEAT[t]]), (f'embed.{t}.b', [D]), (f'embed.{t}.g', [D, D])]
    for r in range(rounds):
        for t in TYPES:
            s += [(f'mp{r}.{t}.w', [D, 3 * D]), (f'mp{r}.{t}.b', [D])]
    s += [('pol.v.w', [2, D]), ('pol.v.b', [2]), ('pol.e.w', [1, D]), ('pol.e.b', [1]), ('pol.h.w', [2, D]), ('pol.h.b', [2]),
          ('pol.g1.w', [H, 4 * D]), ('pol.g1.b', [H]), ('pol.g2.w', [GLOBAL_OUT, H]), ('pol.g2.b', [GLOBAL_OUT]),
          ('val.1.w', [H, 4 * D]), ('val.1.b', [H]), ('val.2.w', [4, H]), ('val.2.b', [4])]
    return s


class Net(nn.Module):
    def __init__(self, cfg=None, seed=None):
        super().__init__()
        self.cfg = dict(cfg or DEFAULT_CONFIG)
        self.specs = tensor_specs(self.cfg)
        self.P = nn.ParameterDict({n.replace('.', '_'): nn.Parameter(torch.zeros(*sh)) for n, sh in self.specs})
        g = torch.Generator().manual_seed(0 if seed is None else seed)
        with torch.no_grad():  # net.js の initWeights と同じ規則（乱数の並びは別）
            for n, sh in self.specs:
                if n.endswith('.w') or n.endswith('.g'):
                    scale = 0.5 if n.startswith('mp') else 0.1 if n.startswith(('pol.v', 'pol.e', 'pol.h', 'pol.g2', 'val.2')) else 1.0
                    self.w(n).copy_(torch.randn(*sh, generator=g) * scale * (2 / sh[1]) ** 0.5)
        tp = topo()
        for k in ('ve', 'vh', 'ev', 'eh', 'hv', 'he'):
            lists = tp[k]
            m = torch.zeros(len(lists), COUNT[k[1]])
            for i, nb in enumerate(lists):
                for j in nb:
                    m[i, j] += 1
                if nb:
                    m[i] /= len(nb)
            self.register_buffer('A_' + k, m, persistent=False)

    def w(self, n):
        return self.P[n.replace('.', '_')]

    def lin(self, x, n):
        return x @ self.w(n + '.w').T + self.w(n + '.b')

    def forward(self, x):
        """x = {'v': [B,54,22], 'e': [B,72,6], 'h': [B,19,9], 'g': [B,63]} → (全行動の logit [B,266]（合法マスク前）, 価値の logit [B,4])"""
        D, rounds = self.cfg['D'], self.cfg['rounds']
        gemb = torch.relu(self.lin(x['g'], 'gemb'))
        hs = {}
        for t in TYPES:
            inj = gemb @ self.w(f'embed.{t}.g').T
            hs[t] = torch.relu(self.lin(x[t], f'embed.{t}') + inj[:, None, :])
        for r in range(rounds):
            new = {}
            for t in TYPES:
                s1, s2 = NBR[t]
                a1 = getattr(self, 'A_' + t + s1) @ hs[s1]
                a2 = getattr(self, 'A_' + t + s2) @ hs[s2]
                new[t] = torch.relu(self.lin(torch.cat([hs[t], a1, a2], -1), f'mp{r}.{t}'))
            hs = {t: hs[t] + new[t] for t in TYPES}
        ctx = torch.cat([hs['v'].mean(1), hs['e'].mean(1), hs['h'].mean(1), gemb], -1)
        pv, ph = self.lin(hs['v'], 'pol.v'), self.lin(hs['h'], 'pol.h')
        pe = self.lin(hs['e'], 'pol.e')[..., 0]
        pg = self.lin(torch.relu(self.lin(ctx, 'pol.g1')), 'pol.g2')
        logits = torch.cat([pe, pv[..., 0], pv[..., 1], pg[:, :1], ph[..., 0], ph[..., 1], pg[:, 1:]], -1)
        vlog = self.lin(torch.relu(self.lin(ctx, 'val.1')), 'val.2')
        return logits, vlog


def split(flat):
    """[B,1854] → forward に渡す辞書（gen.mjs の v|e|h|g の並び）"""
    B = flat.shape[0]
    a, b, c = NV * FV, NV * FV + NE * FE, NV * FV + NE * FE + NH * FH
    return {'v': flat[:, :a].reshape(B, NV, FV), 'e': flat[:, a:b].reshape(B, NE, FE), 'h': flat[:, b:c].reshape(B, NH, FH), 'g': flat[:, c:]}


# ---- TOFN 重み（net.js の encodeWeights / decodeWeights と同じ形式）
def save_weights(net, path):
    head = json.dumps({'format': 'tofn', 'version': 1, 'config': net.cfg,
                       'tensors': [{'name': n, 'shape': sh} for n, sh in net.specs]}, separators=(',', ':'))
    head = head + ' ' * ((4 - len(head) % 4) % 4)
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(b'TOFN' + struct.pack('<I', len(head)) + head.encode('ascii'))
        for n, _ in net.specs:
            f.write(net.w(n).detach().cpu().numpy().astype('<f4').tobytes())
    os.replace(tmp, path)


def load_weights(path):
    raw = open(path, 'rb').read()
    if raw[:4] != b'TOFN':
        raise ValueError('重みのファイルではない')
    hl = struct.unpack('<I', raw[4:8])[0]
    head = json.loads(raw[8:8 + hl])
    net = Net(head['config'])
    if [(t['name'], t['shape']) for t in head['tensors']] != [(n, sh) for n, sh in net.specs]:
        raise ValueError('重みの形が仕様と合わない')
    flat = np.frombuffer(raw, dtype='<f4', offset=8 + hl)
    o = 0
    with torch.no_grad():
        for n, sh in net.specs:
            k = int(np.prod(sh))
            net.w(n).copy_(torch.from_numpy(flat[o:o + k].reshape(sh).copy()))
            o += k
    if o != len(flat):
        raise ValueError('重みの長さが合わない')
    return net


# ---- gen.mjs のデータ（ai/gen.mjs の冒頭に形式）
def load_shard(path):
    with open(path, 'rb') as f:
        if f.read(4) != b'TOFD':
            raise ValueError(f'{path}: データではない')
        _, n, nf, act = struct.unpack('<4I', f.read(16))
        assert nf == NF and act == ACT, 'gen.mjs と特徴量の形が違う'
        rd = lambda dt, c: np.fromfile(f, dtype=dt, count=c)
        return {'x': rd('<f2', n * nf).reshape(n, nf), 'a': rd('<u2', n).astype(np.int64), 'lp': rd('<f4', n), 'vp': rd('<f4', n),
                'ret': rd('<f4', n), 'dvp': rd('<f4', n), 'win': rd('u1', n), 'mask': rd('u1', n * act).reshape(n, act).astype(bool)}


def load_shards(paths):
    parts = [load_shard(p) for p in paths]
    return {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
