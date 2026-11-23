'use strict';
/* Independent audit of PokerEngine, PokerBots and PokerGame (run: npm run audit).
 * Uses its own 7-card evaluator and Monte Carlo / exact ground truth. Reads public/*.js only.
 * Env: AUDIT_SCALE (default 1) multiplies all sample counts. Prints JSON details and a summary. */
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const E = require(path.join(PUB, 'engine.js'));
const G = require(path.join(PUB, 'game.js'));
const SCALE = Number(process.env.AUDIT_SCALE || 1);
const N = (x) => Math.max(1, Math.round(x * SCALE));

// ------------------------------------------------------------ bookkeeping
const REC = {};
function ok(name, cond, ex) {
  if (!REC[name]) REC[name] = { n: 0, fail: 0, ex: [] };
  const r = REC[name];
  r.n++;
  if (!cond) { r.fail++; if (r.ex.length < 4) r.ex.push(ex); }
  return !!cond;
}
const STATS = {};
const stat = (name, v) => { STATS[name] = v; };

function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const row = (res, label) => { const r = res.stats.find((s) => s.label === label); return r ? r.value : undefined; };
const parsePct = (s) => parseFloat(String(s)) / 100;

// ------------------------------------------- independent cards and evaluator
const RK = '23456789TJQKA', SU = 'shdc';
const cint = (s) => RK.indexOf(s[0]) * 4 + SU.indexOf(s[1]);
const PAIRS = [];
for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) PAIRS.push([a, b]);

// Score of exactly five cards: category * 13^5 + tiebreak digits (base 13).
function score5(c) {
  const cnt = new Array(13).fill(0);
  let mask = 0, flush = true;
  for (let i = 0; i < 5; i++) {
    const r = c[i] >> 2;
    cnt[r]++; mask |= 1 << r;
    if ((c[i] & 3) !== (c[0] & 3)) flush = false;
  }
  let sh = -1;
  if (cnt.every((x) => x <= 1)) {
    for (let t = 12; t >= 4; t--) {
      const need = 0x1f << (t - 4);
      if ((mask & need) === need) { sh = t; break; }
    }
    if (sh < 0 && mask === 0x100f) sh = 3; // A-2-3-4-5
  }
  const g = [];
  for (let k = 4; k >= 1; k--) for (let r = 12; r >= 0; r--) if (cnt[r] === k) g.push(r);
  const pat = g.map((r) => cnt[r]).join('');
  let cat, tb;
  if (flush && sh >= 0) { cat = 8; tb = [sh]; }
  else if (pat === '41') { cat = 7; tb = g; }
  else if (pat === '32') { cat = 6; tb = g; }
  else if (flush) { cat = 5; tb = g; }
  else if (sh >= 0) { cat = 4; tb = [sh]; }
  else if (pat === '311') { cat = 3; tb = g; }
  else if (pat === '221') { cat = 2; tb = g; }
  else if (pat === '2111') { cat = 1; tb = g; }
  else { cat = 0; tb = g; }
  let v = cat;
  for (let i = 0; i < 5; i++) v = v * 13 + (i < tb.length ? tb[i] : 0);
  return v;
}
function best7(cards) {
  const n = cards.length;
  let best = -1;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++)
    for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
      const s = score5([cards[a], cards[b], cards[c], cards[d], cards[e]]);
      if (s > best) best = s;
    }
  return best;
}

// Ground truth equity vs villain weight arrays (Float64Array(1326), PAIRS order).
// Exact for one villain on the river; otherwise Monte Carlo with sequential card removal.
function truthEquity(hero, board, weights, samples, rng) {
  const used0 = new Uint8Array(52);
  for (const c of hero.concat(board)) used0[c] = 1;
  if (weights.length === 1 && board.length === 5) {
    const w = weights[0];
    let tot = 0, sh = 0;
    const hs = best7(hero.concat(board));
    for (let k = 0; k < PAIRS.length; k++) {
      const x = w[k];
      if (!(x > 0)) continue;
      const [a, b] = PAIRS[k];
      if (used0[a] || used0[b]) continue;
      const vs = best7([a, b].concat(board));
      tot += x; sh += x * (hs > vs ? 1 : hs === vs ? 0.5 : 0);
    }
    return { eq: tot ? sh / tot : 0.5, exact: true };
  }
  const nb = 5 - board.length;
  let sum = 0, valid = 0;
  for (let s = 0; s < samples; s++) {
    const used = Uint8Array.from(used0);
    const vIdx = [];
    let okS = true;
    for (const w of weights) {
      const cum = [];
      let tot = 0;
      for (let k = 0; k < PAIRS.length; k++) {
        const x = w[k];
        if (!(x > 0)) continue;
        const [a, b] = PAIRS[k];
        if (used[a] || used[b]) continue;
        tot += x; cum.push([tot, k]);
      }
      if (!(tot > 0)) { okS = false; break; }
      const u = rng() * tot;
      let pick = cum[cum.length - 1][1];
      for (const [cv, k] of cum) if (cv > u) { pick = k; break; }
      vIdx.push(pick);
      used[PAIRS[pick][0]] = 1; used[PAIRS[pick][1]] = 1;
    }
    if (!okS) continue;
    const deck = [];
    for (let c = 0; c < 52; c++) if (!used[c]) deck.push(c);
    const brd = board.slice();
    for (let j = 0; j < nb; j++) { const q = Math.floor(rng() * deck.length); brd.push(deck[q]); deck.splice(q, 1); }
    const hs = best7(hero.concat(brd));
    let vmax = -1, tie = 0;
    for (const k of vIdx) {
      const vs = best7(PAIRS[k].concat(brd));
      if (vs > vmax) { vmax = vs; tie = 1; } else if (vs === vmax) tie++;
    }
    sum += hs > vmax ? 1 : hs === vmax ? 1 / (tie + 1) : 0;
    valid++;
  }
  return { eq: valid ? sum / valid : 0.5, exact: false, valid: valid };
}

// Hook the engine source so evaluate() exposes the villain weight arrays it used.
const engineSrc = fs.readFileSync(path.join(PUB, 'engine.js'), 'utf8');
const hooked = engineSrc.replace(/function equityDetail\(([^)]*)\)\s*\{/, (m) => m + ' globalThis.__eqW = arguments[2];');
if (hooked === engineSrc) throw new Error('audit: could not hook equityDetail');
const hm = { exports: {} };
new Function('module', 'exports', hooked + '\n;')(hm, hm.exports);
const EH = hm.exports;

(function checkMapping() {
  const aa = E.parseRange('AA');
  let good = true;
  PAIRS.forEach(([a, b], k) => {
    const isAA = (a >> 2) === 12 && (b >> 2) === 12;
    if ((aa[k] > 0) !== isAA) good = false;
  });
  ok('ground truth: combo index mapping matches engine', good, 'parseRange("AA") mapping differs');
})();

(function evaluatorSection() {
  const rng = mulberry(4321);
  const names = (h) => h.map((c) => RK[c >> 2] + SU[c & 3]);
  let dis = 0, pairs = 0;
  const ex = [];
  for (let i = 0; i < N(20000); i++) {
    const d = []; for (let c = 0; c < 52; c++) d.push(c);
    for (let j = 0; j < 14; j++) { const q = j + Math.floor(rng() * (52 - j)); [d[j], d[q]] = [d[q], d[j]]; }
    const a = d.slice(0, 7), b = d.slice(7, 14);
    const sa = E.evaluateHand(names(a)).score, sb = E.evaluateHand(names(b)).score;
    const ma = best7(a), mb = best7(b);
    pairs++;
    if (Math.sign(sa - sb) !== Math.sign(ma - mb)) { dis++; if (ex.length < 3) ex.push({ a: names(a).join(' '), b: names(b).join(' ') }); }
  }
  ok('evaluateHand orders 7-card hands like an independent evaluator', dis === 0, { disagreements: dis, of: pairs, examples: ex });
  stat('evaluator.disagreements', dis + ' of ' + pairs + ' random hand pairs');
  // Reproductions for the report
  const ev = (h) => E.evaluateHand(h).score;
  ok('equal pair hands tie (kickers beyond the 5-card hand ignored)', ev(['3h', 'As', '8c', '8h', 'Kc', 'Th', '4s']) === ev(['5h', 'Ah', '8c', '8h', 'Kc', 'Th', '4s']), { a: ev(['3h', 'As', '8c', '8h', 'Kc', 'Th', '4s']), b: ev(['5h', 'Ah', '8c', '8h', 'Kc', 'Th', '4s']) });
  ok('two pair with a higher third pair: kicker is the best single', ev(['As', 'Ah', 'Ks', 'Kh', '7s', '7h', '9c']) > ev(['Ac', 'Ad', 'Kc', 'Kd', '8c', '2d', '3c']), { hero: ev(['As', 'Ah', 'Ks', 'Kh', '7s', '7h', '9c']), villain: ev(['Ac', 'Ad', 'Kc', 'Kd', '8c', '2d', '3c']) });
})();

// ------------------------------------------------- scenario validity checker
const TABLE = E.POSITIONS;
function postOrderOf(n) {
  return (n > 2 ? ['SB'] : []).concat(['BB'], TABLE[n].filter((p) => p !== 'SB' && p !== 'BB' && p !== 'BTN'), ['BTN']);
}
function validateScenario(sc, tag) {
  const probs = [];
  const seats = sc.seats;
  const hero = seats.filter((s) => s.isHero);
  if (hero.length !== 1) { probs.push('hero count ' + hero.length); return probs.map((p) => tag + ': ' + p); }
  const h = hero[0];
  if (seats.length !== sc.numPlayers) probs.push('seats ' + seats.length + ' != numPlayers ' + sc.numPlayers);
  const posSet = seats.map((s) => s.position).sort().join(',');
  const want = (TABLE[sc.numPlayers] || []).slice().sort().join(',');
  if (posSet !== want) probs.push('positions ' + posSet + ' vs ' + want);
  const btn = seats.find((s) => s.position === 'BTN');
  if (!btn || btn.seat !== sc.buttonSeat) probs.push('button seat mismatch');
  if (h.position !== sc.heroPosition || h.seat !== sc.heroSeat) probs.push('hero position/seat mismatch');
  const nb = { preflop: 0, flop: 3, turn: 4, river: 5 }[sc.street];
  if (sc.board.length !== nb) probs.push('board ' + sc.board.length + ' cards on ' + sc.street);
  const cards = sc.hero.concat(sc.board);
  if (new Set(cards).size !== cards.length) probs.push('duplicate card ' + cards.join(' '));
  for (const c of cards) if (!/^[2-9TJQKA][shdc]$/.test(c)) probs.push('bad card ' + c);
  const contrib = seats.reduce((a, s) => a + (s.contributed || 0), 0);
  if (Math.abs(contrib - sc.pot) > 0.011 * Math.max(1, seats.length)) probs.push('pot ' + sc.pot + ' != sum of contributions ' + contrib.toFixed(2));
  for (const s of seats) if (!(s.stack >= 0) || !(s.bet >= 0)) probs.push('negative stack/bet at seat ' + s.seat);
  if (Math.abs(h.stack - sc.heroStack) > 0.011) probs.push('heroStack mismatch');
  const liveMax = Math.max(...seats.filter((s) => !s.folded).map((s) => s.bet));
  if (Math.abs(sc.toCall - Math.min(Math.max(0, liveMax - h.bet), h.stack)) > 0.011) probs.push('toCall ' + sc.toCall + ' vs live max bet ' + liveMax + ' minus hero bet ' + h.bet);
  if (sc.toCall > h.stack + 0.011) probs.push('toCall ' + sc.toCall + ' exceeds hero stack ' + h.stack + ' (all-in call for less)');
  const rank = (p) => postOrderOf(sc.numPlayers).indexOf(p);
  const inPosTruth = seats.every((s) => s.isHero || s.folded || rank(s.position) < rank(h.position));
  if (inPosTruth !== sc.inPosition) probs.push('inPosition ' + sc.inPosition + ' expected ' + inPosTruth);
  let prev = -Infinity;
  for (const o of sc.raiseOptions) {
    if (o.amount <= liveMax + 1e-9) probs.push('raise option ' + o.amount + ' not above current bet ' + liveMax);
    if (o.amount <= prev) probs.push('raise options not ascending');
    prev = o.amount;
    if (o.amount > h.bet + h.stack + 1e-9) probs.push('raise option above stack');
  }
  // One standard raise size; an all-in option only when it is flagged (the size would commit most of the stack).
  for (const o of sc.raiseOptions) {
    if (o.allin && Math.abs(o.amount - (h.bet + h.stack)) > 0.011) probs.push('all-in option is not the whole stack');
  }
  if (!sc.situation) probs.push('missing situation');
  return probs.map((p) => tag + ': ' + p);
}

// ------------------------------------------------------------- 1. ground truth
(function truthSection() {
  const count = N(200);
  const devs = [];
  let skipped = 0;
  const t0 = Date.now();
  for (let i = 0; i < count; i++) {
    const seed = 100000 + i;
    const sc = EH.generateScenario({ seed: seed });
    globalThis.__eqW = null;
    const res = EH.evaluate(sc, 'call', undefined, { rng: mulberry(seed + 7) });
    const weights = Array.isArray(globalThis.__eqW) ? globalThis.__eqW : null;
    if (!weights || !weights.length) { skipped++; continue; }
    const po = row(res, 'Pot odds (needed chance)');
    const wantPo = sc.toCall > 0 ? Math.round((sc.toCall / (sc.pot + sc.toCall)) * 100) + '%' : 'n/a';
    ok('pot odds stat = toCall / (pot + toCall)', po === wantPo, { seed, shown: po, want: wantPo, pot: sc.pot, toCall: sc.toCall });
    const shown = parsePct(row(res, 'Chance to win vs range'));
    const t = truthEquity(sc.hero.map(cint), sc.board.map(cint), weights, N(2500), mulberry(seed + 99));
    const dev = shown - t.eq;
    const p = t.eq;
    const seE = Math.sqrt(p * (1 - p) / 3000);
    const seT = t.exact ? 0 : Math.sqrt(p * (1 - p) / 2500);
    devs.push({ seed, dev, z: dev / Math.sqrt(seE * seE + seT * seT), street: sc.street, players: sc.numPlayers, exact: t.exact, shown, truth: t.eq, villains: weights.length });
    ok('equity within 5 pts of ground truth', Math.abs(dev) <= 0.05, { seed, street: sc.street, players: sc.numPlayers, villains: weights.length, shown: +shown.toFixed(3), truth: +t.eq.toFixed(3) });
  }
  const abs = devs.map((d) => Math.abs(d.dev)).sort((a, b) => a - b);
  const mean = devs.reduce((a, d) => a + d.dev, 0) / devs.length;
  const meanAbs = abs.reduce((a, x) => a + x, 0) / abs.length;
  const worst = devs.slice().sort((a, b) => Math.abs(b.dev) - Math.abs(a.dev)).slice(0, 3);
  stat('truth.scenarios', devs.length); stat('truth.skipped', skipped);
  stat('truth.meanSignedDevPts', +(mean * 100).toFixed(2));
  stat('truth.meanAbsDevPts', +(meanAbs * 100).toFixed(2));
  stat('truth.p95AbsDevPts', +(abs[Math.floor(abs.length * 0.95)] * 100).toFixed(2));
  stat('truth.maxAbsDevPts', +(abs[abs.length - 1] * 100).toFixed(2));
  stat('truth.exactShare', +(devs.filter((d) => d.exact).length / devs.length).toFixed(2));
  stat('truth.zOver3', devs.filter((d) => Math.abs(d.z) > 3).length);
  stat('truth.worst', worst.map((d) => ({ seed: d.seed, street: d.street, n: d.players, villains: d.villains, shown: +(d.shown * 100).toFixed(1), truth: +(d.truth * 100).toFixed(1), exact: d.exact })));
  stat('truth.ms', Date.now() - t0);
})();

// ------------------------------------------- 2+3. decisions, ratings, scores
function bandOk(r) {
  const s = r.score;
  if (!Number.isInteger(s) || s < 0 || s > 100) return 'score not integer 0..100';
  if (r.rating === 'best') return s === 100 ? null : 'best without score 100';
  if (r.rating === 'good') return s >= 80 && s <= 96 ? null : 'good with score ' + s;
  if (r.rating === 'mistake') return s >= 40 && s <= 79 ? null : 'mistake with score ' + s;
  if (r.rating === 'blunder') return s >= 0 && s <= 39 ? null : 'blunder with score ' + s;
  return 'unknown rating ' + r.rating;
}
function finiteBad(r) {
  const bad = [];
  if (!Number.isFinite(r.ev.call)) bad.push('ev.call');
  if (r.ev.raise !== null && !Number.isFinite(r.ev.raise)) bad.push('ev.raise');
  if (r.ev.fold !== 0) bad.push('ev.fold');
  if (!r.summary || !Array.isArray(r.explanation) || r.explanation.length < 3 || r.explanation.length > 7) bad.push('text shape');
  for (const s of r.explanation) if (typeof s !== 'string' || !s) bad.push('empty bullet');
  for (const s of r.stats) if (/undefined|NaN/.test(s.value + s.label + s.hint)) bad.push('stat ' + s.label);
  return bad;
}
const LIVE_ROLES_UNOPENED = ['open', '3bet', '4bet', '5bet', 'limp'];
// Chart facing from the live villains' preflop roles (independent of the engine's helper).
function expectedFacing(sc) {
  const roles = sc.seats.filter((s) => !s.isHero && !s.folded).map((s) => s.preflopRole);
  if (roles.some((r) => r === '3bet' || r === '4bet' || r === '5bet')) return 'vs_3bet';
  if (roles.some((r) => r === 'open')) return 'vs_raise';
  if (roles.some((r) => r === 'limp')) return 'vs_limp';
  return 'open';
}
(function decisionSection() {
  const count = N(2200);
  const perf = [];
  const flips = { n: 0, diff: 0 };
  const vio = { bestNotArgmax: 0, bestNotBest: 0, scoreOrder: 0, foldClear: 0, trashCall: 0, premFold: 0, trash72Raise: 0, chartMismatch: 0, chartSkipped: 0, potOddsCallEV: 0 };
  const counts = { premium: 0, premFoldBest: 0, trash: 0, trashRaiseBest: 0, chart: 0, unopened72: 0, foldClearCases: 0 };
  const ratingCounts = {};
  let genErr = 0;
  for (let i = 0; i < count; i++) {
    const seed = 200000 + i;
    let sc;
    try { sc = E.generateScenario({ seed: seed }); } catch (e) { genErr++; continue; }
    const hero = sc.seats.find((s) => s.isHero);
    const t0 = process.hrtime.bigint();
    const rF = E.evaluate(sc, 'fold', undefined, { rng: mulberry(seed) });
    const rC = E.evaluate(sc, 'call', undefined, { rng: mulberry(seed) });
    const rR = E.evaluate(sc, 'raise', undefined, { rng: mulberry(seed) });
    perf.push(Number(process.hrtime.bigint() - t0) / 3e6);
    for (const [nm, r] of [['fold', rF], ['call', rC], ['raise', rR]]) {
      const bad = finiteBad(r);
      ok('outputs finite and well formed', bad.length === 0, { seed, action: nm, bad });
      const bb = bandOk(r);
      ok('score integer 0..100 and in the rating band', bb === null, { seed, action: nm, rating: r.rating, score: r.score, why: bb });
      ok('correct flag = rating best|good', r.correct === (r.rating === 'best' || r.rating === 'good'), { seed, action: nm });
    }
    const C = sc.toCall, P = sc.pot;
    const callEV = rC.ev.call;
    const raiseEV = rR.ev.raise === null ? -Infinity : rR.ev.raise;
    const expBest = raiseEV > Math.max(0, callEV) + 1e-9 ? 'raise' : callEV > 1e-9 ? 'call' : 'fold';
    // Engine decides on unrounded EVs; ours are rounded to 2 decimals, so allow 0.011 BB.
    const evOf = { fold: 0, call: callEV, raise: raiseEV };
    if (!ok('best = highest-EV action (within display rounding)', evOf[rC.best] >= (rC.raiseGated ? Math.max(0, callEV) : Math.max(0, callEV, raiseEV)) - 0.011, { seed, best: rC.best, expBest, ev: { call: callEV, raise: raiseEV } })) vio.bestNotArgmax++;
    const rBest = E.evaluate(sc, rC.best, undefined, { rng: mulberry(seed) });
    if (!ok('acting with the reported best is rated best', rBest.rating === 'best', { seed, best: rC.best, rating: rBest.rating })) vio.bestNotBest++;
    // Score must be non-decreasing in EV across the three user actions.
    // A gated raise is never the verdict, so its score is not compared on EV.
    const pts = [['fold', 0, rF.score], ['call', callEV, rC.score], ['raise', raiseEV, rR.score]].filter((p) => Number.isFinite(p[1]) && !(p[0] === 'raise' && rC.raiseGated));
    let ordBad = null;
    for (const a of pts) for (const b of pts) if (a[1] - b[1] > 0.05 && a[2] < b[2] && !ordBad && !(a[0] === 'fold' && sc.toCall <= 0)) ordBad = { seed, hi: a, lo: b };
    if (!ok('score ordering follows EV ordering', !ordBad, ordBad)) vio.scoreOrder++;
    ratingCounts[rC.rating] = (ratingCounts[rC.rating] || 0) + 1;
    // Grading stability: same input, default (unseeded) sampling, twice.
    const act = ['fold', 'call', 'raise'][i % 3];
    const ra = E.evaluate(sc, act, undefined, {});
    const rb = E.evaluate(sc, act, undefined, {});
    flips.n++;
    if (ra.rating !== rb.rating) flips.diff++;
    flips.maxScoreDelta = Math.max(flips.maxScoreDelta || 0, Math.abs(ra.score - rb.score));

    const Eng = parsePct(row(rC, 'Chance to win vs range'));
    const req = C > 0 ? C / (P + C) : 0;
    const best = rC.best;
    // Call EV must match E * realise * (pot + toCall) - toCall within display rounding.
    const heroTot = (hero.contributed || 0) + sc.heroStack;
    const covers = sc.seats.some((x) => !x.isHero && !x.folded && (x.stack + x.contributed) > heroTot + 1e-9);
    const stackOff = C > 0 && C >= sc.heroStack - 1e-9 && covers ? 0.05 : 0;
    // No implied-odds bonus (removed: it was added to calls only, see engine.js evaluate).
    const wantCall = Math.max(0, Eng * (sc.inPosition ? 1 : 0.92) - stackOff) * (P + C) - C;
    if (!ok('call EV = E * realise * (pot + toCall) - toCall', Math.abs(callEV - wantCall) <= 0.005 * (P + C) + 0.02, { seed, shown: callEV, want: wantCall })) vio.potOddsCallEV++;
    // Fold is never best when the chance to win clearly exceeds the needed chance.
    if (C > 0 && Eng - req > 0.10) {
      counts.foldClearCases++;
      if (!ok('fold never best when chance to win clearly exceeds pot odds', best !== 'fold', { seed, E: Eng, req, best, pot: P, toCall: C })) vio.foldClear++;
    }
    // Trash versus a big bet with no equity: call must not be best (its EV is negative).
    if (C > 0 && req >= 0.4 && Eng < 0.12) {
      counts.trash++;
      if (best === 'raise') counts.trashRaiseBest++;
      if (!ok('trash vs big bet: call is not best', best !== 'call', { seed, E: Eng, req, best, pot: P, toCall: C })) vio.trashCall++;
    }
    // Premium preflop hands: do not fold unless facing an extreme action (toCall >= half the stack).
    if (sc.street === 'preflop' && C > 0) {
      const prem = [['Ah', 'Ad'], ['Kh', 'Kd'], ['Qh', 'Qd'], ['Ah', 'Kh'], ['Ad', 'Ks']][i % 5];
      const sp = Object.assign({}, sc, { hero: prem });
      const r = E.evaluate(sp, 'call', undefined, { rng: mulberry(seed + 5) });
      if (C < 0.5 * hero.stack) {
        counts.premium++;
        const eP = parsePct(row(r, 'Chance to win vs range'));
        const reqP = C / (P + C);
        if (r.best === 'fold') counts.premFoldBest++;
        // A premium hand folds only when its chance to win is below the pot odds (the EV says fold).
        if (!ok('premium preflop hand folds only when chance to win is below pot odds', r.best !== 'fold' || eP < reqP + 0.05, { seed, hand: prem, pos: sc.heroPosition, toCall: C, stack: hero.stack, E: eP, req: reqP, situation: sc.situation })) vio.premFold++;
      }
    }
    // 72o: unopened pot from UTG must not be a raise.
    const live = sc.seats.filter((s) => !s.isHero && !s.folded);
    if (sc.street === 'preflop' && sc.heroPosition === 'UTG' && !live.some((s) => LIVE_ROLES_UNOPENED.indexOf(s.preflopRole) >= 0)) {
      counts.unopened72++;
      const r = E.evaluate(Object.assign({}, sc, { hero: ['7h', '2c'] }), 'call', undefined, { rng: mulberry(seed + 9) });
      if (!ok('7-2 offsuit open from UTG is not the best action', r.best !== 'raise', { seed, best: r.best, situation: sc.situation })) vio.trash72Raise++;
    }
    // Preflop verdict must agree with the range chart cell for the hero's class.
    if (sc.street === 'preflop') {
      let grid = null;
      try { grid = E.getRangeChart(sc.numPlayers, sc.heroPosition, expectedFacing(sc), { stackBB: sc.heroStack }).grid; } catch (e) { grid = null; }
      if (!grid) { vio.chartSkipped++; }
      else {
        counts.chart++;
        const hc = E.handClass(sc.hero[0], sc.hero[1]);
        const cell = grid.reduce((a, rw) => a.concat(rw), []).find((c) => c.hand === hc);
        const act2 = cell.raise ? 'Raise' : cell.call ? (C > 0 ? 'Call' : 'Check') : 'Fold';
        const hint = (rC.stats.find((s) => s.label === 'Hand percentile / chart tier') || {}).hint || '';
        if (!ok('preflop chart verdict = getRangeChart cell for the facing', hint.indexOf('Chart: ' + act2) === 0, { seed, hand: hc, pos: sc.heroPosition, n: sc.numPlayers, facing: expectedFacing(sc), expected: act2, hint, situation: sc.situation })) vio.chartMismatch++;
      }
    }
  }
  // Crafted nut hands on the river: folding must be a blunder.
  const nutTemplates = [
    { name: 'royal flush', hero: ['Ts', '3c'], board: ['As', 'Ks', 'Qs', 'Js', '2d'] },
    { name: 'four nines', hero: ['9c', 'Kd'], board: ['9s', '9h', '9d', '2c', '5h'] },
    { name: 'kings full of twos', hero: ['Kc', '7d'], board: ['2s', '2c', 'Kh', 'Kd', '7h'] },
    { name: 'nut flush, ace high', hero: ['Ah', '3c'], board: ['2h', '5h', '9h', 'Jh', 'Kd'] },
  ];
  const nutInfo = {};
  for (const tpl of nutTemplates) {
    nutInfo[tpl.name] = { tested: 0, foldRating: {} };
    for (let j = 0; j < N(20); j++) {
      const base = E.generateScenario({ seed: 300000 + j * 17 + tpl.name.length, street: 'river' });
      if (base.toCall <= 0) continue;
      const nut = Object.assign({}, base, { hero: tpl.hero, board: tpl.board });
      const rf = E.evaluate(nut, 'fold', undefined, { rng: mulberry(j) });
      const En = parsePct(row(rf, 'Chance to win vs range'));
      nutInfo[tpl.name].tested++;
      nutInfo[tpl.name].foldRating[rf.rating] = (nutInfo[tpl.name].foldRating[rf.rating] || 0) + 1;
      ok('nuts on the river: folding is a blunder (E >= 85%)', En < 0.85 || rf.rating === 'blunder', { template: tpl.name, E: En, rating: rf.rating, best: rf.best, pot: nut.pot, toCall: nut.toCall });
    }
  }
  perf.sort((a, b) => a - b);
  stat('decision.scenarios', count); stat('decision.genErrors', genErr);
  stat('perf.3evaluates.p50ms', +perf[Math.floor(perf.length * 0.5)].toFixed(1));
  stat('perf.3evaluates.p95ms', +perf[Math.floor(perf.length * 0.95)].toFixed(1));
  stat('perf.3evaluates.maxms', +perf[perf.length - 1].toFixed(1));
  stat('perf.note', 'wall time of the three evaluate() calls (fold, call, raise) per scenario; budget is 150 ms per call');
  stat('ratings.distributionCallAction', ratingCounts);
  stat('grading.unseededRatingFlipRate', +(flips.diff / flips.n).toFixed(3));
  stat('grading.unseededMaxScoreDelta', flips.maxScoreDelta);
  stat('premium.checked', counts.premium); stat('premium.foldBest', counts.premFoldBest);
  stat('trash.checked', counts.trash); stat('trash.raiseBest(bluff)', counts.trashRaiseBest);
  stat('chart.checked', counts.chart); stat('chart.skippedNoChart', vio.chartSkipped);
  stat('unopenedUTG.checked', counts.unopened72);
  stat('foldClear.checked', counts.foldClearCases);
  stat('nuts', nutInfo);
  stat('decision.violations', vio);
})();

// ----------------------------------------------------- 2b. monotonicity/charts
(function monotoneSection() {
  const pctOpen = {};
  for (let n = 2; n <= 9; n++) for (const p of E.POSITIONS[n]) {
    if (p === 'BB') continue;
    let g = null;
    try { g = E.getRangeChart(n, p, 'open').grid; } catch (e) { g = null; }
    if (!g) continue;
    let combos = 0;
    for (const rw of g) for (const c of rw) {
      const w = c.hand.length === 2 ? 6 : c.hand.endsWith('s') ? 4 : 12;
      if (c.raise) combos += w;
    }
    pctOpen[n + '|' + p] = combos / 1326;
  }
  const ex1 = [];
  let mono1 = true;
  for (const p of ['UTG', 'MP', 'CO', 'BTN', 'HJ', 'LJ', 'UTG+1']) {
    const ns = [];
    for (let n = 2; n <= 9; n++) if (pctOpen[n + '|' + p] !== undefined) ns.push(n);
    for (let i = 1; i < ns.length; i++) {
      const a = pctOpen[ns[i - 1] + '|' + p], b = pctOpen[ns[i] + '|' + p];
      if (b > a + 1e-9) { mono1 = false; ex1.push({ pos: p, from: ns[i - 1], to: ns[i], pct: [+a.toFixed(3), +b.toFixed(3)] }); }
    }
  }
  ok('chart: more players => same or tighter open range at a position', mono1, ex1.slice(0, 4));
  const order = ['UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO', 'BTN'];
  const ex2 = [];
  let mono2 = true;
  for (let n = 3; n <= 9; n++) {
    const ps = order.filter((p) => pctOpen[n + '|' + p] !== undefined);
    for (let i = 1; i < ps.length; i++) {
      const a = pctOpen[n + '|' + ps[i - 1]], b = pctOpen[n + '|' + ps[i]];
      if (b + 1e-9 < a) { mono2 = false; ex2.push({ n: n, from: ps[i - 1], to: ps[i], pct: [+a.toFixed(3), +b.toFixed(3)] }); }
    }
  }
  ok('chart: later position => same or looser open range', mono2, ex2.slice(0, 4));
  stat('chart.openPctAt6max', ['UTG', 'HJ', 'CO', 'BTN', 'SB'].map((p) => p + ' ' + Math.round((pctOpen['6|' + p] || 0) * 100) + '%').join(', '));
  stat('chart.openPctSB_vs_CO_at9', 'SB ' + Math.round((pctOpen['9|CO'] || 0) * 100) + '% (CO) vs SB chart not in 9-max grid');
  // Bigger bet => more chance to win needed.
  let bigOk = true; const bEx = [];
  for (let i = 0; i < N(200); i++) {
    const sc = E.generateScenario({ seed: 500000 + i, street: 'flop' });
    const P0 = sc.pot - sc.toCall;
    let prev = -1;
    for (const f of [0.25, 0.5, 1, 2]) {
      const bet = f * P0;
      const s2 = Object.assign({}, sc, { pot: P0 + bet, toCall: bet });
      const r = E.evaluate(s2, 'call', undefined, { rng: mulberry(i) });
      const req = parsePct(row(r, 'Pot odds (needed chance)'));
      if (req < prev - 1e-9) { bigOk = false; bEx.push({ seed: 500000 + i, f, req }); }
      prev = req;
    }
  }
  ok('bigger bet => needs more chance to win (pot odds rise)', bigOk, bEx.slice(0, 3));
})();

// ----------------------------------------------------- 4. scenario validity
(function validitySection() {
  const count = N(3000);
  const coverage = { n: {}, pos: {}, street: {}, style: {}, sit: {} };
  let errors = 0;
  const examples = [];
  const streets = ['preflop', 'flop', 'turn', 'river'];
  for (let i = 0; i < count; i++) {
    const opts = { seed: 700000 + i };
    if (i % 3 === 1) opts.players = 2 + (i % 8);
    if (i % 4 === 2) opts.street = streets[(i >> 2) % 4];
    let sc;
    try { sc = E.generateScenario(opts); } catch (e) { errors++; if (examples.length < 3) examples.push('throw ' + e.message); continue; }
    coverage.n[sc.numPlayers] = (coverage.n[sc.numPlayers] || 0) + 1;
    coverage.street[sc.street] = (coverage.street[sc.street] || 0) + 1;
    const pk = sc.numPlayers + ':' + sc.heroPosition;
    coverage.pos[pk] = (coverage.pos[pk] || 0) + 1;
    for (const s of sc.seats) if (!s.isHero) coverage.style[s.style] = (coverage.style[s.style] || 0) + 1;
    const sk = sc.situation.split(',')[0].replace(/\d+/g, '#');
    coverage.sit[sk] = (coverage.sit[sk] || 0) + 1;
    const probs = validateScenario(sc, 'seed ' + (700000 + i));
    if (!ok('scenario validity (pot, positions, cards, toCall, inPosition, raise options)', probs.length === 0, probs.slice(0, 3)) && examples.length < 6) examples.push(probs[0]);
    ok('generator honours street and player options', (!opts.street || opts.street === sc.street) && (!opts.players || opts.players === sc.numPlayers), { opts });
  }
  const missing = [];
  for (let n = 2; n <= 9; n++) for (const p of E.POSITIONS[n]) if (!coverage.pos[n + ':' + p]) missing.push(n + ':' + p);
  if (count >= 3000) ok('every position of every table size is generated', missing.length === 0, missing);
  else stat('coverage.note', 'position coverage not asserted at this sample size (' + count + ')');
  ok('generator never throws', errors === 0, { errors: errors });
  stat('validity.scenarios', count); stat('validity.errors', errors); stat('validity.examples', examples);
  stat('coverage.players', coverage.n); stat('coverage.streets', coverage.street); stat('coverage.villainStyles', coverage.style);
  stat('coverage.situationKinds', coverage.sit);
})();

// ------------------------------------------------- 4b. full-hand simulations
(function gameSection() {
  const sessions = N(160);
  const viol = { chips: 0, negStack: 0, illegalRaise: 0, foldFree: 0, pots: 0, notToAct: 0, throws: 0, scenarioBad: 0, evalBad: 0 };
  const examples = {};
  const note = (k, v) => { viol[k]++; if (!examples[k]) examples[k] = v; };
  let hands = 0, actions = 0;
  for (let si = 0; si < sessions; si++) {
    const rng = mulberry(900000 + si);
    const cpus = 1 + Math.floor(rng() * 8);
    const randomness = [0, 0.15, 0.5, 1][si % 4];
    const allBots = si % 2 === 0;
    const s = G.newSession({ cpus: cpus, randomness: randomness, seed: 1000 + si, allBots: allBots, stackBB: [10, 100, 1000][si % 3], money: si % 5 !== 0 });
    const initTotal = G.totalChips(s);
    for (let h = 0; h < 30 && !s.over; h++) {
      let hand = null;
      try { hand = G.startHand(s, { players: si % 3 === 0 ? undefined : 2 + Math.floor(rng() * 8) }); }
      catch (e) { note('throws', 'startHand: ' + e.message); break; }
      if (!hand) break;
      hands++;
      let guard = 0;
      while (!G.isHandOver(s) && guard++ < 400) {
        const idx = G.toAct(s);
        if (idx == null) { note('notToAct', 'no seat to act, hand ' + hand.no); break; }
        const L = G.legal(s, idx);
        let ev = null;
        try {
          if (idx === 0 && !s.seats[0].isBot) {
            const sc = G.buildScenario(s, 0);
            const probs = validateScenario(sc, 'game hand ' + hand.no);
            if (probs.length) note('scenarioBad', probs[0]);
            const r = E.evaluate(sc, 'call', undefined, { rng: mulberry(h) });
            if (!Number.isFinite(r.ev.call)) note('evalBad', 'ev not finite on game scenario');
            const u = rng();
            if (u < 0.2 && L.toCall > 0) ev = G.act(s, 0, 'fold');
            else if (u < 0.5 && L.canRaise) {
              const amt = Math.max(L.minRaiseTo, Math.min(L.maxRaiseTo, Math.round(L.curBet + rng() * (L.maxRaiseTo - L.curBet))));
              ev = G.act(s, 0, 'raise', amt);
            } else ev = G.act(s, 0, 'call');
          } else {
            ev = G.stepBot(s);
          }
        } catch (e) { note('throws', e.message); break; }
        actions++;
        if (ev.action === 'fold' && L.toCall === 0) note('foldFree', 'fold with a free check, hand ' + hand.no);
        if (ev.action === 'raise') {
          const legal = (ev.amount >= L.minRaiseTo - 1e-9 || Math.abs(ev.amount - L.maxRaiseTo) < 1e-9) && ev.amount <= L.maxRaiseTo + 1e-9;
          if (!legal) note('illegalRaise', { hand: hand.no, amt: ev.amount, min: L.minRaiseTo, max: L.maxRaiseTo });
        }
        if (s.seats.some((x) => x.stack < 0 || !Number.isInteger(x.stack))) note('negStack', s.seats.map((x) => x.stack).join(','));
        if (G.totalChips(s) !== initTotal) note('chips', 'total ' + G.totalChips(s) + ' vs ' + initTotal + ' after ' + ev.text);
      }
      if (guard >= 400) note('throws', 'hand ' + hand.no + ' did not finish');
      const hh = s.hand;
      const contrib = hh.seats.reduce((a, x) => a + x.contributed, 0);
      const potSum = hh.results.pots.reduce((a, p) => a + p.amount, 0);
      const winSum = Object.keys(hh.results.wins).reduce((a, k) => a + hh.results.wins[k], 0);
      if (contrib !== potSum || contrib !== winSum) note('pots', 'contributed ' + contrib + ', pots ' + potSum + ', paid ' + winSum);
      for (const p of hh.results.pots) if (!p.winners.every((w) => p.eligible.indexOf(w) >= 0)) note('pots', 'winner not eligible in hand ' + hand.no);
    }
  }
  ok('game: chips conserved after every action', viol.chips === 0, examples.chips);
  ok('game: stacks are non-negative integers', viol.negStack === 0, examples.negStack);
  ok('game: raises legal (minimum raise, or all-in)', viol.illegalRaise === 0, examples.illegalRaise);
  ok('game: never a fold when check is free', viol.foldFree === 0, examples.foldFree);
  ok('game: pots = contributions = payouts; winners eligible', viol.pots === 0, examples.pots);
  ok('game: a seat is always to act until the hand ends', viol.notToAct === 0, examples.notToAct);
  ok('game: no exceptions during play', viol.throws === 0, examples.throws);
  ok('game: hero scenario passes the validity checks', viol.scenarioBad === 0, examples.scenarioBad);
  ok('game: engine evaluates game scenarios', viol.evalBad === 0, examples.evalBad);
  stat('game.sessions', sessions); stat('game.hands', hands); stat('game.actions', actions);
  const s = G.newSession({ cpus: 3, randomness: 0, seed: 5, allBots: false });
  G.startHand(s, { players: 4 });
  let rejected = true;
  if (G.toAct(s) === 0) {
    const L = G.legal(s, 0);
    if (L.canRaise && L.minRaiseTo + 0.5 < L.maxRaiseTo) {
      rejected = false;
      try { G.act(s, 0, 'raise', L.curBet); } catch (e) { rejected = true; }
    }
  }
  ok('game: act() rejects a raise to the current bet', rejected, 'accepted an illegal raise');
})();

// --------------------------------------------------- 5. language and wording
(function languageSection() {
  const BANNED = /equit(y|ies)|equidad/i;
  const count = N(700);
  let shapeDiff = 0, same = 0, banned = 0, placeholders = 0, esEnglish = 0;
  const ex = { banned: [], placeholders: [], esEnglish: [] };
  const EN_WORDS = /\b(the|you|with|versus|fold|call|raise|check|your|is|pot)\b/i;
  for (let i = 0; i < count; i++) {
    const seed = 800000 + i;
    const sc = E.generateScenario({ seed: seed });
    const en = E.evaluate(sc, 'call', undefined, { lang: 'en', rng: mulberry(seed) });
    const es = E.evaluate(sc, 'call', undefined, { lang: 'es', rng: mulberry(seed) });
    const flat = (r) => [r.summary].concat(r.explanation, r.stats.flatMap((x) => [x.label, x.value, x.hint]));
    const fe = flat(en), fs2 = flat(es);
    if (fe.length !== fs2.length || en.stats.length !== es.stats.length) shapeDiff++;
    if (fe.join('|') === fs2.join('|')) same++;
    for (const t of fe.concat(fs2)) {
      if (BANNED.test(t)) { banned++; if (ex.banned.length < 3) ex.banned.push(t); }
      if (!t || /[{}]|undefined|NaN|null/.test(t)) { placeholders++; if (ex.placeholders.length < 3) ex.placeholders.push(t); }
    }
    if (fs2.some((t) => EN_WORDS.test(t))) { esEnglish++; if (ex.esEnglish.length < 4) ex.esEnglish.push(fs2.find((t) => EN_WORDS.test(t)).slice(0, 140)); }
  }
  ok('language: en and es outputs have the same structure', shapeDiff === 0, shapeDiff);
  ok('language: es output is not the English text', same === 0, same);
  ok('language: no "equity"/"equidad" in engine output', banned === 0, ex.banned);
  ok('language: no empty strings, placeholders or undefined', placeholders === 0, ex.placeholders);
  stat('language.esStringsWithEnglishWords', esEnglish + ' of ' + count + ' scenarios');
  stat('language.esEnglishSamples', ex.esEnglish);
  const en = Object.keys(E.i18n.en), es = Object.keys(E.i18n.es);
  const onlyEn = en.filter((k) => es.indexOf(k) < 0), onlyEs = es.filter((k) => en.indexOf(k) < 0);
  ok('engine i18n: en and es keys identical', onlyEn.length === 0 && onlyEs.length === 0, { onlyEn, onlyEs });
  const ui = fs.readFileSync(path.join(PUB, 'i18n.js'), 'utf8');
  const enBlock = ui.slice(ui.indexOf('var EN = {'), ui.indexOf('var ES = {'));
  const esBlock = ui.slice(ui.indexOf('var ES = {'), ui.indexOf('var DICT'));
  const keysOf = (b) => { const set = new Set(); const re = /'([\w.+-]+)'\s*:/g; let m; while ((m = re.exec(b))) set.add(m[1]); return set; };
  const uEn = keysOf(enBlock), uEs = keysOf(esBlock);
  const dA = [...uEn].filter((k) => !uEs.has(k)), dB = [...uEs].filter((k) => !uEn.has(k));
  ok('UI i18n: en and es keys identical', dA.length === 0 && dB.length === 0, { onlyEn: dA.slice(0, 10), onlyEs: dB.slice(0, 10) });
  const appSrc = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8') + fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const used = new Set();
  let m;
  const tRe = /\bt\(\s*'([\w.+-]+)'/g; while ((m = tRe.exec(appSrc))) used.add(m[1]);
  const dRe = /data-i18n(?:-aria|-title)?="([\w.+-]+)"/g; while ((m = dRe.exec(appSrc))) used.add(m[1]);
  // Keys ending in "." are built at run time (t('posName.' + pos)); require at least one real key per prefix.
  const dynamic = [...used].filter((k) => k.endsWith('.'));
  const missingUi = [...used].filter((k) => !k.endsWith('.') && (!uEn.has(k) || !uEs.has(k)))
    .concat(dynamic.filter((p) => ![...uEn].some((k) => k.startsWith(p)) || ![...uEs].some((k) => k.startsWith(p))));
  ok('UI i18n: every key used by app.js / index.html exists in en and es', missingUi.length === 0, missingUi.slice(0, 10));
  stat('ui.keysUsed', used.size);
})();

// ----------------------------------------------------------------- report
const failing = Object.keys(REC).filter((k) => REC[k].fail > 0);
const out = { stats: STATS, checks: {} };
for (const k of Object.keys(REC)) out.checks[k] = { n: REC[k].n, fail: REC[k].fail, ex: REC[k].ex };
console.log(JSON.stringify(out, null, 1));
console.log('\nSUMMARY: ' + Object.keys(REC).length + ' checks, ' + failing.length + ' with failures');
for (const k of failing) console.log('  FAIL ' + k + ': ' + REC[k].fail + ' of ' + REC[k].n);
if (failing.length) process.exitCode = 1;
