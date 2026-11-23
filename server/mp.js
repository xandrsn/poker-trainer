'use strict';
/* WebSocket transport for multiplayer: attaches a WebSocketServer on path /ws to an existing HTTP
 * server and routes JSON messages. Rooms: a connection starts with no room (room-list screen).
 *   {t:'rooms'} -> {t:'roomList', rooms}; pushed every 2 s to the connections that asked.
 *   {t:'roomNameCheck', name} -> {t:'roomNameCheck', name, ok, reason, suggest?} (name free or taken)
 *   {t:'createRoom', name?, settings?} -> {t:'roomJoined', id}; or {t:'error', msg:'name taken', suggest}
 *   {t:'joinRoom', id} -> {t:'roomJoined', id}
 *   {t:'leaveRoom'} -> {t:'roomLeft'}. Every other message goes to the connection's room (server/room.js).
 * A direct {t:'join'} without a room goes to the default room (hidden from the list, legacy).
 * See MP_PROTOCOL.md.
 *
 * Binary frames are media relayed for clients whose WebRTC link failed (see MP_PROTOCOL.md):
 *   client -> server: [type u8][payload]     type 1 = JPEG video frame, 2 = mu-law audio chunk
 *   server -> others: [type u8][sender seat u8][payload]
 * Nothing is stored. Each client has a byte budget (RELAY_BYTES_PER_S) and a frame is dropped
 * when the receiving socket is backed up (bufferedAmount above RELAY_BACKLOG). */
const { WebSocketServer } = require('ws');
const { RoomManager, CREATE_GAP_MS, MAX_NAME, roomKey } = require('./rooms.js');
// Host settings the create panel may send with createRoom (checked by server/room.js _settings).
const CREATE_SETTINGS = ['stack', 'sb', 'bb', 'blindUpMin', 'spectatorCards', 'lateStack', 'lateFixedBB'];

// JSON: a 64 KB avatar travels as ~88 KB of base64 inside JSON, so JSON may be up to 256 KB.
const MAX_JSON = 256 * 1024;
// ws-level ceiling, above MAX_JSON so an oversize JSON frame gets the app-level 'message too large'
// error instead of a 1009 close. Relayed media frames are still capped at RELAY_FRAME_MAX.
const MAX_PAYLOAD = 512 * 1024;
const RELAY_FRAME_MAX = 128 * 1024;  // one relayed media frame
const RELAY_BYTES_PER_S = 150 * 1000; // ~1.2 Mbps per sender (1.2e6 / 8)
const RELAY_BURST = 512 * 1024;
const RELAY_BACKLOG = 64 * 1024;     // game JSON must not wait behind queued video
const WS_PING_MS = 25000;            // ws-level ping frames; a socket missing 2 pongs is terminated
const MEDIA_TYPES = new Set([1, 2, 3, 4]); // 1-2 JPEG video / PCM audio, 3 WebCodecs video, 4 Opus audio
const MAX_HUMANS_PER_ROOM = 6;

// opts: { seed?, timing? } as for Room; { room } reuses a Room as the default room; { manager } reuses a RoomManager.
function attachMultiplayer(httpServer, opts) {
  const manager = (opts && opts.manager) || new RoomManager(opts || {});
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: MAX_PAYLOAD });
  const stats = { relayIn: 0, relayOut: 0, relayDropped: 0, relayBytesIn: 0, relayBytesOut: 0 };
  const pingMs = (opts && opts.timing && opts.timing.wsPingMs) || WS_PING_MS;
  const pinger = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.missed >= 2) { ws.terminate(); return; }
      ws.missed = (ws.missed || 0) + 1;
      try { ws.ping(); } catch (e) { /* closing */ }
    });
  }, pingMs);
  pinger.unref();

  function relay(conn, data) {
    const room = conn.room;
    const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!room || conn.seat == null || frame.length < 2 || frame.length > RELAY_FRAME_MAX || !MEDIA_TYPES.has(frame[0])) {
      stats.relayDropped += 1;
      return;
    }
    const now = Date.now();
    conn.budget = Math.min(RELAY_BURST, (conn.budget == null ? RELAY_BURST : conn.budget) +
      (now - (conn.budgetAt || now)) * RELAY_BYTES_PER_S / 1000);
    conn.budgetAt = now;
    if (conn.budget < frame.length) {
      stats.relayDropped += 1;
      return;
    }
    conn.budget -= frame.length;
    stats.relayIn += 1;
    stats.relayBytesIn += frame.length;
    const out = Buffer.allocUnsafe(frame.length + 1);
    out[0] = frame[0];
    out[1] = conn.seat;
    frame.copy(out, 2, 1);
    for (const other of room.conns) {
      if (other === conn || other.seat == null || !other.ws || other.ws.readyState !== other.ws.OPEN) continue;
      if (other.ws.bufferedAmount > RELAY_BACKLOG) { stats.relayDropped += 1; continue; }
      other.ws.send(out, { binary: true });
      stats.relayOut += 1;
      stats.relayBytesOut += out.length;
    }
  }

  // Room-list and room membership messages. Returns true when handled here.
  function onRoomMsg(conn, msg) {
    switch (msg.t) {
      case 'rooms':
        manager.subscribers.add(conn);
        conn.send({ t: 'roomList', rooms: manager.list() });
        return true;
      case 'unsubscribeRooms':
        manager.subscribers.delete(conn);
        return true;
      case 'roomNameCheck': {
        // Live check while the create panel is typed in: ok when no other room has this name.
        const name = typeof msg.name === 'string' ? msg.name : '';
        const key = roomKey(name);
        const taken = !!key && manager.nameTaken(name);
        const reply = { t: 'roomNameCheck', name, ok: !!key && !taken, reason: !key ? 'empty' : taken ? 'taken' : null };
        if (taken) reply.suggest = manager.suggestName(name);
        conn.send(reply);
        return true;
      }
      case 'createRoom': {
        if (conn.room) throw new Error('leave the room first');
        const now = Date.now();
        if (conn.lastCreate && now - conn.lastCreate < CREATE_GAP_MS) throw new Error('slow down');
        if (msg.name !== undefined && msg.name !== null && typeof msg.name !== 'string') throw new Error('name must be a string');
        if (typeof msg.name === 'string' && msg.name.length > 200) throw new Error('name is too long (max ' + MAX_NAME + ')');
        // Table names are unique (case-insensitive): refuse with a free alternative to offer.
        if (manager.nameTaken(msg.name)) {
          conn.send({ t: 'error', msg: 'name taken', suggest: manager.suggestName(msg.name) });
          return true;
        }
        conn.lastCreate = now;
        // Settings from the create panel (any subset of the host settings); unset ones keep the defaults.
        let settings;
        if (msg.settings !== undefined && msg.settings !== null) {
          if (typeof msg.settings !== 'object' || Array.isArray(msg.settings)) throw new Error('settings must be an object');
          settings = {};
          CREATE_SETTINGS.forEach((k) => { if (msg.settings[k] !== undefined) settings[k] = msg.settings[k]; });
        }
        const entry = manager.create(msg.name, now, settings);
        manager.attach(conn, entry.room);
        conn.send({ t: 'roomJoined', id: entry.id });
        return true;
      }
      case 'joinRoom': {
        if (conn.room) {
          if (conn.room.roomId === msg.id) { conn.send({ t: 'roomJoined', id: msg.id }); return true; }
          throw new Error('leave the room first');
        }
        const room = typeof msg.id === 'string' ? manager.get(msg.id.toUpperCase()) : null;
        if (!room) throw new Error('room not found');
        if (room._humanCount() >= MAX_HUMANS_PER_ROOM) throw new Error('room full');
        manager.attach(conn, room);
        conn.send({ t: 'roomJoined', id: room.roomId });
        return true;
      }
      case 'leaveRoom':
        manager.detach(conn);
        conn.send({ t: 'roomLeft' });
        return true;
    }
    return false;
  }

  wss.on('connection', (ws) => {
    const conn = {
      ws,
      room: null,
      seat: null,
      clientId: null,
      send(obj) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
      },
      close() {
        ws.close();
      },
    };
    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        relay(conn, raw);
        return;
      }
      if (raw.length > MAX_JSON) {
        conn.send({ t: 'error', msg: 'message too large' });
        return;
      }
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        conn.send({ t: 'error', msg: 'bad json' });
        return;
      }
      if (msg && msg.t === 'ping') { conn.send({ t: 'pong', ts: msg.ts, sv: Date.now() }); return; }
      try {
        if (msg && typeof msg === 'object' && onRoomMsg(conn, msg)) return;
      } catch (e) {
        conn.send({ t: 'error', msg: e.message });
        return;
      }
      if (!conn.room) {
        // Legacy direct join: the default (hidden) room.
        if (msg && msg.t === 'join') manager.attach(conn, manager.defaultRoom);
        else { conn.send({ t: 'error', msg: 'join first' }); return; }
      }
      conn.room.receive(conn, msg);
    });
    ws.missed = 0;
    ws.on('pong', () => { ws.missed = 0; });
    ws.on('close', () => {
      manager.subscribers.delete(conn);
      manager.detach(conn);
    });
    ws.on('error', () => {}); // a failed socket is followed by 'close'
  });

  return {
    room: manager.defaultRoom,
    manager,
    wss,
    stats,
    close() {
      clearInterval(pinger);
      wss.clients.forEach((ws) => ws.terminate());
      wss.close();
      manager.close();
    },
  };
}

module.exports = { attachMultiplayer, MAX_JSON, MAX_PAYLOAD, RELAY_FRAME_MAX, RELAY_BYTES_PER_S, RELAY_BURST, RELAY_BACKLOG };
