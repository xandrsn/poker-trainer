/* Poker Trainer: user colour theme (background, table felt, table border, seat highlight).
 * window.PokerTheme = { get(), set(partial), apply(), onChange(fn), reset(), render(), presets }.
 * Colours are hex strings (#rrggbb). The table border may also be 'none' (the rim then follows the felt).
 * apply() sets CSS variables on :root: --bg-user, --felt-user, --rail-user, --hl-user (+ -rgb triplets,
 * shades --felt-user-2/-3, --rail-user-2, and text tones --text-user, --on-felt-user).
 * Persisted in localStorage with try/catch. Pure helpers are exported for node tests. */
(function () {
  'use strict';

  var STORE_KEY = 'poker-trainer:theme:v2';
  var LEGACY_KEY = 'poker-trainer:theme:v1';
  var GROUPS = ['bg', 'felt', 'rail', 'highlight'];
  var DEFAULTS = { bg: '#000000', felt: '#0f3d27', rail: '#3a2618', highlight: '#ffffff' };
  // the v1 defaults: a stored v1 value equal to one of these was never customised and is replaced by the new default
  var OLD_DEFAULTS = { bg: '#0b0f14', felt: '#14573a', rail: '#2b2f35', highlight: '#ffffff' };
  // Ink for text on a light page: near-black. The fallback is used only when #14110d misses 4.5:1 (mid greys),
  // so that the chosen ink always reaches 4.5:1 on every background (the two fallbacks sit at the crossover).
  var DARK_TEXT = '#14110d';
  var DARK_TEXT_FB = '#050403';
  var LIGHT_TEXT = '#e8eef5';
  var LIGHT_TEXT_FB = '#ffffff';
  var SURFACE_LIGHT = '#fbf8f1';
  var SURFACE_LIGHT_2 = '#efe9dc';
  var PRESETS = {
    bg: [
      { id: 'black', hex: '#000000' },
      { id: 'night', hex: '#0b0f14' },
      { id: 'charcoal', hex: '#1c1f24' },
      { id: 'navy', hex: '#0d1830' },
      { id: 'plum', hex: '#1d1426' },
      { id: 'paper', hex: '#ece6d6' }
    ],
    felt: [
      { id: 'darkgreen', hex: '#0f3d27' },
      { id: 'green', hex: '#14573a' },
      { id: 'blue', hex: '#1d4f8a' },
      { id: 'red', hex: '#7a1f2b' },
      { id: 'black', hex: '#1f2327' },
      { id: 'purple', hex: '#4b2a6e' }
    ],
    rail: [
      { id: 'brown', hex: '#3a2618' },
      { id: 'green', hex: '#0c3a27' },
      { id: 'wood', hex: '#6b4423' },
      { id: 'black', hex: '#111417' },
      { id: 'gold', hex: '#b08d3c' },
      { id: 'silver', hex: '#9aa3ad' },
      { id: 'none', hex: 'none' }
    ],
    highlight: [
      { id: 'white', hex: '#ffffff' },
      { id: 'gold', hex: '#e0b455' },
      { id: 'raise', hex: '#3fbf7f' },
      { id: 'call', hex: '#4aa3df' },
      { id: 'fold', hex: '#d5584f' }
    ]
  };

  /* ---------- pure helpers (no DOM) ---------- */

  // Returns '#rrggbb' (lowercase) or null. Accepts #rgb, rrggbb and #rrggbb.
  function normalizeHex(v) {
    if (typeof v !== 'string') return null;
    var s = v.trim().toLowerCase();
    if (s.charAt(0) !== '#') s = '#' + s;
    if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2) + s.charAt(3) + s.charAt(3);
    return /^#[0-9a-f]{6}$/.test(s) ? s : null;
  }
  function isHex(v) { return normalizeHex(v) !== null; }

  function hexToRgb(hex) {
    var h = normalizeHex(hex);
    if (!h) return null;
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }
  function rgbToHex(r, g, b) {
    function c(n) {
      var x = Math.round(Math.max(0, Math.min(255, n))).toString(16);
      return x.length < 2 ? '0' + x : x;
    }
    return '#' + c(r) + c(g) + c(b);
  }
  function triplet(hex) {
    var rgb = hexToRgb(hex);
    return rgb ? rgb.join(' ') : null;
  }

  // WCAG relative luminance (0 black .. 1 white).
  function luminance(hex) {
    var rgb = hexToRgb(hex);
    if (!rgb) return null;
    var lin = rgb.map(function (c) {
      var s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  }
  function contrastRatio(a, b) {
    var la = luminance(a);
    var lb = luminance(b);
    if (la === null || lb === null) return null;
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  // Ink with the higher contrast against the given background. Each side uses its preferred ink when that
  // reaches 4.5:1, else the pure-ish fallback (which keeps the worst case at ~4.5:1 near luminance 0.18).
  // No hysteresis: the choice is a pure function of the colour, so it cannot flicker while a picker is dragged.
  function textOn(hex) {
    var dk = contrastRatio(hex, DARK_TEXT) >= 4.5 ? DARK_TEXT : DARK_TEXT_FB;
    var lt = contrastRatio(hex, LIGHT_TEXT) >= 4.5 ? LIGHT_TEXT : LIGHT_TEXT_FB;
    var dark = contrastRatio(hex, dk);
    var light = contrastRatio(hex, lt);
    if (dark === null || light === null) return LIGHT_TEXT;
    return dark >= light ? dk : lt;
  }
  // Worst-case contrast of fg over every background in bgs.
  function minContrast(fg, bgs) {
    var m = Infinity;
    bgs.forEach(function (b) { var c = contrastRatio(fg, b); if (c !== null && c < m) m = c; });
    return m === Infinity ? 0 : m;
  }
  // First candidate (listed lighter to darker) that reaches min on every background; else the best of them and the ink.
  function pickOn(bgs, cands, min, ink) {
    for (var i = 0; i < cands.length; i++) if (minContrast(cands[i], bgs) >= min) return cands[i];
    var best = ink, score = minContrast(ink, bgs);
    cands.forEach(function (c) { var s2 = minContrast(c, bgs); if (s2 > score) { best = c; score = s2; } });
    return best;
  }
  // 'light' when dark text is the readable choice on this colour, otherwise 'dark'.
  // (the fallback ink is also dark: mid greys take it, so both count as a light page)
  function tone(hex) {
    var ink = textOn(hex);
    return ink === DARK_TEXT || ink === DARK_TEXT_FB ? 'light' : 'dark';
  }
  // t in [0,1]: mixes hex towards target.
  function mix(hex, target, t) {
    var a = hexToRgb(hex);
    var b = hexToRgb(target);
    if (!a || !b) return null;
    return rgbToHex(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
  }
  // amount in [-1, 1]: negative darkens towards black, positive lightens towards white.
  function shade(hex, amount) {
    var t = Math.max(-1, Math.min(1, amount));
    return t < 0 ? mix(hex, '#000000', -t) : mix(hex, '#ffffff', t);
  }

  // Keeps only valid fields. rail may be 'none'.
  function sanitize(partial) {
    var out = {};
    var src = partial && typeof partial === 'object' ? partial : {};
    GROUPS.forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) return;
      if (k === 'rail' && src[k] === 'none') { out.rail = 'none'; return; }
      var h = normalizeHex(src[k]);
      if (h) out[k] = h;
    });
    return out;
  }

  function merge(base, extra) {
    var out = {};
    GROUPS.forEach(function (k) { out[k] = base[k]; });
    Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
    return out;
  }

  // Light page (dark ink): surfaces, lines, muted and accent text tokens switch to dark-on-light variants.
  // Every value is chosen against the page background (and the light surface), so the contrast holds for any colour.
  function lightPageVars(bg, ink) {
    var surf = SURFACE_LIGHT;
    var bgs = [bg, surf, SURFACE_LIGHT_2];
    var muted = pickOn(bgs, ['#4d4638', '#38322a', '#221e17'], 4.5, ink);
    var line = pickOn([bg, surf, SURFACE_LIGHT_2], ['#8c8473', '#6f6858', '#5c5546'], 3, ink);
    var gold = pickOn(bgs, ['#8a6a12', '#6e5410', '#4f3c08'], 4.5, ink);
    var out = {
      '--bg': bg, '--bg-rgb': triplet(bg),
      '--text': ink, '--text-rgb': triplet(ink),
      '--muted': muted, '--muted-rgb': triplet(muted),
      '--surface': surf, '--surface-rgb': triplet(surf),
      '--surface-2': SURFACE_LIGHT_2, '--surface-2-rgb': triplet(SURFACE_LIGHT_2),
      '--line': line, '--line-rgb': triplet(line),
      '--white-rgb': triplet(ink),
      '--scrim-rgb': '255 255 255',
      '--gold': gold, '--gold-rgb': triplet(gold),
      '--gold-text': pickOn(bgs, ['#8a6a12', '#6e5410', '#4f3c08'], 4.5, ink),
      '--fold-text': pickOn(bgs, ['#a33a2f', '#8a2c22', '#5c1a14'], 4.5, ink),
      '--call-text': pickOn(bgs, ['#2e6a94', '#1f4f72', '#163a55'], 4.5, ink),
      '--raise-text': pickOn(bgs, ['#2a7048', '#1d5234', '#143a25'], 4.5, ink),
      '--warn-text': pickOn(bgs, ['#8a5a0a', '#6e4608', '#4f3205'], 4.5, ink),
      // text on the gold fill (--gold is dark on a light page, so the fill ink is the light one)
      '--fill-text': fillInk(gold), '--on-accent': fillInk(gold)
    };
    return out;
  }

  // Ink for text on a fill: white or near-black, whichever reaches more contrast (both kept at >= 4.5 on a fill
  // that is dark enough to need the light one).
  function fillInk(fill) {
    var w = contrastRatio(fill, '#ffffff');
    var d = contrastRatio(fill, DARK_TEXT);
    return w >= d ? '#ffffff' : DARK_TEXT;
  }

  // Full theme -> map of CSS variable names to values, plus the tone attributes.
  function deriveVars(t) {
    var railHex = t.rail === 'none' ? t.felt : t.rail;
    var lightPage = tone(t.bg) === 'light';
    var ink = textOn(t.bg);
    var page = lightPage ? lightPageVars(t.bg, ink) : {};
    var felt = textOn(t.felt);
    var hlInk = lightPage ? textOn(t.highlight) : null;
    var vars = {
      '--on-felt-user': felt,
      '--on-felt-user-rgb': triplet(felt),
      '--felt-tone-text': felt
    };
    Object.keys(page).forEach(function (k) { vars[k] = page[k]; });
    if (hlInk) vars['--on-hl-user'] = hlInk;
    return {
      page: lightPage,
      vars: Object.assign(vars, {
        '--bg-user': t.bg,
        '--bg-user-rgb': triplet(t.bg),
        '--felt-user': t.felt,
        '--felt-user-rgb': triplet(t.felt),
        '--felt-user-2': shade(t.felt, -0.33),
        '--felt-user-3': shade(t.felt, 0.12),
        '--rail-user': railHex,
        '--rail-user-rgb': triplet(railHex),
        '--rail-user-2': shade(railHex, -0.25),
        '--hl-user': t.highlight,
        '--hl-user-rgb': triplet(t.highlight),
        '--text-user': ink
      }),
      attrs: {
        'data-bg-tone': tone(t.bg),
        'data-felt-tone': tone(t.felt),
        'data-rail': t.rail === 'none' ? 'none' : 'color',
        'data-rail-tone': tone(railHex)
      }
    };
  }

  /* ---------- state ---------- */

  var current = merge(DEFAULTS, {});
  var listeners = [];

  function readStored() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  // v1 -> v2: a colour that still equals the old built-in default was never customised, so it takes the new default;
  // any other colour is kept. The v1 key is removed once read.
  function readLegacy() {
    var out = null;
    try {
      var raw = window.localStorage.getItem(LEGACY_KEY);
      if (!raw) return null;
      out = sanitize(JSON.parse(raw));
      window.localStorage.removeItem(LEGACY_KEY);
    } catch (e) { return null; }
    GROUPS.forEach(function (k) { if (out[k] === OLD_DEFAULTS[k]) delete out[k]; });
    return out;
  }
  function writeStored(t) {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(t)); } catch (e) { /* storage blocked */ }
  }
  function clearStored() {
    try { window.localStorage.removeItem(STORE_KEY); } catch (e) { /* storage blocked */ }
  }

  function get() {
    return merge(current, {});
  }

  // Light-page overrides are removed on a dark page, so the default theme keeps the stylesheet values exactly.
  var PAGE_VARS = ['--bg', '--bg-rgb', '--text', '--text-rgb', '--muted', '--muted-rgb', '--surface', '--surface-rgb',
    '--surface-2', '--surface-2-rgb', '--line', '--line-rgb', '--white-rgb', '--gold', '--gold-rgb', '--gold-text',
    '--fold-text', '--call-text', '--raise-text', '--warn-text', '--scrim-rgb', '--on-hl-user', '--fill-text', '--on-accent'];
  function apply() {
    if (typeof document === 'undefined' || !document.documentElement) return;
    var root = document.documentElement;
    var d = deriveVars(current);
    if (!d.page) PAGE_VARS.forEach(function (k) { root.style.removeProperty(k); });
    Object.keys(d.vars).forEach(function (k) {
      if (d.vars[k]) root.style.setProperty(k, d.vars[k]);
    });
    Object.keys(d.attrs).forEach(function (k) { root.setAttribute(k, d.attrs[k]); });
  }

  function notify() {
    var snapshot = get();
    listeners.slice().forEach(function (fn) {
      try { fn(snapshot); } catch (e) { /* a listener must not break the others */ }
    });
  }

  // set({ felt: '#1d4f8a' }): invalid fields are ignored. Returns the new theme.
  function set(partial) {
    var clean = sanitize(partial);
    if (Object.keys(clean).length === 0) return get();
    current = merge(current, clean);
    writeStored(current);
    apply();
    notify();
    refresh();
    return get();
  }

  function reset() {
    current = merge(DEFAULTS, {});
    clearStored();
    apply();
    notify();
    refresh();
    return get();
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  /* ---------- settings UI (rendered into #theme-settings) ---------- */

  var STR = {
    en: {
      bg: 'Background',
      felt: 'Table felt',
      rail: 'Table border',
      highlight: 'Highlight colour',
      hlHint: 'The outline around your seat. In multiplayer the other players see it.',
      custom: 'Custom',
      preview: 'Table preview',
      reset: 'Reset colours',
      names: {
        darkgreen: 'Dark green', brown: 'Dark brown', black: 'Black', night: 'Night', charcoal: 'Charcoal', navy: 'Navy', plum: 'Plum', paper: 'Paper',
        green: 'Classic green', blue: 'Blue', red: 'Red', black: 'Black', purple: 'Purple',
        wood: 'Wood', gold: 'Gold', silver: 'Silver', none: 'No border', white: 'White', raise: 'Raise green', call: 'Call blue', fold: 'Fold red',
        white: 'White', raise: 'Green', call: 'Blue'
      }
    },
    es: {
      bg: 'Fondo',
      felt: 'Tapete de la mesa',
      rail: 'Borde de la mesa',
      highlight: 'Color de resalte',
      hlHint: 'El contorno de tu asiento. En multijugador lo ven los demás jugadores.',
      custom: 'Personalizado',
      preview: 'Vista previa de la mesa',
      reset: 'Restablecer colores',
      names: {
        darkgreen: 'Verde oscuro', brown: 'Marrón oscuro', black: 'Negro', night: 'Noche', charcoal: 'Carbón', navy: 'Marino', plum: 'Ciruela', paper: 'Papel',
        green: 'Verde clásico', blue: 'Azul', red: 'Rojo', black: 'Negro', purple: 'Morado',
        wood: 'Madera', gold: 'Oro', silver: 'Plata', none: 'Sin borde', white: 'Blanco', raise: 'Subir verde', call: 'Igualar azul', fold: 'Retirarse rojo',
        white: 'Blanco', raise: 'Verde', call: 'Azul'
      }
    }
  };

  function lang() {
    try {
      var l = window.I18N && window.I18N.lang && window.I18N.lang();
      return l === 'es' ? 'es' : 'en';
    } catch (e) { return 'en'; }
  }
  function str(key) {
    var s = STR[lang()];
    return s[key] != null ? s[key] : STR.en[key];
  }
  function name(id) {
    var n = STR[lang()].names;
    return n[id] != null ? n[id] : STR.en.names[id];
  }

  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'style') node.setAttribute('style', attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    return node;
  }

  function swatchRow(group) {
    return el('div', { 'class': 'tcol-row', role: 'group', 'aria-label': str(group) },
      PRESETS[group].map(function (p) {
        var isNone = p.hex === 'none';
        var attrs = {
          type: 'button',
          'class': 'tcol-sw' + (isNone ? ' is-none' : ''),
          'data-group': group,
          'data-hex': p.hex,
          title: name(p.id),
          'aria-label': name(p.id),
          'aria-pressed': 'false'
        };
        if (!isNone) attrs.style = 'background:' + p.hex;
        return el('button', attrs);
      }));
  }

  function colourGroup(group, label, withCustom) {
    var kids = [
      el('p', { 'class': 'tcol-title', text: label, id: 'tcol-l-' + group }),
      swatchRow(group)
    ];
    if (withCustom) {
      kids.push(el('label', { 'class': 'tcol-custom' }, [
        el('span', { text: str('custom') }),
        el('input', { type: 'color', 'data-group': group, 'aria-label': label + ' (' + str('custom') + ')' })
      ]));
    }
    return el('div', { 'class': 'tcol-group', role: 'group', 'aria-labelledby': 'tcol-l-' + group }, kids);
  }

  // Mini table: an inline SVG oval that follows the current colours.
  function buildPreview() {
    var svg = svgEl('svg', { viewBox: '0 0 240 140', 'aria-hidden': 'true', focusable: 'false', 'class': 'tcol-svg' });
    svg.appendChild(svgEl('rect', { x: 0, y: 0, width: 240, height: 140, rx: 10, 'data-role': 'bg' }));
    svg.appendChild(svgEl('ellipse', { cx: 120, cy: 70, rx: 104, ry: 56, 'data-role': 'rail' }));
    svg.appendChild(svgEl('ellipse', { cx: 120, cy: 70, rx: 92, ry: 45, 'data-role': 'felt' }));
    svg.appendChild(svgEl('rect', { x: 96, y: 6, width: 48, height: 16, rx: 4, 'class': 'tcol-seat', 'data-role': 'seat' }));
    svg.appendChild(svgEl('rect', { x: 96, y: 118, width: 48, height: 16, rx: 4, 'class': 'tcol-seat', 'data-role': 'hero' }));
    return el('div', { 'class': 'tcol-preview' }, [svg]);
  }

  function build(container) {
    container.textContent = '';
    var hl = el('div', { 'class': 'tcol-group', role: 'group', 'aria-labelledby': 'tcol-l-highlight' }, [
      el('p', { 'class': 'tcol-title', text: str('highlight'), id: 'tcol-l-highlight' }),
      swatchRow('highlight'),
      el('label', { 'class': 'tcol-custom' }, [
        el('span', { text: str('custom') }),
        el('input', { type: 'color', 'data-group': 'highlight', 'aria-label': str('highlight') + ' (' + str('custom') + ')' })
      ]),
      el('p', { 'class': 'tcol-hint', text: str('hlHint') })
    ]);
    container.appendChild(colourGroup('bg', str('bg'), true));
    container.appendChild(colourGroup('felt', str('felt'), true));
    container.appendChild(colourGroup('rail', str('rail'), true));
    container.appendChild(hl);
    container.appendChild(el('p', { 'class': 'tcol-title', text: str('preview') }));
    container.appendChild(buildPreview());
    container.appendChild(el('button', { type: 'button', 'class': 'ghost small tcol-reset', 'data-action': 'reset', text: str('reset') }));
    container.setAttribute('data-tcol-lang', lang());
  }

  // Updates pressed states, colour inputs and the preview without rebuilding the DOM (keeps focus).
  // The settings UI lives in two hosts: the drawer's #theme-settings and the Look popover (#look-pop-settings).
  function hosts() {
    var out = [];
    if (typeof document === 'undefined') return out;
    ['theme-settings', 'look-pop-settings', 'menu-theme-settings'].forEach(function (id) {
      var h = document.getElementById(id);
      if (h) out.push(h);
    });
    return out;
  }
  function refresh(c) {
    if (!c || c.getAttribute('data-tcol-lang') !== lang()) return;
    var t = get();
    Array.prototype.forEach.call(c.querySelectorAll('.tcol-sw'), function (b) {
      var g = b.getAttribute('data-group');
      var on = String(t[g]).toLowerCase() === b.getAttribute('data-hex') ||
        (g === 'rail' && t.rail === 'none' && b.getAttribute('data-hex') === 'none');
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    Array.prototype.forEach.call(c.querySelectorAll('input[type=color]'), function (inp) {
      var g = inp.getAttribute('data-group');
      var v = g === 'rail' && t.rail === 'none' ? current.felt : t[g];
      if (inp.value !== v) inp.value = v;
    });
    var svg = c.querySelector('.tcol-svg');
    if (svg) {
      var railHex = t.rail === 'none' ? t.felt : t.rail;
      var put = function (role, attr, val) {
        var n = svg.querySelector('[data-role="' + role + '"]');
        if (n) n.setAttribute(attr, val);
      };
      put('bg', 'fill', t.bg);
      put('rail', 'fill', railHex);
      put('felt', 'fill', t.felt);
      put('hero', 'stroke', t.highlight);
      put('hero', 'stroke-width', '3');
    }
  }

  // Renders into #theme-settings (created by the settings drawer). Lazy and idempotent.
  function render() {
    hosts().forEach(renderHost);
  }
  function renderHost(c) {
    if (c.getAttribute('data-tcol-lang') !== lang() || !c.firstChild) {
      build(c);
      if (!c._tcolBound) {
        c._tcolBound = true;
        c.addEventListener('click', function (e) {
          var b = e.target && e.target.closest ? e.target.closest('button') : null;
          if (!b || !c.contains(b)) return;
          if (b.getAttribute('data-action') === 'reset') { reset(); return; }
          var g = b.getAttribute('data-group');
          var hex = b.getAttribute('data-hex');
          if (!g) return;
          var o = {};
          o[g] = hex;
          set(o);
        });
        c.addEventListener('input', function (e) {
          var inp = e.target;
          if (!inp || inp.type !== 'color') return;
          var g = inp.getAttribute('data-group');
          var o = {};
          o[g] = inp.value;
          set(o);
        });
      }
    }
    refresh(c);
  }

  /* ---------- Look button and popover (every mode) ----------
   * A palette button (44px) sits in the topbar's top-right; in a mode the topbar is hidden, so it floats top-right
   * beside the back arrow. It opens a small popover holding the same colour settings as the drawer. */
  var look = { btn: null, pop: null };
  function setLookOpen(open) {
    if (!look.btn) return;
    look.pop.classList.toggle('hidden', !open);
    look.btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open) return;
    render();
    var r = look.btn.getBoundingClientRect();
    // below the button, kept fully inside the viewport (left edge clamped; width is capped by the CSS)
    var pw = Math.min(340, window.innerWidth - 16);
    var left = Math.min(Math.max(8, Math.round(r.left)), Math.max(8, window.innerWidth - pw - 8));
    look.pop.style.top = Math.round(Math.min(r.bottom + 8, window.innerHeight - 60)) + 'px';
    look.pop.style.right = 'auto';
    look.pop.style.left = left + 'px';
  }
  function placeLook() {
    if (!look.btn) return;
    var tr = document.querySelector('.topbar .top-right');
    // in a solo mode the back arrow (#btn-back) shows: the palette floats top-left, clear of the arrow and the mode tools
    var back = document.getElementById('btn-back');
    var solo = !!back && back.offsetParent !== null;
    var inTopbar = !!tr && tr.offsetParent !== null && !solo;
    if (inTopbar) {
      if (look.btn.parentNode !== tr) tr.insertBefore(look.btn, tr.firstChild);
    } else if (look.btn.parentNode !== document.body) {
      document.body.appendChild(look.btn);
    }
    look.btn.classList.toggle('look-float', !inTopbar);
  }
  function mountLook() {
    if (look.btn || !document.body) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'look-btn';
    btn.id = 'btn-look';
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', 'Look / Aspecto');
    btn.title = 'Look / Aspecto';
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 3a9 9 0 0 0 0 18c1.1 0 1.7-.8 1.7-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H16a5 5 0 0 0 5-5c0-4.4-4-7.2-9-7.2zM6.5 12a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>';
    var pop = document.createElement('div');
    pop.className = 'look-pop hidden';
    pop.id = 'look-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Look / Aspecto');
    var body = document.createElement('div');
    body.id = 'look-pop-settings';
    body.className = 'theme-settings';
    pop.appendChild(body);
    look.btn = btn;
    look.pop = pop;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      setLookOpen(pop.classList.contains('hidden'));
    });
    document.addEventListener('click', function (e) {
      if (pop.classList.contains('hidden') || pop.contains(e.target) || btn.contains(e.target)) return;
      setLookOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !pop.classList.contains('hidden')) { setLookOpen(false); btn.focus(); }
    });
    document.body.appendChild(pop);
    placeLook();
    window.addEventListener('resize', placeLook);
    if (window.MutationObserver) new MutationObserver(placeLook).observe(document.body, { attributes: true, attributeFilter: ['data-view'] });
    onChange(function () { hosts().forEach(refresh); });
  }

  /* ---------- wiring ---------- */

  // Used by the first call to set() and by UI-A's settings drawer button.
  var api = {
    get: get,
    set: set,
    apply: apply,
    reset: reset,
    onChange: onChange,
    render: render,
    presets: PRESETS,
    defaults: merge(DEFAULTS, {})
  };

  // Initial load: stored values are validated against the defaults.
  var migrated = readStored() ? null : readLegacy();
  current = merge(DEFAULTS, sanitize(readStored() || migrated));
  if (migrated && Object.keys(migrated).length) writeStored(current);
  apply();

  if (typeof window !== 'undefined') {
    window.PokerTheme = api;
    if (typeof document !== 'undefined' && document.addEventListener) {
      var boot = function () { mountLook(); render(); };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
      else boot();
      // The settings drawer is opened by a button; render lazily on that click (one tick later).
      document.addEventListener('click', function (e) {
        var t = e.target && e.target.closest ? e.target.closest('#btn-settings') : null;
        if (t) setTimeout(render, 0);
      }, true);
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      normalizeHex: normalizeHex,
      isHex: isHex,
      hexToRgb: hexToRgb,
      luminance: luminance,
      contrastRatio: contrastRatio,
      textOn: textOn,
      minContrast: minContrast,
      pickOn: pickOn,
      lightPageVars: lightPageVars,
      tone: tone,
      fillInk: fillInk,
      mix: mix,
      shade: shade,
      sanitize: sanitize,
      deriveVars: deriveVars,
      DEFAULTS: DEFAULTS,
      PRESETS: PRESETS
    };
  }
})();
