// No-scroll / no-clip test. Usage: node test/e2e-noscroll.js [baseUrl] [WxH,WxH]
// For each viewport (fresh browser context each, one browser, closed at the end) it opens every screen:
// menu, mode settings (quick/practice/exam), rules, progress sheet, practice table with the feedback popup,
// each sidebar tab, exam hands with the end-of-hand panel, exam summary, exam analysis, help.
// On every screen it checks:
//   - the document does not scroll (scrollWidth/scrollHeight <= viewport);
//   - every visible box is inside the viewport and inside each clipping ancestor (no cut-off);
//   - no element with overflow hidden/auto has content larger than its box (scrollWidth/scrollHeight).
// Screenshots: .e2e-shots/ns-<screen>-<WxH>.png (SHOT=0 disables).
const { chromium } = require('playwright-core');
const { openFmt } = require('./helpers/menu');
const path = require('path');
const BASE = process.argv[2] || 'http://localhost:3000';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOTS = path.join(__dirname, '..', '.e2e-shots');
const ALL = ['1920x1080', '1536x730', '1366x768', '1280x720', '1024x600', '844x390', '390x844', '360x640'];
const SIZES = (process.argv[3] || ALL.join(',')).split(',').map((s) => s.split('x').map(Number));
const fails = [];
let checks = 0;

// the only containers allowed to scroll vertically: the Analysis (sidebar pane, exam analysis list).
// Their buttons are outside them, so they never move. Inside them, vertical overflow is expected.
// #rv-overlay is the full-screen review (fixed, overflow-y auto by design): it scrolls inside itself.
const SCROLL_OK = '.an-list, .side-pane[data-pane="analysis"], #rv-overlay .rv-coach-body, #rv-overlay .rv-timeline';

// runs inside the page; returns the problems on the current screen
const audit = (SCROLL_OK) => {
  const vw = innerWidth, vh = innerHeight, tol = 1;
  const probs = [];
  const de = document.documentElement;
  if (de.scrollHeight > vh + tol) probs.push('DOC scrollHeight ' + de.scrollHeight + ' > ' + vh);
  if (de.scrollWidth > vw + tol) probs.push('DOC scrollWidth ' + de.scrollWidth + ' > ' + vw);
  const isVisible = (el) => {
    // content of a closed <details> is not painted (its boxes stay laid out): not visible
    { const d = el.closest("details:not([open])"); if (d && !(d.firstElementChild === el || d.firstElementChild.contains(el))) return false; }
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (e.classList.contains('hidden')) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const label = (el) => (el.id ? '#' + el.id : el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : '')).slice(0, 70);
  const all = [...document.querySelectorAll("body *")].filter((el) => !el.classList.contains("sr-only")).filter((el) => !el.closest('svg') && !el.closest('[aria-hidden="true"]') && !el.closest('.felt'));
  for (const el of all) {
    if (!isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    const inScroll = !!el.closest(SCROLL_OK); // scrolled out of view vertically is fine here
    const inRow = !!el.closest('#rv-overlay .rv-hands, #rv-overlay .rv-timeline'); // replay chip and step rows scroll sideways by design
    if ((!inRow && r.left < -tol) || (!inScroll && r.top < -tol) || (!inRow && r.right > vw + tol) || (!inScroll && r.bottom > vh + tol)) {
      probs.push('OUTSIDE viewport ' + label(el) + ' [' + [r.left, r.top, r.right, r.bottom].map(Math.round).join(',') + ']');
    }
    const cs = getComputedStyle(el);
    const clips = (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') && !el.matches(SCROLL_OK);
    const glyph = el.matches('[class*="c-"], .c-rank, .c-suit') || el.closest('.card');
    const gt = glyph ? 4 : tol; // card glyphs: line box vs. ink box
    // deliberate truncation (line clamp / ellipsis) is allowed only when the full text is in a title tooltip
    const tipTruncated = el.hasAttribute('title') && el.title.trim() === el.textContent.trim();
    if (clips && !tipTruncated && el.clientHeight > 0 && (el.scrollHeight > el.clientHeight + gt || el.scrollWidth > el.clientWidth + gt)) {
      probs.push('CLIPPED content in ' + label(el) + ' (content ' + el.scrollWidth + 'x' + el.scrollHeight + ' box ' + el.clientWidth + 'x' + el.clientHeight + ')');
    }
    // text leaves: must sit inside every clipping ancestor
    if (el.children.length === 0 && el.textContent.trim()) {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ps = getComputedStyle(p);
        if (ps.overflowX === 'visible' && ps.overflowY === 'visible') continue;
        if (p.matches(SCROLL_OK)) break; // a whitelisted scroll container: its text may scroll
        const pr = p.getBoundingClientRect();
        if (r.left < pr.left - tol || r.right > pr.right + tol || r.top < pr.top - tol || r.bottom > pr.bottom + tol) {
          probs.push('TEXT cut by ' + label(p) + ': "' + el.textContent.trim().slice(0, 30) + '"');
        }
        break;
      }
    }
  }
  return probs;
};

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--disable-dev-shm-usage', '--disable-gpu'] });
  for (const [w, h] of SIZES) {
    const tag = w + 'x' + h;
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    const check = async (screen) => {
      await p.waitForTimeout(350);
      const probs = await p.evaluate(audit, SCROLL_OK);
      checks++;
      if (process.env.SHOT !== '0') await p.screenshot({ path: path.join(SHOTS, 'ns-' + screen.replace(/[^\w-]/g, '_') + '-' + tag + '.png') }).catch(() => {});
      const seen = {};
      for (const pr of probs) { const k = pr.replace(/[0-9.,\[\] x]+/g, '#'); seen[k] = seen[k] || { n: 0, ex: pr }; seen[k].n++; }
      for (const k of Object.keys(seen)) fails.push(tag + ' [' + screen + '] ' + seen[k].ex + (seen[k].n > 1 ? '  (x' + seen[k].n + ')' : ''));
      console.log((probs.length ? 'FAIL ' : 'ok   ') + tag + ' ' + screen + (probs.length ? ' (' + probs.length + ')' : ''));
    };
    const click = (sel) => p.evaluate((s) => { const e = document.querySelector(s); if (e) e.click(); }, sel);
    try {
      await p.goto(BASE); await p.waitForTimeout(700);
      await check('menu');
      await click('#hub-play'); await check('menu-hub-play-open');
      await click('#hub-practice'); await check('menu-hub-practice-open');
      await openFmt(p, 'quick'); await check('menu-quick');
      await click('#btn-home'); await p.waitForTimeout(150); // a chosen card hides the hub: back to the menu first
      await openFmt(p, 'practice'); await check('menu-practice');
      await click('#btn-home'); await p.waitForTimeout(150);
      await openFmt(p, 'exam'); await check('menu-exam');
      await click('#menu-card-rules'); await check('rules');
      await click('.sheet-close'); await p.waitForTimeout(150);
      await click('#btn-home'); await p.waitForTimeout(150);
      await click('#menu-card-progress'); await check('progress');
      await click('.sheet-close'); await p.waitForTimeout(150);
      await click('#btn-home'); await p.waitForTimeout(150);
      await openFmt(p, 'practice'); await p.waitForTimeout(150);
      await click('#menu-start'); await p.waitForTimeout(1400);
      await check('practice');
      // the in-game drawer is Ranges only (no settings, progress or analysis tabs any more)
      await click('#btn-ranges'); await p.waitForTimeout(450); await check('practice-drawer-ranges'); // drawer slides for --t-panel (260ms)
      await click('#btn-ranges'); await p.waitForTimeout(250);
      // play until the feedback popup shows
      for (let i = 0; i < 12; i++) {
        const shown = await p.evaluate(() => { const f = document.getElementById('feedback'); return !!f && !f.classList.contains('hidden'); });
        if (shown) break;
        await p.evaluate(() => { const b = document.getElementById('btn-call'); if (b && !b.disabled) b.click(); });
        await p.waitForTimeout(600);
      }
      await check('practice-feedback');
      await click('#btn-next'); await p.waitForTimeout(500);
      await click('#btn-back'); await p.waitForTimeout(200);
      await click('#leave-go'); await p.waitForTimeout(300); // a live hand asks first: confirm
      await openFmt(p, 'exam'); await p.waitForTimeout(150);
      await click('#menu-start'); await p.waitForTimeout(1400);
      await check('exam');
      for (let i = 0; i < 40; i++) {
        const panel = await p.evaluate(() => { const c = document.getElementById('cpu-result'); return !!c && !c.classList.contains('hidden'); });
        if (panel) break;
        await p.evaluate(() => { const b = document.getElementById('btn-call'); if (b && !b.disabled) b.click(); });
        await p.waitForTimeout(450);
      }
      await check('exam-hand-panel');
      await click('#btn-cpu-next'); await p.waitForTimeout(300);
      // Finish opens the in-app "Finish exam?" confirm (mp.js askPop): answer it with its OK button, or it stays open over the menu
      await click('#btn-finish-exam'); await p.waitForTimeout(250);
      await p.evaluate(() => { const ok = document.querySelector('#app-ask [data-ask="ok"]'); if (ok) ok.click(); });
      await p.waitForTimeout(600);
      await check('exam-summary');
      await click('#btn-analysis'); await check('exam-analysis');
      await p.evaluate(() => { const c = document.querySelector('#rv-overlay .rv-iconbtn'); if (c) c.click(); }); await p.waitForTimeout(150); // close the review overlay (back to the summary)
      await click('#leave-go');
      await click('#btn-exam-menu'); await p.waitForTimeout(300);
      await openFmt(p, 'practice'); await p.waitForTimeout(150);
      await click('#menu-start'); await p.waitForTimeout(1200);
      await click('#btn-help'); await check('help');
      await p.keyboard.press('Escape'); await p.waitForTimeout(200);
      // 4 players in the solo modes: no scrollbar anywhere (a scrollbar is an element whose offset box is wider or taller than its client box).
      for (const mode of ['practice', 'exam', 'quick']) {
        await p.evaluate(() => { document.querySelectorAll('#btn-back, #btn-exam-menu, #btn-table-menu, #leave-go').forEach((b) => { if (b.offsetParent) b.click(); }); });
        await p.waitForTimeout(250);
        await openFmt(p, mode === 'quick' ? 'table' : mode); await p.waitForTimeout(150);
        if (mode === 'quick') await p.selectOption('#menu-bots', '3');
        else { await p.selectOption('#menu-pmin', '4'); await p.selectOption('#menu-pmax', '4'); }
        await click('#menu-start'); await p.waitForTimeout(1100);
        // a real scrollbar needs overflow auto/scroll AND content larger than the box (borders are not scrollbars)
        const bars = await p.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.offsetHeight && getComputedStyle(e).display !== 'none' && !e.closest('.hidden,[hidden]')).filter((e) => {
          const cs = getComputedStyle(e);
          const sy = /auto|scroll/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 1;
          const sx = /auto|scroll/.test(cs.overflowX) && e.scrollWidth > e.clientWidth + 1;
          return sx || sy;
        }).filter((e) => !e.matches('select, input, textarea')).slice(0, 4).map((e) => (e.id ? '#' + e.id : e.className.toString().split(' ')[0] || e.tagName)));
        if (mode === 'exam') {
          // the Exam table wrap: its content must fit the box (no sideways or downward overflow, so no scrollbar)
          const tw = await p.evaluate(() => { const w = document.querySelector('.table-wrap'); return w ? [w.scrollWidth, w.clientWidth, w.scrollHeight, w.clientHeight] : null; });
          checks++;
          if (!tw) { fails.push(tag + ' [exam] no .table-wrap'); console.log('FAIL ' + tag + ' exam: no .table-wrap'); }
          else if (tw[0] > tw[1] + 1 || tw[2] > tw[3] + 1) { fails.push(tag + ' [exam] table-wrap overflows ' + tw.join('/')); console.log('FAIL ' + tag + ' exam table-wrap scroll ' + tw.join('/')); }
          else console.log('ok   ' + tag + ' exam table-wrap no scrollbar ' + tw.join('/'));
        }
        checks++;
        if (bars.length) { fails.push(tag + ' [4 players ' + mode + '] scrollbar on ' + bars.join(', ')); console.log('FAIL ' + tag + ' 4 players ' + mode + ' scrollbar: ' + bars.join(', ')); }
        else console.log('ok   ' + tag + ' 4 players ' + mode + ' no scrollbar');
      }
      if (errs.length) fails.push(tag + ' JS errors: ' + errs.slice(0, 3).join(' | '));
    } catch (e) {
      fails.push(tag + ' script error: ' + e.message.split('\n')[0]);
      console.log('FAIL ' + tag + ' script error: ' + e.message.split('\n')[0]);
    }
    await ctx.close();
  }
  await browser.close();
  console.log('\n' + checks + ' screens checked, ' + fails.length + ' problems');
  fails.slice(0, 200).forEach((f) => console.log('  ' + f));
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.log('fatal', e.message); process.exit(2); });
