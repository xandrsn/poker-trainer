/* Poker Trainer multiplayer client. Vanilla JS, no libraries.
 * Browser: window.PokerMP (open(), core). Node tests: module.exports = core (pure logic only).
 * Wire protocol: MP_PROTOCOL.md (JSON over WebSocket at /ws). Cameras: WebRTC mesh; each remote
 * peer is a link with perfect negotiation, signalled through the server's `rtc` relay. */
(function () {
  'use strict';

  var STORE_KEY = 'poker-trainer:mp:v1';
  var USER_KEY = 'poker-trainer:user:v1';   // the player's profile (name, photo): Settings > User
  var STUN_URL = 'stun:stun.l.google.com:19302';
  var TURN_MS = 45000;          // server action timer; only drives the countdown shown
  var MAX_SEATS = 9;
  var NAME_MAX = 16;
  var STACK_MIN_BB = 5;            // starting stacks: 5 to 1000 BB, steps of half a BB (server enforces the same)
  var STACK_MAX_BB = 1000;
  var AVATAR_W = 240;              // profile photos: 4:3, cropped at upload
  var AVATAR_H = 180;
  var AVATAR_MAX_BYTES = 45 * 1024;
  var LINK_TIMEOUT_MS = 8000;     // a WebRTC link not connected after this long switches to the server relay
  var RELAY_W = 192;              // relayed video: 192x144 JPEG, about 8 frames per second
  var RELAY_H = 144;
  var RELAY_FRESH_MS = 1500;      // a relayed sender counts as live for this long after its last frame
  var AUDIO_RATE = 8000;          // relayed audio: 8 kHz mu-law, 100 ms chunks
  var AUDIO_CHUNK = 800;
  var DEFAULT_SETTINGS = { stack: 100000, randomness: 15, stacks: 'default', blindUpMin: 0 };
  var SUIT_GLYPH = { s: '♠', h: '♥', d: '♦', c: '♣' };
  var SUIT_CLASS = { s: 's-s', h: 's-h', d: 's-d', c: 's-c' };
  // Position names by number of seats between BB and the button (index = count).
  // label = list[n - 1 - j] for seat index j >= 3, counted from the seat after BB.
  var MIDDLE = [
    [],
    ['CO'],
    ['CO', 'HJ'],
    ['CO', 'HJ', 'UTG'],
    ['CO', 'HJ', 'LJ', 'UTG'],
    ['CO', 'HJ', 'LJ', 'UTG+1', 'UTG'],
    ['CO', 'HJ', 'LJ', 'UTG+2', 'UTG+1', 'UTG']
  ];

  // ------------------------------------------------------------------
  // Pure logic (tested in test/mp-client.test.js)
  // ------------------------------------------------------------------
  function noop() {}
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // 100000 -> "100k", 99500 -> "99.5k", 1234567 -> "1.2M", 500 -> "500".
  function formatChips(n) {
    var v = Math.round(Number(n) || 0);
    var sign = v < 0 ? '-' : '';
    v = Math.abs(v);
    if (v < 1000) return sign + v;
    var div = v < 999950 ? 1000 : 1000000;
    var unit = div === 1000 ? 'k' : 'M';
    var x = Math.round(v / div * 10) / 10;
    return sign + (x % 1 === 0 ? String(x) : x.toFixed(1)) + unit;
  }

  // Every displayed amount is in big blinds: chips / bb, one decimal at most ("12.5 BB", "3 BB").
  // Same chips and bb always give the same text (EN and ES alike, '.' as the decimal mark).
  function fmtBB(chips, bb, bare) {
    var b = Number(bb) > 0 ? Number(bb) : 0;
    var v = Math.round(Number(chips) || 0);
    if (!b) return String(v) + ' chips';
    var x = Math.round(v / b * 10) / 10;
    if (x === 0) x = 0; // no "-0 BB"
    var num = x % 1 === 0 ? String(x) : x.toFixed(1);
    return bare ? num : num + ' BB';
  }

  // Chips typed in BB (decimal allowed, one place) back to whole chips at this bb.
  function bbToChips(bbAmt, bb) {
    return Math.round((Number(bbAmt) || 0) * (Number(bb) || 0));
  }

  // A starting stack in whole chips: 5 to 1000 BB, in steps of half a BB.
  function stackOk(chips, bb) {
    bb = Number(bb) || 0;
    return Number.isInteger(chips) && bb > 0 && chips >= STACK_MIN_BB * bb && chips <= STACK_MAX_BB * bb && (chips * 2) % bb === 0;
  }

  function clampAmount(v, min, max) {
    var n = Math.round(Number(v));
    if (!isFinite(n)) n = min;
    return Math.min(max, Math.max(min, n));
  }

  // Trimmed name of 1 to 16 characters, or '' when invalid.
  function cleanName(s) {
    var t = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
    return t.length >= 1 && t.length <= NAME_MAX ? t : '';
  }

  // Deterministic background colour for a name (placeholder tiles and avatars without a photo).
  function nameColor(name) {
    var h = 0;
    var str = String(name || '');
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return 'hsl(' + (h % 360) + ' 38% 30%)';
  }

  function initials(name) {
    var words = String(name || '').trim().split(/\s+/).slice(0, 2);
    var out = words.map(function (w) { return w.charAt(0).toUpperCase(); }).join('');
    return out || '?';
  }

  // 'As' -> { rank: 'A', glyph, cls }. Ranks 'T' show as 10. Returns null for bad input.
  function cardInfo(code) {
    if (typeof code !== 'string' || code.length < 2) return null;
    var r = code.charAt(0).toUpperCase();
    var s = code.charAt(1).toLowerCase();
    if (!SUIT_GLYPH[s]) return null;
    return { rank: r === 'T' ? '10' : r, glyph: SUIT_GLYPH[s], cls: SUIT_CLASS[s] };
  }

  // Position label for each seat, derived from the dealer button.
  function positionLabels(seatNums, dealerSeat) {
    var seats = seatNums.slice().sort(function (a, b) { return a - b; });
    var n = seats.length;
    var out = {};
    if (n === 0) return out;
    var d = seats.indexOf(dealerSeat);
    if (d < 0) d = 0;
    var order = [];
    for (var i = 0; i < n; i++) order.push(seats[(d + i) % n]);
    out[order[0]] = 'BTN';
    if (n === 1) return out;
    if (n === 2) { out[order[1]] = 'BB'; return out; }
    out[order[1]] = 'SB';
    out[order[2]] = 'BB';
    var list = MIDDLE[n - 3] || MIDDLE[MIDDLE.length - 1];
    for (var j = 3; j < n; j++) out[order[j]] = list[n - 1 - j] || '';
    return out;
  }

  // Seat position in percent of the table box. The local seat sits at the bottom.
  function seatPoint(seat, mySeat) {
    var base = mySeat == null ? 0 : mySeat;
    var rel = (((seat - base) % MAX_SEATS) + MAX_SEATS) % MAX_SEATS;
    var a = Math.PI / 2 + rel * 2 * Math.PI / MAX_SEATS;
    return { x: 50 + 44 * Math.cos(a), y: 50 + 40 * Math.sin(a) };
  }

  // rnd in [0,1) gives the +-30% jitter; the default 0.5 is the plain exponential delay.
  function reconnectDelay(attempt, rnd) {
    var a = Math.max(1, attempt | 0);
    var base = Math.min(8000, 600 * Math.pow(1.7, a - 1));
    var r = rnd == null ? 0.5 : rnd;
    return Math.min(8000, Math.round(base * (0.7 + 0.6 * r)));
  }

  function turnKey(hand) {
    return hand ? [hand.id, hand.street, hand.toAct].join('|') : '';
  }

  function turnRemaining(start, now) {
    return Math.max(0, TURN_MS - Math.max(0, now - start));
  }

  // Time left on a server clock snapshot: frozen while paused, otherwise counted down from the receipt time.
  function remainingFrom(leftMs, at, now, paused) {
    if (leftMs == null || !isFinite(Number(leftMs))) return null;
    if (paused) return Math.max(0, Number(leftMs));
    return Math.max(0, Number(leftMs) - Math.max(0, now - at));
  }

  function clockText(ms) {
    var t = Math.max(0, Math.ceil(Number(ms) / 1000));
    var m = Math.floor(t / 60);
    var s = t % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function groupDigits(n) {
    var v = Math.round(Number(n) || 0);
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function heroSeat(state) {
    return state && state.me && state.me.seat != null ? state.me.seat : null;
  }

  function isMyTurn(state) {
    var h = state && state.hand;
    var me = heroSeat(state);
    return !!(h && h.legal && me != null && h.toAct === me);
  }

  // Raise bounds are "raise to" totals for this street, from the server's legal field.
  function raiseBounds(hand) {
    var l = hand && hand.legal;
    if (!l || !l.raise || l.minRaiseTo == null || l.maxRaiseTo == null) return null;
    return { min: Number(l.minRaiseTo), max: Number(l.maxRaiseTo) };
  }

  // Quick sizes as raise-to totals: min, half pot, pot and all-in, clamped to the legal range.
  function raisePresets(hand, myBet) {
    var b = raiseBounds(hand);
    if (!b) return null;
    var toCall = Number(hand.toCall) || 0;
    var potAfterCall = (Number(hand.pot) || 0) + toCall;
    var base = (Number(myBet) || 0) + toCall;
    function at(frac) { return clampAmount(base + frac * potAfterCall, b.min, b.max); }
    return { min: b.min, half: at(0.5), threeq: at(0.75), pot: at(1), allin: b.max };
  }

  // Rank and distance from the average of the seated players' stacks.
  function rankInfo(stacks, stack) {
    var all = (stacks || []).map(Number).filter(function (v) { return isFinite(v); });
    var n = all.length;
    var avg = n ? all.reduce(function (a, b) { return a + b; }, 0) / n : 0;
    var rank = 1 + all.filter(function (v) { return v > stack; }).length;
    var pct = avg > 0 ? Math.round((stack - avg) / avg * 100) : 0;
    return { rank: rank, of: n, pct: pct };
  }

  // Human clientIds that should have a camera link: server peers plus connected humans in the lobby.
  function peerIds(players, ids, myId) {
    var out = [];
    var seen = {};
    function add(id) {
      if (id && id !== myId && !seen[id]) { seen[id] = true; out.push(id); }
    }
    (Array.isArray(ids) ? ids : []).forEach(add);
    (Array.isArray(players) ? players : []).forEach(function (p) {
      if (!p.bot && p.connected && p.clientId) add(p.clientId);
    });
    return out;
  }

  // Bytes of a data: URL's payload (base64 decoded length).
  function dataUrlBytes(s) {
    var str = String(s || '');
    var i = str.indexOf(',');
    if (i < 0) return 0;
    return Math.floor((str.length - i - 1) * 3 / 4);
  }

  // encode(quality) returns a data URL. Picks the highest quality that fits maxBytes, or null.
  function pickAvatar(encode, maxBytes) {
    var qs = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35];
    for (var i = 0; i < qs.length; i++) {
      var u = encode(qs[i]);
      if (u && dataUrlBytes(u) <= maxBytes) return u;
    }
    return null;
  }

  function initialState() {
    return { me: null, settings: clone(DEFAULT_SETTINGS), players: [], peers: [], hand: null, error: '', paused: false, standings: [], gameOverId: 0 };
  }

  // Applies one server message to the state and returns a new state object.
  function reduce(state, msg) {
    if (!msg || typeof msg !== 'object') return state;
    switch (msg.t) {
      case 'welcome': {
        var you = msg.you || {};
        return Object.assign({}, state, {
          roomName: typeof msg.name === 'string' ? msg.name : state.roomName,
          me: {
            clientId: you.clientId || null,
            seat: you.seat == null ? null : you.seat,
            name: you.name || '',
            host: !!you.host
          },
          settings: Object.assign({}, state.settings, msg.settings || {}),
          error: ''
        });
      }
      case 'lobby': {
        var players = Array.isArray(msg.players) ? msg.players : [];
        var me = state.me;
        if (me && me.clientId) {
          var p = players.filter(function (q) { return q.clientId === me.clientId; })[0];
          if (p) me = Object.assign({}, me, { seat: p.seat == null ? null : p.seat, host: !!p.host, name: p.name || me.name });
        }
        var next = Object.assign({}, state, {
          me: me,
          roomName: typeof msg.name === 'string' ? msg.name : state.roomName,
          players: players,
          spectators: Array.isArray(msg.spectators) ? msg.spectators : [],
          settings: Object.assign({}, state.settings, msg.settings || {})
        });
        if (msg.paused !== undefined) {
          next.paused = !!msg.paused;
          next.pauseInfo = msg.paused && typeof msg.paused === 'object' ? msg.paused : null;
        }
        return next;
      }
      case 'state': {
        var hand = msg.hand || null;
        var out = Object.assign({}, state, { hand: hand });
        if (hand && hand.paused !== undefined) {
          out.paused = !!hand.paused;
          out.pauseInfo = hand.paused && typeof hand.paused === 'object' ? hand.paused : null;
        }
        if (msg.paused !== undefined) {
          out.paused = !!msg.paused;
          out.pauseInfo = msg.paused && typeof msg.paused === 'object' ? msg.paused : null;
        }
        return out;
      }
      case 'peers':
        return Object.assign({}, state, { peers: Array.isArray(msg.ids) ? msg.ids.slice() : [] });
      case 'gameOver':
        return Object.assign({}, state, {
          standings: Array.isArray(msg.standings) ? msg.standings : [],
          gameOverId: (state.gameOverId || 0) + 1
        });
      case 'error':
        return Object.assign({}, state, { error: String(msg.msg || 'error') });
      default:
        return state;
    }
  }

  // Perfect negotiation (MDN pattern). opts: { pc, polite, send(data) }. The result exposes
  // onNegotiationNeeded and onIceCandidate (wire to the pc events) and onSignal(data).
  // ICE candidates that arrive before the remote description are queued and added after it.
  function createNegotiator(opts) {
    var pc = opts.pc;
    var send = opts.send;
    var n = { polite: !!opts.polite, makingOffer: false, ignoreOffer: false, pendingAnswer: false, lastError: null, queue: [] };
    n.onNegotiationNeeded = async function () {
      try {
        n.makingOffer = true;
        await pc.setLocalDescription();
        send({ description: pc.localDescription });
      } catch (e) {
        n.lastError = e;   // glare or a closed connection; the next negotiationneeded retries
      } finally {
        n.makingOffer = false;
      }
    };
    n.onIceCandidate = function (ev) {
      if (ev && ev.candidate) send({ candidate: ev.candidate });
    };
    function addCand(c) {
      if (!pc.remoteDescription) { n.queue.push(c); return Promise.resolve(); }
      return pc.addIceCandidate(c).catch(function (err) { if (!n.ignoreOffer) n.lastError = err; });
    }
    function flush() {
      var q = n.queue;
      n.queue = [];
      return q.reduce(function (p, c) { return p.then(function () { return addCand(c); }); }, Promise.resolve());
    }
    n.onSignal = async function (data) {
      if (!data) return;
      try {
        if (data.description) {
          var desc = data.description;
          var ready = !n.makingOffer && (pc.signalingState === 'stable' || n.pendingAnswer);
          var collision = desc.type === 'offer' && !ready;
          n.ignoreOffer = !n.polite && collision;
          if (n.ignoreOffer) return;
          n.pendingAnswer = desc.type === 'answer';
          await pc.setRemoteDescription(desc);
          n.pendingAnswer = false;
          await flush();
          if (desc.type === 'offer') {
            await pc.setLocalDescription();
            send({ description: pc.localDescription });
          }
        } else if (data.candidate) {
          if (n.ignoreOffer && pc.remoteDescription) return;   // candidates of a rejected offer
          await addCand(data.candidate);
        }
      } catch (err) {
        n.lastError = err;
      }
    };
    return n;
  }

  function swapTrack(sender, track) {
    try {
      var r = sender.replaceTrack(track);
      if (r && r.catch) r.catch(noop);
    } catch (e) { /* sender closed */ }
  }

  // Connection state of a link as the UI shows it: connecting, connected, failed or closed.
  function linkStatus(link) {
    if (link && link.noRtc) return 'relay';
    if (!link || link.closed) return 'closed';
    var st = link.pc.connectionState || link.pc.iceConnectionState || 'new';
    if (st === 'connected' || st === 'completed') return 'connected';
    if (st === 'failed') return 'failed';
    return 'connecting';
  }

  // One WebRTC link to a remote peer. Video and audio transceivers exist from the start (sendrecv),
  // so camera and mic come on and off with replaceTrack and never need renegotiation. Remote video
  // and remote audio are kept in separate streams: the video element is muted, sound plays from a
  // dedicated <audio> element. One ICE restart is tried before the link is given up (see onLinkTimeout).
  // opts: { makePC(config), makeStream(), remoteId, polite, config, send(data), onChange(link) }
  function createPeerLink(opts) {
    var pc = opts.makePC(opts.config || { iceServers: [{ urls: STUN_URL }], iceCandidatePoolSize: 4 });
    var link = {
      id: opts.remoteId, pc: pc, stream: opts.makeStream(), audStream: opts.makeStream(),
      camera: false, mic: false, seenMedia: false, closed: false, lastError: null,
      restarted: false, needsRelay: false, log: [], path: '', audioEl: null, aAn: null
    };
    function changed() { if (opts.onChange) opts.onChange(link); }
    function note(what) {
      link.log.push(String(Date.now() % 100000) + ' ' + what);
      if (link.log.length > 16) link.log.shift();
    }
    link.vTx = pc.addTransceiver('video', { direction: 'sendrecv' });
    link.aTx = pc.addTransceiver('audio', { direction: 'sendrecv' });
    link.neg = createNegotiator({
      pc: pc,
      polite: !!opts.polite,
      send: function (d) { opts.send(d); }
    });
    pc.onnegotiationneeded = link.neg.onNegotiationNeeded;
    pc.onicecandidate = function (ev) {
      if (ev && ev.candidate) note('cand:' + (ev.candidate.type || 'raw'));
      link.neg.onIceCandidate(ev);
    };
    pc.oniceconnectionstatechange = function () { note('ice:' + pc.iceConnectionState); changed(); };
    pc.onconnectionstatechange = function () {
      note('conn:' + pc.connectionState);
      if (pc.connectionState === 'failed') link.restart();
      changed();
    };
    pc.ontrack = function (ev) {
      if (!ev || !ev.track) return;
      var s = ev.track.kind === 'audio' ? link.audStream : link.stream;
      if (s.getTracks().indexOf(ev.track) < 0) s.addTrack(ev.track);
      note('track:' + ev.track.kind);
      changed();
    };
    link.restart = function () {
      if (link.closed || link.restarted) return false;
      link.restarted = true;
      note('restart');
      try { pc.restartIce(); } catch (e) { return false; }
      return true;
    };
    // Candidate types of the selected pair, e.g. "host / srflx" or "relay / host" (for the debug line).
    link.pathInfo = function () {
      return pc.getStats().then(function (st) {
        var byId = {};
        var out = { local: '', remote: '' };
        st.forEach(function (r) { byId[r.id] = r; });
        st.forEach(function (r) {
          if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') {
            var l = byId[r.localCandidateId];
            var rm = byId[r.remoteCandidateId];
            out.local = l ? l.candidateType : '';
            out.remote = rm ? rm.candidateType : '';
          }
        });
        link.path = out.local && out.remote ? out.local + ' / ' + out.remote : '';
        return link.path;
      }, function () { return link.path; });
    };
    link.setLocalTracks = function (video, audio) {
      swapTrack(link.vTx.sender, video || null);
      swapTrack(link.aTx.sender, audio || null);
    };
    link.signal = function (data) { return link.neg.onSignal(data); };
    link.status = function () { return linkStatus(link); };
    link.close = function () {
      if (link.closed) return;
      link.closed = true;
      try { pc.close(); } catch (e) { /* already closed */ }
    };
    return link;
  }

  // G.711 mu-law: one byte per sample, the usual 8 kHz voice codec. Used for relayed audio.
  function mulawEncode(s) {
    var sign = s < 0 ? 0x80 : 0;
    var v = Math.min(32635, Math.round(Math.abs(s) * 32767)) + 132;
    var exp = 7;
    for (var m = 0x4000; (v & m) === 0 && exp > 0; m >>= 1) exp--;
    var mant = (v >> (exp + 3)) & 0x0f;
    return ~(sign | (exp << 4) | mant) & 0xff;
  }

  function mulawDecode(u) {
    u = ~u & 0xff;
    var exp = (u >> 4) & 0x07;
    var mant = u & 0x0f;
    var v = (((mant << 3) + 132) << exp) - 132;
    return ((u & 0x80) ? -v : v) / 32768;
  }

  function encodeMulaw(samples) {
    var out = new Uint8Array(samples.length);
    for (var i = 0; i < samples.length; i++) out[i] = mulawEncode(samples[i]);
    return out;
  }

  function decodeMulaw(bytes) {
    var out = new Float32Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) out[i] = mulawDecode(bytes[i]);
    return out;
  }

  // Box-average decimation from inRate to outRate (a partial last sample is dropped).
  function downsample(input, inRate, outRate) {
    var ratio = inRate / outRate;
    var n = Math.floor(input.length / ratio);
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var a = Math.floor(i * ratio);
      var b = Math.min(input.length, Math.floor((i + 1) * ratio));
      var sum = 0;
      var c = 0;
      for (var j = a; j < b; j++) { sum += input[j]; c++; }
      out[i] = c ? sum / c : 0;
    }
    return out;
  }

  // Client -> server media frame: [type u8][payload]. Server -> client: [type u8][seat u8][payload].
  function packFrame(type, payload) {
    var out = new Uint8Array(payload.length + 1);
    out[0] = type;
    out.set(payload, 1);
    return out;
  }

  function parseFrame(bytes) {
    if (!bytes || bytes.length < 2) return null;
    var type = bytes[0];
    if (type < 1 || type > 4) return null;
    return { type: type, seat: bytes[1], payload: bytes.subarray(2) };
  }

  // True when a link should fall back to the server relay: it failed, or it is still not
  // connected LINK_TIMEOUT_MS after it started.
  function relayNeeded(status, startedAt, now, timeoutMs) {
    if (status === 'connected' || status === 'relay' || status === 'closed') return false;
    return status === 'failed' || now - startedAt >= timeoutMs;
  }

  // Camera tile grid: among 1 to 3 columns, the layout with the largest tiles that fit the area
  // and keep a landscape ratio (1.2 to 2.4). Tiles never go below minW wide when there is more than
  // one column. Returns { cols, rows, w, h } in px.
  function camLayout(n, areaW, areaH, gap, minW) {
    var best = null;
    var fallback = null;
    for (var cols = 1; cols <= 3; cols++) {
      if (cols > Math.max(1, n)) break;
      var colW = Math.floor((areaW - (cols - 1) * gap) / cols);
      if (cols > 1 && colW < minW) continue;
      var rows = Math.max(1, Math.ceil(Math.max(1, n) / cols));
      var h = Math.min(colW * 9 / 16 * 1.6, (areaH - (rows - 1) * gap) / rows);
      if (!(h > 0) || !(colW > 0)) continue;
      var cand = { cols: cols, rows: rows, w: colW, h: Math.floor(h), area: colW * h };
      if (colW / h >= 1.2 && colW / h <= 2.4) { if (!best || cand.area > best.area) best = cand; }
      if (!fallback || cand.area > fallback.area) fallback = cand;
    }
    var pick = best || fallback || { cols: 1, rows: Math.max(1, n), w: Math.max(0, Math.floor(areaW)), h: 0, area: 0 };
    return { cols: pick.cols, rows: pick.rows, w: pick.w, h: pick.h };
  }

  // ------------------------------------------------------------------
  // Relay media: framing and policy (pure; see MP_PROTOCOL.md for the byte layout).
  // ------------------------------------------------------------------
  var CODEC_IDS = { avc: 1, vp8: 2, opus: 3 };
  var KEY_INTERVAL_MS = 2000;      // a keyframe at least this often
  var KEY_REQ_MIN_MS = 1000;       // a receiver asks for a keyframe at most this often
  var BUF_SKIP = 64 * 1024;        // video: no new frame while the socket holds more than this
  var AUDIO_BACKLOG = 32 * 1024;   // audio: dropped (never queued) above this
  var JPEG_W = 360;
  var JPEG_H = 270;
  var JPEG_Q = 0.6;
  var PROBE_PROFILE = { w: 640, h: 480, fps: 30, kbps: 1200 };
  // Chosen by the number of other humans sending to this client (peers) when the call starts.
  var VIDEO_PROFILES = [
    { maxPeers: 1, w: 640, h: 480, fps: 30, kbps: 1200 },
    { maxPeers: 3, w: 640, h: 480, fps: 24, kbps: 900 },
    { maxPeers: 5, w: 480, h: 360, fps: 20, kbps: 500 },
    { maxPeers: Infinity, w: 320, h: 240, fps: 15, kbps: 350 }
  ];
  var OPUS_ENC = { codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 24000, opus: { frameDuration: 20000 } };
  var OPUS_DEC = { codec: 'opus', sampleRate: 48000, numberOfChannels: 1 };
  var JITTER_S = 0.12;             // playback starts this far ahead of the clock
  var SPEAK_RMS = 0.02;            // level above which a tile shows the speaking ring

  // Encoder settings for the WebCodecs video path. avc is Annex B so no decoder description is needed.
  function videoEncoderConfig(codec, p) {
    var cfg = {
      codec: codec === 'avc' ? 'avc1.42E01F' : 'vp8',
      width: p.w, height: p.h, bitrate: p.kbps * 1000, framerate: p.fps, latencyMode: 'realtime'
    };
    if (codec === 'avc') cfg.avc = { format: 'annexb' };
    return cfg;
  }

  // Quality for the number of peers and the bytes queued on the socket. skip: send nothing this tick.
  function chooseVideoProfile(peers, buffered) {
    var n = Math.max(1, Number(peers) || 1);
    var p = VIDEO_PROFILES[VIDEO_PROFILES.length - 1];
    for (var i = 0; i < VIDEO_PROFILES.length; i++) {
      if (n <= VIDEO_PROFILES[i].maxPeers) { p = VIDEO_PROFILES[i]; break; }
    }
    var out = { w: p.w, h: p.h, fps: p.fps, kbps: p.kbps, skip: false };
    var b = Number(buffered) || 0;
    if (b > BUF_SKIP) out.skip = true;
    else if (b > BUF_SKIP / 2) out.fps = Math.max(5, Math.round(out.fps / 2));
    return out;
  }

  function sameProfile(a, b) {
    return !!a && !!b && a.w === b.w && a.h === b.h && a.fps === b.fps && a.kbps === b.kbps;
  }

  // Preference: H.264 baseline, then VP8. sup = { avc: bool, vp8: bool }.
  function pickVideoCodec(sup) {
    if (sup && sup.avc) return 'avc';
    if (sup && sup.vp8) return 'vp8';
    return null;
  }

  function keyframeDue(lastKeyMs, nowMs, intervalMs) {
    return nowMs - lastKeyMs >= intervalMs;
  }

  function keyRequestAllowed(lastReqMs, nowMs) {
    return nowMs - lastReqMs >= KEY_REQ_MIN_MS;
  }

  // True when a delta frame with sequence number seq does not follow prev (a frame was lost).
  function seqGap(prev, seq) {
    return prev != null && ((seq - prev) & 0xffff) !== 1;
  }

  // Client -> server media frame: [type][flags u8][codec u8][seq u16 LE][ts u32 LE ms][data...].
  // flags bit 0 = keyframe. The server replaces nothing but inserts the sender's seat after type.
  function packMedia(type, flags, codec, seq, tsMs, data) {
    var out = new Uint8Array(9 + data.length);
    var t = Math.floor(tsMs) >>> 0;
    out[0] = type;
    out[1] = flags;
    out[2] = codec;
    out[3] = seq & 0xff;
    out[4] = (seq >> 8) & 0xff;
    out[5] = t & 0xff;
    out[6] = (t >>> 8) & 0xff;
    out[7] = (t >>> 16) & 0xff;
    out[8] = (t >>> 24) & 0xff;
    out.set(data, 9);
    return out;
  }

  // Input is the payload that parseFrame returns for a server frame (the bytes after type and seat).
  function parseMediaPayload(p) {
    if (!p || p.length < 8) return null;
    return {
      flags: p[0],
      codec: p[1],
      seq: p[2] | (p[3] << 8),
      ts: (p[4] | (p[5] << 8) | (p[6] << 16) | (p[7] << 24)) >>> 0,
      key: (p[0] & 1) === 1,
      data: p.subarray(8)
    };
  }

  // ICE configuration from GET /rtc-config. Anything malformed falls back to the default STUN server.
  function rtcConfigFrom(j) {
    if (!j || !Array.isArray(j.iceServers) || !j.iceServers.length) {
      return { iceServers: [{ urls: STUN_URL }], iceCandidatePoolSize: 4 };
    }
    return { iceServers: j.iceServers, iceCandidatePoolSize: 4 };
  }

  var core = {
    AUDIO_BACKLOG: AUDIO_BACKLOG,
    BUF_SKIP: BUF_SKIP,
    CODEC_IDS: CODEC_IDS,
    JPEG_H: JPEG_H,
    JPEG_Q: JPEG_Q,
    JPEG_W: JPEG_W,
    KEY_INTERVAL_MS: KEY_INTERVAL_MS,
    OPUS_DEC: OPUS_DEC,
    OPUS_ENC: OPUS_ENC,
    chooseVideoProfile: chooseVideoProfile,
    keyRequestAllowed: keyRequestAllowed,
    keyframeDue: keyframeDue,
    packMedia: packMedia,
    parseMediaPayload: parseMediaPayload,
    rtcConfigFrom: rtcConfigFrom,
    sameProfile: sameProfile,
    seqGap: seqGap,
    videoEncoderConfig: videoEncoderConfig,
    pickVideoCodec: pickVideoCodec,
    camLayout: camLayout,
    mulawEncode: mulawEncode,
    mulawDecode: mulawDecode,
    encodeMulaw: encodeMulaw,
    decodeMulaw: decodeMulaw,
    downsample: downsample,
    packFrame: packFrame,
    parseFrame: parseFrame,
    relayNeeded: relayNeeded,
    LINK_TIMEOUT_MS: LINK_TIMEOUT_MS,
    TURN_MS: TURN_MS,
    STUN_URL: STUN_URL,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    AVATAR_MAX_BYTES: AVATAR_MAX_BYTES,
    formatChips: formatChips,
    fmtBB: fmtBB,
    bbToChips: bbToChips,
    stackOk: stackOk,
    clampAmount: clampAmount,
    cleanName: cleanName,
    initials: initials,
    nameColor: nameColor,
    cardInfo: cardInfo,
    positionLabels: positionLabels,
    seatPoint: seatPoint,
    reconnectDelay: reconnectDelay,
    turnKey: turnKey,
    remainingFrom: remainingFrom,
    clockText: clockText,
    groupDigits: groupDigits,
    turnRemaining: turnRemaining,
    heroSeat: heroSeat,
    isMyTurn: isMyTurn,
    raiseBounds: raiseBounds,
    raisePresets: raisePresets,
    rankInfo: rankInfo,
    peerIds: peerIds,
    dataUrlBytes: dataUrlBytes,
    pickAvatar: pickAvatar,
    initialState: initialState,
    reduce: reduce,
    createNegotiator: createNegotiator,
    createPeerLink: createPeerLink,
    linkStatus: linkStatus
  };

  // ---------- B: chat, custom emoji, toast and bubbles (pure part, tested) ----------
  var EMO_KEY = 'poker-trainer:mp:emoji:v1';
  var EMO_MAX = 12;
  var EMO_BYTES = 8192;
  var EMO_PREFIX = 'data:image/png;base64,';
  var EMO_ID_RE = /^[a-z0-9_]{1,12}$/;
  var TOAST_MS = 2500;
  var BUBBLE_MS = 5000;
  var PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function emojiIdOk(id) { return typeof id === 'string' && EMO_ID_RE.test(id); }
  function emojiDataOk(d) {
    return typeof d === 'string' && d.indexOf(EMO_PREFIX) === 0 && dataUrlBytes(d) <= EMO_BYTES &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(d.slice(EMO_PREFIX.length));
  }
  function isPngHeader(bytes) {
    if (!bytes || bytes.length < 8) return false;
    for (var i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return false;
    return true;
  }
  // Keeps valid entries only: unique ids, PNG data URLs within 8 KB, at most 12.
  function cleanEmojiSet(list) {
    var out = [], seen = {};
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length && out.length < EMO_MAX; i++) {
      var e = list[i];
      if (!e || typeof e !== 'object') continue;
      if (!emojiIdOk(e.id) || !emojiDataOk(e.data) || seen[e.id]) continue;
      seen[e.id] = true;
      out.push({ id: e.id, data: e.data });
    }
    return out;
  }
  // Corrupt or missing localStorage gives an empty set; never throws.
  function loadEmojiSet(raw) {
    if (!raw) return [];
    try { return cleanEmojiSet(JSON.parse(raw)); } catch (err) { return []; }
  }
  function packOf(set) {
    var out = {};
    cleanEmojiSet(set).forEach(function (e) { out[e.id] = e.data; });
    return out;
  }
  function packHas(pack, id) {
    return !!pack && Object.prototype.hasOwnProperty.call(pack, id) && emojiDataOk(pack[id]);
  }
  // Unicode emoji run (with variation selectors, skin tones, ZWJ sequences, flags) or a custom ':id:'.
  var UNI_EMO = '(?:\\p{Extended_Pictographic}|\\p{Regional_Indicator})[\\uFE0E\\uFE0F\\u{1F3FB}-\\u{1F3FF}\\u20E3]*' +
    '(?:\\u200D(?:\\p{Extended_Pictographic}|\\p{Regional_Indicator})[\\uFE0E\\uFE0F\\u{1F3FB}-\\u{1F3FF}\\u20E3]*)*';
  // Splits text into {t:'txt'|'img'|'uni', v}; custom ids stay text unless the sender's pack has them as PNG.
  function tokens(text, pack) {
    var s = String(text == null ? '' : text), out = [], last = 0, m;
    var re = new RegExp(':([a-z0-9_]{1,12}):|(' + UNI_EMO + ')', 'gu');
    while ((m = re.exec(s))) {
      if (m[2] === undefined && !packHas(pack, m[1])) continue;
      if (m.index > last) out.push({ t: 'txt', v: s.slice(last, m.index) });
      if (m[2] !== undefined) out.push({ t: 'uni', v: m[2] });
      else out.push({ t: 'img', v: m[0], id: m[1] });
      last = m.index + m[0].length;
    }
    if (last < s.length) out.push({ t: 'txt', v: s.slice(last) });
    return out;
  }
  // Escapes everything; custom ':id:' becomes an <img>, Unicode emoji runs get a sized span.
  function renderEmojiText(text, pack, big) {
    return tokens(text, pack).map(function (k) {
      if (k.t === 'img') return '<img class="mp-emoji' + (big ? ' big' : '') + '" src="' + escHtml(pack[k.id]) + '" alt="' + escHtml(k.v) + '">';
      if (k.t === 'uni') return '<span class="mp-uemo' + (big ? ' big' : '') + '">' + escHtml(k.v) + '</span>';
      return escHtml(k.v);
    }).join('');
  }
  // Only emoji (custom or Unicode), no other text: rendered big.
  function isOnlyEmoji(text, pack) {
    var toks = tokens(text, pack), has = false;
    for (var i = 0; i < toks.length; i++) {
      if (toks[i].t === 'txt') { if (/\S/.test(toks[i].v)) return false; }
      else has = true;
    }
    return has;
  }
  // History never toasts or bubbles. A new message toasts only when the chat is not visible.
  function chatEffects(history, chatVisible) {
    return { toast: !history && !chatVisible, bubble: !history };
  }
  function toastText(name, text) {
    return String(name || '') + ': ' + String(text || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  }
  function bubbleLive(b, now) { return !!b && now - b.at < BUBBLE_MS; }
  // Returns {set} or {err: 'id' | 'size' | 'max' | 'dup'} without changing the input.
  function emojiAdd(set, id, data) {
    if (!emojiIdOk(id)) return { err: 'id' };
    if (!emojiDataOk(data)) return { err: 'size' };
    if (set.length >= EMO_MAX) return { err: 'max' };
    if (set.some(function (e) { return e.id === id; })) return { err: 'dup' };
    return { set: set.concat([{ id: id, data: data }]) };
  }
  function emojiRemove(set, id) {
    return set.filter(function (e) { return e.id !== id; });
  }
  // Removes an opaque background from RGBA pixels (Uint8ClampedArray, w*h*4), in place.
  // Only when all four corners are opaque: flood fill from the border through pixels within
  // BG_TOL of the corner colour, making them transparent. Images that already have alpha are kept.
  var BG_TOL = 28;
  function knockOutBg(px, w, h) {
    if (!px || w < 2 || h < 2 || px.length < w * h * 4) return px;
    var corners = [0, w - 1, (h - 1) * w, h * w - 1];
    for (var c = 0; c < 4; c++) if (px[corners[c] * 4 + 3] < 250) return px;
    var r = 0, g = 0, b = 0;
    for (c = 0; c < 4; c++) { r += px[corners[c] * 4]; g += px[corners[c] * 4 + 1]; b += px[corners[c] * 4 + 2]; }
    r /= 4; g /= 4; b /= 4;
    var seen = new Uint8Array(w * h), stack = [];
    function near(i) {
      var k = i * 4;
      return Math.abs(px[k] - r) <= BG_TOL && Math.abs(px[k + 1] - g) <= BG_TOL && Math.abs(px[k + 2] - b) <= BG_TOL;
    }
    for (var x = 0; x < w; x++) { stack.push(x, (h - 1) * w + x); }
    for (var y = 0; y < h; y++) { stack.push(y * w, y * w + w - 1); }
    while (stack.length) {
      var i = stack.pop();
      if (seen[i] || !near(i)) continue;
      seen[i] = 1;
      px[i * 4 + 3] = 0;
      var ix = i % w;
      if (ix > 0) stack.push(i - 1);
      if (ix < w - 1) stack.push(i + 1);
      if (i >= w) stack.push(i - w);
      if (i < w * (h - 1)) stack.push(i + w);
    }
    return px;
  }
  core.chat = {
    knockOutBg: knockOutBg,
    EMO_KEY: EMO_KEY, EMO_MAX: EMO_MAX, EMO_BYTES: EMO_BYTES, TOAST_MS: TOAST_MS, BUBBLE_MS: BUBBLE_MS,
    escHtml: escHtml, emojiIdOk: emojiIdOk, emojiDataOk: emojiDataOk, isPngHeader: isPngHeader,
    cleanEmojiSet: cleanEmojiSet, loadEmojiSet: loadEmojiSet, packOf: packOf,
    renderEmojiText: renderEmojiText, isOnlyEmoji: isOnlyEmoji, chatEffects: chatEffects,
    toastText: toastText, bubbleLive: bubbleLive, emojiAdd: emojiAdd, emojiRemove: emojiRemove
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  if (typeof document === 'undefined') return;

  // ------------------------------------------------------------------
  // Strings. Merged into window.I18N when it supports extend(); t() falls back to I18N.t.
  // ------------------------------------------------------------------
  var MP = {
    en: {
      'mp.hp.game': 'Game',
      'mp.hp.bots': 'Bots',
      'mp.tab.players': 'Players',
      'mp.title': 'Multiplayer table',
      'mp.intro': 'Join the shared table. Anyone with this link sits at the same table.',
      'mp.nameLabel': 'Your name',
      'mp.namePh': 'Up to 16 characters',
      'mp.nameRequired': 'Enter a name of 1 to 16 characters.',
      'mp.join': 'Join the table',
      'mp.connecting': 'Connecting...',
      'mp.online': 'Online',
      'mp.reconnecting': 'Reconnecting...',
      'mp.offline': 'Offline',
      'mp.players': 'Players ({n})',
      'mp.you': 'you',
      'mp.host': 'Host',
      'mp.profile': 'Profile',
      'mp.saveProfile': 'Save profile',
      'mp.saved': 'Saved.',
      'mp.photo.upload': 'Upload photo',
      'mp.photo.take': 'Take photo',
      'mp.photo.remove': 'Remove photo',
      'mp.photo.capture': 'Capture',
      'mp.photo.cancel': 'Cancel',
      'mp.photo.bad': 'That file is not an image.',
      'mp.photo.tooBig': 'That photo is too large even when compressed. Try another.',
      'mp.photo.camTitle': 'Take a photo',
      'mp.settings': 'Table settings',
      'mp.volume': 'Volume',
      'mp.stack': 'Starting stack (BB)',
      'mp.blinds': 'Blinds',
      'mp.pausedBy': 'Game paused by {name}',
      'mp.noAct': 'No connection, action not sent',
      'mp.serverMoved': 'Server may have moved: reload',
      'mp.blindsChip': 'Blinds {sb}/{bb} BB',
      'mp.blindsNext': 'next increase {t}',
      'mp.blindsDoubled': 'Blinds doubled: all stacks now show half as many BB',
      'mp.doubleBlinds': 'Double blinds',
      'mp.blindUp': 'Progressive blinds',
      'mp.blindUpOff': 'Off',
      'mp.spectatorCards': 'Spectator cards',
      'mp.spec.live': 'Live (all seats)',
      'mp.spec.afterHand': 'After hand',
      'mp.spec.off': 'Off',
      'mp.blindUpMin': '{n} min',
      'mp.randomness': 'Randomness',
      'mp.botShowCards': 'Bots show their cards at showdown',
      'mp.out': 'You are out - spectating',
      'mp.role.player': 'Player',
      'mp.role.spec': 'Spectator',
      'mp.showCards': 'Click to show your cards',
      'mp.shown': 'Shown', 'mp.shownFolded': 'Shown to folded players',
      'mp.stacksMode': 'Starting stacks',
      'mp.stacksDefault': 'Same for everyone',
      'mp.stacksCustom': 'Custom per player',
      'mp.stackOf': 'Stack for {name}',
      'mp.settingsInvalid': 'The starting stack must be from 5 to 1000 BB, in steps of 0.5 BB.',
      'mp.bots': 'Bots',
      'mp.addBot': 'Add bot',
      'mp.botStyle': 'Bot Elo',
      'mp.botMix': 'Mixed',
      'mp.botName': 'Name (optional)',
      'mp.editBot': 'Edit bot',
      'mp.saveBot': 'Save bot',
      'mp.edit': 'Edit',
      'mp.cancel': 'Cancel',
      'mp.remove': 'Remove',
      'mp.kick': 'Kick',
      'mp.kicked.title': 'Removed from the table', 'mp.kicked.body': 'The host removed you from the table.', 'mp.kicked.menu': 'Back to the menu', 'mp.leaving': 'Leaving after this hand',
      'mp.start': 'Start',
      'mp.lobby.waitHost': 'Waiting for the host to start the game.',
      'mp.lobby.invite': 'Table code', 'mp.lobby.copy': 'Copy', 'mp.lobby.copied': 'Copied', 'mp.lobby.players': 'Players',
      'mp.lobby.emptySeat': 'Empty seat', 'mp.lobby.status': 'Lobby', 'mp.lobby.statusWait': 'Waiting for host',
      'mp.lobby.counts': '{p} players · {b} bots', 'mp.lobby.botsCount': '{n} bots', 'mp.lobby.tableSettings': 'Table settings',
      'mp.lobby.editSettings': 'Edit settings', 'mp.lobby.doneSettings': 'Done', 'mp.lobby.needTwo': 'Add at least one more player or bot',
      'mp.lobby.startGame': 'Start game',
      'mp.tip.stack': 'Stack {amt} · {rank} of {n} · {rel}',
      'mp.tip.above': '{pct}% above average',
      'mp.tip.below': '{pct}% below average',
      'mp.tip.avg': 'at average',
      'mp.cam.retry': 'Retry camera',
      'mp.cam.off': 'Camera off',
      'mp.ui.camOn': 'Turn camera on',
      'mp.ui.camOff': 'Turn camera off',
      'mp.ui.micOn': 'Turn mic on',
      'mp.ui.micOff': 'Mute',
      'mp.cam.relayed': 'Via server',
      'mp.sound.enable': 'Click to enable sound',
      'mp.showHand': 'Show my hand ({n}s)',
      'mp.chat.title': 'Chat',
      'mp.seg.cams': 'Cams',
      'mp.chat.ph': 'Write a message',
      'mp.chat.send': 'Send',
      'mp.emo.btn': 'Emoji', 'mp.emo.title': 'Your emojis', 'mp.emo.add': 'Add emoji',
      'mp.emo.manage': 'Manage', 'mp.emo.done': 'Done',
      'mp.emo.hint': 'Upload a small PNG (64x64 max) to use it as an emoji.',
      'mp.emo.name': 'Name for this emoji (a-z, 0-9, _; 12 max)',
      'mp.emo.notPng': 'Only PNG files.', 'mp.emo.big': 'That image is too big, even at 32x32.',
      'mp.emo.badName': 'Use a-z, 0-9 and _ (1 to 12 characters).',
      'mp.emo.dup': 'You already have an emoji with that name.', 'mp.emo.max': 'You can have up to 12 emojis.',
      'mp.emo.del': 'Delete :{id}: ?', 'mp.emo.count': '{n}/12',
      'mp.emo.srvBad': 'The server refused that emoji.', 'mp.emo.srvMax': 'Too many emojis.',
      'mp.emo.srvSlow': 'Slow down: your emojis are saved in a moment.',
      'mp.chat.toastLabel': 'New chat message',
      'mp.ext.title': 'External call',
      'mp.ext.save': 'Save link',
      'mp.ext.bad': 'The link must start with https://',
      'mp.lan.title': 'Same network',
      'mp.lan.hint': 'Same Wi-Fi? Use this for the best video quality',
      'mp.lan.copy': 'Copy',
      'mp.lan.none': 'No local address found.',
      'mp.ui.muted': 'Muted',
      'mp.cam.waitRelay': 'Connecting via server...',
      'mp.cam.offline': 'Offline',
      'mp.compat': 'Compatibility mode (media via server)',
      'mp.cam.requesting': 'Asking for camera...',
      'mp.cam.live': 'Live',
      'mp.cam.connecting': 'Connecting...',
      'mp.cam.connected': 'Connected',
      'mp.cam.linkFailed': 'Connection failed',
      'mp.cam.denied': 'Camera blocked by the browser',
      'mp.cam.failed': 'Camera failed to start',
      'mp.cam.none': 'No camera found',
      'mp.cam.noMedia': 'Camera needs an https or localhost address',
      'mp.cam.unsupported': 'This browser does not support cameras.',
      'mp.mic.on': 'Mic on',
      'mp.mic.off': 'Mic off',
      'mp.mic.denied': 'Microphone blocked by the browser',
      'mp.mic.failed': 'Microphone failed to start',
      'mp.mic.noMedia': 'Mic needs an https or localhost address',
      'mp.cam.on': 'Camera on',
      'mp.admin': 'Admin',
      'mp.pause': 'Pause',
      'mp.resume': 'Resume',
      'mp.paused': 'Game paused',
      'mp.resetStacks': 'Reset stacks',
      'mp.endGame': 'End game',
      'mp.confirmEnd': 'End the game for everyone?',
      'mp.endFail': 'Could not end the game. Try again.',
      'mp.standings': 'Final standings',
      'mp.backLobby': 'Back to lobby',
      'mp.fold': 'Fold',
      'mp.check': 'Check',
      'mp.call': 'Call {amt}',
      'mp.raise': 'Raise',
      'mp.raiseTo': 'Raise to {amt}',
      'mp.bet': 'Bet {amt}',
      'mp.q.min': 'Min',
      'mp.q.half': '1/2 pot',
      'mp.q.pot': 'Pot',
      'mp.q.allin': 'All-in',
      'mp.yourTurn': 'Your turn',
      'mp.waiting': 'Waiting for {name}',
      'mp.joinNext': 'You will join next hand',
      'mp.secs': '{n}s',
      'mp.pot': 'Pot {amt}',
      'mp.heroInfo': '{pos} · Stack {amt}',
      'mp.dealer': 'Dealer button',
      'mp.win': '{name}: +{amt}',
      'mp.nextAuto': 'Next hand starts automatically.',
      'mp.act.fold': 'Fold',
      'mp.act.call': 'Call',
      'mp.act.raise': 'Raise',
      'mp.act.check': 'Check',
      'mp.act.limp': 'Limp',
      'mp.act.bet': 'Bet',
      'mp.act.allin': 'All-in',
      'mp.street.preflop': 'Preflop',
      'mp.street.flop': 'Flop',
      'mp.street.turn': 'Turn',
      'mp.street.river': 'River'
    },
    es: {
      'mp.hp.game': 'Partida',
      'mp.hp.bots': 'Bots',
      'mp.tab.players': 'Jugadores',
      'mp.title': 'Mesa multijugador',
      'mp.intro': 'Únete a la mesa compartida. Quien tenga este enlace se sienta en la misma mesa.',
      'mp.nameLabel': 'Tu nombre',
      'mp.namePh': 'Hasta 16 caracteres',
      'mp.nameRequired': 'Escribe un nombre de 1 a 16 caracteres.',
      'mp.join': 'Entrar a la mesa',
      'mp.connecting': 'Conectando...',
      'mp.online': 'En línea',
      'mp.reconnecting': 'Reconectando...',
      'mp.offline': 'Sin conexión',
      'mp.players': 'Jugadores ({n})',
      'mp.you': 'tú',
      'mp.host': 'Anfitrión',
      'mp.profile': 'Perfil',
      'mp.saveProfile': 'Guardar perfil',
      'mp.saved': 'Guardado.',
      'mp.photo.upload': 'Subir foto',
      'mp.photo.take': 'Hacer foto',
      'mp.photo.remove': 'Quitar foto',
      'mp.photo.capture': 'Capturar',
      'mp.photo.cancel': 'Cancelar',
      'mp.photo.bad': 'Ese archivo no es una imagen.',
      'mp.photo.tooBig': 'Esa foto es demasiado grande incluso comprimida. Prueba otra.',
      'mp.photo.camTitle': 'Haz una foto',
      'mp.settings': 'Ajustes de la mesa',
      'mp.volume': 'Volumen',
      'mp.stack': 'Stack inicial (BB)',
      'mp.blinds': 'Ciegas',
      'mp.pausedBy': 'Partida pausada por {name}',
      'mp.noAct': 'Sin conexión, acción no enviada',
      'mp.serverMoved': 'El servidor puede haberse movido: recarga',
      'mp.blindsChip': 'Ciegas {sb}/{bb} BB',
      'mp.blindsNext': 'siguiente subida {t}',
      'mp.blindsDoubled': 'Ciegas dobladas: todas las pilas muestran la mitad de BB',
      'mp.doubleBlinds': 'Doblar ciegas',
      'mp.blindUp': 'Ciegas progresivas',
      'mp.blindUpOff': 'Apagado',
      'mp.spectatorCards': 'Cartas de espectadores',
      'mp.spec.live': 'En vivo (todos los asientos)',
      'mp.spec.afterHand': 'Tras la mano',
      'mp.spec.off': 'Desactivado',
      'mp.blindUpMin': '{n} min',
      'mp.randomness': 'Aleatoriedad',
      'mp.botShowCards': 'Los bots muestran sus cartas en el showdown',
      'mp.out': 'Te quedaste sin fichas - espectador',
      'mp.role.player': 'Jugador',
      'mp.role.spec': 'Espectador',
      'mp.showCards': 'Toca para mostrar tus cartas',
      'mp.shown': 'Mostradas', 'mp.shownFolded': 'Mostradas a los que se retiraron',
      'mp.stacksMode': 'Stacks iniciales',
      'mp.stacksDefault': 'Igual para todos',
      'mp.stacksCustom': 'Personalizado por jugador',
      'mp.stackOf': 'Stack de {name}',
      'mp.settingsInvalid': 'El stack inicial debe estar entre 5 y 1000 BB, en pasos de 0,5 BB.',
      'mp.bots': 'Bots',
      'mp.addBot': 'Añadir bot',
      'mp.botStyle': 'Elo del bot',
      'mp.botMix': 'Variado',
      'mp.botName': 'Nombre (opcional)',
      'mp.editBot': 'Editar bot',
      'mp.saveBot': 'Guardar bot',
      'mp.edit': 'Editar',
      'mp.cancel': 'Cancelar',
      'mp.remove': 'Quitar',
      'mp.kick': 'Expulsar',
      'mp.kicked.title': 'Te han quitado de la mesa', 'mp.kicked.body': 'El anfitrión te ha quitado de la mesa.', 'mp.kicked.menu': 'Volver al menú', 'mp.leaving': 'Sale al terminar esta mano',
      'mp.start': 'Empezar',
      'mp.lobby.waitHost': 'Esperando a que el anfitrión empiece la partida.',
      'mp.lobby.invite': 'Código de mesa', 'mp.lobby.copy': 'Copiar', 'mp.lobby.copied': 'Copiado', 'mp.lobby.players': 'Jugadores',
      'mp.lobby.emptySeat': 'Asiento libre', 'mp.lobby.status': 'Sala de espera', 'mp.lobby.statusWait': 'Esperando al anfitrión',
      'mp.lobby.counts': '{p} jugadores · {b} bots', 'mp.lobby.botsCount': '{n} bots', 'mp.lobby.tableSettings': 'Ajustes de la mesa',
      'mp.lobby.editSettings': 'Editar ajustes', 'mp.lobby.doneSettings': 'Listo', 'mp.lobby.needTwo': 'Añade al menos otro jugador o un bot',
      'mp.lobby.startGame': 'Empezar partida',
      'mp.tip.stack': 'Stack {amt} · {rank} de {n} · {rel}',
      'mp.tip.above': '{pct}% por encima de la media',
      'mp.tip.below': '{pct}% por debajo de la media',
      'mp.tip.avg': 'en la media',
      'mp.cam.retry': 'Reintentar cámara',
      'mp.cam.off': 'Cámara apagada',
      'mp.ui.camOn': 'Activar cámara',
      'mp.ui.camOff': 'Desactivar cámara',
      'mp.ui.micOn': 'Activar micrófono',
      'mp.ui.micOff': 'Silenciar',
      'mp.cam.relayed': 'Vía servidor',
      'mp.sound.enable': 'Toca para activar el sonido',
      'mp.showHand': 'Mostrar mi mano ({n}s)',
      'mp.chat.title': 'Chat',
      'mp.seg.cams': 'Cámaras',
      'mp.chat.ph': 'Escribe un mensaje',
      'mp.chat.send': 'Enviar',
      'mp.emo.btn': 'Emoji', 'mp.emo.title': 'Tus emojis', 'mp.emo.add': 'Añadir emoji',
      'mp.emo.manage': 'Gestionar', 'mp.emo.done': 'Listo',
      'mp.emo.hint': 'Sube un PNG pequeño (64x64 máx.) para usarlo como emoji.',
      'mp.emo.name': 'Nombre del emoji (a-z, 0-9, _; 12 máx.)',
      'mp.emo.notPng': 'Solo archivos PNG.', 'mp.emo.big': 'Esa imagen es demasiado grande, ni a 32x32 cabe.',
      'mp.emo.badName': 'Usa a-z, 0-9 y _ (de 1 a 12 caracteres).',
      'mp.emo.dup': 'Ya tienes un emoji con ese nombre.', 'mp.emo.max': 'Puedes tener hasta 12 emojis.',
      'mp.emo.del': '¿Borrar :{id}: ?', 'mp.emo.count': '{n}/12',
      'mp.emo.srvBad': 'El servidor rechazó ese emoji.', 'mp.emo.srvMax': 'Demasiados emojis.',
      'mp.emo.srvSlow': 'Espera un momento: tus emojis se guardan enseguida.',
      'mp.chat.toastLabel': 'Nuevo mensaje del chat',
      'mp.ext.title': 'Llamada externa',
      'mp.ext.save': 'Guardar enlace',
      'mp.ext.bad': 'El enlace debe empezar por https://',
      'mp.lan.title': 'Misma red',
      'mp.lan.hint': '¿Misma Wi-Fi? Usa esta para la mejor calidad de vídeo',
      'mp.lan.copy': 'Copiar',
      'mp.lan.none': 'No se encontró ninguna dirección local.',
      'mp.ui.muted': 'Silenciado',
      'mp.cam.waitRelay': 'Conectando por el servidor...',
      'mp.cam.offline': 'Sin conexión',
      'mp.compat': 'Modo compatibilidad (media por el servidor)',
      'mp.cam.requesting': 'Pidiendo cámara...',
      'mp.cam.live': 'En directo',
      'mp.cam.connecting': 'Conectando...',
      'mp.cam.connected': 'Conectado',
      'mp.cam.linkFailed': 'Conexión fallida',
      'mp.cam.denied': 'El navegador bloquea la cámara',
      'mp.cam.failed': 'No se pudo iniciar la cámara',
      'mp.cam.none': 'No se encontró cámara',
      'mp.cam.noMedia': 'La cámara necesita una dirección https o localhost',
      'mp.cam.unsupported': 'Este navegador no admite cámaras.',
      'mp.mic.on': 'Micro activado',
      'mp.mic.off': 'Micro apagado',
      'mp.mic.denied': 'El navegador bloquea el micrófono',
      'mp.mic.failed': 'No se pudo iniciar el micrófono',
      'mp.mic.noMedia': 'El micrófono necesita una dirección https o localhost',
      'mp.cam.on': 'Cámara activada',
      'mp.admin': 'Admin',
      'mp.pause': 'Pausar',
      'mp.resume': 'Reanudar',
      'mp.paused': 'Partida pausada',
      'mp.resetStacks': 'Reiniciar stacks',
      'mp.endGame': 'Terminar partida',
      'mp.confirmEnd': '¿Terminar la partida para todos?',
      'mp.endFail': 'No se pudo terminar la partida. Inténtalo de nuevo.',
      'mp.standings': 'Clasificación final',
      'mp.backLobby': 'Volver al lobby',
      'mp.fold': 'Retirarse',
      'mp.check': 'Pasar',
      'mp.call': 'Igualar {amt}',
      'mp.raise': 'Subir',
      'mp.raiseTo': 'Subir a {amt}',
      'mp.bet': 'Apostar {amt}',
      'mp.q.min': 'Mín.',
      'mp.q.half': '1/2 bote',
      'mp.q.pot': 'Bote',
      'mp.q.allin': 'All-in',
      'mp.yourTurn': 'Tu turno',
      'mp.waiting': 'Esperando a {name}',
      'mp.joinNext': 'Entrarás en la próxima mano',
      'mp.secs': '{n} s',
      'mp.pot': 'Bote {amt}',
      'mp.heroInfo': '{pos} · Stack {amt}',
      'mp.dealer': 'Botón de reparto',
      'mp.win': '{name}: +{amt}',
      'mp.nextAuto': 'La siguiente mano empieza sola.',
      'mp.act.fold': 'Retirarse',
      'mp.act.call': 'Igualar',
      'mp.act.raise': 'Subir',
      'mp.act.check': 'Pasar',
      'mp.act.limp': 'Limpar',
      'mp.act.bet': 'Apostar',
      'mp.act.allin': 'All-in',
      'mp.street.preflop': 'Preflop',
      'mp.street.flop': 'Flop',
      'mp.street.turn': 'Turno',
      'mp.street.river': 'River'
    }
  };

  function lang() {
    try {
      var l = window.I18N && typeof window.I18N.lang === 'function' ? window.I18N.lang() : 'en';
      return l === 'es' ? 'es' : 'en';
    } catch (e) { return 'en'; }
  }

  function tr(key, vars) {
    var l = lang();
    var s = (MP[l] && MP[l][key]) || MP.en[key];
    if (s == null) {
      if (window.I18N && typeof window.I18N.t === 'function') return window.I18N.t(key, vars);
      return key;
    }
    if (vars) s = s.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? String(vars[k]) : m; });
    return s;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // The Elo after a name: "(1163)".
  function eloTag(p) { return p.rating != null ? '<span class="mp-elo">(' + esc(p.rating) + ')</span>' : ''; }

  function actLabel(a) {
    var k = String(a || '').toLowerCase();
    var m = k.match(/^(fold|call|raise|check|limp|bet)\b/);
    if (m) return tr('mp.act.' + m[1]) + String(a).slice(m[1].length);
    if (k === 'allin' || k === 'all-in') return tr('mp.act.allin');
    return String(a);
  }

  var ICON = {
    cam: 'M3 7h11v10H3z M15 10.5l6-3.5v10l-6-3.5z',
    mic: 'M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-2.1A7 7 0 0 0 19 12z',
    crown: 'M3 18h18l-1.6-9.5-4.6 4-2.8-5.5-2.8 5.5-4.6-4z'
  };
  function svgIcon(name, on) {
    return '<svg class="mp-ico ' + (on ? 'on' : 'off') + '" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="' +
      ICON[name] + '"/>' + (on ? '' : '<path class="mp-slash" d="M4 4l16 16"/>') + '</svg>';
  }

  function avHtml(src, name, cls) {
    if (src) return '<img class="mp-av ' + cls + '" src="' + esc(src) + '" alt="">';
    return '<span class="mp-av ' + cls + ' init" aria-hidden="true">' + esc(core.initials(name)) + '</span>';
  }
  // A bot's avatar: the network symbol when it has no photo; either way its gloss bubble
  // (SeatCard.bindGloss) opens on hover, focus or tap. Humans keep avHtml.
  function botAvHtml(p, cls) {
    var inner = p.avatar ? avHtml(p.avatar, p.name, cls)
      : (window.SeatCard ? SeatCard.styleAvatarHtml() : avHtml('', p.name, cls));
    return '<span class="gloss-av" data-gloss="style" data-gkey="neural" tabindex="0">' + inner + '</span>';
  }
  function avFor(p, cls) { return p.bot ? botAvHtml(p, cls) : avHtml(p.avatar, p.name, cls); }
  // Last action as a symbol; the hover/focus bubble carries the words (data-gname).
  function actSymHtml(raw) {
    var label = actLabel(raw);
    var act = window.Symbols ? Symbols.actionIcon(raw) : { key: 'other', icon: 'equals' };
    var icon = window.Symbols ? Symbols.svg(act.icon) : '';
    return '<span class="mp-last sym-tag la-' + act.key + '" role="img" aria-label="' + esc(label) + '" data-gloss="action" ' +
      'data-gkey="' + act.key + '" data-gname="' + esc(label) + '" tabindex="0">' + icon + '</span>';
  }

  // ------------------------------------------------------------------
  // Browser state
  // ------------------------------------------------------------------
  var C = {
    lang: '', store: {}, name: '', clientId: '', avatar: '', pAvatar: undefined,
    camPref: false, micPref: false,
    ws: null, status: 'offline', wantConnected: false, attempt: 0, retryTimer: null, pingTimer: null,
    state: core.initialState(), peers: {}, sig: {},
    camStream: null, micStream: null, camOn: false, micOn: false, camBusy: false, camRequesting: false,
    camError: '', micError: '',
    tk: '', turnStart: 0, raiseAmt: null, presets: null,
    pendingKey: null, pendingAt: 0, pendingTimer: null, lastAct: null, resendAfterWelcome: false,
    clk: null, blind: null, rtt: null, lastMsgAt: 0, watchTimer: null,
    fileTarget: 'profile', botEdit: null, seenGameOver: 0, tipSeat: null, tipTimer: null,
    capStream: null, photoErr: '',
    compat: false, rtcOff: false, relayIn: {},
    stats: { vidOut: 0, audOut: 0, bytesOut: 0, vidIn: 0, audIn: 0, inFrames: 0, inBytes: 0, vidBytesIn: 0, audBytesIn: 0,
      vidDropped: 0, keyOut: 0, keyIn: 0, keyReq: 0, decoded: 0, drawn: 0, audDecoded: 0 }
  };
  var E = {};

  function $(id) { return document.getElementById(id); }
  function hasApp() { return !!(window.PokerApp && typeof window.PokerApp.showView === 'function'); }
  function hasRTC() { return typeof RTCPeerConnection !== 'undefined' && !C.rtcOff; }
  // Camera and mic are removed from the multiplayer client: this gate stays closed, so getUserMedia is never called.
  function hasMedia() { return false; }
  function isOpen() { return !!C.ws && C.ws.readyState === 1; }

  function loadStored() {
    try {
      var v = JSON.parse(window.localStorage.getItem(STORE_KEY) || 'null');
      if (v && typeof v === 'object') return v;
    } catch (e) { /* storage blocked */ }
    return {};
  }
  function saveStored() {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(C.store)); } catch (e) { /* storage blocked */ }
  }
  // The player's name and photo live in the shared user record (Settings > User, poker-trainer:user:v1).
  function loadUserRec() {
    try {
      var v = JSON.parse(window.localStorage.getItem(USER_KEY) || 'null');
      if (v && typeof v === 'object') return { name: core.cleanName(v.name), avatar: typeof v.avatar === 'string' && v.avatar.indexOf('data:image/') === 0 ? v.avatar : '' };
    } catch (e) { /* storage blocked */ }
    return null;
  }
  function saveUserRec() {
    try { window.localStorage.setItem(USER_KEY, JSON.stringify({ name: C.name, avatar: C.avatar || '' })); } catch (e) { /* storage blocked */ }
  }
  // Takes the name and photo from the shared record (called on mount and when the screen opens).
  function syncUser() {
    var u = loadUserRec();
    if (!u) return;
    C.name = u.name;
    C.avatar = u.avatar;
    if (E.name) E.name.value = C.name;
  }
  function isRanked() { return !!(C.state.settings && C.state.settings.ranked); }
  function rankedTable() { return isRanked() && C.state.settings.kind === 'table'; }
  function rk(key) { return window.I18N ? window.I18N.t('rk.' + key) : key; }
  function savePrefs() {
    // A ranked seat belongs to the account: its identity is never kept as this browser's own.
    var own = isRanked();
    C.store = {
      clientId: own ? C.store.clientId : C.clientId, token: (own ? C.store.token : C.token) || '',
      camPref: !!C.camPref, micPref: !!C.micPref, compat: !!C.compat
    };
    saveStored();
    saveUserRec();
  }

  // Replaces innerHTML only when the markup changed, so inputs and playing videos are kept.
  function setHtml(el, key, html) {
    if (!el || C.sig[key] === html) return;
    C.sig[key] = html;
    el.innerHTML = html;
  }

  function seatOf(hand, seat) {
    var list = hand && Array.isArray(hand.seats) ? hand.seats : [];
    return list.filter(function (x) { return x.seat === seat; })[0] || null;
  }

  function playerAtSeat(s, seat) {
    return (s.players || []).filter(function (p) { return p.seat === seat && !p.bot; })[0] || null;
  }

  function seatAvatar(s, seat) {
    var x = seatOf(s.hand, seat);
    if (x && x.avatar) return x.avatar;
    if (seat === heroSeat(s)) return C.avatar;
    var p = playerAtSeat(s, seat);
    return p && p.avatar ? p.avatar : '';
  }

  function seatName(s, seat) {
    if (seat == null) return '';
    if (seat === heroSeat(s)) return tr('mp.you');
    var x = seatOf(s.hand, seat);
    return x ? x.name : '';
  }

  function cardHtml(code, size) {
    var base = 'mp-card-face ' + (size || '');
    if (code === null || code === undefined) return '<span class="' + base + ' empty"></span>';
    var c = core.cardInfo(code);
    if (!c) return '<span class="' + base + ' back"></span>';
    return '<span class="' + base + ' ' + c.cls + '"><span class="r">' + c.rank + '</span><span class="s">' + c.glyph + '</span></span>';
  }

  // Seats whose faces are known show them in the plate; otherwise the face-down pair peeks above it (.mp-backs).
  function hasFaces(x) {
    return !!(Array.isArray(x.cards) && x.cards.length === 2 && core.cardInfo(x.cards[0]) && core.cardInfo(x.cards[1]));
  }

  // rv: winner reveal of this seat (winnerReveal), or undefined. Winners show their best cards highlighted.
  function miniCards(x, rv) {
    if (!hasFaces(x)) return '';
    var c0 = cardHtml(x.cards[0], 'mini' + (rv && rv.best.indexOf(x.cards[0]) >= 0 ? ' best' : rv ? ' dim' : ''));
    var c1 = cardHtml(x.cards[1], 'mini' + (rv && rv.best.indexOf(x.cards[1]) >= 0 ? ' best' : rv ? ' dim' : ''));
    return '<span class="mp-mini' + (rv ? ' win' : '') + '">' + c0 + c1 + '</span>';
  }

  // Winner tag on the seat plate: hand name (when shown) and the amount won; "wins X" for an uncontested pot.
  // '+amount' that rises over a winner's plate: the sum of every pot the seat won (CSS mp-gain, one pop per hand).
  function gainTag(h, seat) {
    var sum = 0;
    (h.winners || []).forEach(function (v) { if (v.seat === seat) sum += Number(v.amount) || 0; });
    return sum > 0 ? '<span class="mp-gain">+' + esc(bbTxt(sum)) + '</span>' : '';
  }
  function winTag(h, seat, rv) {
    var w = (h.winners || []).filter(function (v) { return v.seat === seat; })[0];
    if (!w) return '';
    var es = lang() === 'es';
    return '<span class="mp-wintag">' + (rv ? esc(rv.text) + ' · ' : '') + esc(es ? 'gana ' : 'wins ') +
      esc(bbTxt(w.amount)) + '</span>';
  }

  // ---------- connection ----------
  function wsUrl() {
    return (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws';
  }

  function setStatus(s) { C.status = s; renderConn(); }

  function renderConn() {
    var map = {
      connecting: ['mp.connecting', ''],
      online: ['mp.online', 'on'],
      reconnecting: ['mp.reconnecting', 'warn'],
      offline: ['mp.offline', 'off']
    };
    var m = map[C.status] || map.offline;
    if (C.left) m = ['', ''];
    if (E.connText) E.connText.textContent = m[0] ? tr(m[0]) : '';
    if (E.connDot) E.connDot.className = 'mp-dot ' + m[1];
    if (E.connText && E.connText.parentNode) E.connText.parentNode.classList.toggle('hidden', !!C.left);
    if (E.rttWrap) {
      E.rttWrap.classList.toggle('hidden', C.rtt == null);
      if (C.rtt != null) {
        E.rttDot.className = 'mp-dot ' + (C.rtt < 120 ? 'rtt-good' : C.rtt < 300 ? 'rtt-mid' : 'rtt-bad');
        E.rtt.textContent = C.rtt + ' ms';
      }
    }
  }

  function send(obj) {
    if (!isOpen()) return false;
    try { C.ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  function sendJoin() {
    send({ t: 'join', name: C.name, clientId: C.clientId || undefined, token: C.token || undefined });
  }

  function sendProfile() {
    send({ t: 'profile', name: C.name, avatar: C.avatar || null, highlight: myHighlight() });
  }

  function startPing() {
    stopPing();
    C.pingTimer = setInterval(function () { send({ t: 'ping', ts: Date.now() }); }, 15000);
    C.lastMsgAt = Date.now();
    clearInterval(C.watchTimer);
    // No message for 35 s: the socket is dead even if the browser has not noticed; reconnect now.
    C.watchTimer = setInterval(function () {
      var dead = C.ws;
      if (!dead || dead.readyState !== 1 || Date.now() - C.lastMsgAt <= 35000) return;
      dead.dead = true;
      C.ws = null;
      try { dead.close(); } catch (e) { /* already closing */ }
      stopPing();
      setStatus('reconnecting');
      scheduleRetry();
    }, 5000);
  }
  function stopPing() { clearInterval(C.pingTimer); clearInterval(C.watchTimer); C.pingTimer = null; C.watchTimer = null; }

  function scheduleRetry() {
    clearTimeout(C.retryTimer);
    C.attempt += 1;
    if (C.attempt === 5) {
      C.state = Object.assign({}, C.state, { error: tr('mp.serverMoved') });
      render();
    }
    C.retryTimer = setTimeout(connect, core.reconnectDelay(C.attempt, Math.random()));
  }

  function connect() {
    C.wantConnected = true;
    C.left = false;
    clearTimeout(C.retryTimer);
    if (!C.name) return;
    if (C.ws && C.ws.readyState <= 1) return;   // already connecting or open
    setStatus(C.attempt > 0 ? 'reconnecting' : 'connecting');
    var ws;
    try { ws = new WebSocket(wsUrl()); } catch (e) { scheduleRetry(); return; }
    C.ws = ws;
    ws.onopen = function () { if (window.PokerRooms && window.PokerRooms.roomId()) send({ t: 'joinRoom', id: window.PokerRooms.roomId() });
      C.attempt = 0;
      setStatus('online');
      startPing();
      sendJoin();
    };
    ws.binaryType = 'arraybuffer';
    ws.onmessage = function (ev) {
      if (typeof ev.data === 'string') onMessage(ev.data);
      else onBinary(ev.data);
    };
    ws.onclose = function () {
      if (ws.dead) return;   // the watchdog already handled this socket
      if (C.ws === ws) C.ws = null;
      stopPing();
      if (C.wantConnected) { setStatus('reconnecting'); scheduleRetry(); } else { setStatus('offline'); }
      render();
    };
    ws.onerror = noop;
  }

  function onMessage(raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    C.lastMsgAt = Date.now();
    if (msg.t === 'pong') {
      if (typeof msg.ts === 'number') C.rtt = Math.max(0, Date.now() - msg.ts);
      renderConn();
      return;
    }
    if (msg.t === 'kicked') { onKicked(); return; }
    if (msg.t === 'notice') {
      if (msg.kind === 'blinds') flash(tr('mp.blindsDoubled', { sb: core.groupDigits(msg.sb), bb: core.groupDigits(msg.bb) }));
      return;
    }
    // The server's no-op answers to pause/resume are silent on purpose.
    if (msg.t === 'error' && /belongs to another player/i.test(String(msg.msg || ''))) {
      // the stored seat is held by someone else (stale clientId): join fresh with a new identity
      C.clientId = ''; C.token = ''; savePrefs(); sendJoin();
      return;
    }
    if (msg.t === 'rated') { onRated(msg); return; }
    if (C.ratedOpen && msg.t === 'error') return;
    if (msg.t === 'error' && /^room (not found|full)$/.test(String(msg.msg || ''))) { leave(); if (window.PokerRooms) { window.PokerRooms.clear(); window.PokerRooms.show(/full/.test(msg.msg) ? 'rooms.full' : 'rooms.gone'); } return; }
    if (msg.t === 'error' && /already paused|not paused/i.test(String(msg.msg || ''))) return;
    if (msg.t === 'welcome' && C.lastAct) C.resendAfterWelcome = true;
    if (msg.t === 'rtc') { whenRtc(function () { onRtc(msg.from, msg.data); }); return; }
    if (msg.t === 'chat') { addChat(msg, false); return; }
    if (msg.t === 'emojiPack' || msg.t === 'emojiPacks') { onEmojiMsg(msg); return; }
    if (msg.t === 'lobby' && fx.ready) onLobbyFx(msg);
    if (msg.t === 'error' && /emoji|slow down/i.test(String(msg.msg || ''))) onEmojiError(String(msg.msg));
    if (msg.t === 'chatHistory' && Array.isArray(msg.messages)) {
      msg.messages.forEach(function (m) { addChat(m, true); });
      return;
    }
    if (msg.t === 'welcome' && Array.isArray(msg.chat)) msg.chat.forEach(function (m) { addChat(m, true); });
    if (msg.t === 'welcome' && msg.you && msg.you.clientId) {
      C.clientId = msg.you.clientId;
      C.token = msg.you.token || '';
      if (!(msg.settings && msg.settings.ranked)) savePrefs();
    }
    if (msg.t === 'welcome') emojiOnWelcome();
    var s = C.state;
    if (msg.t !== 'error' && s.error) s = Object.assign({}, s, { error: '' });
    C.state = core.reduce(s, msg);
    var stNow = C.state;
    if (msg.t === 'error') clearPending();
    if (msg.t === 'state') {
      if (core.turnKey(stNow.hand) !== C.pendingKey) clearPending();
      C.clk = stNow.hand && typeof stNow.hand.turnLeftMs === 'number' ? { left: stNow.hand.turnLeftMs, at: Date.now() } : null;
      if (C.resendAfterWelcome) {
        C.resendAfterWelcome = false;
        var la = C.lastAct;
        C.lastAct = null;
        if (la && stNow.hand && core.turnKey(stNow.hand) === la.key) sendAct(la.payload);
      }
    }
    if (msg.t === 'lobby' || msg.t === 'welcome') {
      var ls = stNow.settings || {};
      var nowMs = Date.now();
      if (typeof ls.nextBlindUpAt === 'number') {
        C.blind = { left: ls.nextBlindUpAt - (typeof msg.serverNow === 'number' ? msg.serverNow : nowMs), at: nowMs };
      } else if (stNow.paused && C.blind) {
        C.blind = { left: core.remainingFrom(C.blind.left, C.blind.at, nowMs, false), at: nowMs };
      } else {
        C.blind = null;
      }
    }
    if (msg.t === 'welcome') {
      if (C.avatar) sendProfile();
      if (C.camPref && !C.camOn) toggleCam(true);
      if (C.micPref && !C.micOn) toggleMic(true);
    }
    if (msg.t === 'welcome' || msg.t === 'lobby' || msg.t === 'peers') {
      var ids = core.peerIds(C.state.players, C.state.peers, C.clientId);
      whenRtc(function () { updatePeers(ids); });
    }
    render();
  }

  // ---------- camera and mic ----------
  function localTrack(kind) {
    var st = kind === 'video' ? C.camStream : C.micStream;
    if (!st) return null;
    var list = kind === 'video' ? st.getVideoTracks() : st.getAudioTracks();
    return list[0] || null;
  }

  // needsOwnRelay: one of this client's links is not connected. The peer uses it to know that it
  // must send its media through the server too (the other side cannot reach us directly).
  function needsOwnRelay() {
    return Object.keys(C.peers).some(function (id) { return C.peers[id].needsRelay; });
  }

  function sendMedia(id) {
    send({ t: 'rtc', to: id, data: { kind: 'media', cam: !!C.camOn, mic: !!C.micOn, relay: needsOwnRelay() } });
  }

  function broadcastMedia() {
    Object.keys(C.peers).forEach(sendMedia);
  }

  function applyLocal() {
    Object.keys(C.peers).forEach(function (id) {
      C.peers[id].setLocalTracks(localTrack('video'), localTrack('audio'));
      sendMedia(id);
    });
    ensureMicSender();
    var vt = localTrack('video');
    if (vt && 'contentHint' in vt) vt.contentHint = 'motion';
  }

  function stopStream(st) {
    if (st) st.getTracks().forEach(function (t) { t.stop(); });
  }

  // ---------- relay media (used when a WebRTC link does not connect, or with ?rtc=off) ----------
  // Video: WebCodecs H.264 (else VP8) chunks, or JPEG frames without WebCodecs. Audio: Opus through
  // WebCodecs, or 8 kHz mu-law without it. The server forwards each frame with the sender's seat in
  // front and never stores it. Byte layouts: MP_PROTOCOL.md.
  var caps = null;               // { video: 'avc'|'vp8'|null, opus: bool }, probed once at mount
  var vtx = { enc: null, codec: null, prof: null, lastFrame: 0, lastKey: 0, seq: 0, needKey: false, resync: false, failed: 0, canvas: null };
  var jpg = { canvas: null, busy: false, last: 0 };
  var vidEl = null;
  var atx = { enc: null, reader: null, seq: 0, track: null, mode: null };  // mode: 'opus' | 'mulaw' | null
  var aud = { ctx: null, proc: null, acc: [] };                              // mu-law sender
  var rx = { ctx: null, seat: {}, blocked: false };                          // playback context, per-seat bus
  var rtcWait = [];

  function relayActive() {
    if (C.compat || C.rtcOff || needsOwnRelay()) return true;
    return Object.keys(C.peers).some(function (id) { return C.peers[id].wantsRelay; });
  }

  // Sends one binary frame (already framed) unless the socket is backed up past limit.
  function sendBytes(u8, limit) {
    if (!isOpen() || C.ws.bufferedAmount > limit) return false;
    try { C.ws.send(u8.buffer); C.stats.bytesOut += u8.length; return true; } catch (e) { return false; }
  }

  function probeCaps() {
    var out = { video: null, opus: false };
    var VE = window.VideoEncoder, VD = window.VideoDecoder, AE = window.AudioEncoder, AD = window.AudioDecoder;
    var p = Promise.resolve();
    if (VE && VD && window.VideoFrame) {
      ['avc', 'vp8'].forEach(function (codec) {
        p = p.then(function () {
          if (out.video) return null;
          var cfg = core.videoEncoderConfig(codec, PROBE_PROFILE);
          return Promise.all([VE.isConfigSupported(cfg), VD.isConfigSupported({ codec: cfg.codec })])
            .then(function (r) { if (r[0].supported && r[1].supported) out.video = codec; }, noop);
        });
      });
    }
    if (AE && AD && window.MediaStreamTrackProcessor) {
      p = p.then(function () {
        return Promise.all([AE.isConfigSupported(OPUS_ENC), AD.isConfigSupported(OPUS_DEC)])
          .then(function (r) { out.opus = !!(r[0].supported && r[1].supported); }, noop);
      });
    }
    return p.then(function () { return out; });
  }

  // ICE servers from GET /rtc-config, fetched once at mount. Peers wait for it (whenRtc).
  function loadRtcConfig() {
    var done = false;
    function finish(cfg) {
      if (done) return;
      done = true;
      C.rtcCfg = cfg;
      var q = rtcWait;
      rtcWait = [];
      q.forEach(function (fn) { fn(); });
    }
    setTimeout(function () { finish(core.rtcConfigFrom(null)); }, 3000);
    if (typeof fetch !== 'function') { finish(core.rtcConfigFrom(null)); return; }
    fetch('/rtc-config', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { finish(core.rtcConfigFrom(j)); }, function () { finish(core.rtcConfigFrom(null)); });
  }

  function whenRtc(fn) {
    if (C.rtcCfg) fn();
    else rtcWait.push(fn);
  }

  // ---------- playback ----------
  function audioCtx() {
    if (rx.ctx) return rx.ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { rx.ctx = new AC(); } catch (e) { return null; }
    return rx.ctx;
  }

  function unlockAudio() {
    var ctx = audioCtx();
    if (ctx && ctx.state !== 'running') ctx.resume().catch(noop);
    if (aud.ctx && aud.ctx.state === 'suspended') aud.ctx.resume().catch(noop);
  }

  function seatBus(seat) {
    var ctx = audioCtx();
    if (!ctx) return null;
    var b = rx.seat[seat];
    if (!b) {
      var g = ctx.createGain();
      var an = ctx.createAnalyser();
      an.fftSize = 512;
      g.connect(an);
      an.connect(ctx.destination);
      b = rx.seat[seat] = { bus: g, an: an, next: 0 };
    }
    return b;
  }

  // Plays decoded mono samples for one seat. A small jitter buffer keeps playback continuous.
  function playPCM(seat, f32, rate) {
    var ctx = audioCtx();
    if (!ctx) return;
    if (ctx.state !== 'running') { rx.blocked = true; setSoundBlocked(true); return; }
    var b = seatBus(seat);
    if (!b) return;
    var buf = ctx.createBuffer(1, f32.length, rate);
    buf.copyToChannel(f32, 0);
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(b.bus);
    var now = ctx.currentTime;
    var t = Math.max(now + JITTER_S, b.next);
    if (t - now > 0.4) t = now + JITTER_S;      // drop backlog instead of growing latency
    src.start(t);
    b.next = t + f32.length / rate;
  }

  function rmsOf(an) {
    if (!an) return 0;
    var a = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(a);
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i] * a[i];
    return Math.sqrt(s / a.length);
  }

  function setSoundBlocked(flag) {
    C.soundBlocked = !!flag;
    if (E.sound) E.sound.classList.toggle('hidden', !flag);
  }

  function playAudioEl(l) {
    var p = l.audioEl && l.audioEl.play ? l.audioEl.play() : null;
    if (p && p.catch) p.catch(function (e) { if (e && e.name === 'NotAllowedError') setSoundBlocked(true); });
  }

  // A dedicated <audio> element per WebRTC peer (not muted), so remote sound never depends on the tile.
  function syncAudioEls() {
    if (!E.audios) return;
    Object.keys(C.peers).forEach(function (id) {
      var l = C.peers[id];
      if (!l || !l.audStream || !l.audStream.getAudioTracks().length) return;
      if (!l.audioEl) {
        var el = document.createElement('audio');
        el.autoplay = true;
        el.playsInline = true;
        el.muted = false;
        el.srcObject = l.audStream;
        E.audios.appendChild(el);
        l.audioEl = el;
      }
      if (!l.aAn && audioCtx() && audioCtx().state !== 'closed') {
        var ctx = audioCtx();
        var src = ctx.createMediaStreamSource(l.audStream);
        l.aAn = ctx.createAnalyser();
        l.aAn.fftSize = 512;
        var g = ctx.createGain();
        g.gain.value = 0;
        src.connect(l.aAn);
        l.aAn.connect(g);
        g.connect(ctx.destination);
      }
      if (l.audioEl.paused) playAudioEl(l);
    });
  }

  function checkSound() {
    if (rx.ctx && rx.ctx.state === 'running') rx.blocked = false;
    var blocked = rx.blocked;
    Object.keys(C.peers).forEach(function (id) {
      var l = C.peers[id];
      if (l && l.audioEl && l.audioEl.paused && l.audioEl.srcObject) blocked = true;
    });
    setSoundBlocked(blocked);
  }

  function playEl(v) {
    var p = v.play && v.play();
    if (p && p.catch) p.catch(noop);
  }

  function playAll() {
    if (E.cams) E.cams.querySelectorAll('video').forEach(function (v) { if (v.srcObject && v.paused) playEl(v); });
    Object.keys(C.peers).forEach(function (id) {
      var l = C.peers[id];
      if (l && l.audioEl && l.audioEl.paused) playAudioEl(l);
    });
    if (rx.ctx && rx.ctx.state !== 'running') rx.ctx.resume().catch(noop);
    setTimeout(checkSound, 300);
  }

  // Level of each tile: local mic, WebRTC remote audio, or relayed audio. Drives the speaking ring.
  function levelTick() {
    if (!E.cams) return;
    Array.prototype.forEach.call(E.cams.querySelectorAll('.mp-tile'), function (t) {
      var lvl = 0;
      var me = t.classList.contains('me');
      if (me) {
        lvl = rmsOf(C.localAn);
      } else {
        var cid = t.getAttribute('data-cid');
        var link = cid ? C.peers[cid] : null;
        if (link && link.aAn) lvl = Math.max(lvl, rmsOf(link.aAn));
        var seat = t.getAttribute('data-seat');
        if (seat != null && rx.seat[seat] && relayAudioWanted(Number(seat))) lvl = Math.max(lvl, rmsOf(rx.seat[seat].an));
      }
      t.classList.toggle('speaking', lvl > SPEAK_RMS);
    });
  }

  function ensureLocalLevel() {
    if (C.localAn || !C.micStream) return;
    var ctx = audioCtx();
    if (!ctx) return;
    var src = ctx.createMediaStreamSource(C.micStream);
    C.localAn = ctx.createAnalyser();
    C.localAn.fftSize = 512;
    var g = ctx.createGain();
    g.gain.value = 0;
    src.connect(C.localAn);
    C.localAn.connect(g);
    g.connect(ctx.destination);
  }

  // ---------- sending: video ----------
  function closeVideoEnc() {
    var e = vtx.enc;
    vtx.enc = null;
    vtx.codec = null;
    vtx.prof = null;
    if (e) { try { e.close(); } catch (err) { /* already closed */ } }
  }

  function onVideoChunk(chunk) {
    if (!isOpen()) { vtx.resync = true; return; }
    var key = chunk.type === 'key';
    if (!key && C.ws.bufferedAmount > BUF_SKIP) { vtx.resync = true; C.stats.vidDropped += 1; return; }
    var data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    var seq = vtx.seq;
    vtx.seq = (vtx.seq + 1) & 0xffff;
    var codecId = vtx.codec === 'avc' ? core.CODEC_IDS.avc : core.CODEC_IDS.vp8;
    var ok = sendBytes(core.packMedia(3, key ? 1 : 0, codecId, seq, Math.round(chunk.timestamp / 1000), data), Infinity);
    if (!ok) { vtx.resync = true; return; }
    C.stats.vidOut += 1;
    if (key) C.stats.keyOut += 1;
  }

  function ensureVideoEnc(prof) {
    var codec = caps.video;
    if (vtx.enc && vtx.codec !== codec) closeVideoEnc();
    if (!vtx.enc) {
      var enc = null;
      try {
        enc = new VideoEncoder({ output: onVideoChunk, error: function () { closeVideoEnc(); vtx.failed = Date.now(); } });
        enc.configure(core.videoEncoderConfig(codec, prof));
      } catch (e) {
        if (enc) { try { enc.close(); } catch (x) { /* ignore */ } }
        vtx.failed = Date.now();
        return null;
      }
      vtx.enc = enc;
      vtx.codec = codec;
      vtx.prof = prof;
      vtx.needKey = true;
    } else if (!core.sameProfile(vtx.prof, prof)) {
      try { vtx.enc.configure(core.videoEncoderConfig(codec, prof)); } catch (e) { closeVideoEnc(); vtx.failed = Date.now(); return null; }
      vtx.prof = prof;
      vtx.needKey = true;
    }
    return vtx.enc;
  }

  // Draws the centre 4:3 part of the source into cv (any size).
  function drawCropTo(cv, src, sw, sh) {
    var ctx = cv.getContext('2d');
    var ar = cv.width / cv.height;
    var cw = sw;
    var ch = sw / ar;
    if (ch > sh) { ch = sh; cw = sh * ar; }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, cv.width, cv.height);
  }

  function jpegTick(now, vw, vh) {
    if (jpg.busy || now - jpg.last < 125 || !isOpen() || C.ws.bufferedAmount > core.BUF_SKIP) return;
    if (!jpg.canvas) jpg.canvas = document.createElement('canvas');
    var cv = jpg.canvas;
    if (cv.width !== core.JPEG_W) { cv.width = core.JPEG_W; cv.height = core.JPEG_H; }
    drawCropTo(cv, vidEl, vw, vh);
    jpg.busy = true;
    jpg.last = now;
    cv.toBlob(function (blob) {
      jpg.busy = false;
      if (!blob) return;
      blob.arrayBuffer().then(function (buf) {
        if (sendBytes(core.packFrame(1, new Uint8Array(buf)), core.BUF_SKIP)) C.stats.vidOut += 1;
      }, noop);
    }, 'image/jpeg', core.JPEG_Q);
  }

  // Runs every 20 ms and sends at the profile's frame rate. Frames are dropped, never queued.
  function relayVideoTick() {
    var now = Date.now();
    if (!C.camOn || !C.camStream || !relayActive()) {
      if (vtx.enc) closeVideoEnc();
      return;
    }
    var prof = core.chooseVideoProfile(Object.keys(C.peers).length, C.ws ? C.ws.bufferedAmount : 0);
    if (prof.skip) return;
    if (!vidEl) {
      vidEl = document.createElement('video');
      vidEl.muted = true;
      vidEl.playsInline = true;
    }
    if (vidEl.srcObject !== C.camStream) { vidEl.srcObject = C.camStream; playEl(vidEl); }
    var vw = vidEl.videoWidth;
    var vh = vidEl.videoHeight;
    if (!vw || !vh) return;
    var codecOk = caps && caps.video && !C.forceJpeg && now - vtx.failed > 5000;
    if (codecOk) {
      if (now - vtx.lastFrame < 1000 / prof.fps) return;
      var enc = ensureVideoEnc(prof);
      if (enc) {
        if (enc.encodeQueueSize > 2) return;     // encoder behind: drop this frame
        var key = vtx.needKey || core.keyframeDue(vtx.lastKey, now, core.KEY_INTERVAL_MS) ||
          (vtx.resync && C.ws.bufferedAmount < 16384);
        if (!vtx.canvas) vtx.canvas = document.createElement('canvas');
        var cv = vtx.canvas;
        if (cv.width !== prof.w || cv.height !== prof.h) { cv.width = prof.w; cv.height = prof.h; }
        drawCropTo(cv, vidEl, vw, vh);
        var fr = new VideoFrame(cv, { timestamp: now * 1000 });
        try { enc.encode(fr, { keyFrame: !!key }); } catch (e) { closeVideoEnc(); vtx.failed = now; }
        fr.close();
        vtx.lastFrame = now;
        if (key) { vtx.lastKey = now; vtx.needKey = false; vtx.resync = false; }
        return;
      }
    }
    jpegTick(now, vw, vh);
  }

  // ---------- sending: audio ----------
  function ensureAudioSender() {
    if (aud.proc || !C.micStream) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    aud.ctx = aud.ctx || new AC();
    var src = aud.ctx.createMediaStreamSource(C.micStream);
    aud.proc = aud.ctx.createScriptProcessor(4096, 1, 1);
    var mute = aud.ctx.createGain();
    mute.gain.value = 0;
    aud.proc.onaudioprocess = function (e) {
      if (!C.micOn || !relayActive() || !isOpen() || atx.mode === 'opus') { aud.acc = []; return; }
      var down = core.downsample(e.inputBuffer.getChannelData(0), aud.ctx.sampleRate, 8000);
      for (var i = 0; i < down.length; i++) aud.acc.push(down[i]);
      while (aud.acc.length >= 800) {
        var chunk = aud.acc.splice(0, 800);
        if (sendBytes(core.packFrame(2, core.encodeMulaw(chunk)), core.AUDIO_BACKLOG)) C.stats.audOut += 1;
      }
    };
    src.connect(aud.proc);
    aud.proc.connect(mute);
    mute.connect(aud.ctx.destination);
    if (aud.ctx.state === 'suspended') aud.ctx.resume().catch(noop);
  }

  function onAudioChunk(chunk) {
    if (!isOpen() || C.ws.bufferedAmount > AUDIO_BACKLOG) return;
    var data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    var seq = atx.seq;
    atx.seq = (atx.seq + 1) & 0xffff;
    if (sendBytes(core.packMedia(4, 1, core.CODEC_IDS.opus, seq, Math.round(chunk.timestamp / 1000), data), Infinity)) C.stats.audOut += 1;
  }

  function stopOpusTx(keepMode) {
    var r = atx.reader;
    var e = atx.enc;
    atx.reader = null;
    atx.enc = null;
    atx.track = null;
    if (!keepMode) atx.mode = null;
    if (r) { try { r.cancel(); } catch (x) { /* ignore */ } }
    if (e) { try { e.close(); } catch (x) { /* ignore */ } }
  }

  // Reads the mic track, encodes only while the mic is on and a relay is in use, and drops the rest.
  function pumpAudio(reader, enc) {
    (function next() {
      if (atx.reader !== reader) return;
      reader.read().then(function (r) {
        if (r.done || atx.reader !== reader) return;
        var d = r.value;
        if (d.sampleRate !== 48000 || d.numberOfChannels !== 1) {
          d.close();
          stopOpusTx(true);
          atx.mode = 'mulaw';
          ensureAudioSender();
          return;
        }
        if (C.micOn && relayActive() && isOpen() && enc.encodeQueueSize < 8) {
          try { enc.encode(d); } catch (e) { /* closed */ }
        }
        d.close();
        next();
      }, function () { /* track ended */ });
    })();
  }

  function startOpusTx(track) {
    if (!caps || !caps.opus || !track) return false;
    var reader;
    var enc;
    try {
      reader = new MediaStreamTrackProcessor({ track: track }).readable.getReader();
      enc = new AudioEncoder({ output: onAudioChunk, error: function () { stopOpusTx(true); atx.mode = 'mulaw'; ensureAudioSender(); } });
      enc.configure(core.OPUS_ENC);
    } catch (e) {
      if (reader) { try { reader.cancel(); } catch (x) { /* ignore */ } }
      return false;
    }
    atx.enc = enc;
    atx.reader = reader;
    atx.track = track;
    atx.mode = 'opus';
    atx.seq = 0;
    pumpAudio(reader, enc);
    return true;
  }

  function ensureMicSender() {
    var track = localTrack('audio');
    if (!track) return;
    ensureLocalLevel();
    if (atx.mode === 'opus' && atx.track === track) return;
    if (atx.mode === null && startOpusTx(track)) return;
    if (atx.mode !== 'opus') ensureAudioSender();
  }

  // ---------- receiving ----------
  function clientOfSeat(seat) {
    var out = null;
    (C.state.players || []).forEach(function (q) { if (q.seat === seat && !q.bot) out = q.clientId || null; });
    return out;
  }

  // Relayed audio plays only when that sender's WebRTC audio is not connected.
  function relayAudioWanted(seat) {
    var cid = clientOfSeat(seat);
    var link = cid ? C.peers[cid] : null;
    return !(link && core.linkStatus(link) === 'connected');
  }

  function relayState(seat) {
    var rs = C.relayIn[seat];
    if (!rs) {
      rs = C.relayIn[seat] = {
        lastVideo: 0, lastAudio: 0, shown: false, seq: null, waitKey: true, codec: null,
        dec: null, adec: null, frame: null, dirty: false, reqAt: 0, decoded: 0, drawn: 0
      };
    }
    return rs;
  }

  function requestKey(seat) {
    var rs = C.relayIn[seat];
    var now = Date.now();
    if (!rs || !core.keyRequestAllowed(rs.reqAt, now)) return;
    var cid = clientOfSeat(seat);
    if (!cid) return;
    rs.reqAt = now;
    C.stats.keyReq += 1;
    send({ t: 'rtc', to: cid, data: { kind: 'needKey' } });
  }

  // Keeps the newest decoded or decoded-JPEG frame for the tile; the draw loop paints it.
  function setFrame(seat, rs, frame) {
    if (rs.frame && rs.frame !== frame && rs.frame.close) { try { rs.frame.close(); } catch (e) { /* ignore */ } }
    rs.frame = frame;
    rs.dirty = true;
    rs.lastVideo = Date.now();
    if (!rs.shown) { rs.shown = true; C.sig.cams = null; render(); }
  }

  function makeVideoDec(seat, rs, codec) {
    if (typeof VideoDecoder === 'undefined') return null;
    var dec = null;
    try {
      dec = new VideoDecoder({
        output: function (fr) { setFrame(seat, rs, fr); rs.decoded += 1; C.stats.decoded += 1; },
        error: function () { rs.dec = null; rs.waitKey = true; requestKey(seat); }
      });
      dec.configure({ codec: codec === core.CODEC_IDS.avc ? 'avc1.42E01F' : 'vp8', optimizeForLatency: true });
    } catch (e) { return null; }
    return dec;
  }

  function onRelayVideo(seat, rs, m) {
    if (!m) return;
    if (core.seqGap(rs.seq, m.seq)) rs.waitKey = true;
    rs.seq = m.seq;
    if (!rs.dec || rs.codec !== m.codec) {
      if (rs.dec) { try { rs.dec.close(); } catch (e) { /* ignore */ } }
      rs.dec = makeVideoDec(seat, rs, m.codec);
      rs.codec = m.codec;
      rs.waitKey = true;
    }
    if (!rs.dec) return;
    if (!m.key && rs.waitKey) { requestKey(seat); return; }
    if (m.key) rs.waitKey = false;
    if (rs.dec.decodeQueueSize > 6) { rs.waitKey = true; requestKey(seat); return; }
    try {
      rs.dec.decode(new EncodedVideoChunk({ type: m.key ? 'key' : 'delta', timestamp: m.ts * 1000, data: m.data }));
    } catch (e) {
      rs.waitKey = true;
      requestKey(seat);
    }
  }

  function makeAudioDec(seat, rs) {
    if (typeof AudioDecoder === 'undefined') return null;
    var dec = null;
    try {
      dec = new AudioDecoder({
        output: function (ad) {
          var f = new Float32Array(ad.numberOfFrames);
          try { ad.copyTo(f, { planeIndex: 0 }); } catch (e) { ad.close(); return; }
          var rate = ad.sampleRate;
          ad.close();
          C.stats.audDecoded += 1;
          playPCM(seat, f, rate);
        },
        error: function () { rs.adec = null; }
      });
      dec.configure(core.OPUS_DEC);
    } catch (e) { return null; }
    return dec;
  }

  function onRelayOpus(seat, rs, m) {
    if (!m || !relayAudioWanted(seat)) return;
    if (!rs.adec) rs.adec = makeAudioDec(seat, rs);
    if (!rs.adec) return;
    rs.lastAudio = Date.now();
    try { rs.adec.decode(new EncodedAudioChunk({ type: 'key', timestamp: m.ts * 1000, data: m.data })); } catch (e) { rs.adec = null; }
  }

  function drawJpeg(seat, rs, bytes) {
    if (!window.createImageBitmap) return;
    createImageBitmap(new Blob([bytes], { type: 'image/jpeg' })).then(function (bmp) { setFrame(seat, rs, bmp); }, noop);
  }

  // Frames from the relay: video (JPEG or WebCodecs) and audio (Opus or mu-law).
  function onBinary(buf) {
    var f = core.parseFrame(new Uint8Array(buf));
    if (!f) return;
    C.stats.inFrames += 1;
    C.stats.inBytes += buf.byteLength;
    var rs = relayState(f.seat);
    if (f.type === 1) {
      C.stats.vidIn += 1;
      C.stats.vidBytesIn += f.payload.length;
      drawJpeg(f.seat, rs, f.payload);
    } else if (f.type === 3) {
      C.stats.vidIn += 1;
      C.stats.vidBytesIn += f.payload.length;
      onRelayVideo(f.seat, rs, core.parseMediaPayload(f.payload));
    } else if (f.type === 2) {
      C.stats.audIn += 1;
      C.stats.audBytesIn += f.payload.length;
      rs.lastAudio = Date.now();
      if (relayAudioWanted(f.seat)) playPCM(f.seat, core.decodeMulaw(f.payload), 8000);
    } else if (f.type === 4) {
      C.stats.audIn += 1;
      C.stats.audBytesIn += f.payload.length;
      onRelayOpus(f.seat, rs, core.parseMediaPayload(f.payload));
    }
  }

  // Cover-fit draw at the canvas size. The canvas follows its CSS size times devicePixelRatio.
  function drawCover(cv, src) {
    var ctx = cv.getContext('2d');
    var sw = src.displayWidth || src.width;
    var sh = src.displayHeight || src.height;
    if (!sw || !sh) return;
    var s = Math.max(cv.width / sw, cv.height / sh);
    var dw = sw * s;
    var dh = sh * s;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, (cv.width - dw) / 2, (cv.height - dh) / 2, dw, dh);
  }

  function drawLoop() {
    requestAnimationFrame(drawLoop);
    if (!E.cams) return;
    var dpr = window.devicePixelRatio || 1;
    Object.keys(C.relayIn).forEach(function (seat) {
      var rs = C.relayIn[seat];
      if (!rs.frame) return;
      var cv = E.cams.querySelector('canvas.mp-relay[data-seat="' + seat + '"]');
      if (!cv) return;
      var w = Math.max(2, Math.round(cv.clientWidth * dpr));
      var h = Math.max(2, Math.round(cv.clientHeight * dpr));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; rs.dirty = true; }
      if (!rs.dirty) return;
      rs.dirty = false;
      drawCover(cv, rs.frame);
      rs.drawn += 1;
      C.stats.drawn += 1;
    });
  }

  // Relayed video is "live" while frames keep arriving; otherwise the tile falls back to its state.
  function relayStale() {
    var now = Date.now();
    var changed = false;
    Object.keys(C.relayIn).forEach(function (seat) {
      var rs = C.relayIn[seat];
      if (rs.shown && now - rs.lastVideo >= RELAY_FRESH_MS) { rs.shown = false; changed = true; }
    });
    if (changed) { C.sig.cams = null; render(); }
  }

  function linkChanged(l) {
    var st = core.linkStatus(l);
    if (st === 'connected') { clearTimeout(l.timer); l.needsRelay = false; }
    else if (st === 'failed' && l.restarted) { l.needsRelay = true; }
    syncAudioEls();
    broadcastMedia();
    C.sig.cams = null;
    render();
  }

  // A link to a peer. With WebRTC off (?rtc=off) the stub carries only media status and every
  // frame goes through the server relay.
  function ensurePeer(id) {
    if (C.peers[id]) return C.peers[id];
    var link;
    if (!hasRTC()) {
      link = {
        id: id, noRtc: true, stream: null, audStream: null, camera: false, mic: false, seenMedia: false,
        closed: false, needsRelay: true, log: [], path: '', audioEl: null, aAn: null,
        status: function () { return 'relay'; },
        setLocalTracks: noop,
        signal: noop,
        close: function () { link.closed = true; }
      };
    } else {
      link = core.createPeerLink({
        config: C.rtcCfg || core.rtcConfigFrom(null),
        makePC: function (cfg) { return new RTCPeerConnection(cfg); },
        makeStream: function () { return new MediaStream(); },
        remoteId: id,
        polite: String(C.clientId) < String(id),
        send: function (data) { send({ t: 'rtc', to: id, data: data }); },
        onChange: function (l) { linkChanged(l); }
      });
      link.needsRelay = false;
      link.startedAt = Date.now();
      link.timer = setTimeout(function () { onLinkTimeout(link); }, LINK_TIMEOUT_MS);
    }
    C.peers[id] = link;
    link.setLocalTracks(localTrack('video'), localTrack('audio'));
    sendMedia(id);
    return link;
  }

  // Not connected after LINK_TIMEOUT_MS: one ICE restart first, then the relay.
  function onLinkTimeout(link) {
    if (link.closed) return;
    var st = core.linkStatus(link);
    if (st === 'connected' || st === 'relay' || st === 'closed') return;
    if (link.restart && link.restart()) {
      link.timer = setTimeout(function () { onLinkTimeout(link); }, LINK_TIMEOUT_MS);
      return;
    }
    link.needsRelay = true;
    broadcastMedia();
    C.sig.cams = null;
    render();
  }

  function updatePeers(ids) {
    var keep = {};
    ids.forEach(function (id) { keep[id] = true; ensurePeer(id); });
    Object.keys(C.peers).forEach(function (id) {
      if (!keep[id]) {
        var l = C.peers[id];
        if (l.audioEl && l.audioEl.parentNode) l.audioEl.parentNode.removeChild(l.audioEl);
        l.close();
        delete C.peers[id];
        C.sig.cams = null;
      }
    });
  }

  function onRtc(from, data) {
    if (!from || !data) return;
    if (data.kind === 'needKey') { vtx.needKey = true; C.stats.keyIn += 1; return; }
    var link = C.peers[from] || ensurePeer(from);
    if (data.kind === 'media') {
      link.camera = !!data.cam;
      link.mic = !!data.mic;
      link.wantsRelay = !!data.relay;
      link.seenMedia = true;
      C.sig.cams = null;
      render();
      return;
    }
    link.signal(data);
  }

  // force: true turns on  // force: true turns on, false turns off, undefined toggles.
  async function toggleCam(force) {
    var want = force === undefined ? !C.camOn : !!force;
    if (C.camBusy) return;
    C.camError = '';
    if (!want) {
      stopStream(C.camStream);
      C.camStream = null;
      C.camOn = false;
    } else if (!hasMedia()) {
      C.camError = 'mp.cam.noMedia';
    } else {
      C.camBusy = true;
      C.camRequesting = true;
      render();
      try {
        C.camStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
          audio: false
        });
        C.camOn = true;
      } catch (e) {
        var name = e && e.name;
        C.camError = name === 'NotAllowedError' || name === 'SecurityError' ? 'mp.cam.denied'
          : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'mp.cam.none' : 'mp.cam.failed';
      } finally {
        C.camBusy = false;
        C.camRequesting = false;
      }
    }
    C.camPref = C.camOn;
    C.sig.cams = null;
    savePrefs();
    applyLocal();
    render();
  }

  // The mic stream is kept once acquired; switching it off disables the track instead of stopping
  // it, so turning it back on needs no permission prompt and no renegotiation.
  async function toggleMic(force) {
    var want = force === undefined ? !C.micOn : !!force;
    C.micError = '';
    if (!want) {
      if (C.micStream) C.micStream.getAudioTracks().forEach(function (t) { t.enabled = false; });
      C.micOn = false;
    } else if (C.micStream) {
      C.micStream.getAudioTracks().forEach(function (t) { t.enabled = true; });
      C.micOn = true;
    } else if (!hasMedia()) {
      C.micError = 'mp.mic.noMedia';
    } else {
      try {
        C.micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: false
        });
        C.micOn = true;
      } catch (e) {
        var name = e && e.name;
        C.micError = name === 'NotAllowedError' || name === 'SecurityError' ? 'mp.mic.denied' : 'mp.mic.failed';
      }
    }
    C.micPref = C.micOn;
    savePrefs();
    applyLocal();
    render();
  }

  function localCamKey() {
    if (C.camRequesting) return 'mp.cam.requesting';
    if (C.camOn) return 'mp.cam.live';
    if (C.camError) return C.camError;
    return 'mp.cam.off';
  }

  // How a remote tile shows its sender: the WebRTC link when connected, the relay when frames
  // arrive, or a status line while neither works yet.
  function remoteView(p, link) {
    if (!p.connected) return { mode: 'none', key: 'mp.cam.offline', cam: false };
    var rs = C.relayIn[p.seat];
    var relayFresh = !!(rs && rs.shown && Date.now() - rs.lastVideo < RELAY_FRESH_MS);
    if (link && core.linkStatus(link) === 'connected') {
      var cam = link.seenMedia ? link.camera : !!p.camera;
      return { mode: 'webrtc', key: cam ? 'mp.cam.live' : 'mp.cam.connected', cam: cam };
    }
    if (relayFresh) return { mode: 'relay', key: 'mp.cam.relayed', cam: true };
    return { mode: 'none', key: link && link.needsRelay ? 'mp.cam.waitRelay' : 'mp.cam.connecting', cam: false };
  }

  // Remote tiles show a status line only while the link is not up yet (or failed); otherwise just video.
  var TRANSIENT = ['mp.cam.connecting', 'mp.cam.waitRelay', 'mp.cam.relayed', 'mp.cam.linkFailed', 'mp.cam.offline'];

  function icon24(name, on) {
    return '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="' + ICON[name] +
      '"/>' + (on ? '' : '<path class="mp-slash" d="M4 4l16 16"/>') + '</svg>';
  }

  function tileBtn(act, on, label, name) {
    return '<button type="button" class="mp-tbtn ' + (on ? 'on' : 'off') + '" data-act="' + act +
      '" aria-label="' + esc(label) + '" title="' + esc(label) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
      icon24(name, on) + '</button>';
  }

  function indicator(name, on) {
    return '<span class="mp-ind' + (on ? ' on' : '') + '" aria-hidden="true">' + svgIcon(name, on) + '</span>';
  }

  function renderCamControls() {
    E.camRetry.classList.toggle('hidden', !C.camError);
    var note = C.camError || C.micError;
    E.camNote.textContent = note ? tr(note) : '';
    E.camNote.classList.toggle('hidden', !note);
    E.compat.checked = !!C.compat;
  }

  // A joined human who is in the spectators list (busted out) is a spectator.
  function amOut(s) {
    return !!(s.me && s.me.clientId && (s.spectators || []).some(function (p) { return p.clientId === s.me.clientId; }));
  }
  function isTurnSeat(s, seat) {
    return !!(s.hand && !s.hand.over && s.hand.toAct != null && s.hand.toAct === seat);
  }

  function renderCams(s) {
    var meOut = amOut(s);
    var tiles = [{
      self: true, seat: null, name: (s.me && s.me.name) || C.name, avatar: C.avatar,
      cam: C.camOn, mic: C.micOn, mode: C.camOn ? 'webrtc' : 'none', status: localCamKey(), link: null,
      role: meOut ? 'spec' : 'player', turn: false, stack: null
    }];
    // Players in seat order (state order), then spectators at the bottom of the column.
    var people = s.players.slice().sort(function (a, b) { return Number(a.seat) - Number(b.seat); })
      .map(function (p) { return { p: p, spec: false }; })
      .concat((s.spectators || []).map(function (p) { return { p: p, spec: true }; }));
    people.forEach(function (x) {
      var p = x.p;
      if (p.bot || !p.clientId || p.clientId === C.clientId) return;
      var link = C.peers[p.clientId] || null;
      var v = remoteView(p, link);
      tiles.push({
        self: false, seat: p.seat, name: p.name, avatar: p.avatar || '',
        cam: v.cam, mic: !!(link && link.seenMedia && link.mic), muted: !!(link && link.seenMedia && !link.mic),
        mode: v.mode, status: v.key, link: link, cid: p.clientId,
        role: x.spec ? 'spec' : 'player', turn: !x.spec && isTurnSeat(s, p.seat), stack: x.spec ? null : p.stack
      });
    });
    var html = tiles.map(function (t) {
      var showCam = t.self ? C.camOn : t.cam;
      var video = t.self || t.mode === 'webrtc' ? '<video autoplay playsinline' + (t.self ? ' muted' : '') + '></video>' : '';
      var relay = t.self ? '' : '<canvas class="mp-relay" width="' + RELAY_W + '" height="' + RELAY_H + '" data-seat="' + t.seat + '"></canvas>';
      var who = t.name + (t.self ? ' (' + tr('mp.you') + ')' : '');
      var acts = t.self
        ? tileBtn('cam', C.camOn, C.camOn ? tr('mp.ui.camOff') : tr('mp.ui.camOn'), 'cam') +
          tileBtn('mic', C.micOn, C.micOn ? tr('mp.ui.micOff') : tr('mp.ui.micOn'), 'mic')
        : (t.muted ? '<span class="mp-ind" title="' + esc(tr('mp.ui.muted')) + '" aria-label="' + esc(tr('mp.ui.muted')) + '">' +
          svgIcon('mic', false) + '</span>' : '');
      var tileAttrs = t.self ? ' data-me="1"' : ' data-seat="' + esc(t.seat) + '" data-cid="' + esc(t.cid || '') + '"';
      var role = '<span class="mp-role ' + t.role + '">' + esc(tr(t.role === 'spec' ? 'mp.role.spec' : 'mp.role.player')) + '</span>';
      var stack = t.stack != null ? '<span class="mp-tile-stack">' + esc(bbTxt(t.stack)) + '</span>' : '';
      return '<div class="mp-tile' + (t.self ? ' me' : '') + (showCam ? ' cam-on' : '') + (t.mode === 'relay' ? ' relay' : '') +
        (t.role === 'spec' ? ' spec' : '') + (t.turn ? ' on-turn' : '') + '"' + tileAttrs + '>' +
        video + relay +
        '<div class="mp-tile-init" style="background:' + core.nameColor(t.name) + '">' + (t.avatar ? '<img class="mp-tile-photo" src="' + esc(t.avatar) + '" alt="">' :
          '<span class="mp-tile-letter">' + esc(core.initials(t.name)) + '</span>') + '</div>' +
        '<div class="mp-tile-top">' + role + '<span class="mp-tile-name">' + esc(who) + '</span>' + stack +
        (t.self || TRANSIENT.indexOf(t.status) >= 0 ? '<span class="mp-tile-status">' + esc(tr(t.status)) + '</span>' : '') + '</div>' +
        '<div class="mp-tile-acts">' + acts + '</div></div>';
    }).join('');
    if (C.sig.cams === html) return;
    C.sig.cams = html;
    E.cams.innerHTML = html;
    var els = E.cams.children;
    tiles.forEach(function (t, i) {
      var v = els[i] && els[i].querySelector('video');
      if (!v) return;
      var stream = t.self ? (C.camOn ? C.camStream : null) : (t.link && t.link.stream ? t.link.stream : null);
      if (v.srcObject !== stream) v.srcObject = stream || null;
      if (stream) playEl(v);
    });
  }

  function renderSettings(s) {
    if (E.extBtn) E.extBtn.classList.toggle('hidden', !(s.settings && s.settings.externalCallUrl));
    if (window.PokerSound) PokerSound.syncControls(); // volume slider in this dialog (sound.js)
    var sig = JSON.stringify(s.settings);
    if (C.sig.settings === sig) return;
    C.sig.settings = sig;
    var st = s.settings;
    if (document.activeElement !== E.setStack) E.setStack.value = core.fmtBB(st.stack, st.bb, true);
    E.setBShow.checked = !!st.botShowCards;
    E.setStacks.value = st.stacks === 'custom' ? 'custom' : 'default';
    if (document.activeElement !== E.setBlindUp) E.setBlindUp.value = String(st.blindUpMin || 0);
    if (E.setSpec) E.setSpec.value = ['live', 'afterHand', 'off'].indexOf(st.spectatorCards) >= 0 ? st.spectatorCards : 'live';
    if (E.setLate) E.setLate.value = ['start', 'half', 'avg', 'fixed'].indexOf(st.lateStack) >= 0 ? st.lateStack : 'start';
    if (E.setLateBB && document.activeElement !== E.setLateBB) E.setLateBB.value = String(st.lateFixedBB || 20);
    if (E.setLateWrap) E.setLateWrap.hidden = !E.setLate || E.setLate.value !== 'fixed';
    if (E.dlgBlindUp && document.activeElement !== E.dlgBlindUp) E.dlgBlindUp.value = String(st.blindUpMin || 0);
    if (E.dlgSpec) E.dlgSpec.value = ['live', 'afterHand', 'off'].indexOf(st.spectatorCards) >= 0 ? st.spectatorCards : 'live';
    if (E.setBlinds) {
      E.setBlinds.textContent = typeof st.sb === 'number' && typeof st.bb === 'number'
        ? core.groupDigits(st.sb) + ' / ' + core.groupDigits(st.bb) : '—';
    }
  }

  function renderPlayers(s) {
    var isHost = !!(s.me && s.me.host);
    var rows = s.players.map(function (p) {
      var me = !p.bot && p.clientId === C.clientId;
      var link = !p.bot && !me ? C.peers[p.clientId] : null;
      var cam = me ? C.camOn : (link && link.seenMedia ? link.camera : !!p.camera);
      var mic = me ? C.micOn : (link && link.seenMedia ? link.mic : false);
      var online = p.bot ? true : !!p.connected;
      var btn = '';
      if (isHost && !me && p.seat != null && !p.leaving) {
        btn = '<button type="button" class="mp-btn small" data-act="' + (p.bot ? 'remove-bot' : 'kick') +
          '" data-seat="' + esc(p.seat) + '">' + esc(tr(p.bot ? 'mp.remove' : 'mp.kick')) + '</button>';
      }
      var tag = p.bot
        ? eloTag(p)
        : svgIcon('cam', cam) + svgIcon('mic', mic);
      var av = p.bot ? botAvHtml(p, 'sm') : avHtml(p.avatar || (me ? C.avatar : ''), p.name, 'sm');
      return '<li class="mp-prow"><i class="mp-dot ' + (online ? 'on' : 'off') + '"></i>' + av +
        '<span class="mp-pname">' + esc(p.name) + '</span>' +
        (me ? '<span class="mp-tag">' + esc(tr('mp.you')) + '</span>' : '') +
        (p.host ? '<span class="mp-crown" title="' + esc(tr('mp.host')) + '">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="' + ICON.crown + '"/></svg></span>' : '') +
        tag + btn + (p.leaving ? '<span class="mp-tag">' + esc(tr('mp.leaving')) + '</span>' : '') + '</li>';
    }).join('');
    setHtml(E.players, 'players', rows);
    E.playersTitle.textContent = tr('mp.players', { n: s.players.length });
    var emptyRows = '';
    for (var k = s.players.length; k < 6; k++) {
      emptyRows += '<li class="mp-prow mp-seat-empty"><span class="mp-av sm init" aria-hidden="true"></span><span class="mp-pname">' + esc(tr('mp.lobby.emptySeat')) + '</span></li>';
    }
    setHtml(E.lobbyPlayers, 'lobbyPlayers', rows + emptyRows);
  }

  function shortLobby() { return !!window.matchMedia && window.matchMedia('(max-height: 700px)').matches; }
  function selText(sel) { return sel && sel.selectedOptions && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : '—'; }
  // Lobby header, counters, settings chips and the Start hint (shown to everyone; the controls are host-only).
  function renderLobbyInfo(s, isHost) {
    var bots = s.players.filter(function (p) { return p.bot; }).length;
    var humans = s.players.length - bots;
    E.lobbyStatusText.textContent = tr(isHost ? 'mp.lobby.status' : 'mp.lobby.statusWait');
    E.lobbyStatus.setAttribute('data-state', isHost ? 'host' : 'wait');
    E.counts.textContent = tr('mp.lobby.counts', { p: humans, b: bots });
    E.botsCount.textContent = tr('mp.lobby.botsCount', { n: bots });
    E.chipStack.textContent = E.setStack ? E.setStack.value : '—';
    E.chipBlinds.textContent = E.setBlinds ? E.setBlinds.textContent : '—';
    E.chipBlindUp.textContent = selText(E.setBlindUp);
    E.chipLate.textContent = E.setLate && E.setLate.value === 'fixed' && E.setLateBB ? tr('mp.lateFixed') + ' ' + E.setLateBB.value : selText(E.setLate);
    E.chipSpec.textContent = selText(E.setSpec);
    // the table name is the title and the code chip's value (copied for guests: they pick the table from the list)
    var table = s.roomName ? String(s.roomName) : '';
    var titles = document.querySelectorAll('.mp-title, .mp-lobby-title');
    for (var ti = 0; ti < titles.length; ti++) titles[ti].textContent = table || tr('mp.title');
    E.codeVal.textContent = table || '—';
    E.codeVal.title = table;
    E.startHint.classList.toggle('hidden', !isHost || s.players.length >= 2);
    E.start.disabled = s.players.length < 2;
  }

  function renderHost(s) {
    var isHost = !!(s.me && s.me.host);
    E.lobby.classList.toggle('is-guest', !isHost);
    E.guest.classList.toggle('hidden', isHost);
    E.start.classList.toggle('hidden', !isHost);
    E.setToggle.classList.toggle('hidden', !isHost);
    E.admin.classList.remove('hidden');
    E.admin.querySelectorAll('button, select, input').forEach(function (x) { x.disabled = !isHost; });
    // Guests get the same settings values (the controls are disabled for them), so they never show stale ones.
    renderSettings(s);
    renderLobbyInfo(s, isHost);
    E.stacksList.parentNode.classList.toggle('hidden', s.settings.stacks !== 'custom');
    if (E.double) E.double.disabled = !!s.paused;
    if (E.setBlindUp) E.setBlindUp.disabled = !!s.paused;
    if (E.setSpec) E.setSpec.disabled = !!s.paused;
    if (E.dlgBlindUp) E.dlgBlindUp.disabled = !!s.paused || !isHost;
    if (E.dlgSpec) E.dlgSpec.disabled = !!s.paused || !isHost;
    var stackRows = s.players.filter(function (p) { return p.seat != null; }).map(function (p) {
      var val = core.fmtBB(p.stack != null ? p.stack : s.settings.stack, s.settings.bb, true);
      return '<label class="mp-stackrow"><span class="mp-pname">' + esc(p.name) + '</span>' +
        '<input type="number" min="2" max="10000" step="0.5" data-seat="' + esc(p.seat) + '" value="' + esc(val) +
        '" aria-label="' + esc(tr('mp.stackOf', { name: p.name })) + '"></label>';
    }).join('');
    setHtml(E.stacksList, 'stacks', stackRows);
    var bots = s.players.filter(function (p) { return p.bot; }).map(function (p) {
      return '<li class="mp-prow">' + botAvHtml(p, 'sm') +'<span class="mp-pname">' + esc(p.name) + '</span>' +
        eloTag(p) +
        '<button type="button" class="mp-btn small" data-act="edit-bot" data-seat="' + esc(p.seat) + '">' +
        esc(tr('mp.edit')) + '</button></li>';
    }).join('');
    var botRows = s.players.filter(function (p) { return p.bot; });
    var per = window.matchMedia('(max-height: 500px)').matches ? 2 : (shortLobby() ? 4 : 6);
    var pages = Math.max(1, Math.ceil(botRows.length / per));
    C.botPage = Math.min(Math.max(0, C.botPage || 0), pages - 1);
    var slice = botRows.slice(C.botPage * per, C.botPage * per + per).map(function (p) {
      return '<li class="mp-prow">' + botAvHtml(p, 'sm') +'<span class="mp-pname">' + esc(p.name) + '</span>' +
        eloTag(p) +
        '<button type="button" class="mp-btn small" data-act="edit-bot" data-seat="' + esc(p.seat) + '">' +
        esc(tr('mp.edit')) + '</button></li>';
    }).join('');
    setHtml(E.bots, 'bots', slice || '<li class="mp-muted">—</li>');
    var pager = document.getElementById('mp-bots-pager');
    if (pager) {
      pager.classList.toggle('hidden', pages < 2);
      var pg = document.getElementById('mp-bots-pg');
      if (pg) pg.textContent = (C.botPage + 1) + ' / ' + pages;
    }
    E.pause.textContent = s.paused ? tr('mp.resume') : tr('mp.pause');
    E.paused.classList.toggle('hidden', !s.paused);
  }

  // ---------- seat layout (table-local px) ----------
  // Seats sit on a ring inside the table box, evenly spaced in clockwise order from the hero (hero at
  // the bottom). Each seat box is min(maxW, 0.92 x distance to its nearest neighbour) wide. Detail levels
  // lv0..lv3 drop content (avatar, style and last action, then mini cards and position badges; names
  // are cut to 6 characters) until no two boxes, bet chips, the pot block, the hero cards or the
  // toolbar/dock overlays intersect. If the full ring still does not fit, the ring is scaled down.
  // Nothing is placed outside the table box. Landscape: the felt is 66% of the width and its bottom
  // sits 35px above the table bottom, so the hero cards hang over it.
  var LAYOUT_MAX_W = [136, 120, 104, 84, 72];
  // lv4 (extra-compact, last resort, only when lv0..lv3 fail): no avatar, badges or face-down cards, 11px
  // name and stack, 22px board cards. Text may drop to 11px at this level only (documented in mp.css).
  var LAYOUT_SCALES = [0.96, 0.92, 0.88, 0.84, 0.8, 0.76, 0.72, 0.68, 0.64, 0.58, 0.52, 0.46];
  var LAYOUT_SCALES_XC = [1, 0.96, 0.92, 0.88, 0.84, 0.8, 0.76, 0.72, 0.68, 0.64, 0.58, 0.52, 0.46, 0.4, 0.34, 0.28, 0.22];
  var LAYOUT_WIDTH_F = [0.92, 0.82, 0.72, 0.62];
  var LAYOUT_TOL = 1;
  var LAND_FELT_BOTTOM = 6;
  var CHIP_T = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82, 0.1, 0.9];
  var CHIP_SLIDE = [0, 14, -14, 28, -28, 48, -48, 72, -72, 110, -110, 150, -150, 200, -200];

  function isLandscape() { return !!window.matchMedia && window.matchMedia('(max-height: 500px)').matches; }
  function boxAt(x, y, w, h) { return { x: x - w / 2, y: y - h / 2, r: x + w / 2, b: y + h / 2 }; }
  function hitBox(a, b) {
    return Math.min(a.r, b.r) - Math.max(a.x, b.x) > LAYOUT_TOL && Math.min(a.b, b.b) - Math.max(a.y, b.y) > LAYOUT_TOL;
  }
  function insideBox(b, W, H) {
    return b.x >= -LAYOUT_TOL && b.y >= -LAYOUT_TOL && b.r <= W + LAYOUT_TOL && b.b <= H + LAYOUT_TOL;
  }
  function rectIn(el, o) {
    if (!el || !el.getClientRects().length) return null;
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { x: r.left - o.left, y: r.top - o.top, r: r.right - o.left, b: r.bottom - o.top };
  }
  function setBox(el, x, y, w, h) {
    el.style.left = x.toFixed(1) + 'px'; el.style.top = y.toFixed(1) + 'px';
    el.style.width = w.toFixed(1) + 'px'; el.style.height = h.toFixed(1) + 'px';
  }

  function layoutTable() {
    var T = document.getElementById('mp-table');
    var view = document.getElementById('mp-table-view');
    if (!T || !view || view.classList.contains('hidden') || T.clientWidth < 80 || T.clientHeight < 80) return;
    var W = T.clientWidth, H = T.clientHeight;
    var o = T.getBoundingClientRect();
    var land = isLandscape();
    var m = 6;
    var felt = land ? { w: Math.round(W * 0.66), h: H - m - LAND_FELT_BOTTOM } : { w: W - 2 * m, h: H - 2 * m };
    felt.x = (W - felt.w) / 2; felt.y = m;
    var cx = felt.x + felt.w / 2, cy = felt.y + felt.h / 2;
    var feltEl = T.querySelector('.mp-felt');
    if (feltEl) setBox(feltEl, felt.x, felt.y, felt.w, felt.h);
    var centerEl = document.getElementById('mp-center');
    if (centerEl) { centerEl.style.left = cx.toFixed(1) + 'px'; centerEl.style.top = cy.toFixed(1) + 'px'; }

    var base = heroSeat(C.state); base = base == null ? 0 : base;
    var seats = Array.prototype.slice.call(T.querySelectorAll('.mp-seat'));
    function rel(el) { return (((Number(el.getAttribute('data-seat')) - base) % MAX_SEATS) + MAX_SEATS) % MAX_SEATS; }
    seats.sort(function (a, b) { return rel(a) - rel(b); });
    var N = seats.length;
    var bets = Array.prototype.slice.call(T.querySelectorAll('.mp-bet'));

    // the dock is a row below the table (landscape), so the seats keep to the felt's own bottom edge
    var heroTop = H;
    // toolbar, dock and pot-block rectangles (table-local); measured per level, since the board size changes
    function obstacles() {
    return ['#mp-hero', '#mp-center', '#mp-table-view .mp-actions', '#mp-table-view .mp-raise-ctl', '.mp-tbar', '.mp-tools']
      .map(function (sel) { return rectIn(document.querySelector(sel), o); })
      .filter(Boolean);
  }

    // one placement with seat width = F x chord (F steps down when side-by-side boxes touch)
    function place(lv, s, F, sy) {
      T.classList.remove('lv0', 'lv1', 'lv2', 'lv3', 'lv4');
      for (var c = 0; c <= lv; c++) T.classList.add('lv' + c);
      var obst = obstacles();
      var maxW = LAYOUT_MAX_W[lv];
      // the ring is set from the real seat height at this level (names never wrap, so it is final)
      seats.forEach(function (el) { el.style.width = maxW + 'px'; });
      var hh = seats.reduce(function (mx, el) { return Math.max(mx, el.offsetHeight); }, 0) || 60;
      var top = 4 + hh / 2, bottom = (land ? heroTop - 4 : H - 4) - hh / 2;
      var ry = Math.max(20, (bottom - top) / 2) * (sy == null ? s : sy);
      var rx = Math.max(20, Math.min(felt.w / 2, W / 2 - 4 - maxW / 2)) * s;
      var ryc = (top + bottom) / 2;
      var pts = seats.map(function (el, k) {
        var sp = window.PokerStadium.at(window.PokerStadium.shape(W / 2, ryc, rx, ry), k / N); // stadium outline (stadium.js)
        return { x: sp.x, y: sp.y };
      });
      var widths = pts.map(function (p, i) {
        var best = Infinity;
        pts.forEach(function (q, j) { if (j !== i) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y)); });
        return Math.max(48, Math.min(maxW, best * F));
      });
      seats.forEach(function (el, i) {
        el.style.width = widths[i].toFixed(1) + 'px';
        el.style.left = pts[i].x.toFixed(1) + 'px';
        el.style.top = pts[i].y.toFixed(1) + 'px';
      });
      var raw = seats.map(function (el, i) { return boxAt(pts[i].x, pts[i].y, widths[i], el.offsetHeight); });
      // the active seat carries a 7px countdown ring: keep that ring clear too
      var chk = raw.map(function (b, i) {
        if (!seats[i].classList.contains('turn')) return b;
        return { x: b.x - 7, y: b.y - 7, r: b.r + 7, b: b.b + 7 };
      });
      var ok = true, i, j;
      raw.forEach(function (b) { if (!insideBox(b, W, H)) ok = false; });
      for (i = 0; i < chk.length; i++) {
        for (j = i + 1; j < chk.length; j++) if (hitBox(chk[i], chk[j])) ok = false;
        for (j = 0; j < obst.length; j++) if (hitBox(chk[i], obst[j])) ok = false;
      }
      var placed = [];
      bets.forEach(function (chip) {
        var idx = -1;
        seats.forEach(function (el, k) { if (el.getAttribute('data-seat') === chip.getAttribute('data-seat')) idx = k; });
        var cw = chip.offsetWidth, ch = chip.offsetHeight;
        var p = idx >= 0 ? pts[idx] : { x: cx, y: cy };
        var dx = cx - p.x, dy = cy - p.y, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
        var spot = null, a, q;
        for (a = 0; a < CHIP_T.length && !spot; a++) {
          for (q = 0; q < CHIP_SLIDE.length && !spot; q++) {
            var x = p.x + dx * CHIP_T[a] + nx * CHIP_SLIDE[q];
            var y = p.y + dy * CHIP_T[a] + ny * CHIP_SLIDE[q];
            var b = boxAt(x, y, cw + 4, ch + 4); // 2px clearance: sub-pixel rounding must not touch a seat
            if (!insideBox(b, W, H)) continue;
            if (chk.some(function (c) { return hitBox(c, b); })) continue;
            if (obst.some(function (c) { return hitBox(c, b); })) continue;
            if (placed.some(function (c) { return hitBox(c, b); })) continue;
            spot = { x: x, y: y, b: b };
          }
        }
        if (!spot) {
          ok = false;
          var mx = p.x + dx * 0.5, my = p.y + dy * 0.5;
          spot = { x: mx, y: my, b: boxAt(mx, my, cw, ch) };
        }
        placed.push(spot.b);
        chip.style.left = spot.x.toFixed(1) + 'px';
        chip.style.top = spot.y.toFixed(1) + 'px';
      });
      T.setAttribute('data-layout', 'lv' + lv + ' s' + s.toFixed(2) + ' w' + F + (ok ? '' : ' fail'));
      return ok;
    }

    function attempt(lv, s, sy) {
      for (var fi = 0; fi < LAYOUT_WIDTH_F.length; fi++) {
        if (place(lv, s, LAYOUT_WIDTH_F[fi], sy)) return true;
      }
      place(lv, s, LAYOUT_WIDTH_F[LAYOUT_WIDTH_F.length - 1], sy);
      return false;
    }

    var done = false, lvI, si;
    for (lvI = 0; lvI < 4 && !done; lvI++) done = attempt(lvI, 1);
    // shrink the ring: first both axes, then only the width (the ring keeps its height, so the bottom
    // seats stay below the pot block and the top seats stay above it)
    for (si = 0; si < LAYOUT_SCALES.length && !done; si++) done = attempt(3, LAYOUT_SCALES[si]) || attempt(3, LAYOUT_SCALES[si], 1);
    // extra-compact level: the ring and the seat plates shrink until no two boxes meet (the search ends
    // at the smallest scale; the result is recorded in data-layout as 'fail' only if even that does not fit)
    for (si = 0; si < LAYOUT_SCALES_XC.length && !done; si++) done = attempt(4, LAYOUT_SCALES_XC[si]) || attempt(4, LAYOUT_SCALES_XC[si], 1);
    if (!done) attempt(4, LAYOUT_SCALES_XC[LAYOUT_SCALES_XC.length - 1]);
  }

  // ---------- winner reveal: best five cards, hand name, highlighted cards ----------
  var RANK_ORDER = '23456789TJQKA';
  var RANK_WORDS = {
    en: { '2': ['two', 'twos'], '3': ['three', 'threes'], '4': ['four', 'fours'], '5': ['five', 'fives'], '6': ['six', 'sixes'],
      '7': ['seven', 'sevens'], '8': ['eight', 'eights'], '9': ['nine', 'nines'], 'T': ['ten', 'tens'], 'J': ['jack', 'jacks'],
      'Q': ['queen', 'queens'], 'K': ['king', 'kings'], 'A': ['ace', 'aces'] },
    es: { '2': ['dos', 'doses'], '3': ['tres', 'treses'], '4': ['cuatro', 'cuatros'], '5': ['cinco', 'cincos'], '6': ['seis', 'seises'],
      '7': ['siete', 'sietes'], '8': ['ocho', 'ochos'], '9': ['nueve', 'nueves'], 'T': ['diez', 'dieces'], 'J': ['sota', 'sotas'],
      'Q': ['reina', 'reinas'], 'K': ['rey', 'reyes'], 'A': ['as', 'ases'] }
  };
  var HAND_TEXT = {
    en: ['High card, {a}', 'Pair of {a}', 'Two pair, {a} and {b}', 'Three {a}', 'Straight to the {a}', 'Flush, {a} high',
      'Full house, {a} over {b}', 'Four {a}', 'Straight flush to the {a}'],
    es: ['Carta alta, {a}', 'Pareja de {a}', 'Doble pareja, {a} y {b}', 'Trío de {a}', 'Escalera hasta {a}', 'Color, {a} alta',
      'Full: {a} sobre {b}', 'Póker de {a}', 'Escalera de color hasta {a}']
  };

  // Best five of the given cards (5..7 codes such as 'As'), by the shared evaluator (public/engine.js).
  function bestFive(cards) {
    var E = window.PokerEngine;
    if (!E || typeof E.evaluateHand !== 'function' || !Array.isArray(cards) || cards.length < 5) return null;
    var best = null, bestScore = -1, pick = [];
    (function rec(start) {
      if (pick.length === 5) {
        var sc = E.evaluateHand(pick.slice()).score;
        if (sc > bestScore) { bestScore = sc; best = pick.slice(); }
        return;
      }
      for (var i = start; i < cards.length; i++) { pick.push(cards[i]); rec(i + 1); pick.pop(); }
    })(0);
    return best ? { cards: best, rank: E.evaluateHand(best).rank } : null;
  }

  // Readable hand name for the best five, e.g. "Two pair, aces and tens" / "Doble pareja, ases y dieces".
  function describeBest(best) {
    var es = lang() === 'es';
    var W = RANK_WORDS[es ? 'es' : 'en'];
    var cnt = {};
    best.cards.forEach(function (c) { var r = String(c).charAt(0).toUpperCase(); cnt[r] = (cnt[r] || 0) + 1; });
    var groups = Object.keys(cnt).sort(function (a, b) {
      return (cnt[b] - cnt[a]) || (RANK_ORDER.indexOf(b) - RANK_ORDER.indexOf(a));
    });
    var top = groups[0];
    if ((best.rank === 4 || best.rank === 8) && cnt['A'] && cnt['2'] && cnt['5']) top = '5'; // wheel: A-2-3-4-5
    var single = best.rank === 0 || best.rank === 4 || best.rank === 5 || best.rank === 8;
    var a = single ? W[top][0] : W[top][1];
    var b = groups[1] ? W[groups[1]][1] : '';
    var tpl = HAND_TEXT[es ? 'es' : 'en'][best.rank] || '';
    return tpl.replace('{a}', a).replace('{b}', b);
  }

  // Per winner with a showdown: the best five, the board cards they use and the readable name.
  function winnerReveal(h) {
    var out = {};
    if (!h || !h.over || !Array.isArray(h.winners)) return out;
    var board = Array.isArray(h.board) ? h.board : [];
    h.winners.forEach(function (w) {
      var x = seatOf(h, w.seat);
      if (!x || !w.hand || !hasFaces(x) || board.length < 5) return;
      var best = bestFive(x.cards.concat(board));
      if (!best) return;
      out[w.seat] = { best: best.cards, hole: best.cards.filter(function (c) { return x.cards.indexOf(c) >= 0; }),
        board: best.cards.filter(function (c) { return board.indexOf(c) >= 0; }), text: describeBest(best) };
    });
    return out;
  }

  function renderTable(s) {
    var h = s.hand;
    var me = heroSeat(s);
    var seats = Array.isArray(h.seats) ? h.seats : [];
    var labels = core.positionLabels(seats.map(function (x) { return x.seat; }), h.dealer);
    var won = {};
    (Array.isArray(h.winners) ? h.winners : []).forEach(function (w) { won[w.seat] = true; });
    var reveal = winnerReveal(h);
    var bestBoard = {};
    Object.keys(reveal).forEach(function (k) { reveal[k].board.forEach(function (c) { bestBoard[c] = true; }); });
    var showdownOn = Object.keys(reveal).length > 0;
    var seatsHtml = '';
    var betsHtml = '';
    seats.forEach(function (x) {
      var cls = ['mp-seat', x.folded ? 'folded' : 'live'];
      var hl = x.bot ? DEFAULT_HL : (x.seat === me ? myHighlight() : hlOf(playerAtSeat(s, x.seat)));
      if (x.bot) cls.push('bot');
      if (x.seat === me) cls.push('me');
      if (x.seat === h.toAct) cls.push('turn');
      if (won[x.seat]) cls.push('winner');
      var label = labels[x.seat] || '';
      seatsHtml += '<div class="' + cls.join(' ') + '" data-seat="' + esc(x.seat) + '" style="--hl:' + hl + '">' +
        '<div class="mp-seat-top">' +
          (label ? '<span class="mp-pos' + (label === 'BTN' ? ' btn' : '') + '">' + esc(label) + '</span>' : '') +
          (x.seat === h.dealer ? '<span class="mp-dealer" title="' + esc(tr('mp.dealer')) + '">D</span>' : '') +
        '</div>' +
        '<div class="mp-seat-who">' + (x.bot ? botAvHtml({ avatar: seatAvatar(s, x.seat), name: x.name }, 'sm')
          : avHtml(seatAvatar(s, x.seat), x.seat === me ? tr('mp.you') : x.name, 'sm')) +
          '<span class="mp-name">' + esc(x.seat === me ? tr('mp.you') : x.name) + '</span>' +
          eloTag(x) + '</div>' +
        '<span class="mp-stack">' + bbTxt(x.stack) + '</span>' +
        (x.lastAction ? actSymHtml(x.lastAction) : '') +
        (x.seat === me ? '' : miniCards(x, reveal[x.seat])) +
        (won[x.seat] ? winTag(h, x.seat, reveal[x.seat]) + gainTag(h, x.seat) : '') +
        (x.shownTo === 'observers' && x.seat !== me ? '<span class="mp-shown-tag">' + esc(tr('mp.shown')) + '</span>' : '') +
        (x.folded || x.seat === me || hasFaces(x) ? '' : '<span class="mp-backs" aria-hidden="true"><i></i><i></i></span>') +
        '</div>';
      if (Number(x.bet) > 0) {
        betsHtml += '<span class="mp-bet" data-seat="' + esc(x.seat) + '">' + bbTxt(x.bet) + '</span>';
      }
    });
    if (window.SeatCard) SeatCard.bindGloss(C.lang === 'es' ? 'es' : 'en');
    setHtml(E.seats, 'seats', seatsHtml);
    dealAnimate(h, Array.prototype.slice.call(E.seats.querySelectorAll('.mp-seat')));
    setHtml(E.bets, 'bets', betsHtml);
    layoutTable();
    if (C.tipSeat != null) showTip(C.tipSeat);

    var board = Array.isArray(h.board) ? h.board : [];
    var boardHtml = '';
    for (var i = 0; i < 5; i++) {
      var bc = i < board.length ? board[i] : null;
      var bcls = !showdownOn || bc === null ? 'board' : bestBoard[bc] ? 'board best' : 'board dim';
      boardHtml += cardHtml(bc, bcls);
    }
    setHtml(E.board, 'board', boardHtml);
    // new board cards (flop, turn, river) flip in one after another; cards already shown stay still
    var boardSeen = C.boardHand === h.id ? C.boardSeen : 0;
    if (board.length > boardSeen) flipCards(E.board.children, boardSeen, board.length, 120);
    C.boardHand = h.id;
    C.boardSeen = board.length;


    E.pot.textContent = tr('mp.pot', { amt: bbTxt(h.pot) });
    E.street.textContent = tr('mp.street.' + (h.street || 'preflop'));

    var wins = Array.isArray(h.winners) ? h.winners : [];
    var bannerHtml = '';
    if (wins.length) {
      bannerHtml = wins.map(function (w) {
        var rv = reveal[w.seat];
        return '<div class="mp-win">' + esc(tr('mp.win', { name: seatName(s, w.seat), amt: bbTxt(w.amount) })) +
          (rv ? ' · ' + esc(rv.text) : '') + '</div>';
      }).join('') + '<div class="mp-next">' + esc(tr('mp.nextAuto')) + '</div>';
    }
    setHtml(E.banner, 'banner', bannerHtml);
    E.banner.classList.toggle('hidden', !wins.length);

    if (h.over && C.overKey !== h.id) { C.overKey = h.id; C.overAt = Date.now(); }
    var hero = Array.isArray(h.youCards) && h.youCards.length ? h.youCards : [null, null];
    var mine = seatOf(h, me);
    // Show my hand: the hole cards themselves are the button while the window is open (busted spectators never).
    var shownNow = !!mine && (!!mine.revealed || !!mine.shown || mine.shownTo === 'observers' || (!!h.over && C.shownKey === h.id));
    var windowOpen = !!h.showWindowMs && Date.now() - (C.overAt || Date.now()) < Number(h.showWindowMs);
    // Between hands the window is timed; during a hand the cards show to folded players only (any seated player).
    var midOk = !h.over && Array.isArray(h.youCards) && h.youCards.length === 2;
    var canShow = !!mine && !shownNow && !amOut(s) && (h.over ? windowOpen : midOk);
    var shownHint = shownNow ? '<span class="mp-show-hint">' + esc(tr(h.over ? 'mp.shown' : 'mp.shownFolded')) + '</span>' : '';
    var rvMe = reveal[me];
    var heroCls = function (c) { return 'hero' + (rvMe && rvMe.best.indexOf(c) >= 0 ? ' best' : rvMe ? ' dim' : ''); };
    var facesHtml = '<span class="mp-hero-faces">' + cardHtml(hero[0], heroCls(hero[0])) + cardHtml(hero[1], heroCls(hero[1])) + '</span>';
    var cardsBox = canShow
      ? '<button type="button" class="mp-hero-cards mp-show-cards" data-act="show-hand" aria-label="' + esc(showLabel(h)) + '">' +
        facesHtml + '<span class="mp-show-hint">' + esc(tr('mp.showCards')) + '</span></button>' +
        (h.over ? '<span class="mp-show-count">' + esc(showLabel(h)) + '</span>' : '')
      : '<div class="mp-hero-cards' + (shownNow ? ' mp-show-cards shown' : '') + '">' + facesHtml + shownHint + '</div>';
    var heroHtml = cardsBox +
      (mine ? '<p class="mp-hero-info">' + esc(tr('mp.heroInfo', { pos: labels[me] || '', amt: bbTxt(mine.stack) })) + '</p>' : '');
    var dockEl = document.getElementById('mp-dock');
    if (dockEl && h.toAct !== me) dockEl.classList.remove('raise-open');
    setHtml(E.hero, 'hero', heroHtml);
    if (C.heroFlipAt != null) { var flipAt = C.heroFlipAt; C.heroFlipAt = null; flipHeroCards(flipAt); }
  }

  // ---------- bot tooltip ----------
  function showTip(seat) {
    var s = C.state;
    var x = s.hand ? seatOf(s.hand, seat) : null;
    var seatEl = E.seats.querySelector('[data-seat="' + seat + '"]');
    if (!x || !x.bot || !seatEl) { hideTip(); return; }
    var info = core.rankInfo(s.hand.seats.map(function (v) { return v.stack; }), x.stack);
    var rel = info.pct === 0 ? tr('mp.tip.avg')
      : info.pct > 0 ? tr('mp.tip.above', { pct: info.pct }) : tr('mp.tip.below', { pct: -info.pct });
    E.tip.innerHTML = '<strong>' + esc(x.name) + '</strong> ' + eloTag(x) +
      '<span class="mp-tip-stack">' + esc(tr('mp.tip.stack', { amt: bbTxt(x.stack), rank: info.rank, n: info.of, rel: rel })) + '</span>';
    E.tip.style.left = seatEl.style.left;
    E.tip.style.top = seatEl.style.top;
    E.tip.classList.remove('hidden');
    C.tipSeat = seat;
  }

  function hideTip() {
    clearTimeout(C.tipTimer);
    C.tipSeat = null;
    E.tip.classList.add('hidden');
  }

  function renderActions(s) {
    var h = s.hand;
    var my = core.isMyTurn(s) && !s.paused;
    var legal = my ? h.legal : {};
    var toCall = my ? (Number(h.toCall) || 0) : 0;
    var mine = seatOf(h, heroSeat(s));
    var bounds = my ? core.raiseBounds(h) : null;

    E.fold.disabled = !(my && legal.fold !== false);
    E.fold.classList.toggle('free-check', !!my && toCall === 0);
    E.call.disabled = !(my && legal.call !== false);
    E.callLabel.textContent = toCall > 0 ? tr('mp.call', { amt: bbTxt(toCall) }) : tr('mp.check');

    var amt = 0;
    if (bounds) {
      C.raiseAmt = core.clampAmount(C.raiseAmt == null ? bounds.min : C.raiseAmt, bounds.min, bounds.max);
      C.presets = core.raisePresets(h, mine ? mine.bet : 0);
      amt = C.raiseAmt;
    } else {
      C.presets = null;
    }
    E.raise.disabled = !bounds;
    E.raiseLabel.textContent = bounds
      ? (toCall > 0 ? tr('mp.raiseTo', { amt: bbTxt(amt) }) : tr('mp.bet', { amt: bbTxt(amt) }))
      : tr('mp.raise');
    E.rRange.disabled = !bounds;
    E.rNum.disabled = !bounds;
    E.quick.forEach(function (b) { b.disabled = !bounds; });
    if (isPhone()) renderPhonePresets();
    if (bounds) {
      E.rRange.min = String(bounds.min);
      E.rRange.max = String(bounds.max);
      E.rNum.min = String(bounds.min);
      E.rNum.max = String(bounds.max);
      if (document.activeElement !== E.rRange) E.rRange.value = String(amt);
      if (document.activeElement !== E.rNum) E.rNum.value = String(amt);
      E.rBB.textContent = bbTxt(amt);
    } else if (document.activeElement !== E.rNum) {
      E.rNum.value = C.raiseAmt != null ? String(C.raiseAmt) : '';
      E.rBB.textContent = C.raiseAmt != null ? bbTxt(C.raiseAmt) : '';   // not your turn: show the last amount, dimmed
    }
  }

  // Tracks whose turn it is; a new turn restarts the countdown and resets the raise amount.
  function trackTurn(h) {
    var k = core.turnKey(h);
    if (k !== C.tk) {
      C.tk = k;
      C.turnStart = Date.now();
      C.raiseAmt = null;
    }
  }

  // Shown on my table while I wait for the next deal (a newcomer joined a running game).
  function updateJoinNote() {
    if (!E.joinNote) return;
    var s = C.state || {};
    var me = heroSeat(s);
    var waiting = me != null && (s.players || []).some(function (p) { return p.seat === me && !!p.waiting; });
    E.joinNote.hidden = !waiting;
    var txt = waiting ? tr('mp.joinNext') : '';
    if (E.joinNote.textContent !== txt) E.joinNote.textContent = txt;
  }

  function updateTurn() {
    var s = C.state;
    var h = s.hand;
    if (!h) return;
    var my = core.isMyTurn(s);
    var rem;
    if (C.clk) {
      // Server clock: hand.turnLeftMs is frozen by the server while paused.
      rem = core.remainingFrom(C.clk.left, C.clk.at, Date.now(), !!s.paused);
    } else {
      // Old server without turnLeftMs: local estimate, frozen while paused.
      var nowMs = Date.now();
      if (s.paused) {
        if (!C.pausedAt) C.pausedAt = nowMs;
        nowMs = C.pausedAt;
      } else if (C.pausedAt) {
        C.turnStart += nowMs - C.pausedAt;
        C.pausedAt = 0;
      }
      rem = core.turnRemaining(C.turnStart, nowMs);
    }
    // The active seat is the only turn indicator: its ring shows the time left (--p, 0 to 1).
    var active = E.seats && h.toAct != null ? E.seats.querySelector('.mp-seat.turn') : null;
    if (active) active.style.setProperty('--p', (rem / core.TURN_MS).toFixed(4));
    var sb = E.hero ? E.hero.querySelector('.mp-show') : null;
    if (sb && h.over) sb.textContent = showLabel(h);
    var text = '';
    if (h.toAct != null) {
      text = my ? tr('mp.yourTurn') : tr('mp.waiting', { name: seatName(s, h.toAct) });
    }
    if (E.turnText.textContent !== text) E.turnText.textContent = text;
  }

  function renderStandings() {
    var s = C.state;
    var list = (s.standings && s.standings.length ? s.standings : (s.hand ? s.hand.seats : []))
      .slice().sort(function (a, b) { return Number(b.stack || 0) - Number(a.stack || 0); });
    E.standList.innerHTML = list.map(function (p, i) {
      return '<li class="mp-prow">' + '<span class="mp-rank">' + (i + 1) + '</span>' +
        avHtml(p.avatar, p.name, 'sm') + '<span class="mp-pname">' + esc(p.name) + '</span>' +
        '<span class="mp-stack">' + bbTxt(p.stack) + '</span></li>';
    }).join('');
  }

  // A joined player who is not in the lobby list has busted out: spectators see the table only.
  function renderSpectator(s) {
    var dock = document.getElementById('mp-dock');
    if (!dock || !s.me) return;
    var out = amOut(s) || (!s.players.some(function (p) { return p.clientId === s.me.clientId; }) && !!s.hand && s.me.seat == null);
    dock.classList.toggle('spectating', out);
    var note = document.getElementById('mp-out-note');
    if (out && !note) {
      note = document.createElement('p');
      note.id = 'mp-out-note';
      note.className = 'mp-out-note';
      note.setAttribute('role', 'status');
      dock.insertBefore(note, dock.firstChild);
    }
    if (note) {
      note.textContent = out ? tr('mp.out') : '';
      note.classList.toggle('hidden', !out);
    }
  }

  // Deal animation (same helper as the solo tables, PokerAnim): card backs fly from the dealer seat to each seat in
  // turn (90 ms apart, two rounds), then the hero's own cards flip once every card has landed. Transform and opacity only.
  function dealAnimate(h, seatEls) {
    var table = document.getElementById('mp-table');
    if (!table || h.over || C.dealKey === h.id) return;
    C.dealKey = h.id;
    var A = window.PokerAnim;
    if (!A || !A.enabled()) return; // reduced motion or hidden tab: the final state is already rendered
    var from = null;
    seatEls.forEach(function (el) {
      if (Number(el.getAttribute('data-seat')) === h.dealer) from = el;
    });
    var fromR = from ? A.rectIn(table, from) : null;
    var targets = [];
    seatEls.forEach(function (el) {
      var num = Number(el.getAttribute('data-seat'));
      if (!h.seats.some(function (x) { return x.seat === num && x.inHand; })) return;
      var r = A.rectIn(table, el);
      if (r) targets.push(r);
    });
    if (!targets.length) return;
    A.clear(table); // a flight left from the previous hand is removed, not drawn over this one
    A.flyCards(table, fromR, targets, { rounds: 2, stagger: 90, duration: 380 }).catch(function () {});
    // the hero's cards are drawn after the seats (render), so their flip is queued there (heroFlipAt)
    C.heroFlipAt = (2 * targets.length - 1) * 90 + 380;
  }

  // hero cards of a new deal: hidden, then revealed by a face-up flip (PokerAnim.flipReveal), after the flights land
  function flipCards(list, from, to, stagger) {
    var A = window.PokerAnim;
    if (!A || !A.enabled() || !list) return; // reduced motion: the cards stay shown
    var cards = Array.prototype.slice.call(list, from, to);
    if (!cards.length) return;
    cards.forEach(function (c) { c.style.opacity = '0'; });
    var show = function (c) { c.style.opacity = ''; };
    A.flipReveal(cards, { delay: 0, stagger: stagger, lift: 6, onMid: show }).catch(function () {});
    // safety: a flip cancelled by a new deal must never leave a card hidden
    setTimeout(function () { cards.forEach(show); }, stagger * cards.length + 900);
  }

  // hero cards of a new deal: hidden, then revealed by a face-up flip, after the flights land
  function flipHeroCards(delay) {
    var A = window.PokerAnim;
    if (!A || !A.enabled()) return; // reduced motion: the cards stay shown
    var cards = Array.prototype.slice.call(document.querySelectorAll('#mp-hero .mp-hero-faces > *'));
    if (!cards.length) return;
    cards.forEach(function (c) { c.style.opacity = '0'; });
    var show = function (c) { c.style.opacity = ''; };
    A.flipReveal(cards, { delay: delay, stagger: 120, onMid: show }).catch(function () {});
    setTimeout(function () { cards.forEach(show); }, delay + 120 * cards.length + 900);
  }

  function render() {
    if (!E.root) return;
    if (lang() !== C.lang) {
      C.lang = lang();
      C.sig = {};
      applyStatic();
    }
    var s = C.state;
    var joined = !!s.me;
    if (E.chipName) { E.chipName.textContent = C.name || ''; E.chipAv.innerHTML = avHtml(C.avatar, C.name, 'sm'); }
    var slot = joined ? E.sideSlot : E.entrySlot;
    if (E.profile.parentNode !== slot) slot.appendChild(E.profile);
    E.profileDetails.classList.toggle('hidden', !joined);
    E.saveProfile.classList.toggle('hidden', !joined);
    E.join.classList.toggle('hidden', joined);
    E.entry.classList.toggle('hidden', joined);
    E.body.classList.toggle('hidden', !joined);
    if ((s.error || '') !== C.shownErr) {
      C.shownErr = s.error || '';
      E.err.textContent = C.shownErr;
      E.err.classList.toggle('hidden', !C.shownErr);
      clearTimeout(C.errTimer);
      if (C.shownErr) C.errTimer = setTimeout(function () { E.err.classList.add('hidden'); }, 4500);
    }
    renderConn();
    renderProfilePreview();
    E.root.classList.toggle('is-ranked', isRanked());
    E.lobby.querySelector('.mp-lobby-title').textContent = isRanked() ? rk(rankedTable() ? 'waitTable' : 'waitOpp') : tr('mp.title');
    if (s.gameOverId && s.gameOverId !== C.seenGameOver) {
      C.seenGameOver = s.gameOverId;
      renderStandings();
      E.standings.classList.remove('hidden');
    }
    if (!joined) return;

    var hasHand = !!s.hand;
    E.lobby.classList.toggle('hidden', hasHand);
    E.tableView.classList.toggle('hidden', !hasHand || !C.wantConnected);
    renderHost(s);
    renderPause(s);
    renderSpectator(s);
    renderPlayers(s);
    updateJoinNote();
    renderCamControls();
    renderCams(s);
    if (hasHand) {
      trackTurn(s.hand);
      if (window.PokerSound) PokerSound.observeHand(s.hand, heroSeat(s)); // sound.js: deal, board, pot, winners, turn
      renderTable(s);
      renderActions(s);
      updateTurn();
    }
    layoutCams();
    if (!hasHand && window.PokerSound) PokerSound.observeHand(null);

    afterRenderFx();
  }

  // Profile preview: pending photo first, then the saved one. Initials when there is none.
  function renderProfilePreview() {
    var src = C.pAvatar !== undefined ? C.pAvatar : C.avatar;
    var name = E.name.value || C.name;
    E.profImg.src = src || '';
    E.profImg.classList.toggle('hidden', !src);
    E.profInit.classList.toggle('hidden', !!src);
    E.profInit.textContent = core.initials(name);
    E.removePhoto.classList.toggle('hidden', !src);
  }

  function renderBotEdit() {
    var b = C.botEdit;
    E.botEdit.classList.toggle('hidden', !b);
    if (!b) return;
    E.beImg.src = b.avatar || '';
    E.beImg.classList.toggle('hidden', !b.avatar);
    E.beInit.classList.toggle('hidden', !!b.avatar);
    E.beInit.textContent = core.initials(E.beName.value || b.name);
  }

  function applyStatic() {
    E.root.querySelectorAll('[data-mp-i18n]').forEach(function (el) {
      el.textContent = tr(el.getAttribute('data-mp-i18n'));
    });
    E.root.querySelectorAll('[data-mp-ph]').forEach(function (el) {
      el.setAttribute('placeholder', tr(el.getAttribute('data-mp-ph')));
    });
    var levels = window.PokerLadder.LADDER.map(function (b) {
      return '<option value="' + b.id + '">' + b.table + '</option>';
    }).join('');
    [E.botStyle, E.beStyle, E.admStyle].forEach(function (sel) {
      var cur = sel.value;
      sel.innerHTML = (sel === E.beStyle ? '' : '<option value="">' + esc(tr('mp.botMix')) + '</option>') + levels;
      sel.value = cur;
    });
    E.setStacks.innerHTML = '<option value="default">' + esc(tr('mp.stacksDefault')) + '</option>' +
      '<option value="custom">' + esc(tr('mp.stacksCustom')) + '</option>';
    var bu = '<option value="0">' + esc(tr('mp.blindUpOff')) + '</option>';
    for (var n = 1; n <= 10; n++) bu += '<option value="' + n + '">' + esc(tr('mp.blindUpMin', { n: n })) + '</option>';
    E.setBlindUp.innerHTML = bu;
    if (E.dlgBlindUp) E.dlgBlindUp.innerHTML = bu;
    var specOpts = ['live', 'afterHand', 'off'].map(function (v) {
      return '<option value="' + v + '">' + esc(tr('mp.spec.' + v)) + '</option>';
    }).join('');
    if (E.setSpec) E.setSpec.innerHTML = specOpts;
    if (E.setLate) E.setLate.innerHTML = ['start', 'half', 'avg', 'fixed'].map(function (v) {
      return '<option value="' + v + '">' + esc(tr('mp.late.' + v)) + '</option>';
    }).join('');
    if (E.dlgSpec) E.dlgSpec.innerHTML = specOpts;
  }

  function tick() {
    if (!E.root) return;
    if (lang() !== C.lang) { render(); return; }
    renderBlinds();
    if (C.state.hand) {
      trackTurn(C.state.hand);
      updateTurn();
    }
  }

  // ---------- phone raise: BB presets, long-press exact amount ----------
  var raiseLP = { timer: null, fired: false };
  var rpop = { open: false };
  var QLBL = {
    en: { min: 'Min', half: '1/2 pot', threeq: '3/4 pot', pot: 'Pot', allin: 'All-in' },
    es: { min: 'Mín', half: '1/2 bote', threeq: '3/4 bote', pot: 'Bote', allin: 'All-in' }
  };
  function isPhone() { return !!window.matchMedia && window.matchMedia('(pointer: coarse), (max-width: 600px)').matches; }
  function bbSize() { var s = C.state && C.state.settings; return s && Number(s.bb) > 0 ? Number(s.bb) : 0; }
  // Amount in BB at the current big blind (or at the bb given, e.g. the one a chat line was written with).
  function bbTxt(chips, bb) { return core.fmtBB(chips, bb != null ? bb : bbSize()); }
  function bbNum(chips) { return core.fmtBB(chips, bbSize(), true); }
  function renderPhonePresets() {
    var bb = bbSize(), L = QLBL[lang() === 'es' ? 'es' : 'en'];
    E.quick.forEach(function (b) {
      var q = b.getAttribute('data-q'), v = C.presets ? C.presets[q] : null;
      b.innerHTML = '<span class="qn">' + esc(L[q] || q) + '</span><small class="qv">' +
        (v != null && bb ? bbTxt(v) : '&mdash;') + '</small>';
    });
  }
  function openRaisePop() {
    var b = core.raiseBounds(C.state.hand), bb = bbSize();
    if (!b || !bb || rpop.open) return;
    rpop.open = true;
    var pop = document.getElementById('mp-rpop');
    document.getElementById('mp-rpop-in').value = bbNum(C.raiseAmt || b.min);
    document.getElementById('mp-rpop-err').classList.add('hidden');
    document.getElementById('mp-rpop-cancel').textContent = lang() === 'es' ? 'Cancelar' : 'Cancel';
    document.getElementById('mp-rpop-ok').textContent = lang() === 'es' ? 'Confirmar' : 'Confirm';
    pop.classList.remove('hidden');
    document.getElementById('mp-rpop-in').focus();
  }
  function closeRaisePop() {
    if (!rpop.open) return;
    rpop.open = false;
    document.getElementById('mp-rpop').classList.add('hidden');
  }
  function stepRaisePop(dir) {
    var inp = document.getElementById('mp-rpop-in');
    inp.value = String(Math.round(Math.max(0, (Number(inp.value) || 0) + dir * 0.5) * 10) / 10);
  }
  function confirmRaisePop() {
    var b = core.raiseBounds(C.state.hand), bb = bbSize();
    var err = document.getElementById('mp-rpop-err');
    var v = Number(document.getElementById('mp-rpop-in').value);
    // The typed BB become chips at this bb, then clamp to the legal raise range (no error for a too-big or too-small value).
    var amt = core.bbToChips(v, bb);
    if (!b || !bb || !isFinite(v) || v < 0) {
      err.textContent = (lang() === 'es' ? 'Entre ' : 'Between ') + bbTxt(b.min) + ' ' + (lang() === 'es' ? 'y ' : 'and ') + bbTxt(b.max);
      err.classList.remove('hidden');
      return;
    }
    // Confirm makes the typed amount the raise and sends it now (the long press is the explicit intent), as solo does.
    amt = core.clampAmount(amt, b.min, b.max);
    C.raiseAmt = amt;
    closeRaisePop();
    sendAct({ action: 'raise', amount: core.clampAmount(amt, b.min, b.max) });
    render();
  }

  // ---------- user actions ----------
  function setRaise(v) {
    var b = core.raiseBounds(C.state.hand);
    if (!b) return;
    C.raiseAmt = core.clampAmount(v, b.min, b.max);
    render();
  }

  function sendSettings() {
    var stack = core.bbToChips(E.setStack.value, bbSize());  // the field is in BB; the server takes chips
    // Only a changed stack is checked (blind-ups can leave an unchanged stack below 5 BB).
    if (!(C.state.settings && stack === C.state.settings.stack) && !core.stackOk(stack, bbSize())) {
      E.setErr.textContent = tr('mp.settingsInvalid');
      E.setErr.classList.remove('hidden');
      return;
    }
    E.setErr.classList.add('hidden');
    send({
      t: 'settings',
      stack: stack,
      blindUpMin: Number(E.setBlindUp.value) || 0,
      spectatorCards: E.setSpec ? E.setSpec.value : 'live',
      lateStack: E.setLate ? E.setLate.value : 'start',
      lateFixedBB: E.setLateBB && Number.isFinite(Number(E.setLateBB.value)) ? Math.min(STACK_MAX_BB, Math.max(STACK_MIN_BB, Math.round(Number(E.setLateBB.value) * 2) / 2)) : undefined,
      botShowCards: !!E.setBShow.checked,
      // 'default' is a label only: keep the server's equal/varied mode, and send 'custom' only when chosen
      stacks: E.setStacks.value === 'custom' ? 'custom' : (C.state.settings && C.state.settings.stacks === 'varied' ? 'varied' : 'equal')
    });
  }

  function sendStack(input) {
    var v = core.bbToChips(input.value, bbSize());  // BB in the field, whole chips on the wire
    if (!core.stackOk(v, bbSize())) {
      E.setErr.textContent = tr('mp.settingsInvalid');
      E.setErr.classList.remove('hidden');
      return;
    }
    send({ t: 'setStack', seat: Number(input.getAttribute('data-seat')), stack: v });
  }

  function addBot(style, name) {
    var msg = { t: 'addBot' }; // no style: the server picks a random Elo
    if (style) msg.style = style;
    var nm = core.cleanName(name);
    if (nm) msg.name = nm;
    send(msg);
  }

  function openBotEdit(seat) {
    var p = C.state.players.filter(function (q) { return q.bot && q.seat === seat; })[0];
    if (!p) return;
    C.botEdit = { seat: seat, name: p.name, avatar: p.avatar || '' };
    E.beName.value = p.name;
    E.beStyle.value = p.style;
    renderBotEdit();
  }

  function saveBotEdit() {
    var b = C.botEdit;
    if (!b) return;
    var nm = core.cleanName(E.beName.value) || b.name;
    send({ t: 'editBot', seat: b.seat, name: nm, style: E.beStyle.value, avatar: b.avatar || null });
    C.botEdit = null;
    renderBotEdit();
  }

  function setPhotoErr(msg) {
    C.photoErr = msg;
    E.profErr.textContent = msg || '';
    E.profErr.classList.toggle('hidden', !msg);
  }

  // Draws the centre square of a source into a 96x96 JPEG within the size budget.
  // Centre crop to 4:3 and resize to 240x180 JPEG, the highest quality that fits the byte cap.
  function squareAvatar(src, w, h) {
    var ar = AVATAR_W / AVATAR_H;
    var cw = w;
    var ch = w / ar;
    if (ch > h) { ch = h; cw = h * ar; }
    var cv = document.createElement('canvas');
    cv.width = AVATAR_W;
    cv.height = AVATAR_H;
    var g = cv.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, (w - cw) / 2, (h - ch) / 2, cw, ch, 0, 0, AVATAR_W, AVATAR_H);
    return core.pickAvatar(function (q) { return cv.toDataURL('image/jpeg', q); }, core.AVATAR_MAX_BYTES);
  }

  // A chosen photo goes to the profile draft or to the bot being edited.
  function usePhoto(dataUrl) {
    if (!dataUrl) { setPhotoErr(tr('mp.photo.tooBig')); return; }
    setPhotoErr('');
    if (C.fileTarget === 'bot' && C.botEdit) {
      C.botEdit.avatar = dataUrl;
      renderBotEdit();
    } else {
      C.pAvatar = dataUrl;
      renderProfilePreview();
    }
  }

  // Rooms screen: the same photo path as the profile dialog (image type, square crop, size budget), but the
  // result is only handed back (cb(dataUrl), or cb(null) when it is not an image or too big); the profile is untouched.
  function photoFromFile(f, cb) {
    if (!f || !/^image\//.test(f.type)) { cb(null); return; }
    var url = URL.createObjectURL(f);
    var img = new Image();
    img.onload = function () {
      var out = squareAvatar(img, img.naturalWidth, img.naturalHeight);
      URL.revokeObjectURL(url);
      cb(out || null);
    };
    img.onerror = function () { URL.revokeObjectURL(url); cb(null); };
    img.src = url;
  }

  function onFile(e) {
    var f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (!/^image\//.test(f.type)) { setPhotoErr(tr('mp.photo.bad')); return; }
    var url = URL.createObjectURL(f);
    var img = new Image();
    img.onload = function () {
      var out = squareAvatar(img, img.naturalWidth, img.naturalHeight);
      URL.revokeObjectURL(url);
      usePhoto(out);
    };
    img.onerror = function () { URL.revokeObjectURL(url); setPhotoErr(tr('mp.photo.bad')); };
    img.src = url;
  }

  async function startCapture() {
    setPhotoErr('');
    if (!hasMedia()) { setPhotoErr(tr('mp.cam.noMedia')); return; }
    try {
      C.capStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      E.capVideo.srcObject = C.capStream;
      E.cap.classList.remove('hidden');
      var pr = E.capVideo.play && E.capVideo.play();
      if (pr && pr.catch) pr.catch(noop);
    } catch (e) {
      setPhotoErr(tr('mp.cam.denied'));
    }
  }

  function stopCapture() {
    stopStream(C.capStream);
    C.capStream = null;
    E.capVideo.srcObject = null;
    E.cap.classList.add('hidden');
  }

  function captureFrame() {
    var v = E.capVideo;
    var w = v.videoWidth || 0;
    var h = v.videoHeight || 0;
    var out = w && h ? squareAvatar(v, w, h) : null;
    stopCapture();
    usePhoto(out);
  }

  function saveProfile() {
    var nm = core.cleanName(E.name.value);
    if (!nm) { setPhotoErr(tr('mp.nameRequired')); return; }
    C.name = nm;
    if (C.pAvatar !== undefined) { C.avatar = C.pAvatar; C.pAvatar = undefined; }
    savePrefs();
    sendProfile();
    setPhotoErr('');
    render();
  }

  function clearPending() {
    C.pendingKey = null;
    clearTimeout(C.pendingTimer);
    C.pendingTimer = null;
  }

  // One act per turn: while an act for this turn key is pending, further clicks (and F/C/R keys) do nothing.
  function sendAct(payload) {
    var h = C.state.hand;
    if (!h || C.state.paused) return;
    var key = core.turnKey(h);
    if (C.pendingKey === key && Date.now() - C.pendingAt < 2000) return;
    C.pendingKey = key;
    C.pendingAt = Date.now();
    clearTimeout(C.pendingTimer);
    C.pendingTimer = setTimeout(clearPending, 2000);
    if (send(Object.assign({ t: 'act', turn: key }, payload))) { C.lastAct = null; return; }
    clearPending();
    if (C.left) return; // removed from the table: nothing is sent and no connection banner
    C.lastAct = { key: key, payload: payload };
    C.state = Object.assign({}, C.state, { error: tr('mp.noAct') });
    render();
  }

  var flashTimer = null;
  function flash(text, ms) {
    if (!E.toast) return;
    E.toast.textContent = text;
    E.toast.classList.remove('hidden');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { E.toast.classList.add('hidden'); }, ms || 4000);
  }

  // Pause banner: a sibling of the admin drawer, visible to everybody.
  function renderPause(s) {
    var on = !!s.paused;
    if (E.root) E.root.classList.toggle('mp-paused', on);
    if (!E.pauseBanner) return;
    E.pauseBanner.classList.toggle('hidden', !on);
    if (!on) return;
    var nm = s.pauseInfo && s.pauseInfo.name ? String(s.pauseInfo.name) : '';
    var txt = nm ? tr('mp.pausedBy', { name: nm }) : tr('mp.paused');
    if (E.pauseText.textContent !== txt) E.pauseText.textContent = txt;
    E.pauseResume.classList.toggle('hidden', !(s.me && s.me.host));
    E.pauseResume.textContent = tr('mp.resume');
  }

  function blindLeft(s) {
    if (!C.blind) return null;
    return core.remainingFrom(C.blind.left, C.blind.at, Date.now(), !!s.paused);
  }

  function renderBlinds() {
    var el = E.blindsChip;
    if (!el) return;
    var s = C.state;
    var st = s.settings || {};
    var show = !!(s.me && s.hand && typeof st.sb === 'number' && typeof st.bb === 'number');
    el.classList.toggle('hidden', !show);
    if (!show) return;
    var txt = tr('mp.blindsChip', { sb: core.fmtBB(st.sb, st.bb, true), bb: '1' });
    var left = blindLeft(s);
    if (left != null) txt += ' · ' + tr('mp.blindsNext', { t: core.clockText(left) });
    if (el.textContent !== txt) el.textContent = txt;
  }

  function handleAct(act, btn) {
    switch (act) {
      case 'cam': toggleCam(); break;
      case 'show-hand':
        send({ t: 'showHand' });
        if (C.state.hand && C.state.hand.over) C.shownKey = C.state.hand.id;
        render();
        break;
      case 'chat-toggle': toggleChat(); break;
      case 'close-sheet': closeSheets(); break;
      case 'chat-expand': chatState.expanded = !chatState.expanded; renderChat(); break;
      case 'bots-prev': C.botPage = (C.botPage || 0) - 1; render(); break;
      case 'bots-next': C.botPage = (C.botPage || 0) + 1; render(); break;
      case 'back-ask': askLeave(); break;
      case 'home': markSession(false); if (window.PokerRooms) window.PokerRooms.clear(); if (hasApp()) { try { window.PokerApp.showView('menu'); } catch (e) { /* view missing */ } } break;
      case 'external-call': {
        var ext = C.state.settings && C.state.settings.externalCallUrl;
        if (ext) window.open(ext, '_blank', 'noopener');
        break;
      }
      case 'save-ext': {
        var u = String(E.extUrl.value || '').trim().slice(0, 300);
        if (u && !/^https?:\/\//.test(u)) { E.setErr.textContent = tr('mp.ext.bad'); E.setErr.classList.remove('hidden'); break; }
        send({
          t: 'settings', stack: C.state.settings.stack, blindUpMin: C.state.settings.blindUpMin || 0,
          stacks: C.state.settings.stacks, externalCallUrl: u
        });
        break;
      }
      case 'toggle-settings': {
        var shut = E.lobbyEdit.classList.toggle('hidden');
        E.setToggle.setAttribute('aria-expanded', String(!shut));
        E.setToggle.textContent = tr(shut ? 'mp.lobby.editSettings' : 'mp.lobby.doneSettings');
        break;
      }
      case 'copy-code': {
        var code = C.state && C.state.roomName ? String(C.state.roomName) : null;
        if (code && navigator.clipboard) {
          navigator.clipboard.writeText(code).then(function () {
            E.codeCopy.textContent = tr('mp.lobby.copied');
            setTimeout(function () { E.codeCopy.textContent = tr('mp.lobby.copy'); }, 1500);
          }).catch(noop);
        }
        break;
      }
      case 'copy-url': {
        var url = btn && btn.getAttribute('data-url');
        if (url && navigator.clipboard) navigator.clipboard.writeText(url).catch(noop);
        break;
      }

      case 'chat-close': setView('cams'); break;
      case 'cam-retry': toggleCam(true); break;
      case 'mic': toggleMic(); break;
      case 'fold': sendAct({ action: 'fold' }); break;
      case 'call': sendAct({ action: 'call' }); break;
      case 'raise': {
        if (raiseLP.fired) { raiseLP.fired = false; break; }   // the long press opened the popover; no raise
        var b = core.raiseBounds(C.state.hand);
        var dk = document.getElementById('mp-dock');
        if (isLandscape() && dk && !dk.classList.contains('raise-open')) { dk.classList.add('raise-open'); layoutTable(); break; }
        if (b) sendAct({ action: 'raise', amount: core.clampAmount(C.raiseAmt, b.min, b.max) });
        break;
      }
      case 'rpop-inc': stepRaisePop(1); break;
      case 'rpop-dec': stepRaisePop(-1); break;
      case 'rpop-ok': confirmRaisePop(); break;
      case 'rpop-cancel': closeRaisePop(); break;
      case 'q': {
        var p = C.presets;
        if (p && p[btn.getAttribute('data-q')] != null) setRaise(p[btn.getAttribute('data-q')]);
        break;
      }
      case 'add-bot': addBot(E.botStyle.value, E.botName.value); E.botName.value = ''; break;
      case 'admin-add-bot': addBot(E.admStyle.value, ''); break;
      case 'remove-bot': send({ t: 'removeBot', seat: Number(btn.getAttribute('data-seat')) }); break;
      case 'kick': send({ t: 'kick', seat: Number(btn.getAttribute('data-seat')) }); break;
      case 'kicked-ok': dismissKicked(); break;
      case 'start': send({ t: 'start' }); break;
      case 'pause': send({ t: C.state.paused ? 'resume' : 'pause' }); break;
      case 'resume': send({ t: 'resume' }); break;
      case 'double-blinds': send({ t: 'doubleBlinds' }); break;
      case 'reset': send({ t: 'reset' }); break;
      case 'end': askEnd(); break;
      case 'close-standings': E.standings.classList.add('hidden'); break;
      case 'pick-photo': C.fileTarget = 'profile'; E.file.click(); break;
      case 'take-photo': C.fileTarget = 'profile'; startCapture(); break;
      case 'clear-photo': C.pAvatar = ''; renderProfilePreview(); break;
      case 'save-profile': saveProfile(); break;
      case 'cap-take': captureFrame(); break;
      case 'cap-cancel': stopCapture(); break;
      case 'edit-bot': openBotEdit(Number(btn.getAttribute('data-seat'))); break;
      case 'bot-photo': C.fileTarget = 'bot'; E.file.click(); break;
      case 'save-bot': saveBotEdit(); break;
      case 'cancel-bot': C.botEdit = null; renderBotEdit(); break;
      default: break;
    }
  }

  function setEntryErr(msg) {
    E.entryErr.textContent = msg || '';
    E.entryErr.classList.toggle('hidden', !msg);
  }

  function onJoinSubmit(e) {
    e.preventDefault();
    var nm = core.cleanName(E.name.value);
    if (!nm) { setEntryErr(tr('mp.nameRequired')); return; }
    setEntryErr('');
    C.name = nm;
    if (C.pAvatar !== undefined) { C.avatar = C.pAvatar; C.pAvatar = undefined; }
    savePrefs();
    if (isOpen()) sendJoin();
    else connect();
  }

  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || !E.root) return;
    var a = document.activeElement;
    if (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return;
    var k = String(e.key || '').toLowerCase();
    var btn = k === 'f' ? E.fold : k === 'c' ? E.call : k === 'r' ? E.raise : null;
    if (!btn || btn.disabled || !E.root.getClientRects().length) return;
    e.preventDefault();
    btn.click();
  }

  // Seat tooltips: hover for mouse; long-press for touch.
  function onSeatOver(e) {
    if (e.pointerType !== 'mouse') return;
    var el = e.target.closest ? e.target.closest('.mp-seat.bot') : null;
    // over the avatar or a symbol the SeatCard bubble speaks instead of the plate tip
    if (el && e.target.closest('[data-gloss]')) { hideTip(); return; }
    if (el) showTip(Number(el.getAttribute('data-seat')));
  }
  function onSeatOut(e) {
    if (e.pointerType !== 'mouse') return;
    var el = e.target.closest ? e.target.closest('.mp-seat.bot') : null;
    if (el && !(e.relatedTarget && el.contains(e.relatedTarget))) hideTip();
  }
  function onSeatDown(e) {
    if (e.pointerType === 'mouse') return;
    var el = e.target.closest ? e.target.closest('.mp-seat.bot') : null;
    if (!el) return;
    var seat = Number(el.getAttribute('data-seat'));
    clearTimeout(C.tipTimer);
    C.tipTimer = setTimeout(function () { showTip(seat); }, 450);
  }
  function onSeatUp(e) {
    if (e.pointerType === 'mouse') return;
    clearTimeout(C.tipTimer);
    if (C.tipSeat != null) C.tipTimer = setTimeout(hideTip, 2200);
  }

  // Shows the multiplayer view through PokerApp when the main menu provides it.
  // The multiplayer screen fills the space below the site's top bar, so the page never scrolls.
  function fitRoot() {
    if (!E.root) return;
    var top = E.root.getBoundingClientRect().top;
    E.root.style.height = Math.max(320, Math.floor(window.innerHeight - top)) + 'px';
  }

  // ---------- highlight colour: own from the theme, others from their profile ----------
  var DEFAULT_HL = '#ffffff';
  function myHighlight() {
    try {
      var t = window.PokerTheme;
      if (t && typeof t.get === 'function') {
        var v = t.get();
        if (v && v.highlight) return v.highlight;
      }
    } catch (e) { /* theme not loaded */ }
    return DEFAULT_HL;
  }
  function hlOf(p) {
    return p && typeof p.highlight === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.highlight) ? p.highlight : DEFAULT_HL;
  }

  // ---------- show my hand (between hands) ----------
  function showLabel(h) {
    var left = Math.max(0, Math.ceil((Number(h.showWindowMs) - (Date.now() - (C.overAt || Date.now()))) / 1000));
    return tr('mp.showHand', { n: left });
  }

  // ---------- chat: newest at the bottom; history arrives on join ----------
  var chatState = { msgs: [], unread: 0, open: false, seen: {}, expanded: false };
  var SYS_RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  var SYS_WORDS = {
    en: { '2': ['two', 'twos'], '3': ['three', 'threes'], '4': ['four', 'fours'], '5': ['five', 'fives'], '6': ['six', 'sixes'],
      '7': ['seven', 'sevens'], '8': ['eight', 'eights'], '9': ['nine', 'nines'], '10': ['ten', 'tens'], J: ['jack', 'jacks'],
      Q: ['queen', 'queens'], K: ['king', 'kings'], A: ['ace', 'aces'] },
    es: { '2': ['dos', 'doses'], '3': ['tres', 'treses'], '4': ['cuatro', 'cuatros'], '5': ['cinco', 'cincos'], '6': ['seis', 'seises'],
      '7': ['siete', 'sietes'], '8': ['ocho', 'ochos'], '9': ['nueve', 'nueves'], '10': ['diez', 'dieces'], J: ['jota', 'jotas'],
      Q: ['reina', 'reinas'], K: ['rey', 'reyes'], A: ['as', 'ases'] }
  };
  // Best five from the server (neutral data: rank index from the evaluator, five card codes).
  function sysHandText(hand, L) {
    if (!hand || !Array.isArray(hand.cards)) return '';
    var cnt = {}, ranks = [];
    hand.cards.forEach(function (c) {
      var r = String(c || '').charAt(0).toUpperCase();
      r = r === 'T' ? '10' : r;
      if (SYS_RANKS.indexOf(r) < 0) return;
      cnt[r] = (cnt[r] || 0) + 1;
      if (ranks.indexOf(r) < 0) ranks.push(r);
    });
    ranks.sort(function (a, b) { return SYS_RANKS.indexOf(b) - SYS_RANKS.indexOf(a); });
    var W = SYS_WORDS[L];
    var pairs = ranks.filter(function (r) { return cnt[r] === 2; });
    var trips = ranks.filter(function (r) { return cnt[r] === 3; });
    var quads = ranks.filter(function (r) { return cnt[r] === 4; });
    var es = L === 'es';
    switch (Number(hand.rank)) {
      case 1: return es ? 'pareja de ' + W[pairs[0] || ranks[0]][1] : 'pair of ' + W[pairs[0] || ranks[0]][1];
      case 2: return es ? 'doble pareja, ' + W[pairs[0]][1] + ' y ' + W[pairs[1]][1] : 'two pair, ' + W[pairs[0]][1] + ' and ' + W[pairs[1]][1];
      case 3: return es ? 'trío de ' + W[trips[0]][1] : 'three ' + W[trips[0]][1];
      case 4: return es ? 'escalera' : 'a straight';
      case 5: return es ? 'color' : 'a flush';
      case 6: return es ? 'full de ' + W[trips[0]][1] + ' sobre ' + W[pairs[0]][1] : 'a full house, ' + W[trips[0]][1] + ' over ' + W[pairs[0]][1];
      case 7: return es ? 'póker de ' + W[quads[0]][1] : 'four ' + W[quads[0]][1];
      case 8: return es ? 'escalera de color' : 'a straight flush';
      default: return es ? 'carta alta, ' + W[ranks[0]][0] : 'high card, ' + W[ranks[0]][0];
    }
  }
  function sysText(m) {
    var L = lang(), es = L === 'es';
    var amt = m.amount ? ' (+' + bbTxt(m.amount, m.bb) + ')' : '';
    var who = String(m.name || '');
    if (m.kind === 'winFold') return who + (es ? ' ganó la mano (todos se retiraron)' : ' won the hand (everyone folded)') + amt;
    if (m.kind === 'botOut') return who + (es ? ' fue eliminado' : ' was eliminated');
    return who + (es ? ' ganó la mano con ' : ' won the hand with ') + sysHandText(m.hand, L) + amt;
  }
  function addSystem(m, history) {
    var text = sysText(m);
    if (!text) return;
    var key = 'sys|' + String(m.time || '') + '|' + text;
    if (chatState.seen[key]) return;
    chatState.seen[key] = true;
    chatState.msgs.push({ from: '', name: '', text: text, mine: false, sys: true });
    if (chatState.msgs.length > 200) chatState.msgs.shift();
    if (!chatState.open && !history) chatState.unread += 1;
    renderChat();
  }
  function addChat(m, history) {
    if (m && m.system) { addSystem(m, history); return; }
    if (!m || typeof m.text !== 'string') return;
    var key = String(m.time || '') + '|' + String(m.from || '') + '|' + m.text;
    if (chatState.seen[key]) return;
    chatState.seen[key] = true;
    var mine = !!C.clientId && m.from === C.clientId;
    chatState.msgs.push({
      from: String(m.from || ''), name: String(m.name || ''), text: String(m.text).slice(0, 200), mine: mine
    });
    if (chatState.msgs.length > 200) chatState.msgs.shift();
    if (!chatState.open && !history) chatState.unread += 1;
    var fxNow = core.chat.chatEffects(history, chatVisible());
    renderChat();
    if (fxNow.toast && !mine) showToast(core.chat.toastText(m.name, m.text));
    if (fxNow.bubble) bubbleSay(String(m.from || ''), String(m.text).slice(0, 120));
  }
  function renderChat() {
    if (!E.chatLog) return;
    var keep = chatState.expanded ? 12 : 6;
    var chatEl = document.getElementById('mp-chat');
    if (chatEl) chatEl.classList.toggle('expanded', !!chatState.expanded);
    E.chatLog.innerHTML = chatState.msgs.slice(-keep).map(function (m) {
      if (m.sys) return '<li class="sys" role="note"><span class="sys-ic" aria-hidden="true">&#9733;</span> ' + esc(m.text) + '</li>';
      var pack = packFor(m.from), body = core.chat.renderEmojiText(m.text, pack, core.chat.isOnlyEmoji(m.text, pack));
      return '<li' + (m.mine ? ' class="mine"' : '') + '><b>' + esc(m.name) + '</b> ' + body + '</li>';
    }).join('');
    E.chatBadge.textContent = String(chatState.unread);
    if (E.segBadge) { E.segBadge.textContent = String(chatState.unread); E.segBadge.classList.toggle('hidden', !chatState.unread || chatState.open); }
    E.chatBadge.classList.toggle('hidden', !chatState.unread);
    E.chatBody.classList.toggle('hidden', !chatState.open);
    E.chatHead.setAttribute('aria-expanded', String(chatState.open));
    if (chatVisible()) clearToast();
    if (fx.ready) placeBubbles();
  }
  // Cams or Chat: the left column shows one of them; the Chat view replaces the camera grid.
  function setView(v) {
    chatState.open = v === 'chat';
    if (chatState.open) chatState.unread = 0;
    var drawer = document.getElementById('mp-chat');
    if (drawer) drawer.classList.toggle('open', chatState.open);
    if (E.chatHead) E.chatHead.setAttribute('aria-expanded', String(chatState.open));
    E.root.querySelectorAll('.mp-seg-btn').forEach(function (b) {
      var on = b.getAttribute('data-view') === v;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    renderChat();
    if (chatState.open && E.chatIn && !wide()) E.chatIn.focus();
  }
  function toggleChat() { setView(chatState.open ? 'cams' : 'chat'); }
  function onChatSubmit(e) {
    e.preventDefault();
    var t = String(E.chatIn.value || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!t) return;
    if (send({ t: 'chat', text: t })) E.chatIn.value = '';
  }

  // ---------- B: chat extras (DOM): toast, emoji picker, bubbles, spectator bench ----------
  // Everything lives in one fixed layer appended to <body>, so nothing here changes layout or scroll
  // under #mp-root. Bubble positions come from the anchors' rects and are refreshed after every render.
  var fx = {
    ready: false, layer: null, toast: null, toastTimer: null, bench: null, benchSig: '', specs: [],
    pop: null, grid: null, popMsg: null, popCount: null, manageBtn: null, file: null, emoBtn: null,
    manage: false, own: core.chat.loadEmojiSet(readEmojiRaw()), packs: {}, sentSome: false,
    bub: {}, els: {}, resendTimer: null
  };
  var TABLE_SMALL = /(^|\s)lv[23](\s|$)/;
  // Built-in Unicode emojis for the picker's quick row (inserted as text at the caret).
  var QUICK_EMO = ['😀', '😂', '😎', '😡', '😭', '👍', '👏', '🔥', '💰', '🃏', '♠', '♥', '♦', '♣', '🤔', '😅', '🙌', '🎉', '😴', '🤑', '😈', '🥶', '😤', '🤝'];
  function readEmojiRaw() {
    try { return window.localStorage.getItem(core.chat.EMO_KEY); } catch (e) { return null; }
  }
  function writeEmojiRaw(v) {
    try { window.localStorage.setItem(core.chat.EMO_KEY, v); } catch (e) { /* storage blocked: keep it in memory */ }
  }
  function packFor(cid) {
    if (!cid) return null;
    if (cid === C.clientId) return core.chat.packOf(fx.own);
    return fx.packs[cid] || null;
  }
  // The chat is visible when the document is shown and the chat panel and the chat body are open.
  function chatVisible() {
    if (!E.root || document.hidden) return false;
    return chatState.open;
  }
  function showToast(text) {
    if (!fx.toast) return;
    fx.toast.textContent = text;
    fx.toast.classList.add('show');
    clearTimeout(fx.toastTimer);
    fx.toastTimer = setTimeout(function () { fx.toast.classList.remove('show'); }, core.chat.TOAST_MS);
  }
  function clearToast() {
    clearTimeout(fx.toastTimer);
    if (fx.toast) fx.toast.classList.remove('show');
  }
  function bubbleSay(cid, text) {
    if (!cid || !text) return;
    fx.bub[cid] = { text: text, at: Date.now() };
    placeBubbles();
  }
  function seatOfCid(cid) {
    var s = C.state, out = null;
    (s.players || []).forEach(function (p) { if (!p.bot && p.clientId === cid && p.seat != null) out = p.seat; });
    if (out == null && s.me && s.me.clientId === cid && s.me.seat != null) out = s.me.seat;
    return out;
  }
  function findByAttr(root, sel, attr, val) {
    if (!root) return null;
    var list = root.querySelectorAll(sel);
    for (var i = 0; i < list.length; i++) if (list[i].getAttribute(attr) === val) return list[i];
    return null;
  }
  function tileOf(cid) {
    if (!E.cams) return null;
    var list = E.cams.querySelectorAll('.mp-tile');
    for (var i = 0; i < list.length; i++) {
      if (cid === C.clientId ? list[i].hasAttribute('data-me') : list[i].getAttribute('data-cid') === cid) return list[i];
    }
    return null;
  }
  function bubbleEl(k) {
    var el = fx.els[k];
    if (!el) {
      el = document.createElement('div');
      el.className = 'mp-bub';
      fx.layer.appendChild(el);
      void el.offsetWidth;   // start from the hidden state so the fade-in animates
      fx.els[k] = el;
    }
    return el;
  }
  function fadeBubble(k) {
    var el = fx.els[k];
    if (!el || el._out) return;
    el._out = true;
    el.classList.remove('on');
    setTimeout(function () {
      if (el._out && fx.els[k] === el) {
        if (el.parentNode) el.parentNode.removeChild(el);
        delete fx.els[k];
      }
    }, 320);
  }
  // mode 'above' sits over the anchor, 'cam' hangs off the right edge of a camera tile.
  function putBubble(k, anchor, html, mode) {
    var el = bubbleEl(k);
    el._out = false;
    if (el._sig !== html) { el.innerHTML = '<span class="mp-bub-t">' + html + '</span>'; el._sig = html; }
    var r = anchor.getBoundingClientRect();
    if (!r.width && !r.height) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.className = 'mp-bub ' + mode + ' on';
    var w = el.offsetWidth, h = el.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight, M = 8;
    // Nothing may sit under the top bar or the toast: the bubble's top edge stays below both.
    var top = M;
    var tb = document.querySelector('.mp-tbar'), tr0 = tb ? tb.getBoundingClientRect() : null;
    if (tr0 && tr0.height) top = Math.max(top, tr0.bottom + M);
    var toast = fx.toast && fx.toast.classList.contains('show') ? fx.toast.getBoundingClientRect() : null;
    if (toast && toast.height) top = Math.max(top, toast.bottom + M);
    var x, y;
    if (mode === 'cam') {
      // Beside the tile, outside it, so the tile's stack and name label stay visible. Right side first, then left.
      var right = r.right + 10, left = r.left - 10 - w;
      var sideR = right + w <= vw - M || left < M;
      // seat plates never sit under the bubble: try the tile's top, bottom, then the spots just above or below each plate
      var plates = Array.prototype.map.call(document.querySelectorAll('#mp-table .mp-seat'), function (s) { return s.getBoundingClientRect(); });
      var hits = function (bx, by) {
        return plates.some(function (p) { return bx < p.right && bx + w > p.left && by < p.bottom && by + h > p.top; });
      };
      var ys = [r.top + 8, r.bottom - h];
      plates.forEach(function (p) { ys.push(p.bottom + 6, p.top - h - 6); });
      var sides = sideR ? [[Math.max(M, Math.min(right, vw - M - w)), 'r'], [Math.max(M, left), 'l']]
        : [[Math.max(M, left), 'l'], [Math.max(M, Math.min(right, vw - M - w)), 'r']];
      var best = null;
      for (var si = 0; si < sides.length && !best; si++) {
        for (var yi = 0; yi < ys.length && !best; yi++) {
          var cy = Math.min(Math.max(ys[yi], top), vh - M - h);
          if (!hits(sides[si][0], cy)) best = { x: sides[si][0], y: cy, tail: sides[si][1] };
        }
      }
      if (!best) best = { x: sides[0][0], y: Math.min(Math.max(r.top + 8, top), vh - M - h), tail: sides[0][1] };
      x = best.x; y = best.y;
      el.className = 'mp-bub cam on' + (best.tail === 'r' ? ' tail-r' : '');
      el.style.left = Math.round(x) + 'px';
      el.style.top = Math.max(top, Math.round(y)) + 'px';
      return;
    }
    // 'above' the seat (translate -50%, -100%), flipped below when there is no room over it.
    x = r.left + r.width / 2;
    x = Math.min(Math.max(x, M + w / 2), vw - M - w / 2);
    var yAbove = r.top - 6;
    var below = yAbove - h < top;
    if (below) {
      y = Math.min(r.bottom + 6, vh - M - h);
      y = Math.max(y, top);
      el.className = 'mp-bub ' + mode + ' below on';
    } else y = yAbove;
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
  }
  // Bubbles for every live message: over the seat, beside the camera tile, and over a bench chip for spectators.
  function placeBubbles() {
    if (!fx.ready) return;
    var now = Date.now(), want = {};
    var T = document.getElementById('mp-table');
    var tableOk = !!T && T.clientHeight >= 160 && !TABLE_SMALL.test(T.className);
    Object.keys(fx.bub).forEach(function (cid) {
      if (!core.chat.bubbleLive(fx.bub[cid], now)) { delete fx.bub[cid]; return; }
      var b = fx.bub[cid], pack = packFor(cid);
      var html = core.chat.renderEmojiText(b.text, pack, core.chat.isOnlyEmoji(b.text, pack));
      var seat = seatOfCid(cid);
      var seatEl = seat != null && tableOk ? findByAttr(E.seats, '.mp-seat', 'data-seat', String(seat)) : null;
      var chip = findByAttr(fx.bench, '.mp-bench-chip', 'data-cid', cid);
      if (seatEl) { want[cid + '|t'] = true; putBubble(cid + '|t', seatEl, html, 'above'); }
      if (chip && !seatEl) { want[cid + '|s'] = true; putBubble(cid + '|s', chip, html, 'above'); }
    });
    Object.keys(fx.els).forEach(function (k) { if (!want[k]) fadeBubble(k); });
  }
  function placeBench() {
    if (!fx.bench) return;
    var T = document.getElementById('mp-table');
    var shown = fx.specs.length > 0 && !!T && !!E.tableView && !E.tableView.classList.contains('hidden') && T.clientWidth >= 80;
    if (!shown) { fx.bench.style.display = 'none'; return; }
    var sig = fx.specs.map(function (p) { return p.clientId + '~' + p.name + '~' + p.avatar; }).join('|');
    if (sig !== fx.benchSig) {
      fx.benchSig = sig;
      fx.bench.innerHTML = fx.specs.map(function (p) {
        return '<div class="mp-bench-chip" data-cid="' + esc(p.clientId) + '" title="' + esc(p.name) + '">' +
          avHtml(p.avatar || '', p.name, 'sm') + '</div>';
      }).join('');
    }
    var r = T.getBoundingClientRect();
    fx.bench.style.display = '';
    fx.bench.style.left = Math.round(r.left + 6) + 'px';
    fx.bench.style.top = Math.round(r.bottom - 34) + 'px';
  }
  function afterRenderFx() {
    if (!fx.ready) return;
    placeBench();
    placeBubbles();
  }
  // Spectators (lobby.spectators) for the corner bench.
  function onLobbyFx(msg) {
    fx.specs = (Array.isArray(msg.spectators) ? msg.spectators : []).filter(function (p) {
      return p && typeof p.clientId === 'string' && p.clientId;
    }).slice(0, 6);
    placeBench();
  }
  // Packs: {t:'emojiPack', clientId, emojis} and {t:'emojiPacks', packs:{clientId:[...]}}.
  function onEmojiMsg(msg) {
    if (msg.t === 'emojiPack') fx.packs[String(msg.clientId || '')] = core.chat.packOf(msg.emojis);
    else if (msg.packs && typeof msg.packs === 'object') {
      Object.keys(msg.packs).forEach(function (cid) { fx.packs[cid] = core.chat.packOf(msg.packs[cid]); });
    }
    renderChat();
  }
  function sendOwnEmoji() {
    if (!isOpen()) return false;
    if (fx.own.length) fx.sentSome = true;
    return send({ t: 'emojiSet', emojis: fx.own.map(function (e) { return { id: e.id, data: e.data }; }) });
  }
  function emojiOnWelcome() {
    if (fx.own.length || fx.sentSome) sendOwnEmoji();
  }
  function saveOwnEmoji(set) {
    fx.own = set;
    writeEmojiRaw(JSON.stringify(set));
    sendOwnEmoji();
    renderPicker();
    renderChat();
  }
  // Server refusals show as a chat toast. A 'slow down' is retried once after the 2 s window.
  function onEmojiError(text) {
    var key = /too many/i.test(text) ? 'mp.emo.srvMax' : /slow down/i.test(text) ? 'mp.emo.srvSlow' :
      /bad emoji/i.test(text) ? 'mp.emo.srvBad' : '';
    if (!key) return;
    if (key === 'mp.emo.srvSlow' && !fx.resendTimer) {
      fx.resendTimer = setTimeout(function () { fx.resendTimer = null; sendOwnEmoji(); }, 2100);
    }
    showToast(tr(key));
  }

  // Emoji picker (fixed size, 4 columns, no scrolling). Manage mode shows names and deletes on click.
  function emoMsg(text) { if (fx.popMsg) fx.popMsg.textContent = text || ''; }
  function renderPicker() {
    if (!fx.grid) return;
    var n = fx.own.length, html = '';
    fx.own.forEach(function (e) {
      var label = ':' + e.id + ':';
      html += '<button type="button" class="mp-emo-cell' + (fx.manage ? ' del' : '') + '" data-emo="' + esc(e.id) +
        '" title="' + esc(label) + '" aria-label="' + esc(label) + '"><img src="' + esc(e.data) + '" alt=""><span>' +
        esc(e.id) + '</span></button>';
    });
    if (n < core.chat.EMO_MAX) {
      html += '<button type="button" class="mp-emo-cell add" data-add="1" aria-label="' + esc(tr('mp.emo.add')) +
        '" title="' + esc(tr('mp.emo.add')) + '">+</button>';
    }
    fx.grid.innerHTML = html;
    fx.popCount.textContent = tr('mp.emo.count', { n: n });
    fx.manageBtn.textContent = tr(fx.manage ? 'mp.emo.done' : 'mp.emo.manage');
    fx.manageBtn.setAttribute('aria-pressed', String(fx.manage));
    if (!n) emoMsg(tr('mp.emo.hint'));
  }
  function toggleEmoPicker(force) {
    if (!fx.pop) return;
    var open = force == null ? fx.pop.classList.contains('hidden') : !!force;
    if (open) {
      var r = fx.emoBtn.getBoundingClientRect();
      var h = fx.pop.offsetHeight || 352;
      fx.pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 232)) + 'px';
      if (r.top - 6 >= h) { fx.pop.style.top = ''; fx.pop.style.bottom = Math.round(window.innerHeight - r.top + 6) + 'px'; }
      else { fx.pop.style.bottom = ''; fx.pop.style.top = Math.round(Math.min(r.bottom + 6, window.innerHeight - h - 6)) + 'px'; }
      renderPicker();
    } else {
      fx.manage = false;
      emoMsg('');
    }
    fx.pop.classList.toggle('hidden', !open);
    fx.emoBtn.setAttribute('aria-expanded', String(open));
  }
  function insertEmoji(id) {
    var v = String(E.chatIn.value || '');
    var sep = v && !/\s$/.test(v) ? ' ' : '';
    var add = sep + ':' + id + ': ';
    if (v.length + add.length > 200) { emoMsg(tr('mp.chat.ph')); return; }
    E.chatIn.value = v + add;
    toggleEmoPicker(false);
    E.chatIn.focus();
  }
  function onPickerClick(e) {
    var q = e.target.closest ? e.target.closest('.mp-emo-q') : null;
    if (q) { insertText(q.getAttribute('data-uni') || ''); return; }
    var cell = e.target.closest ? e.target.closest('.mp-emo-cell') : null;
    if (!cell) return;
    if (cell.hasAttribute('data-add')) { fx.file.click(); return; }
    var id = cell.getAttribute('data-emo');
    if (!id) return;
    if (fx.manage) {
      askPop({ title: tr('mp.emo.del', { id: id }), danger: true, ok: lang() === 'es' ? 'Borrar' : 'Delete',
        onOk: function () { saveOwnEmoji(core.chat.emojiRemove(fx.own, id)); } });
      return;
    }
    insertEmoji(id);
  }
  // Inserts text at the caret of the chat input (replaces the selection), within the 200-char limit.
  function insertText(s) {
    var inp = E.chatIn, v = String(inp.value || '');
    var a = inp.selectionStart == null ? v.length : inp.selectionStart;
    var b = inp.selectionEnd == null ? a : inp.selectionEnd;
    var nv = v.slice(0, a) + s + v.slice(b);
    if (nv.length > 200) { emoMsg(tr('mp.chat.ph')); return; }
    inp.value = nv;
    inp.setSelectionRange(a + s.length, a + s.length);
    toggleEmoPicker(false);
    inp.focus();
  }
  // Draws the image onto a square canvas (cover) and returns a PNG data URL.
  function squareEmoji(img, size) {
    var w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return null;
    var cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    var cx = cv.getContext('2d');
    if (!cx) return null;
    var s = Math.max(size / w, size / h), dw = w * s, dh = h * s;
    cx.clearRect(0, 0, size, size);
    cx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
    try {
      var id = cx.getImageData(0, 0, size, size);
      core.chat.knockOutBg(id.data, size, size);
      cx.putImageData(id, 0, 0);
    } catch (err) { /* tainted or unavailable: keep the image as drawn */ }
    return cv.toDataURL('image/png');
  }
  function onEmoFile(e) {
    var f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    emoMsg('');
    if (f.type !== 'image/png') { emoMsg(tr('mp.emo.notPng')); return; }
    if (f.size > 4 * 1024 * 1024) { emoMsg(tr('mp.emo.big')); return; }
    f.slice(0, 8).arrayBuffer().then(function (buf) {
      if (!core.chat.isPngHeader(new Uint8Array(buf))) { emoMsg(tr('mp.emo.notPng')); return; }
      var url = URL.createObjectURL(f);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var data = null, sizes = [64, 48, 32];
        for (var si = 0; si < sizes.length && !core.chat.emojiDataOk(data); si++) data = squareEmoji(img, sizes[si]);
        if (!core.chat.emojiDataOk(data)) { emoMsg(tr('mp.emo.big')); return; }
        addEmojiFlow(data, f.name);
      };
      img.onerror = function () { URL.revokeObjectURL(url); emoMsg(tr('mp.emo.notPng')); };
      img.src = url;
    }, function () { emoMsg(tr('mp.emo.notPng')); });
  }
  function addEmojiFlow(data, fileName) {
    if (fx.own.length >= core.chat.EMO_MAX) { emoMsg(tr('mp.emo.max')); return; }
    var guess = String(fileName || '').replace(/\.png$/i, '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 12) || 'emo';
    askPop({ title: tr('mp.emo.name'), input: guess, ok: lang() === 'es' ? 'Guardar' : 'Save', onOk: function (name) {
    name = String(name == null ? '' : name).trim().toLowerCase();
    var r = core.chat.emojiAdd(fx.own, name, data);
    if (r.err === 'id') emoMsg(tr('mp.emo.badName'));
    else if (r.err === 'dup') emoMsg(tr('mp.emo.dup'));
    else if (r.err === 'max') emoMsg(tr('mp.emo.max'));
    else if (r.err) emoMsg(tr('mp.emo.big'));
    else saveOwnEmoji(r.set);
  } });
  }

  // Creates the layer, toast, bench and picker once, after the chat markup exists.
  function initFx() {
    if (fx.ready || !document.body) return;
    var layer = document.createElement('div');
    layer.id = 'mp-fx';
    layer.className = 'mp-fx';
    layer.innerHTML = '<div class="mp-chat-toast" id="mp-chat-toast" role="status" aria-live="polite"></div>' +
      '<div class="mp-bench" id="mp-bench"></div>' +
      '<div class="mp-emo-pop hidden" id="mp-emo-pop" role="dialog" aria-label="' + esc(tr('mp.emo.title')) + '">' +
        '<div class="mp-emo-top"><b>' + esc(tr('mp.emo.title')) + '</b><span id="mp-emo-count"></span></div>' +
        '<div class="mp-emo-quick" id="mp-emo-quick">' + QUICK_EMO.map(function (ch) {
          return '<button type="button" class="mp-emo-q" data-uni="' + ch + '" aria-label="' + ch + '" title="' + ch + '">' + ch + '</button>';
        }).join('') + '</div>' +
        '<div class="mp-emo-grid" id="mp-emo-grid"></div>' +
        '<div class="mp-emo-bar"><button type="button" class="mp-btn small" id="mp-emo-manage"></button></div>' +
        '<p class="mp-emo-msg" id="mp-emo-msg" role="status"></p>' +
        '<input type="file" accept="image/png" id="mp-emo-file" class="hidden" tabindex="-1">' +
      '</div>';
    document.body.appendChild(layer);
    fx.layer = layer;
    fx.toast = $('mp-chat-toast');
    fx.bench = $('mp-bench');
    fx.pop = $('mp-emo-pop');
    fx.grid = $('mp-emo-grid');
    fx.popMsg = $('mp-emo-msg');
    fx.popCount = $('mp-emo-count');
    fx.manageBtn = $('mp-emo-manage');
    fx.file = $('mp-emo-file');
    fx.emoBtn = $('mp-emo-btn');
    fx.emoBtn.setAttribute('aria-label', tr('mp.emo.btn'));
    fx.emoBtn.setAttribute('title', tr('mp.emo.btn'));
    fx.emoBtn.addEventListener('click', function () { toggleEmoPicker(); });
    fx.pop.addEventListener('click', onPickerClick);
    fx.manageBtn.addEventListener('click', function () { fx.manage = !fx.manage; renderPicker(); });
    fx.file.addEventListener('change', onEmoFile);
    document.addEventListener('click', function (e) {
      if (!fx.pop || fx.pop.classList.contains('hidden')) return;
      if (fx.pop.contains(e.target) || fx.emoBtn.contains(e.target)) return;
      toggleEmoPicker(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && fx.pop && !fx.pop.classList.contains('hidden')) toggleEmoPicker(false);
    });
    window.addEventListener('resize', afterRenderFx);
    window.addEventListener('scroll', afterRenderFx, true);
    setInterval(afterRenderFx, 250);   // also expires bubbles and follows layout changes made outside render()
    fx.ready = true;
    renderChat();
  }

  // ---------- LAN addresses for the host (GET /lan-info) ----------
  function lanUrls(j) {
    var list = j && (j.urls || j.addresses || j);
    var out = [];
    if (Array.isArray(list)) {
      list.forEach(function (x) {
        var u = typeof x === 'string' ? x : (x && x.url) || '';
        if (/^https:\/\//.test(u)) out.push(u);
      });
    }
    return out;
  }
  function renderLan(urls) {
    if (!E.lan) return;
    E.lan.innerHTML = urls.length
      ? '<p class="mp-note">' + esc(tr('mp.lan.hint')) + '</p>' + urls.map(function (u) {
          return '<div class="mp-lan-row"><code class="mp-lan-url">' + esc(u) + '</code>' +
            '<button type="button" class="mp-btn small" data-act="copy-url" data-url="' + esc(u) + '">' +
            esc(tr('mp.lan.copy')) + '</button></div>';
        }).join('')
      : '<p class="mp-note">' + esc(tr('mp.lan.none')) + '</p>';
  }
  function loadLan() {
    if (!E.lan || typeof fetch !== 'function') return;
    fetch('/lan-info', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { renderLan(lanUrls(j)); }, function () { renderLan([]); });
  }

  // ---------- media diagnostics for the server log: path, states, inbound stats (no media) ----------
  function diagSend(kind, data) { send({ t: 'diag', kind: kind, data: data }); }
  function diagTick() {
    if (!isOpen()) return;
    Object.keys(C.peers).forEach(function (id) {
      var l = C.peers[id];
      if (!l || l.noRtc || !l.pc) return;
      l.pathInfo().then(function (path) {
        var base = {
          peer: id, status: core.linkStatus(l), ice: l.pc.iceConnectionState, conn: l.pc.connectionState,
          path: path, restarted: !!l.restarted, relay: !!l.needsRelay, log: l.log.slice(-6),
          ua: String(navigator.userAgent || '').slice(0, 120), caps: caps
        };
        l.pc.getStats().then(function (rep) {
          var v = {};
          rep.forEach(function (r) {
            if (r.type === 'inbound-rtp' && r.kind === 'video') {
              v = { fps: r.framesPerSecond, bytes: r.bytesReceived, lost: r.packetsLost, jitter: r.jitter, w: r.frameWidth, h: r.frameHeight };
            }
          });
          base.video = v;
          diagSend('webrtc', base);
        }, function () { diagSend('webrtc', base); });
      }, noop);
    });
    diagSend('relay', { vidIn: C.stats.vidIn, audIn: C.stats.audIn, decoded: C.stats.decoded, drawn: C.stats.drawn, keyReq: C.stats.keyReq, keyOut: C.stats.keyOut });
  }

  // Wide screens: the cams column is always shown. Narrow and short screens: it is an overlay.
  function wide() {
    return !!window.matchMedia && window.matchMedia('(min-width: 1100px) and (min-height: 600px)').matches;
  }
  // Settings (players + admin) and Profile open as dialogs: one at a time, closed by Esc, the close button or a click outside.
  var sheetFrom = null;
  function openSheet(id) {
    var el = document.getElementById(id);
    if (!el) return;
    closeSheets();
    sheetFrom = document.activeElement;
    el.classList.remove('hidden');
    var first = el.querySelector('button, input, select');
    if (first) first.focus();
  }
  function closeSheets() {
    var any = false;
    ['mp-settings', 'mp-profile-modal'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && !el.classList.contains('hidden')) { el.classList.add('hidden'); any = true; }
    });
    if (any && sheetFrom && sheetFrom.focus && document.body.contains(sheetFrom)) sheetFrom.focus();
    sheetFrom = null;
    return any;
  }
  function closeDrawers() {
    closeSheets();
    if (E.scrim) E.scrim.classList.remove('open');
    if (chatState.open) setView('cams');
  }
  function toggleDrawer(name) {
    if (name === 'settings') { openSheet('mp-settings'); return; }
    if (name === 'profile-modal') { openSheet('mp-profile-modal'); return; }
    if (name === 'chat') { toggleChat(); return; }
  }


  // Camera grid on desktop: tile size comes from the column (see camLayout). Phones use a strip.
  function layoutCams() {
    if (E.cams) { E.cams.style.gridTemplateColumns = ''; E.cams.style.gridAutoRows = ''; }
    if (!E.cams || !(wide() || (window.matchMedia && window.matchMedia('(min-width: 901px) and (min-height: 501px)').matches)) || !E.cams.getClientRects().length) return;
    var n = E.cams.children.length;
    if (!n) return;
    var gap = parseFloat(getComputedStyle(E.cams).rowGap) || 8;
    var colW = E.cams.clientWidth, areaH = E.cams.clientHeight, chip = document.getElementById('mp-cams-more');
    var tileH = Math.max(180, Math.round(colW * 0.75));
    var fit = Math.max(1, Math.floor((areaH + gap) / (tileH + gap)));
    var shown = n;
    if (n > fit) {
      shown = Math.max(1, Math.floor((areaH - 26 - gap) / (tileH + gap)));
      if (shown >= n) shown = n - 1;
    }
    var kids = Array.prototype.slice.call(E.cams.children), vis = 0;
    kids.forEach(function (k) {
      var on = vis < shown || k.classList.contains('me');
      if (on) vis++;
      k.style.display = on ? '' : 'none';
    });
    var hiddenN = n - vis;
    E.cams.style.gridTemplateColumns = 'repeat(1, ' + colW + 'px)';
    E.cams.style.gridAutoRows = tileH + 'px';
    if (chip) {
      chip.textContent = hiddenN > 0 ? '+' + hiddenN : '';
      chip.classList.toggle('hidden', hiddenN <= 0);
    }
  }

  // Leaving the multiplayer screen ends everything: camera, mic, peer links and the socket.
  // The saved camera/mic preference is kept, so they come back only when the player re-enters.
  // The host removed this player: stop for good (no auto-reconnect) and show a plain message.
  function onKicked() {
    leave();
    C.left = true; // mark as left: the table behind the overlay shows no connection state or errors
    C.state = Object.assign({}, C.state, { error: '' });
    renderConn();
    var old = document.getElementById('mp-kicked');
    if (old) old.parentNode.removeChild(old);
    var d = document.createElement('div');
    d.id = 'mp-kicked';
    d.className = 'mp-modal mp-sheet';
    d.setAttribute('role', 'alertdialog');
    d.setAttribute('aria-modal', 'true');
    d.innerHTML = '<div class="mp-card mp-modal-box"><h3 class="mp-h">' + esc(tr('mp.kicked.title')) + '</h3>' +
      '<p>' + esc(tr('mp.kicked.body')) + '</p>' +
      '<button type="button" class="mp-btn primary" data-act="kicked-ok">' + esc(tr('mp.kicked.menu')) + '</button></div>';
    (E.root || document.body).appendChild(d);
  }
  function dismissKicked() {
    var d = document.getElementById('mp-kicked');
    if (d && d.parentNode) d.parentNode.removeChild(d);
    handleAct('home', null);
  }

  // In-app confirmation popup (never window.confirm/prompt). opts: title, msg, ok, cancel, danger, input (default text), onOk(value).
  // Esc or a click outside cancels; the OK button runs onOk once.
  function askPop(opts) {
    var old = document.getElementById('app-ask');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var es = lang() === 'es';
    var pop = document.createElement('div');
    pop.id = 'app-ask';
    pop.className = 'mp-leave';
    pop.setAttribute('role', 'alertdialog');
    pop.setAttribute('aria-modal', 'true');
    pop.innerHTML = '<div class="mp-leave-card"><p class="mp-leave-t"></p><p class="mp-leave-s"></p>' +
      (opts.input != null ? '<input type="text" class="mp-ask-in" maxlength="12" autocomplete="off" style="width:100%;margin:0 0 12px;padding:8px;box-sizing:border-box">' : '') +
      '<div class="mp-leave-acts"><button type="button" class="mp-btn" data-ask="cancel"></button>' +
      '<button type="button" class="mp-btn' + (opts.danger ? ' mp-leave-go' : '') + '" data-ask="ok"></button></div></div>';
    pop.querySelector('.mp-leave-t').textContent = opts.title || '';
    var sub = pop.querySelector('.mp-leave-s');
    sub.textContent = opts.msg || '';
    sub.classList.toggle('hidden', !opts.msg);
    pop.querySelector('[data-ask="cancel"]').textContent = opts.cancel || (es ? 'Cancelar' : 'Cancel');
    pop.querySelector('[data-ask="ok"]').textContent = opts.ok || 'OK';
    var inp = pop.querySelector('.mp-ask-in');
    if (inp) inp.value = String(opts.input);
    function close() {
      document.removeEventListener('keydown', onKey, true);
      if (pop.parentNode) pop.parentNode.removeChild(pop);
    }
    function run() {
      var v = inp ? inp.value : undefined;
      close();
      if (opts.onOk) opts.onOk(v);
    }
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); }
      else if (ev.key === 'Enter' && inp && ev.target === inp) { ev.preventDefault(); run(); }
      else if (ev.key === 'Tab') {
        // Focus stays inside the popup: Tab cycles over its fields and buttons.
        var fs = Array.prototype.slice.call(pop.querySelectorAll('input,button'));
        var at = fs.indexOf(document.activeElement);
        var nx = ev.shiftKey ? (at <= 0 ? fs.length - 1 : at - 1) : (at < 0 || at >= fs.length - 1 ? 0 : at + 1);
        ev.preventDefault();
        fs[nx].focus();
      }
    }
    pop.addEventListener('click', function (ev) {
      if (ev.target === pop) { close(); return; }
      var b = ev.target.closest ? ev.target.closest('[data-ask]') : null;
      if (!b) return;
      if (b.getAttribute('data-ask') === 'ok') run(); else close();
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(pop);
    (inp || pop.querySelector('[data-ask="ok"]')).focus();
  }
  window.PokerAsk = askPop;
  // End game: the in-app popup, then the server ends the game for everyone (refunds a running hand, standings, lobby).
  function askEnd() {
    askPop({ title: tr('mp.confirmEnd'), ok: tr('mp.endGame'), danger: true, onOk: function () {
      if (!send({ t: 'endGame' })) { showToast(tr('mp.endFail')); return; }
      closeSheets();
      markSession(false);
    } });
  }

  // Back arrow: a small Leave / Stay popup while at the table (no window.confirm). Esc stays.
  function askLeave() {
    var tv = E.tableView;
    var inTable = !!tv && tv.offsetParent !== null;
    var ranked = isRanked();
    function go() {
      if (ranked && send({ t: 'resign' })) return; // the server answers with the result (onRated)
      leave();
      if (tv) tv.classList.add('hidden');
      if (!window.PokerRooms) { handleAct('home', null); return; }
      window.PokerRooms.clear();
      if (ranked && window.PokerRanked) window.PokerRanked.show();
      else window.PokerRooms.show();
    }
    // Lobby (no table view): back leaves the room and returns to the Multiplayer screen, as leave does.
    if (!inTable) { go(); return; }
    if (document.getElementById('mp-leave')) return;
    var es = lang() === 'es';
    var pop = document.createElement('div');
    pop.id = 'mp-leave';
    pop.className = 'mp-leave';
    pop.setAttribute('role', 'alertdialog');
    pop.setAttribute('aria-modal', 'true');
    pop.setAttribute('aria-labelledby', 'mp-leave-t');
    pop.innerHTML = '<div class="mp-leave-card">' +
      '<p id="mp-leave-t" class="mp-leave-t">' + (ranked ? rk('resignT') : es ? '¿Salir de la partida?' : 'Leave the game?') + '</p>' +
      '<p class="mp-leave-s">' + (ranked ? rk(rankedTable() ? 'resignTable' : 'resignD') : es ? 'Te vas de la mesa y de la partida.' : 'You will leave the table and the game.') + '</p>' +
      '<div class="mp-leave-acts">' +
      '<button type="button" class="mp-btn" data-leave="stay">' + (es ? 'Quedarme' : 'Stay') + '</button>' +
      '<button type="button" class="mp-btn mp-leave-go" data-leave="go">' + (ranked ? rk('resign') : es ? 'Salir' : 'Leave') + '</button>' +
      '</div></div>';
    function close() {
      document.removeEventListener('keydown', onKey, true);
      if (pop.parentNode) pop.parentNode.removeChild(pop);
    }
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); close(); }
    }
    pop.addEventListener('click', function (ev) {
      var t = ev.target.closest ? ev.target.closest('[data-leave]') : null;
      if (ev.target === pop) { close(); return; }
      if (!t) return;
      close();
      if (t.getAttribute('data-leave') === 'go') go();
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(pop);
    var stay = pop.querySelector('[data-leave="stay"]');
    if (stay) stay.focus();
  }

  function leave() {
    markSession(false);
    C.wantConnected = false;
    clearTimeout(C.retryTimer);
    updatePeers([]);
    stopStream(C.camStream); C.camStream = null; C.camOn = false;
    stopStream(C.micStream); C.micStream = null; C.micOn = false;
    stopStream(C.capStream); C.capStream = null;
    closeVideoEnc();
    stopPing();
    var ws = C.ws;
    C.ws = null;
    if (ws) { try { ws.close(); } catch (e) { /* already closed */ } }
    setStatus('offline');
    C.sig.cams = null;
    render();
    if (isRanked()) { C.clientId = C.store.clientId || ''; C.token = C.store.token || ''; }
  }

  // A ranked match ended: the result over the table, then back to the ranked screen.
  function onRated(msg) {
    if (C.ratedOpen || !window.PokerRanked) return;
    C.ratedOpen = true;
    markSession(false);
    window.PokerRanked.result(msg, function () {
      C.ratedOpen = false;
      leave();
      E.tableView.classList.add('hidden');
      if (window.PokerRooms) window.PokerRooms.clear();
    });
  }

  // Reloading mid-game: sessionStorage remembers that the player was in Multiplayer. Leave, back and End game clear it.
  var SESSION_KEY = 'poker-trainer:mp:session';
  function markSession(on) {
    try {
      if (on) window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ mode: 'mp' }));
      else window.sessionStorage.removeItem(SESSION_KEY);
    } catch (e) { /* storage blocked */ }
  }
  function restoreSession() {
    var v = null;
    try { v = window.sessionStorage.getItem(SESSION_KEY); } catch (e) { v = null; }
    if (!v || !C.name) return;
    var go = function () { setTimeout(function () { if (!C.wantConnected) open(); }, 0); };
    if (document.readyState === 'complete') go();
    else window.addEventListener('load', go);   // after the menu has finished its own start-up view change
  }

  function open() {
    if (!E.root) return;
    syncUser();
    markSession(true);
    fitRoot();
    if (hasApp()) {
      try { window.PokerApp.showView('multiplayer'); } catch (e) { /* view missing */ }
    } else {
      E.root.hidden = false;
      E.root.classList.add('mp-standalone');
    }
    if (window.PokerRooms && !window.PokerRooms.roomId()) { window.PokerRooms.show(); return; } if (C.name && !C.wantConnected) {
      C.state = Object.assign(core.initialState(), { gameOverId: C.state.gameOverId }); // nothing left over from the last table
      connect();
    }
    render();
  }

  function mount() {
    var root = $('mp-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'mp-root';
      document.body.appendChild(root);
    }
    E.root = root;
    root.innerHTML = SKELETON;
    E.connText = $('mp-conn-text');
    E.connDot = $('mp-conn-dot');
    E.rttWrap = $('mp-rtt-wrap');
    E.rtt = $('mp-rtt');
    E.rttDot = $('mp-rtt-dot');
    E.err = $('mp-err');
    E.entry = $('mp-entry');
    E.form = $('mp-form');
    E.entrySlot = $('mp-entry-slot');
    E.profile = $('mp-profile');
    E.name = $('mp-name');
    E.profImg = $('mp-prof-img');
    E.profInit = $('mp-prof-init');
    E.profErr = $('mp-prof-err');
    E.removePhoto = $('mp-remove-photo');
    E.saveProfile = $('mp-save-profile');
    E.entryErr = $('mp-entry-err');
    E.join = $('mp-join');
    E.body = $('mp-body');
    E.profileDetails = $('mp-profile-details');
    E.sideSlot = $('mp-side-slot');
    E.playersTitle = $('mp-players-title');
    E.players = $('mp-players');
    E.compat = ghost('input');
    function ghost(t) { return document.createElement(t); }   // removed media UI: detached stand-in, never shown
    E.camRetry = ghost('button'); E.camNote = ghost('p'); E.cams = ghost('div');
    E.admin = $('mp-admin');
    E.pause = $('mp-pause');
    E.paused = $('mp-paused');
    E.admStyle = $('mp-adm-style');
    E.lobby = $('mp-lobby');
    E.host = $('mp-host');
    E.setStack = $('mp-set-stack');
    E.setStacks = $('mp-set-stacks');
    E.setBlindUp = $('mp-set-blindup');
    E.setSpec = $('mp-set-spec');
    E.setLate = $('mp-set-late');
    E.setLateBB = $('mp-set-late-bb');
    E.setLateWrap = $('mp-set-late-wrap');
    E.dlgBlindUp = $('mp-dlg-blindup');
    E.dlgSpec = $('mp-dlg-spec');
    E.setBlinds = $('mp-set-blinds');
    E.double = $('mp-double');
    E.blindsChip = $('mp-blinds');
    E.toast = $('mp-toast');
    E.pauseBanner = $('mp-pause-banner');
    E.pauseText = $('mp-pause-text');
    E.pauseResume = $('mp-pause-resume');
    E.setBShow = $('mp-set-bshow');
    E.setErr = $('mp-set-err');
    E.stacksList = $('mp-stacks');
    E.bots = $('mp-bots');
    E.botEdit = $('mp-botedit');
    E.beImg = $('mp-be-img');
    E.beInit = $('mp-be-init');
    E.beName = $('mp-be-name');
    E.beStyle = $('mp-be-style');
    E.botStyle = $('mp-bot-style');
    E.botName = $('mp-bot-name');
    E.guest = $('mp-guest');
    E.start = $('mp-start');
    E.lobbyPlayers = $('mp-lobby-players');
    E.lobbyStatus = $('mp-lobby-status');
    E.lobbyStatusText = $('mp-lobby-status-text');
    E.codeVal = $('mp-code-val');
    E.codeCopy = $('mp-code-copy');
    E.counts = $('mp-lobby-counts');
    E.startHint = $('mp-start-hint');
    E.botsCount = $('mp-bots-count');
    E.setToggle = $('mp-set-toggle');
    E.lobbyEdit = $('mp-lobby-edit');
    E.chipStack = $('mp-chip-stack');
    E.chipBlinds = $('mp-chip-blinds');
    E.chipBlindUp = $('mp-chip-blindup');
    E.chipLate = $('mp-chip-late');
    E.chipSpec = $('mp-chip-spec');
    E.tableView = $('mp-table-view');
    E.street = $('mp-street');
    E.joinNote = $('mp-join-note');
    E.pot = $('mp-pot');
    E.board = $('mp-board');
    E.banner = $('mp-banner');
    E.seats = $('mp-seats');
    E.bets = $('mp-bets');
    E.tip = $('mp-tip');
    E.hero = $('mp-hero');
    E.turnText = $('mp-turn-text');
    E.chatHead = $('mp-btn-chat');
    E.chatBody = $('mp-chat-body');
    E.chatLog = $('mp-chat-log');
    E.chatBadge = $('mp-chat-badge');
    E.chatIn = $('mp-chat-in');
    E.chatForm = $('mp-chat-form');
    E.extBtn = ghost('button'); E.extUrl = ghost('input'); E.lan = ghost('div');
    E.adminBtn = $('mp-btn-admin');
    E.chip = $('mp-chip'); E.chipAv = $('mp-chip-av'); E.chipName = $('mp-chip-name');
    E.camCard = null; E.segBadge = null;
    E.scrim = $('mp-scrim');
    E.side = ghost('aside');
    E.sound = $('mp-sound');
    E.dbg = ghost('p');
    E.fold = $('mp-fold');
    E.call = $('mp-call');
    E.callLabel = $('mp-call-label');
    E.raise = $('mp-raise');
    E.raiseLabel = $('mp-raise-label');
    E.rRange = $('mp-raise-range');
    E.rNum = $('mp-raise-num');
    E.rBB = $('mp-raise-bb');
    E.quick = Array.prototype.slice.call(root.querySelectorAll('[data-q]'));
    E.standings = $('mp-standings');
    E.standList = $('mp-stand-list');
    E.cap = ghost('div'); E.capVideo = ghost('video');
    E.file = $('mp-file');

    C.store = loadStored();
    C.clientId = C.store.clientId || '';
    C.token = C.store.token || '';
    // Migration: a name or photo saved by the older multiplayer store moves into the shared record once.
    if (!loadUserRec() && (C.store.name || C.store.avatar)) {
      C.name = core.cleanName(C.store.name || '');
      C.avatar = typeof C.store.avatar === 'string' ? C.store.avatar : '';
      saveUserRec();
    } else {
      syncUser();
    }
    C.camPref = !!C.store.camPref;
    C.micPref = !!C.store.micPref;
    C.compat = !!C.store.compat;
    C.rtcOff = /[?&]rtc=off\b/.test(location.search);
    C.forceJpeg = /[?&]codec=jpeg\b/.test(location.search);   // debug: JPEG relay video even when WebCodecs exists
    E.name.value = C.name;
    if (window.I18N && typeof window.I18N.extend === 'function') {
      try { window.I18N.extend({ en: MP.en, es: MP.es }); } catch (e) { /* keep own dictionary */ }
    }
    C.lang = lang();
    applyStatic();

    E.form.addEventListener('submit', onJoinSubmit);
    E.chatForm.addEventListener('submit', onChatSubmit);
    E.name.addEventListener('input', renderProfilePreview);
    E.file.addEventListener('change', onFile);
    root.addEventListener('click', function (e) {
      unlockAudio();   // a click is the user gesture that lets audio and video play
      playAll();
      if (chatState.open && !(e.target.closest && e.target.closest('#mp-chat, #mp-btn-chat'))) setView('cams');   // outside click closes the chat drawer
      if (rpop.open && !(e.target.closest && e.target.closest('#mp-rpop, #mp-raise'))) closeRaisePop();
      if (e.target === E.scrim) { closeDrawers(); return; }
      if (e.target.classList && e.target.classList.contains('mp-sheet')) { closeSheets(); return; }
      var seg = e.target.closest ? e.target.closest('.mp-seg-btn') : null;
      if (seg) { setView(seg.getAttribute('data-view')); return; }
      var dr = e.target.closest ? e.target.closest('[data-dr]') : null;
      if (dr) { toggleDrawer(dr.getAttribute('data-dr')); return; }
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (b && !b.disabled) handleAct(b.getAttribute('data-act'), b);
    });
    root.addEventListener('change', function (e) {
      if (e.target.matches && e.target.matches('#mp-stacks input[data-seat]')) sendStack(e.target);
    });
    E.seats.addEventListener('pointerover', onSeatOver);
    E.seats.addEventListener('pointerout', onSeatOut);
    E.seats.addEventListener('pointerdown', onSeatDown);
    E.seats.addEventListener('pointerup', onSeatUp);
    E.seats.addEventListener('pointercancel', onSeatUp);
    document.addEventListener('click', function (e) {
      var o = e.target.closest ? e.target.closest('[data-mp-open]') : null;
      if (o) open();
    });
    document.addEventListener('keydown', onKey);
    if (window.MutationObserver) {
      new MutationObserver(function () {
        if (document.body.dataset.view !== 'multiplayer' && (C.ws || C.camStream || C.micStream || C.wantConnected)) leave();
      }).observe(document.body, { attributes: true, attributeFilter: ['data-view'] });
    }
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && C.wantConnected && !isOpen()) {
        C.attempt = 0;
        connect();
      }
    });
    E.compat.addEventListener('change', function () {
      C.compat = !!E.compat.checked;
      savePrefs();
      C.sig.cams = null;
      render();
    });
    E.audios = $('mp-audios');
    setInterval(relayVideoTick, 20);
    setInterval(levelTick, 100);
    setInterval(checkSound, 1000);
    requestAnimationFrame(drawLoop);
    probeCaps().then(function (c) { caps = c; });
    loadRtcConfig();
    setInterval(relayStale, 1000);
    E.setStack.addEventListener('change', sendSettings);
    E.setBShow.addEventListener('change', sendSettings);
    E.setStacks.addEventListener('change', sendSettings);
    E.setBlindUp.addEventListener('change', sendSettings);
    if (E.setSpec) E.setSpec.addEventListener('change', sendSettings);
    if (E.setLate) E.setLate.addEventListener('change', sendSettings);
    if (E.setLateBB) E.setLateBB.addEventListener('change', sendSettings);
    // The in-game dialog mirrors the two lobby selects and sends the same settings message.
    if (E.dlgBlindUp) E.dlgBlindUp.addEventListener('change', function () { E.setBlindUp.value = E.dlgBlindUp.value; sendSettings(); });
    if (E.dlgSpec) E.dlgSpec.addEventListener('change', function () { E.setSpec.value = E.dlgSpec.value; sendSettings(); });
    E.rRange.addEventListener('input', function () { setRaise(Number(E.rRange.value)); });
    E.rNum.addEventListener('input', function () {
      var v = Number(E.rNum.value);
      if (isFinite(v) && core.raiseBounds(C.state.hand)) { C.raiseAmt = v; render(); }
    });
    E.rNum.addEventListener('change', function () { render(); });
    if (window.ResizeObserver) { var dockEl = $('mp-dock'); if (dockEl) new ResizeObserver(function () { document.documentElement.style.setProperty('--dock-clear', dockEl.offsetHeight + 'px'); }).observe(dockEl); }
    E.raise.addEventListener('pointerdown', function (e) {
      if (!isPhone() || E.raise.disabled || e.button > 0) return;
      raiseLP.fired = false;
      clearTimeout(raiseLP.timer);
      raiseLP.timer = setTimeout(function () { raiseLP.fired = true; openRaisePop(); }, 450);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) {
      E.raise.addEventListener(ev, function () { clearTimeout(raiseLP.timer); });
    });
    E.raise.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    document.getElementById('mp-rpop-in').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); confirmRaisePop(); }
    });

    if (!hasApp()) root.hidden = true;
    fitRoot();
    window.addEventListener('resize', function () { fitRoot(); layoutCams(); });
    if (window.ResizeObserver) new ResizeObserver(layoutCams).observe(E.cams);
    // the toolbar grows after the first layout (chips and labels fill in): re-lay the table when it changes
    if (window.ResizeObserver) {
      var roTable = new ResizeObserver(layoutTable);
      roTable.observe(document.getElementById('mp-table'));
      (['.mp-tbar', '.mp-tools']).forEach(function (sel) { var ob = document.querySelector(sel); if (ob) roTable.observe(ob); });
    }
    // seat content settles after the first layout (web fonts, avatars, chips, the board's cards): re-lay
    // the table once fonts are ready and on any change inside it, coalesced to one pass per frame
    var layoutQueued = false;
    function scheduleLayout() {
      if (layoutQueued) return;
      layoutQueued = true;
      (window.requestAnimationFrame || setTimeout)(function () { layoutQueued = false; layoutTable(); });
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleLayout);
    if (window.MutationObserver) {
      var moTable = document.getElementById('mp-table');
      // layoutTable only writes styles and the table's own class/data-layout, so its own writes are ignored
      if (moTable) new MutationObserver(function (recs) {
        if (recs.some(function (r) { return r.target !== moTable; })) scheduleLayout();
      }).observe(moTable, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
    }
    setInterval(tick, 250);
    window.addEventListener('online', function () { if (C.wantConnected && !isOpen()) connect(); });
    window.addEventListener('pageshow', function () { if (C.wantConnected && !isOpen()) connect(); });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (rpop.open) { closeRaisePop(); return; }
      closeDrawers();
    });
    if (window.PokerTheme && typeof window.PokerTheme.onChange === 'function') {
      window.PokerTheme.onChange(function () {
        if (C.state.me && C.state.me.seat != null) sendProfile();
        render();
      });
    }
    setInterval(diagTick, 5000);
    initFx();
    renderChat();
    if (!hasRTC()) setStatus('offline');
    render();
    setStatus('offline');
    // No connection (and so no camera) until the user opens Multiplayer: open() joins with the remembered name.
    restoreSession();   // after a reload mid-game, go straight back to Multiplayer (same seat via the token)
  }

  var SKELETON = `<div class="mp-app">
  <header class="mp-top">
    <div class="mp-tbar">
      <button type="button" class="mp-back" data-act="back-ask" aria-label="Back" title="Back">&lsaquo;</button>
      <h2 class="mp-title" data-mp-i18n="mp.title"></h2>
      <span class="mp-blinds hidden" id="mp-blinds"></span>
      <span class="mp-conn"><i class="mp-dot" id="mp-conn-dot"></i><span id="mp-conn-text"></span><span class="mp-rtt hidden" id="mp-rtt-wrap"><i class="mp-dot" id="mp-rtt-dot"></i><span id="mp-rtt"></span></span></span>
    </div>
    <div class="mp-tools" role="toolbar">
      <button type="button" class="mp-chip" id="mp-chip" data-dr="profile-modal" aria-haspopup="dialog" aria-label="Profile" title="Profile"><span class="mp-chip-av" id="mp-chip-av"></span><span class="mp-chip-name" id="mp-chip-name"></span></button>
      <button type="button" class="mp-ibtn mp-chat-btn" data-dr="chat" id="mp-btn-chat" aria-haspopup="dialog" aria-expanded="false" aria-label="Chat" title="Chat">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>
        <b class="mp-badge hidden" id="mp-chat-badge">0</b>
      </button>
      <button type="button" class="mp-ibtn" id="mp-btn-settings" data-dr="settings" aria-haspopup="dialog" aria-label="Settings" title="Settings">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3.2h-4l-.4 2.7a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1l.4 2.7h4l.4-2.7c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg>
      </button>
      <button type="button" class="mp-ibtn mp-sound hidden" id="mp-sound" data-act="enable-sound" aria-label="Click to enable sound" title="Click to enable sound">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z"/></svg>
        <span class="mp-sound-txt" data-mp-i18n="mp.sound.enable"></span>
      </button>
      
    </div>
  </header><div class="mp-alert hidden" id="mp-err" role="alert"></div>
  <section class="mp-entry" id="mp-entry">
    <form id="mp-form" class="mp-card mp-form" autocomplete="off">
      <p class="mp-muted" data-mp-i18n="mp.intro"></p>
      <div id="mp-entry-slot">
        <div class="mp-profile" id="mp-profile">
          <label class="mp-field"><span data-mp-i18n="mp.nameLabel"></span>
            <input id="mp-name" type="text" maxlength="16" data-mp-ph="mp.namePh" autocomplete="nickname"></label>
          <div class="mp-photo-row">
            <img id="mp-prof-img" class="mp-av big hidden" alt="">
            <span id="mp-prof-init" class="mp-av big init" aria-hidden="true"></span>
            <div class="mp-photo-btns">
              <button type="button" class="mp-btn small" data-act="pick-photo" data-mp-i18n="mp.photo.upload"></button>
              <button type="button" class="mp-btn small hidden" id="mp-remove-photo" data-act="clear-photo" data-mp-i18n="mp.photo.remove"></button>
            </div>
          </div>
          <p class="mp-err hidden" id="mp-prof-err" role="alert"></p>
          <button type="button" class="mp-btn primary hidden" id="mp-save-profile" data-act="save-profile" data-mp-i18n="mp.saveProfile"></button>
        </div>
      </div>
      <p class="mp-err hidden" id="mp-entry-err" role="alert"></p>
      <button type="submit" class="mp-btn primary" id="mp-join" data-mp-i18n="mp.join"></button>
    </form>
  </section>
  <div class="mp-body hidden" id="mp-body">
    <main class="mp-main">
      <section class="mp-lobby" id="mp-lobby">
        <header class="mp-lobby-head">
          <h2 class="mp-lobby-title" data-mp-i18n="mp.title"></h2>
          <div class="mp-lobby-meta">
            <button type="button" class="mp-code-chip" id="mp-code" data-act="copy-code" title="Copy">
              <span class="mp-code-lbl" data-mp-i18n="mp.lobby.invite"></span>
              <span class="mp-code-val" id="mp-code-val">—</span>
              <span class="mp-code-copy" id="mp-code-copy" data-mp-i18n="mp.lobby.copy"></span>
            </button>
            <span class="mp-lobby-status" id="mp-lobby-status"><i aria-hidden="true"></i><span id="mp-lobby-status-text"></span></span>
          </div>
        </header>
        <div class="mp-lobby-body">
          <section class="mp-card mp-lobby-card mp-lobby-players" aria-labelledby="mp-lobby-players-title">
            <div class="mp-lobby-cardhead"><h3 class="mp-h" id="mp-lobby-players-title" data-mp-i18n="mp.lobby.players"></h3></div>
            <ul class="mp-players mp-lobby-plist" id="mp-lobby-players"></ul>
          </section>
          <section class="mp-card mp-lobby-card mp-host" id="mp-host" aria-labelledby="mp-bots-title">
            <div class="mp-lobby-cardhead"><h3 class="mp-h" id="mp-bots-title" data-mp-i18n="mp.bots"></h3><span class="mp-lobby-count" id="mp-bots-count"></span></div>
            <ul class="mp-players mp-lobby-plist" id="mp-bots"></ul>
            <div class="mp-pager hidden" id="mp-bots-pager">
              <button type="button" class="mp-btn small" data-act="bots-prev" aria-label="Previous">&lsaquo;</button>
              <span id="mp-bots-pg"></span>
              <button type="button" class="mp-btn small" data-act="bots-next" aria-label="Next">&rsaquo;</button>
            </div>
            <div class="mp-botedit hidden" id="mp-botedit">
              <h3 class="mp-h" data-mp-i18n="mp.editBot"></h3>
              <div class="mp-photo-row">
                <img id="mp-be-img" class="mp-av big hidden" alt="">
                <span id="mp-be-init" class="mp-av big init" aria-hidden="true"></span>
                <button type="button" class="mp-btn small" data-act="bot-photo" data-mp-i18n="mp.photo.upload"></button>
              </div>
              <label class="mp-field"><span data-mp-i18n="mp.botName"></span>
                <input id="mp-be-name" type="text" maxlength="16"></label>
              <label class="mp-field"><span data-mp-i18n="mp.botStyle"></span><select id="mp-be-style"></select></label>
              <div class="mp-row">
                <button type="button" class="mp-btn primary" data-act="save-bot" data-mp-i18n="mp.saveBot"></button>
                <button type="button" class="mp-btn" data-act="cancel-bot" data-mp-i18n="mp.cancel"></button>
              </div>
            </div>
            <div class="mp-botform">
              <label class="mp-field"><span data-mp-i18n="mp.botStyle"></span><select id="mp-bot-style"></select></label>
              <label class="mp-field"><span data-mp-i18n="mp.botName"></span>
                <input id="mp-bot-name" type="text" maxlength="16"></label>
              <button type="button" class="mp-btn gold" data-act="add-bot" data-mp-i18n="mp.addBot"></button>
            </div>
          </section>
        </div>
        <section class="mp-card mp-lobby-settings" id="mp-lobby-settings" aria-labelledby="mp-lobby-set-title">
          <div class="mp-lobby-cardhead">
            <h3 class="mp-h" id="mp-lobby-set-title" data-mp-i18n="mp.lobby.tableSettings"></h3>
            <button type="button" class="mp-btn small" id="mp-set-toggle" data-act="toggle-settings" aria-expanded="false" data-mp-i18n="mp.lobby.editSettings"></button>
          </div>
          <div class="mp-chips">
            <span class="mp-chip-s"><small data-mp-i18n="mp.stack"></small><b id="mp-chip-stack">—</b></span>
            <span class="mp-chip-s"><small data-mp-i18n="mp.blinds"></small><b id="mp-chip-blinds">—</b></span>
            <span class="mp-chip-s"><small data-mp-i18n="mp.blindUp"></small><b id="mp-chip-blindup">—</b></span>
            <span class="mp-chip-s"><small data-mp-i18n="mp.lateStack"></small><b id="mp-chip-late">—</b></span>
            <span class="mp-chip-s"><small data-mp-i18n="mp.spectatorCards"></small><b id="mp-chip-spec">—</b></span>
          </div>
          <div class="mp-lobby-edit hidden" id="mp-lobby-edit">
            <div class="mp-grid2">
              <label class="mp-field"><span data-mp-i18n="mp.stack"></span>
                <input id="mp-set-stack" type="number" min="2" max="10000" step="0.5" value="100"></label>
              <div class="mp-field"><span data-mp-i18n="mp.blinds"></span><output class="mp-out" id="mp-set-blinds">—</output></div>
              <label class="mp-field"><span data-mp-i18n="mp.blindUp"></span><select id="mp-set-blindup"></select></label>
              <label class="mp-field"><span data-mp-i18n="mp.spectatorCards"></span><select id="mp-set-spec"></select></label>
              <label class="mp-field"><span data-mp-i18n="mp.lateStack"></span><select id="mp-set-late"></select></label>
              <label class="mp-field" id="mp-set-late-wrap" hidden><span data-mp-i18n="mp.lateFixed"></span><input id="mp-set-late-bb" type="number" min="5" step="0.5" value="20"></label>
              <label class="mp-check"><input id="mp-set-bshow" type="checkbox">
                <span data-mp-i18n="mp.botShowCards"></span></label>
              <label class="mp-field"><span data-mp-i18n="mp.stacksMode"></span><select id="mp-set-stacks"></select></label>
            </div>
            <div class="mp-field hidden"><span data-mp-i18n="mp.stacksMode"></span><div id="mp-stacks" class="mp-stacks"></div></div>
            <label class="mp-field sound-field"><span data-mp-i18n="mp.volume"></span><span class="sound-row"><input type="range" min="0" max="100" step="1" value="60" data-sound-volume><output class="sound-out" data-sound-volume-out>60</output></span></label>
            <p class="mp-err hidden" id="mp-set-err" role="alert"></p>
          </div>
        </section>
        <footer class="mp-lobby-foot">
          <p class="mp-lobby-counts" id="mp-lobby-counts"></p>
          <p class="mp-lobby-hint hidden" id="mp-start-hint" data-mp-i18n="mp.lobby.needTwo"></p>
          <div class="mp-card mp-guest hidden" id="mp-guest"><p data-mp-i18n="mp.lobby.waitHost"></p></div>
          <button type="button" class="mp-btn primary big hidden" id="mp-start" data-act="start" data-mp-i18n="mp.lobby.startGame"></button>
        </footer>
      </section>
      <section class="mp-tablev hidden" id="mp-table-view">
        <div class="mp-pause-banner hidden" id="mp-pause-banner" role="status" aria-live="polite"><b id="mp-pause-text"></b><button type="button" class="mp-btn small primary hidden" id="mp-pause-resume" data-act="resume"></button></div>
        <div class="mp-toast hidden" id="mp-toast" role="status" aria-live="polite"></div><div class="mp-banner hidden" id="mp-banner" role="status" aria-live="polite"></div>
        <div class="mp-table-wrap"><div class="mp-table" id="mp-table">
          <div class="mp-felt" id="mp-felt"></div>
          <div class="mp-center" id="mp-center">
            <div class="mp-status"><span id="mp-street"></span><span id="mp-pot" class="mp-pot"></span></div>
            <div class="mp-board" id="mp-board"></div>
            <p class="mp-join-note" id="mp-join-note" hidden></p>
          </div>
          <div class="mp-bets" id="mp-bets"></div>
          <div class="mp-seats" id="mp-seats"></div>
          <div class="mp-tip hidden" id="mp-tip" role="tooltip"></div>
        </div></div>
        <div class="mp-dock" id="mp-dock">
          <div class="mp-hero" id="mp-hero"></div>
          <div class="mp-actions">
            <button type="button" class="mp-act fold" id="mp-fold" data-act="fold"><kbd>F</kbd><span data-mp-i18n="mp.fold"></span></button>
            <button type="button" class="mp-act call" id="mp-call" data-act="call"><kbd>C</kbd><span id="mp-call-label"></span></button>
            <button type="button" class="mp-act raise" id="mp-raise" data-act="raise"><kbd>R</kbd><span id="mp-raise-label"></span></button>
          </div>
          <div class="mp-rpop hidden" id="mp-rpop" role="dialog" aria-label="Exact raise amount">
            <div class="mp-rpop-row">
              <button type="button" class="mp-btn small" data-act="rpop-dec" aria-label="Minus half BB">&minus;</button>
              <span class="mp-rpop-field"><input id="mp-rpop-in" type="number" step="0.5" inputmode="decimal" aria-label="Raise in big blinds"><b>BB</b></span>
              <button type="button" class="mp-btn small" data-act="rpop-inc" aria-label="Plus half BB">+</button>
            </div>
            <p class="mp-rpop-err hidden" id="mp-rpop-err" role="alert"></p>
            <div class="mp-rpop-acts">
              <button type="button" class="mp-btn small" data-act="rpop-cancel" id="mp-rpop-cancel"></button>
              <button type="button" class="mp-btn small primary" data-act="rpop-ok" id="mp-rpop-ok"></button>
            </div>
          </div>
          <div class="mp-raise-ctl">
            <input type="range" id="mp-raise-range" step="1" aria-label="Raise amount">
            <input type="number" id="mp-raise-num" step="1" aria-label="Raise amount"><b class="mp-raise-bb" id="mp-raise-bb" aria-live="polite"></b>
            <div class="mp-quick">
              <button type="button" class="mp-btn small" data-act="q" data-q="min" data-mp-i18n="mp.q.min"></button>
              <button type="button" class="mp-btn small" data-act="q" data-q="half" data-mp-i18n="mp.q.half"></button>
              <button type="button" class="mp-btn small" data-act="q" data-q="threeq">3/4</button>
              <button type="button" class="mp-btn small" data-act="q" data-q="pot" data-mp-i18n="mp.q.pot"></button>
              <button type="button" class="mp-btn small" data-act="q" data-q="allin" data-mp-i18n="mp.q.allin"></button>
            </div>
          </div>
        </div>
        <p class="mp-sr" id="mp-turn-text" aria-live="polite"></p>
      </section>
    </main>
    
  </div>
  <div class="mp-scrim" id="mp-scrim"></div>
  <aside class="mp-chat-drawer" id="mp-chat" aria-label="Chat">
    <div class="mp-chat-top"><h3 class="mp-h" data-mp-i18n="mp.chat.title"></h3><button type="button" class="mp-btn small" data-act="chat-close" aria-label="Close" title="Close">&times;</button></div>
    <div class="mp-chat-body hidden" id="mp-chat-body">
      <ol class="mp-chat-log" id="mp-chat-log" aria-live="polite"></ol>
      <form class="mp-chat-form" id="mp-chat-form" autocomplete="off">
        <input id="mp-chat-in" type="text" maxlength="200" data-mp-ph="mp.chat.ph" aria-label="Chat">
        <button type="button" class="mp-btn small mp-emo-btn" id="mp-emo-btn" aria-expanded="false" title="Emoji" aria-label="Emoji">&#x263A;</button>
        <button type="submit" class="mp-btn small" data-mp-i18n="mp.chat.send"></button>
      </form>
    </div>
  </aside>
  <div class="mp-modal mp-sheet hidden" id="mp-settings" role="dialog" aria-modal="true" aria-labelledby="mp-settings-title">
    <div class="mp-card mp-modal-box">
      <div class="mp-sheet-head"><h3 class="mp-h" id="mp-settings-title" data-mp-i18n="mp.settings"></h3><button type="button" class="mp-btn small" data-act="close-sheet" aria-label="Close" title="Close">&times;</button></div>
      <div class="mp-sheet-sec"><h3 class="mp-h" id="mp-players-title"></h3>
    <section class="mp-card mp-players-card"><ul class="mp-players" id="mp-players"></ul></section></div>
      <div class="mp-sheet-sec mp-admin-sec"><details class="mp-fold mp-admin-details hidden" id="mp-admin" open><summary data-mp-i18n="mp.admin"></summary>
      <div class="mp-admin">
        <div class="mp-grid2">
          <label class="mp-field"><span data-mp-i18n="mp.blindUp"></span><select id="mp-dlg-blindup"></select></label>
          <label class="mp-field"><span data-mp-i18n="mp.spectatorCards"></span><select id="mp-dlg-spec"></select></label>
        </div>
        <button type="button" class="mp-btn" id="mp-pause" data-act="pause"></button>
        <button type="button" class="mp-btn" id="mp-double" data-act="double-blinds" data-mp-i18n="mp.doubleBlinds"></button>
        <button type="button" class="mp-btn" data-act="reset" data-mp-i18n="mp.resetStacks"></button>
        <button type="button" class="mp-btn danger" data-act="end" data-mp-i18n="mp.endGame"></button>
        <div class="mp-row"><select id="mp-adm-style" aria-label="Elo"></select>
          <button type="button" class="mp-btn" data-act="admin-add-bot" data-mp-i18n="mp.addBot"></button></div>
        <p class="mp-note hidden" id="mp-paused" data-mp-i18n="mp.paused"></p>
      </div>
    </details></div>
    </div>
  </div>
  <div class="mp-modal mp-sheet hidden" id="mp-profile-modal" role="dialog" aria-modal="true" aria-labelledby="mp-profile-title">
    <div class="mp-card mp-modal-box">
      <div class="mp-sheet-head"><h3 class="mp-h" id="mp-profile-title" data-mp-i18n="mp.profile"></h3><button type="button" class="mp-btn small" data-act="close-sheet" aria-label="Close" title="Close">&times;</button></div>
    <details class="mp-fold mp-profile-details" id="mp-profile-details" open><summary data-mp-i18n="mp.profile"></summary>
      <div id="mp-side-slot"></div></details>
    </div>
  </div>

  <div class="mp-modal hidden" id="mp-standings" role="dialog" aria-modal="true">
    <div class="mp-card mp-modal-box">
      <h3 class="mp-h" data-mp-i18n="mp.standings"></h3>
      <ul class="mp-players" id="mp-stand-list"></ul>
      <button type="button" class="mp-btn primary big" data-act="close-standings" data-mp-i18n="mp.backLobby"></button>
    </div>
  </div>
  <input type="file" accept="image/*" id="mp-file" class="hidden">
</div>`;

  window.PokerMP = {
    open: open,
    // Name chosen on the Multiplayer screen (rooms): same rules as the join form. False when empty.
    // avatar (optional): a data URL to use, '' to remove, undefined to keep the saved photo.
    setName: function (v, avatar) {
      var nm = core.cleanName(v);
      if (!nm) return false;
      C.name = nm;
      if (E.name) E.name.value = nm;   // the profile dialog's name field, else Save reads a stale name
      if (avatar !== undefined) C.avatar = avatar || '';
      savePrefs();
      return true;
    },
    // Read from the shared record each time, so a change made in Settings > User is seen at once.
    getAvatar: function () { syncUser(); return C.avatar || ''; },
    getName: function () { syncUser(); return C.name || ''; },
    photoFromFile: photoFromFile,
    core: core,
    // Counters for media: frames and bytes sent and received through the server relay.
    stats: function () { return Object.assign({}, C.stats); },
    // Media state for tests and the debug line: caps, codec, peers (status, ICE log, audio level), relay seats.
    debug: function () {
      return {
        caps: caps, video: vtx.codec, profile: vtx.prof, soundBlocked: !!C.soundBlocked,
        audioCtx: rx.ctx ? rx.ctx.state : null,
        peers: Object.keys(C.peers).map(function (id) {
          var l = C.peers[id];
          return { id: id, status: core.linkStatus(l), restarted: !!l.restarted, needsRelay: !!l.needsRelay,
            log: l.log.slice(), path: l.path, lvl: l.aAn ? rmsOf(l.aAn) : 0,
            audioTime: l.audioEl ? +l.audioEl.currentTime.toFixed(2) : null, audioMuted: l.audioEl ? l.audioEl.muted : null };
        }),
        relay: Object.keys(C.relayIn).map(function (seat) {
          var rs = C.relayIn[seat];
          return { seat: seat, codec: rs.codec, decoded: rs.decoded, drawn: rs.drawn, lvl: rx.seat[seat] ? rmsOf(rx.seat[seat].an) : 0 };
        })
      };
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
