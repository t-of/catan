"""学習。imitate（つよい CPU の手を真似る）と ppo（自己対局のデータで 1 世代ぶん更新）。
使い方:
  python3 ai/py/train.py init  --out w.bin [--seed 1]                         ゼロの重みを書く
  python3 ai/py/train.py imitate --data a.bin b.bin --out w.bin [--weights w0.bin] [--epochs 6]
  python3 ai/py/train.py ppo --weights w0.bin --data a.bin b.bin --out w1.bin [--shape 0.3] [--epochs 3]
"""
import argparse, math, os, sys, time
import numpy as np
import torch
import torch.nn.functional as F
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import catanai as C

NEG = -1e9


def value_target(win):
    """勝者の相対席の one-hot。引き分け（255）は 4 席で一様"""
    t = torch.full((len(win), 4), 0.25)
    w = torch.as_tensor(win.astype(np.int64))
    k = w < 4
    t[k] = F.one_hot(w[k], 4).float()
    return t


def batch(d, idx):
    return C.split(torch.from_numpy(d['x'][idx]).float()), torch.from_numpy(d['mask'][idx])


def masked_logp(logits, mask):
    return F.log_softmax(logits.masked_fill(~mask, NEG), -1)


def threads():
    n = int(os.environ.get('TORCH_THREADS', min(64, os.cpu_count() or 1)))
    torch.set_num_threads(n)


def imitate(net, d, epochs=6, mb=256, lr=1e-3, vcoef=0.5, log=print):
    """教師あり: つよい CPU の手の交差エントロピー ＋ 結果（勝者）の価値の交差エントロピー"""
    threads()
    opt = torch.optim.Adam(net.parameters(), lr=lr)
    N = len(d['a'])
    vt = value_target(d['win'])
    act = torch.from_numpy(d['a'])
    stats = {}
    for ep in range(epochs):
        perm = np.random.permutation(N)
        tot = acc = vl = 0.0
        for i in range(0, N, mb):
            idx = np.sort(perm[i:i + mb])
            x, m = batch(d, idx)
            logits, vlog = net(x)
            lp = masked_logp(logits, m)
            a = act[idx]
            pl = -lp.gather(1, a[:, None]).mean()
            vloss = -(vt[idx] * F.log_softmax(vlog, -1)).sum(1).mean()
            loss = pl + vcoef * vloss
            opt.zero_grad(); loss.backward(); torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0); opt.step()
            n = len(idx); tot += pl.item() * n; vl += vloss.item() * n; acc += (lp.argmax(1) == a).float().sum().item()
        stats = {'policy_loss': tot / N, 'value_loss': vl / N, 'acc': acc / N}
        log(f'  imitate epoch {ep + 1}/{epochs} ' + ' '.join(f'{k}={v:.4f}' for k, v in stats.items()))
    return stats


def ppo(net, d, shape=0.3, epochs=3, mb=2048, lr=3e-4, clip=0.2, vcoef=0.5, ent=0.01, max_kl=0.05, log=print):
    """PPO（打ち切り付き）。1 局 1 つの結果を全判断に使う（GAE なし）: 報酬 = 勝ち(1/0) + shape × 点差、基準 = 価値の「自席が勝つ確率」"""
    threads()
    N = len(d['a'])
    act = torch.from_numpy(d['a'])
    vt = value_target(d['win'])
    with torch.no_grad():  # 更新前の方策と価値
        old = torch.zeros(N); v0 = torch.zeros(N)
        for i in range(0, N, 8192):
            idx = np.arange(i, min(i + 8192, N))
            x, m = batch(d, idx)
            logits, vlog = net(x)
            old[idx] = masked_logp(logits, m).gather(1, act[idx][:, None])[:, 0]
            v0[idx] = torch.softmax(vlog, -1)[:, 0]
    ret = torch.from_numpy(d['ret'] + shape * d['dvp'])
    adv = ret - v0
    adv = (adv - adv.mean()) / (adv.std() + 1e-8)
    drift = float(np.abs(old.numpy() - d['lp']).mean())  # JS が選んだときの対数確率との差（float16 の丸めなど）
    opt = torch.optim.Adam(net.parameters(), lr=lr)
    s = {}
    for ep in range(epochs):
        perm = np.random.permutation(N)
        kl_sum = pg_sum = v_sum = e_sum = clipf = 0.0
        for i in range(0, N, mb):
            idx = np.sort(perm[i:i + mb])
            x, m = batch(d, idx)
            logits, vlog = net(x)
            lp = masked_logp(logits, m)
            new = lp.gather(1, act[idx][:, None])[:, 0]
            ratio = torch.exp(new - old[idx])
            a = adv[idx]
            pg = -torch.min(ratio * a, ratio.clamp(1 - clip, 1 + clip) * a).mean()
            vloss = -(vt[idx] * F.log_softmax(vlog, -1)).sum(1).mean()
            entropy = -(lp.exp() * lp).sum(1).mean()
            loss = pg + vcoef * vloss - ent * entropy
            opt.zero_grad(); loss.backward(); torch.nn.utils.clip_grad_norm_(net.parameters(), 0.5); opt.step()
            n = len(idx)
            kl_sum += (old[idx] - new).mean().item() * n; pg_sum += pg.item() * n; v_sum += vloss.item() * n; e_sum += entropy.item() * n
            clipf += ((ratio - 1).abs() > clip).float().sum().item()
        s = {'policy_loss': pg_sum / N, 'value_loss': v_sum / N, 'entropy': e_sum / N, 'kl': kl_sum / N, 'clipfrac': clipf / N, 'logp_drift': drift}
        log(f'  ppo epoch {ep + 1}/{epochs} ' + ' '.join(f'{k}={v:.4f}' for k, v in s.items()))
        if s['kl'] > max_kl:
            log('  kl が大きいのでここで止める'); break
    return s


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('cmd', choices=['init', 'imitate', 'ppo'])
    p.add_argument('--weights'); p.add_argument('--data', nargs='*', default=[]); p.add_argument('--out', required=True)
    p.add_argument('--seed', type=int, default=1); p.add_argument('--epochs', type=int)
    p.add_argument('--shape', type=float, default=0.3)
    a = p.parse_args()
    torch.manual_seed(a.seed); np.random.seed(a.seed)
    net = C.load_weights(a.weights) if a.weights else C.Net(seed=a.seed)
    if a.cmd != 'init':
        d = C.load_shards(a.data)
        t0 = time.time()
        if a.cmd == 'imitate':
            imitate(net, d, epochs=a.epochs or 6)
        else:
            ppo(net, d, shape=a.shape, epochs=a.epochs or 3)
        print(f'{len(d["a"])} 判断 {time.time() - t0:.1f} 秒')
    C.save_weights(net, a.out)
