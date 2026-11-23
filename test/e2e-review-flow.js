'use strict';
// End-to-end review flow in real Chrome: exam whole-game review (overlay lists every decision, counts match,
// luck card present, Close returns), practice rating badge after a move, quick-game rating toast with no layout shift.
// Run alone: node test/e2e-review-flow.js. CHROME_PATH overrides the browser location.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].filter(Boolean);
const INDEX = 'file:///' + path.join(__dirname, '..', 'public', 'index.html').replace(/\\/g, '/');
const results = { checks: [], console: [] };
function check(name, ok, info) { results.checks.push({ name, ok: !!ok, info: info === undefined ? null : info }); }

async function setup(browser, size) {
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
  page.setDefaultTimeout(8000);
  page.on('pageerror', (e) => results.console.push({ type: 'pageerror', text: String(e.message || e) }));
  await page.goto(INDEX);
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* ignore */ } });
  await page.reload();
  await page.waitForTimeout(300);
  return page;
}
async function openFmt(p, fmt) {
  const group = fmt === 'table' || fmt === 'mp' ? 'play' : 'practice';
  if (!(await p.isVisible('[data-fmt="' + fmt + '"]'))) await p.click('#hub-' + group);
  await p.click('[data-fmt="' + fmt + '"]');
}
// One hero action when a button is enabled: continue, call/check, else fold. Returns true if it acted.
async function actOnce(p) {
  const callable = (sel) => p.$eval(sel, (b) => b.offsetParent !== null && !b.disabled).catch(() => false);
  if (await callable('#btn-cpu-next')) { await p.click('#btn-cpu-next').catch(() => null); return true; }
  if (await callable('#btn-call')) { await p.click('#btn-call').catch(() => null); return true; }
  if (await callable('#btn-fold')) { await p.click('#btn-fold').catch(() => null); return true; }
  return false;
}

async function examFlow(browser) {
  const page = await setup(browser, [1366, 768]);
  await openFmt(page, 'exam');
  await page.click('#menu-start');
  await page.waitForTimeout(500);
  for (let i = 0; i < 600; i++) {
    const hands = await page.$eval('#xl-hands', (e) => Number(e.textContent)).catch(() => 0);
    if (hands >= 3) break;
    if (!(await actOnce(page))) await page.waitForTimeout(150);
    else await page.waitForTimeout(120);
  }
  await page.click('#btn-finish-exam');
  await page.click('[data-ask="ok"]');
  await page.waitForSelector('#exam-summary:not(.hidden)');
  const sumDec = await page.$eval('#sum-decisions', (e) => Number(e.textContent)).catch(() => -2);
  const decisions = sumDec;
  check('exam: decisions played (summary count)', decisions >= 3, { decisions });
  await page.click('#btn-analysis');
  await page.waitForSelector('#rv-overlay .rv-replay .rv-seat');
  // walk every hand of the exam: the timeline has one marker per hero decision (rated), the hand chips select hands
  const walk = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const sel = document.querySelector('#rv-overlay .rv-hand-select');
    const chips = Array.from(sel ? sel.options : []);
    let heroMarks = 0, rated = 0, panels = 0, boards = 0;
    // the timeline lists every hero move of the exam (one marker each): counted once
    const marks = Array.from(document.querySelectorAll('#rv-overlay .rv-tl'));
    heroMarks = marks.length;
    rated = marks.filter((m) => /rating-/.test(m.className)).length;
    for (let i = 0; i < chips.length; i++) {
      sel.value = String(i);
      sel.dispatchEvent(new Event('change'));
      await sleep(30);
      const coachHead = document.querySelector('#rv-overlay .rv-coach-head'); if (coachHead && coachHead.textContent.trim()) panels++; // every hand has a headline in the coach card
      // a hand with a replay shows 9 seats; a hand without one (the unfinished hand) shows the no-replay note
      boards += document.querySelectorAll('#rv-overlay .rv-seat').length === 9 || document.querySelector('#rv-overlay .rv-notice') ? 1 : 0;
    }
    return { hands: chips.length, heroMarks: heroMarks, rated: rated, panels: panels, tables: boards };
  });
  const info = await page.evaluate(() => ({
    screen: !!document.querySelector('#rv-overlay .rv-replay'),
    hands: document.querySelectorAll('#rv-overlay .rv-hand-select option').length,
    summaryPill: !!document.querySelector('#rv-overlay .rv-acc'),
    closeBtn: !!document.querySelector('#rv-overlay .rv-iconbtn')
  }));
  check('exam review: replay screen rendered with a table of 9 seats (or the no-replay note)', info.screen && walk.tables === info.hands, { info, walk });
  check('exam review: every decision listed on the timeline with a rating', walk.heroMarks === decisions && walk.rated === walk.heroMarks, { walk, decisions });
  check('exam review: the coach card has a headline for each hand', walk.panels === info.hands, { walk });
  check('exam review: accuracy ring and Close buttons present', info.summaryPill && info.closeBtn, info);
  await page.click('#rv-overlay .rv-iconbtn');
  await page.waitForTimeout(200);
  const closed = await page.$('#rv-overlay');
  check('exam review: Close returns to the summary', !closed && await page.isVisible('#exam-summary'), { closed: !!closed });
  await page.close();
}

async function practiceFlow(browser) {
  const page = await setup(browser, [1366, 768]);
  await openFmt(page, 'practice');
  await page.click('#menu-start');
  await page.waitForTimeout(500);
  let shown = false;
  for (let i = 0; i < 200 && !shown; i++) {
    await actOnce(page);
    await page.waitForTimeout(250);
    shown = await page.$eval('#feedback', (f) => !f.classList.contains('hidden')).catch(() => false);
  }
  const badge = await page.$eval('#verdict', (v) => !!v.querySelector('.v-icon svg') && !!v.querySelector('.v-summary') && v.querySelector('.v-summary').textContent.trim().length > 0).catch(() => false); // big rating icon and headline (app.js verdict)
  check('practice: rating icon and headline shown after a move', shown && badge, { shown, badge });
  await page.close();
}

async function quickFlow(browser) {
  const page = await setup(browser, [1366, 768]);
  await openFmt(page, 'table');
  await page.click('#menu-start');
  await page.waitForTimeout(500);
  let toast = false, shift = null;
  for (let i = 0; i < 300 && !toast; i++) {
    const hero = await page.$eval('#btn-call', (b) => b.offsetParent !== null && !b.disabled).catch(() => false);
    if (hero) {
      const before = await page.$eval('#btn-fold', (b) => JSON.stringify(b.getBoundingClientRect())).catch(() => '');
      await page.click('#btn-call').catch(() => null);
      const t0 = Date.now();
      while (Date.now() - t0 < 900) {
        if (await page.$('.rv-toast')) { toast = true; break; }
        await page.waitForTimeout(50);
      }
      if (toast) {
        const after = await page.$eval('#btn-fold', (b) => JSON.stringify(b.getBoundingClientRect())).catch(() => before);
        shift = before === after;
      }
    } else await actOnce(page);
    await page.waitForTimeout(150);
  }
  check('quick: rating toast appears after a hero decision', toast, { toast });
  check('quick: toast causes no layout shift on the action buttons', shift === true, { shift });
  await page.close();
}

(async () => {
  const exe = CANDIDATES.find((p) => fs.existsSync(p));
  if (!exe) throw new Error('No Chrome found. Set CHROME_PATH.');
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  try {
    await examFlow(browser);
    await practiceFlow(browser);
    await quickFlow(browser);
  } finally { await browser.close(); }
  const bad = results.checks.filter((c) => !c.ok);
  results.checks.forEach((c) => console.log((c.ok ? 'ok   ' : 'FAIL ') + c.name + (c.ok ? '' : ' ' + JSON.stringify(c.info))));
  console.log(results.checks.length + ' checks, ' + bad.length + ' failed' + (results.console.length ? ', page errors: ' + results.console.length : ''));
  if (results.console.length) console.log(JSON.stringify(results.console.slice(0, 5)));
  process.exit(bad.length || results.console.length ? 1 : 0);
})().catch((e) => { console.error('e2e-review-flow crashed:', e); process.exit(1); });
