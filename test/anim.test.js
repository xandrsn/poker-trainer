'use strict';
// Tests for public/anim.js (PokerAnim) with a minimal DOM stub: elements, style, children, classList,
// getBoundingClientRect and an animate() stub that finishes on a short timer (or never, when hung).
const assert = require('node:assert/strict');

let reduced = false;
let hung = false;
let animCount = 0;

class El {
  constructor(tag) {
    this.tagName = tag;
    this.className = '';
    this.style = {};
    this.children = [];
    this.parentNode = null;
    this.textContent = '';
    this.rect = { left: 0, top: 0, width: 0, height: 0 };
    const self = this;
    this.classList = {
      add(...c) { const set = new Set(self.className.split(/\s+/).filter(Boolean)); c.forEach(x => set.add(x)); self.className = [...set].join(' '); },
      remove(...c) { self.className = self.className.split(/\s+/).filter(x => x && !c.includes(x)).join(' '); },
      contains(c) { return self.className.split(/\s+/).includes(c); },
      toggle(c) { this.contains(c) ? this.remove(c) : this.add(c); }
    };
  }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  getBoundingClientRect() { return this.rect; }
  animate(frames, opts) {
    animCount++;
    let cancelled = false, resolveF, rejectF;
    const finished = new Promise((res, rej) => { resolveF = res; rejectF = rej; });
    if (!hung) setTimeout(() => { if (!cancelled) resolveF(); }, 2);
    return { finished, cancel() { if (!cancelled) { cancelled = true; rejectF(new Error('AbortError')); } } };
  }
}

global.document = { hidden: false, createElement: tag => new El(tag) };
global.window = { matchMedia: () => ({ matches: reduced }) };
const A = require('../public/anim.js');

const anim = () => document.createElement('section');
function countEl(node) {
  let n = 0;
  (function walk(x) { x.children.forEach(c => { if (c.className.includes('anim-el')) n++; walk(c); }); })(node);
  return n;
}
function layerOf(node) { return node.children.find(c => c.className.includes('anim-layer')) || null; }
const rect = (x, y, w = 18, h = 25) => ({ x, y, width: w, height: h });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('layer() creates one .anim-layer and returns the same one again', () => {
  const t = anim();
  const l1 = A.layer(t), l2 = A.layer(t);
  assert.equal(l1, l2);
  assert.equal(l1.className, 'anim-layer');
  assert.equal(t.children.length, 1);
});

test('flyCards resolves with the card count and leaves no .anim-el behind', async () => {
  const t = anim();
  const targets = [rect(10, 10), rect(100, 10), rect(200, 10)];
  const n = await A.flyCards(t, rect(150, 100), targets, { rounds: 2, stagger: 10, duration: 20 });
  assert.equal(n, 6);
  assert.equal(countEl(t), 0);
});

test('flyCards defaults: rounds 2, centre origin when fromRect is null', async () => {
  const t = anim();
  t.clientWidth = 400; t.clientHeight = 200;
  const n = await A.flyCards(t, null, [rect(0, 0)], { stagger: 1, duration: 5 });
  assert.equal(n, 2);
  assert.equal(countEl(t), 0);
});

test('flyCards accepts elements as targets through rectIn', async () => {
  const t = anim();
  const seat = document.createElement('div');
  seat.rect = { left: 40, top: 60, width: 30, height: 40 };
  t.rect = { left: 0, top: 0, width: 400, height: 300 };
  const n = await A.flyCards(t, rect(200, 150), [seat], { rounds: 1, stagger: 1, duration: 5 });
  assert.equal(n, 1);
});

test('element cap: never more than 60 .anim-el at once', async () => {
  const t = anim();
  const targets = Array.from({ length: 10 }, (_, i) => rect(i * 30, 0));
  const p = A.flyCards(t, rect(0, 0), targets, { rounds: 10, stagger: 0, duration: 20 });
  assert.equal(countEl(t), 60);           // 100 requested, the rest are skipped
  const n = await p;
  assert.equal(n, 60);
  assert.equal(countEl(t), 0);
});

test('flipReveal swaps the face at the midpoint and resolves', async () => {
  const t = anim();
  const c = document.createElement('div');
  c.className = 'anim-card back';
  t.appendChild(c);
  await A.flipReveal(c, { duration: 20 });
  assert.ok(c.classList.contains('face'));
  assert.ok(!c.classList.contains('back'));
});

test('flipReveal array form (flop) resolves for all cards', async () => {
  const t = anim();
  const cards = [0, 1, 2].map(() => { const c = document.createElement('div'); c.className = 'anim-card back'; t.appendChild(c); return c; });
  await A.flipReveal(cards, { duration: 10, stagger: 2 });
  cards.forEach(c => assert.ok(c.classList.contains('face')));
});

test('chipCount rules: 0 for no amount, 1 per BB doubling, max 5', () => {
  assert.equal(A.chipCount(0, 10), 0);
  assert.equal(A.chipCount(-5, 10), 0);
  assert.equal(A.chipCount(NaN, 10), 0);
  assert.equal(A.chipCount(10, 10), 1);
  assert.equal(A.chipCount(20, 10), 2);
  assert.equal(A.chipCount(40, 10), 3);
  assert.equal(A.chipCount(80, 10), 4);
  assert.equal(A.chipCount(10000, 10), 5);
  assert.equal(A.chipCount(5, 0), 3);      // bb falls back to 1 when invalid
});

test('flyChips: count per source, total chips returned', async () => {
  const t = anim();
  const n = await A.flyChips([rect(0, 0), rect(50, 0), rect(100, 0)], rect(200, 200), { container: t, count: 2, stagger: 1, duration: 10 });
  assert.equal(n, 6);
  assert.equal(countEl(t), 0);
});

test('flyChips: amounts drive the count per source', async () => {
  const t = anim();
  const n = await A.flyChips([rect(0, 0), rect(50, 0), rect(100, 0)], rect(200, 200), { container: t, amounts: [0, 20, 80], bb: 10, stagger: 1, duration: 10 });
  assert.equal(n, 0 + 2 + 4);
});

test('potToWinners: one flight per chip, amounts split by chipCount', async () => {
  const t = anim();
  const n = await A.potToWinners(rect(200, 120, 40, 20), [{ rect: rect(20, 20), amount: 40 }, { rect: rect(380, 20), amount: 10 }], { container: t, bb: 10, stagger: 1, duration: 10 });
  assert.equal(n, 3 + 1);
  assert.equal(countEl(t), 0);
});

test('countUp ends on the exact final value', async () => {
  const el = document.createElement('span');
  await A.countUp(el, 0, 1234.5, 30, v => '$' + v.toFixed(2));
  assert.equal(el.textContent, '$1234.50');
  await A.countUp(el, 5, 77, 0);
  assert.equal(el.textContent, '77');
  await A.countUp(el, 0, 9, 25);
  assert.equal(el.textContent, '9');
});

test('glow and floatLabel leave no .anim-el behind', async () => {
  const t = anim();
  const seat = document.createElement('div');
  seat.rect = { left: 10, top: 10, width: 40, height: 20 };
  t.appendChild(seat);
  seat.offsetParent = t;
  await A.glow(seat, 15);
  await A.floatLabel(rect(20, 20), '+12 BB', { container: t, cls: 'win', ms: 15 });
  assert.equal(countEl(t), 0);
});

test('clear(container) removes everything immediately and resolves pending work', async () => {
  const t = anim();
  const p = A.flyCards(t, rect(0, 0), [rect(10, 10), rect(20, 20)], { rounds: 2, stagger: 50, duration: 200 });
  assert.ok(countEl(t) > 0);
  A.clear(t);
  assert.equal(countEl(t), 0);
  assert.equal(layerOf(t), null);
  assert.equal(await p, 4);
  A.clear(t);                              // idempotent
  A.clear(t);
  assert.equal(countEl(t), 0);
});

test('clear() with no container clears every live element', () => {
  const t = anim();
  A.flyChips([rect(0, 0)], rect(50, 50), { container: t, count: 3, stagger: 100, duration: 200 });
  assert.ok(countEl(t) > 0);
  A.clear();
  assert.equal(countEl(t), 0);
});

test('reduced motion: every function resolves with no DOM work', async () => {
  reduced = true;
  try {
    const t = anim();
    const before = animCount;
    assert.equal(A.enabled(), false);
    assert.equal(await A.flyCards(t, rect(0, 0), [rect(5, 5)]), 0);
    assert.equal(await A.flyChips([rect(0, 0)], rect(5, 5), { container: t, count: 2 }), 0);
    assert.equal(await A.potToWinners(rect(0, 0), [{ rect: rect(5, 5), amount: 10 }], { container: t }), 0);
    const el = document.createElement('span');
    el.textContent = 'old';
    await A.countUp(el, 0, 5, 100);
    assert.equal(el.textContent, 'old');
    await A.flipReveal(document.createElement('div'));
    assert.equal(layerOf(t), null);
    assert.equal(animCount, before);
  } finally { reduced = false; }
});

test('document.hidden disables the module', async () => {
  document.hidden = true;
  try {
    assert.equal(A.enabled(), false);
    assert.equal(await A.flyCards(anim(), null, [rect(0, 0)]), 0);
  } finally { document.hidden = false; }
  assert.equal(A.enabled(), true);
});

test('missing nodes never throw and resolve', async () => {
  assert.equal(A.layer(null), null);
  assert.equal(A.rectIn(null, null), null);
  A.clear(null);
  await A.flyCards(null, null, [rect(0, 0)]);
  await A.flyCards(anim(), null, null);
  await A.flyChips([null, undefined], null, { container: anim() });
  await A.flyChips([rect(0, 0)], rect(5, 5));           // no container
  await A.potToWinners(null, [null, { rect: null, amount: 5 }], { container: anim() });
  await A.flipReveal(null);
  await A.flipReveal([null, undefined]);
  await A.countUp(null, 0, 5, 10);
  await A.glow(null);
  await A.glow(document.createElement('div'));          // detached: no offsetParent or parent
  await A.floatLabel(null, 'x', { container: anim() });
  await A.floatLabel(rect(0, 0), 'x');                  // no container
  assert.ok(true);
});

test('rectIn returns the rect relative to the container', () => {
  const t = anim(), el = anim();
  t.rect = { left: 100, top: 50, width: 300, height: 200 };
  el.rect = { left: 130, top: 70, width: 40, height: 20 };
  const r = A.rectIn(t, el);
  assert.deepEqual([r.x, r.y, r.width, r.height], [30, 20, 40, 20]);
});

test('a hung animation still resolves through the safety timeout', async () => {
  hung = true;
  try {
    const t = anim();
    const started = Date.now();
    const n = await A.flyCards(t, rect(0, 0), [rect(5, 5)], { rounds: 1, stagger: 0, duration: 20 });
    assert.equal(n, 1);
    assert.ok(Date.now() - started < 1000);
    assert.equal(countEl(t), 0);
  } finally { hung = false; }
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ok   ' + name); }
    catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); }
  }
  if (failed) { console.log(failed + ' anim test(s) failed'); process.exit(1); }
  console.log('anim tests passed (' + tests.length + ')');
})();
