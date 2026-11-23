'use strict';
// Back arrow in Multiplayer: visible at the top-left at 390x844 and 1366x768, and clicking it leaves
// (session cleared, socket closed, menu shown). In-process server on E2E_PORT (default 3573).
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { createServer } = require('../server.js');
const PORT = Number(process.env.E2E_PORT || 3573);
const BASE = 'http://127.0.0.1:' + PORT;
const SHOTS = path.join(__dirname, '..', '.e2e-shots');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const checks = [];
const check = (name, ok, info) => checks.push({ name, ok: !!ok, info: info === undefined ? null : info });

async function run() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const errors = [];
  try {
    for (const vp of [{ w: 390, h: 844 }, { w: 1366, h: 768 }]) {
      const tag = vp.w + 'x' + vp.h;
      // a fresh server per viewport: the first listed table is joined, so an earlier run's table must not be in the list
      const server = createServer();
      await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, permissions: ['camera', 'microphone'] });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(tag + ' pageerror: ' + e.message));
      await page.goto(BASE + '/', { waitUntil: 'load' });
      const backName = 'Back' + Math.random().toString(36).slice(2, 5);
      await require('./_rooms-helper.js').openMp(page, 'join', backName);
      await require('./_rooms-helper.js').enterRoom(page, backName);
      await page.waitForSelector('#mp-body:not(.hidden)', { timeout: 10000 });
      // the back popup only guards a running table: start a one-bot game first (JS clicks; the bot is added from the lobby)
      await page.evaluate(() => document.querySelector('[data-act="add-bot"]').click());
      await page.evaluate(() => document.getElementById('mp-start').click());
      await page.waitForSelector('#mp-table-view:not(.hidden)', { timeout: 10000 });
      await page.waitForTimeout(500);
      const info = await page.evaluate(() => {
        const b = document.querySelector('.mp-back');
        const r = b && b.getBoundingClientRect();
        const t = document.querySelector('.mp-title');
        const tr = t && getComputedStyle(t).display !== 'none' ? t.getBoundingClientRect() : null;
        const cs = b && getComputedStyle(b);
        return { rect: r && { x: r.x, y: r.y, w: r.width, h: r.height }, visible: !!b && cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0,
          titleX: tr ? tr.x : null, inView: !!r && r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, bg: cs && cs.backgroundColor };
      });
      check(tag + ': back arrow visible and inside the viewport', info.visible && info.inView, info);
      if (info.titleX !== null) check(tag + ': back arrow sits left of the mode label', info.rect.x + info.rect.w <= info.titleX + 1, info);
      await page.screenshot({ path: path.join(SHOTS, 'mp-back-' + tag + '.png'), clip: { x: 0, y: 0, width: vp.w, height: 120 } });
      await page.click('.mp-back');
      await page.waitForSelector('#mp-leave', { state: 'visible', timeout: 3000 });
      const popShown = await page.evaluate(() => !!document.getElementById('mp-leave'));
      check(tag + ': back asks for confirmation first', popShown);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      const stillIn = await page.evaluate(() => !document.getElementById('mp-leave') && !!sessionStorage.getItem('poker-trainer:mp:session'));
      check(tag + ': Esc keeps the player in the game', stillIn);
      await page.click('.mp-back');
      await page.waitForSelector('#mp-leave [data-leave="go"]', { state: 'visible', timeout: 3000 });
      await page.click('#mp-leave [data-leave="go"]');
      await page.waitForTimeout(800);
      const after = await page.evaluate(() => ({
        session: sessionStorage.getItem('poker-trainer:mp:session'),
        conn: (document.getElementById('mp-conn-text') || {}).textContent || '',
        view: document.body.dataset.view,
        menuVisible: !!document.getElementById('menu-card-mp') && document.getElementById('menu-card-mp').offsetParent !== null,
        roomsShown: !!document.getElementById('mp-rooms') && !document.getElementById('mp-rooms').hidden
      }));
      // Leave goes back to the Rooms list (the table is not shown behind it).
      check(tag + ': back leaves the table (session cleared, Rooms list shown)', !after.session && after.roomsShown, after);
      await ctx.close();
      await new Promise((r) => server.close(r));
    }
  } finally {
    check('no page errors', errors.length === 0, errors.slice(0, 5));
    await browser.close();
    const failed = checks.filter((c) => !c.ok);
    console.log(JSON.stringify(checks, null, 1));
    console.log(failed.length ? 'FAILED: ' + failed.map((c) => c.name).join('; ') : 'e2e-mp-back: all ' + checks.length + ' checks passed');
    if (failed.length) process.exitCode = 1;
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  }
}
run().catch((e) => { console.error(e); process.exitCode = 1; });
