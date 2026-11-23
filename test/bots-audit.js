'use strict';
// Bot behaviour audit. Simulates random postflop decisions (per personality: street, hand strength,
// bet size, pot odds, 1v1 and multiway) and heads-up self-play hands (fold rates, win rates).
// Run: node test/bots-audit.js   (env AUDIT_SPOTS = spots per personality, default 2000;
// AUDIT_HANDS = self-play hands per pair of personalities, default 200). Prints the tables and
// exits 1 when a required property fails.
const path = require('path');
const E = require(path.join(__dirname, '..', 'public', 'engine.js'));
const Bots = require(path.join(__dirname, '..', 'public', 'bots.js'));
const G = require(path.join(__dirname, '..', 'public', 'game.js'));

const SPOTS = Number(process.env.AUDIT_SPOTS) || 2000;
const HANDS = Number(process.env.AUDIT_HANDS) || 200;
const TYPES = Bots.TYPES;
const STRENGTHS = ['high card', 'board pair', 'bottom pair', 'top pair', 'two pair', 'set+', 'flush+'];
const SIZES = ['check', 'small', 'half', 'pot', 'over', 'allin'];
const CARDS = [];
for (const r of '23456789TJQKA') for (const s of 'cdhs') CARDS.push(r + s);

function rngFrom(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
function U(rng, a, b) { return a + (b - a) * rng(); }
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}
const RANKS = '23456789TJQKA';
const rk = (c) => RANKS.indexOf(c.charAt(0));

// Hand strength of the hero's two cards on this board (the category the audit buckets by).
function strengthOf(hero, board) {
  const all = board.concat(hero);
  const cat = E.evaluateHand(all).rank;
  const cnt = {};
  all.forEach((c) => { cnt[rk(c)] = (cnt[rk(c)] || 0) + 1; });
  const heroR = hero.map(rk);
  // A made hand counts only if a hole card takes part in it (board-only trips or two pair is a board pair).
  const heroIn = (r) => heroR.indexOf(r) >= 0;
  if (cat >= 4) return 'flush+';
  if (cat === 3) {
    const trips = Object.keys(cnt).filter((k) => cnt[k] >= 3).map(Number);
    return trips.some(heroIn) ? 'set+' : 'board pair';
  }
  if (cat === 2) {
    const pairs = Object.keys(cnt).filter((k) => cnt[k] >= 2).map(Number);
    return pairs.some(heroIn) ? 'two pair' : 'board pair';
  }
  if (cat === 1) {
    let pr = -1;
    Object.keys(cnt).forEach((k) => { if (cnt[k] >= 2) pr = Math.max(pr, Number(k)); });
    const boardMax = Math.max.apply(null, board.map(rk));
    if (!heroIn(pr)) return 'board pair';
    if (pr >= boardMax) return 'top pair';
    return 'bottom pair';
  }
  return 'high card';
}

function coordinated(board) {
  if (board.length !== 5) return false;
  const suits = {}, ranks = new Set();
  board.forEach((c) => { suits[c.charAt(1)] = (suits[c.charAt(1)] || 0) + 1; ranks.add(RANKS.indexOf(c.charAt(0))); });
  if (Object.values(suits).some((n) => n >= 4)) return true;
  for (let lo = 0; lo <= 8; lo++) { let n = 0; for (let r = lo; r < lo + 5; r++) if (ranks.has(r)) n++; if (n >= 4) return true; }
  return false;
}

// One postflop spot where the hero is the bot (seat 0) facing a bet of `size` (or checked to).
function makeSpot(rng, street, players, size, types) {
  const deck = shuffle(CARDS.slice(), rng);
  const nB = { flop: 3, turn: 4, river: 5 }[street];
  const hero = deck.slice(0, 2), board = deck.slice(2, 2 + nB);
  const n = players;
  const Pre = Math.round(Math.exp(U(rng, Math.log(4), Math.log(60))) * 2) / 2;
  const frac = { small: U(rng, 0.25, 0.4), half: U(rng, 0.45, 0.6), pot: U(rng, 0.9, 1.1), over: U(rng, 1.3, 2.5) };
  const Hb = Math.round((Pre * U(rng, 0.5, 4) + 10) * 2) / 2;
  const Ob = Math.round((Pre * U(rng, 1, 3) + 10) * 2) / 2;
  let C = 0;
  let allIn = false;
  if (size === 'allin') { C = Math.min(Ob, Math.round((Pre * U(rng, 0.3, 2.5) + 1) * 2) / 2); allIn = true; }
  else if (size !== 'check') C = Math.min(Ob, Math.round(frac[size] * Pre * 2) / 2);
  const bettorLeft = allIn ? 0 : Ob - C;
  const pot = Pre + C;
  const seats = [{ seat: 0, position: 'BB', isHero: true, stack: Hb, bet: 0, contributed: Pre / n, folded: false, style: 'balanced', preflopRole: null }];
  for (let i = 1; i < n; i++) {
    const style = types[Math.floor(rng() * types.length)];
    const bettor = i === 1 && C > 0;
    seats.push({ seat: i, position: 'BTN', isHero: false, stack: bettor ? bettorLeft : Ob, bet: bettor ? C : 0,
      contributed: Pre / n + (bettor ? C : 0), folded: false, style: style, preflopRole: null });
  }
  const toCall = Math.min(C, Hb);
  const sc = { street: street, hero: hero, board: board, pot: pot, numPlayers: n, toCall: toCall, heroStack: Hb,
    heroPosition: 'BB', inPosition: false, seats: seats, history: [] };
  const legal = { toCall: toCall, curBet: C, minRaiseTo: C + 1, maxRaiseTo: Hb, canRaise: !allIn && Hb > C, canCheck: C <= 0 };
  return { sc: sc, legal: legal, strength: strengthOf(hero, board), size: size, pot: pot, C: toCall, Hb: Hb, n: n, street: street };
}

function actionOf(d, C) {
  if (d.action === 'raise') return 'raise';
  if (d.action === 'fold' && C > 0) return 'fold';
  return 'call'; // a check (no bet to face) is reported as 'call'
}

function spotStats(types) {
  const rows = [];
  const rng = rngFrom(20260811);
  const streets = ['flop', 'turn', 'river'];
  types.forEach((type) => {
    for (let i = 0; i < SPOTS; i++) {
      const street = streets[Math.floor(rng() * 3)];
      const players = [2, 2, 3, 4][Math.floor(rng() * 4)];
      const size = SIZES[Math.floor(rng() * SIZES.length)];
      const sp = makeSpot(rng, street, players, size, types);
      const d = Bots.decide({ scenario: sp.sc, key: 's' + i, legal: sp.legal }, { index: 0, type: type }, { seed: i % 13 + 1 });
      rows.push({ type: type, street: street, coord: street === 'river' && coordinated(sp.sc.board), n: players, size: size, strength: sp.strength, C: sp.C,
        req: sp.C > 0 ? sp.C / (sp.pot + sp.C) : 0, act: actionOf(d, sp.C), amount: d.amount, pot: sp.pot, Hb: sp.Hb });
    }
  });
  return rows;
}

// Heads-up (and 3-way) self-play with the same personality matchups; each hand starts at 100 BB.
function selfPlay(typeA, typeB, hands, seedBase) {
  const persona = (t) => Bots.PERSONAS.find((p) => p.type === t);
  const out = { a: { net: 0, won: 0, hands: 0 }, b: { net: 0, won: 0, hands: 0 }, dec: [] };
  for (let h = 0; h < hands; h++) {
    const sess = G.newSession({ cpus: 1, allBots: true, stackBB: 100, stacks: 'equal', seed: seedBase + h });
    const aSeat = h % 2;
    sess.seats[aSeat].persona = persona(typeA);
    sess.seats[1 - aSeat].persona = persona(typeB);
    const before = sess.seats.map((s) => s.stack);
    if (!G.startHand(sess, { players: 2 })) continue;
    const bb = sess.hand.bb;
    let guard = 0;
    while (!G.isHandOver(sess) && guard++ < 400) {
      const hand = sess.hand;
      const idx = hand.toAct;
      const street = hand.street;
      const L = G.legal(sess, idx);
      const type = sess.seats[idx].persona.type;
      const facing = L.toCall > 1e-9;
      G.stepBot(sess);
      const last = hand.history[hand.history.length - 1];
      if (facing) out.dec.push({ type: type, pre: street === 'preflop', fold: last.action === 'fold' });
    }
    [['a', aSeat], ['b', 1 - aSeat]].forEach((x) => {
      const k = x[0], s = x[1];
      out[k].net += (sess.seats[s].stack - before[s]) / bb;
      out[k].hands++;
      if (sess.seats[s].stack > before[s]) out[k].won++;
    });
  }
  return out;
}

function pct(a, b) { return b ? 100 * a / b : NaN; }
function agg(rows) {
  const n = rows.length;
  const f = rows.filter((r) => r.act === 'fold').length, c = rows.filter((r) => r.act === 'call').length, r = rows.filter((x) => x.act === 'raise').length;
  return { n: n, fold: pct(f, n), call: pct(c, n), raise: pct(r, n) };
}
function fmt(a) { return a.n ? (a.fold.toFixed(0) + '/' + a.call.toFixed(0) + '/' + a.raise.toFixed(0)) : '-'; }

let failures = 0;
const checks = [];
function check(ok, msg) { checks.push((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; }

const t0 = Date.now();
const rows = spotStats(TYPES);
const BIG = ['pot', 'over', 'allin'];
const HEADS = (r) => r.n === 2;

console.log('== Postflop decisions: fold/call/raise % by hand strength x bet size (' + SPOTS + ' spots per personality, flop/turn/river, 2-4 players)');
console.log('   columns: check | small (<0.4 pot) | half | pot | over (>=1.3 pot) | all-in   (cell = fold/call/raise)');
TYPES.forEach((t) => {
  console.log('-- ' + t);
  STRENGTHS.forEach((s) => {
    const cells = SIZES.map((z) => fmt(agg(rows.filter((r) => r.type === t && r.strength === s && r.size === z))));
    console.log('   ' + s.padEnd(12) + cells.map((c) => c.padStart(9)).join(''));
  });
});

console.log('\n== Call rate by pot odds (top pair, all sizes except check, all players)');
const odds = [[0, 0.15], [0.15, 0.25], [0.25, 0.33], [0.33, 0.45], [0.45, 1.01]];
console.log('   personality  ' + odds.map((o) => (o[0] + '-' + Math.min(o[1], 1).toFixed(1)).padStart(9)).join(''));
TYPES.forEach((t) => {
  const cells = odds.map((o) => {
    const rs = rows.filter((r) => r.type === t && r.strength === 'top pair' && r.size !== 'check' && r.req >= o[0] && r.req < o[1]);
    return rs.length ? pct(rs.filter((r) => r.act !== 'fold').length, rs.length).toFixed(0).padStart(9) : '        -';
  });
  console.log('   ' + t.padEnd(13) + cells.join(''));
});

console.log('\n== Bet/raise size as a fraction of the pot before the bet (median [p10-p90], distinct sizes)');
const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
const sizeOf = (r) => (r.amount - r.C) / r.pot;
const VALUE = ['top pair', 'two pair', 'set+', 'flush+'];
TYPES.forEach((t) => {
  const cell = (filt) => {
    const rs = rows.filter((r) => r.type === t && r.act === 'raise' && r.size !== 'allin' && filt(r));
    if (!rs.length) return '-';
    const fr = rs.map(sizeOf).sort((a, b) => a - b);
    const distinct = new Set(fr.map((x) => Math.round(x * 100))).size;
    return q(fr, 0.5).toFixed(2) + ' [' + q(fr, 0.1).toFixed(2) + '-' + q(fr, 0.9).toFixed(2) + '] n' + distinct;
  };
  console.log('   ' + t.padEnd(11) + ' value (flop | turn | river): ' + ['flop', 'turn', 'river'].map((st) => cell((r) => r.street === st && VALUE.includes(r.strength))).join(' | '));
  console.log('   ' + ''.padEnd(11) + ' bluff (flop | turn | river): ' + ['flop', 'turn', 'river'].map((st) => cell((r) => r.street === st && r.strength === 'high card')).join(' | '));
});

console.log('\n== Bluff rate: bet/raise when checked to, by strength');
TYPES.forEach((t) => {
  const cells = STRENGTHS.map((s) => {
    const rs = rows.filter((r) => r.type === t && r.strength === s && r.size === 'check');
    return pct(rs.filter((r) => r.act === 'raise').length, rs.length).toFixed(0).padStart(8) + '%';
  });
  console.log('   ' + t.padEnd(12) + cells.join(''));
});

// --- self-play
console.log('\n== Heads-up self-play (' + HANDS + ' hands per pair, 100 BB): BB/100 of row vs column; fold rate facing bets');
const mat = {};
const folds = {};
TYPES.forEach((t) => { folds[t] = { pre: [0, 0], post: [0, 0] }; });
let seedBase = 7000;
for (let i = 0; i < TYPES.length; i++) for (let j = i; j < TYPES.length; j++) {
  const r = selfPlay(TYPES[i], TYPES[j], HANDS, seedBase);
  seedBase += HANDS + 1;
  if (i === j) {
    mat[TYPES[i] + '|' + TYPES[j]] = 0;
  } else {
    mat[TYPES[i] + '|' + TYPES[j]] = 100 * r.a.net / r.a.hands;
    mat[TYPES[j] + '|' + TYPES[i]] = 100 * r.b.net / r.b.hands;
  }
  if (i !== j) mat['w' + TYPES[i] + '|' + TYPES[j]] = pct(r.a.won, r.a.hands);
  if (i !== j) mat['w' + TYPES[j] + '|' + TYPES[i]] = pct(r.b.won, r.b.hands);
  // fold rates from both seats
  [].concat(r.dec).forEach((d) => { const k = d.pre ? 'pre' : 'post'; folds[d.type][k][1]++; if (d.fold) folds[d.type][k][0]++; });
}
console.log('   ' + ''.padEnd(12) + TYPES.map((t) => t.padStart(11)).join(''));
TYPES.forEach((t) => {
  const cells = TYPES.map((u) => (t === u ? '      -    ' : ((mat[t + '|' + u] >= 0 ? '+' : '') + mat[t + '|' + u].toFixed(0) + ' (' + mat['w' + t + '|' + u].toFixed(0) + '%)').padStart(11)));
  console.log('   ' + t.padEnd(12) + cells.join(''));
});
console.log('   (cell: BB/100 and hands won %)');
console.log('\n   fold rate facing a bet: personality  preflop  postflop');
const foldRate = {};
TYPES.forEach((t) => {
  const f = folds[t];
  foldRate[t] = { pre: pct(f.pre[0], f.pre[1]), post: pct(f.post[0], f.post[1]) };
  console.log('   ' + t.padEnd(22) + foldRate[t].pre.toFixed(0).padStart(7) + '%' + foldRate[t].post.toFixed(0).padStart(9) + '%');
});

// --- properties
const coordFolds = {};
const byType = (t, f) => agg(rows.filter((r) => r.type === t && f(r)));
TYPES.forEach((t) => {
  const air = byType(t, (r) => r.street !== 'flop' && r.strength === 'high card' && BIG.includes(r.size) && r.size !== 'check');
  check(air.fold >= 85, t + ': turn/river high card folds to >= pot bet or all-in >= 85% (got ' + air.fold.toFixed(0) + '%)');
  const rv = byType(t, (r) => r.street === 'river' && r.strength === 'high card' && r.size === 'allin');
  check(rv.fold >= 90, t + ': river high card folds to all-in >= 90% (got ' + rv.fold.toFixed(0) + '%)');
  const bp = byType(t, (r) => r.street !== 'flop' && r.strength === 'board pair' && BIG.includes(r.size) && r.size !== 'check');
  check(bp.fold >= 80, t + ': turn/river board pair folds to >= pot bet or all-in >= 80% (got ' + bp.fold.toFixed(0) + '%)');
  const hu = byType(t, (r) => HEADS(r) && r.strength === 'high card' && (r.size === 'pot' || r.size === 'over'));
  check(hu.fold >= 60, t + ': heads-up high card folds to pot/over bet >= 60% (got ' + hu.fold.toFixed(0) + '%)');
  const strong = byType(t, (r) => ['two pair', 'set+', 'flush+'].includes(r.strength) && ['small', 'half', 'pot'].includes(r.size));
  check(strong.fold <= 15, t + ': two pair+ folds to small/half/pot bet <= 15% (got ' + strong.fold.toFixed(0) + '%)');
  const setAll = byType(t, (r) => r.strength === 'set+' && !r.coord && ['over', 'allin'].includes(r.size));
  check(setAll.fold <= 5, t + ': set+ folds to over/all-in <= 5%, excluding coordinated river boards (got ' + setAll.fold.toFixed(0) + '%)');
  const setCoord = byType(t, (r) => r.strength === 'set+' && r.coord && ['over', 'allin'].includes(r.size));
  coordFolds[t] = setCoord.n ? setCoord.fold : NaN;
  const bluff = byType(t, (r) => r.strength === 'high card' && r.size === 'check');
  check(bluff.raise <= 60, t + ': high card bet rate when checked to <= 60% (got ' + bluff.raise.toFixed(0) + '%)');
  check(foldRate[t].post >= 15, t + ': heads-up/multiway postflop self-play folds facing bets >= 15% (got ' + foldRate[t].post.toFixed(0) + '%)');
  check(foldRate[t].pre >= 15, t + ': preflop self-play folds facing a raise >= 15% (got ' + foldRate[t].pre.toFixed(0) + '%)');
  const lo = byType(t, (r) => r.strength === 'top pair' && r.size !== 'check' && r.req < 0.25);
  const hi = byType(t, (r) => r.strength === 'top pair' && r.size !== 'check' && r.req >= 0.33);
  // Continuation (call or raise) must not fall as the price gets cheaper; a raise-vs-call split is not a fold.
  check(lo.call + lo.raise + 5 >= hi.call + hi.raise, t + ': top pair continues (call/raise) more at good pot odds than at bad (' + (lo.call + lo.raise).toFixed(0) + '% vs ' + (hi.call + hi.raise).toFixed(0) + '%)');
});

console.log('\n== Properties');
checks.forEach((c) => console.log('   ' + c));
console.log('\n' + (failures ? failures + ' property failure(s)' : 'all properties pass') + ' (' + ((Date.now() - t0) / 1000).toFixed(0) + 's)');
if (failures) process.exitCode = 1;
