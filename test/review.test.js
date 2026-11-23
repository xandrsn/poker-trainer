'use strict';
const assert = require('assert');
const path = require('path');
const R = require(path.join(__dirname, '..', 'public', 'review.js'));
const E = require(path.join(__dirname, '..', 'public', 'engine.js'));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.error('FAIL ' + name + '\n  ' + e.message); process.exitCode = 1; }
}

// Scenario in the engine/app format (BB units). Only fields the review reads are set.
function seat(i, over) {
  return Object.assign({
    seat: i, position: 'BB', name: 'Seat ' + i, stack: 100, bet: 0, contributed: 0, folded: false,
    isHero: false, style: 'balanced', lastAction: '', lastActionKind: 'check', preflopRole: null,
  }, over || {});
}
function scenario(over) {
  const hero = seat(0, { isHero: true, position: 'BTN', stack: over.heroStack == null ? 100 : over.heroStack });
  const villain = seat(1, { position: 'BB', stack: 100, lastActionKind: over.villainAction || 'check', preflopRole: over.villainRole || null });
  return Object.assign({
    id: 'test', lang: 'en', numPlayers: 2, street: 'river', hero: ['As', 'Ks'], board: ['Qs', 'Js', 'Ts', '2d', '3c'],
    blinds: { sb: 0.5, bb: 1 }, pot: 10, toCall: 0, heroStack: 100, heroPosition: 'BTN', heroSeat: 0, buttonSeat: 0,
    inPosition: true, seats: [hero, villain], actionLog: [], heroCovered: false, history: [], lastRaise: undefined,
    raiseOptions: [], situation: '',
  }, over);
}

const NUM = /\d+(?:[.,]\d+)?/g;
const nums = (s) => (s.match(NUM) || []).map((x) => x.replace(',', '.'));

test('fold the nuts facing a bet is a blunder', () => {
  // Royal flush on the board: hero holds the A-K of spades, villain bets 5 BB into 10 BB.
  const sc = scenario({ hero: ['As', 'Ks'], board: ['Qs', 'Js', 'Ts', '2d', '3c'], pot: 10, toCall: 5, heroStack: 95 });
  const r = R.rateDecision(sc, 'fold');
  assert.ok(r.evLossBB > 3, 'fold should cost real EV, got ' + r.evLossBB);
  assert.ok(['blunder', 'mistake'].includes(r.rating), 'rating ' + r.rating);
  assert.strictEqual(r.best.action, 'raise');
});

test('call an all-in with air is a blunder or mistake', () => {
  // 7-2 offsuit on an A-K-9-5-4 river, facing an all-in for the whole stack.
  const sc = scenario({ hero: ['7d', '2c'], board: ['Ah', 'Kd', '9s', '5c', '4h'], pot: 40, toCall: 20, heroStack: 20 });
  const r = R.rateDecision(sc, 'call');
  assert.ok(r.evLossBB > 0.5, 'expected EV loss, got ' + r.evLossBB);
  assert.ok(['mistake', 'blunder', 'inaccuracy'].includes(r.rating), 'rating ' + r.rating);
  assert.ok(r.tags.indexOf('all_in') >= 0);
});

// Preflop spot: SB with JcTs, two limpers (chart says raise here; the best size is 3 BB, EV loss 0).
function limpSpot(hero, pos) {
  const sc = scenario({ street: 'preflop', hero, board: [], pot: 2.5, toCall: 1, heroStack: 100, numPlayers: 3, heroPosition: pos, inPosition: pos !== 'SB' });
  sc.seats = [
    seat(0, { isHero: true, position: pos, stack: 100, bet: pos === 'BB' ? 1 : 0, contributed: pos === 'BB' ? 1 : 0 }),
    seat(1, { position: 'SB', stack: 99.5, bet: 0.5, contributed: 0.5, preflopRole: 'limp' }),
    seat(2, { position: 'BTN', stack: 99, bet: 1, contributed: 1, preflopRole: 'limp' }),
  ];
  return sc;
}

test('book: the chart primary AND the best move (within tolerance) is Book', () => {
  const r = R.rateDecision(limpSpot(['Jc', 'Ts'], 'SB'), { action: 'raise', amountBB: 3 });
  assert.strictEqual(r.bookAction, 'raise', 'chart primary is raise');
  assert.strictEqual(r.rating, 'book', 'rating ' + r.rating);
  assert.ok(r.book);
  assert.ok(r.tags.indexOf('book_move') >= 0);
  assert.ok(r.why.some((w) => w.key === 'why.chart'));
});

test('book: a chart move that is not the best (wrong size, EV loss) is not Book', () => {
  // Chart says raise from the button with AKs; a 2.5 BB raise loses EV vs 3 BB, so it is Good, not Book.
  const sc = scenario({ street: 'preflop', hero: ['As', 'Ks'], board: [], pot: 1.5, toCall: 1, heroStack: 100, numPlayers: 6, heroPosition: 'BTN', inPosition: true });
  sc.seats = [seat(0, { isHero: true, position: 'BTN', stack: 100 }), seat(1, { position: 'SB', stack: 99.5, bet: 0.5, contributed: 0.5 }), seat(2, { position: 'BB', stack: 99, bet: 1, contributed: 1 })];
  const r = R.rateDecision(sc, { action: 'raise', amountBB: 2.5 });
  assert.strictEqual(r.bookAction, 'raise');
  assert.notStrictEqual(r.rating, 'book', 'rating ' + r.rating);
  assert.ok(r.evLossBB > 0);
});

test('book: never for a move that is not the chart primary, even within the good band', () => {
  const r = R.rateDecision(limpSpot(['Jc', 'Ts'], 'SB'), 'fold');
  assert.strictEqual(r.bookAction, 'raise');
  assert.notStrictEqual(r.rating, 'book', 'folding a chart raise is not book: ' + r.rating);
});

test('book: obvious folds are Best, not Book (72o UTG)', () => {
  const sc = scenario({ street: 'preflop', hero: ['7h', '2c'], board: [], pot: 1.5, toCall: 1, numPlayers: 6, heroPosition: 'UTG' });
  sc.seats = [seat(0, { isHero: true, position: 'UTG', stack: 100 }), seat(1, { position: 'BB', stack: 99, bet: 1, contributed: 1 })];
  const r = R.rateDecision(sc, 'fold');
  assert.strictEqual(r.bookAction, 'fold');
  assert.notStrictEqual(r.rating, 'book', 'trash fold must not be book: ' + r.rating);
  assert.strictEqual(r.rating, 'best');
});

test('forced: hero has no chips left', () => {
  const sc = scenario({ heroStack: 0, toCall: 0, pot: 20 });
  const r = R.rateDecision(sc, 'call');
  assert.strictEqual(r.rating, 'forced');
  assert.strictEqual(r.accuracy, 100);
});

test('luck: AA all-in against KK lost is bad luck', () => {
  const sc = scenario({ hero: ['Ah', 'Ad'], board: [], pot: 0, toCall: 0, heroStack: 0, street: 'preflop' });
  const hand = { decisions: [{ scenario: sc, action: 'call', winChance: 0.82 }], heroNetBB: -100, potBB: 200, heroInvestedBB: 100, showdown: true };
  const h = R.reviewHand(hand);
  assert.strictEqual(h.luck.label, 'bad_luck', JSON.stringify(h.luck));
  assert.strictEqual(h.luck.resultVsPlay, 'good_bad');
  assert.ok(h.luck.luckBB < -50);
});

test('luck: 72o all-in against AA that wins is lucky', () => {
  const sc = scenario({ hero: ['7h', '2d'], board: [], pot: 0, toCall: 0, heroStack: 0, street: 'preflop' });
  const hand = { decisions: [{ scenario: sc, action: 'call', winChance: 0.12 }], heroNetBB: 100, potBB: 200, heroInvestedBB: 100, showdown: true };
  const h = R.reviewHand(hand);
  assert.strictEqual(h.luck.label, 'lucky');
  assert.strictEqual(h.luck.resultVsPlay, 'good_good');
});

test('luck: no all-in and no showdown means no luck data', () => {
  const sc = scenario({});
  const h = R.reviewHand({ decisions: [{ scenario: sc, action: 'fold' }], heroNetBB: -1, potBB: 10, heroInvestedBB: 1, showdown: false });
  assert.strictEqual(h.luck.label, 'unknown');
});

test('reviewGame: counts, accuracy and summary shape', () => {
  const sc = scenario({ heroStack: 0 });
  const g = R.reviewGame([{ decisions: [{ scenario: sc, action: 'call' }], heroNetBB: 3, potBB: 6, heroInvestedBB: 3, showdown: true }]);
  assert.strictEqual(g.handCount, 1);
  assert.strictEqual(g.decisionCount, 1);
  assert.strictEqual(g.counts.forced, 1);
  assert.strictEqual(g.accuracy, null, 'forced-only game has no accuracy');
  assert.ok(Array.isArray(g.suggestions) && g.suggestions.length >= 1);
  assert.strictEqual(Object.keys(g.counts).length, R.RATINGS.length);
});

test('EN and ES carry the same numbers', () => {
  const sc = scenario({ hero: ['7d', '2c'], board: ['Ah', 'Kd', '9s', '5c', '4h'], pot: 40.5, toCall: 20, heroStack: 20 });
  const r = R.rateDecision(sc, 'call');
  assert.deepStrictEqual(nums(r.text.en), nums(r.text.es));
  assert.ok(r.text.en.length > 40 && r.text.es.length > 40);
});

test('no "equity" word in any user-visible output', () => {
  const sc = scenario({ hero: ['7d', '2c'], board: ['Ah', 'Kd', '9s', '5c', '4h'], pot: 40, toCall: 20, heroStack: 20 });
  const r = R.rateDecision(sc, 'call');
  const g = R.reviewGame([{ decisions: [{ scenario: sc, action: 'call' }], heroNetBB: -20, potBB: 40, heroInvestedBB: 20, showdown: true }]);
  const blob = JSON.stringify([r, g]);
  assert.ok(!/equity/i.test(blob), 'the word equity appears in output');
});

test('deterministic: same situation gives identical output', () => {
  const sc = scenario({ hero: ['Jd', 'Th'], board: ['9c', '8h', '2s'], street: 'flop', pot: 12, toCall: 6, heroStack: 80 });
  const a = JSON.stringify(R.rateDecision(sc, 'call'));
  const b = JSON.stringify(R.rateDecision(sc, 'call'));
  assert.strictEqual(a, b);
});

test('engine exposes the review fields', () => {
  const sc = scenario({ toCall: 5, pot: 10, heroStack: 95 });
  const o = E.evaluate(sc, 'fold', undefined, { lang: 'en', samples: 500 });
  assert.ok(typeof o.winChance === 'number' && o.winChance >= 0 && o.winChance <= 1);
  assert.strictEqual(o.userAction, 'fold');
  assert.strictEqual(typeof o.evBest, 'number');
});

// Reading level: short sentences, no jargon, at most 3 numbers in the short text, EN/ES parity.
const JARGON = /\b(equity|EV|GTO|range|blockers?|SPR|MDF|pot odds|equidad|rango|bloqueadores?)\b/;
const SITUATIONS = [
  () => scenario({ hero: ['As', 'Ks'], board: ['Qs', 'Js', 'Ts', '2d', '3c'], pot: 10, toCall: 5, heroStack: 95 }),
  () => scenario({ hero: ['7d', '2c'], board: ['Ah', 'Kd', '9s', '5c', '4h'], pot: 40, toCall: 20, heroStack: 20 }),
  () => scenario({ hero: ['7d', '2c'], board: ['Ah', 'Kd', '9s', '5c', '4h'], pot: 20, toCall: 0 }),
  () => scenario({ hero: ['7d', '2c'], board: ['Ah', 'Kd', '9s', '5c', '4h'], pot: 10, toCall: 5, heroStack: 95 }),
  () => scenario({ hero: ['Jd', 'Th'], board: ['9c', '8h', '2s'], street: 'flop', pot: 12, toCall: 6, heroStack: 80 }),
  () => scenario({ heroStack: 0, toCall: 0, pot: 20 }),
];
const ACTIONS = ['fold', 'call', { action: 'raise', amountBB: 3 }];

test('explanations: text.explain exists in EN and ES; text.full is deprecated (empty)', () => {
  SITUATIONS.forEach((mk) => {
    const r = R.rateDecision(mk(), 'call');
    ['headline', 'short'].forEach((k) => assert.ok(r.text[k].en && r.text[k].es, k));
    assert.ok(r.text.explain.en && r.text.explain.es, 'explain missing');
    assert.deepStrictEqual(r.text.full, []);
    assert.deepStrictEqual(r.headline, r.text.headline);
  });
});

test('explanations: no bullets or line lists; 1-2 paragraphs of 2-4 sentences; sentences <= 22 words; paragraph <= 70 words', () => {
  SITUATIONS.forEach((mk) => ACTIONS.forEach((a) => {
    const r = R.rateDecision(mk(), a);
    ['en', 'es'].forEach((L) => {
      const txt = r.text.explain[L];
      assert.ok(!/[•·▪◦•]|^\s*[-*]\s/m.test(txt), 'bullet char in ' + L + ': ' + txt);
      assert.ok(!/\n\s*\S+\s*\n/.test(txt) && !/\n\s*[\d-]+[.)]/.test(txt), 'list in ' + L);
      txt.split(/\n\n/).forEach((para) => {
        assert.ok(para.split(/(?<=[.!?])\s+/).length >= 2 && para.split(/(?<=[.!?])\s+/).length <= 4, 'sentence count: ' + para);
        assert.ok(para.split(/\s+/).length <= 70, 'paragraph words > 70: ' + para);
        para.split(/(?<=[.!?])\s+/).forEach((sen) => assert.ok(sen.split(/\s+/).length <= 22, 'long sentence (' + sen.split(/\s+/).length + '): ' + sen));
      });
      assert.ok(!JARGON.test(txt), 'jargon in ' + L + ': ' + txt);
      assert.ok(!/equity|equidad/i.test(txt), 'equity word in ' + L);
    });
  }));
});

test('explanations: headline <= 8 words, short is 1-2 sentences, no jargon', () => {
  SITUATIONS.forEach((mk) => ACTIONS.forEach((a) => {
    const r = R.rateDecision(mk(), a);
    ['en', 'es'].forEach((L) => {
      assert.ok(r.text.headline[L].split(/\s+/).length <= 8, 'headline: ' + r.text.headline[L]);
      assert.ok(r.text.short[L].split(/(?<=[.!?])\s+/).length <= 2, 'short too long: ' + r.text.short[L]);
      assert.ok(!JARGON.test(r.text.headline[L] + ' ' + r.text.short[L]), 'jargon in ' + L + ': ' + r.text.short[L]);
    });
  }));
});

test('explanations: facing a bet, the paragraph names a key number (win, needed or pot)', () => {
  SITUATIONS.forEach((mk) => ACTIONS.forEach((a) => {
    const sc = mk();
    if (!(sc.toCall > 0)) return;
    const r = R.rateDecision(sc, a);
    assert.ok(nums(r.text.explain.en).length >= 1, 'no numbers: ' + r.text.explain.en);
  }));
});

test('explanations: at most 3 numbers in the short text, same numbers in EN and ES', () => {
  SITUATIONS.forEach((mk) => ACTIONS.forEach((a) => {
    const r = R.rateDecision(mk(), a);
    assert.ok(nums(r.text.short.en).length <= 3, 'numbers in short: ' + r.text.short.en);
    assert.deepStrictEqual(nums(r.text.short.en), nums(r.text.short.es));
    assert.deepStrictEqual(nums(r.text.explain.en), nums(r.text.explain.es));
    assert.ok(!/equity|equidad/i.test(r.text.en + r.text.es));
  }));
});

test('explanations: deterministic text (same situation, same paragraph)', () => {
  SITUATIONS.forEach((mk) => ACTIONS.forEach((a) => {
    const x = R.rateDecision(mk(), a).text.explain;
    const y = R.rateDecision(mk(), a).text.explain;
    assert.deepStrictEqual(x, y);
  }));
});

test('book: never for blunders or mistakes (and only with ~zero EV loss)', () => {
  SITUATIONS.forEach((mk) => ACTIONS.forEach((a) => {
    const r = R.rateDecision(mk(), a);
    if (r.rating === 'book') assert.ok(r.evLossBB < 0.05, 'book with EV loss ' + r.evLossBB);
    if (['blunder', 'mistake', 'inaccuracy', 'miss'].includes(r.rating)) assert.notStrictEqual(r.rating, 'book');
  }));
});

test('luck: bad-luck text uses the human wording', () => {
  const sc = scenario({ hero: ['Ah', 'Ad'], board: [], pot: 0, toCall: 0, heroStack: 0, street: 'preflop' });
  const h = R.reviewHand({ decisions: [{ scenario: sc, action: 'call', winChance: 0.85 }], heroNetBB: -100, potBB: 200, heroInvestedBB: 100, showdown: true });
  assert.strictEqual(h.luck.label, 'bad_luck');
  assert.ok(h.luck.text.en.startsWith('Bad luck: you were 85% to win'), h.luck.text.en);
  assert.ok(/(Play it the same way next time\.|so keep doing it\.|repeat them\.)$/.test(h.luck.text.en), h.luck.text.en);
  assert.ok(h.luck.text.es.startsWith('Mala suerte: tenías un 85% de ganar'), h.luck.text.es);
});

// ---- coach paragraph (text.explain): template coverage, reading level, contradictions, reason sentences.
const TPL = R.EXPLAIN_TPL;
const PLACE = /\{(\w+)\}/g;
const placeholders = (s) => (s.match(PLACE) || []).slice().sort().join(' ');
const PRAISE_EN = /\b(nice|sound|good (play|choice|discipline)|good discipline|keep it|keep doing|well done|great|right (play|choice|move|one))\b/i;
const PRAISE_ES = /(buena jugada|buen trabajo|buena disciplina|sólid[ao]|sigue así|repítela|repite esto|repite este)/i;
const CATS = ['forced', 'book', 'brilliant', 'great', 'best', 'good', 'call_good', 'fold_good', 'call_light', 'fold_tight', 'fold_free', 'bad', 'size', 'miss_big', 'miss_ahead'];

test('coach templates: every category has 3 phrasings in EN and ES, with the same placeholders', () => {
  CATS.forEach((c) => {
    assert.ok(TPL[c], 'missing category ' + c);
    assert.strictEqual(TPL[c].en.length, 3, c + ' EN count');
    assert.strictEqual(TPL[c].es.length, 3, c + ' ES count');
    TPL[c].en.forEach((en, i) => {
      assert.strictEqual(placeholders(en), placeholders(TPL[c].es[i]), c + '[' + i + '] placeholders differ');
      assert.ok(!/\bequity\b/i.test(en), c + ' equity');
    });
  });
});

test('coach templates: every sentence reads at 22 words or fewer', () => {
  CATS.forEach((c) => {
    ['en', 'es'].forEach((L) => TPL[c][L].forEach((t) => {
      // Test the EN wording only (ES is longer in words); placeholders counted as one word each.
      if (L !== 'en') return;
      t.split(/(?<=[.!?])\s+/).forEach((sen) => assert.ok(sen.split(/\s+/).length <= 22, c + ' long sentence: ' + sen));
    }));
  });
});

test('contradictions: blunder, mistake, inaccuracy, miss never praise the play', () => {
  SITUATIONS.forEach((mk) => ACTIONS.forEach((a) => {
    const r = R.rateDecision(mk(), a);
    if (!['blunder', 'mistake', 'inaccuracy', 'miss'].includes(r.rating)) return;
    const en = [r.text.headline.en, r.text.short.en, r.text.explain.en].join(' ');
    const es = [r.text.headline.es, r.text.short.es, r.text.explain.es].join(' ');
    assert.ok(!PRAISE_EN.test(en), r.rating + ' praises (EN): ' + en);
    assert.ok(!PRAISE_ES.test(es), r.rating + ' praises (ES): ' + es);
  }));
});

test('contradictions: best, great, brilliant never say mistake, blunder or inaccuracy', () => {
  SITUATIONS.forEach((mk) => ACTIONS.forEach((a) => {
    const r = R.rateDecision(mk(), a);
    if (!['best', 'great', 'brilliant', 'book'].includes(r.rating)) return;
    const en = [r.text.headline.en, r.text.short.en, r.text.explain.en].join(' ');
    const es = [r.text.headline.es, r.text.short.es, r.text.explain.es].join(' ');
    assert.ok(!/mistake|blunder|inaccuracy|miss\b/i.test(en), r.rating + ' says a fault (EN): ' + en);
    assert.ok(!/\berror\b|grave|imprecisi/i.test(es), r.rating + ' says a fault (ES): ' + es);
  }));
});

test('verdict: a free check with 1% to win (best) names the free card, not a bare percentage', () => {
  const sc = scenario({ hero: ['7d', '2c'], board: ['Ah', 'Kd', '9s', '5c', '4h'], pot: 20, toCall: 0 });
  const r = R.rateDecision(sc, { action: 'check' });
  assert.strictEqual(r.best.action, 'check');
  assert.ok(r.text.explain.en.includes('Checking is free, so you see the next card at no cost and keep your chips.'), r.text.explain.en);
  assert.ok(!/with 1% to win/.test(r.text.explain.en), r.text.explain.en);
});

test('coach text: 2 to 3 sentences plus at most one out-of-position sentence; no bullets', () => {
  SITUATIONS.forEach((mk) => ACTIONS.forEach((a) => {
    const txt = R.rateDecision(mk(), a).text.explain.en;
    const n = txt.split(/(?<=[.!?])\s+/).length;
    assert.ok(n >= 2 && n <= 4, n + ' sentences: ' + txt);
  }));
});

test('ratings: every rating has a readable name in EN and ES', () => {
  R.RATINGS.forEach((k) => {
    const en = R.format('rating.' + k, {}, 'en');
    const es = R.format('rating.' + k, {}, 'es');
    assert.ok(en && !en.startsWith('rating.'), k);
    assert.ok(es && !es.startsWith('rating.'), k);
  });
});

console.log('\n' + passed + ' review tests passed' + (process.exitCode ? ' (with failures)' : ''));
