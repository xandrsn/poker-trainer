/*
 * PokerAnim: dependency-free table animations (deal, flip, chip flights, count-up, glow, labels).
 * Loaded as a plain script (exposes window.PokerAnim) or via require() in node tests (module.exports).
 * Styles live in public/anim.css. Only transform and opacity are animated (Web Animations API; fill 'both' so delayed pieces stay hidden until they start).
 *
 * API (all functions are safe to call with missing nodes: they resolve without throwing)
 *   PokerAnim.enabled() -> boolean
 *       false under prefers-reduced-motion and when document.hidden. Disabled functions resolve at once and
 *       do no DOM work: the caller renders the final state itself.
 *   PokerAnim.layer(container) -> HTMLElement | null
 *       Returns the div.anim-layer inside `container` (creates it once). Absolute, inset 0, pointer-events none.
 *   PokerAnim.rectIn(container, el) -> {x, y, width, height, left, top, right, bottom} | null
 *       Rect of `el` relative to `container`. One batch of getBoundingClientRect reads per call.
 *   PokerAnim.flyCards(container, fromRect, toRects[], {rounds=2, stagger=70, duration=380, back=true})
 *       -> Promise<number>  Face-down cards from fromRect (null = centre of container, near the pot) to each
 *       target, `rounds` cards per target. Each target rect may also be an element. Resolves with the number
 *       of cards flown when the last one lands; all elements are removed.
 *   PokerAnim.flipReveal(el, {delay=0, duration=260, lift=0, onMid})  -> Promise
 *       Face-down -> face-up rotateY flip. onMid(el) swaps the face at the midpoint (default: on a .anim-card
 *       toggles class back -> face). Array form = flop: flipReveal([c1, c2, c3], {stagger=120, lift=6}).
 *   PokerAnim.flyChips(fromRects[], toRect, {container, count, amounts, bb=1, duration=420, stagger=35})
 *       -> Promise<number>  Chip discs fly from each source to toRect. Chips per source: `count` (number) if
 *       given, else chipCount(amounts[i], bb). Resolves with the number of chips flown.
 *   PokerAnim.potToWinners(potRect, [{rect, amount}], {container, bb=1, duration=620, stagger=90, arc=36})
 *       -> Promise<number>  Splits the pot into chip flights with a small arc to each winner. Side pots:
 *       call again with the side-pot winners.
 *   PokerAnim.chipCount(amount, bb=1) -> integer 0..5   0 for amount <= 0; then 1 + floor(log2(amount/bb)).
 *   PokerAnim.countUp(el, from, to, ms, fmt) -> Promise  Number animation for a pot pill; the final text is
 *       fmt(to) exactly. fmt defaults to rounding to an integer.
 *   PokerAnim.glow(el, ms=1200) -> Promise  Winner halo: an overlay in the element's offsetParent, removed after ms.
 *   PokerAnim.floatLabel(rect, text, {container, cls, ms=950}) -> Promise  Text (e.g. "+12 BB") floating up and
 *       fading from the top-centre of rect (rect relative to container, or an element).
 *   PokerAnim.clear(container?) -> void  Cancels and removes everything now (one container, or all). Idempotent.
 *   PokerAnim.MAX_ELEMENTS = 60  Cap on concurrent .anim-el elements; extra spawns are skipped.
 */
(function (root) {
  'use strict';

  var MAX_ELEMENTS = 60;
  var MAX_CHIPS_PER_SOURCE = 5;
  var CARD_W = 18, CARD_H = 25.2;      // matches .anim-card (5:7)
  var CHIP = 14;                       // matches .anim-chip

  var live = new Set();                // every spawned .anim-el still in the DOM (or about to be)
  var running = new Map();             // el -> [Animation]

  function g() { return typeof globalThis !== 'undefined' ? globalThis : root; }
  function doc() { return g().document || null; }
  function now() {
    var p = g().performance;
    return p && typeof p.now === 'function' ? p.now() : Date.now();
  }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function px(v) { return (Math.round(v * 100) / 100) + 'px'; }
  function T(x, y) { return 'translate(' + px(x) + ',' + px(y) + ')'; }
  function resolved(v) { return Promise.resolve(v); }

  function enabled() {
    var d = doc(), w = g().window;
    if (d && d.hidden) return false;
    if (w && typeof w.matchMedia === 'function') {
      var mq = w.matchMedia('(prefers-reduced-motion: reduce)');
      if (mq && mq.matches) return false;
    }
    return true;
  }

  function hasClass(el, c) {
    if (!el) return false;
    if (el.classList && typeof el.classList.contains === 'function') return el.classList.contains(c);
    return (' ' + (el.className || '') + ' ').indexOf(' ' + c + ' ') >= 0;
  }

  // Layer: one absolute overlay per container.
  function layer(container) {
    var d = doc();
    if (!container || !d || typeof container.appendChild !== 'function') return null;
    var kids = container.children || [];
    for (var i = 0; i < kids.length; i++) {
      if (hasClass(kids[i], 'anim-layer')) return kids[i];
    }
    var l = d.createElement('div');
    l.className = 'anim-layer';
    container.appendChild(l);
    return l;
  }

  function rectIn(container, el) {
    if (!container || !el || typeof el.getBoundingClientRect !== 'function' ||
        typeof container.getBoundingClientRect !== 'function') return null;
    var cr = container.getBoundingClientRect();
    var r = el.getBoundingClientRect();
    var x = r.left - cr.left, y = r.top - cr.top;
    return { x: x, y: y, width: r.width, height: r.height, left: x, top: y, right: x + r.width, bottom: y + r.height };
  }

  // Accepts a rect {x,y,width,height} (or {left,top,w,h}) or an element; returns a normalised rect or null.
  function normRect(r, container) {
    if (!r) return null;
    if (typeof r.getBoundingClientRect === 'function') return rectIn(container, r);
    var x = num(r.x != null ? r.x : r.left), y = num(r.y != null ? r.y : r.top);
    var w = num(r.width != null ? r.width : r.w), h = num(r.height != null ? r.height : r.h);
    if (x === null || y === null) return null;
    return { x: x, y: y, width: w || 0, height: h || 0 };
  }
  function centre(r) { return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }

  // Spawn an .anim-el under parent, respecting the global cap. Returns null when full or no DOM.
  function spawn(parent, cls) {
    var d = doc();
    if (!parent || !d || live.size >= MAX_ELEMENTS) return null;
    var el = d.createElement('div');
    el.className = 'anim-el ' + cls;
    parent.appendChild(el);
    live.add(el);
    return el;
  }

  function drop(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    if (el) { live.delete(el); running.delete(el); }
  }

  // Runs one animation on el; resolves when it finishes or is cancelled (or after a safety timeout).
  // removeAfter drops el from the DOM when done.
  function play(el, frames, opts, removeAfter) {
    function finishNow() { if (removeAfter) drop(el); return undefined; }
    if (!el || typeof el.animate !== 'function') { finishNow(); return resolved(); }
    var a;
    try { a = el.animate(frames, Object.assign({ fill: 'both' }, opts)); } catch (e) { finishNow(); return resolved(); }
    if (!a) { finishNow(); return resolved(); }
    var list = running.get(el) || [];
    list.push(a);
    running.set(el, list);
    var safety = (opts.delay || 0) + (opts.duration || 0) + 250;
    return new Promise(function (res) {
      var done = false, timer = null;
      function end() {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        var l = running.get(el);
        if (l) {
          var i = l.indexOf(a);
          if (i >= 0) l.splice(i, 1);
          if (!l.length) running.delete(el);
        }
        finishNow();
        res();
      }
      timer = setTimeout(end, safety);
      try { if (a.finished && a.finished.then) a.finished.then(end, end); } catch (e) { /* safety timer resolves */ }
    });
  }

  function dropAll(list) {
    return Promise.all(list);
  }

  // ---------- cards ----------
  function flyCards(container, fromRect, toRects, opts) {
    opts = opts || {};
    if (!enabled() || !container || !toRects || !toRects.length || !doc()) return resolved(0);
    var rounds = opts.rounds != null ? opts.rounds : 2;
    var stagger = opts.stagger != null ? opts.stagger : 90;
    var duration = opts.duration != null ? opts.duration : 380;
    var back = opts.back !== false;

    // reads first (no writes until the layer exists)
    var cw = container.clientWidth || 0, ch = container.clientHeight || 0;
    var from = normRect(fromRect, container) ||
      { x: cw / 2 - CARD_W / 2, y: ch / 2 - CARD_H / 2, width: CARD_W, height: CARD_H };
    var c0 = centre(from);
    var targets = [];
    for (var t = 0; t < toRects.length; t++) {
      var tr = normRect(toRects[t], container);
      if (tr) {
        var tc = centre(tr);
        var sc = tr.width ? Math.min(1.2, Math.max(0.4, tr.width / CARD_W)) : 1;
        targets.push({ x: tc.x - CARD_W / 2, y: tc.y - CARD_H / 2, s: sc });
      }
    }
    if (!targets.length) return resolved(0);

    var lay = layer(container);
    var waits = [], flown = 0;
    var n = targets.length;
    for (var r = 0; r < rounds; r++) {
      for (var i = 0; i < n; i++) {
        var card = spawn(lay, 'anim-card ' + (back ? 'back' : 'face'));
        if (!card) continue;
        var idx = r * n + i, delay = idx * stagger, tg = targets[i];
        var sx = c0.x - CARD_W / 2, sy = c0.y - CARD_H / 2;
        waits.push(play(card, [
          { transform: T(sx, sy) + ' scale(0.8)', opacity: 0 },
          { opacity: 1, offset: 0.15 },
          { transform: T(tg.x, tg.y) + ' scale(' + tg.s + ')', opacity: 1 }
        ], { duration: duration, delay: delay, easing: 'cubic-bezier(.2,.7,.3,1)' }, true));
        flown++;
      }
    }
    return dropAll(waits).then(function () { return flown; });
  }

  function flipOne(el, o) {
    var half = Math.max(1, o.duration / 2);
    var lift = o.lift || 0;
    var swap = o.onMid || defaultSwap;
    return play(el, [
      { transform: 'perspective(600px) translateY(0px) rotateY(0deg)' },
      { transform: 'perspective(600px) translateY(' + px(-lift) + ') rotateY(90deg)' }
    ], { duration: half, delay: o.delay, easing: 'ease-in', fill: 'none' }, false).then(function () {
      try { swap(el); } catch (e) { /* swap is caller code; never break the flip */ }
      return play(el, [
        { transform: 'perspective(600px) translateY(' + px(-lift) + ') rotateY(90deg)' },
        { transform: 'perspective(600px) translateY(0px) rotateY(0deg)' }
      ], { duration: half, easing: 'ease-out', fill: 'none' }, false);
    });
  }
  function defaultSwap(el) {
    if (!el || !el.classList || !hasClass(el, 'anim-card')) return;
    el.classList.remove('back');
    el.classList.add('face');
  }

  function flipReveal(el, opts) {
    opts = opts || {};
    if (!enabled()) return resolved();
    var base = { delay: opts.delay || 0, duration: opts.duration != null ? opts.duration : 260, lift: opts.lift, onMid: opts.onMid };
    if (Array.isArray(el)) {
      var stagger = opts.stagger != null ? opts.stagger : 120;
      var lift = opts.lift != null ? opts.lift : 6;
      return dropAll(el.map(function (e, i) {
        return flipOne(e, { delay: base.delay + i * stagger, duration: base.duration, lift: lift, onMid: base.onMid });
      })).then(function () { return undefined; });
    }
    if (!el) return resolved();
    return flipOne(el, base);
  }

  // ---------- chips ----------
  function chipCount(amount, bb) {
    var a = num(amount), b = num(bb) || 1;
    if (a === null || a <= 0) return 0;
    var units = Math.max(1, a / b);
    return Math.min(MAX_CHIPS_PER_SOURCE, 1 + Math.floor(Math.log(units) / Math.LN2 + 1e-9));
  }

  function chipFrames(p0, p1, arc) {
    var fr = [{ transform: T(p0.x - CHIP / 2, p0.y - CHIP / 2) }];
    if (arc) {
      fr.push({ transform: T((p0.x + p1.x) / 2 - CHIP / 2, (p0.y + p1.y) / 2 - arc - CHIP / 2), offset: 0.5 });
    }
    fr.push({ transform: T(p1.x - CHIP / 2, p1.y - CHIP / 2) });
    return fr;
  }

  function flyChips(fromRects, toRect, opts) {
    opts = opts || {};
    if (!enabled() || !opts.container || !fromRects || !fromRects.length || !doc()) return resolved(0);
    var duration = opts.duration != null ? opts.duration : 420;
    var stagger = opts.stagger != null ? opts.stagger : 35;
    var container = opts.container;
    var to = normRect(toRect, container);
    if (!to) return resolved(0);
    var tc = centre(to);
    var plan = [];
    for (var s = 0; s < fromRects.length; s++) {
      var fr = normRect(fromRects[s], container);
      if (!fr) continue;
      var n;
      if (opts.count != null) n = Math.max(0, Math.floor(num(opts.count) || 0));
      else if (opts.amounts) n = chipCount(opts.amounts[s], opts.bb);
      else n = 3;
      if (n > 0) plan.push({ c: centre(fr), n: n });
    }
    if (!plan.length) return resolved(0);
    var lay = layer(container);
    var waits = [], flown = 0, idx = 0;
    plan.forEach(function (src) {
      for (var k = 0; k < src.n; k++) {
        var chip = spawn(lay, 'anim-chip');
        if (!chip) return;
        var p0 = { x: src.c.x + ((k % 3) - 1) * 2, y: src.c.y - k * 2 };
        var p1 = { x: tc.x + ((k % 3) - 1) * 2, y: tc.y - k * 2 };
        waits.push(play(chip, chipFrames(p0, p1, 0), {
          duration: duration, delay: idx * stagger, easing: 'cubic-bezier(.4,0,.2,1)'
        }, true));
        flown++; idx++;
      }
    });
    return dropAll(waits).then(function () { return flown; });
  }

  function potToWinners(potRect, winners, opts) {
    opts = opts || {};
    if (!enabled() || !opts.container || !winners || !winners.length || !doc()) return resolved(0);
    var container = opts.container;
    var duration = opts.duration != null ? opts.duration : 620;
    var stagger = opts.stagger != null ? opts.stagger : 90;
    var arc = opts.arc != null ? opts.arc : 36;
    var pot = normRect(potRect, container);
    if (!pot) return resolved(0);
    var p0 = centre(pot);
    var plan = [];
    for (var w = 0; w < winners.length; w++) {
      var wr = winners[w] && normRect(winners[w].rect, container);
      if (!wr) continue;
      var n = chipCount(winners[w].amount, opts.bb);
      if (n > 0) plan.push({ p1: centre(wr), n: n });
    }
    if (!plan.length) return resolved(0);
    var lay = layer(container);
    var waits = [], flown = 0, idx = 0;
    plan.forEach(function (dst) {
      for (var k = 0; k < dst.n; k++) {
        var chip = spawn(lay, 'anim-chip');
        if (!chip) return;
        var end = { x: dst.p1.x + ((k % 3) - 1) * 2, y: dst.p1.y - k * 2 };
        waits.push(play(chip, chipFrames({ x: p0.x + ((k % 3) - 1) * 2, y: p0.y - k * 2 }, end, arc), {
          duration: duration, delay: idx * stagger, easing: 'ease-in-out'
        }, true));
        flown++; idx++;
      }
    });
    return dropAll(waits).then(function () { return flown; });
  }

  // ---------- numbers, halos, labels ----------
  function countUp(el, from, to, ms, fmt) {
    var f = typeof fmt === 'function' ? fmt : function (v) { return String(Math.round(v)); };
    if (!el || !enabled()) return resolved();
    var a = num(from) === null ? 0 : from, b = num(to) === null ? 0 : to;
    var dur = num(ms) && ms > 0 ? ms : 0;
    if (!dur) { el.textContent = f(b); return resolved(); }
    var token = {};
    el.__animCount = token;
    var t0 = now();
    var raf = g().requestAnimationFrame;
    return new Promise(function (res) {
      var finished = false, safety = null;
      function finish() {
        if (finished) return;
        finished = true;
        if (safety) clearTimeout(safety);
        if (el.__animCount === token) { el.textContent = f(b); el.__animCount = null; }
        res();
      }
      function step() {
        if (finished) return;
        if (el.__animCount !== token) { finished = true; if (safety) clearTimeout(safety); return res(); }
        var t = Math.min(1, (now() - t0) / dur);
        if (t >= 1) return finish();
        var e = 1 - Math.pow(1 - t, 3);
        el.textContent = f(a + (b - a) * e);
        if (typeof raf === 'function') raf.call(g(), step); else setTimeout(step, 16);
      }
      safety = setTimeout(finish, dur + 200);
      step();
    });
  }

  function glow(el, ms) {
    var dur = num(ms) && ms > 0 ? ms : 1200;
    if (!el || !enabled()) return resolved();
    var container = el.offsetParent || el.parentNode;
    var r = rectIn(container, el);
    if (!r) return resolved();
    var lay = layer(container);
    var h = spawn(lay, 'anim-halo');
    if (!h) return resolved();
    h.style.width = px(r.width);
    h.style.height = px(r.height);
    return play(h, [
      { transform: T(r.x, r.y) + ' scale(1.04)', opacity: 0 },
      { transform: T(r.x, r.y) + ' scale(1)', opacity: 1, offset: 0.25 },
      { transform: T(r.x, r.y) + ' scale(1.08)', opacity: 0 }
    ], { duration: dur, easing: 'ease-in-out' }, true);
  }

  function floatLabel(rect, text, opts) {
    opts = opts || {};
    if (!enabled() || !opts.container || !doc()) return resolved();
    var container = opts.container;
    var r = normRect(rect, container);
    if (!r) return resolved();
    var lay = layer(container);
    var label = spawn(lay, 'anim-label' + (opts.cls ? ' ' + opts.cls : ''));
    if (!label) return resolved();
    label.textContent = String(text == null ? '' : text);
    var x = r.x + r.width / 2, y = r.y;
    var dur = opts.ms != null ? opts.ms : 950;
    return play(label, [
      { transform: 'translate(-50%,-50%) ' + T(x, y), opacity: 0 },
      { opacity: 1, offset: 0.2 },
      { transform: 'translate(-50%,-50%) ' + T(x, y - 28), opacity: 0 }
    ], { duration: dur, easing: 'ease-out' }, true);
  }

  // ---------- cleanup ----------
  function inside(el, container) {
    var p = el && el.parentNode;
    while (p) { if (p === container) return true; p = p.parentNode; }
    return false;
  }

  function clear(container) {
    running.forEach(function (list, el) {
      if (container && !inside(el, container)) return;
      list.slice().forEach(function (a) { try { a.cancel(); } catch (e) { /* already done */ } });
    });
    Array.from(live).forEach(function (el) {
      if (!container || inside(el, container)) drop(el);
    });
    if (container && container.children) {
      var kids = Array.prototype.slice.call(container.children);
      kids.forEach(function (k) {
        if (hasClass(k, 'anim-layer') && typeof container.removeChild === 'function') container.removeChild(k);
      });
    }
  }

  var PokerAnim = {
    MAX_ELEMENTS: MAX_ELEMENTS,
    enabled: enabled,
    layer: layer,
    rectIn: rectIn,
    flyCards: flyCards,
    flipReveal: flipReveal,
    flyChips: flyChips,
    potToWinners: potToWinners,
    chipCount: chipCount,
    countUp: countUp,
    glow: glow,
    floatLabel: floatLabel,
    clear: clear
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PokerAnim;
  if (root && typeof root === 'object') root.PokerAnim = PokerAnim;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
