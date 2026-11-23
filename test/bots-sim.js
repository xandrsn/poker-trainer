'use strict';
// Headless bot stress test. Plays hands with the real table flow (public/game.js), seeded RNG, every
// bot seat decided by a bots module (env BOTS = path, default public/bots.js). Reference "heroes"
// (strategy seats) use simple rules. Measures per personality and per hero: BB/100, VPIP, PFR,
// all-in call stats (win chance vs random hand and vs a top-20% shove range), fold-to-bet, folds of
// strong hands, bluff rate, bet sizing, overbets, aggression, showdown win %, decisions per second.
// Run: node test/bots-sim.js [quick|full]   env: BOTS=<bots.js path>, SIM_HANDS, SIM_SEED, SIM_OUT=<json>.
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const E = require(path.join(ROOT, 'public', 'engine.js'));
const G = require(path.join(ROOT, 'public', 'game.js'));
const BOTS_PATH = process.env.BOTS ? path.resolve(process.env.BOTS) : path.join(ROOT, 'public', 'bots.js');
const Bots = require(BOTS_PATH);

const MODE = process.argv[2] || 'quick';
const HANDS = Number(process.env.SIM_HANDS) || (MODE === 'full' ? 3000 : 300);
const SEED = Number(process.env.SIM_SEED) || 20260610;
const BB = 100;
const START = 100 * BB; // every seat starts each hand at 100 BB
const TYPES = Bots.TYPES;
const STRATS = ['solid', 'station', 'maniac', 'shover', 'caller', 'nit'];

function rngFrom(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// Combo weights (engine index order) for the top 20% of hands by preflop percentile: a shove range.
function comboIdx(lo, hi) {
  let idx = 0;
  for (let a = 0; a < lo; a++) idx += 51 - a;
  return idx + (hi - lo - 1);
}
const SHOVE = (function () {
  const w = new Float64Array(1326);
  const cards = [];
  for (const r of '23456789TJQKA') for (const s of 'cdhs') cards.push(r + s);
  for (let i = 0; i < 52; i++) for (let j = i + 1; j < 52; j++) {
    const a = E.parseCard(cards[i]), b = E.parseCard(cards[j]);
    w[comboIdx(Math.min(a, b), Math.max(a, b))] = E.preflopPercentile(cards[i], cards[j]) <= 0.2 ? 1 : 0;
  }
  return w;
})();

// ----------------------------------------------------------------- reference heroes
// Each returns { action: 'fold'|'call'|'raise', amount (BB) } from the decision context ctx.
function makeStrategy(name, seed) {
  const rng = rngFrom(seed);
  const eqRand = (ctx) => E.equity(ctx.hero, ctx.board, Math.max(1, ctx.numOpp), { samples: 200, rng: rng });
  const pctOf = (ctx) => E.preflopPercentile(ctx.hero[0], ctx.hero[1]);
  const raiseBB = (ctx) => (ctx.L.curBet > 0 ? ctx.L.curBet * 3 : 2.5);
  const betTo = (ctx, f) => ctx.L.curBet + f * (ctx.pot + ctx.L.toCall);
  return function (ctx) {
    const L = ctx.L;
    const canR = L.canRaise;
    if (name === 'shover') return canR ? { action: 'raise', amount: L.maxRaiseTo } : { action: 'call' };
    if (name === 'caller') return { action: 'call' };
    const pct = pctOf(ctx);
    if (ctx.street === 'preflop') {
      if (name === 'station') return canR && pct <= 0.04 ? { action: 'raise', amount: raiseBB(ctx) } : { action: 'call' };
      if (name === 'maniac') {
        if (canR && (rng() < 0.7 || pct <= 0.3)) return { action: 'raise', amount: raiseBB(ctx) };
        return { action: 'call' };
      }
      if (name === 'nit') {
        if (canR && pct <= 0.07) return { action: 'raise', amount: raiseBB(ctx) };
        if (L.toCall <= 0) return { action: 'call' };
        return pct <= 0.04 ? { action: 'call' } : { action: 'fold' };
      }
      // solid: open the top 15% (25% from CO/BTN/SB), 3-bet the top 5%, call a raise with the top 9%.
      const late = ['CO', 'BTN', 'SB'].indexOf(ctx.position) >= 0;
      if (canR && L.curBet <= 1.0001 && pct <= (late ? 0.25 : 0.15)) return { action: 'raise', amount: 2.5 };
      if (canR && L.curBet > 1.0001 && L.curBet < 6 && pct <= 0.05) return { action: 'raise', amount: L.curBet * 3 };
      if (L.toCall <= 0) return { action: 'call' };
      if (L.curBet > 1.0001 && pct <= 0.09) return { action: 'call' };
      if (L.toCall <= 1.0001 && pct <= 0.4) return { action: 'call' };
      return { action: 'fold' };
    }
    const eq = eqRand(ctx);
    const P = ctx.pot, C = L.toCall;
    if (name === 'station') {
      if (canR && eq > 0.8) return { action: 'raise', amount: betTo(ctx, 0.7) };
      return { action: 'call' };
    }
    if (name === 'maniac') {
      if (canR && (eq > 0.25 || rng() < 0.75)) return { action: 'raise', amount: betTo(ctx, 1.0) };
      return C > 0 && eq < 0.15 && rng() < 0.6 ? { action: 'fold' } : { action: 'call' };
    }
    if (name === 'nit') {
      if (C <= 0) return canR && eq > 0.75 ? { action: 'raise', amount: betTo(ctx, 0.6) } : { action: 'call' };
      if (eq >= 0.8 && canR) return { action: 'raise', amount: betTo(ctx, 0.9) };
      return eq >= C / (P + C) + 0.15 ? { action: 'call' } : { action: 'fold' };
    }
    // solid: value bet 0.66 pot at 62%+ equity, call with pot odds + 5%, raise at 78%+.
    if (C <= 0) return canR && eq >= 0.62 ? { action: 'raise', amount: betTo(ctx, 0.66) } : { action: 'call' };
    if (canR && eq >= 0.78) return { action: 'raise', amount: betTo(ctx, 1.0) };
    return eq >= C / (P + C) + 0.05 ? { action: 'call' } : { action: 'fold' };
  };
}

// ----------------------------------------------------------------- table simulation
function newStats() {
  return {
    seatHands: 0, bbProfit: 0, vpipN: 0, pfrN: 0, decisions: 0, decisionMs: 0,
    facingBet: 0, foldedToBet: 0, pfBetsRaises: 0, pfBluffs: 0, pfFoldsNuts: 0, pfFoldsTotal: 0,
    allInCalls: 0, allInEqRand: 0, allInEqShove: 0, allInBelowShove: 0,
    callOff40Total: 0, callOff40Low: 0, betFracSum: 0, betFracN: 0, overbets: 0,
    aggrNum: 0, aggrDen: 0, showdowns: 0, showdownWins: 0,
    raiseByStreet: {}, bluffByStreet: {}, allInRaises: 0, allInBelowMedian: 0, riverRaises: 0, riverAirRaises: 0,
    riverAirOverPot: 0, riverAirShoves: 0, bigBluffShoves: 0,
  };
}
function toBB(chips) { return Math.round(chips) / BB; }
function snapBB(x) { return Math.round(x * 2) / 2; }

// Plays `hands` hands at one table. seatSpecs[i]: {kind:'bot', type} or {kind:'strat', name}.
// Stats accumulate into statsBy[label] (label = personality type or strategy name).
function runTable(seatSpecs, hands, seed, bots, statsBy) {
  const session = G.newSession({ cpus: seatSpecs.length - 1, allBots: true, stackBB: 100, stacks: 'equal',
    seed: seed, personalities: TYPES });
  const strategies = {};
  seatSpecs.forEach((sp, i) => {
    const seat = session.seats[i];
    if (sp.kind === 'bot') {
      const p = Bots.PERSONAS.filter((x) => x.type === sp.type)[0];
      seat.persona = { name: p.name, type: p.type, looseness: p.looseness, aggression: p.aggression };
      seat.isBot = true;
    } else {
      seat.persona = null;
      seat.isBot = false;
      strategies[i] = makeStrategy(sp.name, (seed * 31 + i * 7919) >>> 0);
    }
  });
  const labelOf = (i) => (seatSpecs[i].kind === 'bot' ? seatSpecs[i].type : seatSpecs[i].name);
  const statOf = (i) => statsBy[labelOf(i)] || (statsBy[labelOf(i)] = newStats());
  const rng = rngFrom(seed ^ 0x5bd1e995);
  for (let h = 0; h < hands; h++) {
    // Every hand starts from fresh 100 BB stacks: clear the session-over flag a busted hero would set.
    session.seats.forEach((s) => { s.stack = START; s.busted = false; });
    session.over = null;
    if (!G.startHand(session, {})) throw new Error('startHand returned no hand');
    const hand = session.hand;
    const dealt = hand.seats.map((hs) => !!hs.dealt);
    const vpip = {}, pfr = {};
    let guard = 0;
    while (!G.isHandOver(session)) {
      if (++guard > 500) throw new Error('hand did not finish');
      const idx = G.toAct(session);
      const seat = session.seats[idx];
      const L = G.legal(session, idx);
      const sc = G.buildScenario(session, idx);
      const st = statOf(idx);
      const Lb = { toCall: toBB(L.toCall), curBet: toBB(L.curBet), minRaiseTo: toBB(L.minRaiseTo),
        maxRaiseTo: toBB(L.maxRaiseTo), canRaise: L.canRaise, canCheck: L.canCheck };
      const heroStackBB = toBB(session.seats[idx].stack);
      const potBB = sc.pot;
      const allInCall = Lb.toCall > 0 && Lb.toCall >= heroStackBB - 1e-9;
      const numOpp = sc.seats.filter((x) => !x.isHero && !x.folded && !x.busted).length;
      let d;
      if (seat.isBot) {
        const t0 = process.hrtime.bigint();
        d = bots.decide({ scenario: sc, key: hand.no + ':' + hand.actions, legal: Lb },
          { index: idx, type: seat.persona.type, looseness: seat.persona.looseness, aggression: seat.persona.aggression },
          { seed: session.cfg.seed });
        st.decisionMs += Number(process.hrtime.bigint() - t0) / 1e6;
      } else {
        d = strategies[idx]({ hero: sc.hero, board: sc.board, pot: potBB, L: Lb, street: sc.street,
          position: sc.heroPosition, numOpp: numOpp });
      }
      let action = d.action, amount = null;
      if (action === 'fold' && Lb.toCall <= 1e-9) action = 'call';
      if (action === 'raise') {
        if (!L.canRaise) action = 'call';
        else amount = Math.max(L.minRaiseTo, Math.min(snapBB(d.amount) * BB, L.maxRaiseTo));
      }
      // ---- statistics (decision as taken, before it is applied)
      st.decisions++;
      const postflop = sc.street !== 'preflop';
      const callPaid = action === 'call' && Lb.toCall > 0;
      if (!postflop) {
        if (action === 'raise') { vpip[idx] = true; pfr[idx] = true; }
        if (callPaid) vpip[idx] = true;
      } else {
        if (Lb.toCall > 0) { st.facingBet++; if (action === 'fold') st.foldedToBet++; }
        if (action === 'raise') {
          st.aggrNum++;
          const frac = amount / BB / Math.max(potBB, 0.01);
          st.betFracSum += frac; st.betFracN++;
          if (frac > 1.0001) st.overbets++;
        } else if (callPaid) st.aggrDen++;
      }
      // Win chance (vs a random hand and vs a top-20% shove range) for all-in calls on any street, bluffs, and
      // folds of strong hands; the all-in test covers preflop too.
      const needEq = allInCall || action === 'raise' || (postflop && ((action === 'fold' && Lb.toCall > 0) ||
        (callPaid && Lb.toCall >= 0.4 * heroStackBB)));
      if (needEq) {
        const eqR = E.equity(sc.hero, sc.board, Math.max(1, numOpp), { samples: 200, rng: rng });
        if (action === 'raise') {
          // Raise analysis by street: bluff = win chance under 30% (no showdown value to speak of).
          const streetKey = sc.street === 'preflop' ? 'pre' : sc.street;
          st.raiseByStreet[streetKey] = (st.raiseByStreet[streetKey] || 0) + 1;
          if (eqR < 0.3) st.bluffByStreet[streetKey] = (st.bluffByStreet[streetKey] || 0) + 1;
          const ratio = amount / BB; // raise-to in BB
          const isAllIn = amount >= L.maxRaiseTo - 1e-9;
          if (isAllIn) {
            st.allInRaises++;
            if (eqR < 0.5) st.allInBelowMedian++;
          }
          if (sc.street === 'river') {
            st.riverRaises++;
            if (eqR < 0.3) { st.riverAirRaises++; if (ratio >= potBB) st.riverAirOverPot++; }
            if (isAllIn && eqR < 0.3) st.riverAirShoves++;
          }
          if (isAllIn && eqR < 0.3 && heroStackBB > 0) st.bigBluffShoves++;
        }
        if (postflop && action === 'raise') { st.pfBetsRaises++; if (eqR < 0.35) st.pfBluffs++; }
        if (postflop && action === 'fold' && Lb.toCall > 0) { st.pfFoldsTotal++; if (eqR > 0.8) st.pfFoldsNuts++; }
        if (allInCall) {
          const eqS = E.equity(sc.hero, sc.board, [SHOVE], { samples: 200, rng: rng });
          st.allInCalls++;
          st.allInEqRand += eqR;
          st.allInEqShove += eqS;
          if (eqS < Lb.toCall / (potBB + Lb.toCall)) st.allInBelowShove++;
        }
        if (postflop && callPaid && Lb.toCall >= 0.4 * heroStackBB) { st.callOff40Total++; if (eqR < 0.4) st.callOff40Low++; }
      }
      // ---- apply
      if (action === 'fold') G.act(session, idx, 'fold');
      else if (action === 'call') G.act(session, idx, 'call');
      else G.act(session, idx, 'raise', amount);
    }
    const res = G.results(session);
    hand.seats.forEach((hs, i) => {
      if (!dealt[i]) return;
      const st = statOf(i);
      st.seatHands++;
      st.bbProfit += (session.seats[i].stack - START) / BB;
      if (vpip[i]) st.vpipN++;
      if (pfr[i]) st.pfrN++;
      if (res && res.showdown && !hs.folded) { st.showdowns++; if ((res.wins[i] || 0) > 0) st.showdownWins++; }
    });
  }
  return statsBy;
}

// ----------------------------------------------------------------- summaries
function round(x, d) { const p = Math.pow(10, d); return Math.round(x * p) / p; }
function summarize(stats) {
  const out = {};
  Object.keys(stats).forEach((k) => {
    const s = stats[k];
    const sh = Math.max(1, s.seatHands);
    const pct = (a, b) => round(100 * a / Math.max(1, b), 1);
    out[k] = {
      seatHands: s.seatHands,
      bb100: round(s.bbProfit / sh * 100, 1),
      vpip: pct(s.vpipN, sh), pfr: pct(s.pfrN, sh),
      foldToBet: pct(s.foldedToBet, s.facingBet),
      allInCalls: s.allInCalls,
      allInEqRand: pct(s.allInEqRand, s.allInCalls),
      allInEqShove: pct(s.allInEqShove, s.allInCalls),
      allInBelowOdds: pct(s.allInBelowShove, s.allInCalls),
      callOff40LowEq: pct(s.callOff40Low, s.callOff40Total),
      nutsFoldPct: pct(s.pfFoldsNuts, s.pfFoldsTotal),
      bluffPct: pct(s.pfBluffs, s.pfBetsRaises),
      avgBetPot: round(s.betFracSum / Math.max(1, s.betFracN), 2),
      overbetPct: pct(s.overbets, s.betFracN),
      aggression: round(s.aggrNum / Math.max(1, s.aggrDen), 2),
      sdWinPct: pct(s.showdownWins, s.showdowns),
      bluffFlopPct: pct(s.bluffByStreet.flop || 0, s.raiseByStreet.flop || 0),
      bluffTurnPct: pct(s.bluffByStreet.turn || 0, s.raiseByStreet.turn || 0),
      bluffRiverPct: pct(s.bluffByStreet.river || 0, s.raiseByStreet.river || 0),
      bluffPrePct: pct(s.bluffByStreet.pre || 0, s.raiseByStreet.pre || 0),
      riverRaiseAirPct: pct(s.riverAirRaises, s.riverRaises),
      riverAirOverPotPct: pct(s.riverAirOverPot, s.riverRaises),
      riverAirShovePct: pct(s.riverAirShoves, s.riverRaises),
      allInBelowMedianPct: pct(s.allInBelowMedian, s.allInRaises),
      bigBluffShovesPerHand: round(s.bigBluffShoves / Math.max(1, s.seatHands), 4),
      decPerSec: s.decisionMs > 0 ? Math.round(s.decisions / (s.decisionMs / 1000)) : null,
    };
  });
  return out;
}

function randomBots(n, rng) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ kind: 'bot', type: TYPES[Math.floor(rng() * TYPES.length)] });
  return out;
}

function runSuite(bots, opts) {
  const hands = opts.hands, seed = opts.seed;
  const rng = rngFrom(seed);
  const res = { meta: { mode: MODE, hands: hands, seed: seed, bots: BOTS_PATH }, sections: {} };
  const t0 = Date.now();
  // 1. Heads-up round robin, bot vs bot (both seats share one stats object per personality).
  const hu = {};
  for (let a = 0; a < TYPES.length; a++) for (let b = a + 1; b < TYPES.length; b++) {
    const sb = {};
    runTable([{ kind: 'bot', type: TYPES[a] }, { kind: 'bot', type: TYPES[b] }], hands, (seed + a * 97 + b * 13) >>> 0, bots, sb);
    hu[TYPES[a] + ' vs ' + TYPES[b]] = summarize(sb);
  }
  res.sections.headsUp = hu;
  // 2. Mixed tables of 3, 6 and 9 seats with random personalities.
  [[3, 'table3'], [6, 'table6'], [9, 'table9']].forEach(([n, name]) => {
    const all = {};
    const tables = Math.max(1, Math.round(hands / 60));
    for (let t = 0; t < tables; t++) {
      runTable(randomBots(n, rng), Math.max(20, Math.round(hands / tables)), (seed + 1000 + t * 7919 + n) >>> 0, bots, all);
    }
    res.sections[name] = summarize(all);
  });
  // 3. Exploit tests: one reference hero among five random bots (6-max), and heads-up vs each personality.
  const expl = {};
  STRATS.forEach((sname) => {
    const six = {};
    const tables = Math.max(1, Math.round(hands / 60));
    for (let t = 0; t < tables; t++) {
      runTable([{ kind: 'strat', name: sname }].concat(randomBots(5, rng)),
        Math.max(20, Math.round(hands / tables)), (seed + 5000 + t * 104729 + sname.length) >>> 0, bots, six);
    }
    expl[sname + ' vs 6max'] = summarize(six);
    const hu1 = {};
    TYPES.forEach((ty) => {
      const sb = {};
      runTable([{ kind: 'strat', name: sname }, { kind: 'bot', type: ty }], hands,
        (seed + 9000 + ty.length * 31 + sname.length) >>> 0, bots, sb);
      hu1[ty] = summarize(sb);
    });
    expl[sname + ' vs HU'] = hu1;
  });
  res.sections.exploits = expl;
  res.meta.seconds = Math.round((Date.now() - t0) / 1000);
  return res;
}

if (require.main === module) {
  const res = runSuite(Bots, { hands: HANDS, seed: SEED });
  if (process.env.SIM_OUT) fs.writeFileSync(process.env.SIM_OUT, JSON.stringify(res, null, 2));
  console.log('bots: ' + BOTS_PATH + '  hands/config: ' + HANDS + '  seconds: ' + res.meta.seconds);
  const cols = ['bb100', 'vpip', 'pfr', 'foldToBet', 'allInCalls', 'allInEqRand', 'allInEqShove', 'allInBelowOdds',
    'callOff40LowEq', 'nutsFoldPct', 'bluffPct', 'avgBetPot', 'overbetPct', 'aggression', 'sdWinPct', 'decPerSec'];
  console.log('\n6-max mixed tables, per personality:');
  console.log(['type'].concat(cols).join('\t'));
  TYPES.forEach((t) => {
    const r = res.sections.table6[t];
    if (r) console.log([t].concat(cols.map((c) => r[c])).join('\t'));
  });
  console.log('\nExploit: reference hero BB/100 in a 6-max table, and heads-up vs each personality:');
  STRATS.forEach((s) => {
    const six = res.sections.exploits[s + ' vs 6max'][s];
    const hu1 = res.sections.exploits[s + ' vs HU'];
    console.log('  ' + s.padEnd(8) + ' 6max ' + String(six ? six.bb100 : 'n/a').padStart(7) + '   HU vs ' +
      TYPES.map((t) => t + ' ' + (hu1[t][s] ? hu1[t][s].bb100 : 'n/a')).join(', '));
  });
}

module.exports = { runSuite: runSuite, summarize: summarize, runTable: runTable, makeStrategy: makeStrategy };
