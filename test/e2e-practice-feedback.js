'use strict';
// Single spots (quick) and Practice (hands) feedback in real Chrome (file://, no server): `node test/e2e-practice-feedback.js`.
// Matrix: EN and ES x 1366x768, 1920x1080, 844x390, 390x844, 360x640. Per combo:
//  - the rating icon is big (>= 48 px; >= 56 px on desktop) and the headline is visible;
//  - no raw i18n key (rating.great, you.line, ...) is visible, scanned after every verdict and with the drawer open;
//  - "Full explanation" opens and closes (aria-expanded, Escape, button, click outside) and the drawer lists the text;
//  - the drawer fits the viewport and the page never scrolls (the drawer scrolls inside itself);
//  - F/C/R and OK/Next boxes do not move when the verdict or the drawer opens (0 px);
//  - "Always show full explanation" is stored in localStorage and opens the drawer on the next verdict.
// Practice (hands) steps: CPU result (press n) and hero turn (decide) are handled like e2e-feedback's playHands.
// Exam is scanned for raw keys too. Verdict and drawer screenshots go to SHOTS (default .e2e-shots in the project).
// Env: PLAYS (verdicts per combo, default 3), LANGS, MODES (quick,practice), EXAM=0 to skip the Exam scan.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { openFmt } = require('./helpers/menu');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const INDEX = 'file:///' + path.join(__dirname, '..', 'public', 'index.html').replace(/\\/g, '/');
const PLAYS = Number(process.env.PLAYS || 3);
const SHOTS = process.env.SHOTS || path.join(__dirname, '..', '.e2e-shots');
const SIZES = [[1366, 768], [1920, 1080], [844, 390], [390, 844], [360, 640]];
const LANGS = (process.env.LANGS || 'en,es').split(',');
const MODES = (process.env.MODES || 'quick,practice').split(',');
const RAW_KEY = /^[a-z]+(\.[A-Za-z0-9]+)+$/;
const ALWAYS_KEY = 'pt.fullExplainAlways';
const RECTS = ['btn-fold', 'btn-call', 'btn-raise', 'btn-next'];

async function rects(page) {
  return page.evaluate((ids) => {
    const out = {};
    ids.forEach((id) => {
      const e = document.getElementById(id);
      const b = e ? e.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
      out[id] = [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 10) / 10);
    });
    return out;
  }, RECTS);
}

function maxDelta(a, b) {
  let worst = 0;
  Object.keys(a).forEach((k) => { if (a[k][2] === 0) return; a[k].forEach((v, i) => { worst = Math.max(worst, Math.abs(v - b[k][i])); }); }); // a button absent before (OK/Next) is not a shift
  return worst;
}

// Every visible line of the page (innerText, toasts included); a raw key matches the anchored pattern.
async function rawKeysOnPage(page) {
  const text = await page.evaluate(() => document.body.innerText || '');
  return text.split(/\n|\t/).map((s) => s.trim()).filter((s) => RAW_KEY.test(s));
}

function state(page) {
  return page.evaluate(() => {
    const cpu = document.getElementById('cpu-result');
    return {
      feedback: !document.getElementById('feedback').classList.contains('hidden'),
      cpuNext: !!cpu && !cpu.classList.contains('hidden'),
      heroTurn: !document.getElementById('btn-fold').disabled || !document.getElementById('btn-call').disabled
    };
  });
}

// Advances to the next verdict: CPU results get 'n', a hero decision gets a random legal key.
// Returns the F/C/R/OK rects measured just before the hero key, so the caller can compare after the verdict.
async function advance(page, deadline) {
  let base = null;
  while (Date.now() < deadline) {
    const s = await state(page);
    if (s.feedback) { await page.waitForTimeout(220); return base; }
    if (s.cpuNext) { await page.keyboard.press('n'); await page.waitForTimeout(40); continue; }
    if (s.heroTurn) {
      base = await rects(page);
      const raiseOn = await page.$eval('#btn-raise', (b) => !b.disabled);
      const choices = ['f', 'c'].concat(raiseOn ? ['r'] : []);
      await page.keyboard.press(choices[Math.floor(Math.random() * choices.length)]);
      await page.waitForSelector('#feedback:not(.hidden)', { timeout: 10000 }).catch(() => null);
      continue;
    }
    await page.waitForTimeout(120);
  }
  throw new Error('no verdict before the deadline');
}

async function iconInfo(page) {
  return page.evaluate(() => {
    const svg = document.querySelector('#verdict .v-icon svg');
    const h = document.querySelector('#verdict .v-summary');
    const r = svg ? svg.getBoundingClientRect() : null;
    const hr = h ? h.getBoundingClientRect() : null;
    return {
      size: r ? Math.round(Math.min(r.width, r.height)) : 0,
      head: h ? h.textContent.trim() : '',
      headVisible: !!hr && hr.width > 0 && hr.height > 0
    };
  });
}

// The drawer box fits the viewport, and neither the page nor the body scrolls.
async function layoutInfo(page) {
  return page.evaluate(() => {
    const box = document.querySelector('#fx-drawer .fx-box');
    const b = box ? box.getBoundingClientRect() : null;
    const se = document.scrollingElement;
    return {
      inside: !!b && b.left >= -0.5 && b.top >= -0.5 && b.right <= innerWidth + 0.5 && b.bottom <= innerHeight + 0.5,
      pageScroll: window.scrollY > 0 || se.scrollWidth > se.clientWidth + 1 || se.scrollHeight > se.clientHeight + 1
    };
  });
}

async function shot(page, name) {
  try {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, name + '.png') });
  } catch (e) { /* screenshots are for looking at, not a pass criterion */ }
}

async function runCombo(browser, w, h, lang, mode, fails, report) {
  const tag = lang + ' ' + mode + ' ' + w + 'x' + h;
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  await page.goto(INDEX);
  await page.evaluate((l) => { localStorage.clear(); localStorage.setItem('poker-trainer:lang:v1', l); }, lang);
  await page.reload();
  await page.click('#btn-home');
  await openFmt(page, mode);
  await page.click('#menu-start');
  const deadline = Date.now() + 120000;

  let maxSeen = 0;
  let info = null;
  for (let i = 0; i < PLAYS; i++) {
    const base = await advance(page, deadline);
    if (base) maxSeen = Math.max(maxSeen, maxDelta(base, await rects(page)));
    info = await iconInfo(page);
    const min = w > 700 && h > 500 ? 56 : 48; // design: 64 px desktop, 48 px phone portrait and phone landscape
    if (info.size < min) fails.push(tag + ' icon ' + info.size + 'px < ' + min);
    if (!info.headVisible || !info.head) fails.push(tag + ' headline not visible');
    const raw = await rawKeysOnPage(page);
    if (raw.length) fails.push(tag + ' raw key visible: ' + raw.join(', '));
    if (i === 0) await shot(page, tag.replace(/ /g, '-') + '-verdict');
    if (i < PLAYS - 1) {
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.getElementById('feedback').classList.contains('hidden'), null, { timeout: 5000 });
    }
  }

  // Full explanation on the last verdict: the visible button opens, Escape closes; reopen; a click outside closes.
  const before = await rects(page);
  const btnId = await page.evaluate(() => {
    const vis = (id) => { const e = document.getElementById(id); return !!e && e.offsetParent !== null; };
    return ['fb-full', 'btn-more', 'fb-more-strip'].filter(vis)[0] || null;
  });
  if (!btnId) fails.push(tag + ' no visible Full explanation button');
  const label = btnId ? await page.$eval('#' + btnId, (b) => b.textContent.trim()) : '';
  const expected = lang === 'es' ? 'Explicación completa' : 'Full explanation';
  if (btnId && label !== expected) fails.push(tag + ' button label "' + label + '" != "' + expected + '"');
  if (btnId) await page.click('#' + btnId);
  await page.waitForSelector('#fx-drawer:not(.hidden)', { timeout: 3000 }).catch(() => fails.push(tag + ' drawer did not open'));
  await page.waitForTimeout(200);
  const lines = await page.evaluate(() => document.querySelectorAll('#fx-body .fx-line').length);
  const expanded = btnId ? await page.$eval('#' + btnId, (b) => b.getAttribute('aria-expanded')) : null;
  if (expanded !== 'true') fails.push(tag + ' aria-expanded not true when open');
  if (lines < 1) fails.push(tag + ' drawer has no lines');
  const shiftOpen = maxDelta(before, await rects(page));
  if (shiftOpen > 0.5) fails.push(tag + ' F/C/R/OK moved by ' + shiftOpen + 'px when the drawer opened');
  const lay = await layoutInfo(page);
  if (!lay.inside) fails.push(tag + ' drawer box outside the viewport');
  if (lay.pageScroll) fails.push(tag + ' the page scrolls while the drawer is open');
  const rawOpen = await rawKeysOnPage(page);
  if (rawOpen.length) fails.push(tag + ' raw key in drawer: ' + rawOpen.join(', '));
  await shot(page, tag.replace(/ /g, '-') + '-drawer');

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('fx-drawer').classList.contains('hidden'), null, { timeout: 2000 })
    .catch(() => fails.push(tag + ' Escape did not close the drawer'));
  if (btnId) await page.click('#' + btnId);
  await page.waitForSelector('#fx-drawer:not(.hidden)', { timeout: 3000 }).catch(() => fails.push(tag + ' reopen failed'));
  await page.mouse.click(4, 4);
  await page.waitForFunction(() => document.getElementById('fx-drawer').classList.contains('hidden'), null, { timeout: 2000 })
    .catch(() => fails.push(tag + ' outside click did not close the drawer'));

  // "Always show full explanation": stored, and the next verdict opens the drawer by itself.
  if (btnId) await page.click('#' + btnId);
  await page.click('label.fx-always');
  const stored = await page.evaluate((k) => localStorage.getItem(k), ALWAYS_KEY);
  if (stored !== '1') fails.push(tag + ' always-show not stored (' + stored + ')');
  await page.click('#fx-close');
  // After closing, focus is on the primary OK/Next button (not Full explanation), so Enter continues the hand.
  const focusAfterClose = await page.evaluate(() => (document.activeElement && document.activeElement.id) || '');
  if (focusAfterClose !== 'btn-next') fails.push(tag + ' focus after closing the drawer is "' + focusAfterClose + '", not btn-next');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('feedback').classList.contains('hidden'), null, { timeout: 5000 });
  await advance(page, deadline);
  await page.waitForSelector('#fx-drawer:not(.hidden)', { timeout: 3000 })
    .catch(() => fails.push(tag + ' always-show did not open the drawer'));
  await page.evaluate((k) => localStorage.removeItem(k), ALWAYS_KEY);
  if (errors.length) fails.push(tag + ' page errors: ' + errors.join(' | '));
  report.push({ tag: tag, icon: info && info.size, headline: info && info.head, maxShift: maxSeen, drawerShift: shiftOpen });
  await page.close();
}

// Exam: no verdict on every decision, but its visible text must never show a raw key.
async function scanExam(browser, w, h, lang, fails) {
  const tag = 'exam ' + lang + ' ' + w + 'x' + h;
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  await page.goto(INDEX);
  await page.evaluate((l) => { localStorage.clear(); localStorage.setItem('poker-trainer:lang:v1', l); }, lang);
  await page.reload();
  await page.click('#btn-home');
  await openFmt(page, 'exam');
  await page.click('#menu-start');
  const deadline = Date.now() + 60000;
  for (let i = 0; i < 6 && Date.now() < deadline; i++) {
    const s = await state(page);
    const raw = await rawKeysOnPage(page);
    if (raw.length) fails.push(tag + ' raw key visible: ' + raw.join(', '));
    if (s.feedback) await page.keyboard.press('Enter');
    else if (s.cpuNext) await page.keyboard.press('n');
    else if (s.heroTurn) await page.keyboard.press('c');
    await page.waitForTimeout(300);
  }
  if (errors.length) fails.push(tag + ' page errors: ' + errors.join(' | '));
  await page.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const fails = [];
  const report = [];
  try {
    for (const [w, h] of SIZES) {
      for (const lang of LANGS) {
        for (const mode of MODES) {
          await runCombo(browser, w, h, lang, mode, fails, report)
            .catch((e) => fails.push(lang + ' ' + mode + ' ' + w + 'x' + h + ' aborted: ' + String(e.message || e).split('\n')[0]));
        }
      }
    }
    if (process.env.EXAM !== '0') {
      for (const lang of LANGS) await scanExam(browser, 1366, 768, lang, fails);
    }
  } finally {
    await browser.close();
  }
  report.forEach((r) => console.log(JSON.stringify(r)));
  console.log(fails.length ? 'FAIL ' + fails.length + '\n' + fails.join('\n') : 'PASS practice feedback (' + report.length + ' combos + exam scan)');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
