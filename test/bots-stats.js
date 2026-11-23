'use strict';
// Measures CPU personality play and short-stack / all-in behaviour by simulating all-bot tables.
// Run: npm run bots-stats  (env BOTS_HANDS = hands per personality, default 3000).
// Exports the measurers so test/game.test.js can assert on them.
const path = require('path');
const E = require(path.join(__dirname, '..', 'public', 'engine.js'));
const Bots = require(path.join(__dirname, '..', 'public', 'bots.js'));
const G = require(path.join(__dirname, '..', 'public', 'game.js'));

function rngFrom(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// 6-handed, 100 BB, every seat the same personality. VPIP / PFR per seat-hand and postflop
// aggression = (bets + raises) / (calls + checks), counted over all postflop actions.
function measureType(type, hands) {
  const out = { type, seatHands: 0, vpip: 0, pfr: 0, bets: 0, calls: 0, hands: 0 };
  let seed = 1000 + Bots.TYPES.indexOf(type) * 7919;
  while (out.hands < hands) {
    const sess = G.newSession({ cpus: 5, allBots: true, stackBB: 100, stacks: 'equal', personalities: [type], seed: seed++ });
    for (let h = 0; h < 60 && out.hands < hands; h++) {
      if (!G.startHand(sess, { players: 6 })) break;
      let guard = 0;
      while (!G.isHandOver(sess) && guard++ < 400) G.stepBot(sess);
      const hand = sess.hand;
      out.hands++;
      const vol = {}, pfr = {};
      hand.history.forEach((e) => {
        if (e.street === 'preflop') {
          if (e.action === 'limp' || e.action === 'call' || e.action === 'raise' || e.action === 'bet') vol[e.seat] = true;
          if (e.action === 'raise' || e.action === 'bet') pfr[e.seat] = true;
        } else {
          if (e.action === 'bet' || e.action === 'raise') out.bets++;
          else if (e.action === 'call' || e.action === 'check') out.calls++;
        }
      });
      hand.seats.forEach((hs, i) => {
        if (!hs.dealt) return;
        out.seatHands++;
        if (vol[i]) out.vpip++;
        if (pfr[i]) out.pfr++;
      });
    }
  }
  return {
    type,
    hands: out.hands,
    vpip: 100 * out.vpip / out.seatHands,
    pfr: 100 * out.pfr / out.seatHands,
    aggression: out.calls ? out.bets / out.calls : Infinity,
  };
}

// Equal stacks of `depth` BB, all personalities, 6-handed: how often a preflop raise is an all-in,
// and how often a marginal hand (percentile > 0.3) jams.
// Each hand starts from exactly `depth` BB (a fresh table per hand). The effective stack is the
// smallest live total (chips behind plus chips in), as the bot sees it. Results are split into
// effective <= 15 BB (push/fold zone) and deeper spots.
function measureShort(depth, hands) {
  const mk = () => ({ decisions: 0, folds: 0, calls: 0, raises: 0, allInRaises: 0, marginalJams: 0 });
  const out = { depth, short: mk(), deep: mk() };
  let seed = 4000 + depth;
  for (let played = 0; played < hands; played++) {
    const sess = G.newSession({ cpus: 5, allBots: true, stackBB: depth, stacks: 'equal', seed: seed++ });
    if (!G.startHand(sess, { players: 6 })) continue;
    let guard = 0;
    while (!G.isHandOver(sess) && guard++ < 400) {
      const hand = sess.hand;
      const idx = hand.toAct;
      const preflop = hand.street === 'preflop';
      const pct = preflop ? E.preflopPercentile(hand.seats[idx].cards[0], hand.seats[idx].cards[1]) : null;
      let eff = Infinity;
      hand.order.forEach((j) => {
        const o = hand.seats[j];
        if (!o.folded) eff = Math.min(eff, (sess.seats[j].stack + o.contributed) / 100);
      });
      const ev = G.stepBot(sess);
      if (!preflop) continue;
      const o = eff <= 15 ? out.short : out.deep;
      o.decisions++;
      if (ev.action === 'fold') o.folds++;
      else if (ev.action === 'call') o.calls++;
      else if (ev.action === 'raise') {
        o.raises++;
        if (sess.seats[idx].stack === 0) {
          o.allInRaises++;
          if (pct > 0.3) o.marginalJams++;
        }
      }
    }
  }
  return out;
}

// Calls of an all-in shove by a seat in the marginal hand band, split by whether the shove covers
// the bot (call is all-in for the bot: covered) or the bot covers the shover (covering).
// Preflop only, so the hand class is the preflop percentile.
const BANDS = [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 1.01]];
function measureCalls(hands) {
  const rows = BANDS.map((b) => ({ band: b, covered: { n: 0, cont: 0 }, covering: { n: 0, cont: 0 } }));
  let seed = 9100, played = 0;
  const rng = rngFrom(seed);
  while (played < hands) {
    const cust = [0, 1, 2, 3, 4, 5].map(() => 5 + Math.floor(rng() * 60));
    const sess = G.newSession({ cpus: 5, allBots: true, stackBB: 100, stacks: 'custom', customStacks: cust, seed: seed++ });
    for (let h = 0; h < 40 && played < hands; h++) {
      if (!G.startHand(sess, { players: 6 })) break;
      let guard = 0;
      while (!G.isHandOver(sess) && guard++ < 400) {
        const hand = sess.hand;
        const idx = hand.toAct;
        const hs = hand.seats[idx];
        let shover = null;
        if (hand.street === 'preflop' && G.legal(sess, idx).toCall > 0) {
          hand.order.forEach((j) => {
            const o = hand.seats[j];
            if (j !== idx && !o.folded && sess.seats[j].stack === 0 && o.contributed > 0) shover = j;
          });
        }
        const botTotal = sess.seats[idx].stack + hs.contributed;
        const pct = hand.street === 'preflop' ? E.preflopPercentile(hs.cards[0], hs.cards[1]) : null;
        const ev = G.stepBot(sess);
        if (shover == null) continue;
        const covered = hand.seats[shover].contributed >= botTotal - 1e-9;
        const row = rows.find((r) => pct >= r.band[0] && pct < r.band[1]);
        const side = covered ? row.covered : row.covering;
        side.n++;
        if (ev.action !== 'fold') side.cont++;
      }
      played++;
    }
  }
  return rows.map((r) => ({
    band: r.band,
    covered: { n: r.covered.n, callRate: r.covered.n ? r.covered.cont / r.covered.n : null },
    covering: { n: r.covering.n, callRate: r.covering.n ? r.covering.cont / r.covering.n : null },
  }));
}


// Targets (6-handed, 100 BB, 3000 hands each, +/- 4 points for VPIP and PFR).
const TARGETS = {
  tight: { vpip: 16, pfr: 12 },
  loose: { vpip: 42, pfr: 12 },
  aggressive: { vpip: 30, pfr: 24 },
  passive: { vpip: 30, pfr: 5 },
  balanced: { vpip: 23, pfr: 17 },
};
const AGG_TARGET = { aggressive: '>= 2.5', balanced: '~1.5', tight: '~1.3', loose: '~0.8', passive: '<= 0.5' };

module.exports = { measureType, measureShort, measureCalls, TARGETS };

if (require.main === module) {
  const hands = Number(process.env.BOTS_HANDS) || 3000;
  const t0 = Date.now();
  console.log('Personality measurements, 6-handed, 100 BB, ' + hands + ' hands per type');
  console.log('type        VPIP  (tgt)   PFR  (tgt)   aggression (target)');
  Bots.TYPES.forEach((t) => {
    const m = measureType(t, hands);
    console.log(
      t.padEnd(11) + m.vpip.toFixed(1).padStart(5) + '  (' + TARGETS[t].vpip + ')' +
      m.pfr.toFixed(1).padStart(7) + '  (' + TARGETS[t].pfr + ')' +
      '   ' + m.aggression.toFixed(2) + '  (' + AGG_TARGET[t] + ')');
  });
  [8, 12, 15, 25, 50, 100].forEach((d) => {
    const s = measureShort(d, Math.max(200, Math.round(hands / 10)));
    ['short', 'deep'].forEach((k) => {
      const o = s[k];
      if (!o.decisions) return;
      console.log(k + ' (' + d + ' BB start): decisions ' + o.decisions + ', preflop raises ' + o.raises +
        ' (all-in ' + (o.raises ? (100 * o.allInRaises / o.raises).toFixed(0) : '-') + '%), marginal jams ' + o.marginalJams +
        ', folds ' + (100 * o.folds / o.decisions).toFixed(0) + '%');
    });
  });
  measureCalls(Math.max(400, Math.round(hands / 4))).forEach((r) => {
    const f = (x) => x.n + ' (' + (x.callRate == null ? '-' : (100 * x.callRate).toFixed(0) + '%') + ')';
    console.log('all-in call, band ' + r.band[0] + '-' + Math.min(1, r.band[1]).toFixed(1) + ': covered ' + f(r.covered) + ' vs covering ' + f(r.covering));
  });
  console.log('done in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
}
