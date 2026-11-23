/* Poker Trainer review icons: round filled badges with a white glyph and a soft drop shadow, in the
 * style of the chess.com Game Review classification icons (colours and glyphs follow that style).
 * Browser: window.PokerReviewIcons. Node: module.exports. Used by review-ui.js.
 *   svgString(key, size)  -> markup string (one <svg>, aria-hidden, data-rating)
 *   element(key, size)    -> SVG element (same markup, parsed)
 * Keys: brilliant great best excellent good book inaccuracy mistake miss blunder forced none bad_luck lucky
 * Drawn on a 32 x 32 grid: circle r 14.4 centred, shadow circle offset 1.4 down, white glyph on top. */
(function () {
  'use strict';

  var WHITE = '#ffffff';
  var COLOR = {
    brilliant: '#26c2a3',
    great: '#749bbf',
    best: '#81b64c',
    excellent: '#81b64c',
    good: '#95b776',
    book: '#a88865',
    inaccuracy: '#f7c631',
    mistake: '#e58f2a',
    miss: '#ff7769',
    blunder: '#ca3431',
    forced: '#9b9b9b',
    none: '#6f7480',
    bad_luck: '#7f93a8',
    lucky: '#81b64c'
  };
  var KEYS = Object.keys(COLOR);

  function f(n) { return String(Math.round(n * 100) / 100); }

  // "!" centred on x; y0..y1 is the stroke, dot at yd
  function bang(x, y0, y1, yd, sw, dr) {
    return '<path d="M' + f(x) + ' ' + f(y0) + 'V' + f(y1) + '" fill="none" stroke="' + WHITE + '" stroke-linecap="round" stroke-width="' + f(sw) + '"/>' +
      '<circle cx="' + f(x) + '" cy="' + f(yd) + '" r="' + f(dr) + '" fill="' + WHITE + '"/>';
  }
  // "?" drawn in a 16 x 16 box whose top-left is (x, y), scaled by s
  function question(x, y, s, sw) {
    return '<g transform="translate(' + f(x) + ' ' + f(y) + ') scale(' + f(s) + ')">' +
      '<path d="M3.2 5.4C3.2 2.4 5 .8 8 .8C11 .8 12.8 2.4 12.8 5.1C12.8 8.4 8.1 8.9 8.1 12.2V13.2" fill="none" stroke="' + WHITE + '" stroke-width="' + f(sw / s) + '" stroke-linecap="round"/>' +
      '<circle cx="8.1" cy="16.6" r="1.9" fill="' + WHITE + '"/></g>';
  }
  function star(cx, cy, R, r) {
    var pts = [];
    for (var i = 0; i < 10; i++) {
      var rad = i % 2 === 0 ? R : r;
      var a = -Math.PI / 2 + i * Math.PI / 5;
      pts.push(f(cx + rad * Math.cos(a)) + ',' + f(cy + rad * Math.sin(a)));
    }
    return pts.join(' ');
  }
  function eyes(y, dy) {
    return '<circle cx="12.4" cy="' + f(y) + '" r="1.7" fill="' + WHITE + '"/><circle cx="19.6" cy="' + f(y) + '" r="1.7" fill="' + WHITE + '"/>' + (dy || '');
  }

  // glyph markup (white) for one rating, centred on the 32 grid
  function glyph(key) {
    var sw = 3.4;
    switch (key) {
      case 'brilliant':
        return bang(12.6, 8.2, 17.6, 22.4, 3.2, 2) + bang(19.6, 8.2, 17.6, 22.4, 3.2, 2);
      case 'great':
        return bang(16, 7.2, 19.2, 24.2, 3.6, 2.3);
      case 'best':
        return '<polygon points="' + star(16, 16.6, 9.4, 4.1) + '" fill="' + WHITE + '"/>';
      case 'excellent':
        // thumbs up: cuff, then the hand with the raised thumb
        return '<rect x="7.4" y="14.6" width="4.4" height="10" rx="1.2" fill="' + WHITE + '"/>' +
          '<path d="M13.6 15.2L16.6 9.2C17.5 7.4 20.2 7.9 20.2 10.3L19.8 14.2H23.6C25.2 14.2 26.2 15.7 25.6 17.2L23.2 22.8C22.8 23.8 21.9 24.4 20.8 24.4H13.6Z" fill="' + WHITE + '"/>';
      case 'good':
        return '<path d="M9.4 16.8L14.2 21.4L22.8 11.6" fill="none" stroke="' + WHITE + '" stroke-width="' + sw + '" stroke-linecap="round" stroke-linejoin="round"/>';
      case 'book':
        // open book: two pages meeting at the spine
        return '<path d="M16 11.2C13.7 9.5 10.8 9.2 7.6 9.9V22.4C10.8 21.7 13.7 22 16 23.7Z" fill="' + WHITE + '"/>' +
          '<path d="M16 11.2C18.3 9.5 21.2 9.2 24.4 9.9V22.4C21.2 21.7 18.3 22 16 23.7Z" fill="' + WHITE + '"/>';
      case 'inaccuracy':
        return question(7.2, 8.2, 0.82, 3) + bang(22.6, 9.6, 16.4, 21.6, 3, 1.8);
      case 'mistake':
        return question(9.4, 7.4, 1.05, 3.2);
      case 'miss':
        return '<path d="M11.2 11.2L20.8 20.8M20.8 11.2L11.2 20.8" fill="none" stroke="' + WHITE + '" stroke-width="' + sw + '" stroke-linecap="round"/>';
      case 'blunder':
        return question(4.6, 8.4, 0.74, 3) + question(16.2, 8.4, 0.74, 3);
      case 'forced':
        return '<path d="M10 16H22" fill="none" stroke="' + WHITE + '" stroke-width="' + sw + '" stroke-linecap="round"/>';
      case 'none':
        return '<circle cx="16" cy="16" r="6" fill="none" stroke="' + WHITE + '" stroke-width="2.6"/>';
      case 'bad_luck':
        return eyes(13.4) + '<path d="M11 22.2Q16 17.6 21 22.2" fill="none" stroke="' + WHITE + '" stroke-width="2.6" stroke-linecap="round"/>';
      case 'lucky':
        return eyes(13.4) + '<path d="M11 19.6Q16 24.4 21 19.6" fill="none" stroke="' + WHITE + '" stroke-width="2.6" stroke-linecap="round"/>';
    }
    return '';
  }

  // full badge: drop shadow, coloured disc, white glyph
  function body(key) {
    return '<circle cx="16" cy="17.4" r="14.4" fill="#000" fill-opacity="0.32"/>' +
      '<circle cx="16" cy="16" r="14.4" fill="' + COLOR[key] + '"/>' +
      glyph(key);
  }

  function svgString(key, size) {
    var k = COLOR[key] ? key : 'none';
    var px = size || 16;
    return '<svg class="rv-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="' + px + '" height="' + px +
      '" aria-hidden="true" focusable="false" data-rating="' + k + '">' + body(k) + '</svg>';
  }

  function element(key, size) {
    var wrap = document.createElement('span');
    wrap.innerHTML = svgString(key, size);
    return wrap.firstChild;
  }

  var api = { KEYS: KEYS, COLORS: COLOR, svgString: svgString, element: element };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PokerReviewIcons = api;
})();
