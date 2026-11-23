/* Main menu hub: two main tiles (Play, Practice). The active one reveals its options beside it
   (wide screens) or below it (narrow screens). Motion uses transform and opacity only: a FLIP step
   moves the other tiles smoothly when a group opens or closes. Reduced motion: instant.
   Multiplayer is an option of Play: it opens the Multiplayer screen (mp-rooms.js), not a sub-menu. */
(function () {
  'use strict';
  var root = document.getElementById('menu-format');
  if (!root) return;
  var groups = Array.prototype.slice.call(root.querySelectorAll('.hub-group'));
  var reduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var MOVE_MS = 260;
  var active = null; // name of the open group ('play' or 'practice'), or null

  function motionOK() { return !(reduced && reduced.matches); }
  function mainOf(g) { return g.querySelector('.hub-main'); }
  function optsOf(g) { return g.querySelector('.hub-opts'); }
  function lefts() { return groups.map(function (g) { return g.getBoundingClientRect().left; }); }

  // Stagger index for the reveal (40 ms apart), read by the CSS animation.
  groups.forEach(function (g) {
    Array.prototype.forEach.call(optsOf(g).children, function (b, i) { b.style.setProperty('--i', String(i)); });
  });

  // Opens the named group (or closes all when name is null). Animates the tiles with FLIP when asked.
  function setOpen(name, animate) {
    var before = animate && motionOK() ? lefts() : null;
    groups.forEach(function (g) {
      var on = g.dataset.group === name;
      g.classList.toggle('is-open', on);
      mainOf(g).setAttribute('aria-expanded', on ? 'true' : 'false');
      g.style.transition = 'none';
      g.style.transform = '';
    });
    root.dataset.open = name || '';
    active = name;
    if (!before) return;
    var after = lefts();
    groups.forEach(function (g, i) {
      var dx = before[i] - after[i];
      if (Math.abs(dx) < 0.5) return;
      g.style.transform = 'translateX(' + dx.toFixed(1) + 'px)';
    });
    void root.offsetWidth; // commit the start position before the transition
    groups.forEach(function (g) {
      g.style.transition = 'transform ' + MOVE_MS + 'ms cubic-bezier(0.2, 0.7, 0.2, 1)';
      g.style.transform = '';
    });
  }

  // Multiplayer: opens the Multiplayer screen (its own view, back arrow returns here).
  root.addEventListener('click', function (e) {
    var card = e.target.closest ? e.target.closest('[data-mp-open]') : null;
    if (!card) return;
    e.preventDefault(); e.stopPropagation();
    if (window.PokerMP && typeof window.PokerMP.open === 'function') window.PokerMP.open();
    else if (window.PokerApp && typeof window.PokerApp.showView === 'function') window.PokerApp.showView('multiplayer');
  }, true);

  function groupByName(n) { return groups.filter(function (g) { return g.dataset.group === n; })[0]; }
  function optionsOpen() {
    var g = active && groupByName(active);
    return g ? Array.prototype.slice.call(optsOf(g).querySelectorAll('.mode-card')) : [];
  }

  groups.forEach(function (g) {
    var main = mainOf(g);
    var name = g.dataset.group;
    main.addEventListener('click', function () {
      setOpen(active === name ? null : name, true);
    });
    main.addEventListener('keydown', function (e) {
      var other = groups[(groups.indexOf(g) + 1) % groups.length];
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault(); mainOf(other).focus();
      } else if (e.key === 'ArrowDown' && active === name) {
        e.preventDefault(); var first = optionsOpen()[0]; if (first) first.focus();
      } else if (e.key === 'Escape' && active === name) {
        e.preventDefault(); setOpen(null, true); main.focus();
      }
    });
  });

  // Options: arrows move along the row or column; Escape closes the group and returns to its main tile.
  root.addEventListener('keydown', function (e) {
    var t = e.target;
    if (!t.classList || !t.classList.contains('mode-card')) return;
    var list = optionsOpen();
    var i = list.indexOf(t);
    if (i < 0) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); if (list[i + 1]) list[i + 1].focus(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list[i - 1]) list[i - 1].focus(); else mainOf(groupByName(active)).focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      var m = mainOf(groupByName(active));
      setOpen(null, true);
      m.focus();
    }
  });

  setOpen(null, false);
})();
