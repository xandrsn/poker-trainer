'use strict';
// Deal animation audit in real Chrome (playwright-core): Quick game (table), Single spots (quick), Practice, Exam.
// For each mode a new deal is recorded from the menu Play click: samples every 50 ms of every .anim-card flight and of
// the hero and board cards. Checks: no duplicate flight nodes, cards move monotonically toward their final place,
// no opacity flicker (1 -> 0 -> 1), flights are removed after landing, hero cards end visible with no running
// animation, no console or page errors. Reduced motion: no flights at all.
// Multiplayer: two humans and two bots, the host's first hand (see runMultiplayer).
// Usage: node test/e2e-deal-anim.js http://localhost:5220
const { chromium } = require('playwright-core');

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.argv[2] || 'http://localhost:3000';
const SIZES = [[1366, 768], [390, 844]];
const MODES = [['table', 'Quick game'], ['quick', 'Single spots'], ['practice', 'Practice'], ['exam', 'Exam']];
let failures = 0;
const chk = (ok, msg) => { if (!ok) failures++; console.log((ok ? 'ok   ' : 'FAIL ') + msg); };

async function openFmt(p, fmt) {
  const group = fmt === 'table' ? 'play' : 'practice';
  const vis = await p.evaluate((f) => { const e = document.querySelector('[data-fmt="' + f + '"]'); return !!e && e.offsetParent !== null; }, fmt);
  if (!vis) await p.click('#hub-' + group);
  await p.click('[data-fmt="' + fmt + '"]');
}

// In-page recorder: samples every 50 ms for ~3.2 s. Probe ids tag each flight node once.
function recorder() {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let pid = 0;
    const samples = [];
    const rect = (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, op: +getComputedStyle(c).opacity }; };
    const timer = setInterval(() => {
      const flights = Array.from(document.querySelectorAll('.anim-card'));
      flights.forEach((c) => { if (!c.dataset.probe) c.dataset.probe = String(++pid); });
      samples.push({
        t: Math.round(performance.now() - t0),
        flights: flights.map((c) => Object.assign({ id: c.dataset.probe }, rect(c))),
        hero: Array.from(document.querySelectorAll('.hero-cards .card')).map((c) => Object.assign({ code: c.dataset.code || '', anim: c.getAnimations().filter((a) => a.playState === 'running').length }, rect(c))),
        layerNodes: document.querySelectorAll('.deal-layer, .anim-layer .anim-card').length
      });
    }, 50);
    setTimeout(() => { clearInterval(timer); resolve(samples); }, 3200);
  });
}

async function runMode(browser, fmt, label, w, h) {
  const tag = label + ' ' + w + 'x' + h;
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await p.goto(BASE, { waitUntil: 'load' });
  await p.evaluate(() => { try { localStorage.clear(); } catch (e) { /* storage blocked */ } });
  await p.reload({ waitUntil: 'load' });
  await p.waitForTimeout(400);
  await openFmt(p, fmt);
  await p.waitForTimeout(250);
  const started = p.evaluate(recorder);
  await p.click('#menu-start');
  const S = await started;
  const withFlights = S.filter((s) => s.flights.length).length;
  chk(withFlights >= 1, tag + ': cards fly from the centre (' + withFlights + ' samples with flights)');
  chk(S.length >= 20, tag + ': recorded ' + S.length + ' samples');
  const dup = S.some((s) => new Set(s.flights.map((f) => f.id)).size !== s.flights.length);
  chk(!dup, tag + ': no duplicate flight nodes');
  const last = S[S.length - 1];
  chk(last.hero.length === 2 && last.hero.every((c) => c.anim === 0 && c.op === 1), tag + ': hero cards end visible, 2 cards, no running animation');
  chk(last.flights.length === 0 && last.layerNodes === 0, tag + ': flights removed after landing');
  const codes = last.hero.map((c) => c.code);
  chk(new Set(codes).size === codes.length, tag + ': hero codes unique');

  // per flight: distance to its final place never grows; opacity never drops after it has shown
  const byId = {};
  S.forEach((s) => s.flights.forEach((f) => { (byId[f.id] = byId[f.id] || []).push({ x: f.x, y: f.y, op: f.op }); }));
  let backward = 0, flicker = 0;
  Object.keys(byId).forEach((id) => {
    const seq = byId[id];
    const fin = seq[seq.length - 1];
    const dist = (q) => Math.hypot(q.x - fin.x, q.y - fin.y);
    let shown = false;
    seq.forEach((q) => {
      if (q.op >= 0.9) shown = true;
      else if (shown && q.op < 0.5) flicker++;
    });
    for (let i = 1; i < seq.length; i++) if (dist(seq[i]) > dist(seq[i - 1]) + 2) backward++;
  });
  chk(backward === 0, tag + ': cards move monotonically toward their final place (' + backward + ' backward steps)');
  chk(flicker === 0, tag + ': no opacity flicker 1 -> 0 -> 1 (' + flicker + ')');
  chk(errors.length === 0, tag + ': no console or page errors' + (errors.length ? ' ' + errors.slice(0, 3).join(' | ') : ''));
  await ctx.close();
}

// Multiplayer deal (mp.js dealAnimate + flipHeroCards): two humans and two bots. The host records the first hand from
// the Start click. Checks: flights fly and are removed, no duplicate flight nodes, the hero cards start hidden and end
// visible with no running animation, no console or page errors. Run against a fresh server (rooms are shared).
async function runMultiplayer(browser, w, h) {
  const tag = 'Multiplayer ' + w + 'x' + h;
  const R = require('./_rooms-helper.js');
  const errors = [];
  const join = async (name) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(name + ': ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(name + ' console: ' + m.text()); });
    await p.goto(BASE + '/', { waitUntil: 'load' });
    await R.openMp(p, 'join', name);
    await R.enterRoom(p, name);
    await p.waitForSelector('#mp-body:not(.hidden)', { timeout: 10000 });
    return { ctx, p };
  };
  const A = await join('Ana');
  const B = await join('Bo');
  try {
    // Bots are added in the lobby (no separate host page any more).
    await A.p.waitForSelector('[data-act="add-bot"]', { state: 'visible', timeout: 15000 });
    await A.p.click('[data-act="add-bot"]');
    await A.p.click('[data-act="add-bot"]');
    await A.p.waitForTimeout(300);
    const started = A.p.evaluate(() => new Promise((resolve) => {
      const t0 = performance.now();
      let pid = 0;
      const samples = [];
      const timer = setInterval(() => {
        const flights = Array.from(document.querySelectorAll('#mp-table .anim-card'));
        flights.forEach((c) => { if (!c.dataset.probe) c.dataset.probe = String(++pid); });
        samples.push({
          t: Math.round(performance.now() - t0),
          flights: flights.map((c) => ({ id: c.dataset.probe })),
          hero: Array.from(document.querySelectorAll('#mp-hero .mp-hero-faces > *')).map((c) => ({
            op: +getComputedStyle(c).opacity,
            anim: c.getAnimations().filter((a) => a.playState === 'running').length
          }))
        });
      }, 50);
      setTimeout(() => { clearInterval(timer); resolve(samples); }, 3000);
    }));
    await A.p.click('#mp-start');
    const S = await started;
    chk(S.some((s) => s.flights.length), tag + ': cards fly from the dealer to the seats (' + S.filter((s) => s.flights.length).length + ' samples)');
    const dup = S.some((s) => new Set(s.flights.map((f) => f.id)).size !== s.flights.length);
    chk(!dup, tag + ': no duplicate flight nodes');
    const hidden = S.some((s) => s.hero.length === 2 && s.hero.every((c) => c.op === 0));
    chk(hidden, tag + ': hero cards hidden while the flights are out');
    const last = S[S.length - 1];
    chk(last.hero.length === 2 && last.hero.every((c) => c.op === 1 && c.anim === 0), tag + ': hero cards end visible, no running animation');
    chk(last.flights.length === 0, tag + ': flights removed after landing');
    chk(errors.length === 0, tag + ': no console or page errors' + (errors.length ? ' ' + errors.slice(0, 3).join(' | ') : ''));
  } finally {
    await A.ctx.close();
    await B.ctx.close();
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    for (const [w, h] of SIZES) {
      for (const [fmt, label] of MODES) await runMode(browser, fmt, label, w, h);
      if (w === 1366) await runMultiplayer(browser, w, h); // one room per run: the second size would join a table already in a hand
    }
    // reduced motion: the same Single spots deal shows its cards at once, with no flights
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: 'reduce' });
    const p = await ctx.newPage();
    await p.goto(BASE, { waitUntil: 'load' });
    await p.evaluate(() => { try { localStorage.clear(); } catch (e) { /* storage blocked */ } });
    await p.reload({ waitUntil: 'load' });
    await openFmt(p, 'quick');
    await p.click('#menu-start');
    await p.waitForTimeout(300);
    const flights = await p.evaluate(() => document.querySelectorAll('.anim-card').length);
    chk(flights === 0, 'reduced motion: no card flights (' + flights + ')');
    const heroShown = await p.evaluate(() => Array.from(document.querySelectorAll('.hero-cards .card')).every((c) => getComputedStyle(c).opacity === '1'));
    chk(heroShown, 'reduced motion: hero cards visible at once');
    await ctx.close();
  } finally {
    await browser.close();
  }
  console.log(failures ? failures + ' FAILED' : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
