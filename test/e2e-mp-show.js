'use strict';
// Mid-hand show in real headless Chrome. Host Ana, humans Bo and Cy, one bot. Bo folds on his turn.
// Cy shows his hand while the hand still runs. Checks: Bo (folded) sees Cy's cards and the 'Shown' tag
// on Cy's seat; Ana (still in the hand) sees neither cards nor tag; no page errors anywhere.
// Run with `node test/e2e-mp-show.js`. Env: E2E_PORT (default 4192), CHROME_PATH.
const { chromium } = require('playwright-core');
const { createServer } = require('../server.js');

const PORT = Number(process.env.E2E_PORT || 4192);
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const out = { checks: [], errors: [] };
const check = (name, ok, info) => out.checks.push({ name, ok: !!ok, info: info === undefined ? null : info });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function join(page, url, name) {
  await page.goto(url, { waitUntil: 'load' });
  await require('./_rooms-helper.js').openMp(page, 'join', name);
  await require('./_rooms-helper.js').enterRoom(page, name);
  await page.waitForSelector('#mp-body:not(.hidden)', { timeout: 10000 });
}

// Seat cards of the named seat, as the page shows them: number of face-up cards and the tag.
const seatView = (name) => (p) => p.evaluate((n) => {
  const seats = Array.prototype.slice.call(document.querySelectorAll('#mp-seats .mp-seat'));
  const s = seats.filter((x) => (x.textContent || '').indexOf(n) >= 0)[0];
  if (!s) return { found: false };
  return { found: true, tag: !!s.querySelector('.mp-shown-tag'), faces: s.querySelectorAll('.mp-card-face:not(.back)').length };
}, name);

async function run() {
  const server = createServer();
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const base = 'http://localhost:' + PORT;
  const ctxs = [];
  const errs = [];
  try {
    const mk = async (who) => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
      ctxs.push(ctx);
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errs.push(who + ': ' + e.message));
      p.on('console', (m) => { if (m.type() === 'error') errs.push(who + ' console: ' + m.text()); });
      return p;
    };
    const ana = await mk('Ana'), bo = await mk('Bo'), cy = await mk('Cy');
    await join(ana, base + '/', 'Ana');
    await join(bo, base + '/', 'Bo');
    await join(cy, base + '/', 'Cy');
    await ana.waitForSelector('#mp-players li:nth-child(3)', { state: 'attached', timeout: 10000 });
    await ana.evaluate(() => { const b = document.querySelector('[data-hpage="bots"]'); if (b && b.getClientRects().length) b.click(); });
    await ana.click('[data-act="add-bot"]');
    await ana.evaluate(() => { const b = document.querySelector('[data-hpage="game"]'); if (b && b.getClientRects().length) b.click(); });
    await ana.click('#mp-start');
    await ana.waitForSelector('#mp-table-view:not(.hidden)', { timeout: 15000 });
    const pages = [ana, bo, cy];
    // Bo folds on his turn (the others call or check while it is their turn).
    const t0 = Date.now();
    let folded = false;
    while (Date.now() - t0 < 30000 && !folded) {
      folded = await bo.evaluate(() => {
        const f = document.getElementById('mp-fold');
        if (f && !f.disabled && f.getClientRects().length) { f.click(); return true; }
        return false;
      }).catch(() => false);
      if (!folded) {
        for (const p of [ana, cy]) await p.evaluate(() => { const c = document.getElementById('mp-call'); if (c && !c.disabled && c.getClientRects().length) c.click(); }).catch(() => {});
        await sleep(150);
      }
    }
    check('Bo folded on his turn', folded);
    await sleep(500);
    const showBtn = await cy.evaluate(() => { const b = document.querySelector('#mp-hero [data-act="show-hand"]'); if (b) { b.click(); return true; } return false; });
    check('Cy can show mid-hand (show button)', showBtn);
    await sleep(800);
    const cyView = await seatView('Cy')(bo);
    const anaView = await seatView('Cy')(ana);
    const cyForCy = await seatView('Cy')(cy);
    check('Bo (folded) sees the Shown tag on Cy', cyView.found && cyView.tag, cyView);
    check('Bo (folded) sees Cy cards face-up', cyView.found && cyView.faces === 2, cyView);
    check('Ana (in the hand) sees no Shown tag on Cy', anaView.found && !anaView.tag, anaView);
    check('Ana (in the hand) sees no cards of Cy', anaView.found && anaView.faces === 0, anaView);
    const hint = await cy.evaluate(() => !!document.querySelector('#mp-hero .mp-show-hint') && /folded|retir/i.test(document.querySelector('#mp-hero').textContent));
    check('Cy sees the Shown to folded players hint', hint);
    out.errors.push(...errs);
  } finally {
    for (const c of ctxs) await c.close().catch(() => {});
    server.close();
  }
}

let browser;
(async () => {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    await run();
  } finally {
    await browser.close();
  }
  check('no page errors or console errors', out.errors.length === 0, out.errors.slice(0, 10));
  const failed = out.checks.filter((c) => !c.ok);
  for (const c of out.checks) console.log((c.ok ? 'PASS ' : 'FAIL ') + c.name + (c.ok || c.info === null ? '' : ' ' + JSON.stringify(c.info)));
  console.log(out.checks.length - failed.length + '/' + out.checks.length + ' passed');
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; });
