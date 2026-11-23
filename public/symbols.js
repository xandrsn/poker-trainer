/* Icon set for the seat plates: small inline SVGs that replace the words for play styles and last actions.
 * Every icon is a 24x24 stroke drawing in currentColor (colour comes from CSS: see seats.css).
 *
 * window.Symbols
 *   svg(name)            -> SVG markup string for one icon (aria-hidden; the caller adds the label)
 *   styleIcon(style)     -> icon name for a play style: tight, loose, aggressive, passive, balanced
 *   actionIcon(raw)      -> { key, icon } for a raw last-action text ('check', 'raise to 50', 'all-in', ...)
 */
(function (root) {
  'use strict';

  var P = {
    shield: '<path d="M12 3l7 3v5.5c0 4.5-3 8-7 9.5-4-1.5-7-5-7-9.5V6z"/>',
    dice: '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><circle cx="8.5" cy="8.5" r="1.1" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.1" fill="currentColor"/><circle cx="12" cy="12" r="1.1" fill="currentColor"/>',
    flame: '<path d="M12 3c1 3.2 4.5 5.2 4.5 9.5a4.5 4.5 0 0 1-9 0c0-2 .9-3.4 2-4.5.1 1.7.7 2.8 1.7 3.4C11 8.5 11.3 5.8 12 3z"/>',
    pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
    scales: '<path d="M12 4v16M7 20h10M4 7h16"/><path d="M4 7l-2.5 6h5z"/><path d="M20 7l-2.5 6h5z"/>',
    tick: '<path d="M5 12.5l4.5 4.5L19 7"/>',
    equals: '<path d="M5 9h14M5 15h14"/>',
    up: '<path d="M12 20V5M6 11l6-6 6 6"/>',
    chip: '<circle cx="12" cy="12" r="8.5" stroke-dasharray="3 2.3"/><circle cx="12" cy="12" r="4"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    bolt: '<path d="M13.5 2.5L5 13.5h6l-1.5 8 9-11.5h-6z" fill="currentColor"/>',
    out: '<circle cx="12" cy="12" r="8.5"/><path d="M6 18L18 6"/>'
  };

  var STYLE_ICON = { tight: 'shield', loose: 'dice', aggressive: 'flame', passive: 'pause', balanced: 'scales' };

  // ordered: the first matching rule wins (all-in beats the verb: 'bet 20 all-in' is an all-in)
  var ACTION_RULES = [
    [/all-?in/i, 'allin', 'bolt'],
    [/^fold/i, 'fold', 'x'],
    [/^check/i, 'check', 'tick'],
    [/^call/i, 'call', 'equals'],
    [/^limp/i, 'limp', 'equals'],
    [/^bet/i, 'bet', 'chip'],
    [/^raise/i, 'raise', 'up'],
    [/^busted/i, 'out', 'out']
  ];

  function svg(name) {
    var body = P[name] || P.out;
    return '<svg class="sym sym-' + name + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>';
  }
  function styleIcon(style) {
    return STYLE_ICON[style] || 'scales';
  }
  function actionIcon(raw) {
    var s = String(raw || '');
    for (var i = 0; i < ACTION_RULES.length; i++) {
      if (ACTION_RULES[i][0].test(s)) return { key: ACTION_RULES[i][1], icon: ACTION_RULES[i][2] };
    }
    return { key: 'other', icon: 'equals' };
  }

  root.Symbols = { svg: svg, styleIcon: styleIcon, actionIcon: actionIcon };
})(window);
