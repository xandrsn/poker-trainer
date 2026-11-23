'use strict';
// In-game settings dialog (#mp-settings) in one headless Chrome: the host changes spectator cards and
// progressive blinds mid-hand, both guests see the new values in their dialogs, the host kicks a guest
// from the dialog mid-hand, and the kicked page shows only the 'Removed from the table' overlay.
// Uses E2E_PORT (default 3593); the server on port 3000 is never touched.
const { chromium } = require('playwright-core');
const { createServer } = require('../server.js');

const PORT = Number(process.env.E2E_PORT || 3593);
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const out = { checks: [], errors: [] };
const check = (name, ok, info) => out.checks.push({ name, ok: !!ok, info: info === undefined ? null : info });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dlgValues = (p) => p.evaluate(() => [document.getElementById('mp-dlg-spec').value, document.getElementById('mp-dlg-blindup').value]);

async function run() {
  const server = createServer();
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const base = 'http://localhost:' + PORT;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const mk = async (name, vp) => {
      const ctx = await browser.newContext({ viewport: vp || { width: 1366, height: 768 } });
      const p = await ctx.newPage();
      p.on('pageerror', (e) => out.errors.push(name + ' pageerror: ' + e.message));
      await p.goto(base + '/', { waitUntil: 'load' });
      await require('./_rooms-helper.js').openMp(p, 'join', name);
      await require('./_rooms-helper.js').enterRoom(p, name);
      await p.waitForSelector('#mp-body:not(.hidden)', { timeout: 10000 });
      return p;
    };
    const A = await mk('Ana');
    const B = await mk('Bo');
    const C = await mk('Cy');
    await A.waitForSelector('#mp-players li:nth-child(3)', { state: 'attached', timeout: 10000 });
    await A.click('#mp-start');
    await A.waitForSelector('#mp-table-view:not(.hidden)', { timeout: 10000 });
    await sleep(500);
    check('hand is running', await A.evaluate(() => !document.getElementById('mp-table-view').classList.contains('hidden')));

    // host changes both values from the in-game dialog
    await A.click('#mp-btn-settings');
    await A.selectOption('#mp-dlg-spec', 'afterHand');
    await A.selectOption('#mp-dlg-blindup', '2');
    await sleep(800);
    check('host dialog keeps the new values', JSON.stringify(await dlgValues(A)) === JSON.stringify(['afterHand', '2']), await dlgValues(A));
    await A.keyboard.press('Escape');
    await sleep(200);
    for (const [n, p] of [['B', B], ['C', C]]) {
      await p.click('#mp-btn-settings');
      await sleep(300);
      const v = await dlgValues(p);
      check(n + ' dialog shows the host settings (read-only)', JSON.stringify(v) === JSON.stringify(['afterHand', '2']), v);
      check(n + ' host-only controls disabled', await p.evaluate(() => document.getElementById('mp-dlg-spec').disabled && document.getElementById('mp-dlg-blindup').disabled));
      await p.keyboard.press('Escape');
      await sleep(100);
    }

    // host kicks guest B from the dialog mid-hand
    await A.click('#mp-btn-settings');
    await sleep(300);
    await A.click('#mp-players [data-act="kick"]', { timeout: 5000 });
    await sleep(1200);
    const kicked = await B.evaluate(() => {
      const k = document.getElementById('mp-kicked');
      const conn = document.querySelector('#mp-conn-text');
      const connBox = conn && conn.parentNode;
      return { overlay: !!k && !k.classList.contains('hidden'), connHidden: !connBox || connBox.classList.contains('hidden'), connText: conn ? conn.textContent : '' };
    });
    check('kicked guest sees the Removed overlay', kicked.overlay, kicked);
    check('kicked guest shows no connection banner', kicked.connHidden && !/offline|no connection/i.test(kicked.connText), kicked);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
    const failed = out.checks.filter((c) => !c.ok).length;
    out.passed = out.checks.length - failed;
    out.failed = failed;
    console.log(JSON.stringify(out, null, 1));
    process.exitCode = failed || out.errors.length ? 1 : 0;
  }
}

// process.exit: the server's timers and sockets otherwise keep the event loop alive after the report
run().then(() => process.exit(process.exitCode || 0), (e) => { console.error(e); process.exit(1); });
