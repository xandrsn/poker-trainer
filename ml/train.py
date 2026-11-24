"""Heads-up NLHE policy network, trained by self-play PPO with an entropy schedule and an oracle critic.
The critic sees both hands and the runout (allowed: a baseline may use anything the action cannot change);
the policy sees only what its player can see. Exports checkpoints to server/models.json for server/nnbot.js.
Feature order must match features() in server/nnbot.js.   Run: python ml/train.py [iterations]"""
import base64, json, math, os, sys, time
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

torch.manual_seed(7)
D = 'cuda' if torch.cuda.is_available() else 'cpu'
N, NA, MAXT = 8192, 5, 24
HERE = os.path.dirname(os.path.abspath(__file__))


# ---- evaluator (card = rank*4+suit, rank 0..12) via 13-bit rank-mask tables
def build():
    st = np.full(8192, -1, np.int64)
    top = np.zeros((6, 8192), np.int64)
    for m in range(8192):
        for h in range(12, 3, -1):
            if (m >> (h - 4)) & 31 == 31:
                st[m] = h
                break
        if st[m] < 0 and (m & 0x100F) == 0x100F:
            st[m] = 3
        bits = [b for b in range(12, -1, -1) if m >> b & 1]
        for k in range(1, 6):
            top[k, m] = sum(1 << b for b in bits[:k])
    return torch.tensor(st, device=D), torch.tensor(top, device=D)


ST, TOP = build()
POW = 1 << torch.arange(13, device=D)


def mask_of(b):
    return (b.long() * POW).sum(1)


def masks(cards):
    n = cards.shape[0]
    r, s = cards // 4, cards % 4
    cnt = torch.zeros(n, 13, dtype=torch.int64, device=D).scatter_add_(1, r, torch.ones_like(r))
    sm = torch.zeros(n, 52, dtype=torch.bool, device=D).scatter_(1, s * 13 + r, True).view(n, 4, 13)
    return cnt, sm


def score(cards):
    cnt, sm = masks(cards)
    m = [mask_of(cnt >= k) for k in (1, 2, 3, 4)]
    sc = sm.sum(2)
    fl = (sc >= 5).any(1)
    fm = mask_of(sm[torch.arange(len(cards), device=D), sc.argmax(1)]) * fl
    out = TOP[5, m[0]]
    p = TOP[1, m[1]]
    out = torch.where(p > 0, (1 << 26) + (p << 13) + TOP[3, m[0] & ~p], out)
    p2 = TOP[2, m[1]]
    out = torch.where(TOP[1, m[1] & ~p] > 0, (2 << 26) + (p2 << 13) + TOP[1, m[0] & ~p2], out)
    t = TOP[1, m[2]]
    out = torch.where(t > 0, (3 << 26) + (t << 13) + TOP[2, m[0] & ~t], out)
    s = ST[m[0]]
    out = torch.where(s >= 0, (4 << 26) + s, out)
    out = torch.where(fl, (5 << 26) + TOP[5, fm], out)
    fh = TOP[1, m[1] & ~t]
    out = torch.where((t > 0) & (fh > 0), (6 << 26) + (t << 13) + fh, out)
    q = TOP[1, m[3]]
    out = torch.where(q > 0, (7 << 26) + (q << 13) + TOP[1, m[0] & ~q], out)
    sf = torch.where(fl, ST[fm], torch.full_like(s, -1))
    return torch.where(sf >= 0, (8 << 26) + sf, out)


def equity(hole, board, K):
    """Win chance against a random hand. hole [M,2], board [M,b]."""
    M, b = hole.shape[0], board.shape[1]
    res = torch.zeros(M, device=D)
    ch = max(1, 400000 // K)
    for i in range(0, M, ch):
        h, bd = hole[i:i + ch], board[i:i + ch]
        m = h.shape[0]
        w = torch.rand(m * K, 52, device=D)
        w.scatter_(1, torch.cat([h, bd], 1).repeat_interleave(K, 0), -1.)
        x = w.topk(2 + 5 - b, 1).indices
        bb = torch.cat([bd.repeat_interleave(K, 0), x[:, 2:]], 1)
        a = score(torch.cat([h.repeat_interleave(K, 0), bb], 1))
        o = score(torch.cat([x[:, :2], bb], 1))
        res[i:i + ch] = ((a > o).float() + .5 * (a == o).float()).view(m, K).mean(1)
    return res


# ---- card features per street: see cardFeatures() in server/nnbot.js
NC = 25


def straight_win(mask):
    """Most ranks inside any 5-rank window (the ace also counts low)."""
    x = torch.cat([mask[:, 12:], mask], 1).float()
    return x.unfold(1, 5, 1).sum(2).max(1).values


def card_feats(hole, board, eq):
    M = hole.shape[0]
    hr = hole // 4
    hi, lo = hr.max(1).values.float(), hr.min(1).values.float()
    f = [eq, eq * eq, hi / 12, lo / 12, (hole[:, 0] % 4 == hole[:, 1] % 4).float(), (hi == lo).float(), (hi - lo) / 12]
    made = torch.zeros(M, 9, device=D)
    ext = torch.zeros(M, 9, device=D)
    if board.shape[1]:
        allc = torch.cat([hole, board], 1)
        cnt, sm = masks(allc)
        bc, bs = masks(board)
        made[torch.arange(M, device=D), score(allc) >> 26] = 1
        hs = torch.zeros(M, 4, dtype=torch.bool, device=D).scatter_(1, hole % 4, True)
        br = (board // 4).max(1).values
        ext[:, 0] = bc.max(1).values / 4
        ext[:, 1] = (bc >= 2).sum(1) / 2
        ext[:, 2] = bs.sum(2).max(1).values / 5
        ext[:, 3] = (sm.sum(2) * hs).max(1).values / 5
        ext[:, 4] = straight_win(bc > 0) / 5
        ext[:, 5] = straight_win(cnt > 0) / 5
        ext[:, 6] = br / 12
        ext[:, 7] = (hr > br[:, None]).sum(1) / 2
        ext[:, 8] = ((cnt >= 2) & (bc < cnt)).sum(1).clamp(max=2) / 2
    return torch.cat([torch.stack(f, 1), made, ext], 1)


def preflop_table():
    """[hi][lo] suited, [lo][hi] offsuit, diagonal pairs."""
    hs = []
    for a in range(13):
        for c in range(13):
            hs.append([max(a, c) * 4, min(a, c) * 4 + (0 if a > c else 1)])
    return equity(torch.tensor(hs, device=D), torch.zeros(169, 0, dtype=torch.long, device=D), 20000).view(13, 13)


PF = preflop_table()


def make_pool(P):
    feats = torch.zeros(P, 2, 4, NC, dtype=torch.float16)
    win = torch.zeros(P, dtype=torch.int8)
    for i in range(0, P, 8192):
        m = min(8192, P - i)
        d = torch.rand(m, 52, device=D).topk(9, 1).indices
        holes, bd = [d[:, :2], d[:, 2:4]], d[:, 4:]
        for p in (0, 1):
            h = holes[p]
            r = h // 4
            hi, lo = r.max(1).values, r.min(1).values
            e = torch.where(h[:, 0] % 4 == h[:, 1] % 4, PF[hi, lo], PF[lo, hi])
            feats[i:i + m, p, 0] = card_feats(h, bd[:, :0], e).half().cpu()
            for s, b in ((1, 3), (2, 4), (3, 5)):
                feats[i:i + m, p, s] = card_feats(h, bd[:, :b], equity(h, bd[:, :b], 60)).half().cpu()
        a, o = score(torch.cat([holes[0], bd], 1)), score(torch.cat([holes[1], bd], 1))
        win[i:i + m] = torch.sign(a - o).to(torch.int8).cpu()
    return feats, win


# ---- betting environment; player 0 = button / small blind; amounts in BB
class Env:
    def __init__(s, n, pool):
        idx = torch.randint(0, len(pool[1]), (n,))
        s.cf, s.win = pool[0][idx].to(D).float(), pool[1][idx].to(D).float()
        S = s.S = torch.exp(torch.rand(n, device=D) * math.log(70 / 1.5)) * 1.5
        z = lambda *a, **k: torch.zeros(n, *a, device=D, **k)
        s.stack = torch.stack([S - .5, S - 1], 1)
        s.bet = torch.tensor([.5, 1.], device=D).repeat(n, 1)
        s.prev, s.nact, s.nr, s.pay, s.agg = z(), z(), z(), z(), z(2, 4)
        s.street, s.act, s.done = z(dtype=torch.long), z(dtype=torch.long), z(dtype=torch.bool)
        s.minr = torch.ones(n, device=D)
        s.I = torch.arange(n, device=D)

    def obs(s):
        I, a, o = s.I, s.act, 1 - s.act
        st = s.street.clamp(max=3)
        pot = s.prev + s.bet.sum(1)
        tc = (s.bet[I, o] - s.bet[I, a]).clamp(min=0).minimum(s.stack[I, a])
        eff = torch.minimum(s.stack[I, a], s.stack[I, o] + s.bet[I, o] - s.bet[I, a]).clamp(min=0)
        b = torch.stack([(a == 0).float(), tc / (pot + tc), (tc / pot).clamp(max=2) / 2, (eff / pot).clamp(max=10) / 10,
                         torch.log1p(eff) / 5, torch.log1p(pot) / 5, s.nr.clamp(max=4) / 4, (tc > 0).float()], 1)
        x = torch.cat([s.cf[I, a, st], F.one_hot(st, 4).float(), b, s.agg[I, a].clamp(max=3) / 3, s.agg[I, o].clamp(max=3) / 3], 1)
        sgn = (1 - 2 * a).float()
        orc = torch.cat([x, s.cf[I, o, st], s.cf[:, :, :, 0].flatten(1), (s.win * sgn)[:, None], s.S.log()[:, None] / 4], 1)
        can = (s.stack[I, a] > tc + 1e-6) & (s.stack[I, o] > 1e-6)
        sized = can & (s.nr < 4)
        return x, orc, torch.stack([tc > 1e-6, torch.ones_like(can), sized, sized, can], 1), tc, pot

    def step(s, A, tc, pot):
        I, a, o = s.I, s.act, 1 - s.act
        live = ~s.done
        ob, mb, st = s.bet[I, o], s.bet[I, a], s.stack[I, a]
        fold = live & (A == 0)
        s.pay = torch.where(fold, -(1 - 2 * a).float() * (s.prev / 2 + mb), s.pay)
        fr = torch.tensor([0., 0., .5, 1., 0.], device=D)[A]
        cap = torch.minimum(mb + st, ob + s.stack[I, o])
        to = torch.maximum(ob + fr * (pot + tc), ob + s.minr)
        to = torch.where(A == 4, cap, torch.minimum(to, cap))
        rais, call = live & (A >= 2), live & (A == 1)
        new = torch.where(rais, to, torch.where(call, mb + tc, mb))
        s.minr = torch.where(rais, torch.maximum(s.minr, to - ob), s.minr)
        s.stack[I, a] = st - (new - mb)
        s.bet[I, a] = new
        s.agg[I, a, s.street.clamp(max=3)] += rais.float()
        s.nr += rais.float()
        s.nact += live.float()
        s.done = s.done | fold
        close = call & (s.nact >= 2)
        m = s.bet.min(1).values
        sd = close & ((s.stack.min(1).values < 1e-6) | (s.street == 3))
        s.pay = torch.where(sd, s.win * (s.prev / 2 + m), s.pay)
        s.done = s.done | sd
        nx = close & ~sd
        zero = torch.zeros_like(s.prev)
        s.prev = torch.where(nx, s.prev + 2 * m, s.prev)
        s.bet = torch.where(nx[:, None], torch.zeros_like(s.bet), s.bet)
        s.street = s.street + nx.long()
        s.minr = torch.where(nx, torch.ones_like(s.minr), s.minr)
        s.nr = torch.where(nx, zero, s.nr)
        s.nact = torch.where(nx, zero, s.nact)
        s.act = torch.where(nx, torch.ones_like(a), torch.where(s.done, a, o))


NX = NC + 4 + 8 + 8
NO = NX + NC + 8 + 2


def mlp(i, o, h):
    return nn.Sequential(nn.Linear(i, h), nn.ReLU(), nn.Linear(h, h), nn.ReLU(), nn.Linear(h, o)).to(D)


def logp(net, x, mk):
    return F.log_softmax(net(x).masked_fill(~mk, -1e9), 1)


@torch.no_grad()
def play(nets, n, pool):
    """BB per hand of nets[0] against nets[1], averaged over both seats."""
    tot = 0.
    for sw in (0, 1):
        e = Env(n, pool)
        for _ in range(MAXT):
            if e.done.all():
                break
            x, _, mk, tc, pot = e.obs()
            lp = torch.where((e.act ^ sw).bool()[:, None], logp(nets[1], x, mk), logp(nets[0], x, mk))
            e.step(torch.multinomial(lp.exp(), 1)[:, 0], tc, pot)
        tot += (e.pay * (1 - 2 * sw)).mean().item()
    return tot / 2


def export(snaps):
    enc = lambda v: base64.b64encode(v.cpu().numpy().astype('<f4').tobytes()).decode()
    models = [{'name': n, 'layers': [{'i': sd[f'{k}.weight'].shape[1], 'o': sd[f'{k}.weight'].shape[0],
                                      'w': enc(sd[f'{k}.weight']), 'b': enc(sd[f'{k}.bias'])} for k in (0, 2, 4)]}
              for n, sd in snaps]
    pf = [[round(float(v), 4) for v in r] for r in PF.cpu()]
    with open(os.path.join(HERE, '..', 'server', 'models.json'), 'w') as f:
        json.dump({'preflop': pf, 'models': models}, f)


def main(iters):
    t0 = time.time()
    pool = make_pool(300000 if iters > 100 else 20000)
    print('pool', round(time.time() - t0), 's', flush=True)
    pi, vf, ema = mlp(NX, NA, 96), mlp(NO, 1, 192), mlp(NX, NA, 96)
    ema.load_state_dict(pi.state_dict())
    op = torch.optim.Adam([{'params': pi.parameters()}, {'params': vf.parameters()}])
    marks = {max(1, int(iters * f)): n for f, n in ((.012, 'a'), (.04, 'b'), (.12, 'c'), (.35, 'd'), (1, 'e'))}
    snaps = []
    for it in range(1, iters + 1):
        fr = it / iters
        ent = .08 * (1 - fr) + .012 * fr
        for g, lr in zip(op.param_groups, (4e-4, 1e-3)):
            g['lr'] = lr * (1 - .85 * fr)
        e, B = Env(N, pool), []
        with torch.no_grad():
            for _ in range(MAXT):
                live = ~e.done
                if not live.any():
                    break
                x, orc, mk, tc, pot = e.obs()
                lp = logp(pi, x, mk)
                A = torch.multinomial(lp.exp(), 1)[:, 0]
                B.append((x[live], orc[live], mk[live], A[live], lp[e.I, A][live], (1 - 2 * e.act).float()[live], e.I[live]))
                e.step(A, tc, pot)
            x, orc, mk, A, lp0, sg, idx = (torch.cat(z) for z in zip(*B))
            R = e.pay[idx] * sg / e.S[idx].sqrt()
            adv = R - vf(orc)[:, 0]
            adv = (adv / (adv.std() + 1e-6)).clamp(-6, 6)
        for _ in range(3):
            for j in torch.randperm(len(x), device=D).split(8192):
                lp = logp(pi, x[j], mk[j])
                r = (lp[torch.arange(len(j), device=D), A[j]] - lp0[j]).exp()
                H = -(lp.exp() * lp.clamp(min=-30)).sum(1).mean()
                loss = -torch.minimum(r * adv[j], r.clamp(.85, 1.15) * adv[j]).mean() - ent * H \
                    + F.smooth_l1_loss(vf(orc[j])[:, 0], R[j])
                op.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(pi.parameters(), .5)
                op.step()
        with torch.no_grad():
            k = min(.995, it / (it + 10))
            for a, b in zip(ema.parameters(), pi.parameters()):
                a.mul_(k).add_(b, alpha=1 - k)
        if it in marks:
            snaps.append((marks[it], {k: v.clone() for k, v in ema.state_dict().items()}))
            export(snaps)
        if it % 100 == 0 or it == iters:
            msg = ''
            for n, sd in snaps[-3:]:
                old = mlp(NX, NA, 96)
                old.load_state_dict(sd)
                msg += f' vs {n} {play((ema, old), 40000, pool):+.3f}'
            print(it, f'{time.time() - t0:.0f}s ent {H.item():.2f}', msg, flush=True)


if __name__ == '__main__':
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 2500)
