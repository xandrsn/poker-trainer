'use strict';
// End-to-end check of the multiplayer page in real Chrome (system install, driven by playwright-core).
// Not part of `npm test`: run with `npm run e2e`. CHROME_PATH overrides the browser location.
// Starts the real server on E2E_PORT (default 3555) and drives independent browser contexts.
// Writes results.json and screenshots to E2E_SHOTS (default ./.e2e-shots).
//
// Covers: WebRTC camera and mic (both directions, toggles, denied-then-retry, layout at 1366x768,
// 1920x1080 and a 390x844 phone), and the server relay with WebRTC switched off (?rtc=off):
// frames per second, bytes, drawn pixels, and audio chunks.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { createServer } = require('../server.js');

const PORT = Number(process.env.E2E_PORT || 3555);
const SHOTS = process.env.E2E_SHOTS || path.join(__dirname, '..', '.e2e-shots');
const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean);

const results = { checks: [], measures: {}, console: [], pageerror: [], http: [], failedRequests: [] };
function check(name, ok, info) {
  results.checks.push({ name, ok: !!ok, info: info === undefined ? null : info });
}

function findChrome() {
  const hit = CANDIDATES.find((p) => fs.existsSync(p));
  if (!hit) throw new Error('No Chrome/Edge found. Set CHROME_PATH.');
  return hit;
}

// Records every RTCPeerConnection so the page can report getStats() numbers.
const HOOK_RTC = `
  (function () {
    window.__pcs = [];
    var Orig = window.RTCPeerConnection;
    if (!Orig) return;
    window.RTCPeerConnection = function (cfg) { var pc = new Orig(cfg); window.__pcs.push(pc); return pc; };
  })();
`;

// Finds a tile element: 'me' for the local tile, or a remote tile by the start of its name.
const PICK = "(function (name, sel) { var tiles = Array.prototype.slice.call(document.querySelectorAll('#mp-cams .mp-tile'));" +
  " var t = name === 'me' ? tiles.filter(function (x) { return x.classList.contains('me'); })[0]" +
  " : tiles.filter(function (x) { var n = x.querySelector('.mp-tile-name'); return !x.classList.contains('me') && n && n.textContent.indexOf(name) === 0; })[0];" +
  " return t ? t.querySelector(sel) : null; })";

async function probe(page, name, sel) {
  return page.evaluate(([p, n, s]) => {
    const el = eval(p)(n, s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const out = { box: { w: Math.round(r.width), h: Math.round(r.height) } };
    if (el.tagName === 'VIDEO') {
      return Object.assign(out, {
        kind: 'video', w: el.videoWidth, h: el.videoHeight, readyState: el.readyState, paused: el.paused,
        time: +el.currentTime.toFixed(3), muted: el.muted,
        tracks: el.srcObject ? el.srcObject.getTracks().map((t) => t.kind + ':' + t.readyState) : []
      });
    }
    if (el.tagName === 'CANVAS') {
      const d = el.getContext('2d').getImageData(0, 0, el.width, el.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 16) sum += d[i] + d[i + 1] + d[i + 2];
      return Object.assign(out, { kind: 'canvas', nonBlank: sum > 0, sum });
    }
    return Object.assign(out, { kind: el.tagName });
  }, [PICK, name, sel]);
}

async function waitVideo(page, name, timeout) {
  try {
    await page.waitForFunction(([p, n]) => {
      const v = eval(p)(n, 'video');
      return !!v && v.videoWidth > 0 && v.readyState >= 2 && v.currentTime > 0;
    }, [PICK, name], { timeout: timeout || 20000, polling: 250 });
    return true;
  } catch (e) {
    return false;
  }
}

async function waitCanvas(page, name, timeout) {
  try {
    await page.waitForFunction(([p, n]) => {
      const c = eval(p)(n, 'canvas.mp-relay');
      if (!c || !c.width) return false;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 64) if (d[i] + d[i + 1] + d[i + 2] > 0) return true;
      return false;
    }, [PICK, name], { timeout: timeout || 20000, polling: 250 });
    return true;
  } catch (e) {
    return false;
  }
}

// Current pressed state of one of the local tile's buttons ('cam' or 'mic').
function pressed(page, which) {
  return page.evaluate((w) => {
    const b = document.querySelector('#mp-cams .mp-tile.me [data-act="' + w + '"]');
    return b ? b.getAttribute('aria-pressed') : null;
  }, which);
}

async function waitPressed(page, which, value, timeout) {
  try {
    await page.waitForFunction(([w, v]) => {
      const b = document.querySelector('#mp-cams .mp-tile.me [data-act="' + w + '"]');
      return !!b && b.getAttribute('aria-pressed') === v;
    }, [which, value], { timeout: timeout || 15000 });
    return true;
  } catch (e) {
    return false;
  }
}

function muteShown(page, name) {
  return page.evaluate(([p, n]) => !!eval(p)(n, '.mp-ind'), [PICK, name]);
}

async function status(page, name) {
  return page.evaluate(([p, n]) => {
    const t = eval(p)(n, '.mp-tile-status');
    return t ? t.textContent : null;
  }, [PICK, name]);
}

// Frames decoded and audio energy from inbound RTP stats, summed over all peer connections.
function rtpStats(page) {
  return page.evaluate(async () => {
    const out = { video: { framesDecoded: 0, bytes: 0 }, audio: { energy: 0, samples: 0, bytes: 0 } };
    for (const pc of window.__pcs || []) {
      const st = await pc.getStats();
      st.forEach((r) => {
        if (r.type !== 'inbound-rtp') return;
        if (r.kind === 'video') { out.video.framesDecoded += r.framesDecoded || 0; out.video.bytes += r.bytesReceived || 0; }
        if (r.kind === 'audio') {
          out.audio.energy += r.totalAudioEnergy || 0;
          out.audio.samples += r.totalSamplesReceived || 0;
          out.audio.bytes += r.bytesReceived || 0;
        }
      });
    }
    return out;
  });
}

function localAudioSender(page) {
  return page.evaluate(() => {
    for (const pc of window.__pcs || []) {
      for (const s of pc.getSenders()) {
        if (s.track && s.track.kind === 'audio') return { enabled: s.track.enabled, state: s.track.readyState };
      }
    }
    return null;
  });
}

async function layout(page) {
  return page.evaluate(() => {
    const app = document.querySelector('#mp-root .mp-app');
    const tiles = [...document.querySelectorAll('#mp-cams .mp-tile')].map((t) => {
      const r = t.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), landscape: r.width > r.height };
    });
    let minFs = 999;
    let minEl = '';
    document.querySelectorAll('#mp-root *').forEach((el) => {
      if (!el.getClientRects().length) return;
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!hasText) return;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < minFs) { minFs = fs; minEl = (el.id || el.className || el.tagName).toString(); }
    });
    const cams = document.getElementById('mp-cams');
    const overflowing = [];
    document.querySelectorAll('#mp-root .mp-app, #mp-root .mp-app *').forEach((el) => {
      if (!el.getClientRects().length) return;
      const cs = getComputedStyle(el);
      if (cs.overflowY === 'visible' && cs.overflowX === 'visible') return;
      if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) {
        overflowing.push((el.id || el.className || el.tagName).toString().slice(0, 40));
      }
    });
    return {
      viewport: { w: innerWidth, h: innerHeight },
      docScrollHeight: document.documentElement.scrollHeight,
      pageScrollY: document.documentElement.scrollHeight - innerHeight,
      pageScrollX: document.documentElement.scrollWidth - innerWidth,
      appOverflowY: app ? app.scrollHeight - app.clientHeight : null,
      camsOverflowY: cams ? cams.scrollHeight - cams.clientHeight : null,
      overflowing,
      tiles, minFontPx: minFs, minFontEl: minEl
    };
  });
}

async function join(page, url, name) {
  await page.goto(url, { waitUntil: 'load' });
  await require('./_rooms-helper.js').openMp(page, 'join', name);
  await require('./_rooms-helper.js').enterRoom(page, name);
  await page.waitForSelector('#mp-body:not(.hidden)', { timeout: 10000 });
}

async function newPlayer(browser, base, size, label, name, opts) {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: size });
  await ctx.addInitScript(HOOK_RTC);
  if (opts && opts.init) await ctx.addInitScript(opts.init);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') results.console.push(label + ' ' + m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => results.pageerror.push(label + ': ' + e.message));
  page.on('response', (r) => { if (r.status() >= 400) results.http.push(label + ' ' + r.status() + ' ' + r.url()); });
  page.on('requestfailed', (r) => results.failedRequests.push(label + ' ' + r.url() + ' ' + (r.failure() && r.failure().errorText)));
  await join(page, base + '/' + (opts && opts.query ? opts.query : ''), name);
  return page;
}

// WebRTC path: camera and mic both directions, toggles, denied-then-retry, layout and screenshots.
async function runWebRTC(browser, base, size) {
  const tag = size.width + 'x' + size.height;
  const na = 'Ana' + size.width;
  const nb = 'Bo' + size.width;
  const nc = 'Cy' + size.width;
  const A = await newPlayer(browser, base, size, 'A' + tag, na);
  const B = await newPlayer(browser, base, size, 'B' + tag, nb);
  // The third player's first camera request is refused by the page, to exercise the retry path.
  const deny = 'window.__denyOnce = true; (function () { var md = navigator.mediaDevices; if (!md) return;' +
    ' var orig = md.getUserMedia.bind(md); md.getUserMedia = function (c) { if (window.__denyOnce && c && c.video) {' +
    ' window.__denyOnce = false; return Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })); }' +
    ' return orig(c); }; })();';
  const C = await newPlayer(browser, base, size, 'C' + tag, nc, { init: deny });
  await A.waitForSelector('#mp-players li:nth-child(3)', { timeout: 10000 });

  // 1. camera on for A and B: local video plays, and each receives the other over WebRTC
  await A.click('#mp-cams .mp-tile.me [data-act="cam"]');
  await B.click('#mp-cams .mp-tile.me [data-act="cam"]');
  check(tag + ' A local camera plays', await waitVideo(A, 'me', 15000));
  check(tag + ' B local camera plays', await waitVideo(B, 'me', 15000));
  check(tag + ' A receives B over WebRTC', await waitVideo(A, nb, 25000));
  check(tag + ' B receives A over WebRTC', await waitVideo(B, na, 25000));
  const t1 = await probe(A, nb, 'video');
  await A.waitForTimeout(700);
  const t2 = await probe(A, nb, 'video');
  check(tag + ' remote currentTime advances', t2 && t1 && t2.time > t1.time, { t1: t1 && t1.time, t2: t2 && t2.time });
  const remoteStatus = await status(A, nb);
  check(tag + ' remote tile not stuck connecting (no status label, or live)', remoteStatus === null || /Live|En directo|Connected|Conectado/.test(remoteStatus), remoteStatus);
  results.measures[tag] = { localA: await probe(A, 'me', 'video'), remoteA: t2, rtpA: await rtpStats(A), webrtcLinks: await A.evaluate(() => window.__pcs.length) };

  // 2. camera off and on again for A: B's tile follows, and the stream comes back
  await A.click('#mp-cams .mp-tile.me [data-act="cam"]');
  check(tag + ' A cam button reads off after click', await waitPressed(A, 'cam', 'false'));
  const aOff = await status(A, 'me');
  check(tag + ' A local tile shows camera off', /off|apagada/i.test(aOff), aOff);
  await A.click('#mp-cams .mp-tile.me [data-act="cam"]');
  check(tag + ' A cam button reads on again', await waitPressed(A, 'cam', 'true'));
  check(tag + ' camera on again streams to B', await waitVideo(B, na, 20000));

  // 3. mic: A on, B hears audio; the sender track is enabled; then off and B hears silence
  check(tag + ' mic starts off', (await pressed(A, 'mic')) === 'false', await pressed(A, 'mic'));
  await A.click('#mp-cams .mp-tile.me [data-act="mic"]');
  check(tag + ' mic button reads on', await waitPressed(A, 'mic', 'true'));
  await B.waitForTimeout(800);
  const e0 = await rtpStats(B);
  await B.waitForTimeout(1500);
  const e1 = await rtpStats(B);
  const sender = await localAudioSender(A);
  check(tag + ' A audio track enabled while mic on', sender && sender.enabled && sender.state === 'live', sender);
  check(tag + ' B receives A audio bytes', e1.audio.bytes > e0.audio.bytes, { before: e0.audio.bytes, after: e1.audio.bytes });
  check(tag + ' B tile for A shows no mute icon while unmuted', !(await muteShown(B, na)));
  await A.click('#mp-cams .mp-tile.me [data-act="mic"]');
  check(tag + ' mic button reads off again', await waitPressed(A, 'mic', 'false'));
  const senderOff = await localAudioSender(A);
  check(tag + ' A audio track disabled when muted', senderOff && senderOff.enabled === false, senderOff);
  const muteIcon = await B.waitForFunction(([p, n]) => !!eval(p)(n, '.mp-ind'), [PICK, na], { timeout: 5000 }).then(() => true, () => false);
  check(tag + ' B tile for A shows a mute icon when muted', muteIcon);
  await B.waitForTimeout(400);
  const m0 = await rtpStats(B);
  await B.waitForTimeout(1200);
  const m1 = await rtpStats(B);
  const energyDelta = m1.audio.energy - m0.audio.energy;
  check(tag + ' B hears silence after mute (energy flat)', energyDelta < 0.002, { energyDelta });
  results.measures[tag].mic = { onEnergyDeltaPer1_5s: +(e1.audio.energy - e0.audio.energy).toFixed(4), muteEnergyDelta: +energyDelta.toFixed(5) };

  // 4. camera denied on the first try, then the retry button works
  await C.click('#mp-cams .mp-tile.me [data-act="cam"]');
  check(tag + ' denied camera shows retry button', await C.waitForSelector('#mp-cam-retry:not(.hidden)', { timeout: 10000 }).then(() => true, () => false));
  const note = await C.textContent('#mp-cam-note');
  check(tag + ' denied camera explains why', /blocked|bloquea/i.test(note), note);
  await C.click('#mp-cam-retry');
  check(tag + ' retry camera works', await waitVideo(C, 'me', 15000));

  // 5. layout and screenshots (three players, cameras on)
  await A.waitForTimeout(800);
  results.measures[tag].layoutA = await layout(A);
  await A.screenshot({ path: path.join(SHOTS, `mp-${tag}-A.png`) });
  await C.screenshot({ path: path.join(SHOTS, `mp-${tag}-C.png`) });
  await A.context().close();
  await B.context().close();
  await C.context().close();
}

// Relay path: WebRTC switched off with ?rtc=off. Video is JPEG frames and audio is mu-law chunks
// through the server. Counts frames per second, bytes, drawn pixels and audio chunks.
async function runRelay(browser, base) {
  const size = { width: 1366, height: 768 };
  const A = await newPlayer(browser, base, size, 'RA', 'RelayA', { query: '?rtc=off' });
  const B = await newPlayer(browser, base, size, 'RB', 'RelayB', { query: '?rtc=off' });
  await A.waitForSelector('#mp-players li:nth-child(2)', { timeout: 10000 });
  await A.click('#mp-cams .mp-tile.me [data-act="cam"]');
  await B.click('#mp-cams .mp-tile.me [data-act="cam"]');
  check('relay: B draws A camera frames', await waitCanvas(B, 'RelayA', 20000));
  check('relay: A draws B camera frames', await waitCanvas(A, 'RelayB', 20000));
  check('relay: no RTCPeerConnection created', (await A.evaluate(() => window.__pcs.length)) === 0);
  check('relay: tile says via server', /server|servidor/i.test(await status(B, 'RelayA')), await status(B, 'RelayA'));

  const s0 = await B.evaluate(() => window.PokerMP.stats());
  await B.waitForTimeout(3000);
  const s1 = await B.evaluate(() => window.PokerMP.stats());
  const fps = (s1.vidIn - s0.vidIn) / 3;
  const bytesPerFrame = (s1.vidBytesIn - s0.vidBytesIn) / Math.max(1, s1.vidIn - s0.vidIn);
  check('relay: frames per second received', fps >= 4, { fps: +fps.toFixed(2) });
  const sendStats = await A.evaluate(() => window.PokerMP.stats());
  results.measures.relay = {
    fpsReceivedByB: +fps.toFixed(2),
    bytesPerFrame: Math.round(bytesPerFrame),
    videoKBpsPerSender: +((s1.vidBytesIn - s0.vidBytesIn) / 3 / 1024).toFixed(1),
    framesSentByA: sendStats.vidOut,
    px: await probe(B, 'RelayA', 'canvas.mp-relay')
  };

  // mic through the relay: B receives audio chunks while A's mic is on, none after it is muted
  await A.click('#mp-cams .mp-tile.me [data-act="mic"]');
  await waitPressed(A, 'mic', 'true');
  const a0 = await B.evaluate(() => window.PokerMP.stats().audIn);
  await B.waitForTimeout(2000);
  const a1 = await B.evaluate(() => window.PokerMP.stats());
  check('relay: B receives A audio chunks', a1.audIn - a0 > 10, { chunks: a1.audIn - a0 });
  results.measures.relay.audioChunksPerSecFromA = +((a1.audIn - a0) / 2).toFixed(1);
  results.measures.relay.audioKBpsPerSender = +((a1.audBytesIn - 0) / Math.max(1, a1.audIn) * (a1.audIn - a0) / 2 / 1024).toFixed(2);
  await A.click('#mp-cams .mp-tile.me [data-act="mic"]');
  await waitPressed(A, 'mic', 'false');
  await B.waitForTimeout(400);
  const m0 = await B.evaluate(() => window.PokerMP.stats().audIn);
  await B.waitForTimeout(1200);
  const m1 = await B.evaluate(() => window.PokerMP.stats().audIn);
  check('relay: audio stops after mute', m1 - m0 <= 2, { chunks: m1 - m0 });

  await A.waitForTimeout(500);
  results.measures.relay.layoutA = await layout(A);
  await B.screenshot({ path: path.join(SHOTS, 'mp-relay-B.png') });
  await A.context().close();
  await B.context().close();
}

async function run() {
  fs.mkdirSync(SHOTS, { recursive: true });
  // A fresh server per viewport so players from earlier runs do not stay in the lobby as extra tiles.
  let server = null;
  const startServer = async () => {
    if (server) await new Promise((r) => server.close(r));
    server = createServer();
    await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
    return 'http://localhost:' + PORT;
  };
  let base = null;
  const browser = await chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required']
  });
  try {
    for (const size of [{ width: 1366, height: 768 }, { width: 1536, height: 730 }, { width: 1920, height: 937 }, { width: 390, height: 700 }]) {
      base = await startServer();
      await runWebRTC(browser, base, size);
    }
    base = await startServer();
    await runRelay(browser, base);
  } catch (e) {
    check('run completed', false, String((e && e.message) || e));
  } finally {
    const failed = results.checks.filter((c) => !c.ok).length;
    results.summary = { checks: results.checks.length, failed };
    fs.writeFileSync(path.join(SHOTS, 'results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
    await browser.close();
    if (server) server.close();
    if (failed) process.exitCode = 1;
  }
}

run();
