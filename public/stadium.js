/* stadium.js: the racetrack outline of the table (two straight sides, two half-circle ends).
 * window.PokerStadium.shape(cx, cy, rx, ry) returns the outline through the seat centres: a horizontal stadium when
 * rx >= ry (the usual table), a vertical one otherwise (tall phone screens). The two ends are half circles of radius
 * min(rx, ry); the straight sides are as long as the rest. at(shape, f) gives the point at arc-length fraction f
 * (0 = bottom centre, then clockwise on screen: left, top, right). Seats are spaced evenly by arc length along it. */
(function () {
  'use strict';
  function shape(cx, cy, rx, ry) {
    var horiz = rx >= ry;
    var r = horiz ? ry : rx;
    var hs = Math.max(0, (horiz ? rx : ry) - r);
    var segs;
    if (horiz) {
      segs = [
        { line: true, x0: cx, y0: cy + r, x1: cx - hs, y1: cy + r },
        { cx: cx - hs, cy: cy, a0: Math.PI / 2, a1: 3 * Math.PI / 2 },
        { line: true, x0: cx - hs, y0: cy - r, x1: cx + hs, y1: cy - r },
        { cx: cx + hs, cy: cy, a0: 3 * Math.PI / 2, a1: 5 * Math.PI / 2 },
        { line: true, x0: cx + hs, y0: cy + r, x1: cx, y1: cy + r }
      ];
    } else {
      segs = [
        { cx: cx, cy: cy + hs, a0: Math.PI / 2, a1: Math.PI },
        { line: true, x0: cx - r, y0: cy + hs, x1: cx - r, y1: cy - hs },
        { cx: cx, cy: cy - hs, a0: Math.PI, a1: 2 * Math.PI },
        { line: true, x0: cx + r, y0: cy - hs, x1: cx + r, y1: cy + hs },
        { cx: cx, cy: cy + hs, a0: 0, a1: Math.PI / 2 }
      ];
    }
    var total = 0;
    segs.forEach(function (s) {
      s.len = s.line ? Math.hypot(s.x1 - s.x0, s.y1 - s.y0) : r * Math.abs(s.a1 - s.a0);
      total += s.len;
    });
    return { segs: segs, total: total, r: r };
  }
  function at(sh, f) {
    var d = ((f % 1) + 1) % 1 * sh.total;
    for (var i = 0; i < sh.segs.length; i++) {
      var s = sh.segs[i];
      if (d <= s.len || i === sh.segs.length - 1) {
        var t = s.len ? Math.min(1, d / s.len) : 0;
        if (s.line) return { x: s.x0 + (s.x1 - s.x0) * t, y: s.y0 + (s.y1 - s.y0) * t };
        var a = s.a0 + (s.a1 - s.a0) * t;
        return { x: s.cx + sh.r * Math.cos(a), y: s.cy + sh.r * Math.sin(a) };
      }
      d -= s.len;
    }
    return { x: 0, y: 0 };
  }
  if (typeof window !== 'undefined') window.PokerStadium = { shape: shape, at: at };
  if (typeof module !== 'undefined' && module.exports) module.exports = { shape: shape, at: at };
})();
