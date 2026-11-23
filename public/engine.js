/* Poker Trainer engine: hand evaluation, equity, villain ranges, EV model and
 * random scenario generator. Zero dependencies. Browser: window.PokerEngine.
 * Node: module.exports. */
const PokerEngine = (function () {
  'use strict';

  // ---------------------------------------------------------------- constants
  const RANKS = '23456789TJQKA';
  const SUITS = 'shdc';
  const NC = 1326; // two-card combinations
  const STYLES = ['tight', 'loose', 'aggressive', 'passive', 'balanced'];
  const CAT_NAMES = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight',
    'Flush', 'Full house', 'Four of a kind', 'Straight flush'];
  const STYLE_MULT = { tight: 0.8, loose: 1.3, aggressive: 1.1, passive: 0.9, balanced: 1 };
  const FOLD_MULT = { tight: 1.2, balanced: 1, aggressive: 0.9, loose: 0.8, passive: 0.75 };
  const OPEN_BASE = { UTG: 0.13, 'UTG+1': 0.15, MP: 0.17, LJ: 0.2, HJ: 0.23, CO: 0.29, BTN: 0.44, SB: 0.4, BB: 0.2 };
  const TABLE_POS = {
    2: ['BTN', 'BB'],
    3: ['BTN', 'SB', 'BB'],
    4: ['CO', 'BTN', 'SB', 'BB'],
    5: ['HJ', 'CO', 'BTN', 'SB', 'BB'],
    6: ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
    7: ['UTG', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
    8: ['UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
    9: ['UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  };
  const EARLY = ['UTG', 'UTG+1', 'MP'];
  const LATE = ['CO', 'BTN'];
  const POS_NAME = {
    BTN: 'the button', SB: 'the small blind', BB: 'the big blind', CO: 'the cutoff',
    HJ: 'the hijack', LJ: 'the lojack', MP: 'middle position', UTG: 'UTG', 'UTG+1': 'UTG+1',
  };
  const TIER_NAMES = ['', 'Premium', 'Strong', 'Playable', 'Speculative', 'Weak'];

  // Frequencies (probabilities) used by the scenario simulator and by fold equity.
  const BLUFF = { aggressive: 0.45, loose: 0.35, balanced: 0.3, passive: 0.15, tight: 0.12 };
  const BET_FREQ = { aggressive: 0.55, loose: 0.4, balanced: 0.4, passive: 0.2, tight: 0.25 };
  const BET_SIZES = { aggressive: [0.5, 0.75, 1], loose: [0.33, 0.66, 1, 1.5], balanced: [0.5, 0.66], passive: [0.33, 0.5], tight: [0.5, 0.66] };
  const RAISE_FREQ = { aggressive: 0.15, loose: 0.08, balanced: 0.08, passive: 0.04, tight: 0.04 };
  const CALL_FREQ = { aggressive: 0.45, loose: 0.6, balanced: 0.5, passive: 0.6, tight: 0.45 };
  const P3_FREQ = { tight: 0.04, balanced: 0.07, passive: 0.02, loose: 0.1, aggressive: 0.13 };
  const PCALL_FREQ = { tight: 0.15, balanced: 0.22, passive: 0.3, loose: 0.3, aggressive: 0.15 };
  const P4_FREQ = { tight: 0.02, balanced: 0.04, passive: 0.02, loose: 0.03, aggressive: 0.07 };
  const PLIMP_FREQ = { tight: 0.02, balanced: 0.08, passive: 0.25, loose: 0.2, aggressive: 0.02 };

  // ------------------------------------------------------------------ utils
  // ------------------------------------------------------------ i18n
  // All user-facing text. Every key must exist in both languages (tests check this).
  const I18N = {
    en: {
      rng_very: 'very strong', rng_strong: 'strong', rng_wide: 'wide', rng_value: '{label} (~{p} of hands)',
      m_range: 'This player has stayed in for {k} streets, so {verdict}.', v_strong: 'they probably hold a strong hand', v_wide: 'their range is still wide',
      s_table: 'Players / pot / to call', s_texture: 'Board texture', s_chart: 'Preflop chart',
      tbl_value: '{players} players · pot {pot} BB · to call {call} BB', h_potodds2: 'Call {call} BB into {total} BB · SPR {spr}',
      m_short: 'You are short ({s} BB): shove or fold, no raise sizes.', m_deep: 'You are deep ({s} BB): you can win more on later streets.',
      m_cover: 'They cover you: a call puts your whole stack in, so you need extra chance to win.',
      pos_BTN: 'the button', pos_SB: 'the small blind', pos_BB: 'the big blind', pos_CO: 'the cutoff',
      pos_HJ: 'the hijack', pos_LJ: 'the lojack', pos_MP: 'middle position', pos_UTG: 'UTG', 'pos_UTG+1': 'UTG+1',
      you_are: 'you are {pos}', name_hero: 'Hero', name_seat: 'Seat {n}', pending: 'pending',
      act_fold: 'folds', act_check: 'checks', act_limp: 'limps', act_call: 'calls {amt} BB',
      act_bet: 'bets {amt} BB', act_raise: 'raises to {amt} BB', allin_tag: ' (all-in)',
      act_name_fold: 'Fold', act_name_call: 'Call', act_name_check: 'Check', act_name_raise: 'Raise',
      sit_limped: 'Limped pot ({n} {word}), {you}', sit_option: 'Unopened pot, you have the option in the big blind',
      sit_unopened: 'Unopened pot, {you}', sit_facing_open: 'Facing an open from {opener}, {you}',
      sit_facing_3bet: 'Facing a 3-bet, {you}', sit_facing_3bet_own: 'Facing a 3-bet after your open, {you}',
      sit_facing_4bet: 'Facing a 4-bet, {you}', sit_first: 'You act first on the {street}',
      sit_checked: 'Checked to you on the {street}', sit_facing_bet: 'Facing a {size} bet on the {street}',
      sit_raise_own: 'Facing a raise after your bet on the {street}', sit_multiway: ', multiway pot',
      sit_headsup_pot: ', heads-up pot', hand_count: '{n}-handed', hand_hu: 'heads-up',
      sz_third: '1/3-pot', sz_half: 'half-pot', sz_twothirds: '2/3-pot', sz_pot: 'pot-sized', sz_over: 'overbet',
      street_flop: 'flop', street_turn: 'turn', street_river: 'river',
      opt_open: 'Open to {amt} BB', opt_iso: 'Iso to {amt} BB', opt_bigopen: 'Big open to {amt} BB',
      opt_bigiso: 'Big iso to {amt} BB', opt_3bet: '3-bet to {amt} BB', opt_big3bet: 'Big 3-bet to {amt} BB',
      opt_4bet: '4-bet to {amt} BB', opt_bet: 'Bet {frac} ({amt} BB)', opt_raise: 'Raise to {frac} ({amt} BB)',
      opt_std: 'Raise to {amt} BB', opt_allin: 'All-in ({amt} BB)', frac_third: '1/3 pot', frac_half: '1/2 pot', frac_twothirds: '2/3 pot', frac_pot: 'pot',
      chart_open: 'Open raise', chart_vs_limp: 'Versus limpers', chart_vs_raise: 'Versus a raise', chart_vs_3bet: 'Versus a 3-bet',
      chart_title: '{n}-handed {pos}: {facing}',
      adv_open_raise: 'inside {pos} open range', adv_open_fold: 'outside {pos} open range',
      adv_limp_raise: 'strong enough to isolate the limpers', adv_limp_check: 'a free check in the big blind',
      adv_limp_call: 'a limp-range hand', adv_limp_fold: 'too weak to limp',
      adv_vsr_raise: 'a 3-bet value/bluff hand', adv_vsr_call: 'inside the call-vs-open range', adv_vsr_fold: 'outside the call-vs-open range',
      adv_3b_raise: 'a 4-bet hand', adv_3b_call: 'inside the call-vs-3-bet range', adv_3b_fold: 'outside the call-vs-3-bet range',
      made_sf: 'a straight flush', made_quads: 'four of a kind', made_fh: 'a full house', made_flush: 'a flush',
      made_straight: 'a straight', made_set: 'a set of {r}', made_trips: 'three of a kind', made_two: 'two pair',
      made_over: 'an overpair ({r}{r})', made_under: 'an underpair ({r}{r})', made_top: 'a top pair ({r})',
      made_second: 'a second pair ({r})', made_bottom: 'a weak bottom pair ({r})',
      made_boardpair: 'only the board pair (no pair from your hand)', made_high: 'only {r} high',
      dr_flush: 'a flush draw ({n} outs)', dr_oesd: 'an open-ended straight draw ({n} outs)',
      dr_gut: 'a gutshot straight draw ({n} outs)', dr_over1: '1 overcard ({o} outs)', dr_over2: '{n} overcards ({o} outs)',
      tex_wet: 'wet', tex_dry: 'dry', tex_monotone: 'monotone', tex_two: 'two-tone', tex_rainbow: 'rainbow',
      tex_four: 'four-flush', tex_three: 'three-flush', tex_noflush: 'no flush draw', tex_paired: 'paired',
      tex_connected: 'connected', tex_vconnected: 'very connected', tex_high: 'high', tex_low: 'low', tex_mid: 'middle',
      tex_label: '{parts} board ({hi}-high)',
      s_hand: 'Hand / made hand', s_equity: 'Chance to win vs range', s_potodds: 'Pot odds (needed chance)',
      s_outs: 'Outs', s_percentile: 'Hand percentile / chart tier', s_position: 'Position',
      s_spr: 'Stack-to-pot ratio', s_villain: 'Villain range estimate', s_ev: 'EV of fold / call / raise',
      h_mc: 'Monte Carlo, {n} samples vs {v} villain(s)', h_potodds: 'Pot {pot} BB, call {call} BB, {players} in hand',
      h_pos_in: 'acting last post-flop', h_pos_out: 'acting before some villains post-flop',
      h_outs: '{draws}; about {hit} to hit by the river', h_nodraw: 'No draws', h_spr: 'Effective stack {eff} BB',
      h_raise: 'Raise size {amt} BB', h_noraise: 'No legal raise', na: 'n/a', na_river: 'n/a (river)',
      val_in: 'In position', val_out: 'Out of position', val_range: '~{p} of hands', pct_top: 'Top {p} (Tier {t}, {name})',
      tier_1: 'Premium', tier_2: 'Strong', tier_3: 'Playable', tier_4: 'Speculative', tier_5: 'Weak',
      chart_hint: 'Chart: {action} ({text})',
      v_role_open: 'opened', v_role_3bet: '3-bet', v_role_4bet: '4-bet', v_role_call_open: 'flatted an open',
      v_role_call_3bet: 'called a 3-bet', v_role_call_4bet: 'called a 4-bet', v_role_limp: 'limped',
      v_role_bb_check: 'checked his option', v_role_default: 'played an unknown line', v_role_pending: 'has not acted yet',
      style_tight: 'tight', style_loose: 'loose', style_aggressive: 'aggressive', style_passive: 'passive', style_balanced: 'balanced',
      v_line: '{pos} ({style}) {role}', v_none: 'no live villains', v_more: '+{n} more',
      b1_raise: 'Raise: {e} chance to win, plus {fe} chance they fold, makes it the best line.',
      b1_call: 'Call: {e} chance to win beats the {req} you need.', b1_check: 'Check: {e} chance to win realises the pot for free.',
      b1_fold: 'Fold: {e} chance to win is below the {req} needed.',
      b2_pre: '{cls} is in the top {p} of hands ({tier}).', b2_post: 'You have {made}, {pos_txt}.',
      pos_phrase_in: 'in position', pos_phrase_out: 'out of position',
      b3_best: 'Your line is the highest-EV option.', b3_good: 'Your line is within 0.3 BB of the best: an acceptable mixed-spot choice.',
      b3_bad: 'Your line ({act}) gives up {diff} BB versus {best}.',
      m_villains: 'Live opponents: {n}; their range covers about {p} of hands.',
      m_ev: 'EV (expected value) of calling {call} BB, best raise {raise} BB.',
      m_spr: 'SPR {spr} (stack-to-pot ratio): {depth}.', spr_low: 'committed, favours getting it in', spr_mid: 'medium depth', spr_high: 'deep, implied odds matter',
      m_draws: 'Draws: {d}.', m_nodraw: 'No draws to improve.', m_texture: 'Board: {label}.', m_chart: 'Chart: {action} ({text}).',
      m_drawpct: 'Chance to complete it by the river: {p}%.', pre_limp: 'From this seat with {n} players, limping is better than raising.',
      pre_raise: 'From this seat with {n} players, raising is better than limping.', pre_fold: 'From this seat with {n} players, folding is better.',
      hl_pair: 'a pair of {r}', hl_kicker: ' with a good kicker', hl_both: '{made} and {draw}', hl_suited: '{hi}{lo} suited',
      hl_offsuit: '{hi}{lo} offsuit', hl_small: 'a small unpaired hand', hl_weak2: 'a weak two pair (the {r} are on the board)',
      dg_both: 'The board can make a flush or a straight.', dg_flush: 'The board can make a flush.', dg_straight: 'The board can make a straight.',
      pn_late: 'You act late, after most players, so you see more of their moves.', pn_mid: 'Middle position: some players still act after you.',
      pn_early: 'You act early, blind to what the others will do.', pn_blind: 'In the blinds you are out of position and act first after the flop.',
      tip_fold: 'Fold weak hands when the price is too high.', tip_call: 'Call when your chance to win beats the pot odds.',
      tip_check: 'Check for free when a bet costs nothing.', tip_raise: 'Raise when you are ahead or they fold often enough.',
      best_named: 'The best move was to {verb}.', best_close: ' Yours was almost as good.',
      alt_call_lose: 'Calling loses money long term: you need {req} chance to win and have {e}.',
      alt_raise_none: 'Raising does not pay: you add chips for a {e} chance to win.',
      alt_fold_cost: 'Folding gives up a pot you win {e} of the time.',
      alt_call_value: 'Calling leaves value: raising wins about {d} BB more on average.',
      sum_best: '{action} is best: {reason}', r_raise_ahead: "you are ahead of villain's range",
      r_raise_fe: 'chance they fold makes the bet profitable', r_call_price: 'the price is right for your chance to win',
      r_check_free: 'checking realises your chance to win for free', r_fold_odds: 'your chance to win is below the pot odds',
    },
    es: {
      rng_very: 'muy fuerte', rng_strong: 'fuerte', rng_wide: 'amplio', rng_value: '{label} (~{p} de las manos)',
      m_range: 'Este jugador ha seguido {k} calles, así que {verdict}.', v_strong: 'probablemente tiene una mano fuerte', v_wide: 'su rango sigue siendo amplio',
      s_table: 'Jugadores / bote / por igualar', s_texture: 'Textura del board', s_chart: 'Carta preflop',
      tbl_value: '{players} jugadores · bote {pot} BB · por igualar {call} BB', h_potodds2: 'Igualar {call} BB para ganar {total} BB · SPR {spr}',
      m_short: 'Tienes pocas fichas ({s} BB): o subes todo o te retiras.', m_deep: 'Tienes muchas fichas ({s} BB): puedes ganar más en las calles siguientes.',
      m_cover: 'Te cubren: igualar pone todo tu stack en juego, así que necesitas más probabilidad.',
      pos_BTN: 'el botón', pos_SB: 'la ciega pequeña', pos_BB: 'la ciega grande', pos_CO: 'el cutoff',
      pos_HJ: 'el hijack', pos_LJ: 'el lojack', pos_MP: 'posición media', pos_UTG: 'UTG', 'pos_UTG+1': 'UTG+1',
      you_are: 'estás en {pos}', name_hero: 'Héroe', name_seat: 'Asiento {n}', pending: 'pendiente',
      act_fold: 'se retira', act_check: 'pasa', act_limp: 'limpea', act_call: 'iguala {amt} BB',
      act_bet: 'apuesta {amt} BB', act_raise: 'sube a {amt} BB', allin_tag: ' (all-in)',
      act_name_fold: 'Retirarse', act_name_call: 'Igualar', act_name_check: 'Pasar', act_name_raise: 'Subir',
      sit_limped: 'Bote limpeado ({n} {word}), {you}', sit_option: 'Bote sin abrir, tienes la opción en la ciega grande',
      sit_unopened: 'Bote sin abrir, {you}', sit_facing_open: 'Te abren desde {opener}, {you}',
      sit_facing_3bet: 'Enfrentas una resubida, {you}', sit_facing_3bet_own: 'Enfrentas una resubida a tu apertura, {you}',
      sit_facing_4bet: 'Enfrentas una re-resubida, {you}', sit_first: 'Actúas primero en el {street}',
      sit_checked: 'Pasan hasta ti en el {street}', sit_facing_bet: 'Enfrentas una apuesta de {size} en el {street}',
      sit_raise_own: 'Enfrentas una subida tras tu apuesta en el {street}', sit_multiway: ', bote multijugador',
      sit_headsup_pot: ', bote cara a cara', hand_count: '{n} jugadores', hand_hu: 'cara a cara',
      sz_third: '1/3 de bote', sz_half: 'medio bote', sz_twothirds: '2/3 de bote', sz_pot: 'bote', sz_over: 'sobreapuesta',
      street_flop: 'flop', street_turn: 'turn', street_river: 'river',
      opt_open: 'Abrir a {amt} BB', opt_iso: 'Iso a {amt} BB', opt_bigopen: 'Apertura grande a {amt} BB',
      opt_bigiso: 'Iso grande a {amt} BB', opt_3bet: 'Resubir a {amt} BB', opt_big3bet: 'Resubida grande a {amt} BB',
      opt_4bet: 'Re-resubir a {amt} BB', opt_bet: 'Apostar {frac} ({amt} BB)', opt_raise: 'Subir a {frac} ({amt} BB)',
      opt_std: 'Subir a {amt} BB', opt_allin: 'All-in ({amt} BB)', frac_third: '1/3 de bote', frac_half: '1/2 de bote', frac_twothirds: '2/3 de bote', frac_pot: 'bote',
      chart_open: 'Apertura', chart_vs_limp: 'Contra limpeos', chart_vs_raise: 'Contra una subida', chart_vs_3bet: 'Contra una resubida',
      chart_title: '{n} jugadores, {pos}: {facing}',
      adv_open_raise: 'dentro del rango de apertura desde {pos}', adv_open_fold: 'fuera del rango de apertura desde {pos}',
      adv_limp_raise: 'suficientemente fuerte para isolar a los limpeos', adv_limp_check: 'un check gratis en la ciega grande',
      adv_limp_call: 'una mano de rango de limpeo', adv_limp_fold: 'demasiado débil para limpear',
      adv_vsr_raise: 'una mano de resubida (valor o farol)', adv_vsr_call: 'dentro del rango de call contra apertura',
      adv_vsr_fold: 'fuera del rango de call contra apertura', adv_3b_raise: 'una mano de re-resubida',
      adv_3b_call: 'dentro del rango de call contra resubida', adv_3b_fold: 'fuera del rango de call contra resubida',
      made_sf: 'una escalera de color', made_quads: 'póker', made_fh: 'un full', made_flush: 'un color',
      made_straight: 'una escalera', made_set: 'un set de {r}', made_trips: 'un trío', made_two: 'doble pareja',
      made_over: 'una pareja superior ({r}{r})', made_under: 'una pareja inferior ({r}{r})', made_top: 'un par superior ({r})',
      made_second: 'un segundo par ({r})', made_bottom: 'un par débil ({r})',
      made_boardpair: 'solo el par del board (sin par propio)', made_high: 'solo carta alta ({r})',
      dr_flush: 'un proyecto de color ({n} outs)', dr_oesd: 'un proyecto de escalera abierta ({n} outs)',
      dr_gut: 'un proyecto de escalera interior ({n} outs)', dr_over1: '1 carta alta ({o} outs)', dr_over2: '{n} cartas altas ({o} outs)',
      tex_wet: 'húmedo', tex_dry: 'seco', tex_monotone: 'monocolor', tex_two: 'dos colores', tex_rainbow: 'arcoíris',
      tex_four: 'cuatro del mismo palo', tex_three: 'tres del mismo palo', tex_noflush: 'sin proyecto de color', tex_paired: 'con pareja',
      tex_connected: 'conectado', tex_vconnected: 'muy conectado', tex_high: 'alto', tex_low: 'bajo', tex_mid: 'medio',
      tex_label: 'Board {parts} (carta alta {hi})',
      s_hand: 'Mano / jugada', s_equity: 'Probabilidad de ganar vs rango', s_potodds: 'Cuotas del bote (probabilidad necesaria)',
      s_outs: 'Outs', s_percentile: 'Percentil de la mano / tier', s_position: 'Posición',
      s_spr: 'Ratio stack/bote (SPR)', s_villain: 'Rango estimado del villano', s_ev: 'EV retirarse / igualar / subir',
      h_mc: 'Monte Carlo, {n} simulaciones contra {v} villano(s)', h_potodds: 'Bote {pot} BB, igualar {call} BB, {players} en la mano',
      h_pos_in: 'actúas último post-flop', h_pos_out: 'actúas antes que algún villano post-flop',
      h_outs: '{draws}; ~{hit} de acertar en el river', h_nodraw: 'Sin proyectos', h_spr: 'Stack efectivo {eff} BB',
      h_raise: 'Tamaño de subida {amt} BB', h_noraise: 'No hay subida legal', na: 'n/d', na_river: 'n/d (river)',
      val_in: 'En posición', val_out: 'Fuera de posición', val_range: '~{p} de las manos', pct_top: 'Top {p} (tier {t}, {name})',
      tier_1: 'Premium', tier_2: 'Fuerte', tier_3: 'Jugable', tier_4: 'Especulativa', tier_5: 'Débil',
      chart_hint: 'Carta: {action} ({text})',
      v_role_open: 'abrió', v_role_3bet: 'resubió', v_role_4bet: 're-resubió', v_role_call_open: 'igualó una apertura',
      v_role_call_3bet: 'igualó una resubida', v_role_call_4bet: 'igualó una re-resubida', v_role_limp: 'limpeó',
      v_role_bb_check: 'pasó su opción', v_role_default: 'jugó una línea desconocida', v_role_pending: 'aún no ha actuado',
      style_tight: 'cerrado', style_loose: 'suelto', style_aggressive: 'agresivo', style_passive: 'pasivo', style_balanced: 'equilibrado',
      v_line: '{pos} ({style}) {role}', v_none: 'sin villanos activos', v_more: '+{n} más',
      b1_raise: 'Subir: {e} de probabilidad de ganar y {fe} de que se retiren la convierten en la mejor línea.',
      b1_call: 'Igualar: {e} de probabilidad de ganar supera el {req} necesario.', b1_check: 'Pasar: {e} de probabilidad de ganar realiza el bote gratis.',
      b1_fold: 'Retirarse: {e} de probabilidad de ganar está por debajo del {req} necesario.',
      b2_pre: '{cls} está en el top {p} de manos ({tier}).', b2_post: 'Tienes {made}, {pos_txt}.',
      pos_phrase_in: 'en posición', pos_phrase_out: 'fuera de posición',
      b3_best: 'Tu línea es la de mayor EV.', b3_good: 'Tu línea está a menos de 0.3 BB de la mejor: decisión mixta aceptable.',
      b3_bad: 'Tu jugada ({act}) pierde {diff} BB frente a {best}.',
      m_villains: 'Rivales activos: {n}; su rango cubre ~{p} de las manos.',
      m_ev: 'EV (valor esperado) de igualar {call} BB, mejor subida {raise} BB.',
      m_spr: 'SPR {spr} (proporción stack/bote): {depth}.', spr_low: 'comprometido, favorece meter el stack', spr_mid: 'profundidad media', spr_high: 'profundo, importan las cuotas implícitas',
      m_draws: 'Proyectos: {d}.', m_nodraw: 'Sin proyectos que mejoren.', m_texture: 'Board: {label}.', m_chart: 'Carta: {action} ({text}).',
      m_drawpct: 'Probabilidad de completarlo en el río: {p}%.', pre_limp: 'Desde esta posición con {n} jugadores es mejor limpear.',
      pre_raise: 'Desde esta posición con {n} jugadores es mejor subir que limpear.', pre_fold: 'Desde esta posición con {n} jugadores es mejor retirarse.',
      hl_pair: 'un par de {r}', hl_kicker: ' con buen kicker', hl_both: '{made} y {draw}', hl_suited: '{hi}{lo} del mismo palo',
      hl_offsuit: '{hi}{lo} de palos distintos', hl_small: 'una mano pequeña y desparejada', hl_weak2: 'una doble pareja débil (la pareja de {r} está en la mesa)',
      dg_both: 'El board puede completar color o escalera.', dg_flush: 'El board puede completar color.', dg_straight: 'El board puede completar escalera.',
      pn_late: 'Actúas tarde, después de casi todos, así que ves más de lo que hacen.', pn_mid: 'Posición media: todavía actúan jugadores después de ti.',
      pn_early: 'Actúas pronto, a ciegas sobre lo que harán los demás.', pn_blind: 'En las ciegas estás fuera de posición: actúas primero después del flop.',
      tip_fold: 'Retírate con manos débiles cuando el precio sea demasiado alto.', tip_call: 'Iguala cuando tu probabilidad de ganar supere las cuotas del bote.',
      tip_check: 'Pasa gratis cuando no te cuesta nada seguir.', tip_raise: 'Sube cuando vas por delante o cuando se retiran a menudo.',
      best_named: 'La mejor jugada era {verb}.', best_close: ' La tuya era casi igual de buena.',
      alt_call_lose: 'Igualar pierde dinero a largo plazo: necesitas {req} de probabilidad y tienes {e}.',
      alt_raise_none: 'Subir no compensa: pones más fichas con {e} de probabilidad de ganar.',
      alt_fold_cost: 'Retirarte cede un bote que ganas el {e} de las veces.',
      alt_call_value: 'Igualar deja valor: subir gana unos {d} BB más de media.',
      sum_best: '{action} es la mejor: {reason}', r_raise_ahead: 'vas por delante del rango del villano',
      r_raise_fe: 'que se retiren hace rentable la apuesta', r_call_price: 'el precio es correcto para tu probabilidad de ganar',
      r_check_free: 'pasar realiza tu probabilidad de ganar gratis', r_fold_odds: 'tu probabilidad de ganar está por debajo de las cuotas del bote',
    },
  };
  function langOf(l) { return l === 'es' ? 'es' : 'en'; }
  function tr(lang, key, vars) {
    const d = I18N[langOf(lang)];
    let s = d[key];
    if (s === undefined) throw new Error('Missing i18n key: ' + key);
    if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
    return s;
  }

  function r2(x) { return Math.round(x * 100) / 100; }
  function r05(x) { return Math.max(0.5, Math.round(x * 2) / 2); }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function fmt(x) { return String(Math.round(x * 100) / 100); }
  function pctStr(x) { return Math.round(x * 100) + '%'; }
  function hashSeed(v) {
    if (typeof v === 'number') return v >>> 0;
    let h = 2166136261;
    const s = String(v);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function makeRng(seed) {
    if (seed == null) return Math.random;
    let a = hashSeed(seed) | 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function pick(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }
  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // ------------------------------------------------------------------ cards
  function parseCard(c) {
    if (typeof c === 'number') return c;
    const r = RANKS.indexOf(String(c[0]).toUpperCase());
    const s = SUITS.indexOf(String(c[1]).toLowerCase());
    if (String(c).length !== 2 || r < 0 || s < 0) throw new Error('Invalid card: ' + c);
    return r * 4 + s;
  }
  function cardStr(c) { return RANKS[c >> 2] + SUITS[c & 3]; }
  function parseCards(list) { return (list || []).map(parseCard); }

  // ------------------------------------------------------------- evaluator
  const _rc = new Int32Array(13), _sc = new Int32Array(4), _sm = new Int32Array(4);

  function straightHigh(m) {
    for (let h = 12; h >= 4; h--) if (((m >> (h - 4)) & 31) === 31) return h;
    if ((m & 0x100f) === 0x100f) return 3; // wheel (5-high)
    return -1;
  }
  function packScore(cat, list) {
    let v = cat;
    for (let i = 0; i < 5; i++) v = v * 16 + (i < list.length ? list[i] : 0);
    return v;
  }
  // cards: array of card ints, n = count (5..7). Returns comparable score.
  // Side effect: leaves rank/suit counts in _rc/_sc/_sm for the last call.
  function scoreCards(cards, n) {
    _rc.fill(0); _sc.fill(0); _sm.fill(0);
    let all = 0;
    for (let i = 0; i < n; i++) {
      const c = cards[i], r = c >> 2, s = c & 3, b = 1 << r;
      _rc[r]++; _sc[s]++; _sm[s] |= b; all |= b;
    }
    let fs = -1;
    for (let s = 0; s < 4; s++) if (_sc[s] >= 5) { fs = s; break; }
    if (fs >= 0) {
      const sh = straightHigh(_sm[fs]);
      if (sh >= 0) return packScore(8, [sh]);
    }
    // Ranks present (descending) and grouped by multiplicity.
    const present = [];
    const byCount = [[], [], [], [], []];
    for (let r = 12; r >= 0; r--) if (_rc[r] > 0) { present.push(r); byCount[_rc[r]].push(r); }
    const trips = byCount[3], pairs = byCount[2];
    // Each category keeps only the ranks that decide a best 5-card hand.
    if (byCount[4].length) {
      const q = byCount[4][0];
      return packScore(7, [q, present.find((r) => r !== q)]);
    }
    if (trips.length && (trips.length > 1 || pairs.length)) {
      return packScore(6, [trips[0], trips.length > 1 ? trips[1] : pairs[0]]);
    }
    if (fs >= 0) {
      const list = [];
      for (let r = 12; r >= 0 && list.length < 5; r--) if ((_sm[fs] >> r) & 1) list.push(r);
      return packScore(5, list);
    }
    const sh = straightHigh(all);
    if (sh >= 0) return packScore(4, [sh]);
    if (trips.length) {
      const t = trips[0];
      return packScore(3, [t].concat(present.filter((r) => r !== t).slice(0, 2)));
    }
    if (pairs.length > 1) {
      const p1 = pairs[0], p2 = pairs[1];
      return packScore(2, [p1, p2, present.find((r) => r !== p1 && r !== p2)]);
    }
    if (pairs.length) {
      const p = pairs[0];
      return packScore(1, [p].concat(present.filter((r) => r !== p).slice(0, 3)));
    }
    return packScore(0, present.slice(0, 5));
  }

  function evaluateHand(cards) {
    const ints = parseCards(cards);
    if (ints.length < 5 || ints.length > 7) throw new Error('evaluateHand needs 5-7 cards');
    const score = scoreCards(ints, ints.length);
    const cat = score >>> 20;
    return { rank: cat, name: CAT_NAMES[cat], score: score };
  }

  // -------------------------------------------------- combos, classes, chen
  const COMBO_A = new Uint8Array(NC), COMBO_B = new Uint8Array(NC);
  const PAIR_IDX = new Int16Array(52 * 52).fill(-1);
  (function () {
    let k = 0;
    for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) {
      COMBO_A[k] = a; COMBO_B[k] = b;
      PAIR_IDX[a * 52 + b] = k; PAIR_IDX[b * 52 + a] = k;
      k++;
    }
  })();
  function comboIndex(a, b) { return PAIR_IDX[a * 52 + b]; }

  function chenScore(hi, lo, suited) {
    const hp = (r) => (r === 12 ? 10 : r === 11 ? 8 : r === 10 ? 7 : r === 9 ? 6 : (r + 2) / 2);
    if (hi === lo) return Math.ceil(Math.max(hp(hi) * 2, 5));
    let s = hp(hi);
    if (suited) s += 2;
    const gap = hi - lo - 1;
    s -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
    if (gap <= 1 && hi < 10) s += 1;
    return Math.ceil(s);
  }
  function classKey(hi, lo, type) {
    return type === 'p' ? RANKS[hi] + RANKS[hi] : RANKS[hi] + RANKS[lo] + type;
  }
  const COMBO_PCT = new Float64Array(NC);
  const CLASS_PCT = {};
  (function () {
    const classes = [];
    for (let hi = 0; hi < 13; hi++) for (let lo = 0; lo <= hi; lo++) {
      if (hi === lo) classes.push({ hi, lo, type: 'p', count: 6, chen: chenScore(hi, lo, false) });
      else {
        classes.push({ hi, lo, type: 's', count: 4, chen: chenScore(hi, lo, true) });
        classes.push({ hi, lo, type: 'o', count: 12, chen: chenScore(hi, lo, false) });
      }
    }
    // Dominance: a hand with the same or a higher high card, the same or a higher kicker and the same or
    // a better suit type (suited over offsuit) is never ranked weaker. Chen alone breaks this (42s over 52s,
    // Q8o under J8o), so each score is raised to the best score of any hand it dominates.
    const dominates = (x, y) => {
      if (x === y) return false;
      if (x.type === 'p' && y.type === 'p') return x.hi > y.hi;
      if (x.type === 'p') return x.hi >= y.hi;   // a pair over any hand with the same or a lower high card
      if (y.type === 'p') return false;          // a non-pair never dominates a pair
      return x.hi >= y.hi && x.lo >= y.lo && (x.type === y.type || (x.type === 's' && y.type === 'o'));
    };
    let changed = true;
    while (changed) {
      changed = false;
      for (const x of classes) for (const y of classes) {
        if (dominates(x, y) && y.chen > x.chen) { x.chen = y.chen; changed = true; }
      }
    }
    classes.sort((x, y) => (y.chen - x.chen) || (y.hi - x.hi) || (y.lo - x.lo) || (x.type === 's' ? -1 : x.type === 'o' && y.type === 's' ? 1 : 0));
    let cum = 0;
    for (const c of classes) {
      c.pct = (cum + c.count / 2) / NC;
      cum += c.count;
      CLASS_PCT[classKey(c.hi, c.lo, c.type)] = c.pct;
    }
    for (let k = 0; k < NC; k++) {
      const a = COMBO_A[k], b = COMBO_B[k];
      const ra = a >> 2, rb = b >> 2;
      const hi = Math.max(ra, rb), lo = Math.min(ra, rb);
      const type = hi === lo ? 'p' : ((a & 3) === (b & 3) ? 's' : 'o');
      COMBO_PCT[k] = CLASS_PCT[classKey(hi, lo, type)];
    }
  })();
  function comboClass(a, b) {
    const ra = a >> 2, rb = b >> 2;
    const hi = Math.max(ra, rb), lo = Math.min(ra, rb);
    const type = hi === lo ? 'p' : ((a & 3) === (b & 3) ? 's' : 'o');
    return { hi, lo, type, key: classKey(hi, lo, type) };
  }
  function tierOf(pct) {
    if (pct <= 0.05) return 1;
    if (pct <= 0.12) return 2;
    if (pct <= 0.25) return 3;
    if (pct <= 0.45) return 4;
    return 5;
  }

  // ------------------------------------------------------------- ranges
  function classCombos(hi, lo, mode) {
    const out = [];
    if (hi === lo) {
      for (let s1 = 0; s1 < 4; s1++) for (let s2 = s1 + 1; s2 < 4; s2++) out.push(comboIndex(hi * 4 + s1, hi * 4 + s2));
      return out;
    }
    for (let s1 = 0; s1 < 4; s1++) for (let s2 = 0; s2 < 4; s2++) {
      const suited = s1 === s2;
      if (mode === 's' && !suited) continue;
      if (mode === 'o' && suited) continue;
      out.push(comboIndex(hi * 4 + s1, lo * 4 + s2));
    }
    return out;
  }
  // Token grammar: AA, AA+, 22-99, AKs, AKo, AK, ATs+, A2s-A9s, optional ":weight".
  function expandToken(body) {
    const m = /^([2-9TJQKA])([2-9TJQKA])([SO])?(\+)?(?:-([2-9TJQKA])([2-9TJQKA])([SO])?)?$/.exec(body.toUpperCase());
    if (!m) throw new Error('Bad range token: ' + body);
    const r1 = RANKS.indexOf(m[1]), r2_ = RANKS.indexOf(m[2]);
    const mode = m[3] ? m[3].toLowerCase() : 'a';
    const hi0 = Math.max(r1, r2_), lo0 = Math.min(r1, r2_);
    const pair = r1 === r2_;
    const list = [];
    if (m[5]) {
      const s1 = RANKS.indexOf(m[5]), s2 = RANKS.indexOf(m[6]);
      if (pair) {
        for (let v = Math.min(r1, s1, s2); v <= Math.max(r1, s1, s2); v++) list.push([v, v]);
      } else {
        const hi2 = Math.max(s1, s2), lo2 = Math.min(s1, s2);
        for (let lo = Math.min(lo0, lo2); lo <= Math.max(lo0, lo2); lo++) if (lo < hi0 && hi2 === hi0) list.push([hi0, lo]);
      }
    } else if (m[4]) {
      if (pair) for (let v = r1; v <= 12; v++) list.push([v, v]);
      else for (let lo = lo0; lo < hi0; lo++) list.push([hi0, lo]);
    } else {
      list.push([hi0, lo0]);
    }
    return { list, mode };
  }
  function parseRangeSpec(spec) {
    const w = new Float64Array(NC);
    if (spec == null) { w.fill(1); return w; }
    if (spec instanceof Float64Array || spec instanceof Float32Array) {
      if (spec.length !== NC) throw new Error('Range weight array must have 1326 entries');
      w.set(spec); return w;
    }
    const tokens = Array.isArray(spec) ? spec : String(spec).split(/[\s,]+/);
    let any = false;
    for (const raw of tokens) {
      const tok = String(raw).trim();
      if (!tok) continue;
      const parts = tok.split(':');
      const weight = parts.length > 1 ? parseFloat(parts[1]) : 1;
      if (!isFinite(weight) || weight < 0) throw new Error('Bad range weight: ' + tok);
      const { list, mode } = expandToken(parts[0]);
      for (const [hi, lo] of list) for (const idx of classCombos(hi, lo, mode)) w[idx] = Math.max(w[idx], weight);
      any = true;
    }
    if (!any) throw new Error('Empty range');
    return w;
  }

  // Preflop role cut-offs (fraction of hands by Chen percentile).
  function roleCut(role, pos, style, n) {
    const m = STYLE_MULT[style] || 1;
    const blind = pos === 'SB' || pos === 'BB';
    switch (role) {
      case 'open': {
        let base = OPEN_BASE[pos] || 0.2;
        if (n === 2 && pos === 'BTN') base = 0.6;
        else if (n === 3 && pos === 'BTN') base = 0.5;
        return { cut: Math.min(0.9, base * m), ring: 0, ringW: 0, outW: 0 };
      }
      case 'limp': return { cut: Math.min(0.9, 0.5 * m), ring: 0.15, ringW: 0.3, outW: 0.05 };
      case 'call_open': {
        const base = pos === 'BB' ? 0.3 : pos === 'SB' ? 0.07 : LATE.includes(pos) ? 0.11 : (pos === 'HJ' || pos === 'LJ') ? 0.09 : 0.06;
        return { cut: Math.min(0.9, base * m), ring: 0.03, ringW: 0.3, outW: 0 };
      }
      case '3bet': {
        const base = (blind || LATE.includes(pos)) ? 0.05 : 0.03;
        return { cut: Math.min(0.9, base * m), ring: 0.04, ringW: 0.25, outW: 0 };
      }
      case 'call_3bet': {
        const base = (pos === 'BB' || pos === 'SB') ? 0.05 : LATE.includes(pos) ? 0.055 : 0.04;
        return { cut: Math.min(0.9, base * m), ring: 0, ringW: 0, outW: 0 };
      }
      case '4bet': return { cut: Math.min(0.9, 0.02 * m), ring: 0.01, ringW: 0.3, outW: 0 };
      case 'call_4bet': return { cut: Math.min(0.9, 0.03 * m), ring: 0, ringW: 0, outW: 0 };
      case 'bb_check': return { cut: 0.6, ring: 0, ringW: 0, outW: 0.35 };
      default: return { cut: 0.5, ring: 0, ringW: 0, outW: 0.25 };
    }
  }
  const _roleCache = new Map();
  function roleWeights(role, pos, style, n) {
    const key = [role, pos, style, n].join('|');
    if (_roleCache.has(key)) return _roleCache.get(key);
    const c = roleCut(role, pos, style, n);
    const w = new Float64Array(NC);
    for (let k = 0; k < NC; k++) {
      const p = COMBO_PCT[k];
      w[k] = p <= c.cut ? 1 : (p <= c.cut + c.ring ? c.ringW : c.outW);
    }
    if (_roleCache.size > 500) _roleCache.clear();
    _roleCache.set(key, w);
    return w;
  }

  // Postflop kinds per combo for a board: 0 air, 1 draw, 2 weak pair, 3 top pair, 4 value.
  function popcount(x) { let c = 0; while (x) { x &= x - 1; c++; } return c; }
  function boardKinds(board) {
    const kinds = new Uint8Array(NC);
    let bmax = -1, bmask = 0;
    for (const c of board) { bmax = Math.max(bmax, c >> 2); bmask |= 1 << (c >> 2); }
    const cards = new Array(board.length + 2);
    for (let k = 0; k < NC; k++) {
      const a = COMBO_A[k], b = COMBO_B[k];
      if (board.indexOf(a) >= 0 || board.indexOf(b) >= 0) { kinds[k] = 0; continue; }
      cards[0] = a; cards[1] = b;
      for (let j = 0; j < board.length; j++) cards[2 + j] = board[j];
      const score = scoreCards(cards, cards.length);
      const cat = score >>> 20;
      if (cat >= 2) kinds[k] = 4;
      else if (cat === 1) {
        let pr = -1;
        for (let r = 12; r >= 0; r--) if (_rc[r] >= 2) { pr = r; break; }
        kinds[k] = pr >= bmax ? 3 : 2;
      } else {
        const s1 = a & 3, s2 = b & 3;
        const fd = _sc[s1] === 4 || (s2 !== s1 && _sc[s2] === 4);
        const m = (1 << (a >> 2)) | (1 << (b >> 2)) | bmask;
        let sd = false;
        for (let h = 4; h <= 12 && !sd; h++) if (popcount((m >> (h - 4)) & 31) >= 4) sd = true;
        if (!sd && popcount(m & 0x100f) >= 4) sd = true;
        kinds[k] = (fd || sd) ? 1 : 0;
      }
    }
    return kinds;
  }
  const ACT_KIND_W = {
    bet: (style) => [BLUFF[style] || 0.3, 0.55, 0.35, 0.85, 1],
    raise: () => [0.15, 0.45, 0.15, 0.5, 1],
    check: () => [1, 0.8, 1, 0.7, 0.35],
    call: () => [0.6, 1, 0.9, 1, 0.8],
  };

  // ------------------------------------------------------------- equity
  function equityDetail(heroInts, boardInts, villainWeights, opts) {
    const o = opts || {};
    const samples = o.samples || 3000;
    const rng = o.rng || Math.random;
    const k = villainWeights.length;
    if (k === 0) return { equity: 1, win: 1, tie: 0, samples: 0 };
    const dead = new Uint8Array(52);
    for (const c of heroInts) dead[c] = 1;
    for (const c of boardInts) dead[c] = 1;
    const deck = [];
    for (let c = 0; c < 52; c++) if (!dead[c]) deck.push(c);
    const nb = 5 - boardInts.length;
    const cums = villainWeights.map((w) => {
      const cum = new Float64Array(NC);
      let t = 0;
      for (let i = 0; i < NC; i++) { t += w[i]; cum[i] = t; }
      return cum;
    });
    const work = new Uint8Array(52);
    const vIdx = new Int32Array(k);
    let win = 0, tie = 0, valid = 0;
    const rec = !!o.record, recHs = [], recVs = [];
    for (let s = 0; s < samples; s++) {
      work.set(dead);
      let ok = true;
      for (let v = 0; v < k; v++) {
        const cum = cums[v], tot = cum[NC - 1], wv = villainWeights[v];
        let found = -1;
        if (tot > 0) {
          for (let t = 0; t < 40 && found < 0; t++) {
            const u = rng() * tot;
            let lo = 0, hi = NC - 1;
            while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] > u) hi = mid; else lo = mid + 1; }
            if (wv[lo] > 0 && !work[COMBO_A[lo]] && !work[COMBO_B[lo]]) found = lo;
          }
        }
        if (found < 0) {
          const start = Math.floor(rng() * NC);
          for (let j = 0; j < NC; j++) {
            const idx = (start + j) % NC;
            if (wv[idx] > 0 && !work[COMBO_A[idx]] && !work[COMBO_B[idx]]) { found = idx; break; }
          }
        }
        if (found < 0) { ok = false; break; }
        vIdx[v] = found;
        work[COMBO_A[found]] = 1; work[COMBO_B[found]] = 1;
      }
      if (!ok) continue;
      const avail = deck.filter((c) => !work[c]);
      const brd = boardInts.slice();
      for (let j = 0; j < nb; j++) {
        const q = Math.floor(rng() * avail.length);
        brd.push(avail[q]);
        avail[q] = avail[avail.length - 1];
        avail.pop();
      }
      const hc = heroInts.concat(brd);
      const hs = scoreCards(hc, hc.length);
      if (rec) recHs.push(hs);
      let vmax = -1, vcount = 0;
      for (let v = 0; v < k; v++) {
        const idx = vIdx[v];
        const vc = [COMBO_A[idx], COMBO_B[idx]].concat(brd);
        const vs = scoreCards(vc, vc.length);
        if (rec) recVs.push(vs);
        if (vs > vmax) { vmax = vs; vcount = 1; } else if (vs === vmax) vcount++;
      }
      if (hs > vmax) win++;
      else if (hs === vmax) tie += 1 / (vcount + 1);
      valid++;
    }
    if (!valid) return { equity: 0.5, win: 0.5, tie: 0, samples: 0 };
    return { equity: (win + tie) / valid, win: win / valid, tie: tie / valid, samples: valid,
      rec: rec ? { n: recHs.length, k: k, hs: Float64Array.from(recHs), vs: Float64Array.from(recVs) } : null };
  }
  // equity(hero, board, rangeOrNumOpponents, opts) -> number in 0..1
  function equity(hero, board, villains, opts) {
    const heroInts = parseCards(hero), boardInts = parseCards(board || []);
    let weights;
    if (typeof villains === 'number') {
      weights = [];
      for (let i = 0; i < villains; i++) weights.push(parseRangeSpec(null));
    } else {
      weights = (villains || []).map((v) => parseRangeSpec(v));
    }
    return equityDetail(heroInts, boardInts, weights, opts).equity;
  }

  // ----------------------------------------------------- draws, outs, texture
  function straightOutsInfo(mask) {
    const completing = [];
    for (let r = 0; r < 13; r++) {
      if ((mask >> r) & 1) continue;
      if (straightHigh(mask | (1 << r)) >= 0) completing.push(r);
    }
    return completing;
  }
  function drawInfo(heroInts, boardInts, street, lang) {
    const L = lang || 'en';
    const base = heroInts.concat(boardInts);
    const known = new Uint8Array(52);
    for (const c of base) known[c] = 1;
    const cur = scoreCards(base, base.length) >>> 20;
    const info = { cur, outs: 0, outCards: [], draws: [], flushDraw: false, straightDraw: false, overcards: 0, hit: 0 };
    if (boardInts.length < 3 || boardInts.length > 4) return info;
    // An out is a card that improves the hand AND needs a hole card: a pair or better made with a hole card,
    // or a flush/straight completed with one. A card that only improves the board (or a backdoor) is not an out.
    const boardCat = (c) => scoreCards(boardInts.concat([c]), boardInts.length + 1) >>> 20;
    for (let c = 0; c < 52; c++) {
      if (known[c]) continue;
      const arr = base.concat([c]);
      const cat = scoreCards(arr, arr.length) >>> 20;
      if (cat > cur && cat > boardCat(c)) { info.outs++; info.outCards.push(c); }
    }
    if (cur < 5) {
      for (let s = 0; s < 4; s++) {
        const seen = base.filter((c) => (c & 3) === s).length;
        if (seen === 4 && heroInts.some((c) => (c & 3) === s)) {
          info.flushDraw = true;
          info.draws.push(tr(L, 'dr_flush', { n: 13 - seen }));
          break;
        }
      }
    }
    if (cur < 4) {
      let mask = 0;
      for (const c of base) mask |= 1 << (c >> 2);
      let so = 0;
      for (const r of straightOutsInfo(mask)) so += 4 - base.filter((c) => (c >> 2) === r).length;
      if (so > 0) {
        info.straightDraw = true;
        info.draws.push(tr(L, so >= 8 ? 'dr_oesd' : 'dr_gut', { n: so }));
      }
    }
    if (cur === 0) {
      const bmax = Math.max.apply(null, boardInts.map((c) => c >> 2));
      const over = heroInts.filter((c) => (c >> 2) > bmax).length;
      if (over > 0) {
        info.overcards = over;
        info.draws.push(tr(L, over === 1 ? 'dr_over1' : 'dr_over2', { n: over, o: over * 3 }));
      }
    }
    const n = 52 - base.length;
    if (street === 'flop' || boardInts.length === 3) {
      const o = info.outs;
      info.hit = o ? 1 - ((n - o) * (n - o - 1)) / (n * (n - 1)) : 0;
    } else if (boardInts.length === 4) {
      info.hit = info.outs / n;
    }
    return info;
  }

  function boardTexture(board, lang) {
    const L = lang || 'en';
    const ranks = board.map((c) => c >> 2).sort((a, b) => b - a);
    const suitCount = [0, 0, 0, 0];
    for (const c of board) suitCount[c & 3]++;
    const maxSuit = Math.max.apply(null, suitCount);
    const paired = new Set(ranks).size < ranks.length;
    let mask = 0;
    for (const r of ranks) mask |= 1 << r;
    let windowMax = 0;
    for (let h = 4; h <= 12; h++) windowMax = Math.max(windowMax, popcount((mask >> (h - 4)) & 31));
    windowMax = Math.max(windowMax, popcount(mask & 0x100f));
    const high = ranks[0] >= 9;
    const low = ranks[0] <= 6;
    const flushPossible = maxSuit >= 3;
    const straightPossible = windowMax >= 3;
    const wet = flushPossible || straightPossible;
    const suitKey = board.length === 3
      ? (maxSuit === 3 ? 'tex_monotone' : maxSuit === 2 ? 'tex_two' : 'tex_rainbow')
      : (maxSuit >= 4 ? 'tex_four' : maxSuit === 3 ? 'tex_three' : 'tex_noflush');
    const parts = [tr(L, wet ? 'tex_wet' : 'tex_dry'), tr(L, suitKey)];
    if (paired) parts.push(tr(L, 'tex_paired'));
    if (windowMax >= 3) parts.push(tr(L, windowMax >= 4 ? 'tex_vconnected' : 'tex_connected'));
    parts.push(tr(L, high ? 'tex_high' : low ? 'tex_low' : 'tex_mid'));
    return {
      label: tr(L, 'tex_label', { parts: parts.join(', '), hi: RANKS[ranks[0]] }),
      wet: wet, paired: paired, monotone: maxSuit === 3 && board.length === 3,
      flushPossible: flushPossible, straightPossible: straightPossible,
      connected: windowMax >= 3, high: high, low: low,
    };
  }

  function madeHandDesc(heroInts, boardInts, lang) {
    const L = lang || 'en';
    const all = heroInts.concat(boardInts);
    const score = scoreCards(all, all.length);
    const cat = score >>> 20;
    const rc = Array.from(_rc);
    const bRanks = boardInts.map((c) => c >> 2);
    const bmax = Math.max.apply(null, bRanks);
    const uniq = Array.from(new Set(bRanks)).sort((a, b) => b - a);
    const hr = heroInts.map((c) => c >> 2);
    const pocket = hr[0] === hr[1];
    const heroHigh = Math.max(hr[0], hr[1]);
    const R = (r) => RANKS[r];
    switch (cat) {
      case 8: return tr(L, 'made_sf');
      case 7: return tr(L, 'made_quads');
      case 6: return tr(L, 'made_fh');
      case 5: return tr(L, 'made_flush');
      case 4: return tr(L, 'made_straight');
      case 3:
        if (pocket && rc[hr[0]] === 3) return tr(L, 'made_set', { r: L === 'es' ? RANK_ES[hr[0]] : RANK_EN[hr[0]] });
        return tr(L, 'made_trips');
      case 2: return tr(L, 'made_two');
      case 1: {
        let pr = -1;
        for (let r = 12; r >= 0; r--) if (rc[r] === 2) { pr = r; break; }
        if (hr.indexOf(pr) < 0) return tr(L, 'made_boardpair');
        if (pocket) return tr(L, pr > bmax ? 'made_over' : 'made_under', { r: R(pr) });
        const idx = uniq.indexOf(pr);
        if (idx === 0) return tr(L, 'made_top', { r: R(pr) });
        if (idx === 1) return tr(L, 'made_second', { r: R(pr) });
        return tr(L, 'made_bottom', { r: R(pr) });
      }
      default:
        return tr(L, 'made_high', { r: L === 'es' ? R(heroHigh) : RANK_EN1[heroHigh] });
    }
  }

  // ------------------------------------------------------- preflop charts
  // Chart facings: 'open', 'vs_limp', 'vs_raise', 'vs_3bet'.
  // Built from the same roleCut() data that the villain range model uses.
  const CHART_FACING = { unopened: 'open', limped: 'vs_limp', vs_open: 'vs_raise', vs_3bet: 'vs_3bet', open: 'open', vs_raise: 'vs_raise' };
  // Stack depth changes the chart: short stacks shove wider and call less; deep stacks call a bit wider.
  function stackFactor(stackBB, role) {
    const s = stackBB == null ? 100 : stackBB;
    if (s <= 15) return { open: 1.6, '3bet': 1.5, call_open: 0.5, call_3bet: 0.5, '4bet': 1.3, call_4bet: 0.5 }[role] || 1;
    if (s <= 25) return { open: 1.2, '3bet': 1.1, call_open: 0.8, call_3bet: 0.8 }[role] || 1;
    if (s >= 100) return { call_open: 1.15, call_3bet: 1.1, open: 0.95 }[role] || 1;
    return 1;
  }
  // Cell grade: great = mostly raise, good = mostly call/check or mixed, bad = mostly fold.
  function cellGrade(f) { return f.raise >= 0.5 ? 'great' : f.fold >= 0.5 ? 'bad' : 'good'; }
  function chartFreq(facing, pos, n, pct, stackBB) {
    const cut = (role) => roleCut(role, pos, 'balanced', n).cut * stackFactor(stackBB, role);
    const f = { fold: 0, call: 0, raise: 0 };
    if (facing === 'open') {
      if (pct <= cut('open')) f.raise = 1; else f.fold = 1;
    } else if (facing === 'vs_limp') {
      if (pct <= cut('open')) f.raise = 1;
      else if (pos === 'BB') f.call = 1;
      else if (pct <= 0.5) f.call = 1;
      else f.fold = 1;
    } else if (facing === 'vs_raise') {
      if (pct <= cut('3bet')) f.raise = 1;
      else if (pct <= cut('call_open')) f.call = 1;
      else f.fold = 1;
    } else if (facing === 'vs_3bet') {
      if (pct <= cut('4bet')) f.raise = 1;
      else if (pct <= cut('call_3bet')) f.call = 1;
      else f.fold = 1;
    } else {
      throw new Error('Unknown facing: ' + facing);
    }
    return f;
  }
  function chartAdvice(pct, pos, n, state, lang, stackBB) {
    const L = lang || 'en';
    const facing = CHART_FACING[state] || 'open';
    const f = chartFreq(facing, pos, n, pct, stackBB);
    const action = f.raise ? 'raise' : f.call ? 'call' : 'fold';
    const keys = {
      open: { raise: 'adv_open_raise', fold: 'adv_open_fold' },
      vs_limp: { raise: 'adv_limp_raise', call: pos === 'BB' ? 'adv_limp_check' : 'adv_limp_call', fold: 'adv_limp_fold' },
      vs_raise: { raise: 'adv_vsr_raise', call: 'adv_vsr_call', fold: 'adv_vsr_fold' },
      vs_3bet: { raise: 'adv_3b_raise', call: 'adv_3b_call', fold: 'adv_3b_fold' },
    }[facing];
    return { action: action, text: tr(L, keys[action], { pos: posName(pos, L) }) };
  }
  // Valid {position, facing} spots for a table size.
  function listChartSpots(numPlayers) {
    const n = clamp(Math.round(numPlayers), 2, 9);
    const table = TABLE_POS[n];
    const first = table[0];
    const spots = [];
    for (const pos of table) {
      if (pos !== 'BB') spots.push({ position: pos, facing: 'open' });
      const canFaceAction = pos !== first && !(n === 2 && pos === 'BTN');
      if (canFaceAction) spots.push({ position: pos, facing: 'vs_limp' });
      if (canFaceAction) spots.push({ position: pos, facing: 'vs_raise' });
      if (pos !== first) spots.push({ position: pos, facing: 'vs_3bet' });
    }
    return spots;
  }
  // 13x13 grid: rows/cols A..2. Diagonal pairs, above diagonal suited, below offsuit.
  // opts: a language string or { lang }.
  function getRangeChart(numPlayers, position, facing, opts) {
    const lang = langOf(typeof opts === 'string' ? opts : (opts && opts.lang));
    const stackBB = opts && typeof opts === 'object' && opts.stackBB != null ? opts.stackBB : 100;
    const n = clamp(Math.round(numPlayers), 2, 9);
    const ok = listChartSpots(n).some((s) => s.position === position && s.facing === facing);
    if (!ok) throw new Error('No chart for ' + n + '-handed ' + position + ' ' + facing);
    const grid = [];
    for (let i = 0; i < 13; i++) {
      const row = [];
      for (let j = 0; j < 13; j++) {
        const ri = 12 - i, rj = 12 - j;
        let hi, lo, type;
        if (i === j) { hi = ri; lo = ri; type = 'p'; }
        else if (i < j) { hi = ri; lo = rj; type = 's'; }
        else { hi = rj; lo = ri; type = 'o'; }
        const key = classKey(hi, lo, type);
        const f = chartFreq(facing, position, n, CLASS_PCT[key], stackBB);
        row.push({ hand: key, fold: f.fold, call: f.call, raise: f.raise, grade: cellGrade(f) });
      }
      grid.push(row);
    }
    const facingKey = { open: 'chart_open', vs_limp: 'chart_vs_limp', vs_raise: 'chart_vs_raise', vs_3bet: 'chart_vs_3bet' }[facing];
    return { title: tr(lang, 'chart_title', { n: n, pos: position, facing: tr(lang, facingKey) }), grid: grid };
  }

  // Postflop action kind of a seat for the current street (null if none).
  function actionKindOf(seat) {
    const k = seat.lastActionKind;
    return (k === 'bet' || k === 'raise' || k === 'check' || k === 'call') ? k : null;
  }
  function inferRole(seat, street) {
    if (seat.preflopRole) return seat.preflopRole;
    if (street !== 'preflop') return 'default';
    if ((seat.kind || seat.lastActionKind) === 'pending') return 'pending';
    const map = { raise: 'open', bet: 'open', call: 'call_open', limp: 'limp', check: 'bb_check' };
    return map[seat.lastActionKind] || 'default';
  }
  // ------------------------------------------- range narrowing by hand history
  // Hand-class strength value per board kind (0 air .. 4 value).
  const SVAL = [0.1, 0.3, 0.4, 0.75, 0.95];
  const BLUFF_RAISE = { aggressive: 0.35, balanced: 0.2, loose: 0.2, passive: 0.05, tight: 0.08 };
  const BLUFF_BET = { aggressive: 0.4, balanced: 0.3, loose: 0.3, passive: 0.12, tight: 0.12 };
  // P(action | board kind, style, bet size). Kinds: 0 air, 1 draw, 2 weak pair, 3 top pair, 4 value.
  // Values are <= 1 so each street can only narrow the range.
  function likelihoodFor(action, kind, style, betFrac) {
    const bf = Math.min(betFrac || 0, 1.5) / 1.5;
    const weakish = kind <= 2;
    let L;
    if (action === 'call') {
      L = [0.25, 0.6, 0.6, 0.85, 0.9][kind];
      if (style === 'loose' && kind <= 1) L *= 1.2;
      if (style === 'tight' && weakish) L *= 0.7;
      if (weakish) L *= 1 - 0.25 * bf;
    } else if (action === 'raise') {
      L = [BLUFF_RAISE[style] || 0.2, 0.45, 0.15, 0.5, 0.95][kind];
    } else if (action === 'bet') {
      L = [BLUFF_BET[style] || 0.3, 0.5, 0.35, 0.7, 0.9][kind];
      if (kind === 0) L *= 1 - 0.3 * bf;
      else if (kind === 4) L *= 0.85 + 0.15 * bf;
    } else if (action === 'check') {
      L = [0.5, 0.9, 1.0, 0.7, 0.45][kind];
    } else {
      return 1;
    }
    return clamp(L, 0.02, 1);
  }
  // Prior weights multiplied by every post-flop action of this seat, street by street.
  function narrowedWeights(S, seat, boardInts, kindsCache, prior) {
    const w = Float64Array.from(prior);
    for (const h of S.history) {
      if (h.seat !== seat.seat || h.street === 'preflop' || h.action === 'fold') continue;
      const len = h.street === 'flop' ? 3 : h.street === 'turn' ? 4 : 5;
      if (boardInts.length < len) continue;
      const key = 'k' + len;
      const kinds = kindsCache[key] || (kindsCache[key] = boardKinds(boardInts.slice(0, len)));
      for (let k = 0; k < NC; k++) w[k] *= likelihoodFor(h.action, kinds[k], seat.style || 'balanced', h.betFraction);
    }
    for (let k = 0; k < NC; k++) if (w[k] < 0.005 * prior[k]) w[k] = 0.005 * prior[k];
    return w;
  }
  function rangeLabel(strength, L) {
    return tr(L, strength >= 0.7 ? 'rng_very' : strength >= 0.5 ? 'rng_strong' : 'rng_wide');
  }
  function villainInfo(S, seat, boardInts, kindsCache) {
    const role = inferRole(seat, S.street);
    const style = seat.style || 'balanced';
    const prior = roleWeights(role, seat.position, style, S.numPlayers);
    let w = prior;
    let streets = 0;
    if (Array.isArray(S.history)) {
      const hist = S.history.filter((h) => h.seat === seat.seat && h.street !== 'preflop' && h.action !== 'fold');
      if (hist.length) {
        w = narrowedWeights(S, seat, boardInts, kindsCache, prior);
        streets = new Set(hist.map((h) => h.street)).size;
      }
    } else {
      const act = S.street === 'preflop' ? null : actionKindOf(seat);
      if (act && boardInts.length >= 3) {
        const kinds = kindsCache.kinds || (kindsCache.kinds = boardKinds(boardInts));
        const mult = ACT_KIND_W[act](style);
        const w2 = new Float64Array(NC);
        let sum = 0;
        for (let k = 0; k < NC; k++) { w2[k] = prior[k] * mult[kinds[k]]; sum += w2[k]; }
        if (sum > 0) w = w2;
      }
    }
    const postflop = boardInts.length >= 3;
    const kinds = postflop ? (kindsCache.kinds || (kindsCache.kinds = boardKinds(boardInts))) : null;
    let mass = 0, str = 0;
    for (let k = 0; k < NC; k++) {
      mass += w[k];
      str += w[k] * (kinds ? SVAL[kinds[k]] : 1 - COMBO_PCT[k]);
    }
    const strength = mass > 0 ? str / mass : 0.5;
    return {
      role: role, act: S.street === 'preflop' ? null : actionKindOf(seat), weights: w, pctOfHands: mass / NC,
      style: style, position: seat.position, bet: seat.bet || 0, stack: seat.stack, total: (seat.stack || 0) + (seat.contributed || 0), allin: (seat.stack || 0) <= 0,
      streets: streets, strength: strength,
    };
  }
  // Summary of one villain's narrowed range (seat object or seat index).
  function rangeSummary(S, seat, lang) {
    const sObj = typeof seat === 'number' ? S.seats.find((x) => x.seat === seat) : seat;
    const L = langOf(lang || S.lang);
    const vi = villainInfo(S, sObj, parseCards(S.board || []), {});
    return { label: rangeLabel(vi.strength, L), mass: vi.pctOfHands, strength: vi.strength, streets: vi.streets };
  }
  // Short phrase for the UI: "muy fuerte (~18% de las manos)".
  function describeRange(S, seat, lang) {
    const L = langOf(lang || S.lang);
    const r = rangeSummary(S, seat, L);
    return tr(L, 'rng_value', { label: r.label, p: pctStr(r.mass) });
  }
  // Chance that one villain folds to a bet of betFrac x pot. Calibrated (see test/MATH_REVIEW.md):
  // a strong narrowed range folds less, a weak one more; a villain who already called or raised this street
  // and covers the bet folds rarely (at most 10%); a shove against a covering strong range gets no folds.
  function foldProb(v, betFrac, coveredShove) {
    if (v.allin) return 0;
    if (coveredShove && v.strength > 0.6) return 0;
    let p = 0.22 + 0.28 * Math.min(betFrac, 1.25) / 1.25;
    p *= FOLD_MULT[v.style] || 1;
    p *= 1.15 - 0.5 * v.strength;
    if (v.act === 'raise' || v.act === 'bet' || v.act === '3bet') p *= 0.9;
    if (v.act === 'call' || v.act === 'limp') p = Math.min(p, 0.1);
    return clamp(p, 0.02, 0.7);
  }

  // ------------------------------------------------------------- evaluate
  function posName(p, lang) { return tr(lang || 'en', 'pos_' + p); }

  const ROLE_KEY = {
    open: 'v_role_open', '3bet': 'v_role_3bet', '4bet': 'v_role_4bet', call_open: 'v_role_call_open',
    call_3bet: 'v_role_call_3bet', call_4bet: 'v_role_call_4bet', limp: 'v_role_limp',
    bb_check: 'v_role_bb_check', default: 'v_role_default', pending: 'v_role_pending',
  };

  // ----------------------------------------------------------- narration
  // Conversational coach text built from live data. Text only: no decision logic here.
  const STYLE_ES = { tight: 'cerrado', loose: 'suelto', aggressive: 'agresivo', passive: 'pasivo', balanced: 'neutro' };
  // [singular, plural] verb phrases for one player or several.
  const ACT_ES = {
    open: ['ha abierto', 'han abierto'], '3bet': ['ha resubido', 'han resubido'], call: ['solo ha igualado', 'solo han igualado'],
    raise: ['ha subido', 'han subido'], bet: ['ha apostado', 'han apostado'], check: ['ha pasado', 'han pasado'],
    limp: ['ha limpeado', 'han limpeado'], pending: ['por actuar', 'por actuar'],
  };
  const ACT_EN = {
    open: ['opened', 'opened'], '3bet': ['made a 3-bet', 'made a 3-bet'], call: ['only called', 'only called'],
    raise: ['raised', 'raised'], bet: ['bet', 'bet'], check: ['checked', 'checked'], limp: ['limped', 'limped'],
    pending: ['yet to act', 'yet to act'],
  };
  const TIER_ADJ_ES = { 1: 'muy fuerte', 2: 'fuerte', 3: 'jugable', 4: 'especulativa', 5: 'débil' };
  const TIER_ADJ_EN = { 1: 'very strong', 2: 'strong', 3: 'playable', 4: 'speculative', 5: 'weak' };
  const ES_INF = { fold: 'retirarte', call: 'igualar', check: 'pasar', raise: 'subir' };
  const ES_STYLE_PL = { tight: 'ajustados', loose: 'sueltos', aggressive: 'agresivos', passive: 'pasivos', balanced: 'equilibrados' };
  const EN_GER = { fold: 'folding', call: 'calling', check: 'checking', raise: 'raising' };
  const EN_VERB = { fold: 'fold', call: 'call', check: 'check', raise: 'raise' };
  const ES_NUM = ['cero', 'un', 'dos', 'tres', 'cuatro'];
  const EN_NUM = ['zero', 'one', 'two', 'three', 'four'];

  function numL(x, L) { return L === 'es' ? fmt(x).replace('.', ',') : fmt(x); }
  function capFirst(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  // "check" when calling would cost nothing.
  function actName(a, C) { return a === 'call' && C <= 0 ? 'check' : a; }

  // Action of one villain on the current street, from live seat data.
  function villainAct(v, preflop) {
    if (!preflop) {
      const k = v.lastActionKind;
      return (k === 'bet' || k === 'raise' || k === 'call' || k === 'check') ? k : 'pending';
    }
    const map = { open: 'open', '3bet': '3bet', '4bet': '3bet', '5bet': '3bet', call_open: 'call', call_3bet: 'call', call_4bet: 'call', limp: 'limp', bb_check: 'check' };
    if (map[v.role]) return map[v.role];
    // No known role: fall back to the action kind, so an opponent who already acted is never "yet to act".
    const byKind = { raise: 'open', bet: 'open', call: 'call', check: 'check', limp: 'limp' };
    return byKind[v.lastActionKind] || 'pending';
  }

  // One group of players with the same style and action.
  function groupText(g, es) {
    const k = g.count;
    if (es) {
      const adj = STYLE_ES[g.style] || 'neutro';
      if (g.act === 'pending') return k === 1 ? 'un jugador ' + adj + ' por actuar' : (k <= 4 ? ES_NUM[k] : String(k)) + ' jugadores ' + adj + 's por actuar';
      const verb = ACT_ES[g.act] || ACT_ES.pending;
      if (k === 1) return 'un jugador ' + adj + ' que ' + verb[0];
      return (k <= 4 ? ES_NUM[k] : String(k)) + ' jugadores ' + adj + 's que ' + verb[1];
    }
    const adj = g.style;
    if (g.act === 'pending') return k === 1 ? (/^[aeiou]/i.test(adj) ? 'an ' : 'a ') + adj + ' player yet to act' : (k <= 4 ? EN_NUM[k] : String(k)) + ' ' + adj + ' players yet to act';
    const verb = ACT_EN[g.act] || ACT_EN.pending;
    if (k === 1) return (/^[aeiou]/i.test(adj) ? 'an ' : 'a ') + adj + ' player who ' + verb[0];
    return (k <= 4 ? EN_NUM[k] : String(k)) + ' ' + adj + ' players who ' + verb[1];
  }
  // "un jugador pasivo que solo ha igualado y dos jugadores neutros que aún no actúan"
  function villainPhrase(villains, L) {
    const es = L === 'es';
    const n = villains.length;
    if (!n) return es ? 'nadie más' : 'nobody else';
    const groups = [];
    for (const v of villains) {
      let g = groups.find((x) => x.style === v.style && x.act === v.act);
      if (!g) { g = { style: v.style, act: v.act, count: 0 }; groups.push(g); }
      g.count++;
    }
    const pendingAll = villains.every((v) => v.act === 'pending');
    const shown = groups.slice(0, 1);
    const shownCount = shown.reduce((a, g) => a + g.count, 0);
    const parts = shown.map((g) => groupText(g, es));
    let text = parts.length === 1 ? parts[0] : parts[0] + (es ? ' y ' : ' and ') + parts[1];
    const rest = n - shownCount;
    if (rest > 0) {
      if (es) text += ' y ' + rest + (rest === 1 ? ' jugador más' : ' jugadores más');
      else text += ' and ' + rest + (rest === 1 ? ' more player' : ' more players');
    }
    return text;
  }

  // ------------------------------------------------ objective chances (no ranges, no betting)
  const SUIT_SYM = { s: '♠', h: '♥', d: '♦', c: '♣' };
  function cardSym(c) { return RANKS[c >> 2] + SUIT_SYM[SUITS[c & 3]]; }
  // Seed for every Monte Carlo and template choice: a hash of the situation, never of the scenario id.
  function situationSeed(S) {
    const seats = S.seats.map((s) => [s.position, s.stack, s.bet, s.contributed, s.folded ? 1 : 0, s.style, s.isHero ? 1 : 0].join(':')).join('|');
    return hashSeed([(S.hero || []).join(''), (S.board || []).join(''), S.street, S.pot, S.toCall, S.heroStack,
      S.numPlayers, S.inPosition ? 1 : 0, seats, JSON.stringify(S.history || [])].join('#'));
  }
  // Hero's chance to win when every opponent holds random cards and the missing board cards are random.
  // Exact by enumeration for one opponent on the river or turn; otherwise a seeded Monte Carlo of 60000 deals.
  const RWP_SAMPLES = 60000;
  const rwpCache = new Map();
  function randomWinCore(heroInts, boardInts, numOpp) {
    const opp = Math.max(0, Math.min(8, numOpp | 0));
    const known = new Uint8Array(52);
    for (const c of heroInts.concat(boardInts)) known[c] = 1;
    const unseen = [];
    for (let c = 0; c < 52; c++) if (!known[c]) unseen.push(c);
    const toCome = 5 - boardInts.length;
    if (opp === 0) return { win: 1, total: 1, exact: true };
    const credit = (acc, board5, oppHands) => {
      const hs = scoreCards(heroInts.concat(board5), 7);
      let best = -1, ties = 0;
      for (const h of oppHands) {
        const sc = scoreCards(h.concat(board5), 7);
        if (sc > best) { best = sc; ties = 1; } else if (sc === best) ties++;
      }
      if (hs > best) acc.win += 1; else if (hs === best) acc.win += 1 / (ties + 1);
      acc.total++;
    };
    const acc = { win: 0, total: 0 };
    if (opp === 1 && toCome <= 1) {
      const runouts = toCome === 0 ? [[]] : unseen.map((c) => [c]);
      for (const run of runouts) {
        const board5 = boardInts.concat(run);
        const rest = unseen.filter((c) => run.indexOf(c) < 0);
        for (let i = 0; i < rest.length; i++) {
          for (let j = i + 1; j < rest.length; j++) credit(acc, board5, [[rest[i], rest[j]]]);
        }
      }
      return { win: acc.win, total: acc.total, exact: true };
    }
    const rng = makeRng(hashSeed(heroInts.concat(boardInts).join(',') + '|' + opp));
    const work = unseen.slice();
    for (let s = 0; s < RWP_SAMPLES; s++) {
      // Partial Fisher-Yates: the first cards of the work array are a uniform random draw.
      for (let k = 0; k < toCome + 2 * opp; k++) {
        const j = k + Math.floor(rng() * (work.length - k));
        const t = work[k]; work[k] = work[j]; work[j] = t;
      }
      const oppHands = [];
      for (let o = 0; o < opp; o++) oppHands.push([work[toCome + 2 * o], work[toCome + 2 * o + 1]]);
      credit(acc, boardInts.concat(work.slice(0, toCome)), oppHands);
    }
    return { win: acc.win, total: acc.total, exact: false };
  }
  // Public: { pct (0-100, one decimal), exact, samples }. Cards may be strings ('As') or ints.
  function randomWinPct(heroCards, board, numOpponents) {
    const hi = (heroCards || []).map((x) => (typeof x === 'number' ? x : parseCard(x)));
    const bi = (board || []).map((x) => (typeof x === 'number' ? x : parseCard(x)));
    const key = hi.join(',') + '|' + bi.join(',') + '|' + (numOpponents | 0);
    if (rwpCache.has(key)) return Object.assign({}, rwpCache.get(key));
    const r = randomWinCore(hi, bi, numOpponents);
    const out = { pct: Math.round((r.win / r.total) * 1000) / 10, exact: r.exact, samples: r.total };
    if (rwpCache.size > 2000) rwpCache.clear();
    rwpCache.set(key, out);
    return Object.assign({}, out);
  }
  // Chance that one card completes a flush or straight draw by the river (hypergeometric, exact).
  // Backdoor draws that need two cards are not counted.
  function combN(n, k) {
    if (k < 0 || k > n) return 0;
    let r = 1;
    for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
    return r;
  }
  function drawChance(heroInts, boardInts) {
    if (boardInts.length < 3 || boardInts.length > 4) return null;
    const base = heroInts.concat(boardInts);
    const cur = scoreCards(base, base.length) >>> 20;
    if (cur >= 4) return null;
    const known = new Set(base);
    let n = 0, outs = 0;
    for (let c = 0; c < 52; c++) {
      if (known.has(c)) continue;
      n++;
      const cat = scoreCards(base.concat([c]), base.length + 1) >>> 20;
      if (cat > cur && (cat === 4 || cat === 5)) outs++;
    }
    if (outs === 0) return null;
    const k = 5 - boardInts.length;
    const pct = 1 - combN(n - outs, k) / combN(n, k);
    return { pct: Math.round(pct * 1000) / 10, outs: outs, cardsToCome: k };
  }

  // Chance that at least one opponent (random hole cards) has a pair or better that uses a hole card,
  // a flush, or a straight by the river on this board. Seeded Monte Carlo (800 deals), cached.
  const boardOddsCache = new Map();
  function boardOdds(heroInts, boardInts, numOpp) {
    const n = Math.max(1, Math.min(8, numOpp | 0));
    const key = heroInts.concat(boardInts).join(',') + '|' + n;
    if (boardOddsCache.has(key)) return boardOddsCache.get(key);
    const known = new Set(heroInts.concat(boardInts));
    const unseen = [];
    for (let c = 0; c < 52; c++) if (!known.has(c)) unseen.push(c);
    const toCome = 5 - boardInts.length;
    const rng = makeRng(hashSeed('odds|' + key));
    const work = unseen.slice();
    const SAMPLES = 800;
    let pair = 0, flush = 0, straight = 0;
    for (let s = 0; s < SAMPLES; s++) {
      for (let k = 0; k < toCome + 2 * n; k++) {
        const j = k + Math.floor(rng() * (work.length - k));
        const t = work[k]; work[k] = work[j]; work[j] = t;
      }
      const b5 = boardInts.concat(work.slice(0, toCome));
      const boardRanks = new Array(13).fill(0);
      for (const c of b5) boardRanks[c >> 2]++;
      let hasPair = false, hasFlush = false, hasStraight = false;
      for (let o = 0; o < n; o++) {
        const h1 = work[toCome + 2 * o], h2 = work[toCome + 2 * o + 1];
        const cat = scoreCards(b5.concat([h1, h2]), 7) >>> 20;
        if (cat >= 5) hasFlush = true;
        else if (cat === 4) hasStraight = true;
        // A pair counts only when a hole card pairs the board or the hole cards are a pocket pair.
        if (cat >= 1 && (boardRanks[h1 >> 2] > 0 || boardRanks[h2 >> 2] > 0 || (h1 >> 2) === (h2 >> 2))) hasPair = true;
      }
      if (hasPair) pair++;
      if (hasFlush) flush++;
      if (hasStraight) straight++;
    }
    const out = { pair: pair / SAMPLES, flush: flush / SAMPLES, straight: straight / SAMPLES };
    boardOddsCache.set(key, out);
    return out;
  }
  // Plain-word level of a chance. Thresholds: >= 75% very high, >= 50% high, >= 25% medium, else low.
  function oddsLevel(p, L) {
    const es = L === 'es';
    if (p >= 0.75) return es ? 'muy alta' : 'very high';
    if (p >= 0.5) return es ? 'alta' : 'high';
    if (p >= 0.25) return es ? 'media' : 'medium';
    return es ? 'baja' : 'low';
  }

  // Rank names in plain words (index = rank 0..12, '2'..'A').
  const RANK_EN = ['twos', 'threes', 'fours', 'fives', 'sixes', 'sevens', 'eights', 'nines', 'tens', 'jacks', 'queens', 'kings', 'aces'];
  const RANK_ES = ['doses', 'treses', 'cuatros', 'cincos', 'seises', 'sietes', 'ochos', 'nueves', 'dieces', 'jotas', 'reinas', 'reyes', 'ases'];
  const RANK_EN1 = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'jack', 'queen', 'king', 'ace'];

  // The hero's hand in plain words: a made hand, or a made hand plus a draw, or a draw.
  // Also returns the category, draws, and board danger (flush or straight the board can make).
  function heroSummary(heroInts, boardInts, preflop, lang, draws) {
    const L = lang || 'en', es = L === 'es';
    const hr = heroInts.map((c) => c >> 2);
    if (preflop) {
      const hi = Math.max(hr[0], hr[1]), lo = Math.min(hr[0], hr[1]);
      const suited = (heroInts[0] & 3) === (heroInts[1] & 3);
      let label;
      if (hi === lo) label = tr(L, 'hl_pair', { r: es ? RANK_ES[hi] : RANK_EN[hi] });
      else if (suited) label = tr(L, 'hl_suited', { hi: RANKS[hi], lo: RANKS[lo] });
      else if (hi <= 7) label = tr(L, 'hl_small');
      else label = tr(L, 'hl_offsuit', { hi: RANKS[hi], lo: RANKS[lo] });
      return { label: label, cat: -1, draws: [], danger: '' };
    }
    const all = heroInts.concat(boardInts);
    const rawCat = scoreCards(all, all.length) >>> 20;
    const counts = new Array(13).fill(0);
    for (const r of hr.concat(boardInts.map((c) => c >> 2))) counts[r]++;
    // A pair that is only on the board is no pair for the hero: the hand is a high card.
    const pr = rawCat === 1 ? counts.findIndex((n, r) => n === 2 && hr.indexOf(r) >= 0) : -1;
    // The same holds when the board alone already makes the category (e.g. trips on the board).
    const boardCat = boardInts.length >= 3 ? scoreCards(boardInts, boardInts.length) >>> 20 : 0;
    const cat = rawCat === 1 ? (pr < 0 ? 0 : 1) : (rawCat >= 2 && boardCat === rawCat ? 0 : rawCat);
    const d = draws || drawInfo(heroInts, boardInts, boardInts.length === 3 ? 'flop' : 'turn', L);
    let label = cat === 0 ? tr(L, 'made_high', { r: es ? RANKS[Math.max(hr[0], hr[1])] : RANK_EN1[Math.max(hr[0], hr[1])] }) : madeHandDesc(heroInts, boardInts, L);
    if (rawCat === 2 && cat === 2 && boardCat === 1) {
      // The board holds one pair and the hero's pair sits below it: a weak two pair.
      const bc = new Array(13).fill(0);
      for (const c of boardInts) bc[c >> 2]++;
      const pb = bc.findIndex((n) => n >= 2);
      const ph = hr.find((r) => r !== pb && counts[r] >= 2);
      if (pb >= 0 && ph !== undefined && ph < pb) label = tr(L, 'hl_weak2', { r: es ? RANK_ES[pb] : RANK_EN[pb] });
    }
    if (cat === 1) {
      // Kicker: the highest hero card that is not the paired rank, when the pair is the hero's own.
      const kicker = hr[0] === hr[1] ? -1 : Math.max.apply(null, hr.filter((r) => r !== pr));
      if (kicker >= 9) label += tr(L, 'hl_kicker');
    }
    if (cat <= 1 && (d.flushDraw || d.straightDraw)) {
      label = cat === 1 ? tr(L, 'hl_both', { made: label, draw: d.draws[0] }) : d.draws[0];
    }
    const tex = boardTexture(boardInts, L);
    const fl = tex.flushPossible && cat < 5, st = tex.straightPossible && cat < 4;
    const danger = fl && st ? tr(L, 'dg_both') : fl ? tr(L, 'dg_flush') : st ? tr(L, 'dg_straight') : '';
    return { label: label, cat: cat, draws: d.draws, danger: danger };
  }

  // The board in plain words with suit symbols, e.g. "On the flop K♠ 7♦ 2♣, the board is dry: ...".
  // Board in suit symbols, with the chance that a flush appears and that an opponent gets a pair.
  function boardSentence(S, boardInts, heroInts, nVill, L) {
    const es = L === 'es';
    const cards = boardInts.map(cardSym).join(' ');
    const o = boardOdds(heroInts, boardInts, nVill);
    // The level word uses the same rounded percentage that is printed (50% must not read as "possible").
    const lvl = oddsLevel(Math.round(o.pair * 100) / 100, L), flushLvl = oddsLevel(Math.round(o.flush * 100) / 100, L);
    const pct = Math.round(o.pair * 100) + '%';
    const opp = nVill === 1 ? (es ? '1 rival' : '1 opponent') : (es ? nVill + ' rivales' : nVill + ' opponents');
    if (es) {
      const flushW = { 'muy alta': 'muy probable', alta: 'probable', media: 'posible', baja: 'poco probable' }[flushLvl];
      return 'En el ' + S.street + ' ' + cards + ', el color es ' + flushW + '; contra ' + opp + ', alguien tendrá pareja: probabilidad ' + lvl + ' (' + pct + ').';
    }
    const flushW = { 'very high': 'very likely', high: 'likely', medium: 'possible', low: 'unlikely' }[flushLvl];
    const pairW = { 'very high': 'very likely', high: 'likely', medium: 'possible', low: 'unlikely' }[lvl];
    return 'On the ' + S.street + ' ' + cards + ', a flush is ' + flushW + '; against ' + opp + ', a pair is ' + pairW + ' (' + pct + ').';
  }

  // One phrase about what the seat implies.
  function positionNote(pos, lang) {
    const key = pos === 'BTN' || pos === 'CO' ? 'pn_late'
      : pos === 'SB' || pos === 'BB' ? 'pn_blind'
        : pos === 'UTG' || pos === 'UTG+1' ? 'pn_early' : 'pn_mid';
    return tr(lang || 'en', key);
  }

  // One takeaway sentence for a beginner, from the best move.
  function tipFor(best, C, lang) {
    const L = lang || 'en';
    if (best === 'raise') return tr(L, 'tip_raise');
    if (best === 'call') return tr(L, C > 0 ? 'tip_call' : 'tip_check');
    return tr(L, 'tip_fold');
  }

  // Bullets 1-3 as conversational coach text.
  function narrate(c) {
    const L = c.L, es = L === 'es', h = c.seed;
    const pick3 = (arr) => arr[h % arr.length];
    const villains = c.villains.map((v) => ({ style: v.style, act: villainAct(v, c.preflop) }));
    // Short opener: with several opponents, give the count; the stats table lists their styles.
    // Several opponents: the count and the dominant style (the stats table lists each one).
    const styleCount = {};
    for (const v of c.villains) styleCount[v.style] = (styleCount[v.style] || 0) + 1;
    const domStyle = Object.keys(styleCount).sort((a, b) => styleCount[b] - styleCount[a])[0];
    const vs = villains.length > 1
      ? (es ? villains.length + ' jugadores, sobre todo ' + ES_STYLE_PL[domStyle] : villains.length + ' players, mostly ' + domStyle)
      : villainPhrase(villains, L);
    const posTxt = posName(c.pos, L);
    const streetTxt = c.preflop ? '' : (es ? ' en el ' + c.street : ' on the ' + c.street);
    let intro;
    if (!villains.length) intro = es ? 'Estás en ' + posTxt + ', sin rivales activos.' : "You're on " + posTxt + ', with no active rivals.';
    else if (villains.length === 1) intro = es
      ? 'En ' + posTxt + ', cara a cara contra ' + vs + '.'
      : 'On ' + posTxt + ', heads up against ' + vs + '.';
    else if (es) intro = pick3(['En ' + posTxt + ' contra ' + vs + '.', 'Desde ' + posTxt + ' juegas contra ' + vs + '.']);
    else intro = pick3(['On ' + posTxt + ' against ' + vs + '.', 'From ' + posTxt + ', you face ' + vs + '.']);

    // Recommendation and main reason.
    const many = villains.length > 1;
    let rec;
    if (c.best === 'raise') {
      // The amount comes first: the same size the Raise button applies (c.raiseSize).
      const sz = c.raiseSize == null ? '' : numL(c.raiseSize, L);
      const ap = c.raiseSize == null ? (es ? 'Sube' : 'Raise')
        : c.raiseAllin ? (es ? 'Sube todo a ' + sz + ' BB' : 'Shove to ' + sz + ' BB')
          : (es ? 'Sube a ' + sz + ' BB' : 'Raise to ' + sz + ' BB');
      if (c.E < 0.4) rec = ap + ': ' + pick3(es ? ['pueden retirarse.', 'se retirarán.'] : ['a fold is likely.', 'they may fold.']);
      else if (c.vStrength < 0.5) rec = ap + ': ' + pick3(es ? ['pocas manos fuertes.', 'rango flojo.'] : ['they rarely have much.', 'their range is weak.']);
      else if (c.E < 0.55) rec = ap + ': ' + pick3(es ? ['pueden retirarse.', 'para ganar el bote.'] : ['they may fold.', 'to win the pot now.']);
      else rec = ap + ': ' + pick3(es ? ['vas por delante.', 'para cobrar valor.'] : ['your hand is ahead.', 'for value.']);
    } else if (c.best === 'call' && c.C > 0) {
      rec = es
        ? pick3(['Iguala: el precio compensa.', 'Iguala: vale lo que cuesta.'])
        : pick3(['Call and stay in: the price is worth it.', 'Call: your hand is worth the price of staying in.']);
    } else if (c.best === 'call') {
      rec = es
        ? pick3(['Pasa: no te cuesta nada.', 'Pasa gratis y mira la siguiente carta.'])
        : pick3(['Check: it costs nothing.', 'Check for free and see the next card.']);
    } else {
      rec = es
        ? pick3(['Retírate: el precio es demasiado alto.', 'Retírate y guarda las fichas: no compensa.'])
        : pick3(['Fold: the price is too high for your hand.', 'Fold and save your chips: it does not pay.']);
    }
    const b1 = intro + ' ' + capFirst(rec);

    // Hand strength in plain words.
    const E = pctStr(c.E);
    const hs = c.hs;
    let b2;
    if (c.preflop) {
      b2 = es
        ? 'Tu mano, ' + hs.label + ', es ' + TIER_ADJ_ES[c.tier] + ': tienes una probabilidad de ganar de alrededor del ' + E + '.'
        : 'Your hand, ' + hs.label + ', is ' + TIER_ADJ_EN[c.tier] + ': about ' + E + ' chance to win.';
    } else {
      // The danger sentence is skipped when a draw is already named (keeps the bullet short).
      const dangerTxt = hs.danger && hs.cat <= 1 && !(c.draws && c.draws.length) ? ' ' + hs.danger : '';
      b2 = es
        ? 'Tienes ' + hs.label + ': probabilidad de ganar de alrededor del ' + E + '.' + dangerTxt
        : 'You have ' + hs.label + ': about ' + E + ' chance to win.' + dangerTxt;
    }

    // Third bullet: what the alternatives cost, relative to the user's choice.
    const user = actName(c.userAction, c.C), best = actName(c.best, c.C), alt = c.altAction ? actName(c.altAction, c.C) : null;
    let b3;
    if (user === best && (c.rating === 'best' || c.rating === 'good')) {
      if (!alt || c.altCost < 0.05) {
        b3 = es ? 'Las otras opciones valen casi lo mismo, así que es cuestión de estilo.' : 'The other lines are nearly as good, so this is a matter of style.';
      } else {
        b3 = es
          ? capFirst(ES_INF[alt]) + ' aquí te costaría unos ' + numL(c.altCost, L) + ' BB de media.'
          : capFirst(EN_GER[alt]) + ' here would cost about ' + numL(c.altCost, L) + ' BB on average.';
      }
    } else {
      // The user's move differs from the best one: name the best move, then say how costly the choice was.
      const named = tr(L, 'best_named', { verb: es ? ES_INF[best] : EN_VERB[best] });
      if (c.rating === 'good') {
        b3 = named + tr(L, 'best_close');
      } else {
        let cons;
        if (user === 'call' && best === 'fold') cons = tr(L, 'alt_call_lose', { req: pctStr(c.req), e: E });
        else if (user === 'raise') cons = tr(L, 'alt_raise_none', { e: E });
        else if (user === 'fold') cons = tr(L, 'alt_fold_cost', { e: E });
        else cons = tr(L, 'alt_call_value', { d: numL(c.diff, L) });
        b3 = named + ' ' + cons;
      }
    }
    return [b1, b2, b3];
  }

  function evaluate(scenario, action, raiseAmount, options) {
    const S = scenario;
    const opts = options || {};
    const L = langOf(opts.lang || S.lang);
    const seats = S.seats;
    const hero = seats.find((s) => s.isHero);
    const heroInts = parseCards(S.hero);
    const boardInts = parseCards(S.board || []);
    const street = S.street;
    const preflop = street === 'preflop';
    const P = S.pot;
    const C = Math.max(0, Math.min(r2(S.toCall), r2(S.heroStack)));
    const heroBet = hero.bet;
    const curMax = Math.max(heroBet + C, ...seats.map((s) => s.bet));
    const cap = r2(heroBet + S.heroStack);
    const live = seats.filter((s) => !s.isHero && !s.folded);
    const kindsCache = {};
    const vinfos = live.map((s) => villainInfo(S, s, boardInts, kindsCache));
    const samples = opts.samples || 3000;
    const eqd = live.length
      ? equityDetail(heroInts, boardInts, vinfos.map((v) => v.weights), { samples: samples, rng: opts.rng || makeRng(situationSeed(S)), record: true })
      : { equity: 1, samples: 0 };
    const E = eqd.equity;
    const realize = S.inPosition ? 1 : 0.92;
    const heroTotal = (hero.contributed || 0) + S.heroStack;
    const coversAny = vinfos.some((v) => v.total > heroTotal + 1e-9);
    const allInCall = C > 0 && C >= S.heroStack - 1e-9;
    const stackOff = allInCall && coversAny ? 0.05 : 0;
    // No implied-odds bonus: an earlier version added 3% of the pot on deep stacks to the call EV only,
    // which made calling look better than raising in exactly those spots (raise EV had no such term).
    const callEV = Math.max(0, E * realize - stackOff) * (P + C) - C;
    const req = C > 0 ? C / (P + C) : 0;

    // Raise EV for a total raise-to amount R (hero's total bet this street).
    // Per sample: each villain folds with its own probability; the hero is
    // compared with the callers who remain. The pot holds every caller's chips.
    function raiseEV(R) {
      const maxTot = vinfos.length ? Math.max(curMax, ...vinfos.map((v) => v.total)) : R;
      const inc = Math.min(R, maxTot) - heroBet;
      const over = Math.max(0, R - curMax);
      const betFrac = over / Math.max(0.01, P + C);
      const shove = R >= cap - 1e-9;
      const folds = vinfos.map((v) => foldProb(v, betFrac, shove && v.total > heroTotal + 1e-9));
      const fold = folds.reduce((a, f) => a * f, 1);
      if (!eqd.rec) return { ev: fold * P + (1 - fold) * (E * realize * (P + C) - C), fold: fold };
      const rec = eqd.rec, k = vinfos.length, n = rec.n;
      const incs = vinfos.map((v) => Math.min(Math.max(0, R - v.bet), v.stack));
      const rng = makeRng(situationSeed(S) + 7);
      let total = 0;
      for (let s = 0; s < n; s++) {
        let nc = 0, add = 0, maxV = -1, ties = 0;
        for (let v = 0; v < k; v++) {
          if (rng() < folds[v]) continue;
          nc++;
          add += incs[v];
          const sc = rec.vs[s * k + v];
          if (sc > maxV) { maxV = sc; ties = 1; } else if (sc === maxV) ties++;
        }
        if (nc === 0) { total += P; continue; }
        const h = rec.hs[s];
        let w = h > maxV ? 1 : h === maxV ? 1 / (ties + 1) : 0;
        w *= realize;
        total += w * (P + add) - (1 - w) * inc;
      }
      return { ev: total / n, fold: fold };
    }

    // Candidate raise sizes: the scenario's options, filtered to legal sizes.
    const curSeats = Math.max(...seats.map((s) => s.bet));
    const stdRaise = standardRaiseTo(legalRaise(curSeats, heroBet, S.heroStack, S.lastRaise), P, preflop, 1);
    const cands = stdRaise == null ? [] : [stdRaise];
    let bestRaise = null, bestRaiseEV = -Infinity;
    for (const R of cands) {
      const e = raiseEV(R).ev;
      if (e > bestRaiseEV) { bestRaiseEV = e; bestRaise = R; }
    }
    const canRaise = bestRaise !== null;

    // Best action (ties resolved toward call, then raise).
    // A raise with a medium postflop hand (one pair or a weak two pair, under 55% chance to win) needs a
    // weak narrowed villain range; against a strong range, the chance that they fold is not enough.
    const drawsEarly = preflop ? null : drawInfo(heroInts, boardInts, street, L);
    const hs = heroSummary(heroInts, boardInts, preflop, L, drawsEarly);
    const mainV0 = vinfos.reduce((b, v) => (!b || v.streets > b.streets ? v : b), null);
    const vStrength = mainV0 ? mainV0.strength : 0.5;
    const medium = !preflop && hs.cat >= 0 && hs.cat <= 2;
    const raiseOK = !medium || E >= 0.55 || vStrength < 0.5;
    // Preflop, facing an open or a 3-bet: a raise needs a raise cell in the range chart or at least 45%
    // chance to win. Without either, the raise rests on fold equity alone, which we do not give to trash.
    const roleList = vinfos.map((v) => v.role);
    const preState = !preflop ? null : roleList.some((r) => r === '3bet') ? 'vs_3bet' : roleList.some((r) => r === 'open') ? 'vs_open' : null;
    const pctPre = COMBO_PCT[comboIndex(Math.min(heroInts[0], heroInts[1]), Math.max(heroInts[0], heroInts[1]))];
    const preRaiseCell = preState !== null && chartAdvice(pctPre, hero.position, S.numPlayers, preState, L, S.heroStack).action === 'raise';
    const raiseOK2 = preState === null || preRaiseCell || E >= 0.45;
    let best = 'fold', bestEV = 0;
    if (callEV > bestEV + 1e-9) { best = 'call'; bestEV = callEV; }
    if (canRaise && raiseOK && raiseOK2 && bestRaiseEV > bestEV + 1e-9) { best = 'raise'; bestEV = bestRaiseEV; }
    // Nobody has bet (toCall = 0): checking is free and never worse than folding.
    if (C <= 0 && best === 'fold') best = 'call';

    // The user's action.
    let userAction = action, userAmount = null, userEV;
    if (action === 'fold') userEV = 0;
    else if (action === 'raise' && canRaise) {
      userAmount = raiseAmount != null ? clamp(r2(raiseAmount), curMax + 0.5, cap) : bestRaise;
      userEV = raiseEV(userAmount).ev;
    } else { userAction = 'call'; userEV = callEV; }
    const evRaiseShown = canRaise ? (userAmount != null ? userEV : bestRaiseEV) : null;
    const bestRaiseShown = canRaise ? bestRaise : null;

    const diff = Math.max(0, bestEV - userEV);
    // Rating thresholds (BB): good within max(0.3, 5% of pot); mistake up to max(1.5, 20% of pot); blunder above.
    const goodT = Math.max(0.3, 0.05 * (P + C));
    const blunderT = Math.max(1.5, 0.2 * (P + C));
    let rating;
    if (userAction === best && diff < 0.05) rating = 'best';
    else if (diff <= goodT) rating = 'good';
    else if (diff <= blunderT) rating = 'mistake';
    else rating = 'blunder';
    let score;
    if (rating === 'best') score = 100;
    else if (rating === 'good') score = Math.round(96 - 16 * diff / goodT);
    else if (rating === 'mistake') score = Math.round(clamp(79 - 39 * (diff - goodT) / Math.max(0.01, blunderT - goodT), 40, 79));
    else score = Math.round(clamp(39 - 39 * Math.min(1, (diff - blunderT) / blunderT), 0, 39));
    // Folding when the check is free is always a mistake, however small the EV gap looks.
    // A fold that is already a blunder stays a blunder; a fold rated better than mistake drops to mistake.
    // A fold when checking is free throws away the whole pot share: always a blunder, scored near zero.
    if (C <= 0 && userAction === 'fold') { rating = 'blunder'; score = Math.min(score, 5); }

    // ---- descriptive values
    const effStack = Math.min(S.heroStack, ...(live.length ? live.map((s) => s.stack) : [S.heroStack]));
    const spr = P > 0 ? effStack / P : 0;
    const heroHand = heroInts.map(cardSym);
    const cls = comboClass(heroInts[0], heroInts[1]);
    const pct = COMBO_PCT[comboIndex(Math.min(heroInts[0], heroInts[1]), Math.max(heroInts[0], heroInts[1]))];
    const tier = tierOf(pct);
    const tierName = tr(L, 'tier_' + tier);
    const draws = drawsEarly;
    const madeDesc = preflop ? null : madeHandDesc(heroInts, boardInts, L);
    const texture = preflop || boardInts.length < 3 ? null : boardTexture(boardInts, L);
    const nVill = live.length;
    const villainText = vinfos.length
      ? vinfos.map((v, i) => tr(L, 'v_line', {
        pos: posName(live[i].position, L),
        style: tr(L, 'style_' + v.style),
        role: tr(L, ROLE_KEY[v.role] || 'v_role_default'),
      })).join('; ')
      : tr(L, 'v_none');
    const rangePct = vinfos.length ? vinfos.reduce((a, v) => a + v.pctOfHands, 0) / vinfos.length : 1;

    // Preflop chart state from villain roles.
    let chartState = 'unopened';
    if (preflop) {
      const roles = vinfos.map((v) => v.role);
      if (roles.some((r) => r === '3bet')) chartState = 'vs_3bet';
      else if (roles.some((r) => r === 'open')) chartState = 'vs_open';
      else if (roles.some((r) => r === 'limp')) chartState = 'limped';
    }
    // Same hand percentile the Ranges grid uses (class percentile, not the combo one).
    const chart = preflop ? chartAdvice(CLASS_PCT[comboClass(heroInts[0], heroInts[1]).key], hero.position, S.numPlayers, chartState, L, S.heroStack) : null;

    const actionName = (a) => {
      if (a === 'raise') return tr(L, 'act_name_raise');
      if (a === 'call') return tr(L, C > 0 ? 'act_name_call' : 'act_name_check');
      return tr(L, 'act_name_fold');
    };
    let reasonKey;
    if (best === 'raise') reasonKey = E > 0.55 ? 'r_raise_ahead' : 'r_raise_fe';
    else if (best === 'call') reasonKey = C > 0 ? 'r_call_price' : 'r_check_free';
    else reasonKey = 'r_fold_odds';
    const summary = tr(L, 'sum_best', { action: actionName(best), reason: tr(L, reasonKey) });

    // Explanation: three short bullets, then up to four extra notes.
    const evByAction = { fold: 0, call: callEV, raise: canRaise ? bestRaiseEV : -Infinity };
    let second = { a: null, v: -Infinity };
    for (const act of ['fold', 'call', 'raise']) {
      if (act === best || (act === 'raise' && !canRaise)) continue;
      if (evByAction[act] > second.v) second = { a: act, v: evByAction[act] };
    }
    const explanation = narrate({
      L: L, seed: situationSeed(S), preflop: preflop, street: street, pos: hero.position, hs: hs, req: req, vStrength: vStrength, raiseSize: canRaise ? bestRaise : null, raiseAllin: canRaise && bestRaise >= cap - 1e-9,
      inPos: S.inPosition, villains: vinfos.map((v, i) => ({ style: v.style, role: v.role, lastActionKind: live[i].lastActionKind })),
      best: best, userAction: userAction, rating: rating, E: E, cls: cls.key, tier: tier,
      made: madeDesc, draws: preflop ? [] : draws.draws, C: C,
      altAction: second.a, altCost: second.a ? r2(bestEV - second.v) : 0, diff: r2(diff),
    });
    // Main villain: the one who stayed in the longest drives the range wording.
    const mainV = vinfos.reduce((best, v) => (!best || v.streets > best.streets ? v : best), null);
    const mainLabel = mainV ? rangeLabel(mainV.strength, L) : rangeLabel(0.5, L);
    const mainWord = mainV && mainV.streets <= 4 ? (L === 'es' ? ES_NUM[mainV.streets] : EN_NUM[mainV.streets]) : String(mainV ? mainV.streets : 0);
    const mainLine = mainV && mainV.streets >= 2
      ? tr(L, 'm_range', { k: mainWord, verdict: tr(L, mainV.strength >= 0.5 ? 'v_strong' : 'v_wide') })
      : tr(L, 'm_villains', { n: nVill, p: pctStr(rangePct) });
    // One line about stack depth or covering, for the "more" notes.
    const stackLine = stackOff > 0 ? tr(L, 'm_cover')
      : S.heroStack <= 15 ? tr(L, 'm_short', { s: fmt(S.heroStack) })
        : S.heroStack >= 100 ? tr(L, 'm_deep', { s: fmt(S.heroStack) })
          : tr(L, 'm_spr', { spr: spr.toFixed(1), depth: tr(L, spr < 4 ? 'spr_low' : spr > 10 ? 'spr_high' : 'spr_mid') });
    // Notes: villains, stack depth, then the board and draw odds (or the chart and limp advice before the flop).
    const dChance = preflop || !draws || !(draws.flushDraw || draws.straightDraw) ? null : drawChance(heroInts, boardInts);
    const more = [mainLine, stackLine];
    if (preflop) {
      // Position and player count when the chart says limp, raise or fold.
      const preKey = C <= 0 && chart.action === 'call' ? 'pre_limp' : chart.action === 'raise' ? 'pre_raise' : chart.action === 'fold' ? 'pre_fold' : null;
      more.push(preKey ? tr(L, preKey, { n: S.numPlayers }) : tr(L, 'm_chart', { action: actionName(chart.action), text: chart.text }));
    } else {
      more.push(boardSentence(S, boardInts, heroInts, nVill, L));
      if (draws.draws.length) {
        const dt = tr(L, 'm_draws', { d: draws.draws.join(', ') });
        more.push(dChance ? dt + ' ' + tr(L, 'm_drawpct', { p: dChance.pct.toFixed(1) }) : dt);
      } else more.push(tr(L, 'm_nodraw'));
    }

    // Stats: eight rows, each with a stable key for the UI.
    const stats = [];
    stats.push({ key: 'hand', label: tr(L, 's_hand'), value: preflop ? cls.key + ' (' + tierName + ')' : hs.label, hint: heroHand.join(' ') });
    stats.push({ key: 'win_chance', label: tr(L, 's_equity'), value: pctStr(E), hint: tr(L, 'h_mc', { n: eqd.samples, v: nVill }) });
    stats.push({
      key: 'pot_odds', label: tr(L, 's_potodds'), value: C > 0 ? pctStr(req + stackOff) : tr(L, 'na'),
      hint: C > 0 ? tr(L, 'h_potodds2', { call: fmt(C), total: fmt(P + C), spr: spr.toFixed(1) }) : tr(L, 'h_spr', { eff: fmt(effStack) }),
    });
    stats.push({
      key: 'table', label: tr(L, 's_table'),
      value: tr(L, 'tbl_value', { players: nVill + 1, pot: fmt(P), call: fmt(C) }),
      hint: tr(L, 's_position') + ': ' + tr(L, S.inPosition ? 'val_in' : 'val_out') + ' · ' + posName(hero.position, L),
    });
    if (preflop) {
      stats.push({
        key: 'percentile', label: tr(L, 's_percentile'), value: tr(L, 'pct_top', { p: pctStr(pct), t: tier, name: tierName }),
        hint: tr(L, 'chart_hint', { action: actionName(chart.action), text: chart.text }),
      });
      stats.push({ key: 'chart', label: tr(L, 's_chart'), value: actionName(chart.action), hint: chart.text });
    } else {
      const listTxt = draws.draws.length ? draws.draws.join('; ') : tr(L, 'h_nodraw');
      stats.push({
        key: 'outs', label: tr(L, 's_outs'), value: boardInts.length === 5 ? tr(L, 'na_river') : String(draws.outs),
        hint: tr(L, 'h_outs', { draws: listTxt, hit: pctStr(draws.hit) }),
      });
      stats.push({ key: 'texture', label: tr(L, 's_texture'), value: texture.label, hint: boardInts.map(cardSym).join(' ') });
    }
    stats.push({
      key: 'villain', label: tr(L, 's_villain'),
      value: tr(L, 'rng_value', { label: mainLabel, p: pctStr(mainV ? mainV.pctOfHands : rangePct) }),
      hint: villainText,
    });
    stats.push({
      key: 'ev', label: tr(L, 's_ev'),
      value: '0 / ' + fmt(r2(callEV)) + ' / ' + (evRaiseShown == null ? tr(L, 'na') : fmt(r2(evRaiseShown))),
      hint: canRaise ? tr(L, 'h_raise', { amt: fmt(userAmount != null ? userAmount : bestRaise) }) : tr(L, 'h_noraise'),
    });

    const out = {
      best: best,
      bestRaiseAmount: bestRaiseShown,
      rating: rating,
      correct: rating === 'best' || rating === 'good',
      ev: { fold: 0, call: r2(callEV), raise: evRaiseShown == null ? null : r2(evRaiseShown) },
      score: score,
      summary: summary,
      explanation: explanation,
      handLabel: hs.label,
      positionNote: positionNote(hero.position, L),
      tip: tipFor(best, C, L),
      more: more.slice(0, 4),
      stats: stats,
      raiseSize: canRaise ? bestRaise : null,
      // True when a raise had more EV than the best of fold and call, but a gate (medium hand, or preflop without chart support) blocked it.
      raiseGated: canRaise && (!raiseOK || !raiseOK2) && bestRaiseEV > Math.max(0, callEV) + 1e-9,
      raiseAllin: canRaise && bestRaise >= cap - 1e-9,
      drawChance: dChance,
      // Review helpers (public/review.js): the hero's win share E (0..1), the action as graded, and the EV of
      // the graded action and of the best one (BB). Read-only additions, no effect on the scores above.
      winChance: E,
      userAction: userAction,
      evUser: userEV,
      evBest: bestEV,
      evBestRaise: canRaise ? bestRaiseEV : null,
    };
    // Objective chance vs random opponents: computed only when read (it can take a moment).
    let rwp = null;
    Object.defineProperty(out, 'winPctRandom', {
      enumerable: true,
      get: function () {
        if (rwp === null) rwp = randomWinPct(heroInts, boardInts, live.length);
        return rwp;
      },
    });
    return out;
  }

  // Stacks in big blinds. "varied" draws a spread: short, medium, deep and covering.
  function randomStack(rng) {
    const r = rng();
    const base = r < 0.1 ? 6 + rng() * 9 : r < 0.3 ? 15 + rng() * 25 : r < 0.8 ? 40 + rng() * 80 : 120 + rng() * 130;
    return r05(base);
  }
  function stackFor(o, rng) { return o.stacks === 'varied' ? randomStack(rng) : 100; }
  function commitTo(st, s, to) {
    to = r05(to); // money grain: every bet is a whole multiple of 0.5 BB
    const need = to - s.bet;
    if (need <= 1e-9) return 0;
    const pay = Math.min(need, s.stack);
    s.bet = r2(s.bet + pay);
    s.contributed = r2(s.contributed + pay);
    s.stack = r2(s.stack - pay);
    st.pot = r2(st.pot + pay);
    if (s.stack <= 1e-9) { s.stack = 0; s.allin = true; }
    return pay;
  }
  function allinTag(st, s) { return s.allin ? tr(st.lang, 'allin_tag') : ''; }
  function doFold(st, s) { s.folded = true; s.kind = 'fold'; s.last = tr(st.lang, 'act_fold'); }
  function doCheck(st, s, role) {
    s.kind = 'check';
    s.last = tr(st.lang, 'act_check');
    if (role) s.role = role;
  }
  function doCall(st, s, role) {
    const before = s.bet;
    commitTo(st, s, st.curMax);
    const paid = r2(s.bet - before);
    if (role) s.role = role;
    if (st.street === 'preflop' && st.raises === 0) {
      st.limpers++;
      s.kind = 'limp';
      s.last = tr(st.lang, 'act_limp') + allinTag(st, s);
    } else {
      s.kind = 'call';
      s.last = tr(st.lang, 'act_call', { amt: fmt(paid) }) + allinTag(st, s);
    }
  }
  function doRaise(st, s, to, role) {
    const prev = st.curMax;
    const potBefore = st.pot;
    commitTo(st, s, to);
    if (s.bet > prev + 1e-9) {
      if (st.street === 'preflop' && st.raises === 0) st.openerPos = s.pos;
      st.lastBetPot = potBefore;
      st.raises++;
      if (s.bet - prev >= (st.lastRaise || 1) - 1e-9) st.lastRaise = s.bet - prev;
      st.curMax = s.bet;
      st.lastAggressorHero = !!s.isHero;
      st.raisedNow = true;
      if (role) s.role = role;
      const isBet = prev <= 0;
      s.kind = isBet ? 'bet' : 'raise';
      s.last = tr(st.lang, isBet ? 'act_bet' : 'act_raise', { amt: fmt(s.bet) }) + allinTag(st, s);
    } else {
      doCall(st, s, role);
    }
  }
  function doFoldOrCheck(st, s, role) {
    if (st.curMax - s.bet <= 1e-9) doCheck(st, s, role);
    else doFold(st, s);
  }
  function preRoleFor(st) {
    return st.raises === 0 ? 'open' : st.raises === 1 ? '3bet' : '4bet';
  }
  function callRoleFor(st) {
    return st.raises === 0 ? 'limp' : st.raises === 1 ? 'call_open' : st.raises === 2 ? 'call_3bet' : 'call_4bet';
  }
  function openProb(s, N) {
    let base = OPEN_BASE[s.pos] || 0.2;
    if (N === 2 && s.pos === 'BTN') base = 0.6;
    return Math.min(0.9, base * (STYLE_MULT[s.style] || 1));
  }

  // Decision for one player, using the hidden hand strength (0..1) and kinds.
  function decide(st, s, strength, rng) {
    const toCall = st.curMax - s.bet;
    const m = STYLE_MULT[s.style] || 1;
    const r = rng();
    if (st.street === 'preflop') {
      if (st.raises === 0) {
        if (toCall <= 1e-9) {
          if (st.limpers > 0 && r < 0.18 * m * (0.3 + 1.4 * strength)) {
            return { kind: 'raise', to: r05((EARLY.includes(s.pos) ? 3 : 2.5) + st.limpers), role: 'open' };
          }
          return { kind: 'check', role: 'bb_check' };
        }
        const pOpen = openProb(s, st.N) * (0.3 + 1.4 * strength);
        const pLimp = (PLIMP_FREQ[s.style] || 0.1) * (0.6 + 0.8 * (1 - strength));
        if (r < pOpen) {
          const base = EARLY.includes(s.pos) ? 3 : 2.5;
          return { kind: 'raise', to: r05(base + st.limpers + (rng() < 0.3 ? 0.5 : 0)), role: 'open' };
        }
        if (r < pOpen + pLimp) return { kind: 'call', role: 'limp' };
        return { kind: 'fold' };
      }
      if (st.raises === 1) {
        const late = LATE.includes(s.pos) || s.pos === 'SB';
        const early = EARLY.includes(s.pos);
        const p3 = (P3_FREQ[s.style] || 0.05) * (late ? 1.3 : early ? 0.7 : 1) * (0.2 + 1.6 * strength * strength);
        const pc = (PCALL_FREQ[s.style] || 0.2) * (late ? 1.2 : early ? 0.8 : 1) * (0.6 + 0.8 * strength);
        if (r < p3) return { kind: 'raise', to: r05(st.curMax * (2.8 + rng() * 0.8)), role: '3bet' };
        if (r < p3 + pc) return { kind: 'call', role: 'call_open' };
        return { kind: 'fold' };
      }
      if (st.raises === 2) {
        const p4 = (P4_FREQ[s.style] || 0.03) * (0.2 + 2 * strength * strength);
        if (r < p4) return { kind: 'raise', to: r05(st.curMax * (2.2 + rng() * 0.6)), role: '4bet' };
        if (r < p4 + 0.3 * (0.5 + strength)) return { kind: 'call', role: 'call_3bet' };
        return { kind: 'fold' };
      }
      if (r < 0.02 + 0.1 * strength) return { kind: 'raise', to: r05(st.curMax * 2.2), role: '5bet' };
      if (r < 0.3 + 0.3 * strength) return { kind: 'call', role: 'call_4bet' };
      return { kind: 'fold' };
    }
    // post-flop
    if (toCall <= 1e-9) {
      const bluffy = BLUFF[s.style] || 0.3;
      const pBet = (BET_FREQ[s.style] || 0.4) * (0.25 + 1.5 * strength) + (s.role === 'open' || s.role === '3bet' || s.role === '4bet' ? 0.08 : 0) + (strength < 0.3 ? bluffy * 0.2 : 0);
      if (r < pBet) {
        const sizes = BET_SIZES[s.style] || [0.5];
        const frac = pick(sizes, rng);
        return { kind: 'raise', to: r05(st.pot * frac), role: null };
      }
      return { kind: 'check' };
    }
    const pRaise = (RAISE_FREQ[s.style] || 0.05) * (0.3 + 1.4 * strength);
    const pCall = (CALL_FREQ[s.style] || 0.45) * (0.3 + 1.2 * strength);
    if (r < pRaise) return { kind: 'raise', to: r05(st.curMax * (2.2 + rng())), role: null };
    if (r < pRaise + Math.min(0.95, pCall)) return { kind: 'call' };
    return { kind: 'fold' };
  }

  function applyAction(st, s, d) {
    switch (d.kind) {
      case 'fold': return doFold(st, s);
      case 'check': return doCheck(st, s, d.role);
      case 'call': return doCall(st, s, d.role);
      case 'raise': {
        const role = st.street === 'preflop' ? (d.role || preRoleFor(st)) : null;
        const amt = d.to;
        if (amt <= st.curMax + 1e-9) return doFoldOrCheck(st, s, d.role);
        return doRaise(st, s, amt, role);
      }
      default: return doFoldOrCheck(st, s, null);
    }
  }

  function sizeKey(frac) {
    if (frac <= 0.4) return 'sz_third';
    if (frac <= 0.55) return 'sz_half';
    if (frac <= 0.8) return 'sz_twothirds';
    if (frac <= 1.1) return 'sz_pot';
    return 'sz_over';
  }
  function buildSituation(snap, hero, live, N, L) {
    const you = tr(L, 'you_are', { pos: posName(hero.pos, L) });
    const hand = N === 2 ? tr(L, 'hand_hu') : tr(L, 'hand_count', { n: N });
    const sname = snap.street === 'preflop' ? '' : tr(L, 'street_' + snap.street);
    if (snap.street === 'preflop') {
      let s;
      if (snap.raises === 0) {
        if (snap.limpers > 0) s = tr(L, 'sit_limped', { n: snap.limpers, word: snap.limpers === 1 ? (L === 'es' ? 'limpeo' : 'limper') : (L === 'es' ? 'limpeos' : 'limpers'), you: you });
        else if (hero.pos === 'BB' && snap.curMax <= 1) s = tr(L, 'sit_option');
        else s = tr(L, 'sit_unopened', { you: you });
      } else if (snap.raises === 1) {
        s = tr(L, 'sit_facing_open', { opener: posName(snap.openerPos || hero.pos, L), you: you });
      } else if (snap.raises === 2) {
        s = tr(L, snap.openerPos === hero.pos ? 'sit_facing_3bet_own' : 'sit_facing_3bet', { you: you });
      } else {
        s = tr(L, 'sit_facing_4bet', { you: you });
      }
      return s + ', ' + hand;
    }
    let s;
    if (snap.curMax <= 0) {
      const allFirst = live.filter((x) => !x.isHero).every((x) => x.kind === 'pending');
      s = tr(L, allFirst ? 'sit_first' : 'sit_checked', { street: sname });
    } else if (snap.lastAggressorHero) {
      s = tr(L, 'sit_raise_own', { street: sname });
    } else {
      const frac = snap.curMax / Math.max(0.01, snap.lastBetPot);
      s = tr(L, 'sit_facing_bet', { size: tr(L, sizeKey(frac)), street: sname });
    }
    return s + tr(L, live.length > 2 ? 'sit_multiway' : 'sit_headsup_pot');
  }
  // The raise size the Raise button applies. Same rule and inputs as standardRaiseTo in public/game.js:
  // L = {canRaise, curBet, toCall, minRaiseTo, maxRaiseTo} in BB, potChips in BB, bb = 1 in BB units.
  function standardRaiseTo(L, potChips, preflop, bb) {
    if (!L.canRaise) return null;
    bb = bb || 1;
    const target = preflop
      ? (L.curBet > 0 ? L.curBet * 3 : 2.5 * bb)
      : L.curBet + (2 / 3) * (potChips + L.toCall);
    const step = bb / 2;
    return Math.max(L.minRaiseTo, Math.min(Math.round(target / step) * step, L.maxRaiseTo));
  }
  // The legal raise range for a seat (the fields game.js legalFor returns), from the table state.
  function legalRaise(curMax, heroBet, heroStack, lastRaise) {
    const toCall = Math.max(0, curMax - heroBet);
    const maxTo = heroBet + heroStack;
    return {
      canRaise: heroStack > toCall && maxTo > curMax,
      curBet: curMax, toCall: toCall,
      minRaiseTo: Math.min(curMax + (lastRaise || 1), maxTo), maxRaiseTo: maxTo,
    };
  }
  // The scenario's raise option: the one size the button applies (an all-in when it reaches the stack).
  function buildRaiseOptions(snap, hero, L) {
    const lg = legalRaise(snap.curMax, hero.bet, hero.stack, snap.lastRaise);
    const std = standardRaiseTo(lg, snap.pot, snap.street === 'preflop', 1);
    if (std == null) return [];
    const allin = std >= lg.maxRaiseTo - 1e-9;
    return [{ amount: std, label: tr(L, allin ? 'opt_allin' : 'opt_std', { amt: fmt(std) }), allin: allin }];
  }

  // opts: { players?, position?, street?, seed?, lang? ('en'|'es') }
  function generateScenario(opts) {
    const o = opts || {};
    const lang = langOf(o.lang);
    const rng = makeRng(o.seed);
    let N = null;
    if (o.players != null) N = clamp(Math.round(o.players), 2, 9);
    if (o.position != null) {
      const cands = [];
      for (let n = 2; n <= 9; n++) if (TABLE_POS[n].indexOf(o.position) >= 0 && (N == null || N === n)) cands.push(n);
      if (!cands.length) throw new Error('Position ' + o.position + ' is not valid for ' + (N == null ? 'any' : N) + '-handed');
      if (N == null) N = pick(cands, rng);
    }
    // The street is drawn once; retries only re-simulate the hand until the hero decides on that street.
    const target = o.street && o.street !== 'any' ? o.street : pickStreet(rng);
    for (let attempt = 0; attempt < 2000; attempt++) {
      const s = buildAttempt(o, rng, lang, N == null ? 2 + Math.floor(rng() * 8) : N, target);
      if (s) { s.id = 'h' + Math.floor(rng() * 1e9).toString(36) + attempt; return s; }
    }
    throw new Error('Could not generate a scenario with the given options');
  }
  // Target street for a random scenario: uniform over the four streets.
  function pickStreet(rng) {
    return ['preflop', 'flop', 'turn', 'river'][Math.floor(rng() * 4)];
  }

  function buildAttempt(o, rng, lang, N, target) {
    const table = TABLE_POS[N];
    const btnIdx = table.indexOf('BTN');
    const buttonSeat = Math.floor(rng() * N);
    // Hero seat: random, or the seat that holds the requested position.
    let heroSeat = Math.floor(rng() * N);
    if (o.position != null) {
      const k = table.indexOf(o.position);
      if (k < 0) return null;
      heroSeat = (((buttonSeat - btnIdx + k) % N) + N) % N;
    }
    const deck = [];
    for (let c = 0; c < 52; c++) deck.push(c);
    shuffle(deck, rng);
    const seats = [];
    for (let i = 0; i < N; i++) {
      const pos = table[(((i - buttonSeat + btnIdx) % N) + N) % N];
      const isHero = i === heroSeat;
      seats.push({
        seat: i, position: pos, pos: pos, isHero: isHero,
        name: isHero ? tr(lang, 'name_hero') : tr(lang, 'name_seat', { n: i + 1 }),
        style: isHero ? 'balanced' : pick(STYLES, rng), stack: stackFor(o, rng),
        bet: 0, contributed: 0, folded: false, allin: false, last: tr(lang, 'pending'), kind: 'pending', role: null,
        combo: 0,
      });
    }
    for (const s of seats) {
      const a = deck.pop(), b = deck.pop();
      s.combo = comboIndex(Math.min(a, b), Math.max(a, b));
      s.cards = [a, b];
    }
    const boardAll = [deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop()];
    const byPos = {};
    seats.forEach((s) => { byPos[s.pos] = s; });
    const sbSeat = N === 2 ? byPos.BTN : byPos.SB;
    const bbSeat = byPos.BB;
    // Blinds.
    const st0 = { street: 'preflop', pot: 0, log: [] };
    commitTo(st0, sbSeat, 0.5);
    commitTo(st0, bbSeat, 1);
    const orderPre = table.map((p) => byPos[p]);
    const postPos = (N > 2 ? ['SB'] : []).concat(['BB'], table.filter((p) => p !== 'SB' && p !== 'BB' && p !== 'BTN'), ['BTN']);
    const orderPost = postPos.map((p) => byPos[p]);

    const sim = simulateHandFrom(seats, orderPre, orderPost, boardAll, rng, N, st0.pot, lang);
    if (!sim.snaps.length) return null;
    // The hero's decisions on the target street; if the hand never reaches it, the caller retries.
    const pool = sim.snaps.filter((x) => x.street === target);
    if (!pool.length) return null;
    const snap = pool[Math.floor(rng() * pool.length)];
    return buildScenario(snap, N, boardAll, deck, rng, lang);
  }

  function simulateHandFrom(seats, orderPre, orderPost, boardAll, rng, N, potStart, lang) {
    const st = {
      N: N, seats: seats, pot: potStart, log: [], street: 'preflop', curMax: 1, lastRaise: 1, raises: 0, limpers: 0,
      lastBetPot: 0, openerPos: null, lastAggressorHero: false, raisedNow: false, lang: lang, history: [],
    };
    return runSim(st, seats, orderPre, orderPost, boardAll, rng, N);
  }

  function runSim(st, seats, orderPre, orderPost, boardAll, rng, N) {
    const streets = ['preflop', 'flop', 'turn', 'river'];
    const snaps = [];
    const kindsMap = new Map();
    let si = 0;
    for (;;) {
      const street = streets[si];
      st.street = street;
      if (street !== 'preflop') {
        const n = street === 'flop' ? 3 : street === 'turn' ? 4 : 5;
        kindsMap.set(street, boardKinds(boardAll.slice(0, n)));
        st.log.push('--- ' + street.charAt(0).toUpperCase() + street.slice(1) + ': ' + boardAll.slice(0, n).map(cardStr).join(' ') + ' ---');
      } else {
        kindsMap.set('preflop', null);
      }
      const order = street === 'preflop' ? orderPre : orderPost;
      const needs = new Set(order.filter((s) => !s.folded && !s.allin));
      let guard = 0;
      while (needs.size && guard++ < 60) {
        for (const s of order) {
          if (!needs.has(s)) continue;
          needs.delete(s);
          if (s.folded || s.allin) continue;
          if (seats.filter((x) => !x.folded).length <= 1) return { snaps, st };
          const strength = street === 'preflop'
            ? 1 - COMBO_PCT[s.combo]
            : [0.1, 0.3, 0.4, 0.75, 0.95][kindsMap.get(street)[s.combo]];
          const d = decide(st, s, strength, rng);
          if (s.isHero) {
            snaps.push({
              street: street,
              seats: seats.map((x) => ({ ...x })),
              pot: st.pot, curMax: st.curMax, lastRaise: st.lastRaise, raises: st.raises, limpers: st.limpers,
              lastBetPot: st.lastBetPot, openerPos: st.openerPos,
              lastAggressorHero: st.lastAggressorHero, log: st.log.slice(), history: st.history.slice(),
            });
          }
          st.raisedNow = false;
          const potBefore = st.pot, prevBet = s.bet;
          applyAction(st, s, d);
          st.history.push({ street: street, seat: s.seat, action: s.kind,
            amount: r2(s.kind === 'call' || s.kind === 'limp' ? s.bet - prevBet : s.bet),
            potBefore: r2(potBefore),
            betFraction: (s.kind === 'bet' || s.kind === 'raise') ? r2(s.bet / Math.max(0.01, potBefore)) : null });
          if (st.raisedNow) for (const o of order) if (o !== s && !o.folded && !o.allin) needs.add(o);
        }
      }
      if (si === 3) break;
      if (seats.filter((x) => !x.folded).length <= 1) break;
      si++;
      for (const s of seats) {
        s.bet = 0;
        // the previous street's action is cleared, all-in seats included (they have no action on the new street)
        if (!s.folded) { s.last = tr(st.lang, 'pending'); s.kind = 'pending'; }
      }
      st.curMax = 0; st.lastRaise = 1; st.raises = 0; st.lastBetPot = 0; st.lastAggressorHero = false;
    }
    return { snaps, st };
  }

  function buildScenario(snap, N, boardAll, deck, rng, L) {
    const seats = snap.seats;
    const hero = seats.find((s) => s.isHero);
    const live = seats.filter((s) => !s.folded);
    const street = snap.street;
    const nBoard = street === 'preflop' ? 0 : street === 'flop' ? 3 : street === 'turn' ? 4 : 5;
    const board = boardAll.slice(0, nBoard);
    // Position: hero acts after every live villain post-flop.
    const postOrder = (N > 2 ? ['SB'] : []).concat(['BB'], TABLE_POS[N].filter((x) => x !== 'SB' && x !== 'BB' && x !== 'BTN'), ['BTN']);
    const postRank = (s) => postOrder.indexOf(s.pos);
    const inPosition = live.every((s) => s.isHero || postRank(s) < postRank(hero));
    const toCall = Math.max(0, Math.min(r2(snap.curMax - hero.bet), r2(hero.stack)));
    const heroStateForOptions = { bet: hero.bet, stack: hero.stack, pos: hero.pos };
    const situationState = {
      street: street, curMax: snap.curMax, lastRaise: snap.lastRaise, pot: snap.pot, raises: snap.raises, limpers: snap.limpers,
      lastBetPot: snap.lastBetPot, openerPos: snap.openerPos, lastAggressorHero: snap.lastAggressorHero,
    };
    return {
      id: '',
      lang: L,
      numPlayers: N,
      street: street,
      hero: hero.cards.map(cardStr),
      board: board.map(cardStr),
      blinds: { sb: 0.5, bb: 1 },
      pot: r2(snap.pot),
      toCall: toCall,
      heroStack: r2(hero.stack),
      heroPosition: hero.pos,
      heroSeat: hero.seat,
      buttonSeat: (seats.find((s) => s.pos === 'BTN') || { seat: 0 }).seat,
      inPosition: inPosition,
      seats: seats.map((s) => ({
        seat: s.seat, position: s.pos, name: s.name, stack: r2(s.stack), bet: r2(s.bet),
        contributed: r2(s.contributed), folded: s.folded, isHero: s.isHero, style: s.style,
        lastAction: s.last, lastActionKind: s.kind, preflopRole: s.role || null,
      })),
      actionLog: [],
      heroCovered: live.some((s) => !s.isHero && (s.stack + s.contributed) > (hero.stack + hero.contributed) + 1e-9),
      history: snap.history || [],
      lastRaise: snap.lastRaise || 1,
      raiseOptions: buildRaiseOptions(situationState, heroStateForOptions, L),
      situation: buildSituation(situationState, hero, live, N, L),
    };
  }
  function buttonSeatOf(seats) {
    const b = seats.find((s) => s.pos === 'BTN');
    return b ? b.seat : 0;
  }

  return {
    generateScenario: generateScenario,
    evaluate: evaluate,
    evaluateHand: evaluateHand,
    equity: equity,
    parseCard: parseCard,
    cardStr: cardStr,
    handClass: function (a, b) { return comboClass(parseCard(a), parseCard(b)).key; },
    preflopPercentile: function (a, b) { return COMBO_PCT[comboIndex(Math.min(parseCard(a), parseCard(b)), Math.max(parseCard(a), parseCard(b)))]; },
    tierOf: tierOf,
    boardTexture: function (board) { return boardTexture(parseCards(board)); },
    outs: function (hero, board) { const h = parseCards(hero), b = parseCards(board); return drawInfo(h, b, b.length === 3 ? 'flop' : 'turn').outs; },
    parseRange: parseRangeSpec,
    getRangeChart: getRangeChart,
    i18n: I18N,
    rangeSummary: rangeSummary,
    describeRange: describeRange,
    listChartSpots: listChartSpots,
    POSITIONS: TABLE_POS,
    STYLES: STYLES,
    personalities: ['tight', 'loose', 'aggressive', 'passive', 'balanced'],
    randomWinPct: randomWinPct,
    standardRaiseTo: standardRaiseTo,
    drawChance: function (hero, board) { return drawChance(parseCards(hero), parseCards(board)); },
  };
  })();

if (typeof module !== 'undefined' && module.exports) module.exports = PokerEngine;
if (typeof window !== 'undefined') window.PokerEngine = PokerEngine;
