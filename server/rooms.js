'use strict';
/* Room registry: many independent tables (server/room.js), each with its own state, bots, chat,
 * host and settings. Public rooms only for now (isPublic is always true; password is an unused slot).
 * A room with no connections for `emptyMs` is destroyed. The default room (legacy direct `join`
 * without a room, used by old tests and tools) is hidden from the list and never destroyed. */
const crypto = require('crypto');
const { Room } = require('./room.js');

const ID_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1 (easy to read aloud)
const ID_LEN = 5;
const MAX_ROOMS = 50;
const MAX_NAME = 24;
const MAX_HUMANS = 6;                 // same cap as Room (media mesh size)
const CREATE_GAP_MS = 5000;           // per connection
const DEFAULT_EMPTY_MS = 2 * 60 * 1000;
const SWEEP_MS = 15000;
const PUSH_MS = 2000;

// Room name: control characters and HTML-special characters become spaces, runs collapse, max 24.
function cleanRoomName(v, id) {
  const fallback = 'Room ' + id;
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v !== 'string') throw new Error('name must be a string');
  const t = v.replace(/[\u0000-\u001f\u007f-\u009f<>&"'`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
  return t || fallback;
}

// Name key for uniqueness: the cleaned name, trimmed, whitespace collapsed, lower case.
// 'Mesa  de Ana' and 'mesa de ana ' are the same table name.
function roomKey(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f-\u009f<>&"'`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim().toLowerCase();
}

class RoomManager {
  // opts: { seed?, timing?, diagFile?, diagMaxBytes?, room? (the default room) }
  constructor(opts) {
    opts = opts || {};
    this.opts = opts;
    this.timing = opts.timing || {};
    this.emptyMs = this.timing.roomEmptyMs || DEFAULT_EMPTY_MS;
    this.maxRooms = this.timing.maxRooms || MAX_ROOMS;
    this.entries = new Map();          // id -> { id, name, room, createdAt, isPublic, password }
    this.subscribers = new Set();      // connections on the room-list screen
    this.lastCreate = new WeakMap();   // conn -> ms of its last createRoom
    this.defaultRoom = opts.room || new Room(opts);
    this._sweeper = setInterval(() => this.sweep(), this.timing.roomSweepMs || SWEEP_MS);
    this._pusher = setInterval(() => this.pushLists(), this.timing.roomPushMs || PUSH_MS);
    this._sweeper.unref();
    this._pusher.unref();
  }

  newId() {
    for (let tries = 0; tries < 100; tries++) {
      const bytes = crypto.randomBytes(ID_LEN);
      let id = '';
      for (let i = 0; i < ID_LEN; i++) id += ID_CHARS[bytes[i] % ID_CHARS.length];
      if (!this.entries.has(id)) return id;
    }
    throw new Error('no room code free');
  }

  get(id) {
    const e = this.entries.get(id);
    return e ? e.room : null;
  }

  // True when another room already has this name (case-insensitive, trimmed, spaces collapsed).
  nameTaken(name, exceptId) {
    const key = roomKey(name);
    if (!key) return false;
    for (const e of this.entries.values()) {
      if (e.id !== exceptId && roomKey(e.name) === key) return true;
    }
    return false;
  }

  // First free alternative: 'Mesa de Ana' -> 'Mesa de Ana 2', 'Mesa de Ana 3', ... (max 24 chars).
  suggestName(name) {
    const base = cleanRoomName(name, 'Room');
    for (let n = 2; n < 1000; n++) {
      const tail = ' ' + n;
      const cand = base.slice(0, MAX_NAME - tail.length).trim() + tail;
      if (!this.nameTaken(cand)) return cand;
    }
    return base;
  }

  // Creates a room. `settings` (optional) are the host settings chosen in the create panel, checked by the
  // same rules as the host's settings message (server/room.js _settings). Throws on a bad value.
  create(name, now, settings) {
    if (this.entries.size >= this.maxRooms) throw new Error('too many rooms (max ' + this.maxRooms + ')');
    const id = this.newId();
    const room = new Room(Object.assign({}, this.opts, { room: undefined, seed: undefined }));
    room.roomId = id;
    const entry = { id, name: cleanRoomName(name, id), room, createdAt: now || Date.now(), isPublic: true, password: null };
    room.roomName = entry.name; // the table name: shown in the lobby title and copied by the code chip
    room.roomEntry = entry;
    if (settings) {
      // No one is seated yet, so the host seat is -1 (room._hostSeat). The pseudo connection has the same
      // seat, which passes the host check of _settings; nothing else about the connection is used.
      try { room._settings({ seat: -1 }, settings); } catch (err) { room.dispose(); throw err; }
    }
    this.entries.set(id, entry);
    return entry;
  }

  // Room state for the list. players = seated humans, bots = seated bots, max = humans allowed.
  summary(entry) {
    const room = entry.room;
    const recs = room.recs.filter(Boolean);
    const humans = recs.filter((r) => !r.bot).length;
    const bots = recs.length - humans;
    const host = room._hostSeat();
    const hostRec = host == null ? null : room.recs[host];
    return {
      id: entry.id,
      name: entry.name,
      players: humans,
      max: MAX_HUMANS,
      bots,
      status: room.autoplay ? 'playing' : 'lobby',
      host: hostRec ? hostRec.name : null,
      blinds: { sb: room.settings.sb, bb: room.settings.bb },
      createdAt: entry.createdAt,
      isPublic: true,
    };
  }

  list() {
    return Array.from(this.entries.values()).map((e) => this.summary(e));
  }

  // Attaches conn to a room (connection bookkeeping in Room.connect).
  attach(conn, room) {
    room.connect(conn);
    conn.room = room;
    if (room.roomEntry) room.roomEntry.emptySince = null;
  }

  detach(conn) {
    const room = conn.room;
    conn.room = null;
    if (!room) return;
    room.disconnect(conn);
    if (room.roomEntry && room.conns.size === 0) room.roomEntry.emptySince = Date.now();
  }

  // Destroys rooms with no connection for emptyMs. The default room is never destroyed.
  sweep(now) {
    now = now || Date.now();
    for (const [id, e] of this.entries) {
      if (e.room.conns.size === 0 && e.emptySince && now - e.emptySince >= this.emptyMs) this.destroy(id);
    }
  }

  destroy(id) {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    e.room.dispose();
  }

  pushLists() {
    if (!this.subscribers.size) return;
    const msg = { t: 'roomList', rooms: this.list() };
    for (const conn of this.subscribers) conn.send(msg);
  }

  close() {
    clearInterval(this._sweeper);
    clearInterval(this._pusher);
    this.subscribers.clear();
    for (const e of this.entries.values()) e.room.dispose();
    this.entries.clear();
    this.defaultRoom.dispose();
  }
}

module.exports = { RoomManager, cleanRoomName, roomKey, ID_CHARS, ID_LEN, MAX_ROOMS, MAX_NAME, CREATE_GAP_MS };
