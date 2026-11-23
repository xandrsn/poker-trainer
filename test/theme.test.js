'use strict';
// Pure helpers of public/theme.js: colour validation, luminance contrast, shade derivation.
const assert = require('node:assert/strict');
const T = require('../public/theme.js');

// colour validation
assert.equal(T.normalizeHex('#14573A'), '#14573a');
assert.equal(T.normalizeHex('abc'), '#aabbcc');
assert.equal(T.normalizeHex('#fff'), '#ffffff');
assert.equal(T.normalizeHex('#12345'), null);
assert.equal(T.normalizeHex('red'), null);
assert.equal(T.normalizeHex(null), null);
assert.equal(T.isHex('#0b0f14'), true);
assert.equal(T.isHex('#0b0f1g'), false);

// sanitize keeps only valid fields; rail may be 'none'
assert.deepEqual(T.sanitize({ bg: '#000000', felt: 'nope', rail: 'none', highlight: '#FFF', x: 1 }),
  { bg: '#000000', rail: 'none', highlight: '#ffffff' });
assert.deepEqual(T.sanitize({ felt: 'none' }), {});
assert.deepEqual(T.sanitize(null), {});

// luminance and contrast (WCAG)
assert.equal(Math.round(T.contrastRatio('#000000', '#ffffff')), 21);
assert.equal(T.luminance('#000000'), 0);
assert.ok(Math.abs(T.luminance('#ffffff') - 1) < 1e-9);

// text colour chosen by contrast
assert.equal(T.textOn('#ffffff'), '#14110d');
assert.deepEqual(T.DEFAULTS, { bg: '#000000', felt: '#0f3d27', rail: '#3a2618', highlight: '#ffffff' });
assert.equal(T.textOn('#000000'), '#e8eef5');
assert.equal(T.textOn('#0b0f14'), '#e8eef5');
assert.equal(T.textOn('#7a7a7a'), '#050403');
assert.equal(T.tone('#ece6d6'), 'light');
assert.equal(T.tone('#14573a'), 'dark');

// shades: darker felt is close to the built-in rim colour, and mix stays in range
assert.equal(T.shade('#ffffff', 0.5), '#ffffff');
assert.equal(T.shade('#000000', 1), '#ffffff');
assert.equal(T.shade('#ffffff', -1), '#000000');
const edge = T.shade(T.DEFAULTS.felt, -0.33);
assert.match(edge, /^#[0-9a-f]{6}$/);
const d = Math.abs(parseInt(edge.slice(1, 3), 16) - 10) + Math.abs(parseInt(edge.slice(3, 5), 16) - 41) +
  Math.abs(parseInt(edge.slice(5, 7), 16) - 26);
assert.ok(d < 12, 'darkened felt ' + edge + ' should be near the built-in rim #0a291a');

// derived variables: rail none follows the felt; tones follow luminance
const v1 = T.deriveVars({ bg: '#0b0f14', felt: '#14573a', rail: 'none', highlight: '#ffffff' });
assert.equal(v1.vars['--rail-user'], '#14573a');
assert.equal(v1.attrs['data-rail'], 'none');
assert.equal(v1.vars['--hl-user'], '#ffffff');
assert.equal(v1.vars['--hl-user-rgb'], '255 255 255');
const v2 = T.deriveVars({ bg: '#ffffff', felt: '#000000', rail: '#ffffff', highlight: '#ffffff' });
assert.equal(v2.attrs['data-bg-tone'], 'light');
assert.equal(v2.vars['--text-user'], '#14110d');
assert.equal(v2.page, true);
assert.equal(v2.vars['--text'], '#14110d');
assert.equal(T.deriveVars(T.DEFAULTS).page, false);
assert.equal(v2.vars['--on-felt-user'], '#e8eef5');
assert.equal(v2.attrs['data-rail'], 'color');

// contrast palette: the chosen ink reaches 4.5:1 on every background, for text on the page and on the felt
const PALETTE = ['#000000', '#ffffff', '#f2efe6', '#ffe9a8', '#b9d7c1', '#7a7a7a', '#808080', '#707070', '#6b6b6b',
  '#d0d0d0', '#333333', '#ece6d6', '#fffbe0', '#e6f7ff', '#ffe4ec', '#1c1f24', '#0d1830', '#3a2618', '#6b4423',
  '#b08d3c', '#9aa3ad', '#7fff00', '#14573a', '#4b2a6e'];
assert.equal(PALETTE.length, 24);
PALETTE.forEach((bg) => {
  const ink = T.textOn(bg);
  assert.ok(T.contrastRatio(bg, ink) >= 4.5, 'ink ' + ink + ' on ' + bg + ' is ' + T.contrastRatio(bg, ink).toFixed(2));
  // the light-page tokens reach 4.5:1 for muted and accent text when the page is light
  if (T.tone(bg) === 'light') {
    const p = T.lightPageVars(bg, ink);
    ['--muted', '--gold-text', '--fold-text', '--call-text', '--raise-text', '--warn-text'].forEach((k) => {
      assert.ok(T.minContrast(p[k], [bg, '#fbf8f1']) >= 4.5, k + ' ' + p[k] + ' on ' + bg);
    });
    assert.ok(T.minContrast(p['--line'], [bg, '#fbf8f1']) >= 3, '--line on ' + bg);
  }
});

console.log('theme.test.js: all assertions passed');
