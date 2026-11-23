/* Progress statistics. Pure functions only (no DOM, no storage).
 * Browser: window.PokerStats. Node: module.exports.
 *
 * Records:
 *   decision: { t, mode: 'practice'|'exam', format: 'full'|'quick', position, street, players, score (0-100), best, chosen }
 *   session:  { t, mode, format, n (decisions), avg (0-100) }
 *   hand:     { t, mode, format, net (BB, + won / - lost) }
 */
(function () {
  'use strict';

  var POSITION_ORDER = ['UTG', 'UTG+1', 'UTG+2', 'MP', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
  var STREET_ORDER = ['preflop', 'flop', 'turn', 'river'];
  var GOOD_SCORE = 75;     // best or good rating (matches the 75-100 score bar)
  var MIN_SAMPLES = 5;     // weakest-spot suggestions need this many decisions

  function num(x) { var v = Number(x); return isFinite(v) ? v : 0; }
  function mean(xs) { return xs.length ? xs.reduce(function (a, b) { return a + b; }, 0) / xs.length : null; }
  function round1(x) { return x == null ? null : Math.round(x * 10) / 10; }

  // 'all' (default), 'practice' or 'exam'.
  function filterBy(list, filter) {
    if (!filter || filter === 'all') return list.slice();
    return list.filter(function (r) { return r && r.mode === filter; });
  }

  function averageScore(decisions) {
    return round1(mean(decisions.map(function (d) { return num(d.score); })));
  }

  // Last 10 sessions against the 10 before them.
  function trend(sessions) {
    var all = sessions.slice().sort(function (a, b) { return num(a.t) - num(b.t); });
    var cur = all.slice(-10);
    var prev = all.slice(-20, -10);
    var curAvg = round1(mean(cur.map(function (s) { return num(s.avg); })));
    var prevAvg = prev.length ? round1(mean(prev.map(function (s) { return num(s.avg); }))) : null;
    if (curAvg == null || prevAvg == null) return { current: curAvg, previous: prevAvg, delta: null, direction: null };
    var delta = round1(curAvg - prevAvg);
    var direction = delta > 0.5 ? 'up' : delta < -0.5 ? 'down' : 'flat';
    return { current: curAvg, previous: prevAvg, delta: delta, direction: direction };
  }

  // Moving average (window decisions) over the last `last` decisions, plus session start ticks.
  function chartSeries(decisions, sessions, opts) {
    opts = opts || {};
    var last = opts.last || 100;
    var win = opts.win || 10;
    var ds = decisions.slice().sort(function (a, b) { return num(a.t) - num(b.t); });
    var start = Math.max(0, ds.length - last);
    var slice = ds.slice(start);
    var points = slice.map(function (_, i) {
      var from = Math.max(0, i - win + 1);
      var part = slice.slice(from, i + 1);
      return { x: i, y: round1(mean(part.map(function (d) { return num(d.score); }))) };
    });
    var ticks = [];
    (sessions || []).forEach(function (s) {
      var idx = slice.findIndex(function (d) { return num(d.t) >= num(s.t); });
      if (idx >= 0 && ticks.indexOf(idx) < 0) ticks.push(idx);
    });
    return { points: points, ticks: ticks.sort(function (a, b) { return a - b; }), n: slice.length };
  }

  // Average and count per group. key: 'position' | 'street' | 'players'.
  function breakdown(decisions, key) {
    var out = {};
    decisions.forEach(function (d) {
      var k = d[key] == null || d[key] === '' ? '?' : String(d[key]);
      if (!out[k]) out[k] = { n: 0, sum: 0 };
      out[k].n += 1;
      out[k].sum += num(d.score);
    });
    Object.keys(out).forEach(function (k) {
      out[k] = { n: out[k].n, avg: round1(out[k].sum / out[k].n) };
    });
    return out;
  }

  function handsPlayed(hands) { return hands.length; }

  // Longest run of decisions rated best or good, in time order.
  function bestStreak(decisions) {
    var ds = decisions.slice().sort(function (a, b) { return num(a.t) - num(b.t); });
    var best = 0, run = 0;
    ds.forEach(function (d) {
      run = num(d.score) >= GOOD_SCORE ? run + 1 : 0;
      if (run > best) best = run;
    });
    return best;
  }

  // Lowest-scoring position or street with at least minN decisions.
  function weakest(decisions, minN) {
    var min = minN || MIN_SAMPLES;
    var best = null;
    ['position', 'street'].forEach(function (dim) {
      var groups = breakdown(decisions, dim);
      Object.keys(groups).forEach(function (k) {
        var g = groups[k];
        if (k === '?' || g.n < min || g.avg == null) return;
        if (!best || g.avg < best.avg || (g.avg === best.avg && g.n > best.n)) {
          best = { dim: dim, key: k, avg: g.avg, n: g.n };
        }
      });
    });
    return best;
  }

  // Everything the Progress page shows, for one filter ('all' | 'practice' | 'exam').
  function summary(store, filter) {
    var s = store || {};
    var decisions = filterBy(s.decisions || [], filter);
    var sessions = filterBy(s.sessions || [], filter);
    var hands = filterBy(s.hands || [], filter);
    return {
      decisions: decisions.length,
      average: averageScore(decisions),
      trend: trend(sessions),
      chart: chartSeries(decisions, sessions, { last: 100, win: 10 }),
      byPosition: breakdown(decisions, 'position'),
      byStreet: breakdown(decisions, 'street'),
      byPlayers: breakdown(decisions, 'players'),
      handsPlayed: handsPlayed(hands),
      bestStreak: bestStreak(decisions),
      weakest: weakest(decisions, MIN_SAMPLES)
    };
  }

  var api = {
    POSITION_ORDER: POSITION_ORDER, STREET_ORDER: STREET_ORDER, GOOD_SCORE: GOOD_SCORE, MIN_SAMPLES: MIN_SAMPLES,
    filterBy: filterBy, averageScore: averageScore, trend: trend, chartSeries: chartSeries,
    breakdown: breakdown, handsPlayed: handsPlayed, bestStreak: bestStreak, weakest: weakest, summary: summary
  };
  if (typeof window !== 'undefined') window.PokerStats = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
