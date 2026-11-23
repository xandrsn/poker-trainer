const { openFmt } = require('./helpers/menu');
// Real-browser verification of the user's UI points against a running server.
// Usage: node test/verify-points.js [baseUrl]
const { chromium } = require('playwright-core');
const path = require('path');
const BASE = process.argv[2] || 'http://localhost:3000';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOTS = path.join(__dirname, '..', '.e2e-shots');
const out = [];
const chk = (pt, ok, msg) => { out.push({ pt, ok: !!ok, msg }); console.log((ok ? 'ok   ' : 'FAIL ') + '[' + pt + '] ' + msg); };

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_|favicon/.test(m.text())) errs.push(m.text()); });
  await p.goto(BASE); await p.waitForTimeout(900);
  const ev = (f, a) => p.evaluate(f, a);
  const visible = (sel) => ev((s) => { const e = document.querySelector(s); return !!e && e.getBoundingClientRect().width > 0 && getComputedStyle(e).visibility !== 'hidden' && e.offsetParent !== null; }, sel);
  const clickIf = async (sel) => { if (await visible(sel)) { await p.click(sel).catch(() => {}); return true; } return false; };
  const canAct = () => ev(() => { const b = document.getElementById('btn-call'); return !!b && !b.disabled && b.offsetParent !== null; });

  // 3 thin header
  const headerH = await ev(() => { const h = document.querySelector('header, .topbar'); return h ? Math.round(h.getBoundingClientRect().height) : -1; });
  chk(3, headerH > 0 && headerH <= 56, 'header height ' + headerH + 'px (<= 56)');
  // 4 menu cards
  const cardNames = await ev(() => [...document.querySelectorAll('#view-menu .mode-card')].map((c) => c.innerText.replace(/\s+/g, ' ').trim().slice(0, 28)));
  console.log('     menu cards: ' + cardNames.join(' | '));
  const toolBtns = await ev(() => [...document.querySelectorAll('#view-menu .menu-tools .tool-btn')].map((b) => b.textContent.trim()));
  chk(4, cardNames.length === 5 && toolBtns.length === 2, 'main menu: 5 mode cards + 2 small tool buttons (Statistics, Rules): ' + cardNames.length + ' + ' + toolBtns.join('/'));
  for (const fmt of ['quick', 'practice', 'exam']) {
    await p.click('#btn-home').catch(() => {}); await p.waitForTimeout(200);
    await openFmt(p, fmt); await p.waitForTimeout(300);
    chk(4, await visible('#menu-start'), fmt + ': clicking the card reveals settings + a visible Play button');
  }
  // 13 personalities, no randomness
  await p.click('#btn-home'); await p.waitForTimeout(200); await openFmt(p, 'practice'); await p.waitForTimeout(300);
  const persBoxes = await ev(() => document.querySelectorAll('#menu-pers input[type=checkbox], #set-pers input[type=checkbox]').length);
  chk(13, persBoxes >= 5, 'personality checkboxes present: ' + persBoxes);
  chk(13, !(await ev(() => /randomness|aleatoriedad/i.test(['view-menu', 'menu-settings', 'settings-panel'].map((i) => (document.getElementById(i) || { innerText: '' }).innerText).join(' ')))), 'no randomness parameter in the menu or settings text');
  // 5 exam without fixed length
  chk(5, !(await ev(() => !!document.querySelector('#menu-exam-len, [data-len], #exam-bar'))), 'no 10/20/50 selector and no exam bar in the DOM');
  // 6 / 8
  await p.click('#menu-start'); await p.waitForTimeout(1500);
  chk(6, !(await ev(() => !!document.querySelector('#sidebar-left, #btn-left, #seat-list'))), 'no left panel listing seats and actions');
  chk(8, !(await ev(() => !!document.querySelector('#mode-label, .mode-pill, #table-title, #hand-title'))), 'no yellow mode pill / table title elements');
  const topText = await ev(() => (document.getElementById('practice-area') || document.body).innerText.split('\n').slice(0, 4).join(' '));
  chk(8, !/\d+\s*(players|jugadores)/i.test(topText) && !/preflop|flop|turn|river/i.test(topText.split(' ').slice(0, 6).join(' ')), 'no "position - N players - street" title above the table: "' + topText.slice(0, 60) + '"');
  // 9 folded opacity (play a few decisions so some seats fold)
  let opacityInfo = null;
  // practice = whole hands. The hero folds on the first decision, so a folded seat exists deterministically
  // (no reliance on what the bots happen to do). The other seats stay in and must not be faded.
  for (let i = 0; i < 60 && !(opacityInfo && opacityInfo.folded > 0); i++) {
    if (await canAct()) { await p.click('#btn-fold').catch(() => {}); await p.waitForTimeout(700); }
    await clickIf('#btn-next'); await p.waitForTimeout(400);
    opacityInfo = await ev(() => {
      const s = [...document.querySelectorAll('.seat')];
      const isF = (x) => /fold/i.test(x.className) || x.dataset.folded === 'true';
      const f = s.filter(isF), n = s.filter((x) => !isF(x) && !x.classList.contains('hero'));
      return { folded: f.length, fo: f.length ? +getComputedStyle(f[0]).opacity : null, no: n.length ? +getComputedStyle(n[0]).opacity : null };
    });
  }
  chk(9, opacityInfo && opacityInfo.folded > 0 && opacityInfo.fo < 0.6 && opacityInfo.no >= 0.9, 'folded seat opacity ' + (opacityInfo && opacityInfo.fo) + ' vs active ' + (opacityInfo && opacityInfo.no) + ' (' + (opacityInfo && opacityInfo.folded) + ' folded seats)');
  // 12 ranges drawer + win %
  // The win % is a guide for the hero's own turn: advance to a decision first.
  for (let i = 0; i < 20 && !(await canAct()); i++) { await clickIf('#btn-next'); await p.waitForTimeout(500); }
  await clickIf('#btn-ranges'); await p.waitForTimeout(700);
  const note = await ev(() => (document.getElementById('helper-panel') || { innerText: '' }).innerText.replace(/\s+/g, ' '));
  chk(12, /\d+(\.\d)?\s*%/.test(note), 'Ranges panel shows a win % number: "' + (note.match(/[^.]{0,60}\d+(\.\d)?\s*%[^.]{0,40}/) || [''])[0] + '"');
  const panelW = await ev(() => Math.round(document.getElementById('sidebar-right').getBoundingClientRect().width));
  chk('ranges', panelW >= 240 && (await visible('#helper-grid')), 'Ranges tab in the right sidebar, width ' + panelW + 'px, chart visible');
  await p.screenshot({ path: path.join(SHOTS, 'verify-ranges.png') });
  // 10 theme: the settings panel lives on the main menu only (header gear, Table tab)
  await p.click('#btn-back'); await p.waitForTimeout(200); await clickIf('#leave-go'); await p.waitForTimeout(300);
  await p.click('#btn-settings'); await p.waitForTimeout(300); await p.click('#set-tab-table'); await p.waitForTimeout(400);
  const themeUi = await ev(() => { const t = document.getElementById('menu-theme-settings'); return t ? { inputs: t.querySelectorAll('input[type=color]').length, buttons: t.querySelectorAll('button').length } : null; });
  chk(10, themeUi && themeUi.inputs >= 3 && themeUi.buttons >= 8, 'theme settings UI: ' + JSON.stringify(themeUi));
  await p.screenshot({ path: path.join(SHOTS, 'verify-settings.png') });
  await ev(() => window.PokerTheme && window.PokerTheme.set({ felt: '#1b3a8a', highlight: '#ff00aa' }));
  await p.waitForTimeout(300);
  const after = await ev(() => ({ felt: getComputedStyle(document.documentElement).getPropertyValue('--felt-user').trim(), hl: getComputedStyle(document.documentElement).getPropertyValue('--hl-user').trim(), rendered: getComputedStyle(document.querySelector('.felt')).backgroundColor }));
  chk(10, after.felt.toLowerCase() === '#1b3a8a' && after.hl.toLowerCase() === '#ff00aa', 'theme variables applied (felt ' + after.felt + ', highlight ' + after.hl + ', rendered felt ' + after.rendered + ')');
  await p.reload(); await p.waitForTimeout(800);
  await p.click('#btn-settings'); await p.waitForTimeout(200); await p.click('#btn-settings-close'); await p.waitForTimeout(200);
  chk(10, (await ev(() => getComputedStyle(document.documentElement).getPropertyValue('--hl-user').trim())).toLowerCase() === '#ff00aa', 'theme persists after reload');
  await ev(() => window.PokerTheme && window.PokerTheme.reset());
  // 11 help: the scoring link sits at the menu foot (menu only)
  await p.click('#btn-home'); await p.waitForTimeout(300);
  chk(11, await visible('#btn-help'), 'help link "How does scoring work?" visible on the menu foot');
  await p.click('#btn-help'); await p.waitForTimeout(600);
  const help = await ev(() => { const d = [...document.querySelectorAll('[role=dialog]')].find((x) => x.getBoundingClientRect().width > 0); return d ? d.innerText.replace(/\s+/g, ' ') : null; });
  chk(11, help && help.length > 300 && !/equity/i.test(help), 'help modal opens with ' + (help ? help.length : 0) + ' chars: "' + (help || '').slice(0, 90) + '..."');
  await p.screenshot({ path: path.join(SHOTS, 'verify-help.png') });
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  // 7 stacks setting
  await p.goto(BASE); await p.waitForTimeout(600); await openFmt(p, 'practice'); await p.waitForTimeout(300);
  await p.click('.menu-advanced > summary'); await p.waitForTimeout(300); // Position, street and stack fold on the Play setup
  const stacksOpts = await ev(() => [...document.querySelectorAll('#set-stacks option')].map((o) => o.value));
  chk(7, stacksOpts.length >= 3, 'stacks setting options: ' + stacksOpts.join(','));
  // 5 exam flow
  await p.goto(BASE); await p.waitForTimeout(600);
  await openFmt(p, 'exam'); await p.waitForTimeout(300); await p.click('#menu-start'); await p.waitForTimeout(1500);
  chk(5, await visible('#btn-finish-exam'), 'exam: "Finish exam" button visible');
  let shown = 0, decisions = 0;
  const panels = [];
  // whole hands: a short hand gives 1-3 decisions, so keep going until 8 (or the cap) before the >= 4 check
  for (let i = 0; i < 80 && decisions < 8; i++) {
    if (await canAct()) { await p.click(i % 4 === 3 ? '#btn-raise' : '#btn-call').catch(() => {}); decisions++; await p.waitForTimeout(800); if (await visible('#feedback')) shown++; }
    else await p.waitForTimeout(700);
    // End-of-hand panel (exam): one % per decided round + the hand average
    if (await visible('#cpu-result')) {
      panels.push(await ev(() => ({
        lines: [...document.querySelectorAll('#cpu-result-lines li')].map((l) => l.innerText.trim()),
        titleHidden: getComputedStyle(document.getElementById('cpu-result-title')).display === 'none',
        text: document.getElementById('cpu-result').innerText.replace(/\s+/g, ' ')
      })));
    }
    await clickIf('#btn-cpu-next'); await clickIf('#btn-next');
  }
  chk('exam', decisions >= 4 && shown === 0, 'exam: ' + decisions + ' decisions made, feedback popup shown ' + shown + ' times (must be 0)');
  const roundRe = /^(Preflop|Flop|Turn|River) \d{1,3}%$/;
  const avgRe = /^(Average|Media) \d{1,3}%$/;
  const panelOk = (pn) => pn.lines.length >= 2 && pn.lines.slice(0, -1).every((l) => roundRe.test(l)) && avgRe.test(pn.lines[pn.lines.length - 1]) && pn.titleHidden;
  const noWords = (pn) => !/(best|good|mistake|blunder|mejor|bien|error|equity)/i.test(pn.text);
  chk('exam', panels.length >= 1 && panels.every(panelOk), 'exam: end-of-hand panel after each hand (' + panels.length + ' hands): ' + JSON.stringify(panels.slice(0, 2).map((x) => x.lines)));
  chk('exam', panels.length >= 1 && panels.every(noWords), 'exam: hand panel has no Best/Good/Mistake/Blunder words or explanations');
  chk('exam', !(await visible('#btn-ranges')), 'exam: no ranges button during hands');
  chk(5, !(await visible('#exam-live')), 'exam: no live stats card during hands (stats only via the Statistics button)');
  // one click opens the in-app confirm popup (PokerAsk); its OK button finishes the exam
  await p.click('#btn-finish-exam'); await p.waitForSelector('[data-ask="ok"]', { state: 'visible', timeout: 3000 });
  await p.click('[data-ask="ok"]'); await p.waitForTimeout(900);
  chk(5, await visible('#exam-summary'), 'exam: summary shown after Finish');
  const avg = await ev(() => (document.getElementById('sum-avg') || { innerText: '' }).innerText);
  chk(5, /\d/.test(avg || ''), 'exam: average % in the summary: ' + avg);
  await p.click('#btn-analysis').catch(() => {}); await p.waitForTimeout(700);
  const an = await ev(() => { const o = document.getElementById('rv-overlay'); return o ? { items: (o.innerText.match(/Hand\s*\d+/g) || []).length, txt: o.innerText.replace(/\s+/g, ' ').slice(0, 120) } : null; });
  chk(5, an && an.items >= 1, 'exam: Review game lists decisions: ' + JSON.stringify(an));
  await p.screenshot({ path: path.join(SHOTS, 'verify-exam-analysis.png') });
  // rules
  await p.goto(BASE); await p.waitForTimeout(600);
  await p.click('#menu-card-rules'); await p.waitForTimeout(700);
  // the rulebook is paged: read the ranking page, then the 'Why' page
  const rulesRank = await ev(() => document.getElementById('sheet-rules').innerText.replace(/\s+/g, ' '));
  let rules = rulesRank;
  const whyPages = [];
  await p.click('[data-rpage="1"]'); await p.waitForTimeout(150);
  for (let i = 0; i < 12; i++) {
    const txt = await ev(() => document.getElementById('sheet-rules').innerText.replace(/\s+/g, ' '));
    whyPages.push(txt); rules += ' ' + txt;
    if (await ev(() => document.getElementById('rule-next').disabled)) break;
    await ev(() => document.getElementById('rule-next').click()); await p.waitForTimeout(100);
  }
  const whyAll = whyPages.join(' ');
  chk('rules', /royal|escalera real/i.test(rulesRank) && whyPages.length >= 6 && /position|posici/i.test(whyAll) && /stack|fichas|dinero|money/i.test(whyAll) && /players|jugadores/i.test(whyAll) && !/equity/i.test(rules), 'rulebook: ranking + ' + whyPages.length + ' Why pages clicked through; position, stacks and players text found on them (' + rules.length + ' chars)');
  await p.screenshot({ path: path.join(SHOTS, 'verify-rules.png') });
  chk(18, errs.length === 0, 'no JS errors during the whole run' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await browser.close();
  const bad = out.filter((o) => !o.ok).length;
  console.log('\n' + (out.length - bad) + '/' + out.length + ' verification checks passed');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('script failed:', e.message.split('\n')[0]); process.exit(2); });
