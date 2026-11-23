/* Poker Trainer review UI: rating icons and badges, move cards, the game analysis screen, the hand strip and rating toasts.
 * Pure DOM builders on top of window.PokerReview (review.js) and window.PokerReviewIcons (review-icons.js).
 * Browser: window.PokerReviewUI. Styles: review-ui.css. Contract: icon, badge, moveCard, renderGame, renderHandSummary, toast.
 * Optional extras (not in the contract): moveCard/renderGame read a `scenario` on each decision (hero, board, pot, toCall)
 * when the caller attaches it; without it the cards and pot context are left out. opts.lang overrides the language. */
(function () {
  'use strict';

  var PR = window.PokerReview;
  var ICONS = window.PokerReviewIcons;
  var NS = 'http://www.w3.org/2000/svg';
  var STREETS = ['preflop', 'flop', 'turn', 'river'];
  var RATING_ORDER = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder', 'forced'];

  // UI strings (EN, ES). Rating names come from the decision when present, else from here.
  var T = {
    rating: {
      brilliant: { en: 'Brilliant', es: 'Brillante' }, great: { en: 'Great', es: 'Genial' }, best: { en: 'Best', es: 'Mejor' },
      excellent: { en: 'Excellent', es: 'Excelente' }, good: { en: 'Good', es: 'Buena' }, book: { en: 'Book', es: 'Libro' },
      inaccuracy: { en: 'Inaccuracy', es: 'Imprecisión' }, mistake: { en: 'Mistake', es: 'Error' }, miss: { en: 'Miss', es: 'Oportunidad perdida' },
      blunder: { en: 'Blunder', es: 'Error grave' }, forced: { en: 'Forced', es: 'Forzada' },
      bad_luck: { en: 'Bad luck', es: 'Mala suerte' }, lucky: { en: 'Lucky', es: 'Suerte' }, none: { en: 'Neutral', es: 'Neutral' }
    },
    street: { preflop: { en: 'Preflop', es: 'Preflop' }, flop: { en: 'Flop', es: 'Flop' }, turn: { en: 'Turn', es: 'Turn' }, river: { en: 'River', es: 'River' } },
    act: {
      fold: { en: 'fold', es: 'retirarse' }, call: { en: 'call', es: 'igualar' }, check: { en: 'check', es: 'pasar' },
      raise: { en: 'raise to {n} BB', es: 'subir a {n} BB' }
    },
    youPlayed: { en: 'You played', es: 'Jugaste' },
    best: { en: 'Best', es: 'Mejor' },
    evLoss: { en: 'Lost {n} BB', es: 'Perdidos {n} BB' },
    noEvLoss: { en: 'Nothing lost', es: 'Sin BB perdidos' },
    details: { en: 'Details', es: 'Detalles' },
    hide: { en: 'Hide', es: 'Ocultar' },
    close: { en: 'Close', es: 'Cerrar' },
    gameTitle: { en: 'Game review', es: 'Análisis de la partida' },
    accuracy: { en: 'Accuracy', es: 'Precisión' },
    hands: { en: '{n} hands', es: '{n} manos' },
    decisions: { en: '{n} decisions', es: '{n} decisiones' },
    net: { en: 'Net', es: 'Neto' },
    all: { en: 'All', es: 'Todas' },
    luck: { en: 'Luck', es: 'Suerte' },
    luckNotMeasured: { en: 'Not measured', es: 'No medida' },
    expected: { en: 'Expected', es: 'Esperado' },
    actual: { en: 'Actual', es: 'Real' },
    keyMoments: { en: 'Key moments', es: 'Momentos clave' },
    bestMove: { en: 'Best move', es: 'Mejor jugada' },
    biggestBlunder: { en: 'Biggest blunder', es: 'Mayor error' },
    none: { en: 'No key moments', es: 'Sin momentos clave' },
    timeline: { en: 'BB lost per decision', es: 'BB perdidos por decisión' },
    timelineHint: { en: 'Click a bar to open the move', es: 'Pulsa una barra para abrir la jugada' },
    ratings: { en: 'Ratings', es: 'Calificaciones' },
    filterHint: { en: 'Click a rating to filter the moves', es: 'Pulsa una calificación para filtrar' },
    focus: { en: 'Move', es: 'Jugada' },
    selectMove: { en: 'Select a move to see the explanation.', es: 'Elige una jugada para ver la explicación.' },
    whatYouDid: { en: 'What you did', es: 'Lo que hiciste' },
    why: { en: 'Why', es: 'Por qué' },
    bestWhy: { en: 'Best move', es: 'Mejor jugada' },
    evCompare: { en: 'Chips compared (BB)', es: 'Comparación de fichas (BB)' },
    yourEv: { en: 'Your line', es: 'Tu jugada' },
    bestEv: { en: 'Best line', es: 'Mejor jugada' },
    winChance: { en: 'Chance to win', es: 'Prob. de ganar' },
    needed: { en: 'Needed to call', es: 'Necesaria para igualar' },
    outs: { en: 'Outs', es: 'Outs' },
    spr: { en: 'Chips behind', es: 'Fichas detrás' },
    pot: { en: 'Pot', es: 'Bote' },
    toCall: { en: 'To call', es: 'Por igualar' },
    handLabel: { en: 'Hand {n}', es: 'Mano {n}' },
    coach: { en: 'Coach notes', es: 'Notas del entrenador' },
    expand: { en: 'Show details', es: 'Ver detalles' },
    collapse: { en: 'Hide details', es: 'Ocultar detalles' },
    rateLabel: { en: 'Rating', es: 'Calificación' },
    notFound: { en: 'No moves match this filter.', es: 'Ninguna jugada coincide con este filtro.' },
    hidden: { en: 'hidden', es: 'oculto' }
  };

  var curLang = (typeof document !== 'undefined' && document.documentElement && /^es/i.test(document.documentElement.lang || '')) ? 'es' : 'en';
  function langOf(opts) { return opts && (opts.lang === 'es' || opts.lang === 'en') ? opts.lang : curLang; }
  function tr(key, lang, params) {
    var d = T[key] || {};
    var s = d[lang] || d.en || key;
    if (params) s = s.replace(/\{(\w+)\}/g, function (m, k) { return params[k] != null ? String(params[k]) : m; });
    return s;
  }
  function ratingName(key, lang, d) {
    if (d && d.ratingName && d.ratingName[lang]) return d.ratingName[lang];
    return T.rating[key] ? T.rating[key][lang] || T.rating[key].en : key;
  }
  function num(x, lang, digits) {
    if (x == null || isNaN(x)) return '–';
    var s = Number(x).toFixed(digits == null ? 1 : digits);
    if (s === '-0.0') s = '0.0';
    return lang === 'es' ? s.replace('.', ',') : s;
  }
  function signed(x, lang) {
    if (x == null || isNaN(x)) return '–';
    var v = Math.round(x * 10) / 10;
    var s = num(Math.abs(v), lang, 1);
    return (v > 0 ? '+' : v < 0 ? '−' : '') + s;
  }
  function pct(x) { return x == null ? '–' : Math.round(x * 100) + '%'; }

  /* ----------------------------------------------------------- DOM helpers */
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function svgEl(tag, attrs) {
    var e = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }
  function icon(ratingKey, opts) {
    var size = (opts && opts.size) || 16;
    return ICONS.element(ratingKey, size);
  }
  function badge(ratingKey, opts) {
    var lang = langOf(opts);
    var label = (opts && opts.label) || (T.rating[ratingKey] ? T.rating[ratingKey][lang] : ratingKey);
    var sp = h('span', 'rv-badge');
    sp.setAttribute('data-rating', ratingKey);
    sp.setAttribute('role', 'img');
    sp.setAttribute('aria-label', label);
    sp.appendChild(icon(ratingKey, { size: 16 }));
    sp.appendChild(h('span', 'rv-badge-text', label));
    return sp;
  }
  function miniCard(card) {
    var r = card.charAt(0) === 'T' ? '10' : card.charAt(0);
    var s = card.charAt(1);
    var sym = { s: '♠', h: '♥', d: '♦', c: '♣' }[s] || '';
    var c = h('span', 'rv-card rv-suit-' + s);
    c.setAttribute('aria-label', card);
    c.appendChild(h('span', 'rv-card-r', r));
    c.appendChild(h('span', 'rv-card-s', sym));
    return c;
  }
  function cardRow(cards, cls) {
    var row = h('span', cls || 'rv-cards');
    (cards || []).forEach(function (c) { row.appendChild(miniCard(c)); });
    return row;
  }

  function actionText(d, lang) {
    var sc = d.scenario;
    var a = d.action;
    if (a === 'raise' && d.amountBB != null) return T.act.raise[lang].replace('{n}', num(d.amountBB, lang, 1));
    if (a === 'call' && sc && sc.toCall === 0) return T.act.check[lang];
    if (a === 'call' && d.toCall === 0) return T.act.check[lang];
    if (a === 'check') return T.act.check[lang];
    return T.act[a] ? T.act[a][lang] : String(a);
  }
  function bestText(d, lang) {
    var b = d.best || {};
    if (b.action === 'raise' && b.amountBB != null) return T.act.raise[lang].replace('{n}', num(b.amountBB, lang, 1));
    if (b.action === 'call') return T.act.call[lang];
    if (b.action === 'check') return T.act.check[lang];
    return T.act[b.action] ? T.act[b.action][lang] : String(b.action);
  }
  function whyItems(d, lang) {
    return (d.why || []).map(function (w) { return PR.format(w.key, w.params, lang); });
  }
  function findParam(d, key, name) {
    var w = (d.why || []).filter(function (x) { return x.key === key; })[0];
    return w && w.params ? w.params[name] : undefined;
  }

  /* ----------------------------------------------------------- move card */
  function moveCard(d, opts) {
    opts = opts || {};
    var lang = langOf(opts);
    var rating = d.rating;
    var card = h('article', 'rv-move' + (opts.compact ? ' is-compact' : ''));
    card.setAttribute('data-rating', rating);
    if (d.index != null) card.setAttribute('data-index', String(d.index));
    if (opts.handIndex != null) card.setAttribute('data-hand', String(opts.handIndex));
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-expanded', 'false');
    var label = ratingName(rating, lang, d);
    card.setAttribute('aria-label', label + ': ' + actionText(d, lang));

    var top = h('div', 'rv-move-top');
    var meta = h('span', 'rv-move-meta', [opts.handNo != null ? tr('handLabel', lang, { n: opts.handNo }) : null, d.street ? T.street[d.street][lang] : null].filter(Boolean).join(' · '));
    top.appendChild(meta);
    var rName = h('span', 'rv-move-rating', label);
    rName.style.color = 'var(--rc, #888)';
    top.appendChild(rName);
    card.appendChild(top);
    // chess.com style: the rating badge sits on the top-right corner of the move it rates
    var corner = h('span', 'rv-corner');
    corner.appendChild(icon(rating, { size: 26 }));
    card.appendChild(corner);

    var line = h('div', 'rv-move-line');
    var you = h('span', 'rv-you');
    you.appendChild(document.createTextNode(T.youPlayed[lang] + ' '));
    you.appendChild(h('b', null, actionText(d, lang)));
    line.appendChild(you);
    if (!d.correct && d.best) {
      var best = h('span', 'rv-best');
      best.appendChild(document.createTextNode(T.best[lang] + ': '));
      best.appendChild(h('b', null, bestText(d, lang)));
      line.appendChild(best);
    }
    card.appendChild(line);

    var items = whyItems(d, lang);
    var one = h('p', 'rv-why', items[0] || (d.headline ? d.headline[lang] : ''));
    card.appendChild(one);

    var foot = h('div', 'rv-move-foot');
    var ev = h('span', 'rv-ev' + (d.evLossBB > 0 ? '' : ' is-zero'),
      d.evLossBB > 0 ? tr('evLoss', lang, { n: num(d.evLossBB, lang, 2) }) : T.noEvLoss[lang]);
    foot.appendChild(ev);
    if (d.scenario && d.scenario.hero) foot.appendChild(cardRow(d.scenario.hero.concat(d.scenario.board || []), 'rv-cards rv-cards-mini'));
    card.appendChild(foot);

    var det = h('div', 'rv-details');
    det.hidden = true;
    var list = h('ul', 'rv-why-list');
    items.forEach(function (t) { list.appendChild(h('li', null, t)); });
    det.appendChild(list);
    det.appendChild(contextChips(d, lang));
    card.appendChild(det);

    card.addEventListener('click', function () { setOpen(card, !card.classList.contains('is-open')); });
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(card, !card.classList.contains('is-open')); }
    });
    return card;
  }
  function setOpen(card, open) {
    card.classList.toggle('is-open', open);
    card.setAttribute('aria-expanded', open ? 'true' : 'false');
    var det = card.querySelector('.rv-details');
    if (det) det.hidden = !open;
  }
  function chip(label, value, cls) {
    var c = h('span', 'rv-stat' + (cls ? ' ' + cls : ''));
    c.appendChild(h('span', 'rv-stat-k', label));
    c.appendChild(h('span', 'rv-stat-v', value));
    return c;
  }
  function contextChips(d, lang) {
    var row = h('div', 'rv-stats');
    var sc = d.scenario || {};
    if (sc.pot != null) row.appendChild(chip(T.pot[lang], num(sc.pot, lang, 1) + ' BB'));
    if (sc.toCall != null && sc.toCall > 0) row.appendChild(chip(T.toCall[lang], num(sc.toCall, lang, 1) + ' BB'));
    if (d.winChance != null) row.appendChild(chip(T.winChance[lang], pct(d.winChance)));
    if (d.potOddsNeededPct != null) row.appendChild(chip(T.needed[lang], Math.round(d.potOddsNeededPct) + '%'));
    var outs = findParam(d, 'why.outs', 'outs');
    if (outs != null) row.appendChild(chip(T.outs[lang], String(outs)));
    if (sc.numPlayers) row.appendChild(chip(lang === 'es' ? 'Rivales' : 'Players', String(sc.numPlayers)));
    return row;
  }

  /* ----------------------------------------------------------- badge + toast + hand strip */
  function toast(ratingKey, text, opts) {
    var lang = langOf(opts);
    var t = h('div', 'rv-toast');
    t.setAttribute('role', 'status');
    t.setAttribute('aria-live', 'polite');
    t.setAttribute('data-rating', ratingKey);
    t.appendChild(icon(ratingKey, { size: 28 }));
    var txt = h('div', 'rv-toast-body');
    txt.appendChild(h('div', 'rv-toast-title', T.rating[ratingKey] ? T.rating[ratingKey][lang] : ratingKey));
    if (text) txt.appendChild(h('div', 'rv-toast-text', text));
    t.appendChild(txt);
    setTimeout(function () { t.classList.add('is-out'); }, 2000);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2400);
    return t;
  }

  function lucky(label) {
    if (label === 'bad_luck' || label === 'lucky') return label;
    if (label === 'none') return 'none';
    return null;
  }
  function ring(acc, size, cls) {
    var r = 30, C = 2 * Math.PI * r;
    var svg = svgEl('svg', { viewBox: '0 0 72 72', width: size, height: size, 'aria-hidden': 'true', 'class': 'rv-ring ' + (cls || '') });
    svg.appendChild(svgEl('circle', { cx: 36, cy: 36, r: r, 'class': 'rv-ring-track', fill: 'none', 'stroke-width': 6 }));
    var arc = svgEl('circle', { cx: 36, cy: 36, r: r, 'class': 'rv-ring-arc', fill: 'none', 'stroke-width': 6,
      'stroke-dasharray': (acc == null ? 0 : acc / 100 * C) + ' ' + C, transform: 'rotate(-90 36 36)' });
    svg.appendChild(arc);
    return svg;
  }
  function accuracyBlock(acc, lang, size) {
    var box = h('div', 'rv-acc');
    var wrap = h('div', 'rv-acc-ring');
    wrap.appendChild(ring(acc, size || 72));
    wrap.appendChild(h('span', 'rv-acc-num', acc == null ? '–' : num(acc, lang, 1)));
    box.appendChild(wrap);
    box.appendChild(h('span', 'rv-acc-label', T.accuracy[lang]));
    return box;
  }

  function renderHandSummary(container, handReview, opts) {
    var lang = langOf(opts);
    var root = h('div', 'rv-hsum');
    root.appendChild(accuracyBlock(handReview.accuracy, lang, 52));
    var mid = h('div', 'rv-hsum-mid');
    var counts = h('div', 'rv-hsum-counts');
    RATING_ORDER.forEach(function (k) {
      var n = handReview.counts && handReview.counts[k];
      if (!n) return;
      var c = h('span', 'rv-count');
      c.setAttribute('data-rating', k);
      c.appendChild(icon(k, { size: 18 }));
      c.appendChild(h('span', 'rv-count-l', T.rating[k][lang] + ':')); c.appendChild(h('span', 'rv-count-n', String(n)));
      c.setAttribute('title', T.rating[k][lang]);
      counts.appendChild(c);
    });
    mid.appendChild(counts);
    if (handReview.netBB != null) {
      var net = h('span', 'rv-net ' + (handReview.netBB >= 0 ? 'is-pos' : 'is-neg'), T.net[lang] + ' ' + signed(handReview.netBB, lang) + ' BB');
      mid.appendChild(net);
    }
    root.appendChild(mid);
    var lk = handReview.luck && lucky(handReview.luck.label);
    if (lk) {
      var lb = h('div', 'rv-luck-inline');
      lb.appendChild(badge(lk, { lang: lang }));
      if (handReview.luck.text) lb.appendChild(h('p', 'rv-luck-text', handReview.luck.text[lang]));
      root.appendChild(lb);
    }
    if (container) { container.innerHTML = ''; container.appendChild(root); }
    return root;
  }

  /* ----------------------------------------------------------- replay screen (hero-only player)
   * Layout (REVIEW_UX.md): a header with back, title, hand picker, rating counts and the accuracy ring; the table, the
   * timeline and the controls on the left, the coach card on the right. On a phone the order is table, coach sheet,
   * timeline, controls (fixed at the bottom). The stepping unit is the hero's own decision: villain actions are applied
   * silently between stops. A decision stop has two phases: 'before' (the spot, hero to act) and 'after' (the hero's
   * action lands, its rating appears on the seat and in the coach card). After the last decision of a hand one 'end'
   * stop shows the hand result. Built with DOM calls only (data is written with textContent). */
  var TX = {
    back: { en: 'Back', es: 'Volver' },
    hand: { en: 'Hand {n}', es: 'Mano {n}' },
    moveN: { en: 'Move {i} of {n}', es: 'Jugada {i} de {n}' },
    handN: { en: 'Hand {h} of {H}', es: 'Mano {h} de {H}' },
    prevHand: { en: 'Previous hand (Up)', es: 'Mano anterior (Arriba)' },
    prevMove: { en: 'Previous move (Left)', es: 'Jugada anterior (Izquierda)' },
    play: { en: 'Play (Space)', es: 'Reproducir (Espacio)' },
    pause: { en: 'Pause (Space)', es: 'Pausar (Espacio)' },
    nextMove: { en: 'Next move (Right)', es: 'Jugada siguiente (Derecha)' },
    nextHand: { en: 'Next hand (Down)', es: 'Mano siguiente (Abajo)' },
    toAct: { en: 'To act', es: 'Actúa' },
    yourMove: { en: 'Your move', es: 'Tu jugada' },
    yourMoveHint: { en: 'Look at the spot. The coach rates your action next.', es: 'Mira la situación. El entrenador valora tu acción después.' },
    verdict: { en: 'You played {x} — best was {y}', es: 'Jugaste {x} — la mejor era {y}' },
    verdictSame: { en: 'You played {x} — that was the best move', es: 'Jugaste {x} — esa era la mejor jugada' },
    verdictOnly: { en: 'You played {x}', es: 'Jugaste {x}' },
    showBest: { en: 'Show best move', es: 'Ver mejor jugada' },
    hideBest: { en: 'Hide best move', es: 'Ocultar mejor jugada' },
    more: { en: 'More detail', es: 'Más detalle' },
    pot: { en: 'Pot', es: 'Bote' },
    potPill: { en: 'Pot {n} BB', es: 'Bote {n} BB' },
    winChance: { en: 'Chance to win (vs their likely hands)', es: 'Prob. de ganar (contra sus manos probables)' },
    needed: { en: 'Needed to call', es: 'Necesaria para igualar' },
    bbLost: { en: 'BB lost', es: 'BB perdidos' },
    accuracy: { en: 'Accuracy', es: 'Precisión' },
    net: { en: 'Net', es: 'Neto' },
    noReplay: { en: 'No replay was recorded for this hand. The coach still reviews its decisions.', es: 'No se grabó el replay de esta mano. El entrenador sigue revisando sus decisiones.' },
    bet: { en: 'Bet {n}', es: 'Apuesta {n}' },
    stack: { en: '{n} BB', es: '{n} BB' },
    you: { en: 'You', es: 'Tú' },
    result: { en: 'Hand result', es: 'Resultado de la mano' },
    won: { en: 'You won {n} BB', es: 'Ganaste {n} BB' },
    lost: { en: 'You lost {n} BB', es: 'Perdiste {n} BB' },
    even: { en: 'Broke even', es: 'Sin ganancia ni pérdida' },
    shown: { en: 'Cards shown at showdown', es: 'Cartas mostradas en el showdown' },
    noShown: { en: 'Won without a showdown', es: 'Ganada sin showdown' },
    countsLabel: { en: 'Moves by rating (click to jump)', es: 'Jugadas por calificación (pulsa para ir)' },
    timeline: { en: 'Your moves in this exam', es: 'Tus jugadas en este examen' },
    dotLabel: { en: 'Hand {h}, move {m}: {r}', es: 'Mano {h}, jugada {m}: {r}' },
    replayLabel: { en: 'Replay', es: 'Repetición' }
  };
  function tx(k, lang, p) {
    var s = TX[k] ? (TX[k][lang] || TX[k].en) : String(k);
    if (p) s = s.replace(/\{(\w+)\}/g, function (m, n) { return p[n] != null ? String(p[n]) : m; });
    return s;
  }
  var NAV_PATHS = {
    bar: 'M5 6v12', prevHand: 'M11 6l-6 6 6 6M18 6l-6 6 6 6', prev: 'M15 6l-6 6 6 6',
    next: 'M9 6l6 6-6 6', nextHand: 'M6 6l6 6-6 6M13 6l6 6-6 6', endBar: 'M19 6v12'
  };
  function svgPath(d, filled) {
    var s = svgEl('svg', { viewBox: '0 0 24 24', width: '24', height: '24', 'aria-hidden': 'true' });
    s.appendChild(svgEl('path', filled
      ? { d: d, fill: 'currentColor' }
      : { d: d, fill: 'none', stroke: 'currentColor', 'stroke-width': '2.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    return s;
  }
  function ctlIcon(k) {
    if (k === 'play') return svgPath('M8 5v14l11-7z', true);
    if (k === 'pause') return svgPath('M7 5h3.5v14H7zM13.5 5H17v14h-3.5z', true);
    var s = svgEl('svg', { viewBox: '0 0 24 24', width: '24', height: '24', 'aria-hidden': 'true' });
    var parts = k === 'prevHand' ? [NAV_PATHS.bar, NAV_PATHS.prevHand] : k === 'nextHand' ? [NAV_PATHS.nextHand, NAV_PATHS.endBar]
      : k === 'prev' ? [NAV_PATHS.prev] : [NAV_PATHS.next];
    parts.forEach(function (d) { s.appendChild(svgEl('path', { d: d, fill: 'none', stroke: 'currentColor', 'stroke-width': '2.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })); });
    return s;
  }
  function crossIcon() {
    var s = svgEl('svg', { viewBox: '0 0 24 24', width: '20', height: '20', 'aria-hidden': 'true' });
    s.appendChild(svgEl('path', { d: 'M6 6l12 12M18 6L6 18', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round' }));
    return s;
  }
  function btnEl(cls, label, onClick) {
    var b = h('button', cls);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.setAttribute('title', label);
    b.addEventListener('click', onClick);
    return b;
  }
  var STREET_CARDS = { preflop: 0, flop: 3, turn: 4, river: 5 };

  // Explanation text of a decision. text.explain ({en,es}, one human paragraph) when present; else text.short.
  function dtext(d, field, lang) {
    var t = d && d.text;
    if (t && typeof t === 'object' && t[field] && typeof t[field] === 'object') {
      var v = t[field][lang] || t[field].en;
      if (v) return v;
    }
    if (field === 'short' && t && typeof t.en === 'string') return t[lang] || t.en;
    if (field === 'headline' && d && d.headline) return d.headline[lang] || d.headline.en || '';
    return '';
  }
  // Optional detail: text.full bullets, shown only inside the "More detail" expander (empty when there are none).
  function dmore(d, lang) {
    var t = d && d.text;
    var out = [];
    if (t && Array.isArray(t.full)) t.full.forEach(function (b) {
      var v = b && typeof b === 'object' ? (b[lang] || b.en || '') : String(b || '');
      if (v) out.push(v);
    });
    return out;
  }
  // "raise to 6 BB", "call", "check", "fold" from a rated decision's best or played action.
  function actLabel(a, amountBB, lang) {
    if (!a) return '';
    if (a === 'raise' || a === 'bet') return amountBB != null ? T.act.raise[lang].replace('{n}', num(amountBB, lang, 1)) : (T.act.raise[lang].split(' ')[0]);
    if (a === 'limp') a = 'call';
    return T.act[a] ? T.act[a][lang] : String(a);
  }
  function histLabel(e, lang) { return actLabel(e.action, e.amount, lang); }

  // Hero stops of the whole exam. Each decision stop: k0 = history index of the hero action (table before it),
  // k1 = k0 + 1 (after it). The end stop of a hand: k0 = k1 = history length. Without a replay k0 = k1 = -1.
  function buildStops(hands) {
    var out = [];
    hands.forEach(function (hand, hi) {
      var decs = hand.decisions || [];
      var rp = hand.replay;
      var heroIdx = [];
      if (rp && rp.history) {
        var heroSeat = rp.heroSeat != null ? rp.heroSeat : 0;
        rp.history.forEach(function (e, i) { if (e.seat === heroSeat) heroIdx.push(i); });
      }
      var replayOk = heroIdx.length === decs.length && decs.length > 0;
      decs.forEach(function (d, di) {
        var k0 = replayOk ? heroIdx[di] : -1;
        out.push({ hi: hi, di: di, end: false, k0: k0, k1: replayOk ? k0 + 1 : -1 });
      });
      var n = rp && rp.history ? rp.history.length : -1;
      out.push({ hi: hi, di: -1, end: true, k0: n >= 0 ? n : -1, k1: n >= 0 ? n : -1 });
    });
    return out;
  }
  // Table state after k actions: stacks and street bets (BB), pot, folds, board, last action.
  function stateAt(hand, k) {
    var rp = hand.replay;
    var n = rp.history.length;
    var seats = rp.seats.map(function (s) {
      return { seat: s.seat, name: s.name, isHero: s.isHero, dealt: s.dealt, stack: s.startBB, bet: 0, folded: false, cards: s.cards || [] };
    });
    var pot = 0, street = 'preflop', last = null;
    for (var i = 0; i < k && i < n; i++) {
      var e = rp.history[i];
      var s = seats[e.seat];
      if (e.street !== street) { street = e.street; seats.forEach(function (x) { x.bet = 0; }); }
      if (!s) continue;
      if (e.action === 'fold') s.folded = true;
      s.stack -= e.put;
      s.bet += e.put;
      pot += e.put;
      last = e;
    }
    var vis = k < n ? rp.history[k].street : (n ? rp.history[n - 1].street : 'preflop');
    var cards = k >= n ? (rp.board || []).length : Math.min(STREET_CARDS[vis] || 0, (rp.board || []).length);
    return { seats: seats, pot: pot, board: (rp.board || []).slice(0, cards), last: last, atEnd: k >= n, showdown: !!rp.showdown };
  }
  function pctN(x) { return x == null || isNaN(x) ? '–' : Math.round(x) + '%'; }
  function tile(label, value, unit, cls) {
    var t = h('div', 'rv-tile' + (cls ? ' ' + cls : ''));
    t.appendChild(h('span', 'rv-tile-l', label));
    var v = h('span', 'rv-tile-v', value);
    if (unit) v.appendChild(h('span', 'rv-tile-u', ' ' + unit));
    t.appendChild(v);
    return t;
  }
  // Chance to win as a big number with a tiny bar: the fill is the chance, the tick is the chance needed to call.
  function winTile(chance, needed, lang) {
    var t = h('div', 'rv-tile rv-tile-win');
    t.appendChild(h('span', 'rv-tile-l', tx('winChance', lang)));
    t.appendChild(h('span', 'rv-tile-v', pct(chance)));
    if (chance != null) {
      var meter = h('div', 'rv-meter');
      meter.setAttribute('role', 'img');
      meter.setAttribute('aria-label', pct(chance) + ' · ' + tx('needed', lang) + ' ' + pctN(needed));
      var fill = h('span', 'rv-meter-fill ' + (needed == null || chance * 100 >= needed ? 'is-ok' : 'is-low'));
      fill.style.width = Math.round(chance * 100) + '%';
      meter.appendChild(fill);
      if (needed != null) {
        var mark = h('span', 'rv-meter-mark');
        mark.style.left = Math.round(needed) + '%';
        meter.appendChild(mark);
      }
      t.appendChild(meter);
    }
    return t;
  }

  function renderGame(container, gameReview, opts) {
    opts = opts || {};
    var lang = langOf(opts);
    var onClose = opts.onClose;
    var tickMs = opts.tickMs || 2500;                       // autoplay: time per hero move (end card waits longer)
    var popMs = opts.popMs != null ? opts.popMs : 420;      // 'before' shows the spot, then the hero's action lands
    container.innerHTML = '';
    var root = h('section', 'rv-replay');
    root.setAttribute('data-lang', lang);
    root.setAttribute('data-phase', 'none');
    root.setAttribute('aria-label', T.gameTitle[lang]);
    container.appendChild(root);
    var hands = (gameReview && gameReview.hands) || [];
    if (!hands.length) {
      root.appendChild(h('p', 'rv-notice', T.selectMove[lang]));
      return { root: root, destroy: function () { container.innerHTML = ''; } };
    }
    var flat = buildStops(hands);
    var handFirst = hands.map(function () { return -1; });
    var posOf = hands.map(function () { return []; });
    var decTotal = [];
    flat.forEach(function (s, p) {
      if (handFirst[s.hi] < 0) handFirst[s.hi] = p;
      if (!s.end) posOf[s.hi][s.di] = p;
      decTotal[s.hi] = (decTotal[s.hi] || 0) + (s.end ? 0 : 1);
    });
    var st = { pos: 0, phase: 'before', showBest: false, playing: false, timer: null, popTimer: null };

    /* header: back, title and move line, rating counts (jump), hand picker, accuracy ring */
    var head = h('header', 'rv-head');
    var back = btnEl('rv-iconbtn', tx('back', lang), function () { destroy(); if (onClose) onClose(); });
    back.appendChild(crossIcon());
    head.appendChild(back);
    var titleBox = h('div', 'rv-head-text');
    titleBox.appendChild(h('h2', 'rv-title', T.gameTitle[lang]));
    var subLine = h('p', 'rv-sub');
    var subMove = h('span', 'rv-sub-move');
    var subHand = h('span', 'rv-sub-hand');
    subLine.appendChild(subMove);
    subLine.appendChild(h('span', 'rv-sub-sep', ' · '));
    subLine.appendChild(subHand);
    titleBox.appendChild(subLine);
    head.appendChild(titleBox);
    var counts = h('div', 'rv-counts');
    counts.setAttribute('role', 'group');
    counts.setAttribute('aria-label', tx('countsLabel', lang));
    RATING_ORDER.forEach(function (k) {
      var nC = (gameReview.counts && gameReview.counts[k]) || 0;
      if (!nC) return;
      var c = btnEl('rv-count rating-' + k, T.rating[k][lang] + ': ' + nC, function () { jumpRating(k); });
      c.appendChild(icon(k, { size: 18 }));
      c.appendChild(h('span', 'rv-count-l', T.rating[k][lang]));
      c.appendChild(h('span', 'rv-count-n', String(nC)));
      counts.appendChild(c);
    });
    head.appendChild(counts);
    var handSel = h('select', 'rv-hand-select');
    handSel.setAttribute('aria-label', tx('replayLabel', lang));
    hands.forEach(function (hand, hi) {
      var o = h('option', null, tx('hand', lang, { n: hi + 1 }) + ' · ' + signed(hand.netBB, lang) + ' BB');
      o.value = String(hi);
      handSel.appendChild(o);
    });
    handSel.addEventListener('change', function () { goPos(handFirst[Number(handSel.value)], { manual: true }); });
    head.appendChild(handSel);
    var accBox = h('div', 'rv-head-acc');
    accBox.appendChild(accuracyBlock(gameReview.accuracy, lang, 56));
    head.appendChild(accBox);
    root.appendChild(head);

    /* table (the stage) */
    var stage = h('div', 'rv-stage');
    var table = h('div', 'rv-table');
    table.appendChild(h('div', 'rv-felt'));
    var potEl = h('div', 'rv-pot');
    var boardEl = h('div', 'rv-board');
    var seatLayer = h('div', 'rv-seats');
    table.appendChild(potEl);
    table.appendChild(boardEl);
    table.appendChild(seatLayer);
    stage.appendChild(table);
    root.appendChild(stage);

    /* coach card: rating, one-line verdict, stat tiles, win-chance note, explanation */
    var coach = h('aside', 'rv-coach');
    coach.setAttribute('aria-live', 'polite');
    var coachHead = h('div', 'rv-coach-head');
    var coachBody = h('div', 'rv-coach-body');
    coach.appendChild(coachHead);
    coach.appendChild(coachBody);
    root.appendChild(coach);

    /* timeline: one dot per hero move, grouped by hand (hand number first), current one ringed */
    var timeline = h('div', 'rv-timeline');
    timeline.setAttribute('role', 'group');
    timeline.setAttribute('aria-label', tx('timeline', lang));
    var markers = [];      // flat position -> dot of that decision
    var markFor = [];      // flat position -> flat position of the decision marker to highlight
    hands.forEach(function (hand, hi) {
      var g = h('div', 'rv-tl-group');
      var lbl = h('span', 'rv-tl-h', String(hi + 1));
      lbl.setAttribute('title', tx('hand', lang, { n: hi + 1 }));
      g.appendChild(lbl);
      (hand.decisions || []).forEach(function (d, di) {
        var p = posOf[hi][di];
        var rn = T.rating[d.rating] ? T.rating[d.rating][lang] : d.rating;
        var m = btnEl('rv-tl rating-' + d.rating, tx('dotLabel', lang, { h: hi + 1, m: di + 1, r: rn }), function () { goPos(p, { manual: true }); });
        m.setAttribute('data-rating', d.rating);
        m.appendChild(h('span', 'rv-tl-dot'));
        markers[p] = m;
        g.appendChild(m);
      });
      timeline.appendChild(g);
    });
    flat.forEach(function (s, p) {
      var q = p, found = -1;
      while (q >= 0 && flat[q].hi === s.hi) { if (!flat[q].end) { found = q; break; } q--; }
      markFor[p] = found;
    });
    root.appendChild(timeline);

    /* controls: previous hand, previous move, play/pause, next move, next hand (56px+, centred under the table) */
    var nav = h('nav', 'rv-controls');
    nav.setAttribute('aria-label', tx('replayLabel', lang));
    var bPrevHand = btnEl('rv-ctl', tx('prevHand', lang), function () { prevHand(); });
    bPrevHand.appendChild(ctlIcon('prevHand'));
    var bPrev = btnEl('rv-ctl', tx('prevMove', lang), function () { goPos(st.pos - 1, { manual: true }); });
    bPrev.appendChild(ctlIcon('prev'));
    var bPlay = btnEl('rv-ctl rv-ctl-play', tx('play', lang), function () { togglePlay(); });
    bPlay.setAttribute('aria-pressed', 'false');
    var bNext = btnEl('rv-ctl', tx('nextMove', lang), function () { goPos(st.pos + 1, { manual: true, animate: true }); });
    bNext.appendChild(ctlIcon('next'));
    var bNextHand = btnEl('rv-ctl', tx('nextHand', lang), function () { nextHand(); });
    bNextHand.appendChild(ctlIcon('nextHand'));
    [bPrevHand, bPrev, bPlay, bNext, bNextHand].forEach(function (b) { nav.appendChild(b); });
    root.appendChild(nav);

    function cur() { return flat[st.pos]; }
    function decOf(s) { return !s.end ? hands[s.hi].decisions[s.di] : null; }
    function clearPop() { if (st.popTimer) { clearTimeout(st.popTimer); st.popTimer = null; } }
    function stopPlay() { st.playing = false; if (st.timer) { clearTimeout(st.timer); st.timer = null; } }
    function goPos(p, o) {
      o = o || {};
      if (!flat.length) return;
      if (o.manual) stopPlay();
      p = Math.max(0, Math.min(flat.length - 1, p));
      var prev = st.pos;
      clearPop();
      st.pos = p;
      var s = flat[p];
      var forward = !!o.animate || p > prev;
      if (!s.end && forward && s.k0 >= 0) {
        st.phase = 'before';
        render();
        st.popTimer = setTimeout(function () { st.popTimer = null; st.phase = 'after'; render(); }, popMs);
      } else {
        st.phase = s.end ? 'end' : (s.k0 >= 0 ? 'after' : 'none');
        render();
      }
    }
    function prevHand() {
      var s = cur();
      var first = handFirst[s.hi];
      // inside a hand: back to its first move; at its first move: the previous hand
      goPos(st.pos > first ? first : (s.hi > 0 ? handFirst[s.hi - 1] : 0), { manual: true });
    }
    function nextHand() {
      var s = cur();
      if (s.hi < hands.length - 1) goPos(handFirst[s.hi + 1], { manual: true, animate: true });
    }
    function scheduleNext() {
      if (st.timer) clearTimeout(st.timer);
      var wait = flat[st.pos].end ? Math.round(tickMs * 1.6) : tickMs;
      st.timer = setTimeout(function () {
        st.timer = null;
        if (st.pos >= flat.length - 1) { stopPlay(); render(); return; }
        goPos(st.pos + 1, { animate: true });
        if (st.playing) scheduleNext();
      }, wait);
    }
    function togglePlay() {
      if (st.playing) { stopPlay(); render(); return; }
      st.playing = true;
      if (st.pos >= flat.length - 1) { goPos(0, { animate: true }); }
      scheduleNext();
      render();
    }
    function destroy() { stopPlay(); clearPop(); document.removeEventListener('keydown', onKey); }

    function renderHeader(s, d) {
      var hi = s.hi;
      var n = decTotal[hi] || 0;
      var i = s.end ? n : s.di + 1;
      subMove.textContent = tx('moveN', lang, { i: i, n: n });
      subHand.textContent = tx('handN', lang, { h: hi + 1, H: hands.length });
      handSel.value = String(hi);
    }
    function renderTable(hand, s, d) {
      seatLayer.textContent = '';
      boardEl.textContent = '';
      potEl.textContent = '';
      var rp = hand.replay;
      var before = st.phase === 'before' && d;
      var k = before ? s.k0 : s.k1;
      var sv = rp && k >= 0 ? stateAt(hand, k) : null;
      root.classList.toggle('is-no-replay', !sv);
      if (!sv) { seatLayer.appendChild(h('p', 'rv-notice', tx('noReplay', lang))); return; }
      potEl.textContent = tx('potPill', lang, { n: num(sv.pot, lang, 1) });
      sv.board.forEach(function (c) { var cc = miniCard(c); cc.classList.add('rv-board-card'); boardEl.appendChild(cc); });
      var n = sv.seats.length;
      var heroIdx = rp.heroSeat != null ? rp.heroSeat : 0;
      sv.seats.forEach(function (x, i) {
        // hero-centred: the hero sits at the bottom of the table, the others follow in seat order
        var off = ((i - heroIdx) % n + n) % n;
        var a = (2 * Math.PI * off) / n;
        var toAct = before && x.isHero;
        var cls = 'rv-seat' + (x.isHero ? ' is-hero' : '') + (x.folded ? ' is-folded' : '') +
          (sv.last && sv.last.seat === x.seat ? ' is-acting' : '') + (toAct ? ' is-tomove' : '');
        var seat = h('div', cls);
        seat.style.left = (50 + 36 * Math.sin(a)) + '%';
        seat.style.top = (50 + (root.classList.contains('is-compact') ? 33 : 38) * Math.cos(a)) + '%';
        seat.appendChild(h('span', 'rv-seat-name', x.isHero ? tx('you', lang) : x.name));
        seat.appendChild(h('span', 'rv-seat-stack', tx('stack', lang, { n: num(x.stack, lang, 1) })));
        var cards = h('span', 'rv-seat-cards');
        var reveal = x.isHero || (sv.atEnd && sv.showdown && !x.folded && x.cards && x.cards.length);
        if (reveal && x.cards && x.cards.length) x.cards.forEach(function (c) { cards.appendChild(miniCard(c)); });
        else if (!x.folded && x.dealt !== false) { cards.appendChild(h('span', 'rv-back')); cards.appendChild(h('span', 'rv-back')); }
        seat.appendChild(cards);
        if (x.bet > 0) seat.appendChild(h('span', 'rv-betchip', tx('bet', lang, { n: num(x.bet, lang, 1) })));
        if (rp.btnSeat === x.seat) seat.appendChild(h('span', 'rv-dealer', 'D'));
        if (sv.last && sv.last.seat === x.seat) seat.appendChild(h('span', 'rv-bubble', histLabel(sv.last, lang)));
        if (toAct) seat.appendChild(h('span', 'rv-tomove', tx('toAct', lang)));
        if (x.isHero && d && !before) {
          // the rating lands on the hero's seat, like a classification icon on the moved piece
          var pop = h('span', 'rv-rate');
          pop.setAttribute('data-rating', d.rating);
          pop.setAttribute('aria-label', T.rating[d.rating][lang]);
          pop.appendChild(icon(d.rating, { size: 26 }));
          seat.appendChild(pop);
        }
        if (x.isHero && st.showBest && d && d.best) {
          var g = h('span', 'rv-ghost', actLabel(d.best.action, d.best.amountBB, lang));
          g.setAttribute('aria-label', T.best[lang] + ': ' + g.textContent);
          seat.appendChild(g);
        }
        seatLayer.appendChild(seat);
      });
    }
    function renderCoach(hand, s, d, hi) {
      coachHead.textContent = '';
      coachBody.textContent = '';
      var rp = hand.replay;
      var before = st.phase === 'before' && d;
      var k = before ? s.k0 : s.k1;
      var sv = rp && k >= 0 ? stateAt(hand, k) : null;
      var pot = sv ? sv.pot : (d && d.scenario ? d.scenario.pot : null);
      var needed = d ? (d.potOddsNeededPct != null ? d.potOddsNeededPct : 0) : null;
      if (d && before) {
        coachHead.appendChild(h('h3', 'rv-coach-title', tx('yourMove', lang)));
        coachHead.appendChild(h('p', 'rv-coach-sub', tx('yourMoveHint', lang)));
        var t0 = h('div', 'rv-tiles');
        t0.appendChild(winTile(d.winChance, needed, lang));
        t0.appendChild(tile(tx('needed', lang), pctN(needed), '', ''));
        t0.appendChild(tile(tx('pot', lang), pot != null ? num(pot, lang, 1) : '–', pot != null ? 'BB' : '', ''));
        coachBody.appendChild(t0);
        return;
      }
      if (d) {
        var played = rp && s.k1 > 0 && sv ? histLabel(rp.history[s.k1 - 1], lang) : actLabel(d.action, d.amountBB, lang);
        var bestTxt = d.best ? actLabel(d.best.action, d.best.amountBB, lang) : '';
        var row = h('div', 'rv-rate-row');
        row.appendChild(icon(d.rating, { size: 44 }));
        row.appendChild(h('h3', 'rv-rate-name', ratingName(d.rating, lang, d)));
        coachHead.appendChild(row);
        var verdict = !bestTxt ? tx('verdictOnly', lang, { x: played })
          : bestTxt === played ? tx('verdictSame', lang, { x: played }) : tx('verdict', lang, { x: played, y: bestTxt });
        coachHead.appendChild(h('p', 'rv-verdict', verdict));
        if (d.best) {
          var tgl = btnEl('rv-ghostbtn', st.showBest ? tx('hideBest', lang) : tx('showBest', lang), function () { st.showBest = !st.showBest; render(); });
          tgl.textContent = st.showBest ? tx('hideBest', lang) : tx('showBest', lang);
          tgl.setAttribute('aria-pressed', st.showBest ? 'true' : 'false');
          row.appendChild(tgl);
        }
        var tiles = h('div', 'rv-tiles');
        tiles.appendChild(winTile(d.winChance, needed, lang));
        tiles.appendChild(tile(tx('needed', lang), pctN(needed), '', ''));
        tiles.appendChild(tile(tx('bbLost', lang), num(d.evLossBB || 0, lang, 2), 'BB', d.evLossBB > 0 ? 'is-lost' : 'is-kept'));
        coachBody.appendChild(tiles);
        // the chance moved with the same cards: one line says why (their bet narrowed or shifted their range)
        if (d.chanceShift && d.chanceShift.text) {
          coachBody.appendChild(h('p', 'rv-shift is-' + d.chanceShift.dir, d.chanceShift.text[lang] || d.chanceShift.text.en));
        }
        var expl = dtext(d, 'explain', lang) || dtext(d, 'short', lang);
        if (expl) coachBody.appendChild(h('p', 'rv-explain', expl));
        var more = dmore(d, lang);
        if (more.length) {
          var det = h('details', 'rv-more');
          det.appendChild(h('summary', null, tx('more', lang)));
          more.forEach(function (t) { det.appendChild(h('p', 'rv-more-p', t)); });
          coachBody.appendChild(det);
        }
        return;
      }
      // hand result (end stop) or a hand without decisions
      var net = hand.netBB || 0;
      var showdown = !!((rp && rp.showdown) || hand.showdown);
      coachHead.appendChild(h('h3', 'rv-coach-title', tx('result', lang)));
      coachHead.appendChild(h('p', 'rv-result' + (net < 0 ? ' is-neg' : net > 0 ? ' is-pos' : ''),
        net > 0 ? tx('won', lang, { n: signed(net, lang).replace(/^\+/, '') })
          : net < 0 ? tx('lost', lang, { n: signed(Math.abs(net), lang).replace(/^[+−]/, '') }) : tx('even', lang)));
      coachHead.appendChild(h('p', 'rv-coach-sub', showdown ? tx('shown', lang) : tx('noShown', lang)));
      var rt = h('div', 'rv-tiles');
      rt.appendChild(tile(tx('net', lang), signed(net, lang), 'BB', net < 0 ? 'is-lost' : 'is-kept'));
      var hr = gameReview.hands && gameReview.hands[hi];
      rt.appendChild(tile(tx('accuracy', lang), hr && hr.accuracy != null ? num(hr.accuracy, lang, 1) : '–', '', ''));
      coachBody.appendChild(rt);
      var lk = hand.luck && lucky(hand.luck.label === 'lucky' ? 'lucky' : hand.luck.label === 'bad_luck' ? 'bad_luck' : null);
      if (lk) {
        var lb = h('div', 'rv-luck');
        lb.appendChild(badge(lk, { lang: lang }));
        if (hand.luck.text) lb.appendChild(h('p', 'rv-luck-text', hand.luck.text[lang] || hand.luck.text.en));
        coachBody.appendChild(lb);
      }
    }
    function renderTimeline() {
      markers.forEach(function (m, p) { if (m) m.classList.toggle('is-current', markFor[st.pos] === p); });
      var cm = markers[markFor[st.pos]];
      // keep the current dot in view by moving the row itself (scrollIntoView could also move the overlay)
      if (cm && timeline.scrollWidth > timeline.clientWidth) {
        timeline.scrollLeft = Math.max(0, cm.offsetLeft - timeline.clientWidth / 2 + cm.offsetWidth / 2);
      }
    }
    function renderControls() {
      bPrevHand.disabled = st.pos <= 0;
      bPrev.disabled = st.pos <= 0;
      bNext.disabled = st.pos >= flat.length - 1;
      bNextHand.disabled = cur().hi >= hands.length - 1;
      bPlay.textContent = '';
      bPlay.appendChild(ctlIcon(st.playing ? 'pause' : 'play'));
      bPlay.setAttribute('aria-label', st.playing ? tx('pause', lang) : tx('play', lang));
      bPlay.setAttribute('title', st.playing ? tx('pause', lang) : tx('play', lang));
      bPlay.setAttribute('aria-pressed', st.playing ? 'true' : 'false');
    }
    // the next move with that rating after the current one (wraps to the first)
    function jumpRating(k) {
      var list = [];
      flat.forEach(function (s, p) { if (!s.end && hands[s.hi].decisions[s.di].rating === k) list.push(p); });
      if (!list.length) return;
      var nxt = list.filter(function (p) { return p > st.pos; })[0];
      goPos(nxt != null ? nxt : list[0], { manual: true, animate: true });
    }

    function render() {
      var s = cur();
      // a short table (landscape phone) gets compact seats and a tighter vertical seat ring
      root.classList.toggle('is-compact', table.clientHeight > 0 && table.clientHeight < 250);
      var hand = hands[s.hi];
      var d = decOf(s);
      root.setAttribute('data-phase', s.end ? 'end' : st.phase);
      root.classList.toggle('is-playing', st.playing);
      renderHeader(s, d);
      renderTable(hand, s, d);
      renderCoach(hand, s, d, s.hi);
      renderControls();
      renderTimeline();
    }

    // Keyboard: Left/Right move, Up/Down or PageUp/PageDown hand, Space play/pause, Home/End first/last stop, Escape back.
    function onKey(e) {
      if (!root.isConnected) return;
      var k = e.key;
      if (e.target && e.target.tagName === 'SELECT' && k !== ' ' && k !== 'Escape') return;
      if (k === 'ArrowLeft') goPos(st.pos - 1, { manual: true });
      else if (k === 'ArrowRight') goPos(st.pos + 1, { manual: true, animate: true });
      else if (k === 'ArrowUp' || k === 'PageUp') prevHand();
      else if (k === 'ArrowDown' || k === 'PageDown') nextHand();
      else if (k === 'Home') goPos(0, { manual: true });
      else if (k === 'End') goPos(flat.length - 1, { manual: true });
      else if (k === ' ') togglePlay();
      else if (k === 'Escape') { destroy(); if (onClose) onClose(); }
      else return;
      e.preventDefault();
    }
    document.addEventListener('keydown', onKey);
    goPos(0, { animate: true });
    return {
      root: root,
      select: function (hi, di) { goPos(posOf[hi][di], { manual: true }); },
      playing: function () { return st.playing; },
      destroy: function () { destroy(); container.innerHTML = ''; }
    };
  }

  var api = {
    icon: icon,
    badge: badge,
    moveCard: moveCard,
    renderGame: renderGame,
    renderHandSummary: renderHandSummary,
    toast: toast,
    // Always a readable name (never a raw key): the T table, else the key humanised in English.
    ratingName: function (key, l) {
      var lg = l === 'es' ? 'es' : l === 'en' ? 'en' : curLang;
      var s = ratingName(key, lg, null);
      return s && s !== key ? s : String(key || '').replace(/[_.]+/g, ' ').replace(/^\w/, function (c) { return c.toUpperCase(); });
    },
    setLang: function (l) { curLang = l === 'es' ? 'es' : 'en'; },
    RATING_ORDER: RATING_ORDER
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PokerReviewUI = api;
})();
