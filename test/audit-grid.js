'use strict';
// Scripted hero strategies against the CPU field (6-handed, seat 0 is the hero, 5 CPUs drawn from
// all personalities). Reports the hero's result in BB/100 with a standard error.
// Run: node test/audit-grid.js   env: GRID_HANDS (default 2000), GRID_EVAL_HANDS (default 1000 for
// evaluation-best, which runs the engine per decision), GRID_STACKS (equal,varied), GRID_ONLY (name).
const path = require('path');
// GRID_ROOT: a directory holding public/ to run against (before/after comparisons).
const ROOT = process.env.GRID_ROOT || path.join(__dirname, '..');
const E = require(path.join(ROOT, 'public', 'engine.js'));
const G = require(path.join(ROOT, 'public', 'game.js'));

const HANDS = Number(process.env.GRID_HANDS) || 2000;
const EVAL_HANDS = Number(process.env.GRID_EVAL_HANDS) || 1000;
const STACKS = (process.env.GRID_STACKS || 'equal,varied').split(',');
const ONLY = process.env.GRID_ONLY || null;

function clampAmt(x, L) { return Math.max(L.minRaiseTo, Math.min(L.maxRaiseTo, x)); }

// Each strategy gets (sess, L, hand) and returns { action, amount (chips) }.
const STRATEGIES = {
  'always-raise': function (sess, L, hand) {
    if (!L.canRaise) return { action: L.toCall > 0 ? 'call' : 'call' };
    const pot = hand.seats.reduce((a, h) => a + h.contributed, 0);
    return { action: 'raise', amount: clampAmt(L.curBet + 0.6 * pot, L) };
  },
  'always-call': function () { return { action: 'call' }; },
  'always-fold': function (sess, L) { return { action: L.toCall > 0 ? 'fold' : 'call' }; },
  'premium-only': function (sess, L, hand) {
    const c = hand.seats[0].cards;
    const pct = E.preflopPercentile(c[0], c[1]);
    if (hand.street === 'preflop' && pct <= 0.1 && L.canRaise) return { action: 'raise', amount: clampAmt(L.curBet * 3, L) };
    return { action: L.toCall > 0 ? 'fold' : 'call' };
  },
  'evaluation-best': function (sess, L, hand) {
    const sc = G.buildScenario(sess, 0);
    const r = E.evaluate(sc, 'call', null, { samples: 500, lang: 'en' });
    if (r.best === 'raise' && r.bestRaiseAmount != null) {
      return { action: 'raise', amount: clampAmt(r.bestRaiseAmount * hand.bb, L) };
    }
    if (r.best === 'fold' && L.toCall > 0) return { action: 'fold' };
    return { action: 'call' };
  },
};

function runCell(name, stacks, hands) {
  let seed = 20000 + stacks.length * 13 + name.length * 101 + (stacks === 'varied' ? 7 : 0);
  let n = 0, sum = 0, sumSq = 0, vpipHands = 0;
  const strat = STRATEGIES[name];
  while (n < hands) {
    const sess = G.newSession({ cpus: 5, stackBB: 100, stacks: stacks, seed: seed++ });
    for (let h = 0; h < 40 && n < hands && !sess.over; h++) {
      const before = sess.seats[0].stack;
      if (!G.startHand(sess, { players: 6 })) break;
      let guard = 0;
      while (!G.isHandOver(sess) && guard++ < 400) {
        const idx = G.toAct(sess);
        if (idx === 0) {
          const L = G.legal(sess, 0);
          const hand = sess.hand;
          const d = strat(sess, L, hand);
          if (d.action === 'raise' && !L.canRaise) d.action = 'call';
          if (d.action === 'fold' && L.toCall <= 0) d.action = 'call';
          G.act(sess, 0, d.action, d.action === 'raise' ? d.amount : null);
        } else {
          G.stepBot(sess);
        }
      }
      const bb = sess.hand ? sess.hand.bb : G.BB;
      const delta = (sess.seats[0].stack - before) / bb;
      n++; sum += delta; sumSq += delta * delta;
    }
  }
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  return { strategy: name, stacks: stacks, hands: n, bb100: 100 * mean, se: 100 * sd / Math.sqrt(n) };
}

if (require.main === module) {
  const names = ONLY ? [ONLY] : Object.keys(STRATEGIES);
  const t0 = Date.now();
  console.log('Hero strategy grid vs CPU field, 6-handed, 100 BB, all personalities. BB/100 +/- 1 SE.');
  for (const stacks of STACKS) {
    for (const name of names) {
      const hands = name === 'evaluation-best' ? EVAL_HANDS : HANDS;
      const r = runCell(name, stacks, hands);
      console.log(r.strategy.padEnd(16) + r.stacks.padEnd(8) + String(r.hands).padStart(6) + ' hands  ' +
        (r.bb100 >= 0 ? '+' : '') + r.bb100.toFixed(0) + ' +/- ' + r.se.toFixed(0));
    }
  }
  console.log('done in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
}

module.exports = { STRATEGIES: STRATEGIES, runCell: runCell };
