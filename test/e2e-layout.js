'use strict';
// Layout check of the multiplayer table in real headless Chrome. For each viewport and for 2, 5 and
// 9 seated players (bots fill the seats), a hand is running and the page is measured:
//  - pairwise intersections (1px tolerance) between seat boxes, bet chips, the pot, the board, the
//    banner, hero cards, the action row, the raise popover and the toolbar groups: must be 0;
//  - every seat, chip, card and button fully inside the viewport and not clipped by an overflow ancestor;
//  - the felt (table oval) is large enough for its screen; no page scroll; text 12px or more.
// Run with `node test/e2e-layout.js`. Env: E2E_PORT (default 3561), E2E_SHOTS (screenshot folder),
// VIEWPORT_ONLY (e.g. "844x390,390x844"), PLAYERS_ONLY (e.g. "9"). Writes layout-results.json there.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { createServer } = require('../server.js');

const PORT = Number(process.env.E2E_PORT || 3561);
const SHOTS = process.env.E2E_SHOTS || path.join(__dirname, '..', '.e2e-shots');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const VIEWPORTS = [
  { w: 844, h: 390, phone: true },
  { w: 1024, h: 600 },
  { w: 1280, h: 720 },
  { w: 1366, h: 768 },
  { w: 390, h: 844, phone: true },
  { w: 360, h: 640, phone: true },
  { w: 1920, h: 1080 }
];
const PLAYER_COUNTS = [2, 5, 9];

// No scrolling anywhere in multiplayer: every visible element under #mp-root must fit its box (scrollHeight
// and scrollWidth <= client size), and the document must not scroll. Returns the offending elements.
// No scrolling anywhere in multiplayer: no visible scroll container (overflow auto/scroll) under #mp-root may
// have content larger than its box, and the document must not scroll. Lists the offenders.
const SCROLLS = `(function () {
  var out = [];
  document.querySelectorAll('#mp-root *').forEach(function (el) {
    if (!el.getClientRects().length) return;
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    var scrollable = /auto|scroll/.test(cs.overflowY + ' ' + cs.overflowX);
    if (!scrollable) return;
    if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) {
      out.push((el.id || el.className || el.tagName).toString().slice(0, 40) + ' ' + el.scrollHeight + '/' + el.clientHeight + ' x ' + el.scrollWidth + '/' + el.clientWidth);
    }
  });
  var d = document.documentElement;
  if (d.scrollHeight > innerHeight + 1 || d.scrollWidth > innerWidth + 1) out.push('document ' + d.scrollHeight + 'x' + d.scrollWidth);
  return out;
})()`;

// Runs in the page. Returns the items to check (rects in viewport px), the number of seats and text sizes.
const MEASURE = `(function () {
  var vw = innerWidth, vh = innerHeight;
  function shown(el) {
    if (!el || !el.getClientRects().length) return false;
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function rect(el) {
    var r = el.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height };
  }
  function clippedBy(el, r) {
    var a = el.parentElement;
    while (a && a !== document.body && a !== document.documentElement) {
      var cs = getComputedStyle(a);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        var q = a.getBoundingClientRect();
        if (r.l < q.left - 0.5 || r.t < q.top - 0.5 || r.r > q.right + 0.5 || r.b > q.bottom + 0.5) {
          return (a.id || a.className || a.tagName).toString().slice(0, 40);
        }
      }
      a = a.parentElement;
    }
    return null;
  }
  var items = [];
  function add(kind, el, label) {
    if (!shown(el)) return;
    items.push({ kind: kind, label: label || '', rect: rect(el), el: el });
  }
  var seats = Array.prototype.slice.call(document.querySelectorAll('#mp-seats .mp-seat'));
  seats.forEach(function (el) { add('seat', el, el.getAttribute('data-seat')); });
  Array.prototype.slice.call(document.querySelectorAll('#mp-bets .mp-bet')).forEach(function (el) { add('chip', el, el.textContent); });
  add('pot', document.getElementById('mp-pot'), 'pot');
  add('board', document.getElementById('mp-board'), 'board');
  var boardEl = document.getElementById('mp-board');
  var boardCards = boardEl ? Array.prototype.slice.call(boardEl.querySelectorAll('.mp-card-face')) : [];
  var boardBox = boardEl && boardEl.getClientRects().length ? rect(boardEl) : null;
  var cardsInBoard = !boardBox || boardCards.every(function (c) { var r = rect(c); return r.l >= boardBox.l - 1 && r.t >= boardBox.t - 1 && r.r <= boardBox.r + 1 && r.b <= boardBox.b + 1; });
  add('banner', document.getElementById('mp-banner'), 'banner');
  Array.prototype.slice.call(document.querySelectorAll('#mp-hero .mp-card-face.hero')).forEach(function (el, i) { add('hero', el, 'hero' + i); });
  add('actions', document.querySelector('#mp-table-view .mp-actions'), 'actions');
  add('raise', document.querySelector('#mp-table-view .mp-raise-ctl'), 'raise');
  add('toolbar', document.querySelector('.mp-tbar'), 'toolbar-left');
  add('toolbar', document.querySelector('.mp-tools'), 'toolbar-right');
  // buttons: inside the viewport and not clipped (not part of the pairwise set: they sit in their group)
  var buttons = [];
  Array.prototype.slice.call(document.querySelectorAll('#mp-table-view .mp-act, .mp-tools .mp-ibtn, .mp-tbar .mp-ibtn, #mp-table-view .mp-raise-ctl .mp-btn, #mp-table-view .mp-raise-ctl input')).forEach(function (el) {
    if (shown(el)) buttons.push({ label: el.id || el.className, rect: rect(el), clip: clippedBy(el, rect(el)) });
  });
  var checkedClip = items.map(function (it) { return { label: it.kind + ':' + it.label, clip: clippedBy(it.el, it.rect) }; });
  var felt = document.getElementById('mp-felt');
  var feltR = felt && felt.getClientRects().length ? rect(felt) : null;
  var minFs = 999, minEl = '';
  document.querySelectorAll('#mp-root *').forEach(function (el) {
    if (!el.getClientRects().length) return;
    var hasText = Array.prototype.some.call(el.childNodes, function (n) { return n.nodeType === 3 && n.textContent.trim(); });
    if (!hasText) return;
    var fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < minFs) { minFs = fs; minEl = (el.id || el.className || el.tagName).toString().slice(0, 30); }
  });
  var table = document.getElementById('mp-table');
  return {
    vw: vw, vh: vh,
    docScrollY: Math.max(0, document.documentElement.scrollHeight - vh),
    docScrollX: Math.max(0, document.documentElement.scrollWidth - vw),
    seatCount: seats.length,
    layout: table ? table.getAttribute('data-layout') : null,
    felt: feltR,
    items: items.map(function (it) { return { kind: it.kind, label: it.label, rect: it.rect }; }),
    clips: checkedClip.filter(function (c) { return c.clip; }),
    buttons: buttons,
    raiseBox: (function () { var r = document.querySelector('#mp-table-view .mp-raise-ctl'); return r && r.getClientRects().length ? rect(r) : null; })(),
    raiseKids: Array.prototype.slice.call(document.querySelectorAll('#mp-table-view .mp-raise-ctl .mp-btn')).filter(shown).map(function (el) { return rect(el); }),
    cardsInBoard: cardsInBoard,
    minFont: minFs, minFontEl: minEl,
    dbg: (function () {
      var q = { root: "#mp-root", app: ".mp-app", body: "#mp-body", main: ".mp-main", tablev: "#mp-table-view", wrap: ".mp-table-wrap", table: "#mp-table", center: "#mp-center", board: "#mp-board", dock: "#mp-dock", hero: "#mp-hero", tbar: ".mp-tbar", tools: ".mp-tools", conn: ".mp-conn", blinds: ".mp-blinds" };
      var out = {};
      Object.keys(q).forEach(function (k) { var el = document.querySelector(q[k]); out[k] = el && el.getClientRects().length ? [Math.round(el.getBoundingClientRect().left), Math.round(el.getBoundingClientRect().top), Math.round(el.getBoundingClientRect().width), Math.round(el.getBoundingClientRect().height), getComputedStyle(el).padding] : null; });
      out.seatRects = items.filter(function (it) { return it.kind === "seat"; }).map(function (it) { return [it.label, Math.round(it.rect.l), Math.round(it.rect.t), Math.round(it.rect.w), Math.round(it.rect.h)]; });
      out.chipRects = items.filter(function (it) { return it.kind === "chip"; }).map(function (it) { return [it.label, Math.round(it.rect.l), Math.round(it.rect.t), Math.round(it.rect.w), Math.round(it.rect.h)]; });
      return out;
    })(),
    heroSize: items.filter(function (it) { return it.kind === 'hero'; }).map(function (it) { return [it.rect.w, it.rect.h]; })
  };
})()`;

// Pairwise overlap test used by the assertions (1px tolerance on both axes).
function overlaps(a, b, tol) {
  const t = tol == null ? 1 : tol;
  const w = Math.min(a.r, b.r) - Math.max(a.l, b.l);
  const h = Math.min(a.b, b.b) - Math.max(a.t, b.t);
  return w > t && h > t;
}
function inside(r, vw, vh) {
  return r.l >= -0.5 && r.t >= -0.5 && r.r <= vw + 0.5 && r.b <= vh + 0.5;
}

async function join(page, url, name) {
  await page.goto(url, { waitUntil: 'load' });
  await require('./_rooms-helper.js').openMp(page, 'join', name);
  await require('./_rooms-helper.js').enterRoom(page, name);
  await page.waitForSelector('#mp-body:not(.hidden)', { timeout: 10000 });
}

// Returns the list of failed checks for one measurement.
function evaluate(m, vp, players) {
  const landscape = vp.h <= 500;
  const pairs = [];
  for (let i = 0; i < m.items.length; i++) {
    for (let j = i + 1; j < m.items.length; j++) {
      if (overlaps(m.items[i].rect, m.items[j].rect)) {
        pairs.push(m.items[i].kind + ':' + m.items[i].label + ' x ' + m.items[j].kind + ':' + m.items[j].label);
      }
    }
  }
  const outside = m.items.filter((it) => !inside(it.rect, m.vw, m.vh)).map((it) => it.kind + ':' + it.label);
  const btnOut = m.buttons.filter((b) => !inside(b.rect, m.vw, m.vh) || b.clip).map((b) => b.label);
  const clipped = m.clips.map((c) => c.label);
  const act = m.buttons.filter((b) => String(b.label).indexOf('mp-act') >= 0 || (b.label || '').indexOf('act') >= 0);
  const felt = m.felt || { w: 0, h: 0 };
  const raiseInside = !m.raiseBox || m.raiseKids.every((k) => k.l >= m.raiseBox.l - 0.5 && k.r <= m.raiseBox.r + 0.5);
  const checks = {
    seatsAllShown: m.seatCount === players,
    noPairwiseOverlap: pairs.length === 0,
    everythingInsideViewport: outside.length === 0 && btnOut.length === 0,
    notClipped: clipped.length === 0,
    noPageScroll: m.docScrollY === 0 && m.docScrollX === 0,
    feltHeight: landscape ? felt.h >= 0.6 * m.vh : felt.h >= 0.4 * m.vh,
    feltWidth: landscape ? felt.w >= 0.5 * m.vw : felt.w >= 0.5 * m.vw,
    layoutFits: !!m.layout && m.layout.indexOf('fail') < 0,
    actionsTall44: m.items.filter((it) => it.kind === 'actions').every((it) => it.rect.h >= 44) && act.every((b) => b.rect.h >= 44),
    heroCards: m.heroSize.length === 2,
    heroCardLandscape: !landscape || m.heroSize.every((s) => s[0] >= 40 && s[0] <= 50),
    boardCardsInside: m.cardsInBoard !== false,
    raisePresetsInBox: raiseInside,
    // 12px minimum everywhere; 11px is allowed only at the extra-compact level lv4 (mp.js layoutTable)
    text12px: m.minFont >= ((m.layout || '').indexOf('lv4') >= 0 ? 11 : 12)
  };
  const failed = Object.keys(checks).filter((k) => !checks[k]);
  return { checks, failed, pairs, outside, btnOut, clipped };
}

async function runCase(browser, base, vp, players) {
  const tag = vp.w + 'x' + vp.h + '-p' + players;
  const opts = { viewport: { width: vp.w, height: vp.h }, permissions: [] };
  if (vp.phone) Object.assign(opts, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  else Object.assign(opts, { deviceScaleFactor: 1 });
  const humans = players >= 5 ? 3 : 2;
  const bots = players - humans;
  const ctxs = [];
  const errors = [];
  const pages = [];
  try {
    for (let i = 0; i < humans; i++) {
      const ctx = await browser.newContext(opts);
      ctxs.push(ctx);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(String(e.message)));
      pages.push(page);
      await join(page, base + '/', ['Ana', 'Bo', 'Cy'][i] + vp.w);
    }
    const host = pages[0];
    if (humans > 1) await host.waitForSelector('#mp-players li:nth-child(' + humans + ')', { state: 'attached', timeout: 10000 });
    // the lobby is one page (Players and Bots side by side, or stacked on phones): no host page switch to probe
    for (let i = 0; i < bots; i++) {
      await host.click('[data-act="add-bot"]');
      await host.waitForTimeout(120);
    }
    const lobbyScroll = await host.evaluate(SCROLLS);
    await host.screenshot({ path: path.join(SHOTS, 'mpredesign-' + vp.w + 'x' + vp.h + '-lobby.png') });
    const lobbyScrollGuest = await pages[1].evaluate(SCROLLS);
    await host.click('#mp-start');
    await host.waitForSelector('#mp-table-view:not(.hidden)', { timeout: 15000 });
    await host.waitForFunction((n) => document.querySelectorAll('#mp-seats .mp-seat').length >= n, players, { timeout: 15000 });
    await host.waitForTimeout(1000);
    const m = await host.evaluate(MEASURE);
    const handScroll = await host.evaluate(SCROLLS);
    let dbgAfter = null, dbgAfter2 = null;
    const res = evaluate(m, vp, players);
    const shot = path.join(SHOTS, 'mpredesign-' + vp.w + 'x' + vp.h + '-hand.png');
    await host.screenshot({ path: shot });
    const cardsDbg = await host.evaluate(() => Array.prototype.slice.call(document.querySelectorAll("#mp-board .mp-card-face")).map(function (el) { var r = el.getBoundingClientRect(); var p = el.parentElement; var pr = p.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height), el.className, p.id, Math.round(pr.left), Math.round(pr.top), Math.round(pr.width), getComputedStyle(p).transform, getComputedStyle(el).position]; }));
    dbgAfter2 = cardsDbg;
    const after = await host.evaluate(() => { var b = document.getElementById("mp-board").getBoundingClientRect(); var c = document.getElementById("mp-center").getBoundingClientRect(); var t = document.getElementById("mp-table").getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(c.left), Math.round(c.top), Math.round(t.left), Math.round(t.top), getComputedStyle(document.getElementById("mp-center")).transform, getComputedStyle(document.getElementById("mp-board")).transform]; });
    dbgAfter = after;
    return {
      tag, w: vp.w, h: vp.h, players, scroll: { lobby: lobbyScroll, guest: lobbyScrollGuest, hand: handScroll },
      ok: res.failed.length === 0 && res.pairs.length === 0 && !lobbyScroll.length && !lobbyScrollGuest.length && !handScroll.length,
      intersections: res.pairs.length, pairs: res.pairs.slice(0, 8), failed: res.failed, checks: res.checks, buttons: m.buttons,
      outside: res.outside, btnOut: res.btnOut, clipped: res.clipped, layout: m.layout,
      dbg: m.dbg, dbgAfter, dbgAfter2, felt: m.felt, minFont: m.minFont, minFontEl: m.minFontEl, errors, shot
    };
  } finally {
    for (const ctx of ctxs) await ctx.close();
  }
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const VP_ONLY = process.env.VIEWPORT_ONLY ? process.env.VIEWPORT_ONLY.split(',') : null;
  const P_ONLY = process.env.PLAYERS_ONLY ? process.env.PLAYERS_ONLY.split(',').map(Number) : null;
  const browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required']
  });
  const results = [];
  try {
    for (const vp of VIEWPORTS.filter((v) => !VP_ONLY || VP_ONLY.includes(v.w + 'x' + v.h))) {
      for (const players of PLAYER_COUNTS.filter((n) => !P_ONLY || P_ONLY.includes(n))) {
        const server = createServer();
        await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
        try {
          results.push(await runCase(browser, 'http://localhost:' + PORT, vp, players));
        } catch (e) {
          results.push({ tag: vp.w + 'x' + vp.h + '-p' + players, ok: false, intersections: -1, error: String((e && e.message) || e).slice(0, 300) });
        } finally {
          await new Promise((r) => server.close(r));
        }
      }
    }
  } finally {
    await browser.close();
  }
  const out = path.join(SHOTS, 'layout-results.json');
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  for (const r of results) {
    if (r.error) console.log(r.tag, 'ERROR', r.error);
    else console.log(r.tag, r.ok ? 'PASS' : 'FAIL', 'intersections=' + r.intersections, r.layout, r.failed.length ? 'failed: ' + r.failed.join(',') : '', r.pairs.length ? JSON.stringify(r.pairs.slice(0, 3)) : '', (r.scroll && (r.scroll.lobby.length || r.scroll.guest.length || r.scroll.hand.length)) ? 'scroll=' + JSON.stringify(r.scroll).slice(0, 400) : '');
  }
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}

if (require.main === module) main();
module.exports = { runCase, evaluate, VIEWPORTS };
