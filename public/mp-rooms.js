/* Multiplayer entry screen (public/mp-rooms.js): titled 'Multiplayer', a header chip with the player's name and
 * photo (Edit opens Settings > User), then two tiles. The player's name is set in Settings > User (shared record
 * poker-trainer:user:v1); without one, the tiles are replaced by a blocking prompt that opens that tab and comes
 * back here when saved.
 * Join table: a table-name finder (live filter; Enter joins an exact match) and the live list of open tables.
 * Create table: one panel with every table setting (no bots: those are added in the host lobby) and Create table.
 * Joining hands the table code to mp.js (window.PokerMP.open).
 * Browser only: window.PokerRooms = { show(msg?), hide(), roomId(), clear(), join(id, name?), intent(m) }.
 * Own socket on /ws while a panel that needs the list or the name check is open; the server pushes roomList
 * every 2 s. */
(function () {
  'use strict';
  var STORE_KEY = 'poker-trainer:mp:room';
  var RETRY_MS = 1500;
  var CHECK_MS = 250;
  var NAME_MAX = 16;        // same limit as the profile name (mp.js cleanName, app.js user record)
  var TABLE_MAX = 24;       // server MAX_NAME
  var memRoom = null;
  var ws = null;
  var retryTimer = null;
  var root = null;
  var E = {};
  var lastRooms = null;
  var pendingCreate = false;
  var openOpt = null;       // 'join' | 'create' | null
  var pendingIntent = null;
  var reduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var MOVE_MS = 260;
  var checkTimer = null;
  var lastCheck = { name: null, ok: false };
  // Create-panel settings (BB for stacks; chips = BB * 1000 is sent). Defaults: 100 BB, 0.5/1 blinds.
  var form = { stack: 100, sb: 0.5, blindUp: 0, late: 'start', lateFixed: 20, spect: 'live' };
  var BB_CHIPS = 1000;

  function t(key, vars) {
    if (window.I18N && typeof window.I18N.t === 'function') return window.I18N.t(key, vars);
    return key;
  }
  function wsUrl() { return (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws'; }
  function motionOK() { return !(reduced && reduced.matches); }

  function roomId() {
    try {
      var v = window.sessionStorage.getItem(STORE_KEY);
      return v || memRoom || null;
    } catch (e) { return memRoom; }
  }
  function storeRoom(id) {
    memRoom = id || null;
    try {
      if (id) window.sessionStorage.setItem(STORE_KEY, id);
      else window.sessionStorage.removeItem(STORE_KEY);
    } catch (e) { /* storage blocked: memory only */ }
  }

  function send(obj) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  function closeSocket() {
    clearTimeout(retryTimer);
    retryTimer = null;
    if (ws) {
      var s = ws;
      ws = null;
      s.onclose = null;
      try { s.close(); } catch (e) { /* already closed */ }
    }
  }

  // Table names: control characters and HTML-special characters become spaces, runs collapse, at most 24.
  function cleanText(v) {
    return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f<>&"'`]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function tableKey(v) { return cleanText(v).slice(0, TABLE_MAX).trim(); }

  // The list socket. Open while the join panel or the create panel (name checks) is open.
  function openSocket() {
    closeSocket();
    var s;
    try { s = new WebSocket(wsUrl()); } catch (e) { setStatus('rooms.offline'); return; }
    ws = s;
    s.onopen = function () { send({ t: 'rooms' }); if (openOpt === 'create') scheduleCheck(true); };
    s.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'roomList') { lastRooms = msg.rooms || []; renderList(); setStatus(''); return; }
      if (msg.t === 'roomNameCheck') { onNameCheck(msg); return; }
      if (msg.t === 'roomJoined' && pendingCreate) { pendingCreate = false; join(msg.id); return; }
      if (msg.t === 'error') {
        pendingCreate = false;
        var m = String(msg.msg || '');
        if (/name taken/.test(m)) { lastCheck = { name: null, ok: false }; onNameTaken(msg.suggest); updateCreate(); return; }
        if (/room full/.test(m)) setStatus('rooms.full');
        else if (/room not found/.test(m)) setStatus('rooms.gone');
        else setStatus(m, true);
        if (E.createErr && openOpt === 'create') E.createErr.textContent = m;
      }
    };
    s.onclose = function () {
      if (ws !== s) return;
      ws = null;
      if (root && !root.hidden && openOpt) {
        setStatus('rooms.offline');
        clearTimeout(retryTimer);
        retryTimer = setTimeout(function () {
          if (root && !root.hidden && openOpt) openSocket();
        }, RETRY_MS);
      }
    };
  }

  function setStatus(text, raw) {
    if (!E.status) return;
    E.status.textContent = raw ? text : (text ? t(text) : '');
  }

  // The profile name from Settings > User (shared record through mp.js). '' when not set.
  function savedName() {
    return window.PokerMP && typeof window.PokerMP.getName === 'function' ? window.PokerMP.getName() : '';
  }
  function savedAvatar() {
    return window.PokerMP && typeof window.PokerMP.getAvatar === 'function' ? window.PokerMP.getAvatar() : '';
  }
  function hasUser() { return !!savedName(); }
  function defaultTableName() {
    var u = savedName();
    return u ? t('rooms.defaultName', { user: u }).slice(0, TABLE_MAX) : t('rooms.defaultNameAnon');
  }

  // Filter text of the join panel, lower case; '' shows every table.
  function filterText() { return E.tfilter ? cleanText(E.tfilter.value).toLowerCase() : ''; }

  function renderList() {
    if (!E.rows) return;
    var here = roomId();
    var q = filterText();
    var rooms = (lastRooms || []).filter(function (r) { return !q || String(r.name).toLowerCase().indexOf(q) >= 0; });
    rooms.sort(function (a, b) { return b.createdAt - a.createdAt; });
    E.rows.textContent = '';
    E.empty.hidden = rooms.length > 0 || lastRooms === null || openOpt !== 'join';
    E.emptyText.textContent = q ? t('rooms.noMatch') : t('rooms.empty');
    rooms.forEach(function (r) {
      var li = document.createElement('li');
      li.className = 'mr-row' + (r.id === here ? ' mr-here' : '');
      li.setAttribute('data-room', r.id);
      var main = document.createElement('div');
      main.className = 'mr-main';
      var name = document.createElement('span');
      name.className = 'mr-name';
      name.textContent = r.name;
      var meta = document.createElement('span');
      meta.className = 'mr-meta';
      var parts = [t('rooms.players', { n: r.players, max: r.max })];
      if (r.host) parts.push(t('rooms.host', { name: r.host }));
      if (r.blinds) parts.push(t('rooms.blinds', { sb: r.blinds.sb, bb: r.blinds.bb }));
      meta.textContent = parts.join(' · ');
      var dots = document.createElement('span');
      dots.className = 'mr-dots';
      dots.setAttribute('aria-hidden', 'true');
      var seats = Math.min(Math.max(1, r.max || 6), 12);
      for (var i = 0; i < seats; i++) {
        var dot = document.createElement('i');
        dot.className = 'mr-dot' + (i < r.players ? ' on' : '');
        dots.appendChild(dot);
      }
      main.appendChild(name);
      main.appendChild(meta);
      main.appendChild(dots);
      var badges = document.createElement('span');
      badges.className = 'mr-badges';
      if (r.id === here) {
        var you = document.createElement('span');
        you.className = 'mr-badge mr-you';
        you.textContent = t('rooms.here');
        badges.appendChild(you);
      }
      var badge = document.createElement('span');
      badge.className = 'mr-badge mr-' + (r.status === 'playing' ? 'playing' : 'lobby');
      badge.textContent = t(r.status === 'playing' ? 'rooms.playing' : 'rooms.lobby');
      badges.appendChild(badge);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mr-join';
      btn.setAttribute('data-join', r.id);
      btn.textContent = r.id === here ? t('rooms.enter') : t('rooms.join');
      li.appendChild(main);
      li.appendChild(badges);
      li.appendChild(btn);
      E.rows.appendChild(li);
    });
  }

  // Hands the table to mp.js: this screen closes and mp.js connects with the saved profile name.
  function join(id) {
    storeRoom(id);
    hide();
    if (window.PokerMP && typeof window.PokerMP.open === 'function') window.PokerMP.open();
  }

  // Join: Enter (or submit) joins the open table whose name matches the filter exactly (any case).
  function joinSubmit(ev) {
    ev.preventDefault();
    var want = cleanText(E.tfilter.value).toLowerCase();
    E.joinErr.textContent = '';
    if (!want) { E.joinErr.textContent = t('rooms.findHint'); return; }
    var hit = (lastRooms || []).filter(function (r) { return String(r.name).toLowerCase() === want; })[0];
    if (!hit) { E.joinErr.textContent = t('rooms.noExact'); return; }
    join(hit.id);
  }

  // msg: an i18n key (rooms.full, rooms.gone) shown on the screen, optional.
  function show(msg) {
    if (!root) return;
    root.hidden = false;
    pendingCreate = false;
    closeSocket();
    setOpen(null, false);
    refresh();
    if (msg) setStatus(msg);
    // Set by the main menu (menu-hub.js): expand the named tile right away.
    var m = pendingIntent;
    pendingIntent = null;
    if ((m === 'create' || m === 'join') && hasUser()) setOpen(m, false);
  }

  function hide() {
    closeSocket();
    if (root) root.hidden = true;
  }

  function clear() { storeRoom(null); }

  // ---- Header chip and the blocking prompt ------------------------------------------------------

  function initialOf(name) {
    var core = window.PokerMP && window.PokerMP.core;
    if (core && typeof core.initials === 'function') return core.initials(name) || '?';
    return name ? name.charAt(0).toUpperCase() : '?';
  }
  function colorOf(name) {
    var core = window.PokerMP && window.PokerMP.core;
    return core && typeof core.nameColor === 'function' ? core.nameColor(name) : '#3a4656';
  }
  // Photo, or the initials on the name colour. Used by the header chip.
  function paintAvatar(el, name, photo) {
    el.textContent = '';
    el.style.background = photo ? '' : colorOf(name || '?');
    if (photo) {
      var img = document.createElement('img');
      img.src = photo;
      img.alt = '';
      el.appendChild(img);
    } else {
      el.textContent = initialOf(name || '');
    }
  }
  function renderChip() {
    var name = savedName();
    paintAvatar(E.meAv, name, savedAvatar());
    E.meName.textContent = name || t('rooms.noUser');
    E.meName.classList.toggle('is-empty', !name);
  }
  // The gate: the tiles show only with a username; otherwise the blocking prompt.
  function renderGate() {
    var ok = hasUser();
    E.opts.hidden = !ok;
    E.needName.hidden = ok;
    root.setAttribute('data-needname', ok ? '' : '1');
    if (!ok) setOpen(null, false);
  }
  function refresh() {
    renderChip();
    renderGate();
  }
  // Settings > User, from this screen. Saving or closing returns here (the same screen, refreshed).
  function openSettingsUser() {
    if (window.PokerApp && typeof window.PokerApp.openSettings === 'function') {
      window.PokerApp.openSettings('user', refresh);
    }
  }

  // ---- Tiles and panels -------------------------------------------------------------------------

  // Expands one panel (or collapses all when name is null). The other tile moves with FLIP (transform
  // only, 260 ms) when the layout shifts; the panel fades and slides in (CSS). One panel open at a time.
  function setOpen(name, animate) {
    if (!root) return;
    var tiles = [E.tiles.join, E.tiles.create];
    var before = animate && motionOK() ? tiles.map(function (b) { var r = b.getBoundingClientRect(); return { x: r.left, y: r.top }; }) : null;
    var prev = openOpt;
    openOpt = name || null;
    ['join', 'create'].forEach(function (k) {
      var on = openOpt === k;
      E.tiles[k].setAttribute('aria-expanded', on ? 'true' : 'false');
      E.tiles[k].parentNode.classList.toggle('is-open', on);
      E.panels[k].hidden = !on;
      E.tiles[k].style.transition = 'none';
      E.tiles[k].style.transform = '';
    });
    root.setAttribute('data-open', openOpt || '');
    if (openOpt === 'create') {
      if (prev !== 'create') { E.tName.value = defaultTableName(); lastCheck = { name: null, ok: false }; renderForm(); }
      if (!ws) openSocket();
      // The socket's onopen starts the first name check; an open socket checks now.
      if (ws && ws.readyState === 1) scheduleCheck(true); else updateCreate();
    } else if (openOpt === 'join') {
      if (!ws) openSocket();
      renderList();
    } else {
      clearTimeout(checkTimer);
      closeSocket();
    }
    if (!before) return;
    var after = tiles.map(function (b) { var r = b.getBoundingClientRect(); return { x: r.left, y: r.top }; });
    tiles.forEach(function (b, i) {
      var dx = before[i].x - after[i].x, dy = before[i].y - after[i].y;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      b.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)';
    });
    void root.offsetWidth;
    tiles.forEach(function (b) {
      b.style.transition = 'transform ' + MOVE_MS + 'ms cubic-bezier(0.2, 0.7, 0.2, 1)';
      b.style.transform = '';
    });
  }

  // Create panel: segmented and stepper controls.
  function renderForm() {
    E.stackVal.textContent = t('rooms.bbVal', { n: formatBB(form.stack) });
    E.stackMinus.disabled = form.stack <= 5;
    E.stackPlus.disabled = form.stack >= 1000;
    E.lateFixedWrap.hidden = form.late !== 'fixed';
    E.lateFixedVal.textContent = t('rooms.bbVal', { n: formatBB(form.lateFixed) });
    E.lateMinus.disabled = form.lateFixed <= 5;
    E.latePlus.disabled = form.lateFixed >= 1000;
    Array.prototype.forEach.call(root.querySelectorAll('[data-seg]'), function (g) {
      var key = g.getAttribute('data-seg');
      Array.prototype.forEach.call(g.querySelectorAll('button'), function (b) {
        var v = b.getAttribute('data-v');
        var cur = String(form[key]);
        b.setAttribute('aria-pressed', v === cur ? 'true' : 'false');
      });
    });
  }
  function formatBB(n) { return String(Math.round(n * 10) / 10).replace(/\.0$/, ''); }

  function stepForm(key, delta, lo, hi) {
    var v = Math.round((form[key] + delta) * 2) / 2;
    form[key] = Math.min(hi, Math.max(lo, v));
    renderForm();
  }

  // Live name check: debounced; the server answers roomNameCheck with ok (free) or taken (+ suggest).
  function scheduleCheck(now) {
    clearTimeout(checkTimer);
    var name = tableKey(E.tName.value);
    E.namemsg.textContent = '';
    E.namemsg.className = 'mr-namemsg';
    if (!name) { lastCheck = { name: '', ok: false }; updateCreate(); return; }
    E.namemsg.textContent = t('rooms.nameChecking');
    lastCheck = { name: null, ok: false };
    updateCreate();
    checkTimer = setTimeout(function () {
      if (!send({ t: 'roomNameCheck', name: name })) {
        E.namemsg.textContent = t('rooms.offline');
        lastCheck = { name: null, ok: false };
        updateCreate();
      }
    }, now ? 0 : CHECK_MS);
  }
  function onNameCheck(msg) {
    if (msg.name !== tableKey(E.tName.value)) return; // stale reply for an older value
    E.suggest.hidden = true;
    if (msg.ok) {
      lastCheck = { name: msg.name, ok: true };
      E.namemsg.textContent = t('rooms.nameFree');
      E.namemsg.className = 'mr-namemsg is-ok';
    } else {
      lastCheck = { name: msg.name, ok: false };
      if (msg.reason === 'empty') { E.namemsg.textContent = t('rooms.nameReq'); E.namemsg.className = 'mr-namemsg is-bad'; }
      else onNameTaken(msg.suggest);
    }
    updateCreate();
  }
  function onNameTaken(suggest) {
    E.namemsg.className = 'mr-namemsg is-bad';
    E.namemsg.textContent = t('rooms.nameTaken');
    if (suggest) {
      E.suggest.textContent = t('rooms.useName', { name: suggest });
      E.suggest.setAttribute('data-name', suggest);
      E.suggest.hidden = false;
    }
  }
  function canCreate() {
    return lastCheck.ok && lastCheck.name === tableKey(E.tName.value) && hasUser();
  }
  function updateCreate() {
    if (!E.createBtn) return;
    E.createBtn.disabled = !canCreate();
  }

  function createNow(ev) {
    ev.preventDefault();
    if (!canCreate()) return;
    E.createErr.textContent = '';
    var settings = {
      stack: Math.round(form.stack * BB_CHIPS),
      sb: Math.round(form.sb * BB_CHIPS),
      bb: BB_CHIPS,
      blindUpMin: form.blindUp,
      lateStack: form.late,
      lateFixedBB: form.lateFixed,
      spectatorCards: form.spect,
    };
    if (!ws || ws.readyState !== 1) { E.createErr.textContent = t('rooms.offline'); return; }
    pendingCreate = true;
    send({ t: 'createRoom', name: tableKey(E.tName.value), settings: settings });
  }

  // ---- Build ------------------------------------------------------------------------------------

  function tileHTML(kind, icon) {
    return '<button type="button" class="mr-choice" id="mr-tile-' + kind + '" data-tile="' + kind + '" aria-expanded="false" aria-controls="mr-panel-' + kind + '">' +
      '<span class="mr-choice-icon" aria-hidden="true">' + icon + '</span>' +
      '<span class="mr-choice-name"></span>' +
      '<span class="mr-choice-desc"></span></button>';
  }
  function seg(key, opts) {
    return '<div class="mr-seg" role="group" data-seg="' + key + '">' + opts.map(function (o) {
      return '<button type="button" data-v="' + o[0] + '" aria-pressed="false">' + o[1] + '</button>';
    }).join('') + '</div>';
  }
  function stepper(key, label) {
    return '<div class="mr-stepper" role="group" aria-label="' + label + '">' +
      '<button type="button" class="mr-step" data-step-key="' + key + '" data-delta="-0.5" aria-label="-0.5">&minus;</button>' +
      '<output class="mr-stepval" data-stepval="' + key + '"></output>' +
      '<button type="button" class="mr-step" data-step-key="' + key + '" data-delta="0.5" aria-label="+0.5">+</button></div>';
  }

  function build() {
    root = document.createElement('section');
    root.id = 'mp-rooms';
    root.className = 'mr-screen';
    root.hidden = true;
    root.setAttribute('aria-labelledby', 'mr-title');
    root.setAttribute('data-view', 'choose');
    var SVG = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
    var ICON_CREATE = SVG + '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>';
    var ICON_JOIN = SVG + '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M4 12h10"/><path d="M10 8l4 4-4 4"/></svg>';
    var ICON_USER = SVG + '<circle cx="12" cy="9" r="3.5"/><path d="M5 20c1.2-3.2 3.8-5 7-5s5.8 1.8 7 5"/></svg>';
    root.innerHTML =
      '<header class="mr-head">' +
        '<button type="button" class="mr-back" data-mr="back">' +
          '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '</button>' +
        '<h2 id="mr-title" class="mr-title"></h2>' +
        '<div class="mr-me">' +
          '<span class="mr-me-av" aria-hidden="true"></span>' +
          '<span class="mr-me-name"></span>' +
          '<button type="button" class="mr-me-edit" data-mr="edit"></button>' +
        '</div>' +
      '</header>' +
      '<div class="mr-needname" hidden>' +
        '<span class="mr-needname-icon" aria-hidden="true">' + ICON_USER + '</span>' +
        '<h3 class="mr-needname-title"></h3>' +
        '<p class="mr-needname-desc"></p>' +
        '<button type="button" class="mr-confirm mr-needname-go"></button>' +
      '</div>' +
      '<div class="mr-choose" data-mr-choose>' +
        '<div class="mr-opts">' +
          '<div class="mr-opt" data-opt="join">' +
            tileHTML('join', ICON_JOIN) +
            '<div class="mr-panel mr-panel-join" id="mr-panel-join" role="region" aria-labelledby="mr-tile-join" hidden>' +
              '<form class="mr-pform mr-join-form" role="search" novalidate>' +
                '<label class="mr-field"><span class="mr-label-find"></span>' +
                  '<input type="search" class="mr-input mr-tfilter" maxlength="' + TABLE_MAX + '" autocomplete="off"></label>' +
                '<p class="mr-findhint"></p>' +
                '<p class="mr-err mr-join-err" role="alert"></p>' +
                '<div class="mr-list-wrap">' +
                  '<ul class="mr-list" aria-labelledby="mr-tile-join"></ul>' +
                  '<div class="mr-empty" hidden><p class="mr-empty-text"></p></div>' +
                '</div>' +
              '</form>' +
            '</div>' +
          '</div>' +
          '<div class="mr-opt" data-opt="create">' +
            tileHTML('create', ICON_CREATE) +
            '<div class="mr-panel mr-panel-create" id="mr-panel-create" role="region" aria-labelledby="mr-tile-create" hidden>' +
              '<form class="mr-pform mr-create-form" novalidate>' +
                '<div class="mr-grid">' +
                  '<label class="mr-field mr-span2"><span class="mr-label-tname"></span>' +
                    '<input type="text" class="mr-input mr-tname" maxlength="' + TABLE_MAX + '" autocomplete="off"></label>' +
                  '<div class="mr-namerow mr-span2"><p class="mr-namemsg" role="status" aria-live="polite"></p>' +
                    '<button type="button" class="mr-suggest" hidden></button></div>' +
                  '<div class="mr-field"><span class="mr-label-stack"></span>' + stepper('stack') + '</div>' +
                  '<div class="mr-field"><span class="mr-label-blinds"></span>' +
                    seg('sb', [[0.5, '0.5 / 1'], [1, '1 / 1']]) + '</div>' +
                  '<div class="mr-field"><span class="mr-label-blindup"></span>' +
                    seg('blindUp', [[0, '—'], [1, '1'], [2, '2'], [5, '5'], [10, '10']]) + '</div>' +
                  '<div class="mr-field mr-span2"><span class="mr-label-late"></span>' +
                    seg('late', [['start', ''], ['half', ''], ['avg', ''], ['fixed', '']]) +
                    '<div class="mr-latefixed" hidden>' + stepper('lateFixed') + '</div></div>' +
                  '<div class="mr-field mr-span2"><span class="mr-label-spect"></span>' +
                    seg('spect', [['live', ''], ['afterHand', ''], ['off', '']]) + '</div>' +
                '</div>' +
                '<p class="mr-err mr-create-err" role="alert"></p>' +
                '<div class="mr-form-actions"><button type="submit" class="mr-confirm mr-create-go"></button></div>' +
              '</form>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<p class="mr-status" role="status" aria-live="polite"></p>';
    document.body.appendChild(root);
    E.backBtn = root.querySelector('.mr-back');
    E.title = root.querySelector('.mr-title');
    E.meAv = root.querySelector('.mr-me-av');
    E.meName = root.querySelector('.mr-me-name');
    E.meEdit = root.querySelector('.mr-me-edit');
    E.needName = root.querySelector('.mr-needname');
    E.opts = root.querySelector('.mr-opts');
    E.choose = root.querySelector('.mr-choose');
    E.tiles = { join: root.querySelector('#mr-tile-join'), create: root.querySelector('#mr-tile-create') };
    E.panels = { join: root.querySelector('#mr-panel-join'), create: root.querySelector('#mr-panel-create') };
    E.tiles.join.querySelector('.mr-choice-name').textContent = t('rooms.joinTable');
    E.tiles.join.querySelector('.mr-choice-desc').textContent = t('rooms.joinDesc');
    E.tiles.create.querySelector('.mr-choice-name').textContent = t('rooms.createTable');
    E.tiles.create.querySelector('.mr-choice-desc').textContent = t('rooms.createDesc');
    E.joinForm = root.querySelector('.mr-join-form');
    E.tfilter = root.querySelector('.mr-tfilter');
    E.joinErr = root.querySelector('.mr-join-err');
    E.createForm = root.querySelector('.mr-create-form');
    E.tName = root.querySelector('.mr-tname');
    E.namemsg = root.querySelector('.mr-namemsg');
    E.suggest = root.querySelector('.mr-suggest');
    E.stackVal = root.querySelector('[data-stepval="stack"]');
    E.stackMinus = root.querySelector('[data-step-key="stack"][data-delta="-0.5"]');
    E.stackPlus = root.querySelector('[data-step-key="stack"][data-delta="0.5"]');
    E.lateFixedWrap = root.querySelector('.mr-latefixed');
    E.lateFixedVal = root.querySelector('[data-stepval="lateFixed"]');
    E.lateMinus = root.querySelector('[data-step-key="lateFixed"][data-delta="-0.5"]');
    E.latePlus = root.querySelector('[data-step-key="lateFixed"][data-delta="0.5"]');
    E.createErr = root.querySelector('.mr-create-err');
    E.createBtn = root.querySelector('.mr-create-go');
    E.status = root.querySelector('.mr-status');
    E.rows = root.querySelector('.mr-list');
    E.empty = root.querySelector('.mr-empty');
    E.emptyText = root.querySelector('.mr-empty-text');
    // Labels and buttons (i18n).
    E.title.textContent = t('rooms.mpTitle');
    E.backBtn.setAttribute('aria-label', t('rooms.back'));
    E.backBtn.title = t('rooms.back');
    E.meEdit.textContent = t('rooms.edit');
    root.querySelector('.mr-needname-title').textContent = t('rooms.needName');
    root.querySelector('.mr-needname-desc').textContent = t('rooms.needNameDesc');
    root.querySelector('.mr-needname-go').textContent = t('rooms.openSettings');
    root.querySelector('.mr-label-find').textContent = t('rooms.findTable');
    E.tfilter.placeholder = t('rooms.findPh');
    root.querySelector('.mr-findhint').textContent = t('rooms.findHint');
    root.querySelector('.mr-label-tname').textContent = t('rooms.tableName');
    root.querySelector('.mr-label-stack').textContent = t('rooms.stack');
    root.querySelector('.mr-label-blinds').textContent = t('rooms.blindsLbl');
    root.querySelector('.mr-label-blindup').textContent = t('rooms.blindUp');
    root.querySelector('.mr-label-late').textContent = t('rooms.lateStack');
    root.querySelector('.mr-label-spect').textContent = t('rooms.spectCards');
    E.createBtn.textContent = t('rooms.createTable');
    E.tName.placeholder = t('rooms.tableNamePh');
    var segTxt = { blindUp: { '0': t('rooms.off') },
      late: { start: t('rooms.lateStart'), half: t('rooms.lateHalf'), avg: t('rooms.lateAvg'), fixed: t('rooms.lateFixed') },
      spect: { live: t('rooms.spLive'), afterHand: t('rooms.spAfter'), off: t('rooms.off') } };
    Array.prototype.forEach.call(root.querySelectorAll('[data-seg]'), function (g) {
      var key = g.getAttribute('data-seg');
      Array.prototype.forEach.call(g.querySelectorAll('button'), function (b) {
        var v = b.getAttribute('data-v');
        if (segTxt[key] && segTxt[key][v] !== undefined) b.textContent = segTxt[key][v];
      });
    });
    E.emptyText.textContent = t('rooms.empty');
    setOpen(null, false);
    renderForm();
    refresh();

    root.addEventListener('click', function (ev) {
      var target = ev.target;
      var j = target.closest ? target.closest('[data-join]') : null;
      if (j) { join(j.getAttribute('data-join')); return; }
      var row = target.closest ? target.closest('.mr-row') : null;
      if (row && row.getAttribute('data-room')) { join(row.getAttribute('data-room')); return; }
      var tile = target.closest ? target.closest('[data-tile]') : null;
      if (tile) { setOpen(openOpt === tile.getAttribute('data-tile') ? null : tile.getAttribute('data-tile'), true); return; }
      var sg = target.closest ? target.closest('[data-seg] button') : null;
      if (sg) {
        var key = sg.parentNode.getAttribute('data-seg');
        var val = sg.getAttribute('data-v');
        form[key] = key === 'late' || key === 'spect' ? val : Number(val);
        renderForm();
        return;
      }
      var st = target.closest ? target.closest('[data-step-key]') : null;
      if (st) {
        var k = st.getAttribute('data-step-key');
        if (k === 'stack') stepForm('stack', Number(st.getAttribute('data-delta')), 5, 1000);
        else stepForm('lateFixed', Number(st.getAttribute('data-delta')), 5, 1000);
        return;
      }
      var sug = target.closest ? target.closest('.mr-suggest') : null;
      if (sug && !sug.hidden) {
        E.tName.value = sug.getAttribute('data-name') || '';
        E.suggest.hidden = true;
        scheduleCheck(true);
        E.tName.focus();
        return;
      }
      if (target.closest && target.closest('.mr-needname-go')) { openSettingsUser(); return; }
      if (target.closest && target.closest('.mr-me-edit')) { openSettingsUser(); return; }
      var b = target.closest ? target.closest('[data-mr]') : null;
      if (!b) return;
      if (b.getAttribute('data-mr') === 'back') {
        if (openOpt) { var k2 = openOpt; setOpen(null, true); E.tiles[k2].focus(); }
        else goBack();
      }
    });
    // Keyboard: Escape collapses the open panel and returns focus to its tile.
    root.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape' || !openOpt) return;
      ev.preventDefault();
      var k = openOpt;
      setOpen(null, true);
      E.tiles[k].focus();
    });
    E.joinForm.addEventListener('submit', joinSubmit);
    E.createForm.addEventListener('submit', createNow);
    E.tfilter.addEventListener('input', function () { E.joinErr.textContent = ''; renderList(); });
    E.tName.addEventListener('input', function () { scheduleCheck(false); });
    E.tName.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') ev.preventDefault(); });
  }

  // Back arrow on the chooser: the main menu.
  function goBack() {
    hide();
    try { window.sessionStorage.removeItem('poker-trainer:mp:session'); } catch (e) { /* storage blocked */ }
    if (window.PokerApp && typeof window.PokerApp.showView === 'function') {
      try { window.PokerApp.showView('menu'); } catch (e) { /* view missing */ }
    }
  }

  function init() {
    if (!document.body) return;
    build();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.PokerRooms = {
    show: show, hide: hide, roomId: roomId, clear: clear,
    // Opens a table by its code (ranked.js). name: used when the player has not set one.
    join: function (id, name) {
      if (name && !window.PokerMP.getName()) window.PokerMP.setName(name);
      join(id);
    },
    intent: function (m) { pendingIntent = m === 'create' || m === 'join' ? m : null; },
  };
})();
