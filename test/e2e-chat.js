'use strict';
// Chat extras in one headless Chrome against an in-process server (fresh port 3650-3669): one browser,
// one context per player. A is the host (adds a bot, starts); B chats in the right-edge chat drawer,
// uploads a custom emoji and sends it. A (drawer closed) gets a toast and bubbles over B's seat.
// Bubbles only sit over seats/bench (no camera tiles). Checks bad uploads, Unicode emoji, console errors.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const { createServer } = require('../server.js');
let BASE = process.env.E2E_BASE || '';
const SHOTS = path.join(__dirname, '..', '.e2e-shots');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const out = { checks: [], errors: [], m: {} };
const check = (name, ok, info) => out.checks.push({ name, ok: !!ok, info: info === undefined ? null : info });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 6);

async function join(page, name) {
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await require('./_rooms-helper.js').openMp(page, 'join', name);
  await require('./_rooms-helper.js').enterRoom(page, name);
  try {
    await page.waitForSelector('#mp-body:not(.hidden)', { timeout: 10000 });
  } catch (e) {
    const why = await page.evaluate(() => (document.getElementById('mp-err') || {}).textContent || '');
    throw new Error('join failed for ' + name + ': ' + why);
  }
}

async function newPage(ctx, name) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => out.errors.push(name + ' pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) out.errors.push(name + ' console: ' + m.text()); });
  await join(page, name);
  return page;
}

// Chat drawer helpers: #mp-chat gets class "open"; #mp-btn-chat toggles it; the X is data-act="chat-close".
const chatOpen = (p) => p.evaluate(() => document.getElementById('mp-chat').classList.contains('open'));
async function openChat(p) {
  if (!(await chatOpen(p))) await p.click('#mp-btn-chat');
  await p.waitForSelector('#mp-chat.open', { timeout: 3000 });
  await p.waitForFunction(() => !document.getElementById('mp-chat-body').classList.contains('hidden'), null, { timeout: 3000 });
}
async function closeChat(p) {
  if (await chatOpen(p)) await p.click('#mp-chat [data-act="chat-close"]');
  await p.waitForFunction(() => !document.getElementById('mp-chat').classList.contains('open'), null, { timeout: 3000 });
}
// Emoji picker: #mp-emo-pop is hidden unless open; #mp-emo-btn (in the drawer) toggles it.
const emoOpen = (p) => p.evaluate(() => !document.getElementById('mp-emo-pop').classList.contains('hidden'));
async function setEmoPicker(p, want) {
  if ((await emoOpen(p)) !== want) await p.click('#mp-emo-btn');
}

// Bubbles currently on screen on a page: text, class (above | ...), emoji images.
const bubbles = (p) => p.evaluate(() => Array.from(document.querySelectorAll('#mp-fx .mp-bub.on')).map((b) => ({
  text: b.textContent, cls: b.className, img: b.querySelectorAll('img.mp-emoji').length,
  shown: b.style.display !== 'none'
})));

async function run() {
  fs.mkdirSync(SHOTS, { recursive: true });
  let server = null;
  if (!BASE) {
    server = createServer();
    const port = Number(process.env.E2E_PORT || 3650);
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
    BASE = 'http://localhost:' + port;
  }
  const browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required']
  });
  try {
    // One browser, one context per player: the client stores its identity in localStorage.
    const newCtx = () => browser.newContext({ viewport: { width: 1366, height: 768 } });
    const A = await newPage(await newCtx(), 'A' + tag);
    const B = await newPage(await newCtx(), 'B' + tag);
    const nameB = 'B' + tag;
    await A.waitForSelector('#mp-players li:nth-child(2)', { state: 'attached', timeout: 10000 });
    await A.click('[data-act="add-bot"]');
    await A.click('#mp-start');
    await A.waitForFunction(() => document.querySelectorAll('#mp-seats .mp-seat').length >= 2, null, { timeout: 15000 });
    await sleep(500);

    // ---- toast: B sends while A's chat drawer is closed
    check('A chat drawer is closed', !(await chatOpen(A)) && await A.evaluate(() => document.getElementById('mp-chat-body').classList.contains('hidden')));
    await openChat(B);
    await B.fill('#mp-chat-in', 'hola a todos');
    const t0 = Date.now();
    await B.press('#mp-chat-in', 'Enter');
    let toastMs = null;
    try {
      await A.waitForFunction((n) => {
        const t = document.getElementById('mp-chat-toast');
        return !!t && t.classList.contains('show') && t.textContent.indexOf(n + ': hola') === 0;
      }, nameB, { timeout: 1000 });
      toastMs = Date.now() - t0;
    } catch (e) { /* recorded below */ }
    check('toast on A within 1 s with "Name: text"', toastMs !== null, { ms: toastMs });
    await openChat(A);
    check('A chat log has the message', await A.evaluate(() => document.getElementById('mp-chat-log').textContent.indexOf('hola a todos') >= 0));
    await closeChat(A);

    // ---- bubbles: over B's seat on A (seat bubbles only, no camera-tile bubbles any more)
    await A.waitForFunction(() => Array.from(document.querySelectorAll('#mp-fx .mp-bub.on')).some((b) => b.textContent.indexOf('hola') >= 0), null, { timeout: 2000 }).catch(() => {});
    const onA = await bubbles(A);
    check('bubble over B\'s seat on A', onA.some((b) => /\babove\b/.test(b.cls) && b.text.indexOf('hola') >= 0), onA);
    check('no bubble on camera tiles (only seats and bench)', !onA.some((b) => /\bcam\b/.test(b.cls)), onA);
    const geo = await A.evaluate(() => {
      const bub = Array.from(document.querySelectorAll('#mp-fx .mp-bub.on')).find((b) => b.textContent.indexOf('hola') >= 0);
      const r = bub ? bub.getBoundingClientRect() : null;
      return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
    });
    check('bubble stays inside the 1366 viewport', !!geo && geo.x >= 0 && geo.y >= 0 && geo.x + geo.w <= 1366, geo);
    await A.screenshot({ path: path.join(SHOTS, 'mp5b-1366-toast-bubble-A.png') });
    const onB = await bubbles(B);
    check('B sees its own bubble over its seat', onB.some((b) => /\babove\b/.test(b.cls) && b.text.indexOf('hola') >= 0), onB);

    // ---- custom emoji on B: canvas PNG, name prompt, then ':wave:' in the chat (B's drawer is open)
    await openChat(B);
    await sleep(5200);   // let the first bubbles expire before the next round
    const png = await B.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 32; c.height = 32;
      const x = c.getContext('2d'); x.fillStyle = '#e5484d'; x.fillRect(0, 0, 32, 32);
      x.fillStyle = '#fff'; x.fillRect(8, 8, 16, 16);
      return c.toDataURL('image/png');
    });
    const pngFile = path.join(SHOTS, 'mp5b-emoji-src.png');
    fs.writeFileSync(pngFile, Buffer.from(png.split(',')[1], 'base64'));
    // The emoji name is asked in the in-app popup (PokerAsk, #app-ask), not window.prompt.
    await B.setInputFiles('#mp-emo-file', pngFile);
    await B.waitForSelector('#app-ask .mp-ask-in', { timeout: 5000 }).catch(() => {});
    await B.fill('#app-ask .mp-ask-in', 'wave').catch(() => {});
    await B.click('#app-ask [data-ask="ok"]').catch(() => {});
    await B.waitForFunction(() => !!document.querySelector('.mp-emo-cell[data-emo="wave"]'), null, { timeout: 5000 }).catch(() => {});
    const emoCount = await B.evaluate(() => document.querySelectorAll('.mp-emo-cell[data-emo]').length);
    check('upload: emoji saved as "wave"', emoCount === 1 && await B.evaluate(() => !!localStorage.getItem('poker-trainer:mp:emoji:v1')));
    await setEmoPicker(B, true);
    check('picker opens (in the drawer) with own emoji and an add button', await emoOpen(B) && !!(await B.$('.mp-emo-cell.add')));
    await B.screenshot({ path: path.join(SHOTS, 'mp5b-1366-picker-B.png') });
    await B.click('.mp-emo-cell[data-emo="wave"]');
    check('picking an emoji inserts :id: into the input', await B.evaluate(() => document.getElementById('mp-chat-in').value.indexOf(':wave:') >= 0));
    await B.press('#mp-chat-in', 'Enter');
    await setEmoPicker(B, false);
    await openChat(A);
    await A.waitForFunction(() => document.querySelectorAll('#mp-chat-log img.mp-emoji').length > 0, null, { timeout: 4000 }).catch(() => {});
    check('A renders the emoji as an <img> in the chat log', await A.evaluate(() => document.querySelectorAll('#mp-chat-log img.mp-emoji').length > 0));
    await closeChat(A);
    const emojiBub = await bubbles(A);
    check('A renders the emoji in the bubble too', emojiBub.some((b) => b.img > 0), emojiBub);
    const src = await A.evaluate(() => { const i = document.querySelector('#mp-chat-log img.mp-emoji'); return i ? i.getAttribute('src').slice(0, 22) : null; });
    check('emoji src is a PNG data URL', src === 'data:image/png;base64,', src);
    // The source PNG has a solid red background: after knock-out its corner pixel must be transparent.
    const corner = await A.evaluate(() => new Promise((res) => {
      const i = document.querySelector('#mp-chat-log img.mp-emoji') || document.querySelector('#mp-fx img.mp-emoji');
      if (!i) return res(null);
      const go = () => { const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight;
        const x = c.getContext('2d'); x.drawImage(i, 0, 0); try { res(x.getImageData(0, 0, 1, 1).data[3]); } catch (e) { res(-1); } };
      if (i.complete) go(); else i.onload = go;
    }));
    check('custom PNG with opaque background: corner pixel transparent (no box)', corner === 0, corner);

    // ---- Unicode emoji: quick row in the picker, sent from B, rendered on A (chat list and bubble)
    await openChat(B);
    await setEmoPicker(B, true);
    const quick = await B.evaluate(() => ({ n: document.querySelectorAll('.mp-emo-q').length,
      named: Array.from(document.querySelectorAll('.mp-emo-q')).every((b) => b.getAttribute('aria-label') && b.getAttribute('title')) }));
    check('picker quick row: 24 Unicode emojis with aria-label and title', quick.n === 24 && quick.named, quick);
    const popBox = await B.evaluate(() => { const r = document.getElementById('mp-emo-pop').getBoundingClientRect();
      return { w: r.width, h: r.height, bottom: r.bottom, right: r.right, vw: innerWidth, vh: innerHeight }; });
    check('picker box inside the 1366x768 viewport', popBox.w > 0 && popBox.bottom <= popBox.vh && popBox.right <= popBox.vw, popBox);
    await B.screenshot({ path: path.join(SHOTS, 'mp5b-1366-quick-picker-B.png') });
    await B.click('.mp-emo-q[data-uni="\u{1F602}"]');
    check('quick row inserts the Unicode emoji into the input', await B.evaluate(() => document.getElementById('mp-chat-in').value === '\u{1F602}'));
    await sleep(2500);
    await B.press('#mp-chat-in', 'Enter');
    await setEmoPicker(B, false);
    await A.waitForFunction(() => document.querySelectorAll('#mp-fx .mp-uemo').length > 0, null, { timeout: 4000 }).catch(() => {});
    const uniBub = await A.evaluate(() => { const b = Array.from(document.querySelectorAll('#mp-fx .mp-bub.on')).find((x) => x.querySelector('.mp-uemo'));
      if (!b) return null; const s = b.querySelector('.mp-uemo').getBoundingClientRect(); return { w: s.width, h: s.height }; });
    check('A bubble: Unicode emoji box > 24px', !!uniBub && Math.max(uniBub.w, uniBub.h) > 24, uniBub);
    await openChat(A);
    await sleep(300);
    const uniList = await A.evaluate(() => { const s = document.querySelector('#mp-chat-log .mp-uemo'); if (!s) return null;
      const r = s.getBoundingClientRect(); return { w: r.width, h: r.height, font: getComputedStyle(s).fontSize }; });
    check('A chat list: Unicode emoji box > 24px', !!uniList && Math.max(uniList.w, uniList.h) > 24, uniList);
    await A.screenshot({ path: path.join(SHOTS, 'mp5b-1366-chat-view-A.png') });
    await closeChat(A);
    // Bubble position against the top bar and the toast (1366x768)
    const geoBub = async (p) => p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('#mp-fx .mp-bub.on')).find((x) => x.style.display !== 'none' && x.textContent.trim());
      if (!b) return null;
      const r = b.getBoundingClientRect(), tb = document.querySelector('.mp-tbar');
      const tr1 = tb ? tb.getBoundingClientRect() : { left: 0, top: 0, right: 0, bottom: 0 };
      const toast = document.getElementById('mp-chat-toast'), t = toast.getBoundingClientRect();
      const hit = (a, c) => a.left < c.right && c.left < a.right && a.top < c.bottom && c.top < a.bottom;
      return { x: r.left, y: r.top, r: r.right, b: r.bottom, vw: innerWidth, vh: innerHeight,
        inside: r.left >= 7.5 && r.top >= 7.5 && r.right <= innerWidth - 7.5 && r.bottom <= innerHeight - 7.5,
        overTbar: hit(r, tr1), overToast: toast.classList.contains('show') && hit(r, t) };
    });
    const gA = await geoBub(A);
    check('A bubble inside viewport (>= 8px), not over top bar or toast', !!gA && gA.inside && !gA.overTbar && !gA.overToast, gA);

    // ---- refusals on B (client-side)
    const refuse = async (file, expect) => {
      await setEmoPicker(B, true);
      await B.evaluate(() => { document.getElementById('mp-emo-msg').textContent = ''; });
      await B.setInputFiles('#mp-emo-file', file);
      await B.waitForFunction(() => document.getElementById('mp-emo-msg').textContent.length > 0, null, { timeout: 3000 }).catch(() => {});
      const msg = await B.evaluate(() => document.getElementById('mp-emo-msg').textContent);
      return { msg: msg, ok: msg.length > 0 && msg.indexOf(expect) >= 0 };
    };
    const r1 = await refuse({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hola') }, 'PNG');
    check('text file refused (not PNG)', r1.ok, r1.msg);
    const r2 = await refuse({ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('definitely not a png') }, 'PNG');
    check('fake PNG (bad signature) refused', r2.ok, r2.msg);
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const r3 = await refuse({ name: 'huge.png', mimeType: 'image/png', buffer: Buffer.concat([sig, Buffer.alloc(Math.round(4.5 * 1024 * 1024))]) }, 'big');
    check('oversized file refused client-side', r3.ok, r3.msg);
    const countAfter = await B.evaluate(() => document.querySelectorAll('.mp-emo-cell[data-emo]').length);
    check('refused files add nothing', countAfter === 1, countAfter);
    await B.screenshot({ path: path.join(SHOTS, 'mp5b-1366-refused-B.png') });
    await setEmoPicker(B, false);
    await closeChat(B);

    // ---- 844x390 phone-landscape: toast and seat bubble again, page does not scroll
    await A.setViewportSize({ width: 844, height: 390 });
    await B.setViewportSize({ width: 844, height: 390 });
    await sleep(600);
    await openChat(B);
    await B.fill('#mp-chat-in', 'otra vez');
    await B.press('#mp-chat-in', 'Enter');
    const t1 = Date.now();
    let toast2 = null;
    try {
      await A.waitForFunction(() => {
        const t = document.getElementById('mp-chat-toast');
        return !!t && t.classList.contains('show') && t.textContent.indexOf('otra vez') >= 0;
      }, null, { timeout: 1000 });
      toast2 = Date.now() - t1;
    } catch (e) { /* recorded below */ }
    check('844x390: toast on A within 1 s', toast2 !== null, { ms: toast2 });
    await sleep(300);
    const small = await bubbles(A);
    // At lv2/lv3 detail (short table) the table hides seat bubbles by design (TABLE_SMALL in mp.js): reported, not failed.
    const lvSmall = await A.evaluate(() => /(^|\s)lv[23](\s|$)/.test(document.getElementById('mp-table').className));
    check('844x390: seat bubble for the new message on A (or table at lv2/lv3, bubbles hidden by design)', lvSmall || small.some((b) => /\babove\b/.test(b.cls) && b.text.indexOf('otra vez') >= 0), { lvSmall, small });
    const noScroll = await A.evaluate(() => ({
      w: document.documentElement.scrollWidth <= window.innerWidth + 1,
      h: document.documentElement.scrollHeight <= window.innerHeight + 1
    }));
    check('844x390: no page scroll on A', noScroll.w && noScroll.h, noScroll);
    await A.screenshot({ path: path.join(SHOTS, 'mp5b-844-toast-bubble-A.png') });
    await B.screenshot({ path: path.join(SHOTS, 'mp5b-844-B.png') });
    await closeChat(B);

    // ---- reload mid-hand: back in Multiplayer at the same seat, same stack
    const seatInfo = (p) => p.evaluate(() => ({
      stack: ((document.querySelector('#mp-seats .mp-seat.me .mp-stack')) || {}).textContent || '',
      cards: document.querySelectorAll('#mp-hero .mp-card, #mp-hero .mp-card-face').length
    }));
    const beforeReload = await seatInfo(B);
    await B.reload({ waitUntil: 'load' });
    await B.waitForSelector('#mp-body:not(.hidden) #mp-seats .mp-seat.me', { timeout: 15000 }).catch(() => {});
    await sleep(800);
    const afterReload = await seatInfo(B);
    check('reload mid-hand: back in Multiplayer at the same seat', afterReload.stack !== '' && afterReload.stack === beforeReload.stack, { beforeReload, afterReload });
    check('reload mid-hand: hole cards back', beforeReload.cards === 0 || afterReload.cards === beforeReload.cards, { beforeReload, afterReload });

    // ---- phone portrait 390x844: a Unicode emoji bubble on A stays inside the screen, below the top bar
    await A.setViewportSize({ width: 390, height: 844 });
    await B.setViewportSize({ width: 390, height: 844 });
    await sleep(600);
    await openChat(B);
    await B.fill('#mp-chat-in', '\u{1F525}\u{1F525} vamos');
    await B.press('#mp-chat-in', 'Enter');
    await A.waitForFunction(() => Array.from(document.querySelectorAll('#mp-fx .mp-bub.on')).some((x) => x.querySelector('.mp-uemo')), null, { timeout: 4000 }).catch(() => {});
    await sleep(300);
    const g390 = await geoBub(A);
    check('390x844: Unicode emoji bubble on A inside viewport, not over top bar or toast', !!g390 && g390.inside && !g390.overTbar && !g390.overToast, g390);
    await A.screenshot({ path: path.join(SHOTS, 'mp5b-390-bubble-A.png') });
    await B.screenshot({ path: path.join(SHOTS, 'mp5b-390-B.png') });
  } finally {
    out.checks.push({ name: 'no console or page errors', ok: out.errors.length === 0, info: out.errors.slice(0, 5) });
    await browser.close();
    if (server) server.close();
    const failed = out.checks.filter((c) => !c.ok);
    console.log(JSON.stringify(out.checks, null, 1));
    console.log(failed.length ? 'FAILED: ' + failed.map((c) => c.name).join('; ') : 'e2e-chat: all ' + out.checks.length + ' checks passed');
    if (failed.length) process.exitCode = 1;
    setTimeout(() => process.exit(process.exitCode || 0), 200);   // websocket keep-alives can hold the loop open
  }
}

run().catch((e) => { console.error(e); process.exitCode = 1; });
