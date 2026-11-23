'use strict';
// New multiplayer checks in one headless Chrome against an in-process server (E2E_PORT, default 3690):
// (1) getUserMedia is never called (lobby and hand), (2) chat drawer open/close and unread badge + toast,
// (3) system win lines in EN (A) and ES (C, client language set to Spanish), showdown and fold-win,
// (4) Fold stays enabled with opacity < 0.6 when Check is free and ~1 when facing a bet,
// (5) back arrow popup: Stay / Esc keep the table, Leave goes back to the menu and clears the session.
// One context per player (3 players, 1366x768). Writes JSON checks to stdout.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { createServer } = require('../server.js');

const PORT = Number(process.env.E2E_PORT || 3690);
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SHOTS = path.join(__dirname, '..', '.e2e-shots');
const out = { checks: [], errors: [], m: {} };
const check = (name, ok, info) => out.checks.push({ name, ok: !!ok, info: info === undefined ? null : info });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 6);

// Counts getUserMedia calls on each page; the stub rejects so nothing can start a camera or mic.
const GUM_STUB = '(function(){window.__gum=0;try{var md=navigator.mediaDevices;if(md){md.getUserMedia=function(){window.__gum++;return Promise.reject(new DOMException("stub","NotAllowedError"));};}}catch(e){}})();';
const ES_LANG = "try{localStorage.setItem('poker-trainer:lang:v1','es');}catch(e){}";

async function newPage(browser, base, name, lang) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx.addInitScript(GUM_STUB);
  if (lang) await ctx.addInitScript(ES_LANG);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => out.errors.push(name + ' pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) out.errors.push(name + ' console: ' + m.text()); });
  await page.goto(base + '/', { waitUntil: 'load' });
  await require('./_rooms-helper.js').openMp(page, 'join', name);
  await require('./_rooms-helper.js').enterRoom(page, name);
  await page.waitForSelector('#mp-body:not(.hidden)', { timeout: 10000 });
  return page;
}

const visible = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; }, sel);
const chatOpen = (p) => p.evaluate(() => document.getElementById('mp-chat').classList.contains('open'));
const badgeText = (p) => p.evaluate(() => { const b = document.getElementById('mp-chat-badge'); return { t: b.textContent, hidden: b.classList.contains('hidden') }; });
const logText = (p) => p.evaluate(() => document.getElementById('mp-chat-log').textContent);
const winCount = async (p) => ((await logText(p)).match(/won the hand|ganó la mano/g) || []).length;

// The page whose turn it is: its #mp-call is enabled.
async function turnPage(pages) {
  for (const x of pages) {
    const on = await x.p.evaluate(() => { const c = document.getElementById('mp-call'); return !!c && !c.disabled && c.getClientRects().length > 0; });
    if (on) return x;
  }
  return null;
}

// Plays one hand to its end. mode 'fold': everyone folds to one winner. mode 'call': everyone calls/checks down.
// Samples the Fold button opacity on each turn (free check vs facing a bet). Returns when A logs a new win line.
async function playHand(pages, A, mode, samples) {
  const before = await winCount(A);
  for (let i = 0; i < 300; i++) {
    if ((await winCount(A)) > before) return true;
    const t = await turnPage(pages);
    if (!t) { await sleep(120); continue; }
    await sleep(220);   // let the class toggle transition settle before reading opacity
    const f = await t.p.evaluate(() => {
      const b = document.getElementById('mp-fold');
      return { free: b.classList.contains('free-check'), op: parseFloat(getComputedStyle(b).opacity), disabled: b.disabled };
    });
    if (samples && !f.disabled) samples.push(f);
    await t.p.evaluate((m) => document.getElementById(m === 'fold' ? 'mp-fold' : 'mp-call').click(), mode);
    await sleep(100);
  }
  return (await winCount(A)) > before;
}

async function run() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = createServer();
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const base = 'http://localhost:' + PORT;
  const browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required']
  });
  try {
    const A = await newPage(browser, base, 'A' + tag);
    const B = await newPage(browser, base, 'B' + tag);
    const C = await newPage(browser, base, 'C' + tag, true);   // client language Spanish
    const pages = [{ n: 'A', p: A }, { n: 'B', p: B }, { n: 'C', p: C }];
    const gum = async () => Promise.all(pages.map((x) => x.p.evaluate(() => window.__gum || 0)));

    // ---- (1) lobby: no getUserMedia calls
    check('(1) getUserMedia not called in the lobby', (await gum()).every((n) => n === 0), await gum());

    await A.waitForSelector('#mp-players li:nth-child(3)', { state: 'attached', timeout: 10000 }).catch(() => {});
    await A.click('#mp-start');
    await A.waitForFunction(() => document.querySelectorAll('#mp-seats .mp-seat').length >= 3, null, { timeout: 15000 });
    await sleep(600);

    // ---- (2) chat drawer: open/close by X, Esc, outside click; unread badge and toast while closed
    await A.click('#mp-btn-chat');
    check('(2) chat drawer opens on the chat button', await chatOpen(A));
    await A.click('#mp-chat [data-act="chat-close"]');
    check('(2) chat drawer closes by the X', !(await chatOpen(A)));
    await A.click('#mp-btn-chat');
    await A.keyboard.press('Escape');
    check('(2) chat drawer closes with Esc', !(await chatOpen(A)));
    await A.click('#mp-btn-chat');
    const neutral = await A.evaluate(() => { const r = document.getElementById('mp-table-view').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * 0.3) }; });
    await A.mouse.click(neutral.x, neutral.y);   // outside the drawer, on the table felt away from the controls
    await sleep(150);
    check('(2) chat drawer closes on an outside click', !(await chatOpen(A)));

    await B.click('#mp-btn-chat');
    await B.fill('#mp-chat-in', 'hola desde B');
    await B.press('#mp-chat-in', 'Enter');
    await A.waitForFunction(() => { const t = document.getElementById('mp-chat-toast'); return !!t && t.classList.contains('show'); }, null, { timeout: 2000 }).catch(() => {});
    const bd = await badgeText(A);
    check('(2) closed drawer: unread badge counts the new message', bd.t === '1' && !bd.hidden, bd);
    const toast = await A.evaluate(() => { const t = document.getElementById('mp-chat-toast'); return { show: t.classList.contains('show'), text: t.textContent }; });
    check('(2) closed drawer: toast shows "Name: text"', toast.show && toast.text.indexOf('hola desde B') >= 0, toast);
    await A.click('#mp-btn-chat');
    const bd2 = await badgeText(A);
    check('(2) opening the drawer clears the badge', bd2.t === '0' && bd2.hidden, bd2);
    await A.click('#mp-chat [data-act="chat-close"]');
    await B.click('#mp-chat [data-act="chat-close"]').catch(() => {});

    // ---- (3) + (4) hands: alternate fold-win and call-down until the four win lines are seen (max 40 hands)
    const got = { enWin: false, enFold: false, esWin: false, esFold: false };
    const fold = { samples: [] };
    let hands = 0;
    let gumMid = null;
    for (let h = 0; h < 40; h++) {
      const mode = h % 2 === 0 ? 'fold' : 'call';
      await playHand(pages, A, mode, fold.samples);
      hands++;
      if (gumMid === null) gumMid = await gum();   // after the first hand: still no camera or mic access
      const la = await logText(A), lc = await logText(C);
      got.enWin = got.enWin || la.indexOf('won the hand with') >= 0;
      got.enFold = got.enFold || la.indexOf('everyone folded') >= 0;
      got.esWin = got.esWin || lc.indexOf('ganó la mano con') >= 0;
      got.esFold = got.esFold || lc.indexOf('todos se retiraron') >= 0;
      if (got.enWin && got.enFold && got.esWin && got.esFold) break;
    }
    check('(1) getUserMedia not called during a hand', gumMid && gumMid.every((n) => n === 0), gumMid);
    check('(3) EN showdown line "won the hand with" in the drawer log (A)', got.enWin, { hands });
    check('(3) ES showdown line "ganó la mano con" in the drawer log (C, Spanish)', got.esWin, { hands });
    check('(3) EN fold-win line "everyone folded" (A)', got.enFold, { hands });
    check('(3) ES fold-win line "todos se retiraron" (C, Spanish)', got.esFold, { hands });
    const free = fold.samples.filter((s) => s.free), facing = fold.samples.filter((s) => !s.free);
    check('(4) Fold enabled and opacity < 0.6 when Check is free', free.length > 0 && free.every((s) => s.op < 0.6),
      { n: free.length, max: free.length ? Math.max.apply(null, free.map((s) => s.op)) : null });
    check('(4) Fold opacity ~1 when facing a bet', facing.length > 0 && facing.every((s) => s.op >= 0.95),
      { n: facing.length, min: facing.length ? Math.min.apply(null, facing.map((s) => s.op)) : null });
    out.m.hands = hands;

    // ---- (5) back popup on C (at the table)
    check('(5) C is at the table', await visible(C, '#mp-table-view'));
    await C.evaluate(() => document.querySelector('button.mp-back').click());
    check('(5) back arrow opens the Leave popup', await visible(C, '#mp-leave'));
    await C.keyboard.press('Escape');
    check('(5) Esc closes the popup and keeps the table', !(await visible(C, '#mp-leave')) && await visible(C, '#mp-table-view'));
    await C.evaluate(() => document.querySelector('button.mp-back').click());
    await C.click('#mp-leave [data-leave="stay"]');
    check('(5) Stay keeps the table', !(await visible(C, '#mp-leave')) && await visible(C, '#mp-table-view'));
    await C.evaluate(() => document.querySelector('button.mp-back').click());
    await C.click('#mp-leave [data-leave="go"]');
    await sleep(400);
    check('(5) Leave goes back to the Rooms list', await C.evaluate(() => { const e = document.getElementById('mp-rooms'); return !!e && !e.hidden && e.getClientRects().length > 0; }) && !(await visible(C, '#mp-table-view')));
    const sess = await C.evaluate(() => sessionStorage.getItem('poker-trainer:mp:session'));
    check('(5) Leave clears the sessionStorage session', sess === null, sess);
  } finally {
    out.checks.push({ name: 'no console or page errors', ok: out.errors.length === 0, info: out.errors.slice(0, 5) });
    await browser.close();
    server.close();
    const failed = out.checks.filter((c) => !c.ok);
    console.log(JSON.stringify(out, null, 1));
    console.log(failed.length ? 'FAILED: ' + failed.map((c) => c.name).join('; ') : 'e2e-mp-new: all ' + out.checks.length + ' checks passed');
    if (failed.length) process.exitCode = 1;
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  }
}

run().catch((e) => { console.error(e); process.exitCode = 1; });
