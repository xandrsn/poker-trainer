'use strict';
const assert = require('assert');
const path = require('path');
const E = require(path.join(__dirname, '..', 'public', 'engine.js'));
const Bots = require(path.join(__dirname, '..', 'public', 'bots.js'));
const G = require(path.join(__dirname, '..', 'public', 'game.js'));

let failures = 0;
function test(name, fn) {
  const t0 = Date.now();
  try {
    fn();
    console.log('  ok   ' + name + ' (' + (Date.now() - t0) + ' ms)');
  } catch (e) {
    failures++;
    console.log('  FAIL ' + name + '\n       ' + e.message);
  }
}

function rngFrom(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// Bot-only table settings drawn from a generator: stacks mode, custom stacks (BB) and personalities.
const STACK_MODES = ['equal', 'varied', 'custom'];
const PERSONALITY_SETS = [undefined, ['tight'], ['loose', 'aggressive'], ['passive'], ['tight', 'passive', 'balanced'], false];
function mixedConfig(rng, cpus) {
  return {
    cpus,
    stackBB: 20 + Math.floor(rng() * 180),
    stacks: STACK_MODES[Math.floor(rng() * STACK_MODES.length)],
    customStacks: Array.from({ length: cpus + 1 }, () => 1 + Math.floor(rng() * 60)),
    personalities: PERSONALITY_SETS[Math.floor(rng() * PERSONALITY_SETS.length)],
  };
}

// Plays one all-bot hand, checking conservation and legality at every step.
function playBotHand(sess, check) {
  const total = G.totalChips(sess);
  const hand = G.startHand(sess);
  if (!hand) return null;
  let guard = 0;
  while (!G.isHandOver(sess)) {
    if (guard++ > 400) throw new Error('hand did not terminate');
    const idx = G.toAct(sess);
    const legal = G.legal(sess, idx);
    assert.ok(sess.seats[idx].isBot, 'only bots act in an all-bot session');
    const ev = G.stepBot(sess);
    assert.strictEqual(ev.seat, idx, 'event seat matches actor');
    if (ev.action === 'raise') {
      assert.ok(legal.canRaise, 'raise was legal');
      assert.ok(ev.amount >= legal.minRaiseTo - 1e-9 && ev.amount <= legal.maxRaiseTo + 1e-9,
        'raise ' + ev.amount + ' within [' + legal.minRaiseTo + ', ' + legal.maxRaiseTo + ']');
    } else {
      assert.ok(['fold', 'call'].includes(ev.action), 'known action ' + ev.action);
    }
    if (legal.toCall <= 0) assert.notStrictEqual(ev.action, 'fold', 'a bot never folds when the check is free');
    assert.strictEqual(G.totalChips(sess), total, 'chips conserved mid-hand');
    if (check) check(sess);
  }
  assert.strictEqual(G.totalChips(sess), total, 'chips conserved at hand end');
  return hand;
}

// Engine-style state for Bots.decide from a live session (amounts converted to BB).
function botState(sess, idx) {
  const L = G.legal(sess, idx);
  return {
    scenario: G.buildScenario(sess, idx),
    key: sess.hand.no + ':' + sess.hand.actions,
    legal: { toCall: L.toCall / 100, curBet: L.curBet / 100, minRaiseTo: L.minRaiseTo / 100, maxRaiseTo: L.maxRaiseTo / 100, canRaise: L.canRaise, canCheck: L.canCheck },
  };
}

console.log('Poker Trainer game tests');

// ------------------------------------------------------------ simulations
test('500 all-bot hands, mixed stacks and personalities: chip conservation, legal actions', () => {
  const rng = rngFrom(20240601);
  let hands = 0, multiPot = 0, bustHands = 0, sessions = 0, showdowns = 0;
  const t0 = Date.now();
  while (hands < 500) {
    const cfg = mixedConfig(rng, 1 + Math.floor(rng() * 8));
    const seed = Math.floor(rng() * 1e9);
    const sess = G.newSession(Object.assign(cfg, { seed, allBots: true, randomness: 0.9 /* legacy, ignored */ }));
    sessions++;
    while (!sess.over && hands < 500) {
      const before = sess.seats.map((s) => s.busted);
      const hand = playBotHand(sess);
      if (!hand) break;
      hands++;
      // Busted seats are never dealt in again.
      sess.seats.forEach((s, i) => {
        if (before[i]) assert.ok(!hand.seats[i].dealt, 'busted seat ' + i + ' was dealt in');
      });
      const res = G.results(sess);
      assert.ok(res, 'hand has results');
      const potSum = res.pots.reduce((a, p) => a + p.amount, 0);
      const contrib = hand.seats.reduce((a, h) => a + h.contributed, 0);
      assert.strictEqual(potSum, contrib, 'pots cover every contributed chip');
      if (res.pots.length > 1) multiPot++;
      if (res.showdown) showdowns++;
      res.pots.forEach((p) => {
        assert.ok(p.winners.length >= 1, 'every pot has a winner');
        p.winners.forEach((w) => assert.ok(p.eligible.includes(w), 'winner is eligible'));
      });
      if (sess.seats.some((s, i) => s.busted && !before[i])) bustHands++;
    }
  }
  console.log('       ' + hands + ' hands in ' + sessions + ' sessions, ' + showdowns +
    ' showdowns, ' + multiPot + ' with side pots, ' + bustHands + ' hands with a bust, ' +
    (Date.now() - t0) + ' ms');
  assert.ok(multiPot > 0, 'side pots occurred in the simulation');
});

// ------------------------------------------------------------- side pots
test('side pots: all-in short stack splits main pot and side pot', () => {
  const pots = G.buildPots([
    { idx: 0, contributed: 50, folded: false },
    { idx: 1, contributed: 100, folded: false },
    { idx: 2, contributed: 100, folded: false },
  ]);
  assert.deepStrictEqual(pots, [
    { amount: 150, eligible: [0, 1, 2] },
    { amount: 100, eligible: [1, 2] },
  ]);
});

test('side pots: folded chips stay in the pot but folded seats are not eligible', () => {
  const pots = G.buildPots([
    { idx: 0, contributed: 30, folded: true },
    { idx: 1, contributed: 30, folded: false },
    { idx: 2, contributed: 80, folded: false },
    { idx: 3, contributed: 80, folded: false },
  ]);
  assert.deepStrictEqual(pots, [
    { amount: 120, eligible: [1, 2, 3] },
    { amount: 100, eligible: [2, 3] },
  ]);
  assert.strictEqual(pots.reduce((a, p) => a + p.amount, 0), 220);
});

test('side pots: uncalled excess returns to the only contributor above the level', () => {
  const pots = G.buildPots([
    { idx: 0, contributed: 40, folded: false },
    { idx: 1, contributed: 200, folded: false },
  ]);
  assert.deepStrictEqual(pots, [
    { amount: 80, eligible: [0, 1] },
    { amount: 160, eligible: [1] },
  ]);
});

// ------------------------------------------------------- legality checks
test('illegal actions are rejected', () => {
  const sess = G.newSession({ cpus: 2, seed: 99, allBots: true });
  G.startHand(sess);
  const idx = G.toAct(sess);
  const legal = G.legal(sess, idx);
  assert.throws(() => G.act(sess, (idx + 1) % 3 === idx ? (idx + 2) % 3 : (idx + 1) % 3, 'call'), /not to act/);
  if (legal.canRaise) {
    assert.throws(() => G.act(sess, idx, 'raise', legal.minRaiseTo - 50), /below the minimum|must exceed/);
    assert.throws(() => G.act(sess, idx, 'raise', legal.maxRaiseTo + 100), /exceeds stack/);
  }
  assert.throws(() => G.act(sess, idx, 'bet', 100), /unknown action/);
});

// ------------------------------------------------------------ determinism
test('same seed gives identical hands and actions', () => {
  function run() {
    const sess = G.newSession({ cpus: 4, stackBB: 100, seed: 4242, allBots: true });
    const logs = [];
    for (let h = 0; h < 25 && !sess.over; h++) {
      playBotHand(sess);
      logs.push(sess.hand.log.join('\n'));
    }
    return logs.join('\n====\n') + '|' + sess.seats.map((s) => s.stack).join(',');
  }
  assert.strictEqual(run(), run());
});

test('decide() is a pure function of state and seed', () => {
  const sess = G.newSession({ cpus: 3, seed: 5, allBots: true });
  G.startHand(sess);
  const idx = G.toAct(sess);
  const state = botState(sess, idx);
  const seat = { index: idx, looseness: 'balanced', aggression: 'balanced' };
  const a = Bots.decide(state, seat, { seed: 77 });
  const b = Bots.decide(state, seat, { seed: 77 });
  assert.deepStrictEqual(a, b);
});

test('personalities deviate from each other and stay deterministic', () => {
  const rng = rngFrom(31337);
  const diff = {};
  let decisions = 0;
  Bots.TYPES.forEach((t) => { diff[t] = 0; });
  for (let s = 0; s < 8; s++) {
    const sess = G.newSession({ cpus: 3 + (s % 3), stackBB: 100, seed: 500 + s, allBots: true, personalities: false });
    for (let h = 0; h < 6; h++) {
      if (!G.startHand(sess)) break;
      let guard = 0;
      while (!G.isHandOver(sess) && guard++ < 400) {
        const idx = G.toAct(sess);
        const st = botState(sess, idx);
        const seat = (type) => ({ index: idx, type, looseness: 'balanced', aggression: 'balanced' });
        const base = Bots.decide(st, seat('balanced'), { seed: 9 });
        assert.deepStrictEqual(Bots.decide(st, seat('balanced'), { seed: 9 }), base, 'deterministic');
        Bots.TYPES.forEach((t) => {
          const d = Bots.decide(st, seat(t), { seed: 9 });
          if (d.action !== base.action || d.amount !== base.amount) diff[t]++;
        });
        decisions++;
        G.stepBot(sess);
      }
    }
  }
  void rng;
  assert.ok(decisions > 60, 'decisions sampled: ' + decisions);
  ['tight', 'loose', 'aggressive', 'passive'].forEach((t) => {
    assert.ok(diff[t] > 0, t + ' differs from balanced at least once');
  });
  console.log('       differs from balanced in ' + JSON.stringify(diff) + ' of ' + decisions + ' decisions');
});

test('bot decisions are always legal for random states and types', () => {
  const rng = rngFrom(8);
  for (let s = 0; s < 40; s++) {
    const sess = G.newSession(Object.assign(mixedConfig(rng, 1 + Math.floor(rng() * 8)), { seed: 9000 + s, allBots: true }));
    for (let h = 0; h < 3; h++) {
      if (!G.startHand(sess)) break;
      let guard = 0;
      while (!G.isHandOver(sess) && guard++ < 400) {
        const idx = G.toAct(sess);
        const L = G.legal(sess, idx);
        const type = Bots.TYPES[Math.floor(rng() * Bots.TYPES.length)];
        const d = Bots.decide(botState(sess, idx), { index: idx, type }, { seed: 3 });
        assert.ok(['fold', 'call', 'raise'].includes(d.action), 'action ' + d.action);
        if (d.action === 'raise') {
          assert.ok(L.canRaise, 'raise only when allowed');
          assert.ok(d.amount >= L.minRaiseTo / 100 - 1e-9 && d.amount <= L.maxRaiseTo / 100 + 1e-9, 'raise amount legal');
        }
        G.stepBot(sess);
      }
    }
  }
});

// ----------------------------------------------------- stacks and short-stack play
test('stacks option: equal, varied and custom (per seat, BB)', () => {
  const eq = G.newSession({ cpus: 4, stackBB: 80, stacks: 'equal', seed: 1 });
  assert.ok(eq.seats.every((s) => s.stack === 8000), 'equal stacks');
  const va = G.newSession({ cpus: 6, stackBB: 100, stacks: 'varied', seed: 2 });
  va.seats.forEach((s) => {
    assert.ok(s.stack >= 50 * 100 - 1 && s.stack <= 200 * 100 + 1, 'varied stack ' + s.stack);
  });
  assert.ok(new Set(va.seats.map((s) => s.stack)).size > 1, 'varied stacks differ');
  const cu = G.newSession({ cpus: 2, stackBB: 100, stacks: 'custom', customStacks: [12, 40, 250], seed: 3 });
  assert.deepStrictEqual(cu.seats.map((s) => s.stack), [1200, 4000, 25000]);
  assert.strictEqual(cu.cfg.stacks, 'custom');
});

test('legacy randomness option is accepted and ignored; personalities option picks enabled types', () => {
  const s1 = G.newSession({ cpus: 8, randomness: 0.9, seed: 4, allBots: true });
  assert.strictEqual(s1.cfg.randomness, undefined, 'no randomness in the config');
  const only = G.newSession({ cpus: 8, seed: 5, allBots: true, personalities: ['tight'] });
  assert.ok(only.seats.every((s) => s.persona.type === 'tight'), 'only tight bots');
  const mixed = G.newSession({ cpus: 8, seed: 6, allBots: true, personalities: ['loose', 'passive'] });
  assert.ok(mixed.seats.every((s) => ['loose', 'passive'].includes(s.persona.type)), 'only enabled types');
  const none = G.newSession({ cpus: 3, seed: 7, allBots: true, personalities: [] });
  assert.ok(none.seats.every((s) => s.persona.type === 'balanced'), 'empty list falls back to balanced');
  const legacy = G.newSession({ cpus: 3, seed: 8, allBots: true, personalities: false });
  assert.ok(legacy.seats.every((s) => s.persona.type === 'balanced'), 'legacy false is balanced');
});

test('short stacks (<= 15 BB) push or fold preflop; shoves are all-in', () => {
  const rng = rngFrom(606);
  let shoves = 0, folds = 0, others = 0;
  for (let s = 0; s < 60; s++) {
    const sess = G.newSession({ cpus: 5, seed: 7000 + s, allBots: true, stacks: 'custom',
      customStacks: [8, 12, 15, 10, 6, 14], personalities: Bots.TYPES.filter(() => rng() < 0.7).concat(['balanced']) });
    for (let h = 0; h < 4; h++) {
      if (!G.startHand(sess)) break;
      let guard = 0;
      while (!G.isHandOver(sess) && guard++ < 200) {
        const idx = G.toAct(sess);
        const L = G.legal(sess, idx);
        const preflop = sess.hand.street === 'preflop';
        const eff = Math.min(...sess.seats.filter((x, i) => sess.hand.seats[i].dealt && !sess.hand.seats[i].folded).map((x) => x.stack)) / 100;
        const ev = G.stepBot(sess);
        if (preflop && eff <= 15) {
          // A short stack either shoves (always to the full stack) or folds / calls.
          if (ev.action === 'raise') {
            assert.strictEqual(ev.amount, L.maxRaiseTo, 'short-stack raise is an all-in');
            shoves++;
          } else if (ev.action === 'fold') folds++;
          else others++;
        }
      }
    }
  }
  assert.ok(shoves > 0, 'short-stack shoves: ' + shoves);
  assert.ok(folds > 0, 'short-stack folds: ' + folds);
  console.log('       short-stack preflop: ' + shoves + ' shoves, ' + folds + ' folds, ' + others + ' calls/checks');
});

test('scenario: heroCovered matches the live opponents, toCall capped at the hero stack', () => {
  let checked = 0;
  for (let s = 0; s < 40 && checked < 25; s++) {
    const sess = G.newSession({ cpus: 3, stackBB: 40, stacks: 'varied', seed: 1500 + s, personalities: false });
    if (!G.startHand(sess)) continue;
    let guard = 0;
    while (!G.isHandOver(sess) && G.toAct(sess) !== 0 && guard++ < 200) G.stepBot(sess);
    if (G.isHandOver(sess)) continue;
    const sc = G.buildScenario(sess, 0);
    const heroTotal = sc.heroStack + sc.seats[0].contributed;
    const covered = sc.seats.some((x) => !x.isHero && !x.folded && x.stack + x.contributed > heroTotal + 1e-9);
    assert.strictEqual(sc.heroCovered, covered, 'heroCovered');
    const L = G.legal(sess, 0);
    if (L.toCall > 0) {
      sess.seats[0].stack = Math.floor(L.toCall / 2);
      const short = G.buildScenario(sess, 0);
      assert.ok(short.toCall <= short.heroStack + 1e-9, 'toCall capped');
    }
    checked++;
  }
  assert.ok(checked >= 10, 'checked ' + checked);
});

test('hero decisions are recorded per hand with the pre-action scenario', () => {
  const rng = rngFrom(4444);
  let recorded = 0, hands = 0;
  for (let s = 0; s < 6; s++) {
    const sess = G.newSession({ cpus: 4, stackBB: 100, seed: 8800 + s });
    for (let h = 0; h < 6 && !sess.over; h++) {
      if (!G.startHand(sess, { players: 2 + Math.floor(rng() * 5) })) break;
      let mine = 0, guard = 0;
      while (!G.isHandOver(sess) && guard++ < 300) {
        if (G.toAct(sess) === 0) {
          const L = G.legal(sess, 0);
          if (rng() < 0.2 && L.toCall > 0) G.act(sess, 0, 'fold');
          else if (rng() < 0.3 && L.canRaise) G.act(sess, 0, 'raise', L.minRaiseTo);
          else G.act(sess, 0, 'call');
          mine++;
        } else G.stepBot(sess);
      }
      const res = G.results(sess);
      assert.ok(Array.isArray(res.heroDecisions), 'heroDecisions array');
      assert.strictEqual(res.heroDecisions.length, mine, 'one record per hero decision');
      res.heroDecisions.forEach((d) => {
        assert.strictEqual(d.handIndex, sess.hand.no, 'handIndex');
        assert.ok(['preflop', 'flop', 'turn', 'river'].includes(d.street), 'street');
        assert.ok(['fold', 'call', 'raise'].includes(d.action), 'action');
        assert.ok(d.scenario && d.scenario.hero.length === 2, 'scenario present');
        assert.strictEqual(d.scenario.street, d.street, 'scenario street');
        recorded++;
      });
      hands++;
    }
  }
  assert.ok(recorded > 20, 'recorded ' + recorded + ' over ' + hands + ' hands');
  // A record can be re-graded with the engine later.
  const sess = G.newSession({ cpus: 2, seed: 77 });
  G.startHand(sess);
  let g2 = 0;
  while (!G.isHandOver(sess) && g2++ < 200) {
    if (G.toAct(sess) === 0) G.act(sess, 0, 'call');
    else G.stepBot(sess);
  }
  {
    const d = G.results(sess).heroDecisions[0];
    const r = E.evaluate(d.scenario, d.action, d.raiseAmount || undefined, { samples: 200 });
    assert.ok(['best', 'good', 'mistake', 'blunder'].includes(r.rating), 'regraded: ' + r.rating);
  }
});

// ----------------------------------------------------- engine integration
test('hero scenario from live state grades with PokerEngine.evaluate', () => {
  const rng = rngFrom(77);
  let graded = 0;
  for (let s = 0; s < 6 && graded < 12; s++) {
    const sess = G.newSession({ cpus: 3 + (s % 4), stackBB: 100, seed: 60 + s });
    for (let h = 0; h < 4 && graded < 12; h++) {
      if (!G.startHand(sess)) break;
      let guard = 0;
      while (!G.isHandOver(sess) && G.toAct(sess) !== 0 && guard++ < 200) G.stepBot(sess);
      if (G.isHandOver(sess)) continue;
      const sc = G.buildScenario(sess, 0);
      assert.ok(sc.heroToAct);
      assert.strictEqual(sc.hero.length, 2);
      assert.strictEqual(sc.board.length, { preflop: 0, flop: 3, turn: 4, river: 5 }[sc.street]);
      const action = sc.standardRaise != null && rng() < 0.5 ? 'raise' : 'call';
      const r = E.evaluate(sc, action, undefined, { samples: 600 });
      assert.ok(['best', 'good', 'mistake', 'blunder'].includes(r.rating), 'rating ' + r.rating);
      assert.ok(r.score >= 0 && r.score <= 100, 'score in range');
      const L = G.legal(sess, 0);
      if (action === 'raise') G.act(sess, 0, 'raise');
      else G.act(sess, 0, L.toCall > 0 && rng() < 0.3 ? 'fold' : 'call');
      graded++;
      while (!G.isHandOver(sess) && G.toAct(sess) !== 0 && guard++ < 400) G.stepBot(sess);
    }
  }
  assert.ok(graded >= 6, 'graded hero decisions: ' + graded);
});

// ------------------------------------------------- full-hand game flow
test('per-hand players and hero position are honoured', () => {
  const P = E.POSITIONS;
  let checked = 0;
  for (let n = 2; n <= 9; n++) {
    for (const pos of P[n]) {
      const sess = G.newSession({ cpus: 8, seed: 100 + n * 13 + pos.length, allBots: true });
      const hand = G.startHand(sess, { players: n, heroPosition: pos });
      assert.ok(hand, 'hand dealt');
      assert.strictEqual(hand.m, n, 'players ' + n);
      assert.strictEqual(hand.seats[0].pos, pos, 'hero at ' + pos + ' for ' + n + ' players');
      const sc = G.buildScenario(sess, 0);
      assert.strictEqual(sc.numPlayers, n);
      assert.strictEqual(sc.seats.length, n, 'only seats in the hand are shown');
      checked++;
    }
  }
  assert.ok(checked > 40, 'checked ' + checked + ' combinations');
});

test('full hands: random table sizes per hand, chips conserved, hero net matches stack change', () => {
  const rng = rngFrom(4321);
  let hands = 0, showdowns = 0, rivers = 0;
  for (let s = 0; s < 40; s++) {
    const sess = G.newSession({ cpus: 8, stackBB: 100, seed: 7000 + s, allBots: true });
    const total = G.totalChips(sess);
    for (let h = 0; h < 15 && !sess.over; h++) {
      const heroStart = sess.seats[0].stack;
      const players = 2 + Math.floor(rng() * 8);
      const hand = G.startHand(sess, { players });
      if (!hand) break;
      assert.strictEqual(hand.m, Math.min(players, 1 + sess.seats.filter((x, i) => i > 0 && hand.seats[i].dealt).length));
      assert.ok(hand.m <= players && hand.m >= 2);
      let guard = 0;
      while (!G.isHandOver(sess) && guard++ < 400) {
        G.stepBot(sess);
        assert.strictEqual(G.totalChips(sess), total, 'conserved mid-hand');
      }
      const res = G.results(sess);
      assert.strictEqual(res.heroNet, sess.seats[0].stack - heroStart, 'hero net equals stack change');
      if (res.showdown) showdowns++;
      if (hand.board.length === 5) rivers++;
      hands++;
    }
    assert.strictEqual(G.totalChips(sess), total);
  }
  assert.ok(hands >= 200, 'hands ' + hands);
  assert.ok(showdowns > 0 && rivers > 0, 'hands reached showdown and river');
});

test('hero plays multi-street hands: several decisions per hand, scenarios stay valid', () => {
  const rng = rngFrom(99);
  let heroDecisions = 0, multiDecisionHands = 0, hands = 0, folds = 0;
  for (let s = 0; s < 25; s++) {
    const sess = G.newSession({ cpus: 8, stackBB: 150, seed: 300 + s });
    const total = G.totalChips(sess);
    for (let h = 0; h < 8 && !sess.over; h++) {
      const hand = G.startHand(sess, { players: 3 + Math.floor(rng() * 6) });
      if (!hand) break;
      let mine = 0, guard = 0;
      while (!G.isHandOver(sess) && guard++ < 400) {
        if (G.toAct(sess) === 0) {
          const sc = G.buildScenario(sess, 0);
          assert.ok(sc.heroToAct && sc.hero.length === 2);
          assert.ok(sc.board.length === { preflop: 0, flop: 3, turn: 4, river: 5 }[sc.street]);
          const L = G.legal(sess, 0);
          const roll = rng();
          if (roll < 0.15 && L.toCall > 0) { G.act(sess, 0, 'fold'); folds++; }
          else if (roll < 0.35 && L.canRaise) G.act(sess, 0, 'raise', L.minRaiseTo);
          else G.act(sess, 0, 'call');
          mine++;
          heroDecisions++;
        } else {
          G.stepBot(sess);
        }
        assert.strictEqual(G.totalChips(sess), total, 'conserved with a human hero');
      }
      if (mine >= 2) multiDecisionHands++;
      hands++;
    }
    assert.strictEqual(G.totalChips(sess), total);
  }
  assert.ok(multiDecisionHands > 20, 'hands with several hero decisions: ' + multiDecisionHands + '/' + hands);
  assert.ok(folds > 0 && heroDecisions > 100);
});

// ------------------------------------------------- action history and scenario fields
test('scenario carries a consistent action history mid-hand', () => {
  let checked = 0;
  for (let s = 0; s < 8 && checked < 10; s++) {
    const sess = G.newSession({ cpus: 4, stackBB: 100, seed: 900 + s });
    for (let h = 0; h < 3 && checked < 10; h++) {
      if (!G.startHand(sess)) break;
      let guard = 0;
      while (!G.isHandOver(sess) && G.toAct(sess) !== 0 && guard++ < 200) G.stepBot(sess);
      if (G.isHandOver(sess)) continue;
      const sc = G.buildScenario(sess, 0);
      assert.ok(Array.isArray(sc.history), 'history is an array');
      // Blinds are the only money in the pot before the first recorded action.
      const put = sc.history.reduce((a, e) => a + e.put, 0);
      const blindsPot = sc.pot - put;
      assert.ok(Math.abs(blindsPot - 1.5) < 0.01, 'blinds before actions: ' + blindsPot);
      // Each entry's potBefore is the running pot; the history ends at the scenario pot.
      let running = blindsPot;
      sc.history.forEach((e) => {
        assert.ok(Math.abs(e.potBefore - running) < 0.02, 'potBefore matches the running pot');
        running += e.put;
      });
      assert.ok(Math.abs(running - sc.pot) < 0.02, 'history ends at the scenario pot');
      // Every seat (folded or not): blind (0, 0.5 or 1 BB) plus its own actions = what it has put in.
      sess.hand.seats.forEach((hs, i) => {
        const own = sc.history.filter((e) => e.seat === i).reduce((a, e) => a + e.put, 0);
        const blind = hs.contributed / 100 - own;
        assert.ok([0, 0.5, 1].some((b) => Math.abs(blind - b) < 0.01), 'seat ' + i + ' blind ' + blind);
      });
      // Folded seats never act after folding.
      const folded = new Set();
      sc.history.forEach((e) => {
        assert.ok(!folded.has(e.seat), 'seat ' + e.seat + ' acted after folding');
        if (e.action === 'fold') folded.add(e.seat);
      });
      checked++;
    }
  }
  assert.ok(checked >= 5, 'mid-hand scenarios checked: ' + checked);
});

// ------------------------------------------------- no walkovers in solo mode
test('solo mode (noWalkover): no hand is won while every other seat folded and the hero is still in', () => {
  let seed = 4242;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let hands = 0, walkovers = 0, chipErrors = 0;
  const examples = [];
  for (let s = 0; hands < 1000 && s < 500; s++) {
    const sess = G.newSession({ cpus: 1 + (s % 8), stackBB: 1000, seed: 5000 + s, noWalkover: true,
      stacks: s % 2 ? 'varied' : 'equal', personalities: s % 3 ? undefined : false });
    const chips0 = G.totalChips(sess);
    for (let h = 0; h < 10; h++) {
      if (!G.startHand(sess)) break;
      let guard = 0;
      while (!G.isHandOver(sess) && guard++ < 500) {
        if (G.toAct(sess) === 0) {
          const L = G.legal(sess, 0);
          const r = rnd();
          if (r < 0.25 && L.toCall > 0) G.act(sess, 0, 'fold');
          else if (r < 0.5 && L.canRaise) G.act(sess, 0, 'raise', L.minRaiseTo);
          else G.act(sess, 0, 'call');
        } else {
          G.stepBot(sess);
        }
      }
      hands++;
      const seats = sess.hand.seats;
      const dealt = seats.filter((x) => x.dealt).length;
      const heroIn = !seats[0].folded;
      const othersFolded = seats.every((x, j) => j === 0 || !x.dealt || x.folded);
      if (heroIn && othersFolded && dealt >= 2) {
        walkovers++;
        if (examples.length < 3) examples.push({ session: s, hand: h });
      }
      if (G.totalChips(sess) !== chips0) chipErrors++;
    }
  }
  assert.ok(hands >= 1000, 'hands simulated: ' + hands);
  assert.strictEqual(walkovers, 0, 'walkovers in ' + hands + ' hands: ' + JSON.stringify(examples));
  assert.strictEqual(chipErrors, 0, 'chip conservation');
});

// ------------------------------------------------- personality and stack measurements
const S = require(path.join(__dirname, 'bots-stats.js'));
test('personalities differ in VPIP, PFR and postflop aggression (300 hands each)', () => {
  const m = {};
  Bots.TYPES.forEach((t) => { m[t] = S.measureType(t, 300); });
  assert.ok(m.loose.vpip > m.tight.vpip + 15, 'loose plays far more hands than tight');
  assert.ok(m.tight.pfr < 16 && m.passive.pfr < 9, 'tight and passive rarely raise');
  assert.ok(m.aggressive.pfr > m.balanced.pfr && m.aggressive.pfr > m.passive.pfr + 10, 'aggressive raises more');
  assert.ok(m.aggressive.aggression > m.balanced.aggression && m.balanced.aggression > m.passive.aggression, 'aggression order');
  assert.ok(m.passive.aggression < 0.6 && m.loose.aggression < m.aggressive.aggression, 'passive and loose call more than they bet');
  Bots.TYPES.forEach((t) => console.log('       ' + t + ': VPIP ' + m[t].vpip.toFixed(1) + ', PFR ' + m[t].pfr.toFixed(1) + ', aggression ' + m[t].aggression.toFixed(2)));
});

test('short stacks (<= 15 BB) only shove all-in; deep stacks never jam marginal hands', () => {
  const s = S.measureShort(10, 300);
  assert.ok(s.short.raises > 0, 'short-stack raises: ' + s.short.raises);
  assert.strictEqual(s.short.allInRaises, s.short.raises, 'every short-stack raise is an all-in');
  const d = S.measureShort(100, 150);
  assert.strictEqual(d.deep.marginalJams, 0, 'no marginal all-in from deep stacks');
});

// Heavy part (3000 hands per type, about 20 s): run with GAME_HEAVY=1 npm run bots-stats (or node).
if (process.env.GAME_HEAVY === '1') {
  test('HEAVY: VPIP / PFR within 4 points of target, aggression near targets (3000 hands each)', () => {
    Bots.TYPES.forEach((t) => {
      const m = S.measureType(t, 3000);
      const T = S.TARGETS[t];
      console.log('       ' + t + ': VPIP ' + m.vpip.toFixed(1) + ' (' + T.vpip + '), PFR ' + m.pfr.toFixed(1) + ' (' + T.pfr + '), aggression ' + m.aggression.toFixed(2));
      assert.ok(Math.abs(m.vpip - T.vpip) <= 4, t + ' VPIP ' + m.vpip.toFixed(1));
      assert.ok(Math.abs(m.pfr - T.pfr) <= 4, t + ' PFR ' + m.pfr.toFixed(1));
      if (t === 'aggressive') assert.ok(m.aggression >= 2.5, 'aggressive >= 2.5: ' + m.aggression.toFixed(2));
      if (t === 'balanced') assert.ok(Math.abs(m.aggression - 1.5) <= 0.3, 'balanced ~1.5: ' + m.aggression.toFixed(2));
      if (t === 'tight') assert.ok(m.aggression >= 1.0 && m.aggression <= 1.5, 'tight 1.0-1.5: ' + m.aggression.toFixed(2));
      if (t === 'loose') assert.ok(Math.abs(m.aggression - 0.8) <= 0.2, 'loose ~0.8: ' + m.aggression.toFixed(2));
      if (t === 'passive') assert.ok(m.aggression <= 0.5, 'passive <= 0.5: ' + m.aggression.toFixed(2));
    });
  });
  test('HEAVY: short-stack and all-in call behaviour measured over many spots', () => {
    const shortRes = S.measureShort(12, 1500);
    assert.strictEqual(shortRes.short.allInRaises, shortRes.short.raises, 'short raises all-in');
    assert.ok(shortRes.short.raises > 100, 'short raises sampled: ' + shortRes.short.raises);
    const rows = S.measureCalls(4000);
    rows.forEach((r) => {
      console.log('       band ' + r.band[0] + '-' + r.band[1] + ': covered ' + r.covered.n + ' (' + (r.covered.callRate == null ? '-' : (100 * r.covered.callRate).toFixed(0)) + '% call) vs covering ' + r.covering.n + ' (' + (r.covering.callRate == null ? '-' : (100 * r.covering.callRate).toFixed(0)) + '% call)');
    });
    // Marginal hands (percentile 0.2-0.6) call an all-in that covers them less than one they cover.
    [rows[1], rows[2]].forEach((r) => {
      if (r.covered.n >= 30 && r.covering.n >= 30) {
        assert.ok(r.covered.callRate + 0.10 <= r.covering.callRate, 'band ' + r.band.join('-') + ': covered call rate below covering');
      }
    });
  });
}

test('scenario carries lastRaise (BB) after a raise; undefined before any raise on the street', () => {
  let raised = 0, undef = 0;
  for (let s = 0; s < 30; s++) {
    const sess = G.newSession({ cpus: 3, stackBB: 100, seed: 2600 + s, allBots: true });
    if (!G.startHand(sess)) continue;
    if (G.buildScenario(sess, 0).lastRaise === undefined) undef++;
    let guard = 0;
    while (!G.isHandOver(sess) && guard++ < 200) {
      const idx = G.toAct(sess);
      const curBefore = G.legal(sess, idx).curBet;
      const ev = G.stepBot(sess);
      if (ev.action !== 'raise' || G.isHandOver(sess)) continue;
      const sc = G.buildScenario(sess, 0);
      assert.ok(sc.lastRaise !== undefined, 'lastRaise defined after a raise');
      const inc = (ev.amount - curBefore) / 100;
      assert.ok(Math.abs(sc.lastRaise - inc) < 1e-9, 'lastRaise ' + sc.lastRaise + ' equals the raise size ' + inc);
      raised++;
    }
  }
  assert.ok(raised > 10, 'raises checked: ' + raised);
  assert.ok(undef > 0, 'scenarios before any raise have lastRaise undefined: ' + undef);
});

test('multiplayer default (noWalkover off) keeps the bot fold rules', () => {
  const sess = G.newSession({ cpus: 3, stackBB: 100, seed: 77 });
  assert.strictEqual(sess.cfg.noWalkover, false);
});

test('bot postflop bets are at most a 1.5x pot overbet, never a jam because the stack is short (D1)', () => {
  // Before the fix, a bot with stack-to-pot <= 2.5 bet its whole stack (e.g. 88 BB into a 25 BB pot).
  let bigBets = 0, bets = 0;
  for (let seed = 500; seed < 620; seed++) {
    const sess = G.newSession({ cpus: 5, allBots: true, stackBB: 100, stacks: 'varied', seed: seed });
    for (let h = 0; h < 25 && !sess.over; h++) {
      if (!G.startHand(sess, { players: 6 })) break;
      let guard = 0;
      while (!G.isHandOver(sess) && guard++ < 400) G.stepBot(sess);
      sess.hand.history.forEach((e) => {
        if (e.street === 'preflop' || e.action !== 'bet') return;
        bets++;
        if (e.amount > 2 && e.betFraction > 1.5 + 1e-6) bigBets++;
      });
    }
  }
  assert.ok(bets > 200, 'enough postflop bets sampled: ' + bets);
  assert.strictEqual(bigBets, 0, bigBets + ' of ' + bets + ' postflop bets were larger than 1.5x the pot');
});

// Quick game: one whole session (the table of bots) with a scripted hero until busted or won.
[1, 3, 8].forEach(function (cpus) {
  test('quick game, ' + cpus + ' bot(s): session ends busted or won, chips conserved every hand', function () {
    const s = G.newSession({ cpus: cpus, stackBB: 100, stacks: 'equal', money: true, noWalkover: true, seed: 900 + cpus });
    const total = s.seats.reduce(function (a, x) { return a + x.stack; }, 0);
    let hands = 0;
    const MAX = 400;
    while (!s.over && hands < MAX) {
      const hand = G.startHand(s, {});
      if (!hand) break;
      hands++;
      let guard = 0;
      let i = 0;
      while (!G.isHandOver(s) && guard++ < 500) {
        if (G.toAct(s) === 0) {
          const pick = i++ % 3 === 0 ? 'raise' : 'call';
          try { G.act(s, 0, pick); } catch (e) { G.act(s, 0, 'call'); }
        } else {
          G.stepBot(s);
        }
      }
      assert.ok(G.isHandOver(s), 'hand ' + hands + ' finished');
      const sum = s.seats.reduce(function (a, x) { return a + x.stack; }, 0);
      assert.strictEqual(sum, total, 'chips conserved after hand ' + hands);
    }
    assert.ok(s.over === 'busted' || s.over === 'won', 'session over: ' + s.over + ' after ' + hands + ' hands');
    assert.ok(hands < MAX, 'terminated within ' + MAX + ' hands (' + hands + ')');
    if (s.over === 'busted') assert.strictEqual(s.seats[0].stack, 0, 'hero out of chips');
    if (s.over === 'won') assert.ok(s.seats.slice(1).every(function (x) { return x.stack <= 0; }), 'every bot out');
  });
});


// ---- bot river showdown value and 0.1 BB sizing
test('bot river: a board-pair-only hand (4d7d on TQQK5) folds to a big bet for every personality and seed', () => {
  const sc = {
    street: 'river', hero: ['4d', '7d'], board: ['Tc', 'Qh', 'Qs', 'Kc', '5h'], pot: 52, numPlayers: 2,
    toCall: 22, heroStack: 50, heroPosition: 'BB', inPosition: true,
    seats: [
      { seat: 0, position: 'BB', isHero: true, stack: 50, bet: 0, contributed: 10, folded: false, style: 'balanced' },
      { seat: 1, position: 'BTN', isHero: false, stack: 50, bet: 22, contributed: 30, folded: false, style: 'aggressive', preflopRole: null },
    ],
    history: [],
  };
  const legal = { toCall: 22, curBet: 22, minRaiseTo: 44, maxRaiseTo: 50, canRaise: true, canCheck: false };
  for (const type of Bots.TYPES) {
    for (let seed = 1; seed <= 25; seed++) {
      const d = Bots.decide({ scenario: sc, key: 'r' + seed, legal }, { index: 1, type }, { seed });
      assert.strictEqual(d.action, 'fold', type + ' seed ' + seed + ' paid a big river bet with board-pair-only value');
    }
  }
});

// River spot for a bot facing an all-in (BB units): the bot seat is the hero of the scenario.
function riverAllInSpot(type, hole, board, botStack, pot) {
  const C = Math.min(100, botStack);
  const sc = {
    street: 'river', hero: hole, board, pot, numPlayers: 2, toCall: C, heroStack: botStack, heroPosition: 'BB', inPosition: true,
    seats: [
      { seat: 0, position: 'BB', isHero: true, stack: botStack, bet: 0, contributed: pot - 100, folded: false, style: type, preflopRole: null },
      { seat: 1, position: 'BTN', isHero: false, stack: 0, bet: 100, contributed: 100, folded: false, style: 'balanced', preflopRole: null },
    ],
    history: [],
  };
  const legal = { toCall: C, curBet: 100, minRaiseTo: 200, maxRaiseTo: 100 + botStack, canRaise: false, canCheck: false };
  return { scenario: sc, legal };
}

test('passive bot with 7-high folds to a river all-in on a board without pair help (50 seeds)', () => {
  const spot = riverAllInSpot('passive', ['7h', '2c'], ['Kd', 'Ts', '4h', '9c', '3s'], 100, 150);
  for (let seed = 1; seed <= 50; seed++) {
    const d = Bots.decide({ scenario: spot.scenario, key: 'a' + seed, legal: spot.legal }, { index: 0, type: 'passive' }, { seed });
    assert.strictEqual(d.action, 'fold', 'passive called a river all-in with 7-high, seed ' + seed);
  }
});

test('nearly committed bot (call < 10% of the pot) still calls a river all-in with a set', () => {
  const spot = riverAllInSpot('passive', ['Ks', 'Kd'], ['Kh', '7c', '2d', '9s', '4c'], 3, 120);
  assert.ok(spot.legal.toCall / spot.scenario.pot < 0.1);
  for (let seed = 1; seed <= 25; seed++) {
    const d = Bots.decide({ scenario: spot.scenario, key: 'n' + seed, legal: spot.legal }, { index: 0, type: 'passive' }, { seed });
    assert.strictEqual(d.action, 'call', 'nearly committed set folded, seed ' + seed);
  }
});

test('strong hands still call a river all-in (full house, 50 seeds, every personality)', () => {
  for (const type of Bots.TYPES) {
    const spot = riverAllInSpot(type, ['Ks', 'Kd'], ['Kh', '7c', '7d', '9s', '4c'], 100, 150);
    for (let seed = 1; seed <= 50; seed++) {
      const d = Bots.decide({ scenario: spot.scenario, key: 'f' + seed, legal: spot.legal }, { index: 0, type }, { seed });
      assert.strictEqual(d.action, 'call', type + ' folded a full house, seed ' + seed);
    }
  }
});

test('bot raise sizes are multiples of 0.5 BB (before the legal clamp), so shown amounts add up', () => {
  let checked = 0;
  for (let i = 0; i < 400; i++) {
    const s = E.generateScenario({ seed: 'bsz' + i });
    const hero = s.seats.find((x) => x.isHero);
    const maxBet = Math.max(...s.seats.map((x) => x.bet || 0));
    const legal = { toCall: s.toCall, curBet: maxBet, minRaiseTo: maxBet + 1, maxRaiseTo: hero.stack + hero.bet, canRaise: true, canCheck: s.toCall <= 0 };
    const types = Bots.TYPES;
    const d = Bots.decide({ scenario: s, key: i, legal }, { index: 0, type: types[i % types.length] }, { seed: i });
    if (d.action !== 'raise' || d.amount === legal.maxRaiseTo || d.amount === legal.minRaiseTo) continue;
    checked++;
    const halves = d.amount * 2;
    assert.ok(Math.abs(halves - Math.round(halves)) < 1e-9, 'raise ' + d.amount + ' is not on the 0.5 BB grid');
  }
  assert.ok(checked > 0, 'no raises sampled');
});


test('bet cap: max raise is the largest live opponent total (3-way, deepest 30k, me 200k => 30k)', () => {
  const mk = (bet, stack, folded) => ({ bet, contributed: bet, folded: !!folded, dealt: true, allIn: stack === 0, acted: false, raiseAllowed: true });
  const session = { seats: [{ stack: 200000 }, { stack: 30000 }, { stack: 5000 }], hand: null };
  session.hand = { order: [0, 1, 2], m: 3, curBet: 0, lastRaise: 0, toAct: 0, over: false, bb: 1000,
    seats: [mk(0, 200000), mk(0, 30000), mk(0, 5000)] };
  let L = G.legal(session, 0);
  assert.strictEqual(L.maxRaiseTo, 30000, 'hero capped at deepest opponent');
  assert.strictEqual(L.canRaise, true);
  // folded deepest opponent is excluded: next largest live stack (5000) is the cap
  session.hand.seats[1].folded = true;
  L = G.legal(session, 0);
  assert.strictEqual(L.maxRaiseTo, 5000, 'folded opponents do not set the cap');
  // one opponent all-in for 8k (stack 0), other live with 30k: cap is 30k
  session.hand.seats[1].folded = false;
  session.seats[2].stack = 0; session.hand.seats[2].allIn = true; session.hand.seats[2].bet = 8000; session.hand.seats[2].contributed = 8000;
  session.hand.curBet = 8000; session.hand.seats[2].acted = true;
  L = G.legal(session, 0);
  assert.strictEqual(L.maxRaiseTo, 30000, 'all-in opponent does not reduce the cap below the live deeper stack');
  assert.ok(L.toCall === 8000 && L.maxRaiseTo > L.curBet);
  // hero shorter than every opponent: no cap effect
  session.seats[0].stack = 4000; session.seats[1].stack = 30000;
  session.hand.seats[0].bet = 0;
  L = G.legal(session, 0);
  assert.strictEqual(L.maxRaiseTo, 4000, 'hero stack still limits');
});

test('bet cap UI rule: a raise capped by opponents is not all-in for me (max < myBet + stack)', () => {
  const mk = (bet, stack) => ({ bet, contributed: bet, folded: false, dealt: true, allIn: stack === 0, acted: false, raiseAllowed: true });
  const session = { seats: [{ stack: 200000 }, { stack: 30000 }], hand: null };
  session.hand = { order: [0, 1], m: 2, curBet: 0, lastRaise: 0, toAct: 0, over: false, bb: 1000, seats: [mk(0, 200000), mk(0, 30000)] };
  const L = G.legal(session, 0);
  const stackMax = L.myBet + L.stack;
  assert.strictEqual(L.maxRaiseTo, 30000, 'cap is the opponent');
  assert.ok(L.maxRaiseTo < stackMax - 0.05, 'label must read Raise to X, not All-in');
  // when I am the shorter stack the cap equals my whole stack: All-in is correct
  session.seats[0].stack = 20000; session.hand.seats[0].bet = 0;
  const L2 = G.legal(session, 0);
  assert.ok(L2.maxRaiseTo >= L2.myBet + L2.stack - 0.05, 'truly all-in when my stack is the limit');
});

// Last-action chip audit: plays bot hands and checks every seat's chip (buildScenario lastAction -> symbol key)
// against the hand's own history after each action. The chip shows only the current street's action.
test('last-action chips match the hand history after every action (current street only)', () => {
  const vm = require('vm'), fs = require('fs');
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'symbols.js'), 'utf8'), ctx);
  const Sym = ctx.window.Symbols;
  const KEY = { fold: 'fold', check: 'check', call: 'call', limp: 'limp', bet: 'bet', raise: 'raise' };
  let checked = 0;
  for (let s = 0; s < 40; s++) {
    const sess = G.newSession({ cpus: 3 + (s % 6), stackBB: 20 + ((s * 7) % 120), seed: 900 + s, allBots: true, personalities: false });
    for (let h = 0; h < 15; h++) {
      if (!G.startHand(sess)) break;
      let guard = 0;
      while (!G.isHandOver(sess) && guard++ < 400) {
        G.stepBot(sess);
        const hand = sess.hand;
        G.buildScenario(sess, 0).seats.forEach((st) => {
          if (st.busted) return;
          const raw = st.folded ? '' : st.lastAction;
          const last = hand.history.filter((e) => e.seat === st.seat).pop();
          if (!last || last.street !== hand.street) {
            assert.strictEqual(raw, '', 'seat ' + st.seat + ' shows a stale action on ' + hand.street + ': ' + raw);
            return;
          }
          if (st.folded) return;
          checked++;
          const wantKey = /all-in/.test(raw) ? 'allin' : KEY[last.action];
          assert.strictEqual(Sym.actionIcon(raw).key, wantKey, 'chip for "' + raw + '" vs history ' + last.action);
          // the tag is read when the action lands; a finished hand has already paid out the stacks
          if (!hand.over) assert.strictEqual(/all-in/.test(raw), sess.seats[st.seat].stack === 0 && last.action !== 'fold', 'all-in label for "' + raw + '"');
          if (last.action === 'check') assert.ok(!/call/i.test(raw), 'a check is never shown as a call');
        });
      }
    }
  }
  assert.ok(checked > 500, 'actions checked: ' + checked);
});

console.log(failures ? '\n' + failures + ' test(s) failed' : '\nall game tests passed (bot river and sizing)');
// ---- money granularity (0.5 BB grid), elimination, odd chips, blind doubling, stack validation
function onGrid(x, grain) { const q = x / grain; return Math.abs(q - Math.round(q)) < 1e-9; }
// Every chip count must sit on the 0.5 BB grid of the level in play, and the total must be conserved.
function checkGrid(sess, total0, where) {
  const grain = sess.hand ? sess.hand.bb / 2 : sess.levelBB / 2;
  sess.seats.forEach((s, i) => assert.ok(onGrid(s.stack, grain), where + ': seat ' + i + ' stack ' + s.stack + ' is off the ' + grain + ' grid'));
  if (sess.hand) {
    sess.hand.seats.forEach((hs, i) => assert.ok(onGrid(hs.bet, grain) && onGrid(hs.contributed, grain), where + ': seat ' + i + ' bet/contributed off grid'));
    assert.ok(onGrid(sess.hand.curBet, grain), where + ': curBet ' + sess.hand.curBet + ' off grid');
  }
  assert.strictEqual(G.totalChips(sess), total0, where + ': chips not conserved');
}
// One whole hand: bots use stepBot (their own sizes), the other seats fold, call, raise on the grid or all-in.
// Returns false when no hand can be dealt (session over).
function playHand(sess, rng, total0, where) {
  if (!G.startHand(sess)) return false;
  checkGrid(sess, total0, where + ' deal');
  let guard = 0;
  while (!G.isHandOver(sess)) {
    assert.ok(guard++ < 500, where + ': hand did not finish');
    const idx = G.toAct(sess);
    if (sess.seats[idx].isBot && rng() < 0.5) {
      G.stepBot(sess);
    } else {
      const L = G.legal(sess, idx);
      const grain = sess.hand.bb / 2;
      const r = rng();
      if (r < 0.2 && L.toCall > 0) G.act(sess, idx, 'fold');
      else if (L.canRaise && r < 0.6) {
        const to = rng() < 0.2 ? L.maxRaiseTo : Math.min(L.maxRaiseTo, L.minRaiseTo + Math.floor(rng() * 8) * grain);
        G.act(sess, idx, 'raise', to);
      } else G.act(sess, idx, 'call');
    }
    checkGrid(sess, total0, where + ' action');
    // mid-hand: a seat at 0 (all-in) is still in the hand, never marked eliminated before the hand ends
    sess.seats.forEach((s, i) => {
      if (sess.hand.seats[i].dealt && !sess.hand.seats[i].folded && !G.isHandOver(sess)) assert.ok(!s.busted, where + ': seat ' + i + ' busted mid-hand');
    });
  }
  const res = G.results(sess);
  const grain = sess.hand.bb / 2;
  res.pots.forEach((p) => assert.ok(onGrid(p.amount, grain), where + ': pot ' + p.amount + ' off grid'));
  Object.keys(res.wins).forEach((k) => assert.ok(onGrid(res.wins[k], grain), where + ': win ' + res.wins[k] + ' off grid'));
  checkGrid(sess, total0, where + ' end');
  return true;
}

test('granularity: 2000+ random hands (all-ins, side pots, bot sizes) keep every chip on the 0.5 BB grid and conserve chips', () => {
  const rng = rngFrom(4242);
  let hands = 0, sidePots = 0, allIns = 0, sessions = 0;
  for (let s = 0; hands < 2000; s++) {
    const stackBB = [100, 37.5, 12, 250][s % 4];
    const sess = G.newSession({ cpus: 2 + (s % 7), seed: 1000 + s, allBots: true, stackBB, stacks: s % 2 ? 'varied' : 'equal' });
    const total0 = G.totalChips(sess);
    sessions++;
    for (let h = 0; h < 400; h++) {
      if (!playHand(sess, rng, total0, 's' + s + ' h' + h)) break;
      hands++;
      if (G.results(sess).pots.length > 1) sidePots++;
      if (sess.hand.seats.some((hs) => hs.allIn)) allIns++;
    }
  }
  assert.ok(hands >= 2000, 'only ' + hands + ' hands');
  assert.ok(sidePots > 50, 'too few side-pot hands: ' + sidePots);
  assert.ok(allIns > 200, 'too few all-in hands: ' + allIns);
  console.log('       ' + hands + ' hands in ' + sessions + ' sessions: ' + sidePots + ' with side pots, ' + allIns + ' with an all-in');
});

test('blind doubling: stacks re-expressed on the new 0.5 BB grid between hands; rounding goes to the bank, chips conserved', () => {
  const rng = rngFrom(77);
  let banked = 0, levels = 0;
  for (let s = 0; s < 40; s++) {
    const sess = G.newSession({ cpus: 6, seed: 500 + s, allBots: true, stackBB: 75.5, stacks: 'varied' });
    const total0 = G.totalChips(sess);
    for (let lvl = 0; lvl < 5 && !sess.over; lvl++) {
      sess.cfg.bb = 100 * Math.pow(2, lvl); // the app doubles cfg.bb between hands; startHand re-expresses the stacks
      sess.cfg.sb = sess.cfg.bb / 2;
      for (let h = 0; h < 8; h++) {
        if (!playHand(sess, rng, total0, 'd' + s + ' L' + lvl + ' h' + h)) break;
        assert.strictEqual(sess.levelBB, sess.cfg.bb, 'stacks not re-expressed at the new level');
      }
      levels++;
    }
    if (sess.bank > 0) banked++;
  }
  assert.ok(banked > 0, 'no level change ever banked a rounding residue; the rule is not exercised');
  console.log('       ' + levels + ' levels played, rounding banked in ' + banked + ' of 40 sessions');
});

test('elimination: under 1 BB is out between hands (never dealt again); an all-in at 0 mid-hand keeps playing', () => {
  assert.strictEqual(G.isEliminated(0), true);
  assert.strictEqual(G.isEliminated(0.5), true);
  assert.strictEqual(G.isEliminated(0.99), true);
  assert.strictEqual(G.isEliminated(1), false);
  assert.strictEqual(G.isEliminated(100), false);
  // hero at 0.5 BB before the next hand: out, the session is over
  let sess = G.newSession({ cpus: 2, seed: 3, allBots: true });
  sess.seats[0].stack = 50;
  assert.strictEqual(G.startHand(sess), null);
  assert.strictEqual(sess.over, 'busted');
  assert.strictEqual(sess.seats[0].busted, true);
  // a bot at 0.5 BB is removed; the others are dealt in
  sess = G.newSession({ cpus: 3, seed: 4, allBots: true });
  sess.seats[2].stack = 50;
  assert.ok(G.startHand(sess));
  assert.strictEqual(sess.seats[2].busted, true);
  assert.strictEqual(sess.hand.seats[2].dealt, false, 'eliminated bot was dealt in');
  // exactly 1 BB: not eliminated; the blind posts all-in and the seat is still in the hand
  sess = G.newSession({ cpus: 2, seed: 5, allBots: true });
  sess.seats.forEach((s) => { s.stack = 100; });
  G.startHand(sess);
  assert.ok(sess.hand.seats.some((hs) => hs.allIn), 'a blind of 1 BB should post all-in');
  sess.seats.forEach((s, i) => { if (sess.hand.seats[i].dealt) assert.ok(!s.busted, 'seat ' + i + ' busted during the hand'); });
});

test('odd half-BB chips: a split pot gives the extra 0.5 BB unit to the first winner clockwise after the button', () => {
  const rng = rngFrom(99);
  let splits = 0, odd = 0;
  for (let s = 0; s < 400; s++) {
    const sess = G.newSession({ cpus: 3 + (s % 5), seed: 7000 + s, allBots: true, stackBB: 40 + (s % 3) * 0.5 });
    const total0 = G.totalChips(sess);
    for (let h = 0; h < 60; h++) {
      if (!playHand(sess, rng, total0, 'o' + s + ' h' + h)) break;
      const hand = sess.hand, r = G.results(sess);
      if (!r.showdown || r.pots.length !== 1 || r.pots[0].winners.length < 2) continue;
      splits++;
      const w = r.pots[0].winners, grain = hand.bb / 2;
      const units = r.pots[0].amount / grain, base = Math.floor(units / w.length), rem = units - base * w.length;
      if (rem) odd++;
      // clockwise from the seat after the button (SB side); the button itself comes last
      const sbOrder = hand.order.slice(1).concat(hand.order.slice(0, 1)).filter((idx) => w.indexOf(idx) >= 0);
      sbOrder.forEach((idx, j) => assert.strictEqual(r.wins[idx], (base + (j < rem ? 1 : 0)) * grain, 'split pot share for seat ' + idx));
    }
  }
  assert.ok(splits > 0, 'no split pot was produced');
  console.log('       ' + splits + ' split pots, ' + odd + ' with an odd half-BB unit');
});

test('starting stack: default 100 BB, min 5, max 1000, 0.5 steps, never negative or NaN', () => {
  const v = G.validStackBB;
  assert.strictEqual(v(undefined), 100);
  assert.strictEqual(v(NaN), 100);
  assert.strictEqual(v('abc'), 100);
  assert.strictEqual(v(-20), 5);
  assert.strictEqual(v(0), 5);
  assert.strictEqual(v(4.9), 5);
  assert.strictEqual(v(100.26), 100.5);
  assert.strictEqual(v(100.24), 100);
  assert.strictEqual(v(5000), 1000);
  assert.strictEqual(v('250'), 250);
  const sess = G.newSession({ cpus: 3, stackBB: -7, seed: 1 });
  sess.seats.forEach((s) => assert.strictEqual(s.stack, 500));
});

process.exitCode = failures ? 1 : 0;
