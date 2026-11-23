'use strict';
// Tests for public/stats.js (pure progress aggregation).
const assert = require('assert');
const S = require('../public/stats.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.error('FAIL ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
const dec = (t, score, extra) => Object.assign({ t, mode: 'practice', format: 'quick', position: 'BTN', street: 'preflop', players: 6, score }, extra || {});

test('averageScore rounds to one decimal and is null when empty', () => {
  assert.strictEqual(S.averageScore([]), null);
  assert.strictEqual(S.averageScore([dec(1, 100), dec(2, 50), dec(3, 80)]), 76.7);
});

test('filterBy keeps practice and exam records apart', () => {
  const list = [dec(1, 100, { mode: 'practice' }), dec(2, 0, { mode: 'exam' })];
  assert.strictEqual(S.filterBy(list, 'practice').length, 1);
  assert.strictEqual(S.filterBy(list, 'exam')[0].score, 0);
  assert.strictEqual(S.filterBy(list, 'all').length, 2);
});

test('trend compares the last 10 sessions with the 10 before', () => {
  const sessions = [];
  for (let i = 0; i < 10; i++) sessions.push({ t: i, avg: 50 });
  for (let i = 10; i < 20; i++) sessions.push({ t: i, avg: 70 });
  const tr = S.trend(sessions);
  assert.strictEqual(tr.current, 70);
  assert.strictEqual(tr.previous, 50);
  assert.strictEqual(tr.delta, 20);
  assert.strictEqual(tr.direction, 'up');
});

test('trend has no direction without 11+ sessions', () => {
  const tr = S.trend([{ t: 1, avg: 60 }]);
  assert.strictEqual(tr.delta, null);
  assert.strictEqual(tr.direction, null);
});

test('trend reports down and flat', () => {
  const down = []; for (let i = 0; i < 20; i++) down.push({ t: i, avg: i < 10 ? 80 : 60 });
  assert.strictEqual(S.trend(down).direction, 'down');
  const flat = []; for (let i = 0; i < 20; i++) flat.push({ t: i, avg: 60 });
  assert.strictEqual(S.trend(flat).direction, 'flat');
});

test('chartSeries keeps only the last 100 decisions and computes a moving average', () => {
  const ds = [];
  for (let i = 0; i < 150; i++) ds.push(dec(i, i < 100 ? 0 : 100));
  const c = S.chartSeries(ds, [], { last: 100, win: 10 });
  assert.strictEqual(c.n, 100);
  assert.strictEqual(c.points.length, 100);
  assert.strictEqual(c.points[0].y, 0);
  assert.strictEqual(c.points[99].y, 100);
});

test('chartSeries marks sessions as ticks at the first decision of each session', () => {
  const ds = [dec(10, 50), dec(20, 60), dec(30, 70), dec(40, 80)];
  const c = S.chartSeries(ds, [{ t: 15, avg: 0 }, { t: 35, avg: 0 }], { last: 100, win: 2 });
  assert.deepStrictEqual(c.ticks, [1, 3]);
});

test('breakdown groups by key with counts and averages', () => {
  const b = S.breakdown([dec(1, 100, { position: 'BTN' }), dec(2, 60, { position: 'BTN' }), dec(3, 20, { position: 'UTG' })], 'position');
  assert.deepStrictEqual(b.BTN, { n: 2, avg: 80 });
  assert.deepStrictEqual(b.UTG, { n: 1, avg: 20 });
});

test('bestStreak counts consecutive best/good ratings in time order', () => {
  const ds = [dec(3, 80), dec(1, 90), dec(2, 75), dec(4, 10), dec(5, 100), dec(6, 100), dec(7, 100)];
  assert.strictEqual(S.bestStreak(ds), 3);
});

test('weakest needs enough samples and picks the lowest group', () => {
  const ds = [];
  for (let i = 0; i < 5; i++) ds.push(dec(i, 90, { position: 'BTN' }));
  for (let i = 0; i < 5; i++) ds.push(dec(10 + i, 30, { position: 'UTG' }));
  for (let i = 0; i < 3; i++) ds.push(dec(20 + i, 0, { position: 'SB' })); // too few samples
  const w = S.weakest(ds, 5);
  assert.strictEqual(w.dim, 'position');
  assert.strictEqual(w.key, 'UTG');
  assert.strictEqual(w.avg, 30);
});

test('weakest is null with too few decisions', () => {
  assert.strictEqual(S.weakest([dec(1, 10)], 5), null);
});

test('summary combines the pieces for one filter', () => {
  const store = {
    decisions: [dec(1, 80, { mode: 'practice' }), dec(2, 40, { mode: 'exam' })],
    sessions: [{ t: 1, mode: 'practice', avg: 80 }],
    hands: [{ t: 1, mode: 'practice', net: 2 }, { t: 2, mode: 'exam', net: -1 }]
  };
  const p = S.summary(store, 'practice');
  assert.strictEqual(p.decisions, 1);
  assert.strictEqual(p.average, 80);
  assert.strictEqual(p.handsPlayed, 1);
  const a = S.summary(store, 'all');
  assert.strictEqual(a.decisions, 2);
  assert.strictEqual(a.average, 60);
  assert.strictEqual(a.handsPlayed, 2);
});

console.log(passed + ' stats tests passed');
