const { openFmt } = require('./helpers/menu');
'use strict';
// Quick game (the table format) in real Chrome: every new game starts every seat (hero and bots) with the same
// stack, 100 BB, even when an old session saved the stack mode as 'varied'.
// Before blinds: stack + the blind the seat posted = 100 BB. Run: node test/e2e-quick-stacks.js
const path = require('path');
const { chromium } = require('playwright-core');

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const INDEX = 'file:///' + path.join(__dirname, '..', 'public', 'index.html').replace(/\\/g, '/');
const GAMES = 5;

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  let fails = 0;
  const expect = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await ctx.newPage();
    await page.goto(INDEX);
    // An old session saved 'varied': the Quick game must still start equal.
    await page.evaluate(() => {
      try {
        const k = Object.keys(localStorage).filter((x) => /settings/i.test(x));
        k.forEach((x) => { const v = JSON.parse(localStorage.getItem(x) || 'null'); if (v) { v.stacks = 'varied'; v.sv = 1; localStorage.setItem(x, JSON.stringify(v)); } });
      } catch (e) {}
    });
    await page.reload();
    for (let g = 1; g <= GAMES; g++) {
      await page.reload();
      await openFmt(page, 'table');
      await page.click('#menu-start');
      await page.waitForSelector('.seat-stack', { timeout: 10000 });
      const seats = await page.evaluate(() => Array.from(document.querySelectorAll('.seat')).map((s) => {
        const st = s.querySelector('.seat-stack'); const bt = s.querySelector('.seat-bet, .bet');
        return { stack: st ? st.textContent.trim() : null, bet: bt ? bt.textContent.trim() : '' };
      }));
      const bb = (x) => Number(String(x || '').replace(',', '.').replace(/[^0-9.]/g, ''));
      // Stack already has the blind posted, so the check is stack + posted blind = 100 BB.
      // The seat bet is not in the DOM, so a seat may show 100 minus the small blind (0.5) or big blind (1).
      const ok = seats.length >= 2 && seats.every((s) => [100, 99.5, 99].indexOf(bb(s.stack)) >= 0);
      expect(ok, 'game ' + g + ': every seat starts at 100 BB, minus only a blind ' + JSON.stringify(seats.map((s) => s.stack)));
      await page.evaluate(() => { const b = document.querySelector('#btn-cpu-next, #btn-next'); if (b) b.blur(); });
      await page.evaluate(() => { try { window.scrollTo(0, 0); } catch (e) {} });
      await page.reload();
    }
    await ctx.close();
  } finally {
    await browser.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
