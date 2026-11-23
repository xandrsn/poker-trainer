'use strict';
// Main menu hub: options are revealed by their group's main tile (Play or Practice) first.
async function openFmt(p, fmt) {
  const group = fmt === 'table' || fmt === 'mp' ? 'play' : 'practice';
  if (!(await p.isVisible('[data-fmt="' + fmt + '"]'))) await p.click('#hub-' + group);
  await p.click('[data-fmt="' + fmt + '"]');
}

// End-to-end scroll and layout check of the solo UI in real Chrome (system install, driven by playwright-core).
// Not part of `npm test`: run with `npm run e2e:solo`. CHROME_PATH overrides the browser location.
// Writes results to e2e-solo-results.json and screenshots to E2E_SHOTS (default ./.e2e-shots/solo).
//
// For every screen at every size it checks: the document is no taller or wider than the viewport
// (scrollHeight <= innerHeight, scrollWidth <= innerWidth), and it lists any scroll container that
// scrolls inside the page (only drawers and panels may, and only when their content truly needs it).
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean);
const SHOTS = process.env.E2E_SHOTS || path.join(__dirname, '..', '.e2e-shots', 'solo');
const INDEX = 'file:///' + path.join(__dirname, '..', 'public', 'index.html').replace(/\\/g, '/');
const SIZES = [[1366, 768], [1536, 730], [1920, 937], [390, 700]];

const results = { checks: [], screens: [], console: [] };
function check(name, ok, info) { results.checks.push({ name, ok: !!ok, info: info === undefined ? null : info }); }

function findChrome() {
  const hit = CANDIDATES.find((p) => fs.existsSync(p));
  if (!hit) throw new Error('No Chrome/Edge found. Set CHROME_PATH.');
  return hit;
}

// Document metrics plus every element that scrolls on its own (with its owning panel name).
async function measure(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const scrollers = [];
    document.querySelectorAll('body *').forEach((el) => {
      const cs = getComputedStyle(el);
      if (!/(auto|scroll)/.test(cs.overflowY)) return;
      if (el.scrollHeight <= el.clientHeight + 1) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const panel = el.closest('.drawer, .sheet, .sidebar, .menu-view, #practice-area, .main-col, .layout') || null;
      scrollers.push({
        tag: el.tagName.toLowerCase(), id: el.id || '', cls: String(el.className || '').slice(0, 60),
        panel: panel ? (panel.id || panel.className.split(' ')[0]) : 'page',
        over: el.scrollHeight - el.clientHeight
      });
    });
    return {
      innerW: window.innerWidth, innerH: window.innerHeight,
      docW: de.scrollWidth, docH: de.scrollHeight,
      scrollers
    };
  });
}

// Records a screen: checks the document fits, notes panel scrolling, saves a screenshot.
async function screen(page, name, size) {
  await page.waitForTimeout(450); // let entrance animations settle
  const m = await measure(page);
  const fitsH = m.docH <= m.innerH + 1;
  const fitsW = m.docW <= m.innerW + 1;
  const pageScrollers = m.scrollers.filter((s) => s.panel === 'page');
  const label = name + ' @' + size[0] + 'x' + size[1];
  results.screens.push({ screen: label, docH: m.docH, innerH: m.innerH, docW: m.docW, innerW: m.innerW, scrollers: m.scrollers });
  check(label + ': no vertical page scroll', fitsH, { docH: m.docH, innerH: m.innerH });
  check(label + ': no horizontal overflow', fitsW, { docW: m.docW, innerW: m.innerW });
  check(label + ': only panels scroll', pageScrollers.length === 0, pageScrollers);
  const file = path.join(SHOTS, name.replace(/[^a-z0-9]+/gi, '-') + '-' + size[0] + 'x' + size[1] + '.png');
  await page.screenshot({ path: file });
  return file;
}

async function setup(browser, size) {
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
  page.setDefaultTimeout(8000); // a missing element fails fast instead of waiting 30 s
  page.on('pageerror', (e) => results.console.push({ size, type: 'pageerror', text: String(e.message || e) }));
  page.on('console', (msg) => { if (msg.type() === 'error') results.console.push({ size, type: 'console', text: msg.text() }); });
  await page.goto(INDEX);
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* ignore */ } });
  await page.reload();
  await page.waitForTimeout(300);
  return page;
}

async function runSize(browser, size) {
  const page = await setup(browser, size);
  const tag = size[0] + 'x' + size[1];
  // 1. main menu (first screen)
  await screen(page, 'menu', size);
  // 2. menu settings for each mode, then play
  for (const [name, click] of [
    ['full-hands', 'practice'],
    ['quick-spots', 'quick']
  ]) {
    await openFmt(page, click); // the mode card sits under its hub tile (menu-hub.css)
    await screen(page, 'menu-settings-' + name, size);
    await page.click('#menu-start');
    await page.waitForTimeout(400);
    await screen(page, 'game-' + name, size);
    await page.click('#btn-back'); if (await page.isVisible('#leave-pop')) await page.click('#leave-go'); // live hand: confirm leaving
  }
  // exam: the exam card
  await openFmt(page, 'exam');
  await screen(page, 'menu-settings-exam', size);
  await page.click('#menu-start');
  await page.waitForTimeout(400);
  await screen(page, 'game-exam', size);
  // 3. feedback after an action (full hands): fold or call once the hero can act
  await page.waitForFunction(() => {
    const b = document.getElementById('btn-call');
    return b && !b.disabled && document.body.dataset.view === 'game';
  }, null, { timeout: 15000 }).catch(() => null);
  if (await page.$eval('#btn-call', (b) => !b.disabled).catch(() => false)) {
    await page.click('#btn-call');
    await page.waitForTimeout(350);
    await screen(page, 'game-feedback-exam', size);
  }
  await page.click('#btn-back'); if (await page.isVisible('#leave-pop')) await page.click('#leave-go'); // live hand: confirm leaving
  // 4. ranges and progress drawers from a fresh practice game
  await openFmt(page, 'practice');
  await page.click('#menu-start');
  await page.waitForTimeout(400);
  await page.click('#btn-ranges');
  await screen(page, 'ranges-drawer', size);
  await page.keyboard.press('Escape'); // closes the Ranges drawer
  // statistics, rules and settings are opened from the menu only (no in-game tabs)
  await page.click('#btn-back'); if (await page.isVisible('#leave-pop')) await page.click('#leave-go');
  await page.click('#menu-card-progress');
  await screen(page, 'progress-sheet', size);
  await page.click('.sheet:not(.hidden) .sheet-close');
  await page.click('#menu-card-rules');
  await screen(page, 'rules-sheet', size);
  await page.click('.sheet:not(.hidden) .sheet-close');
  await page.click('#btn-settings');
  await screen(page, 'settings-panel', size);
  await page.click('#btn-settings-close');
  await page.close();
  return tag;
}

// Raise amount controls exist only in the Quick game (table). Single spots, Practice and Exam show only F/C/R.
async function runRaiseScope(browser) {
  const modes = [['quick', 'single spots'], ['practice', 'practice'], ['exam', 'exam']];
  for (const [fmt, name] of modes) {
    const page = await setup(browser, [1366, 768]);
    await openFmt(page, fmt);
    await page.click('#menu-start');
    await page.waitForTimeout(400);
    await page.waitForFunction(() => { const b = document.getElementById('btn-call'); return b && !b.disabled; }, null, { timeout: 15000 }).catch(() => null);
    const info = await page.evaluate(() => {
      const c = document.getElementById('raise-ctl');
      const r = (id) => { const b = document.getElementById(id); return b ? Math.round(b.getBoundingClientRect().top) : null; };
      return { ctlDisplay: c ? getComputedStyle(c).display : 'missing', fcrTop: [r('btn-fold'), r('btn-call'), r('btn-raise')] };
    });
    check(name + ': no raise amount controls', info.ctlDisplay === 'none', info);
    await page.close();
  }
}

// Exam: no fixed sidebar; the right drawer is closed by default (parked off-screen) and opened by #btn-right.
// Practice keeps its sidebar.
async function runExamSide(browser) {
  for (const size of [[1366, 768], [390, 844]]) {
    const tag = size[0] + 'x' + size[1];
    for (const fmt of ['exam', 'practice']) {
      const page = await setup(browser, size);
      await openFmt(page, fmt);
      await page.click('#menu-start');
      await page.waitForTimeout(400);
      const info = await page.evaluate(() => {
        const s = document.getElementById('sidebar-right');
        const b = document.getElementById('btn-ranges');
        const shown = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
        const r = s ? s.getBoundingClientRect() : null;
        return { sidebar: !!r && r.left < window.innerWidth - 1, drawerClosed: !!r && r.left >= window.innerWidth - 1, toggle: shown(b) };
      });
      if (fmt === 'exam') {
        check('exam ' + tag + ': no ranges drawer or toggle during hands', info.drawerClosed && !info.toggle, info);
      } else {
        check('practice ' + tag + ': Ranges drawer toggle kept, drawer closed by default', info.toggle && !info.sidebar, info);
      }
      await page.close();
    }
  }
}

// Quick game: a custom raise amount is the bet placed, and the in-game settings tab is not offered.
// Volume slider in the menu (persists across reload) and the hero turn indicator in a quick game.
async function runVolumeAndTurn(browser) {
  const page = await setup(browser, [1366, 768]);
  await openFmt(page, 'quick');
  await page.click('#btn-settings'); // volume lives in the header settings panel now
  const sliders = await page.$$eval('input[data-sound-volume]', (xs) => xs.length);
  check('menu: volume slider present', sliders >= 1, { sliders });
  const labelled = await page.$eval('input[data-sound-volume]', (i) => !!(i.getAttribute('aria-label') || '').trim()).catch(() => false);
  check('menu: volume slider has an aria-label', labelled);
  await page.evaluate(() => {
    const i = document.querySelector('input[data-sound-volume]');
    i.value = '35';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const stored = await page.evaluate(() => localStorage.getItem('poker-trainer:volume'));
  check('volume: change is persisted (poker-trainer:volume)', stored === '35', { stored });
  await page.reload();
  await page.click('#btn-settings');
  const back =await page.$eval('input[data-sound-volume]', (i) => i.value).catch(() => null);
  check('volume: value persists across reload', back === '35', { back });
  await page.evaluate(() => { const i = document.querySelector('input[data-sound-volume]'); i.value = '0'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.evaluate(() => { const i = document.querySelector('input[data-sound-volume]'); i.value = '60'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.reload(); // clean menu (no mode card open) before the table game
  await openFmt(page, 'table');
  await page.click('#menu-start');
  const turned = await page.waitForFunction(() => document.body.classList.contains('turn-hero') && !!document.querySelector('.seat.hero.to-act'), null, { timeout: 30000 })
    .then(() => true).catch(() => false);
  check('turn: hero seat has to-act and body.turn-hero while it is the hero\'s turn', turned);
  if (turned) {
    const shadow = await page.$eval('#actions', (a) => getComputedStyle(a).boxShadow).catch(() => 'none');
    check('turn: action bar carries the accent underglow', shadow !== 'none', { shadow });
  }
  await page.close();
}

async function runQuickGame(browser) {
  const page = await setup(browser, [1366, 768]);
  await openFmt(page, 'table');
  await page.click('#menu-start');
  await page.waitForTimeout(400);
  const tabHidden = await page.evaluate(() => { const b = document.getElementById('btn-settings-tab'); return !b || getComputedStyle(b).display === 'none'; });
  check('quick game: settings tab not offered in-game', tabHidden);
  await page.waitForFunction(() => { const b = document.getElementById('btn-raise'); return b && !b.disabled; }, null, { timeout: 30000 }).catch(() => null);
  const canRaise = await page.$eval('#btn-raise', (b) => !b.disabled).catch(() => false);
  check('quick game: hero can raise', canRaise);
  const ctlShown = await page.$eval('#raise-ctl', (c) => getComputedStyle(c).display !== 'none').catch(() => false);
  check('quick game: raise amount controls present', ctlShown);
  if (canRaise) {
    await page.fill('#raise-num', '3.5');
    await page.dispatchEvent('#raise-num', 'input');
    await page.dispatchEvent('#raise-num', 'change');
    // The number box shows the clamped amount once it is left, and the button names the same amount.
    const chosen = await page.$eval('#raise-num', (n) => n.value);
    const label = await page.textContent('#raise-label');
    check('quick game: raise label names the chosen amount', label.indexOf(chosen) >= 0, { chosen, label });
    await page.click('#btn-raise');
    const bet = await page.waitForFunction((want) => {
      const c = document.querySelector('.bet-chip[data-idx="0"]');
      return !!c && c.textContent.trim() === want;
    }, chosen, { timeout: 4000 }).then(() => chosen).catch(() => null);
    check('quick game: custom raise places a bet equal to the chosen amount', bet === chosen, { chosen });
  }
  await page.close();
}

// Progressive blinds: after 10 hands the blinds double between hands. The hero stack shown in BB halves
// (same chips, bigger BB), the notice appears, and the blind label names the new BB unit. Plays by folding.
async function runBlindDoubling(browser) {
  const page = await setup(browser, [1366, 768]);
  await openFmt(page, 'table');
  await page.check('#menu-prog');
  // 1000 BB start: nobody can bust before hand 10 (a short stack made a bot leave at hand ~7 and the test flaky)
  await page.fill('#menu-stack', '1000');
  await page.dispatchEvent('#menu-stack', 'change');
  await page.click('#menu-start');
  const handNo = () => page.$eval('#hand-info', (e) => { const m = /(?:hand|mano) (\d+)/.exec(e.textContent); return m ? Number(m[1]) : 0; }).catch(() => 0);
  const heroStack = () => page.$eval('.seat.hero .seat-stack', (e) => parseFloat(e.textContent)).catch(() => NaN);
  const noticeShown = () => page.$eval('#table-notice', (e) => !e.classList.contains('hidden') ? e.textContent : '').catch(() => '');
  const clickable = (sel) => page.$eval(sel, (b) => b.offsetParent !== null && !b.disabled).catch(() => false);
  let before = NaN, after = NaN, notice = '', info = '';
  for (let guard = 0; guard < 900 && !notice; guard++) {
    const n = await handNo();
    notice = await noticeShown();
    // the last stack shown in the old BB unit (after hand 10, before the deal that doubles)
    if (!notice && n >= 10) { const v = await heroStack(); if (isFinite(v)) before = v; }
    if (notice) { after = await heroStack(); info = await page.textContent('#hand-info'); break; }
    if (await clickable('#btn-cpu-next')) { await page.click('#btn-cpu-next').catch(() => null); }
    else if (await clickable('#btn-fold')) { await page.click('#btn-fold').catch(() => null); }
    else if (await clickable('#btn-call')) { await page.click('#btn-call').catch(() => null); }
    await page.waitForTimeout(120);
  }
  check('blinds: doubling notice appears after 10 hands', /Blinds doubled|Ciegas duplicadas/.test(notice), { notice });
  check('blinds: blind label names the new BB unit', /1 BB = 2 (original BB|BB originales)/.test(info), { info });
  // same chips: twice the BB count now, less the hand-11 blinds the hero may have posted (at most 1 new BB)
  const ok = isFinite(before) && isFinite(after) && before > 40 && Math.abs(after - before / 2) <= 1.5;
  check('blinds: hero stack in BB halves, chips unchanged', ok, { before, after });
  await page.close();
}

// Exam: after each hand the end-of-hand panel lists one % per round the hero acted in, then the average.
async function runExamRounds(browser) {
  const page = await setup(browser, [1366, 768]);
  await openFmt(page, 'exam');
  await page.click('#menu-start');
  await page.waitForTimeout(800);
  const panels = [];
  for (let i = 0; i < 40 && panels.length < 2; i++) {
    const shown = await page.$eval('#cpu-result', (el) => getComputedStyle(el).display !== 'none').catch(() => false);
    if (shown) {
      panels.push(await page.$$eval('#cpu-result-lines li', (ls) => ls.map((l) => l.innerText.trim())));
      await page.click('#btn-cpu-next').catch(() => null);
      await page.waitForTimeout(300);
      continue;
    }
    const callable = await page.$eval('#btn-call', (b) => !b.disabled).catch(() => false);
    if (callable) await page.click('#btn-call').catch(() => null);
    await page.waitForTimeout(500);
  }
  const roundRe = /^(Preflop|Flop|Turn|River) \d{1,3}%$/;
  const avgRe = /^(Average|Media) \d{1,3}%$/;
  const ok = panels.length >= 1 && panels.every((p) => p.length >= 2 && p.slice(0, -1).every((l) => roundRe.test(l)) && avgRe.test(p[p.length - 1]));
  check('exam: end-of-hand panel lists a % per round and the average', ok, { panels });
  await page.close();
}

// Showdown (Practice, EN and ES): the hero calls every decision until a hand reaches showdown. Then the winner
// plate is gold, the result lists the pot and a hand name for each live hand, and the best five are marked.
async function runShowdown(browser) {
  for (const lang of ['en', 'es']) {
    const page = await setup(browser, [1366, 768]);
    await page.evaluate((l) => { localStorage.setItem('poker-trainer:lang:v1', l); }, lang);
    await page.reload(); await page.waitForTimeout(300);
    await openFmt(page, 'practice'); await page.click('#menu-start'); await page.waitForTimeout(400);
    let found = false;
    for (let i = 0; i < 300 && !found; i++) {
      const st = await page.evaluate(() => {
        const vis = (id) => { const e = document.getElementById(id); return !!e && e.offsetParent !== null && !e.disabled; };
        const res = document.getElementById('cpu-result');
        const act = vis('btn-call') ? 'call' : vis('btn-next') ? 'next' : vis('btn-cpu-next') ? 'cpu-next' : '';
        if (act === 'call') document.getElementById('btn-call').click();
        else if (act === 'next') document.getElementById('btn-next').click();
        else if (act === 'cpu-next') document.getElementById('btn-cpu-next').click();
        return !!res && !res.classList.contains('hidden') && document.querySelectorAll('.seat.winner').length > 0;
      });
      if (st) { found = true; break; }
      await page.waitForTimeout(350);
    }
    await page.waitForTimeout(2500); // the board and the winner glow settle
    const info = await page.evaluate(() => {
      const res = document.getElementById('cpu-result');
      const lines = [...res.querySelectorAll('li')].map((li) => li.textContent.trim());
      return {
        winnerPlate: document.querySelectorAll('.seat.winner').length,
        winnerCards: document.querySelectorAll('.seat.winner .mini-cards .card').length,
        bestMarked: document.querySelectorAll('.card.best').length,
        pot: lines.some((x) => /^(Pot|Bote) /.test(x)),
        handNamed: lines.some((x) => /(Two pair|Pair of|Doble pareja|Pareja de|Carta alta|High card|Three of|Trío|Straight|Escalera|Flush|Color|Full house|Four of|Póker|Straight flush|Escalera de color)/i.test(x))
      };
    });
    const tag = '[' + lang + ']';
    check('showdown ' + tag + ': a hand reaches showdown', found, info);
    check('showdown ' + tag + ': winner plate highlighted', info.winnerPlate > 0, info);
    check('showdown ' + tag + ': winner hole cards revealed', info.winnerCards >= 2, info);
    check('showdown ' + tag + ': best five marked on board and hole cards', info.bestMarked >= 3, info);
    check('showdown ' + tag + ': pot line in the result', info.pot, info);
    check('showdown ' + tag + ': hand name in the result', info.handNamed, info);
    await page.close();
  }
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ['--allow-file-access-from-files'] });
  try {
    for (const size of SIZES) await runSize(browser, size);
    await runQuickGame(browser);
    await runBlindDoubling(browser);
    await runRaiseScope(browser);
    await runExamSide(browser);
    await runExamRounds(browser);
    await runVolumeAndTurn(browser);
    await runShowdown(browser);
  } finally {
    await browser.close();
  }
  const bad = results.checks.filter((c) => !c.ok);
  const errors = results.console.filter((c) => c.type === 'pageerror');
  check('no uncaught page errors', errors.length === 0, errors.slice(0, 5));
  fs.writeFileSync(path.join(__dirname, '..', 'e2e-solo-results.json'), JSON.stringify(results, null, 2));
  console.log(results.checks.length + ' checks, ' + bad.length + ' failed, screenshots in ' + SHOTS);
  bad.forEach((c) => console.log('FAIL ' + c.name + ' ' + JSON.stringify(c.info)));
  process.exitCode = bad.length ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
