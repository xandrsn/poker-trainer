"""Policy network for 2 to 9 players, trained like ml/train.py (self-play PPO, oracle critic, side pots included).
Exports checkpoints as 16-bit floats to public/nn-models.json for public/nn.js.
Feature order must match features() in public/nn.js.   Run: python ml/train_multi.py [iterations]"""
import base64, json, math, os, sys, time
import torch
import torch.nn as nn
import torch.nn.functional as F
from train import D, HERE, NA, NC, PF, card_feats, equity, logp, mlp, score

P, N, MAXT = 9, 4096, 150
SEATS = torch.tensor([0, 0, .13, .15, .15, .16, .23, .05, .05, .08])  # share of hands per table size


def make_pool(M):
    feats = torch.zeros(M, P, 4, NC, dtype=torch.float16)
    rank = torch.zeros(M, P, dtype=torch.int8)  # showdown order at the table, higher wins, equal ties
    for i in range(0, M, 2048):
        m = min(2048, M - i)
        d = torch.rand(m, 52, device=D).topk(2 * P + 5, 1).indices
        bd = d[:, 2 * P:]
        h = d[:, :2 * P].reshape(m * P, 2)
        b = bd.repeat_interleave(P, 0)
        r = h // 4
        hi, lo = r.max(1).values, r.min(1).values
        e = torch.where(h[:, 0] % 4 == h[:, 1] % 4, PF[hi, lo], PF[lo, hi])
        out = torch.zeros(m * P, 4, NC, device=D)
        out[:, 0] = card_feats(h, b[:, :0], e)
        for s, k in ((1, 3), (2, 4), (3, 5)):
            out[:, s] = card_feats(h, b[:, :k], equity(h, b[:, :k], 60))
        feats[i:i + m] = out.view(m, P, 4, NC).half().cpu()
        sc = score(torch.cat([h, b], 1)).view(m, P)
        rank[i:i + m] = (sc[:, :, None] > sc[:, None, :]).sum(2).to(torch.int8).cpu()
    return feats, rank


def payout(tot, live, rank):
    """Chips won minus chips paid, side pots included."""
    lv = torch.cat([torch.zeros_like(tot[:, :1]), tot.sort(1).values], 1)
    won = torch.zeros_like(tot)
    for k in range(1, P + 1):
        w = lv[:, k] - lv[:, k - 1]
        part = tot >= lv[:, k, None] - 1e-4
        size = w * part.sum(1)
        el = part & live
        best = torch.where(el, rank, torch.full_like(rank, -1)).max(1).values
        win = el & (rank == best[:, None])
        won += win * (size / win.sum(1).clamp(min=1))[:, None]
    return won - tot


# Seat 0 = button; amounts in BB
class Env:
    def __init__(s, n, pool):
        idx = torch.randint(0, len(pool[1]), (n,))
        s.cf, s.rank = pool[0][idx].to(D).float(), pool[1][idx].to(D).float()
        s.np = torch.multinomial(SEATS.to(D), n, replacement=True)
        np, I = s.np, torch.arange(n, device=D)
        s.I = I
        s.dealt = torch.arange(P, device=D)[None] < np[:, None]
        S = torch.exp(torch.rand(n, device=D) * math.log(150 / 1.5)) * 1.5
        vary = (torch.rand(n, device=D) < .5).float()[:, None]
        st = (S[:, None] * torch.exp(vary * .6 * torch.randn(n, P, device=D))).clamp(1, 300) * s.dealt
        s.S = st.clone()
        s.sb = torch.where(np == 2, 0, 1)
        s.bb = torch.where(np == 2, 1, 2)
        s.bet = torch.zeros(n, P, device=D)
        s.bet[I, s.sb] = .5
        s.bet[I, s.bb] = 1.
        s.stack = st - s.bet
        s.tot = s.bet.clone()
        s.live = s.dealt.clone()
        s.need = s.live & (s.stack > 1e-6)
        s.street = torch.zeros(n, dtype=torch.long, device=D)
        s.done = torch.zeros(n, dtype=torch.bool, device=D)
        s.minr, s.nr, s.pay = torch.ones(n, device=D), torch.zeros(n, device=D), torch.zeros(n, P, device=D)
        s.agg = torch.zeros(n, P, 4, device=D)
        s.last = torch.full((n,), -1, device=D)
        s.done |= ~s.need.any(1)  # everybody all-in on the blinds: nothing to decide, pays nothing
        s.act = s.next(s.bb)

    def ring(s, a):
        return (a[:, None] + torch.arange(1, P + 1, device=D)) % s.np[:, None]

    def next(s, a):
        o = s.ring(a)
        ok = s.need.gather(1, o) & (torch.arange(1, P + 1, device=D)[None] <= s.np[:, None])
        return o.gather(1, ok.float().argmax(1, keepdim=True))[:, 0]

    def obs(s):
        I, a = s.I, s.act
        st = s.street
        me = F.one_hot(a, P).bool()
        opp = s.live & ~me
        mb, ms = s.bet[I, a], s.stack[I, a]
        pot = s.tot.sum(1)
        cur = s.bet.max(1).values
        tc = (cur - mb).clamp(min=0).minimum(ms)
        cover = torch.where(opp, s.bet + s.stack, torch.zeros_like(s.bet)).max(1).values
        eff = torch.minimum(ms, cover - mb).clamp(min=0)
        nl = opp.sum(1).float()
        chips = s.stack > 1e-6
        order = (torch.arange(P, device=D)[None] - 1) % s.np[:, None]  # who acts when after the flop: the button last
        mine = (a - 1) % s.np
        can_act = opp & chips
        after = (can_act & (order > mine[:, None])).sum(1) / can_act.sum(1).clamp(min=1)
        callers = ((opp & (s.bet >= cur[:, None] - 1e-6)).sum(1) - 1).clamp(min=0) * (cur > 0)
        eq = s.cf[I, a, st]
        b = torch.stack([(a == 0).float(), tc / (pot + tc), (tc / pot).clamp(max=2) / 2, (eff / pot).clamp(max=10) / 10,
                         torch.log1p(eff) / 5, torch.log1p(pot) / 5, s.nr.clamp(max=4) / 4, (tc > 1e-6).float(),
                         nl / 8, eq[:, 0] ** nl, (opp & ~chips).sum(1) / 8, (opp & s.need).sum(1) / 8, after,
                         (a == s.sb).float(), (a == s.bb).float(), s.np / 9, callers / 8, (s.last == a).float(), s.tot[I, a] / pot], 1)
        ra = s.agg[I, a]
        x = torch.cat([eq, F.one_hot(st, 4).float(), b, ra.clamp(max=3) / 3, (s.agg.sum(1) - ra).clamp(max=3) / 3], 1)
        o = s.ring(a)[:, :P - 1]
        valid = torch.arange(1, P, device=D)[None] < s.np[:, None]
        lv = s.live.gather(1, o) & valid
        now = s.cf[:, :, :, 0].gather(2, st[:, None, None].expand(-1, P, 1))[:, :, 0]
        orc = torch.cat([x, lv.float(), now.gather(1, o) * lv, s.cf[:, :, 3, 0].gather(1, o) * lv,
                         torch.sign(s.rank[I, a][:, None] - s.rank.gather(1, o)) * lv, (lv & ~chips.gather(1, o)).float(),
                         s.tot.gather(1, o) / pot[:, None] * valid, torch.log1p(s.stack.gather(1, o)) / 5 * lv,
                         s.cf[I, a, 3, :1], s.S[I, a].clamp(min=1).log()[:, None] / 4], 1)
        can = (ms > tc + 1e-6) & (can_act.sum(1) > 0)
        sized = can & (s.nr < 4)
        return x, orc, torch.stack([tc > 1e-6, torch.ones_like(can), sized, sized, can], 1), tc, pot, cover

    def step(s, A, tc, pot, cover):
        I, a = s.I, s.act
        go = ~s.done
        mb, ms = s.bet[I, a], s.stack[I, a]
        cur = s.bet.max(1).values
        fold, call, rais = go & (A == 0), go & (A == 1), go & (A >= 2)
        fr = torch.tensor([0., 0., .5, 1., 0.], device=D)[A]
        cap = torch.minimum(mb + ms, cover)
        to = torch.where(A == 4, cap, torch.minimum(torch.maximum(cur + fr * (pot + tc), cur + s.minr), cap))
        new = torch.where(rais, to, torch.where(call, mb + tc, mb))
        s.minr = torch.where(rais, torch.maximum(s.minr, to - cur), s.minr)
        s.stack[I, a] = ms - (new - mb)
        s.tot[I, a] += new - mb
        s.bet[I, a] = new
        s.live[I, a] &= ~fold
        s.agg[I, a, s.street] += rais.float()
        s.nr = s.nr + rais.float()
        s.last = torch.where(rais, a, s.last)
        me = F.one_hot(a, P).bool()
        s.need = torch.where(rais[:, None], s.live & (s.stack > 1e-6) & ~me, s.need & ~(me & go[:, None]))
        alone = go & (s.live.sum(1) == 1)
        end = go & ~s.need.any(1) & ~alone
        able = s.live & (s.stack > 1e-6)
        fin = alone | (end & ((s.street == 3) | (able.sum(1) <= 1)))
        if fin.any():
            s.pay[fin] = payout(s.tot[fin], s.live[fin], s.rank[fin])
        s.done = s.done | fin
        nx = end & ~fin
        s.bet = torch.where(nx[:, None], torch.zeros_like(s.bet), s.bet)
        s.street = s.street + nx.long()
        s.minr = torch.where(nx, torch.ones_like(s.minr), s.minr)
        s.nr = torch.where(nx, torch.zeros_like(s.nr), s.nr)
        s.need = torch.where(nx[:, None], able, s.need)
        s.act = torch.where(s.done, a, s.next(torch.where(nx, torch.zeros_like(a), a)))


NX = NC + 4 + 19 + 8
NO = NX + 7 * (P - 1) + 2
H = 112


@torch.no_grad()
def play(hero, rest, n, pool):
    """BB per hand of one seat playing `hero` at tables of `rest`."""
    e = Env(n, pool)
    seat = (torch.rand(n, device=D) * e.np).long()
    for _ in range(MAXT):
        if e.done.all():
            break
        x, _, mk, *r = e.obs()
        lp = torch.where((e.act == seat)[:, None], logp(hero, x, mk), logp(rest, x, mk))
        e.step(torch.multinomial(lp.exp(), 1)[:, 0], *r)
    return e.pay[e.I, seat].mean().item()


def export(snaps):
    enc = lambda v: base64.b64encode(v.cpu().numpy().astype('<f2').tobytes()).decode()
    models = [{'name': n, 'layers': [{'i': sd[f'{k}.weight'].shape[1], 'o': sd[f'{k}.weight'].shape[0],
                                      'w': enc(sd[f'{k}.weight']), 'b': enc(sd[f'{k}.bias'])} for k in (0, 2, 4)]}
              for n, sd in snaps]
    with open(os.path.join(HERE, '..', 'public', 'nn-models.json'), 'w') as f:
        json.dump({'preflop': [[round(float(v), 4) for v in r] for r in PF.cpu()], 'models': models}, f)


def main(iters):
    t0 = time.time()
    pool = make_pool(120000 if iters > 100 else 8000)
    print('pool', round(time.time() - t0), 's', flush=True)
    pi, vf, ema = mlp(NX, NA, H), mlp(NO, 1, 256), mlp(NX, NA, H)
    ema.load_state_dict(pi.state_dict())
    op = torch.optim.Adam([{'params': pi.parameters()}, {'params': vf.parameters()}])
    marks = {max(1, int(iters * f)): n for f, n in ((.015, 'a'), (.05, 'b'), (.14, 'c'), (.4, 'd'), (1, 'e'))}
    snaps = []
    for it in range(1, iters + 1):
        fr = it / iters
        ent = .06 * (1 - fr) + .008 * fr
        for g, lr in zip(op.param_groups, (4e-4, 1e-3)):
            g['lr'] = lr * (1 - .85 * fr)
        e, B = Env(N, pool), []
        with torch.no_grad():
            for _ in range(MAXT):
                go = ~e.done
                if not go.any():
                    break
                x, orc, mk, *r = e.obs()
                lp = logp(pi, x, mk)
                A = torch.multinomial(lp.exp(), 1)[:, 0]
                B.append((x[go], orc[go], mk[go], A[go], lp[e.I, A][go], e.act[go], e.I[go]))
                e.step(A, *r)
            x, orc, mk, A, lp0, seat, idx = (torch.cat(z) for z in zip(*B))
            R = e.pay[idx, seat] / e.S[idx, seat].sqrt()
            adv = R - vf(orc)[:, 0]
            adv = (adv / (adv.std() + 1e-6)).clamp(-6, 6)
        for _ in range(3):
            for j in torch.randperm(len(x), device=D).split(8192):
                lp = logp(pi, x[j], mk[j])
                r = (lp[torch.arange(len(j), device=D), A[j]] - lp0[j]).exp()
                ent_now = -(lp.exp() * lp.clamp(min=-30)).sum(1).mean()
                loss = -torch.minimum(r * adv[j], r.clamp(.85, 1.15) * adv[j]).mean() - ent * ent_now \
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
                old = mlp(NX, NA, H)
                old.load_state_dict(sd)
                msg += f' vs {n} {play(ema, old, 40000, pool):+.3f}'
            assert e.done.all() and e.pay.sum().abs() < 10, 'chips leaked'
            print(it, f'{time.time() - t0:.0f}s ent {ent_now.item():.2f} n {len(x)}', msg, flush=True)


if __name__ == '__main__':
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 5000)
