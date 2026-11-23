'use strict';
// Multiplayer sizes check in real headless Chrome: iPad portrait (768x1024), short landscape phone
// (667x375) and a 1024x768 tablet landscape. Each size runs the lobby and a hand with 5 seated players
// (reusing runCase/evaluate from test/e2e-layout.js) and asserts: no overlap between seats, chips, pot,
// board, banner, cards, action row, raise popover and toolbar; no page or container scroll; everything
// inside the viewport; text 12px or more (11px only at layout level lv4, the extra-compact fallback);
// and on touch every button at least 44px tall and wide (F/C/R included).
// Run with `node test/e2e-mp-sizes.js`. Env: E2E_PORT (default 3770), E2E_SHOTS (screenshot folder).
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { createServer } = require('../server.js');
const { runCase, evaluate } = require('./e2e-layout.js');

const PORT = Number(process.env.E2E_PORT || 3770);
const SHOTS = process.env.E2E_SHOTS || path.join(__dirname, '..', '.e2e-shots');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// [viewport, players]. 667x375 (phone landscape) runs 2, 5 and 9 players: the seat ring must never overlap
// anything there, and text may drop to 11px only at the extra-compact level (layout lv4).
const CASES = [
  [{ w: 768, h: 1024, phone: true }, 5],
  [{ w: 667, h: 375, phone: true }, 2],
  [{ w: 667, h: 375, phone: true }, 5],
  [{ w: 667, h: 375, phone: true }, 9],
  [{ w: 1024, h: 768, phone: true }, 5]
];

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required']
  });
  const results = [];
  try {
    for (const [vp, players] of CASES) {
      const server = createServer();
      await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
      try {
        const res = await runCase(browser, 'http://localhost:' + PORT, vp, players);
        const tapSmall = (res.buttons || []).filter((b) => b.rect.h < 44 || b.rect.w < 44).map((b) => b.label);
        const checks = Object.assign({}, res.checks, { tap44: tapSmall.length === 0 });
        const failed = Object.keys(checks).filter((k) => !checks[k]);
        results.push({ tag: res.tag, ok: failed.length === 0 && res.ok && tapSmall.length === 0, failed, pairs: res.pairs, tapSmall, minFont: res.minFont, minFontEl: res.minFontEl, errors: res.errors, scroll: res.scroll });
      } catch (e) {
        results.push({ tag: vp.w + 'x' + vp.h + '-p' + players, ok: false, failed: ['error'], error: String((e && e.message) || e).slice(0, 300) });
      } finally {
        await new Promise((r) => server.close(r));
      }
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(SHOTS, 'sizes-results.json'), JSON.stringify(results, null, 2));
  for (const r of results) {
    console.log(r.tag, r.ok ? 'PASS' : 'FAIL', r.failed.length ? 'failed: ' + r.failed.join(',') : '', r.pairs && r.pairs.length ? JSON.stringify(r.pairs.slice(0, 3)) : '', r.tapSmall && r.tapSmall.length ? 'tap<44: ' + r.tapSmall.join(',') : '', r.error ? 'ERROR ' + r.error : '');
  }
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}

main();
