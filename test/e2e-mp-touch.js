'use strict';
// Phone (touch) multiplayer raise controls in real headless Chrome: 390x844, hasTouch, isMobile.
// One hero (a real touch context) and two bots fill three seats. Checks: the slider and number box are
// hidden; five preset buttons show BB amounts and are >= 44px; tapping a preset changes the Raise label;
// a long press (600 ms, real CDP touch events) on Raise opens the exact-amount popover; Escape and an
// outside tap close it; typing an exact amount and Confirm sends that raise at once (the act frame).
// Run: E2E_PORT=3672 node test/e2e-mp-touch.js. Env: E2E_SHOTS (screenshot folder), CHROME_PATH.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { createServer } = require('../server.js');

const PORT = Number(process.env.E2E_PORT || 3672);
const SHOTS = process.env.E2E_SHOTS || path.join(__dirname, '..', '.e2e-shots');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://localhost:' + PORT;

const checks = [];
function check(name, ok, detail) { checks.push({ name: name, ok: !!ok, detail: detail == null ? '' : String(detail) }); }

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = createServer();
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required']
  });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const errors = [];
  const info = { bb: 0 };
  try {
    // record every text frame the page sends (the act frames) and the blinds from the state frames
    await ctx.addInitScript(() => {
      window.__sent = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (d) { try { window.__sent.push(String(d)); } catch (e) { /* ignore */ } return send.call(this, d); };
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e.message)));
    // act frames the hero has sent so far
    const actsSent = async () => (await page.evaluate(() => window.__sent.slice())).map((s) => { try { return JSON.parse(s); } catch (e) { return {}; } }).filter((m) => m.t === 'act');
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await require('./_rooms-helper.js').openMp(page, 'join', 'Hero');
    await require('./_rooms-helper.js').enterRoom(page, 'Hero');
    await page.waitForSelector('#mp-body:not(.hidden)', { timeout: 10000 });
    const showPage = (n) => page.evaluate((x) => { const b = document.querySelector('[data-hpage="' + x + '"]'); if (b && b.getClientRects().length) b.click(); }, n);
    await showPage('bots');
    for (let i = 0; i < 2; i++) { await page.click('[data-act="add-bot"]'); await page.waitForTimeout(120); }
    await showPage('game');
    await page.click('#mp-start');
    await page.waitForSelector('#mp-table-view:not(.hidden)', { timeout: 15000 });
    await page.waitForFunction(() => document.querySelectorAll('#mp-seats .mp-seat').length >= 3, null, { timeout: 15000 });
    check('three seats shown', await page.evaluate(() => document.querySelectorAll('#mp-seats .mp-seat').length === 3));

    // wait for the hero's turn (the bots act first when they are ahead)
    await page.waitForSelector('#mp-raise:not([disabled])', { timeout: 90000 });
    await page.waitForTimeout(300);

    const vis = (sel) => page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el || !el.getClientRects().length) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getBoundingClientRect().height > 0;
    }, sel);
    check('slider hidden on touch', !(await vis('#mp-raise-range')));
    check('number box hidden on touch', !(await vis('#mp-raise-num')));
    const presets = await page.evaluate(() => Array.prototype.slice.call(document.querySelectorAll('#mp-table-view [data-act="q"]')).map((b) => {
      const r = b.getBoundingClientRect();
      const qv = b.querySelector('.qv');
      return { q: b.getAttribute('data-q'), vis: !!b.getClientRects().length && r.height > 0, h: Math.round(r.height), qv: qv ? qv.textContent : '' };
    }));
    check('five presets visible', presets.length === 5 && presets.every((p) => p.vis), presets.map((p) => p.q).join(','));
    check('presets >= 44px', presets.every((p) => p.h >= 44), presets.map((p) => p.h).join(','));
    check('presets show BB amounts', presets.every((p) => /BB$/.test(p.qv)), presets.map((p) => p.qv).join(' | '));
    await page.screenshot({ path: path.join(SHOTS, 'touch-turn.png') });

    // tapping Pot changes the Raise label
    const label = () => page.textContent('#mp-raise-label');
    const before = await label();
    await page.tap('#mp-table-view [data-act="q"][data-q="pot"]');
    await page.waitForTimeout(150);
    const afterPot = await label();
    check('preset changes the Raise label', afterPot !== before, before + ' -> ' + afterPot);

    // long press on Raise: real CDP touch events, held 600 ms
    const cdp = await ctx.newCDPSession(page);
    const box = await page.locator('#mp-raise').boundingBox();
    const tx = box.x + box.width / 2, ty = box.y + box.height / 2;
    async function longPress(ms) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tx, y: ty }] });
      await page.waitForTimeout(ms);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    const framesBefore = (await actsSent()).length;
    await longPress(600);
    await page.waitForTimeout(150);
    check('long press opens exact-amount popover', await vis('#mp-rpop'));
    check('long press does not raise', (await actsSent()).length === framesBefore);
    await page.screenshot({ path: path.join(SHOTS, 'touch-rpop.png') });

    // Escape closes it
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    check('Escape closes popover', !(await vis('#mp-rpop')));

    // an outside tap closes it
    await longPress(600);
    await page.waitForTimeout(150);
    check('popover reopened for the outside-tap test', await vis('#mp-rpop'));
    await page.tap('#mp-hero');
    await page.waitForTimeout(150);
    check('outside tap closes popover', !(await vis('#mp-rpop')));

    // exact amount: 7.5 BB, Confirm sends it at once
    await longPress(600);
    await page.waitForTimeout(150);
    await page.fill('#mp-rpop-in', '7.5');
    await page.tap('#mp-rpop-ok');
    await page.waitForTimeout(400);
    const bb = info.bb || 1000; // default big blind (room DEFAULTS)
    const want = Math.round(7.5 * bb);
    const sent = (await actsSent()).slice(framesBefore);
    check('Confirm sends one act frame', sent.length === 1, JSON.stringify(sent));
    check('raise frame carries the exact amount', sent.length === 1 && sent[0].action === 'raise' && sent[0].amount === want,
      'want ' + want + ' (bb ' + bb + ') got ' + JSON.stringify(sent[0] || null));
    check('popover closes after Confirm', !(await vis('#mp-rpop')));
  } finally {
    await ctx.close();
    await browser.close();
    await new Promise((r) => server.close(r));
  }
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  let failed = 0;
  checks.forEach((c) => { if (!c.ok) failed++; console.log((c.ok ? 'PASS ' : 'FAIL ') + c.name + (c.detail ? ' (' + c.detail + ')' : '')); });
  console.log(failed ? failed + ' of ' + checks.length + ' failed' : 'all ' + checks.length + ' checks passed');
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error('ERROR', e && e.stack || e); process.exitCode = 1; });
