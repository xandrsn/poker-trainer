/* Poker Trainer review layer: rates each decision (chess.com-style labels), explains it in EN and ES,
 * grades a finished hand or game for luck, and summarises a game. Pure logic, no DOM.
 * Browser: window.PokerReview (needs window.PokerEngine). Node: module.exports (requires ./engine.js).
 * API and data formats: REVIEW_API.md (project root). Book rules: BOOK_MOVES.md (project root). */
(function () {
  'use strict';

  var ENG = (typeof window !== 'undefined' && window.PokerEngine) || require('./engine.js');

  var SAMPLES = 2000;                       // Monte Carlo samples per graded decision (engine seeds them: deterministic)
  // "Obvious" best moves are never Book (BOOK_MOVES.md section 0). Gap in BB or as a share of the pot (whichever is smaller).
  var OBV_BB = 1.0, OBV_POT = 0.25;
  var OBV_FOLD_WIN = 0.35;                  // folding facing a bet with at most this chance to win: trash
  var OBV_RAISE_WIN = 0.85;                 // betting or calling with at least this chance to win: a monster
  var RATINGS = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder', 'forced'];
  var GOOD_SET = { brilliant: 1, great: 1, best: 1, excellent: 1, good: 1, book: 1, forced: 1 };
  var BAD_SET = { inaccuracy: 1, mistake: 1, miss: 1, blunder: 1 };
  var ICONS = {
    brilliant: { glyph: '!!', color: '#1baca6', shape: 'disc' },
    great: { glyph: '!', color: '#5b8bb4', shape: 'disc' },
    best: { glyph: '★', color: '#96bc4b', shape: 'star' },
    excellent: { glyph: '✓+', color: '#7cab4f', shape: 'disc' },
    good: { glyph: '✓', color: '#9ab26a', shape: 'disc' },
    book: { glyph: 'B', color: '#a88865', shape: 'square' },
    inaccuracy: { glyph: '?!', color: '#f7c631', shape: 'disc' },
    mistake: { glyph: '?', color: '#e68a2e', shape: 'disc' },
    miss: { glyph: '×', color: '#ff7769', shape: 'disc' },
    blunder: { glyph: '??', color: '#ca3431', shape: 'disc' },
    forced: { glyph: '–', color: '#8b8b8b', shape: 'disc' },
  };
  var STREETS = ['preflop', 'flop', 'turn', 'river'];
  var MADE_NAMES = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

  /* ------------------------------------------------------------------ i18n */
  var DICT = {
    'amt.none': { en: '', es: '' },
    'pos.UTG': { en: 'UTG', es: 'UTG' }, 'pos.UTG+1': { en: 'UTG+1', es: 'UTG+1' }, 'pos.MP': { en: 'MP', es: 'MP' }, 'pos.LJ': { en: 'LJ', es: 'LJ' },
    'pos.HJ': { en: 'HJ', es: 'HJ' }, 'pos.CO': { en: 'CO', es: 'CO' }, 'pos.BTN': { en: 'BTN', es: 'BTN' }, 'pos.SB': { en: 'SB', es: 'SB' }, 'pos.BB': { en: 'BB', es: 'BB' },
    'act.fold': { en: 'fold', es: 'retirarse' },
    'act.call': { en: 'call', es: 'igualar' },
    'act.check': { en: 'check', es: 'pasar' },
    'act.raise': { en: 'raise', es: 'subir' },
    'act.bet': { en: 'bet', es: 'apostar' },
    'rating.brilliant': { en: 'Brilliant', es: 'Brillante' },
    'rating.great': { en: 'Great', es: 'Genial' },
    'rating.best': { en: 'Best', es: 'Mejor' },
    'rating.excellent': { en: 'Excellent', es: 'Excelente' },
    'rating.good': { en: 'Good', es: 'Buena' },
    'rating.book': { en: 'Book', es: 'Libro' },
    'rating.inaccuracy': { en: 'Inaccuracy', es: 'Imprecisión' },
    'rating.mistake': { en: 'Mistake', es: 'Error' },
    'rating.miss': { en: 'Miss', es: 'Oportunidad perdida' },
    'rating.blunder': { en: 'Blunder', es: 'Error grave' },
    'rating.forced': { en: 'Forced', es: 'Forzada' },
    // Headlines (max 8 words)
    'hl.forced': { en: 'No real decision here', es: 'Sin decisión real' },
    'hl.book': { en: 'Book move: standard play', es: 'Jugada de libro: juego estándar' },
    // (Bullet keys f.*, tip.*, best.* below are deprecated: text.full is [] now; kept for old saved data.)
    'hl.good': { en: '{rating}: {act}', es: '{rating}: {act}' },
    'hl.bad': { en: '{rating}: next time, {cmd}.', es: '{rating}: la próxima vez, {cmd}.' },
    'hl.miss': { en: 'Miss: {cmd} instead.', es: 'Oportunidad perdida: {cmd} en su lugar.' },
    'hl.foldfree': { en: 'Blunder: never fold a free check', es: 'Error grave: no te retires si pasas gratis' },
    // Short texts (1-2 sentences, at most 3 numbers). {cmd} = imperative of the best action, {reason} = one sentence.
    'sh.forced': { en: 'You had no chips left, so there was no real choice.', es: 'No te quedaban fichas, así que no había decisión real.' },
    'sh.book': { en: 'Book move: {act} is the standard play in this spot. Keep it.', es: 'Jugada de libro: {act} es lo estándar aquí. Repítela.' },
    'sh.best': { en: 'Best: {act} was the top play here, and you lost nothing.', es: 'Mejor: {act} fue la mejor jugada aquí, y no perdiste nada.' },
    'sh.great': { en: '{rating}: {act} was clearly better than the other lines. {reason}', es: '{rating}: {act} fue claramente mejor que las demás. {reason}' },
    'sh.brilliant': { en: '{rating}: {act} was hard to find, and the other lines lose more. {reason}', es: '{rating}: {act} era difícil de ver, y las demás pierden más. {reason}' },
    'sh.good': { en: '{rating}: {act} is close to the best line. You give up {loss} BB.', es: '{rating}: {act} está cerca de la mejor. Cedes {loss} BB.' },
    'sh.bad': { en: '{rating}: {act} loses about {loss} BB on average. Next time, {cmd} here.', es: '{rating}: {act} pierde unos {loss} BB de media. La próxima vez, {cmd} aquí.' },
    'sh.call_light': { en: '{rating}: you needed {need}% to call, but had {win}%. Next time, {cmd} here.', es: '{rating}: para igualar necesitabas un {need}%, y tenías un {win}%. La próxima vez, {cmd} aquí.' },
    'sh.fold_tight': { en: '{rating}: you folded with {win}% to win, but calling needed only {need}%. Next time, {cmd} here.', es: '{rating}: te retiraste con un {win}% de ganar, pero igualar pedía solo un {need}%. La próxima vez, {cmd} aquí.' },
    'sh.fold_free': { en: 'Blunder: checking was free, so folding threw away your {win}% chance. Next time, check.', es: 'Error grave: pasar era gratis, así que retirarte tiró tu {win}% de probabilidad. La próxima vez, pasa.' },
    'sh.miss': { en: 'Miss: you had {win}% to win, and {best} wins more. Next time, {cmd} here.', es: 'Oportunidad perdida: tenías un {win}% de ganar, y {best} gana más. La próxima vez, {cmd} aquí.' },
    // Verb forms: noun (after "is"/"was"), imperative (Next time, ...), past (you ...). 'bet' = raise when nobody has bet.
    'noun.fold': { en: 'folding', es: 'retirarte' }, 'noun.call': { en: 'calling', es: 'igualar' }, 'noun.check': { en: 'checking', es: 'pasar' },
    'noun.raise': { en: 'raising', es: 'subir' }, 'noun.bet': { en: 'betting', es: 'apostar' },
    'cmd.fold': { en: 'fold', es: 'retírate' }, 'cmd.call': { en: 'call', es: 'iguala' }, 'cmd.check': { en: 'check', es: 'pasa' },
    'cmd.raise': { en: 'raise', es: 'sube' }, 'cmd.bet': { en: 'bet', es: 'apuesta' },
    'past.fold': { en: 'folded', es: 'te retiraste' }, 'past.call': { en: 'called', es: 'igualaste' }, 'past.check': { en: 'checked', es: 'pasaste' },
    'past.raise': { en: 'raised', es: 'subiste' }, 'past.bet': { en: 'bet', es: 'apostaste' },
    'holdN.pre': { en: 'hand', es: 'mano' }, 'holdN.made': { en: 'made hand', es: 'mano hecha' }, 'holdN.draw': { en: 'draw', es: 'proyecto' },
    'holdN.air': { en: 'hand (no pair, no draw)', es: 'mano (sin pareja ni proyecto)' },
    // Why the best line works (one sentence; {best} = its noun).
    'rsn.fold': { en: 'Folding avoids a call that loses money over time.', es: 'Retirarte evita un pago que pierde dinero a la larga.' },
    'rsn.call': { en: 'Calling keeps the price right for your chance to win.', es: 'Igualar tiene buen precio para tu probabilidad de ganar.' },
    'rsn.check_weak': { en: 'Checking is free, so you see the next card at no cost and keep your chips.', es: 'Pasar es gratis, así que ves la siguiente carta sin coste y guardas tus fichas.' },
    'rsn.check_mid': { en: 'Checking is free and keeps the pot small.', es: 'Pasar es gratis y mantiene el bote pequeño.' },
    'rsn.check_strong': { en: 'Checking keeps the pot small while your strong hand waits for a bet.', es: 'Pasar mantiene el bote pequeño mientras tu mano fuerte espera una apuesta.' },
    'rsn.raise_weak': { en: '{best} takes the pot right away, or builds it with a hand that plays well.', es: '{best} se lleva el bote ya, o lo hace crecer con una mano que juega bien.' },
    'rsn.raise_strong': { en: '{best} builds the pot while you are ahead, and weaker hands fold.', es: '{best} hace crecer el bote mientras vas por delante, y las manos débiles se retiran.' },
    // Full text bullets (3-6 per decision)
    'f.allin': { en: 'All-in: calling means putting in all your chips.', es: 'All-in: igualar significa meter todas tus fichas.' },
    'f.bet': { en: 'You must pay {call} BB to stay in. The pot is {total} BB.', es: 'Debes pagar {call} BB para seguir. El bote es de {total} BB.' },
    'f.nobet': { en: 'Nobody has bet, so checking is free.', es: 'Nadie ha apostado, así que pasar es gratis.' },
    'f.price': { en: 'To break even on a call, you need to win {need}% of the time. Your chance is {win}%.', es: 'Para salir igual al igualar necesitas ganar el {need}% de las veces. Tu probabilidad es {win}%.' },
    'f.win': { en: 'Your chance to win this pot is {win}%.', es: 'Tu probabilidad de ganar este bote es del {win}%.' },
    'f.hand': { en: 'Your hand: {made}. {posn}', es: 'Tu mano: {made}. {posn}' },
    'f.chart': { en: 'The preflop chart says {chartAct} from {pos} with {n} players.', es: 'La tabla preflop dice {chartAct} desde {pos} con {n} jugadores.' },
    'f.best': { en: 'Best move: {best}. Why: {reason}', es: 'Mejor jugada: {best}. Por qué: {reason}' },
    'f.ev': { en: 'On average, your play gives up {loss} BB compared with the best move.', es: 'De media, tu jugada cede {loss} BB frente a la mejor.' },
    'f.ev_same': { en: 'On average, your play is as good as the best move.', es: 'De media, tu jugada es igual de buena que la mejor.' },
    'tip.fold_free': { en: 'Tip: never fold when checking is free.', es: 'Consejo: nunca te retires si puedes pasar gratis.' },
    'tip.call': { en: 'Tip: call only when your chance beats the number you need.', es: 'Consejo: iguala solo si tu probabilidad supera la que necesitas.' },
    'tip.fold': { en: 'Tip: when the call is cheap enough, call instead of folding.', es: 'Consejo: si igualar sale barato, iguala en vez de retirarte.' },
    'tip.value': { en: 'Tip: with a strong hand, raise instead of calling or checking.', es: 'Consejo: con una mano fuerte, sube en vez de igualar o pasar.' },
    'tip.raise': { en: 'Tip: raise only when you have a clear edge.', es: 'Consejo: sube solo cuando tengas una ventaja clara.' },
    'tip.pre': { en: 'Tip: check the preflop chart from your seat before you act.', es: 'Consejo: mira la tabla preflop de tu posición antes de actuar.' },
    'tip.good': { en: 'Tip: this is the kind of play to repeat.', es: 'Consejo: repite este tipo de jugada.' },
    'best.fold': { en: 'folding loses least, because calling costs more than you can win.', es: 'retirarse pierde menos, porque igualar cuesta más de lo que puedes ganar.' },
    'best.call': { en: 'calling is right, since your chance beats the number you need.', es: 'igualar es correcto, porque tu probabilidad supera la que necesitas.' },
    'best.check': { en: 'checking is free and keeps the pot small.', es: 'pasar es gratis y mantiene el bote pequeño.' },
    'best.raise': { en: 'raising wins more: weak hands fold and strong hands pay you.', es: 'subir gana más: las manos débiles se retiran y las fuertes pagan.' },
    'posn.in': { en: 'You act last on later streets, which helps.', es: 'Actúas al final en las calles siguientes, lo que ayuda.' },
    'posn.out': { en: 'You act first on later streets, which hurts.', es: 'Actúas primero en las calles siguientes, lo que perjudica.' },
    // Short facts (why[] list, kept for the UI)
    'why.price': { en: 'To call {call} BB you need {need}% to win. Your chance is {win}%.', es: 'Para igualar {call} BB necesitas un {need}% de ganar. Tu probabilidad es {win}%.' },
    'why.free': { en: 'Checking is free. Your chance to win is {win}%.', es: 'Pasar es gratis. Tu probabilidad de ganar es {win}%.' },
    'why.free_raise': { en: 'Nobody has bet. Your chance to win is {win}%.', es: 'Nadie ha apostado. Tu probabilidad de ganar es {win}%.' },
    'why.fold_free': { en: 'Folding when checking is free throws away your share of the pot.', es: 'Retirarte pudiendo pasar regala tu parte del bote.' },
    'why.in_pos': { en: 'You act last on later streets, which helps.', es: 'Actúas al final en las calles siguientes, lo que ayuda.' },
    'why.out_pos': { en: 'You act first on later streets, which hurts.', es: 'Actúas primero en las calles siguientes, lo que perjudica.' },
    'why.villains': { en: '{n} opponent(s) still in. Their hands are {strength}: about {pct}% of all hands.', es: '{n} rival(es) en la mano. Sus manos son {strength}: unas {pct}% de todas.' },
    'str.very': { en: 'very strong', es: 'muy fuertes' },
    'str.strong': { en: 'strong', es: 'fuertes' },
    'str.wide': { en: 'mixed', es: 'variadas' },
    'why.made': { en: 'Your hand: {made}.', es: 'Tu mano: {made}.' },
    'made.High card': { en: 'high card', es: 'carta alta' },
    'made.Pair': { en: 'a pair', es: 'pareja' },
    'made.Two pair': { en: 'two pair', es: 'doble pareja' },
    'made.Three of a kind': { en: 'three of a kind', es: 'trío' },
    'made.Straight': { en: 'a straight', es: 'escalera' },
    'made.Flush': { en: 'a flush', es: 'color' },
    'made.Full house': { en: 'a full house', es: 'full' },
    'made.Four of a kind': { en: 'four of a kind', es: 'póker' },
    'made.Straight flush': { en: 'a straight flush', es: 'escalera de color' },
    'why.outs': { en: 'You have {outs} cards that improve your hand: about {hit}% to hit one.', es: 'Tienes {outs} cartas que mejoran tu mano: unas {hit}% de salir una.' },
    'why.tex': { en: 'The board is {tex}.', es: 'El tablero es {tex}.' },
    'tex.wet': { en: 'wet (many draws are possible)', es: 'mojado (hay muchos proyectos)' },
    'tex.dry': { en: 'dry (few draws)', es: 'seco (pocos proyectos)' },
    'tex.paired': { en: 'paired', es: 'emparejado' },
    'why.spr': { en: 'You have {stack} BB behind, about {spr} times the pot.', es: 'Te quedan {stack} BB, unas {spr} veces el bote.' },
    'why.chart': { en: 'The preflop chart from {pos} says {action} with {n} players.', es: 'La tabla preflop desde {pos} dice {action} con {n} jugadores.' },
    'why.cbet': { en: 'Standard continuation bet: you raised before the flop and the flop came to you.', es: 'Apuesta de continuación estándar: subiste antes del flop y el flop te llegó a ti.' },
    'why.size': { en: 'Your bet was {size}% of the pot. The best size is about {best}%.', es: 'Tu apuesta fue el {size}% del bote. El mejor tamaño ronda el {best}%.' },
    'why.allin': { en: 'This decision puts all your chips in.', es: 'Esta decisión mete todas tus fichas.' },
    // Luck (per hand)
    'luck.bad': { en: 'Bad luck: you were {win}% to win and the cards just didn\'t fall your way. Play it the same way next time.', es: 'Mala suerte: tenías un {win}% de ganar y las cartas no te acompañaron. Juégalo igual la próxima vez.' },
    'luck.bad.2': { en: 'Bad luck: you were {win}% to win, and the last cards went against you. The play was sound, so keep doing it.', es: 'Mala suerte: tenías un {win}% de ganar, y las últimas cartas fueron en tu contra. La jugada fue sólida, así que sigue igual.' },
    'luck.bad.3': { en: 'Bad luck: you were {win}% to win, and the cards did not cooperate. Your decisions were fine, so repeat them.', es: 'Mala suerte: tenías un {win}% de ganar, y las cartas no ayudaron. Tus decisiones fueron correctas, así que repítelas.' },
    'luck.lucky': { en: 'Lucky: you were only {win}% to win, and the cards gave you the pot. Do not expect this every time.', es: 'Suerte: solo tenías un {win}% de ganar, y las cartas te dieron el bote. No esperes que pase siempre.' },
    'luck.lucky.2': { en: 'Lucky: you were just {win}% to win, but the cards came your way. Judge the play, not the result.', es: 'Suerte: tenías solo un {win}% de ganar, pero las cartas te acompañaron. Juzga la jugada, no el resultado.' },
    'luck.lucky.3': { en: 'Lucky: your chance was only {win}%, and the cards gave you the pot. Your play did not change, so do not count on it.', es: 'Suerte: tu probabilidad era solo un {win}%, y las cartas te dieron el bote. Tu juego no cambió, así que no cuentes con ello.' },
    'luck.none': { en: 'Luck did not change this hand much.', es: 'La suerte no cambió mucho esta mano.' },
    'rvp.good_bad': { en: 'Good play, bad result.', es: 'Buen juego, mal resultado.' },
    'rvp.bad_good': { en: 'Bad play, good result.', es: 'Mal juego, buen resultado.' },
    'rvp.good_good': { en: 'Good play, good result.', es: 'Buen juego, buen resultado.' },
    'rvp.bad_bad': { en: 'Bad play, bad result.', es: 'Mal juego, mal resultado.' },
    'rvp.unknown': { en: 'Result not known.', es: 'Resultado desconocido.' },
    // Game summary
    'sum.luck_lucky': { en: 'Overall you got lucky: you won {luck} BB more than your play earned.', es: 'En conjunto tuviste suerte: ganaste {luck} BB más de lo que tu juego merecía.' },
    'sum.luck_unlucky': { en: 'Overall the cards went against you: you lost {luck} BB more than your play earned.', es: 'En conjunto las cartas fueron en tu contra: perdiste {luck} BB más de lo que tu juego merecía.' },
    'sum.luck_none': { en: 'Results match your play. Luck made little difference.', es: 'Los resultados encajan con tu juego. La suerte influyó poco.' },
    'sugg.preflop': { en: 'Study the preflop charts: you made {n} preflop mistake(s).', es: 'Repasa las tablas preflop: cometiste {n} error(es) preflop.' },
    'sugg.value': { en: 'You missed {n} chance(s) to raise a strong hand. Raise more when you are ahead.', es: 'Perdiste {n} oportunidad(es) de subir con una mano fuerte. Sube más cuando vas ganando.' },
    'sugg.calls': { en: '{n} call(s) were too loose. Before calling, check that your chance beats the number you need.', es: '{n} igualada(s) fueron demasiado sueltas. Antes de igualar, mira si tu probabilidad supera la que necesitas.' },
    'sugg.free_check': { en: 'You folded {n} time(s) when checking was free. Never do that.', es: 'Te retiraste {n} vez/veces pudiendo pasar gratis. No lo hagas.' },
    'sugg.street': { en: 'You lost the most BB on the {street}. Slow down and think more there.', es: 'Perdiste más BB en el {street}. Frena y piensa más ahí.' },
    'sugg.good': { en: 'Solid game: keep the same routine.', es: 'Partida sólida: mantén la misma rutina.' },
    'street.preflop': { en: 'preflop', es: 'preflop' },
    'street.flop': { en: 'flop', es: 'flop' },
    'street.turn': { en: 'turn', es: 'turn' },
    'street.river': { en: 'river', es: 'river' },
  };

  function fmtNum(lang, x) {
    if (Number.isInteger(x)) return String(x);
    var s = String(Math.round(x * 100) / 100);
    return lang === 'es' ? s.replace('.', ',') : s;
  }
  function resolveParam(v, lang) {
    if (v && typeof v === 'object' && v.$t) return format(v.$t, v, lang);
    if (typeof v === 'number') return fmtNum(lang, v);
    return v == null ? '' : String(v);
  }
  // format(key, params, lang): localized string. Params may hold {$t: key, ...} for nested phrases.
  function format(key, params, lang) {
    var L = lang === 'es' ? 'es' : 'en';
    var d = DICT[key];
    if (!d) return key;
    var s = d[L] || d.en;
    return s.replace(/\{(\w+)\}/g, function (m, k) {
      return params && Object.prototype.hasOwnProperty.call(params, k) ? resolveParam(params[k], L) : m;
    });
  }
  function render(parts, lang) {
    return parts.map(function (p) { return format(p.key, p.params, lang); }).join(' ');
  }
  function both(parts) { return { en: render(parts, 'en'), es: render(parts, 'es') }; }

  /* ------------------------------------------------------------ helpers */
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function r2(x) { return Math.round(x * 100) / 100; }
  function pct(x) { return Math.round(x * 100); }
  function sizeAmt(a) { return a == null ? { $t: 'amt.none' } : { $t: 'amt.to', n: r2(a) }; }

  function heroOf(sc) {
    var h = (sc.seats || []).find(function (s) { return s.isHero; });
    if (!h) throw new Error('scenario has no hero seat');
    return h;
  }
  function normAction(a) {
    var s = String(a || '').toLowerCase();
    if (s === 'check') return 'call';
    if (s === 'bet') return 'raise';
    if (s === 'fold' || s === 'call' || s === 'raise') return s;
    throw new Error('unknown action: ' + a);
  }

  // Preflop chart spot from the other seats' roles (same mapping as the engine's CHART_FACING).
  function chartFacing(sc, hero) {
    var others = sc.seats.filter(function (s) { return !s.isHero && !s.folded; });
    var roles = others.map(function (s) { return s.preflopRole; });
    if (roles.indexOf('3bet') >= 0 || roles.indexOf('4bet') >= 0) return 'vs_3bet';
    if (roles.indexOf('open') >= 0) return 'vs_raise';
    if (roles.indexOf('limp') >= 0) return 'vs_limp';
    return 'open';
  }
  // Book action from the preflop chart (primary recommendation), or null outside the charts.
  function bookPreflop(sc, hero) {
    var n = sc.numPlayers;
    var pos = sc.heroPosition || hero.position;
    var facing = chartFacing(sc, hero);
    try {
      var grid = ENG.getRangeChart(n, pos, facing, { lang: 'en', stackBB: sc.heroStack });
      var key = ENG.handClass(sc.hero[0], sc.hero[1]);
      for (var i = 0; i < grid.grid.length; i++) {
        for (var j = 0; j < grid.grid[i].length; j++) {
          var c = grid.grid[i][j];
          if (c.hand === key) return { action: c.raise ? 'raise' : c.call ? 'call' : 'fold', facing: facing, n: n, pos: pos, hand: key };
        }
      }
    } catch (e) { return null; }
    return null;
  }
  // Standard flop c-bet: hero was the last preflop raiser, the flop is checked to hero, at most 2 opponents.
  function isStandardCbet(sc, hero) {
    if (sc.street !== 'flop' || (sc.toCall || 0) > 0) return false;
    var hist = sc.history || [];
    var lastPre = null;
    hist.forEach(function (h) { if (h.street === 'preflop' && (h.action === 'raise' || h.action === 'bet')) lastPre = h; });
    if (!lastPre || lastPre.seat !== hero.seat) return false;
    var opps = sc.seats.filter(function (s) { return !s.isHero && !s.folded; }).length;
    return opps >= 1 && opps <= 2;
  }
  function boardTexture(board) {
    var ranks = board.map(function (c) { return '23456789TJQKA'.indexOf(c[0]); });
    var suits = board.map(function (c) { return c[1]; });
    var paired = ranks.some(function (r, i) { return ranks.indexOf(r) !== i; });
    var suitCount = {};
    suits.forEach(function (s) { suitCount[s] = (suitCount[s] || 0) + 1; });
    var maxSuit = Math.max.apply(null, Object.keys(suitCount).map(function (k) { return suitCount[k]; }));
    var sorted = ranks.slice().sort(function (a, b) { return a - b; });
    var connected = sorted.some(function (r, i) { return i > 0 && r - sorted[i - 1] <= 2; });
    if (paired) return 'paired';
    return maxSuit >= 3 || connected ? 'wet' : 'dry';
  }

  /* ------------------------------------------------- coach paragraph (text.explain) */
  // Human, second-person coach voice: 2-3 short sentences (situation and price, numbers and verdict, one tip).
  // Variants are picked by a hash of the situation, so the same situation always reads the same, and EN/ES use the
  // same variant index and the same numbers.
  // Placeholders: {win} chance to win, {need} chance needed to call, {pot} pot, {call} to call, {loss} BB lost vs best,
  // {act} your action (noun), {best} best action (noun), {cmd} best action (imperative), {past} your action (past tense),
  // {holdN} what you hold (noun phrase), {reason} why the best line works (one sentence), {rating} rating name.
  var EXPLAIN_TPL = {
    forced: {
      en: [
        'You had no chips left to act, so there was no real choice. Your hand had {win} to win the {pot} pot. Nothing to change here.',
        'All your chips were already in, so this spot was decided before you acted. Your chance was {win} in the {pot} pot.',
        'With no chips left, you could only watch the cards. Your {holdN} had {win} to win the {pot} pot.',
      ],
      es: [
        'No te quedaban fichas para actuar, así que no había elección real. Tu mano tenía un {win} de ganar el bote de {pot}. Nada que cambiar aquí.',
        'Ya tenías todas tus fichas dentro, así que esta situación se decidió antes de actuar. Tu probabilidad era un {win} en el bote de {pot}.',
        'Sin fichas, solo podías mirar las cartas. Tu {holdN} tenía un {win} de ganar el bote de {pot}.',
      ],
    },
    book: {
      en: [
        'Book move: this is the standard play here. Your {holdN} has {win} to win the {pot} pot, and {act} is what the charts recommend. Repeat it when this spot comes up.',
        'Book move: the charts say {act} here, and you found it. With {win} to win in the {pot} pot, the choice is standard. Keep it.',
        'Book move: {act} is the standard play in this spot. Your {win} chance in the {pot} pot backs it up. Keep doing it.',
      ],
      es: [
        'Jugada de libro: este es el juego estándar aquí. Tu {holdN} tiene un {win} de ganar el bote de {pot}, y {act} es lo que recomiendan las tablas. Repite esto cuando aparezca esta situación.',
        'Jugada de libro: las tablas dicen que {act} aquí, y la encontraste. Con un {win} de ganar en el bote de {pot}, la elección es la estándar. Sigue así.',
        'Jugada de libro: {act} es la jugada estándar en esta situación. Tu {win} de ganar en el bote de {pot} la respalda. Sigue haciéndolo.',
      ],
    },
    brilliant: {
      en: [
        '{rating}: {act} was hard to find, with {win} to win in the {pot} pot. {reason}',
        '{rating}: a difficult find, with {win} to win the {pot} pot. {act} beats the other lines by a wide margin. {reason}',
        '{rating}: {act} beats the other lines by a wide margin, with {win} to win. {reason} Few players find this.',
      ],
      es: [
        '{rating}: {act} era difícil de ver, con un {win} de ganar en el bote de {pot}. {reason}',
        '{rating}: un hallazgo difícil, con un {win} de ganar en el bote de {pot}. {act} supera a las demás por mucho. {reason}',
        '{rating}: {act} supera a las demás por mucho, con un {win} de ganar. {reason} Pocos jugadores lo encuentran.',
      ],
    },
    great: {
      en: [
        '{rating}: {act} was clearly better than the other lines, with {win} to win. {reason} Keep it.',
        '{rating}: {act} stood out here, with {win} to win the {pot} pot. {reason}',
        '{rating}: the other lines lose more than {act}, with {win} to win in the {pot} pot. {reason} Repeat this pattern.',
      ],
      es: [
        '{rating}: {act} fue claramente mejor que las demás, con un {win} de ganar. {reason} Sigue así.',
        '{rating}: {act} destacó aquí, con un {win} de ganar en el bote de {pot}. {reason}',
        '{rating}: las demás líneas pierden más que {act}, con un {win} de ganar en el bote de {pot}. {reason} Repite este patrón.',
      ],
    },
    best: {
      en: [
        'Best move: {act} was the top play here, and you lost nothing. Your {holdN} had {win} to win the {pot} pot. {reason}',
        'That is the top line in this spot, and it gives up nothing. Your chance was {win} in the {pot} pot. {reason}',
        'Nice work: {act} was the top play, and it gives up nothing. Your chance was {win} in the {pot} pot. {reason}',
      ],
      es: [
        'Mejor jugada: {act} era la mejor opción aquí, y no perdiste nada. Tu {holdN} tenía un {win} de ganar el bote de {pot}. {reason}',
        'Esta es la línea principal aquí, y no cede nada. Tu probabilidad era un {win} en el bote de {pot}. {reason}',
        'Buen trabajo: {act} era la jugada principal, y no cede nada. Tu probabilidad era un {win} en el bote de {pot}. {reason}',
      ],
    },
    good: {
      en: [
        'Close to the best line: {act} gives up only {loss} on average. That is a small slip, not a big one.',
        '{act} is a sound choice here, with {win} to win the {pot} pot. It gives up about {loss} against the best line.',
        'You are near the top line with {act}, giving up about {loss}. Next time, {cmd} here for the small extra edge.',
      ],
      es: [
        'Muy cerca de la mejor línea: {act} cede solo {loss} de media. Es un pequeño desliz, no uno grande.',
        '{act} es una elección sólida aquí, con un {win} de ganar en el bote de {pot}. Cede unos {loss} frente a la mejor línea.',
        'Estás cerca de la línea principal con {act}, cediendo unos {loss}. La próxima vez, {cmd} aquí para ganar un poco más.',
      ],
    },
    call_good: {
      en: [
        'The pot is {pot} and calling {call} needs {need} to break even. Your {holdN} has {win} to win, so {act} was a sound play. Keep calling when the price is this good.',
        'Calling {call} into a {pot} pot needs only {need}, and you have {win} to win. That price is good, so {act} was the sound choice. Keep it up.',
        'You needed {need} to win just to get your {call} back. Your {holdN} has {win} to win in a {pot} pot, so {act} makes sense here. Repeat it when this price comes up.',
      ],
      es: [
        'El bote es de {pot} e igualar {call} necesita un {need} para salir igual. Tu {holdN} tiene un {win} de ganar, así que {act} fue una jugada sólida. Repite esto cuando el precio sea así de bueno.',
        'Igualar {call} en un bote de {pot} pide solo un {need}, y tú tienes un {win} de ganar. Ese precio es bueno, así que {act} fue la elección acertada. Sigue así.',
        'Necesitabas un {need} para recuperar tus {call}. Tu {holdN} tiene un {win} de ganar en un bote de {pot}, así que {act} tiene sentido. Repite esto cuando aparezca este precio.',
      ],
    },
    size: {
      en: [
        '{act} was the right kind of play, but your size cost about {loss}. Next time, {cmd} for a size closer to the best one.',
        'Your {holdN} had {win} to win the {pot} pot, so {act} was the right idea. The size was off by about {loss}. Next time, {cmd} with a size nearer the best amount.',
        'Your choice was right, but the amount was too far off and cost about {loss}. Next time, {cmd} for a size nearer the best one.',
      ],
      es: [
        '{act} era la jugada correcta, pero el tamaño costó unos {loss}. La próxima vez, {cmd} con un tamaño más cercano al mejor.',
        'Tu {holdN} tenía un {win} de ganar en el bote de {pot}, así que {act} era buena idea. El tamaño se alejó unos {loss}. La próxima vez, {cmd} con una cantidad más cercana a la mejor.',
        'Tu elección fue correcta, pero la cantidad se alejó demasiado y costó unos {loss}. La próxima vez, {cmd} con un tamaño más cercano al mejor.',
      ],
    },
    fold_good: {
      en: [
        'The pot is {pot} and calling {call} needs {need} to break even. Your {holdN} has only {win} to win, so folding was the sound play. Next time, fold again when the price is this poor.',
        'Calling {call} into a {pot} pot needs {need} to win, and your chance is only {win}. That is too little, so folding was right. Good discipline.',
        'You would need {need} to break even on that {call} call, but your {holdN} has {win}. Folding saves chips, and that was the sound choice. Repeat this when the price is poor.',
      ],
      es: [
        'El bote es de {pot} e igualar {call} necesita un {need} para salir igual. Tu {holdN} tiene solo un {win} de ganar, así que retirarte fue la jugada sólida. La próxima vez, retírate ante un precio así.',
        'Igualar {call} en un bote de {pot} pide un {need} para ganar, y tu probabilidad es solo {win}. Es muy poco, así que retirarte era lo correcto. Buena disciplina.',
        'Necesitarías un {need} para salir igual en esa llamada de {call}, pero tu {holdN} tiene {win}. Retirarte ahorra fichas, y esa era la jugada sensata. Repite esto con precios así.',
      ],
    },
    call_light: {
      en: [
        'Calling {call} into a {pot} pot needs {need} to break even. Your {holdN} has only {win} to win. Next time, {cmd} here.',
        'You needed {need} to call here, yet your {holdN} has {win} to win in a {pot} pot. Calling cost chips, so {best} was the better play. Next time, {cmd} here.',
        'You had only {win} to win, and the price asked for {need}. Calling {call} lost chips, so {best} was the better play. Next time, {cmd} here.',
      ],
      es: [
        'Igualar {call} en un bote de {pot} pide un {need} para salir igual. Tu {holdN} tiene solo un {win} de ganar. La próxima vez, {cmd} aquí.',
        'Necesitabas un {need} para igualar aquí, y tu {holdN} tiene un {win} en un bote de {pot}. Igualar te costó fichas, así que {best} era mejor. La próxima vez, {cmd} aquí.',
        'Tenías solo un {win} de ganar, y el precio pedía un {need}. Igualar {call} te costó fichas, así que {best} era mejor. La próxima vez, {cmd} aquí.',
      ],
    },
    fold_tight: {
      en: [
        'Calling {call} into a {pot} pot needs only {need}, and your {holdN} has {win} to win. Folding gave away chips, so {best} was better. Next time, {cmd} here.',
        'You had {win} to win, but the price asked for only {need}. Folding throws that edge away in the {pot} pot. Next time, {cmd} here.',
        'The price asked for only {need}, but your {holdN} has about {win} to win. Folding throws that edge away in the {pot} pot. Next time, {cmd} here.',
      ],
      es: [
        'Igualar {call} en un bote de {pot} pide solo un {need}, y tu {holdN} gana alrededor del {win}. Retirarte regaló fichas, así que {best} era mejor. La próxima vez, {cmd} aquí.',
        'Tenías un {win} de ganar, pero el precio pedía solo un {need}. Retirarte tira esa ventaja en el bote de {pot}. La próxima vez, {cmd} aquí.',
        'El precio pedía solo un {need}, pero tu {holdN} tiene alrededor de un {win} de ganar. Retirarte tira esa ventaja en el bote de {pot}. La próxima vez, {cmd} aquí.',
      ],
    },
    fold_free: {
      en: [
        'Checking was free, so folding gave up your {win} chance at the {pot} pot for nothing. Next time, check instead of folding.',
        'Nobody had bet, so you could check for free. Folding with {win} to win threw the {pot} pot away. Next time, check.',
        'Folding when you can check gives the pot away, and your {holdN} had {win} to win. Next time, check.',
      ],
      es: [
        'Pasar era gratis, así que retirarte tiró tu {win} de ganar en el bote de {pot} sin motivo. La próxima vez, pasa.',
        'Nadie había apostado, así que podías pasar gratis. Retirarte con un {win} de ganar tiró el bote de {pot}. La próxima vez, pasa.',
        'Retirarte pudiendo pasar regala el bote. Tu {holdN} tenía un {win} de ganar. La próxima vez, pasa.',
      ],
    },
    bad: {
      en: [
        'This line loses about {loss} on average. Your {holdN} had {win} to win the {pot} pot, and {best} was the better play. Next time, {cmd} here.',
        '{best} is the better play here, and this line gives up {loss} over time. Your {holdN} sat at {win} in a {pot} pot. Next time, {cmd} here.',
        'You gave up about {loss} with this line. With {win} to win the {pot} pot, {best} was the stronger choice. Next time, {cmd} here.',
      ],
      es: [
        'Esta línea pierde unos {loss} de media. Tu {holdN} tenía un {win} de ganar el bote de {pot}, y {best} era la mejor jugada. La próxima vez, {cmd} aquí.',
        '{best} es la mejor jugada aquí, y esta línea cede {loss} a la larga. Tu {holdN} estaba en un {win} en un bote de {pot}. La próxima vez, {cmd} aquí.',
        'Con esta línea cediste unos {loss}. Con un {win} de ganar el bote de {pot}, {best} era la opción más fuerte. La próxima vez, {cmd} aquí.',
      ],
    },
    miss_big: {
      en: [
        'You had the best hand here (about {win} to win) and {past}. {best} would have built the pot while you were far ahead. Next time, {cmd} with a hand this strong.',
        'Your {holdN} had {win} to win the {pot} pot, so you were far ahead, yet you {past}. {best} wins more when they call. Next time, {cmd} when you are this far ahead.',
        'You were far ahead with {win} to win, yet you {past} and let them off the hook. Next time, {cmd} a hand this strong for value.',
      ],
      es: [
        'Tenías el mejor juego aquí (un {win} de ganar) y {past}. {best} habría construido el bote mientras ibas muy por delante. La próxima vez, {cmd} con una mano así de fuerte.',
        'Tu {holdN} tenía un {win} de ganar en el bote de {pot}, así que ibas muy por delante, pero {past}. {best} gana más cuando te pagan. La próxima vez, {cmd} cuando vayas así de adelante.',
        'Ibas muy por delante con un {win} de ganar, pero {past} y dejaste escapar valor. La próxima vez, {cmd} con una mano tan fuerte.',
      ],
    },
    miss_ahead: {
      en: [
        'You had a strong hand (about {win} to win) and only {past}. {best} would have built the pot while you were ahead. Next time, {cmd} when you are this far ahead.',
        'Your {holdN} had {win} to win the {pot} pot, so you were ahead. Yet you {past} and gave up value. Next time, {cmd} here.',
        'You were ahead with {win} to win in the {pot} pot, and {best} would have won more. Next time, {cmd} when you are this far ahead.',
      ],
      es: [
        'Tenías una mano fuerte (un {win} de ganar) y solo {past}. {best} habría construido el bote mientras ibas por delante. La próxima vez, {cmd} cuando vayas así de adelante.',
        'Tu {holdN} tenía un {win} de ganar en el bote de {pot}, así que ibas por delante. Aun así {past} y cediste valor. La próxima vez, {cmd} aquí.',
        'Ibas por delante con un {win} de ganar en el bote de {pot}, y {best} habría ganado más. La próxima vez, {cmd} cuando vayas así de adelante.',
      ],
    },
  };
  var OUT_OF_POS_EN = 'You act first on later streets, which makes these spots harder.';
  var OUT_OF_POS_ES = 'Actúas primero en las calles siguientes, lo que hace estas situaciones más difíciles.';

  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function fill(tpl, v) {
    return tpl.replace(/\{(\w+)\}/g, function (m, k) { return Object.prototype.hasOwnProperty.call(v, k) ? v[k] : m; });
  }
  // Which of the three verdict-tier categories a decision falls in. Returns the EXPLAIN_TPL key.
  function explainCategory(ctx) {
    if (ctx.rating === 'forced' || ctx.rating === 'book' || ctx.rating === 'brilliant' || ctx.rating === 'great' || ctx.rating === 'best') return ctx.rating;
    if (ctx.rating === 'miss') return ctx.win >= 0.9 ? 'miss_big' : 'miss_ahead';
    if (ctx.foldFree) return 'fold_free';
    if (ctx.bad && ctx.userKey === ctx.bestKey && (ctx.userKey === 'raise' || ctx.userKey === 'bet')) return 'size';
    if (ctx.bad) {
      if (ctx.C > 0 && ctx.userKey === 'call' && ctx.win < ctx.req) return 'call_light';
      if (ctx.C > 0 && ctx.userKey === 'fold' && ctx.win > ctx.req) return 'fold_tight';
      return 'bad';
    }
    // The price only backs a call or a fold when the numbers agree; otherwise the plain verdict text is used.
    if (ctx.C > 0 && ctx.userKey === 'fold' && ctx.win <= ctx.req) return 'fold_good';
    if (ctx.C > 0 && ctx.userKey === 'call' && ctx.win >= ctx.req) return 'call_good';
    return 'good';
  }
  // ctx: { rating, userKey, bestKey, reasonKey, holdKind, win (0..1), req (0..1), C, P, evLoss, foldFree, bad, pre, inPos, key }
  function buildExplain(ctx) {
    var cat = explainCategory(ctx);
    var variants = EXPLAIN_TPL[cat];
    var idx = hashStr(ctx.key + '|' + cat) % variants.en.length;
    var out = {};
    ['en', 'es'].forEach(function (L) {
      var v = {
        win: pct(ctx.win) + '%', need: pct(ctx.req) + '%', pot: fmtNum(L, r2(ctx.P)) + ' BB', call: fmtNum(L, r2(ctx.C)) + ' BB',
        loss: fmtNum(L, round1(ctx.evLoss)) + ' BB', rating: format('rating.' + ctx.rating, {}, L),
        act: format('noun.' + ctx.userKey, {}, L), past: format('past.' + ctx.userKey, {}, L),
        best: format('noun.' + ctx.bestKey, {}, L), cmd: format('cmd.' + ctx.bestKey, {}, L),
        holdN: format('holdN.' + ctx.holdKind, {}, L),
        reason: format('rsn.' + ctx.reasonKey, { best: { $t: 'noun.' + ctx.bestKey } }, L),
      };
      var s = fill(variants[L][idx], v).replace(/(^|[.!?]\s+)(\p{Ll})/gu, function (m, p, c) { return p + c.toUpperCase(); });
      if (!ctx.pre && !ctx.inPos && ctx.bad) s += ' ' + (L === 'es' ? OUT_OF_POS_ES : OUT_OF_POS_EN);
      out[L] = s;
    });
    return out;
  }

  /* ----------------------------------------------------------- rateDecision */
  // rateDecision(situation, action): situation = engine scenario (game/app format, BB units).
  // action: 'fold' | 'call' | 'check' | 'raise' | { action, amountBB }.
  function rateDecision(situation, action, opts) {
    opts = opts || {};
    var sc = situation;
    var hero = heroOf(sc);
    var act = normAction(typeof action === 'string' ? action : action.action);
    var amt = typeof action === 'object' && action ? (action.amountBB != null ? action.amountBB : action.amount) : undefined;
    if (act !== 'raise') amt = undefined;
    var o = ENG.evaluate(sc, act, amt, { lang: 'en', samples: opts.samples || SAMPLES });

    var P = sc.pot || 0;
    var heroStack = sc.heroStack || 0;
    var C = Math.min(sc.toCall || 0, heroStack);
    var scale = Math.max(1, P + C);
    var goodT = Math.max(0.3, 0.05 * scale);
    var incT = Math.max(0.8, 0.12 * scale);
    var mistT = Math.max(2, 0.25 * scale);
    var win = o.winChance;
    var userAct = o.userAction;                       // engine downgrades a raise that is not legal
    var evUser = o.evUser, evBest = o.evBest, best = o.best;
    var bestAmtOverride = null;
    // The engine grades one standard raise size; a played size that is worth more is the best line.
    if (userAct === 'raise' && o.evUser > o.evBest + 1e-9) { evBest = o.evUser; best = 'raise'; bestAmtOverride = amt != null ? amt : o.raiseSize; }
    var canRaise = o.evBestRaise != null;
    var evLoss = Math.max(0, evBest - evUser);
    var req = C > 0 ? C / (P + C) : 0;

    // Second-best line (for Great/Brilliant: how much worse the alternatives are).
    var lines = { fold: 0, call: o.ev.call };
    if (canRaise) lines.raise = o.evBestRaise;
    var alt = -Infinity;
    Object.keys(lines).forEach(function (k) { if (k !== best && lines[k] > alt) alt = lines[k]; });
    var altGap = alt === -Infinity ? 0 : Math.max(0, evBest - alt);

    var pre = sc.street === 'preflop';
    var book = null, bookHit = false, cbet = false;
    if (pre) {
      book = bookPreflop(sc, hero);
      bookHit = !!book && book.action === userAct;
    } else if (act === 'raise' && isStandardCbet(sc, hero)) {
      var size = amt != null ? amt : o.raiseSize;
      var frac = P > 0 && size ? size / P : 0;
      cbet = frac >= 0.25 && frac <= 0.8;
      bookHit = cbet;
    }
    bookHit = bookHit && evLoss <= goodT;

    var forced = (!canRaise && (C <= 0 || heroStack <= 0) && userAct === 'call') || heroStack <= 0;
    var brilliant = (best === 'fold' && win >= 0.45 && altGap >= Math.max(1, 0.1 * scale)) ||
      (best === 'raise' && win < 0.45 && altGap >= Math.max(1, 0.1 * scale)) ||
      (best === 'raise' && win >= 0.55 && win <= 0.75 && !o.raiseAllin && altGap >= Math.max(0.5, 0.05 * scale));
    // Obvious: a clear gap to the second line, or trash folded / a monster played. Obvious plays are Best or Forced, never Book.
    var obvious = altGap >= Math.min(OBV_BB, OBV_POT * scale) ||
      (C > 0 && best === 'fold' && win <= OBV_FOLD_WIN) ||
      (best !== 'fold' && win >= OBV_RAISE_WIN);
    var rating;
    if (forced) rating = 'forced';
    else if (userAct === 'fold' && C <= 0) rating = 'blunder';           // folding when checking is free
    else if (userAct === best && evLoss < 0.05) {                       // Book needs the best move (within tolerance)
      if (brilliant) rating = 'brilliant';
      else if (altGap >= Math.max(0.5, 0.05 * scale)) rating = 'great';
      else if (bookHit && !obvious) rating = 'book';
      else rating = 'best';
    } else if (evLoss <= goodT) rating = evLoss <= 0.5 * goodT ? 'excellent' : 'good';
    else if (userAct === 'call' && best === 'raise' && win >= 0.7) rating = 'miss';
    else if (evLoss <= incT) rating = 'inaccuracy';
    else if (evLoss <= mistT) rating = 'mistake';
    else rating = 'blunder';

    var accuracy = (rating === 'forced' || rating === 'book' || rating === 'brilliant' || rating === 'great' || rating === 'best')
      ? 100 : Math.round(1000 * 100 * Math.exp(-4 * Math.min(1, evLoss / scale))) / 1000;

    // ---- explanation: why[] (short facts) and the three tiers (headline, short, full). Same numbers in EN and ES.
    var parts = [];
    var fold_free = userAct === 'fold' && C <= 0;
    var allin = heroStack <= 0 || (C > 0 && C >= heroStack - 1e-9);
    if (C > 0) parts.push({ key: 'why.price', params: { call: r2(C), total: r2(P + C), need: pct(req), win: pct(win) } });
    else parts.push({ key: act === 'raise' ? 'why.free_raise' : 'why.free', params: { win: pct(win) } });
    if (fold_free) parts.push({ key: 'why.fold_free' });
    if (allin) parts.push({ key: 'why.allin' });
    var live = sc.seats.filter(function (s) { return !s.isHero && !s.folded; });
    if (live.length) {
      var summ = live.map(function (s) { return ENG.rangeSummary(sc, s, 'en'); });
      var main = summ.reduce(function (b, x) { return !b || x.streets > b.streets ? x : b; }, null);
      var lvl = main.strength >= 0.7 ? 'str.very' : main.strength >= 0.5 ? 'str.strong' : 'str.wide';
      parts.push({ key: 'why.villains', params: { n: live.length, strength: { $t: lvl }, pct: pct(main.mass) } });
    }
    var madeName = null;
    var holdKind = 'pre';                             // what the hero holds, for the coach text: pre | made | draw | air
    if (!pre) {
      var board = sc.board || [];
      var made = ENG.evaluateHand(sc.hero.concat(board));
      madeName = MADE_NAMES[made.rank];
      holdKind = madeName !== 'High card' ? 'made' : 'air';
      parts.push({ key: 'why.made', params: { made: { $t: 'made.' + madeName } } });
      if (board.length === 3 || board.length === 4) {
        var outs = ENG.outs(sc.hero, board);
        var dc = ENG.drawChance(sc.hero, board);
        if (outs > 0 && dc) { parts.push({ key: 'why.outs', params: { outs: outs, hit: Math.round(dc.pct) } }); if (holdKind === 'air') holdKind = 'draw'; }
      }
      parts.push({ key: 'why.tex', params: { tex: { $t: 'tex.' + boardTexture(board) } } });
      parts.push({ key: sc.inPosition ? 'why.in_pos' : 'why.out_pos' });
      if (cbet) parts.push({ key: 'why.cbet' });
      if (act === 'raise' && P > 0) {
        var bestSize = o.bestRaiseAmount != null ? o.bestRaiseAmount : null;
        var mySize = amt != null ? amt : o.raiseSize;
        if (mySize != null && bestSize != null) parts.push({ key: 'why.size', params: { size: pct(mySize / P), best: pct(bestSize / P) } });
      }
    } else if (book) {
      parts.push({ key: 'why.chart', params: { pos: { $t: 'pos.' + book.pos }, action: { $t: 'act.' + book.action }, n: book.n } });
    }
    var effStack = Math.min(heroStack, live.length ? Math.min.apply(null, live.map(function (s) { return s.stack; })) : heroStack);
    if (!pre && P > 0) parts.push({ key: 'why.spr', params: { spr: r2(effStack / P), stack: r2(effStack) } });

    // Best line amount (raise size) for the output.
    var bestAmt = best === 'raise' ? (bestAmtOverride != null ? bestAmtOverride : o.bestRaiseAmount) : null;

    var tags = [pre ? 'preflop' : 'postflop'];
    if (fold_free) tags.push('fold_free');
    if (allin) tags.push('all_in');
    if (cbet) tags.push('cbet');
    if (brilliant) tags.push('hard_to_find');
    if (act === 'raise' && win < 0.45) tags.push('bluff');
    if (act === 'raise' && win >= 0.55 && win <= 0.75 && !o.raiseAllin) tags.push('thin_value');
    if (rating === 'book') tags.push('book_move');

    function bi(key, p) { return { en: format(key, p, 'en'), es: format(key, p, 'es') }; }
    // Builds headline (<= 8 words), short (1-2 sentences) and full (3-6 bullets) for this decision.
    function explainTiers() {
      // Verb keys: with nobody having bet, a raise is a bet and a call is a check.
      var userKey = userAct === 'call' && C <= 0 ? 'check' : (userAct === 'raise' && C <= 0 ? 'bet' : userAct);
      var bestKey = best === 'call' && C <= 0 ? 'check' : (best === 'raise' && C <= 0 ? 'bet' : best);
      // Why the best line works (picks the reason sentence in text.explain and text.short).
      var reasonKey = bestKey === 'fold' ? 'fold' : bestKey === 'call' ? 'call'
        : bestKey === 'check' ? (win < 0.25 ? 'check_weak' : win >= 0.85 ? 'check_strong' : 'check_mid')
          : (win < 0.45 ? 'raise_weak' : 'raise_strong');
      var winP = pct(win), needP = pct(req);
      var bad = rating === 'inaccuracy' || rating === 'mistake' || rating === 'blunder';
      var hl, sh;
      if (rating === 'forced') { hl = 'hl.forced'; sh = 'sh.forced'; }
      else if (rating === 'book') { hl = 'hl.book'; sh = 'sh.book'; }
      else if (rating === 'miss') { hl = 'hl.miss'; sh = 'sh.miss'; }
      else if (rating === 'brilliant' || rating === 'great') { hl = 'hl.good'; sh = 'sh.' + rating; }
      else if (rating === 'best') { hl = 'hl.good'; sh = 'sh.best'; }
      else if (rating === 'excellent' || rating === 'good') { hl = 'hl.good'; sh = 'sh.good'; }
      else if (fold_free) { hl = 'hl.foldfree'; sh = 'sh.fold_free'; }
      else {
        hl = 'hl.bad';
        if (rating === 'mistake' || rating === 'blunder') {
          if (C > 0 && userKey === 'call' && winP < needP) sh = 'sh.call_light';
          else if (C > 0 && userKey === 'fold' && winP > needP) sh = 'sh.fold_tight';
          else sh = 'sh.bad';
        } else sh = 'sh.bad';
      }
      var P1 = {
        rating: { $t: 'rating.' + rating }, act: { $t: 'noun.' + userKey }, best: { $t: 'noun.' + bestKey },
        cmd: { $t: 'cmd.' + bestKey }, past: { $t: 'past.' + userKey }, holdN: { $t: 'holdN.' + holdKind },
        reason: { $t: 'rsn.' + reasonKey, best: { $t: 'noun.' + bestKey } },
        win: winP, need: needP, loss: round1(evLoss), call: round1(C), total: round1(P + C),
        made: { $t: 'made.' + madeName }, posn: { $t: sc.inPosition ? 'posn.in' : 'posn.out' },
        pos: book ? { $t: 'pos.' + book.pos } : '', chartAct: book ? { $t: 'act.' + book.action } : '', n: book ? book.n : '',
      };
      var headline = bi(hl, P1), short = bi(sh, P1);
      // text.explain: the coach paragraph (2-3 sentences). text.full is deprecated and empty.
      var explain = buildExplain({
        rating: rating, userKey: userKey, bestKey: bestKey, reasonKey: reasonKey, holdKind: holdKind,
        win: win, req: req, C: C, P: P, evLoss: evLoss,
        foldFree: fold_free, bad: bad, pre: pre, inPos: sc.inPosition, key: JSON.stringify([sc.street, sc.hero, sc.board, P, C, userKey]),
      });
      return {
        headline: headline,
        short: short,
        full: [],
        explain: explain,
        text: {
          en: explain.en,
          es: explain.es,
          explain: explain,
          headline: headline,
          short: short,
          full: [],
        },
      };
    }
    var tiers = explainTiers();
    var text = tiers.text;
    var headline = tiers.headline;
    return {
      street: sc.street,
      action: userAct,
      amountBB: act === 'raise' ? (amt != null ? r2(amt) : null) : null,
      rating: rating,
      ratingName: { en: format('rating.' + rating, {}, 'en'), es: format('rating.' + rating, {}, 'es') },
      icon: ICONS[rating],
      accuracy: accuracy,
      evLossBB: r2(evLoss),
      evUserBB: r2(evUser),
      evBestBB: r2(evBest),
      gainBB: r2(altGap),
      winChance: Math.round(win * 1000) / 1000,
      potOddsNeededPct: C > 0 ? pct(req) : null,
      best: { action: best === 'call' && C <= 0 ? 'check' : best, amountBB: bestAmt != null ? r2(bestAmt) : null },
      book: rating === 'book',
      bookAction: book ? book.action : null,
      tags: tags,
      why: parts,
      text: text,
      headline: headline,
      correct: !!GOOD_SET[rating],
    };
  }

  // Same street and same board (no new card) for two decision situations.
  function sameSpot(a, b) {
    if (!a || !b || a.street !== b.street) return false;
    var x = a.board || [], y = b.board || [];
    return x.length === y.length && x.join(',') === y.join(',');
  }
  // Chance to win moved with the same cards: returns { from, to, dir, text:{en,es} } in whole percent, or null.
  // Only when an opponent bet or raised between the two decisions (their likely range narrows or shifts).
  function chanceShiftOf(prevSc, sc, from, to) {
    if (from == null || to == null) return null;
    var hero = sc.heroSeat != null ? sc.heroSeat : 0;
    var before = (prevSc.history || []).length;
    var bets = (sc.history || []).slice(before).filter(function (e) {
      return e.seat !== hero && (e.action === 'raise' || e.action === 'bet');
    });
    if (!bets.length) return null;
    var a = Math.round(from * 100), b = Math.round(to * 100);
    if (a === b) return null;
    var kind = bets[bets.length - 1].action;
    var en = kind === 'bet' ? 'bet' : 'raise', es = kind === 'bet' ? 'apuesta' : 'subida';
    var down = b < a;
    var text = down
      ? { en: 'Same cards, but their ' + en + ' means they likely hold a stronger hand, so your chance to win dropped from ' + a + '% to ' + b + '%.',
        es: 'Mismas cartas, pero su ' + es + ' significa que probablemente tienen una mano más fuerte, así que tu probabilidad de ganar bajó de ' + a + '% a ' + b + '%.' }
      : { en: 'Same cards, but their ' + en + ' changes which hands they likely hold, so your chance to win rose from ' + a + '% to ' + b + '%.',
        es: 'Mismas cartas, pero su ' + es + ' cambia qué manos probablemente tienen, así que tu probabilidad de ganar subió de ' + a + '% a ' + b + '%.' };
    return { from: a, to: b, dir: down ? 'down' : 'up', text: text };
  }

  /* ------------------------------------------------------------- reviewHand */
  // Hand record (BB units), see REVIEW_API.md:
  // { decisions: [{ scenario, action, amountBB?, winChance? }], heroNetBB, potBB?, heroInvestedBB?, showdown? }
  function reviewHand(hand, opts) {
    var decisions = (hand && hand.decisions) || [];
    var rated = decisions.map(function (d, i) {
      var r = rateDecision(d.scenario, { action: d.action, amountBB: d.amountBB }, opts);
      r.index = i;
      if (d.winChance != null) r.winChanceKnown = clamp(Number(d.winChance), 0, 1);
      return r;
    });
    // Chance to win with the same cards: an earlier decision on this street with the same board (no new card).
    // If an opponent bet or raised in between, their range changed, so the chance can move. Adds prevWinChance and
    // chanceShift (numbers and both languages come from the same values). Ratings are not touched.
    rated.forEach(function (r, i) {
      var sc = decisions[i] && decisions[i].scenario;
      var j = i - 1;
      while (j >= 0 && !sameSpot(decisions[j].scenario, sc)) j--;
      if (j < 0) return;
      r.prevWinChance = rated[j].winChance;
      var shift = chanceShiftOf(decisions[j].scenario, sc, rated[j].winChance, r.winChance);
      if (shift) r.chanceShift = shift;
    });
    var counts = zeroCounts();
    rated.forEach(function (r) { counts[r.rating]++; });
    var acc = rated.filter(function (r) { return r.rating !== 'forced'; });
    var handAccuracy = acc.length ? round1(acc.reduce(function (a, r) { return a + r.accuracy; }, 0) / acc.length) : null;
    return { decisions: rated, counts: counts, accuracy: handAccuracy, luck: handLuck(hand, rated), netBB: hand && hand.heroNetBB != null ? r2(hand.heroNetBB) : null };
  }

  function handLuck(hand, rated) {
    var none = { label: 'unknown', resultVsPlay: 'unknown', expectedBB: null, actualBB: null, luckBB: null, winChance: null, playedWell: null, text: both([{ key: 'rvp.unknown' }]) };
    if (!rated.length || !hand) return none;
    var last = rated[rated.length - 1];
    var allIn = rated.some(function (r) { return r.tags.indexOf('all_in') >= 0; });
    var reached = !!hand.showdown || allIn;
    var haveMoney = hand.heroNetBB != null && hand.potBB != null && hand.heroInvestedBB != null;
    var playedWell = rated.every(function (r) { return !BAD_SET[r.rating]; });
    if (!reached || !haveMoney) return Object.assign({}, none, { playedWell: playedWell });
    var win = last.winChanceKnown != null ? last.winChanceKnown : last.winChance;
    var expected = win * hand.potBB - hand.heroInvestedBB;
    var actual = hand.heroNetBB;
    var luck = actual - expected;
    var gate = Math.abs(luck) >= Math.max(1, 0.1 * hand.potBB);
    var label = 'none';
    if (gate && win >= 0.8 && actual < 0 && playedWell) label = 'bad_luck';
    else if (gate && win <= 0.2 && actual > 0) label = 'lucky';
    var rvp = playedWell ? (actual < 0 ? 'good_bad' : 'good_good') : (actual < 0 ? 'bad_bad' : 'bad_good');
    var text;
    // Three phrasings per luck label, picked by a hash of the hand (same hand, same text; EN and ES share the variant).
    var lv = hashStr(String(pct(win))) % 3;
    var lsfx = lv === 0 ? '' : '.' + (lv + 1);
    if (label === 'bad_luck') text = both([{ key: 'luck.bad' + lsfx, params: { win: pct(win) } }]);
    else if (label === 'lucky') text = both([{ key: 'luck.lucky' + lsfx, params: { win: pct(win) } }]);
    else text = both([{ key: 'luck.none' }]);
    return {
      label: label, resultVsPlay: rvp, expectedBB: r2(expected), actualBB: r2(actual), luckBB: r2(luck),
      winChance: Math.round(win * 1000) / 1000, playedWell: playedWell, text: text,
      resultText: both([{ key: 'rvp.' + rvp }]),
    };
  }

  function zeroCounts() {
    var c = {};
    RATINGS.forEach(function (r) { c[r] = 0; });
    return c;
  }
  function round1(x) { return Math.round(x * 10) / 10; }

  /* ------------------------------------------------------------- reviewGame */
  // reviewGame(handRecords): summary over finished hands.
  function reviewGame(handRecords, opts) {
    var hands = (handRecords || []).map(function (h) { return reviewHand(h, opts); });
    var counts = zeroCounts();
    var perStreet = {};
    STREETS.forEach(function (s) { perStreet[s] = { decisions: 0, accuracy: null, evLossBB: 0, mistakes: 0, _acc: 0, _n: 0 }; });
    var all = [];
    hands.forEach(function (hr, hi) {
      hr.decisions.forEach(function (r) {
        counts[r.rating]++;
        var ps = perStreet[r.street] || (perStreet[r.street] = { decisions: 0, accuracy: null, evLossBB: 0, mistakes: 0, _acc: 0, _n: 0 });
        ps.decisions++; ps.evLossBB += r.evLossBB;
        if (r.rating === 'mistake' || r.rating === 'blunder' || r.rating === 'miss') ps.mistakes++;
        if (r.rating !== 'forced') { ps._acc += r.accuracy; ps._n++; }
        all.push({ hand: hi, r: r });
      });
    });
    Object.keys(perStreet).forEach(function (k) {
      var p = perStreet[k];
      p.accuracy = p._n ? round1(p._acc / p._n) : null;
      p.evLossBB = r2(p.evLossBB);
      delete p._acc; delete p._n;
    });
    var scored = all.filter(function (x) { return x.r.rating !== 'forced'; });
    var accuracy = scored.length ? round1(scored.reduce(function (a, x) { return a + x.r.accuracy; }, 0) / scored.length) : null;

    var worst = null, bestMove = null;
    all.forEach(function (x) {
      if ((x.r.rating === 'blunder' || x.r.rating === 'mistake' || x.r.rating === 'miss') && (!worst || x.r.evLossBB > worst.r.evLossBB)) worst = x;
      if ((x.r.rating === 'brilliant' || x.r.rating === 'great') && (!bestMove || x.r.gainBB > bestMove.r.gainBB)) bestMove = x;
    });
    var keyMoments = {
      biggestBlunder: worst ? { hand: worst.hand, index: worst.r.index, street: worst.r.street, rating: worst.r.rating, evLossBB: worst.r.evLossBB, text: worst.r.text } : null,
      bestMove: bestMove ? { hand: bestMove.hand, index: bestMove.r.index, street: bestMove.r.street, rating: bestMove.r.rating, gainBB: bestMove.r.gainBB, text: bestMove.r.text } : null,
    };

    // Net and luck over the hands that have results.
    var actual = 0, expected = 0, withLuck = 0, potSum = 0, badLuck = 0, lucky = 0, netHands = 0;
    hands.forEach(function (hr, i) {
      var src = handRecords[i];
      if (hr.netBB != null) { actual += hr.netBB; netHands++; }
      if (src && src.potBB != null) potSum += src.potBB;
      if (hr.luck.luckBB != null) {
        withLuck++;
        expected += hr.luck.expectedBB;
        if (hr.luck.label === 'bad_luck') badLuck++;
        if (hr.luck.label === 'lucky') lucky++;
      }
    });
    var luckBB = withLuck ? r2(actual - expected) : null;
    // Luck factor is material when it reaches 10% of the chips contested (min 5 BB).
    var threshold = Math.max(5, 0.1 * potSum);
    var luckLabel = 'unknown';
    if (luckBB != null) luckLabel = luckBB >= threshold ? 'lucky' : luckBB <= -threshold ? 'unlucky' : 'none';
    var luckText = luckLabel === 'lucky' ? both([{ key: 'sum.luck_lucky', params: { luck: Math.abs(luckBB) } }])
      : luckLabel === 'unlucky' ? both([{ key: 'sum.luck_unlucky', params: { luck: Math.abs(luckBB) } }])
        : both([{ key: 'sum.luck_none' }]);

    var suggestions = suggest(counts, perStreet, all);
    return {
      handCount: hands.length,
      decisionCount: all.length,
      accuracy: accuracy,
      counts: counts,
      perStreet: perStreet,
      keyMoments: keyMoments,
      net: { actualBB: netHands ? r2(actual) : null, expectedBB: withLuck ? r2(expected) : null, luckBB: luckBB, luckLabel: luckLabel, luckThresholdBB: r2(threshold), badLuckHands: badLuck, luckyHands: lucky, handsWithLuck: withLuck },
      luckText: luckText,
      suggestions: suggestions,
      hands: hands,
    };
  }

  function suggest(counts, perStreet, all) {
    var out = [];
    var preMist = all.filter(function (x) { return x.r.street === 'preflop' && (x.r.rating === 'mistake' || x.r.rating === 'blunder'); }).length;
    if (preMist >= 2) out.push({ key: 'sugg.preflop', params: { n: preMist } });
    if (counts.miss >= 2) out.push({ key: 'sugg.value', params: { n: counts.miss } });
    var lightCalls = all.filter(function (x) { return x.r.action === 'call' && x.r.potOddsNeededPct != null && (x.r.rating === 'blunder' || x.r.rating === 'mistake') && x.r.winChance * 100 < x.r.potOddsNeededPct; }).length;
    if (lightCalls >= 1) out.push({ key: 'sugg.calls', params: { n: lightCalls } });
    if (counts.blunder && all.some(function (x) { return x.r.tags.indexOf('fold_free') >= 0; })) {
      out.push({ key: 'sugg.free_check', params: { n: all.filter(function (x) { return x.r.tags.indexOf('fold_free') >= 0; }).length } });
    }
    var worstStreet = STREETS.reduce(function (b, s) { return !b || perStreet[s].evLossBB > perStreet[b].evLossBB ? s : b; }, null);
    if (worstStreet && perStreet[worstStreet].evLossBB > 0 && out.length < 4) out.push({ key: 'sugg.street', params: { street: { $t: 'street.' + worstStreet } } });
    if (!out.length) out.push({ key: 'sugg.good' });
    return out.slice(0, 4).map(function (s) { return { key: s.key, params: s.params, text: both([s]) }; });
  }

  /* ------------------------------------------------------ adapters (app data) */
  // From a finished engine session (game.js): the hand that just ended. Units converted to BB.
  function handRecordFromGame(session) {
    var hand = session && session.hand;
    if (!hand || !hand.results) return null;
    var bb = hand.bb;
    var res = hand.results;
    var pot = (res.pots || []).reduce(function (a, p) { return a + p.amount; }, 0);
    return {
      decisions: (res.heroDecisions || []).map(function (d) {
        return { scenario: d.scenario, action: d.action, amountBB: d.raiseAmount == null ? undefined : d.raiseAmount };
      }),
      heroNetBB: res.heroNet / bb,
      potBB: pot / bb,
      heroInvestedBB: hand.seats[0].contributed / bb,
      showdown: !!res.showdown,
    };
  }
  // From the app's exam records (app.js examRecord): records of one hand share `hand`; nets optional
  // (netsByHand: { [handNumber]: netBB }, from the progress hands list).
  function handRecordsFromExam(records, netsByHand) {
    var byHand = {};
    (records || []).forEach(function (r) {
      (byHand[r.hand] = byHand[r.hand] || []).push(r);
    });
    return Object.keys(byHand).map(Number).sort(function (a, b) { return a - b; }).map(function (n) {
      return {
        decisions: byHand[n].map(function (r) { return { scenario: r.scn, action: r.action, amountBB: r.amount }; }),
        heroNetBB: netsByHand && netsByHand[n] != null ? netsByHand[n] : undefined,
      };
    });
  }

  var api = {
    RATINGS: RATINGS,
    ICONS: ICONS,
    rateDecision: rateDecision,
    reviewHand: reviewHand,
    reviewGame: reviewGame,
    handRecordFromGame: handRecordFromGame,
    handRecordsFromExam: handRecordsFromExam,
    format: format,
    DICT: DICT,
    EXPLAIN_TPL: EXPLAIN_TPL,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PokerReview = api;
})();
