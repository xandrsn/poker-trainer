/* Poker Trainer game flow for "vs CPU" play: deal from a shuffled deck, action order,
 * min-raise rules, all-in handling, side pots and showdown. Chips are integers
 * (1 BB = 100 chips, SB = 50). Scenarios handed to the engine are in BB.
 * Browser: window.PokerGame. Node: module.exports. */
(function () {
  'use strict';

  var E = (typeof window !== 'undefined' && window.PokerEngine) || require('./engine.js');
  var Bots = (typeof window !== 'undefined' && window.PokerBots) || require('./bots.js');

  var BB = 100, SB = 50;
  var RANKS = '23456789TJQKA', SUITS = 'shdc';
  var POS = E.POSITIONS;

  // ------------------------------------------------------------------ utils
  function mulberry(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function fullDeck() {
    var d = [];
    for (var r = 0; r < 13; r++) for (var s = 0; s < 4; s++) d.push(RANKS[r] + SUITS[s]);
    return d;
  }
  function clampNum(x, a, b) { return Math.max(a, Math.min(b, x)); }
  // bb: the table's big blind in chips (solo tables use BB; multiplayer tables may differ).
  function bbOf(chips, bb) { return Math.round(chips) / (bb || BB); }
  function fmtChips(chips, bb) { return String(Math.round(chips) / (bb || BB)); }
  // Money granularity: every amount is a whole multiple of half a big blind (0.5 BB) of the current
  // level. Chips: 1 BB = 100 chips at the base level, so the grain is cfg.bb / 2 (50 chips at base).
  function snapChips(chips, grain) { return Math.round(chips / grain) * grain; }
  // Starting stack in BB: default 100, min 5, max 1000, step 0.5, never negative or NaN.
  var STACK_DEFAULT = 100, STACK_MIN = 5, STACK_MAX = 1000;
  function validStackBB(x) {
    var v = Number(x);
    if (x === '' || x == null || !isFinite(v)) return STACK_DEFAULT;
    return clampNum(Math.round(v * 2) / 2, STACK_MIN, STACK_MAX);
  }
  // Elimination, checked between hands only: fewer than 1 BB left (BB of the current level).
  // During a hand an all-in player may sit at 0 and keep playing.
  function isEliminated(stackBB) { return !(Number(stackBB) >= 1); }
  // Marks seats with less than 1 BB as busted (eliminated); they are never dealt in again.
  function markEliminated(session, bb) {
    session.seats.forEach(function (s) {
      if (!s.busted && isEliminated(bbOf(s.stack, bb))) s.busted = true;
    });
  }
  // Blind level change (progressive blinds / doubling), applied between hands. Each stack is floored to a
  // whole half-BB of the new level; the chips left over (under half a new BB per seat) go to session.bank,
  // because a leftover cannot be split into 0.5 BB multiples without breaking the grain. totalChips counts
  // the bank, so chips are conserved exactly.
  function rebaseLevel(session, newBB) {
    var grain = newBB / 2, residue = 0;
    session.seats.forEach(function (s) {
      var keep = Math.floor(s.stack / grain) * grain;
      residue += s.stack - keep;
      s.stack = keep;
    });
    session.bank = (session.bank || 0) + residue;
    session.levelBB = newBB;
  }
  // Enabled personality types. Accepts an array of names (unknown names ignored, never empty),
  // or the legacy booleans: true = all types, false = balanced only.
  function enabledTypes(o) {
    var all = Bots.TYPES;
    if (o === false) return ['balanced'];
    if (!Array.isArray(o)) return all.slice();
    var out = all.filter(function (t) { return o.indexOf(t) >= 0; });
    return out.length ? out : ['balanced'];
  }
  function pickPersona(rng, types) {
    var name = types[Math.floor(rng() * types.length)];
    var p = Bots.PERSONAS.filter(function (x) { return x.type === name; })[0];
    return { name: p.name, type: p.type, looseness: p.looseness, aggression: p.aggression };
  }
  // Starting stack of one seat in BB. 'equal': stackBB. 'varied': random between 0.5x and 2x
  // (half-BB steps). 'custom': customStacks[seat] (BB) with stackBB as the fallback.
  function seatStackBB(mode, i, stackBB, custom, rng) {
    if (mode === 'varied') return Math.max(1, Math.round((stackBB * (0.5 + rng() * 1.5)) * 2) / 2);
    if (mode === 'custom') {
      var x = custom && custom[i] != null ? Number(custom[i]) : NaN;
      return isFinite(x) && x > 0 ? validStackBB(x) : stackBB;
    }
    return stackBB;
  }

  // --------------------------------------------------------------- session
  function newSession(o) {
    o = o || {};
    var cpus = Math.round(clampNum(Number(o.cpus) || 8, 1, 8));
    // Money off: very deep stacks internally, so nobody is meaningfully all-in.
    var money = o.money !== false;
    var stackBB = money ? validStackBB(o.stackBB) : 1000;
    // Money off: every seat is equal and very deep, so nobody is meaningfully all-in.
    var stacks = money && ['equal', 'varied', 'custom'].indexOf(o.stacks) >= 0 ? o.stacks : 'equal';
    var types = enabledTypes(o.personalities);
    var seed = (o.seed != null && isFinite(Number(o.seed)))
      ? (Number(o.seed) >>> 0)
      : (Math.floor(Math.random() * 4294967296) >>> 0);
    var rng = mulberry(seed);
    var seats = [];
    for (var i = 0; i <= cpus; i++) {
      var isHero = i === 0;
      var bbStack = seatStackBB(stacks, i, stackBB, o.customStacks, rng);
      seats.push({
        idx: i,
        name: isHero ? 'Hero' : 'CPU ' + i,
        isHero: isHero,
        isBot: isHero ? !!o.allBots : true,
        stack: Math.round(bbStack * BB),
        busted: false,
        persona: (isHero && !o.allBots) ? null : pickPersona(rng, types),
      });
    }
    return {
      cfg: { cpus: cpus, stackBB: stackBB, stacks: stacks, seed: seed, allBots: !!o.allBots,
        money: money, personalities: types, noWalkover: !!o.noWalkover },
      rng: rng,
      seats: seats,
      btnIdx: -1,
      handNo: 0,
      hand: null,
      levelBB: BB, // BB (chips) the stacks are currently expressed in; see rebaseLevel
      bank: 0,     // chips rounded off by a level change (never on a seat)
      over: null, // 'busted' | 'won' once the session has ended
    };
  }

  // ------------------------------------------------------------- positions
  function needsAction(hs, curBet) {
    return hs.dealt && !hs.folded && !hs.allIn && (!hs.acted || hs.bet < curBet);
  }
  function firstActor(hand, start) {
    for (var j = 0; j < hand.m; j++) {
      var idx = hand.order[(start + j) % hand.m];
      if (needsAction(hand.seats[idx], hand.curBet)) return idx;
    }
    return null;
  }
  function nextActorAfter(hand, idx) {
    var p = hand.order.indexOf(idx);
    for (var j = 1; j <= hand.m; j++) {
      var cand = hand.order[(p + j) % hand.m];
      if (needsAction(hand.seats[cand], hand.curBet)) return cand;
    }
    return null;
  }
  function roundComplete(hand) {
    return hand.order.every(function (idx) {
      var hs = hand.seats[idx];
      if (hs.folded || hs.allIn) return true;
      return hs.acted && hs.bet === hand.curBet;
    });
  }

  // ---------------------------------------------------------------- betting
  function pay(session, hand, idx, amount) {
    var hs = hand.seats[idx], seat = session.seats[idx];
    var p = Math.max(0, Math.min(amount, seat.stack));
    seat.stack -= p;
    hs.bet += p;
    hs.contributed += p;
    if (seat.stack === 0) hs.allIn = true;
    return p;
  }
  // Largest total (this street) that any other live opponent could still call: a bet above it is
  // pointless because the excess would come straight back. Folded seats are excluded.
  function effectiveCap(session, hand, idx) {
    var cap = 0;
    hand.order.forEach(function (j) {
      if (j === idx) return;
      var h = hand.seats[j];
      if (!h || !h.dealt || h.folded) return;
      cap = Math.max(cap, h.bet + session.seats[j].stack);
    });
    return cap;
  }
  function legalFor(session, hand, idx) {
    var hs = hand.seats[idx];
    var stack = session.seats[idx].stack;
    var toCall = Math.max(0, hand.curBet - hs.bet);
    var maxTo = Math.min(hs.bet + stack, effectiveCap(session, hand, idx));
    var canRaise = !!hs.raiseAllowed && stack > toCall && maxTo > hand.curBet;
    var minTo = Math.min(hand.curBet + hand.lastRaise, maxTo);
    return {
      toCall: toCall,
      canCheck: toCall === 0,
      canRaise: canRaise,
      minRaiseTo: minTo,
      maxRaiseTo: maxTo,
      curBet: hand.curBet,
      myBet: hs.bet,
      stack: stack,
    };
  }
  function who(session, hand, idx) {
    var s = session.seats[idx];
    var nm = s.isHero ? 'Hero' : s.name;
    var pos = hand.seats[idx].pos;
    return pos ? nm + ' (' + pos + ')' : nm;
  }
  function allInTag(session, idx) {
    return session.seats[idx].stack === 0 ? ' (all-in)' : '';
  }

  function act(session, idx, action, amount) {
    var hand = session.hand;
    if (!hand || hand.over) throw new Error('no hand in progress');
    if (hand.toAct !== idx) throw new Error('seat ' + idx + ' is not to act');
    var hs = hand.seats[idx];
    // Human decisions keep the engine scenario as it was before the action (for later grading).
    var rec = session.seats[idx].isBot ? null : buildScenario(session, idx);
    var L = legalFor(session, hand, idx);
    var text, outAmount = null, paid = 0;
    var potBefore = hand.seats.reduce(function (a, h) { return a + h.contributed; }, 0);
    var curBefore = hand.curBet;
    if (action === 'fold') {
      hs.folded = true;
      text = 'folds';
    } else if (action === 'call') {
      if (L.toCall <= 0) {
        text = 'checks';
        if (hand.street === 'preflop') hs.role = 'bb_check';
      } else {
        paid = pay(session, hand, idx, L.toCall);
        if (hand.street === 'preflop') {
          var lim = hand.raisesRound;
          hs.role = lim === 0 ? 'limp' : lim === 1 ? 'call_open' : lim === 2 ? 'call_3bet' : 'call_4bet';
        }
        var limped = hand.street === 'preflop' && hand.raisesRound === 0;
        text = (limped ? 'limps' : 'calls ' + fmtChips(paid, hand.bb) + ' BB') + allInTag(session, idx);
      }
    } else if (action === 'raise') {
      if (!L.canRaise) throw new Error('raise not allowed for seat ' + idx);
      if (amount == null) amount = standardRaiseTo(L, hand.seats.reduce(function (a, h) { return a + h.contributed; }, 0), hand.street === 'preflop', hand.bb);
      // Bounds are checked on the amount as sent, before snapping to the 0.5 BB grain: snapping must
      // never turn a too-small or too-large request into a legal one. An amount at the stack is an all-in.
      if (amount < L.minRaiseTo && amount < L.maxRaiseTo) throw new Error('raise below the minimum');
      if (amount > L.maxRaiseTo) throw new Error('raise exceeds stack');
      var R = amount >= L.maxRaiseTo ? L.maxRaiseTo : snapChips(amount, hand.bb / 2);
      if (R > L.maxRaiseTo) R = L.maxRaiseTo;
      if (R < L.minRaiseTo && R < L.maxRaiseTo) R = L.minRaiseTo;
      if (!(R > hand.curBet)) throw new Error('raise must exceed the current bet');
      var prevCur = hand.curBet;
      paid = pay(session, hand, idx, R - hs.bet);
      var inc = R - prevCur;
      var full = inc >= hand.lastRaise;
      hand.curBet = R;
      if (full) hand.lastRaise = inc;
      hand.lastRaiseSize = inc; // size of the latest raise on this street (for the scenario)
      if (hand.street === 'preflop') {
        hs.role = hand.raisesRound === 0 ? 'open' : hand.raisesRound === 1 ? '3bet' : '4bet';
      }
      hand.raisesRound++;
      hs.raiseAllowed = false;
      hand.order.forEach(function (j) {
        if (j === idx) return;
        var o = hand.seats[j];
        if (o.dealt && !o.folded && !o.allIn) {
          o.acted = false;               // must respond to the new bet
          if (full) o.raiseAllowed = true; // only a full raise reopens raising
        }
      });
      outAmount = R;
      text = (prevCur === 0 ? 'bets ' : 'raises to ') + fmtChips(R, hand.bb) + ' BB' + allInTag(session, idx);
    } else {
      throw new Error('unknown action ' + action);
    }
    // Action history for the whole hand (survives street changes). Amounts in BB; 'put' is what this
    // action added to the pot; betFraction = size of a bet/raise relative to the pot after the call.
    var kind = action === 'fold' ? 'fold'
      : action === 'call' ? (L.toCall > 0 ? (hand.street === 'preflop' && hand.raisesRound === 0 ? 'limp' : 'call') : 'check')
      : (curBefore === 0 ? 'bet' : 'raise');
    var betFrac = 0;
    if (kind === 'bet' || kind === 'raise') {
      var potAfterCall = potBefore + L.toCall;
      betFrac = potAfterCall > 0 ? (paid - L.toCall) / potAfterCall : 0;
    }
    hand.history.push({
      street: hand.street, seat: idx, action: kind,
      amount: bbOf(kind === 'raise' || kind === 'bet' ? outAmount : paid, hand.bb),
      potBefore: bbOf(potBefore, hand.bb), betFraction: Math.round(betFrac * 1000) / 1000,
      put: bbOf(paid, hand.bb)
    });
    if (rec) {
      hand.heroDecisions.push({
        handIndex: hand.no,
        street: hand.street,
        scenario: rec,
        action: action === 'raise' ? 'raise' : action === 'fold' ? 'fold' : 'call', // call also = check
        raiseAmount: action === 'raise' ? bbOf(outAmount, hand.bb) : null,
      });
    }
    hs.acted = true;
    hs.lastAction = text;
    hand.actions++;
    hand.log.push(who(session, hand, idx) + ' ' + text);
    hand.toAct = nextActorAfter(hand, idx);
    settle(session);
    return {
      seat: idx,
      name: session.seats[idx].isHero ? 'Hero' : session.seats[idx].name,
      action: action,
      amount: action === 'raise' ? outAmount : (paid || null),
      text: text,
    };
  }

  // ----------------------------------------------------------- street flow
  // Deals the next board cards (flop, then turn, then river) and logs them.
  function dealNextCards(hand) {
    var n = hand.board.length === 0 ? 3 : 1;
    hand.street = hand.board.length === 0 ? 'flop' : hand.board.length === 3 ? 'turn' : 'river';
    // the chips show the current street only: clear the old action here too (run-outs skip nextStreet)
    hand.seats.forEach(function (hs) { if (hs.dealt && !hs.folded) hs.lastAction = 'pending'; });
    for (var i = 0; i < n; i++) hand.board.push(hand.deck.pop());
    var label = hand.street.charAt(0).toUpperCase() + hand.street.slice(1);
    hand.log.push('--- ' + label + ': ' + hand.board.join(' ') + ' ---');
  }
  // Starts the next betting round.
  function nextStreet(session) {
    var hand = session.hand;
    dealNextCards(hand);
    hand.seats.forEach(function (hs) {
      hs.bet = 0;
      hs.acted = false;
      hs.raiseAllowed = true;
      // a new street clears the previous street's action: the chip shows only the current street's action
      if (hs.dealt && !hs.folded) hs.lastAction = 'pending';
    });
    hand.curBet = 0;
    hand.lastRaise = hand.bb;
    hand.lastRaiseSize = null;
    hand.raisesRound = 0;
    hand.toAct = firstActor(hand, 1);
  }
  function settle(session) {
    var hand = session.hand;
    var live = hand.order.filter(function (idx) { return !hand.seats[idx].folded; });
    if (live.length === 1) { finishHand(session, true); return; }
    if (!roundComplete(hand)) return;
    var active = hand.order.filter(function (idx) {
      var hs = hand.seats[idx];
      return !hs.folded && !hs.allIn;
    });
    if (hand.street === 'river' || active.length <= 1) {
      // Nobody can bet any more: run out the remaining board and go to showdown.
      while (hand.board.length < 5) dealNextCards(hand);
      finishHand(session, false);
      return;
    }
    nextStreet(session);
  }

  // ----------------------------------------------------------- side pots
  // entries: [{idx, contributed, folded}] -> [{amount, eligible: [idx]}] (ordered by level).
  function buildPots(entries) {
    var levels = [];
    entries.forEach(function (e) {
      if (e.contributed > 0 && levels.indexOf(e.contributed) < 0) levels.push(e.contributed);
    });
    levels.sort(function (a, b) { return a - b; });
    var pots = [], prev = 0;
    levels.forEach(function (L) {
      var amount = 0;
      entries.forEach(function (e) { amount += Math.max(0, Math.min(e.contributed, L) - prev); });
      var elig = entries.filter(function (e) { return !e.folded && e.contributed >= L; }).map(function (e) { return e.idx; });
      if (!elig.length) elig = entries.filter(function (e) { return e.contributed >= L; }).map(function (e) { return e.idx; });
      if (amount > 0) {
        var last = pots[pots.length - 1];
        if (last && last.eligible.join(',') === elig.join(',')) last.amount += amount;
        else pots.push({ amount: amount, eligible: elig });
      }
      prev = L;
    });
    return pots;
  }

  function finishHand(session, uncontested) {
    var hand = session.hand;
    var live = hand.order.filter(function (idx) { return !hand.seats[idx].folded; });
    var lines = [];
    var handNames = {};
    if (!uncontested) {
      live.forEach(function (idx) {
        var hs = hand.seats[idx];
        var r = E.evaluateHand(hs.cards.concat(hand.board));
        hs.reveal = true;
        hs.handName = r.name;
        hs.score = r.score;
        handNames[idx] = r.name;
        lines.push((session.seats[idx].isHero ? 'Hero' : session.seats[idx].name) + ' shows ' +
          hs.cards.join(' ') + ' – ' + r.name);
      });
    }
    var pots = buildPots(hand.order.map(function (idx) {
      var hs = hand.seats[idx];
      return { idx: idx, contributed: hs.contributed, folded: hs.folded };
    }));
    var wins = {};
    var potInfo = pots.map(function (pot) {
      var liveElig = pot.eligible.filter(function (idx) { return !hand.seats[idx].folded; });
      var winners;
      if (!liveElig.length) winners = pot.eligible.slice();
      else if (liveElig.length === 1) winners = liveElig;
      else {
        var best = -Infinity;
        liveElig.forEach(function (idx) { best = Math.max(best, hand.seats[idx].score); });
        winners = liveElig.filter(function (idx) { return hand.seats[idx].score === best; });
      }
      // Odd half-BB units go to the winner first clockwise after the button (the SB side first).
      var sbRank = function (idx) { return (hand.order.indexOf(idx) + hand.m - 1) % hand.m; };
      winners = winners.slice().sort(function (a, b) { return sbRank(a) - sbRank(b); });
      var grain = hand.bb / 2;
      var units = Math.round(pot.amount / grain);
      var share = Math.floor(units / winners.length);
      var rem = units - share * winners.length;
      winners.forEach(function (idx, j) {
        var amt = (share + (j < rem ? 1 : 0)) * grain;
        session.seats[idx].stack += amt;
        wins[idx] = (wins[idx] || 0) + amt;
      });
      return { amount: pot.amount, eligible: pot.eligible.slice(), winners: winners };
    });
    Object.keys(wins).forEach(function (k) {
      var idx = Number(k);
      var nm = session.seats[idx].isHero ? 'Hero' : session.seats[idx].name;
      var line = nm + ' wins ' + fmtChips(wins[idx], hand.bb) + ' BB';
      if (uncontested) line += ' uncontested';
      else if (handNames[idx]) line += ' with ' + handNames[idx];
      lines.push(line);
    });
    hand.log.push('Hand #' + hand.no + ' complete');
    lines.forEach(function (l) { hand.log.push(l); });

    markEliminated(session, hand.bb); // between hands: under 1 BB is eliminated
    hand.over = true;
    hand.toAct = null;
    hand.results = {
      showdown: !uncontested,
      heroDecisions: hand.heroDecisions,
      pots: potInfo,
      wins: wins,
      heroWon: wins[0] || 0,
      heroNet: (wins[0] || 0) - hand.seats[0].contributed,
      handNames: handNames,
      lines: lines,
    };
    if (session.table) return; // multiplayer tables: the server decides when a table is over
    var hero = session.seats[0];
    if (hero.busted) session.over = 'busted';
    else if (session.seats.every(function (s, i) { return i === 0 || s.busted; })) session.over = 'won';
  }

  // ---------------------------------------------------------------- hands
  // Seats dealt into this hand: the hero plus (players - 1) random live CPUs.
  // Without `players`, every live CPU plays.
  function pickActive(session, players) {
    var n = session.seats.length;
    var cpus = [];
    for (var j = 1; j < n; j++) if (!session.seats[j].busted) cpus.push(j);
    var want = players == null ? cpus.length : Math.max(1, Math.min(8, Math.round(players) - 1));
    shuffle(cpus, session.rng);
    return [0].concat(cpus.slice(0, want)).sort(function (a, b) { return a - b; });
  }
  // Seats in clockwise order starting at the button.
  function orderFrom(active, btn, n) {
    var out = [];
    for (var k = 0; k < n; k++) {
      var s = (btn + k) % n;
      if (active.indexOf(s) >= 0) out.push(s);
    }
    return out;
  }
  // opts: { players?: 2..9, heroPosition?: 'BTN' ... } (both optional).
  // Multiplayer: opts.active = [seat, ...] names the seats dealt in (those with chips); the solo
  // busted/over bookkeeping is then skipped.
  function startHand(session, opts) {
    opts = opts || {};
    var i = 0;
    if (session.over) return null;
    var n = session.seats.length;
    var bb = session.cfg.bb || BB, sb = session.cfg.sb || SB;
    if (bb !== session.levelBB) rebaseLevel(session, bb);
    markEliminated(session, bb);
    var active;
    if (opts.active) {
      active = opts.active.filter(function (s) {
        return session.seats[s] && session.seats[s].stack > 0 && !isEliminated(bbOf(session.seats[s].stack, bb));
      })
        .sort(function (a, b) { return a - b; });
      if (active.length < 2) return null;
    } else {
      if (session.seats[0].busted) { session.over = 'busted'; return null; }
      var alive = session.seats.filter(function (s) { return !s.busted; });
      if (alive.length < 2) { session.over = 'won'; return null; }
      active = pickActive(session, opts.players);
      if (active.length < 2) { session.over = 'won'; return null; }
    }

    var prev = session.btnIdx >= 0 ? session.btnIdx : n - 1;
    var cands = [];
    for (var k = 1; k <= n; k++) {
      var c = (prev + k) % n;
      if (active.indexOf(c) >= 0) cands.push(c);
    }
    var m0 = active.length;
    var btn = cands[0];
    if (opts.heroPosition && POS[m0] && POS[m0].indexOf(opts.heroPosition) >= 0) {
      var bp = POS[m0].indexOf('BTN');
      for (var q = 0; q < cands.length; q++) {
        var ord = orderFrom(active, cands[q], n);
        if (POS[m0][(bp + ord.indexOf(0)) % m0] === opts.heroPosition) { btn = cands[q]; break; }
      }
    }
    session.btnIdx = btn;

    var order = orderFrom(active, btn, n);
    var m = order.length;
    var table = POS[m];
    var btnPos = table.indexOf('BTN');

    var hand = {
      no: ++session.handNo,
      btnIdx: btn,
      order: order,
      m: m,
      street: 'preflop',
      board: [],
      deck: shuffle(fullDeck(), session.rng),
      curBet: bb,
      lastRaise: bb,
      lastRaiseSize: null,
      bb: bb,
      sb: sb,
      raisesRound: 0,
      toAct: null,
      actions: 0,
      log: [],
      history: [],
      heroDecisions: [],
      over: false,
      results: null,
      seats: [],
    };
    for (i = 0; i < n; i++) {
      hand.seats.push({
        idx: i, dealt: false, cards: [], pos: null, bet: 0, contributed: 0,
        folded: true, allIn: false, acted: false, raiseAllowed: true,
        lastAction: '', role: null, reveal: false, handName: null, score: null,
      });
    }
    order.forEach(function (idx, j) {
      var hs = hand.seats[idx];
      hs.dealt = true;
      hs.folded = false;
      hs.pos = table[(btnPos + j) % m];
      hs.lastAction = 'pending';
    });
    for (var c = 0; c < 2; c++) {
      order.forEach(function (idx) { hand.seats[idx].cards.push(hand.deck.pop()); });
    }
    session.hand = hand;

    var sbIdx = m === 2 ? order[0] : order[1];
    var bbIdx = m === 2 ? order[1] : order[2];
    pay(session, hand, sbIdx, sb);
    pay(session, hand, bbIdx, bb);
    hand.curBet = Math.max(hand.seats[sbIdx].bet, hand.seats[bbIdx].bet);
    hand.log.push('--- Hand #' + hand.no + ' ---');
    hand.log.push('Blinds: ' + who(session, hand, sbIdx) + ' ' + fmtChips(sb, bb) + ' BB, ' + who(session, hand, bbIdx) + ' ' + fmtChips(bb, bb) + ' BB');

    hand.toAct = firstActor(hand, m === 2 ? 0 : 3 % m);
    settle(session);
    return hand;
  }

  function isHandOver(session) {
    return !session.hand || session.hand.over;
  }
  function toAct(session) {
    return session.hand && !session.hand.over ? session.hand.toAct : null;
  }
  function results(session) {
    return session.hand && session.hand.over ? session.hand.results : null;
  }
  function totalChips(session) {
    var t = session.seats.reduce(function (a, s) { return a + s.stack; }, 0) + (session.bank || 0);
    if (session.hand && !session.hand.over) {
      t += session.hand.seats.reduce(function (a, hs) { return a + hs.contributed; }, 0);
    }
    return t;
  }

  // ------------------------------------------------------------ scenarios
  // The hero's single raise size (no size choice in the UI): preflop 2.5 BB when unopened, else 3x the
  // current bet; postflop 2/3 pot. Clamped to the legal range, so an all-in is only used when it is the cap.
  function standardRaiseTo(L, potChips, preflop, bb) {
    if (!L.canRaise) return null;
    bb = bb || BB;
    var target = preflop
      ? (L.curBet > 0 ? L.curBet * 3 : 2.5 * bb)
      : L.curBet + (2 / 3) * (potChips + L.toCall);
    var step = bb / 2; // rounding grain: half a big blind
    return Math.max(L.minRaiseTo, Math.min(Math.round(target / step) * step, L.maxRaiseTo));
  }
  function situationText(hand, hero) {
    var hd = hand.m === 2 ? 'heads-up' : hand.m + '-handed';
    var pos = hero.pos || '';
    if (hand.street === 'preflop') {
      var limped = hand.seats.some(function (s) { return s.role === 'limp'; });
      var f = hand.raisesRound === 0 ? (limped ? 'Limped pot' : 'Unopened pot')
        : hand.raisesRound === 1 ? 'Facing a raise'
        : hand.raisesRound === 2 ? 'Facing a 3-bet' : 'Facing a 4-bet';
      return f + ', ' + pos + ', ' + hd;
    }
    return (hand.curBet > 0 ? 'Facing a bet' : 'Checked to you') + ' on the ' + hand.street + ', ' + pos + ', ' + hd;
  }

  // Engine-compatible Scenario (amounts in BB) seen from seat forIdx.
  function buildScenario(session, forIdx) {
    var hand = session.hand;
    if (!hand) return null;
    var hs = hand.seats[forIdx];
    var m = hand.m;
    var bb = hand.bb;
    var live = hand.order.filter(function (j) { return !hand.seats[j].folded; });
    var potChips = hand.seats.reduce(function (a, h) { return a + h.contributed; }, 0);
    function postRank(j) { var off = hand.order.indexOf(j); return off === 0 ? m : off; }
    var inPos = hs.dealt && live.every(function (j) { return j === forIdx || postRank(forIdx) > postRank(j); });
    var L = hs.dealt ? legalFor(session, hand, forIdx) : null;
    var seatsOut = session.seats.map(function (s, i) {
      var h = hand.seats[i];
      return {
        seat: i,
        position: h.dealt ? h.pos : null,
        name: s.isHero ? 'Hero' : s.name,
        stack: bbOf(s.stack, bb),
        bet: bbOf(h.bet, bb),
        contributed: bbOf(h.contributed, bb),
        folded: !h.dealt || h.folded,
        busted: !h.dealt,
        isHero: i === forIdx,
        style: s.persona ? Bots.styleOf(s.persona) : 'balanced',
        lastAction: !h.dealt ? 'busted' : (h.lastAction === 'pending' ? '' : h.lastAction),
        preflopRole: h.role || null,
        reveal: h.reveal ? h.cards.slice() : null,
      };
    });
    seatsOut = seatsOut.filter(function (x) { return !x.busted; }); // only seats dealt into this hand
    // heroCovered: some live opponent has more chips in total (stack + street bet) than the seat.
    var heroTotal = session.seats[forIdx].stack + hs.contributed;
    var heroCovered = hand.order.some(function (j) {
      return j !== forIdx && !hand.seats[j].folded && (session.seats[j].stack + hand.seats[j].contributed) > heroTotal;
    });
    var toActNow = hand.toAct === forIdx && !hand.over;
    return {
      id: 'cpu-' + hand.no + '-' + hand.actions,
      numPlayers: m,
      street: hand.street,
      hero: hs.cards.slice(),
      board: hand.board.slice(),
      blinds: { sb: hand.sb / bb, bb: 1 },
      pot: bbOf(potChips, bb),
      toCall: L ? bbOf(Math.min(L.toCall, session.seats[forIdx].stack), bb) : 0, // capped at the hero stack
      heroStack: bbOf(session.seats[forIdx].stack, bb),
      heroCovered: heroCovered,
      // Size (BB) of the last raise on this street; undefined while nobody has raised yet.
      lastRaise: hand.lastRaiseSize == null ? undefined : bbOf(hand.lastRaiseSize, bb),
      heroPosition: hs.pos || '',
      heroSeat: forIdx,
      buttonSeat: hand.btnIdx,
      inPosition: inPos,
      seats: seatsOut,
      actionLog: hand.log.slice(),
      history: (hand.history || []).map(function (e) { return Object.assign({}, e); }),
      raiseOptions: [],
      standardRaise: toActNow && L && standardRaiseTo(L, potChips, hand.street === 'preflop', bb) != null ? bbOf(standardRaiseTo(L, potChips, hand.street === 'preflop', bb), bb) : null,
      situation: situationText(hand, hs),
      heroToAct: toActNow,
    };
  }

  // True when this seat's fold would leave the hero as the only player still in the hand.
  function wouldWalkover(hand, idx) {
    var live = hand.seats.filter(function (h, j) { return j !== idx && h.dealt && !h.folded; });
    return live.length === 1 && live[0] === hand.seats[0] && !hand.seats[0].folded;
  }
  // Bot turn: decide with PokerBots, apply the result, return the event.
  function stepBot(session) {
    var hand = session.hand;
    if (!hand || hand.over) throw new Error('no hand in progress');
    var idx = hand.toAct;
    if (idx == null) throw new Error('no seat is to act');
    var seat = session.seats[idx];
    if (!seat.isBot) throw new Error('seat ' + idx + ' is not a bot');
    var L = legalFor(session, hand, idx);
    var sc = buildScenario(session, idx);
    var d = Bots.decide({
      scenario: sc,
      key: hand.no + ':' + hand.actions,
      legal: {
        toCall: bbOf(L.toCall, hand.bb), curBet: bbOf(L.curBet, hand.bb),
        minRaiseTo: bbOf(L.minRaiseTo, hand.bb), maxRaiseTo: bbOf(L.maxRaiseTo, hand.bb),
        canRaise: L.canRaise, canCheck: L.canCheck,
      },
    }, { index: idx, type: seat.persona.type, looseness: seat.persona.looseness, aggression: seat.persona.aggression },
    { seed: session.cfg.seed });
    var action = d.action, amount = null;
    if (action === 'raise') {
      if (!L.canRaise) action = 'call';
      else amount = clampNum(snapChips(d.amount * hand.bb, hand.bb / 2), L.minRaiseTo, L.maxRaiseTo);
    }
    // noWalkover (solo): the last opponent never folds an uncontested pot. Aggressive and loose
    // types complete or raise instead, the others call; the hero always gets a real decision.
    if (action === 'fold' && session.cfg.noWalkover && wouldWalkover(hand, idx)) {
      var sty = Bots.styleOf(seat.persona);
      if (L.canRaise && (sty === 'aggressive' || sty === 'loose')) {
        action = 'raise';
        var potChips = hand.seats.reduce(function (a, h) { return a + h.contributed; }, 0);
        amount = standardRaiseTo(L, potChips, hand.street === 'preflop', hand.bb);
      } else {
        action = 'call';
      }
    }
    return act(session, idx, action, amount);
  }

  // Multiplayer table: `maxSeats` empty seats (the server seats players and bots, sets stack/isBot/persona).
  // o: { bb, sb (chips), seed, personalities (type names; legacy boolean accepted) }. `randomness` is ignored.
  function newTable(o) {
    o = o || {};
    var bb = Math.round(Number(o.bb)) || BB;
    var sb = Math.round(Number(o.sb)) || SB;
    var seed = (o.seed != null && isFinite(Number(o.seed)))
      ? (Number(o.seed) >>> 0)
      : (Math.floor(Math.random() * 4294967296) >>> 0);
    var seats = [];
    for (var i = 0; i < (o.maxSeats || 9); i++) {
      seats.push({ idx: i, name: '', isHero: false, isBot: false, stack: 0, busted: true, persona: null });
    }
    return {
      cfg: { bb: bb, sb: sb, seed: seed, personalities: enabledTypes(o.personalities) },
      rng: mulberry(seed),
      seats: seats,
      btnIdx: -1,
      handNo: 0,
      hand: null,
      over: null,
      table: true,
      levelBB: bb,
      bank: 0,
    };
  }

  var api = {
    BB: BB,
    SB: SB,
    newSession: newSession,
    newTable: newTable,
    validStackBB: validStackBB,
    isEliminated: isEliminated,
    markEliminated: markEliminated,
    setBlindLevel: function (session, bb) { rebaseLevel(session, bb); },
    STACK_DEFAULT: STACK_DEFAULT, STACK_MIN: STACK_MIN, STACK_MAX: STACK_MAX,
    startHand: startHand,
    act: act,
    stepBot: stepBot,
    legal: function (session, idx) {
      if (!session.hand || session.hand.over) return null;
      return legalFor(session, session.hand, idx);
    },
    toAct: toAct,
    isHandOver: isHandOver,
    results: results,
    buildScenario: buildScenario,
    buildPots: buildPots,
    totalChips: totalChips,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PokerGame = api;
})();
