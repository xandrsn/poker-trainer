'use strict';
/* Multiplayer table ("mesa"): one shared game with up to 9 seats (humans and bots).
 * Server-authoritative. Hands, chips, side pots and bot decisions come from PokerGame
 * (public/game.js) and PokerBots (public/bots.js). Transport-agnostic: a connection is any
 * object with send(obj) and close(); mp.js wraps ws sockets into that shape.
 * Protocol: see MP_PROTOCOL.md. */
const crypto = require('crypto');
const path = require('path');
const G = require(path.join(__dirname, '..', 'public', 'game.js'));
const ENGINE = require(path.join(__dirname, '..', 'public', 'engine.js'));

const { DiagLog } = require('./diag.js');

const SEATS = 9;
const MAX_MEDIA_HUMANS = 6;          // camera/mic mesh is only sized for small rooms
const PERSONALITIES = ['tight', 'loose', 'aggressive', 'passive', 'balanced'];
const DEFAULTS = { stack: 100000, sb: 500, bb: 1000, personalities: PERSONALITIES.slice(), stacks: 'equal',
  externalCallUrl: null, botShowCards: false, blindUpMin: 0, spectatorCards: 'live', lateStack: 'start', lateFixedBB: 20 };
const SPECTATOR_CARDS = ['live', 'afterHand', 'off'];
const LATE_STACKS = ['start', 'half', 'avg', 'fixed'];   // entry stack of a player who joins a running game
const BB_CAP = 512000;
const PAUSE_AUTO_RESUME_MS = 10 * 60 * 1000;
const STACK_MODES = ['equal', 'varied', 'custom'];
const CHAT_MAX = 200, CHAT_KEEP = 50, CHAT_GAP_MS = 700;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const BALANCED = { name: 'balanced balanced', looseness: 'balanced', aggression: 'balanced' };
// Bot styles map onto PokerBots personas (styleOf(persona) gives the style back).
const STYLE_PERSONA = {
  tight: { name: 'tight balanced', looseness: 'tight', aggression: 'balanced' },
  loose: { name: 'loose balanced', looseness: 'loose', aggression: 'balanced' },
  aggressive: { name: 'balanced aggressive', looseness: 'balanced', aggression: 'aggressive' },
  passive: { name: 'balanced passive', looseness: 'balanced', aggression: 'passive' },
  balanced: BALANCED,
};
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const AVATAR_RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const AVATAR_MAX_BYTES = 64 * 1024;  // ~240x180 JPEG/PNG/WebP photos
const DEFAULT_TIMING = { botDelay: [500, 1200], actionMs: 45000, disconnectMs: 30000, showWindowMs: 5000,
  disconnectGraceMs: 5000, autoResumeMs: PAUSE_AUTO_RESUME_MS, blindMinuteMs: 60000,
  abandonedMs: 3 * 60 * 1000, emojiGoneMs: 60 * 60 * 1000 };

const EMOJI_MAX = 12, EMOJI_BYTES = 8192, EMOJI_DIM = 64, EMOJI_GAP_MS = 2000;
const EMOJI_PACKS_MAX = 40;         // packs kept for clientIds without a seat (oldest seen dropped first)
const EMOJI_ID_RE = /^[a-z0-9_]{1,12}$/;
const EMOJI_PREFIX = 'data:image/png;base64,';
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Validates one emoji image: PNG data URL, decoded <= 8 KB, IHDR first with width and height <= 64,
// no animation chunk (acTL = APNG). Throws 'bad emoji' otherwise.
function checkEmojiPng(data) {
  if (typeof data !== 'string' || !data.startsWith(EMOJI_PREFIX)) throw new Error('bad emoji');
  const b64 = data.slice(EMOJI_PREFIX.length);
  if (!b64.length || b64.length % 4 !== 0 || !B64_RE.test(b64)) throw new Error('bad emoji');
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  if (Math.floor(b64.length * 3 / 4) - padding > EMOJI_BYTES) throw new Error('bad emoji');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > EMOJI_BYTES || buf.length < 33) throw new Error('bad emoji');
  for (let i = 0; i < 8; i++) if (buf[i] !== PNG_SIG[i]) throw new Error('bad emoji');
  if (buf.toString('ascii', 12, 16) !== 'IHDR') throw new Error('bad emoji');
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (w < 1 || h < 1 || w > EMOJI_DIM || h > EMOJI_DIM) throw new Error('bad emoji');
  // Walk the chunks: refuse any acTL (animated PNG) and malformed lengths.
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'acTL') throw new Error('bad emoji');
    if (type === 'IEND') return;
    off += 12 + len;
  }
  throw new Error('bad emoji');
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function cleanName(v, what) {
  if (typeof v !== 'string') throw new Error((what || 'name') + ' must be a string');
  // Control characters become spaces; runs of whitespace collapse. Names are labels only, never ids.
  const t = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length < 1 || t.length > 16) throw new Error((what || 'name') + ' must be 1-16 characters');
  return t;
}
// Decoded byte count of a base64 body: 3 bytes per 4 characters, minus the '=' padding.
function avatarBytes(b64) {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor(b64.length * 3 / 4) - padding;
}
// null clears the avatar. Only small JPEG/PNG/WebP data URLs are accepted.
function cleanAvatar(v) {
  if (v === null) return null;
  const m = typeof v === 'string' ? AVATAR_RE.exec(v) : null;
  if (!m || avatarBytes(m[2]) > AVATAR_MAX_BYTES) {
    throw new Error('avatar must be a JPEG, PNG or WebP data URL of at most 64 KB');
  }
  return v;
}
function intIn(v, lo, hi, what) {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(what + ' must be an integer ' + lo + '-' + hi);
  return v;
}
// Starting stacks (and the late fixed stack) are 5 to 1000 big blinds, in steps of half a big blind.
const STACK_MIN_BB = 5, STACK_MAX_BB = 1000;
const STACK_RULE = 'The starting stack must be from 5 to 1000 BB, in steps of 0.5 BB.';
function checkStackBB(chips, bb) {
  if (!Number.isInteger(chips) || chips < STACK_MIN_BB * bb || chips > STACK_MAX_BB * bb) throw new Error(STACK_RULE);
  if ((chips * 2) % bb !== 0) throw new Error(STACK_RULE);
  return chips;
}
// Hex colour like #1a2b3c, or null to clear.
function cleanHighlight(v) {
  if (v === null) return null;
  if (typeof v !== 'string' || !HEX_RE.test(v)) throw new Error('highlight must be a #rrggbb colour');
  return v.toLowerCase();
}
// http(s) URL up to 200 chars, or null to clear.
function cleanExternalUrl(v) {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > 200) throw new Error('externalCallUrl must be an http(s) URL of at most 200 characters');
  let u;
  try { u = new URL(v); } catch (e) { throw new Error('externalCallUrl must be an http(s) URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('externalCallUrl must be an http(s) URL');
  return v;
}
// Personality list: array of known types (at least one), or a boolean (true = all, false = balanced only).
function cleanPersonalities(v) {
  if (v === true) return PERSONALITIES.slice();
  if (v === false) return ['balanced'];
  if (!Array.isArray(v) || !v.length) throw new Error('personalities must list at least one of ' + PERSONALITIES.join(', '));
  const bad = v.find((p) => PERSONALITIES.indexOf(p) < 0);
  if (bad !== undefined) throw new Error('unknown personality ' + bad);
  return PERSONALITIES.filter((p) => v.indexOf(p) >= 0);
}

class Room {
  // opts: { seed?, timing?: { botDelay:[min,max], actionMs, disconnectMs, nextHandMs } }
  constructor(opts) {
    opts = opts || {};
    this.timing = Object.assign({}, DEFAULT_TIMING, opts.timing || {});
    // Delay before the next deal defaults to the between-hands window.
    if (this.timing.nextHandMs == null) this.timing.nextHandMs = this.timing.showWindowMs;
    this.settings = Object.assign({}, DEFAULTS, { personalities: PERSONALITIES.slice() });
    this.diag = opts.diagFile === false ? null
      : new DiagLog(opts.diagFile || path.join(__dirname, '..', 'logs', 'mp-diag.log'), opts.diagMaxBytes);
    this.chat = [];                            // last CHAT_KEEP messages, sent to joiners
    this.shown = {};                           // seat -> true: cards shown this hand (showHand)
    this.table = G.newTable({ maxSeats: SEATS, seed: opts.seed });
    // seat -> { seat, clientId, name, avatar, bot, style, persona, connected, conn, joinOrder,
    //           startStack (custom stacks), kickPending }
    this.recs = new Array(SEATS).fill(null);
    this.conns = new Set();                    // every open connection (joined or not)
    this.joinCount = 0;
    this.removed = new Set();                  // clientIds the host removed: one refused rejoin each
    this.autoplay = false;                     // set by the host's first `start`; hands then repeat
    this.paused = false;
    this.pausedInfo = null;                    // {by, name, since, autoResumeAt} while paused
    this._pauseTimer = null;
    this.base = { sb: this.settings.sb, bb: this.settings.bb };  // blinds the host chose
    this.blindLevel = 0;                       // doublings in effect since the base blinds
    this.pendingDoubles = 0;                   // timer doublings waiting for the next hand
    this._blindClock = null;                   // { timer, left, due, fn } progressive blinds
    this.emojis = new Map();                   // clientId -> { emojis: [{id, data}] }, room lifetime
    this.netChips = 0;                         // chips put on / taken off the table by admin actions
    this.lastAct = {};                         // seat -> { hand, street, label, amount, allIn }
    this._turn = null;                         // { key, seat, timer, left, due, fn }
    this._next = null;                         // { timer, left, due, fn } (next hand)
    this._syncSettings();
  }

  // ------------------------------------------------------------ connections
  connect(conn) {
    this.conns.add(conn);
    conn.seat = null;
    conn.clientId = null;
  }

  disconnect(conn) {
    this.conns.delete(conn);
    if (conn.seat == null || this._disposed) return; // a disposed room arms no timers (late socket closes)
    const seat = conn.seat;
    conn.seat = null;
    const rec = this.recs[seat];
    if (rec && rec.conn === conn) {
      rec.conn = null;
      // The seat stays reserved; it shows as disconnected only after the grace period.
      this._clearGrace(rec);
      this._armAbandon(seat, rec);
      rec.graceTimer = setTimeout(() => {
        rec.graceTimer = null;
        if (!rec.conn && this.recs[seat] === rec && !this._disposed) {
          rec.connected = false;
          this._changed({ peers: true });
        }
      }, this.timing.disconnectGraceMs);
      // A player on turn who drops gets at most the short clock; the running clock never restarts.
      if (this._turn && this._turn.seat === seat) this._shortenTurn();
    }
    this._changed({ peers: true });
  }

  _clearGrace(rec) {
    if (rec.graceTimer) clearTimeout(rec.graceTimer);
    rec.graceTimer = null;
  }

  // A human seat dropped for abandonedMs is abandoned: freed at once unless a hand holds its chips
  // (then it is freed when that hand ends). Reclaiming the seat cancels the clock.
  _armAbandon(seat, rec) {
    this._disarmAbandon(rec);
    rec.droppedAt = Date.now();
    rec.abandonTimer = setTimeout(() => {
      rec.abandonTimer = null;
      if (this._disposed || this.recs[seat] !== rec) return;
      if (this._freeable(seat)) { this._vacate(seat); this._changed({ peers: true }); }
    }, this.timing.abandonedMs);
  }
  _disarmAbandon(rec) {
    if (rec.abandonTimer) clearTimeout(rec.abandonTimer);
    rec.abandonTimer = null;
    rec.droppedAt = null;
  }

  // Stops all timers for good: a disposed room never schedules again (late disconnects included).
  dispose() {
    this._disposed = true;
    this._dropTurn();
    this._clearNext();
    this._blindDisarm();
    this._clearPauseTimer();
    this.recs.forEach((rec) => { if (rec) { this._clearGrace(rec); this._disarmAbandon(rec); } });
  }

  // ---------------------------------------------------------------- messages
  receive(conn, msg) {
    try {
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') throw new Error('bad message');
      switch (msg.t) {
        case 'ping': return conn.send({ t: 'pong', ts: msg.ts, sv: Date.now() });
        case 'join': return this._join(conn, msg);
      }
      if (conn.seat == null) throw new Error('join first');
      switch (msg.t) {
        case 'profile': return this._profile(conn, msg);
        case 'addBot': return this._addBot(conn, msg);
        case 'editBot': return this._editBot(conn, msg);
        case 'removeBot': return this._removeBot(conn, msg);
        case 'kick': return this._kick(conn, msg);
        case 'settings': return this._settings(conn, msg);
        case 'setStack': return this._setStacks(conn, { [msg.seat]: msg.stack }, msg);
        case 'setStacks': return this._setStacks(conn, msg.stacks, msg);
        case 'start': return this._start(conn);
        case 'pause': return this._pause(conn);
        case 'resume': return this._resume(conn);
        case 'endGame': return this._endGame(conn);
        case 'reset': return this._reset(conn);
        case 'rebuy': return this._rebuy(conn);
        case 'doubleBlinds': return this._doubleBlinds(conn);
        case 'act': return this._act(conn, msg);
        case 'showHand': return this._showHand(conn);
        case 'chat': return this._chat(conn, msg);
        case 'emojiSet': return this._emojiSet(conn, msg);
        case 'emojiGet': return this._emojiGet(conn, msg);
        case 'diag': return this._diag(conn, msg);
        case 'needKey': return this._needKey(conn, msg);
        case 'rtc': return this._rtc(conn, msg);
        default: throw new Error('unknown message ' + msg.t);
      }
    } catch (e) {
      // Every rejection is a user-facing message (illegal action, host only, ...).
      conn.send({ t: 'error', msg: e.message });
    }
  }

  // -------------------------------------------------------------- lobby ops
  _join(conn, msg) {
    if (conn.seat != null) throw new Error('already joined');
    const clientId = typeof msg.clientId === 'string' && ID_RE.test(msg.clientId) ? msg.clientId : newId();
    const avatar = msg.avatar === undefined ? undefined : cleanAvatar(msg.avatar);
    const highlight = msg.highlight === undefined ? undefined : cleanHighlight(msg.highlight);
    if (msg.clientId !== undefined && this.removed.has(clientId)) {
      this.removed.delete(clientId);
      throw new Error('you were removed by the host');
    }
    let rec = this._human(clientId);
    if (rec) {
      // The clientId is public (peers see it); only the seat's secret token may reclaim it.
      if (typeof msg.token !== 'string' || !rec.token || msg.token !== rec.token) throw new Error('this seat belongs to another player');
      // Reclaim the seat: the old socket (another tab) is dropped.
      if (rec.conn && rec.conn !== conn) this._evict(rec.conn, 'connected from another window');
      rec.conn = conn;
      rec.connected = true;
      this._clearGrace(rec);
      this._disarmAbandon(rec);
      if (avatar !== undefined) rec.avatar = avatar;
      if (highlight !== undefined) rec.highlight = highlight;
    } else {
      const name = cleanName(msg.name);
      if (this._humanCount() >= MAX_MEDIA_HUMANS && !this._takeOverAbandoned()) {
        throw new Error('room is full (max ' + MAX_MEDIA_HUMANS + ' players)');
      }
      const seat = this.recs.indexOf(null);
      if (seat < 0) throw new Error('table is full');
      rec = { seat, clientId, name, avatar: avatar || null, highlight: highlight || null, bot: false, style: null,
        persona: null, connected: true, conn, joinOrder: ++this.joinCount, startStack: this.settings.stack,
        kickPending: false, varied: null, token: newToken() };
      this.recs[seat] = rec;
      // A newcomer who joins a running game waits until a hand actually deals him in (see _isWaiting).
      rec.awaitingDeal = this._isLive();
      this._setStack(seat, this._isLive() ? this._lateStack(seat, rec) : this._begin(rec));
    }
    conn.seat = rec.seat;
    conn.clientId = clientId;
    conn.lastChat = 0;
    conn.send({
      t: 'welcome',
      name: this.roomName || null,
      you:{ clientId, token: rec.token, seat: rec.seat, name: rec.name, avatar: rec.avatar, highlight: rec.highlight,
        host: this._hostSeat() === rec.seat },
      settings: this._settingsOut(),
    });
    conn.send({ t: 'chatHistory', messages: this.chat.slice() });
    this._emojiPrune();
    // Every non-empty custom emoji pack goes to the joiner (packs are small).
    for (const [id, pack] of this.emojis) {
      if (pack.emojis.length) conn.send({ t: 'emojiPack', clientId: id, emojis: pack.emojis.slice() });
    }
    this._changed({ peers: true });
  }

  // Custom emoji: the sender's whole set, replaced on every emojiSet. Kept for the room lifetime.
  _emojiSet(conn, msg) {
    const rec = this.recs[conn.seat];
    if (!rec || rec.bot) throw new Error('no seat for emoji');
    const now = Date.now();
    if (conn.lastEmojiSet && now - conn.lastEmojiSet < EMOJI_GAP_MS) throw new Error('slow down');
    conn.lastEmojiSet = now;
    if (!Array.isArray(msg.emojis)) throw new Error('bad emoji');
    if (msg.emojis.length > EMOJI_MAX) throw new Error('too many emojis');
    const ids = new Set();
    const clean = msg.emojis.map((e) => {
      if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !EMOJI_ID_RE.test(e.id)) throw new Error('bad emoji');
      if (ids.has(e.id)) throw new Error('bad emoji');
      ids.add(e.id);
      checkEmojiPng(e.data);
      return { id: e.id, data: e.data };
    });
    this.emojis.set(conn.clientId, { emojis: clean, seenAt: now });
    this._emojiPrune();
    const out = { t: 'emojiPack', clientId: conn.clientId, emojis: clean };
    for (const c of this.conns) if (c.seat != null) c.send(out);
  }

  // Packs of clientIds without a seat go once unseen for emojiGoneMs; at most EMOJI_PACKS_MAX are kept.
  _emojiPrune() {
    const now = Date.now();
    const seated = new Set(this.recs.filter((r) => r && !r.bot).map((r) => r.clientId));
    for (const [id, pack] of this.emojis) {
      if (seated.has(id)) pack.seenAt = now;
      else if (now - pack.seenAt > this.timing.emojiGoneMs) this.emojis.delete(id);
    }
    while (this.emojis.size > EMOJI_PACKS_MAX) {
      let oldest = null;
      for (const [id, pack] of this.emojis) {
        if (!seated.has(id) && (oldest === null || pack.seenAt < this.emojis.get(oldest).seenAt)) oldest = id;
      }
      if (oldest === null) break;
      this.emojis.delete(oldest);
    }
  }

  // Packs for the given clients: {t:'emojiPacks', packs:{clientId:[...]}}.
  _emojiGet(conn, msg) {
    if (!Array.isArray(msg.clientIds) || msg.clientIds.length > 64 || msg.clientIds.some((c) => typeof c !== 'string')) {
      throw new Error('bad emoji request');
    }
    const packs = {};
    for (const id of msg.clientIds) {
      const p = this.emojis.get(id);
      packs[id] = p ? p.emojis.slice() : [];
    }
    conn.send({ t: 'emojiPacks', packs: packs });
  }

  _profile(conn, msg) {
    const rec = this.recs[conn.seat];
    if (!rec || rec.bot) throw new Error('no seat to update');
    const name = msg.name === undefined ? undefined : cleanName(msg.name);
    const avatar = msg.avatar === undefined ? undefined : cleanAvatar(msg.avatar);
    const highlight = msg.highlight === undefined ? undefined : cleanHighlight(msg.highlight);
    if (name !== undefined) rec.name = name;
    if (avatar !== undefined) rec.avatar = avatar;
    if (highlight !== undefined) rec.highlight = highlight;
    this._changed({});
  }

  // Text chat: trimmed, control characters stripped, <= 200 chars, one message per 700 ms per client.
  _chat(conn, msg) {
    const rec = this.recs[conn.seat];
    if (!rec || rec.bot) throw new Error('no seat to chat from');
    if (typeof msg.text !== 'string') throw new Error('chat needs text');
    const text = msg.text.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!text) throw new Error('empty message');
    if (text.length > CHAT_MAX) throw new Error('chat message is longer than ' + CHAT_MAX + ' characters');
    const now = Date.now();
    if (conn.lastChat && now - conn.lastChat < CHAT_GAP_MS) throw new Error('chat too fast');
    conn.lastChat = now;
    const entry = { t: 'chat', from: conn.clientId, name: rec.name, text: text, time: now };
    this.chat.push(entry);
    if (this.chat.length > CHAT_KEEP) this.chat.splice(0, this.chat.length - CHAT_KEEP);
    for (const c of this.conns) if (c.seat != null) c.send(entry);
  }

  // Media diagnostics from a client: JSON line in logs/mp-diag.log. Invalid, oversized or too
  // frequent reports are dropped silently (1 per second per client, <= 4 KB each).
  _diag(conn, msg) {
    const rec = this.recs[conn.seat];
    if (!rec || !this.diag) return;
    const now = Date.now();
    if (conn.lastDiag && now - conn.lastDiag < 1000) return;
    if (typeof msg.kind !== 'string' || msg.kind.length > 40) return;
    if (JSON.stringify(msg).length > 4096) return;
    conn.lastDiag = now;
    this.diag.append({ clientId: conn.clientId, name: rec.name, kind: msg.kind, data: msg.data });
  }

  // A receiver asks a sender for a keyframe: routed as {t:'needKey', from} to the sender.
  _needKey(conn, msg) {
    if (typeof msg.to !== 'string') throw new Error('needKey needs a target');
    const rec = this._human(msg.to);
    if (!rec || !rec.conn) throw new Error('peer not connected');
    rec.conn.send({ t: 'needKey', from: conn.clientId });
  }

  _addBot(conn, msg) {
    this._requireHost(conn);
    this._requireNotPaused();
    const style = msg.style === undefined ? 'balanced' : msg.style;
    if (!Object.prototype.hasOwnProperty.call(STYLE_PERSONA, style)) throw new Error('unknown style');
    const seat = this.recs.indexOf(null);
    if (seat < 0) throw new Error('table is full');
    const name = msg.name === undefined ? cap(style) + ' bot' : cleanName(msg.name, 'bot name');
    const avatar = msg.avatar === undefined ? null : cleanAvatar(msg.avatar);
    const rec = { seat, clientId: null, name, avatar, bot: true, style, persona: STYLE_PERSONA[style],
      connected: true, conn: null, joinOrder: ++this.joinCount, startStack: this.settings.stack, kickPending: false };
    this.recs[seat] = rec;
    this._setStack(seat, this._begin(rec));
    this._syncPersonas();
    this._changed({});
  }

  // Name, avatar and (between hands only) style of a bot.
  _editBot(conn, msg) {
    this._requireHost(conn);
    const seat = this._seatArg(msg);
    const rec = this.recs[seat];
    if (!rec || !rec.bot) throw new Error('no bot at that seat');
    if (msg.style !== undefined && msg.style !== rec.style) {
      this._requireIdle();
      if (!Object.prototype.hasOwnProperty.call(STYLE_PERSONA, msg.style)) throw new Error('unknown style');
      rec.style = msg.style;
      rec.persona = STYLE_PERSONA[msg.style];
    }
    if (msg.name !== undefined) rec.name = cleanName(msg.name, 'bot name');
    if (msg.avatar !== undefined) rec.avatar = cleanAvatar(msg.avatar);
    this._syncPersonas();
    this._changed({});
  }

  // A bot removed mid-hand is accepted at once: marked leaving, it folds on its turn and leaves when
  // the hand ends (its chips in the pot stay there). Between hands it leaves immediately.
  _removeBot(conn, msg) {
    this._requireHost(conn);
    this._requireNotPaused();
    const seat = this._seatArg(msg);
    const rec = this.recs[seat];
    if (!rec || !rec.bot) throw new Error('no bot at that seat');
    if (rec.kickPending) return;
    if (this._handActive() && this.table.hand.seats[seat].dealt) {
      rec.kickPending = true;
      if (this._turn && this._turn.seat === seat) this._dropTurn();
      this._changed({ peers: true });
      return;
    }
    this._vacate(seat);
    this._changed({ peers: true });
  }

  // A human is removed at once when no hand runs. During a hand the player is marked, folds
  // on their next turn (immediately if it is their turn now), and leaves when the hand ends.
  _kick(conn, msg) {
    this._requireHost(conn);
    this._requireNotPaused();
    const seat = this._seatArg(msg);
    const rec = this.recs[seat];
    if (!rec) throw new Error('no player at that seat');
    if (rec.conn === conn) throw new Error('cannot kick yourself');
    if (rec.kickPending) throw new Error('that player is already leaving');
    if (rec.clientId) this.removed.add(rec.clientId);
    if (rec.conn) this._evict(rec.conn, 'kicked by the host', { t: 'kicked', reason: 'host' });
    if (this._handActive() && this.table.hand.seats[seat].dealt) {
      // Held: the seat keeps its chips in the pot and is freed when the hand ends.
      rec.kickPending = true;
      rec.conn = null;
      rec.connected = false;
      this._clearGrace(rec);
      if (this._turn && this._turn.seat === seat) this._dropTurn();
      this._changed({ peers: true });
      return;
    }
    this._vacate(seat);
    this._changed({ peers: true });
  }

  // `randomness` is retired (CPU behaviour follows the personalities): accepted and ignored.
  _settings(conn, msg) {
    this._requireHost(conn);
    this._requireNotPaused();
    const s = Object.assign({}, this.settings);
    if (msg.blindUpMin !== undefined) s.blindUpMin = intIn(msg.blindUpMin, 0, 10, 'blindUpMin');
    if (msg.spectatorCards !== undefined) {
      if (SPECTATOR_CARDS.indexOf(msg.spectatorCards) < 0) throw new Error("spectatorCards must be 'live', 'afterHand' or 'off'");
      s.spectatorCards = msg.spectatorCards;
    }
    if (msg.stack !== undefined) s.stack = intIn(msg.stack, 1, 1e9, 'stack');
    if (msg.sb !== undefined) s.sb = intIn(msg.sb, 1, 1e6, 'sb');
    if (msg.bb !== undefined) s.bb = intIn(msg.bb, 2, 1e6, 'bb');
    if (msg.personalities !== undefined) s.personalities = cleanPersonalities(msg.personalities);
    if (msg.stacks !== undefined) {
      if (STACK_MODES.indexOf(msg.stacks) < 0) throw new Error("stacks must be 'equal', 'varied' or 'custom'");
      s.stacks = msg.stacks;
    }
    if (msg.externalCallUrl !== undefined) s.externalCallUrl = cleanExternalUrl(msg.externalCallUrl);
    if (msg.botShowCards !== undefined) {
      if (typeof msg.botShowCards !== 'boolean') throw new Error('botShowCards must be true or false');
      s.botShowCards = msg.botShowCards;
    }
    if (msg.lateStack !== undefined) {
      if (LATE_STACKS.indexOf(msg.lateStack) < 0) throw new Error("lateStack must be 'start', 'half', 'avg' or 'fixed'");
      s.lateStack = msg.lateStack;
    }
    if (msg.lateFixedBB !== undefined) {
      const v = msg.lateFixedBB;
      if (typeof v !== 'number' || !isFinite(v) || v < STACK_MIN_BB || v > STACK_MAX_BB || (v * 2) % 1 !== 0) throw new Error('The late fixed stack must be from 5 to 1000 BB, in steps of 0.5 BB.');
      s.lateFixedBB = v;
    }
    // The external call link can change at any time; the rest only between hands.
    // Only a real change counts: the table's settings dialog re-sends every field, unchanged ones included.
    const blindsOrStacks = ['stack', 'sb', 'bb', 'personalities', 'stacks'].some((k) => JSON.stringify(s[k]) !== JSON.stringify(this.settings[k]));
    if (blindsOrStacks) this._requireIdle();
    if (s.sb > s.bb) throw new Error('sb must not exceed bb');
    // Only a real change to the stack or the blinds is checked, so an unchanged stack after blind-ups still saves.
    if ((msg.stack !== undefined || msg.bb !== undefined) && (s.stack !== this.settings.stack || s.bb !== this.settings.bb)) checkStackBB(s.stack, s.bb);
    const switchedToEqual = s.stacks === 'equal' && this.settings.stacks !== 'equal';
    const switchedToVaried = s.stacks === 'varied' && this.settings.stacks !== 'varied';
    this.settings = s;
    // Blinds the host sets become the new base; progressive doublings start over from them.
    if (msg.sb !== undefined || msg.bb !== undefined) {
      this.base = { sb: s.sb, bb: s.bb };
      this.blindLevel = 0;
      this.pendingDoubles = 0;
    }
    this._syncSettings();
    this._syncPersonas();
    if (s.blindUpMin === 0) { this._blindDisarm(); this.pendingDoubles = 0; } else this._blindArm();
    // Switching the money mode puts every seat on the new starting stacks now.
    if (switchedToEqual) this.recs.forEach((rec, seat) => { if (rec) this._setStack(seat, s.stack); });
    if (switchedToVaried) this.recs.forEach((rec, seat) => { if (rec) this._setStack(seat, this._begin(rec)); });
    this._changed({});
  }

  // Custom stacks: host sets each seat's starting stack (between hands). `map` is {seat: amount}.
  _setStacks(conn, map, msg) {
    this._requireHost(conn);
    this._requireNotPaused();
    this._requireIdle();
    if (this.settings.stacks !== 'custom') throw new Error("set stacks to 'custom' first");
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('stacks must be {seat: amount}');
    const bb = this.settings.bb;
    const entries = Object.keys(map).map((k) => {
      const seat = Number(k);
      if (!Number.isInteger(seat) || seat < 0 || seat >= SEATS) throw new Error('bad seat ' + k);
      if (!this.recs[seat]) throw new Error('no player at seat ' + seat);
      return [seat, checkStackBB(intIn(map[k], 1, 1e9, 'stack'), bb)];
    });
    if (!entries.length) throw new Error('no stacks given');
    entries.forEach(([seat, amount]) => {
      this.recs[seat].startStack = amount;
      this._setStack(seat, amount);
    });
    this._changed({});
  }

  _start(conn) {
    this._requireHost(conn);
    if (this.paused) throw new Error('the game is paused');
    if (this._handActive()) throw new Error('a hand is already running');
    const prev = this.autoplay;
    this.autoplay = true;
    if (!this._startHand()) {
      this.autoplay = prev;
      throw new Error('need at least 2 players with chips');
    }
    this._blindArm();
    this._changed({});
  }

  // Freezes every timer (turns, bot actions, next hand, blind clock) and refuses player actions.
  // The pause is server-side: everybody sees the same banner (who, since, auto-resume time).
  _pause(conn) {
    this._requireHost(conn);
    if (this.paused) return; // pausing twice is a silent no-op
    const now = Date.now();
    const rec = this.recs[conn.seat];
    this.paused = true;
    this.pausedInfo = { by: conn.seat, name: rec ? rec.name : '', since: now, autoResumeAt: now + this.timing.autoResumeMs };
    this._freezeTimers();
    this._clearPauseTimer();
    this._pauseTimer = setTimeout(() => {
      this._pauseTimer = null;
      if (this._disposed || !this.paused) return;
      this._unpause();
      this._changed({});
    }, this.timing.autoResumeMs);
    this._changed({});
  }

  _resume(conn) {
    this._requireHost(conn);
    if (!this.paused) return; // resuming when not paused is a silent no-op
    this._unpause();
    this._changed({});
  }

  _unpause() {
    this.paused = false;
    this.pausedInfo = null;
    this._clearPauseTimer();
    for (const t of this._timers()) if (t && !t.timer) this._runTimer(t);
  }

  _clearPauseTimer() {
    if (this._pauseTimer) clearTimeout(this._pauseTimer);
    this._pauseTimer = null;
  }

  _requireNotPaused() {
    if (this.paused) throw new Error('the game is paused');
  }

  // Host only: queues one doubling for the NEXT hand. While a hand runs it waits for the hand boundary
  // (_startHand), so the BB shown in the lobby and at the table never changes mid-hand.
  _doubleBlinds(conn) {
    this._requireHost(conn);
    this._requireNotPaused();
    if (this._handActive()) {
      if (this.settings.bb >= BB_CAP || this.settings.bb * 2 > this.settings.stack) throw new Error('blinds cannot go higher');
      this.pendingDoubles += 1;
      this._changed({});
      return;
    }
    if (!this._doubleOnce()) throw new Error('blinds cannot go higher');
    this._notifyBlinds();
    this._changed({});
  }

  // Doubles sb and bb once, capped at BB_CAP and at the starting stack. Returns true when changed.
  _doubleOnce() {
    const bb = Math.min(BB_CAP, this.settings.bb * 2);
    if (bb === this.settings.bb || bb > this.settings.stack) return false;
    this.settings = Object.assign({}, this.settings, { sb: Math.min(this.settings.sb * 2, bb), bb: bb });
    this.blindLevel += 1;
    this._syncSettings();
    return true;
  }

  _notifyBlinds() {
    const msg = { t: 'notice', kind: 'blinds', sb: this.settings.sb, bb: this.settings.bb };
    for (const c of this.conns) c.send(msg);
  }

  // Back to the blinds the host chose (game end or reset).
  _restoreBase() {
    const changed = this.settings.sb !== this.base.sb || this.settings.bb !== this.base.bb;
    this.blindLevel = 0;
    this.pendingDoubles = 0;
    if (!changed) return;
    this.settings = Object.assign({}, this.settings, { sb: this.base.sb, bb: this.base.bb });
    this._syncSettings();
    this._notifyBlinds();
  }

  // Progressive blinds: a clock of blindUpMin minutes; each tick queues one doubling for the next hand.
  _blindArm() {
    if (this._blindClock || this._disposed || !this.autoplay || !this.settings.blindUpMin) return;
    const period = this.settings.blindUpMin * this.timing.blindMinuteMs;
    this._blindClock = { timer: null, left: period, due: 0, fn: () => this._blindTick() };
    this._runTimer(this._blindClock);
  }
  _blindTick() {
    const c = this._blindClock;
    if (!c) return;
    c.timer = null;
    c.left = this.settings.blindUpMin * this.timing.blindMinuteMs;
    this.pendingDoubles += 1;
    this._runTimer(c);
    this._changed({});
  }
  _blindDisarm() {
    if (this._blindClock && this._blindClock.timer) clearTimeout(this._blindClock.timer);
    this._blindClock = null;
  }

  // Ends the game now: a running hand is refunded (chips return to the seats), autoplay stops,
  // and every connected player gets the standings. The table stays seated for the next game.
  _endGame(conn) {
    this._requireHost(conn);
    this.autoplay = false;
    this.paused = false;
    this.pausedInfo = null;
    this._clearPauseTimer();
    this._dropTurn();
    this._clearNext();
    this._blindDisarm();
    this._restoreBase();
    if (this._handActive()) {
      const hand = this.table.hand;
      hand.seats.forEach((hs, seat) => {
        this.table.seats[seat].stack += hs.contributed;
        hs.contributed = 0;
      });
    }
    this.table.hand = null;
    this.table.over = null;
    this.lastAct = {};
    this._gameOverSent = true;
    // Standings show the chips each player ended with; then every seat (bots too) is back on its
    // starting stack and the table waits in the lobby for the host to start again.
    this._sendStandings();
    this.recs.forEach((rec, seat) => { if (rec) this._setStack(seat, this._begin(rec)); });
    this._changed({});
  }

  _sendStandings() {
    const standings = this.recs
      .map((rec, seat) => (rec && !rec.kickPending ? { seat, name: rec.name, stack: this.table.seats[seat].stack, avatar: rec.avatar || null } : null))
      .filter(Boolean)
      .sort((a, b) => b.stack - a.stack || a.seat - b.seat);
    for (const c of this.conns) if (c.seat != null) c.send({ t: 'gameOver', standings: standings });
  }

  // Host only, between hands: every seated player gets their starting stack back.
  _reset(conn) {
    this._requireHost(conn);
    this._requireNotPaused();
    this._requireIdle();
    this.recs.forEach((rec, seat) => { if (rec) this._setStack(seat, this._begin(rec)); });
    this._restoreBase();
    this._blindDisarm();
    this._blindArm();
    this._changed({});
  }

  // A busted human buys back in with their starting stack (between hands).
  _rebuy(conn) {
    const rec = this.recs[conn.seat];
    this._requireNotPaused();
    if (!rec || rec.bot) throw new Error('no seat to rebuy');
    // Allowed mid-hand when this seat is not in the running hand (its chips are not in play).
    if (this._handActive() && this.table.hand.seats[conn.seat].dealt) throw new Error('wait until the hand ends');
    if (!this._eliminated(conn.seat)) throw new Error('you still have chips');
    this._setStack(conn.seat, this._begin(rec));
    this._changed({});
  }

  _act(conn, msg) {
    const hand = this.table.hand;
    // A duplicate or stale act (double click, late packet) carries an old turn key: ignored silently.
    if (msg.turn !== undefined) {
      if (typeof msg.turn !== 'string') throw new Error('bad turn');
      if (msg.turn !== this._turnKey()) return;
    }
    if (this.paused) throw new Error('the game is paused');
    if (this._isOut(conn.seat)) throw new Error('you are out - spectating');
    if (!hand || hand.over) throw new Error('no hand in progress');
    if (hand.toAct !== conn.seat) throw new Error('not your turn');
    const action = msg.action;
    if (action !== 'fold' && action !== 'call' && action !== 'raise') throw new Error('unknown action');
    let amount;
    if (action === 'raise') {
      if (typeof msg.amount !== 'number' || !Number.isFinite(msg.amount)) throw new Error('raise needs an amount');
      amount = msg.amount;
    }
    this._apply(conn.seat, () => G.act(this.table, conn.seat, action, amount));
    this._changed({});
  }

  // Between hands: reveal this seat's two cards to everyone (folded or uncontested too).
  // During a hand: only to the observers (folded or out of the hand, spectators): shownTo 'observers'.
  _showHand(conn) {
    const rec = this.recs[conn.seat];
    if (!rec || rec.bot) throw new Error('no seat to show from');
    if (this._isOut(conn.seat)) throw new Error('you are out - spectating');
    const hand = this.table.hand;
    if (!hand) throw new Error('no hand to show');
    if (!hand.seats[conn.seat].dealt) throw new Error('you were not dealt in this hand');
    if (hand.over) this.shown[conn.seat] = true;
    else if (this.shown[conn.seat] !== true) this.shown[conn.seat] = 'observers';
    this._changed({});
  }

  _rtc(conn, msg) {
    if (typeof msg.to !== 'string') throw new Error('rtc needs a target');
    if (msg.data === null || typeof msg.data !== 'object') throw new Error('rtc needs data');
    const rec = this._human(msg.to);
    if (!rec || !rec.conn) throw new Error('peer not connected');
    rec.conn.send({ t: 'rtc', from: conn.clientId, data: msg.data });
  }

  // ------------------------------------------------------------- hand flow
  _startHand() {
    this._clearNext();
    this._gameOverSent = false;
    this.table.over = null; // solo bookkeeping; the table has no 'over' state of its own
    // Busted bots were removed when their hand ended (_finishLeaves): nothing refills them.
    // Progressive blinds: queued doublings take effect here, at the hand boundary only (before the
    // eligibility check below, which uses the blind level of the hand being dealt).
    let doubled = false;
    while (this.pendingDoubles > 0) {
      this.pendingDoubles -= 1;
      if (this._doubleOnce()) doubled = true;
    }
    if (doubled) this._notifyBlinds();
    const active = [];
    this.recs.forEach((rec, seat) => { if (rec && !rec.kickPending && !this._eliminated(seat)) active.push(seat); });
    if (active.length < 2) return false;
    const hand = G.startHand(this.table, { active: active });
    if (!hand) return false;
    // Newcomers are waiting until a deal includes them: clear the flag for every seat dealt in now.
    this.recs.forEach((rec, seat) => { if (rec && hand.seats[seat] && hand.seats[seat].dealt) rec.awaitingDeal = false; });
    this.lastAct = {};
    this.shown = {};
    this._changed({});
    return true;
  }

  // Applies one engine action and records its label for the seat's last-action text.
  _apply(seat, fn) {
    const hand = this.table.hand;
    const no = hand.no, street = hand.street;
    const res = fn();
    // The engine records the real kind of each action (limp, bet, raise, call, check, fold) in hand.history.
    const hist = hand.history && hand.history.length ? hand.history[hand.history.length - 1] : null;
    let label = hist && hist.seat === seat ? hist.action : res.action;
    if (label === 'call' && res.text === 'checks') label = 'check';
    this.lastAct[seat] = { hand: no, street: street, label: label, amount: res.amount,
      allIn: res.action !== 'fold' && this.table.seats[seat].stack === 0 };
    return res;
  }

  _turnTimeout(key) {
    if (this.paused || !this._turn || this._turn.key !== key) return;
    this._turn = null;
    const hand = this.table.hand;
    if (!hand || hand.over || hand.toAct == null) return this._changed({});
    const seat = hand.toAct;
    const rec = this.recs[seat];
    try {
      if (rec && rec.kickPending) {
        this._apply(seat, () => G.act(this.table, seat, 'fold'));
      } else if (rec && rec.bot) {
        this._apply(seat, () => G.stepBot(this.table));
      } else {
        // Auto-play for a player who is away: check when free, otherwise fold.
        const L = G.legal(this.table, seat);
        const action = L && L.toCall > 0 ? 'fold' : 'call';
        this._apply(seat, () => G.act(this.table, seat, action));
      }
    } catch (e) {
      console.error('room: turn timeout failed: ' + (e && e.stack || e));
      try { this._apply(seat, () => G.act(this.table, seat, 'fold')); } catch (e2) { /* nothing legal left */ }
    }
    this._changed({});
  }

  // System lines in the chat when a hand ends: one per winning seat. Neutral keys + params only
  // (kind, name, hand {rank, cards}, amount, bb: the big blind in chips when the hand ended); each client words them in its own language.
  _announceWins(hand) {
    const res = hand.results;
    if (!res || !res.wins) return;
    const now = Date.now();
    Object.keys(res.wins).forEach((k) => {
      const seat = Number(k);
      const rec = this.recs[seat];
      const name = rec ? rec.name : '';
      const amount = res.wins[k];
      let entry;
      if (!res.showdown) {
        entry = { t: 'chat', system: true, kind: 'winFold', name, amount, bb: this.settings.bb, time: now };
      } else {
        const hs = hand.seats[seat];
        const all = (hs && hs.cards ? hs.cards.slice() : []).concat(hand.board || []);
        let best = null, bestScore = -1;
        if (all.length >= 5) {
          for (let a = 0; a < all.length; a++) for (let b = a + 1; b < all.length; b++) for (let c = b + 1; c < all.length; c++)
            for (let d = c + 1; d < all.length; d++) for (let e = d + 1; e < all.length; e++) {
              const five = [all[a], all[b], all[c], all[d], all[e]];
              const r = ENGINE.evaluateHand(five);
              if (r.score > bestScore) { bestScore = r.score; best = { rank: r.rank, cards: five }; }
            }
        }
        entry = { t: 'chat', system: true, kind: 'win', name, hand: best, amount, bb: this.settings.bb, time: now };
      }
      this.chat.push(entry);
      if (this.chat.length > CHAT_KEEP) this.chat.splice(0, this.chat.length - CHAT_KEEP);
      for (const c of this.conns) if (c.seat != null) c.send(entry);
    });
  }

  // Keeps exactly one timer for the current decision, and one for the next hand.
  _advance() {
    if (this._disposed) return;
    const hand = this.table.hand;
    if (hand && hand.over && this._announced !== hand.no) { this._announced = hand.no; this._announceWins(hand); }
    if (hand && !hand.over && hand.toAct != null) {
      const key = hand.no + ':' + hand.actions;
      if (!this._turn || this._turn.key !== key) {
        if (this._turn && this._turn.timer) clearTimeout(this._turn.timer);
        const seat = hand.toAct;
        const rec = this.recs[seat];
        let ms;
        if (rec && rec.kickPending) ms = 0;
        else if (rec && rec.bot) ms = this.timing.botDelay[0] + Math.random() * (this.timing.botDelay[1] - this.timing.botDelay[0]);
        else ms = rec && rec.conn ? this.timing.actionMs : this.timing.disconnectMs;
        this._turn = { key: key, seat: seat, timer: null, left: ms, due: 0, fn: () => this._turnTimeout(key) };
        this._runTimer(this._turn);
      }
    } else if (this._turn) {
      this._dropTurn();
    }
    if ((!hand || hand.over) && !this._next && this._canAutoStart()) {
      this._next = { timer: null, left: this.timing.nextHandMs, due: 0, fn: () => {
        this._next = null;
        if (this._canAutoStart()) this._startHand();
      } };
      this._runTimer(this._next);
    }
  }

  // Timers only run while the game is not paused; a paused timer keeps its remaining time.
  _runTimer(t) {
    if (this.paused || t.timer) return;
    t.due = Date.now() + t.left;
    t.timer = setTimeout(t.fn, t.left);
  }
  _timers() {
    return [this._turn, this._next, this._blindClock];
  }
  _freezeTimers() {
    for (const t of this._timers()) {
      if (t && t.timer) {
        clearTimeout(t.timer);
        t.timer = null;
        t.left = Math.max(0, t.due - Date.now());
      }
    }
  }
  // Milliseconds left on a clock: frozen while paused (no timer), counted down otherwise.
  _leftOf(t) {
    if (!t) return null;
    return t.timer ? Math.max(0, t.due - Date.now()) : t.left;
  }
  // A player on turn drops: the running clock only shrinks to the disconnect clock, never restarts.
  _shortenTurn() {
    const t = this._turn;
    if (!t) return;
    t.left = Math.min(this._leftOf(t), this.timing.disconnectMs);
    if (t.timer) { clearTimeout(t.timer); t.timer = null; }
    this._runTimer(t);
  }
  _dropTurn() {
    if (this._turn && this._turn.timer) clearTimeout(this._turn.timer);
    this._turn = null;
  }
  // Identifies the current decision; a client's act carries it so stale acts are ignored.
  _turnKey() {
    const h = this.table.hand;
    if (!h || h.over || h.toAct == null) return null;
    return h.no + '|' + h.street + '|' + h.toAct;
  }
  _clearNext() {
    if (this._next && this._next.timer) clearTimeout(this._next.timer);
    this._next = null;
  }

  // The next hand repeats while at least one human has chips and two seats can play.
  _canAutoStart() {
    if (!this.autoplay) return false;
    let humanWithChips = false, playable = 0;
    this.recs.forEach((rec, seat) => {
      if (!rec || rec.kickPending) return;
      if (this._eliminated(seat)) return; // same eligibility as _startHand: a hand must be dealable
      if (!rec.bot) humanWithChips = true;
      playable++;
    });
    // A busted human who stays as a spectator keeps the bots playing; with nobody connected it waits.
    return (humanWithChips || this.conns.size > 0) && playable >= 2;
  }

  // ------------------------------------------------------------ broadcasts
  _changed(opts) {
    if (!this._handActive()) { this._finishLeaves(); this._sweepAbandoned(); }
    this._checkGameOver();
    // Arm timers first so the broadcast can announce nextHandAt.
    this._advance();
    this._broadcast(!!(opts && opts.peers));
  }

  // One player left with chips after a showdown: the game is over (standings, autoplay stops).
  _checkGameOver() {
    const hand = this.table.hand;
    if (!this.autoplay || !hand || !hand.over || this._gameOverSent) return;
    const chipped = this.recs.filter((rec, seat) => rec && !rec.kickPending && !this._eliminated(seat)).length;
    if (chipped >= 2) return;
    this._gameOverSent = true;
    this.autoplay = false;
    this._clearNext();
    this._blindDisarm();
    this._sendStandings();
  }

  // Players kicked mid-hand and bots that busted leave once the hand is over. A busted bot is
  // gone for good: it is never refilled, so its chips cannot reappear.
  // A bot under 1 BB at hand end is eliminated: it is removed, with a system note, and the table goes on.
  _finishLeaves() {
    this.recs.forEach((rec, seat) => {
      if (!rec) return;
      if (rec.kickPending) { this._vacate(seat); return; }
      if (rec.bot && this._eliminated(seat)) {
        this._vacate(seat);
        const entry = { t: 'chat', system: true, kind: 'botOut', name: rec.name, time: Date.now() };
        this.chat.push(entry);
        if (this.chat.length > CHAT_KEEP) this.chat.splice(0, this.chat.length - CHAT_KEEP);
        for (const c of this.conns) if (c.seat != null) c.send(entry);
      }
    });
  }
  // Eliminated = fewer than 1 BB left (the engine's isEliminated rule). Checked between hands only:
  // a seat all-in at 0 during a hand is not eliminated until that hand ends.
  _eliminated(seat) {
    return this.table.seats[seat].stack < this.settings.bb;
  }

  // A seat is freeable when it is a human socket-less seat that no running hand holds.
  _freeable(seat) {
    const rec = this.recs[seat];
    if (!rec || rec.bot || rec.conn || rec.kickPending) return false;
    const hs = this._handActive() && this.table.hand.seats[seat];
    return !(hs && hs.dealt);
  }
  _isAbandoned(seat) {
    const rec = this.recs[seat];
    return !!rec && rec.droppedAt != null && Date.now() - rec.droppedAt >= this.timing.abandonedMs && this._freeable(seat);
  }
  // Frees every abandoned seat that no hand holds (run when a hand ends).
  _sweepAbandoned() {
    this.recs.forEach((rec, seat) => { if (rec && this._isAbandoned(seat)) this._vacate(seat); });
  }
  // A full room: the oldest abandoned seat is freed for the newcomer. False when there is none.
  _takeOverAbandoned() {
    let pick = -1;
    this.recs.forEach((rec, seat) => {
      if (this._isAbandoned(seat) && (pick < 0 || rec.droppedAt < this.recs[pick].droppedAt)) pick = seat;
    });
    if (pick < 0) return false;
    this._vacate(pick);
    return true;
  }

  _broadcast(peers) {
    const lobby = { t: 'lobby', name: this.roomName || null, players: this._players(), spectators: this._spectators(), settings: this._settingsOut() };
    const ids = this._peerIds();
    const serverNow = Date.now();
    for (const conn of this.conns) {
      if (conn.seat == null) continue;
      conn.send(lobby);
      conn.send({ t: 'state', paused: this.paused ? this.pausedInfo : null, serverNow: serverNow,
        hand: this._viewFor(conn.seat) });
      if (peers) conn.send({ t: 'peers', ids: ids });
    }
  }

  _players() {
    const host = this._hostSeat();
    const out = [];
    this.recs.forEach((rec, seat) => {
      if (!rec || this._isOut(seat)) return;
      const p = { seat: seat, name: rec.name, avatar: rec.avatar || null, highlight: rec.highlight || null, bot: rec.bot, waiting: this._isWaiting(seat),
        connected: rec.bot ? true : rec.connected, host: seat === host, camera: false,
        stack: this.table.seats[seat].stack, startStack: this._startOf(rec) };
      if (rec.kickPending) p.leaving = true; // removed by the host; leaves when this hand ends
      if (rec.bot) p.style = rec.style; else p.clientId = rec.clientId;
      out.push(p);
    });
    return out;
  }

  // Busted humans: out of the seats for play, still connected (chat, camera, watching).
  _spectators() {
    const out = [];
    this.recs.forEach((rec, seat) => {
      if (!rec || !this._isOut(seat)) return;
      // stack: the chips this spectator still holds (under 1 BB); they stay in the ledger (netChips) until a rebuy.
      out.push({ seat: seat, clientId: rec.clientId, name: rec.name, avatar: rec.avatar || null, connected: rec.connected,
        stack: this.table.seats[seat].stack });
    });
    return out;
  }

  _lastActionText(seat) {
    const e = this.lastAct[seat];
    const hand = this.table.hand;
    if (!e || !hand || e.hand !== hand.no || e.street !== hand.street) return '';
    let s = e.label;
    if (e.label === 'raise') s += ' to ' + e.amount;
    else if (e.label === 'bet' && e.amount) s += ' ' + e.amount;
    if (e.allIn) s += ' (all-in)';
    return s;
  }

  // The state one seat may see. Hidden cards appear only for that seat, or after showdown
  // for players who reached it.
  _viewFor(me) {
    const hand = this.table.hand;
    if (!hand) return null;
    const over = hand.over;
    const meHs = me != null ? hand.seats[me] : null;
    const myTurn = !over && me != null && hand.toAct === me && !this.paused;
    const L = myTurn ? G.legal(this.table, me) : null;
    // Spectators (busted humans) may see other players' hole cards, per settings.spectatorCards.
    // Players never do: only their own cards, or cards that are face-up for everybody.
    const spectator = me != null && this._isOut(me);
    const mode = this.settings.spectatorCards;
    const seeAll = spectator && (mode === 'live' || (mode === 'afterHand' && over));
    const seeFolded = spectator && mode === 'afterHand';
    // Observers of a running hand: spectators, and seated viewers who are folded or not dealt in it.
    const observer = me != null && (spectator || !meHs || !meHs.dealt || meHs.folded);
    const seats = [];
    const potChips = hand.seats.reduce((a, hs) => a + hs.contributed, 0);
    this.recs.forEach((rec, seat) => {
      if (!rec || rec.kickPending || this._isOut(seat)) return;
      const hs = hand.seats[seat];
      const es = this.table.seats[seat];
      const shown = this.shown[seat] === true && !!hs.dealt;
      const faceUp = !!(hs.dealt && (hs.reveal || shown) && (!rec.bot || this.settings.botShowCards));
      // Spectators see every dealt seat per setting, bots included (botShowCards only affects players).
      const specView = !!(hs.dealt && (seeAll || (seeFolded && hs.folded)));
      // A mid-hand show reaches only the shower and the observers (folded, out of the hand, spectators).
      // Every other viewer gets no cards and no shownTo field for that seat (no leak).
      const obsShown = !over && this.shown[seat] === 'observers' && !!hs.dealt && (seat === me || observer);
      const s = {
        seat: seat, name: rec.name, avatar: rec.avatar || null, highlight: rec.highlight || null, bot: rec.bot,
        stack: es.stack, bet: over ? 0 : hs.bet, inHand: hs.dealt, folded: !hs.dealt || hs.folded, allIn: hs.allIn,
        position: hs.dealt ? hs.pos : null, lastAction: this._lastActionText(seat),
        cards: hs.dealt && (seat === me || faceUp || specView || obsShown) ? hs.cards.slice() : null,
        shown: shown,
        revealed: faceUp,
        connected: rec.bot ? true : rec.connected,
      };
      if (obsShown) s.shownTo = 'observers';
      if (rec.bot) s.style = rec.style;
      seats.push(s);
    });
    const h = {
      id: hand.no, street: hand.street, over: over, pot: over ? 0 : potChips,
      board: hand.board.slice(), dealer: hand.btnIdx,
      toAct: over ? null : hand.toAct, minRaise: hand.curBet + hand.lastRaise,
      toCall: meHs && meHs.dealt && !meHs.folded && !over ? Math.max(0, hand.curBet - meHs.bet) : 0,
      seats: seats,
      youCards: meHs && meHs.dealt ? meHs.cards.slice() : [],
      showWindowMs: this.timing.showWindowMs,
      // Epoch ms when the next deal happens (between hands only; null while paused or not scheduled).
      nextHandAt: over && this._next && this._next.timer && !this.paused ? this._next.due : null,
      // Ms left on the running clocks (frozen while paused; null when there is none).
      turnLeftMs: !over && hand.toAct != null && this._turn ? this._leftOf(this._turn) : null,
      nextLeftMs: over && this._next ? this._leftOf(this._next) : null,
    };
    if (L) h.legal = { fold: true, call: true, raise: L.canRaise, minRaiseTo: L.minRaiseTo, maxRaiseTo: L.maxRaiseTo };
    if (over) {
      const res = G.results(this.table);
      h.winners = Object.keys(res.wins).map((k) => ({
        seat: Number(k), amount: res.wins[k], hand: res.handNames[k] || null,
      }));
      h.pots = res.pots.map((p) => ({ amount: p.amount, winners: p.winners.slice() }));
    }
    return h;
  }

  // ------------------------------------------------------------- helpers
  _human(clientId) {
    return this.recs.find((r) => r && !r.bot && !r.kickPending && r.clientId === clientId) || null;
  }
  _hostSeat() {
    // the earliest joiner who is still connected; a seat that dropped never keeps the host role from the others
    let best = null;
    const pick = (needConnected) => this.recs.forEach((rec) => {
      if (rec && !rec.bot && !rec.kickPending && (!needConnected || rec.connected) && (best === null || rec.joinOrder < best.joinOrder)) best = rec;
    });
    pick(true);
    if (!best) pick(false);
    return best ? best.seat : -1;
  }
  _peerIds() {
    return this.recs.filter((r) => r && !r.bot && !r.kickPending && r.connected).map((r) => r.clientId);
  }
  // The stack a seat starts with, and gets back on reset/rebuy: the equal stack or its own.
  _startOf(rec) {
    return this.settings.stacks === 'equal' ? this.settings.stack : rec.startStack;
  }
  // Like _startOf, but in 'varied' mode first draws a fresh random stack for the seat
  // (0.4x-1.6x the base stack, whole big blinds, from the table's seeded generator).
  // A game is running (hands repeat or one is dealt): a newcomer gets the late-join stack.
  _isLive() { return this.autoplay || this._handActive(); }
  // Seated during a running hand but not dealt in: waits for the next deal (no cards until then).
  _isWaiting(seat) {
    const rec = this.recs[seat];
    if (rec && rec.awaitingDeal) return true; // stays true between hands until a deal includes him
    const hand = this.table.hand;
    if (!this._handActive() || !hand || !hand.seats || !hand.seats[seat]) return false;
    return !hand.seats[seat].dealt;
  }
  // Entry stack of a newcomer while the game runs: 'start' (starting stack), 'half', 'avg' (average of
  // the other stacks) or 'fixed' (lateFixedBB). Amounts are whole multiples of half a big blind.
  _lateStack(seat, rec) {
    const s = this.settings;
    if (s.lateStack === 'start') return this._begin(rec);
    const bb = s.bb;
    const unit = Math.max(1, Math.round(bb / 2));
    const grid = (v) => Math.max(bb, Math.round(v / unit) * unit);
    if (s.lateStack === 'fixed') return grid(s.lateFixedBB * bb);
    if (s.lateStack === 'half') return grid(rec.startStack / 2);
    const others = this.table.seats.filter((es, i) => i !== seat && es && es.stack > 0).map((es) => es.stack);
    if (!others.length) return this._begin(rec);
    return grid(others.reduce((a, b) => a + b, 0) / others.length);
  }
  _begin(rec) {
    if (this.settings.stacks === 'varied') {
      const bb = this.settings.bb;
      const f = 0.4 + 1.2 * this.table.rng();
      rec.startStack = Math.max(bb, Math.round(this.settings.stack * f / bb) * bb);
    }
    return this._startOf(rec);
  }
  // A human under 1 BB (busted, or below the elimination line) leaves the seats once no hand deals
  // them in (the showdown of the hand they busted in stays visible). Their socket stays open: they see
  // the table, chat and showdowns, but cannot act.
  _isOut(seat) {
    const rec = this.recs[seat];
    if (!rec || rec.bot || rec.kickPending || !this._eliminated(seat)) return false;
    const hs = this.table.hand && this.table.hand.seats[seat];
    return !(hs && hs.dealt);
  }
  _humanCount() {
    return this.recs.filter((r) => r && !r.bot && !r.kickPending).length;
  }
  _requireHost(conn) {
    if (this._hostSeat() !== conn.seat) throw new Error('host only');
  }
  _requireIdle() {
    if (this._handActive()) throw new Error('wait until the hand ends');
  }
  _handActive() {
    return !!this.table.hand && !this.table.hand.over;
  }
  _seatArg(msg) {
    if (!Number.isInteger(msg.seat) || msg.seat < 0 || msg.seat >= SEATS) throw new Error('bad seat');
    return msg.seat;
  }
  _evict(conn, reason, frame) {
    conn.send(frame || { t: 'error', msg: reason });
    conn.seat = null;
    conn.clientId = null;
    this.conns.delete(conn);
    conn.close();
  }
  _vacate(seat) {
    const rec = this.recs[seat];
    if (rec) { this._clearGrace(rec); this._disarmAbandon(rec); }
    this._setStack(seat, 0);
    this.recs[seat] = null;
    const es = this.table.seats[seat];
    es.isBot = false;
    es.persona = null;
    es.busted = true;
  }
  // Sets a seat's stack and keeps netChips in step (chips the room added or removed).
  _setStack(seat, amount) {
    const es = this.table.seats[seat];
    const rec = this.recs[seat];
    this.netChips += amount - es.stack;
    es.stack = amount;
    es.busted = amount <= 0;
    es.isBot = !!(rec && rec.bot);
    if (!es.isBot) es.persona = null;
  }
  _syncSettings() {
    this.table.cfg.bb = this.settings.bb;
    this.table.cfg.sb = this.settings.sb;
    this.table.cfg.personalities = this.settings.personalities.slice();
  }
  // A bot plays its own style when that personality is enabled, otherwise as a balanced player.
  _syncPersonas() {
    this.recs.forEach((rec, seat) => {
      if (!rec || !rec.bot) return;
      const enabled = this.settings.personalities.indexOf(rec.style) >= 0;
      this.table.seats[seat].persona = enabled ? rec.persona : BALANCED;
    });
  }
  _settingsOut() {
    return Object.assign({}, this.settings, { blindLevel: this.blindLevel, nextBlindUpAt: this._nextBlindUpAt() });
  }
  // Epoch ms of the next progressive doubling; null while off, paused or idle.
  _nextBlindUpAt() {
    const c = this._blindClock;
    return c && c.timer && !this.paused ? c.due : null;
  }
  // Chips in play: stacks plus what is in the pot. Equals netChips at all times.
  chipsInPlay() {
    return G.totalChips(this.table);
  }
}

function newId() { return crypto.randomBytes(9).toString('base64url'); }
function newToken() { return crypto.randomBytes(18).toString('base64url'); }

module.exports = { Room, SEATS, STYLE_PERSONA, DEFAULTS, checkEmojiPng, EMOJI_MAX, EMOJI_BYTES, EMOJI_DIM, EMOJI_GAP_MS };
