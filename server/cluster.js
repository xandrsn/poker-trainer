'use strict';
/* Rooms across several server instances (Vercel Functions), used only with Redis.
 * One instance owns a room: it holds the lease, runs the Room in memory and saves a snapshot after every
 * change. The sockets of other instances reach it through Redis pub/sub. When the owner stops (or has no
 * socket of its own left in the room), the next instance that needs the room takes the lease and restores
 * the snapshot; its players reconnect and reclaim their seats with their token. */
const crypto = require('crypto');
const { Room } = require('./room.js');

const LEASE_MS = 9000, TICK_MS = 3000, SAVE_MS = 120, REFRESH_MS = 60000, LIST_MS = 150000;
const SNAP_MS = { casual: 10 * 60 * 1000, ranked: 60 * 60 * 1000 };
const SAVE_LUA = "if redis.call('get',KEYS[1])==ARGV[1] then redis.call('set',KEYS[2],ARGV[2],'PX',ARGV[3]) return 1 end return 0";
const RENEW_LUA = "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('pexpire',KEYS[1],ARGV[2]) end return 0";
const RELEASE_LUA = "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) end return 0";

// Stands in for a room owned by another instance (same calls as Room makes available to mp.js).
class RemoteRoom {
  constructor(cluster, id, owner) {
    this.cluster = cluster;
    this.roomId = id;
    this.owner = owner;
    this.conns = new Set();
  }
  receive(conn, msg) { this.cluster.toOwner(this, { k: 'msg', cid: conn.cid, msg }, conn); }
  disconnect(conn) { this.conns.delete(conn); this.cluster.toOwner(this, { k: 'close', cid: conn.cid }, null); }
}

class Cluster {
  constructor(manager, store) {
    this.m = manager;
    this.r = store.raw;
    this.id = crypto.randomBytes(8).toString('base64url');
    this.local = new Map();   // cid -> conn (sockets on this instance attached to a remote room)
    this.virtual = new Map(); // 'inst:cid' -> conn (sockets on other instances, attached to a room owned here)
    this.saving = new Map();  // room id -> timer
    this.opening = new Map(); // room id -> promise of taking it over
    this.cache = [];          // last room list
    this.sub = store.subscriber();
    this.sub.subscribe('i:' + this.id).catch((e) => console.error('cluster: ' + e.message));
    this.sub.on('message', (ch, raw) => this._onMessage(JSON.parse(raw)));
    this._timer = setInterval(() => this._tick().catch((e) => console.error('cluster: ' + e.message)), TICK_MS);
    this._timer.unref();
    manager.cluster = this;
    process.once('SIGTERM', () => { for (const id of Array.from(manager.entries.keys())) this._release(id).catch(() => {}); });
  }

  _pub(inst, obj) { return this.r.publish('i:' + inst, JSON.stringify(obj)); }

  // ------------------------------------------------------------ opening rooms
  // Attaches conn to a room wherever it runs. False when there is no such room.
  async join(conn, id) {
    for (let tries = 0; tries < 6; tries++) {
      if (tries) await new Promise((r) => setTimeout(r, 150));
      await this.opening.get(id);
      const own = this.m.entries.get(id);
      if (own) { this.m.attach(conn, own.room); return true; }
      const take = this._take(id);
      this.opening.set(id, take.catch(() => {}));
      let got;
      try { got = await take; } finally { this.opening.delete(id); }
      if (got === 'none') return false;
      if (got === 'mine') {
        this.m.attach(conn, this.m.entries.get(id).room);
        return true;
      }
      const owner = await this.r.get('lease:' + id);
      if (!owner || owner === this.id) continue;
      const room = new RemoteRoom(this, id, owner);
      const n = await this._pub(owner, { k: 'open', room: id, cid: conn.cid, from: this.id, user: conn.user || null });
      if (n > 0) {
        this.local.set(conn.cid, conn);
        room.conns.add(conn);
        conn.room = room;
        return true;
      }
      await this.r.eval(RELEASE_LUA, 1, 'lease:' + id, owner); // the owner is gone
    }
    return false;
  }

  // Takes the lease of a room nobody runs and restores it: 'mine', 'other' (it runs elsewhere) or 'none'.
  async _take(id) {
    if (!(await this.r.set('lease:' + id, this.id, 'PX', LEASE_MS, 'NX'))) return 'other';
    const raw = await this.r.get('snap:' + id);
    if (!raw) { await this.r.eval(RELEASE_LUA, 1, 'lease:' + id, this.id); return 'none'; }
    this._adopt(Room.restore(JSON.parse(raw).state, this.m.opts), id);
    return 'mine';
  }

  _adopt(room, id) {
    room.roomId = id;
    const entry = { id, name: room.roomName, room, createdAt: room.createdAt || Date.now(), isPublic: !room.ranked, password: null };
    room.roomEntry = entry;
    this.m.entries.set(id, entry);
    this.watch(entry);
    return entry;
  }

  watch(entry) {
    entry.savedAt = 0;
    entry.room.onChange = () => {
      if (this.saving.has(entry.id)) return;
      this.saving.set(entry.id, setTimeout(() => {
        this.saving.delete(entry.id);
        this._save(entry).catch((e) => console.error('cluster: ' + e.message));
      }, SAVE_MS));
    };
  }

  // A casual room just made by this instance's manager.
  async created(entry) {
    await this.r.set('lease:' + entry.id, this.id, 'PX', LEASE_MS);
    this.watch(entry);
    await this._save(entry);
  }

  // A ranked room starts as a snapshot; the first player to arrive runs it.
  async createRanked(room, id) {
    await this.r.set('snap:' + id, JSON.stringify({ at: Date.now(), state: room.snapshot() }), 'PX', SNAP_MS.ranked);
  }

  async status(id, staleMs) {
    const raw = await this.r.get('snap:' + id);
    if (!raw) return 'gone';
    const s = JSON.parse(raw);
    if (s.state.finished) return 'gone';
    return Date.now() - s.at > staleMs ? 'stale' : 'live';
  }

  async _save(entry) {
    const room = entry.room;
    if (room._disposed) return;
    entry.savedAt = Date.now();
    const ok = await this.r.eval(SAVE_LUA, 2, 'lease:' + entry.id, 'snap:' + entry.id, this.id,
      JSON.stringify({ at: Date.now(), state: room.snapshot() }), room.ranked ? SNAP_MS.ranked : SNAP_MS.casual);
    if (!ok) { this._drop(entry.id); return; } // another instance took the room
    if (!room.ranked) await this.r.hset('rooms', entry.id, JSON.stringify({ at: Date.now(), room: this.m.summary(entry) }));
  }

  // Stops running a room here. Returns its sockets: closing them makes the players reconnect to the new owner.
  _stop(id) {
    const e = this.m.entries.get(id);
    if (!e) return [];
    clearTimeout(this.saving.get(id));
    this.saving.delete(id);
    const conns = Array.from(e.room.conns);
    this.m.entries.delete(id);
    e.room.dispose();
    for (const [key, v] of this.virtual) if (v.room === e.room) this.virtual.delete(key);
    conns.forEach((c) => { c.room = null; });
    return conns;
  }

  _drop(id) { this._stop(id).forEach((c) => c.close()); }

  async _release(id) {
    const e = this.m.entries.get(id);
    if (!e) return;
    const saved = this._save(e); // the snapshot is taken before the room stops
    const conns = this._stop(id);
    await saved;
    await this.r.eval(RELEASE_LUA, 1, 'lease:' + id, this.id);
    conns.forEach((c) => c.close());
  }

  // Called by the manager when a room is destroyed for being empty.
  destroyed(id) {
    clearTimeout(this.saving.get(id));
    this.saving.delete(id);
    this.r.eval(RELEASE_LUA, 1, 'lease:' + id, this.id).catch(() => {});
    this.r.hdel('rooms', id).catch(() => {});
    this.r.del('snap:' + id).catch(() => {});
  }

  // A room with no socket on this instance must not stay here: the platform may freeze the process.
  leftBy(room) {
    if (!room || !room.roomEntry || room._disposed) return;
    if (!Array.from(room.conns).some((c) => c.ws)) this._release(room.roomId).catch((e) => console.error('cluster: ' + e.message));
  }

  // ------------------------------------------------------------ messages between instances
  toOwner(room, obj, conn) {
    this._pub(room.owner, Object.assign({ room: room.roomId, from: this.id }, obj)).then((n) => {
      if (!n && conn) conn.close();
    }).catch(() => { if (conn) conn.close(); });
    if (obj.k === 'close') this.local.delete(obj.cid);
  }

  _onMessage(o) {
    if (o.k === 'out' || o.k === 'drop') {
      const c = this.local.get(o.cid);
      if (!c) return;
      if (o.k === 'out') c.send(o.obj);
      else c.close();
      return;
    }
    const key = o.from + ':' + o.cid;
    if (o.k === 'open') {
      const e = this.m.entries.get(o.room);
      if (!e) { this._pub(o.from, { k: 'drop', cid: o.cid }); return; }
      const v = {
        from: o.from, user: o.user, seat: null, clientId: null, room: e.room,
        send: (obj) => { this._pub(o.from, { k: 'out', cid: o.cid, obj }).catch(() => {}); },
        close: () => { this._pub(o.from, { k: 'drop', cid: o.cid }).catch(() => {}); },
      };
      this.virtual.set(key, v);
      this.m.attach(v, e.room);
      return;
    }
    const v = this.virtual.get(key);
    if (!v || !v.room) { if (o.k === 'msg') this._pub(o.from, { k: 'drop', cid: o.cid }); return; }
    if (o.k === 'msg') v.room.receive(v, o.msg);
    else { this.virtual.delete(key); this.m.detach(v); }
  }

  async _tick() {
    for (const e of Array.from(this.m.entries.values())) {
      if (!(await this.r.eval(RENEW_LUA, 1, 'lease:' + e.id, this.id, LEASE_MS))) this._drop(e.id);
      else if (Date.now() - e.savedAt > REFRESH_MS) await this._save(e);
    }
    const peers = Array.from(new Set(Array.from(this.virtual.values(), (v) => v.from)));
    if (peers.length) {
      const n = await this.r.pubsub('NUMSUB', ...peers.map((p) => 'i:' + p));
      const dead = new Set(peers.filter((p, i) => Number(n[i * 2 + 1]) === 0));
      for (const [key, v] of this.virtual) if (dead.has(v.from)) { this.virtual.delete(key); this.m.detach(v); }
    }
    // Sockets here whose room moved to another owner (a frozen owner keeps its subscription).
    for (const c of Array.from(this.local.values())) {
      if (c.room && c.room.owner && (await this.r.get('lease:' + c.room.roomId)) !== c.room.owner) c.close();
    }
  }

  // Open casual rooms everywhere.
  async list() {
    const all = await this.r.hgetall('rooms');
    const out = [];
    for (const id of Object.keys(all)) {
      const e = JSON.parse(all[id]);
      if (Date.now() - e.at > LIST_MS) this.r.hdel('rooms', id).catch(() => {});
      else out.push(e.room);
    }
    this.cache = out;
    return out;
  }

  close() {
    clearInterval(this._timer);
    this.saving.forEach((t) => clearTimeout(t));
    this.sub.disconnect();
    this.r.disconnect();
  }
}

module.exports = { Cluster };
