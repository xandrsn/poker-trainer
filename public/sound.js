/*
 * PokerSound: synthesized table sounds (Web Audio API, no files, no downloads).
 * Loaded as a plain script (window.PokerSound) or via require() in node tests (module.exports).
 *
 *   PokerSound.getVolume() -> 0..100          default 60, persisted in localStorage 'poker-trainer:volume'
 *   PokerSound.setVolume(v)                    clamps to 0..100; 0 is mute
 *   PokerSound.play(name, delayMs=0)           name: deal | next | flop | chips | win | turn | tick
 *   PokerSound.dealCards(count, staggerMs)     one 'deal' per card, staggered
 *   PokerSound.setTurn('hero' | 'other' | null) body class turn-hero / turn-other; 'turn' chime on hero's edge
 *   PokerSound.observeHand(hand, heroSeat)     multiplayer: sounds from state diffs (deal, board, pot, winners, turn)
 *   PokerSound.unlock()                        creates/resumes the AudioContext (also run on the first gesture)
 *
 * Never throws. Silent when volume is 0, when audio is unavailable, or when the tab is hidden.
 * Voices are capped (MAX_VOICES) and each sound name is throttled (MIN_GAP_MS), so bursts cannot pile up.
 */
(function (global) {
  'use strict';

  var STORE_KEY = 'poker-trainer:volume';
  var DEFAULT_VOLUME = 60;
  var MAX_VOICES = 8;
  var MIN_GAP_MS = 25;

  var root = typeof window !== 'undefined' ? window : (global || {});
  var state = { vol: DEFAULT_VOLUME, ctx: null, master: null, noise: null, voices: 0, lastAt: {}, turn: null, snap: null };

  function noop() {}
  function clamp(v) {
    var n = Number(v);
    if (!isFinite(n)) return DEFAULT_VOLUME;
    return Math.max(0, Math.min(100, Math.round(n)));
  }
  function gainOf(v) { return v <= 0 ? 0 : 0.8 * Math.pow(v / 100, 1.5); }

  function readStored() {
    try {
      var raw = root.localStorage && root.localStorage.getItem(STORE_KEY);
      if (raw != null && raw !== '') return clamp(raw);
    } catch (e) { /* storage blocked: default */ }
    return DEFAULT_VOLUME;
  }
  function writeStored(v) {
    try { if (root.localStorage) root.localStorage.setItem(STORE_KEY, String(v)); } catch (e) { /* storage blocked */ }
  }

  function hidden() {
    try { return !!(root.document && root.document.hidden); } catch (e) { return false; }
  }

  function makeNoise(ctx) {
    var rate = ctx.sampleRate || 44100;
    var len = Math.floor(rate * 0.5);
    var buf = ctx.createBuffer(1, len, rate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  function ensure() {
    if (state.ctx) return state.ctx;
    try {
      var Ctor = root.AudioContext || root.webkitAudioContext;
      if (!Ctor) return null;
      var ctx = new Ctor();
      var master = ctx.createGain();
      master.gain.value = gainOf(state.vol);
      master.connect(ctx.destination);
      state.ctx = ctx;
      state.master = master;
      state.noise = makeNoise(ctx);
    } catch (e) {
      state.ctx = null;
      state.master = null;
    }
    return state.ctx;
  }

  function resume() {
    var c = state.ctx;
    if (!c || c.state !== 'suspended' || typeof c.resume !== 'function') return;
    try { var p = c.resume(); if (p && p.catch) p.catch(noop); } catch (e) { /* ignore */ }
  }

  function unlock() {
    try { ensure(); resume(); } catch (e) { /* never throws */ }
  }

  // A voice is one scheduled source; it is counted until its end time so bursts stay bounded.
  function claim(ms) {
    if (state.voices >= MAX_VOICES) return false;
    state.voices++;
    setTimeout(function () { state.voices = Math.max(0, state.voices - 1); }, Math.max(20, ms + 40));
    return true;
  }

  // noise through a filter with an exponential decay envelope
  function burst(ctx, at, dur, o) {
    if (!claim(dur * 1000)) return;
    var src = ctx.createBufferSource();
    src.buffer = state.noise;
    var f = ctx.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.frequency.value = o.freq;
    f.Q.value = o.q || 1;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(o.gain, at + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f); f.connect(g); g.connect(state.master);
    src.start(at, Math.random() * 0.3);
    src.stop(at + dur + 0.02);
  }

  // short sine ping with a decay envelope
  function ping(ctx, at, freq, dur, gain) {
    if (!claim(dur * 1000)) return;
    var osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(gain, at + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(g); g.connect(state.master);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  function jitter(base, pct) { return base * (1 + (Math.random() * 2 - 1) * pct); }

  // ----- the sounds (all take a context and a start time) -----
  function synthDeal(ctx, t) {
    // soft card slide: a short band-passed noise flick
    burst(ctx, t, 0.08, { freq: jitter(2600, 0.1), q: 0.9, gain: 0.35 });
  }
  function synthNext(ctx, t) {
    // a single card turn: a tiny tap
    burst(ctx, t, 0.035, { freq: jitter(1900, 0.1), q: 2, gain: 0.3 });
    ping(ctx, t, jitter(700, 0.05), 0.025, 0.04);
  }
  function synthChip(ctx, t, spacing, count) {
    // clack: layered noise + two sine pings with slight random pitch
    for (var k = 0; k < count; k++) {
      var at = t + k * spacing;
      burst(ctx, at, 0.04, { type: 'highpass', freq: jitter(3200, 0.08), q: 0.7, gain: 0.3 });
      ping(ctx, at, jitter(2600, 0.06), 0.06, 0.1);
      ping(ctx, at, jitter(3900, 0.06), 0.035, 0.05);
    }
  }
  function synthTurn(ctx, t) {
    // very soft two-note chime
    ping(ctx, t, 880, 0.18, 0.035);
    ping(ctx, t + 0.07, 1320, 0.2, 0.025);
  }

  var SYNTH = {
    deal: function (ctx, t) { synthDeal(ctx, t); },
    next: function (ctx, t) { synthNext(ctx, t); },
    chips: function (ctx, t) { synthChip(ctx, t, 0.018, 3); },
    win: function (ctx, t) { synthChip(ctx, t, 0.07, 8); },
    turn: function (ctx, t) { synthTurn(ctx, t); },
    tick: function (ctx, t) { synthChip(ctx, t, 0.01, 1); }
  };

  function emit(name) {
    if (!SYNTH[name]) return;
    var now = Date.now();
    var last = state.lastAt[name] || 0;
    if (now - last < MIN_GAP_MS) return;
    state.lastAt[name] = now;
    if (state.vol <= 0 || hidden()) return;
    var ctx = ensure();
    if (!ctx || !state.master || !state.noise) return;
    resume();
    try { SYNTH[name](ctx, ctx.currentTime + 0.005); } catch (e) { /* audio failure is silent */ }
  }

  function play(name, delayMs) {
    try {
      var d = Math.max(0, Number(delayMs) || 0);
      if (name === 'flop') {
        play('next', d); play('next', d + 110); play('next', d + 220);
        return;
      }
      if (state.vol <= 0) return;
      if (d > 0) setTimeout(function () { emit(name); }, d);
      else emit(name);
    } catch (e) { /* never throws */ }
  }

  function dealCards(count, staggerMs) {
    var n = Math.max(0, Math.min(24, Math.floor(Number(count) || 0)));
    var step = Math.max(20, Number(staggerMs) || 70);
    for (var i = 0; i < n; i++) play('deal', i * step);
  }

  function setVolume(v) {
    state.vol = clamp(v);
    writeStored(state.vol);
    try { if (state.master) state.master.gain.value = gainOf(state.vol); } catch (e) { /* ignore */ }
    if (state.vol > 0) unlock();
    return state.vol;
  }
  function getVolume() { return state.vol; }

  function setTurn(who) {
    var next = who === 'hero' || who === 'other' ? who : null;
    var prev = state.turn;
    state.turn = next;
    try {
      var cl = root.document && root.document.body && root.document.body.classList;
      if (cl) {
        cl.toggle('turn-hero', next === 'hero');
        cl.toggle('turn-other', next === 'other');
      }
    } catch (e) { /* no DOM */ }
    if (next === 'hero' && prev !== 'hero') play('turn');
  }

  // Multiplayer: derive sounds from the difference between two state snapshots.
  function observeHand(h, me) {
    if (!h) { setTurn(null); return; } // between hands: keep the snapshot so the next new hand still deals
    var board = Array.isArray(h.board) ? h.board.length : 0;
    var pot = Number(h.pot) || 0;
    var winners = Array.isArray(h.winners) ? h.winners.length : 0;
    var seats = Array.isArray(h.seats) ? h.seats.length : 0;
    var prev = state.snap;
    var mine = h.toAct != null && h.toAct === me && !h.over;
    if (prev && prev.id === h.id) {
      var fresh = Math.max(0, board - prev.board);
      if (fresh === 3) play('flop', 0);
      else for (var k = 0; k < fresh; k++) play('next', k * 110);
      if (pot > prev.pot) play('chips', 0);
      if (winners && !prev.winners) play('win', 150);
    } else if (prev) {
      // a new hand: the cards go out to every seat, two each
      dealCards(seats * 2, 70);
    }
    state.snap = { id: h.id, board: board, pot: pot, winners: winners };
    setTurn(mine ? 'hero' : (h.toAct != null && !h.over ? 'other' : null));
  }

  // Preview click for the volume slider(s), debounced so dragging does not spam.
  var previewTimer = null;
  function preview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(function () { play('tick', 0); }, 150);
  }

  // Volume sliders ([data-sound-volume]) may be rendered later (multiplayer dialog): one delegated listener,
  // and syncControls() pushes the stored value into every slider and readout.
  function syncControls() {
    try {
      var doc = root.document;
      if (!doc || !doc.querySelectorAll) return;
      var v = state.vol;
      Array.prototype.forEach.call(doc.querySelectorAll('input[data-sound-volume]'), function (inp) {
        inp.value = String(v);
        inp.setAttribute('aria-valuetext', v === 0 ? 'off' : v + '%');
      });
      Array.prototype.forEach.call(doc.querySelectorAll('[data-sound-volume-out]'), function (out) {
        out.textContent = String(v);
      });
    } catch (e) { /* no DOM */ }
  }

  function onSliderInput(ev) {
    var t = ev && ev.target;
    if (!t || !t.hasAttribute || !t.hasAttribute('data-sound-volume')) return;
    setVolume(t.value);
    syncControls();
    preview();
  }

  function bindControls() {
    try {
      var doc = root.document;
      if (!doc || !doc.addEventListener) return;
      if (!state.bound) {
        state.bound = true;
        doc.addEventListener('input', onSliderInput);
        var gesture = function () { unlock(); };
        doc.addEventListener('pointerdown', gesture, { passive: true });
        doc.addEventListener('keydown', gesture);
      }
      syncControls();
    } catch (e) { /* no DOM: nothing to bind */ }
  }

  state.vol = readStored();
  if (root.document && root.document.addEventListener) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', bindControls);
    else bindControls();
  }

  var api = {
    getVolume: getVolume,
    setVolume: setVolume,
    play: play,
    dealCards: dealCards,
    setTurn: setTurn,
    observeHand: observeHand,
    syncControls: syncControls,
    bindControls: bindControls,
    unlock: unlock,
    _state: state
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.PokerSound = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
