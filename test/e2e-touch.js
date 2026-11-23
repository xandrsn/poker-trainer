'use strict';
// Main menu hub: options are revealed by their group's main tile (Play or Practice) first.
async function openFmt(p, fmt) {
  const group = fmt === 'table' || fmt === 'mp' ? 'play' : 'practice';
  if (!(await p.isVisible('[data-fmt="' + fmt + '"]'))) await p.click('#hub-' + group);
  await p.click('[data-fmt="' + fmt + '"]');
}

// Phone raise checks in real Chrome with a touch context (390x844): presets visible, slider hidden,
// a preset changes the Raise label, and a long press opens the exact-amount popover that confirms a raise.
// Run: node test/e2e-touch.js   (CHROME_PATH overrides the browser location)
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const CHROME = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const INDEX = 'file:///' + path.join(__dirname, '..', 'public', 'index.html').split(path.sep).join('/');
let failures = 0;
function check(name, ok, info) { if (!ok) failures++; console.log((ok ? '  ok   ' : '  FAIL ') + name + (info !== undefined && !ok ? ' ' + JSON.stringify(info) : '')); }

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--allow-file-access-from-files'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(INDEX);
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* none */ } });
  await page.reload();
  await openFmt(page, 'table');
  await page.click('#menu-start');
  const ready = await page.waitForFunction(() => { const b = document.getElementById('btn-raise'); return b && !b.disabled && document.getElementById('raise-ctl').offsetParent !== null; }, null, { timeout: 40000 }).then(() => true).catch(() => false);
  check('hero can raise on a phone', ready);
  if (ready) {
    const geo = await page.evaluate(() => {
      const vis = (id) => { const e = document.getElementById(id); const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== 'none'; };
      const pre = Array.prototype.map.call(document.querySelectorAll('#raise-ctl [data-rq]'), (b) => ({ q: b.dataset.rq, h: Math.round(b.getBoundingClientRect().height), vis: b.getBoundingClientRect().width > 0 }));
      return { range: vis('raise-range'), num: vis('raise-num'), pre: pre };
    });
    check('phone: slider and number box hidden', !geo.range && !geo.num, geo);
    check('phone: five presets, all >= 44px tall', geo.pre.length === 5 && geo.pre.every((p) => p.vis && p.h >= 44), geo.pre);
    const before = await page.textContent('#raise-label');
    await page.tap('[data-rq="pot"]');
    const after = await page.textContent('#raise-label');
    check('phone: a preset changes the Raise label', after !== before, { before, after });
    const potAmt = await page.textContent('[data-rq="pot"] .rq-amt');
    check('phone: preset shows its amount in BB', /\d/.test(potAmt), potAmt);
    // long press: pointer events held for 500 ms
    await page.evaluate(() => { const b = document.getElementById('btn-raise'); b.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true, button: 0, isPrimary: true })); });
    await page.waitForTimeout(520);
    await page.evaluate(() => { const b = document.getElementById('btn-raise'); b.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true, button: 0, isPrimary: true })); });
    await page.waitForTimeout(80);
    const pop = await page.evaluate(() => { const p = document.getElementById('raise-pop'); const r = p.getBoundingClientRect(); return { open: !p.classList.contains('hidden'), inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, top: r.top, bottom: r.bottom }; });
    check('long press opens the exact-amount popover inside the viewport', pop.open && pop.inside, pop);
    const betBefore = await page.evaluate(() => { const c = document.querySelector('.bet-chip[data-idx="0"]'); return c ? c.textContent.trim() : ''; });
    const target = await page.evaluate(() => { const n = document.getElementById('rp-num'); return String(Math.round((Number(n.value) + 0.5) * 10) / 10); });
    await page.fill('#rp-num', target);
    await page.press('#rp-num', 'Enter');
    const bet = await page.waitForFunction((want) => { const c = document.querySelector('.bet-chip[data-idx="0"]'); return !!c && c.textContent.trim() === want; }, target, { timeout: 5000 }).then(() => true).catch(() => false);
    check('popover confirm raises to the typed amount (' + target + ' BB)', bet, { betBefore, target });
    const closed = await page.evaluate(() => document.getElementById('raise-pop').classList.contains('hidden'));
    check('popover closes after confirm', closed);
    const shot = path.join(__dirname, '..', '.e2e-shots', 'touch-raise.png');
    await page.screenshot({ path: shot }).catch(() => null);
  }
  await browser.close();
  console.log(failures ? failures + ' check(s) failed' : 'touch raise checks passed');
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
