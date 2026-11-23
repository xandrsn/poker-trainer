'use strict';
// Hero-only game review player in real headless Chrome, on test/fixtures/review-demo.html (sample exam, replay data).
// Sizes: 1920x1080, 1366x768, 1024x600 (desktop: table left, panel right); 844x390 (landscape phone),
// 390x844, 360x640 (phone: table on top, panel sheet, controls at the bottom). Languages: EN and ES (?lang=es).
// For each size and language:
//  - no page errors or console errors; the document does not scroll; the replay fits; no overlaps or clipping;
//  - only the panel body, the summary drawer and the timeline row may scroll (SCROLL_OK);
//  - controls are 44px+ and inside the viewport;
//  - stepping visits hero moves only: Next visits every decision and one end card per hand (no villain stops);
//  - each decision stop goes before -> after (data-phase), the coach card shows the rating, the verdict, the explanation;
//  - Previous move, Next hand, Previous hand, Play/Pause (fast timer via ?fast=1), keyboard (Left/Right, Up/Down,
//    PageUp/PageDown, Home/End, Space), timeline click, Show best move ghost, rating count jumps (desktop), Escape closes.
// Screenshots: .e2e-shots/review-ui. Env: E2E_PORT (6240-6259, default 6240), VIEWPORT_ONLY (e.g. "390x844"), CHROME_PATH.
// Run alone: node test/e2e-review-ui.js
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 6240);
const SHOTS = path.join(ROOT, '.e2e-shots', 'review-ui');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
const SIZES = [
  { w: 1920, h: 1080 }, { w: 1366, h: 768 }, { w: 1024, h: 600 },
  { w: 844, h: 390, phone: true }, { w: 390, h: 844, phone: true }, { w: 360, h: 640, phone: true }
];
const ONLY = process.env.VIEWPORT_ONLY ? process.env.VIEWPORT_ONLY.split(',') : null;
const LANGS = ['en', 'es'];

function serve() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const p = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(ROOT, p === '/' ? 'test/fixtures/review-demo.html' : p);
      if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(data);
      });
    });
    srv.on('error', reject);
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

// Layout facts read in the page: overlaps between the big parts, small or outside controls, scrollers, document scroll.
const LAYOUT = `(() => {
  const SCROLL_OK = /rv-coach-body|rv-timeline/;
  const root = document.querySelector('.rv-replay');
  const vw = innerWidth, vh = innerHeight;
  const shown = (el) => !!el && el.offsetParent !== null;
  const parts = {};
  [['top', '.rv-head'], ['table', '.rv-table'], ['panel', '.rv-coach'], ['timeline', '.rv-timeline'], ['controls', '.rv-controls']]
    .forEach(function (p) { const el = root.querySelector(p[1]); if (shown(el)) parts[p[0]] = el.getBoundingClientRect(); });
  const overlaps = [];
  const names = Object.keys(parts);
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const a = parts[names[i]], b = parts[names[j]];
    const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left) - 1;
    const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) - 1;
    if (ox > 0 && oy > 0) overlaps.push(names[i] + '/' + names[j]);
  }
  const small = [], outside = [];
  const sel = '.rv-ctl, .rv-tl, .rv-iconbtn, .rv-hand-select, .rv-ghostbtn, .rv-count';
  root.querySelectorAll(sel).forEach(function (el) {
    if (!shown(el) || el.disabled) return;
    const b = el.getBoundingClientRect();
    const isDot = el.classList.contains('rv-tl'); // timeline dots: 44px tall touch row, 26px wide
    if (b.height < 43.5 || (!isDot && b.width < 43.5)) small.push((el.className || el.tagName) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height));
    const inRow = !!el.closest('.rv-timeline'); // the timeline row scrolls sideways by design
    if (!inRow && (b.left < -0.5 || b.top < -0.5 || b.right > vw + 0.5 || b.bottom > vh + 0.5)) outside.push(String(el.className));
  });
  // seat cards and bubbles must stay inside the table
  const tb = root.querySelector('.rv-table').getBoundingClientRect();
  const seatOut = [];
  root.querySelectorAll('.rv-seat').forEach(function (el) {
    const b = el.getBoundingClientRect();
    if (b.left < tb.left - 2 || b.right > tb.right + 2 || b.top < tb.top - 30 || b.bottom > tb.bottom + 30) seatOut.push(Math.round(b.left) + ',' + Math.round(b.top));
  });
  const scrollers = [];
  root.querySelectorAll('*').forEach(function (el) {
    if (!shown(el)) return;
    const cs = getComputedStyle(el);
    const scrollable = /(auto|scroll)/.test(cs.overflowY) || /(auto|scroll)/.test(cs.overflowX);
    if (scrollable && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) scrollers.push(String(el.className));
  });
  const r = root.getBoundingClientRect();
  const doc = document.scrollingElement;
  return {
    docScroll: doc.scrollHeight > doc.clientHeight + 1 || doc.scrollWidth > doc.clientWidth + 1,
    inside: r.top >= -0.5 && r.bottom <= vh + 0.5 && r.left >= -0.5 && r.right <= vw + 0.5,
    overlaps: overlaps, small: small, outside: outside, seatOut: seatOut,
    badScrollers: scrollers.filter(function (c) { return !SCROLL_OK.test(c); }),
    scrollers: scrollers,
    seats: root.querySelectorAll('.rv-seat').length
  };
})()`;

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const srv = await serve();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const failures = [];
  const results = {};
  const fail = (where, msg) => { failures.push(where + ': ' + msg); };
  try {
    for (const lang of LANGS) {
      for (const vp of SIZES) {
        const key = vp.w + 'x' + vp.h + '-' + lang;
        if (ONLY && ONLY.indexOf(vp.w + 'x' + vp.h) < 0) continue;
        const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 1, hasTouch: !!vp.phone, isMobile: !!vp.phone });
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
        page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
        await page.goto('http://127.0.0.1:' + PORT + '/test/fixtures/review-demo.html?lang=' + lang + '&fast=1', { waitUntil: 'load' });
        await page.waitForSelector('.rv-replay .rv-seat');
        await page.waitForSelector('.rv-replay[data-phase="after"]');
        const L = await page.evaluate(LAYOUT);
        if (L.docScroll) fail(key, 'document scrolls');
        if (!L.inside) fail(key, 'replay outside viewport');
        if (L.overlaps.length) fail(key, 'overlap ' + L.overlaps.join(','));
        if (L.small.length) fail(key, 'small controls ' + L.small.join(';'));
        if (L.outside.length) fail(key, 'controls outside viewport ' + L.outside.join(';'));
        if (L.seatOut.length) fail(key, 'seats outside the table ' + L.seatOut.join(';'));
        if (L.badScrollers.length) fail(key, 'unexpected scroller ' + L.badScrollers.join(';'));
        if (L.seats !== 9) fail(key, 'seats ' + L.seats + ' expected 9');

        const info = await page.evaluate(() => ({
          decisions: document.querySelectorAll('.rv-tl').length,
          hands: document.querySelectorAll('.rv-hand-select option').length,
          heroMarks: document.querySelectorAll('.rv-tl').length
        }));
        const sub = () => page.locator('.rv-sub').first().textContent();
        const phase = () => page.evaluate(() => document.querySelector('.rv-replay').getAttribute('data-phase'));
        const headline = () => page.evaluate(() => { const e = document.querySelector('.rv-coach-head h3'); return e ? e.textContent : ''; });
        const next = () => page.locator('.rv-ctl').nth(3).click();
        const prev = () => page.locator('.rv-ctl').nth(1).click();
        const shot = (name) => page.screenshot({ path: path.join(SHOTS, key + '-' + name + '.png') });

        // stepping: every stop is a hero move or a hand-end card; Next walks the whole exam
        const keyNow = async () => (await sub()) + ((await phase()) === 'end' ? '|end' : '');
        const seq = [await keyNow()];
        const phases = [];
        for (let i = 0; i < info.decisions + info.hands + 2; i++) {
          if (await page.locator('.rv-ctl').nth(3).isDisabled()) break;
          await next();
          await page.waitForTimeout(40);
          phases.push(await phase());
          seq.push(await keyNow());
        }
        const stops = new Set(seq).size;
        if (stops !== info.decisions + info.hands) fail(key, 'stops ' + stops + ' expected ' + (info.decisions + info.hands) + ' (decisions + hand ends)');
        if (phases.filter((p) => p === 'end').length !== info.hands) fail(key, 'hand end cards ' + phases.filter((p) => p === 'end').length + ' expected ' + info.hands);
        if (phases.some((p) => p !== 'before' && p !== 'after' && p !== 'end')) fail(key, 'unexpected phase ' + phases.join(','));
        await page.waitForSelector('.rv-replay[data-phase="after"]').catch(() => null);
        if ((await page.locator('.rv-ctl').nth(3).isDisabled()) !== true) fail(key, 'Next not disabled at the last stop');
        await page.keyboard.press('Home');
        await page.waitForTimeout(160);
        if ((await keyNow()) !== seq[0]) fail(key, 'Home did not go to the first stop');
        await page.waitForSelector('.rv-replay[data-phase="after"]');

        const p1 = await page.evaluate(() => {
          const b = document.querySelector('.rv-coach-head h3');
          return {
            badge: !!document.querySelector('.rv-rate-row .rv-icon'),
            you: !!document.querySelector('.rv-verdict'),
            best: /best|mejor/i.test(document.querySelector('.rv-verdict') ? document.querySelector('.rv-verdict').textContent : ''),
            explain: !!document.querySelector('.rv-explain') && document.querySelector('.rv-explain').textContent.length > 0,
            es: /Jugaste/.test(document.querySelector('.rv-coach').textContent),
            rate: !!document.querySelector('.rv-seat.is-hero .rv-rate'),
            bullets: document.querySelectorAll('.rv-coach ul').length
          };
        });
        if (!p1.badge || !p1.you || !p1.explain || !p1.rate) fail(key, 'decision panel incomplete ' + JSON.stringify(p1));
        if (!p1.best) fail(key, 'verdict has no best move');
        if (p1.bullets) fail(key, 'bullet list in the coach card');
        if (lang === 'es' && !p1.es) fail(key, 'ES panel text missing');
        await shot('first');

        // play one move: next, then the before/after phases
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(40);
        const beforeAfter = await phase();
        await page.waitForSelector('.rv-replay[data-phase="after"]');
        if (beforeAfter !== 'before' && beforeAfter !== 'after') fail(key, 'ArrowRight phase ' + beforeAfter);
        if ((await sub()) === seq[0]) fail(key, 'ArrowRight did not move');

        // previous move returns to the first stop
        await prev();
        if ((await sub()) !== seq[0]) fail(key, 'previous move did not go back');

        // hand navigation: Next hand goes to the first stop of hand 2; Previous hand (at its first stop) goes to hand 1
        await page.locator('.rv-ctl').nth(4).click();
        if (!(await sub()).match(/Hand 2 of|Mano 2 de/)) fail(key, 'Next hand did not reach hand 2: ' + (await sub()));
        await page.locator('.rv-ctl').nth(0).click();
        if (!(await sub()).match(/Hand 1 of|Mano 1 de/)) fail(key, 'Previous hand did not reach hand 1');
        await page.keyboard.press('PageDown');
        if (!(await sub()).match(/Hand 2 of|Mano 2 de/)) fail(key, 'PageDown did not reach hand 2');
        await page.keyboard.press('ArrowUp');
        if (!(await sub()).match(/Hand 1 of|Mano 1 de/)) fail(key, 'ArrowUp did not reach hand 1');
        await page.keyboard.press('ArrowDown');
        if (!(await sub()).match(/Hand 2 of|Mano 2 de/)) fail(key, 'ArrowDown did not reach hand 2');
        await page.keyboard.press('Home');
        await page.keyboard.press('End');
        if ((await page.locator('.rv-ctl').nth(3).isDisabled()) !== true) fail(key, 'End did not reach the last stop');
        await page.keyboard.press('Home');

        // play / pause: Space starts auto-advance over hero moves, Space again pauses
        await page.locator('.rv-ctl-play').click();
        if ((await page.locator('.rv-ctl-play').getAttribute('aria-pressed')) !== 'true') fail(key, 'play did not start');
        const startSub = await sub();
        await page.waitForTimeout(900);
        if ((await sub()) === startSub) fail(key, 'autoplay did not advance');
        await page.keyboard.press('Space');
        if ((await page.locator('.rv-ctl-play').getAttribute('aria-pressed')) !== 'false') fail(key, 'Space did not pause');
        const pausedAt = await sub();
        await page.waitForTimeout(700);
        if ((await sub()) !== pausedAt) fail(key, 'pause did not stop autoplay');

        // timeline click jumps to that hero move
        await page.locator('.rv-tl').nth(2).click();
        const curIdx = await page.evaluate(() => [].indexOf.call(document.querySelectorAll('.rv-tl'), document.querySelector('.rv-tl.is-current')));
        if (curIdx !== 2) fail(key, 'timeline click did not open move 3 (got ' + curIdx + ')');

        // show best move ghost on the table
        await page.locator('.rv-ghostbtn').first().click();
        if (!(await page.evaluate(() => !!document.querySelector('.rv-ghost')))) fail(key, 'best move ghost did not show');
        await page.locator('.rv-ghostbtn').first().click();
        if (await page.evaluate(() => !!document.querySelector('.rv-ghost'))) fail(key, 'best move ghost did not hide');

        // the rating counts in the header jump to a move with that rating (shown from 1000px wide)
        const cnt = page.locator('.rv-counts .rv-count');
        if (await cnt.first().isVisible()) {
          const want = await cnt.first().getAttribute('class');
          const rating = (want.match(/rating-(\w+)/) || [])[1];
          await cnt.first().click();
          const got = await page.evaluate(() => { const c = document.querySelector('.rv-tl.is-current'); return c ? c.getAttribute('data-rating') : null; });
          if (got !== rating) fail(key, 'rating count did not jump to a ' + rating + ' move (got ' + got + ')');
        } else if (vp.w >= 1000) fail(key, 'rating counts hidden on a wide screen');
        await shot('counts');

        await page.locator('.rv-timeline .rv-tl').nth(0).click();
        await page.waitForTimeout(100);
        await shot('end-of-setup');

        // phone: the explanation is visible without scrolling the page; the panel body scrolls inside
        if (vp.phone) {
          // the explanation is reached by scrolling the panel body only (the page never scrolls)
          const visible = await page.evaluate(() => { const e = document.querySelector('.rv-explain'), body = document.querySelector('.rv-coach-body'), pn = document.querySelector('.rv-coach'); if (!e) return false; body.scrollTop = body.scrollHeight; const b = e.getBoundingClientRect(), p = pn.getBoundingClientRect(); body.scrollTop = 0; return b.height > 0 && b.bottom <= p.bottom + 1 && b.top >= p.top - 1; });
          if (!visible) fail(key, 'phone: explanation not visible in the sheet');
        }

        await page.keyboard.press('Escape');
        if (!(await page.evaluate(() => !!window.__closed))) fail(key, 'Escape did not call onClose');
        if (errors.length) fail(key, 'errors: ' + errors.join(' | '));
        results[key] = { stops: stops, decisions: info.decisions, hands: info.hands, overlaps: L.overlaps.length, small: L.small.length, scrollers: L.scrollers, errors: errors.length };
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    srv.close();
  }
  const out = { ok: failures.length === 0, failures: failures, results: results };
  fs.writeFileSync(path.join(SHOTS, 'results.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ok: out.ok, failures: failures, sizes: Object.keys(results) }, null, 2));
  process.exit(out.ok ? 0 : 1);
})().catch((e) => { console.error('e2e-review-ui crashed:', e); process.exit(1); });
