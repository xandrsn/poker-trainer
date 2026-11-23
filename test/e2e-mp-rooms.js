'use strict';
// Multiplayer rooms in real headless Chrome. Flow: Play -> Multiplayer -> Join table (name, Continue, list) or
// Create table (settings, Create). A creates a room with a 50 BB stack and enters the lobby as host; C tries the
// same table name (name taken disables Create), then creates its own; B joins A's room by name from the list
// (live list); isolation between rooms; leave returns to the Multiplayer screen. Screenshots of the Multiplayer
// screen at 1366x768, 844x390 and 390x844. In-process server on E2E_PORT (default 5740). Run alone.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { openMp } = require('./_rooms-helper.js');
const { createServer } = require('../server.js');
const PORT = Number(process.env.E2E_PORT || 5740);
const BASE = 'http://127.0.0.1:' + PORT;
const SHOTS = path.join(__dirname, '..', '.e2e-shots');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const checks = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, info) => checks.push({ name, ok: !!ok, info: info === undefined ? null : info });

async function rowsOf(page) {
  return page.$$eval('#mp-rooms .mr-row', (rs) => rs.map((r) => ({
    id: r.getAttribute('data-room'), name: r.querySelector('.mr-name').textContent,
    meta: r.querySelector('.mr-meta').textContent,
  })));
}
const sessionRoom = (page) => page.evaluate(() => sessionStorage.getItem('poker-trainer:mp:room'));
const playersText = (page) => page.evaluate(() => { const el = document.getElementById('mp-players'); return el ? el.textContent : ''; });
const noScroll = (page) => page.evaluate(() => {
  const d = document.documentElement;
  return !(d.scrollHeight > d.clientHeight + 1 || d.scrollWidth > d.clientWidth + 1);
});

async function run() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = createServer({ diagFile: false });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const errors = [];
  const ctxs = [];
  try {
    const mk = async (vp) => {
      const c = await browser.newContext({ viewport: vp });
      ctxs.push(c);
      const p = await c.newPage();
      p.on('pageerror', (e) => errors.push(e.message));
      p.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
      await p.goto(BASE + '/', { waitUntil: 'load' });
      return p;
    };
    const A = await mk({ width: 1366, height: 768 });
    const B = await mk({ width: 844, height: 390 });
    const C = await mk({ width: 390, height: 844 });

    // A: Join -> name -> Continue. No room yet: the list shows the empty hint.
    await openMp(A, 'join', 'Ann');
    await A.waitForSelector('#mp-rooms .mr-empty:not([hidden])', { timeout: 10000 });
    const hint = (await A.textContent('#mp-rooms .mr-empty-text')).trim();
    check('empty list shows a hint', hint.length > 0, hint);
    await A.screenshot({ path: path.join(SHOTS, 'rooms-empty-1366x768.png') });

    // A: Back to the chooser, Create table: name, then the stack stepper 100 -> 50 BB (100 presses of -0.5).
    await A.click('#mp-rooms .mr-back');
    await A.click('#mr-tile-create');
    await A.fill('#mp-rooms .mr-tname', 'Friday night');
    await A.waitForSelector('#mp-rooms .mr-create-go:not([disabled])', { timeout: 10000 });
    await A.evaluate(() => {
      const b = document.querySelector('#mp-rooms .mr-step[data-step-key="stack"][data-delta="-0.5"]');
      for (let i = 0; i < 100; i++) b.click();
    });
    const stackLabel = (await A.textContent('#mp-rooms [data-stepval="stack"]')).trim();
    check('create panel shows the chosen stack (50 BB)', /\b50\b/.test(stackLabel), stackLabel);
    await A.screenshot({ path: path.join(SHOTS, 'rooms-create-1366x768.png') });
    await A.click('#mp-rooms .mr-create-go');
    await A.waitForSelector('#mp-body:not(.hidden)', { timeout: 10000 });
    const roomA = await sessionRoom(A);
    check('A created a room and entered the lobby as host', !!roomA && /Ann/.test(await playersText(A)), roomA);
    const room = server.multiplayer.manager.get(roomA);
    check('settings applied at creation: stack 50 BB (50000 chips)', !!room && room.settings.stack === 50000, room && room.settings.stack);

    // C: the same table name is taken: the live check says so and Create stays disabled.
    await openMp(C, 'create', 'Cy');
    await C.fill('#mp-rooms .mr-tname', 'Friday night');
    await C.waitForSelector('#mp-rooms .mr-namemsg.is-bad', { timeout: 8000 });
    const takenDisabled = await C.$eval('#mp-rooms .mr-create-go', (b) => b.disabled);
    check('name taken: Create is disabled', takenDisabled === true);
    await C.screenshot({ path: path.join(SHOTS, 'rooms-name-taken-390x844.png') });
    await C.fill('#mp-rooms .mr-tname', 'Cy table');
    await C.waitForSelector('#mp-rooms .mr-namemsg.is-ok', { timeout: 8000 });
    await C.click('#mp-rooms .mr-create-go');
    await C.waitForSelector('#mp-body:not(.hidden)', { timeout: 10000 });
    const roomC = await sessionRoom(C);
    check('C got its own room code', !!roomC && roomC !== roomA, roomC);

    // B: Join by name, the list shows A's room; C's room appears live.
    await openMp(B, 'join', 'Bea');
    await B.waitForSelector('#mp-rooms .mr-row', { timeout: 10000 });
    const rowsB = await rowsOf(B);
    check("B sees A's room in the list", rowsB.some((r) => r.name === 'Friday night' && r.id === roomA), rowsB);
    const liveOk = await B.waitForFunction((id) => !!document.querySelector('#mp-rooms [data-room="' + id + '"]'), roomC, { timeout: 8000 })
      .then(() => true, () => false);
    check("B sees C's new room live (no reload)", liveOk);
    await B.click('#mp-rooms [data-room="' + roomA + '"]');
    await B.waitForSelector('#mp-body:not(.hidden)', { timeout: 10000 });
    const aSees = await A.waitForFunction(() => /Bea/.test((document.getElementById('mp-players') || {}).textContent || ''), null, { timeout: 8000 })
      .then(() => true, () => false);
    check('A sees Bea at the same table', aSees);
    check('B sees Ann at the same table', /Ann/.test(await playersText(B)));

    // Isolation: C's room has neither Ann nor Bea.
    const cText = await playersText(C);
    check('C (another room) does not see Ann or Bea', !/Ann|Bea/.test(cText), cText.slice(0, 80));

    // Leave: back to the Multiplayer screen, the table hidden.
    await B.evaluate(() => document.querySelector('button.mp-back').click());
    // The confirm pop-up only guards a running hand; in the lobby the leave is immediate.
    const confirmGo = await B.waitForSelector('#mp-leave [data-leave="go"]', { timeout: 1500 }).catch(() => null);
    if (confirmGo) await confirmGo.click();
    await sleep(400);
    const back = await B.evaluate(() => {
      const r = document.getElementById('mp-rooms'); const tv = document.getElementById('mp-table-view');
      return { view: document.body.dataset.view, menuShown: !!document.getElementById('menu-format') && document.getElementById('menu-format').getClientRects().length > 0, rooms: !!r && !r.hidden && r.getClientRects().length > 0, choose: !!r && r.getAttribute('data-view') === 'choose',
        table: !!tv && tv.getClientRects().length > 0 && getComputedStyle(tv).display !== 'none' };
    });
    check('leave returns to the Multiplayer screen, table hidden', back.rooms && back.choose && !back.table, back);

    // The list on three sizes: two rooms, players and host shown, no page scroll.
    const E = await mk({ width: 390, height: 844 });
    await openMp(E, 'join', 'Eve');
    await E.waitForSelector('#mp-rooms .mr-row', { timeout: 8000 }).catch(() => {});
    const rowsE = await rowsOf(E);
    check('two rooms listed with players and host', rowsE.length >= 2 && rowsE.every((r) => /players/.test(r.meta)), rowsE);
    await E.screenshot({ path: path.join(SHOTS, 'rooms-two-390x844.png') });
    await E.setViewportSize({ width: 844, height: 390 });
    await E.screenshot({ path: path.join(SHOTS, 'rooms-two-844x390.png') });
    await E.setViewportSize({ width: 1366, height: 768 });
    await E.screenshot({ path: path.join(SHOTS, 'rooms-two-1366x768.png') });
    check('no page scroll on the Multiplayer list (list scrolls itself)', await noScroll(E));
  } catch (e) {
    check('e2e run', false, String(e && e.message).slice(0, 300));
  } finally {
    check('no page errors', errors.length === 0, errors.slice(0, 3));
    await Promise.all(ctxs.map((c) => c.close().catch(() => {})));
    await browser.close().catch(() => {});
    server.multiplayer.close();
    await new Promise((r) => server.close(r));
    const failed = checks.filter((c) => !c.ok).length;
    console.log(JSON.stringify({ checks, failed }, null, 2));
    process.exit(failed ? 1 : 0);
  }
}
run();
