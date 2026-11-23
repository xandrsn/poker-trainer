'use strict';
// Main menu hub: options are revealed by their group's main tile (Play or Practice) first.
async function openFmt(p, fmt) {
  const group = fmt === 'table' || fmt === 'mp' ? 'play' : 'practice';
  if (!(await p.isVisible('[data-fmt="' + fmt + '"]'))) await p.click('#hub-' + group);
  await p.click('[data-fmt="' + fmt + '"]');
}

// Quick game (one table of bots, played to the end) in real Chrome (playwright-core). Not part of `npm test`.
// Menu -> Quick game card -> settings -> Play, ~15 decisions with F/C/R keys. Checks: no feedback popup,
// no Ranges or Progress tab, bots count shown, Finish (two-step) -> end panel with stats, Play again restarts.
// Sizes: 1366x768, 390x844, 844x390; no document scroll and the end panel inside the viewport.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.argv[2] || 'http://localhost:3000';
const SHOTS = path.join(__dirname, '..', '.e2e-shots');
const SIZES = [[1366, 768], [390, 844], [844, 390]];
const DECISIONS = 15;
let failures = 0;
const chk = (ok, msg) => { if (!ok) failures++; console.log((ok ? 'ok   ' : 'FAIL ') + msg); };

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    for (const [w, h] of SIZES) {
      const tag = w + 'x' + h;
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const p = await ctx.newPage();
      const errors = [];
      p.on('pageerror', (e) => errors.push(e.message));
      p.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
      const ev = (fn, arg) => p.evaluate(fn, arg);
      // getClientRects, not offsetParent: position:fixed popups (#app-ask, .mp-leave) have offsetParent === null.
      const visible = (sel) => ev((s) => { const e = document.querySelector(s); return !!e && e.getClientRects().length > 0 && !e.classList.contains('hidden'); }, sel);

      await p.goto(BASE, { waitUntil: 'load' });
      await p.waitForTimeout(600);
      await p.evaluate(() => { try { localStorage.clear(); } catch (e) { /* storage blocked */ } });
      await p.reload({ waitUntil: 'load' });
      await p.waitForTimeout(500);

      // Menu: the new card, then its settings.
      await openFmt(p, 'table');
      await p.waitForTimeout(300);
      chk(await visible('#menu-start'), tag + ' quick game card reveals settings and Play');
      chk(await ev(() => !document.querySelector('#menu-pmin').closest('.menu-group').offsetParent), tag + ' players range hidden in quick game settings');
      await p.selectOption('#menu-bots', '2');
      await p.click('#menu-start');
      await p.waitForTimeout(1200);
      chk(await ev(() => document.body.dataset.view === 'game' && document.body.classList.contains('table-mode')), tag + ' Play enters the game in table mode');
      chk(await ev(() => { const b = document.getElementById('btn-ranges'); return !b || getComputedStyle(b).display === 'none'; }), tag + ' no Ranges tab');
      chk(await ev(() => { const t = document.querySelector('.side-tab[data-tab="progress"]'); return !t || getComputedStyle(t).display === 'none'; }), tag + ' no Progress tab');
      chk(await ev(() => { const t = document.getElementById('btn-settings-tab'); return !t || getComputedStyle(t).display === 'none'; }), tag + ' no in-game Settings tab');
      const info = await ev(() => document.getElementById('hand-info').textContent);
      chk(/2 bots|2 bot/.test(info) || /2 bots/.test(info) || /\b2\b/.test(info), tag + ' bots count shown: "' + info + '"');

      // ~15 decisions with F/C/R; no feedback popup, no per-decision feedback at any point.
      let decisions = 0, feedbackSeen = false, guard = 0, keyIdx = 0, maxAnim = 0;
      const keys = ['c', 'c', 'r', 'c', 'f'];
      let handNo = 1;
      while ((decisions < DECISIONS || handNo < 3) && guard++ < 600) {
        handNo = Number((await ev(() => document.getElementById('hand-info').textContent)).match(/hand (\d+)/)?.[1] || handNo);
        if (await ev(() => document.body.dataset.view !== 'game' || !!document.getElementById('table-end') && !document.getElementById('table-end').classList.contains('hidden'))) break;
        if (await visible('#feedback') || await visible('#btn-next')) feedbackSeen = true;
        const canAct = await ev(() => { const b = document.getElementById('btn-call'); return !!b && !b.disabled && b.offsetParent !== null; });
        if (canAct) {
          await p.keyboard.press(keys[keyIdx++ % keys.length]);
          decisions++;
          maxAnim = Math.max(maxAnim, await ev(() => document.querySelectorAll('.anim-el').length));
          await p.waitForTimeout(150);
        } else if (await visible('#btn-cpu-next')) {
          await p.click('#btn-cpu-next').catch(() => {});
          await p.waitForTimeout(250);
        } else {
          await p.waitForTimeout(350);
        }
      }
      chk(decisions >= DECISIONS, tag + ' played ' + decisions + ' decisions');
      chk(!feedbackSeen, tag + ' no feedback popup or Next button during play');
      // Default motion (no reduced-motion emulation): PokerAnim elements appear during play and are gone after 3 s.
      chk(maxAnim > 0, tag + ' anim elements appear during play (max ' + maxAnim + ')');
      await p.waitForTimeout(3000);
      chk(await ev(() => document.querySelectorAll('.anim-el').length) === 0, tag + ' no anim elements left after 3 s');
      await p.screenshot({ path: path.join(SHOTS, 'gm-' + tag + '-play.png') });

      // Finish is one click: it opens the in-app popup (PokerAsk), and the popup's OK finishes the game.
      // the table can end by itself on the last hand (the end panel then replaces the Finish button): that is a finished game too
      if (await visible('#table-end')) {
        chk(true, tag + ' game ended on its own after the last hand');
      } else if (await visible('#btn-finish-table')) {
        await p.click('#btn-finish-table');
        await p.waitForTimeout(150);
        chk(await visible('#app-ask') && !(await visible('#table-end')), tag + ' one Finish click opens the popup, no end yet');
        await p.click('#app-ask [data-ask="ok"]');
        await p.waitForSelector('#table-end', { state: 'visible', timeout: 5000 }).catch(() => {});
        chk(await visible('#table-end') && !(await visible('#app-ask')), tag + ' popup OK finishes the game');
      } else {
        chk(false, tag + ' Finish button visible during play');
      }
      await p.waitForTimeout(500);
      chk(await visible('#table-end'), tag + ' end panel visible after Finish');
      const stats = await ev(() => ({
        title: document.getElementById('table-end-title').textContent,
        hands: document.getElementById('te-hands').textContent,
        win: document.getElementById('te-win').textContent,
        stack: document.getElementById('te-stack').textContent,
      }));
      console.log('     end panel: ' + JSON.stringify(stats));
      chk(stats.title.length > 0 && /^\d+$/.test(stats.hands) && Number(stats.hands) > 0, tag + ' end panel has title and hands count');
      const fit = await ev(() => {
        const r = document.getElementById('table-end').getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, vh: window.innerHeight, vw: window.innerWidth, left: r.left, right: r.right };
      });
      chk(fit.top >= 0 && fit.bottom <= fit.vh + 1 && fit.left >= 0 && fit.right <= fit.vw + 1, tag + ' end panel inside viewport (' + Math.round(fit.bottom) + '/' + fit.vh + ')');
      const scroll = await ev(() => document.documentElement.scrollHeight - window.innerHeight);
      chk(scroll <= 1, tag + ' no document scroll (overflow ' + scroll + 'px)');
      await p.screenshot({ path: path.join(SHOTS, 'gm-' + tag + '-end.png') });

      // Play again restarts with the same settings.
      await p.click('#btn-table-again');
      await p.waitForTimeout(800);
      chk(!(await visible('#table-end')) && await visible('#btn-finish-table'), tag + ' Play again restarts the game');

      chk(errors.length === 0, tag + ' no JS errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  console.log(failures ? '\n' + failures + ' check(s) failed' : '\nall game-mode checks passed');
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
