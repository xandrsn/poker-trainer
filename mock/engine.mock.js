/* Throwaway mock of public/engine.js for UI development. Not shipped. */
(function (root) {
  'use strict';

  const RANKS = '23456789TJQKA';
  const SUITS = 'shdc';
  const STREETS = ['preflop', 'flop', 'turn', 'river'];
  const BOARD_LEN = { preflop: 0, flop: 3, turn: 4, river: 5 };
  const STYLES = ['tight', 'loose', 'aggressive', 'passive', 'balanced'];
  // Seat order clockwise starting from the button.
  const ORDER = {
    2: ['BTN', 'BB'],
    3: ['BTN', 'SB', 'BB'],
    4: ['BTN', 'SB', 'BB', 'CO'],
    5: ['BTN', 'SB', 'BB', 'UTG', 'CO'],
    6: ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'],
    7: ['BTN', 'SB', 'BB', 'UTG', 'LJ', 'HJ', 'CO'],
    8: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'LJ', 'HJ', 'CO'],
    9: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO'],
  };

  function makeRng(seed) {
    let s = (seed >>> 0) || 0x9e3779b9;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }
  function hashStr(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }
  const r05 = (x) => Math.round(x * 2) / 2;
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function generateScenario(opts) {
    opts = opts || {};
    const rnd = opts.seed != null ? makeRng(opts.seed) : Math.random;
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    // Fixed position with random size: pick a size whose table has that seat.
    const sizesWith = Object.keys(ORDER).map(Number).filter((k) => !opts.position || ORDER[k].includes(opts.position));
    const n = opts.players >= 2 && opts.players <= 9 ? Math.floor(opts.players) : sizesWith[Math.floor(rnd() * sizesWith.length)];
    const street = opts.street && opts.street !== 'any' ? opts.street : pick(STREETS);

    const deck = [];
    for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    const hero = [deck.pop(), deck.pop()];
    const board = [];
    for (let i = 0; i < BOARD_LEN[street]; i++) board.push(deck.pop());

    const order = ORDER[n];
    const buttonSeat = Math.floor(rnd() * n);
    const heroK = opts.position && order.indexOf(opts.position) >= 0 ? order.indexOf(opts.position) : Math.floor(rnd() * n);
    const preflop = street === 'preflop';
    const potBefore = preflop ? 1.5 : r05(2 + rnd() * 12);
    const raiseTo = pick([2.5, 3, 3, 4, 9]);
    const aggressorK = (heroK + 1 + Math.floor(rnd() * Math.max(1, n - 1))) % n;

    const items = [];
    for (let k = 0; k < n; k++) {
      const isHero = k === heroK;
      const position = order[k];
      const style = isHero ? 'balanced' : pick(STYLES);
      const folded = !isHero && rnd() < (preflop ? 0.45 : 0.3);
      let bet = 0;
      let lastAction = '';
      if (isHero) {
        if (preflop) bet = position === 'SB' || (n === 2 && position === 'BTN') ? 0.5 : position === 'BB' ? 1 : 0;
      } else if (folded) {
        lastAction = 'folds';
      } else if (preflop) {
        if (k === aggressorK) { bet = raiseTo; lastAction = 'raises to ' + raiseTo + ' BB'; }
        else if (rnd() < 0.5) { bet = 1; lastAction = 'calls 1 BB'; }
        else { bet = 1; lastAction = 'limps'; }
      } else if (k === aggressorK && rnd() < 0.6) {
        bet = r05(potBefore * (0.3 + rnd() * 0.6));
        lastAction = 'bets ' + bet + ' BB';
      } else {
        lastAction = 'checks';
      }
      items.push({ k, seat: (buttonSeat + k) % n, position, name: isHero ? 'Hero' : 'Villain ' + k,
        stack: isHero ? r05(60 + rnd() * 120) : r05(40 + rnd() * 160), bet, folded, isHero, style, lastAction });
    }
    items.sort((a, b) => a.seat - b.seat);

    const heroItem = items.find((s) => s.isHero);
    const maxBet = Math.max.apply(null, items.map((s) => s.bet));
    const toCall = Math.max(0, r05(maxBet - heroItem.bet));
    const pot = r05(potBefore + items.reduce((a, s) => a + s.bet, 0));
    const heroStack = heroItem.stack;
    const allIn = r05(heroItem.bet + heroStack);
    const minTotal = r05(heroItem.bet + toCall + Math.max(1, toCall));
    const raw = [
      { label: 'Min', amount: minTotal },
      { label: '1/2 pot', amount: r05(heroItem.bet + toCall + (pot + toCall) * 0.5) },
      { label: '2/3 pot', amount: r05(heroItem.bet + toCall + (pot + toCall) * 0.667) },
      { label: 'Pot', amount: r05(heroItem.bet + toCall + pot + toCall) },
      { label: 'All-in', amount: allIn },
    ];
    const seen = {};
    const raiseOptions = raw.filter((o) => {
      if (o.amount > allIn || o.amount < minTotal && o.label !== 'Min' || seen[o.amount]) return false;
      seen[o.amount] = true;
      return true;
    });

    const id = 's' + Math.floor(rnd() * 1e9).toString(36);
    const seats = items.map((s) => ({
      seat: s.seat, position: s.position, name: s.name, stack: s.stack, bet: s.bet, folded: s.folded,
      isHero: s.isHero, style: s.style, lastAction: s.lastAction,
    }));
    const actionLog = items.filter((s) => !s.isHero && s.lastAction).map((s) => s.position + ' ' + s.lastAction);

    return {
      id,
      numPlayers: n,
      street,
      hero,
      board,
      blinds: { sb: 0.5, bb: 1 },
      pot,
      toCall,
      heroStack,
      heroPosition: heroItem.position,
      heroSeat: heroItem.seat,
      buttonSeat,
      inPosition: ['BTN', 'CO', 'SB'].indexOf(heroItem.position) >= 0 || n === 2,
      seats,
      actionLog,
      raiseOptions,
      situation: n + '-handed, ' + street + ', hero ' + heroItem.position +
        (toCall > 0 ? ', facing ' + toCall + ' BB' : ', checked to hero'),
    };
  }

  function evaluate(sc, action, raiseAmount) {
    if (['fold', 'call', 'raise'].indexOf(action) < 0) throw new Error('Unknown action: ' + action);
    const h = hashStr(sc.id + ':' + sc.toCall);
    const bestRaise = sc.raiseOptions && sc.raiseOptions[1] ? sc.raiseOptions[1].amount : null;
    let best;
    if (sc.toCall > 0) best = ['call', 'raise', 'fold'][h % 3];
    else best = h % 2 ? 'call' : 'raise';
    let rating;
    if (action === best) rating = 'best';
    else if (action === 'fold' && sc.toCall === 0) rating = 'blunder';
    else rating = ['good', 'mistake', 'blunder'][(h >>> 3) % 3];
    const score = { best: 100, good: 80, mistake: 40, blunder: 10 }[rating];
    const eq = 30 + (h % 50);
    const potOdds = sc.toCall > 0 ? (sc.toCall / (sc.pot + sc.toCall)) * 100 : 0;
    const ev = { fold: 0, call: r05((eq / 100) * (sc.pot + sc.toCall) - sc.toCall), raise: r05(((h >>> 5) % 9) - 3) };
    const hero = sc.hero.join(' ');
    return {
      best,
      bestRaiseAmount: best === 'raise' ? bestRaise : null,
      rating,
      correct: rating === 'best' || rating === 'good',
      ev,
      score,
      summary: cap(best) + ' is best â€“ mock verdict for ' + action + ' (' + rating + ')',
      explanation: [
        'Hand strength: ' + hero + ' is a mock hand with roughly ' + eq + '% equity.',
        'Pot odds: you need ' + potOdds.toFixed(1) + '% to continue facing ' + sc.toCall + ' BB.',
        'Position: ' + sc.heroPosition + (sc.inPosition ? ' (in position) gives extra control.' : ' (out of position).'),
        'Stack-to-pot ratio is about ' + (sc.heroStack / Math.max(0.5, sc.pot)).toFixed(1) + '.',
        'Alternatives: ' + (best === action ? 'the other lines are weaker here.' : 'your choice leaves EV on the table.'),
      ],
      stats: [
        { label: 'Hand / Made hand', value: 'Mock pair', hint: 'Placeholder' },
        { label: 'Equity vs range', value: eq + '%', hint: 'Monte Carlo (mock)' },
        { label: 'Pot odds (required equity)', value: potOdds.toFixed(1) + '%', hint: 'toCall / (pot + toCall)' },
        { label: 'Outs', value: sc.street === 'preflop' ? 'n/a' : '8', hint: 'Post-flop only' },
        { label: 'Position', value: sc.heroPosition, hint: sc.inPosition ? 'In position' : 'Out of position' },
        { label: 'Players', value: String(sc.numPlayers), hint: 'Dealt in' },
        { label: 'Pot', value: sc.pot + ' BB', hint: 'Includes current bets' },
        { label: 'To call', value: sc.toCall + ' BB', hint: '' },
        { label: 'Stack-to-pot ratio', value: (sc.heroStack / Math.max(0.5, sc.pot)).toFixed(1), hint: 'SPR' },
        { label: 'Villain range estimate', value: 'Top 35%', hint: 'Mock' },
        { label: 'EV fold / call / raise', value: '0 / ' + ev.call + ' / ' + ev.raise + ' BB', hint: 'Approximate' },
        { label: 'Board texture', value: sc.board.length ? 'Dry' : 'n/a', hint: 'Post-flop only' },
        { label: 'Hand percentile', value: 'Top ' + (20 + (h % 60)) + '%', hint: 'Preflop tier (mock)' },
      ],
    };
  }

  // Range charts (mock). Grid rows/cols: index 0 = A ... 12 = 2; row = higher card, col = lower card;
  // above the diagonal = suited, below = offsuit, diagonal = pairs. Cells are {raise, call, fold} frequencies.
  var CHART_FACINGS = { unopened: 1, facing: 1 };
  function listChartSpots(numPlayers) {
    var n = Math.floor(Number(numPlayers));
    if (!ORDER[n]) throw new Error('listChartSpots: unsupported player count ' + numPlayers);
    var spots = [];
    ORDER[n].forEach(function (pos) {
      if (pos === 'BB') return;
      spots.push({ position: pos, facing: 'unopened', label: pos + ' unopened' });
      if (pos !== 'SB' || n === 2) spots.push({ position: pos, facing: 'facing', label: pos + ' facing raise' });
    });
    return spots;
  }
  function getRangeChart(numPlayers, position, facing) {
    var n = Math.floor(Number(numPlayers));
    if (!ORDER[n]) throw new Error('getRangeChart: unsupported player count ' + numPlayers);
    var spot = listChartSpots(n).filter(function (s) { return s.position === position && s.facing === facing; })[0];
    if (!spot) return null;
    var tight = 0.5 + (ORDER[n].indexOf(position) / Math.max(1, n - 1)) * -0.25 + (facing === 'facing' ? 0.2 : 0);
    var grid = [];
    for (var r = 0; r < 13; r++) {
      var row = [];
      for (var c = 0; c < 13; c++) {
        var strength = (12 - Math.min(r, c)) / 12 * 0.6 + (12 - Math.max(r, c)) / 12 * 0.3 + (r === c ? 0.25 : 0) + (r < c ? 0.05 : 0);
        var raise = Math.max(0, Math.min(1, (strength - tight) * 4));
        var call = Math.max(0, Math.min(1 - raise, (strength - tight + 0.12) * 2 - raise * 0.5));
        if (facing === 'facing' && raise > 0) { call = Math.min(1 - raise, call + 0.1); }
        var fold = Math.max(0, 1 - raise - call);
        row.push({ raise: Math.round(raise * 100) / 100, call: Math.round(call * 100) / 100, fold: Math.round(fold * 100) / 100 });
      }
      grid.push(row);
    }
    return { numPlayers: n, position: position, facing: facing, label: spot.label, grid: grid };
  }

  function evaluateHand(cards) { return { rank: 0, name: 'Mock ' + cards.join('') }; }
  function equity(hero, board, range) { return { win: 0.5, tie: 0, range: range || 1, hero: hero, board: board }; }

  const api = { generateScenario, evaluate, evaluateHand, equity, getRangeChart, listChartSpots };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PokerEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
