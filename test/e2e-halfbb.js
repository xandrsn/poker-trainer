const { openFmt } = require('./helpers/menu');
'use strict';
// Money display in whole or half big blinds (0.5 BB grain) and the stack inputs (validStackBB: 5..1000, 0.5 steps).
// Quick game in real Chrome: seat stacks, pot, bets, raise presets and the exact raise box never show a third of a BB.
// Run alone: node test/e2e-halfbb.js
const path = require('path');
const { chromium } = require('playwright-core');

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const INDEX = 'file:///' + path.join(__dirname, '..', 'public', 'index.html').split(String.fromCharCode(92)).join('/');
const HALF = /^\d+(\.5)?$/;

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  let fails = 0;
  const expect = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message || e)));
    await page.goto(INDEX);
    await openFmt(page, 'table');

    // Stack input: typed values are rounded to 0.5 and clamped to 5..1000 on change.
    const stackCase = async (typed, want) => {
      await page.fill('#menu-stack', typed);
      await page.dispatchEvent('#menu-stack', 'change');
      const got = await page.inputValue('#menu-stack');
      expect(got === want, 'menu stack "' + typed + '" -> ' + got + ' (want ' + want + ')');
    };
    await stackCase('12.3', '12.5');
    await stackCase('2', '5');
    await stackCase('5000', '1000');
    await stackCase('', '100');
    await stackCase('250', '250');

    await page.fill('#menu-stack', '100');
    await page.click('#menu-start');
    await page.waitForSelector('.seat-stack', { timeout: 10000 });
    // Wait until the hero is asked to act (raise presets carry an amount then).
    await page.waitForFunction(() => Array.prototype.some.call(document.querySelectorAll('#raise-ctl [data-rq] .rq-amt'), (e) => e.textContent.trim() !== ''), null, { timeout: 30000 }).catch(() => {});
    const shown = await page.evaluate(() => {
      const txt = (sel) => Array.prototype.map.call(document.querySelectorAll(sel), (e) => e.textContent.trim()).filter(Boolean);
      return {
        stacks: txt('.seat-stack'), pot: txt('.pot-val'), bets: txt('.bet-chip span'),
        presets: txt('#raise-ctl [data-rq] .rq-amt'), raiseNum: document.querySelector('#raise-num') ? document.querySelector('#raise-num').value : '',
        rangeStep: document.querySelector('#raise-range') ? document.querySelector('#raise-range').step : '',
      };
    });
    const num = (s) => Number(String(s).replace(/[^0-9.]/g, ''));
    const onHalf = (arr) => arr.every((s) => HALF.test(String(s).replace(/[^0-9.]/g, '')) && (num(s) * 2) % 1 === 0);
    expect(shown.stacks.length >= 2 && onHalf(shown.stacks), 'seat stacks whole or .5 BB: ' + JSON.stringify(shown.stacks));
    expect(onHalf(shown.pot), 'pot whole or .5 BB: ' + JSON.stringify(shown.pot));
    expect(onHalf(shown.bets), 'bets whole or .5 BB: ' + JSON.stringify(shown.bets));
    expect(onHalf(shown.presets), 'raise presets whole or .5 BB: ' + JSON.stringify(shown.presets));
    expect(shown.presets.every((x) => HALF.test(x.replace(/[^0-9.]/g, ''))), 'no decimals other than .5 in presets');
    expect(shown.rangeStep === '' || Number(shown.rangeStep) % 50 === 0, 'raise slider step is a 0.5 BB grain (' + shown.rangeStep + ')');

    // Exact entry: 3.3 BB is taken as the nearest legal half BB (3.5), shown back in the box.
    if (shown.presets.length) {
      await page.fill('#raise-num', '8.3');
      await page.dispatchEvent('#raise-num', 'input');
      await page.dispatchEvent('#raise-num', 'change');
      const after = await page.inputValue('#raise-num');
      // 8.3 BB is taken as the nearest half BB (8.5), unless 8.5 is below the legal minimum (then the minimum shows).
      const minShown = Number(shown.presets[0]);
      expect(HALF.test(after) && (Number(after) === 8.5 || Number(after) >= minShown), 'exact raise 8.3 snaps to a half BB, legal (got "' + after + '", min preset ' + minShown + ')');
    } else {
      expect(false, 'hero never got a turn with raise presets in 30 s');
    }
    await page.screenshot({ path: path.join(__dirname, '..', '.e2e-shots', 'halfbb-table.png') }).catch(() => {});
    expect(errors.length === 0, 'no page errors ' + JSON.stringify(errors.slice(0, 3)));
    await ctx.close();
  } finally {
    await browser.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
