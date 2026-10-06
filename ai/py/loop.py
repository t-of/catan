"""世代のループ: 生成（Node）→ 学習（PyTorch）→ 評価 → 次の世代。世代ごとに重みと記録を残すので、同じコマンドで続きから再開できる。
使い方: python3 ai/py/loop.py --run ai/runs/名前 --gens 10 --games 4000 --procs 64 --init imitate|zero
出力: <run>/gen-0000.bin（初期）, gen-0001.bin ...（各世代の重み）, <run>/log.jsonl（世代ごとの記録）
"""
import argparse, glob, json, os, random, re, shutil, subprocess, sys, time
import numpy as np
import torch
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import catanai as C
import train as T

p = argparse.ArgumentParser()
p.add_argument('--run', required=True)
p.add_argument('--gens', type=int, default=10, help='ここまでの世代を作る（再開時は続きから）')
p.add_argument('--games', type=int, default=4000, help='1 世代の自己対局の局数')
p.add_argument('--procs', type=int, default=os.cpu_count() or 1, help='Node の同時プロセス数')
p.add_argument('--init', choices=['imitate', 'zero'], default='imitate')
p.add_argument('--imitate-games', type=int, default=2000)
p.add_argument('--imitate-epochs', type=int, default=6)
p.add_argument('--keep', type=float, default=0.1, help='記録する判断の割合')
p.add_argument('--max-turns', type=int, default=300)
p.add_argument('--mix', default='0.6,0.2,0.2')
p.add_argument('--epochs', type=int, default=3)
p.add_argument('--shape', type=float, default=0.3, help='点差の報酬の重み（--shape-gens 世代で 0 まで下げる）')
p.add_argument('--shape-gens', type=int, default=30)
p.add_argument('--eval-every', type=int, default=1)
p.add_argument('--eval-games', type=int, default=200, help='評価 1 項目の局数（vs つよい 3 人。前の世代・ランダムは半分）')
p.add_argument('--seed', type=int, default=1)
p.add_argument('--max-minutes', type=float, default=0, help='この分数に収まらなそうなら世代の前で止める（0 = 無制限）。再投入で続きから')
p.add_argument('--keep-data', action='store_true')
p.add_argument('--D', type=int, default=48); p.add_argument('--rounds', type=int, default=3); p.add_argument('--H', type=int, default=48)
a = p.parse_args()

run = os.path.abspath(a.run)
os.makedirs(run, exist_ok=True)
W = lambda g: f'{run}/gen-{g:04d}.bin'
logf = f'{run}/log.jsonl'
NODE = ['node']


def log(msg):
    print(time.strftime('%H:%M:%S'), msg, flush=True)


def record(entry):
    with open(logf, 'a') as f:
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')


def done_gens():
    if not os.path.exists(logf):
        return set()
    return {json.loads(l)['gen'] for l in open(logf) if l.strip() and os.path.exists(W(json.loads(l)['gen']))}


def run_procs(cmds):
    """Node を同時に回し、各プロセスの最後の行（JSON）を集める"""
    ps = [subprocess.Popen(c, cwd=C.ROOT, stdout=subprocess.PIPE, text=True) for c in cmds]
    outs = [q.communicate()[0] for q in ps]
    for q, c in zip(ps, cmds):
        if q.returncode:
            raise RuntimeError(f'失敗: {" ".join(c)}')
    return outs


def split_games(n, k):
    return [n // k + (1 if i < n % k else 0) for i in range(k) if n // k + (1 if i < n % k else 0)]


def generate(g, mode, weights, n, past_pool):
    d = f'{run}/data-{g:04d}'
    shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
    cmds = []
    for i, k in enumerate(split_games(n, a.procs)):
        c = NODE + ['ai/gen.mjs', '--mode', mode, '--games', str(k), '--seed', str(a.seed * 1000 + g), '--shard', str(i), '--out', f'{d}/shard-{i:04d}.bin',
                    '--keep', str(1.0 if mode == 'imitate' else a.keep), '--max-turns', str(a.max_turns), '--mix', a.mix]
        if mode != 'imitate':
            c += ['--weights', weights]
            if past_pool:
                c += ['--past', random.choice(past_pool)]
        cmds.append(c)
    outs = run_procs(cmds)
    tot = {'games': 0, 'draws': 0, 'turns': 0, 'samples': 0, 'miss': 0}
    for o in outs:
        j = json.loads(o.strip().splitlines()[-1])
        for k in tot:
            tot[k] += j[k]
    return d, tot


def evaluate(weights, seats, n, seed):
    """seats[0] が新しい重み。席は selfplay.mjs が毎局ずらす。→ (勝った割合, 引き分けの割合, 平均ターン)"""
    cmds = [NODE + ['ai/selfplay.mjs', str(k), seats, str(seed + i * 100000), str(a.max_turns)] for i, k in enumerate(split_games(n, a.procs))]
    wins = draws = games = 0; turns = 0.0
    for o, k in zip(run_procs(cmds), split_games(n, a.procs)):
        m = re.search(r'打ち切り=(\d+) 勝ち\(席ごと\)=([\d/]+) 平均ターン=([\d.]+)', o)
        draws += int(m.group(1)); wins += int(m.group(2).split('/')[0]); turns += float(m.group(3)) * k; games += k
    return {'win': wins / games, 'draw': draws / games, 'turns': turns / games, 'n': games}


def evals(g):
    w = W(g)
    r = {'vs_strong': evaluate(w, f'net:{w},strong,strong,strong', a.eval_games, 900000 + g * 7)}
    r['vs_random'] = evaluate(w, f'net:{w},random,random,random', a.eval_games // 2, 910000 + g * 7)
    if g >= 1:
        pw = W(g - 1)
        r['vs_prev'] = evaluate(w, f'net:{w},net:{pw},net:{pw},net:{pw}', a.eval_games // 2, 920000 + g * 7)
    return r


def fmt(r):
    return ' '.join(f'{k}={v["win"]:.2f}(引分{v["draw"]:.2f},{v["turns"]:.0f}t)' for k, v in r.items())


done = done_gens()
random.seed(a.seed); np.random.seed(a.seed); torch.manual_seed(a.seed)
t00 = time.time()
last_sec = 0
if 0 not in done:
    t0 = time.time()
    cfg = {'D': a.D, 'rounds': a.rounds, 'H': a.H}
    net = C.Net(cfg, seed=a.seed)
    entry = {'gen': 0, 'init': a.init}
    if a.init == 'imitate':
        log(f'世代 0: つよい CPU の {a.imitate_games} 局を記録して真似る')
        d, tot = generate(0, 'imitate', None, a.imitate_games, [])
        entry.update(tot)
        data = C.load_shards(sorted(glob.glob(f'{d}/shard-*.bin')))
        entry.update(T.imitate(net, data, epochs=a.imitate_epochs, log=log))
        if not a.keep_data:
            shutil.rmtree(d)
    C.save_weights(net, W(0))
    entry['train_sec'] = round(time.time() - t0, 1)
    entry['eval'] = evals(0) if a.eval_every else {}
    entry['sec'] = round(time.time() - t0, 1)
    log(f'世代 0 {fmt(entry["eval"])}')
    record(entry)
for g in range(1, a.gens + 1):
    if g in done:
        continue
    if a.max_minutes and last_sec and (time.time() - t00 + last_sec * 1.2) / 60 > a.max_minutes:
        log(f'時間の枠（{a.max_minutes} 分）に収まらないので世代 {g} の前で止める。同じコマンドで続きから'); break
    t0 = time.time()
    pool = [W(i) for i in range(0, g - 1)]
    d, tot = generate(g, 'play', W(g - 1), a.games, pool)
    t1 = time.time()
    data = C.load_shards(sorted(glob.glob(f'{d}/shard-*.bin')))
    net = C.load_weights(W(g - 1))
    shape = a.shape * max(0.0, 1 - (g - 1) / a.shape_gens)
    log(f'世代 {g}: {tot["games"]} 局 {tot["samples"]} 判断 引き分け {tot["draws"] / tot["games"]:.2f} 平均 {tot["turns"] / tot["games"]:.0f} ターン（生成 {t1 - t0:.0f} 秒）shape={shape:.3f}')
    stats = T.ppo(net, data, shape=shape, epochs=a.epochs, log=log)
    C.save_weights(net, W(g))
    t2 = time.time()
    entry = {'gen': g, **tot, 'shape': shape, **stats, 'gen_sec': round(t1 - t0, 1), 'train_sec': round(t2 - t1, 1)}
    if a.eval_every and g % a.eval_every == 0:
        entry['eval'] = evals(g)
        log(f'世代 {g} {fmt(entry["eval"])}')
    entry['sec'] = round(time.time() - t0, 1)
    record(entry)
    last_sec = entry['sec']
    if not a.keep_data:
        shutil.rmtree(d, ignore_errors=True)
log(f'おわり（{time.time() - t00:.0f} 秒）。重み: {W(a.gens)}')
