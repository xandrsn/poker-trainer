'use strict';
/* npm run turn-test: checks TURN credentials by gathering a relay candidate in headless Chrome.
 * It creates an RTCPeerConnection with iceTransportPolicy 'relay' and waits up to 10 s for a
 * candidate of type "relay". Not part of npm test (needs Chrome and network access).
 *
 * Input: --urls turn:host:port[,turns:...]  --user NAME  --pass SECRET
 *   or the environment variables TURN_URLS, TURN_USER, TURN_PASS.
 * Browser: playwright-core driving Chrome at CHROME_PATH (default: Chrome for Windows). */
const fs = require('fs');

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const TIMEOUT_MS = 10000;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--urls') out.urls = argv[++i];
    else if (a === '--user') out.user = argv[++i];
    else if (a === '--pass') out.pass = argv[++i];
  }
  return out;
}

// Runs inside the page: returns the first relay candidate or null after the timeout.
function probeInPage(cfg) {
  return new Promise((resolve) => {
    const ice = { urls: cfg.urls };
    if (cfg.user) ice.username = cfg.user;
    if (cfg.pass) ice.credential = cfg.pass;
    const pc = new RTCPeerConnection({ iceServers: [ice], iceTransportPolicy: 'relay' });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try { pc.close(); } catch (e) { /* already closed */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish({ relay: null, gathering: pc.iceGatheringState }), cfg.timeoutMs);
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      const c = ev.candidate.candidate;
      if (/ typ relay/.test(c)) {
        clearTimeout(timer);
        finish({ relay: c });
      }
    };
    pc.createDataChannel('turn-probe');
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch((err) => { clearTimeout(timer); finish({ error: String(err && err.message || err) }); });
  });
}

function findChrome() {
  return CHROME_PATHS.find((p) => fs.existsSync(p)) || null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const urls = (args.urls || process.env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const user = args.user || process.env.TURN_USER || '';
  const pass = args.pass || process.env.TURN_PASS || '';
  if (!urls.length) {
    console.log('Usage: npm run turn-test -- --urls turn:host:3478 --user NAME --pass SECRET');
    console.log('   or set TURN_URLS, TURN_USER, TURN_PASS.');
    process.exitCode = 2;
    return;
  }
  const chrome = findChrome();
  if (!chrome) {
    console.log('FAIL: Chrome not found (set CHROME_PATH).');
    process.exitCode = 1;
    return;
  }
  let chromium;
  try {
    chromium = require('playwright-core').chromium;
  } catch (e) {
    console.log('FAIL: playwright-core is not installed (npm install).');
    process.exitCode = 1;
    return;
  }
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    const result = await page.evaluate(probeInPage, { urls: urls, user: user, pass: pass, timeoutMs: TIMEOUT_MS });
    if (result.relay) {
      console.log('PASS: relay candidate gathered via ' + urls.join(', '));
      console.log('      ' + result.relay);
      process.exitCode = 0;
    } else {
      const why = result.error ? 'error: ' + result.error : 'no relay candidate within ' + TIMEOUT_MS / 1000 + ' s';
      console.log('FAIL: ' + why + (result.gathering ? ' (gathering state: ' + result.gathering + ')' : ''));
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.log('FAIL: ' + (err && err.message || err));
  process.exitCode = 1;
});
