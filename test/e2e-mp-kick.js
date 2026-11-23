'use strict';
// Kicking a player in real headless Chrome, in the middle of a hand and between hands. Each scenario
// runs on a fresh server (fresh room): host Ana, human Bo, human Cy, one bot. Checks:
//  - the kicked human's page lands on the 'Removed from the table' screen, with no page errors;
//  - the host sees 'Leaving after this hand' while the hand runs, and Bo is gone once it ends;
//  - the hand continues: the table keeps playing and nothing throws.
// Run with `node test/e2e-mp-kick.js`. Env: E2E_PORT (default 4190), CHROME_PATH.
const { chromium } = require('playwright-core');
const { createServer } = require('../server.js');

const PORT = Number(process.env.E2E_PORT || 4190);
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

// Calls on every page whose turn it is (keeps the hand moving), except the pages in `skip`.
async function drive(pages, skip) {
  for (const p of pages) {
    if (skip.indexOf(p) >= 0) continue;
    await p.evaluate(() => { const c = document.getElementById('mp-call'); if (c && !c.disabled && c.getClientRects().length) c.click(); }).catch(() => {});
  }
}

async function scenario(browser, name, opts) {
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
    await ana.waitForFunction(() => document.querySelectorAll('#mp-seats .mp-seat').length >= 3, null, { timeout: 15000 });
    const waitTurn = async (who) => {
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        const on = await ana.evaluate((w) => {
          const s = document.querySelector('#mp-seats .mp-seat.turn');
          return s ? (s.textContent || '').indexOf(w) >= 0 : false;
        }, who).catch(() => false);
        if (on) return true;
        await drive(pages, []);
        await sleep(150);
      }
      return false;
    };
    if (opts.when === 'folded') {
      await waitTurn('Bo');
      await bo.evaluate(() => { const f = document.getElementById('mp-fold'); if (f && !f.disabled) f.click(); });
      await sleep(300);
    } else if (opts.when === 'turn') {
      await waitTurn('Bo');
    }
    const clicked = await ana.evaluate((args) => {
      const rows = Array.prototype.slice.call(document.querySelectorAll('#mp-players li'));
      const row = rows.filter((li) => args.bot ? !!li.querySelector('[data-act="remove-bot"]')
        : ((li.querySelector('.mp-pname') || {}).textContent === 'Bo'))[0];
      const btn = row && row.querySelector(args.bot ? '[data-act="remove-bot"]' : '[data-act="kick"]');
      if (btn) { btn.click(); return true; }
      return false;
    }, { bot: !!opts.bot }).catch(() => false);
    check(name + ': host clicked the kick button', clicked);
    await sleep(400);
    if (!opts.bot) {
      const kickedShown = await bo.waitForFunction(() => { const d = document.getElementById('mp-kicked'); return !!d && d.getClientRects().length > 0; }, null, { timeout: 8000 }).then(() => true, () => false);
      check(name + ': Bo sees the clean kicked screen', kickedShown);
      const leaving = await ana.evaluate(() => Array.prototype.some.call(document.querySelectorAll('#mp-players .mp-tag'), (t) => /after this hand|al terminar/i.test(t.textContent)));
      check(name + ': host sees the leaving badge', leaving);
    }
    const skip = opts.bot ? [] : [bo];
    const t0 = Date.now();
    let gone = false;
    while (Date.now() - t0 < 90000) {
      await drive(pages, skip);
      gone = await ana.evaluate((bot) => {
        const rows = Array.prototype.slice.call(document.querySelectorAll('#mp-players li'));
        return bot ? !rows.some((li) => !!li.querySelector('[data-act="remove-bot"]'))
          : !rows.some((li) => (li.querySelector('.mp-pname') || {}).textContent === 'Bo');
      }, !!opts.bot).catch(() => false);
      if (gone) break;
      await sleep(200);
    }
    check(name + ': removed from the table after the hand', gone);
    await sleep(4000);
    await drive(pages, skip);
    await sleep(3000);
    const stillTable = await ana.evaluate(() => { const v = document.getElementById('mp-table-view'); return !!v && !v.classList.contains('hidden'); });
    check(name + ': table keeps playing', stillTable);
    out.errors.push(...errs.map((e) => name + ' ' + e));
  } finally {
    for (const c of ctxs) await c.close().catch(() => {});
    server.close();
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    await scenario(browser, 'mid-hand on turn', { when: 'turn' });
    await scenario(browser, 'already folded', { when: 'folded' });
    await scenario(browser, 'bot mid-hand', { when: 'turn', bot: true });
  } finally {
    await browser.close();
  }
  check('no page errors or console errors', out.errors.length === 0, out.errors.slice(0, 10));
  const failed = out.checks.filter((c) => !c.ok);
  for (const c of out.checks) console.log((c.ok ? 'PASS ' : 'FAIL ') + c.name + (c.ok || c.info === null ? '' : ' ' + JSON.stringify(c.info)));
  console.log(out.checks.length - failed.length + '/' + out.checks.length + ' passed');
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; });
