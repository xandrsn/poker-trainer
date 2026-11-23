'use strict';
// Theme contrast check in real Chrome (playwright-core): for six page backgrounds x five screens (x2 sizes), every
// visible text element is sampled (computed colour, composited over its effective background by walking the
// ancestors). Text needs 4.5:1, or 3:1 when large (>= 24px, or >= 18.66px bold). Offenders are printed.
// Screenshots of the white and yellow backgrounds go to SHOT_DIR (default: the temp folder).
// Run: node test/e2e-theme-contrast.js   (the multiplayer screens start a local server on E2E_PORT, 5620-5639)
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const H = require('./_rooms-helper.js');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.E2E_PORT || 5620);
const INDEX = 'file:///' + path.join(__dirname, '..', 'public', 'index.html').replace(/\\/g, '/');
const SHOTS = process.env.SHOT_DIR || path.join(process.env.TEMP || '/tmp', 'theme-contrast-shots');
const BGS = ['#000000', '#ffffff', '#f2efe6', '#ffe9a8', '#b9d7c1', '#7a7a7a'];
const SIZES = [[1366, 768], [390, 844]];
// felts: the default, and two light felts (dark table labels switch on them); tested on the table screens only
const FELTS = ['#0f3d27', '#b9d7c1', '#e8e0c8'];
const TABLE_SCREENS = ['quick game table', 'practice feedback', 'practice ranges drawer', 'exam'];

// Runs in the page: the visible text elements with their colours and the effective background.
function sampleScript() {
  function parse(c) {
    const m = /rgba?\(([^)]+)\)/.exec(c || '');
    if (!m) return null;
    const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  function over(top, bot) {
    const a = top[3];
    return [top[0] * a + bot[0] * (1 - a), top[1] * a + bot[1] * (1 - a), top[2] * a + bot[2] * (1 - a), 1];
  }
  function lum(c) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  }
  function ratio(a, b) {
    const x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  function parseBg(cs) {
    // one colour per background layer; a gradient or image contributes all of its colour stops
    const out = [];
    const c = parse(cs.backgroundColor);
    if (c && c[3] > 0) out.push(c);
    const img = cs.backgroundImage || 'none';
    if (img !== 'none' && /gradient/.test(img)) {
      const re = /(rgba?|color)\(([^)]*)\)/g;
      let m;
      while ((m = re.exec(img))) {
        let body = m[2].trim();
        let p;
        if (m[1] === 'color') {
          // color(srgb r g b / a): components are 0..1
          p = body.replace(/^srgb\s*/, '').split(/[ ,\/]+/).filter(Boolean).map(Number);
          if (p.length >= 3) p = [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1];
          else continue;
        } else {
          p = body.split(/[ ,\/]+/).filter(Boolean).map(Number);
          p = [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
        }
        if (p.slice(0, 3).some(Number.isNaN)) continue;
        if (p[3] > 0.05) out.push(p);
      }
    }
    return out;
  }
  function label(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (el.className && typeof el.className === 'string' && el.className.trim()) {
      s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    }
    return s;
  }
  const out = [];
  const seen = new Set();
  document.body.querySelectorAll('*').forEach((el) => {
    const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    if (!hasText) return;
    if (!el.getClientRects().length) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return;
    // hidden by an ancestor (closed panel, display none, the hidden class)
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.display === 'none' || s.visibility === 'hidden' || a.hasAttribute('hidden') || a.classList.contains('hidden')) return;
    }
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return;
    let fg = parse(cs.color);
    if (!fg) return;
    // effective background: the ancestors' backgrounds from the element up to the first opaque one. A gradient
    // (the felt, the seat plate) contributes its colour stops; the text is checked against the worst stop.
    const layers = [];
    let base = null;
    for (let a = el; a; a = a.parentElement) {
      const bgs = parseBg(getComputedStyle(a));
      if (bgs.length) {
        layers.push(bgs);
        if (bgs.every((c) => c[3] >= 1)) { base = bgs; break; }
      }
    }
    if (!base) base = [[255, 255, 255, 1]];
    // candidate grounds: each top layer composited over each base candidate
    let cands = base;
    for (let i = layers.length - 2; i >= 0; i--) {
      const next = [];
      layers[i].forEach((t) => cands.forEach((b) => next.push(over(t, b))));
      cands = next;
    }
    if (fg[3] < 1) fg = over(fg, cands[0]);
    let bg = cands[0];
    let cr = Infinity;
    cands.forEach((c) => { const r = ratio(fg, c); if (r < cr) { cr = r; bg = c; } });
    const size = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    const text = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').slice(0, 40);
    const key = label(el) + '|' + text;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      sel: label(el), text, fg: fg.slice(0, 3).map(Math.round), bg: bg.slice(0, 3).map(Math.round),
      cr: Math.round(cr * 100) / 100, need, ok: cr >= need, size: Math.round(size), image: cs.backgroundImage !== 'none'
    });
  });
  return out;
}

async function setBg(page, bg, felt) {
  await page.evaluate(([hex, f]) => {
    try {
      localStorage.setItem('poker-trainer:theme:v2', JSON.stringify({ bg: hex, felt: f || '#0f3d27', rail: '#3a2618', highlight: '#ffffff' }));
    } catch (e) { /* storage blocked */ }
  }, [bg, felt]);
}

async function openFmt(p, fmt) {
  const group = fmt === 'table' || fmt === 'mp' ? 'play' : 'practice';
  if (!(await p.isVisible('[data-fmt="' + fmt + '"]'))) await p.click('#hub-' + group);
  await p.click('[data-fmt="' + fmt + '"]');
}

async function waitGame(p) {
  await p.waitForFunction(() => document.body.getAttribute('data-view') === 'game', null, { timeout: 15000 }).catch(() => null);
  await p.waitForTimeout(400);
}

// The screens: each one leaves the page in the state to sample.
const SCREENS = {
  'main menu': async () => {},
  'play hub open': async (p) => { await p.click('#hub-play'); await p.waitForTimeout(450); },
  'settings panel': async (p) => { await p.click('#btn-settings'); await p.waitForTimeout(450); },
  'quick game table': async (p) => { await openFmt(p, 'quick'); await p.click('#menu-start'); await waitGame(p); },
  'practice feedback': async (p) => {
    await openFmt(p, 'practice'); await p.click('#menu-start'); await waitGame(p);
    await p.waitForTimeout(600);
  },
  'exam': async (p) => { await openFmt(p, 'exam'); await p.click('#menu-start'); await waitGame(p); }
};
// Practice drawers: the ranges drawer (side panel) and the full-explanation drawer (opened from a verdict).
SCREENS['practice ranges drawer'] = async (p) => {
  await openFmt(p, 'practice'); await p.click('#menu-start'); await waitGame(p);
  await p.click('#btn-ranges'); await p.waitForTimeout(450);
};
// Multiplayer screens: the entry helpers set the user name (Settings > User record) before the screen opens.
// The table screens join the first listed table (or create one) and show the lobby, then a hand with one bot.
const MP_SCREENS = {
  'multiplayer rooms': async (p) => { await H.openMp(p, false); await p.waitForTimeout(400); },
  'multiplayer create panel': async (p) => { await H.openMp(p, 'create', 'Theme'); await p.waitForTimeout(400); },
  'multiplayer join panel': async (p) => { await H.openMp(p, 'join', 'Theme'); await p.waitForTimeout(400); },
  'multiplayer table lobby': async (p) => {
    await H.openMp(p, 'join', 'Theme'); await H.enterRoom(p, 'Theme');
    await p.waitForTimeout(400);
    await p.evaluate(() => document.querySelector('[data-hpage="bots"]') && document.querySelector('[data-hpage="bots"]').click());
    await p.waitForTimeout(200);
  },
  'multiplayer table hand': async (p) => {
    await H.openMp(p, 'join', 'Theme'); await H.enterRoom(p, 'Theme');
    await p.evaluate(() => document.querySelector('[data-act="add-bot"]').click());
    await p.waitForTimeout(200);
    await p.evaluate(() => document.getElementById('mp-start').click());
    await p.waitForSelector('#mp-table-view:not(.hidden)', { timeout: 15000 });
    await p.waitForTimeout(600);
  }
};

function startServer() {
  const env = Object.assign({}, process.env, { PORT: String(PORT), HTTPS_PORT: String(PORT + 10) });
  return spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const offenders = [];
  let total = 0;
  let checked = 0;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const server = startServer();
  await new Promise((r) => setTimeout(r, 1500));
  try {
    for (const bg of BGS) {
      for (const [w, h] of SIZES) {
        const touch = w < 900;
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch });
        const page = await ctx.newPage();
        page.setDefaultTimeout(8000);
        const screens = Object.assign({}, SCREENS, MP_SCREENS);
        const runs = [];
        for (const name of Object.keys(screens)) {
          if (TABLE_SCREENS.includes(name)) FELTS.forEach((f) => runs.push([name, f]));
          else runs.push([name, FELTS[0]]);
        }
        for (const [name, felt] of runs) {
          const tag = bg + ' ' + w + 'x' + h + ' ' + name + (felt === FELTS[0] ? '' : ' felt ' + felt);
          const origin = MP_SCREENS[name] ? 'http://localhost:' + PORT + '/' : INDEX;
          try {
            await page.goto(origin);
            await setBg(page, bg, felt);
            await page.reload();
            await page.waitForTimeout(250);
            await screens[name](page);
            const rows = await page.evaluate(sampleScript);
            total += rows.length;
            checked++;
            rows.filter((r) => !r.ok).forEach((r) => offenders.push(Object.assign({ tag }, r)));
            if (bg === '#ffffff' || bg === '#ffe9a8') {
              const file = path.join(SHOTS, name.replace(/\s+/g, '-') + '_' + bg.slice(1) + '_' + w + 'x' + h + '.png');
              await page.screenshot({ path: file });
            }
          } catch (e) {
            offenders.push({ tag, sel: 'ERROR', text: String(e.message).slice(0, 120), cr: 0, need: 4.5, fg: [], bg: [] });
          }
        }
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    server.kill();
  }
  console.log('screens checked: ' + checked + ', text elements sampled: ' + total + ', offenders: ' + offenders.length);
  const byTag = {};
  offenders.forEach((o) => { byTag[o.tag] = (byTag[o.tag] || 0) + 1; });
  console.log('offenders per combination:');
  Object.keys(byTag).forEach((k) => console.log('  ' + byTag[k] + '  ' + k));
  // at most 3 rows per screen (the same element repeats on every background and size)
  const perScreen = {};
  offenders.filter((o) => {
    const k = o.tag.replace(/^\S+ \S+ /, '').replace(/ felt .*/, '');
    perScreen[k] = (perScreen[k] || 0) + 1;
    return perScreen[k] <= 3;
  }).slice(0, 80).forEach((o) => console.log('  ' + o.tag + ' | ' + o.sel + ' "' + o.text + '" fg ' + JSON.stringify(o.fg) + ' bg ' + JSON.stringify(o.bg) + ' cr ' + o.cr + ' need ' + o.need));
  process.exitCode = offenders.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
