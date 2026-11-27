/* Neural bots for tables of 2 to 9: the policy networks of ml/train_multi.py (nn-models.json), and the parts shared
 * with the heads-up networks of server/nnbot.js. features() must stay in step with Env.obs() in ml/train_multi.py.
 * Browser: window.PokerNN; load() fetches the networks, until then ready() is false. Node: module.exports. */
(function () {
  'use strict';
  var node = typeof window === 'undefined';
  var E = node ? require('./engine.js') : window.PokerEngine;
  var RANKS = '23456789TJQKA', SUITS = 'shdc', STREETS = ['preflop', 'flop', 'turn', 'river'];
  var SAMPLES = 250;
  var DATA = null, loading = null;

  function bytes(b64) {
    var s = atob(b64), out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return new DataView(out.buffer);
  }
  function half(h) {
    var e = (h >> 10) & 31, m = h & 1023, sign = h & 32768 ? -1 : 1;
    return sign * (e ? Math.pow(2, e - 15) * (1 + m / 1024) : Math.pow(2, -14) * (m / 1024));
  }
  // base64 of little-endian floats, 4 or 2 bytes each.
  function floats(b64, size) {
    var v = bytes(b64), out = new Float32Array(v.byteLength / size);
    for (var i = 0; i < out.length; i++) out[i] = size === 4 ? v.getFloat32(i * 4, true) : half(v.getUint16(i * 2, true));
    return out;
  }
  function parse(json, size) {
    var nets = {};
    json.models.forEach(function (m) {
      nets[m.name] = m.layers.map(function (l) { return { i: l.i, o: l.o, w: floats(l.w, size), b: floats(l.b, size) }; });
    });
    // shortcut: nets not trained yet play as the strongest one there is, until ml/train_multi.py has run to the end.
    var last = nets[json.models[json.models.length - 1].name];
    ['d', 'e'].forEach(function (k) { if (!nets[k]) nets[k] = last; });
    return { preflop: json.preflop, nets: nets };
  }

  function forward(net, x) {
    net.forEach((l, n) => {
      const y = new Array(l.o);
      for (let r = 0; r < l.o; r++) {
        let s = l.b[r];
        for (let c = 0; c < l.i; c++) s += l.w[r * l.i + c] * x[c];
        y[r] = n < net.length - 1 && s < 0 ? 0 : s;
      }
      x = y;
    });
    return x;
  }

  const rankOf = (c) => RANKS.indexOf(c[0]);
  function counts(cards) {
    const r = new Array(13).fill(0), s = [0, 0, 0, 0];
    cards.forEach((c) => { r[rankOf(c)]++; s[SUITS.indexOf(c[1])]++; });
    return { r, s };
  }
  // Most ranks inside any 5-rank window (the ace also counts low).
  function straightWin(r) {
    const a = [r[12]].concat(r).map((n) => (n > 0 ? 1 : 0));
    let best = 0;
    for (let i = 0; i + 5 <= a.length; i++) best = Math.max(best, a[i] + a[i + 1] + a[i + 2] + a[i + 3] + a[i + 4]);
    return best;
  }

  function cardFeatures(hole, board, rng, preflop) {
    const a = rankOf(hole[0]), b = rankOf(hole[1]);
    const hi = Math.max(a, b), lo = Math.min(a, b), suited = hole[0][1] === hole[1][1];
    const eq = board.length ? E.equity(hole, board, 1, { samples: SAMPLES, rng }) : suited ? preflop[hi][lo] : preflop[lo][hi];
    const f = [eq, eq * eq, hi / 12, lo / 12, suited ? 1 : 0, hi === lo ? 1 : 0, (hi - lo) / 12];
    const made = new Array(9).fill(0), ext = new Array(9).fill(0);
    if (board.length) {
      const all = counts(hole.concat(board)), bd = counts(board);
      made[E.evaluateHand(hole.concat(board)).rank] = 1;
      const top = Math.max(...board.map(rankOf));
      ext[0] = Math.max(...bd.r) / 4;
      ext[1] = bd.r.filter((n) => n >= 2).length / 2;
      ext[2] = Math.max(...bd.s) / 5;
      ext[3] = Math.max(...hole.map((c) => all.s[SUITS.indexOf(c[1])])) / 5;
      ext[4] = straightWin(bd.r) / 5;
      ext[5] = straightWin(all.r) / 5;
      ext[6] = top / 12;
      ext[7] = [a, b].filter((r) => r > top).length / 2;
      ext[8] = Math.min(2, all.r.filter((n, r) => n >= 2 && bd.r[r] < n).length) / 2;
    }
    return f.concat(made, ext);
  }

  // Network input and legal-action mask for the seat on turn. L: the legal action of game.js for that seat.
  function features(table, seat, L, rng, preflop) {
    var hand = table.hand, me = hand.seats[seat], bb = hand.bb;
    var st = STREETS.indexOf(hand.street), m = hand.m;
    var opp = hand.seats.filter(function (s) { return s.dealt && !s.folded && s.idx !== seat; });
    var chips = function (s) { return table.seats[s.idx].stack; };
    var pot = hand.seats.reduce(function (n, s) { return n + s.contributed; }, 0) / bb;
    var toCall = Math.min(L.toCall, L.stack) / bb;
    var cover = Math.max.apply(null, opp.map(function (s) { return s.bet + chips(s); }));
    var eff = Math.max(0, Math.min(L.stack, cover - me.bet)) / bb;
    var canAct = opp.filter(function (s) { return chips(s) > 0; });
    var order = function (i) { return (hand.order.indexOf(i) + m - 1) % m; }; // who acts when after the flop: the button last
    var after = canAct.filter(function (s) { return order(s.idx) > order(seat); }).length / Math.max(1, canAct.length);
    var callers = hand.curBet > 0 ? Math.max(0, opp.filter(function (s) { return s.bet >= hand.curBet; }).length - 1) : 0;
    var mine = [0, 0, 0, 0], others = [0, 0, 0, 0], last = -1;
    hand.history.forEach(function (h) {
      if (h.action !== 'raise' && h.action !== 'bet') return;
      (h.seat === seat ? mine : others)[STREETS.indexOf(h.street)]++;
      last = h.seat;
    });
    var nr = mine[st] + others[st];
    var cards = cardFeatures(me.cards, hand.board, rng, preflop);
    var third = function (n) { return Math.min(n, 3) / 3; };
    var x = cards.concat(
      STREETS.map(function (s, i) { return i === st ? 1 : 0; }),
      [hand.order[0] === seat ? 1 : 0, toCall / (pot + toCall), Math.min(toCall / pot, 2) / 2, Math.min(eff / pot, 10) / 10,
        Math.log1p(eff) / 5, Math.log1p(pot) / 5, Math.min(nr, 4) / 4, toCall > 0 ? 1 : 0,
        opp.length / 8, Math.pow(cards[0], opp.length), (opp.length - canAct.length) / 8,
        canAct.filter(function (s) { return !s.acted; }).length / 8, after,
        hand.order[m === 2 ? 0 : 1] === seat ? 1 : 0, hand.order[m === 2 ? 1 : 2] === seat ? 1 : 0, m / 9, callers / 8,
        last === seat ? 1 : 0, me.contributed / bb / pot],
      mine.map(third), others.map(third));
    var sized = L.canRaise && nr < 4;
    return { x: x, mask: [L.toCall > 0, true, sized, sized, L.canRaise] };
  }

  // Action probabilities. temp > 1 flattens them; eps (0 to 1) is the share of moves picked at random among the
  // allowed ones but all-in (random shoves would make weak bots swingy, not weak). Both make a weaker player.
  function probs(net, f, temp, eps) {
    var z = forward(net, f.x).map(function (v, i) { return f.mask[i] ? v / (temp || 1) : -Infinity; });
    var top = Math.max.apply(null, z);
    var e = z.map(function (v) { return Math.exp(v - top); });
    var sum = e.reduce(function (a, b) { return a + b; }, 0);
    var k = eps || 0, n = f.mask.slice(0, 4).filter(Boolean).length;
    return e.map(function (v, i) { return (1 - k) * v / sum + (i < 4 && f.mask[i] ? k / n : 0); });
  }

  // Draws an action and turns it into { action, amount (chips) }.
  function draw(p, table, L, rng) {
    var u = rng(), a = 0;
    while (a < 4 && (u -= p[a]) >= 0) a++;
    while (!p[a]) a--; // rounding at the top of the range
    if (a < 2) return { action: a ? 'call' : 'fold' };
    if (a === 4) return { action: 'raise', amount: L.maxRaiseTo };
    var hand = table.hand, grain = hand.bb / 2;
    var pot = hand.seats.reduce(function (n, s) { return n + s.contributed; }, 0);
    var to = Math.round((L.curBet + (a === 2 ? 0.5 : 1) * (pot + L.toCall)) / grain) * grain;
    return { action: 'raise', amount: Math.max(L.minRaiseTo, Math.min(to, L.maxRaiseTo)) };
  }

  function decide(table, seat, L, net, temp, rng, eps) {
    rng = rng || Math.random;
    var d = data();
    return draw(probs(d.nets[net], features(table, seat, L, rng, d.preflop), temp, eps), table, L, rng);
  }

  function data() {
    if (!DATA && node) DATA = parse(require('./nn-models.json'), 2);
    return DATA;
  }
  function ready() { return !!data(); }
  // Browser: fetches the networks once. A failed download is tried again on the next call.
  function load() {
    if (DATA) return Promise.resolve();
    loading = loading || fetch('nn-models.json').then(function (r) {
      if (!r.ok) throw new Error('nn-models.json: ' + r.status);
      return r.json();
    }).then(function (j) { DATA = parse(j, 2); }).catch(function (e) { loading = null; throw e; });
    return loading;
  }

  var api = { load: load, ready: ready, decide: decide, features: features, data: data,
    parse: parse, cardFeatures: cardFeatures, probs: probs, draw: draw };
  if (!node) window.PokerNN = api;
  else module.exports = api;
})();
