/* Seat card: the one plate used for every seat (solo tables and, later, multiplayer).
 *
 * window.SeatCard API
 *   SeatCard.build(seat, opts) -> HTMLElement (.seat)
 *     seat: { seat, name, stack, position, style, lastAction, folded, busted, isHero, reveal: [codes], bet }
 *     opts: {
 *       t(key, vars)        translator (for last-action / 'you' labels); optional
 *       lang                'en' | 'es' (glossary language); default 'en'
 *       name                display name (string); default seat.name
 *       stackText           text for the stack line (e.g. "42.5") or null to hide it
 *       styleLabel          text for the style tag (bots only); null/'' hides it
 *       lastText            last-action chip text; '' hides it
 *       dealerBtn           true to show the D button
 *       toAct               true when this seat is to act now
 *       winner              true for a winning seat at showdown
 *       rel                 data-rel (0 = hero, 1.. clockwise), set by layoutTable()
 *       delay               animation delay in ms (optional)
 *       avatar              optional string (initial/letter) for a human seat
 *       cardEl(code)        renders one face-up card for `reveal` (optional; text fallback otherwise)
 *       tipText             text of the seat-level tooltip (last action); optional
 *     }
 *   SeatCard.glossPos(pos, lang)   -> { title, text } for a position badge
 *   SeatCard.glossStyle(style, lang) -> { title, text } for a style tag
 *   SeatCard.bindGloss(root)       one-time delegated handler (hover, focus, tap) for [data-gloss] elements
 *   SeatCard.STATES                 class names that describe the state of a seat
 * Markup (same class list in every mode): .seat > .seat-top(.pos-badge, .dealer-btn) > .seat-name
 *   > .seat-stack? > .style-tag? > .la-chip? > .mini-cards? ; .seat-backs (face-down pair, above the plate)
 * Glossary bubbles are position:fixed and live on document.body (never clipped by the table).
 */
(function (root) {
  'use strict';

  var POS = {
    en: {
      UTG: ['Under the Gun', 'First to act preflop. The hardest seat: you act before everyone, with the least information.'],
      'UTG+1': ['Under the Gun +1', 'Second to act preflop. Still early: play tight.'],
      'UTG+2': ['Under the Gun +2', 'Third to act preflop. Still an early seat: play tight.'],
      LJ: ['Lojack', 'Middle-early seat, two seats before the Hijack. Still before the button.'],
      HJ: ['Hijack', 'Middle-late seat, two seats before the button.'],
      CO: ['Cutoff', 'The seat right before the button. Acts late, so you can steal more.'],
      BTN: ['Button', 'Acts last after the flop: the best seat at the table.'],
      SB: ['Small Blind', 'Posts half a blind before the cards. Acts first after the flop, so it is hard to play.'],
      BB: ['Big Blind', 'Posts a full blind before the cards. Closes the preflop action.'],
      MP: ['Middle Position', 'Seats between early and late position.'],
      EP: ['Early Position', 'The first seats to act. Play tight.']
    },
    es: {
      UTG: ['Under the Gun', 'El primero en actuar en preflop. El asiento más difícil: actúas antes que nadie, con menos información.'],
      'UTG+1': ['Under the Gun +1', 'Segundo en actuar en preflop. Sigue siendo temprano: juega tight.'],
      'UTG+2': ['Under the Gun +2', 'Tercero en actuar en preflop. Sigue siendo posición temprana: juega tight.'],
      LJ: ['Lojack', 'Posición media-temprana, dos asientos antes del Hijack. Todavía antes del botón.'],
      HJ: ['Hijack', 'Posición media-tardía, dos asientos antes del botón.'],
      CO: ['Cutoff', 'El asiento justo antes del botón. Actúa tarde, así que puedes robar más.'],
      BTN: ['Botón', 'Actúa el último después del flop: el mejor asiento de la mesa.'],
      SB: ['Ciega pequeña', 'Pone media ciega antes de repartir. Actúa primero después del flop, así que es difícil de jugar.'],
      BB: ['Ciega grande', 'Pone la ciega completa antes de repartir. Cierra la acción en preflop.'],
      MP: ['Posición media', 'Asientos entre la posición temprana y la tardía.'],
      EP: ['Posición temprana', 'Los primeros en actuar. Juega tight.']
    }
  };

  var STYLE = {
    en: {
      tight: ['Tight: plays few hands', 'Plays only strong starting hands and waits for a good spot. Typical hands: pairs and big cards.\nExploit: steal their blinds and fold to their raises unless you have a strong hand; they rarely bluff.'],
      loose: ['Loose: plays many hands', 'Plays many hands, even weak ones, and sees lots of flops. Typical hands: suited connectors, any ace, small pairs.\nExploit: value bet thinner and bluff them less; their calls are wide.'],
      aggressive: ['Aggressive: bets and raises a lot', 'Bets and raises often, even without a made hand. Typical: wide raises and bluffs.\nExploit: do not fold too much to their bets; check strong hands to let them bluff, call with medium hands.'],
      passive: ['Passive: mostly calls', 'Mostly calls and checks, and rarely raises. Typical: calls with medium hands and bets only big hands.\nExploit: bet for value when you are ahead and bluff less; when they bet, take it seriously.'],
      balanced: ['Balanced: normal play', 'Mixes strong and weak hands with normal aggression. Typical: standard ranges, few obvious tells.\nExploit: play by the book and watch for patterns over several hands.']
    },
    es: {
      tight: ['Tight: juega pocas manos', 'Juega solo manos iniciales fuertes y espera buen momento. Manos típicas: parejas y cartas altas.\nExplotar: róbale las ciegas y retírate ante sus subidas salvo que tengas mano fuerte; casi nunca farolea.'],
      loose: ['Loose: juega muchas manos', 'Juega muchas manos, incluso débiles, y ve muchos flops. Manos típicas: conectores del mismo palo, cualquier as, parejas pequeñas.\nExplotar: apuesta por valor con manos más flojas y farolea menos; sus igualadas son anchas.'],
      aggressive: ['Agresivo: apuesta y sube mucho', 'Apuesta y sube a menudo, incluso sin mano hecha. Típico: subidas amplias y faroles.\nExplotar: no te retires demasiado ante sus apuestas; pasa con manos fuertes para que farolee e iguala con manos medias.'],
      passive: ['Pasivo: sobre todo iguala', 'Sobre todo iguala y pasa, y rara vez sube. Típico: iguala con manos medias y apuesta solo con manos grandes.\nExplotar: apuesta por valor cuando vas por delante y farolea menos; cuando apuesta, tómatelo en serio.'],
      balanced: ['Equilibrado: juego normal', 'Mezcla manos fuertes y débiles con agresividad normal. Típico: rangos estándar, pocas pistas claras.\nExplotar: juega según el libro y busca patrones en varias manos.']
    }
  };

  var STATES = ['hero', 'human', 'bot', 'folded', 'busted', 'in-hand', 'to-act', 'winner'];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function pick(table, lang, key) {
    var L = table[lang] || table.en;
    return L[key] || null;
  }
  function glossPos(pos, lang) {
    var p = pick(POS, lang === 'es' ? 'es' : 'en', String(pos || '').replace(/^UTG\+/, 'UTG+'));
    if (!p) return { title: String(pos || ''), text: '' };
    return { title: pos + ' – ' + p[0], text: p[1] };
  }
  // last-action explanations (the chip's bubble: the action's name, then one line on what it means)
  var ACT = {
    en: {
      fold: 'Give up the hand and forfeit the chips already put in.',
      check: 'Pass without betting, when no bet is owed.',
      call: 'Match the current bet to stay in the hand.',
      limp: 'Call the big blind before the flop instead of raising.',
      bet: 'Put chips in first, when no one has bet this round.',
      raise: 'Raise the bet, so the others must put in more to stay.',
      allin: 'Bet every chip you have left.',
      out: 'No chips left: the player is eliminated.'
    },
    es: {
      fold: 'Abandona la mano y pierde las fichas que ya puso.',
      check: 'Pasa sin apostar, cuando no debe nada.',
      call: 'Iguala la apuesta actual para seguir en la mano.',
      limp: 'Iguala la ciega grande antes del flop en lugar de subir.',
      bet: 'Pone fichas primero, cuando nadie ha apostado en esta ronda.',
      raise: 'Sube la apuesta; los demás deben poner más para seguir.',
      allin: 'Apuesta todas las fichas que le quedan.',
      out: 'Sin fichas: el jugador queda eliminado.'
    }
  };
  function actGloss(key, lang, name) {
    var L = ACT[lang === 'es' ? 'es' : 'en'];
    return { title: name || '', text: L[key] || '' };
  }
  function glossStyle(style, lang) {
    var p = pick(STYLE, lang === 'es' ? 'es' : 'en', style);
    if (!p) return { title: String(style || ''), text: '' };
    return { title: p[0], text: p[1] };
  }

  // Seat plate. Pure DOM: no layout is read here (layoutTable() sets position and width afterwards).
  function build(seat, opts) {
    opts = opts || {};
    var isHero = !!seat.isHero;
    var folded = !!seat.folded;
    var busted = !!seat.busted;
    var live = !folded && !busted;
    var cls = ['seat'];
    if (isHero) cls.push('hero'); else cls.push('opp');
    if (folded) cls.push('folded');
    if (busted) cls.push('busted');
    if (live) cls.push('in-hand');
    if (live && opts.toAct) cls.push('to-act');
    if (opts.winner) cls.push('winner');
    var card = el('div');
    card.className = cls.join(' ');
    if (!isHero) {
      card.tabIndex = 0;
      if (opts.tipText) card.setAttribute('data-tip', opts.tipText);
    }
    card.setAttribute('data-rel', String(opts.rel || 0));
    card.setAttribute('data-state', folded ? 'folded' : busted ? 'busted' : live ? 'live' : 'out');
    if (opts.delay != null) card.style.setProperty('--delay', opts.delay + 'ms');
    else card.style.animation = 'none';

    // face-down pair above a live opponent; replaced by the revealed cards at showdown
    var reveal = Array.isArray(seat.reveal) && seat.reveal.length ? seat.reveal : null;
    if (!isHero && live && !reveal) {
      var backs = el('span', 'seat-backs');
      backs.setAttribute('aria-hidden', 'true');
      backs.appendChild(el('i')); backs.appendChild(el('i'));
      card.appendChild(backs);
    }

    // round avatar at the top centre of the plate: a play-style illustration for a bot (the plate carries the
    // style glossary, so it still shows when a photo replaces this), a person silhouette for the hero
    var botStyle = !isHero && opts.styleLabel && seat.style ? String(seat.style) : null;
    var av = el('span', botStyle ? 'seat-avatar bot st-' + botStyle : 'seat-avatar');
    av.setAttribute('aria-hidden', 'true');
    if (botStyle) av.innerHTML = root.Symbols.svg(root.Symbols.styleIcon(botStyle));
    else av.appendChild(el('i'));
    card.appendChild(av);
    if (botStyle) {
      card.setAttribute('data-gloss', 'style');
      card.setAttribute('data-gkey', botStyle);
    }
    var top = el('div', 'seat-top');
    if (seat.position) {
      var pb = el('span', 'pos-badge pos-' + String(seat.position).replace('+', ''), seat.position);
      pb.setAttribute('data-gloss', 'pos');
      pb.setAttribute('data-gkey', String(seat.position));
      pb.tabIndex = 0;
      top.appendChild(pb);
    }
    if (opts.dealerBtn) top.appendChild(el('span', 'dealer-btn', 'D'));
    card.appendChild(top);

    card.appendChild(el('div', 'seat-name', opts.name != null ? opts.name : (seat.name || ('Seat ' + seat.seat))));
    // the stack stays on a folded plate too; a small 'Folded' flag sits in the top row (it is not a stack line)
    if (opts.stackText != null && opts.stackText !== '') card.appendChild(el('div', 'seat-stack', opts.stackText));
    if (folded && !busted) top.appendChild(el('span', 'seat-flag', (opts.lang || currentLang) === 'es' ? 'Retirado' : 'Folded'));
    // the play style is shown once: the avatar above (its glossary bubble is on the plate); no second style tag
    if (opts.lastText) { // every state (check, call, raise, fold, ...) is shown, folded seats too
      // the last action as a symbol; its name is the hover/tap bubble (data-gname)
      var act = root.Symbols.actionIcon(busted ? 'busted' : (seat.lastAction || opts.lastText));
      var chip = el('span', 'la-chip sym-tag la-' + act.key);
      chip.innerHTML = root.Symbols.svg(act.icon);
      chip.setAttribute('role', 'img');
      chip.setAttribute('aria-label', opts.lastText);
      chip.setAttribute('data-gloss', 'action');
      chip.setAttribute('data-gkey', act.key);
      chip.setAttribute('data-gname', opts.lastText);
      card.appendChild(chip);
    }
    if (reveal) {
      var mini = el('div', 'mini-cards');
      reveal.forEach(function (code) {
        var c = typeof opts.cardEl === 'function' ? opts.cardEl(code) : el('div', 'card', String(code));
        mini.appendChild(c);
      });
      card.appendChild(mini);
    }
    return card;
  }

  /* ---------- glossary bubble (one shared element on document.body) ---------- */
  var bubble = null, shown = null;
  var currentLang = 'en';
  function ensureBubble() {
    if (bubble) return bubble;
    bubble = el('div', 'gloss-bubble');
    bubble.setAttribute('role', 'tooltip');
    bubble.hidden = true;
    document.body.appendChild(bubble);
    return bubble;
  }
  function showGloss(target) {
    var b = ensureBubble();
    var kind = target.getAttribute('data-gloss');
    var key = target.getAttribute('data-gkey') || '';
    var g = kind === 'style' ? glossStyle(key, currentLang)
      : kind === 'action' ? actGloss(key, currentLang, target.getAttribute('data-gname') || '')
      : glossPos(key, currentLang);
    if (!g.text && kind !== 'action') return hideGloss();
    if (!g.title) return hideGloss();
    var isHero = target.closest && target.closest('.seat.hero');
    b.textContent = '';
    b.appendChild(el('strong', 'gloss-title', g.title));
    if (g.text) String(g.text).split('\n').forEach(function (line) { b.appendChild(el('span', 'gloss-line', line)); });
    if (kind === 'pos' && isHero) b.appendChild(el('span', 'gloss-line gloss-you', currentLang === 'es' ? 'Ese asiento eres tú.' : 'That is you.'));
    b.hidden = false;
    b.style.visibility = 'hidden';
    var r = target.getBoundingClientRect();
    var bw = b.offsetWidth, bh = b.offsetHeight;
    var left = r.left + r.width / 2 - bw / 2;
    left = Math.max(8, Math.min(window.innerWidth - bw - 8, left));
    var top = r.top - bh - 8;
    if (top < 8) top = r.bottom + 8;
    b.style.left = Math.round(left) + 'px';
    b.style.top = Math.round(top) + 'px';
    b.style.visibility = '';
    shown = target;
    b.setAttribute('data-kind', kind);
  }
  function hideGloss() {
    if (bubble) bubble.hidden = true;
    shown = null;
  }
  var bound = false;
  // Delegated, once per page: hover / focus show, tap or click toggles, and the event never reaches the seat tip.
  function bindGloss(lang) {
    if (lang) currentLang = lang === 'es' ? 'es' : 'en';
    if (bound) return;
    bound = true;
    function gl(target) { return target && target.closest ? target.closest('[data-gloss]') : null; }
    document.addEventListener('pointerover', function (e) {
      var g = gl(e.target); if (g && g !== shown) showGloss(g);
    });
    document.addEventListener('pointerout', function (e) {
      var g = gl(e.target);
      if (g && (!e.relatedTarget || !g.contains(e.relatedTarget))) hideGloss();
    });
    document.addEventListener('focusin', function (e) { var g = gl(e.target); if (g) showGloss(g); });
    document.addEventListener('focusout', function () { hideGloss(); });
    document.addEventListener('click', function (e) {
      var g = gl(e.target);
      if (!g) return;
      e.stopPropagation();
      if (shown === g) hideGloss(); else showGloss(g);
    }, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hideGloss(); });
    window.addEventListener('scroll', hideGloss, true);
    window.addEventListener('resize', hideGloss);
  }

  // Markup helpers for the multiplayer plates (mp.js builds its own seats): a bot's default avatar,
  // and the symbol for a style tag or a last action (the hover/tap bubble is bound by the caller).
  function styleAvatarHtml(style) {
    return '<span class="mp-av sm bot-style st-' + String(style) + '" aria-hidden="true">' +
      root.Symbols.svg(root.Symbols.styleIcon(style)) + '</span>';
  }
  function actionSymHtml(raw, label) {
    var act = root.Symbols.actionIcon(raw);
    return '<span class="sym-tag la-' + act.key + '" role="img" aria-label="' + String(label || '').replace(/"/g, '&quot;') + '">' +
      root.Symbols.svg(act.icon) + '</span>';
  }

  root.SeatCard = {
    styleAvatarHtml: styleAvatarHtml,
    actionSymHtml: actionSymHtml,
    build: build,
    glossPos: glossPos,
    glossStyle: glossStyle,
    bindGloss: bindGloss,
    hideGloss: hideGloss,
    STATES: STATES
  };
})(window);
