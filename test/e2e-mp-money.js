'use strict';
// Money model in real headless Chrome: every amount the host sees is in BB (chips / bb). The starting
// stack field shows BB; after the host doubles the blinds, the same chips show half as many BB; a
// typed BB value is converted to whole chips and sent back. Lobby only (no hand), so the doubling is
// applied at once. Uses E2E_PORT (default 4085); the server on port 3000 is never touched.
const { chromium } = require('playwright-core');
const { createServer } = require('../server.js');

const PORT = Number(process.env.E2E_PORT || 4085);
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const out = { checks: [], errors: [] };
const check = (name, ok, info) => out.checks.push({ name, ok: !!ok, info: info === undefined ? null : info });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const server = createServer();
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const base = 'http://localhost:' + PORT;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => out.errors.push('pageerror: ' + e.message));
    await p.goto(base + '/', { waitUntil: 'load' });
    await require('./_rooms-helper.js').openMp(p, 'join', 'Ana');
    await require('./_rooms-helper.js').enterRoom(p, 'Ana');
    await p.waitForSelector('#mp-body:not(.hidden)', { timeout: 10000 });
    const stackField = () => p.evaluate(() => document.getElementById('mp-set-stack').value);
    const typeStack = async (v) => {
      await p.evaluate((val) => {
        const el = document.getElementById('mp-set-stack');
        el.value = val;
        el.dispatchEvent(new Event('change'));
      }, v);
    };
    // 100000 chips at 500/1000 blinds: 100 BB.
    await p.waitForFunction(() => document.getElementById('mp-set-stack').value === '100', null, { timeout: 5000 }).catch(() => {});
    check('starting stack shown in BB (100 BB at 1000 chips bb)', (await stackField()) === '100', await stackField());
    // Host doubles the blinds (lobby, no hand: applied at once). Same chips, half the BB.
    await p.evaluate(() => document.getElementById('mp-double').click());
    await p.waitForFunction(() => document.getElementById('mp-set-stack').value === '50', null, { timeout: 5000 }).catch(() => {});
    check('after doubling the same chips show half the BB (100 -> 50)', (await stackField()) === '50', await stackField());
    // Typed BB become whole chips: 150 BB at bb 2000 = 300000 chips, shown back as 150.
    await typeStack('150');
    await sleep(300);
    check('typed BB are converted to chips and shown back in BB', (await stackField()) === '150', await stackField());
    // Out-of-range BB is refused with a message in BB: under 5 BB (1 BB at bb 2000) and over 1000 BB.
    const errText = () => p.evaluate(() => (document.getElementById('mp-set-err') ? document.getElementById('mp-set-err').textContent : ''));
    await p.evaluate(() => { document.getElementById('mp-set-err').textContent = ''; });
    await typeStack('1');
    await sleep(200);
    const err = await errText();
    check("'1' BB is refused (minimum 5 BB) with a BB message", /BB/.test(err) && /5/.test(err), err);
    await p.evaluate(() => { document.getElementById('mp-set-err').textContent = ''; });
    await typeStack('1000.5');
    await sleep(200);
    const errMax = await errText();
    check("'1000.5' BB is refused (maximum 1000 BB) with a BB message", /1000/.test(errMax), errMax);
    await p.evaluate(() => document.getElementById('mp-double').click());
    await p.waitForFunction(() => document.getElementById('mp-set-stack').value === '75', null, { timeout: 5000 }).catch(() => {});
    check('second doubling halves again (150 -> 75)', (await stackField()) === '75', await stackField());
    check('no page errors', out.errors.length === 0, out.errors);
    await ctx.close();
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
  const failed = out.checks.filter((c) => !c.ok);
  for (const c of out.checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.ok ? '' : JSON.stringify(c.info));
  console.log(failed.length ? 'FAILED ' + failed.length : 'ALL ' + out.checks.length + ' PASSED');
  process.exitCode = failed.length ? 1 : 0;
}

run().catch((e) => { console.error('ERR', e && e.stack || e); process.exitCode = 1; });
