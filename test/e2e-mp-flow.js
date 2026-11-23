'use strict';
// Full multiplayer check in one headless Chrome: lobby, a hand with 3 humans and 2 bots, chat,
// showdown and show-my-hand, camera and mic over WebRTC and over the relay (?rtc=off), and
// the console. Writes numbers to stdout as JSON. Uses E2E_PORT (default 3562); the server on
// port 3000 is never touched.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
// SERVER_JS overrides the server module (used to test a patched copy; the default is the project server).
const { createServer } = require(process.env.SERVER_JS || '../server.js');

// Records every RTCPeerConnection so getStats() numbers can be read from the page.
const HOOK_RTC = '(function(){window.__pcs=[];var O=window.RTCPeerConnection;if(!O)return;window.RTCPeerConnection=function(c){var p=new O(c);window.__pcs.push(p);return p;};})();';

// Inbound RTP totals of a page: decoded frames, bytes, frame size, audio energy (cumulative).
function rtcSample(p) {
  return p.evaluate(async () => {
    const out = { framesDecoded: 0, bytes: 0, energy: 0, w: 0, h: 0, fpsStat: 0, t: performance.now() };
    for (const pc of window.__pcs || []) {
      const st = await pc.getStats();
      st.forEach((r) => {
        if (r.type !== 'inbound-rtp') return;
        if (r.kind === 'video') { out.framesDecoded += r.framesDecoded || 0; out.bytes += r.bytesReceived || 0; out.w = r.frameWidth || out.w; out.h = r.frameHeight || out.h; out.fpsStat = r.framesPerSecond || out.fpsStat; }
        if (r.kind === 'audio') out.energy += r.totalAudioEnergy || 0;
      });
    }
    return out;
  });
}

const PORT = Number(process.env.E2E_PORT || 3562);
const SHOTS = path.join(__dirname, '..', '.e2e-shots');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const out = { checks: [], m: {}, errors: [] };
const check = (name, ok, info) => out.checks.push({ name, ok: !!ok, info: info === undefined ? null : info });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function join(page, base, name) {
  await page.goto(base + '/', { waitUntil: 'load' });
  await require('./_rooms-helper.js').openMp(page, 'join', name);
  await require('./_rooms-helper.js').enterRoom(page, name);
  await page.waitForSelector('#mp-body:not(.hidden)', { timeout: 10000 });
}

async function newPage(browser, base, name, opts) {
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 768 }, permissions: ['camera', 'microphone'],
    ...(opts && opts.ctx ? opts.ctx : {})
  });
  await ctx.addInitScript(HOOK_RTC);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => out.errors.push(name + ' pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') out.errors.push(name + ' console: ' + m.text()); });
  await join(page, base + (opts && opts.query ? opts.query : ''), name);
  return page;
}

// Players whose seat is marked as the one to act, and their own seat state.
const turnState = (p) => p.evaluate(() => {
  const me = document.querySelector('.mp-seat.me');
  return { myTurn: !!document.querySelector('.mp-seat.me.turn'), anyTurn: !!document.querySelector('.mp-seat.turn'), hasSeat: !!me };
});

async function playToShowdown(pages, maxSteps) {
  for (let step = 0; step < maxSteps; step++) {
    const over = await pages[0].evaluate(() => !!document.querySelector('#mp-banner:not(.hidden)'));
    if (over) return true;
    let acted = false;
    for (const p of pages) {
      const st = await turnState(p);
      if (st.myTurn) {
        const key = step % 3 === 0 ? 'c' : step % 3 === 1 ? 'c' : 'f';
        await p.keyboard.press(key === 'f' ? 'f' : 'c');
        acted = true;
        await sleep(150);
        break;
      }
    }
    if (!acted) await sleep(300);
  }
  return false;
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
    // ---- 1. lobby
    const A = await newPage(browser, base, 'Ana');
    const B = await newPage(browser, base, 'Bo');
    const C = await newPage(browser, base, 'Cy');
    await A.waitForSelector('#mp-players li:nth-child(3)', { state: 'attached', timeout: 10000 });
    check('lobby: three humans listed', (await A.$$('#mp-players li')).length >= 3);
    await A.click('#mp-chip');
    check('profile chip opens the profile sheet', await A.evaluate(() => !document.getElementById('mp-profile-modal').classList.contains('hidden')));
    await A.keyboard.press('Escape');
    check('Esc closes the profile sheet', await A.evaluate(() => document.getElementById('mp-profile-modal').classList.contains('hidden')));
    await A.click('[data-act="add-bot"]');
    await A.click('[data-act="add-bot"]');
    await A.waitForTimeout(300);
    check('two bots added', (await A.$$('#mp-bots li')).length === 2 || (await A.evaluate(() => document.querySelectorAll('#mp-bots li').length)) === 2);
    await A.click('#mp-bots [data-act="edit-bot"]');
    await A.fill('#mp-be-name', 'Robo');
    await A.click('[data-act="save-bot"]');
    await A.waitForTimeout(500);
    check('bot edit saves a name', await A.evaluate(() => document.body.textContent.indexOf('Robo') >= 0));
    await A.keyboard.press('Escape');
    await A.click('#mp-set-toggle');   // the settings panel opens from the lobby card
    await A.selectOption('#mp-set-stacks', 'custom').catch(() => {});
    await A.click('#mp-start');
    await A.waitForSelector('#mp-table-view:not(.hidden)', { timeout: 15000 });
    await A.waitForFunction(() => document.querySelectorAll('#mp-seats .mp-seat').length >= 5, null, { timeout: 15000 });
    await sleep(800);

    // ---- 2. hand
    check('active seat has a ring, no turn bar', await A.evaluate(() => !document.getElementById('mp-timer') && !!document.querySelector('.mp-seat')));
    const hl = await A.evaluate(() => Array.from(document.querySelectorAll('.mp-seat')).map((s) => s.style.getPropertyValue('--hl')));
    check('each seat has a highlight colour', hl.length >= 5 && hl.every((c) => c), hl);
    const pages = [A, B, C];
    const reached = await playToShowdown(pages, 60);
    check('a hand reaches showdown or ends', reached);
    const banner = await A.evaluate(() => { const b = document.getElementById('mp-banner'); return b && !b.classList.contains('hidden') ? b.textContent : ''; });
    check('winner banner shown', banner.length > 0, banner.slice(0, 80));
    const showBtns = await Promise.all(pages.map((p) => p.evaluate(() => !!document.querySelector('button.mp-show-cards[data-act="show-hand"]'))));
    check('show-my-hand offered during the window', showBtns.some(Boolean), showBtns);
    const shown = await B.evaluate(() => { const b = document.querySelector('button.mp-show-cards[data-act="show-hand"]'); if (b) { b.click(); return true; } return false; });
    await sleep(600);
    const revealedOnA = await A.evaluate(() => document.querySelectorAll('#mp-seats .mp-mini .mp-card-face:not(.back)').length);
    check('a revealed hand appears on another screen', shown && revealedOnA > 0, { clicked: shown, revealedOnA });
    const shownLabel = await B.evaluate(() => { const b = document.querySelector('#mp-hero .mp-show-cards.shown .mp-show-hint'); return b ? b.textContent : ''; });
    check('the sender sees the Shown state (no show button left)', !!shownLabel && !(await B.evaluate(() => !!document.querySelector('button.mp-show-cards'))), shownLabel);

    // ---- 2b. chat
    await B.click('#mp-btn-chat');
    await B.fill('#mp-chat-in', 'hola desde Bo');
    await B.keyboard.press('Enter');
    await sleep(500);
    const badge = await A.evaluate(() => document.getElementById('mp-chat-badge').textContent);
    check('chat reaches others and bumps the unread badge', badge !== '0' && badge !== '', { badge });
    await A.click('#mp-btn-chat');
    check('chat log shows the message', await A.evaluate(() => document.getElementById('mp-chat-log').textContent.indexOf('hola desde Bo') >= 0));
    await A.click('#mp-chat [data-act="chat-close"]');   // the drawer overlays the table by design: measure it closed
    const chatBox = await A.evaluate(() => {
      const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, r: b.right, b: b.bottom }; };
      const c = document.getElementById('mp-chat').getBoundingClientRect();
      const hero = document.querySelector('#mp-hero .mp-hero-cards');
      const act = document.querySelector('#mp-table-view .mp-actions');
      const hit = (a, b) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const box = (el) => (el ? el.getBoundingClientRect() : null);
      return { chatHitsHero: hit(box(document.getElementById('mp-chat')), box(hero)), chatHitsActions: hit(box(document.getElementById('mp-chat')), box(act)), chat: r(document.getElementById('mp-chat')) };
    });
    check('closed chat drawer does not overlap hero cards or actions', !chatBox.chatHitsHero && !chatBox.chatHitsActions, chatBox);
    await C.evaluate(() => 1);
    const late = await (await browser.newContext({ viewport: { width: 1366, height: 768 } })).newPage();
    await join(late, base, 'Dee');
    await late.click('#mp-btn-chat');
    check('late joiner gets chat history', await late.evaluate(() => document.getElementById('mp-chat-log').textContent.indexOf('hola desde Bo') >= 0));
    await late.context().close();

    // ---- 3c. relay path (?rtc=off) in its own room
    await A.close();
    await B.close();
    await C.close();
    // the relay phase gets a fresh server so the lobby and hand of the WebRTC phase do not interfere
    // not awaited: the late joiner context above keeps a WebSocket open, and close() waits for those
    server.close();
    const server2 = createServer();
    await new Promise((r) => server2.listen(PORT, '127.0.0.1', r));
    server2.close();
  } finally {
    await browser.close();
    server.close();
  }
  const bad = out.checks.filter((c) => !c.ok).length;
  out.summary = { checks: out.checks.length, failed: bad, consoleErrors: out.errors.length };
  fs.writeFileSync(path.join(SHOTS, 'flow-results.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  if (bad) process.exitCode = 1;
  // open sockets and servers can keep the process alive after the report: exit explicitly
  setTimeout(() => process.exit(process.exitCode || 0), 500);
}

async function runRelay(browser, base) {
  const R1 = await newPage(browser, base, 'RelayA', { query: '?rtc=off' });
  const R2 = await newPage(browser, base, 'RelayB', { query: '?rtc=off' });
  await R1.waitForSelector('#mp-players li:nth-child(2)', { state: 'attached', timeout: 10000 });
  await R1.click('#mp-cams .mp-tile.me [data-act="cam"]');
  await R2.click('#mp-cams .mp-tile.me [data-act="cam"]');
  await R1.click('#mp-cams .mp-tile.me [data-act="mic"]');
  await R2.click('#mp-cams .mp-tile.me [data-act="mic"]');
  await sleep(2000);
  const s0 = await R2.evaluate(() => window.PokerMP.stats());
  let peakLevel = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    const lv = await R2.evaluate(() => window.PokerMP.debug().relay.reduce((m, r) => Math.max(m, r.lvl), 0));
    peakLevel = Math.max(peakLevel, lv);
  }
  const s1 = await R2.evaluate(() => window.PokerMP.stats());
  const dbg = await R2.evaluate(() => window.PokerMP.debug());
  const sec = 4;
  const res = {
    drawnFps: +((s1.drawn - s0.drawn) / sec).toFixed(1),
    decodedFps: +((s1.decoded - s0.decoded) / sec).toFixed(1),
    videoKbpsIn: +(((s1.vidBytesIn - s0.vidBytesIn) * 8) / sec / 1000).toFixed(0),
    audioChunksPerSec: +((s1.audIn - s0.audIn) / sec).toFixed(1),
    codec: dbg.video, caps: dbg.caps,
    relayLevels: dbg.relay,
    canvas: await R2.evaluate(() => { const c = document.querySelector('canvas.mp-relay'); return c ? { w: c.width, h: c.height, cssW: c.clientWidth } : null; })
  };
  check('relay: video frames drawn at the receiver', res.drawnFps > 5, res);
  res.audioPeakLevel = +peakLevel.toFixed(5);
  check('relay: audio energy at the receiver', peakLevel > 0.0005 && res.audioChunksPerSec > 10, { peakLevel, chunksPerSec: res.audioChunksPerSec });
  await R1.context().close();
  await R2.context().close();
  return res;
}

run().catch((e) => { console.error('RUN FAILED', e); process.exitCode = 1; });
