'use strict';
// Unit tests for public/sound.js (PokerSound) with a mock Web Audio API and a mock localStorage.
// No real audio is produced: this checks volume persistence, clamping, throttling, voice cap and no-throw paths.
const assert = require('node:assert/strict');
const path = require('path');

const MODULE = path.join(__dirname, '..', 'public', 'sound.js');

let store = {};
let created = 0;
let starts = 0;
let storageThrows = false;
let audioMissing = false;
let ctorThrows = false;

function mockAudio() {
  class Param { constructor() { this.value = 0; } setValueAtTime(v) { this.value = v; return this; } linearRampToValueAtTime(v) { this.value = v; return this; } exponentialRampToValueAtTime(v) { this.value = v; return this; } }
  class Node { constructor() { this.gain = new Param(); this.frequency = new Param(); this.Q = new Param(); } connect() {} start() { starts++; } stop() {} }
  class Ctx {
    constructor() {
      if (ctorThrows) throw new Error('no audio');
      created++;
      this.sampleRate = 8000; this.currentTime = 0; this.state = 'suspended'; this.destination = {};
    }
    createGain() { return new Node(); }
    createBiquadFilter() { return new Node(); }
    createOscillator() { return new Node(); }
    createBufferSource() { return new Node(); }
    createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
    resume() { this.state = 'running'; return Promise.resolve(); }
  }
  return Ctx;
}

function setEnv({ audio = true, hidden = false } = {}) {
  store = {};
  created = 0;
  starts = 0;
  storageThrows = false;
  ctorThrows = false;
  global.localStorage = {
    getItem: (k) => { if (storageThrows) throw new Error('blocked'); return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: (k, v) => { if (storageThrows) throw new Error('blocked'); store[k] = String(v); }
  };
  if (audio) global.AudioContext = mockAudio(); else delete global.AudioContext;
  delete global.webkitAudioContext;
  delete global.window;
  global.document = { hidden: hidden, readyState: 'complete', body: null, addEventListener() {} };
  delete require.cache[require.resolve(MODULE)];
  return require(MODULE);
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let n = 0;
  const ok = (name, fn) => { fn(); n++; console.log('ok - ' + name); };

  // default and persistence
  let S = setEnv();
  ok('default volume is 60 without a stored value', () => assert.equal(S.getVolume(), 60));
  ok('setVolume persists to localStorage poker-trainer:volume', () => {
    S.setVolume(35);
    assert.equal(store['poker-trainer:volume'], '35');
    assert.equal(S.getVolume(), 35);
  });
  ok('a stored value is read back on load (persists across reload)', () => {
    S = setEnv();
    store['poker-trainer:volume'] = '42';
    delete require.cache[require.resolve(MODULE)];
    S = require(MODULE);
    assert.equal(S.getVolume(), 42);
  });
  ok('clamps to 0..100 and rejects junk', () => {
    S.setVolume(250); assert.equal(S.getVolume(), 100);
    S.setVolume(-20); assert.equal(S.getVolume(), 0);
    S.setVolume('abc'); assert.equal(S.getVolume(), 60);
    S.setVolume(33.6); assert.equal(S.getVolume(), 34);
  });
  ok('volume 0 is mute: play() creates no voices', () => {
    S = setEnv();
    S.setVolume(0);
    const before = starts;
    S.play('chips');
    assert.equal(starts, before);
  });

  // no throw without audio or storage
  ok('no throw when AudioContext is missing', () => {
    S = setEnv({ audio: false });
    assert.doesNotThrow(() => { S.play('deal'); S.play('flop'); S.setTurn('hero'); S.dealCards(4, 70); });
  });
  ok('no throw when the AudioContext constructor throws', () => {
    S = setEnv();
    ctorThrows = true;
    assert.doesNotThrow(() => { S.play('chips'); S.unlock(); });
  });
  ok('no throw when localStorage is blocked', () => {
    S = setEnv();
    storageThrows = true;
    assert.doesNotThrow(() => { S.setVolume(20); assert.equal(S.getVolume(), 20); });
  });

  // hidden tab: silent
  ok('never plays while the tab is hidden', () => {
    S = setEnv({ hidden: true });
    S.play('next');
    assert.equal(starts, 0);
  });

  // throttle and voice cap (timers and Date.now real; synchronous bursts land in one window)
  S = setEnv();
  S.unlock();
  await tick(5);
  ok('a synchronous burst of one sound plays once (per-name throttle)', () => {
    const before = starts;
    for (let i = 0; i < 50; i++) S.play('chips');
    // one chips sound = 3 clicks x (1 noise + 2 pings) = 9 sources; 50 calls in one window must not add more than one
    assert.ok(starts - before <= 9, 'started ' + (starts - before));
    assert.ok(starts - before >= 1);
  });
  await tick(200);
  ok('voice cap: many different sounds at once stay within 8 concurrent voices', () => {
    S = setEnv();
    S.unlock();
    const before = starts;
    for (let i = 0; i < 40; i++) S.play(['deal', 'next', 'turn', 'win', 'tick'][i % 5]);
    // each sound is at most a few oscillators/sources; the cap is on claimed voices, so the count stays bounded
    assert.ok(S._state.voices <= 8, 'voices ' + S._state.voices);
    assert.ok(starts - before < 60, 'starts ' + (starts - before));
  });
  await tick(200);
  S = setEnv();
  S.setVolume(60);
  S.unlock();
  const d0 = starts;
  S.dealCards(6, 70);
  ok('scheduled deals are staggered: only the first card sounds at once', () => {
    assert.equal(starts - d0, 1, 'started ' + (starts - d0));
  });
  await tick(400);
  ok('the remaining deal cards follow on their stagger', () => {
    assert.ok(starts - d0 >= 4, 'started ' + (starts - d0));
  });
  ok('turn chime plays once on the hero edge only', () => {
    S = setEnv();
    S.unlock();
    S.setTurn('other');
    const a = starts;
    S.setTurn('hero');
    const b = starts;
    S.setTurn('hero');
    assert.ok(b > a, 'hero edge plays');
    assert.equal(starts, b, 'repeat call does not replay');
  });

  console.log('\n' + n + ' sound tests passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
