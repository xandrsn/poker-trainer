'use strict';
// Wording check: the words "equity" / "equidad" must never reach the user. Code identifiers
// (e.g. the row.equity key) are allowed; only string literals and HTML text are scanned.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const BANNED = /equit(y|ies)|equidad/i;
const FILES = ['public/i18n.js', 'public/app.js', 'public/engine.js', 'public/index.html'];

// Remove comments from JS (HTML is scanned as a whole).
function stripJsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}
// String literals in JS. Identifier-like keys (row.equity, btn.close) are skipped.
function literals(src) {
  const out = [];
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  let m;
  while ((m = re.exec(src))) {
    const s = m[1] ?? m[2] ?? m[3] ?? '';
    if (/^[a-z][\w.+-]*$/i.test(s) && /[._]/.test(s)) continue; // i18n / data keys (no spaces)
    out.push(s);
  }
  return out;
}

let checked = 0;
const failures = [];
for (const f of FILES) {
  const raw = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const text = f.endsWith('.html') ? raw : stripJsComments(raw);
  const pieces = f.endsWith('.html') ? [raw] : literals(text);
  for (const s of pieces) {
    checked++;
    if (BANNED.test(s)) failures.push(f + ': ' + JSON.stringify(s.trim().slice(0, 80)));
  }
}

try {
  assert.deepStrictEqual(failures, []);
  console.log('ok   ' + checked + ' user-facing strings contain no "equity" / "equidad"');
  console.log('all i18n wording tests passed');
} catch (e) {
  console.error('FAIL wording check:\n  ' + failures.join('\n  '));
  process.exitCode = 1;
}

// Theme swatches: every palette id has an EN and ES name (the swatch aria-label was 'undefined' for 'white').
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'theme.js'), 'utf8');
  const ids = [...src.matchAll(/\{ id: '([a-z]+)', hex: /g)].map((m) => m[1]);
  const blocks = [...src.matchAll(/names: \{([\s\S]*?)\}/g)].map((m) => m[1]);
  if (blocks.length < 2) throw new Error('theme names blocks not found');
  for (const id of new Set(ids)) {
    for (const b of blocks) {
      if (!new RegExp('(^|[^a-z])' + id + ': ').test(b)) throw new Error('theme swatch "' + id + '" has no name');
    }
  }
  console.log('ok   every theme swatch has an EN and ES name (no aria-label "undefined")');
}

// Spanish UI: every static aria-label in index.html is translated (data-i18n-aria), and each such key has a Spanish entry.
{
  const root = require('path').join(__dirname, '..', 'public');
  const html = require('fs').readFileSync(require('path').join(root, 'index.html'), 'utf8');
  const i18nSrc = require('fs').readFileSync(require('path').join(root, 'i18n.js'), 'utf8');
  const esBlock = i18nSrc.slice(i18nSrc.indexOf('var ES = {'), i18nSrc.indexOf('var DICT'));
  const tags = html.match(/<[^>]*\baria-label="[^"]*"[^>]*>/g) || [];
  const untranslated = tags.filter((t) => !/data-i18n-aria="/.test(t)).map((t) => t.match(/aria-label="([^"]*)"/)[1]);
  if (untranslated.length) throw new Error('aria-label without data-i18n-aria (English in Spanish UI): ' + untranslated.join(' | '));
  const keys = [...new Set([...html.matchAll(/data-i18n-aria="([^"]*)"/g)].map((m) => m[1]))];
  const noEs = keys.filter((k) => !new RegExp("'" + k.replace(/\./g, '\.') + "':").test(esBlock));
  if (noEs.length) throw new Error('aria keys without a Spanish entry: ' + noEs.join(', '));
  console.log('ok   every aria-label in index.html is translated and has a Spanish entry (' + keys.length + ' keys)');
}

// Every literal t('x.y') in public/*.js has an EN and an ES entry; tr('x') keys exist in review-ui's EN and ES text dictionary.
// Keys built as 'rating.' + name are expanded over the rating names. Dynamic keys (other concatenations) are not checked.
{
  const pubDir = path.join(__dirname, '..', 'public');
  const files = fs.readdirSync(pubDir).filter((f) => f.endsWith('.js'));
  const I18N = require(path.join(pubDir, 'i18n.js'));
  const RATING_NAMES = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder', 'forced'];
  const LUCK_NAMES = ['bad_luck', 'lucky', 'none'];
  const tKeys = new Set();
  const trKeys = new Set();
  for (const f of files) {
    const src = fs.readFileSync(path.join(pubDir, f), 'utf8');
    for (const m of src.matchAll(/(^|[^A-Za-z0-9_.])t\('([a-z]+(\.[A-Za-z0-9_]+)+)'\)/g)) tKeys.add(m[2]);
    if (/(^|[^A-Za-z0-9_.])t\('rating\.'\s*\+/.test(src)) RATING_NAMES.forEach((r) => tKeys.add('rating.' + r));
    if (f === 'review-ui.js') for (const m of src.matchAll(/(^|[^A-Za-z0-9_.])tr\('([A-Za-z][A-Za-z0-9_.]*)'/g)) trKeys.add(m[2]);
  }
  LUCK_NAMES.forEach((n) => tKeys.add('rating.luck.' + n));
  const missing = [];
  for (const k of tKeys) {
    for (const lang of ['en', 'es']) {
      if (!I18N.dict || !I18N.dict[lang] || I18N.dict[lang][k] == null) missing.push(lang + ':' + k);
    }
  }
  if (missing.length) throw new Error('t() keys missing in i18n.js: ' + missing.join(', '));
  console.log('ok   ' + tKeys.size + ' t() keys exist in EN and ES (i18n.js)');

  const ui = fs.readFileSync(path.join(pubDir, 'review-ui.js'), 'utf8');
  const block = ui.slice(ui.indexOf('var T = {'), ui.indexOf('var curLang'));
  const missingTr = [];
  for (const k of trKeys) {
    const top = k.split('.');
    const re = new RegExp('(^|[\\s{,])' + top[top.length - 1] + ': \\{ en: [^\\n]*?es: ');
    if (!re.test(block)) missingTr.push(k);
  }
  if (missingTr.length) throw new Error('tr() keys missing in review-ui.js text dictionary: ' + missingTr.join(', '));
  console.log('ok   ' + trKeys.size + ' tr() keys exist in review-ui EN and ES dictionary');
}
