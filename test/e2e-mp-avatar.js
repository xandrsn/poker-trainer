'use strict';
// Profile photo end to end in two headless Chrome contexts, on the Multiplayer screen. Player A sets the photo
// with Choose photo in the Join panel BEFORE Continue (it is committed on join). B sees it in the lobby list and
// on A's seat plate once a hand runs. A changes it later through the profile dialog (header chip) and B sees the
// new one. A reloads and the saved photo is back on the Join panel. Remove clears it. The PNGs are generated here.
// Uses E2E_PORT (default 5780); the server on port 3000 is never touched.
const zlib = require('zlib');
const { chromium } = require('playwright-core');
const { createServer } = require('../server.js');
const H = require('./_rooms-helper.js');

const PORT = Number(process.env.E2E_PORT || 5780);
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const out = { checks: [], errors: [] };
const check = (name, ok, info) => out.checks.push({ name, ok: !!ok, info: info === undefined ? null : info });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.AVATAR_SHOTS || '';

// A w x h gradient PNG (RGB, 8-bit), so the photo is a real image and not a placeholder.
function makePng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = 230; raw[o + 1] = 70 + (x * 120) / w; raw[o + 2] = 40 + (y * 150) / h;
    }
  }
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// The photo is part of the shared user record (Settings > User, poker-trainer:user:v1): the helpers set it before the
// Multiplayer screen opens, so the entry has no photo picker. Photo changes in a game go through the profile dialog.
const USER_KEY = 'poker-trainer:user:v1';

async function run() {
  const server = createServer();
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const base = 'http://localhost:' + PORT;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    // Entry: the name and photo go into the user record, then the Multiplayer screen opens (it reads the record on open)
    // and the Join finder is expanded. The photo is a real JPEG made in the page (canvas), like the app's own uploads.
    const jpegDataUrl = (p, w, h, seed) => p.evaluate(([w, h, seed]) => {
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const g = cv.getContext('2d'); const gr = g.createLinearGradient(0, 0, w, h);
      gr.addColorStop(0, '#e64628'); gr.addColorStop(1, seed); g.fillStyle = gr; g.fillRect(0, 0, w, h);
      return cv.toDataURL('image/jpeg', 0.85);
    }, [w, h, seed]);
    const mk = async (name, photo) => {
      const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
      const p = await ctx.newPage();
      p.on('pageerror', (e) => out.errors.push(name + ' pageerror: ' + e.message));
      await p.goto(base + '/', { waitUntil: 'load' });
      const photoUrl = photo ? await jpegDataUrl(p, photo.w, photo.h, photo.seed) : '';
      await p.evaluate(([k, v]) => window.localStorage.setItem(k, v), [USER_KEY, JSON.stringify({ name, avatar: photoUrl })]);
      if (!(await p.isVisible('#menu-card-mp'))) await p.click('#hub-play');
      await p.click('#menu-card-mp');
      await p.waitForSelector('#mp-rooms[data-view="choose"]', { timeout: 10000 });
      await p.click('#mr-tile-join');
      await p.waitForSelector('#mr-panel-join:not([hidden])', { timeout: 10000 });
      return p;
    };
    const A = await mk('Ana', { w: 240, h: 180, seed: '#2a6fdb' });
    check('A photo is in the user record before joining', await A.evaluate((k) => (JSON.parse(window.localStorage.getItem(k)) || {}).avatar.startsWith('data:image/jpeg'), USER_KEY));
    if (SHOTS) await A.screenshot({ path: SHOTS + '/avatar-join-1366.png' });
    await H.enterRoom(A, 'Ana');
    await sleep(400);
    check('A header chip shows the photo after joining', await A.evaluate(() => { const i = document.querySelector('#mp-chip-av img'); return !!i && i.src.startsWith('data:image/'); }));

    // B joins the same table list (no photo).
    const B = await mk('Bo', null);
    await H.enterRoom(B, 'Bo');
    await B.waitForFunction(() => document.querySelectorAll('#mp-players li').length >= 2, null, { timeout: 10000 });
    await sleep(400);
    const lobbyImg = await B.evaluate(() => {
      const li = [...document.querySelectorAll('#mp-players li')].find((x) => /Ana/.test(x.textContent));
      const i = li && li.querySelector('img.mp-av');
      return i ? i.src.slice(0, 23) : null;
    });
    check('B sees A photo in the lobby list', lobbyImg === 'data:image/jpeg;base64,', lobbyImg);
    if (SHOTS) await B.screenshot({ path: SHOTS + '/avatar-lobby-390.png' });

    await A.click('#mp-start');
    await A.waitForSelector('#mp-table-view:not(.hidden)', { timeout: 10000 });
    await sleep(900);
    const seatSrc = () => B.evaluate(() => {
      const seat = [...document.querySelectorAll('.mp-seat')].find((x) => /Ana/.test((x.querySelector('.mp-name') || {}).textContent || ''));
      const i = seat && seat.querySelector('img.mp-av');
      return i ? i.src : null;
    });
    const seat1 = await seatSrc();
    check('B sees A photo on A seat plate', !!seat1 && seat1.startsWith('data:image/jpeg;base64,'));
    if (SHOTS) await B.screenshot({ path: SHOTS + '/avatar-seat-1366.png' });

    // A changes the photo later through the profile dialog; B sees the new one on the seat plate.
    await A.click('#mp-chip');
    await A.waitForSelector('#mp-profile-modal:not(.hidden)', { timeout: 5000 });
    const [fc2] = await Promise.all([A.waitForEvent('filechooser'), A.click('#mp-profile-modal [data-act="pick-photo"]')]);
    await fc2.setFiles({ name: 'ana2.png', mimeType: 'image/png', buffer: makePng(200, 260) });
    await A.waitForFunction(() => { const i = document.getElementById('mp-prof-img'); return !!i && !i.classList.contains('hidden') && i.src.startsWith('data:image/jpeg'); }, null, { timeout: 5000 });
    await A.click('#mp-profile-modal [data-act="save-profile"]');
    await B.waitForFunction((old) => {
      const seat = [...document.querySelectorAll('.mp-seat')].find((x) => /Ana/.test((x.querySelector('.mp-name') || {}).textContent || ''));
      const i = seat && seat.querySelector('img.mp-av');
      return !!i && i.src !== old;
    }, seat1, { timeout: 5000 }).catch(() => {});
    const seat2 = await seatSrc();
    out.chipAfterSave = await A.evaluate(() => { const i = document.querySelector('#mp-chip-av img'); return i ? i.src.length : -1; });
    check('B sees A new photo after the profile dialog change', !!seat2 && seat2.startsWith('data:image/') && seat2 !== seat1,
      { same: seat2 === seat1, len1: (seat1 || '').length, len2: (seat2 || '').length, dlg: await A.evaluate(() => { const i = document.getElementById('mp-prof-img'); return i ? i.src.length : -1; }) });
    await A.keyboard.press('Escape').catch(() => {});
    await sleep(200);

    // A reloads: the saved photo is back on the Join panel (remembered across sessions).
    await A.reload({ waitUntil: 'load' });
    await A.click('#mp-chip');
    await A.waitForSelector('#mp-profile-modal:not(.hidden)', { timeout: 5000 });
    check('A photo survives a reload (saved profile)', await A.evaluate(() => { const i = document.getElementById('mp-prof-img'); return !!i && !i.classList.contains('hidden') && i.src.startsWith('data:image/'); }));
    await A.keyboard.press('Escape').catch(() => {});
    await sleep(200);
    check('the saved photo stays in the user record after a reload', await A.evaluate((k) => (JSON.parse(window.localStorage.getItem(k)) || {}).avatar.startsWith('data:image/'), USER_KEY));
    await A.click('#mp-chip');
    await A.waitForSelector('#mp-profile-modal:not(.hidden)', { timeout: 5000 });
    await A.click('#mp-profile-modal [data-act="clear-photo"]');
    check('Remove clears the photo in the profile dialog', await A.evaluate(() => { const i = document.getElementById('mp-prof-img'); return !!i && i.classList.contains('hidden'); }));
    await A.click('#mp-profile-modal [data-act="save-profile"]');
    await A.waitForFunction((k) => (JSON.parse(window.localStorage.getItem(k)) || {}).avatar === '', USER_KEY, { timeout: 5000 }).catch(() => {});
    check('Remove + save clears the saved photo', await A.evaluate((k) => (JSON.parse(window.localStorage.getItem(k)) || {}).avatar === '', USER_KEY));
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
  const failed = out.checks.filter((c) => !c.ok);
  out.passed = out.checks.length - failed.length;
  out.failed = failed.length;
  console.log(JSON.stringify(out, null, 2));
  process.exit(failed.length || out.errors.length ? 1 : 0);
}

run().catch((e) => { console.error('FAIL', e); process.exit(1); });
