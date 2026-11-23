/* Poker Trainer CPU bots. Each personality type (tight, loose, aggressive, passive, balanced) has
 * built-in tendencies: preflop range widths (open / play / 3-bet cut-offs by hand percentile,
 * scaled by position), postflop equity thresholds for betting, raising, calling and bluffing.
 * Decisions depend only on the state, the seat's personality and a seed: no Math.random, no
 * randomness parameter. Stack depth matters: short stacks (<= 15 BB) push/fold, and an all-in
 * that covers the bot is called more selectively than one the bot covers. Pure JS, no state.
 * Browser: window.PokerBots. Node: module.exports. */
(function () {
  'use strict';

  var E = (typeof window !== 'undefined' && window.PokerEngine) || require('../public/engine.js');

  var TYPES = ['tight', 'loose', 'aggressive', 'passive', 'balanced'];
  // Preflop (hand percentile, 0 = best, 1 = worst):
  //   open: raise cut-off when unopened (PFR); play: call/limp cut-off (VPIP); threeBet: 3-bet cut-off;
  //   limp: whether the type limps; width: push-range width for short stacks; openSize: raise size.
  // Postflop (equity 0..1):
  //   betTh/raiseTh: equity to bet/raise; betSize: bet as a fraction of the pot; bluff/bluffMin: chance
  //   and equity floor for betting with low equity; bluffRaise: chance of a raise bluff; callMargin: extra
  //   equity needed to call; marginal: chance of calling just below the pot-odds line; villainTop: width
  //   of the opponent range assumed for equity.
  var TRAITS = {
    tight:      { open: 0.12, play: 0.16, threeBet: 0.04, limp: false, width: 0.85, openSize: 0.95,
                  betTh: 0.36, raiseTh: 0.75, betSize: 0.50, bluff: 0.75, bluffMin: 0.30, bluffRaise: 0.00,
                  callMargin: 0.16, bigBetMargin: 0.06, marginal: 0.02, villainTop: 0.22 },
    loose:      { open: 0.12, play: 0.39, threeBet: 0.03, limp: true, width: 1.20, openSize: 1.05,
                  betTh: 0.36, raiseTh: 0.80, betSize: 0.50, bluff: 0.65, bluffMin: 0.20, bluffRaise: 0.05,
                  callMargin: -0.03, bigBetMargin: 0.00, marginal: 0.60, villainTop: 0.50 },
    aggressive: { open: 0.26, play: 0.27, threeBet: 0.09, limp: false, width: 1.00, openSize: 1.15,
                  betTh: 0.30, raiseTh: 0.50, betSize: 0.75, bluff: 0.95, bluffMin: 0.00, bluffRaise: 0.40,
                  callMargin: 0.05, bigBetMargin: 0.00, marginal: 0.05, villainTop: 0.40 },
    passive:    { open: 0.05, play: 0.30, threeBet: 0.00, limp: true, width: 1.00, openSize: 0.90,
                  betTh: 0.85, raiseTh: 0.95, betSize: 0.33, bluff: 0.00, bluffMin: 1.00, bluffRaise: 0.00,
                  callMargin: 0.07, bigBetMargin: 0.08, marginal: 0.20, villainTop: 0.35 },
    balanced:   { open: 0.19, play: 0.23, threeBet: 0.06, limp: true, width: 1.00, openSize: 1.00,
                  betTh: 0.42, raiseTh: 0.70, betSize: 0.50, bluff: 0.80, bluffMin: 0.05, bluffRaise: 0.25,
                  callMargin: 0.03, bigBetMargin: 0.03, marginal: 0.15, villainTop: 0.35 },
  };
  // Position weight on the preflop cut-offs (6-max average is about 1).
  var POS_MULT = { UTG: 0.55, 'UTG+1': 0.7, MP: 0.85, LJ: 0.9, HJ: 0.95, CO: 1.25, BTN: 1.8, SB: 1.15, BB: 0.8 };
  var SHORT_BB = 15; // at or below this effective stack the bot plays push/fold
  // Lowest equity at which a postflop bluff bet or raise is made (per personality, the larger of this
  // and bluffMin). Without it an aggressive bot raise-bluffed with about 0% to win.
  var BLUFF_FLOOR = 0.13;
  var SAMPLES = 160;
  var EARLY = ['UTG', 'UTG+1', 'MP'];

  var PERSONAS = TYPES.map(function (t) {
    var lo = t === 'tight' || t === 'loose' ? t : 'balanced';
    var ag = t === 'aggressive' || t === 'passive' ? t : 'balanced';
    return { name: t, type: t, looseness: lo, aggression: ag };
  });

  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

  function hashParts(parts) {
    var s = parts.join('|');
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function makeRng(seed) {
    var a = seed | 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function styleOf(p) {
    if (!p) return 'balanced';
    if (p.aggression === 'aggressive') return 'aggressive';
    if (p.aggression === 'passive') return 'passive';
    if (p.looseness === 'tight') return 'tight';
    if (p.looseness === 'loose') return 'loose';
    return 'balanced';
  }
  function traitsOf(seat) {
    var t = seat && TRAITS[seat.type] ? seat.type : styleOf(seat);
    return TRAITS[t] || TRAITS.balanced;
  }

  // ---------------------------------------------------------------- ranges
  var COMBO_PCT = null;
  var VILLAIN_W = {};
  function comboPct() {
    if (COMBO_PCT) return COMBO_PCT;
    COMBO_PCT = new Float64Array(1326);
    var k = 0;
    for (var a = 0; a < 52; a++) for (var b = a + 1; b < 52; b++) {
      COMBO_PCT[k++] = E.preflopPercentile(a, b);
    }
    return COMBO_PCT;
  }
  function villainWeights(top) {
    var key = String(top);
    if (VILLAIN_W[key]) return VILLAIN_W[key];
    var pct = comboPct();
    var w = new Float64Array(1326);
    for (var k = 0; k < 1326; k++) w[k] = pct[k] <= top ? 1 : 0;
    VILLAIN_W[key] = w;
    return w;
  }

  // 'open' (nothing raised yet, limps allowed), 'vs_limp', 'vs_raise' (one raise), 'vs_3bet' (more).
  function facingOf(sc) {
    var lvl = 0;
    sc.seats.forEach(function (s) {
      if (s.isHero) return;
      var r = s.preflopRole;
      if (r === 'limp') lvl = Math.max(lvl, 1);
      else if (r === 'open') lvl = Math.max(lvl, 2);
      else if (r === '3bet' || r === '4bet' || r === '5bet') lvl = Math.max(lvl, 3);
    });
    return lvl === 3 ? 'vs_3bet' : lvl === 2 ? 'vs_raise' : lvl === 1 ? 'vs_limp' : 'open';
  }
  function limperCount(sc) {
    return sc.seats.filter(function (s) { return !s.isHero && s.preflopRole === 'limp'; }).length;
  }

  // ------------------------------------------------------------ stack depth
  // Everything in BB. eff: the deepest stack that can still be lost by the bot (smallest live
  // opponent stack, or the bot's own if it is smaller). covered: some live opponent has more chips
  // in total than the bot, so a call can be all-in for the bot. coversAll: the bot covers every
  // live opponent.
  function stackState(sc, L) {
    var hero = sc.seats.filter(function (s) { return s.isHero; })[0];
    var heroStack = hero.stack;
    // Totals = chips still behind + chips already in this hand (an all-in opponent keeps its total).
    var heroTotal = hero.stack + hero.contributed;
    var live = sc.seats.filter(function (s) { return !s.isHero && !s.folded && !s.busted; });
    var eff = heroTotal, covered = false, coversAll = true;
    live.forEach(function (s) {
      var tot = s.stack + s.contributed;
      eff = Math.min(eff, tot);
      if (tot > heroTotal + 1e-9) { covered = true; coversAll = false; }
    });
    var allInCall = L.toCall > 0 && L.toCall >= heroStack - 1e-9;
    var facing = sc.street === 'preflop' ? facingOf(sc) : null;
    var marginAdj = 0;
    if (!allInCall && coversAll && live.length) marginAdj -= 0.02; // covering stacks call wider
    return {
      eff: eff,
      C: Math.min(L.toCall, heroStack),
      allInCall: allInCall,
      covered: covered,
      coversAll: coversAll,
      facingRaise: facing === 'vs_raise' || facing === 'vs_3bet',
      marginAdj: marginAdj,
    };
  }

  // Bet/raise size in BB, scaled by the stack-to-pot ratio. Shallow (SPR <= 2.5) jams, but only a
  // raise: a bet into a shallow pot still uses the pot-fraction size (a bet is never an all-in just
  // because the stack is short relative to the pot). isRaise: the bot is raising, not opening a bet.
  function sizedTo(L, base, f, spr, isRaise) {
    if (isRaise && spr <= 2.5) return L.maxRaiseTo;
    return Math.min(L.curBet + f * base, L.maxRaiseTo);
  }
  // Pot fraction for a bet or raise. value: thin value bets small, strong hands larger (up to ~1.3x the
  // personality size). bluff: the personality size. Shallow SPR: geometric size, so the stack is
  // committed over the streets left (f = ((1+2*SPR)^(1/n) - 1) / 2). A random jitter of +-10% keeps the
  // sizes from being a tell. Consumes one rng draw.
  function betFrac(T, eq, sc, spr, rng, kind) {
    var street = sc.street;
    var f = T.betSize;
    // Bluff size from the pot odds it offers: with bluffs a share b of the betting range, a bet of f pot
    // is break-even when f/(1+2f) = b, so f = b/(1-2b). Semi-bluffs (some equity) are sized a bit larger.
    if (kind === 'bluff') { var b = 0.2 + 0.1 * T.bluff; f = b / (1 - 2 * b); if (eq >= 0.3) f *= 1.15; }
    if (kind === 'value') f *= 0.8 + 0.5 * clamp((eq - T.betTh) / Math.max(0.05, 1 - T.betTh), 0, 1);
    var left = street === 'flop' ? 3 : street === 'turn' ? 2 : 1;
    if (spr < 4) f = (Math.pow(1 + 2 * Math.max(spr, 0.01), 1 / left) - 1) / 2;
    // Wetter boards get bigger value bets (draws to charge), dry boards smaller ones.
    if (kind === 'value') f *= 0.85 + 0.3 * boardWet(sc);
    // Overbets only polarized: nuts (eq >= 0.85) or air (eq < 0.25). Others are capped at a pot.
    if (f > 1 && !(eq >= 0.85 || eq < 0.25)) f = 1;
    return Math.min(f, 1.3) * (0.9 + 0.2 * rng()); // overbets up to ~1.4 pot, never more
  }
  // 0..1 wetness of the board: flush draws (suit counts), connected ranks, paired boards dry it.
  function boardWet(sc) {
    var b = sc.board || [];
    if (b.length < 3) return 0;
    var suits = {}, ranks = {}, maxS = 0;
    b.forEach(function (c) {
      suits[c.charAt(1)] = (suits[c.charAt(1)] || 0) + 1;
      maxS = Math.max(maxS, suits[c.charAt(1)]);
      ranks[RANK_CHARS.indexOf(c.charAt(0))] = 1;
    });
    var r = Object.keys(ranks).map(Number).sort(function (x, y) { return x - y; });
    var span = 0, run = 1;
    for (var i = 1; i < r.length; i++) { run = r[i] - r[i - 1] <= 2 ? run + 1 : 1; span = Math.max(span, run); }
    var paired = r.length < b.length ? 0.1 : 0;
    return clamp((maxS >= 3 ? 0.5 : maxS === 2 ? 0.15 : 0) + (span >= 3 ? 0.35 : span === 2 ? 0.15 : 0) - paired, 0, 1);
  }
  var RANK_CHARS = '23456789TJQKA';

  // ------------------------------------------------------- postflop strategy
  // capTop (optional): on a turn or river all-in or a bet >= pot, a bet this big is made by a strong
  // range, so the assumed villain range is narrowed (15% for a tight-passive bot, 25% otherwise).
  function villainRanges(sc, capTop) {
    return sc.seats
      .filter(function (s) { return !s.isHero && !s.folded && !s.busted; })
      .map(function (s) {
        var top = TRAITS[s.style] ? TRAITS[s.style].villainTop : 0.35;
        if (capTop != null) top = Math.min(top, capTop);
        return villainWeights(top);
      });
  }
  // Postflop (and short-stack) by equity against the opponents' assumed ranges.
  // River showdown value with no hole card involved: the board makes at most a pair (or high card) and the
  // hole cards add nothing (no pair with the board or each other, no flush or straight). Such a hand
  // should not pay a big bet.
  function boardOnlyValue(sc) {
    if (sc.street !== 'river' || !sc.board || sc.board.length !== 5 || !sc.hero || sc.hero.length !== 2) return false;
    var boardRank = E.evaluateHand(sc.board).rank;
    var allRank = E.evaluateHand(sc.board.concat(sc.hero)).rank;
    if (boardRank > 1 || allRank > 1) return false;
    var boardR = sc.board.map(function (c) { return c.charAt(0); });
    var h0 = sc.hero[0].charAt(0), h1 = sc.hero[1].charAt(0);
    return boardR.indexOf(h0) < 0 && boardR.indexOf(h1) < 0 && h0 !== h1;
  }
  // Hand category (engine rank) when a hole card takes part and it is two pair or better; 0 otherwise
  // (a board-only pair or two pair does not count).
  function madeRank(sc) {
    var b = sc.board || [], h = sc.hero;
    if (b.length < 3 || !h || h.length !== 2) return 0;
    var all = E.evaluateHand(b.concat(h)).rank;
    if (all < 2) return 0;
    if (all >= 4) return b.length < 5 || E.evaluateHand(b).rank < all ? all : 0;
    var cnt = {};
    b.concat(h).forEach(function (c) { cnt[c.charAt(0)] = (cnt[c.charAt(0)] || 0) + 1; });
    return cnt[h[0].charAt(0)] >= 2 || cnt[h[1].charAt(0)] >= 2 ? all : 0;
  }
  // A five-card board that can complete a flush or straight with one more card (4 suited or 4 ranks in
  // a five-rank window): a bigger made hand is possible there.
  function coordinatedBoard(board) {
    if (board.length !== 5) return false;
    var suits = {}, ranks = {};
    board.forEach(function (c) {
      suits[c.charAt(1)] = (suits[c.charAt(1)] || 0) + 1;
      ranks[RANK_CHARS.indexOf(c.charAt(0))] = true;
    });
    if (Object.keys(suits).some(function (s) { return suits[s] >= 4; })) return true;
    for (var lo = 0; lo <= 8; lo++) {
      var n = 0;
      for (var r = lo; r < lo + 5; r++) if (ranks[r]) n++;
      if (n >= 4) return true;
    }
    return false;
  }
  function equityChoice(sc, L, T, st, rng) {
    var P = sc.pot, C = st.C;
    // A big bet (>= pot) or any all-in on turn/river is a strong range: narrow the assumed villain range.
    // P includes the bet, so a bet of at least the pot before it is C >= P - C.
    var bigOrAllIn = st.allInCall || C >= (P - C) - 1e-9;
    var lateStreet = sc.street === 'turn' || sc.street === 'river';
    var capTop = null;
    if (bigOrAllIn && lateStreet) capTop = T.bigBetMargin >= 0.05 ? 0.15 : 0.25;
    var ranges = villainRanges(sc, capTop);
    var eq = ranges.length ? E.equity(sc.hero, sc.board, ranges, { samples: SAMPLES, rng: rng }) : 1;
    if (st.eff <= SHORT_BB) return C > 1e-9 && madeRank(sc) >= 2 ? { action: 'call' } : shortEquity(eq, L, P, C, st);
    var spr = st.eff / Math.max(P, 0.01);
    // Bluffs need some chance to win (a floor, so no bluff is made with near-zero equity).
    var bluffFloor = Math.max(T.bluffMin, BLUFF_FLOOR);
    if (C <= 1e-9) {
      if (L.canRaise && eq >= T.betTh) return { action: 'raise', amount: sizedTo(L, P, betFrac(T, eq, sc, spr, rng, 'value'), spr, false) };
      if (L.canRaise && eq >= bluffFloor && rng() < T.bluff) return { action: 'raise', amount: sizedTo(L, P, betFrac(T, eq, sc, spr, rng, 'bluff'), spr, false) };
      return { action: 'call' };
    }
    var req = C / (P + C);
    // The extra margin grows with the bet size (0 at a small bet, full at a pot-size bet or all-in), so a
    // cheaper price never needs more equity: calling frequency is monotone in pot odds.
    var margin = T.callMargin + st.marginAdj + T.bigBetMargin * clamp(C / Math.max(P - C, 0.01), 0, 1);
    if (L.canRaise && eq >= T.raiseTh + (st.allInCall ? 0.05 : 0)) {
      return { action: 'raise', amount: sizedTo(L, P + C, betFrac(T, eq, sc, spr, rng, 'value'), spr, true) };
    }
    // A made hand that uses a hole card (two pair or better) calls any bet. Only a river over-pot or all-in
    // bet from a hand that is not clearly ahead (equity < 50%) on a coordinated board can make it fold.
    var coord = sc.street === 'river' && bigOrAllIn && eq < 0.4 && coordinatedBoard(sc.board);
    if (madeRank(sc) >= 2 && !coord) return { action: 'call' };
    // Weak showdown value (board pair only) folds to a big bet unless the equity is strong.
    var bigBet = C >= 0.5 * (P - C);
    if (bigBet && eq < T.raiseTh && boardOnlyValue(sc)) return { action: 'fold' };
    if (eq >= req + margin) return { action: 'call' };
    // Natural deviation: a hand just below the pot-odds line is sometimes called (never an all-in).
    // Never a random call against an all-in or a bet >= pot.
    if (!bigOrAllIn && eq >= req + margin - 0.05 && rng() < T.marginal) return { action: 'call' };
    if (L.canRaise && !st.allInCall && eq >= bluffFloor && rng() < T.bluffRaise) {
      return { action: 'raise', amount: sizedTo(L, P + C, betFrac(T, eq, sc, spr, rng, 'bluff'), spr, true) };
    }
    return { action: 'fold' };
  }
  // Short stack (push/fold) by equity: shove strong hands, call only with clear pot odds.
  function shortEquity(eq, L, P, C, st) {
    // Never more than the effective stack (the shortest live total): an all-in for a few chips must not
    // make a deep bot push its whole stack into a small pot.
    var shove = Math.min(L.maxRaiseTo, Math.max(st.eff, L.minRaiseTo));
    if (C <= 1e-9) {
      if (L.canRaise && eq >= 0.55) return { action: 'raise', amount: shove };
      return { action: 'call' };
    }
    if (L.canRaise && eq >= 0.68) return { action: 'raise', amount: shove };
    var req = C / (P + C);
    if (eq >= req + (st.allInCall ? 0.06 : 0.02)) return { action: 'call' };
    return { action: 'fold' };
  }

  // ----------------------------------------------------------- preflop
  // Call cut-off for the hand percentile: an all-in the bot is covered by is called less; an all-in
  // the bot covers is called more.
  function callCut(T, m, st) {
    var c = T.play * m;
    if (st.allInCall) c *= 0.6;
    else if (st.coversAll) c *= 1.15;
    return c;
  }
  // Push/fold for stacks <= SHORT_BB: the push range widens as the stack shrinks.
  function shortPreflop(L, T, st, pct) {
    var top = clamp(0.25 + (SHORT_BB - st.eff) * 0.035, 0.25, 0.8) * T.width;
    if (!st.facingRaise) {
      if (L.canRaise && pct <= top) return { action: 'raise', amount: L.maxRaiseTo };
      return { action: st.C > 1e-9 ? 'fold' : 'call' };
    }
    if (st.C <= 1e-9) return { action: 'call' };
    var callTop = top * (st.allInCall ? 0.6 : 0.75) * (st.coversAll ? 1.15 : 1);
    return { action: pct <= callTop ? 'call' : 'fold' };
  }
  function preflopChoice(sc, hero, L, T, st, rng) {
    var facing = facingOf(sc);
    var pct = E.preflopPercentile(sc.hero[0], sc.hero[1]);
    if (st.eff <= SHORT_BB) return shortPreflop(L, T, st, pct);
    var m = POS_MULT[hero.position] || 1;
    var limpers = limperCount(sc);
    if (facing === 'open' || facing === 'vs_limp') {
      if (L.canRaise && pct <= T.open * m) {
        var base = facing === 'vs_limp' ? 3 + limpers
          : (EARLY.indexOf(hero.position) >= 0 ? 3 : 2.5) + limpers * 0.5;
        return { action: 'raise', amount: base * T.openSize * (0.95 + 0.1 * rng()) };
      }
      if (st.C <= 1e-9) return { action: 'call' }; // free check
      if (T.limp && pct <= T.play * m) return { action: 'call' };
      return { action: 'fold' };
    }
    if (facing === 'vs_raise') {
      if (L.canRaise && !st.allInCall && pct <= T.threeBet * m) {
        // 3-bet about 3x the open in position, 4x out of position (plus a little jitter).
        var inPos = hero.position === 'CO' || hero.position === 'BTN';
        return { action: 'raise', amount: L.curBet * (inPos ? 3 : 4) * T.openSize * (0.95 + 0.1 * rng()) };
      }
      return { action: pct <= callCut(T, m, st) ? 'call' : 'fold' };
    }
    // Facing a 3-bet or more: continue tighter, re-raise only the very top.
    if (L.canRaise && !st.allInCall && pct <= 0.02 * m) {
      return { action: 'raise', amount: L.curBet * 2.2 };
    }
    return { action: pct <= callCut(T, m, st) * 0.5 ? 'call' : 'fold' };
  }

  // Legal, canonical form: check is reported as 'call', amounts clamped to the legal range.
  function normalize(choice, L) {
    var a = choice.action;
    if (a === 'raise' && !L.canRaise) a = 'call';
    if (a === 'fold' && L.toCall <= 1e-9) a = 'call';
    if (a === 'check') a = 'call';
    if (a !== 'raise') return { action: a, amount: null };
    // Sizes are rounded to 0.5 BB (the table's money grain) before the legal clamp; the clamp bounds are 0.5 multiples too.
    var amt = Math.round(choice.amount * 2) / 2;
    return { action: 'raise', amount: clamp(amt, L.minRaiseTo, L.maxRaiseTo) };
  }

  /* decide(state, seat, opts) -> { action: 'fold'|'call'|'raise', amount }
   *   state: { scenario, key, legal: { toCall, curBet, minRaiseTo, maxRaiseTo, canRaise, canCheck } }
   *          scenario is an engine Scenario whose isHero seat is the deciding bot; amounts in BB.
   *          key: any value that changes between decisions (combined with seed and seat index).
   *   seat:  { index, looseness, aggression, type? }  (type defaults to the style of the personality)
   *   opts:  { seed }  (a legacy `randomness` option is accepted and ignored)
   * Deterministic: the same state, seat and seed always give the same decision. */
  function decide(state, seat, opts) {
    var o = opts || {};
    var sc = state.scenario, L = state.legal;
    var T = traitsOf(seat);
    var seed = (Number(o.seed) || 0) >>> 0;
    var key = state.key == null ? 0 : state.key;
    var idx = seat.index == null ? 0 : seat.index;
    var rng = makeRng(hashParts(['bot', seed, key, idx]));
    var st = stackState(sc, L);
    var hero = sc.seats.filter(function (s) { return s.isHero; })[0];
    var choice = sc.street === 'preflop'
      ? preflopChoice(sc, hero, L, T, st, rng)
      : equityChoice(sc, L, T, st, rng);
    return normalize(choice, L);
  }

  var api = { decide: decide, PERSONAS: PERSONAS, TYPES: TYPES.slice(), TRAITS: TRAITS, styleOf: styleOf, SHORT_BB: SHORT_BB };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PokerBots = api;
})();
