const { openFmt } = require('./helpers/menu');
// Real-browser layout test of the solo table against a running server (default http://localhost:3000).
// Usage: node test/smoke-solo.js [baseUrl]     (one headless Chrome, runs in sequence, then closed)
// Runs: 2, 5 and 9 players at 844x390, 1024x600, 1280x720, 390x844, 360x640, 1366x768 and 1920x937,
// plus 8 players at 1366x768. Each run plays at least 6 decisions (the feedback popup each time).
// After every decision it measures (getBoundingClientRect) and checks:
//   - no two of these overlap by more than 1px: seat boxes, bet chips, pot, board cards, hero cards,
//     the feedback popup (when shown) and the action row (the dock);
//   - the seats, chips, pot and board are inside the table, and every measured item is inside the viewport;
//   - no measured item is clipped by an overflow ancestor;
//   - F/C/R never move; the page never scrolls; no JS errors.
// Screenshots of the first popup of each run go to .e2e-shots (r8-<w>x<h>-<n>p.png).
const { chromium } = require('playwright-core');
const path = require('path');
const BASE = process.argv[2] || 'http://localhost:3000';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOTS = path.join(__dirname, '..', '.e2e-shots');
const SIZES = [[844, 390], [1024, 600], [1280, 720], [390, 844], [360, 640], [1366, 768], [1920, 937], [1920, 1080]];
const RUNS = [];
for (const [w, h] of SIZES) for (const n of [2, 5, 9]) RUNS.push({ w, h, players: n });
RUNS.push({ w: 1366, h: 768, players: 8 });
const ONLY = process.env.SMOKE_ONLY; // e.g. SMOKE_ONLY=390x844:9
const ONLY_SET = ONLY ? ONLY.split(',') : null; // e.g. SMOKE_ONLY=390x844:9,360x640:9
const RUN_LIST = ONLY_SET ? RUNS.filter((r) => ONLY_SET.indexOf(r.w + 'x' + r.h + ':' + r.players) >= 0) : RUNS;
if (RUN_LIST.length === 0) { console.log('no run matches SMOKE_ONLY=' + ONLY); process.exit(2); }
const MIN_DECISIONS = 6;
const results = [];
const note = (ok, msg) => { results.push(ok); console.log((ok ? 'ok   ' : 'FAIL ') + msg); };

// a click on the element itself (no actionability waits: the page is often busy when several tests run)
const domClick = (p, sel) => p.evaluate((q) => { const e = document.querySelector(q); if (e && !e.disabled) e.click(); }, sel);

// runs inside the page: every visible item with its box, then the checks
const measureInPage = () => {
  const vis = (el) => {
    if (!el) return false;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom }; };
  const items = [];
  const add = (kind, label, el) => { if (vis(el)) items.push({ kind, label, el, b: box(el) }); };
  document.querySelectorAll('#seats .seat').forEach((el, i) => add('seat', 'seat' + i + '(' + (el.querySelector('.seat-name') || {}).textContent + ')', el));
  document.querySelectorAll('#bets .bet-chip').forEach((el, i) => add('chip', 'chip' + i, el));
  add('pot', 'pot', document.getElementById('pot'));
  document.querySelectorAll('#board .card').forEach((el, i) => add('board', 'board' + i, el));
  document.querySelectorAll('#hero-cards .card').forEach((el, i) => add('hero', 'hero' + i, el));
  const fb = document.getElementById('feedback');
  if (fb && !fb.classList.contains('expanded')) add('popup', 'popup', fb);
  add('dock', 'dock', document.getElementById('actions'));
  const hit = (a, b) => Math.min(a.r, b.r) - Math.max(a.x, b.x) > 1 && Math.min(a.b, b.b) - Math.max(a.y, b.y) > 1;
  const pairs = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (hit(items[i].b, items[j].b)) pairs.push(items[i].label + ' x ' + items[j].label);
    }
  }
  const vw = innerWidth, vh = innerHeight;
  const outside = items.filter((it) => it.b.x < -1 || it.b.y < -1 || it.b.r > vw + 1 || it.b.b > vh + 1).map((it) => it.label);
  const tb = box(document.getElementById('table'));
  const inTable = items.filter((it) => ['seat', 'chip', 'pot', 'board'].indexOf(it.kind) >= 0)
    .filter((it) => it.b.x < tb.x - 1 || it.b.y < tb.y - 1 || it.b.r > tb.r + 1 || it.b.b > tb.b + 1).map((it) => it.label);
  const clipped = [];
  items.forEach((it) => {
    for (let p = it.el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const pb = box(p);
      if (it.b.x < pb.x - 1 || it.b.y < pb.y - 1 || it.b.r > pb.r + 1 || it.b.b > pb.b + 1) {
        clipped.push(it.label + ' by ' + (p.id || p.className));
        break;
      }
    }
  });
  const scroll = document.documentElement.scrollHeight <= vh + 1 && document.documentElement.scrollWidth <= vw + 1;
  return {
    seatCount: document.querySelectorAll('#seats .seat').length,
    popup: items.some((it) => it.kind === 'popup'),
    level: document.getElementById('table').className,
    pairs, outside, inTable, clipped, scroll,
    count: items.length
  };
};

async function runOne(browser, run, totals) {
  const { w, h, players } = run;
    const tag = w + 'x' + h + '/' + players + 'p';
    console.log('--- ' + tag);
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    // saved settings: exactly this many players, random position, all personalities, equal stacks
    await ctx.addInitScript((n) => {
      try {
        localStorage.setItem('poker-trainer:settings:v2', JSON.stringify({
          pmin: n, pmax: n, position: 'random', street: 'any', stack: 100,
          ranges: { spots: { pmin: n, pmax: n }, practice: { pmin: n, pmax: n }, exam: { pmin: n, pmax: n }, table: { pmin: n, pmax: n } },
          personalities: ['tight', 'loose', 'aggressive', 'passive', 'balanced'], stacks: 'equal', customStacks: [], money: false
        }));
      } catch (e) { /* storage blocked */ }
    }, players);
    ctx.setDefaultTimeout(15000);
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_|favicon/.test(m.text())) errs.push('console: ' + m.text()); });
    await p.goto(BASE, { waitUntil: 'load' });
    await p.waitForTimeout(800);
    const view = () => p.evaluate(() => document.body.dataset.view);
    const scrollOk = () => p.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth + 1);

    note((await view()) === 'menu', tag + ' starts on the menu');
    await openFmt(p, 'practice'); await p.waitForTimeout(300);
    const startVisible = await p.evaluate(() => { const r = document.getElementById('menu-start').getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.top >= -1; });
    note(startVisible, tag + ' Play button fully visible');
    await p.click('#menu-start'); await p.waitForTimeout(1500);
    note((await view()) === 'game', tag + ' Play opens the game view');
    note(await scrollOk(), tag + ' game view does not scroll');

    const rect = () => p.evaluate(() => ['btn-fold', 'btn-call', 'btn-raise'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return [id, Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(','); }).join('|'));
    const baseline = await rect();
    const agg = { pairs: [], outside: [], inTable: [], clipped: [], scrollFail: 0, moved: 0, decisions: 0, popups: 0, maxSeats: 0, seatMismatch: 0, levels: new Set() };
    let shot = false;
    for (let i = 0; i < 40 && agg.decisions < MIN_DECISIONS + 2; i++) {
      const enabled = await p.evaluate(() => { const b = document.getElementById('btn-call'); return !!b && !b.disabled && b.offsetParent !== null; });
      if (enabled) {
        await domClick(p, i % 4 === 3 ? '#btn-raise' : '#btn-call');
        agg.decisions++;
      }
      await p.waitForTimeout(1300); // deal, chip slide and popup animations finish
      const m = await p.evaluate(measureInPage);
      if (m.seatCount !== players) { agg.seatMismatch++; console.log('seat mismatch ' + tag + ' step ' + i + ': ' + m.seatCount + ' seats'); }
      agg.maxSeats = Math.max(agg.maxSeats, m.seatCount);
      agg.levels.add(m.level.replace('table', '').trim() || 'full');
      if (m.pairs.length) agg.pairs.push(...m.pairs.map((s) => i + ': ' + s));
      if (m.outside.length) agg.outside.push(...m.outside.map((s) => i + ': ' + s));
      if (m.inTable.length) agg.inTable.push(...m.inTable.map((s) => i + ': ' + s));
      if (m.clipped.length) agg.clipped.push(...m.clipped.map((s) => i + ': ' + s));
      if (!m.scroll) agg.scrollFail++;
      if (m.popup) {
        agg.popups++;
        if (!shot) { await p.screenshot({ path: path.join(SHOTS, 'r8-' + w + 'x' + h + '-' + players + 'p.png') }); shot = true; }
      }
      const nowRect = await rect();
      if (nowRect !== baseline) { agg.moved++; if (agg.moved <= 3) console.log('moved ' + tag + ' step ' + i + ': ' + baseline + ' -> ' + nowRect); }
      const next = await p.evaluate(() => {
        const b = document.getElementById('btn-next');
        if (b && b.offsetParent !== null) return '#btn-next';
        const c = document.getElementById('btn-cpu-next');
        return c && c.offsetParent !== null ? '#btn-cpu-next' : null;
      });
      if (next) await domClick(p, next);
      else await p.keyboard.press('Enter');
      await p.waitForTimeout(500);
    }
    const shortList = (arr) => arr.slice(0, 4).join(' ; ');
    note(agg.decisions >= MIN_DECISIONS, tag + ' played ' + agg.decisions + ' decisions (at least ' + MIN_DECISIONS + ')');
    note(agg.popups > 0, tag + ' feedback popup measured ' + agg.popups + ' times');
    note(agg.maxSeats === players && agg.seatMismatch === 0, tag + ' seat count is ' + players + ' at every measure');
    note(agg.pairs.length === 0, tag + ' intersections between seats, chips, pot, board, hero cards, popup and dock: ' + agg.pairs.length + (agg.pairs.length ? ' e.g. ' + shortList(agg.pairs) : ''));
    note(agg.outside.length === 0, tag + ' every item inside the viewport: ' + agg.outside.length + (agg.outside.length ? ' e.g. ' + shortList(agg.outside) : ''));
    note(agg.inTable.length === 0, tag + ' seats, chips, pot and board inside the table: ' + agg.inTable.length + (agg.inTable.length ? ' e.g. ' + shortList(agg.inTable) : ''));
    note(agg.clipped.length === 0, tag + ' nothing clipped by an overflow ancestor: ' + agg.clipped.length + (agg.clipped.length ? ' e.g. ' + shortList(agg.clipped) : ''));
    note(agg.moved === 0, tag + ' F/C/R never moved (' + agg.moved + ' shifts)');
    note(agg.scrollFail === 0 && (await scrollOk()), tag + ' page never scrolls');
    console.log('info ' + tag + ' table levels used: ' + [...agg.levels].join(', '));
    totals.pairs += agg.pairs.length; totals.outside += agg.outside.length; totals.inTable += agg.inTable.length;
    totals.clipped += agg.clipped.length; totals.decisions += agg.decisions; totals.popups += agg.popups;
    // the back arrow (top-right) goes home from the game: the topbar with the logo is hidden inside a mode
    await p.click('#btn-back').catch(() => {}); await p.waitForTimeout(400);
    // a live game asks first ("Leave the game?"): confirm it
    if (await p.evaluate(() => { const l = document.getElementById('leave-pop'); return !!l && !l.classList.contains('hidden'); })) {
      await domClick(p, '#leave-go'); await p.waitForTimeout(400);
    }
    note((await view()) === 'menu', tag + ' back arrow returns to the menu');
    note(errs.length === 0, tag + ' no JS errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
    await ctx.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const totals = { pairs: 0, outside: 0, inTable: 0, clipped: 0, decisions: 0, popups: 0 };
  for (const run of RUN_LIST) {
    try {
      await runOne(browser, run, totals);
    } catch (e) {
      note(false, run.w + "x" + run.h + "/" + run.players + "p run stopped: " + String(e.message).split(String.fromCharCode(10))[0]);
    }
  }
  await browser.close();
  const bad = results.filter((ok) => !ok).length;
  console.log('\ntotals: decisions ' + totals.decisions + ', popups measured ' + totals.popups + ', intersections ' + totals.pairs +
    ', outside viewport ' + totals.outside + ', outside table ' + totals.inTable + ', clipped ' + totals.clipped);
  console.log((results.length - bad) + '/' + results.length + ' checks passed');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('script failed:', e.message); process.exit(2); });
