/* Poker Trainer UI. Talks to the engine only through window.PokerEngine (see CONTRACT.md),
 * the full-hand game through window.PokerGame (+ PokerBots), and strings through window.I18N.
 * Two games: "Hands" (full hands vs CPUs, default) and "Quick spots" (single-decision drills). */
(function () {
  'use strict';

  var STORE = {
    stats: 'poker-trainer:stats:v2', statsV1: 'poker-trainer:stats:v1', settings: 'poker-trainer:settings:v2',
    mode: 'poker-trainer:mode:v1', game: 'poker-trainer:game:v2',
    progress: 'poker-trainer:progress:v1', table: 'poker-trainer:table:v1', menuSeen: 'poker-trainer:menu-seen:v1', theme: 'poker-trainer:theme:v1', user: 'poker-trainer:user:v1'
  };
  var POS_ORDER = ['UTG', 'UTG+1', 'UTG+2', 'MP', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
  var POSITION_ALL = ['UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
  var STREET_ORDER = ['preflop', 'flop', 'turn', 'river'];
  var PLAYER_NUMS = ['2', '3', '4', '5', '6', '7', '8', '9'];
  var STREET_OPTIONS = ['any'].concat(STREET_ORDER);
  var SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
  var RANKS = 'AKQJT98765432';
  var CHART_COLORS = { raise: 'var(--raise)', call: 'var(--call)', fold: 'var(--fold)' };
  // Engine stat rows kept in the compact table (others are dropped to keep the panel short).
  var COMPACT_SKIP = { 'Players': true, 'Pot': true, 'To call': true, 'Villain range estimate': true, 'Board texture': true };
  var STAT_KEY = {
    'Hand / Made hand': 'row.hand', 'Chance to win vs range': 'row.winChance', 'Pot odds (required chance to win)': 'row.potOdds',
    'Outs': 'row.outs', 'Position': 'row.position', 'Stack-to-pot ratio': 'row.spr',
    'EV of fold / call / raise': 'row.evs', 'Hand percentile / chart tier': 'row.percentile'
  };
  var LA_RULES = [
    [/^fold/i, 'la.fold'], [/^check/i, 'la.check'], [/^call/i, 'la.call'], [/^limp/i, 'la.limp'],
    [/^bet/i, 'la.bet'], [/^raise/i, 'la.raise'], [/^busted/i, 'la.busted']
  ];
  var HAND_NAMES = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    gameBtns: document.querySelectorAll('#game-toggle .mode-btn'),
    modeBtns: document.querySelectorAll('#sub-toggle .mode-btn'),
    langBtns: document.querySelectorAll('.lang-btn'),
    setPosition: $('set-position'), setStreet: $('set-street'),
    setStackField: $('set-stack-field'),
    setStacks: $('set-stacks'), setCustomStacks: $('set-custom-stacks'), setCustomField: $('set-custom-field'), setStack: $('set-stack'),
    btnFinishExam: $('btn-finish-exam'),
    practiceArea: $('practice-area'), handInfo: $('hand-info'), btnRanges: $('btn-ranges'),

    cpuResult: $('cpu-result'), cpuResultTitle: $('cpu-result-title'), cpuResultLines: $('cpu-result-lines'),
    btnCpuNext: $('btn-cpu-next'), cpuNextLabel: $('cpu-next-label'),
    seats: $('seats'), bets: $('bets'), pot: $('pot'), board: $('board'),
    heroCards: $('hero-cards'), heroInfo: $('hero-info'),
    errorBanner: $('error-banner'), errorText: $('error-text'), errorRetry: $('error-retry'),
    btnFold: $('btn-fold'), btnCall: $('btn-call'), btnRaise: $('btn-raise'), callLabel: $('call-label'),
    raiseLabel: $('raise-label'),
    feedback: $('feedback'), fbPractice: $('fb-practice'),
    verdict: $('verdict'), explanation: $('explanation'), btnMore: $('btn-more'), statsTable: $('stats-table'),
    btnNext: $('btn-next'), nextLabel: $('next-label'),
    examSummary: $('exam-summary'), sumAvg: $('sum-avg'), sumHands: $('sum-hands'), sumDecisions: $('sum-decisions'),
    sumBest: $('sum-best'), sumWorst: $('sum-worst'), sumByPosition: $('sum-by-position'), sumByStreet: $('sum-by-street'),
    sumView: $('sum-view'),
    btnAnalysis: $('btn-analysis'), btnNewExam: $('btn-new-exam'),
    btnExamMenu: $('btn-exam-menu'),
    examLive: $('exam-live'), xlHands: $('xl-hands'), xlDecisions: $('xl-decisions'), xlAvg: $('xl-avg'),
    xlStreak: $('xl-streak'), xlBest: $('xl-best'), xlWorst: $('xl-worst'),
    helperPanel: $('helper-panel'),
    helperPlayers: $('helper-players'), helperPosition: $('helper-position'),
    helperFacing: $('helper-facing'), helperGrid: $('helper-grid'), helperNote: $('helper-note'),
    statsTitle: $('stats-title'),
    kpiHands: $('kpi-hands'), kpiAcc: $('kpi-acc'), kpiStreak: $('kpi-streak'), kpiBest: $('kpi-best'),
    kpiScore: $('kpi-score'), kpiAvg: $('kpi-avg'), byPosition: $('by-position'), byStreet: $('by-street')
  };

  var settings = null;     // {players, position, street, randomness (0-100), stack (BB)}
  var game = 'hands';      // 'hands' (full hands, default) | 'spots' (quick single-decision drills)
  var mode = 'practice';   // 'practice' | 'exam' (applies to both games)
  var stats = null;        // {practice, exam, 'cpu-practice', 'cpu-exam'} ('cpu-*' = hands)
  var exam = null;         // hands exam: {count, sum, streak, bestStreak, hands, records, finished}
  var tbl = null;          // hands table: {session, timer, heroTurn, handOver, decisions: [{street, move, pct, rating}]}
  var scenario = null;     // scenario the hero is deciding on
  var answered = null;     // {action, amount, result}
  var raiseReady = false;  // the one raise button is usable (its size is automatic)
  var errorRetry = null;
  var helperSel = null;    // {players, position, facing}
  var helperSpots = [];
  var rangesOpen = false;
  var winnerSeats = null;
  var actingSeat = null;   // session seat whose turn it is in full hands (null otherwise)  // session seat indices that won the last showdown

  /* ---------- helpers ---------- */
  function t(key, vars) { return window.I18N ? window.I18N.t(key, vars) : key; }
  function lang() { return window.I18N ? window.I18N.lang() : 'en'; }
  function eng() { return window.PokerEngine; }
  function enginePositions() { var e = eng(); return (e && e.POSITIONS) || {}; }
  function loadJSON(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function saveJSON(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage blocked */ }
  }
  function num(x) { var v = Number(x); return isFinite(v) ? v : 0; }
  // Every BB amount on screen is a whole or half big blind (0.5 BB grain): rounded to the nearest half, no trailing .0.
  function bbHalf(n) { return Math.round(num(n) * 2) / 2; }
  function fmtBB(n) {
    var x = bbHalf(n);
    return Number.isInteger(x) ? String(x) : x.toFixed(1);
  }
  // Starting stack in BB: validStackBB (game.js) - default 100, 5..1000, 0.5 steps.
  function stackBB(v) { return window.PokerGame ? window.PokerGame.validStackBB(v) : 100; }
  function errMsg(e) { return e && e.message ? e.message : String(e); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function posName(p) { return p ? t('posName.' + p) : ''; }
  function streetName(s) { return t('street.' + s); }
  function cpuName(name) {
    var m = /^CPU (\d+)$/.exec(String(name || ''));
    if (m) return t('cpu.name', { n: m[1] });
    m = /^Seat (\d+)$/.exec(String(name || ''));
    if (m) return t('seat.n', { n: m[1] });
    return String(name || '');
  }
  function handName(en) { return HAND_NAMES.indexOf(en) >= 0 ? t('hand.' + en) : String(en || ''); }
  // Showdown: the best five of 7 cards, its descriptive name in the language ('Two pair, aces and tens').
  function bestFive(cards) {
    var best = -1, pick = null, n = cards.length;
    for (var a = 0; a < n; a++) for (var b = a + 1; b < n; b++) for (var c = b + 1; c < n; c++)
      for (var d = c + 1; d < n; d++) for (var e = d + 1; e < n; e++) {
        var five = [cards[a], cards[b], cards[c], cards[d], cards[e]];
        var sc = window.PokerEngine.evaluateHand(five).score;
        if (sc > best) { best = sc; pick = five; }
      }
    return pick;
  }
  function describeHand(five) {
    var RO = '23456789TJQKA';
    var cat = window.PokerEngine.evaluateHand(five).rank;
    var counts = {};
    five.forEach(function (c) { var r = c.charAt(0).toUpperCase(); counts[r] = (counts[r] || 0) + 1; });
    var ranks = Object.keys(counts).sort(function (x, y) { return RO.indexOf(y) - RO.indexOf(x); });
    var groups = ranks.slice().sort(function (x, y) { return (counts[y] - counts[x]) || (RO.indexOf(y) - RO.indexOf(x)); });
    var hi = ranks[0];
    if ((cat === 4 || cat === 8) && ranks[0] === 'A' && ranks[1] === '5') hi = '5'; // the wheel: five high
    var P = function (r) { return t('rk.p.' + r); }, S = function (r) { return t('rk.s.' + r); };
    if (cat === 0) return t('hd.high', { a: S(hi) });
    if (cat === 1) return t('hd.pair', { a: P(groups[0]) });
    if (cat === 2) return t('hd.two', { a: P(groups[0]), b: P(groups[1]) });
    if (cat === 3) return t('hd.trips', { a: P(groups[0]) });
    if (cat === 4) return t('hd.straight', { a: S(hi) });
    if (cat === 5) return t('hd.flush', { a: S(hi) });
    if (cat === 6) return t('hd.full', { a: P(groups[0]), b: P(groups[1]) });
    if (cat === 7) return t('hd.quads', { a: P(groups[0]) });
    return t('hd.sf', { a: S(hi) });
  }
  // Every live hand at showdown: seat index, name, best five and its description.
  function showdownInfo(s) {
    var hand = s.hand, out = [];
    if (!hand || !hand.results || !hand.results.showdown) return out;
    hand.order.forEach(function (idx) {
      var hs = hand.seats[idx];
      if (hs.folded || !hs.cards || !hs.cards.length) return;
      var five = bestFive(hs.cards.concat(hand.board));
      if (!five) return;
      var name = s.seats[idx].isHero ? heroLabel() : cpuName(s.seats[idx].name);
      var desc = describeHand(five);
      out.push({ idx: idx, name: name, hero: !!s.seats[idx].isHero, five: five, hand: desc.charAt(0).toUpperCase() + desc.slice(1) });
    });
    return out;
  }
  // Highlights the winners' best five on the board and in the hole cards; the other board cards dim.
  function showdownMark(info, winners) {
    var win = info.filter(function (x) { return winners.indexOf(x.idx) >= 0; });
    var best = {};
    win.forEach(function (x) { x.five.forEach(function (c) { best[c] = true; }); });
    document.querySelectorAll('.card[data-code]').forEach(function (c) {
      var code = c.getAttribute('data-code');
      var inRoot = !!c.closest('#board, #hero-cards, .seat.winner .mini-cards');
      if (!inRoot || !win.length) { c.classList.remove('best'); c.style.opacity = ''; c.style.boxShadow = ''; return; }
      c.classList.toggle('best', !!best[code]);
      c.style.opacity = best[code] ? '' : '0.45';
      c.style.boxShadow = best[code] ? '0 0 0 2px var(--gold)' : '';
    });
  }
  function laLabel(text) {
    if (!text) return '';
    var s = String(text), out = null;
    for (var i = 0; i < LA_RULES.length && !out; i++) if (LA_RULES[i][0].test(s)) out = t(LA_RULES[i][1]);
    out = out || s;
    if (/all-in/i.test(s)) out += ' · ' + t('la.allin');
    return out;
  }
  function styleLabel(style) { return t('style.' + style); }
  function titleFor(sc) {
    var n = sc.numPlayers || sc.seats.length;
    var st = streetName(sc.street);
    return sc.heroPosition
      ? t('title.hand', { pos: posName(sc.heroPosition), n: n, street: st })
      : t('title.noPos', { n: n, street: st });
  }
  function emptyStats() {
    return { hands: 0, correct: 0, scoreSum: 0, streak: 0, bestStreak: 0, byPosition: {}, byStreet: {} };
  }
  function sanitizeStats(s) {
    var d = emptyStats();
    if (!s || typeof s !== 'object') return d;
    ['hands', 'correct', 'scoreSum', 'streak', 'bestStreak'].forEach(function (k) { d[k] = num(s[k]); });
    d.byPosition = s.byPosition && typeof s.byPosition === 'object' ? s.byPosition : {};
    d.byStreet = s.byStreet && typeof s.byStreet === 'object' ? s.byStreet : {};
    return d;
  }
  function loadStats() {
    var v2 = loadJSON(STORE.stats, null);
    if (v2 && typeof v2 === 'object') {
      return {
        practice: sanitizeStats(v2.practice), exam: sanitizeStats(v2.exam),
        'cpu-practice': sanitizeStats(v2['cpu-practice']), 'cpu-exam': sanitizeStats(v2['cpu-exam'])
      };
    }
    return {
      practice: sanitizeStats(loadJSON(STORE.statsV1, null)), exam: emptyStats(),
      'cpu-practice': emptyStats(), 'cpu-exam': emptyStats()
    };
  }
  // Player range (pmin-pmax, 2-9), position, street, stack, personalities, stacks, money.
  function clampInt(v, lo, hi, dflt) {
    if (v === null || v === undefined || v === '') return dflt;
    var n = Math.round(Number(v));
    return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
  }
  var PERSONALITY_TYPES = ['tight', 'loose', 'aggressive', 'passive', 'balanced'];
  var STACK_MODES = ['equal', 'varied', 'custom'];
  function sanitizePers(v) {
    var a = Array.isArray(v) ? v.filter(function (x) { return PERSONALITY_TYPES.indexOf(x) >= 0; }) : [];
    return a.length ? a : PERSONALITY_TYPES.slice();
  }
  function sanitizeCustom(v) {
    var a = Array.isArray(v) ? v.map(Number).filter(function (x) { return isFinite(x) && x > 0; }) : [];
    return a.slice(0, 9).map(function (x) { return stackBB(x); });
  }
  function sanitizeSettings(s) {
    s = s && typeof s === 'object' ? s : {};
    var lo = clampInt(s.pmin, 2, 9, 2), hi = clampInt(s.pmax, 2, 9, 9);
    if (hi < lo) hi = lo;
    var out = {
      pmin: lo, pmax: hi,
      position: POSITION_ALL.indexOf(String(s.position)) >= 0 ? String(s.position) : 'random',
      street: STREET_OPTIONS.indexOf(String(s.street)) >= 0 ? String(s.street) : 'any',
      stack: stackBB(s.stack),
      personalities: sanitizePers(s.personalities),
      stacks: STACK_MODES.indexOf(String(s.stacks)) >= 0 ? String(s.stacks) : 'varied',
      sv: 2,
      customStacks: sanitizeCustom(s.customStacks),
      money: s.money !== false
    };
    if (lo === hi && out.position !== 'random' && positionChoices(String(lo)).indexOf(out.position) < 0) out.position = 'random';
    out.ranges = sanitizeRanges(s.ranges);
    return out;
  }
  // Each game keeps its own player range (Single spots, Practice, Exam, Quick game); pmin/pmax are the active one.
  var RANGE_KEYS = ['spots', 'practice', 'exam', 'table'];
  function sanitizeRanges(v) {
    var out = {};
    RANGE_KEYS.forEach(function (k) {
      var r = v && typeof v === 'object' ? v[k] : null;
      var lo = clampInt(r && r.pmin, 2, 9, 2), hi = clampInt(r && r.pmax, 2, 9, 9);
      out[k] = { pmin: lo, pmax: Math.max(lo, hi) };
    });
    return out;
  }
  // The range key of the game on screen (in play) or of the format picked on the menu.
  function rangeKeyNow() { return isTable() ? 'table' : game === 'spots' ? 'spots' : mode === 'exam' ? 'exam' : 'practice'; }
  function rangeKeyOfFormat(fmt, md) { return fmt === 'table' ? 'table' : fmt === 'quick' ? 'spots' : md === 'exam' ? 'exam' : 'practice'; }
  // Makes the range of one game the active one (pmin/pmax read by the hands and the Settings panel).
  function applyRange(key) {
    var r = settings.ranges[key] || { pmin: 2, pmax: 9 };
    settings.pmin = r.pmin; settings.pmax = r.pmax;
  }
  function storeRange(key, lo, hi) {
    settings.ranges[key] = { pmin: lo, pmax: hi };
    settings.pmin = lo; settings.pmax = hi;
  }
  function statsKey() { if (mode === 'table') return 'cpu-practice'; return (game === 'hands' ? 'cpu-' : '') + mode; }
  function curStats() { return stats[statsKey()]; }
  function statsTitleText() {
    var k = statsKey();
    var key = { practice: 'stats.titlePractice', exam: 'stats.titleExam', 'cpu-practice': 'stats.titleHandsPractice', 'cpu-exam': 'stats.titleHandsExam' }[k];
    return t(key);
  }
  function helperAvailable() {
    var e = eng();
    return !!e && typeof e.getRangeChart === 'function' && typeof e.listChartSpots === 'function';
  }
  // Positions valid for a player count (all positions when the count is random).
  function positionChoices(players) {
    var P = enginePositions();
    if (players && players !== 'random' && P[Number(players)]) return P[Number(players)].slice();
    return POSITION_ALL.slice();
  }
  function formatMove(action, amount, sc) {
    if (action === 'fold') return t('move.fold');
    // Postflop with nothing to call, the aggressive action is a Bet, not a Raise.
    var bet = !!sc && sc.toCall === 0 && sc.street !== 'preflop';
    if (action === 'raise') return amount != null ? t(bet ? 'move.bet' : 'move.raise', { x: fmtBB(amount) }) : t(bet ? 'move.betBare' : 'move.raiseBare');
    return sc && sc.toCall > 0 ? t('move.call') : t('move.check');
  }
  // The one raise size of the game: the size the Raise button applies (scenario.standardRaise, BB), or the
  // engine's raiseSize when the scenario has none (quick spots). It is "All-in" only when it reaches the hero's
  // whole stack (remaining chips plus this street's bet); it is never shown as a plain number then.
  function heroBetOf(sc) {
    var i = findHeroIndex(sc);
    return i >= 0 ? num(sc.seats[i].bet) : 0;
  }
  function sizeFor(sc, res) {
    if (!sc) return null;
    var raw = sc.standardRaise != null ? sc.standardRaise : (res && res.raiseSize != null ? res.raiseSize : null);
    var size = Number(raw);
    if (raw == null || !isFinite(size) || size <= 0) return null;
    var cap = num(sc.heroStack) + heroBetOf(sc);
    var allIn = cap > 0 && size >= cap - 0.05;
    return { amount: allIn ? cap : size, allIn: allIn };
  }
  function moveText(action, r, sc) {
    if (action !== 'raise') return formatMove(action, null, sc);
    if (!r) return formatMove('raise', null, sc);
    if (r.allIn) return t('move.allin');
    return formatMove('raise', r.amount, sc);
  }

  function cardEl(code, opts) {
    opts = opts || {};
    var valid = typeof code === 'string' && /^[2-9TJQKA][shdc]$/i.test(code);
    var card = el('div', 'card' + (opts.large ? ' large' : ''));
    if (code) card.setAttribute('data-code', String(code));
    if (!code) {
      card.classList.add('empty');
    } else if (!valid) {
      card.classList.add('unknown');
      card.textContent = '?';
    } else {
      var rank = code.charAt(0).toUpperCase() === 'T' ? '10' : code.charAt(0).toUpperCase();
      var suit = code.charAt(1).toLowerCase();
      if (suit === 'h' || suit === 'd') card.classList.add('red');
    if (suit) card.classList.add('suit-' + suit);
      // one upright index (rank over suit) in the top-left corner and one big suit in the centre
      var corner = el('span', 'c-corner');
      corner.appendChild(el('span', 'c-rank', rank));
      corner.appendChild(el('span', 'c-idx', SUIT_SYMBOL[suit]));
      card.appendChild(corner);
      card.appendChild(el('span', 'c-suit', SUIT_SYMBOL[suit]));
    }
    if (opts.delay != null) card.style.setProperty('--delay', opts.delay + 'ms');
    if (opts.flip) card.classList.add('flip-in');
    if (!opts.animate) card.style.animation = 'none';
    return card;
  }
  function findHeroIndex(sc) {
    var idx = sc.seats.findIndex(function (s) { return s && s.isHero; });
    if (idx < 0) idx = sc.seats.findIndex(function (s) { return s && s.seat === sc.heroSeat; });
    return idx;
  }
  function validateScenario(sc) {
    if (!sc || typeof sc !== 'object') throw new Error('engine returned no scenario');
    if (!Array.isArray(sc.seats) || sc.seats.length < 2) throw new Error('scenario has no seats');
    if (!Array.isArray(sc.hero) || sc.hero.length !== 2) throw new Error('scenario has no hero cards');
    if (findHeroIndex(sc) < 0) throw new Error('scenario has no hero seat');
    if (!Array.isArray(sc.board)) sc.board = [];
    if (!Array.isArray(sc.raiseOptions)) sc.raiseOptions = [];
    sc.pot = num(sc.pot);
    sc.toCall = num(sc.toCall);
    sc.heroStack = num(sc.heroStack);
    sc.seats.forEach(function (s) { s.stack = num(s.stack); s.bet = num(s.bet); });
  }
  function validateResult(r) {
    if (!r || typeof r !== 'object') throw new Error('engine returned no result');
    if (['best', 'good', 'mistake', 'blunder'].indexOf(r.rating) < 0) throw new Error('engine returned unknown rating "' + r.rating + '"');
    r.score = num(r.score);
    if (!Array.isArray(r.explanation)) r.explanation = [];
    if (!Array.isArray(r.stats)) r.stats = [];
    r.summary = r.summary ? String(r.summary) : '';
  }

  /* ---------- errors ---------- */
  function showError(msg, retry) {
    els.errorText.textContent = msg;
    errorRetry = retry || null;
    els.errorRetry.classList.toggle('hidden', !retry);
    els.errorBanner.classList.remove('hidden');
  }
  function clearError() {
    errorRetry = null;
    els.errorBanner.classList.add('hidden');
  }

  /* ---------- table rendering ---------- */
  function clearTable() {
    els.seats.textContent = '';
    els.bets.textContent = '';
    els.board.textContent = '';
    els.heroCards.textContent = '';
    els.pot.textContent = '';
    els.heroInfo.textContent = '';
    els.handInfo.textContent = '';
    renderSidePanels(null);
  }
  /* ---------- table layout ----------
   * Seats sit on the table's stadium outline (stadium.js) through their centres: hero at the bottom, the others clockwise, evenly by arc length. The outline is the
   * largest one that keeps every seat box inside the table and clear of the other seats, the pot and the board.
   * Sizes come from the measured table (no fixed pixel guesses). When the table is small, a seat gives up content
   * in steps (style tag, last-action chip, then the smallest name + position box). Bet chips sit on the radius
   * between their seat and the centre, where they touch no seat, the pot or the board. */
  var LAYOUT_GAP = 6;
  // lvl-4 is the compact seat level for tiny tables (on top of lvl-3: smaller plates, smaller pot and chips)
  var LAYOUT_LEVELS = ['', 'lvl-1', 'lvl-2', 'lvl-3', 'lvl-3 lvl-4'];
  var layoutRaf = 0;
  function scheduleLayout() {
    if (layoutRaf) return;
    layoutRaf = requestAnimationFrame(function () { layoutRaf = 0; layoutTable(); });
  }
  function boxHit(a, b, gap) {
    return Math.abs(a.x - b.x) < (a.w + b.w) / 2 + gap && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + gap;
  }
  function setLayoutLevel(tbl, lvl) {
    ['lvl-1', 'lvl-2', 'lvl-3', 'lvl-4'].forEach(function (c) { tbl.classList.remove(c); });
    if (lvl) lvl.split(' ').forEach(function (c) { tbl.classList.add(c); });
  }
  // Room above the top seats for the face-down pair (seats.css .seat-backs overhangs the plate). Read at the current
  // table level, so the ellipse keeps the pair inside the table; 0 when no seat shows backs.
  function backsOverhang(seats) {
    var ov = 0;
    seats.forEach(function (s) {
      var b = s.querySelector('.seat-backs');
      if (b && getComputedStyle(b).display !== 'none') ov = Math.max(ov, -(parseFloat(getComputedStyle(b).top) || 0));
    });
    return ov ? Math.ceil(ov) + 4 : 0;
  }
  function layoutFits(pts, board, pot) {
    for (var i = 0; i < pts.length; i++) {
      if (boxHit(pts[i], board, LAYOUT_GAP) || boxHit(pts[i], pot, LAYOUT_GAP)) return false;
      for (var j = i + 1; j < pts.length; j++) if (boxHit(pts[i], pts[j], LAYOUT_GAP)) return false;
    }
    return true;
  }
  // Bet chip spots, one per seat, precomputed for every seat at layout time: each sits on the radius between its seat
  // and the centre, nudged sideways when the seat, the board or the pot is in the way, and never on a chip of an
  // earlier seat. The spots depend only on the table geometry (seat count, size, level), never on which bets exist,
  // so a new bet does not move the chips already on the table. Index = seat index. strict: null if a seat has no clear spot.
  function seatChipSpots(pts, obstacles, cx, cy, cw, ch, strict) {
    var placed = [];
    var fractions = [0.45, 0.55, 0.35, 0.65, 0.25, 0.75, 0.15, 0.85, 0.3, 0.7, 0.2, 0.8];
    var sideways = [0, 1, -1, 2, -2, 3, -3];
    for (var si = 0; si < pts.length; si++) {
      var p = pts[si];
      var dx = cx - p.x, dy = cy - p.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
      var ux = -dy / len, uy = dx / len; // unit vector across the radius
      var pick = null;
      for (var k = 0; k < fractions.length && !pick; k++) {
        for (var s = 0; s < sideways.length && !pick; s++) {
          var off = sideways[s] * 34;
          var cand = { x: p.x + dx * fractions[k] + ux * off, y: p.y + dy * fractions[k] + uy * off, w: cw, h: ch };
          var inside = cand.x - cw / 2 >= 0 && cand.x + cw / 2 <= cx * 2 && cand.y - ch / 2 >= 0 && cand.y + ch / 2 <= cy * 2;
          var clash = !inside || obstacles.some(function (o) { return boxHit(cand, o, 3); }) ||
            placed.some(function (o) { return boxHit(cand, o, 3); });
          if (!clash) pick = cand;
        }
      }
      if (!pick) {
        if (strict) return null;
        pick = { x: p.x + dx * 0.5, y: p.y + dy * 0.5, w: cw, h: ch };
      }
      placed.push(pick);
    }
    return placed;
  }
  // Keeps the table box between a tall and a flat ellipse and centred in its area, whatever the screen shape.
  // Landscape tables are racetrack stadiums about 2.2:1 (1.9 at least); portrait screens get a taller stadium (0.6 to 0.8).
  var TABLE_RATIO_MIN = 0.6, TABLE_RATIO_MAX = 2.2, TABLE_RATIO_WIDE = 1.9;
  function fitTableBox(tbl) {
    var wrap = tbl.parentElement;
    if (!wrap) return;
    tbl.style.left = tbl.style.top = tbl.style.right = tbl.style.bottom = tbl.style.width = tbl.style.height = '';
    var aw = wrap.clientWidth, ah = wrap.clientHeight;
    if (!aw || !ah) return;
    var r = aw / ah;
    r = r > 1.2 ? Math.max(TABLE_RATIO_WIDE, Math.min(TABLE_RATIO_MAX, r)) : Math.max(TABLE_RATIO_MIN, Math.min(0.8, r));
    var w = Math.min(aw, ah * r), h = Math.min(ah, aw / r);
    tbl.style.right = tbl.style.bottom = 'auto';
    tbl.style.width = Math.floor(w) + 'px'; tbl.style.height = Math.floor(h) + 'px';
    tbl.style.left = Math.floor((aw - w) / 2) + 'px'; tbl.style.top = Math.floor((ah - h) / 2) + 'px';
  }
  // The room each bet chip is given in the layout (fixed per level, so the spots do not depend on the chips' text):
  // full chips, the smaller level 3 chips, and the compact pills.
  function chipBox(cmode, li) {
    if (cmode) return { w: 48, h: 16 };
    return li >= 3 ? { w: 60, h: 20 } : { w: 72, h: 24 };
  }
  function layoutTable() {
    var tbl = $('table');
    var seats = Array.prototype.slice.call(els.seats.children);
    if (!tbl || !seats.length) return;
    fitTableBox(tbl);
    if (!tbl.clientWidth || !tbl.clientHeight) return;
    var W = tbl.clientWidth, H = tbl.clientHeight, cx = W / 2, cy = H / 2, n = seats.length;
    var maxW = parseFloat(getComputedStyle(tbl).getPropertyValue('--seat-maxw')) || 118;
    var minW = 56;
    var baseBoard = Math.min(60, Math.max(30, W * 0.07));
    var scales = [1, 0.85, 0.72, 0.6, 0.5];
    var found = null, last = null;
    // second pass with compact chip pills (no " BB" suffix, smaller discs) when no size fits with full chips
    for (var cmode = 0; cmode < 2 && !found; cmode++) {
    tbl.classList.toggle('chips-compact', cmode === 1);
    for (var si = 0; si < scales.length && !found; si++) {
      els.board.style.setProperty('--board-cw', Math.max(22, Math.round(baseBoard * scales[si])) + 'px');
      var board = { x: cx, y: cy, w: els.board.offsetWidth, h: els.board.offsetHeight };
      // the pot pill counts up after the layout (a 5-digit value is wider): reserve room for it so it never touches the board
      var potH = els.pot.offsetHeight;
      // the pot is centred over the board (above it, or below it when the table is too short for that)
      var potSpotsFor = function (potW) {
        var spots = [
          { x: cx, y: cy - board.h / 2 - LAYOUT_GAP - potH / 2 },
          { x: cx, y: cy + board.h / 2 + LAYOUT_GAP + potH / 2 }
        ];
        // compact level only: the pot beside the board, on the centre line (the top and bottom rows are full of seats)
        var side = board.w / 2 + LAYOUT_GAP + potW / 2;
        spots.push({ x: cx - side, y: cy }, { x: cx + side, y: cy });
        return spots;
      };
      for (var li = 0; li < LAYOUT_LEVELS.length && !found; li++) {
        setLayoutLevel(tbl, LAYOUT_LEVELS[li]);
        // the pot pill's reserve: the compact level (tiny tables) reserves less room for it
        var ov = backsOverhang(seats);
        for (var w = maxW; w >= minW && !found; w -= 2) {
          // the height is measured at this width (a narrower seat can wrap its personality tag)
          var sh = 0;
          seats.forEach(function (s) { s.style.width = w + 'px'; sh = Math.max(sh, s.offsetHeight); });
          var rx = (W - w) / 2, ry = (H - sh) / 2 - ov; // top seat's box and its backs stay inside the table
          if (rx < 0 || ry < 0) continue;
          var outline = window.PokerStadium.shape(cx, cy, rx, ry); // seats follow the stadium (straight sides, round ends)
          var pts = seats.map(function (s) {
            var rel = +s.getAttribute('data-rel') || 0;
            var p = window.PokerStadium.at(outline, rel / n);
            return { x: p.x, y: p.y, w: w, h: sh };
          });
          // a fixed reserve, not the pot pill's measured width: the pot grows while it counts up, and that would move the bet chips
          var potW = LAYOUT_LEVELS[li].indexOf('lvl-4') >= 0 ? 60 : 150; // lvl-4 pill: no chip disc, the value capped at 60px (seats.css)
          var potSpots = potSpotsFor(potW);
          // the side spots only exist on the compact level, so the other levels keep their first two candidates
          if (LAYOUT_LEVELS[li].indexOf('lvl-4') < 0) potSpots.length = 2;
          for (var pk = 0; pk < potSpots.length && !found; pk++) {
            var pot = { x: potSpots[pk].x, y: potSpots[pk].y, w: potW, h: potH };
            last = { pts: pts, w: w, rx: rx, ry: ry, lvl: LAYOUT_LEVELS[li], scale: si, board: board, pot: pot, cm: cmode };
            if (!layoutFits(pts, board, pot)) continue;
            var obstacles = pts.concat([board, pot]);
            var spots = seatChipSpots(pts, obstacles, cx, cy, chipBox(cmode, li).w, chipBox(cmode, li).h, true);
            if (spots) { last.spots = spots; found = last; }
          }
        }
      }
    }
    }
    var f = found || last;
    tbl.classList.toggle('chips-compact', !!f.cm);    setLayoutLevel(tbl, f.lvl);
    els.board.style.setProperty('--board-cw', Math.max(22, Math.round(baseBoard * scales[f.scale])) + 'px');
    seats.forEach(function (s, i) {
      s.style.width = f.w + 'px';
      s.style.left = f.pts[i].x + 'px';
      s.style.top = f.pts[i].y + 'px';
    });
    // the felt is set once per table size and seat count: bets and seat content change the seat layout during a hand,
    // and the felt must not follow it (that would move the table under the player's buttons and the popup)
    var felt = tbl.querySelector('.felt');
    var feltKey = W + 'x' + H + 'x' + n;
    if (felt && tbl.getAttribute('data-felt-key') !== feltKey) {
      tbl.setAttribute('data-felt-key', feltKey);
      felt.style.left = (cx - f.rx) + 'px'; felt.style.top = (cy - f.ry) + 'px';
      felt.style.width = (2 * f.rx) + 'px'; felt.style.height = (2 * f.ry) + 'px';
    }
    els.pot.style.left = f.pot.x + 'px'; els.pot.style.top = f.pot.y + 'px';
    els.board.style.left = cx + 'px'; els.board.style.top = cy + 'px';

    var spots = f.spots || seatChipSpots(f.pts, f.pts.concat([f.board, f.pot]), cx, cy, chipBox(f.cm, LAYOUT_LEVELS.indexOf(f.lvl)).w, chipBox(f.cm, LAYOUT_LEVELS.indexOf(f.lvl)).h, false);
    var chipEls = Array.prototype.slice.call(els.bets.children);
    chipEls.forEach(function (c) {
      var r = spots[+c.getAttribute('data-idx')];
      if (!r) return;
      // chips are always at their final place (never on a seat); a new bet fades in after its delay (renderTable)
      if (c.hasAttribute('data-anim')) {
        c.style.opacity = '0';
        c.removeAttribute('data-anim');
        void c.offsetWidth;
        c.style.opacity = '';
      }
      c.style.left = r.x + 'px'; c.style.top = r.y + 'px';
    });
  }
  function chipDisc() { return el('span', 'chip-disc'); }
  // New hand (full hands): small face-down cards fly from the centre of the table to each seat, two per seat,
  // staggered by seat order and ending by ~800ms. Transform and opacity only, in a layer that takes no layout space.
  // PokerAnim helpers: absent or disabled animation means the caller renders the final state only.
  function animApi() {
    var A = window.PokerAnim;
    return A && typeof A.enabled === 'function' && A.enabled() ? A : null;
  }
  function animMobile() { return window.innerWidth < 600; }
  function animScale() { return animMobile() ? 0.8 : 1; }
  // Same deal in every mode: cards leave the centre one after another at this interval (sound and flights share it).
  var DEAL_STAGGER = 90;
  function dealFly() {
    var tblEl = $('table');
    if (window.PokerSound && els.seats) PokerSound.dealCards(els.seats.children.length * 2, DEAL_STAGGER); // sound.js
    if (!tblEl) return;
    tblEl.querySelectorAll('.deal-layer').forEach(function (old) { old.remove(); });
    var A = animApi();
    if (A) {
      // PokerAnim: face-down cards from the pot area to every seat; never blocks timers or input
      A.clear(tblEl); // a deal still in flight from the previous hand or spot is removed now, never drawn over the new table
      var seatNodes = Array.prototype.slice.call(els.seats.children);
      // targets are the seat centres, kept inside the table: a seat at the top edge would end the card above the viewport
      var tr0 = tblEl.getBoundingClientRect(), cwH = tblEl.clientHeight, cwW = tblEl.clientWidth, pad = 16;
      var seatTargets = seatNodes.map(function (s) {
        var r = s.getBoundingClientRect(), mx = r.left - tr0.left + r.width / 2, my = r.top - tr0.top + r.height / 2;
        mx = Math.max(pad, Math.min(cwW - pad, mx)); my = Math.max(pad, Math.min(cwH - pad, my));
        return { x: mx - r.width / 2, y: my - r.height / 2, width: r.width, height: r.height };
      });
      A.flyCards(tblEl, null, seatTargets, { rounds: animMobile() ? 1 : 2, stagger: DEAL_STAGGER, duration: 380 * animScale() })
        .catch(function () {});
      return;
    }
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var seats = Array.prototype.slice.call(els.seats.children);
    var cx = tblEl.clientWidth / 2, cy = tblEl.clientHeight / 2;
    var step = Math.min(70, Math.floor(420 / Math.max(1, seats.length - 1)));
    var layer = el('div', 'deal-layer');
    seats.forEach(function (seat) {
      var rel = +seat.getAttribute('data-rel') || 0;
      var dx = parseFloat(seat.style.left) - cx, dy = parseFloat(seat.style.top) - cy;
      if (!isFinite(dx) || !isFinite(dy)) return;
      for (var k = 0; k < 2; k++) {
        var c = el('span', 'deal-card');
        c.style.setProperty('--dx', dx + 'px');
        c.style.setProperty('--dy', dy + 'px');
        c.style.setProperty('--delay', (rel * step + k * 40) + 'ms');
        layer.appendChild(c);
      }
    });
    tblEl.appendChild(layer);
    setTimeout(function () { layer.remove(); }, 900);
  }

  // opts (optional): { seats, cards } override the animation of seats and cards; chips follow `animate`.
  function renderTable(sc, animate, opts) {
    opts = opts || {};
    SeatCard.bindGloss(lang());
    SeatCard.hideGloss(); // a bubble whose seat is re-rendered must not stay behind
    // opts.deal: a new hand (full hands) flies the face-down cards out and flips the hero cards in
    var seatsAnim = opts.seats != null ? !!opts.seats : !!animate;
    var cardsAnim = opts.cards != null ? !!opts.cards : !!animate;
    var n = sc.seats.length;
    var heroIdx = findHeroIndex(sc);
    var btnIdx = sc.seats.findIndex(function (s) { return s.seat === sc.buttonSeat; });

    els.handInfo.textContent = titleFor(sc);
    // PokerAnim: read the old bet chips and pot rects BEFORE the DOM is rebuilt below
    var A = animApi(), tblEl = $('table'), prevChipRects = [];
    if (A && tblEl) {
      prevChipRects = Array.prototype.slice.call(els.bets.children).map(function (c) { return A.rectIn(tblEl, c); }).filter(Boolean);
    }
    var prevPot = lastPotShown;
    // bet chips and card codes from the last render: unchanged ones are not animated again (no replay, no flicker)
    var prevBets = {};
    Array.prototype.slice.call(els.bets.children).forEach(function (c) { prevBets[c.getAttribute('data-idx')] = c; });
    var prevCards = lastCardCodes;
    els.seats.textContent = '';
    els.bets.textContent = '';

    sc.seats.forEach(function (s, idx) {
      var rel = ((idx - heroIdx) % n + n) % n;
      var toAct = s.isHero ? !!sc.heroToAct : (game === 'hands' && actingSeat === s.seat);
      var la = s.folded && !s.busted ? '' : laLabel(s.busted ? 'busted' : s.lastAction);
      // one plate for every solo mode (seatcard.js); position and size come from layoutTable()
      var seat = SeatCard.build(s, {
        rel: rel,
        toAct: toAct,
        winner: !!(winnerSeats && winnerSeats.indexOf(s.seat) >= 0),
        dealerBtn: idx === btnIdx,
        name: s.isHero ? heroLabel() : cpuName(s.name || ('Seat ' + s.seat)),
        stackText: settings.money && !s.busted && isFinite(Number(s.stack)) ? fmtBB(num(s.stack)) : null,
        styleLabel: !s.isHero && s.style && settings.personalities ? styleLabel(s.style) : null,
        lastText: la,
        tipText: s.isHero ? '' : seatTip(s),
        delay: seatsAnim ? rel * 70 : null,
        cardEl: function (code) { return cardEl(code, { animate: false }); }
      });
      if (!seatsAnim) seat.classList.add('no-anim'); // re-rendered seat: no entry animation replay
      els.seats.appendChild(seat);

      if (s.bet > 0 && !s.folded) {
        var chip = el('div', 'bet-chip');
        chip.appendChild(chipDisc());
        chip.appendChild(el('span', null, fmtBB(s.bet)));
        chip.setAttribute('data-idx', String(idx));
        var pb = prevBets[String(idx)];
        var sameBet = !!pb && !!pb.lastChild && pb.lastChild.textContent === fmtBB(s.bet);
        if (sameBet) { chip.style.left = pb.style.left; chip.style.top = pb.style.top; } // unchanged: no replay, no jump
        else if (animate) {
          chip.setAttribute('data-anim', '1');
          chip.style.transitionDelay = (300 + rel * 70) + 'ms';
        }
        els.bets.appendChild(chip);
      }
    });

    els.pot.textContent = '';
    els.pot.appendChild(chipDisc());
    var potVal = el('span', 'pot-val', fmtBB(sc.pot));
    els.pot.appendChild(potVal);
    var potNum = num(sc.pot);

    els.board.textContent = '';
    // only cards that are new since the last render deal in; the rest are redrawn still
    var prevBoard = prevCards.board, newBoard = 0;
    // a deal: hole cards land first (dealLand), the board comes after them; otherwise the board follows at once
    var dealLand = opts.deal ? ((animMobile() ? 0 : n) + heroIdx) * DEAL_STAGGER + 380 : 120;
    var boardDelay = opts.deal ? dealLand + 240 : 200;
    for (var i = 0; i < 5; i++) {
      var freshB = cardsAnim && !!sc.board[i] && sc.board[i] !== prevBoard[i];
      // The flip sound follows the board, not the animation flag: every new board card plays once.
      var newCard = !!sc.board[i] && sc.board[i] !== prevBoard[i];
      if (newCard) newBoard++;
      els.board.appendChild(cardEl(sc.board[i], { animate: freshB, flip: freshB, delay: boardDelay + (newBoard - 1) * 120 }));
      if (newCard && window.PokerSound) PokerSound.play('next', boardDelay + (newBoard - 1) * 120); // sound.js: flip at the reveal
    }
    els.heroCards.textContent = '';
    sc.hero.forEach(function (code, i) {
      var freshH = cardsAnim && (!!opts.deal || code !== prevCards.hero[i]);
      els.heroCards.appendChild(cardEl(code, { large: true, animate: freshH, flip: freshH, delay: (opts.deal ? dealLand : 120) + i * 120 }));
    });
    lastCardCodes = { board: sc.board.slice(), hero: sc.hero.slice() };
    els.heroInfo.textContent = '';
    renderSidePanels(sc);
    layoutTable();
    if (opts.deal) dealFly();
    // PokerAnim: bets fly to the pot when the pot grows; the pot pill counts up. Chips are never delayed by timers.
    var grew = potNum !== null && prevPot !== null && potNum > prevPot;
    if (A && tblEl && grew) {
      var newPotRect = A.rectIn(tblEl, els.pot);
      if (prevChipRects.length && newPotRect) {
        A.flyChips(prevChipRects, newPotRect, { container: tblEl, count: 2, duration: 420 * animScale(), stagger: 35 })
          .catch(function () {});
      }
      A.countUp(potVal, prevPot, potNum, 400 * animScale(), fmtBB).catch(function () {});
    }
    if (window.PokerSound) {
      if (grew) PokerSound.play('chips', 420 * animScale()); // bet landing (sound.js)
      PokerSound.setTurn(sc.heroToAct ? 'hero' : (game === 'hands' && actingSeat != null ? 'other' : null));
    }
    lastPotShown = potNum;
  }
  var lastPotShown = null;
  var lastCardCodes = { board: [], hero: [] }; // card codes of the last render (renderTable)

  /* ---------- raise: one button, standard size (no size choice) ---------- */
  function setupRaise(sc) {
    var canRaiseNow = sc.standardRaise != null || (sc.raiseOptions || []).length > 0;
    raiseReady = canRaiseNow;
    updateRaiseUI();
  }
  function updateRaiseUI() { els.raiseLabel.textContent = t('btn.raise'); }
  // Grades a hero action. Raise is graded without an amount (the engine's best size); if the engine
  // needs one, the standard size the game applies is used.
  function gradeChoice(sc, action, bbAmt) {
    var opts = { lang: lang() };
    if (action !== 'raise') return eng().evaluate(sc, action, undefined, opts);
    if (bbAmt != null) {
      // grade the raise at the size the hero chose
      try { return eng().evaluate(sc, 'raise', bbAmt, opts); } catch (e) { console.error('graded chosen raise failed', e); }
    }
    var std = sizeFor(sc, null);
    if (std) {
      // grade the raise at the same size the Raise button applies
      try { return eng().evaluate(sc, 'raise', std.amount, opts); } catch (e) { console.error('graded raise size failed', e); }
    }
    try { return eng().evaluate(sc, 'raise', undefined, opts); } catch (e) {
      var fb = sc.standardRaise != null ? sc.standardRaise
        : ((sc.raiseOptions || []).filter(function (o) { return !/all/i.test(o.label); })[0] || {}).amount;
      if (fb == null) throw e;
      return eng().evaluate(sc, 'raise', fb, opts);
    }
  }
  // Same rule as game.js legalFor (canRaise): the engine must allow a raise for seat 0 (the hero) right now.
  function raiseLegalNow() {
    if (game !== 'hands') return true;
    var L = tbl && tbl.session && window.PokerGame ? window.PokerGame.legal(tbl.session, 0) : null;
    return !!(L && L.canRaise);
  }
  /* ---------- hands (quick game, practice and exam full hands): any raise size, like the multiplayer table ---------- */
  var heroRaise = null;  // chips: the raise-to total chosen on the hero's turn (null until chosen: the minimum)
  // Raise amounts snap to the 0.5 BB grain (grain chips = bb / 2), then clamp to the legal range.
  // The clamp ends can be off-grain (an all-in is the exact stack), which is legal.
  function clampChips(v, min, max, grain) {
    var n = Number(v);
    if (!isFinite(n)) n = min;
    var g = grain > 0 ? grain : 50;
    n = Math.round(n / g) * g;
    return Math.min(max, Math.max(min, n));
  }
  // Legal raise range for the hero in chips, or null when no raise is possible now.
  function heroRaiseBounds() {
    if (game !== 'hands' || !tbl || !tbl.session || !tbl.session.hand || !window.PokerGame) return null;
    var L = window.PokerGame.legal(tbl.session, 0);
    if (!L || !L.canRaise) return null;
    var pot = tbl.session.hand.seats.reduce(function (a, h) { return a + h.contributed; }, 0);
    // stackMax: the hero's whole reach (this street's bet plus stack). max can sit below it when the bet cap binds.
    return { min: L.minRaiseTo, max: L.maxRaiseTo, stackMax: L.myBet + L.stack, toCall: L.toCall, myBet: L.myBet, pot: pot, bb: tbl.session.hand.bb || 1 };
  }
  // Presets as raise-to totals, as in the multiplayer table: min, half pot, pot, all-in (clamped).
  function heroRaiseFor(q) {
    var b = heroRaiseBounds();
    if (!b) return null;
    if (q === 'min') return b.min;
    if (q === 'allin') return b.max;
    var potAfterCall = b.pot + b.toCall;
    return clampChips(b.myBet + b.toCall + (q === 'half' ? 0.5 : q === 'threeq' ? 0.75 : 1) * potAfterCall, b.min, b.max, b.bb / 2);
  }
  // The raise the hero's Raise button applies now (chips, clamped to the legal range); null when no raise.
  function heroRaiseAmount() {
    var b = heroRaiseBounds();
    if (!b) return null;
    heroRaise = clampChips(heroRaise == null ? b.min : heroRaise, b.min, b.max, b.bb / 2);
    return heroRaise;
  }
  // The chosen raise in big blinds and whether it is all-in, for grading and the move text; null when none.
  function heroRaiseRecord() {
    var c = heroRaiseAmount();
    var b = heroRaiseBounds();
    if (c == null || !b) return null;
    return { amount: c / b.bb, allIn: c >= b.max && b.max >= b.stackMax - 0.05 };
  }
  function setHeroRaise(chips) {
    if (!heroRaiseBounds()) return;
    heroRaise = clampChips(chips, heroRaiseBounds().min, heroRaiseBounds().max, heroRaiseBounds().bb / 2);
    updateControls();
  }
  // Raise row and the Raise button label for the hands game (the slider is in chips, the number in big blinds).
  function renderRaiseCtl() {
    var ctl = $('raise-ctl');
    ctl.classList.remove('hidden');
    var b = canAct() ? heroRaiseBounds() : null;
    ctl.classList.toggle('ctl-off', !b);
    renderRaisePresets(b);
    if (!b) { els.raiseLabel.textContent = t('btn.raise'); return; }
    var amt = heroRaiseAmount();
    var range = $('raise-range'), num = $('raise-num');
    range.min = b.min; range.max = b.max; range.step = String(b.bb / 2); range.value = String(amt);
    if (document.activeElement !== num) num.value = String(bbHalf(amt / b.bb));
    // "All-in" only when the raise really is my whole stack; a raise capped by the opponents' reach reads "Raise to X".
    var postflopBet = b.toCall === 0 && tbl.session.hand.street !== 'preflop';
    els.raiseLabel.textContent = amt >= b.max && b.max >= b.stackMax - 0.05 ? t('move.allin')
      : t(postflopBet ? 'btn.betTo' : 'btn.raiseTo', { x: fmtBB(amt / b.bb) });
  }
  // Preset buttons show their amount in BB and the one matching the chosen size is pressed.
  function renderRaisePresets(b) {
    Array.prototype.forEach.call(document.querySelectorAll('#raise-ctl [data-rq]'), function (btn) {
      var amt = b ? heroRaiseFor(btn.dataset.rq) : null;
      var out = btn.querySelector('.rq-amt');
      if (out) out.textContent = amt != null ? fmtBB(amt / b.bb) : '';
      btn.setAttribute('aria-pressed', amt != null && heroRaise != null && Math.abs(amt - heroRaise) < 0.5 ? 'true' : 'false');
    });
  }
  /* ---------- phones: a long press on Raise (>= LP_MS) opens an exact-amount popover above the button ---------- */
  var LP_MS = 450, lpTimer = null, lpFired = false;
  function rpOpen() { return !$('raise-pop').classList.contains('hidden'); }
  function rpClose() { $('raise-pop').classList.add('hidden'); }
  function rpBounds() {
    var b = heroRaiseBounds();
    return b ? { lo: b.min / b.bb, hi: b.max / b.bb } : null;
  }
  // Validates the typed amount against min..max (BB); disables Confirm and marks the field when it is out of range.
  function rpCheck() {
    var num = $('rp-num'), bd = rpBounds(), v = Number(num.value);
    var halves = Math.abs(v * 2 - Math.round(v * 2)) < 1e-9; // 0.5 BB steps only
    var ok = !!bd && num.value !== '' && isFinite(v) && halves && v >= bd.lo - 1e-9 && v <= bd.hi + 1e-9;
    num.classList.toggle('invalid', !ok && num.value !== '');
    $('rp-ok').disabled = !ok;
    $('rp-range').textContent = bd ? fmtBB(bd.lo) + ' – ' + fmtBB(bd.hi) + ' BB' : '';
    return ok;
  }
  function rpSet(v) { $('rp-num').value = String(bbHalf(v)); rpCheck(); }
  function rpPlace() {
    var pop = $('raise-pop'), r = els.btnRaise.getBoundingClientRect();
    var w = pop.offsetWidth, h = pop.offsetHeight;
    var left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    var top = r.top - h - 10;
    if (top < 8) top = Math.min(window.innerHeight - h - 8, r.bottom + 10);
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.max(8, Math.round(top)) + 'px';
  }
  function rpShow() {
    var b = heroRaiseBounds();
    if (!b) return;
    rpSet(heroRaiseAmount() / b.bb);
    $('raise-pop').classList.remove('hidden');
    rpPlace();
    $('rp-num').focus();
  }
  // Confirm: the typed amount becomes the raise and is made now (the long press is the explicit intent).
  function rpCommit() {
    if (!rpCheck()) return;
    var b = heroRaiseBounds();
    if (!b) return;
    var v = Number($('rp-num').value);
    rpClose();
    setHeroRaise(v * b.bb);
    submit('raise');
  }
  function lpCancel() {
    clearTimeout(lpTimer);
    lpTimer = null;
    els.btnRaise.classList.remove('lp-arming');
  }
  function canAct() {
    return game === 'hands' ? !!(tbl && tbl.heroTurn && scenario && !answered) : !!scenario && !answered;
  }
  function updateControls() {
    var ready = canAct();
    var freeCheck = isTable() && tbl && tbl.session && window.PokerGame && window.PokerGame.legal(tbl.session, 0)
      ? window.PokerGame.legal(tbl.session, 0).toCall === 0
      : (scenario ? Number(scenario.toCall) === 0 : false);
    // Fold stays clickable when Check is free (the move is never the best one): it is only dimmed (.is-free-check)
    els.btnFold.disabled = !ready;
    els.btnFold.classList.toggle('is-free-check', !!ready && !!freeCheck);
    els.btnCall.disabled = !ready;
    els.btnRaise.disabled = !ready || !raiseReady || !raiseLegalNow();
    var callAmt = scenario ? Number(scenario.toCall) : 0;
    // Full hands with no decision open (bots act, next hand dealt): no stale label from the previous hand.
    els.callLabel.textContent = !scenario && game === 'hands' ? '' : callAmt > 0 ? t('btn.callAmt', { x: fmtBB(callAmt) }) : t('btn.check');
    if (game === 'hands' && isTable()) renderRaiseCtl();
    else {
      // Exam, Practice and Single spots: no amount controls; Raise is the standard size.
      $('raise-ctl').classList.add('hidden');
      var raiseStd = scenario && raiseReady ? sizeFor(scenario, null) : null;
      var stdBet = !!scenario && Number(scenario.toCall) === 0 && scenario.street !== 'preflop';
      els.raiseLabel.textContent = raiseStd ? t(stdBet ? 'btn.betTo' : 'btn.raiseTo', { x: fmtBB(raiseStd.amount) }) : t('btn.raise');
    }
    els.feedback.classList.toggle('hidden', !answered || isTable()); // Quick game: table only, no coaching card
    if (!answered || isTable()) closeDrawer(false);

    els.nextLabel.textContent = t('btn.ok');
    els.btnNext.classList.toggle('hidden', game === 'hands' && !(tbl && tbl.awaitingOk));
  }

  /* ---------- feedback ---------- */
  function chip(text, cls) { return el('span', 'chip ' + (cls || ''), text); }
  // Rows are keyed by the engine's stable row.key, so Spanish and English show the same rows.
  // Labels are used only for rows that arrive without a key.
  // Engine row keys (preflop and postflop). table, chart, villain and texture are context rows: not shown in the compact table.
  var COMPACT_SKIP_KEYS = { table: true, chart: true, villain: true, texture: true };
  var STAT_KEY_I18N = {
    hand: 'row.hand', win_chance: 'row.winChance', pot_odds: 'row.potOdds', percentile: 'row.percentile',
    outs: 'row.outs', ev: 'row.evs', win_random: 'row.winRandom', draw: 'row.drawChance'
  };
  // Feature-detected engine fields: a number or an object with pct; fractions (<=1) are scaled to percent.
  function pctOf(v) {
    var n = v && typeof v === 'object' ? Number(v.pct) : Number(v);
    if (v == null || v === '' || !isFinite(n)) return null;
    return Math.round((n <= 1 ? n * 100 : n) * 10) / 10;
  }
  function compactRows(rows) {
    return (rows || []).filter(function (r) {
      if (!r) return false;
      var skip = r.key ? COMPACT_SKIP_KEYS[r.key] : COMPACT_SKIP[r.label];
      return !skip && String(r.value == null ? '' : r.value).indexOf('n/a') !== 0;
    }).slice(0, 8).map(function (r) {
      var v = String(r.value == null ? '' : r.value);
      if (v === 'In position') v = t('pos.in');
      else if (v === 'Out of position') v = t('pos.out');
      var label;
      if (r.key) label = STAT_KEY_I18N[r.key] ? t(STAT_KEY_I18N[r.key]) : String(r.label || r.key);
      else label = STAT_KEY[r.label] ? t(STAT_KEY[r.label]) : String(r.label || '');
      return { label: label, value: v };
    });
  }
  // Short explanation on the card (first three lines, simple words); the whole list goes to the Full explanation drawer.
  var fxLines = [];
  function renderExplanation(lines, full) {
    var shortLines = lines.length ? lines : [t('fb.none')];
    fxLines = full && full.length ? full : shortLines;
    els.explanation.textContent = '';
    els.explanation.classList.remove('expanded');
    shortLines.slice(0, 3).forEach(function (line) { els.explanation.appendChild(el('li', null, String(line))); });
    els.feedback.classList.remove('expanded');
    els.btnMore.classList.remove('hidden'); // always there for a verdict: showing it later would move the card
    setMoreLabel(drawerOpen());
    if (drawerOpen()) renderDrawerBody();
  }
  // "Full explanation" exists twice: in the desktop Why card and in the phone strip. Both open the same drawer.
  function setMoreLabel(open) {
    var label = t('fb.fullExplain');
    [els.btnMore, els.btnMoreStrip, document.getElementById('fb-full')].forEach(function (b) {
      if (!b) return;
      b.textContent = label;
      b.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }
  // Full explanation drawer: a fixed panel over the table (no layout effect, F/C/R and OK never move).
  // Closes with its button, Escape or a click outside. "Always show" is remembered per browser.
  var FX_ALWAYS_KEY = 'pt.fullExplainAlways';
  function fxAlways() { try { return localStorage.getItem(FX_ALWAYS_KEY) === '1'; } catch (e) { return false; } }
  function fxSetAlways(v) { try { localStorage.setItem(FX_ALWAYS_KEY, v ? '1' : '0'); } catch (e) { /* private mode: the choice lasts this page only */ } }
  var fxEl = null;
  function drawerOpen() { return !!fxEl && !fxEl.classList.contains('hidden'); }
  function renderDrawerBody() {
    var body = fxEl.querySelector('#fx-body');
    body.textContent = '';
    fxLines.forEach(function (line) { body.appendChild(el('p', 'fx-line', String(line))); });
  }
  function ensureDrawer() {
    if (fxEl) return fxEl;
    var d = el('div', 'fx-drawer hidden');
    d.id = 'fx-drawer';
    var box = el('div', 'fx-box');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'false');
    box.setAttribute('aria-labelledby', 'fx-title');
    var head = el('div', 'fx-head');
    var title = el('h3', null, t('fb.fullExplain'));
    title.id = 'fx-title';
    var close = el('button', 'ghost small fx-close', t('btn.close'));
    close.type = 'button';
    close.id = 'fx-close';
    head.appendChild(title);
    head.appendChild(close);
    var body = el('div', 'fx-body');
    body.id = 'fx-body';
    var always = el('label', 'fx-always');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'fx-always';
    cb.checked = fxAlways();
    cb.addEventListener('change', function () { fxSetAlways(cb.checked); });
    always.appendChild(cb);
    always.appendChild(el('span', null, t('fb.alwaysFull')));
    box.appendChild(head);
    box.appendChild(body);
    box.appendChild(always);
    d.appendChild(box);
    d.addEventListener('click', function (e) { if (e.target === d) closeDrawer(false); });
    close.addEventListener('click', function () { closeDrawer(true); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && drawerOpen()) { e.preventDefault(); closeDrawer(true); }
    });
    document.body.appendChild(d);
    fxEl = d;
    return d;
  }
  // focus: move focus into the drawer (button press) or leave it alone (automatic opening during play).
  function openDrawer(focus) {
    if (!answered) return;
    var d = ensureDrawer();
    renderDrawerBody();
    d.classList.remove('hidden');
    setMoreLabel(true);
    if (focus) d.querySelector('#fx-close').focus();
  }
  function closeDrawer(focusBack) {
    if (!fxEl || fxEl.classList.contains('hidden')) return;
    fxEl.classList.add('hidden');
    setMoreLabel(false);
    // Focus goes to the primary OK/Next button, so Enter continues the hand instead of reopening the drawer.
    if (focusBack && els.btnNext && !els.btnNext.classList.contains('hidden')) els.btnNext.focus();
    else if (focusBack && els.btnMore && !els.btnMore.classList.contains('hidden')) els.btnMore.focus();
  }
  function toggleMore() {
    if (drawerOpen()) closeDrawer(true); else openDrawer(true);
  }
  // Sentences of one explanation text (the PokerReview text), used as the short and the full lines.
  function rvSentences(s) {
    return String(s || '').split(/(?<=[.!?])\s+/).filter(function (x) { return x.trim(); });
  }
  function renderPracticeFeedback(sc, act, result) {
    var verdict = els.verdict;
    // Review rating (review.js): badge, explanation and toast all come from the same rating.
    var std = sizeFor(sc, null);
    lastRv = rvRate(sc, act, act === 'raise' && std ? std.amount : null);
    var key = lastRv ? lastRv.rating : result.rating;
    verdict.className = 'verdict rating-' + key;
    verdict.textContent = '';
    var head = el('div', 'v-head');
    // Big rating icon (shape + colour) and one headline: "Great fold" (ES: "Genial: retirarse").
    var vicon = el('span', 'v-icon');
    var ui = window.PokerReviewUI;
    var svg = ui && typeof ui.icon === 'function' ? ui.icon(key, { size: 64 }) : null;
    if (svg) vicon.appendChild(svg); else vicon.appendChild(rvBadge(key));
    head.appendChild(vicon);
    var actKey = act === 'call' && sc && Number(sc.toCall) <= 0 ? 'check' : act;
    var actWord = String(t('btn.' + actKey) || actKey).toLowerCase();
    // PokerReview tiers (review.js): one headline, one short text, the full list. Older builds: the rating name + action.
    var tiers = lastRv && lastRv.text && lastRv.text.short ? lastRv.text : null;
    var headline = tiers && tiers.headline ? rvText(tiers.headline) : (lang() === 'es' ? rvRatingLabel(key) + ': ' + actWord : rvRatingLabel(key) + ' ' + actWord);
    var vsum = el('span', 'v-summary', headline); vsum.title = result.summary || headline; head.appendChild(vsum);
    verdict.appendChild(head);
    var meta = el('div', 'v-meta');
    if (result.best) meta.appendChild(chip(t('chip.best', { m: moveText(result.best, sizeFor(sc, result), sc) }), 'chip-best'));
    meta.appendChild(chip(t('chip.score', { s: Math.round(result.score) }), 'chip-score'));
    meta.appendChild(chip(Math.round(result.score) + '%', 'chip-pct')); // short form for the phone strip
    // Always visible on desktop (the Why card is hidden in the compact popup); the phone strip has its own button.
    var fullBtn = el('button', 'ghost small fb-full', t('fb.fullExplain'));
    fullBtn.type = 'button';
    fullBtn.id = 'fb-full';
    fullBtn.setAttribute('aria-expanded', drawerOpen() ? 'true' : 'false');
    fullBtn.addEventListener('click', toggleMore);
    meta.appendChild(fullBtn);
    verdict.appendChild(meta);

    // Card: the short text. Drawer: the short text and then the full bullets (no sentence splitting when the tiers exist).
    var lines = tiers ? [rvText(tiers.short)] : lastRv ? rvSentences(rvText(lastRv.text)) : (Array.isArray(result.why) && result.why.length ? result.why : (result.explanation || [])).map(String);
    if (result.handLabel) lines = [String(result.handLabel)].concat(lines);
    if (!lastRv && result.positionNote) lines = lines.concat([String(result.positionNote)]);
    if (!lastRv && result.tip) lines = lines.concat([String(result.tip)]);
    var full = tiers && Array.isArray(tiers.full) ? lines.concat(tiers.full.map(function (x) { return rvText(x); })) : null;
    renderExplanation(lines, full);
    if (fxAlways()) openDrawer(false); // "Always show full explanation" is on: the drawer opens with each verdict

    els.statsTable.textContent = '';
    var extra = [];
    var wr = pctOf(result.winPctRandom);
    if (wr !== null) extra.push({ key: 'win_random', label: t('row.winRandom'), value: wr + '%' });
    var dc = pctOf(result.drawChance);
    if (dc !== null) extra.push({ key: 'draw', label: t('row.drawChance'), value: dc + '%' });
    compactRows((result.stats || []).concat(extra)).forEach(function (row) {
      var tr = el('tr');
      tr.appendChild(el('td', null, row.label));
      tr.appendChild(el('td', 'v', row.value));
      els.statsTable.appendChild(tr);
    });
  }
  function scoreClass(score) {
    return score >= 80 ? 'good' : score >= 50 ? 'mid' : 'bad';
  }
  // Re-requests the explanation text in the current language (the graded numbers are kept).
  function refreshAnswerText() {
    if (!answered || !scenario || mode !== 'practice') return;
    try {
      var fresh = eng().evaluate(scenario, answered.action, answered.amount, { lang: lang(), samples: 800 });
      validateResult(fresh);
      answered.result.summary = fresh.summary;
      answered.result.explanation = fresh.explanation;
      answered.result.stats = fresh.stats;
    } catch (e) { console.error('explanation refresh failed', e); }
    renderPracticeFeedback(scenario, answered.action, answered.result);
  }

  /* ---------- range helper ---------- */
  function normalizeSpot(s) {
    if (typeof s === 'string') return { position: s, facing: 'open' };
    if (!s || typeof s !== 'object' || !s.position) return null;
    return { position: String(s.position), facing: String(s.facing || 'open') };
  }
  function uniq(arr) {
    return arr.filter(function (v, i) { return arr.indexOf(v) === i; });
  }
  function fillSelect(select, values, current, labelFn) {
    select.textContent = '';
    values.forEach(function (v) {
      var o = el('option', null, labelFn ? labelFn(v) : v);
      o.value = v;
      select.appendChild(o);
    });
    select.value = values.indexOf(current) >= 0 ? current : (values[0] || '');
    return select.value;
  }
  function loadHelperSpots(players) {
    try {
      var raw = eng().listChartSpots(players);
      helperSpots = (Array.isArray(raw) ? raw : []).map(normalizeSpot).filter(Boolean);
    } catch (e) {
      console.error('listChartSpots failed', e);
      helperSpots = [];
    }
  }
  // Chart facing from the real preflop history (same rule as the feedback): the strongest action before the hero.
  function helperFacingOf(sc) {
    if (!sc || sc.street !== 'preflop' || !Array.isArray(sc.seats)) return 'open';
    var lvl = 0;
    sc.seats.forEach(function (s) {
      if (s.isHero) return;
      var r = s.preflopRole;
      if (r === '3bet' || r === '4bet' || r === '5bet') lvl = Math.max(lvl, 3);
      else if (r === 'open') lvl = Math.max(lvl, 2);
      else if (r === 'limp') lvl = Math.max(lvl, 1);
    });
    return lvl === 3 ? 'vs_3bet' : lvl === 2 ? 'vs_raise' : lvl === 1 ? 'vs_limp' : 'open';
  }
  function helperDefaultsFor(sc) {
    var players = sc ? (sc.numPlayers || sc.seats.length) : 6;
    var position = sc && sc.heroPosition ? sc.heroPosition : '';
    var facing = helperFacingOf(sc);
    return { players: players, position: position, facing: facing };
  }
  function renderHelperControls(preferred) {
    var players = Number(els.helperPlayers.value || preferred.players);
    loadHelperSpots(players);
    var positions = uniq(helperSpots.map(function (s) { return s.position; }));
    var pos = fillSelect(els.helperPosition, positions, preferred.position, posName);
    var facings = uniq(helperSpots.filter(function (s) { return s.position === pos; }).map(function (s) { return s.facing; }));
    var facing = fillSelect(els.helperFacing, facings, preferred.facing, function (f) { return t('facing.' + f); });
    helperSel = { players: players, position: pos, facing: facing };
  }
  function helperNormalizeCell(v) {
    var f = { raise: 0, call: 0, fold: 0 };
    if (typeof v === 'string') {
      var s = v.toLowerCase();
      if (s.indexOf('raise') >= 0 || s.indexOf('bet') >= 0) f.raise = 1;
      else if (s.indexOf('call') >= 0) f.call = 1;
      else f.fold = 1;
      return f;
    }
    if (v && typeof v === 'object') {
      f.raise = Math.max(0, num(v.raise));
      f.call = Math.max(0, num(v.call));
      f.fold = Math.max(0, num(v.fold));
    }
    var total = f.raise + f.call + f.fold;
    if (total <= 0) { f.fold = 1; return f; }
    f.raise /= total; f.call /= total; f.fold /= total;
    return f;
  }
  function handNotation(row, col) {
    if (row === col) return RANKS[row] + RANKS[col];
    if (row < col) return RANKS[row] + RANKS[col] + 's';
    return RANKS[col] + RANKS[row] + 'o';
  }
  function heroGridCell() {
    if (!scenario || !scenario.hero || scenario.hero.length !== 2) return null;
    var a = scenario.hero[0], b = scenario.hero[1];
    if (typeof a !== 'string' || typeof b !== 'string' || a.length < 2 || b.length < 2) return null;
    var r1 = RANKS.indexOf(a.charAt(0).toUpperCase() === 'T' ? 'T' : a.charAt(0).toUpperCase());
    var r2 = RANKS.indexOf(b.charAt(0).toUpperCase() === 'T' ? 'T' : b.charAt(0).toUpperCase());
    if (r1 < 0 || r2 < 0) return null;
    var hi = Math.min(r1, r2), lo = Math.max(r1, r2);
    var suited = a.charAt(1).toLowerCase() === b.charAt(1).toLowerCase();
    if (hi === lo) return { row: hi, col: hi };
    return suited ? { row: hi, col: lo } : { row: lo, col: hi };
  }
  function drawHelper() {
    if (mode !== 'practice') return;
    els.helperGrid.textContent = '';
    els.helperNote.textContent = '';
    if (!helperSel || !helperSel.position) {
      els.helperNote.textContent = t('ranges.none');
      return;
    }
    var chart;
    try {
      // Same stack depth as the feedback chart advice (scenario heroStack), so both use one chart.
      var stackBB = scenario && scenario.heroStack != null ? scenario.heroStack : 100;
      chart = eng().getRangeChart(helperSel.players, helperSel.position, helperSel.facing, { lang: lang(), stackBB: stackBB });
    } catch (e) {
      console.error('getRangeChart failed', e);
      els.helperNote.textContent = t('ranges.unavailable', { m: errMsg(e) });
      return;
    }
    var grid = chart && (chart.grid || chart.cells || chart);
    if (!Array.isArray(grid) || grid.length !== 13 || !grid.every(function (row) { return Array.isArray(row) && row.length === 13; })) {
      els.helperNote.textContent = t('ranges.none');
      return;
    }
    var hero = heroGridCell();
    els.helperGrid.appendChild(el('div', 'rg-corner'));
    RANKS.split('').forEach(function (r) { els.helperGrid.appendChild(el('div', 'rg-head', r)); });
    for (var row = 0; row < 13; row++) {
      els.helperGrid.appendChild(el('div', 'rg-head', RANKS.charAt(row)));
      for (var col = 0; col < 13; col++) {
        var f = helperNormalizeCell(grid[row][col]);
        var name = handNotation(row, col);
        var cell = el('div', 'rg-cell' + (hero && hero.row === row && hero.col === col ? ' hero' : ''));
        // the label sits on its own dark tag: no ink reaches 4.5:1 on all three stops (fold is dark, call is light)
        cell.appendChild(el('span', 'rg-label', name));
        var p1 = Math.round(f.raise * 100), p2 = Math.round((f.raise + f.call) * 100);
        cell.style.background = 'linear-gradient(to right, ' +
          CHART_COLORS.raise + ' 0 ' + (f.raise * 100) + '%, ' +
          CHART_COLORS.call + ' ' + (f.raise * 100) + '% ' + ((f.raise + f.call) * 100) + '%, ' +
          CHART_COLORS.fold + ' ' + ((f.raise + f.call) * 100) + '% 100%)';
        cell.title = name + ': ' + p1 + '% / ' + (p2 - p1) + '% / ' + (100 - p2) + '%';
        els.helperGrid.appendChild(cell);
      }
    }
    els.helperNote.textContent = t('chart.title', {
      pos: posName(helperSel.position), n: helperSel.players, facing: t('facing.' + helperSel.facing)
    }) + (hero ? '' : ' · ' + t('chart.notInGrid'));
    var w = winPctText();
    if (w) els.helperNote.textContent += ' · ' + w;
  }
  // Guide only: win % vs random opponent cards, from the hero's cards and the board so far.
  function winPctText() {
    var e = eng();
    if (!scenario || !scenario.hero || scenario.hero.length !== 2 || !helperSel || !e || typeof e.randomWinPct !== 'function') return '';
    try {
      var activeOpp = (scenario.seats || []).filter(function (s) { return !s.isHero && !s.folded; }).length;
      var r = e.randomWinPct(scenario.hero, scenario.board || [], Math.max(1, activeOpp));
      var pct = r ? Number(r.pct) : NaN;
      if (!isFinite(pct)) return '';
      return t('ranges.win', { p: pct.toFixed(1) });
    } catch (err) { return ''; }
  }
  function onHelperPlayersChange() {
    renderHelperControls({ players: Number(els.helperPlayers.value), position: els.helperPosition.value, facing: els.helperFacing.value });
    drawHelper();
  }
  function onHelperPositionChange() {
    renderHelperControls({ players: Number(els.helperPlayers.value), position: els.helperPosition.value, facing: '' });
    drawHelper();
  }
  function onHelperFacingChange() {
    helperSel.facing = els.helperFacing.value;
    drawHelper();
  }
  function populateHelperPlayers() {
    fillSelect(els.helperPlayers, ['2', '3', '4', '5', '6', '7', '8', '9'], '6', function (v) { return t('players.n', { n: v }); });
  }
  function initHelper() {
    if (!helperAvailable()) {
      els.btnRanges.classList.add('hidden');
      els.helperPanel.classList.add('hidden');
      return;
    }
    populateHelperPlayers();
    if (helperSel) renderHelperControls(helperSel);
    else renderHelperControls({ players: 6, position: '', facing: '' });
    drawHelper();
  }
  function resetHelperForHand(sc) {
    if (!helperAvailable() || mode !== 'practice') return;
    var d = helperDefaultsFor(sc);
    els.helperPlayers.value = String(d.players);
    renderHelperControls(d);
    drawHelper();
  }

  /* ---------- stats ---------- */
  function bump(map, key, correct, score) {
    var k = key || '?';
    var row = map[k] || (map[k] = { n: 0, correct: 0, score: 0 });
    row.n += 1;
    if (correct) row.correct += 1;
    row.score += score;
  }
  function recordStats(sc, result, bucket) {
    var score = Math.max(0, Math.min(100, num(result.score)));
    bucket.hands += 1;
    if (result.correct) bucket.correct += 1;
    bucket.scoreSum += score;
    bucket.streak = result.correct ? bucket.streak + 1 : 0;
    bucket.bestStreak = Math.max(bucket.bestStreak, bucket.streak);
    bump(bucket.byPosition, sc.heroPosition, !!result.correct, score);
    bump(bucket.byStreet, sc.street, !!result.correct, score);
    saveJSON(STORE.stats, stats);
  }
  // valueKind 'acc' shows accuracy, 'avg' shows average score.
  function renderBreakdown(container, map, order, valueKind) {
    container.textContent = '';
    var keys = order.filter(function (k) { return map[k] && map[k].n > 0; });
    Object.keys(map).forEach(function (k) {
      if (keys.indexOf(k) < 0 && map[k] && map[k].n > 0) keys.push(k);
    });
    if (!keys.length) {
      container.appendChild(el('p', 'empty-note', t('stats.none')));
      return;
    }
    keys.forEach(function (k) {
      var row = map[k];
      var pct = valueKind === 'avg' ? Math.round(row.score / row.n) : Math.round(100 * row.correct / row.n);
      var line = el('div', 'bd-row');
      line.appendChild(el('span', 'bd-name', k));
      var bar = el('div', 'bd-bar');
      var fill = el('div', 'bd-fill');
      fill.style.width = pct + '%';
      bar.appendChild(fill);
      line.appendChild(bar);
      line.appendChild(el('span', 'bd-val', pct + '% · ' + row.n));
      container.appendChild(line);
    });
  }
  function renderStats() {
    var s = curStats();
    if (!els.kpiHands) return; // the in-game stats pane is gone: statistics live in the Statistics sheet only
    els.statsTitle.textContent = statsTitleText();
    els.kpiHands.textContent = String(s.hands);
    els.kpiAcc.textContent = s.hands ? Math.round(100 * s.correct / s.hands) + '%' : '–';
    els.kpiStreak.textContent = String(s.streak);
    els.kpiBest.textContent = t('stats.best', { n: s.bestStreak });
    els.kpiScore.textContent = String(Math.round(s.scoreSum));
    els.kpiAvg.textContent = s.hands ? t('stats.avg', { n: Math.round(s.scoreSum / s.hands) }) : '';
    renderBreakdown(els.byPosition, s.byPosition, POS_ORDER, 'acc');
    renderBreakdown(els.byStreet, s.byStreet, STREET_ORDER, 'acc');
  }

  /* ---------- exam: continuous full hands, graded silently ---------- */
  function examNew() {
    return { count: 0, sum: 0, hands: 0, streak: 0, bestStreak: 0, records: [], handRecs: [], finished: false };
  }
  function examAvg() { return exam && exam.count ? Math.round(exam.sum / exam.count) : null; }
  // Best and worst spot: the position or street with the highest and the lowest average score.
  function examSpots(records) {
    var map = {};
    records.forEach(function (r) {
      [['p:' + r.pos, posName(r.pos) || '?'], ['s:' + r.street, streetName(r.street)]].forEach(function (k) {
        var row = map[k[0]] || (map[k[0]] = { label: k[1], n: 0, sum: 0 });
        row.n += 1;
        row.sum += r.score;
      });
    });
    var rows = Object.keys(map).map(function (k) { return { label: map[k].label, avg: map[k].sum / map[k].n }; });
    rows.sort(function (a, b) { return b.avg - a.avg; });
    return { best: rows[0] || null, worst: rows[rows.length - 1] || null };
  }
  function spotText(s) { return s ? s.label + ' · ' + Math.round(s.avg) + '%' : '–'; }
  // Live panel in the right sidebar and the Finish button: shown only while an exam runs.
  function renderExamLive() {
    var running = game === 'hands' && mode === 'exam' && !!exam && !exam.finished;
    els.btnFinishExam.classList.toggle('hidden', !running);
    if (!running || !els.xlHands) return;
    var avg = examAvg();
    var sp = examSpots(exam.records);
    els.xlHands.textContent = String(exam.hands);
    els.xlDecisions.textContent = String(exam.count);
    els.xlAvg.textContent = avg == null ? '–' : avg + '%';
    els.xlStreak.textContent = String(exam.streak);
    els.xlBest.textContent = spotText(sp.best);
    els.xlWorst.textContent = spotText(sp.worst);
  }
  // Silent grading: the decision is stored for the summary and the analysis; nothing is shown.
  function examRecord(sc, action, amount, result) {
    var score = Math.max(0, Math.min(100, num(result.score)));
    var lines = (Array.isArray(result.why) && result.why.length ? result.why : (result.explanation || [])).map(String);
    var mine = action === 'raise' ? sizeFor(sc, null) : null;
    var bestR = result.best === 'raise' ? sizeFor(sc, result) : null;
    exam.count += 1;
    exam.sum += score;
    exam.streak = result.correct ? exam.streak + 1 : 0;
    exam.bestStreak = Math.max(exam.bestStreak, exam.streak);
    exam.records.push({
      hand: exam.hands + 1, street: sc.street, pos: sc.heroPosition || '', players: sc.numPlayers || sc.seats.length,
      board: (sc.board || []).slice(), hero: sc.hero.slice(), toCall: sc.toCall,
      action: action, amount: mine ? mine.amount : undefined, allIn: !!(mine && mine.allIn),
      best: result.best || '', bestAmount: bestR ? bestR.amount : undefined, bestAllIn: !!(bestR && bestR.allIn),
      score: score, correct: !!result.correct, lang: lang(),
      text: { first: lines[0] || '', tip: result.tip ? String(result.tip) : '' },
      scn: JSON.parse(JSON.stringify(sc))
    });
  }
  function renderExamSummary() {
    var recs = exam.records;
    var avg = examAvg();
    els.sumAvg.textContent = avg == null ? '–' : avg + '%';
    els.sumHands.textContent = String(exam.hands);
    els.sumDecisions.textContent = String(recs.length);
    var sp = examSpots(recs);
    els.sumBest.textContent = spotText(sp.best);
    els.sumWorst.textContent = spotText(sp.worst);
    var posMap = {}, streetMap = {};
    recs.forEach(function (r) {
      bump(posMap, r.pos, r.correct, r.score);
      bump(streetMap, r.street, r.correct, r.score);
    });
    renderBreakdown(els.sumByPosition, posMap, POS_ORDER, 'avg');
    renderBreakdown(els.sumByStreet, streetMap, STREET_ORDER, 'avg');
  }
  /* ---------- review: PokerReview (logic, review.js) + PokerReviewUI (screens, review-ui.js) ----------
   * Defensive: without review-ui.js the screens fall back to plain text; without review.js nothing is rated. */
  function rvText(x) { return x ? (x[lang()] || x.en || '') : ''; }
  // Full action history of a finished hand for the replay (review-ui.js): seats with start stacks and cards,
  // the board, and every action (street, seat, action, amount, chips put in). All amounts in BB.
  function rvReplayOf(session) {
    try {
      var hand = session && session.hand;
      if (!hand || !hand.results) return null;
      var bb = hand.bb, wins = hand.results.wins || {};
      return {
        heroSeat: 0,
        btnSeat: hand.btnIdx,
        board: (hand.board || []).slice(),
        showdown: !!hand.results.showdown,
        seats: hand.seats.map(function (hs, i) {
          var ss = session.seats[i] || {};
          var put = (hs.contributed || 0) / bb;
          return {
            seat: i, name: ss.isHero ? "Hero" : (ss.name || ("Seat " + (i + 1))), isHero: !!ss.isHero, dealt: !!hs.dealt,
            startBB: (ss.stack || 0) / bb + put - (wins[i] || 0) / bb, folded: !!hs.folded, cards: (hs.cards || []).slice(), pos: hs.pos || ""
          };
        }),
        history: (hand.history || []).map(function (e) { return Object.assign({}, e); })
      };
    } catch (e) { console.error("replay record failed", e); return null; }
  }
  function rvHandRecord(session) {
    try {
      var rec = window.PokerReview ? window.PokerReview.handRecordFromGame(session) : null;
      if (rec) rec.replay = rvReplayOf(session);
      return rec;
    }
    catch (e) { console.error('hand record failed', e); return null; }
  }
  // A hand still running when the exam is finished: its decisions so far (no result, so no luck).
  function rvUnfinishedRecord(session) {
    var hand = session && session.hand;
    if (!hand || hand.results || !hand.heroDecisions || !hand.heroDecisions.length) return null;
    return { decisions: hand.heroDecisions.map(function (d) {
      return { scenario: d.scenario, action: d.action, amountBB: d.raiseAmount == null ? undefined : d.raiseAmount };
    }) };
  }
  // Luck for one hand: only 'Bad luck' and 'Lucky' are shown; null for every other label.
  function rvLuckOf(hr) {
    try {
      var luck = window.PokerReview && hr ? window.PokerReview.reviewHand(hr).luck : null;
      return luck && (luck.label === 'bad_luck' || luck.label === 'lucky') ? luck : null;
    } catch (e) { console.error('luck failed', e); return null; }
  }
  function rvLuckLi(luck) {
    var li = el('li', 'rv-luck-line');
    var chip = el('span', 'rv-luck ' + (luck.label === 'lucky' ? 'lucky' : 'bad'), t(luck.label === 'lucky' ? 'rv.lucky' : 'rv.badLuck'));
    chip.title = rvText(luck.text);
    li.appendChild(chip);
    return li;
  }
  // Rating of one hero decision (same numbers as the review). amountBB is the raise-to in BB, or null.
  function rvRate(sc, action, amountBB) {
    try {
      if (!window.PokerReview || !sc) return null;
      return window.PokerReview.rateDecision(sc, action === 'raise' && amountBB != null ? { action: 'raise', amountBB: amountBB } : action);
    } catch (e) { console.error('rating failed', e); return null; }
  }
  // The one source of rating labels: never a raw i18n key (rating.great etc.), always a readable name.
  function rvRatingLabel(key) {
    var ui = window.PokerReviewUI;
    var name = ui && typeof ui.ratingName === 'function' ? ui.ratingName(key, lang()) : '';
    return name || String(key || '');
  }
  function rvBadge(key) {
    var ui = window.PokerReviewUI;
    if (ui && typeof ui.badge === 'function') { try { var b = ui.badge(key, { label: rvRatingLabel(key) }); if (b) return b; } catch (e) { console.error('badge failed', e); } }
    return el('span', 'v-badge rating-' + key, rvRatingLabel(key));
  }
  // Short rating toast over the hero seat for 1.5 s. It is a fixed overlay: no layout shift, no button moves.
  function rvToast(rv) {
    if (!rv || !rv.rating) return;
    try {
      var ui = window.PokerReviewUI;
      var node = ui && typeof ui.toast === 'function' ? ui.toast(rv.rating, rvText(rv.headline)) : null;
      if (!node) node = el('div', 'rv-toast rating-' + rv.rating, rvText(rv.headline));
      node.style.position = 'fixed';
      node.style.zIndex = '1500';
      node.style.pointerEvents = 'none';
      node.style.transform = 'translate(-50%, -100%)';
      node.style.bottom = 'auto'; // the review CSS pins bottom: 20px; with a top set, that stretched the box
      var seat = els.seats && els.seats.children[0];
      var r = seat && seat.getBoundingClientRect ? seat.getBoundingClientRect() : null;
      node.style.left = (r ? r.left + r.width / 2 : window.innerWidth / 2) + 'px';
      node.style.top = (r ? r.top - 6 : window.innerHeight / 2) + 'px';
      document.body.appendChild(node);
      // keep it on screen: above the hero seat when there is room, else just below it
      if (node.getBoundingClientRect().top < 8) { node.style.transform = 'translate(-50%, 0)'; node.style.top = (r ? r.bottom + 6 : 8) + 'px'; }
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 1500);
    } catch (e) { console.error('rating toast failed', e); }
  }
  // Whole-game review of a list of hand records (PokerReview.reviewGame).
  function rvGameReview(recs) {
    try {
      if (!window.PokerReview) return null;
      var g = window.PokerReview.reviewGame(recs || []);
      // the UI draws cards and pot from each decision's engine scenario (review results do not carry it)
      (g.hands || []).forEach(function (h, hi) {
        var src = recs[hi] && recs[hi].decisions || [];
        (h.decisions || []).forEach(function (d, i) { if (src[i]) d.scenario = src[i].scenario; });
        if (recs[hi] && recs[hi].replay) h.replay = recs[hi].replay;
      });
      return g;
    } catch (e) { console.error('review failed', e); return null; }
  }
  var rvScreen = null; // the open review screen ({destroy}), released on close
  function closeReviewOverlay() {
    if (rvScreen && rvScreen.destroy) { try { rvScreen.destroy(); } catch (e) { console.error('review destroy failed', e); } }
    rvScreen = null;
    var old = document.getElementById('rv-overlay');
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }
  // Full-screen review: the one place with internal scroll. Close removes it and returns to the summary or table.
  function openReviewOverlay(g) {
    closeReviewOverlay();
    var ov = el('div', 'rv-overlay');
    ov.id = 'rv-overlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.style.cssText = 'position:fixed;inset:0;z-index:1400;overflow:hidden;box-sizing:border-box;';
    var body = el('div', 'rv-body');
    ov.appendChild(body);
    document.body.appendChild(ov);
    var close = function () { closeReviewOverlay(); };
    if (!g) { body.appendChild(el('p', 'empty-note', t('stats.none'))); }
    else if (window.PokerReviewUI && typeof window.PokerReviewUI.renderGame === 'function') {
      try { rvScreen = window.PokerReviewUI.renderGame(body, g, { lang: lang(), onClose: close }) || null; }
      catch (e) { console.error('review screen failed', e); body.textContent = ''; rvPlainReview(body, g, close); }
    } else rvPlainReview(body, g, close);
    return ov;
  }
  // Plain-text review (no review-ui.js): one line per decision with its rating and explanation.
  function rvPlainReview(body, g, close) {
    body.appendChild(el('h2', null, t('rv.reviewGame')));
    body.appendChild(el('p', null, t('rv.accuracy', { p: g.accuracy == null ? '–' : g.accuracy })));
    if (g.luckText) body.appendChild(el('p', 'rv-luck-text', rvText(g.luckText)));
    var n = 0;
    g.hands.forEach(function (h) {
      h.decisions.forEach(function (d) {
        n += 1;
        body.appendChild(el('p', 'rv-line', n + ' · ' + streetName(d.street) + ' · ' + rvRatingLabel(d.rating) + ' · ' + rvText(d.text)));
      });
    });
    var btn = el('button', 'big btn-call', t('rv.close'));
    btn.type = 'button';
    btn.addEventListener('click', close);
    body.appendChild(btn);
  }
  function startNewExam() {
    exam = examNew();
    handsNewSession();
  }
  function finishExam() {
    if (!exam || exam.finished) return;
    handsClearTimer();
    progressEndSession();
    exam.finished = true;
    // the hand cut short by Finish still counts in the review: its decisions are in the exam records
    var partial = tbl && tbl.session ? rvUnfinishedRecord(tbl.session) : null;
    if (partial) exam.handRecs.push(partial);
    tbl = null;
    scenario = null;
    answered = null;
    winnerSeats = null;
    clearError();
    clearTable();
    els.feedback.classList.add('hidden');
    renderExamSummary();
    applyModeVisibility();
    updateControls();
    window.scrollTo(0, 0);
  }

  /* ---------- mode ---------- */
  function applyModeVisibility() {
    var handsOn = game === 'hands';
    var inExam = handsOn && mode === 'exam' && !!exam;
    var examEnd = inExam && exam.finished;
    var practice = mode === 'practice';

    // Every solo mode: the table has the full width. The only extra panel (Ranges, practice) is a drawer, closed by default.
    $('view-game').classList.add('no-side');
    document.body.classList.add('drawer-ok');
    els.practiceArea.classList.toggle('hidden', examEnd);
    els.examSummary.classList.toggle('hidden', !examEnd);
    els.fbPractice.classList.toggle('hidden', inExam);
    renderExamLive();
    tableSyncView();

    els.cpuResult.classList.toggle('hidden', !(handsOn && tbl && tbl.handOver));

    // Ranges: button in practice only; the panel opens/closes on demand.
    var rangesOk = practice && helperAvailable();
    els.btnRanges.classList.toggle('hidden', !rangesOk);
    els.helperPanel.classList.toggle('hidden', !rangesOk);
    // Leaving practice closes the Ranges drawer (it is no longer offered).
    if (!rangesOk && sideOpen()) setRangesDrawer(false);
    els.btnRanges.setAttribute('aria-expanded', rangesOpen && rangesOk ? 'true' : 'false');

    Array.prototype.forEach.call(els.modeBtns, function (b) {
      var on = b.dataset.mode === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    Array.prototype.forEach.call(els.gameBtns, function (b) {
      var on = b.dataset.game === game;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function renderLangButtons() {
    var cur = lang();
    Array.prototype.forEach.call(els.langBtns, function (b) {
      var on = b.dataset.lang === cur;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  // Quick spots have no exam: the exam is full hands only.
  // In-app popup (PokerAsk, mp.js) instead of window.confirm. Fail-safe: without it nothing is done.
  function askConfirm(title, ok, go) {
    if (window.PokerAsk) window.PokerAsk({ title: title, ok: ok, danger: true, onOk: go });
  }
  function setMode(next) {
    if (next === mode) return;
    if (mode === 'table') tableLeave();
    if (next === 'exam' && game === 'spots') return;
    if (mode === 'exam' && exam && !exam.finished) {
      askConfirm(t('exam.leave'), t('leave.go'), function () { setModeNow(next); });
      return;
    }
    setModeNow(next);
  }
  function setModeNow(next) {
    if (mode === 'exam') exam = null;
    mode = next;
    saveJSON(STORE.mode, mode);
    applyRange(rangeKeyNow());
    if (game === 'hands') { handsSubmodeChanged(); return; }
    scenario = null;
    answered = null;
    raiseReady = false;
    clearError();
    clearTable();
    els.feedback.classList.add('hidden');
    renderStats();
    applyModeVisibility();
    if (mode === 'practice') newHand();
    else updateControls();
  }
  function setGame(next) {
    if (next === game) return;
    if (mode === 'table') tableLeave();
    if (mode === 'exam' && exam && !exam.finished) {
      askConfirm(t('exam.leave'), t('leave.go'), function () { setGameNow(next); });
      return;
    }
    setGameNow(next);
  }
  function setGameNow(next) {
    if (mode === 'exam') {
      exam = null;
      if (next === 'spots') { mode = 'practice'; saveJSON(STORE.mode, mode); }
    }
    game = next;
    saveJSON(STORE.game, game);
    applyRange(rangeKeyNow());
    clearError();
    scenario = null;
    answered = null;
    raiseReady = false;
    els.feedback.classList.add('hidden');
    clearTable();
    if (game === 'hands') { handsEnter(); return; }
    handsClearTimer();
    if (tbl) tbl.heroTurn = false;
    renderStats();
    applyModeVisibility();
    if (mode === 'practice') newHand();
    else updateControls();
  }

  /* ---------- quick spots flow ---------- */
  // Spot options from Settings. A random street is drawn uniformly (not mostly preflop).
  function buildGenOpts() {
    var o = { lang: lang() };
    var n = settings.pmin + Math.floor(Math.random() * (settings.pmax - settings.pmin + 1));
    var pos = settings.position !== 'random' ? settings.position : null;
    // money on: every player has their own stack (the engine draws short, medium, deep and covering stacks)
    o.stacks = settings.money && settings.stacks !== 'equal' ? 'varied' : 'equal';
    if (settings.street !== 'any') o.street = settings.street;
    else o.street = STREET_ORDER[Math.floor(Math.random() * STREET_ORDER.length)];
    if (pos && n == null) {
      var P = enginePositions();
      var sizes = Object.keys(P).map(Number).filter(function (k) { return P[k].indexOf(pos) >= 0; });
      if (sizes.length) n = sizes[Math.floor(Math.random() * sizes.length)];
    }
    if (n != null) o.players = n;
    if (pos) o.position = pos;
    return o;
  }
  // The engine may not honour `position` yet; retry a few times so the chosen seat is shown.
  function generateForSettings(opts) {
    var sc = null;
    for (var i = 0; i < 40; i++) {
      sc = eng().generateScenario(opts);
      if (!opts.position || sc.heroPosition === opts.position) break;
    }
    return sc;
  }
  function newHand() {
    if (game === 'hands') { handsNext(); return; }
    clearError();
    answered = null;
    scenario = null;
    raiseReady = false;
    els.feedback.classList.add('hidden');

    if (!eng() || typeof eng().generateScenario !== 'function') {
      clearTable();
      showError(t('err.noEngine'), null);
      applyModeVisibility();
      updateControls();
      return;
    }
    var sc;
    try {
      sc = generateForSettings(buildGenOpts());
      validateScenario(sc);
    } catch (e) {
      console.error('generateScenario failed', e);
      clearTable();
      showError(t('err.deal', { m: errMsg(e) }), newHand);
      applyModeVisibility();
      updateControls();
      return;
    }
    scenario = sc;
    try {
      renderTable(sc, true, { deal: true }); // same deal as full hands: cards fly from the centre, hero flips, board follows
      setupRaise(sc);
      resetHelperForHand(sc);
    } catch (e) {
      console.error('render failed', e);
      showError(t('err.display', { m: errMsg(e) }), newHand);
    }
    applyModeVisibility();
    updateControls();
  }
  function submit(action) {
    if (game === 'hands') { handsSubmit(action); return; }
    if (!scenario || answered) return;
    if (action === 'raise' && !raiseReady) return;
    var amount;
    var result;
    try {
      result = gradeChoice(scenario, action);
      validateResult(result);
    } catch (e) {
      console.error('evaluate failed', e);
      showError(t('err.scoring', { m: errMsg(e) }), function () { submit(action); });
      return;
    }
    clearError();
    answered = { action: action, amount: amount, result: result };
    try { recordStats(scenario, result, curStats()); } catch (e) { console.error('stats not saved', e); }
    try { progressDecision(scenario, action, result); } catch (e) { console.error('progress not saved', e); }

    renderStats();
    updateControls();
    try { renderPracticeFeedback(scenario, action, result); } catch (e) { console.error('feedback failed', e); }
    rvToast(lastRv);
    els.btnNext.focus({ preventScroll: true });
  }
  function nextAction() {
    if (game === 'hands') {
      if (tbl && tbl.awaitingOk) { handsContinue(); return; }
      if (tbl && tbl.endPending) { tableFinish(tbl.endPending); return; }
      if (tbl && tbl.handOver) handsNext();
      return;
    }
    if (!answered) return;
    newHand();
  }

  /* ---------- quick game: one table of bots, played until someone is out of chips ---------- */
  // Settings (bots, progressive blinds) are remembered; a game is one whole session, no ratings or feedback.
  var TABLE_BB = 100;          // chips per base BB (game.js)
  var tableCfg = normalizeTableCfg(loadJSON(STORE.table, null));
  var tableRun = null;         // {hands, biggest, wins, net, ended, start} while a quick game is on; biggest/net in chips
  var tableFinishTimer = null;
  var tableEndRecs = [];       // hand records of the last quick game (its Analysis button)
  var lastRv = null;           // review rating of the last practice or single-spot answer (toast, badge)
  var tableNoticeTimer = null;
  // Chips per big blind of the hand in play (or the next one). Chips never change when blinds double:
  // the BB unit doubles, so every BB amount shown halves. Results are converted with the BB of their own hand.
  function tableBB() { return (tbl && tbl.session && tbl.session.cfg && tbl.session.cfg.bb) || TABLE_BB; }
  function handBB() { var h = tbl && tbl.session && tbl.session.hand; return (h && h.bb) || TABLE_BB; }
  function showTableNotice(msg) {
    var n = $('table-notice');
    if (!n) return;
    n.textContent = msg;
    n.classList.remove('hidden');
    clearTimeout(tableNoticeTimer);
    tableNoticeTimer = setTimeout(function () { n.classList.add('hidden'); }, 6000);
  }
  function normalizeTableCfg(v) {
    v = v || {};
    var b = Math.round(Number(v.bots));
    return { bots: isFinite(b) ? Math.max(1, Math.min(8, b)) : 3, prog: !!v.prog };
  }
  function isTable() { return mode === 'table' && !!tableRun; }
  function tableConfig() {
    return { cpus: tableCfg.bots, stackBB: settings.stack, noWalkover: true, money: settings.money,
      personalities: settings.personalities, stacks: 'equal', customStacks: settings.customStacks };
  }
  // Blinds of the next hand: with progressive blinds they double every 10 hands (capped at 16x).
  function tableDealSetup() {
    var prevBB = tableBB();
    var mult = Math.pow(2, tableCfg.prog ? Math.min(4, Math.floor(tableRun.hands / 10)) : 0);
    tbl.session.cfg.bb = TABLE_BB * mult;
    tbl.session.cfg.sb = (TABLE_BB / 2) * mult;
    if (tbl.session.cfg.bb > prevBB) showTableNotice(t('table.doubled'));
    return {};
  }
  // Hero action in the quick game: applied silently, the hand simply goes on.
  function tableAct(action) {
    var hrec = action === 'raise' ? heroRaiseRecord() : null;
    var rv = rvRate(scenario, action, hrec ? hrec.amount : null); // rated before the action changes the table
    try { window.PokerGame.act(tbl.session, 0, action, action === 'raise' ? heroRaiseAmount() : undefined); } catch (e) {
      console.error('hero action rejected', e);
      showError(t('err.illegal') + ' (' + errMsg(e) + ')', null);
      return;
    }
    clearError();
    tbl.heroTurn = false;
    // Quick game vs bots: no per-move rating toast (ratings stay in practice, single spots and the exam review).
    handsRender(true, { seats: false, cards: false });
    handsPump();
  }
  // Hand result in the quick game: the hand's net and the running totals; the game ends with the session.
  function tableHandDone(res) {
    var s = tbl.session;
    var hn = 0;
    if (!tbl.counted) {
      tbl.counted = true;
      tableRun.hands += 1;
      if (res) progressHand(res);
      if (res) {
        var trec = rvHandRecord(s);
        if (trec) tableRun.handRecs.push(trec);
        tbl.handLuck = rvLuckOf(trec);
        hn = num(res.heroNet) / handBB();
        tableRun.net += num(res.heroNet);
        if (hn > 0) tableRun.wins += 1;
        var won = num(res.heroWon);
        if (won > tableRun.biggest) tableRun.biggest = won;
      }
    }
    // the last hand of the game is shown in full (runout, showdown); its Next button then ends the game
    if (s.over) tbl.endPending = s.over;
    els.cpuResultTitle.textContent = Math.abs(hn) < 0.005 ? t('hand.even')
      : hn > 0 ? t('hand.won', { amt: fmtBB(hn) }) : t('hand.lost', { amt: fmtBB(-hn) });
    els.cpuResultTitle.classList.remove('hidden');
    els.cpuResult.classList.remove('exam-hand');
    els.cpuResultLines.textContent = '';
    if (tbl.handLuck) els.cpuResultLines.appendChild(rvLuckLi(tbl.handLuck));
    // Bots that ran out of chips in this hand leave the table from the next hand; the summary says so once.
    var before = tbl.bustedAtDeal || [];
    s.seats.forEach(function (seat, i) {
      if (i === 0 || !seat.busted || before[i]) return;
      els.cpuResultLines.appendChild(el('li', 'sd-line', t('table.out', { name: cpuName(seat.name) })));
      showTableNotice(t('table.out', { name: cpuName(seat.name) }));
    });
    els.cpuNextLabel.textContent = t('btn.next');
    applyModeVisibility();
    updateControls();
  }
  // The game is over: 'busted' (hero out of chips), 'won' (every bot out) or 'quit'. Records it in progress.
  function tableFinish(result) {
    handsClearTimer();
    if (!tableRun || tableRun.ended) return;
    tableRun.ended = result;
    tableEndRecs = tableRun.handRecs.slice();
    var reviewBtn = $('btn-table-review');
    if (reviewBtn) reviewBtn.classList.toggle('hidden', !tableEndRecs.length);
    var bbNow = tableBB();
    var final = num(tbl.session.seats[0].stack) / bbNow;
    var net = tableRun.net / bbNow;
    capPush(progress.games, {
      t: Date.now(), bots: tableCfg.bots, prog: tableCfg.prog, hands: tableRun.hands, wins: tableRun.wins,
      net: bbHalf(net), biggest: bbHalf(tableRun.biggest / bbNow),
      start: tableRun.start * TABLE_BB / bbNow, end: bbHalf(final), result: result
    }, 200);
    progressSave();
    var n = { n: tableRun.hands };
    $('table-end-title').textContent = result === 'won' ? t('table.won') : result === 'busted' ? t('table.over') : t('table.quit');
    $('table-end-sub').textContent = t(result === 'won' ? 'table.subWon' : result === 'busted' ? 'table.subOver' : 'table.subQuit', n);
    $('te-hands').textContent = String(tableRun.hands);
    $('te-biggest').textContent = fmtBB(tableRun.biggest / bbNow);
    $('te-net').textContent = (net > 0 ? '+' : '') + fmtBB(net);
    $('te-win').textContent = tableRun.hands ? Math.round(100 * tableRun.wins / tableRun.hands) + '%' : '–';
    $('te-stack').textContent = fmtBB(final);
    applyModeVisibility();
    updateControls();
  }
  function tableNewGame() {
    handsClearTimer();
    mode = 'table'; saveJSON(STORE.mode, mode);
    game = 'hands'; saveJSON(STORE.game, game);
    exam = null;
    tableRun = { hands: 0, biggest: 0, wins: 0, net: 0, ended: null, start: settings.stack, handRecs: [] };
    tbl = { session: window.PokerGame.newSession(tableConfig()), timer: null, heroTurn: false, handOver: false,
      decisions: [], counted: false, awaitingOk: false };
    clearError();
    scenario = null;
    answered = null;
    raiseReady = false;
    els.feedback.classList.add('hidden');
    renderStats();
    applyModeVisibility();
    handsDeal();
  }
  // The starting stack typed on the menu: read from the field itself (a typed value counts before 'change' fires).
  function readMenuStack() {
    var v = stackBB($('menu-stack').value);
    $('menu-stack').value = String(v);
    if (menuDraft) menuDraft.stack = v;
    return v;
  }
  function tableStart() {
    var d = menuDraft;
    tableCfg = normalizeTableCfg({ bots: d.bots, prog: d.prog });
    saveJSON(STORE.table, tableCfg);
    var stack = readMenuStack();
    settings = sanitizeSettings({
      pmin: settings.ranges.table.pmin, pmax: settings.ranges.table.pmax, position: settings.position, street: settings.street,
      ranges: settings.ranges, stack: stack, personalities: d.personalities, stacks: settings.stacks,
      customStacks: settings.customStacks, money: d.money
    });
    saveJSON(STORE.settings, settings);
    closeSheets();
    showView('game');
    progressEndSession();
    tableNewGame();
  }
  // Leaving the table before the end counts as a finished game (quit) when a hand was played.
  function tableLeave() {
    if (tableRun && !tableRun.ended && tableRun.hands > 0) tableFinish('quit');
    handsClearTimer();
    tableRun = null;
    if (mode === 'table') { mode = 'practice'; saveJSON(STORE.mode, mode); }
    applyRange(rangeKeyNow());
  }
  // Table view: the end panel replaces the table; the finish button and hand line show only during play.
  function tableSyncView() {
    var on = isTable();
    var ended = on && tableEnded();
    document.body.classList.toggle('table-mode', on);
    $('table-end').classList.toggle('hidden', !ended);
    if (on) $('practice-area').classList.toggle('hidden', ended);
    $('btn-finish-table').classList.toggle('hidden', !on || ended);
    $('hand-info').classList.toggle('hidden', !on);
    // Blind level (progressive blinds only): the level now and the hands until the next increase.
    var lvl = Math.min(4, Math.floor(on ? tableRun.hands / 10 : 0));
    var blinds = on && tableCfg.prog ? ' · ' + (lvl < 4 ? t('table.level', { l: lvl + 1, n: 10 - tableRun.hands % 10 }) : t('table.levelMax', { l: lvl + 1 })) : '';
    // after a doubling, one BB is worth more starting BB: say so next to the level
    if (on && tableBB() > TABLE_BB) blinds += ' · ' + t('table.bbUnit', { x: fmtBB(tableBB() / TABLE_BB) });
    if (on) $('hand-info').textContent = t(tableCfg.bots === 1 ? 'table.info1' : 'table.info', { n: tableCfg.bots, h: tableRun.hands + 1 }) + blinds;
  }
  function tableEnded() { return !!(tableRun && tableRun.ended); }
  function tableFinishDisarm() {
    clearTimeout(tableFinishTimer);
    tableFinishTimer = null;
    $('btn-finish-table').classList.remove('armed');
    $('btn-finish-table').textContent = t('table.finish');
  }
  function tableBind() {
    // Two-step finish, like the exam: the first click arms it for a few seconds.
    $('btn-finish-table').addEventListener('click', function () {
      // One click opens the in-app popup (PokerAsk, mp.js); the popup's OK finishes the game.
      var go = function () { tableFinish('quit'); };
      if (window.PokerAsk) window.PokerAsk({ title: t('table.finish'), ok: t('table.finish'), danger: true, onOk: go });
      else go();
    });
    $('btn-table-again').addEventListener('click', function () { tableNewGame(); });
    $('btn-table-menu').addEventListener('click', function () { showView('menu'); });
    $('menu-bots').addEventListener('change', function () { menuDraft.bots = Number(this.value); });
    $('menu-prog').addEventListener('change', function () { menuDraft.prog = this.checked; });
    $('menu-stack').addEventListener('change', function () {
      var v = stackBB(this.value);
      this.value = String(v);
      menuDraft.stack = v;
    });
  }

  /* ---------- hands: full hands vs CPUs ---------- */
  function handsConfig() {
    return { cpus: 8, stackBB: settings.stack, noWalkover: true, money: settings.money,
      personalities: settings.personalities, stacks: settings.stacks, customStacks: settings.customStacks };
  }
  function handsClearTimer() {
    if (tbl && tbl.timer) { clearTimeout(tbl.timer); tbl.timer = null; }
  }
  function handsView() {
    return window.PokerGame.buildScenario(tbl.session, 0);
  }
  function seatName(s, idx) {
    var seat = s.seats[idx];
    return seat.isHero ? heroLabel() : cpuName(seat.name);
  }
  function handsFail(e) {
    console.error('hands play failed', e);
    handsClearTimer();
    showError(t('cpu.failed', { m: errMsg(e) }), null);
  }
  // The turn is shown by highlighting the acting seat (renderTable), not by a status strip.
  function handsUpdateStatus() {}
  // Session seat whose turn it is (renderTable highlights it); null when nobody is to act.
  function setActing() {
    var s = tbl && tbl.session;
    actingSeat = s && !s.over ? window.PokerGame.toAct(s) : null;
  }
  function handsRender(animate, opts) {
    setActing();
    var sc = handsView();
    // All-in runout: betting is over with 2+ live seats and the engine has already dealt the rest of the board.
    // The live hands show face-up and the board comes one street at a time (handsRunoutStep); the hand ends after it.
    if (handsRunoutDue(sc)) {
      tbl.runout = true;
      sc.board = sc.board.slice(0, tbl.shownBoard || 0);
      sc.seats.forEach(function (x) {
        var hs = tbl.session.hand.seats[x.seat];
        if (!x.folded && !x.busted && hs && hs.cards) x.reveal = hs.cards.slice();
      });
      if (!tbl.runTimer) tbl.runTimer = setTimeout(handsRunoutStep, 1000);
    }
    tbl.shownBoard = sc.board.length;
    renderTable(sc, animate, opts);
    handsUpdateStatus();
  }
  function handsRunoutDue(sc) {
    if (!tbl || !tbl.session || !tbl.session.hand) return false;
    if (tbl.runout) return true;
    if (!window.PokerGame.isHandOver(tbl.session)) return false;
    var live = sc.seats.filter(function (x) { return !x.folded && !x.busted; }).length;
    return live >= 2 && sc.board.length > (tbl.shownBoard || 0);
  }
  // One street of the runout: the flop comes together, then turn and river, about a second apart.
  function handsRunoutStep() {
    if (!tbl) return;
    tbl.runTimer = null;
    if (!tbl.runout || !tbl.session.hand) return;
    var full = tbl.session.hand.board.length;
    var shownN = tbl.shownBoard || 0;
    tbl.shownBoard = Math.min(full, shownN < 3 ? 3 : shownN + 1);
    if (tbl.shownBoard >= full) tbl.runout = false;
    handsRender(true, { seats: false });
    if (!tbl.runout) handsFinish();
  }
  // Table size and hero position for the next hand, from Settings (Random = drawn per hand).
  // Table size is drawn per hand from the player range; position applies when valid for that size.
  function chooseHandSetup() {
    var lo = settings.pmin, hi = settings.pmax;
    var n = lo + Math.floor(Math.random() * (hi - lo + 1));
    var pos = settings.position !== 'random' ? settings.position : null;
    if (pos) {
      var P = enginePositions();
      if (!P[n] || P[n].indexOf(pos) < 0) {
        var sizes = [];
        for (var k = lo; k <= hi; k++) if (P[k] && P[k].indexOf(pos) >= 0) sizes.push(k);
        if (sizes.length) n = sizes[Math.floor(Math.random() * sizes.length)];
        else pos = null;
      }
    }
    return { players: n, heroPosition: pos || undefined };
  }
  function handsNewSession() {
    handsClearTimer();
    progressEndSession();
    tbl = { session: window.PokerGame.newSession(handsConfig()), timer: null, heroTurn: false, handOver: false, decisions: [], counted: false };
    handsDeal();
  }
  function handsDeal() {
    handsClearTimer();
    if (tbl.runTimer) { clearTimeout(tbl.runTimer); tbl.runTimer = null; }
    tbl.runout = false;
    tbl.shownBoard = 0;
    tbl.handOver = false;
    tbl.heroTurn = false;
    tbl.decisions = [];
    answered = null;
    scenario = null;
    winnerSeats = null;
    tbl.counted = false;
    tbl.winAnimDone = false; // PokerAnim win flight: once per hand (it was once per game before)
    tbl.awaitingOk = false;
    clearError();
    els.feedback.classList.add('hidden');
    var hand;
    tbl.bustedAtDeal = tbl.session.seats.map(function (x) { return !!x.busted; }); // who was already out before this hand
    try { hand = window.PokerGame.startHand(tbl.session, isTable() ? tableDealSetup() : chooseHandSetup()); } catch (e) { handsFail(e); return; }
    if (!hand) { handsFinish(); return; }
    handsRender(true, { deal: true });
    applyModeVisibility();
    updateControls(); // the new hand's labels (and disabled buttons) right away, not after the bots' first action
    handsPump();
  }
  function handsNext() {
    if (!tbl || tbl.session.over) { handsNewSession(); return; }
    handsDeal();
  }
  // Runs bot actions (with delays) until the hero must act or the hand ends.
  function handsPump() {
    if (tbl && tbl.runout) return; // the all-in runout drives the hand until its last street
    handsClearTimer();
    // The bots only act while the table is on screen (menu and multiplayer pause the hand).
    if (document.body.dataset.view !== 'game') return;
    var s = tbl.session;
    if (window.PokerGame.isHandOver(s)) { handsFinish(); return; }
    var actor = window.PokerGame.toAct(s);
    if (actor == null) { handsFinish(); return; }
    if (!s.seats[actor].isBot) { handsHeroTurn(); return; }
    // Hero is out: let the rest of the hand play out in the background.
    if (s.hand.seats[0].folded) { handsRunBots(); handsFinish(); return; }
    tbl.heroTurn = false;
    handsUpdateStatus();
    var delay = 520 + Math.round(Math.random() * 280);
    tbl.timer = setTimeout(function () {
      tbl.timer = null;
      // Menu or another view took the table: the bots pause; handsEnter resumes the hand.
      if (document.body.dataset.view !== 'game') return;
      try { window.PokerGame.stepBot(s); } catch (e) { handsFail(e); return; }
      handsRender(true, { seats: false, cards: false });
      handsPump();
    }, delay);
  }
  // Resolves bot actions immediately until the hero must act (or the hand ends).
  function handsRunBots() {
    var s = tbl.session;
    var guard = 0;
    while (!window.PokerGame.isHandOver(s) && window.PokerGame.toAct(s) !== 0 && guard++ < 500) {
      window.PokerGame.stepBot(s);
    }
  }
  function handsHeroTurn() {
    var view = handsView();
    tbl.heroTurn = true;
    answered = null;
    scenario = view;
    clearError();
    els.feedback.classList.add('hidden');
    setActing();
    setupRaise(view);
    heroRaise = null;      // a new turn starts at the minimum raise
    raiseReady = true;     // hands: the amount is chosen on the row (any size), so Raise is ready when legal
    resetHelperForHand(view);
    // No table redraw here: the render that brought the hand to the hero (handsRender) already drew it,
    // and a second synchronous redraw would cut off the card and chip animations that render started.
    handsUpdateStatus();
    applyModeVisibility();
    updateControls();
  }
  // OK on the feedback popup: the hand continues, or the summary shows at the end of the hand.
  function handsContinue() {
    if (!tbl || !tbl.awaitingOk) return;
    tbl.awaitingOk = false;
    answered = null;
    els.feedback.classList.add('hidden');
    updateControls();
    handsRender(false, { seats: false, cards: false });
    handsPump();
  }
  function handsSubmit(action) {
    if (!tbl || !tbl.heroTurn || answered || !scenario) return;
    if (action === 'raise' && !raiseLegalNow()) return; // illegal raise: refused silently, like the disabled button
    if (isTable()) { tableAct(action); return; }
    var amount;
    var result;
    var rec = action === 'raise' ? (isTable() ? heroRaiseRecord() : sizeFor(scenario, null)) : null;
    try {
      result = gradeChoice(scenario, action, rec ? rec.amount : null);
      validateResult(result);
    } catch (e) {
      console.error('evaluate failed', e);
      showError(t('err.scoring', { m: errMsg(e) }), function () { handsSubmit(action); });
      return;
    }
    var move = moveText(action, rec, scenario);
    try {
      window.PokerGame.act(tbl.session, 0, action, action === 'raise' && isTable() ? heroRaiseAmount() : undefined);
    } catch (e) {
      console.error('hero action rejected', e);
      showError(t('err.illegal') + ' (' + errMsg(e) + ')', null);
      return;
    }
    clearError();
    tbl.heroTurn = false;
    tbl.decisions.push({
      street: scenario.street, move: move,
      pct: Math.max(0, Math.min(100, result.score)), rating: result.rating
    });
    try { recordStats(scenario, result, curStats()); } catch (e) { console.error('stats not saved', e); }
    try { progressDecision(scenario, action, result); } catch (e) { console.error('progress not saved', e); }
    if (mode === 'exam' && exam) {
      // Exam: graded silently, nothing is shown; the hand simply goes on.
      try { examRecord(scenario, action, amount, result); } catch (e) { console.error('exam record failed', e); }
      renderStats();
      updateControls();
      handsRender(true, { seats: false, cards: false });
      handsPump();
      return;
    }
    answered = { action: action, amount: amount, result: result };
    renderStats();
    updateControls();
    try { renderPracticeFeedback(scenario, action, result); } catch (e) { console.error('feedback failed', e); }
    rvToast(lastRv);
    handsRender(true, { seats: false, cards: false });
    tbl.awaitingOk = true;
    updateControls();
  }
  // Winner plates in every solo mode: gold class (ring and pulse come from polish.css) and a '+X BB' pop on the plate.
  // Idempotent: a re-render or a second call replaces the pop, never stacks one.
  function winnerPop(s, res) {
    var sc = handsView();
    var nodes = els.seats ? Array.prototype.slice.call(els.seats.children) : [];
    nodes.forEach(function (node) { var old = node.querySelector('.win-pop'); if (old) old.remove(); });
    if (!winnerSeats || !res || !res.wins) return;
    sc.seats.forEach(function (seat, idx) {
      var node = nodes[idx];
      if (!node || winnerSeats.indexOf(seat.seat) < 0) return;
      node.classList.add('winner');
      var won = num(res.wins[seat.seat]) / handBB();
      if (won > 0) node.appendChild(el('span', 'win-pop', '+' + fmtBB(won) + ' BB'));
    });
  }
  // PokerAnim end of hand: the pot splits to the winners' seats, winner seats glow, hero gets a '+X BB' label.
  // Runs once per hand; purely visual (no timers, no input).
  function animHandWin(s, res) {
    var A = animApi(), tblEl = $('table');
    if (!A || !tblEl || !winnerSeats || !tbl || tbl.winAnimDone) return;
    tbl.winAnimDone = true;
    var sc = handsView();
    var potRect = A.rectIn(tblEl, els.pot);
    var nodes = Array.prototype.slice.call(els.seats.children);
    var winners = [], heroNode = null, heroWon = false;
    sc.seats.forEach(function (seat, idx) {
      var node = nodes[idx];
      if (!node || winnerSeats.indexOf(seat.seat) < 0) return;
      winners.push(node);
      if (seat.isHero) { heroNode = node; heroWon = true; }
      A.glow(node, 1200 * animScale()).catch(function () {});
    });
    if (!winners.length || !potRect) return;
    var share = (num(sc.pot) || 0) / winners.length;
    var targets = winners.map(function (node) { return { rect: node, amount: share }; });
    A.potToWinners(potRect, targets, { container: tblEl, duration: 620 * animScale(), stagger: animMobile() ? 70 : 90 })
      .catch(function () {});
    var net = res ? num(res.heroNet) / handBB() : null;
    if (heroWon && net !== null && net > 0.005) {
      A.floatLabel(heroNode, '+' + fmtBB(net) + ' BB', { container: tblEl, cls: 'anim-win-label', ms: 950 * animScale() })
        .catch(function () {});
    }
  }
  // Hand summary: result in BB, the hero's decisions with their scores, and the average.
  function handsFinish() {
    if (tbl.runout) return; // the runout is still on the table; it calls handsFinish when its last street is shown
    handsClearTimer();
    tbl.heroTurn = false;
    var s = tbl.session;
    handsRender(false, { seats: false, cards: false });
    if (tbl.runout) return;
    tbl.handOver = true;
    var res = s.hand ? window.PokerGame.results(s) : null;
    winnerSeats = res && res.wins ? Object.keys(res.wins).map(Number) : null;
    if (window.PokerSound && winnerSeats) PokerSound.play('win', 150); // pot payout (sound.js)
    animHandWin(s, res);
    winnerPop(s, res);
    if (isTable()) {
      // Quick game: the same winner ring, '+X BB' pop and best-five highlight as every other solo mode.
      var tableSd = showdownInfo(s);
      if (winnerSeats && tableSd.length) showdownMark(tableSd, winnerSeats);
      winnerPop(s, res);
      tableHandDone(res);
      return;
    }
    if (!tbl.counted) {
      tbl.counted = true;
      if (res) { progressHand(res); if (mode === 'exam' && exam) exam.hands += 1; }
      // Full hand record (decisions, pot, invested, showdown): the exam review and the hand luck use it.
      var hrec = res ? rvHandRecord(s) : null;
      if (hrec && mode === 'exam' && exam) exam.handRecs.push(hrec);
      tbl.handLuck = rvLuckOf(hrec);
    }
    if (winnerSeats) handsRender(false, { seats: false, cards: false });
    var sdInfo = showdownInfo(s);
    if (winnerSeats && sdInfo.length) showdownMark(sdInfo, winnerSeats);
    winnerPop(s, res);
    var title;
    if (s.over === 'busted') title = t('cpu.busted');
    else if (s.over === 'won') title = t('cpu.cleared');
    else if (res) {
      var net = num(res.heroNet) / handBB();
      title = Math.abs(net) < 0.005 ? t('hand.even')
        : net > 0 ? t('hand.won', { amt: fmtBB(net) }) : t('hand.lost', { amt: fmtBB(-net) });
    } else title = '';
    els.cpuResultTitle.textContent = mode === 'exam' ? '' : title;
    els.cpuResultTitle.classList.toggle('hidden', mode === 'exam');
    els.cpuResult.classList.toggle('exam-hand', mode === 'exam');
    els.cpuResultLines.textContent = '';
    if (mode !== 'exam' && tbl.handLuck) els.cpuResultLines.appendChild(rvLuckLi(tbl.handLuck));
    if (mode === 'exam') {
      // Exam: after the hand only, one % per round the hero acted in, then the average of those rounds. No per-decision feedback.
      var rounds = [];
      tbl.decisions.forEach(function (d) {
        var r = rounds.filter(function (x) { return x.street === d.street; })[0];
        if (!r) { r = { street: d.street, sum: 0, n: 0 }; rounds.push(r); }
        r.sum += d.pct; r.n += 1;
      });
      rounds.forEach(function (r) {
        r.pct = Math.round(r.sum / r.n);
        els.cpuResultLines.appendChild(el('li', null, streetName(r.street) + ' ' + r.pct + '%'));
      });
      if (rounds.length) {
        var examAvg = Math.round(rounds.reduce(function (a, r) { return a + r.pct; }, 0) / rounds.length);
        els.cpuResultLines.appendChild(el('li', 'avg-line', t('hand.average', { p: examAvg })));
      }
    } else {
      tbl.decisions.forEach(function (d) {
        els.cpuResultLines.appendChild(el('li', null, streetName(d.street) + ' · ' + d.move + ' · ' + rvRatingLabel(d.rating)));
      });
      if (tbl.decisions.length) {
        var avg = Math.round(tbl.decisions.reduce(function (a, d) { return a + d.pct; }, 0) / tbl.decisions.length);
        els.cpuResultLines.appendChild(el('li', 'avg-line', t('hand.average', { p: avg })));
      }
    }
    if (sdInfo.length && res && mode !== 'exam') { // exam keeps its panel to the % per round and the average
      // Showdown: the pot, then each live hand with its name; the winners are marked.
      var potChips = (res.pots || []).reduce(function (a, p) { return a + num(p.amount); }, 0);
      els.cpuResultLines.appendChild(el('li', 'sd-pot', t('sd.pot', { x: fmtBB(potChips / handBB()) })));
      sdInfo.forEach(function (x) {
        var won = res.wins && res.wins[x.idx] ? res.wins[x.idx] : 0;
        var line = won > 0
          ? t(x.hero ? 'sd.winsYou' : 'sd.wins', { name: x.name, amt: fmtBB(won / handBB()), hand: x.hand })
          : t('sd.shows', { name: x.name, hand: x.hand });
        els.cpuResultLines.appendChild(el('li', won > 0 ? 'sd-win' : 'sd-line', line));
      });
    }
    els.cpuNextLabel.textContent = s.over ? t('btn.newSession') : t('btn.next');
    applyModeVisibility();
    updateControls();
  }
  // Fast-forward: resolve bot actions immediately up to the hero's next decision.
  function handsSkip() {
    if (!tbl || tbl.heroTurn || tbl.handOver || tbl.runout) return;
    handsClearTimer();
    try { handsRunBots(); } catch (e) { handsFail(e); return; }
    handsRender(false, { seats: false, cards: false });
    handsPump();
  }
  function handsEnter() {
    if (mode === 'table' && !tableRun) { mode = 'practice'; saveJSON(STORE.mode, mode); }
    renderStats();
    if (mode === 'exam' && !exam) exam = examNew();
    if (exam && exam.finished) { /* the exam summary stays on screen */ }
    else if (!tbl) handsNewSession();
    else if (tbl.handOver) { handsRender(false, { seats: false, cards: false }); handsFinish(); }
    else { handsRender(false, { seats: false, cards: false }); handsPump(); }
    applyModeVisibility();
    updateControls();
  }
  function handsSubmodeChanged() {
    if (mode === 'exam' && !exam) exam = examNew();
    renderStats();
    applyModeVisibility();
    if (answered && scenario && mode === 'practice') {
      try { renderPracticeFeedback(scenario, answered.action, answered.result); } catch (e) { console.error('feedback failed', e); }
    } else {
      els.feedback.classList.add('hidden');
    }
    if (mode === 'practice' && scenario && tbl && tbl.heroTurn) resetHelperForHand(scenario);
    updateControls();
  }

  /* ---------- sheets: start menu, rulebook, progress ---------- */
  var SHEETS = ['rules', 'progress'];
  var NS = 'http://www.w3.org/2000/svg';
  var progress = { decisions: [], sessions: [], hands: [] };
  var sessionAcc = null;   // session being played: {t, mode, format, n, sum}
  var progFilter = 'all';
  var progWeakest = null;
  var menuDraft = null;

  function sheetEl(name) { return $('sheet-' + name); }
  function sheetOpen() {
    return SHEETS.some(function (n) { var e = sheetEl(n); return !!e && !e.classList.contains('hidden'); });
  }
  function openSheet(name) {
    SHEETS.forEach(function (n) { sheetEl(n).classList.toggle('hidden', n !== name); });
    $('sheet-backdrop').classList.remove('hidden');
    if (name === 'menu') openMenu();
    if (name === 'rules') setRulesPage(0, 0);
    if (name === 'progress') { renderProgress(); setProgPage(0); }
    var f = sheetEl(name).querySelector('.sheet-close');
    if (f) f.focus();
  }
  // Rulebook as pages: page 0 = hand ranking, page 1 = one 'why' section at a time (prev/next + dots).
  var rulesWhy = 0;
  function setRulesPage(page, why) {
    var sheet = $('sheet-rules');
    if (!sheet) return;
    rulesWhy = why || 0;
    sheet.setAttribute('data-page', String(page));
    Array.prototype.forEach.call(sheet.querySelectorAll('[data-rpage]'), function (b) {
      var on = Number(b.getAttribute('data-rpage')) === page;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    var whys = sheet.querySelectorAll('details.rule');
    Array.prototype.forEach.call(whys, function (d, i) { d.classList.toggle('is-current', i === rulesWhy); d.open = i === rulesWhy; });
    $('rule-pager').hidden = page !== 1;
    var dots = $('rule-dots');
    dots.textContent = '';
    for (var i = 0; i < whys.length; i++) dots.appendChild(el('span', i === rulesWhy ? 'dot on' : 'dot'));
    $('rule-prev').disabled = rulesWhy === 0;
    $('rule-next').disabled = rulesWhy >= whys.length - 1;
  }
  // Progress sheet as two pages: Overview (KPIs, chart) and Breakdown (by position/street/players, export).
  function setProgPage(page) {
    var sheet = $('sheet-progress');
    if (!sheet) return;
    Array.prototype.forEach.call(sheet.querySelectorAll('[data-ppage]'), function (b) {
      var on = Number(b.getAttribute('data-ppage')) === page;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    Array.prototype.forEach.call(sheet.querySelectorAll('.pp'), function (p, i) { p.hidden = i !== page; });
  }
  // Exam summary: Results (average, KPIs) | By spot (position, street breakdown).
  function setSumPage(page) {
    Array.prototype.forEach.call(document.querySelectorAll('#exam-summary [data-spage]'), function (b) {
      var on = Number(b.getAttribute('data-spage')) === page;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    Array.prototype.forEach.call(document.querySelectorAll('#exam-summary .sp'), function (p, i) { p.hidden = i !== page; });
  }
  var sumBound = false;
  function initSumPages() {
    var box = $('exam-summary');
    if (!box || sumBound) return;
    sumBound = true;
    box.addEventListener('click', function (e) {
      var tab = e.target.closest && e.target.closest('[data-spage]');
      if (tab) setSumPage(Number(tab.getAttribute('data-spage')));
    });
  }
  var progBound = false;
  function initProgPages() {
    var sheet = $('sheet-progress');
    if (!sheet || progBound) return;
    progBound = true;
    sheet.addEventListener('click', function (e) {
      var tab = e.target.closest && e.target.closest('[data-ppage]');
      if (tab) setProgPage(Number(tab.getAttribute('data-ppage')));
    });
  }
  var rulesBound = false;
  function initRulesPages() {
    var sheet = $('sheet-rules');
    if (!sheet || rulesBound) return;
    rulesBound = true;
    sheet.addEventListener('click', function (e) {
      var tab = e.target.closest && e.target.closest('[data-rpage]');
      if (tab) { setRulesPage(Number(tab.getAttribute('data-rpage')), rulesWhy); return; }
      var summ = e.target.closest && e.target.closest('details.rule > summary');
      if (summ) {
        e.preventDefault();
        setRulesPage(1, Array.prototype.indexOf.call(sheet.querySelectorAll('details.rule'), summ.parentNode));
      }
    });
    $('rule-prev').addEventListener('click', function () { setRulesPage(1, Math.max(0, rulesWhy - 1)); });
    $('rule-next').addEventListener('click', function () { setRulesPage(1, rulesWhy + 1); });
  }
  function closeSheets() {
    SHEETS.forEach(function (n) { sheetEl(n).classList.add('hidden'); });
    $('sheet-backdrop').classList.add('hidden');
  }
  function renderOpenSheets() {
    if (document.body.dataset.view === 'menu' && menuDraft) populateMenu();
    if (!sheetEl('progress').classList.contains('hidden')) renderProgress();
  }
  // Rulebook opener: the hand ranking is drawn with the same card renderer as the table (real suits).
  var RULE_HANDS = [
    { key: 'rules.rank.royal', cards: ['As', 'Ks', 'Qs', 'Js', 'Ts'] },
    { en: 'Straight flush', cards: ['9h', '8h', '7h', '6h', '5h'] },
    { en: 'Four of a kind', cards: ['Ks', 'Kh', 'Kd', 'Kc', '2s'] },
    { en: 'Full house', cards: ['7s', '7h', '7d', '4c', '4s'] },
    { en: 'Flush', cards: ['Ad', 'Jd', '8d', '5d', '2d'] },
    { en: 'Straight', cards: ['9c', '8d', '7s', '6h', '5c'] },
    { en: 'Three of a kind', cards: ['Qs', 'Qh', 'Qd', '9c', '3s'] },
    { en: 'Two pair', cards: ['Js', 'Jh', '4d', '4c', '2s'] },
    { en: 'Pair', cards: ['Ac', 'Ad', '9s', '6h', '3c'] },
    { en: 'High card', cards: ['As', 'Jh', '8c', '5d', '2s'] }
  ];
  function renderRulebook() {
    var ol = $('rules-ranking');
    if (!ol) return;
    ol.textContent = '';
    RULE_HANDS.forEach(function (h, i) {
      var li = el('li', 'rk-row');
      li.appendChild(el('span', 'rk-rank', String(i + 1)));
      li.appendChild(el('span', 'rk-name', h.key ? t(h.key) : handName(h.en)));
      var cards = el('span', 'rk-cards');
      h.cards.forEach(function (c) { cards.appendChild(cardEl(c, { animate: false })); });
      li.appendChild(cards);
      ol.appendChild(li);
    });
  }
  function playerLabel(v) { return t('players.n', { n: v }); }
  function setPressed(group, attr, value) {
    Array.prototype.forEach.call(group.querySelectorAll('[' + attr + ']'), function (b) {
      var on = b.getAttribute(attr) === String(value);
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  /* start menu: remembered choices, applied with the big Start button */
  function openMenu() {
    var fmtKey = rangeKeyOfFormat(isTable() ? 'table' : game === 'hands' ? 'full' : 'quick', mode);
    menuDraft = {
      mode: mode, format: isTable() ? 'table' : game === 'hands' ? 'full' : 'quick',
      pmin: settings.ranges[fmtKey].pmin, pmax: settings.ranges[fmtKey].pmax,
      personalities: settings.personalities, money: settings.money,
      bots: tableCfg.bots, prog: tableCfg.prog, stack: settings.stack
    };
    showMenuCards();
    populateMenu();
  }
  function populateMenu() {
    if (!menuDraft) return;
    var d = menuDraft;
    setPressed($('menu-format'), 'data-fmt', d.format === 'table' ? 'table' : d.format === 'quick' ? 'quick' : d.mode);
    $('menu-settings').classList.toggle('is-table', d.format === 'table');
    $('menu-settings').classList.toggle('is-practice', d.format === 'full' && d.mode === 'practice');
    fillSelect($('menu-bots'), ['1', '2', '3', '4', '5', '6', '7', '8'], String(d.bots), function (v) { return Number(v) === 1 ? t('table.bot1') : t('table.bots', { n: v }); });
    $('menu-prog').checked = !!d.prog;
    $('menu-stack').value = String(d.stack);
    fillSelect($('menu-pmin'), PLAYER_NUMS, String(d.pmin), playerLabel);
    fillSelect($('menu-pmax'), PLAYER_NUMS, String(d.pmax), playerLabel);
    renderPersChecks($('menu-pers'), d.personalities, function (v) { menuDraft.personalities = v; });
    $('menu-money').checked = d.money;
  }
  function menuStart() { if (menuDraft.format === 'table') { tableStart(); return; }
    var d = menuDraft;
    settings = sanitizeSettings({
      pmin: d.pmin, pmax: d.pmax, position: settings.position, street: settings.street, ranges: settings.ranges,
      stack: readMenuStack(), personalities: d.personalities, stacks: settings.stacks, customStacks: settings.customStacks,
      money: (d.format === 'full' && d.mode === 'practice') ? false : d.money
    });
    storeRange(rangeKeyOfFormat(d.format, d.mode), settings.pmin, settings.pmax);
    applyRange(rangeKeyOfFormat(d.format, d.mode));
    saveJSON(STORE.settings, settings);
    closeSheets();
    showView('game');
    progressEndSession();
    exam = null;
    mode = d.format === 'full' ? d.mode : 'practice';
    saveJSON(STORE.mode, mode);
    game = d.format === 'full' ? 'hands' : 'spots';
    saveJSON(STORE.game, game);
    clearError();
    scenario = null;
    answered = null;
    raiseReady = false;
    els.feedback.classList.add('hidden');
    if (game === 'hands') { if (mode === 'exam') exam = examNew(); handsNewSession(); return; }
    handsClearTimer();
    if (tbl) tbl.heroTurn = false;
    clearTable();
    renderStats();
    applyModeVisibility();
    newHand();
    updateControls();
  }

  /* progress: every graded decision, finished sessions and hands go to localStorage */
  function progressLoad() {
    var v = loadJSON(STORE.progress, null) || {};
    progress = {
      decisions: Array.isArray(v.decisions) ? v.decisions : [],
      sessions: Array.isArray(v.sessions) ? v.sessions : [],
      hands: Array.isArray(v.hands) ? v.hands : [], games: Array.isArray(v.games) ? v.games : []
    };
  }
  function progressSave() { saveJSON(STORE.progress, progress); }
  function capPush(list, rec, max) {
    list.push(rec);
    if (list.length > max) list.splice(0, list.length - max);
  }
  function formatKey() { return game === 'hands' ? 'full' : 'quick'; }
  function progressDecision(sc, action, result) {
    var rec = {
      t: Date.now(), mode: mode === 'exam' ? 'exam' : 'practice', format: formatKey(), position: sc.heroPosition || '?', street: sc.street,
      players: sc.numPlayers || sc.seats.length, score: Math.round(Math.max(0, Math.min(100, num(result.score)))),
      best: result.best || '', chosen: action
    };
    capPush(progress.decisions, rec, 5000);
    // A single-decision spot is one hand for Progress ("Hands played" counts spots in Single spots, net 0).
    if (game === 'spots') capPush(progress.hands, { t: rec.t, mode: rec.mode, format: rec.format, net: 0, spot: true }, 2000);
    if (!sessionAcc || sessionAcc.mode !== mode || sessionAcc.format !== rec.format) {
      progressEndSession();
      sessionAcc = { t: rec.t, mode: mode, format: rec.format, n: 0, sum: 0 };
    }
    sessionAcc.n += 1;
    sessionAcc.sum += rec.score;
    progressSave();
  }
  function progressEndSession() {
    if (sessionAcc && sessionAcc.n > 0) {
      capPush(progress.sessions, {
        t: sessionAcc.t, mode: sessionAcc.mode, format: sessionAcc.format, n: sessionAcc.n,
        avg: Math.round(sessionAcc.sum / sessionAcc.n * 10) / 10
      }, 500);
      progressSave();
    }
    sessionAcc = null;
  }
  function progressHand(res) {
    // Quick-game (table) hands are practice hands for Progress: store them as 'practice' so the Practice filter counts them.
    capPush(progress.hands, { t: Date.now(), mode: mode === 'exam' ? 'exam' : 'practice', format: formatKey(), net: Math.round(num(res.heroNet) / handBB() * 100) / 100 }, 2000);
    progressSave();
  }
  function svgEl(tag, attrs) {
    var n = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, String(attrs[k])); });
    return n;
  }
  function renderChart(box, c) {
    box.textContent = '';
    if (!c.points.length) { box.appendChild(el('p', 'empty-note', t('prog.noChart'))); return; }
    var W = 600, H = 220, PL = 40, PR = 14, PT = 14, PB = 28;
    var n = c.points.length;
    function X(i) { return n <= 1 ? (PL + W - PR) / 2 : PL + i * (W - PL - PR) / (n - 1); }
    function Y(v) { return PT + (1 - v / 100) * (H - PT - PB); }
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': t('prog.chartAria', { n: n }), class: 'line-chart' });
    [0, 50, 100].forEach(function (v) {
      svg.appendChild(svgEl('line', { x1: PL, x2: W - PR, y1: Y(v), y2: Y(v), class: 'grid' }));
      var lab = svgEl('text', { x: PL - 6, y: Y(v) + 4, 'text-anchor': 'end', class: 'axis' });
      lab.textContent = v + '%';
      svg.appendChild(lab);
    });
    c.ticks.forEach(function (i) {
      svg.appendChild(svgEl('line', { x1: X(i), x2: X(i), y1: PT, y2: H - PB, class: 'session-tick' }));
    });
    var d = c.points.filter(function (p) { return p.y != null; })
      .map(function (p, k) { return (k ? 'L' : 'M') + X(p.x).toFixed(1) + ' ' + Y(p.y).toFixed(1); }).join(' ');
    if (d) svg.appendChild(svgEl('path', { d: d, class: 'trend-line' }));
    var last = c.points[n - 1];
    if (last.y != null) svg.appendChild(svgEl('circle', { cx: X(last.x), cy: Y(last.y), r: 4, class: 'trend-dot' }));
    var xl = svgEl('text', { x: PL, y: H - 6, class: 'axis' });
    xl.textContent = t('prog.axisStart', { n: n });
    svg.appendChild(xl);
    var xr = svgEl('text', { x: W - PR, y: H - 6, 'text-anchor': 'end', class: 'axis' });
    xr.textContent = t('prog.axisEnd');
    svg.appendChild(xr);
    box.appendChild(svg);
    box.appendChild(el('p', 'chart-note', t('prog.chartNote', { n: n })));
  }
  function renderBars(box, map, order, labelFn) {
    box.textContent = '';
    var keys = order.filter(function (k) { return map[k] && map[k].n > 0; });
    if (!keys.length) { box.appendChild(el('p', 'empty-note', t('stats.none'))); return; }
    keys.forEach(function (k) {
      var row = map[k];
      var line = el('div', 'bd-row');
      line.appendChild(el('span', 'bd-name', labelFn(k)));
      var bar = el('div', 'bd-bar');
      var fill = el('div', 'score-fill ' + scoreClass(row.avg));
      fill.style.width = Math.round(row.avg) + '%';
      bar.appendChild(fill);
      line.appendChild(bar);
      line.appendChild(el('span', 'bd-val', Math.round(row.avg) + '% · ' + row.n));
      box.appendChild(line);
    });
  }
  function renderProgress() {
    var S = window.PokerStats;
    if (!S || !progress) return;
    var s = S.summary(progress, progFilter);
    Array.prototype.forEach.call($('filter-group').querySelectorAll('[data-pf]'), function (b) {
      var on = b.dataset.pf === progFilter;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    $('pg-avg').textContent = s.average == null ? '–' : Math.round(s.average) + '%';
    var tr = s.trend;
    if (tr.direction == null) {
      $('pg-trend').textContent = t('prog.trendNone');
    } else {
      var arrow = tr.direction === 'up' ? '↑' : tr.direction === 'down' ? '↓' : '→';
      $('pg-trend').textContent = arrow + ' ' + (tr.delta > 0 ? '+' : '') + tr.delta + ' ' + t('prog.trend.' + tr.direction);
    }
    $('pg-decisions').textContent = String(s.decisions);
    $('pg-hands').textContent = String(s.handsPlayed);
    $('pg-streak').textContent = String(s.bestStreak);
    $('pg-empty').classList.toggle('hidden', s.decisions > 0);
    renderChart($('pg-chart'), s.chart);
    renderBars($('pg-position'), s.byPosition, POSITION_ALL, posName);
    renderBars($('pg-street'), s.byStreet, STREET_ORDER, streetName);
    renderBars($('pg-players'), s.byPlayers, PLAYER_NUMS, playerLabel);
    var w = s.weakest;
    progWeakest = w;
    $('pg-weakest').textContent = w
      ? t('prog.weakest', { spot: w.dim === 'position' ? posName(w.key) : streetName(w.key), avg: Math.round(w.avg) })
      : t('prog.noWeakest');
    $('btn-drill').classList.toggle('hidden', !w);
  }
  function progressExport() {
    var blob = new Blob([JSON.stringify(progress, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'poker-trainer-progress.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function progressReset() {
    askConfirm(t('prog.confirmReset'), t('btn.reset'), function () {
      progress = { decisions: [], sessions: [], hands: [] };
      sessionAcc = null;
      progressSave();
      renderProgress();
    });
  }
  // Starts quick spots aimed at the weakest position or street.
  function drillWeakest() {
    var w = progWeakest;
    if (!w) return;
    var next = Object.assign({}, settings);
    if (w.dim === 'position') next.position = w.key;
    else next.street = w.key;
    settings = sanitizeSettings(next);
    saveJSON(STORE.settings, settings);
    closeSheets();
    showView('game');
    progressEndSession();
    exam = null;
    mode = 'practice';
    saveJSON(STORE.mode, mode);
    game = 'spots';
    saveJSON(STORE.game, game);
    clearError();
    scenario = null;
    answered = null;
    raiseReady = false;
    clearTable();
    els.feedback.classList.add('hidden');
    renderStats();
    applyModeVisibility();
    newHand();
  }
  // A hand or quick game is live (Practice, Exam, Quick game): leaving it loses its progress.
  function liveGame() {
    if (game !== 'hands') return !!scenario && !answered; // Single spots: a decision is open
    if (isTable()) return !!tableRun && !tableRun.ended;
    return !!(tbl && tbl.session && tbl.session.hand && !tbl.handOver);
  }
  var leaveReturn = null;
  function openLeave() {
    leaveReturn = document.activeElement;
    $('leave-pop').classList.remove('hidden');
    $('leave-stay').focus();
  }
  function closeLeave() {
    $('leave-pop').classList.add('hidden');
    if (leaveReturn && leaveReturn.focus) leaveReturn.focus();
    leaveReturn = null;
  }
  function bindSheets() {
    $('btn-back').addEventListener('click', function () { if (liveGame()) openLeave(); else showView('menu'); });
    $('leave-stay').addEventListener('click', closeLeave);
    $('leave-go').addEventListener('click', function () { closeLeave(); showView('menu'); });
    $('leave-pop').addEventListener('click', function (e) { if (e.target === this) closeLeave(); });
    $('leave-pop').addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); closeLeave(); } });
    $('leave-pop').addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var f = [$('leave-stay'), $('leave-go')]; // focus stays inside the small dialog
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[1]) { e.preventDefault(); f[0].focus(); }
    });
    $('sheet-backdrop').addEventListener('click', closeSheets);
    tableBind();
    SHEETS.forEach(function (n) { sheetEl(n).querySelector('.sheet-close').addEventListener('click', closeSheets); });
    $('menu-format').addEventListener('click', function (e) {
      var b = e.target.closest('[data-fmt]');
      if (!b) return;
      if (b.dataset.fmt === 'table') menuDraft.format = 'table'; else if (b.dataset.fmt === 'quick') menuDraft.format = 'quick';
      else { menuDraft.format = 'full'; menuDraft.mode = b.dataset.fmt; }
      // Each game keeps its own player range: the draft takes the range of the game picked.
      var rk = rangeKeyOfFormat(menuDraft.format, menuDraft.mode);
      menuDraft.pmin = settings.ranges[rk].pmin; menuDraft.pmax = settings.ranges[rk].pmax;
      populateMenu();
    });
    $('menu-pmin').addEventListener('change', function () {
      menuDraft.pmin = Number(this.value);
      if (menuDraft.pmax < menuDraft.pmin) menuDraft.pmax = menuDraft.pmin;
      populateMenu();
    });
    $('menu-pmax').addEventListener('change', function () {
      menuDraft.pmax = Number(this.value);
      if (menuDraft.pmin > menuDraft.pmax) menuDraft.pmin = menuDraft.pmax;
      populateMenu();
    });
    $('menu-money').addEventListener('change', function () {
      menuDraft.money = this.checked;
      if (this.checked && settings.stacks === 'equal') settings.stacks = 'varied';
    });
    $('menu-start').addEventListener('click', menuStart);
    Array.prototype.forEach.call($('filter-group').querySelectorAll('[data-pf]'), function (b) {
      b.addEventListener('click', function () { progFilter = b.dataset.pf; renderProgress(); });
    });
    $('btn-drill').addEventListener('click', drillWeakest);
    $('btn-export').addEventListener('click', progressExport);
    $('btn-reset-progress').addEventListener('click', progressReset);
    bindSettingsPanel();
  }

  /* ---------- views, theme, side panels, Ranges drawer, PokerApp ---------- */
  // Views: 'menu' (first screen), 'game' (the table) and 'mp' (mount point for the multiplayer client).
  function showView(name) {
    if (name === 'mp') name = 'multiplayer';
    if (['menu', 'game', 'multiplayer'].indexOf(name) < 0) return;
    document.body.dataset.view = name;
    // Leaving the table stops the bots' timers; the hand resumes when the table is shown again.
    if (name !== 'game') handsClearTimer();
    if (name === 'menu') tableLeave();
    closeSheets();
    closeSideDrawers();
    closeSettingsPanel(false);
    if (name === 'menu') openMenu();
    window.scrollTo(0, 0);
  }
  function showMenuPanel() {
    $('view-menu').dataset.step = 'settings';
    $('menu-settings').classList.remove('hidden');
    $('menu-start').focus({ preventScroll: true });
  }
  function showMenuCards() {
    $('view-menu').dataset.step = 'cards';
    $('menu-settings').classList.add('hidden');
  }
  // The topbar height is published as --topbar-h so drawers and the backdrop start below it.
  function syncTopbarH() {
    var bar = document.querySelector('.topbar');
    if (bar) document.documentElement.style.setProperty('--topbar-h', bar.offsetHeight + 'px');
  }
  function toggleSide(id, btnId) {
    var panel = $(id);
    var open = !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    $(btnId).setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  // Sidebar tabs: Analysis, Ranges (practice only), Progress, Settings. One pane is visible at a time.
  // The Ranges drawer (practice only): open or closed, with the chart drawn when it opens.
  function setRangesDrawer(open) {
    $('sidebar-right').classList.toggle('open', !!open);
    $('btn-ranges').setAttribute('aria-expanded', open ? 'true' : 'false');
    rangesOpen = !!open;
    if (rangesOpen) drawHelper();
  }
  function closeSideDrawers() {
    setRangesDrawer(false);
  }
  function sideOpen() {
    var s = $('sidebar-right');
    return !!s && s.classList.contains('open');
  }
  // Dark only. An older stored theme choice is removed.
  function clearStoredTheme() {
    try { window.localStorage.removeItem(STORE.theme); } catch (e) { /* storage blocked */ }
  }
  // Hand info and players panel (left and right sidebars) for the current table.
  // Seat-level tooltip: the last action only (the style has its own bubble on .style-tag, the position on .pos-badge).
  function seatTip(s) {
    var last = s.lastAction ? laLabel(s.lastAction) : '';
    return t('tip.last', { a: last || t('tip.none') });
  }
  function bindSeatTips() {
    var tipTimer = null;
    els.seats.addEventListener('touchstart', function (e) {
      var seat = e.target.closest ? e.target.closest('.seat[data-tip]') : null;
      if (!seat) return;
      clearTimeout(tipTimer);
      tipTimer = setTimeout(function () { seat.classList.add('tip-open'); }, 400);
    }, { passive: true });
    els.seats.addEventListener('touchend', function () {
      clearTimeout(tipTimer);
      Array.prototype.forEach.call(els.seats.querySelectorAll('.tip-open'), function (n) {
        setTimeout(function () { n.classList.remove('tip-open'); }, 1600);
      });
    });
    // the tip is 240px wide at most: shift it inside the table box so a seat at the edge never pushes it out
    function fitTip(seat) {
      var box = (els.seats.closest && els.seats.closest('.table-wrap')) || els.seats;
      var wr = box.getBoundingClientRect(), sr = seat.getBoundingClientRect();
      var half = Math.min(120, (wr.width - 16) / 2), c = sr.left + sr.width / 2, dx = 0;
      if (c - half < wr.left + 4) dx = wr.left + 4 - (c - half);
      else if (c + half > wr.right - 4) dx = wr.right - 4 - (c + half);
      seat.style.setProperty('--tip-dx', Math.round(dx) + 'px');
    }
    els.seats.addEventListener('mouseover', function (e) {
      var seat = e.target.closest ? e.target.closest('.seat[data-tip]') : null;
      if (seat) fitTip(seat);
    });
    els.seats.addEventListener('click', function (e) {
      var seat = e.target.closest ? e.target.closest('.seat[data-tip]') : null;
      if (seat) { fitTip(seat); seat.classList.toggle('tip-open'); }
    });
  }
  function renderSidePanels(sc) {
    if (!$('hi-pos')) return; // the hand info pane was removed from the game screens
    $('hi-pos').textContent = sc && sc.heroPosition ? sc.heroPosition : '\u2013';
    $('hi-stack').textContent = sc ? fmtBB(sc.heroStack) : '\u2013';
    $('hi-stack-row').classList.toggle('hidden', !settings.money);
    $('hi-pot').textContent = sc ? fmtBB(sc.pot) + ' BB' : '\u2013';
    $('hi-players').textContent = sc ? String(sc.numPlayers || sc.seats.length) : '\u2013';
    $('hi-street').textContent = sc && sc.street ? streetName(sc.street) : '\u2013';
  }
  // Ranges is a right-hand drawer. Optional opts ({players, position, facing}) preselect the chart.
  function openRanges(opts) {
    if (!helperAvailable()) return;
    if (opts && helperSel) {
      helperSel = Object.assign({}, helperSel, opts);
      renderHelperControls(helperSel);
    }
    applyModeVisibility();
    setRangesDrawer(true);
  }
  // The drawer (quick game, exam) closes on a click outside it or Esc.
  document.addEventListener('click', function (e) {
    if (document.body.classList.contains('drawer-ok') && $('sidebar-right').classList.contains('open') && !$('sidebar-right').contains(e.target) && !$('btn-ranges').contains(e.target)) setRangesDrawer(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && document.body.classList.contains('drawer-ok') && $('sidebar-right').classList.contains('open')) setRangesDrawer(false);
  });
  function bindShell() {
    // Multiplayer buttons carry data-mp-open (mp.js opens the view and connects). This is the fallback when mp.js is absent.
    if ($('btn-mp')) $('btn-mp').addEventListener('click', function () { if (!window.PokerMP) showView('multiplayer'); });
    $('menu-card-mp').addEventListener('click', function () { if (!window.PokerMP) showView('multiplayer'); });
    $('menu-card-rules').addEventListener('click', function () { openSheet('rules'); });
    $('menu-card-progress').addEventListener('click', function () { openSheet('progress'); });
    $('btn-home').addEventListener('click', function () { showView('menu'); });
    $('btn-help').addEventListener('click', function () { if (window.PokerHelp && typeof window.PokerHelp.open === 'function') window.PokerHelp.open(); });
    $('btn-ranges').addEventListener('click', function () { setRangesDrawer(!sideOpen()); });
    $('view-menu').querySelector('.menu-hub').addEventListener('click', function (e) {
      if (e.target.closest('[data-fmt],[data-mm],.mode-card-pe')) showMenuPanel();
    });
  }

  /* ---------- settings drawer ---------- */  /* ---------- settings drawer ---------- */
  function populateSettings() {
    var fixed = settings.pmin === settings.pmax ? String(settings.pmin) : 'random';
    fillSelect(els.setPosition, ['random'].concat(positionChoices(fixed)), settings.position, function (v) {
      return v === 'random' ? t('random') : v + ' · ' + posName(v);
    });
    fillSelect(els.setStreet, STREET_OPTIONS, settings.street, function (v) {
      return v === 'any' ? t('settings.anyStreet') : streetName(v);
    });
    els.setStack.value = String(settings.stack);
    renderPersChecks(els.persBox, settings.personalities, onPersChange);
    fillSelect(els.setStacks, STACK_MODES, settings.stacks, function (v) { return t('stacks.' + v); });
    els.setCustomStacks.value = settings.customStacks.join(', ');
    els.setCustomField.classList.toggle('hidden', settings.stacks !== 'custom');
    els.setStackField.classList.toggle('hidden', !settings.money);
  }
  // Range, position, street, personalities and money: applied from the next hand or spot (money and
  // personalities apply to the next full-hands session).
  function onSettingChange() {
    settings = sanitizeSettings({ pmin: settings.pmin, pmax: settings.pmax, position: els.setPosition.value, street: els.setStreet.value,
      ranges: settings.ranges, stack: settings.stack, personalities: settings.personalities, stacks: settings.stacks,
      customStacks: settings.customStacks, money: settings.money });
    storeRange(rangeKeyNow(), settings.pmin, settings.pmax);
    saveJSON(STORE.settings, settings);
    populateSettings();
    if (game === 'spots' && mode === 'practice' && !answered) newHand();
  }
  function renderPersChecks(box, enabled, onChange) {
    if (!box) return;
    box.textContent = '';
    PERSONALITY_TYPES.forEach(function (p) {
      var lab = document.createElement('label');
      lab.className = 'check';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = p;
      cb.checked = enabled.indexOf(p) >= 0;
      cb.addEventListener('change', function () {
        var on = PERSONALITY_TYPES.filter(function (q) {
          var c = box.querySelector('input[value="' + q + '"]');
          return c && c.checked;
        });
        if (!on.length) { cb.checked = true; return; }
        onChange(on);
      });
      lab.appendChild(cb);
      var sp = document.createElement('span');
      sp.textContent = t('pers.' + p);
      lab.appendChild(sp);
      box.appendChild(lab);
    });
  }
  function onPersChange(v) {
    settings.personalities = sanitizePers(v);
    saveJSON(STORE.settings, settings);
  }
  function onStacksChange() {
    settings.stacks = STACK_MODES.indexOf(els.setStacks.value) >= 0 ? els.setStacks.value : 'equal';
    saveJSON(STORE.settings, settings);
    populateSettings();
  }
  function onCustomStacksChange() {
    settings.customStacks = sanitizeCustom(String(els.setCustomStacks.value).split(',').map(Number));
    saveJSON(STORE.settings, settings);
    populateSettings();
  }
  function onStackChange() {
    settings.stack = stackBB(els.setStack.value);
    els.setStack.value = String(settings.stack);
    saveJSON(STORE.settings, settings);
  }
  /* ---------- menu settings panel (header gear: language, volume, table look) ---------- */
  /* ---------- user profile (name and photo, kept on this device): the hero's name at the table ---------- */
  var USER_AV_W = 240, USER_AV_H = 180, USER_AV_MAX = 45 * 1024; // the same limits as the multiplayer profile
  var user = { name: '', avatar: '' };
  // Name rules (the same as multiplayer): control characters become spaces, runs collapse, trimmed, 1 to 16.
  function cleanUserName(v) {
    var s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
    return s.length >= 1 && s.length <= 16 ? s : '';
  }
  function loadUser() {
    try {
      var v = JSON.parse(window.localStorage.getItem(STORE.user) || 'null');
      if (v && typeof v === 'object') {
        user = { name: cleanUserName(v.name).slice(0, 16), avatar: typeof v.avatar === 'string' && v.avatar.indexOf('data:image/') === 0 ? v.avatar : '' };
        return;
      }
      // Migration: a name or photo saved by the older multiplayer profile moves into this record once.
      var mp = JSON.parse(window.localStorage.getItem('poker-trainer:mp:v1') || 'null');
      if (mp && typeof mp === 'object' && (mp.name || mp.avatar)) {
        user = { name: cleanUserName(mp.name).slice(0, 16), avatar: typeof mp.avatar === 'string' && mp.avatar.indexOf('data:image/') === 0 ? mp.avatar : '' };
        saveUser();
      }
    } catch (e) { /* storage blocked: the profile is empty */ }
  }
  function saveUser() {
    try { window.localStorage.setItem(STORE.user, JSON.stringify(user)); } catch (e) { /* storage blocked: kept for this page only */ }
  }
  function heroLabel() { return user.name || t('seat.you'); }
  function setUserErr(msg) {
    $('user-err').textContent = msg || '';
    $('user-err').classList.toggle('hidden', !msg);
  }
  function renderUser() {
    var name = $('user-name');
    if (document.activeElement !== name) name.value = user.name;
    var av = $('user-av');
    av.textContent = '';
    if (user.avatar) {
      var img = document.createElement('img');
      img.src = user.avatar;
      img.alt = '';
      av.appendChild(img);
    } else {
      av.textContent = (user.name || '?').charAt(0).toUpperCase();
    }
    $('user-clear').classList.toggle('hidden', !user.avatar);
  }
  // Centre crop to 4:3, 240x180 JPEG at the best quality that fits the byte cap (the multiplayer rule).
  function userPhoto(img) {
    var w = img.naturalWidth, h = img.naturalHeight;
    var cw = w, ch = w / (USER_AV_W / USER_AV_H);
    if (ch > h) { ch = h; cw = h * (USER_AV_W / USER_AV_H); }
    var cv = document.createElement('canvas');
    cv.width = USER_AV_W;
    cv.height = USER_AV_H;
    var g = cv.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, (w - cw) / 2, (h - ch) / 2, cw, ch, 0, 0, USER_AV_W, USER_AV_H);
    var out = '';
    [0.9, 0.8, 0.7, 0.6, 0.5].some(function (q) {
      var d = cv.toDataURL('image/jpeg', q);
      if (d.length * 0.75 > USER_AV_MAX) return false;
      out = d;
      return true;
    });
    return out;
  }
  function onUserFile() {
    var f = this.files && this.files[0];
    this.value = '';
    if (!f) return;
    if (!/^image\//.test(f.type)) { setUserErr(t('user.notImage')); return; }
    var url = URL.createObjectURL(f);
    var img = new Image();
    img.onload = function () {
      var d = userPhoto(img);
      URL.revokeObjectURL(url);
      if (!d) { setUserErr(t('user.tooBig')); return; }
      setUserErr('');
      user.avatar = d;
      saveUser();
      renderUser();
    };
    img.onerror = function () { URL.revokeObjectURL(url); setUserErr(t('user.notImage')); };
    img.src = url;
  }
  function bindUser() {
    if (!$('user-name')) return;
    $('user-name').addEventListener('change', function () {
      var name = cleanUserName(this.value);
      if (!name) {
        // Required: keep the saved name and say why.
        setUserErr(t('user.nameReq'));
        this.value = user.name;
        return;
      }
      setUserErr('');
      user.name = name;
      saveUser();
      renderUser();
      renderAll(); // the hero's seat takes the new name at once
    });
    $('user-file').addEventListener('change', onUserFile);
    $('user-clear').addEventListener('click', function () {
      user.avatar = '';
      saveUser();
      renderUser();
    });
  }

  var setPanel = { open: false, returnTo: null, onClose: null };
  function openSettingsPanel(tab, onClose) {
    var panel = $('settings-panel');
    var view = document.body.dataset.view;
    if (setPanel.open || !panel || (view !== 'menu' && view !== 'multiplayer')) return false;
    setPanel.open = true;
    setPanel.returnTo = document.activeElement;
    setPanel.onClose = typeof onClose === 'function' ? onClose : null;
    loadUser(); // the profile may have changed on another screen (multiplayer writes the same record)
    if (tab) showSetTab(tab);
    renderUser();
    var vol = window.PokerSound ? PokerSound.getVolume() : 60; // the slider shows the stored volume
    $('set-volume').value = String(vol);
    $('settings-backdrop').classList.remove('hidden');
    panel.classList.remove('hidden');
    $('btn-settings').setAttribute('aria-expanded', 'true');
    panel.focus();
    return true;
  }
  function closeSettingsPanel(restoreFocus) {
    if (!setPanel.open) return;
    setPanel.open = false;
    $('settings-backdrop').classList.add('hidden');
    $('settings-panel').classList.add('hidden');
    $('btn-settings').setAttribute('aria-expanded', 'false');
    var back = setPanel.returnTo;
    var done = setPanel.onClose;
    setPanel.returnTo = null;
    setPanel.onClose = null;
    if (restoreFocus !== false && back && back.focus) back.focus();
    if (done) { try { done(); } catch (e) { /* the caller's view is gone */ } }
  }
  // Tabs: Language | Volume | Table. One section is shown at a time (arrow keys move between tabs).
  function showSetTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('#settings-panel .set-tab'), function (t) {
      var on = t.dataset.tab === name;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      $('set-pane-' + t.dataset.tab).classList.toggle('hidden', !on);
    });
  }
  function bindSettingsPanel() {
    var panel = $('settings-panel');
    if (!panel) return;
    Array.prototype.forEach.call(panel.querySelectorAll('.set-tab'), function (t) {
      t.addEventListener('click', function () { showSetTab(t.dataset.tab); });
      t.addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        var tabs = Array.prototype.slice.call(panel.querySelectorAll('.set-tab'));
        var i = tabs.indexOf(t), n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        e.preventDefault(); showSetTab(n.dataset.tab); n.focus();
      });
    });
    $('btn-settings').addEventListener('click', function () { if (setPanel.open) closeSettingsPanel(); else openSettingsPanel(); });
    $('btn-settings-close').addEventListener('click', function () { closeSettingsPanel(); });
    $('settings-backdrop').addEventListener('click', function () { closeSettingsPanel(false); });
    // Focus stays inside the panel while it is open (Tab wraps; Escape is handled by the document listener).
    panel.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var items = Array.prototype.filter.call(panel.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])'), function (x) {
        return !x.disabled && x.getClientRects().length > 0;
      });
      if (!items.length) return;
      var first = items[0], last = items[items.length - 1], cur = document.activeElement;
      if (e.shiftKey && (cur === first || cur === panel)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
    });
  }

  /* ---------- language ---------- */
  function setLanguage(l) {
    if (!window.I18N || l === lang()) return;
    window.I18N.setLang(l);
    window.I18N.apply(document);
    renderAll();
  }
  // Re-renders every language-dependent piece without changing game state.
  function renderAll() {
    renderLangButtons();
    renderStats();
    populateSettings();
    populateHelperPlayers();
    if (game === 'hands' && tbl && tbl.session.hand) {
      handsRender(false, { seats: false, cards: false });
      if (tbl.handOver) handsFinish();
    } else if (scenario) {
      renderTable(scenario, false, { seats: false, cards: false });
    }
    if (helperSel) { renderHelperControls(helperSel); drawHelper(); }
    if (answered && mode === 'practice') refreshAnswerText();
    if (exam && exam.finished) renderExamSummary();
    renderOpenSheets();
    renderRulebook();
    updateRaiseUI();
    applyModeVisibility();
    updateControls();
  }

  /* ---------- events ---------- */
  function bind() {
    Array.prototype.forEach.call(els.modeBtns, function (b) {
      b.addEventListener('click', function () { showView('game'); setMode(b.dataset.mode); });
    });
    Array.prototype.forEach.call(els.gameBtns, function (b) {
      b.addEventListener('click', function () { showView('game'); setGame(b.dataset.game); });
    });
    Array.prototype.forEach.call(els.langBtns, function (b) {
      b.addEventListener('click', function () { setLanguage(b.dataset.lang); });
    });
    // Side tabs: roving tabindex (only the selected tab is in the Tab order); Arrow keys, Home and End move between them.
    els.btnMore.addEventListener('click', toggleMore);

    // Two-step confirmation inside the page (a native confirm() blocks the page and looks out of place).
    var finishArmTimer = null;
    function finishDisarm() {
      clearTimeout(finishArmTimer);
      finishArmTimer = null;
      els.btnFinishExam.classList.remove('armed');
      els.btnFinishExam.textContent = t('btn.finishExam');
    }
    els.btnFinishExam.addEventListener('click', function () {
      // One click opens the in-app popup (PokerAsk, mp.js); the popup's OK finishes the exam.
      var go = function () { finishExam(); };
      if (window.PokerAsk) window.PokerAsk({ title: t('btn.finishExam'), ok: t('btn.finishExam'), danger: true, onOk: go });
      else go();
    });
    // 'Review game': the whole exam's review (every decision rated, luck summary) in the full-screen review.
    els.btnAnalysis.addEventListener('click', function () { openReviewOverlay(rvGameReview(exam ? exam.handRecs : [])); });
    var tableReviewBtn = $('btn-table-review');
    if (tableReviewBtn) tableReviewBtn.addEventListener('click', function () { openReviewOverlay(rvGameReview(tableEndRecs)); });
    els.btnNewExam.addEventListener('click', function () { startNewExam(); });
    els.btnExamMenu.addEventListener('click', function () { showView('menu'); });

    els.btnFold.addEventListener('click', function () { submit('fold'); });
    els.btnCall.addEventListener('click', function () { submit('call'); });
    // Touch: press and hold (LP_MS) opens the exact-amount popover; the click that ends a long press is swallowed.
    // A mouse never long-presses (desktop keeps the slider). contextmenu is off so the hold is not a menu.
    els.btnRaise.addEventListener('pointerdown', function (e) {
      lpFired = false;
      if (e.pointerType === 'mouse' || e.button > 0 || game !== 'hands' || !isTable() || !canAct() || !heroRaiseBounds()) return;
      var btn = this;
      clearTimeout(lpTimer);
      btn.classList.add('lp-arming');
      lpTimer = setTimeout(function () {
        lpTimer = null;
        lpFired = true;
        btn.classList.remove('lp-arming');
        rpShow();
      }, LP_MS);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) { els.btnRaise.addEventListener(ev, lpCancel); });
    els.btnRaise.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    els.btnRaise.addEventListener('click', function (e) {
      if (lpFired) { lpFired = false; e.preventDefault(); return; }
      submit('raise');
    });
    $('rp-num').addEventListener('input', rpCheck);
    $('rp-num').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); rpCommit(); }
      else if (e.key === 'Escape') { e.preventDefault(); rpClose(); }
    });
    $('rp-minus').addEventListener('click', function () { var bd = rpBounds(); if (bd) rpSet(Math.max(bd.lo, (Number($('rp-num').value) || bd.lo) - 0.5)); });
    $('rp-plus').addEventListener('click', function () { var bd = rpBounds(); if (bd) rpSet(Math.min(bd.hi, (Number($('rp-num').value) || bd.lo) + 0.5)); });
    $('rp-cancel').addEventListener('click', rpClose);
    $('rp-ok').addEventListener('click', rpCommit);
    // Outside tap or Escape anywhere closes the popover (the Raise button itself is handled by its own listeners).
    document.addEventListener('pointerdown', function (e) {
      if (rpOpen() && !$('raise-pop').contains(e.target) && !els.btnRaise.contains(e.target)) rpClose();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && rpOpen()) rpClose(); });
    $('raise-range').addEventListener('input', function () { setHeroRaise(Number(this.value)); });
    $('raise-num').addEventListener('input', function () {
      var b = heroRaiseBounds();
      var v = Number(this.value);
      if (b && this.value !== '' && isFinite(v)) setHeroRaise(v * b.bb);
    });
    // Letting go of the slider or leaving the number box returns the focus, so R and F/C keep working.
    $('raise-num').addEventListener('change', function () { this.blur(); updateControls(); });
    $('raise-range').addEventListener('change', function () { this.blur(); });
    Array.prototype.forEach.call(document.querySelectorAll('#raise-ctl [data-rq]'), function (b) {
      b.addEventListener('click', function () {
        var v = heroRaiseFor(this.dataset.rq);
        if (v != null) setHeroRaise(v);
      });
    });
    els.btnNext.addEventListener('click', nextAction);
    els.btnCpuNext.addEventListener('click', nextAction);

    els.errorRetry.addEventListener('click', function () {
      var f = errorRetry;
      clearError();
      if (f) f();
    });

    els.setPosition.addEventListener('change', onSettingChange);
    els.setStreet.addEventListener('change', onSettingChange);
    els.setStacks.addEventListener('change', onStacksChange);
    els.setCustomStacks.addEventListener('change', onCustomStacksChange);
    els.setStack.addEventListener('change', onStackChange);

    els.helperPlayers.addEventListener('change', onHelperPlayersChange);
    els.helperPosition.addEventListener('change', onHelperPositionChange);
    els.helperFacing.addEventListener('change', onHelperFacingChange);

    document.addEventListener('keydown', function (e) {
      // Escape closes the top layer first: sheet, settings drawer, then the side panel.
      if (e.key === 'Escape') {
        if (setPanel.open) { closeSettingsPanel(); return; }
        if (sheetOpen()) { closeSheets(); return; }
        if (sideOpen()) { closeSideDrawers(); return; }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      // Shortcuts only act on the table, never on the menu or multiplayer, and not while a layer is open.
      if (document.body.dataset.view !== 'game') return;
      var t0 = e.target;
      var tag = t0 && t0.tagName;
      if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA' || (t0 && t0.isContentEditable)) return;
      if (sheetOpen() || sideOpen()) return;
      var key = e.key;
      var k = typeof key === 'string' ? key.toLowerCase() : '';
      // Shortcuts follow the buttons: a disabled action does nothing (no error, no scoring).
      if (k === 'f') { if (!els.btnFold.disabled) { e.preventDefault(); submit('fold'); } }
      else if (k === 'c') { if (!els.btnCall.disabled) { e.preventDefault(); submit('call'); } }
      else if (k === 'r') { if (!els.btnRaise.disabled) { e.preventDefault(); submit('raise'); } }
      else if (k === 'n' || ((key === 'Enter' || key === ' ') && (tag === 'BODY' || tag === 'HTML' || !tag))) {
        if (game === 'hands' ? (tbl && (tbl.handOver || tbl.awaitingOk)) : answered) { e.preventDefault(); nextAction(); }
      }
    });
  }

  // Each block of wiring runs on its own, so one failure cannot stop the logo, the menu or the sheets from working.
  function safe(name, fn) {
    try { fn(); } catch (e) { console.error(name + ' failed', e); }
  }
  function init() {
    safe('settings', function () {
      var saved = loadJSON(STORE.settings, null);
      // money on means every player has their own stack: settings saved before that move to 'varied' once
      if (saved && saved.sv !== 2 && saved.stacks === 'equal') saved.stacks = 'varied';
      settings = sanitizeSettings(saved);
    });
    safe('progress', progressLoad);
    safe('user', function () { loadUser(); bindUser(); });
    clearStoredTheme();
    var savedMode = loadJSON(STORE.mode, 'practice');
    mode = savedMode === 'exam' ? 'exam' : 'practice';
    game = loadJSON(STORE.game, 'hands') === 'spots' ? 'spots' : 'hands';
    if (game === 'spots' && mode === 'exam') mode = 'practice';
    applyRange(rangeKeyNow());
    stats = loadStats();
    if (window.I18N) window.I18N.apply(document);
    safe('lang', renderLangButtons);
    safe('settings-ui', populateSettings);
    safe('helper-players', populateHelperPlayers);
    safe('ranges', initHelper);
    safe('bind', bind);
    // the tab/pager handlers are bound once here (idempotent flags), so they work on a plain page load, not only after renderAll()
    safe('pagers', function () { initRulesPages(); initProgPages(); initSumPages(); });
    safe('sheets', bindSheets);
    safe('shell', bindShell);
    safe('rulebook', renderRulebook);
    safe('seat-tips', bindSeatTips);
    safe('fb-more-strip', function () {
      // the phone strip's "More": a second button for the same expander (created here, shown by CSS only on phones)
      var b = el('button', 'ghost small fb-more-strip', t('btn.more'));
      b.type = 'button';
      b.id = 'fb-more-strip';
      b.setAttribute('aria-expanded', 'false');
      b.addEventListener('click', toggleMore);
      els.btnNext.parentNode.insertBefore(b, els.btnNext);
      els.btnMoreStrip = b;
    });
    safe('table-layout', function () {
      // re-place the seats whenever the table's box changes (window resize, orientation, the table becoming visible)
      var wrap = document.querySelector('.table-wrap');
      if (window.ResizeObserver && wrap) new ResizeObserver(scheduleLayout).observe(wrap);
      window.addEventListener('resize', scheduleLayout);
      // the first measure can run before the web fonts load: text then gets wider and seats/chips overflow the table. Re-run once they are in.
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleLayout);
    });
    safe('topbar', function () {
      syncTopbarH();
      window.addEventListener('resize', syncTopbarH);
    });
    safe('menu-back', function () { $('menu-back').addEventListener('click', showMenuCards); });
    showView('menu');
    safe('stats', renderStats);
    if (game === 'hands') { safe('hands', handsEnter); return; }
    if (mode === 'practice') newHand();
    else { applyModeVisibility(); updateControls(); }
  }

  // openSettings(tab, onClose): the Settings panel on a tab ('user' for the profile); onClose runs when it closes.
  window.PokerApp = { showView: showView, t: t, openRanges: openRanges, openSettings: openSettingsPanel };

  try {
    init();
  } catch (e) {
    console.error('init failed', e);
    showError(t('err.init', { m: errMsg(e) }), null);
  }
})();
