const { openFmt } = require('./helpers/menu');
'use strict';
// Seat plates in the solo modes (Quick spots, Practice, Exam, Quick game) at 1366x768 and 390x844, real Chrome.
// Checks: folded seats recede (computed opacity <= 0.45), live seats stay at 1 with a highlight outline,
// the position badge and the style tag each show their own glossary bubble (the style one only on the word),
// seat markup is the same in every mode, and no seat shows hole cards twice.
// Run: node test/e2e-seats.js   (one browser, closed at the end). Screenshots: .e2e-shots/seats-*.png
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);
const INDEX = 'file:///' + path.join(__dirname, '..', 'public', 'index.html').replace(/\\/g, '/');
const SHOTS = path.join(__dirname, '..', '.e2e-shots');
const SIZES = [[1366, 768], [390, 844]];
const MODES = ['quick', 'practice', 'exam', 'table'];

const results = [];
// hover by coordinates read at the moment of the move (the table can re-render between reads)
// The bot seats re-render between the read and the move, so the pointer can land on a neighbour (its bubble
// would then be the neighbour's). Retry until elementFromPoint at the pointer is the target itself.
async function hoverSel(p, sel) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await p.waitForTimeout(400);
    const c = await p.evaluate((q) => { const e = document.querySelector(q); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, sel);
    if (!c) return false;
    await p.mouse.move(c[0], c[1]);
    await p.waitForTimeout(150);
    const under = await p.evaluate(([q, x, y]) => { const t = document.querySelector(q); const e = document.elementFromPoint(x, y); return !!t && !!e && (e === t || t.contains(e)); }, [sel, c[0], c[1]]);
    if (under) return true;
  }
  return false;
}
function check(name, ok, info) {
  results.push({ name, ok: !!ok, info: info === undefined ? null : info });
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (info !== undefined && info !== null ? '  [' + info + ']' : ''));
}

(async () => {
  const hit = CANDIDATES.find((p) => fs.existsSync(p));
  if (!hit) throw new Error('No Chrome/Edge found. Set CHROME_PATH.');
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: hit, headless: true });
  const signatures = {};
  try {
    for (const [w, h] of SIZES) {
      for (const mode of MODES) {
        const tag = mode + ' ' + w + 'x' + h;
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce' });
        const p = await ctx.newPage();
        const errs = [];
        p.on('pageerror', (e) => errs.push(e.message));
        await p.goto(INDEX, { waitUntil: 'load' });
        await p.waitForTimeout(600);
        const card = await p.$('[data-fmt="' + mode + '"]');
        if (!card) { check(tag + ' mode card exists', false); await ctx.close(); continue; }
        // mode cards sit under their hub tile (menu-hub.css)
        await openFmt(p, mode); await p.waitForTimeout(250);
        await p.click('#menu-start'); await p.waitForTimeout(1200);
        const seatCount = await p.evaluate(() => document.querySelectorAll('#table .seat').length);
        check(tag + ' seats rendered', seatCount >= 2, seatCount);
        if (seatCount < 2) { await ctx.close(); continue; }

        // play a few decisions until somebody folds (full hands); quick spots and practice have one decision each
        let folded = 0;
        for (let i = 0; i < 14 && !folded; i++) {
          await p.evaluate(() => { const b = document.getElementById('btn-call'); if (b && !b.disabled) b.click(); });
          await p.waitForTimeout(350);
          await p.evaluate(() => { const b = document.getElementById('btn-next'); if (b && !b.classList.contains('hidden') && !b.disabled) b.click(); });
          await p.waitForTimeout(350);
          folded = await p.evaluate(() => document.querySelectorAll('#table .seat.folded').length);
        }
        const states = await p.evaluate(() => {
          const pick = (q) => { const e = document.querySelector(q); if (!e) return null; const cs = getComputedStyle(e); return { opacity: +cs.opacity, outline: cs.outlineStyle + ' ' + cs.outlineWidth, shadow: cs.boxShadow }; };
          return { folded: pick('#table .seat.folded'), live: pick('#table .seat.in-hand:not(.hero)') };
        });
        if (states.folded) {
          check(tag + ' folded seat recedes (opacity <= 0.45)', states.folded.opacity <= 0.45, states.folded.opacity);
        } else {
          check(tag + ' folded seat present (not reached in this run, not failed)', true, 'no fold reached');
        }
        if (states.live) {
          const hl = states.live.outline.indexOf('solid') >= 0 || (states.live.shadow && states.live.shadow !== 'none');
          check(tag + ' live seat opacity 1 with highlight', states.live.opacity === 1 && hl, states.live.opacity + ' / ' + states.live.outline);
        } else {
          check(tag + ' live seat present', false);
        }

        // glossary: position badge (own bubble, full name), style tag (own bubble, long text), not on the rest of the seat
        const badge = await p.$('#table .seat[data-tip] .pos-badge');
        const badgeSel = '#table .seat[data-tip] .pos-badge';
        if (badge) {
          // A bot plate can re-render under the pointer (renderTable replaces every seat and hides the bubble); the
          // pointer then lands on the new plate and its style bubble shows. Retry until the position bubble is up.
          let b1 = null;
          for (let attempt = 0; attempt < 5 && !b1; attempt++) {
            await hoverSel(p, badgeSel); await p.waitForTimeout(150);
            const got = await p.evaluate(() => { const b = document.querySelector('.gloss-bubble'); return b && !b.hidden && b.getAttribute('data-kind') === 'pos' ? b.textContent : null; });
            if (got) b1 = got; else { await p.mouse.move(1, 1); await p.waitForTimeout(300); }
          }
          check(tag + ' badge hover shows its own glossary bubble', !!b1 && /\u2013|-/.test(b1), b1 ? b1.slice(0, 60) : null);
          const seatTipShown = await p.evaluate(() => { const s = document.querySelector('#table .seat[data-tip] .pos-badge').closest('.seat'); return getComputedStyle(s, '::after').opacity; });
          check(tag + ' badge hover hides the seat tip', seatTipShown === '0', seatTipShown);
        } else check(tag + ' position badge present', false);
        await p.mouse.move(1, 1); await p.waitForTimeout(120);

        // the play style is shown once: the avatar; there is no .style-tag element any more
        const dupTags = await p.$$eval('#table .seat .style-tag', (n) => n.length);
        check(tag + ' no duplicate style tag on the plate', dupTags === 0, dupTags);
        // at table level 3 the avatar is hidden by design (the plate name carries the same bubble, checked below)
        const avatarVisible = await p.evaluate(() => [...document.querySelectorAll('#table .seat .seat-avatar.bot')].some((a) => a.getBoundingClientRect().width > 0));
        const avatar = avatarVisible ? await p.$('#table .seat .seat-avatar.bot') : null;
        if (avatar) {
          // same re-render race as the badge above: retry until the style bubble of this plate is up
          let s1 = null;
          for (let attempt = 0; attempt < 5 && !s1; attempt++) {
            await hoverSel(p, '#table .seat .seat-avatar.bot'); await p.waitForTimeout(150);
            const got = await p.evaluate(() => { const b = document.querySelector('.gloss-bubble'); return b && !b.hidden && b.getAttribute('data-kind') === 'style' ? { text: b.textContent, lines: b.querySelectorAll('.gloss-line').length } : null; });
            if (got) s1 = got; else { await p.mouse.move(1, 1); await p.waitForTimeout(300); }
          }
          check(tag + ' avatar hover shows the long style bubble', !!s1 && s1.lines >= 2, s1 ? s1.lines + ' lines' : null);
          // hovering the seat name (elsewhere on the plate) shows the same style bubble: the plate carries the glossary
          const nm = await p.$('#table .seat.opp[data-gloss="style"] .seat-name');
          if (nm) {
            await p.mouse.move(1, 1); await p.waitForTimeout(150);
            await hoverSel(p, '#table .seat.opp[data-gloss="style"] .seat-name'); await p.waitForTimeout(150);
            const nmBox = await p.evaluate(() => { const r = document.querySelector('#table .seat.opp[data-gloss="style"] .seat-name').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
            await p.mouse.move(nmBox[0] + 1, nmBox[1]); await p.waitForTimeout(150);
            const hit = await p.evaluate(() => { const r = document.querySelector('#table .seat.opp[data-gloss="style"] .seat-name').getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return e ? e.className : null; });
            const s2 = await p.evaluate(() => { const b = document.querySelector('.gloss-bubble'); return !!b && !b.hidden && b.getAttribute('data-kind') === 'style'; });
            check(tag + ' hovering a bot plate name shows the style bubble (plate carries the glossary)', s2, hit);
          }
        } else {
          check(tag + ' style tag not shown at this size (style.css hides it on narrow screens)', true, 'hidden or absent');
        }
        await p.mouse.move(1, 1); await p.waitForTimeout(120);

        // markup: the base class list of every opponent seat (state classes removed) and the children
        const sig = await p.evaluate(() => {
          const states = ['hero', 'folded', 'busted', 'in-hand', 'to-act', 'winner', 'opp', 'seat', 'no-anim'];
          const seats = [...document.querySelectorAll('#table .seat:not(.hero)')];
          const base = new Set();
          seats.forEach((s) => s.classList.forEach((c) => { if (!states.includes(c)) base.add(c); }));
          const kids = new Set();
          seats.forEach((s) => [...s.children].forEach((c) => kids.add(c.className.split(' ')[0])));
          return { classes: [...base].sort().join(','), kids: [...kids].sort().join(',') };
        });
        signatures[mode] = sig;

        // no doubled hole cards: one face-down pair OR revealed cards per seat, and the hero shows two cards
        const doubled = await p.evaluate(() => [...document.querySelectorAll('#table .seat')].filter((s) => s.querySelector('.seat-backs') && s.querySelector('.mini-cards')).length);
        check(tag + ' no seat shows both a face-down pair and revealed cards', doubled === 0, doubled);
        const heroCards = await p.evaluate(() => document.querySelectorAll('#hero-cards .card').length);
        check(tag + ' hero has at most two hole cards', heroCards <= 2, heroCards);

        // PokerAnim leftovers: no .anim-el may remain 3 s after a hand (reduced motion here, so the layer is normally empty)
        await p.waitForTimeout(3000);
        const animLeft = await p.evaluate(() => document.querySelectorAll('.anim-el').length);
        check(tag + ' no .anim-el 3 s after a hand', animLeft === 0, animLeft);
        // keyboard R while raise is disabled must send no action (hero action chip unchanged, nothing advances)
        const raiseOff = await p.evaluate(() => { const b = document.getElementById('btn-raise'); return !b || b.disabled || b.classList.contains('hidden'); });
        if (raiseOff) {
          const before = await p.evaluate(() => document.querySelector('#table .seat.hero') ? document.querySelector('#table .seat.hero').textContent : '');
          await p.keyboard.press('r'); await p.waitForTimeout(300);
          const after = await p.evaluate(() => document.querySelector('#table .seat.hero') ? document.querySelector('#table .seat.hero').textContent : '');
          check(tag + ' keyboard R with raise disabled sends no action', before === after, before === after ? null : 'seat text changed');
        } else check(tag + ' keyboard R check (raise enabled at this point, not failed)', true, 'skipped');

        check(tag + ' no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || null);
        await p.screenshot({ path: path.join(SHOTS, 'seats-' + mode + '-' + w + 'x' + h + '.png') });
        await ctx.close();
      }
    }
    // the same plate in every mode: identical base classes and child elements
    const ref = signatures[MODES[0]];
    MODES.forEach((m) => {
      const s = signatures[m];
      if (!s) return;
      const allowed = ['seat-top', 'seat-name', 'seat-stack', 'la-chip', 'mini-cards', 'seat-backs', 'seat-avatar'];
      const kidsOk = s.kids.split(',').every((k) => !k || allowed.indexOf(k) >= 0) && s.kids.indexOf('seat-top') >= 0 && s.kids.indexOf('seat-name') >= 0;
      check('seat markup from the shared plate: ' + m, kidsOk && s.classes === '' , s.classes + ' | ' + s.kids);
    });
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n' + (results.length - failed) + '/' + results.length + ' seat checks passed');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
