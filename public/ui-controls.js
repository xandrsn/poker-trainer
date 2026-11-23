/* ui-controls.js: every input[type=range] gets the .ui-range class and a --p custom property (the filled share of the
 * track, in %). ui-controls.css draws the track and thumb from it. Covers ranges already in the page, ranges created
 * later (MutationObserver) and value changes made in code (a short poll on the few ranges, no events needed). */
(function () {
  'use strict';
  var SEL = 'input[type="range"]';

  function sync(inp) {
    var min = parseFloat(inp.min); var max = parseFloat(inp.max);
    if (isNaN(min)) min = 0;
    if (isNaN(max)) max = 100;
    var v = parseFloat(inp.value);
    var p = max > min && !isNaN(v) ? ((v - min) / (max - min)) * 100 : 0;
    p = Math.max(0, Math.min(100, p));
    var s = p.toFixed(2) + '%';
    if (inp.style.getPropertyValue('--p') !== s) inp.style.setProperty('--p', s);
  }
  function enhance(inp) {
    if (!inp || inp.nodeType !== 1 || inp.type !== 'range') return;
    inp.classList.add('ui-range');
    sync(inp);
  }
  function enhanceAll(root) {
    if (!root || !root.querySelectorAll) return;
    if (root.matches && root.matches(SEL)) enhance(root);
    Array.prototype.forEach.call(root.querySelectorAll(SEL), enhance);
  }

  function boot() {
    enhanceAll(document);
    // delegated: input/change from any range, anywhere
    ['input', 'change'].forEach(function (ev) {
      document.addEventListener(ev, function (e) { if (e.target && e.target.type === 'range') sync(e.target); }, true);
    });
    if (window.MutationObserver) {
      new MutationObserver(function (list) {
        list.forEach(function (m) {
          Array.prototype.forEach.call(m.addedNodes, function (n) { if (n.nodeType === 1) enhanceAll(n); });
          if (m.type === 'attributes' && m.target.type === 'range') enhance(m.target);
        });
      }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['min', 'max'] });
    }
    // values set in code do not fire 'input': re-sync the ranges a few times a second (there are only a handful)
    setInterval(function () {
      Array.prototype.forEach.call(document.querySelectorAll('input.ui-range'), sync);
    }, 250);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})();
