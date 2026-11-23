/* Poker Trainer: plain-language "?" help modal.
 * window.PokerHelp.open() / close(). Accessible: role=dialog, focus trap, Esc, backdrop click,
 * focus returns to the opener. Language follows window.I18N.lang() (ES or EN). */
(function () {
  'use strict';

  var C = {
    en: {
      title: 'How this trainer works',
      intro: 'Plain explanations. Everything here is an estimate, made for practice.',
      close: 'Close',
      more: 'More details',
      sections: [
        { h: 'Do the opponents have real cards?', p: [
          'Yes. Every hand is dealt from a real, shuffled deck of 52 cards. CPU players hold actual cards and play them according to their style. Hands stay hidden unless they reach showdown or a player shows them.'
        ] },
        { h: 'How is the win percentage calculated?', p: [
          'The app does not know the opponents\' cards, and neither do you. So it imagines thousands of possible deals of the unseen cards (the opponents\' cards and the rest of the board) and counts how often your hand wins. That share is your win percentage.',
          'When only a few cards are left to come, it plays out thousands of random endings, so the number is very close to exact (on the river it is exact).'
        ] },
        { h: 'Random cards or estimated range?', p: [
          '"Random opponent cards" assumes an opponent could hold any two cards. It is a fair baseline for comparing hands.',
          '"Estimated range" narrows that using what opponents did. Someone who raises before the flop probably has a strong hand, so the app gives them fewer weak hands. Later actions narrow it further.'
        ] },
        { h: 'Pot odds in one example', p: [
          'The pot holds 100 chips, including the bet you face. The bet to you is 25 chips. Calling costs 25 to win a pot of 125, so you need to win 25 out of 125, which is 20% of the time.',
          'If your hand wins more than 1 time in 5 at showdown, calling makes money in the long run.'
        ] },
        { h: 'How the 0 to 100 score is given', p: [
          'Each decision is compared with the best move found for that exact spot. The best move scores 100. A close alternative scores high. A clear mistake scores low.',
          'It is a scale, because several moves are often fine in poker. The text gives the reasons: your hand, the board, position, number of players and opponents\' styles.'
        ] },
        { h: 'Position, players and stack depth', p: [
          'Position: acting later means you see what the others did first, which is an advantage.',
          'Players: with more players, your hand needs to be stronger, because someone is more likely to have a better one.',
          'Stack depth: how many big blinds each player has. Deep stacks leave room to play after the flop; short stacks push or fold more.'
        ] },
        { h: 'Multiplayer', p: [
          'Multiplayer uses the same card logic: a real shuffled deck and real cards for everyone. The other seats are real people or CPUs. There is no hidden advice.'
        ] },
        { h: 'Limits', p: [
          'These are training estimates. The app is not a solver: it does not compute perfect strategy, and it simplifies how opponents bet. Use it to learn the reasons.'
        ] }
      ],
      details: [
        'Pot odds = call / (pot + call). In the example: 25 / (100 + 25) = 20%.',
        'Outs rule: each out (a card that completes your hand) is worth about 2% for each card still to come, so about 4% on the flop and 2% on the turn. A flush draw has 9 outs: about 36% on the flop (exact value 35%).',
        'Range narrowing: each possible hand the opponent could hold gets a weight. An action such as a raise keeps only the hands that would have made that raise, and the weights are then normalised.'
      ]
    },
    es: {
      title: 'Cómo funciona este entrenador',
      intro: 'Explicaciones sencillas. Todo aquí son estimaciones, hechas para practicar.',
      close: 'Cerrar',
      more: 'Más detalles',
      sections: [
        { h: '¿Los rivales tienen cartas reales?', p: [
          'Sí. Cada mano se reparte de una baraja real de 52 cartas, barajada. Los CPU tienen cartas de verdad y juegan según su estilo. Las manos quedan ocultas, salvo en el showdown o si un jugador las muestra.'
        ] },
        { h: '¿Cómo se calcula el porcentaje de victoria?', p: [
          'La app no conoce las cartas de los rivales, y tú tampoco. Por eso imagina miles de repartos posibles de las cartas ocultas (las de los rivales y el resto del tablero) y cuenta cuántas veces gana tu mano. Esa proporción es tu porcentaje de victoria.',
          'Con pocas cartas por salir simula miles de finales al azar, así que el número es muy cercano al real (en el river es exacto).'
        ] },
        { h: '¿Cartas al azar o rango estimado?', p: [
          '"Cartas al azar" supone que un rival puede tener cualquier par de cartas. Es una base justa para comparar manos.',
          '"Rango estimado" lo reduce según lo que hicieron los rivales. Quien sube antes del flop probablemente tiene una mano fuerte, así que se le asignan menos manos débiles. Las acciones posteriores lo reducen más.'
        ] },
        { h: 'Probabilidades del bote, con un ejemplo', p: [
          'El bote tiene 100 fichas, incluida la apuesta que enfrentas. La apuesta para ti es de 25 fichas. Pagar cuesta 25 para ganar un bote de 125, así que necesitas ganar 25 de cada 125, es decir, el 20% de las veces.',
          'Si tu mano gana más de 1 vez de cada 5 en el showdown, pagar rinde dinero a largo plazo.'
        ] },
        { h: 'Cómo se da la puntuación de 0 a 100', p: [
          'Cada decisión se compara con la mejor jugada encontrada para esa situación exacta. La mejor jugada puntúa 100. Una alternativa parecida puntúa alto. Un error claro puntúa bajo.',
          'Es una escala, porque en el póker varias jugadas suelen ser válidas. El texto explica los motivos: tu mano, el tablero, tu posición, el número de jugadores y el estilo de los rivales.'
        ] },
        { h: 'Posición, jugadores y profundidad de fichas', p: [
          'Posición: actuar más tarde significa ver antes lo que hicieron los demás, y eso es una ventaja.',
          'Jugadores: con más jugadores, tu mano necesita ser más fuerte, porque es más probable que alguien tenga una mejor.',
          'Profundidad: cuántas ciegas grandes tiene cada jugador. Con fichas profundas hay margen para jugar después del flop; con fichas cortas se va todo dentro o se retira más.'
        ] },
        { h: 'Multijugador', p: [
          'El multijugador usa la misma lógica de cartas: una baraja real barajada y cartas reales para todos. Los demás asientos son personas reales o CPU. No hay consejos ocultos.'
        ] },
        { h: 'Límites', p: [
          'Son estimaciones para entrenar. La app no es un solver: no calcula la estrategia perfecta y simplifica cómo apuestan los rivales. Úsala para aprender los motivos.'
        ] }
      ],
      details: [
        'Probabilidades del bote = pagar / (bote + pagar). En el ejemplo: 25 / (100 + 25) = 20%.',
        'Regla de los outs: cada out (carta que completa tu mano) vale unos 2% por cada carta que falta, es decir, unos 4% en el flop y 2% en el turn. Un proyecto de color tiene 9 outs: unos 36% en el flop (valor exacto 35%).',
        'Reducción del rango: cada mano posible del rival tiene un peso. Una acción como subir solo mantiene las manos que habrían subido, y luego los pesos se normalizan.'
      ]
    }
  };

  var overlay = null;
  var dialog = null;
  var body = null;
  var closeBtn = null;
  var opener = null;
  var isOpen = false;

  function lang() {
    try {
      var l = window.I18N && window.I18N.lang && window.I18N.lang();
      return l === 'es' ? 'es' : 'en';
    } catch (e) { return 'en'; }
  }

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    return n;
  }

  var page = 0;
  var pages = [];
  var pager = null;
  var prevBtn = null;
  var nextBtn = null;
  var dotsEl = null;

  function ensureDom() {
    if (overlay) return;
    overlay = el('div', { 'class': 'help-overlay hidden', id: 'help-overlay' });
    dialog = el('div', { 'class': 'help-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'help-title' });
    var head = el('div', { 'class': 'help-head' });
    var title = el('h2', { 'class': 'help-title', id: 'help-title' });
    closeBtn = el('button', { type: 'button', 'class': 'ghost small', id: 'help-close' });
    closeBtn.addEventListener('click', close);
    head.appendChild(title);
    head.appendChild(closeBtn);
    body = el('div', { 'class': 'help-body', 'aria-live': 'polite' });
    pager = el('div', { 'class': 'help-pager' });
    prevBtn = el('button', { type: 'button', 'class': 'ghost small', id: 'help-prev' });
    nextBtn = el('button', { type: 'button', 'class': 'ghost small', id: 'help-next' });
    dotsEl = el('span', { 'class': 'dots' });
    prevBtn.addEventListener('click', function () { show(page - 1); });
    nextBtn.addEventListener('click', function () { show(page + 1); });
    pager.appendChild(prevBtn);
    pager.appendChild(dotsEl);
    pager.appendChild(nextBtn);
    dialog.appendChild(head);
    dialog.appendChild(body);
    dialog.appendChild(pager);
    overlay.appendChild(dialog);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });
    document.body.appendChild(overlay);
    overlay._title = title;
  }

  // Pages: the intro goes with the first section; each section is one page; the details are the last page.
  function fill() {
    var L = C[lang()];
    overlay._title.textContent = L.title;
    closeBtn.textContent = L.close;
    prevBtn.textContent = lang() === 'es' ? 'Anterior' : 'Previous';
    nextBtn.textContent = lang() === 'es' ? 'Siguiente' : 'Next';
    pages = L.sections.map(function (s, i) {
      return function () {
        var frag = [];
        if (i === 0) frag.push(el('p', { 'class': 'help-intro' }, L.intro));
        var sec = el('section', { 'class': 'help-sec' });
        sec.appendChild(el('h3', null, s.h));
        s.p.forEach(function (txt) { sec.appendChild(el('p', null, txt)); });
        frag.push(sec);
        return frag;
      };
    });
    pages.push(function () {
      var det = el('section', { 'class': 'help-sec help-more' });
      det.appendChild(el('h3', null, L.more));
      L.details.forEach(function (txt) { det.appendChild(el('p', null, txt)); });
      return [det];
    });
    show(0);
  }

  function show(i) {
    if (i < 0 || i >= pages.length) return;
    page = i;
    body.textContent = '';
    pages[i]().forEach(function (n) { body.appendChild(n); });
    prevBtn.disabled = i === 0;
    nextBtn.disabled = i === pages.length - 1;
    dotsEl.textContent = '';
    pages.forEach(function (_, k) {
      dotsEl.appendChild(el('span', { 'class': k === i ? 'dot on' : 'dot', 'aria-hidden': 'true' }));
    });
    body.scrollTop = 0;
  }

  function focusables() {
    var list = dialog.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])');
    return Array.prototype.filter.call(list, function (n) {
      return !n.disabled && n.offsetParent !== null || n === closeBtn;
    });
  }

  function onKey(e) {
    if (!isOpen) return;
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    var items = focusables();
    if (items.length === 0) return;
    var first = items[0];
    var last = items[items.length - 1];
    var active = document.activeElement;
    var inside = dialog.contains(active);
    if (e.shiftKey) {
      if (!inside || active === first) { e.preventDefault(); last.focus(); }
    } else if (!inside || active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function open() {
    if (typeof document === 'undefined') return;
    ensureDom();
    if (isOpen) return;
    opener = document.activeElement;
    fill();
    overlay.classList.remove('hidden');
    isOpen = true;
    document.addEventListener('keydown', onKey, true);
    closeBtn.focus();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    overlay.classList.add('hidden');
    document.removeEventListener('keydown', onKey, true);
    if (opener && typeof opener.focus === 'function') opener.focus();
    opener = null;
  }

  if (typeof window !== 'undefined') {
    window.PokerHelp = { open: open, close: close, isOpen: function () { return isOpen; } };
    if (typeof document !== 'undefined' && document.addEventListener) {
      // The header button (#btn-help, owned by the header) opens the modal if it exists.
      document.addEventListener('click', function (e) {
        var t = e.target && e.target.closest ? e.target.closest('#btn-help') : null;
        if (t) { e.preventDefault(); open(); }
      });
    }
  }
})();
