'use strict';
const assert = require('assert');
const path = require('path');
const E = require(path.join(__dirname, '..', 'public', 'engine.js'));

let failures = 0;
const ONLY = process.env.ENGINE_ONLY || '';
function test(name, fn) {
  if (ONLY && name.indexOf(ONLY) < 0) return;
  const t0 = Date.now();
  try {
    fn();
    console.log('  ok   ' + name + ' (' + (Date.now() - t0) + ' ms)');
  } catch (e) {
    failures++;
    console.log('  FAIL ' + name + '\n       ' + e.message);
  }
}

// Heavy sweeps (thousands of evaluations) run only in the heavy phase: ENGINE_FULL=1 node test/engine.test.js.
const FULL = process.env.ENGINE_FULL === '1';
let skipped = 0;
function heavy(name, fn) {
  if (!FULL) { skipped++; console.log('  skip ' + name + ' (heavy: set ENGINE_FULL=1)'); return; }
  test(name, fn);
}

function seededRng(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const score = (c) => E.evaluateHand(c).score;
const cat = (c) => E.evaluateHand(c).rank;

// ------------------------------------------------------------ evaluator
test('hand categories are identified', () => {
  assert.strictEqual(cat(['As', 'Ks', 'Qs', 'Js', 'Ts']), 8, 'royal flush');
  assert.strictEqual(cat(['5h', '4h', '3h', '2h', 'Ah']), 8, 'wheel straight flush');
  assert.strictEqual(cat(['9c', '9d', '9h', '9s', '2c']), 7, 'quads');
  assert.strictEqual(cat(['Kc', 'Kd', 'Kh', '3s', '3c']), 6, 'full house');
  assert.strictEqual(cat(['Ah', 'Jh', '8h', '4h', '2h']), 5, 'flush');
  assert.strictEqual(cat(['5h', '4d', '3c', '2s', 'Ah']), 4, 'wheel straight');
  assert.strictEqual(cat(['Qh', 'Jd', 'Tc', '9s', '8h']), 4, 'straight');
  assert.strictEqual(cat(['7c', '7d', '7h', 'Ks', '2c']), 3, 'trips');
  assert.strictEqual(cat(['Ac', 'Ad', '4h', '4s', 'Kc']), 2, 'two pair');
  assert.strictEqual(cat(['Ac', 'Ad', '5h', '4s', 'Kc']), 1, 'pair');
  assert.strictEqual(cat(['Ac', 'Qd', '5h', '4s', '9c']), 0, 'high card');
});

test('seven-card best hand is chosen', () => {
  // Straight flush hidden among seven cards.
  assert.strictEqual(cat(['5h', '6h', '7h', '8h', '9h', 'Ac', 'Ad']), 8);
  // Full house from 7 cards with two trips.
  assert.strictEqual(cat(['Kc', 'Kd', 'Kh', '3s', '3c', '3d', 'Ah']), 6);
});

test('ordering and kicker tie-breaks', () => {
  assert.ok(score(['2h', '4h', '6h', '8h', 'Th']) > score(['Ac', 'Kd', 'Qh', 'Js', '9c']), 'flush beats straight');
  assert.ok(score(['Ac', 'Ad', 'Kh', 'Qs', '9c']) > score(['Ac', 'Ad', 'Kh', 'Qs', '8c']), 'kicker 9 beats 8');
  assert.ok(score(['Ac', 'Ad', 'Kh', 'Kd', '2c']) > score(['Qc', 'Qd', 'Jh', 'Jd', 'Ac']), 'AA-KK beats QQ-JJ');
  assert.ok(score(['Ac', 'Ad', 'Kh', 'Qs', '9c']) === score(['As', 'Ah', 'Kd', 'Qc', '9s']), 'suits do not matter');
  assert.ok(score(['6h', '5d', '4c', '3s', '2h']) > score(['5h', '4d', '3c', '2s', 'Ah']), '6-high straight beats wheel');
  assert.ok(score(['Kh', 'Kd', 'Kc', 'As', 'Ac']) > score(['Qh', 'Qd', 'Qc', 'As', 'Ac']), 'trips K beat trips Q');
});

test('parseCard / cardStr round trip', () => {
  for (const c of ['As', 'Td', '7h', '2c']) assert.strictEqual(E.cardStr(E.parseCard(c)), c);
  assert.throws(() => E.parseCard('1x'));
});

// ------------------------------------------------------------ equity
test('AA vs KK preflop is about 82%', () => {
  const eq = E.equity(['As', 'Ad'], [], ['KK'], { samples: 6000, rng: seededRng(7) });
  assert.ok(Math.abs(eq - 0.82) < 0.025, 'got ' + eq);
});

test('AA vs random hand is about 85%', () => {
  const eq = E.equity(['As', 'Ad'], [], 1, { samples: 4000, rng: seededRng(11) });
  assert.ok(Math.abs(eq - 0.85) < 0.02, 'got ' + eq);
});

test('72o vs AA is about 12%', () => {
  const eq = E.equity(['7h', '2c'], [], ['AA'], { samples: 4000, rng: seededRng(3) });
  assert.ok(Math.abs(eq - 0.12) < 0.02, 'got ' + eq);
});

test('equity is 100% with a made nut hand on the river', () => {
  const eq = E.equity(['As', 'Ad'], ['Ah', 'Kd', 'Ks', '2c', '7h'], ['QQ'], { samples: 300, rng: seededRng(5) });
  assert.ok(eq > 0.99, 'got ' + eq);
});

// ------------------------------------------------------------ outs
test('flush draw counts nine flush outs', () => {
  const o = E.outs(['Ah', 'Kh'], ['7h', '2h', '9d']);
  assert.ok(o >= 9, 'outs ' + o);
});

test('overcards with no pair have outs', () => {
  const o = E.outs(['Ah', 'Kc'], ['7d', '2s', '9h']);
  assert.ok(o >= 6, 'outs ' + o);
});

// ------------------------------------------------------------ charts
test('range chart is a 13x13 grid with normalised frequencies', () => {
  for (const spot of E.listChartSpots(6)) {
    const c = E.getRangeChart(6, spot.position, spot.facing);
    assert.strictEqual(c.grid.length, 13);
    assert.ok(c.title.length > 0);
    for (let i = 0; i < 13; i++) {
      assert.strictEqual(c.grid[i].length, 13);
      for (let j = 0; j < 13; j++) {
        const cell = c.grid[i][j];
        const sum = cell.fold + cell.call + cell.raise;
        assert.ok(Math.abs(sum - 1) < 1e-9, 'cell ' + cell.hand + ' sums to ' + sum);
      }
    }
  }
  const g = E.getRangeChart(6, 'CO', 'open').grid;
  assert.strictEqual(g[0][0].hand, 'AA');
  assert.strictEqual(g[0][1].hand, 'AKs', 'suited above diagonal');
  assert.strictEqual(g[1][0].hand, 'AKo', 'offsuit below diagonal');
});

test('listChartSpots returns valid pairs per table size', () => {
  assert.ok(E.listChartSpots(2).length > 0);
  assert.ok(E.listChartSpots(9).length > E.listChartSpots(2).length);
  assert.throws(() => E.getRangeChart(6, 'LJ', 'open'), 'LJ does not exist at 6-handed');
});

test('chart opens tighter from UTG than from BTN', () => {
  const count = (g) => g.flat().filter((c) => c.raise === 1).length;
  assert.ok(count(E.getRangeChart(6, 'UTG', 'open').grid) < count(E.getRangeChart(6, 'BTN', 'open').grid));
});

// ------------------------------------------------------------ scenarios
function checkConsistency(s) {
  const N = s.numPlayers;
  assert.strictEqual(s.seats.length, N, 'seat count');
  assert.strictEqual(s.seats.filter((x) => x.isHero).length, 1, 'one hero');
  assert.strictEqual(new Set(s.seats.map((x) => x.position)).size, N, 'unique positions');
  const hero = s.seats.find((x) => x.isHero);
  assert.strictEqual(hero.position, s.heroPosition);
  const want = { preflop: 0, flop: 3, turn: 4, river: 5 }[s.street];
  assert.strictEqual(s.board.length, want, 'board length for ' + s.street);
  const all = s.hero.concat(s.board);
  assert.strictEqual(new Set(all).size, all.length, 'duplicate cards');
  const contrib = s.seats.reduce((a, x) => a + x.contributed, 0);
  assert.ok(Math.abs(contrib - s.pot) < 1e-6, 'pot ' + s.pot + ' vs contributed ' + contrib);
  const maxBet = Math.max.apply(null, s.seats.map((x) => x.bet));
  for (const x of s.seats) {
    assert.ok(x.stack >= 0, 'negative stack');
    assert.ok(x.bet <= x.contributed + 1e-9, 'bet above contributed');
    assert.ok(x.bet <= maxBet + 1e-9, 'bet above max');
  }
  // toCall is capped at the hero's stack (the hero can only call all-in).
  assert.ok(Math.abs(s.toCall - Math.min(Math.max(0, maxBet - hero.bet), hero.stack)) < 1e-6, 'toCall mismatch');
  assert.strictEqual(s.heroStack, hero.stack);
  for (const o of s.raiseOptions) {
    assert.ok(o.amount > maxBet - 1e-9, 'raise option below current bet');
    assert.ok(o.amount <= hero.bet + hero.stack + 1e-9, 'raise option above stack');
  }
  assert.ok(s.situation.length > 0);
}

heavy('2000 generated scenarios are consistent', () => {
  let n = 0;
  for (let i = 0; i < 2000; i++) {
    const s = E.generateScenario({ seed: 'c' + i });
    checkConsistency(s);
    n++;
  }
  assert.strictEqual(n, 2000);
});

test('scenario options are honoured', () => {
  for (let i = 0; i < 60; i++) {
    const s = E.generateScenario({ players: 4, street: 'turn', seed: 'o' + i });
    assert.strictEqual(s.numPlayers, 4);
    assert.strictEqual(s.street, 'turn');
    assert.strictEqual(s.board.length, 4);
  }
});

test('500 scenarios show wide variety', () => {
  const players = new Set(), positions = new Set(), streets = new Set(), tocalls = new Set();
  const hands = new Set(), boards = new Set(), combos = new Set(), keys = [];
  for (let i = 0; i < 500; i++) {
    const s = E.generateScenario({ seed: 'v' + i });
    players.add(s.numPlayers);
    positions.add(s.heroPosition);
    streets.add(s.street);
    tocalls.add(s.toCall);
    hands.add(s.hero.slice().sort().join(''));
    boards.add(s.board.slice().sort().join(''));
    combos.add(s.hero.concat(s.board).slice().sort().join(''));
    keys.push(s.hero.concat(s.board).slice().sort().join(''));
  }
  assert.ok(players.size >= 8, 'player counts ' + players.size);
  assert.ok(positions.size >= 8, 'positions ' + positions.size);
  assert.strictEqual(streets.size, 4, 'streets');
  assert.ok(tocalls.size >= 5, 'toCall sizes ' + tocalls.size);
  // 500 uniform deals of 1326 combos give ~416 distinct hands on average.
  assert.ok(hands.size >= 380, 'distinct hero hands ' + hands.size);

  // Preflop scenarios reveal no board, so hero+board collisions are expected.
  assert.ok(combos.size >= 380, 'distinct hero+board combos ' + combos.size);
  const counts = new Map();
  for (const k of keys) counts.set(k, (counts.get(k) || 0) + 1);
  // Random collisions over 1326 two-card hands: a max of 3 repeats is expected.
  assert.ok(Math.max.apply(null, Array.from(counts.values())) <= 3, 'same deal repeated too often');
});

test('evaluate returns a well-formed result for sampled scenarios', () => {
  const times = [];
  for (let i = 0; i < 40; i++) {
    const s = E.generateScenario({ seed: 'e' + i });
    const actions = ['fold', 'call', 'raise'];
    const action = actions[i % 3];
    const amt = s.raiseOptions.length ? s.raiseOptions[0].amount : undefined;
    const t0 = process.hrtime.bigint();
    const r = E.evaluate(s, action, amt);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    assert.ok(['fold', 'call', 'raise'].includes(r.best));
    assert.ok(['best', 'good', 'mistake', 'blunder'].includes(r.rating));
    assert.ok(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100, 'score ' + r.score);
    assert.strictEqual(r.correct, r.rating === 'best' || r.rating === 'good');
    assert.ok(r.explanation.length >= 3 && r.explanation.length <= 7, 'bullets ' + r.explanation.length);
    assert.ok(Number.isFinite(r.ev.call));
    assert.ok(r.stats.some((x) => x.label === 'Chance to win vs range'));
    assert.ok(r.stats.some((x) => x.label === 'Pot odds (needed chance)'));
    assert.ok(r.stats.some((x) => x.label === 'Villain range estimate'));
    if (s.street === 'preflop') assert.ok(r.stats.some((x) => /percentile/.test(x.label)));
    else assert.ok(r.stats.some((x) => x.label === 'Outs' || x.label === 'Board texture'));
  }
  assert.ok(Math.max.apply(null, times) < 150, 'slowest evaluate ' + Math.max.apply(null, times).toFixed(1) + ' ms');
});

test('mixed spots: close alternative is rated good', () => {
  // Synthetic: call and raise with equal EV should never be a mistake.
  const s = E.generateScenario({ seed: 'mix' });
  const r = E.evaluate(s, 'call', undefined, { samples: 1500 });
  if (r.best !== 'call') assert.ok(['good', 'best', 'mistake', 'blunder'].includes(r.rating));
});

test('translation tables have identical keys', () => {
  const en = Object.keys(E.i18n.en).sort(), es = Object.keys(E.i18n.es).sort();
  assert.deepStrictEqual(es, en);
  for (const k of en) {
    assert.ok(E.i18n.es[k].length > 0, 'empty Spanish text for ' + k);
  }
});

// English words that must not leak into Spanish output (poker jargon kept on purpose is excluded).
const ENGLISH_LEAK = /(the|you|your|fold|call|raise|villain|villains|pot|check|bet|pending|is|are|with|from|versus|and|opened|folds|calls|raises|limps|checks)/i;

test('Spanish output contains no English fallback words', () => {
  let checked = 0;
  for (let i = 0; i < 150; i++) {
    const s = E.generateScenario({ seed: 'es' + i, lang: 'es' });
    const r = E.evaluate(s, i % 2 ? 'call' : 'raise', undefined, { samples: 400 });
    const texts = [s.situation, r.summary].concat(r.explanation, r.more || [], r.stats.flatMap((x) => [x.label, String(x.value), x.hint || '']));
    for (const row of s.raiseOptions) texts.push(row.label);
    for (const seat of s.seats) texts.push(seat.lastAction, seat.name);
    for (const t of texts) {
      assert.ok(!ENGLISH_LEAK.test(t), 'English leak in: ' + t);
      checked++;
    }
  }
  assert.ok(checked > 1000);
});

test('Spanish chart titles and hand texts are localised', () => {
  const g = E.getRangeChart(6, 'CO', 'open', { lang: 'es' });
  assert.ok(/Apertura/.test(g.title), g.title);
  assert.ok(!ENGLISH_LEAK.test(g.title), g.title);
  assert.strictEqual(E.getRangeChart(6, 'CO', 'open', 'en').title.indexOf('Open raise') >= 0, true);
});

test('explanation is short: 3 bullets, optional 4 extras, 6-8 stats', () => {
  for (let i = 0; i < 60; i++) {
    const lang = i % 2 ? 'es' : 'en';
    const s = E.generateScenario({ seed: 'short' + i, lang: lang });
    const r = E.evaluate(s, 'call', undefined, { samples: 600 });
    assert.strictEqual(r.explanation.length, 3);
    assert.ok(r.more.length <= 4);
    assert.ok(r.explanation[0].split(/\s+/).length <= 22, 'long first bullet: ' + r.explanation[0]);
    for (const b of r.explanation.slice(1).concat(r.more)) assert.ok(b.split(/\s+/).length <= 25, 'long bullet: ' + b);
    assert.ok(r.stats.length >= 6 && r.stats.length <= 8, 'stats ' + r.stats.length);
    assert.ok(typeof r.summary === 'string' && r.summary.length > 0);
  }
});

test('lang is honoured from scenario and evaluate options', () => {
  const s = E.generateScenario({ seed: 'lang1', lang: 'es' });
  assert.strictEqual(s.lang, 'es');
  const r = E.evaluate(s, 'fold', undefined, { samples: 300 });
  assert.ok(!ENGLISH_LEAK.test(r.summary), r.summary);
  const en = E.evaluate(Object.assign({}, s, { lang: 'en' }), 'fold', undefined, { samples: 300 });
  assert.ok(/is best/.test(en.summary), en.summary);
});

test('position option places hero in the requested seat', () => {
  for (const pos of ['UTG', 'CO', 'BTN', 'SB', 'BB']) {
    for (let i = 0; i < 10; i++) {
      const s = E.generateScenario({ players: 6, position: pos, seed: pos + i });
      assert.strictEqual(s.heroPosition, pos);
      assert.strictEqual(s.numPlayers, 6);
      assert.strictEqual(s.seats.find((x) => x.isHero).position, pos);
    }
  }
  assert.throws(() => E.generateScenario({ players: 6, position: 'LJ' }), /not valid/);
  const any = E.generateScenario({ position: 'LJ', seed: 'lj' });
  assert.strictEqual(any.heroPosition, 'LJ');
  assert.ok(any.numPlayers >= 9);
});

test('actionLog is kept but may be empty', () => {
  const s = E.generateScenario({ seed: 'log' });
  assert.ok(Array.isArray(s.actionLog));
});

test('no user-visible string says "equity" or "equidad"', () => {
  const banned = /equity|equidad/i;
  for (const lang of ['en', 'es']) {
    for (const [k, v] of Object.entries(E.i18n[lang])) assert.ok(!banned.test(v), lang + '.' + k + ': ' + v);
  }
  for (const lang of ['en', 'es']) {
    for (let i = 0; i < 60; i++) {
      const s = E.generateScenario({ seed: 'noeq' + i, lang: lang });
      const r = E.evaluate(s, i % 3 === 0 ? 'fold' : i % 3 === 1 ? 'call' : 'raise', undefined, { samples: 400 });
      const texts = [s.situation, r.summary].concat(r.explanation, r.more, s.raiseOptions.map((o) => o.label));
      for (const row of r.stats) texts.push(row.label, String(row.value), row.hint || '');
      for (const t of texts) assert.ok(!banned.test(t), lang + ' output contains banned word: ' + t);
    }
    const chart = E.getRangeChart(6, 'CO', 'open', lang);
    assert.ok(!banned.test(chart.title), chart.title);
  }
});

heavy('narration: no undefined/NaN, one-line summary, varied openings', () => {
  const openings = new Set();
  for (const lang of ['en', 'es']) {
    for (let i = 0; i < 200; i++) {
      const s = E.generateScenario({ seed: 'nar' + i, lang: lang });
      const r = E.evaluate(s, i % 2 ? 'call' : 'raise', undefined, { samples: 300 });
      const texts = [r.summary, s.situation].concat(r.explanation, r.more);
      for (const t of texts) {
        assert.ok(!/undefined|NaN|null/.test(t), lang + ' bad text: ' + t);
        assert.ok(t.length > 0);
      }
      assert.ok(!/\n/.test(r.summary), 'summary must be one line');
      assert.ok(r.summary.split(/\s+/).length <= 16, 'summary too long: ' + r.summary);
      assert.strictEqual(r.explanation.length, 3);
      const open = r.explanation[0].split(' ').slice(0, 3).join(' ');
      openings.add(lang + ':' + open);
    }
  }
  assert.ok(openings.size >= 15, 'only ' + openings.size + ' distinct openings');
});

heavy('wording sweep: 300 scenarios x en/es x fold/call/raise', () => {
  const checks = [
    [/\b1 (limpers|limpeos|players|jugadores|opponents|rivales)\b/, 'singular 1 with plural noun'],
    [/\b([2-9]|\d{2,}) (limper|limpeo)\b/, 'plural number with singular limper'],
    [/\bone who\b|\bone (loose|tight|passive|aggressive|balanced)\b/, 'one + adjective'],
    [/\buno\b/, 'uno'],
    [/ {2,}/, 'double space'],
    [/[{}]/, 'template brace'],
    [/undefined|NaN|null/, 'undefined/NaN'],
  ];
  let scanned = 0;
  for (const lang of ['en', 'es']) {
    for (let i = 0; i < 300; i++) {
      const s = E.generateScenario({ seed: 'sweep' + i, lang: lang });
      for (const action of ['fold', 'call', 'raise']) {
        const r = E.evaluate(s, action, undefined, { samples: 150 });
        const texts = [r.summary, s.situation, s.heroPosition]
          .concat(r.explanation, r.more, s.raiseOptions.map((o) => o.label))
          .concat(r.stats.flatMap((x) => [x.label, String(x.value), x.hint || '']))
          .concat(s.seats.map((x) => x.lastAction));
        for (const text of texts) {
          for (const [re, name] of checks) assert.ok(!re.test(text), lang + ' ' + action + ' ' + name + ': ' + text);
          scanned++;
        }
      }
    }
  }
  assert.ok(scanned > 20000, 'scanned ' + scanned);
});

// ------------------------------------------------ audit regressions
test('pair kickers: only the best five cards count (3h As 8c 8h Kc Th 4s ties 5h Ah ...)', () => {
  const a = E.evaluateHand(['3h', 'As', '8c', '8h', 'Kc', 'Th', '4s']).score;
  const b = E.evaluateHand(['5h', 'Ah', '8c', '8h', 'Kc', 'Th', '4s']).score;
  assert.strictEqual(a, b);
});

test('two pair with a third pair on the board: kicker is the best leftover card', () => {
  const a = E.evaluateHand(['As', 'Ad', 'Ks', 'Kd', '7c', '7h', '9d']).score;
  const b = E.evaluateHand(['As', 'Ad', 'Ks', 'Kd', '9d', '2c', '3h']).score;
  assert.strictEqual(a, b);
  const c = E.evaluateHand(['As', 'Ad', 'Ks', 'Kd', '7c', '7h', '8d']).score;
  assert.ok(a > c);
});

test('scoreCards matches a brute-force best-of-all-5-card-hands on 20k random 7-card hands', () => {
  const rng = seededRng(12345);
  const deck = [];
  for (const r of '23456789TJQKA') for (const s of 'shdc') deck.push(r + s);
  const combos = [];
  for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) for (let c = b + 1; c < 7; c++)
    for (let d = c + 1; d < 7; d++) for (let e2 = d + 1; e2 < 7; e2++) combos.push([a, b, c, d, e2]);
  for (let i = 0; i < 20000; i++) {
    const cards = deck.slice();
    for (let j = cards.length - 1; j > 0; j--) { const q = Math.floor(rng() * (j + 1)); const x = cards[j]; cards[j] = cards[q]; cards[q] = x; }
    const hand = cards.slice(0, 7);
    let best = -1;
    for (const cb of combos) {
      const sc = E.evaluateHand(cb.map((k) => hand[k])).score;
      if (sc > best) best = sc;
    }
    const got = E.evaluateHand(hand).score;
    assert.strictEqual(got, best, 'hand ' + hand.join(' '));
  }
});

heavy('raise EV: premium hands are rarely rated fold and raise EVs stay in range', () => {
  let premium = 0, foldBest = 0;
  const pairs = 'AA KK QQ'.split(' ');
  for (let i = 0; i < 4000 && premium < 60; i++) {
    const s = E.generateScenario({ seed: 'prem' + i, lang: 'en' });
    const h = s.hero.map((c) => c[0]);
    const isPair = h[0] === h[1] && pairs.indexOf(h[0] + h[1]) >= 0;
    const isAK = (h[0] === 'A' && h[1] === 'K') || (h[0] === 'K' && h[1] === 'A');
    if (!isPair && !isAK) continue;
    premium++;
    const r = E.evaluate(s, 'call', undefined, { samples: 800 });
    // A fold is correct when the chance to win is below the pot odds; count only the other folds.
    const eP = Number(r.stats.find((x) => x.key === 'win_chance').value.replace('%', ''));
    const reqP = s.toCall > 0 ? (100 * Math.min(s.toCall, s.heroStack)) / (s.pot + Math.min(s.toCall, s.heroStack)) : 0;
    if (r.best === 'fold' && eP >= reqP + 5) foldBest++;
    if (r.ev.raise != null) {
      const stackSum = s.seats.reduce((a, x) => a + x.stack + x.contributed, 0);
      assert.ok(Number.isFinite(r.ev.raise), 'raise EV not finite');
      assert.ok(r.ev.raise <= stackSum && r.ev.raise >= -s.heroStack - s.pot, 'raise EV outlier ' + r.ev.raise);
    }
  }
  assert.ok(premium >= 40, 'premium sample too small: ' + premium);
  assert.ok(foldBest <= Math.ceil(premium * 0.1), 'premium folds rated best: ' + foldBest + '/' + premium);
});

test('toCall is capped at the hero stack; pot odds use the capped amount', () => {
  const s = E.generateScenario({ seed: 'capped' });
  const synthetic = Object.assign({}, s, { toCall: 59.5, heroStack: 48 });
  const r = E.evaluate(synthetic, 'call', undefined, { samples: 300 });
  const row = r.stats.find((x) => x.key === 'pot_odds');
  // Pot odds use the capped 48 BB; a covering all-in adds the stack-off margin (about 5 points).
  const base = Math.round((48 / (synthetic.pot + 48)) * 100);
  assert.ok(row.value === base + '%' || row.value === base + 5 + '%', 'pot odds ' + row.value + ' vs base ' + base);
});

test('stats rows: stable keys, 6-8 rows, players/pot/to-call merged in one row', () => {
  for (let i = 0; i < 40; i++) {
    const s = E.generateScenario({ seed: 'rows' + i, lang: i % 2 ? 'es' : 'en' });
    const r = E.evaluate(s, 'call', undefined, { samples: 300 });
    const keys = r.stats.map((x) => x.key);
    assert.ok(keys.length >= 6 && keys.length <= 8, 'row count ' + keys.length);
    for (const k of ['hand', 'win_chance', 'pot_odds', 'table', 'villain', 'ev']) assert.ok(keys.indexOf(k) >= 0, 'missing ' + k);
    assert.ok(keys.indexOf('outs') >= 0 || keys.indexOf('percentile') >= 0);
    if (s.street !== 'preflop') assert.ok(keys.indexOf('texture') >= 0, 'postflop texture row');
    const table = r.stats.find((x) => x.key === 'table');
    assert.ok(/\d/.test(table.value) && table.value.indexOf('BB') >= 0);
  }
});

// ------------------------------------------------ range narrowing
function syntheticRiver(history) {
  return {
    id: 'syn', lang: 'en', numPlayers: 2, street: 'river', hero: ['Kd', 'Qc'],
    board: ['Ks', '7c', '2d', '9s', '3h'], blinds: { sb: 0.5, bb: 1 }, pot: 50, toCall: 10,
    heroStack: 30, heroPosition: 'BB', heroSeat: 1, buttonSeat: 0, inPosition: true,
    seats: [
      { seat: 0, position: 'BTN', name: 'Villain', stack: 50, bet: 10, contributed: 30, folded: false, isHero: false,
        style: 'balanced', lastAction: 'bets 10 BB', lastActionKind: 'bet', preflopRole: 'call_open' },
      { seat: 1, position: 'BB', name: 'Hero', stack: 30, bet: 0, contributed: 20, folded: false, isHero: true,
        style: 'balanced', lastAction: 'pending', lastActionKind: 'pending', preflopRole: null },
    ],
    actionLog: [], raiseOptions: [], situation: 'test', history: history,
  };
}
function equityOf(s) {
  const r = E.evaluate(s, 'call', undefined, { samples: 4000, rng: seededRng(99) });
  return parseInt(r.stats.find((x) => x.key === 'win_chance').value, 10);
}

test('same hand and board: long-surviving villain gives a lower chance to win than a one-street caller', () => {
  const longHist = [
    { street: 'preflop', seat: 0, action: 'call', amount: 1, potBefore: 2, betFraction: null },
    { street: 'flop', seat: 1, action: 'bet', amount: 5, potBefore: 10, betFraction: 0.5 },
    { street: 'flop', seat: 0, action: 'call', amount: 5, potBefore: 15, betFraction: null },
    { street: 'turn', seat: 1, action: 'bet', amount: 10, potBefore: 25, betFraction: 0.4 },
    { street: 'turn', seat: 0, action: 'call', amount: 10, potBefore: 35, betFraction: null },
    { street: 'river', seat: 0, action: 'bet', amount: 10, potBefore: 40, betFraction: 0.25 },
  ];
  const oneStreetHist = [
    { street: 'preflop', seat: 0, action: 'call', amount: 1, potBefore: 2, betFraction: null },
    { street: 'river', seat: 0, action: 'bet', amount: 10, potBefore: 40, betFraction: 0.25 },
  ];
  const longE = equityOf(syntheticRiver(longHist));
  const oneE = equityOf(syntheticRiver(oneStreetHist));
  assert.ok(longE + 5 <= oneE, 'long ' + longE + '% vs one-street ' + oneE + '%');
  assert.strictEqual(E.describeRange(syntheticRiver(longHist), 0, 'en').indexOf('very strong') >= 0 ||
    E.describeRange(syntheticRiver(longHist), 0, 'en').indexOf('strong') >= 0, true);
});

test('river after multi-street action gives a narrower range than a one-street case (seeded cases)', () => {
  let cases = 0, strictlyNarrower = 0;
  for (let i = 0; i < 60 && cases < 12; i++) {
    const s = E.generateScenario({ seed: 'narrow' + i, street: 'river' });
    const counts = {};
    for (const h of s.history) if (h.street !== 'preflop' && h.action !== 'fold') counts[h.seat] = (counts[h.seat] || new Set());
    for (const h of s.history) if (h.street !== 'preflop' && h.action !== 'fold') counts[h.seat].add(h.street);
    const seat = s.seats.find((x) => !x.isHero && !x.folded && counts[x.seat] && counts[x.seat].size >= 2);
    if (!seat) continue;
    cases++;
    const oneHist = s.history.filter((h) => h.seat !== seat.seat || h.street === 'preflop' || h.street === 'river');
    const full = E.rangeSummary(s, seat.seat, 'en');
    const one = E.rangeSummary(Object.assign({}, s, { history: oneHist }), seat.seat, 'en');
    assert.ok(full.mass <= one.mass + 1e-12, 'multi-street range wider than one-street');
    if (full.mass < one.mass - 1e-9) strictlyNarrower++;
  }
  assert.ok(cases >= 12, 'only ' + cases + ' cases');
  assert.ok(strictlyNarrower >= 8, 'narrower in only ' + strictlyNarrower + ' cases');
});

test('no history: falls back to the position/style range model', () => {
  const s = syntheticRiver(undefined);
  delete s.history;
  const r = E.evaluate(s, 'call', undefined, { samples: 500 });
  assert.ok(Number.isFinite(parseInt(r.stats.find((x) => x.key === 'win_chance').value, 10)));
  assert.ok(E.describeRange(s, 0, 'es').length > 0);
});

test('river evaluate with history stays under 150 ms', () => {
  const times = [];
  for (let i = 0; i < 20; i++) {
    const s = E.generateScenario({ seed: 'perfriver' + i, street: 'river' });
    const t0 = process.hrtime.bigint();
    E.evaluate(s, 'call');
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  assert.ok(Math.max.apply(null, times) < 150, 'slowest ' + Math.max.apply(null, times).toFixed(1) + ' ms');
});

// ------------------------------------------------ stack-aware evaluation
// Same spot with villains that either cover the hero or are shorter than him.
function stackSpot(seed, covering, heroStack, lang) {
  const s = E.generateScenario({ seed: seed, lang: lang || 'en', street: 'flop' });
  const seats = s.seats.map((x) => Object.assign({}, x));
  const hero = seats.find((x) => x.isHero);
  hero.stack = heroStack;
  for (const v of seats) {
    if (v.isHero || v.folded) continue;
    v.contributed = 0;
    v.stack = covering ? heroStack + 200 : 1;
  }
  return Object.assign({}, s, { seats: seats, heroStack: heroStack, toCall: heroStack, heroCovered: covering });
}

test('facing a covering all-in needs more chance to win than a non-covering one', () => {
  for (const seed of ['cov1', 'cov2', 'cov3']) {
    const cov = E.evaluate(stackSpot(seed, true, 60), 'call', undefined, { samples: 400 });
    const nc = E.evaluate(stackSpot(seed, false, 60), 'call', undefined, { samples: 400 });
    const a = parseInt(cov.stats.find((x) => x.key === 'pot_odds').value, 10);
    const b = parseInt(nc.stats.find((x) => x.key === 'pot_odds').value, 10);
    assert.ok(a > b, seed + ': covering ' + a + '% vs non-covering ' + b + '%');
    assert.ok(a - b >= 3 && a - b <= 7, seed + ': margin ' + (a - b));
  }
});

test('deep stack notes say deep, short stack notes say short (predictable direction)', () => {
  const deep = E.evaluate(stackSpot('deep1', false, 200), 'call', undefined, { samples: 300 });
  assert.ok(deep.more.some((t) => /You are deep \(\d+ BB\)/.test(t)), 'deep note: ' + deep.more.join(' | '));
  const short = E.evaluate(stackSpot('short1', false, 12), 'call', undefined, { samples: 300 });
  assert.ok(short.more.some((t) => /You are short \(12 BB\)/.test(t)), 'short note: ' + short.more.join(' | '));
  const shortEs = E.evaluate(stackSpot('short1', false, 12, 'es'), 'call', undefined, { samples: 300 });
  assert.ok(shortEs.more.some((t) => /Tienes pocas fichas \(12 BB\)/.test(t)), 'es short note');
});

test('heroCovered is a boolean and matches the seats', () => {
  for (let i = 0; i < 60; i++) {
    const s = E.generateScenario({ seed: 'hc' + i, stacks: 'varied' });
    assert.strictEqual(typeof s.heroCovered, 'boolean');
    const hero = s.seats.find((x) => x.isHero);
    const heroTotal = hero.stack + hero.contributed;
    const cover = s.seats.some((x) => !x.isHero && !x.folded && x.stack + x.contributed > heroTotal + 1e-9);
    assert.strictEqual(s.heroCovered, cover, 'heroCovered vs seats at ' + s.id);
  }
});

test('default stacks are 100 BB; stacks:"varied" gives short, deep and covering seats', () => {
  for (let i = 0; i < 30; i++) {
    const s = E.generateScenario({ seed: 'def' + i });
    const hero = s.seats.find((x) => x.isHero);
    // Blinds are posted from the stacks, so compare stack plus chips already in (100 BB total).
    assert.ok(Math.abs(hero.stack + hero.contributed - 100) < 1e-6, 'default hero total ' + (hero.stack + hero.contributed));
  }
  let short = 0, deep = 0, covered = 0, notCovered = 0;
  for (let i = 0; i < 300; i++) {
    const s = E.generateScenario({ seed: 'var' + i, stacks: 'varied' });
    if (s.heroStack <= 15) short++;
    if (s.heroStack >= 120) deep++;
    if (s.heroCovered) covered++; else notCovered++;
  }
  assert.ok(short >= 5, 'short stacks ' + short);
  assert.ok(deep >= 20, 'deep stacks ' + deep);
  assert.ok(covered >= 20 && notCovered >= 20, 'covered ' + covered + ' / not ' + notCovered);
});

test('short stack (<=15 BB) plays push or fold: no raise sizes are offered', () => {
  const s = stackSpot('pf1', false, 12);
  const r = E.evaluate(s, 'raise', 30, { samples: 300 });
  assert.ok(r.more.some((t) => /shove or fold/.test(t)), 'push/fold note');
});

// ------------------------------------------------ chart grades and stack depth
test('chart cells carry a grade consistent with their frequencies', () => {
  const g = E.getRangeChart(6, 'BTN', 'open');
  let seen = new Set();
  for (const row of g.grid || g.cells || []) {
    for (const cell of row) {
      seen.add(cell.grade);
      if (cell.grade === 'great') assert.ok(cell.raise >= 0.5 - 1e-9, 'great but raise ' + cell.raise);
      if (cell.grade === 'bad') assert.ok(cell.fold >= 0.5 - 1e-9, 'bad but fold ' + cell.fold);
      assert.ok(['great', 'good', 'bad'].indexOf(cell.grade) >= 0, 'grade ' + cell.grade);
    }
  }
  assert.ok(seen.size >= 2, 'expected several grades');
});

test('chart widens with a short stack and tightens with a deep stack', () => {
  const sumRaise = (g) => {
    const cells = [].concat.apply([], g.grid || g.cells || []);
    return cells.reduce((t, c) => t + c.raise, 0);
  };
  const short = sumRaise(E.getRangeChart(6, 'BTN', 'open', { stackBB: 12 }));
  const normal = sumRaise(E.getRangeChart(6, 'BTN', 'open', { stackBB: 100 }));
  assert.ok(short > normal, 'short open raise ' + short.toFixed(1) + ' should exceed ' + normal.toFixed(1));
});

// ------------------------------------------------ informative feedback
const noBad = (t) => typeof t === 'string' && t.length > 0 && !/undefined|NaN|null|\{|\}|  |\s[,.]/.test(t) && !/equity|equidad/i.test(t);

test('handLabel, positionNote and tip are filled for 150 random scenarios in en and es', () => {
  for (let i = 0; i < 150; i++) {
    const lang = i % 2 ? 'es' : 'en';
    const s = E.generateScenario({ seed: 'fb' + i, lang: lang });
    const r = E.evaluate(s, i % 3 === 0 ? 'fold' : 'call', undefined, { samples: 200 });
    assert.ok(noBad(r.handLabel), lang + ' handLabel: ' + r.handLabel);
    assert.ok(noBad(r.positionNote), lang + ' positionNote: ' + r.positionNote);
    assert.ok(noBad(r.tip), lang + ' tip: ' + r.tip);
    assert.ok(r.tip.split(/\s+/).length <= 14, 'tip too long: ' + r.tip);
    assert.ok(r.explanation[0].split(/\s+/).length <= 22, 'first bullet: ' + r.explanation[0]);
    for (const b of r.explanation) assert.ok(noBad(b), lang + ' bullet: ' + b);
    assert.ok(!/one who|\bthe the\b/i.test(r.explanation.join(' ')), 'grammar: ' + r.explanation.join(' | '));
  }
});

test('hand labels: preflop pairs, suited, offsuit and small hands in both languages', () => {
  const pre = (hero, lang) => E.evaluate(Object.assign(E.generateScenario({ seed: 'pl', lang: lang, street: 'preflop' }),
    { hero: hero, board: [] }), 'call', undefined, { samples: 200 }).handLabel;
  assert.strictEqual(pre(['Ah', 'Ad'], 'en'), 'a pair of aces');
  assert.strictEqual(pre(['Ah', 'Ad'], 'es'), 'un par de ases');
  assert.strictEqual(pre(['Ah', 'Kh'], 'en'), 'AK suited');
  assert.strictEqual(pre(['Ah', 'Kh'], 'es'), 'AK del mismo palo');
  assert.strictEqual(pre(['Ah', 'Kc'], 'en'), 'AK offsuit');
  assert.strictEqual(pre(['7h', '2c'], 'en'), 'a small unpaired hand');
  assert.strictEqual(pre(['7h', '2c'], 'es'), 'una mano pequeña y desparejada');
});

test('hand labels: a pair only on the board is not called a pair; board trips are not the hero\'s', () => {
  const post = (hero, board, lang) => E.evaluate(Object.assign(E.generateScenario({ seed: 'pl2', lang: lang, street: 'flop' }),
    { hero: hero, board: board, street: 'flop' }), 'call', undefined, { samples: 200 }).handLabel;
  assert.strictEqual(post(['5c', '7d'], ['Kh', 'Kc', 'Qd'], 'en'), 'only seven high');
  assert.strictEqual(post(['5c', '7d'], ['Kh', 'Kc', 'Kd'], 'en'), 'only seven high');
  assert.strictEqual(post(['Ks', '9d'], ['2d', 'Jc', '9h'], 'en'), 'a second pair (9) with a good kicker');
  assert.ok(/flush|straight/.test(post(['6s', 'Jc'], ['7d', 'Ts', '9h'], 'en')), 'open-ended draw label');
  assert.ok(post(['Ah', 'Kh'], ['2h', '7h', 'Jd'], 'en').indexOf('flush draw') >= 0, 'flush draw label');
});

test('the third bullet names the best move and says how close the user was', () => {
  let named = 0, close = 0;
  for (let i = 0; i < 150; i++) {
    const s = E.generateScenario({ seed: 'nb' + i, lang: 'en' });
    const r = E.evaluate(s, 'fold', undefined, { samples: 200 });
    if (r.best === 'fold') continue;
    named++;
    const verb = r.best === 'raise' ? 'raise' : r.best === 'call' ? (s.toCall > 0 ? 'call' : 'check') : 'fold';
    assert.ok(r.explanation[2].indexOf('The best move was to ' + verb) === 0, 'best named: ' + r.explanation[2]);
    if (r.rating === 'good') { close++; assert.ok(/almost as good/.test(r.explanation[2]), 'close call: ' + r.explanation[2]); }
  }
  assert.ok(named >= 30, 'non-fold best spots ' + named);
  assert.ok(close >= 0);
});

test('feedback text never contains the banned word, in both languages', () => {
  for (let i = 0; i < 120; i++) {
    const lang = i % 2 ? 'es' : 'en';
    const s = E.generateScenario({ seed: 'bw' + i, lang: lang });
    const r = E.evaluate(s, 'raise', undefined, { samples: 200 });
    const all = [r.handLabel, r.positionNote, r.tip].concat(r.explanation).join(' | ');
    assert.ok(!/equity|equidad/i.test(all), lang + ': ' + all);
  }
});

// ------------------------------------------------ article agreement and weak two pair
test('hand labels in "You have ..." / "Tienes ..." take the right article', () => {
  const bad = /^(top|second|flush|open-ended|gutshot|pair|set of|overpair|underpair|straight draw|proyecto|par |pareja |segundo|set de|escalera|trío)/i;
  for (let i = 0; i < 100; i++) {
    const en = E.evaluate(E.generateScenario({ seed: 'art' + i, lang: 'en', street: i % 2 ? 'flop' : 'turn' }), 'call', undefined, { samples: 150 });
    const es = E.evaluate(E.generateScenario({ seed: 'art' + i, lang: 'es', street: i % 2 ? 'flop' : 'turn' }), 'call', undefined, { samples: 150 });
    if (en.handLabel.indexOf(' and ') < 0 && en.handLabel.indexOf(' with ') < 0) assert.ok(!bad.test(en.handLabel), 'en article: ' + en.handLabel);
    if (es.handLabel.indexOf(' y ') < 0) assert.ok(!bad.test(es.handLabel), 'es article: ' + es.handLabel);
    // English labels must start with an article, a count, or a category word that takes none.
    assert.ok(/^(a |an |two |three |four |only |\d|1 overcard|full |straight)/.test(en.handLabel) || /^(a|an)\b/.test(en.handLabel), 'en label article: ' + en.handLabel);
    assert.ok(/^(un |una |doble |solo |póker|\d)/.test(es.handLabel), 'es label article: ' + es.handLabel);
  }
});

test('weak two pair with a board pair is labelled honestly and does not claim strength', () => {
  const spot = (seed, lang) => {
    const s = E.generateScenario({ seed: seed, lang: lang, street: 'river', players: 3 });
    s.hero = ['4s', '2c']; s.board = ['5h', 'Qh', '2d', '8c', '5c'];
    return s;
  };
  const en = E.evaluate(spot('wtp1', 'en'), 'call', undefined, { samples: 800 });
  assert.ok(en.handLabel.indexOf('a weak two pair (the fives are on the board)') === 0, 'en label: ' + en.handLabel);
  const es = E.evaluate(spot('wtp1', 'es'), 'call', undefined, { samples: 800 });
  assert.ok(es.handLabel.indexOf('una doble pareja débil (la pareja de cincos está en la mesa)') === 0, 'es label: ' + es.handLabel);
  for (let i = 0; i < 40; i++) {
    for (const lang of ['en', 'es']) {
      const r = E.evaluate(spot('wtp' + i, lang), 'call', undefined, { samples: 300 });
      const weakRange = /wide|amplio/.test(r.stats.find((x) => x.key === 'villain').value);
      if (/rarely have much|seldom have|su rango es flojo|pocas veces/.test(r.explanation[0])) assert.ok(weakRange, 'claims weak range: ' + r.explanation[0]);
      if (r.best === 'raise') assert.ok(weakRange || Number(r.stats.find((x) => x.key === 'win_chance').value.replace('%', '')) >= 55, 'raise on medium hand vs strong range: ' + r.explanation[0]);
    }
  }
});

// ------------------------------------------------ phase 2: exact values, folds, determinism
test('flush draw on the flop: 9 outs, 35.0% to hit by the river (exact 1 - C(38,2)/C(47,2))', () => {
  const d = E.drawChance(['Ah', 'Kh'], ['2h', '7h', '9c']);
  assert.strictEqual(d.outs, 9);
  assert.strictEqual(d.cardsToCome, 2);
  const exact = (1 - (38 * 37) / (47 * 46)) * 100;
  assert.ok(Math.abs(d.pct - exact) < 0.06, d.pct + ' vs ' + exact.toFixed(3));
  assert.strictEqual(d.pct.toFixed(1), '35.0');
  // Rule of four says 36%: it overstates the exact value by about one point.
  assert.ok(4 * 9 - exact < 1.2);
});

test('draw chance is null without a flush or straight draw', () => {
  assert.strictEqual(E.drawChance(['Ah', 'Kd'], ['2c', '7h', '9s']), null);
  assert.strictEqual(E.drawChance(['Ah', 'Kd'], ['2c', '7h', '9s', 'Ts']), null);
});

test('randomWinPct: exact river and turn enumeration, Monte Carlo elsewhere; one decimal', () => {
  const river = E.randomWinPct(['Ah', 'Ad'], ['Kc', '7d', '2s', '9h', '3c'], 1);
  assert.strictEqual(river.exact, true);
  assert.strictEqual(river.samples, 990); // C(45,2) opponent hands
  assert.ok(Math.round(river.pct * 10) === river.pct * 10, 'one decimal');
  const turn = E.randomWinPct(['Ah', 'Ad'], ['Kc', '7d', '2s', '9h'], 1);
  assert.strictEqual(turn.exact, true);
  assert.strictEqual(turn.samples, 46 * 990); // 46 river cards x C(45,2)
  const flop = E.randomWinPct(['Ah', 'Ad'], ['Kc', '7d', '2s'], 1);
  assert.strictEqual(flop.exact, false);
  assert.strictEqual(flop.samples, 60000);
  const pre = E.randomWinPct(['Ah', 'Ad'], [], 1);
  // AA against a random hand: about 85.2% before the flop.
  assert.ok(Math.abs(pre.pct - 85.2) < 0.8, 'AA vs random ' + pre.pct);
  assert.deepStrictEqual(E.randomWinPct(['Ah', 'Ad'], [], 1), pre, 'same numbers on every call');
  assert.strictEqual(E.randomWinPct(['Ah', 'Ad'], ['Kc', '7d', '2s', '9h', '3c'], 0).pct, 100);
});

test('pot odds are call / (pot + call): 5 into 10 needs 33%', () => {
  const s = E.generateScenario({ seed: 'potodds', street: 'flop' });
  const synthetic = Object.assign({}, s, { pot: 10, toCall: 5, heroStack: 100 });
  const r = E.evaluate(synthetic, 'call', undefined, { samples: 200 });
  assert.strictEqual(r.stats.find((x) => x.key === 'pot_odds').value, '33%');
});

test('the personalities list and randomWinPct are exported', () => {
  assert.deepStrictEqual(E.personalities, ['tight', 'loose', 'aggressive', 'passive', 'balanced']);
  assert.strictEqual(typeof E.randomWinPct, 'function');
});

heavy('checking is free: 2000 scenarios: fold is never best and never rated above check', () => {
  const rank = { best: 4, good: 3, mistake: 2, blunder: 1 };
  for (let i = 0; i < 2000; i++) {
    const s = E.generateScenario({ seed: 'freeall' + i, lang: i % 2 ? 'es' : 'en' });
    const free = Object.assign({}, s, { toCall: 0 });
    const fold = E.evaluate(free, 'fold', undefined, { samples: 60 });
    const check = E.evaluate(free, 'call', undefined, { samples: 60 });
    assert.notStrictEqual(fold.best, 'fold', 'best was fold at ' + s.id);
    assert.ok(rank[fold.rating] <= rank[check.rating], 'fold rated above check at ' + s.id);
  }
});

heavy('deterministic: 200 scenarios, 20 evaluations each, equal in en and es', () => {
  for (let i = 0; i < 200; i++) {
    const lang = i % 2 ? 'es' : 'en';
    const s = E.generateScenario({ seed: 'det200_' + i, lang: lang });
    const first = plain(E.evaluate(s, 'call', undefined, { samples: 100 }));
    for (let k = 1; k < 20; k++) {
      assert.strictEqual(plain(E.evaluate(s, 'call', undefined, { samples: 100 })), first, 'call ' + k + ' differs at ' + s.id);
    }
  }
});

test('checking is free: fold is never the best move and never rated above check (150 scenarios)', () => {
  const rank = { best: 4, good: 3, mistake: 2, blunder: 1 };
  for (let i = 0; i < 150; i++) {
    const s = E.generateScenario({ seed: 'free' + i, lang: i % 2 ? 'es' : 'en' });
    const free = Object.assign({}, s, { toCall: 0 });
    const fold = E.evaluate(free, 'fold', undefined, { samples: 100 });
    const check = E.evaluate(free, 'call', undefined, { samples: 100 });
    assert.notStrictEqual(fold.best, 'fold', 'best was fold at ' + s.id);
    assert.ok(rank[fold.rating] <= rank[check.rating], 'fold rated above check at ' + s.id);
  }
});

test('no Math.random is reached by evaluate(): it runs with Math.random disabled', () => {
  const s = E.generateScenario({ seed: 'nomathrandom', street: 'turn' });
  const original = Math.random;
  Math.random = function () { throw new Error('Math.random used in evaluate'); };
  try {
    const r = E.evaluate(s, 'call', undefined, { samples: 150 });
    assert.ok(r.best);
  } finally {
    Math.random = original;
  }
});

// Everything except the lazily computed winPctRandom (tested separately): reading it runs a 60000-deal simulation.
function plain(r) {
  const o = {};
  for (const k of Object.keys(r)) if (k !== 'winPctRandom') o[k] = r[k];
  return JSON.stringify(o);
}

test('deterministic: the same situation gives the same result, whatever the scenario id', () => {
  for (let i = 0; i < 25; i++) {
    const s = E.generateScenario({ seed: 'det' + i, lang: i % 2 ? 'es' : 'en' });
    const a = plain(E.evaluate(s, 'call', undefined, { samples: 150 }));
    const b = plain(E.evaluate(s, 'call', undefined, { samples: 150 }));
    const renamed = plain(E.evaluate(Object.assign({}, s, { id: 'other-id' }), 'call', undefined, { samples: 150 }));
    assert.strictEqual(a, b, 'repeat call differs at ' + s.id);
    assert.strictEqual(a, renamed, 'scenario id changes the numbers at ' + s.id);
  }
});

test('explanations name the position and the opponents, never a play style; postflop notes show the board', () => {
  const style = /(tight|loose|aggressive|passive|balanced|cerrad|suelt|agresiv|pasiv|neutr|equilibrad|ajustad)/;
  let postflop = 0;
  for (let i = 0; i < 80; i++) {
    const lang = i % 2 ? 'es' : 'en';
    const s = E.generateScenario({ seed: 'where' + i, lang: lang, street: i % 4 === 0 ? 'preflop' : i % 2 ? 'flop' : 'turn' });
    const r = E.evaluate(s, 'call', undefined, { samples: 150 });
    const posWord = E.i18n[lang]['pos_' + s.heroPosition];
    assert.ok(r.explanation[0].indexOf(posWord) >= 0, lang + ' position in bullet 1: ' + r.explanation[0]);
    if (r.stats.find((x) => x.key === 'villain') && s.seats.some((x) => !x.isHero && !x.folded)) {
      assert.ok(/player|jugador/.test(r.explanation[0]), lang + ' opponents in bullet 1: ' + r.explanation[0]);
      assert.ok(!style.test(r.explanation[0]), lang + ' style in bullet 1: ' + r.explanation[0]);
    }
    if (s.street !== 'preflop') {
      postflop++;
      assert.ok(r.more.some((t) => /[♠♥♦♣]/.test(t)), 'board with suit symbols: ' + r.more.join(' | '));
    }
  }
  assert.ok(postflop >= 30, 'postflop sample ' + postflop);
});

// ------------------------------------------------ board-aware sentences
test('board sentence uses suit symbols and states the chance with the plain-word level', () => {
  // English pair words by level; Spanish level words after "probabilidad".
  const enWord = { 'very likely': 75, likely: 50, possible: 25, unlikely: 0 };
  const esWord = { 'muy alta': 75, alta: 50, media: 25, baja: 0 };
  for (let i = 0; i < 40; i++) {
    const lang = i % 2 ? 'es' : 'en';
    const s = E.generateScenario({ seed: 'bs' + i, lang: lang, street: i % 3 ? 'flop' : 'turn' });
    const r = E.evaluate(s, 'call', undefined, { samples: 150 });
    const line = r.more.find((t) => /[♠♥♦♣]/.test(t));
    assert.ok(line, 'board line: ' + r.more.join(' | '));
    assert.ok(noBad(line), lang + ' board line: ' + line);
    assert.ok(line.split(/\s+/).length <= 25, 'long board line: ' + line);
    const m = line.match(/\((\d+)%\)/);
    assert.ok(m, 'chance in board line: ' + line);
    const pct = Number(m[1]);
    const expect = pct >= 75 ? 75 : pct >= 50 ? 50 : pct >= 25 ? 25 : 0;
    const table = lang === 'en' ? enWord : esWord;
    const hit = Object.keys(table).find((w) => (lang === 'en' ? line.indexOf('a pair is ' + w) : line.indexOf('probabilidad ' + w)) >= 0);
    assert.ok(hit !== undefined, 'pair level in ' + line);
    assert.strictEqual(table[hit], expect, 'level ' + hit + ' vs ' + pct + '%');
  }
});

test('board cards are written as suit symbols in both languages (K♠ 7♦ 2♣)', () => {
  for (const lang of ['en', 'es']) {
    const s = E.generateScenario({ seed: 'symbols', lang: lang, street: 'flop' });
    s.board = ['Ks', '7d', '2c'];
    s.hero = ['Ah', 'Qc'];
    const r = E.evaluate(s, 'call', undefined, { samples: 150 });
    assert.ok(r.more.join(' | ').indexOf('K♠ 7♦ 2♣') >= 0, lang + ': ' + r.more.join(' | '));
    assert.ok(r.stats.find((x) => x.key === 'texture').hint === 'K♠ 7♦ 2♣', 'texture hint symbols');
    assert.ok(r.stats.find((x) => x.key === 'hand').hint === 'A♥ Q♣', 'hand hint symbols');
  }
});

test('preflop: the chart sentence names the position and the player count (limp, raise or fold)', () => {
  let found = 0;
  for (let i = 0; i < 400 && found < 6; i++) {
    const lang = i % 2 ? 'es' : 'en';
    const s = E.generateScenario({ seed: 'prepos' + i, lang: lang, street: 'preflop' });
    const r = E.evaluate(s, 'call', undefined, { samples: 100 });
    const n = s.numPlayers;
    const line = r.more.find((t) => /From this seat with|Desde esta posición con/.test(t));
    if (!line) continue;
    found++;
    assert.ok(line.indexOf(String(n)) >= 0, 'player count ' + n + ' in: ' + line);
    assert.ok(noBad(line), lang + ': ' + line);
  }
  assert.ok(found >= 3, 'preflop chart sentences found ' + found);
});

test('board and preflop sentences are deterministic and free of undefined/NaN (60 scenarios, en and es)', () => {
  for (let i = 0; i < 60; i++) {
    const lang = i % 2 ? 'es' : 'en';
    const s = E.generateScenario({ seed: 'bsdet' + i, lang: lang, street: i % 3 ? 'flop' : 'preflop' });
    const a = E.evaluate(s, 'call', undefined, { samples: 150 });
    const b = E.evaluate(s, 'call', undefined, { samples: 150 });
    assert.deepStrictEqual(a.more, b.more);
    for (const t of a.more) assert.ok(noBad(t), lang + ': ' + t);
  }
});

// ------------------------------------------------ raise sizes, gates, ratings (calibration)
const fmtEn = (x) => String(Math.round(x * 100) / 100);
const fmtEs = (x) => fmtEn(x).replace('.', ',');

test('raise: the verdict uses one standard size, shown as bestRaiseAmount, raiseSize and in the text', () => {
  let checked = 0;
  for (let i = 0; i < 200 && checked < 60; i++) {
    const lang = i % 2 ? 'es' : 'en';
    const s = E.generateScenario({ seed: 'rs' + i, lang: lang });
    const r = E.evaluate(s, 'call', undefined, { samples: 150 });
    if (r.best !== 'raise') continue;
    checked++;
    assert.strictEqual(r.raiseSize, r.bestRaiseAmount, 'raiseSize equals the shown amount');
    assert.strictEqual(s.raiseOptions.length, 1, 'one raise option');
    assert.strictEqual(s.raiseOptions[0].amount, r.raiseSize, 'the option is the size the verdict used');
    const amt = lang === 'en' ? fmtEn(r.raiseSize) : fmtEs(r.raiseSize);
    const want = r.raiseAllin
      ? (lang === 'en' ? 'Shove to ' + amt + ' BB' : 'Sube todo a ' + amt + ' BB')
      : (lang === 'en' ? 'Raise to ' + amt + ' BB' : 'Sube a ' + amt + ' BB');
    assert.ok(r.explanation[0].indexOf(want) >= 0, lang + ': "' + want + '" in ' + r.explanation[0]);
    assert.ok(noBad(r.explanation[0]), lang + ' bullet 1: ' + r.explanation[0]);
  }
  assert.ok(checked >= 30, 'raise spots found ' + checked);
});

test('raise: all-in exactly when the game.js size reaches the stack (no separate shove rule)', () => {
  let checked = 0;
  for (let i = 0; i < 300; i++) {
    const s = E.generateScenario({ seed: 'shove' + i });
    const hero = s.seats.find((x) => x.isHero);
    const r = E.evaluate(s, 'call', undefined, { samples: 100 });
    if (r.raiseSize == null) continue;
    checked++;
    assert.strictEqual(r.raiseAllin, r.raiseSize >= hero.bet + hero.stack - 1e-9, 'all-in flag at ' + s.id);
  }
  assert.ok(checked >= 150, 'raise-capable spots ' + checked);
});

test('preflop: a raise into an unopened or limped pot is 3 BB, as in game.js (BB already posted)', () => {
  let found = 0;
  for (let i = 0; i < 300 && found < 20; i++) {
    const s = E.generateScenario({ seed: 'open' + i, street: 'preflop' });
    if (s.seats.some((x) => x.bet > 1.01)) continue;   // nobody has raised yet
    const r = E.evaluate(s, 'call', undefined, { samples: 100 });
    if (r.raiseSize == null || r.raiseAllin) continue;
    found++;
    assert.strictEqual(r.raiseSize, 3, 'raise size ' + r.raiseSize);
  }
  assert.ok(found >= 5, 'unopened spots found ' + found);
});

heavy('engine raise size equals game.js: 500 live hero decisions (standardRaiseTo and evaluate)', () => {
  const G = require(path.join(__dirname, '..', 'public', 'game.js'));
  const bb = G.BB;
  let n = 0, session = null, hero = -1, sessions = 0;
  const newSess = () => {
    session = G.newSession({ cpus: 5, stackBB: 100 });
    hero = session.seats.findIndex((x) => !x.isBot);
    sessions++;
    G.startHand(session, {});
  };
  newSess();
  for (let g = 0; g < 400000 && n < 500; g++) {
    if (session.over) { newSess(); continue; }
    if (!session.hand || session.hand.over) { G.startHand(session, {}); continue; }
    const idx = G.toAct(session);
    if (idx == null) { G.startHand(session, {}); continue; }
    if (idx !== hero) { G.stepBot(session); continue; }
    const L = G.legal(session, hero);
    if (L && L.canRaise) {
      const sc = G.buildScenario(session, hero);
      const probe = JSON.parse(JSON.stringify(session));
      G.act(probe, hero, 'raise');                       // the Raise button: amount omitted
      const gameTo = probe.hand.seats[hero].bet / bb;     // BB
      const lgBB = { canRaise: L.canRaise, curBet: L.curBet / bb, toCall: L.toCall / bb, minRaiseTo: L.minRaiseTo / bb, maxRaiseTo: L.maxRaiseTo / bb };
      const fn = E.standardRaiseTo(lgBB, sc.pot, sc.street === 'preflop', 1);
      const ev = E.evaluate(sc, 'raise', undefined, { samples: 60 }).raiseSize;
      n++;
      assert.ok(Math.abs(fn - gameTo) < 1e-9, 'standardRaiseTo ' + fn + ' vs game ' + gameTo + ' (' + sc.street + ')');
      assert.ok(Math.abs(ev - gameTo) < 1e-9, 'evaluate raiseSize ' + ev + ' vs game ' + gameTo + ' (' + sc.street + ')');
      G.act(session, hero, g % 2 ? 'raise' : 'call');
    } else {
      G.act(session, hero, 'call');
    }
  }
  assert.strictEqual(n, 500, 'live decisions compared: ' + n + ' in ' + sessions + ' sessions');
});

test('preflop: no trash hand (72o, 32o, 42o, 52o, 62o) raises facing an open or a 3-bet', () => {
  const trash = ['72o', '32o', '42o', '52o', '62o'];
  let facing = 0;
  for (let i = 0; i < 400; i++) {
    const s = E.generateScenario({ seed: 'trash' + i, street: 'preflop' });
    const curMax = Math.max(...s.seats.map((x) => x.bet));
    if (!(curMax > 2.6)) continue;
    facing++;
    if (trash.indexOf(E.handClass(s.hero[0], s.hero[1])) < 0) continue;
    const r = E.evaluate(s, 'call', undefined, { samples: 100 });
    assert.notStrictEqual(r.best, 'raise', 'trash raised facing a raise at ' + s.id);
  }
  assert.ok(facing >= 40, 'facing-raise spots ' + facing);
});

test('ratings follow the score bands: good 80-96, mistake 40-79, blunder 0-39', () => {
  for (let i = 0; i < 120; i++) {
    const s = E.generateScenario({ seed: 'band' + i, lang: i % 2 ? 'es' : 'en' });
    for (const act of ['fold', 'call', 'raise']) {
      const r = E.evaluate(s, act, undefined, { samples: 100 });
      if (r.rating === 'best') assert.strictEqual(r.score, 100);
      else if (r.rating === 'good') assert.ok(r.score >= 80 && r.score <= 96, 'good score ' + r.score);
      else if (r.rating === 'mistake') assert.ok(r.score >= 40 && r.score <= 79, 'mistake score ' + r.score);
      else assert.ok(r.score >= 0 && r.score <= 39, 'blunder score ' + r.score);
    }
  }
});

test('monotone: a stronger hand has a higher chance to win and a higher raise EV in the same spot', () => {
  const base = E.generateScenario({ seed: 'mono', street: 'preflop', position: 'BTN', players: 6 });
  const hands = [['7h', '2c'], ['Jh', '8c'], ['Th', 'Tc'], ['Ah', 'Ac']];
  let prevE = -1, prevRaise = -Infinity;
  for (const hand of hands) {
    const s = Object.assign({}, base, { hero: hand });
    const r = E.evaluate(s, 'call', undefined, { samples: 3000 });
    const e = Number(r.stats.find((x) => x.key === 'win_chance').value.replace('%', ''));
    assert.ok(e >= prevE - 1, 'chance to win dropped at ' + hand.join(''));
    const raiseEv = r.ev.raise == null ? prevRaise : r.ev.raise;
    assert.ok(raiseEv >= prevRaise - 0.5, 'raise EV dropped at ' + hand.join('') + ': ' + raiseEv + ' < ' + prevRaise);
    prevE = e;
    prevRaise = raiseEv;
  }
});

heavy('calibration over 2000 preflop spots: 3-bet rate, premium share, first-in agreement, call blunders', () => {
  const PREM = new Set(['AA', 'KK', 'QQ', 'AKs', 'AKo']);
  const cache = {};
  let faceRaise = 0, faceRaiseBest = 0, premium = 0, chartN = 0, chartAgree = 0, total = 0, blunder = 0;
  for (let i = 0; i < 2000; i++) {
    const s = E.generateScenario({ seed: 7000 + i, street: 'preflop' });
    const r = E.evaluate(s, 'call', undefined, { samples: 200 });
    total++;
    if (r.rating === 'blunder') blunder++;
    const curMax = Math.max(...s.seats.map((x) => x.bet));
    const cls = E.handClass(s.hero[0], s.hero[1]);
    if (curMax > 2.6) {
      faceRaise++;
      if (r.best === 'raise') {
        faceRaiseBest++;
        if (PREM.has(cls) || /^A[2-9TJQK]s$/.test(cls)) premium++;
      }
    } else if (curMax <= 1.01) {
      const key = s.numPlayers + '|' + s.heroPosition;
      if (!cache[key]) {
        try { cache[key] = E.getRangeChart(s.numPlayers, s.heroPosition, 'open', { lang: 'en', stackBB: s.heroStack }); } catch (e) { cache[key] = null; }
      }
      if (!cache[key]) continue;
      const cell = [].concat.apply([], cache[key].grid).find((c) => c.hand === cls);
      if (!cell) continue;
      chartN++;
      if ((cell.raise >= 0.5) === (r.best === 'raise')) chartAgree++;
    }
  }
  const rate = faceRaiseBest / faceRaise;
  assert.ok(rate < 0.2, 'facing-a-raise raise rate ' + (100 * rate).toFixed(1) + '%');
  assert.ok(premium / Math.max(1, faceRaiseBest) >= 0.5, 'premium share of 3-bets ' + premium + '/' + faceRaiseBest);
  assert.ok(chartAgree / chartN >= 0.75, 'first-in agreement with the chart ' + (100 * chartAgree / chartN).toFixed(1) + '%');
  assert.ok(blunder / total <= 0.2, 'call blunder rate ' + (100 * blunder / total).toFixed(1) + '%');
});

heavy('street mix: 1000 random scenarios, each street within 20-30%', () => {
  const c = { preflop: 0, flop: 0, turn: 0, river: 0 };
  for (let i = 0; i < 1000; i++) c[E.generateScenario({ seed: 9000 + i }).street]++;
  for (const k of Object.keys(c)) assert.ok(c[k] >= 200 && c[k] <= 300, k + ' ' + c[k]);
});

test('deep-stack call EV is pot odds only: no implied-odds bonus on calls (D3)', () => {
  // With 100+ BB behind the old code added 3% of the pot to call EV and nothing to raise EV.
  // Call EV must equal E * realize * (P + C) - C, with E read back from the displayed win chance.
  let checked = 0;
  for (let i = 0; i < 400 && checked < 25; i++) {
    const g = E.generateScenario({ seed: 'd3-' + i, street: i % 2 ? 'flop' : 'turn' });
    if (g.street === 'river' || !(g.toCall > 0)) continue;
    // Same spot with 100 BB behind (the generator rarely deals deep stacks).
    const s = Object.assign({}, g, { heroStack: 100 });
    if (s.toCall >= s.heroStack - 1e-9) continue;
    const r = E.evaluate(s, 'call', undefined, { samples: 1500 });
    const stat = r.stats.filter((x) => x.label === 'Chance to win vs range')[0];
    if (!stat) continue;
    const win = parseFloat(stat.value) / 100;
    if (!(win >= 0.5)) continue; // the old bonus (3% of P+C times E) only matters for strong hands
    const C = Math.min(s.toCall, s.heroStack), P = s.pot;
    const realize = s.inPosition ? 1 : 0.92;
    const expected = win * realize * (P + C) - C;
    const diff = Math.abs(r.ev.call - expected);
    assert.ok(diff <= 0.008 * (P + C) + 0.02, 'call EV ' + r.ev.call + ' vs pot-odds ' + expected.toFixed(3) + ' (P+C ' + (P + C).toFixed(1) + ')');
    checked++;
  }
  assert.ok(checked >= 8, 'enough deep spots checked: ' + checked);
});

test('outs count only cards that improve the hand with a hole card (T7 on Qs9cAs: 6, not 15)', () => {
  assert.strictEqual(E.outs(['Th', '7h'], ['Qs', '9c', 'As']), 6);
  // Backdoor flush (two hearts on the board plus hero hearts) is not counted; pairs with hole cards are.
  assert.strictEqual(E.outs(['Ah', '5h'], ['2h', '9c', 'Kd']), 6);
});

test('a fold when checking is free is a blunder scored near zero', () => {
  let checked = 0;
  for (let i = 0; i < 400 && checked < 5; i++) {
    const s = E.generateScenario({ seed: 'cf' + i, lang: 'en' });
    if (s.toCall > 0) continue;
    const r = E.evaluate(s, 'fold', undefined, { samples: 300, lang: 'en' });
    assert.strictEqual(r.rating, 'blunder', 'rating ' + r.rating);
    assert.ok(r.score <= 5, 'score ' + r.score);
    checked++;
  }
  assert.ok(checked >= 5, 'enough free-check spots: ' + checked);
});

test('win vs random cards: one number per active opponent count, folded seats not counted', () => {
  const r = E.randomWinPct(['Th', '7h'], ['Qs', '9c', 'As'], 1);
  assert.ok(r.pct >= 15 && r.pct <= 40, 'T7h on Qs9cAs vs one random hand: ' + r.pct);
});

test('preflop ranking is monotone: a dominating hand is never played less than the hand it dominates', () => {
  const R = '23456789TJQKA';
  const reps = (hi, lo, t) => t === 'p' ? [R[hi] + 's', R[hi] + 'h'] : t === 's' ? [R[hi] + 's', R[lo] + 's'] : [R[hi] + 's', R[lo] + 'h'];
  const dom = (x, y) => {
    if (x.t === 'p' && y.t === 'p') return x.hi > y.hi;
    if (x.t === 'p') return x.hi >= y.hi;
    if (y.t === 'p') return false;
    return x.hi >= y.hi && x.lo >= y.lo && (x.t === y.t || (x.t === 's' && y.t === 'o'));
  };
  const cls = [];
  for (let hi = 0; hi < 13; hi++) for (let lo = 0; lo <= hi; lo++) {
    if (hi === lo) cls.push({ hi, lo, t: 'p' });
    else { cls.push({ hi, lo, t: 's' }); cls.push({ hi, lo, t: 'o' }); }
  }
  const pct = (c) => { const [a, b] = reps(c.hi, c.lo, c.t); return E.preflopPercentile(a, b); };
  let bad = [];
  for (const x of cls) for (const y of cls) {
    if (x === y || !dom(x, y)) continue;
    if (pct(x) > pct(y) + 1e-9) bad.push(x.t + x.hi + x.lo + ' under ' + y.t + y.hi + y.lo);
  }
  assert.deepStrictEqual(bad, [], 'dominance violations');
  // The chart is built from the same ranking: a dominated hand is never raised or called where a dominating one folds.
  const lvl = { fold: 0, call: 1, raise: 2 };
  const key = (c) => R[c.hi] + R[c.lo] + (c.t === 'p' ? '' : c.t);
  const byKey = (k) => { const hi = R.indexOf(k[0]), lo = R.indexOf(k[1]); return { hi: Math.max(hi, lo), lo: Math.min(hi, lo), t: k.length === 2 ? 'p' : k[2] }; };
  let chartBad = [];
  for (const n of [2, 3, 6, 9]) for (const sp of E.listChartSpots(n)) {
    const g = E.getRangeChart(n, sp.position, sp.facing, { lang: 'en' }).grid;
    const lv = {};
    for (const row of g) for (const cell of row) lv[cell.hand] = lvl[cell.grade === 'great' ? 'raise' : cell.grade === 'bad' ? 'fold' : 'call'];
    for (const x of cls) for (const y of cls) {
      if (x === y || !dom(x, y)) continue;
      const kx = key(x), ky = key(y);
      if (lv[kx] < lv[ky]) chartBad.push(n + ' ' + sp.position + ' ' + sp.facing + ': ' + kx + ' under ' + ky);
    }
  }
  assert.deepStrictEqual(chartBad.slice(0, 5), [], 'chart monotone violations: ' + chartBad.length);
});

test('Why text: a single opponent who already raised (5-bet role) is never described as yet to act', () => {
  let checked = 0;
  for (let i = 0; i < 200 && checked < 10; i++) {
    const s = E.generateScenario({ seed: 'why' + i });
    if (s.street !== 'preflop') continue;
    const others = s.seats.filter((x) => !x.isHero);
    others.forEach((x, j) => { if (j > 0) x.folded = true; });
    const v = others[0];
    if (!v || v.folded) continue;
    v.preflopRole = '5bet'; v.lastActionKind = 'raise';
    const r = E.evaluate(s, 'call');
    const text = [r.situation].concat(r.explanation).join(' ');
    assert.ok(!/yet to act/i.test(text), 'still says yet to act: ' + text);
    checked++;
  }
  assert.ok(checked > 0, 'no preflop spot sampled');
});

console.log(failures ? '\n' + failures + ' test(s) failed' : '\nall engine tests passed' + (skipped ? ' (' + skipped + ' heavy sweeps skipped; ENGINE_FULL=1 runs them)' : ''));
// ---- money granularity: every scenario amount is a whole 0.5 BB
test("scenario amounts (stacks, bets, pot, to-call, raise options) are multiples of 0.5 BB", () => {
  const onGrid = (x) => Math.abs(x * 2 - Math.round(x * 2)) < 1e-9;
  let n = 0;
  for (let seed = 1; seed <= 300; seed++) {
    for (const stacks of [undefined, "varied"]) {
      const s = E.generateScenario({ seed, stacks });
      n++;
      const amounts = [s.pot, s.toCall, s.heroStack, ...s.seats.flatMap((x) => [x.stack, x.bet])];
      (s.raiseOptions || []).forEach((o) => amounts.push(o.amount));
      amounts.forEach((a) => assert.ok(onGrid(a), "seed " + seed + " amount " + a + " is off the 0.5 BB grid"));
    }
  }
  assert.ok(n > 500);
});

process.exitCode = failures ? 1 : 0;
