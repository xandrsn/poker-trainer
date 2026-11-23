'use strict';
// Main menu hub: options are revealed by their group's main tile (Play or Practice) first.
async function openFmt(p, fmt) {
  const group = fmt === 'table' || fmt === 'mp' ? 'play' : 'practice';
  if (!(await p.isVisible('[data-fmt="' + fmt + '"]'))) await p.click('#hub-' + group);
  await p.click('[data-fmt="' + fmt + '"]');
}

// Menu and navigation check in real Chrome (playwright-core). Not part of `npm test`: `npm run e2e:menu`.
// For each size: after choosing a mode card, #menu-start must be inside the viewport and clickable,
// Play must enter the game (body[data-view]=game), the logo must go home from the game and from an open sheet,
// and clicking the backdrop must close an open sheet.
const path = require('path');
const { chromium } = require('playwright-core');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const INDEX = 'file:///' + path.join(__dirname, '..', 'public', 'index.html').replace(/\\/g, '/');
const SIZES = [[1366, 768], [1536, 730], [1920, 937], [390, 700]];
const PANEL_SIZES = [[1366, 768], [1920, 1080], [390, 844], [844, 390]];

// Main menu hub: two equal main tiles (Play, Practice). Play reveals exactly 2 options (Vs bots, Multiplayer),
// Practice exactly 3. Multiplayer opens the Multiplayer screen (two equal tiles: Join table, Create table; its
// back arrow returns to the menu). Checked at six sizes: no page scroll, the reveal animates only transform and
// opacity, Escape collapses expanded panels, the keyboard works.
async function hubChecks(browser, expect, rows) {
  const HUB_SIZES = [[1920, 1080], [1366, 768], [1024, 600], [844, 390], [390, 844], [360, 640]];
  for (const [w, h] of HUB_SIZES) {
    const touch = w < 900;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch });
    const page = await ctx.newPage();
    const tag = 'hub ' + w + 'x' + h;
    await page.goto(INDEX);
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.reload();
    // The Multiplayer tiles need a user name (Settings > User record); set it as the real app does.
    await page.evaluate(() => localStorage.setItem('poker-trainer:user:v1', JSON.stringify({ name: 'Tester', avatar: '' })));
    const shown = (g) => page.evaluate((grp) => Array.from(document.querySelectorAll('#hub-opts-' + grp + ' .mode-card'))
      .filter((c) => c.getClientRects().length > 0).map((c) => { const r = c.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }), g);
    const optIds = (g) => page.evaluate((grp) => Array.from(document.querySelectorAll('#hub-opts-' + grp + ' .mode-card'))
      .filter((c) => c.getClientRects().length > 0).map((c) => c.dataset.fmt || c.id), g);
    const mains = await page.evaluate(() => ['hub-play', 'hub-practice'].map((id) => {
      const r = document.getElementById(id).getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)];
    }));
    expect(mains[0][0] === mains[1][0] && mains[0][1] === mains[1][1], tag + ': two main tiles equal size ' + JSON.stringify(mains));
    const scroll0 = await page.evaluate(() => document.scrollingElement.scrollHeight - innerHeight);
    expect(scroll0 <= 0, tag + ': no page scroll at start (' + scroll0 + ')');
    expect((await shown('play')).length === 0 && (await shown('practice')).length === 0, tag + ': options hidden at start');
    // Play: click, then sample the reveal animation right away.
    await page.click('#hub-play');
    const anim = await page.evaluate(() => {
      const names = []; const props = new Set();
      document.querySelectorAll('#hub-opts-play .mode-card').forEach((c) => c.getAnimations().forEach((a) => {
        names.push(a.animationName);
        a.effect.getKeyframes().forEach((k) => Object.keys(k).forEach((p) => props.add(p)));
      }));
      return { names, props: Array.from(props) };
    });
    const onlyTO = anim.props.every((p) => ['opacity', 'transform', 'offset', 'easing', 'computedOffset', 'composite'].includes(p));
    expect(anim.names.length > 0 && onlyTO, tag + ': reveal animates transform/opacity only ' + JSON.stringify(anim));
    await page.waitForTimeout(350);
    const play = await shown('play');
    const playIds = await optIds('play');
    expect(play.length === 2 && playIds.join(',') === 'table,menu-card-mp', tag + ': Play reveals exactly 2 options (' + playIds.join(',') + ')');
    expect((await shown('practice')).length === 0, tag + ': Practice hidden while Play is open');
    expect((await page.getAttribute('#hub-play', 'aria-expanded')) === 'true', tag + ': aria-expanded true on Play');
    // Multiplayer opens its own screen: two equal tiles, no scroll.
    await page.click('#menu-card-mp');
    await page.waitForSelector('#mp-rooms[data-view="choose"]', { timeout: 10000 });
    const tiles = await page.evaluate(() => ['#mr-tile-join', '#mr-tile-create'].map((s) => {
      const r = document.querySelector(s).getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)];
    }));
    expect(tiles[0].join('x') === tiles[1].join('x'), tag + ': Multiplayer has two equal tiles ' + JSON.stringify(tiles));
    const mpScroll = await page.evaluate(() => document.scrollingElement.scrollHeight - innerHeight);
    expect(mpScroll <= 0, tag + ': no page scroll on the Multiplayer screen (' + mpScroll + ')');
    // Enter on a tile expands its panel; Escape collapses it and keeps focus on the tile.
    await page.focus('#mr-tile-join'); await page.keyboard.press('Enter'); await page.waitForTimeout(120);
    const openJ = (await page.getAttribute('#mr-tile-join', 'aria-expanded')) === 'true';
    await page.keyboard.press('Escape'); await page.waitForTimeout(120);
    const collapsed = (await page.getAttribute('#mr-tile-join', 'aria-expanded')) === 'false';
    const tileFocus = await page.evaluate(() => document.activeElement && document.activeElement.id === 'mr-tile-join');
    expect(openJ && collapsed && tileFocus, tag + ': Enter expands, Escape collapses the Join panel, focus stays on the tile');
    // Back arrow returns to the main menu with Play still open.
    await page.click('#mp-rooms .mr-back');
    await page.waitForSelector('#mp-rooms', { state: 'hidden', timeout: 5000 });
    expect((await optIds('play')).join(',') === 'table,menu-card-mp', tag + ': back arrow returns to the menu, Play still open');
    // Keyboard: Enter on Multiplayer opens the screen; back returns; Escape on Play collapses the group.
    await page.focus('#menu-card-mp'); await page.keyboard.press('Enter');
    await page.waitForSelector('#mp-rooms[data-view="choose"]', { timeout: 5000 });
    await page.click('#mp-rooms .mr-back');
    await page.waitForSelector('#mp-rooms', { state: 'hidden', timeout: 5000 });
    await page.focus('#hub-play'); await page.keyboard.press('Escape'); await page.waitForTimeout(120);
    expect((await shown('play')).length === 0, tag + ': Escape on Play collapses the group');
    // Practice: switches the group, shows exactly 3.
    await page.click('#hub-play'); await page.waitForTimeout(300);
    await page.click('#hub-practice');
    await page.waitForTimeout(350);
    const practice = await shown('practice');
    const playAfter = await shown('play');
    expect(practice.length === 3 && playAfter.length === 0, tag + ': Practice reveals exactly 3 options (' + practice.length + ')');
    const sizes = new Set(play.concat(practice).map((s) => s.join('x')));
    expect(sizes.size === 1, tag + ': all option tiles the same size ' + Array.from(sizes).join(' '));
    const scroll = await page.evaluate(() => document.scrollingElement.scrollHeight - innerHeight);
    expect(scroll <= 0, tag + ': no page scroll with options open (' + scroll + ')');
    // Clicking the active main again collapses it.
    await page.click('#hub-practice'); await page.waitForTimeout(300);
    expect((await shown('practice')).length === 0 && (await page.getAttribute('#hub-practice', 'aria-expanded')) === 'false', tag + ': active main collapses its group');
    // Keyboard: Enter opens, ArrowDown enters the options, Escape closes and returns focus to the main tile.
    await page.focus('#hub-play'); await page.keyboard.press('Enter'); await page.waitForTimeout(120);
    await page.keyboard.press('ArrowDown');
    const onFirst = await page.evaluate(() => document.activeElement && document.activeElement.dataset.fmt === 'table');
    await page.keyboard.press('Escape'); await page.waitForTimeout(120);
    const back = await page.evaluate(() => document.activeElement && document.activeElement.id === 'hub-play');
    const closed = (await page.getAttribute('#hub-play', 'aria-expanded')) === 'false';
    expect(onFirst && back && closed, tag + ': keyboard Enter / ArrowDown / Escape works');
    rows.push({ size: w + 'x' + h, mains, play: play.map((s) => s.join('x')).join(' '), practice: practice.map((s) => s.join('x')).join(' '), anim: anim.names, scroll, tiles });
    await ctx.close();
  }
}

// Header settings panel on the main menu: one gear, open/close (button, Close, Esc, outside click),
// language switch, volume persistence, colour change, and the gear hidden inside a mode.
async function panelChecks(browser, expect, rows) {
  for (const [w, h] of PANEL_SIZES) {
    const tag = 'panel ' + w + 'x' + h;
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(INDEX);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    const shown = (sel) => page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el || el.closest('.hidden') || getComputedStyle(el).display === 'none') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }, sel);
    const header = await page.evaluate(() => {
      const gear = document.getElementById('btn-settings');
      const look = document.getElementById('btn-look');
      return {
        gears: document.querySelectorAll('.topbar #btn-settings').length,
        headerLang: document.querySelectorAll('.topbar .lang-btn').length,
        gearSide: gear ? Math.round(gear.getBoundingClientRect().left / innerWidth * 100) : -1,
        gearPx: gear ? [Math.round(gear.getBoundingClientRect().width), Math.round(gear.getBoundingClientRect().height)] : null,
        lookDisplay: look ? getComputedStyle(look).display : 'none',
        pageScroll: document.scrollingElement.scrollHeight - innerHeight
      };
    });
    expect(header.gears === 1 && header.headerLang === 0, tag + ': one gear in header, no header language toggle ' + JSON.stringify(header));
    expect(header.gearSide >= 50 && header.gearPx && header.gearPx[0] >= 44 && header.gearPx[1] >= 44, tag + ': gear is top-right and 44px ' + JSON.stringify(header));
    expect(header.lookDisplay === 'none', tag + ': floating Look button hidden on the main menu');
    await page.click('#btn-settings');
    expect(await shown('#settings-panel'), tag + ': gear opens panel');
    expect(await page.evaluate(() => document.getElementById('settings-panel').contains(document.activeElement)), tag + ': focus moves into panel');
    await page.keyboard.press('Escape');
    expect(!(await shown('#settings-panel')), tag + ': Escape closes panel');
    const back = await page.evaluate(() => document.activeElement && document.activeElement.id);
    expect(back === 'btn-settings', tag + ': focus returns to gear (' + back + ')');
    await page.click('#btn-settings');
    await page.click('#btn-settings-close');
    expect(!(await shown('#settings-panel')), tag + ': Close button closes panel');
    await page.click('#btn-settings');
    await page.mouse.click(5, Math.round(h / 2));
    expect(!(await shown('#settings-panel')), tag + ': outside click closes panel');
    // Language switch updates the panel and the menu at once.
    await page.click('#btn-settings');
    await page.click('#settings-panel [data-lang="es"]');
    const esTitle = (await page.textContent('#settings-panel-title')).trim();
    const esMenu = (await page.textContent('#menu-heading')).trim();
    expect(esTitle === 'Ajustes' && esMenu === 'Elige un modo', tag + ': Spanish updates panel and menu (' + esTitle + ' / ' + esMenu + ')');
    await page.click('#settings-panel [data-lang="en"]');
    expect((await page.textContent('#settings-panel-title')).trim() === 'Settings', tag + ': back to English');
    // Volume applies at once and persists across reload.
    await page.evaluate(() => { const i = document.getElementById('set-volume'); i.value = '35'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    const stored = await page.evaluate(() => localStorage.getItem('poker-trainer:volume'));
    expect(stored === '35', tag + ': volume persisted (' + stored + ')');
    await page.reload();
    await page.click('#btn-settings');
    const vol = await page.$eval('#set-volume', (i) => i.value);
    expect(vol === '35', tag + ': volume slider shows stored value after reload (' + vol + ')');
    // Table colour applies live and persists.
    const themeBefore = await page.evaluate(() => localStorage.getItem('poker-trainer:theme:v2'));
    const clicked = await page.evaluate(() => {
      const sw = Array.from(document.querySelectorAll('#menu-theme-settings .tcol-sw')).find((b) => b.getAttribute('aria-pressed') !== 'true' && !b.classList.contains('is-none'));
      if (!sw) return false;
      sw.click();
      return true;
    });
    const themeAfter = await page.evaluate(() => localStorage.getItem('poker-trainer:theme:v2'));
    expect(clicked && themeAfter && themeAfter !== themeBefore, tag + ': colour swatch in panel applies and persists');
    await page.keyboard.press('Escape');
    // Inside a mode the header (and its gear) is hidden.
    await openFmt(page, 'quick');
    await page.click('#menu-start');
    expect(!(await shown('#btn-settings')), tag + ': gear not visible inside a mode');
    expect(errors.length === 0, tag + ': no page errors ' + errors.join(' | '));
    rows.push({ size: w + 'x' + h, header, panelPageScrollPx: header.pageScroll });
    await page.close();
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const rows = [];
  const failures = [];
  const expect = (ok, what) => { if (!ok) failures.push(what); };
  try {
    for (const [w, h] of SIZES) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      await page.goto(INDEX);
      await page.evaluate(() => localStorage.clear());
      await page.reload();
      for (const card of ['practice', 'quick']) {
        const size = w + 'x' + h + ' ' + card;
        await page.click('#btn-home');
        await openFmt(page, card);
        const box = await page.evaluate(() => {
          const r = document.getElementById('menu-start').getBoundingClientRect();
          return { top: Math.round(r.top), bottom: Math.round(r.bottom), innerH: innerHeight };
        });
        const inside = box.top >= 0 && box.bottom <= box.innerH;
        expect(inside, size + ': Play inside viewport ' + JSON.stringify(box));
        await page.click('#menu-start');
        const inGame = await page.evaluate(() => document.body.dataset.view);
        expect(inGame === 'game', size + ': Play enters game (view=' + inGame + ')');
        // inside a mode the top bar (logo) is hidden: the back arrow (top-right) is the way home
        const logoHidden = await page.evaluate(() => { const b = document.getElementById('btn-home'); return !b || b.getBoundingClientRect().width === 0 || getComputedStyle(b).display === 'none' || getComputedStyle(b.closest('header, .topbar') || b).display === 'none'; });
        expect(logoHidden, size + ': logo hidden inside the game');
        // back arrow: top-left in every mode; a live hand asks first ("Leave the game?"): Stay keeps the game
        const arrow = await page.evaluate(() => { const r = document.getElementById('btn-back').getBoundingClientRect(); return { x: r.left, y: r.top, w: innerWidth }; });
        expect(arrow.x < arrow.w / 3 && arrow.y < 60, size + ': back arrow top-left ' + JSON.stringify(arrow));
        await page.click('#btn-back');
        const asked = await page.evaluate(() => { const l = document.getElementById('leave-pop'); return !!l && !l.classList.contains('hidden'); });
        expect(asked, size + ': back arrow in a live hand asks to confirm leaving');
        await page.click('#leave-stay');
        expect((await page.evaluate(() => document.body.dataset.view)) === 'game', size + ': Stay keeps the game');
        await page.click('#btn-back');
        await page.click('#leave-go');
        const home = await page.evaluate(() => document.body.dataset.view);
        expect(home === 'menu', size + ': confirmed back arrow returns home from game (view=' + home + ')');
        rows.push({ size: w + 'x' + h, card, play: box, viewAfterPlay: inGame, viewAfterLogo: home });
      }
      // Logo from an open sheet.
      await page.click('#menu-card-rules');
      const openRules = await page.evaluate(() => !document.getElementById('sheet-rules').classList.contains('hidden'));
      { const lb = await page.evaluate(() => { const r = document.getElementById('btn-home').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }); await page.mouse.click(lb.x, lb.y); await page.waitForTimeout(150); await page.click('#btn-home'); } // the sheet covers the header: first click hits the backdrop
      const closedAfterLogo = await page.evaluate(() => document.getElementById('sheet-rules').classList.contains('hidden'));
      const viewAfterSheetLogo = await page.evaluate(() => document.body.dataset.view);
      expect(openRules && closedAfterLogo && viewAfterSheetLogo === 'menu', w + 'x' + h + ': logo closes sheet and goes home');
      // Backdrop closes an open sheet.
      await openFmt(page, 'practice');
      await page.click('#btn-home');
      await page.click('#menu-card-progress');
      await page.mouse.click(5, h - 5);
      const closedByBackdrop = await page.evaluate(() => document.getElementById('sheet-progress').classList.contains('hidden'));
      expect(closedByBackdrop, w + 'x' + h + ': backdrop closes progress sheet');
      rows.push({ size: w + 'x' + h, sheetLogo: { openRules, closedAfterLogo, viewAfterSheetLogo }, backdropClosed: closedByBackdrop });
      await page.close();
    }
    await hubChecks(browser, expect, rows);
    await panelChecks(browser, expect, rows);
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(rows, null, 1));
  if (failures.length) { console.log('FAILURES:\n' + failures.join('\n')); process.exitCode = 1; }
  else console.log('all menu checks passed at ' + SIZES.length + ' sizes');
})().catch((e) => { console.error(e); process.exitCode = 1; });
