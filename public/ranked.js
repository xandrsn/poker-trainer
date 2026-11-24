/* Ranked screen: account (sign in, sign up), match search, bot ladder, leaderboard and player profiles.
 * The match itself is a multiplayer room: PokerRooms.join opens it and mp.js calls PokerRanked.result at the end.
 * Browser only: window.PokerRanked = { show(), hide(), result(msg, done) }. Server: /api (server/api.js). */
(function () {
  'use strict';
  var POLL_MS = 2000, OFFER_BOT_S = 20;
  var user = null;       // signed-in player, or null
  var ready = null;      // promise of the first /api/me
  var off = '';          // why accounts do not work here ('setup' or 'net'), '' when they do
  var googleOn = false;  // Google sign-in is set up on this server
  var notice = '';       // i18n key of a message for the play panel, until the next click
  var search = null;     // { since, timer, bot, table, players } while looking for a match
  var bots = [], tab = 'bots', profileName = null, profile = null;
  var root, chip, dlg, drawn = 0;

  function t(k, v) { return window.I18N ? window.I18N.t('rk.' + k, v) : k; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  function signed(n) { return (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n); }
  function $(sel, el) { return (el || root).querySelector(sel); }

  function api(path, body) {
    return fetch('/api/' + path, {
      method: body ? 'POST' : 'GET', credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.ok) return d;
        var e = new Error(d.error || 'server error');
        e.status = r.status;
        throw e;
      });
    });
  }
  // Server messages are English; the ones a player meets have a translation.
  var ERR = { 401: 'eSignIn', 403: 'eWrongPass', 410: 'g.error', 409: 'eTaken', 429: 'eMany', 503: 'eSetup' };
  function errText(e, e401) {
    if (e.status === 401 && e401) return t(e401);
    if (ERR[e.status]) return t(ERR[e.status]);
    if (e.status === 400) return /password/.test(e.message) ? t('ePass') : t('eName');
    return t(e.status ? 'eServer' : 'eNet');
  }

  function loadMe() {
    return api('me').then(function (d) { user = d.user; googleOn = d.google; off = ''; }, function (e) {
      user = null;
      off = e.status === 503 ? 'eSetup' : 'eNet';
    }).then(drawChip);
  }

  function drawChip() {
    if (!chip) return;
    chip.innerHTML = user
      ? '<span class="rk-chip-name">' + esc(user.name) + '</span><b class="rk-num">' + user.rating + '</b>'
      : '<span>' + esc(t('signIn')) + '</span>';
    chip.setAttribute('aria-label', user ? t('chipAria', { name: user.name, r: user.rating }) : t('signIn'));
  }

  // ---------- sign in, sign up, recovery ----------
  // Keys are the server routes. fields: p is the current password, n a new one.
  var FORMS = {
    'login': { title: 'signIn', fields: ['name', 'p'], e401: 'eLogin', google: true, links: [['recover', 'forgot'], ['register', 'noAccount']] },
    'register': { title: 'signUp', fields: ['name', 'n'], hint: true, google: true, links: [['login', 'haveAccount']] },
    'recover': { title: 'recoverT', note: 'recoverD', fields: ['name', 'code', 'n'], e401: 'eCode', links: [['login', 'backToLogin']] },
    'google/finish': { title: 'googleNameT', fields: ['name'], hint: true, links: [] },
    'recovery-code': { title: 'newCode', note: 'newCodeD', fields: ['p'], links: [] }
  };
  function field(k, hint) {
    if (k === 'name') return '<label><span>' + esc(t('name')) + '</span><input name="name" autocomplete="username" required minlength="3" maxlength="16" pattern="[A-Za-z0-9_]+" autocapitalize="none" spellcheck="false">' +
      (hint ? '<small>' + esc(t('nameHint')) + '</small>' : '') + '</label>';
    if (k === 'code') return '<label><span>' + esc(t('code')) + '</span><input name="code" autocomplete="off" required maxlength="40" autocapitalize="characters" spellcheck="false"></label>';
    return '<label><span>' + esc(t(k === 'n' && !hint ? 'newPassword' : 'password')) + '</span><input name="password" type="password" autocomplete="' + (k === 'n' ? 'new-password' : 'current-password') + '" required minlength="8" maxlength="128">' +
      (k === 'n' ? '<small>' + esc(t('passHint')) + '</small>' : '') + '</label>';
  }
  function dialog(mode, html) {
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.className = 'rk-dlg';
      document.body.appendChild(dlg);
      dlg.addEventListener('click', function (e) {
        if (e.target === dlg && dlg.dataset.mode !== 'code') { dlg.close(); return; } // a code is shown only once
        var b = e.target.closest('[data-rk]'), k = b && b.getAttribute('data-rk');
        if (k === 'google') google(false, $('.rk-err', dlg));
        else if (k) openAuth(k);
      });
      dlg.addEventListener('submit', submitAuth);
    }
    dlg.dataset.mode = mode;
    dlg.setAttribute('aria-labelledby', 'rk-auth-t');
    dlg.innerHTML = html;
    if (!dlg.open) dlg.showModal();
  }
  function openAuth(mode) {
    var f = FORMS[mode];
    dialog(mode, '<form class="rk-auth" method="post"><h2 id="rk-auth-t">' + esc(t(f.title)) + '</h2>' +
      (f.note ? '<p class="rk-note">' + esc(t(f.note)) + '</p>' : '') +
      f.fields.map(function (k) { return field(k, f.hint); }).join('') +
      '<p class="rk-err" role="alert"></p>' +
      '<button type="submit" class="mr-confirm">' + esc(t(f.title)) + '</button>' +
      (f.google && googleOn ? '<button type="button" class="mr-join" data-rk="google">' + esc(t('google')) + '</button>' : '') +
      f.links.map(function (l) { return '<button type="button" class="rk-link" data-rk="' + l[0] + '">' + esc(t(l[1])) + '</button>'; }).join('') +
      '</form>');
    $('input', dlg).focus();
  }

  function submitAuth(e) {
    e.preventDefault();
    var f = e.target, btn = $('[type="submit"]', f), err = $('.rk-err', f), mode = dlg.dataset.mode, body = {};
    if (!FORMS[mode]) return;
    Array.prototype.forEach.call(f.querySelectorAll('input'), function (i) { body[i.name] = i.name === 'password' ? i.value : i.value.trim(); });
    btn.disabled = true;
    err.textContent = '';
    api(mode, body).then(function (d) {
      return loadMe().then(function () {
        if (root.hidden) show();
        else { if (mode !== 'recovery-code') profileName = null; draw(); }
        if (d.code) showCode(d.code);
        else dlg.close();
      });
    }, function (x) { err.textContent = errText(x, FORMS[mode].e401); btn.disabled = false; });
  }

  function showCode(code) {
    dialog('code', '<div class="rk-auth"><h2 id="rk-auth-t">' + esc(t('codeT')) + '</h2><p class="rk-note">' + esc(t('codeD')) + '</p>' +
      '<p class="rk-code">' + esc(code) + '</p>' +
      '<button type="button" class="mr-join">' + esc(t('copy')) + '</button>' +
      '<button type="button" class="mr-confirm">' + esc(t('codeDone')) + '</button></div>');
    var copy = $('.mr-join', dlg), ok = $('.mr-confirm', dlg);
    // Without clipboard access (plain http) the code can still be selected.
    if (!navigator.clipboard) copy.remove();
    else copy.addEventListener('click', function () { navigator.clipboard.writeText(code).then(function () { copy.textContent = t('copied'); }, function () { copy.remove(); }); });
    ok.addEventListener('click', function () { dlg.close(); });
    ok.focus();
  }

  // Off to Google; it comes back to /?google=... (fromGoogle).
  function google(link, err) {
    api('google', { link: link }).then(function (d) { location.href = d.url; }, function (e) { err.textContent = errText(e); });
  }
  function fromGoogle() {
    var r = new URLSearchParams(location.search).get('google');
    if (!r) return;
    history.replaceState(null, '', location.pathname);
    ready.then(function () {
      if (r === 'error' || r === 'taken') notice = 'g.' + r;
      show();
      if (r === 'linked') { tab = 'me'; drawTab(); }
      if (r === 'name') openAuth('google/finish');
    });
  }

  // ---------- match search ----------
  function play(bot, table) {
    if (!user) { openAuth('login'); return; }
    stopSearch(false);
    var s = search = { since: Date.now(), timer: null, bot: bot, table: table, players: 1 };
    drawPlay();
    poll(s);
  }
  function poll(s) {
    api('queue', s.bot ? { bot: s.bot } : s.table ? { mode: 'table' } : {}).then(function (d) {
      if (search !== s) return;
      if (d.status === 'matched') {
        search = null;
        hide();
        window.PokerRooms.join(d.room, user.name);
        return;
      }
      s.players = d.players || s.players;
      s.timer = setTimeout(function () { poll(s); }, POLL_MS);
      drawPlay();
    }, function (e) {
      if (search !== s) return;
      if (e.status) { // refused: polling again would not help
        search = null;
        if (e.status === 401) { user = null; drawChip(); }
        drawPlay(errText(e));
      } else {
        s.timer = setTimeout(function () { poll(s); }, POLL_MS);
        drawPlay(errText(e));
      }
    });
  }
  function stopSearch(redraw) {
    if (!search) return;
    clearTimeout(search.timer);
    search = null;
    api('queue/cancel', {}).catch(function () { /* the server drops a player who stops polling */ });
    if (redraw) drawPlay();
  }

  // ---------- drawing ----------
  function build() {
    root = document.createElement('div');
    root.className = 'mr-screen rk-screen';
    root.id = 'rk-screen';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'rk-title');
    document.body.appendChild(root);
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); back(); return; }
      if (e.key !== 'Tab') return;
      var f = Array.prototype.filter.call(root.querySelectorAll('button:not(:disabled)'), function (b) { return b.offsetParent; });
      var edge = e.shiftKey ? f[0] : f[f.length - 1];
      if (document.activeElement === edge) { e.preventDefault(); (e.shiftKey ? f[f.length - 1] : f[0]).focus(); }
    });
  }

  function draw() {
    root.innerHTML = '<header class="mr-head">' +
      '<button type="button" class="mr-back" data-rk="back" aria-label="' + esc(t('back')) + '"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M15 6l-6 6 6 6"/></svg></button>' +
      '<h2 class="mr-title" id="rk-title">' + esc(t('title')) + '</h2></header>' +
      '<div class="rk-scroll"><div class="rk-grid"><section class="rk-play" aria-live="polite"></section><section class="rk-main">' +
      '<div class="rk-tabs" role="tablist">' + ['bots', 'board', 'me'].map(function (k) {
        return '<button type="button" role="tab" id="rk-tab-' + k + '" aria-controls="rk-panel" aria-selected="' + (tab === k) + '" data-tab="' + k + '">' + esc(t('tab.' + k)) + '</button>';
      }).join('') + '</div><div class="rk-panel" id="rk-panel" role="tabpanel" aria-labelledby="rk-tab-' + tab + '"></div></section></div></div>';
    drawPlay();
    drawTab();
  }

  function drawPlay(error) {
    var el = root && $('.rk-play');
    if (!el) return;
    var h;
    if (off) h = '<p class="rk-note" role="status">' + esc(t(off)) + '</p>' + (off === 'eNet' ? '<button type="button" class="mr-join" data-rk="retry">' + esc(t('retry')) + '</button>' : '');
    else if (!user) {
      h = '<p class="rk-lead">' + esc(t('lead')) + '</p>' +
        '<button type="button" class="mr-confirm" data-rk="register">' + esc(t('signUp')) + '</button>' +
        '<button type="button" class="mr-join" data-rk="login">' + esc(t('signIn')) + '</button>';
    } else {
      var waited = search ? Math.floor((Date.now() - search.since) / 1000) : 0;
      var near = bots.slice().sort(function (a, b) { return Math.abs(a.rating - user.rating) - Math.abs(b.rating - user.rating); })[0];
      h = '<button type="button" class="rk-me" data-profile="' + esc(user.name) + '"><span>' + esc(user.name) + '</span><b class="rk-big rk-num">' + user.rating + '</b>' +
        '<small>' + esc(user.games ? t('record', { g: user.games, w: user.wins }) : t('noGames')) + '</small></button>';
      if (search && !search.bot) {
        h += '<p class="rk-wait"><span class="rk-dot" aria-hidden="true"></span>' + esc(t(search.table ? 'searchingTable' : 'searching', { s: waited, n: search.players })) + '</p>' +
          '<button type="button" class="mr-join" data-rk="cancel">' + esc(t('cancel')) + '</button>' +
          (search.table ? '<p class="rk-note">' + esc(t('tableFill')) + '</p>' : waited >= OFFER_BOT_S && near ? '<p class="rk-note">' + esc(t('offer')) + '</p><button type="button" class="mr-confirm" data-bot="' + esc(near.id) + '">' + esc(t('playName', { name: near.name })) + '</button>' : '');
      } else {
        h += '<button type="button" class="mr-confirm" data-rk="find"' + (search ? ' disabled' : '') + '>' + esc(t(search ? 'opening' : 'find')) + '</button>' +
          (search ? '' : '<button type="button" class="mr-join" data-rk="table">' + esc(t('findTable')) + '</button>') +
          '<p class="rk-note">' + esc(t('format')) + '</p>';
      }
      h += '<button type="button" class="rk-link" data-rk="logout">' + esc(t('signOut')) + '</button>';
    }
    if (!error && notice) error = t(notice);
    if (error) h += '<p class="rk-err" role="alert">' + esc(error) + '</p>';
    if (el.rkHtml === h) return; // set on the element, so a fresh panel always draws
    var keep = el.contains(document.activeElement) && document.activeElement.getAttribute('data-rk');
    el.innerHTML = el.rkHtml = h;
    if (keep) { var b = $('[data-rk="' + keep + '"]', el) || $('button', el); if (b) b.focus(); }
  }

  function load(path) {
    var n = ++drawn, p = $('.rk-panel');
    p.setAttribute('aria-busy', 'true');
    return api(path).then(function (d) { return n === drawn && $('.rk-panel') ? d : null; }, function (e) {
      if (n === drawn) { p = $('.rk-panel'); if (p) p.innerHTML = '<p class="rk-note">' + esc(errText(e)) + '</p>'; }
      return null;
    }).then(function (d) { if (p) p.removeAttribute('aria-busy'); return d; });
  }

  function drawTab() {
    var p = $('.rk-panel');
    Array.prototype.forEach.call(root.querySelectorAll('[data-tab]'), function (b) { b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === tab)); });
    p.setAttribute('aria-labelledby', 'rk-tab-' + tab);
    if (off) { p.innerHTML = ''; return; }
    if (tab === 'bots') {
      load('bots').then(function (d) {
        if (!d) return;
        bots = d.bots;
        $('.rk-panel').innerHTML = '<p class="rk-note">' + esc(t('botsNote')) + '</p><ul class="rk-list">' + bots.slice().reverse().map(function (b) {
          return '<li class="mr-row rk-row"><span class="rk-who"><b>' + esc(b.name) + ' (' + b.rating + ')</b><small>' + esc(t('tableRating', { r: b.table })) + '</small></span>' +
            '<button type="button" class="mr-join" data-bot="' + esc(b.id) + '" aria-label="' + esc(t('playName', { name: b.name })) + '">' + esc(t('play')) + '</button></li>';
        }).join('') + '</ul>';
        drawPlay();
      });
    } else if (tab === 'board') {
      load('leaderboard').then(function (d) {
        if (!d) return;
        $('.rk-panel').innerHTML = d.players.length ? '<table class="rk-table"><thead><tr><th scope="col">#</th><th scope="col">' + esc(t('player')) + '</th><th scope="col">' + esc(t('games')) + '</th><th scope="col">' + esc(t('won')) + '</th><th scope="col">' + esc(t('rating')) + '</th></tr></thead><tbody>' +
          d.players.map(function (u, i) {
            return '<tr' + (user && u.name === user.name ? ' class="is-me"' : '') + '><td>' + (i + 1) + '</td><td><button type="button" class="rk-link" data-profile="' + esc(u.name) + '">' + esc(u.name) + '</button></td><td>' + u.games + '</td><td>' + (u.games ? Math.round(u.wins / u.games * 100) : 0) + '%</td><td><b>' + u.rating + '</b></td></tr>';
          }).join('') + '</tbody></table>' : '<p class="rk-note">' + esc(t('boardEmpty')) + '</p>';
      });
    } else {
      var name = profileName || (user && user.name);
      if (!name) { p.innerHTML = '<p class="rk-note">' + esc(t('eSignIn')) + '</p>'; return; }
      load('profile?name=' + encodeURIComponent(name)).then(function (d) { if (d) { profile = d.player; drawProfile(); } });
    }
  }

  function against(h) { return h.of ? t('tableOf', { n: h.of }) : h.opp; }
  function drawProfile() {
    var u = profile, p = $('.rk-panel');
    function stat(label, v) { return '<div><dt>' + esc(label) + '</dt><dd class="rk-num">' + v + '</dd></div>'; }
    p.innerHTML = '<h3 class="rk-pname">' + esc(u.name) + '</h3><dl class="rk-stats">' + stat(t('rating'), u.rating) + stat(t('peak'), u.peak) +
      stat(t('rank'), u.rank ? '#' + u.rank : '–') + stat(t('games'), u.games) + stat(t('won'), (u.games ? Math.round(u.wins / u.games * 100) : 0) + '%') + '</dl>' +
      (u.history.length > 1 ? '<figure class="rk-fig"><figcaption>' + esc(t('chart', { n: u.history.length })) + '</figcaption><div class="rk-chart"></div></figure>' : '') +
      (u.history.length ? '<h3 class="rk-h">' + esc(t('recent')) + '</h3><ul class="rk-list">' + u.history.map(function (h) {
        return '<li class="rk-game"><span class="rk-res ' + (h.won ? 'is-won' : 'is-lost') + '">' + esc(h.of && !h.won ? '#' + h.place : t(h.won ? 'win' : 'loss')) + '</span><span class="rk-who"><b>' + esc(against(h)) + '</b>' + (h.of ? '' : ' <small class="rk-num">' + h.oppRating + '</small>') + '</span>' +
          '<time datetime="' + new Date(h.at).toISOString() + '">' + new Date(h.at).toLocaleDateString() + '</time><b class="rk-num">' + signed(h.delta) + '</b></li>';
      }).join('') + '</ul>' : '<p class="rk-note">' + esc(t('noGames')) + '</p>') +
      (user && u.name === user.name ? access() : '');
    var c = $('.rk-chart');
    if (c) chart(c, u.history.slice().reverse());
  }

  // Your own profile: how you sign in.
  function access() {
    var h = user.password ? '<button type="button" class="mr-join" data-rk="recovery-code">' + esc(t('newCode')) + '</button>' : '';
    if (user.google) h += '<p class="rk-note">' + esc(t('googleLinked')) + '</p>';
    else if (googleOn) h += '<button type="button" class="mr-join" data-rk="link">' + esc(t('linkGoogle')) + '</button>';
    return h && '<h3 class="rk-h">' + esc(t('access')) + '</h3><div class="rk-access">' + h + '<p class="rk-err" role="alert"></p></div>';
  }

  // Rating after each match: one line, the last value labelled, a crosshair with the match under the pointer.
  // The list below it is the table view of the same numbers.
  function chart(el, hist) {
    var W = Math.max(260, el.clientWidth || 520), H = 150, L = 44, R = 52, T = 12, B = 12;
    var ys = hist.map(function (h) { return h.after; });
    var lo = Math.floor(Math.min.apply(null, ys) / 50) * 50, hi = Math.ceil(Math.max.apply(null, ys) / 50) * 50;
    if (hi === lo) hi += 50;
    function x(i) { return L + i / (ys.length - 1) * (W - L - R); }
    function y(v) { return T + (hi - v) / (hi - lo) * (H - T - B); }
    var last = ys.length - 1;
    el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" role="img" aria-label="' + esc(t('chartAria', { a: ys[0], b: ys[last] })) + '">' +
      [lo, (lo + hi) / 2, hi].map(function (v) {
        return '<line class="rk-grid-l" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '"/><text class="rk-axis" x="' + (L - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + v + '</text>';
      }).join('') +
      '<path class="rk-line" d="' + ys.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); }).join('') + '"/>' +
      '<line class="rk-cross" y1="' + T + '" y2="' + (H - B) + '" visibility="hidden"/>' +
      '<circle class="rk-pt" r="4.5" cx="' + x(last) + '" cy="' + y(ys[last]) + '"/>' +
      '<text class="rk-axis rk-end" x="' + (x(last) + 10) + '" y="' + (y(ys[last]) + 4) + '">' + ys[last] + '</text></svg><div class="rk-tip" hidden></div>';
    var svg = el.firstChild, cross = $('.rk-cross', el), pt = $('.rk-pt', el), tip = $('.rk-tip', el);
    function at(i, on) {
      pt.setAttribute('cx', x(i));
      pt.setAttribute('cy', y(ys[i]));
      cross.setAttribute('x1', x(i));
      cross.setAttribute('x2', x(i));
      cross.setAttribute('visibility', on ? 'visible' : 'hidden');
      tip.hidden = !on;
      if (!on) return;
      tip.textContent = ys[i] + ' (' + signed(hist[i].delta) + ') ' + against(hist[i]);
      tip.style.left = Math.max(0, Math.min(W - tip.offsetWidth, x(i) - tip.offsetWidth / 2)) + 'px';
    }
    svg.addEventListener('pointermove', function (e) {
      var r = svg.getBoundingClientRect();
      var i = Math.round(((e.clientX - r.left) * W / r.width - L) / (W - L - R) * last);
      at(Math.max(0, Math.min(last, i)), true);
    });
    svg.addEventListener('pointerleave', function () { at(last, false); });
  }

  // ---------- actions ----------
  function onClick(e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (notice) { notice = ''; drawPlay(); }
    if (b.hasAttribute('data-tab')) { tab = b.getAttribute('data-tab'); if (tab === 'me') profileName = null; drawTab(); return; }
    if (b.hasAttribute('data-bot')) { play(b.getAttribute('data-bot')); return; }
    if (b.hasAttribute('data-profile')) { profileName = b.getAttribute('data-profile'); tab = 'me'; drawTab(); return; }
    switch (b.getAttribute('data-rk')) {
      case 'back': back(); break;
      case 'find': play(null); break;
      case 'table': play(null, true); break;
      case 'cancel': stopSearch(true); break;
      case 'login': openAuth('login'); break;
      case 'register': openAuth('register'); break;
      case 'recovery-code': openAuth('recovery-code'); break;
      case 'link': google(true, $('.rk-access .rk-err')); break;
      case 'retry': loadMe().then(function () { if (!root.hidden) draw(); }); break;
      case 'logout':
        stopSearch(false);
        api('logout', {}).then(loadMe, loadMe).then(function () { profileName = null; if (!root.hidden) draw(); });
        break;
    }
  }

  function back() {
    stopSearch(false);
    hide();
    if (window.PokerApp) window.PokerApp.showView('menu');
    var c = document.getElementById('menu-card-ranked');
    if (c && c.offsetParent) c.focus();
  }

  function show() {
    if (window.PokerApp) window.PokerApp.showView('menu');
    root.hidden = false;
    tab = 'bots';
    profileName = null;
    draw();
    $('.mr-back').focus();
    loadMe().then(function () { if (!root.hidden) { drawPlay(); drawTab(); } }); // ratings change after a match
  }
  function hide() { root.hidden = true; }

  // End of a match: the result over the table. done() leaves the room.
  function result(m, done) {
    var d = document.createElement('dialog');
    d.className = 'rk-dlg rk-result';
    var me = user && m.players.filter(function (p) { return p.id === user.id; })[0];
    var won = !!me && me.won, table = m.kind === 'table';
    var title = m.void ? 'voidT' : won ? 'youWon' : table ? 'place' : 'youLost';
    var why = m.void ? (table ? 'voidTable' : 'voidD') : won && table ? 'why.table' : 'why.' + m.reason + (won ? '' : '.l');
    d.setAttribute('aria-labelledby', 'rk-res-t');
    d.innerHTML = '<div class="rk-auth"><h2 id="rk-res-t">' + esc(t(title, { p: m.place, n: m.of })) + '</h2>' +
      '<p class="rk-note">' + esc(t(why)) + '</p>' +
      (me ? '<p class="rk-delta"><b class="rk-big rk-num" data-to="' + me.after + '">' + me.before + '</b><span class="rk-num ' + (me.delta >= 0 ? 'is-won' : 'is-lost') + '">' + signed(me.delta) + '</span></p>' : '') +
      '<button type="button" class="mr-confirm" autofocus>' + esc(t('toRanked')) + '</button></div>';
    document.body.appendChild(d);
    d.addEventListener('close', function () { d.remove(); done(); show(); });
    $('button', d).addEventListener('click', function () { d.close(); });
    d.showModal();
    if (me) count($('[data-to]', d), me.before, me.after);
  }
  function count(el, a, b) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = b; return; }
    var t0 = performance.now();
    (function step(now) {
      var k = Math.max(0, Math.min(1, (now - t0 - 400) / 700));
      el.textContent = Math.round(a + (b - a) * (1 - Math.pow(1 - k, 3)));
      if (k < 1 && el.isConnected) requestAnimationFrame(step);
    })(t0);
  }

  function init() {
    build();
    chip = document.getElementById('btn-account');
    if (chip) chip.addEventListener('click', function () {
      ready.then(function () {
        if (!user && !off) { openAuth('login'); return; }
        show();
        if (user) { tab = 'me'; drawTab(); }
      });
    });
    var card = document.getElementById('menu-card-ranked');
    if (card) card.addEventListener('click', function (e) { e.stopPropagation(); show(); });
    drawChip();
    ready = loadMe();
    fromGoogle();
    new MutationObserver(drawChip).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    setInterval(function () { if (search && !root.hidden) drawPlay(); }, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.PokerRanked = { show: show, hide: hide, result: result };
})();
