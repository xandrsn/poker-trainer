'use strict';
// End game and Finish flows in one headless Chrome. Multiplayer: the host's End game (mid-hand, paused, and
// between hands) is one click on the settings sheet -> in-app popup (PokerAsk) -> OK -> every client is back in the
// lobby with the standings, and the settings sheet is closed. Solo: Finish game and Finish exam are one click ->
// popup; Cancel keeps playing; OK finishes. Reset stats uses the same popup. No native dialog may fire.
// Uses E2E_PORT (default 5240); the server on port 3000 is never touched.
const { chromium } = require('playwright-core');
const { createServer } = require('../server.js');
const rooms = require('./_rooms-helper.js');

const PORT = Number(process.env.E2E_PORT || 5240);
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const out = { checks: [], errors: [], dialogs: [] };
const check = (name, ok, info) => out.checks.push({ name, ok: !!ok, info: info === undefined ? null : info });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Visible = not hidden and laid out (fixed popups have no offsetParent).
const vis = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); return !!e && e.getClientRects().length > 0 && !e.classList.contains('hidden'); }, sel);
const waitVis = async (p, sel, ms) => {
  const end = Date.now() + (ms || 8000);
  while (Date.now() < end) { if (await vis(p, sel)) return true; await sleep(100); }
  return false;
};
const waitGone = async (p, sel, ms) => {
  const end = Date.now() + (ms || 8000);
  while (Date.now() < end) { if (!(await vis(p, sel))) return true; await sleep(100); }
  return false;
};

async function run() {
  const server = createServer();
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const base = 'http://localhost:' + PORT;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const pages = [];
  try {
    const mk = async (name) => {
      const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
      const p = await ctx.newPage();
      pages.push(p);
      p.on('pageerror', (e) => out.errors.push(name + ' pageerror: ' + e.message));
      p.on('dialog', (d) => { out.dialogs.push(name + ' ' + d.type() + ': ' + d.message()); d.dismiss(); });
      await p.goto(base + '/', { waitUntil: 'load' });
      await rooms.openMp(p, 'join', name);
      await rooms.enterRoom(p, name);
      await p.waitForSelector('#mp-body:not(.hidden)', { timeout: 10000 });
      return p;
    };
    const A = await mk('Ana');
    const B = await mk('Bo');
    const C = await mk('Cy');
    const all = [['A', A], ['B', B], ['C', C]];
    await A.waitForSelector('#mp-players li:nth-child(3)', { state: 'attached', timeout: 10000 });

    // Closes the standings overlay on every client (back to the lobby), as the player does.
    const closeStandings = async () => {
      for (const [, p] of all) {
        if (await vis(p, '#mp-standings')) await p.click('#mp-standings [data-act="close-standings"]');
      }
    };
    // Host: opens the settings sheet, one click on End game, popup, OK.
    const endFromSheet = async (label) => {
      await A.click('#mp-btn-settings');
      check(label + ': settings sheet opens', await waitVis(A, '#mp-settings'));
      await A.click('#mp-settings [data-act="end"]');
      check(label + ': one click on End game opens the popup', await waitVis(A, '#app-ask'));
      await A.click('#app-ask [data-ask="ok"]');
      check(label + ': popup closes after OK', await waitGone(A, '#app-ask'));
    };
    const checkLobby = async (label) => {
      check(label + ': settings sheet closed for host', await waitGone(A, '#mp-settings'));
      for (const [n, p] of all) {
        check(label + ': ' + n + ' shows the standings', await waitVis(p, '#mp-standings', 6000));
        check(label + ': ' + n + ' is back in the lobby', await waitVis(p, '#mp-lobby', 6000));
      }
      await closeStandings();
    };
    const startHand = async (label) => {
      await A.click('#mp-start');
      check(label + ': hand starts', await waitVis(A, '#mp-table-view', 10000));
      await sleep(500);
    };

    // 1) Mid-hand End game.
    await startHand('mid-hand');
    await endFromSheet('mid-hand');
    await checkLobby('mid-hand');

    // 2) While paused: endGame is allowed by the server (MP_PROTOCOL.md), so the same one-click flow ends it.
    await startHand('paused');
    await A.click('#mp-btn-settings');
    await waitVis(A, '#mp-settings');
    await A.click('#mp-settings [data-act="pause"]');
    await sleep(500);
    check('paused: game is paused', await vis(A, '#mp-pause-banner') || await vis(A, '#mp-paused'));
    await A.click('#mp-settings [data-act="end"]');
    check('paused: one click on End game opens the popup', await waitVis(A, '#app-ask'));
    await A.click('#app-ask [data-ask="ok"]');
    await checkLobby('paused');

    // 3) Between hands: wait (up to 40 s) for a hand to finish while the game still runs, then End game.
    await startHand('between-hands');
    let between = false;
    for (let i = 0; i < 80 && !between; i++) {
      between = await vis(A, '#mp-table-view') && (await vis(A, '.mp-show-count') || await vis(A, '.mp-show-cards'));
      if (!between) await sleep(500);
    }
    check('between-hands: reached a state between two hands', between);
    if (between) {
      await endFromSheet('between-hands');
      await checkLobby('between-hands');
    }

    // 4) Solo: Finish game (quick table) and Finish exam, each one click + popup, Cancel keeps playing.
    const solo = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const s = await solo.newPage();
    pages.push(s);
    s.on('pageerror', (e) => out.errors.push('solo pageerror: ' + e.message));
    s.on('dialog', (d) => { out.dialogs.push('solo ' + d.type() + ': ' + d.message()); d.dismiss(); });
    await s.goto(base + '/', { waitUntil: 'load' });
    await s.evaluate(() => { try { localStorage.clear(); } catch (e) { /* storage blocked */ } });
    await s.reload({ waitUntil: 'load' });
    const openFmt = async (fmt) => {
      const group = fmt === 'table' || fmt === 'mp' ? 'play' : 'practice';
      if (!(await vis(s, '[data-fmt="' + fmt + '"]'))) await s.click('#hub-' + group);
      await s.click('[data-fmt="' + fmt + '"]');
    };
    await openFmt('table');
    await s.click('#menu-start');
    check('solo table: Finish game shown', await waitVis(s, '#btn-finish-table', 8000));
    await s.click('#btn-finish-table');
    check('solo table: one click opens the popup', await waitVis(s, '#app-ask'));
    await s.click('#app-ask [data-ask="cancel"]');
    check('solo table: Cancel keeps the game running', await waitGone(s, '#app-ask') && !(await vis(s, '#table-end')) && await vis(s, '#btn-finish-table'));
    await s.click('#btn-finish-table');
    await waitVis(s, '#app-ask');
    await s.click('#app-ask [data-ask="ok"]');
    check('solo table: OK finishes the game (end panel)', await waitVis(s, '#table-end', 8000));

    await s.evaluate(() => { const b = document.getElementById('btn-table-menu'); if (b) b.click(); });
    await openFmt('exam');
    await s.click('#menu-start');
    check('solo exam: Finish exam shown', await waitVis(s, '#btn-finish-exam', 8000));
    await s.click('#btn-finish-exam');
    check('solo exam: one click opens the popup', await waitVis(s, '#app-ask'));
    await s.click('#app-ask [data-ask="cancel"]');
    check('solo exam: Cancel keeps the exam running', await waitGone(s, '#app-ask') && await vis(s, '#btn-finish-exam'));
    await s.click('#btn-finish-exam');
    await waitVis(s, '#app-ask');
    await s.click('#app-ask [data-ask="ok"]');
    check('solo exam: OK finishes the exam', await waitGone(s, '#btn-finish-exam', 8000));

    // 5) Reset stats: popup, Cancel keeps the data, OK clears it.
    await s.reload({ waitUntil: 'load' });
    await s.click('#menu-card-progress');
    check('reset: progress sheet opens', await waitVis(s, '#sheet-progress'));
    await s.evaluate(() => { const t = document.querySelector('#sheet-progress .pill-tab[data-ppage="1"]'); if (t) t.click(); });
    await sleep(300);
    await s.evaluate(() => { const d = document.querySelector('#sheet-progress details.menu-more'); if (d) d.open = true; });
    await sleep(200);
    for (let k = 0; k < 6 && !(await vis(s, '#btn-reset-progress')); k++) {
      const n = await s.locator('#sheet-progress .pill-tab').count();
      if (k < n) await s.locator('#sheet-progress .pill-tab').nth(k).click();
      await sleep(200);
    }
    await s.click('#btn-reset-progress');
    check('reset: one click opens the popup', await waitVis(s, '#app-ask'));
    await s.click('#app-ask [data-ask="cancel"]');
    check('reset: Cancel closes the popup only', await waitGone(s, '#app-ask'));
    await s.click('#btn-reset-progress');
    await waitVis(s, '#app-ask');
    await s.keyboard.press('Escape');
    check('reset: Escape cancels', await waitGone(s, '#app-ask'));
    await s.click('#btn-reset-progress');
    await waitVis(s, '#app-ask');
    await s.click('#app-ask [data-ask="ok"]');
    check('reset: OK closes the popup', await waitGone(s, '#app-ask'));

    check('no native dialog (confirm/alert/prompt) fired', out.dialogs.length === 0, out.dialogs);
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
