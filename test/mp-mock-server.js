'use strict';
// Development stand-in for the multiplayer server, used until server/ and the `ws` package exist.
// It speaks the MP_PROTOCOL.md messages loosely: lobby, bots as placeholders, a fake hand, and the
// rtc relay. It is NOT a poker engine and nothing here ships to the browser.
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const STYLES = require('../public/ladder.js').LADDER.map((b) => b.id);

function encodeText(text) {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const head = Buffer.alloc(4);
  head[0] = 0x81; head[1] = 126; head.writeUInt16BE(payload.length, 2);
  return Buffer.concat([head, payload]);
}

// Client frames are masked; server frames are not. Returns the bytes not yet forming a frame.
function readFrames(buf, onFrame) {
  let off = 0;
  while (buf.length - off >= 2) {
    const op = buf[off] & 0x0f;
    const masked = (buf[off + 1] & 0x80) !== 0;
    let len = buf[off + 1] & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length < p + 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    }
    let mask = null;
    if (masked) {
      if (buf.length < p + 4) break;
      mask = buf.subarray(p, p + 4);
      p += 4;
    }
    if (buf.length < p + len) break;
    const data = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    onFrame(op, data);
    off = p + len;
  }
  return buf.subarray(off);
}

function encodeMaskedText(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  let head;
  if (payload.length < 126) {
    head = Buffer.from([0x81, 0x80 | payload.length]);
  } else {
    head = Buffer.alloc(4);
    head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2);
  }
  const body = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([head, mask, body]);
}

function startMockServer(port) {
  const sockets = new Map();   // clientId -> socket
  const players = [];          // { seat, clientId, name, bot, style, connected, host, camera }
  const settings = { stack: 100000, sb: 500, bb: 1000, randomness: 15, personalities: true };
  let hand = null;
  let paused = false;
  let handNo = 0;
  let idSeq = 0;

  const server = http.createServer((req, res) => { res.writeHead(404).end(); });

  function sendRaw(sock, obj) {
    if (sock && !sock.destroyed) sock.write(encodeText(JSON.stringify(obj)));
  }
  function sendToId(id, obj) { sendRaw(sockets.get(id), obj); }
  function byId(id) { return players.find((p) => p.clientId === id) || null; }
  function freeSeat() {
    for (let s = 0; s < 9; s++) if (!players.some((p) => p.seat === s)) return s;
    return null;
  }
  function publicPlayers() {
    return players.slice().sort((a, b) => a.seat - b.seat).map((p) => ({
      seat: p.seat,
      clientId: p.bot ? undefined : p.clientId,
      name: p.name,
      bot: p.bot,
      style: p.style,
      connected: p.bot ? true : !!p.connected,
      host: !!p.host,
      camera: !!p.camera,
      avatar: p.avatar,
      stack: p.stack
    }));
  }
  function broadcastPeers() {
    const ids = [...sockets.keys()];
    for (const id of ids) sendToId(id, { t: 'peers', ids });
  }
  function broadcastLobby() {
    const msg = { t: 'lobby', players: publicPlayers(), settings: { ...settings }, paused };
    for (const id of sockets.keys()) sendToId(id, msg);
    broadcastPeers();
  }

  function stateFor(id) {
    const p = byId(id);
    const hero = p ? p.seat : null;
    const mine = hand && hand.seats.find((s) => s.seat === hero);
    return {
      id: hand.id,
      street: hand.street,
      pot: hand.pot,
      board: hand.board,
      dealer: hand.dealer,
      toAct: hand.toAct,
      toCall: hand.toCall,
      minRaise: hand.bb,
      seats: hand.seats.map((s) => ({
        seat: s.seat, name: s.name, bot: s.bot, style: s.style, stack: s.stack, bet: s.bet,
        folded: s.folded, allIn: false, lastAction: s.lastAction,
        cards: hand.revealed && !s.folded ? s.cards : null
      })),
      youCards: mine ? mine.cards : undefined,
      legal: hand.toAct != null && hand.toAct === hero
        ? { fold: true, call: true, raise: true, minRaiseTo: hand.bb * 2, maxRaiseTo: settings.stack }
        : undefined,
      winners: hand.winners
    };
  }
  function broadcastState() {
    if (!hand) return;
    for (const id of sockets.keys()) sendToId(id, { t: 'state', hand: stateFor(id) });
  }

  function startHand() {
    handNo += 1;
    const seats = players.slice().sort((a, b) => a.seat - b.seat).map((p) => ({
      seat: p.seat, name: p.name, bot: p.bot, style: p.style, stack: settings.stack, bet: 0,
      folded: false, cards: ['As', 'Kd'], lastAction: null
    }));
    const firstHuman = seats.find((s) => !s.bot);
    hand = {
      id: handNo, street: 'preflop', pot: settings.sb + settings.bb, board: [],
      dealer: seats[0].seat, toAct: firstHuman ? firstHuman.seat : null,
      toCall: settings.bb, bb: settings.bb, seats, revealed: false, winners: undefined
    };
  }

  function finishHand(seat) {
    hand.toAct = null;
    hand.revealed = true;
    hand.winners = [{ seat, amount: hand.pot, hand: 'High card' }];
    broadcastState();
    const t = setTimeout(() => {
      if (players.length) { startHand(); broadcastState(); broadcastLobby(); }
    }, 1500);
    t.unref();
  }

  function isHost(ctx) {
    const p = ctx.clientId && byId(ctx.clientId);
    return !!(p && p.host);
  }

  function handle(sock, ctx, msg) {
    switch (msg.t) {
      case 'join': {
        const name = typeof msg.name === 'string' ? msg.name.trim() : '';
        if (!name || name.length > 16) return sendRaw(sock, { t: 'error', msg: 'Name must be 1 to 16 characters' });
        let p = msg.clientId ? byId(msg.clientId) : null;
        if (!p) {
          const seat = freeSeat();
          if (seat === null) return sendRaw(sock, { t: 'error', msg: 'The table is full' });
          p = {
            seat, clientId: 'c' + (++idSeq) + crypto.randomBytes(3).toString('hex'), name, bot: false,
            connected: true, host: !players.some((q) => !q.bot), camera: false
          };
          players.push(p);
        }
        p.name = name;
        p.connected = true;
        sockets.set(p.clientId, sock);
        ctx.clientId = p.clientId;
        sendRaw(sock, { t: 'welcome', you: { clientId: p.clientId, seat: p.seat, name: p.name, host: !!p.host }, settings: { ...settings } });
        broadcastLobby();
        if (hand) sendRaw(sock, { t: 'state', hand: stateFor(p.clientId) });
        return undefined;
      }
      case 'addBot': {
        if (!isHost(ctx)) return sendRaw(sock, { t: 'error', msg: 'Only the host can do that' });
        const seat = freeSeat();
        if (seat === null) return sendRaw(sock, { t: 'error', msg: 'The table is full' });
        const style = STYLES.includes(msg.style) ? msg.style : 'lv1';
        const name = typeof msg.name === 'string' && msg.name.trim() ? msg.name.trim().slice(0, 16) : 'CPU ' + (seat + 1);
        players.push({ seat, bot: true, style, name, connected: true, host: false });
        return broadcastLobby();
      }
      case 'removeBot': {
        if (!isHost(ctx)) return sendRaw(sock, { t: 'error', msg: 'Only the host can do that' });
        const i = players.findIndex((p) => p.bot && p.seat === msg.seat);
        if (i >= 0) players.splice(i, 1);
        return broadcastLobby();
      }
      case 'kick': {
        if (!isHost(ctx)) return sendRaw(sock, { t: 'error', msg: 'Only the host can do that' });
        const p = players.find((q) => !q.bot && q.seat === msg.seat && q.clientId !== ctx.clientId);
        if (!p) return undefined;
        players.splice(players.indexOf(p), 1);
        const victim = sockets.get(p.clientId);
        sockets.delete(p.clientId);
        if (victim) victim.end();
        return broadcastLobby();
      }
      case 'settings': {
        if (!isHost(ctx)) return sendRaw(sock, { t: 'error', msg: 'Only the host can do that' });
        const stack = Number(msg.stack);
        if (!Number.isInteger(stack) || stack < 2000) return sendRaw(sock, { t: 'error', msg: 'Invalid stack' });
        Object.assign(settings, { stack, randomness: Number(msg.randomness) || 0, personalities: !!msg.personalities });
        return broadcastLobby();
      }
      case 'start': {
        if (!isHost(ctx)) return sendRaw(sock, { t: 'error', msg: 'Only the host can do that' });
        if (players.length < 2) return sendRaw(sock, { t: 'error', msg: 'Need at least 2 players' });
        if (!hand) startHand();
        broadcastState();
        return broadcastLobby();
      }
      case 'act': {
        const p = byId(ctx.clientId);
        if (!p || !hand || hand.toAct !== p.seat) return sendRaw(sock, { t: 'error', msg: 'Not your turn' });
        if (!['fold', 'call', 'raise'].includes(msg.action)) return sendRaw(sock, { t: 'error', msg: 'Unknown action' });
        if (msg.action === 'raise') {
          const amt = Number(msg.amount);
          if (!(amt >= hand.bb * 2 && amt <= settings.stack)) return sendRaw(sock, { t: 'error', msg: 'Illegal raise' });
        }
        return finishHand(p.seat);
      }
      case 'rtc': {
        if (ctx.clientId && sockets.has(msg.to)) sendToId(msg.to, { t: 'rtc', from: ctx.clientId, data: msg.data });
        return undefined;
      }
      case 'profile': {
        const p = byId(ctx.clientId);
        if (!p) return undefined;
        const name = typeof msg.name === 'string' ? msg.name.trim().slice(0, 16) : '';
        if (name) p.name = name;
        p.avatar = typeof msg.avatar === 'string' && msg.avatar.startsWith('data:image/jpeg') ? msg.avatar : undefined;
        return broadcastLobby();
      }
      case 'editBot': {
        if (!isHost(ctx)) return sendRaw(sock, { t: 'error', msg: 'Only the host can do that' });
        const b = players.find((q) => q.bot && q.seat === msg.seat);
        if (!b) return undefined;
        if (typeof msg.name === 'string' && msg.name.trim()) b.name = msg.name.trim().slice(0, 16);
        if (STYLES.includes(msg.style)) b.style = msg.style;
        b.avatar = typeof msg.avatar === 'string' ? msg.avatar : undefined;
        return broadcastLobby();
      }
      case 'setStack': {
        if (!isHost(ctx) || hand) return sendRaw(sock, { t: 'error', msg: 'Wait until the hand ends' });
        const q = players.find((x) => x.seat === msg.seat);
        if (q && Number.isInteger(msg.stack)) q.stack = msg.stack;
        return broadcastLobby();
      }
      case 'pause':
      case 'resume': {
        if (!isHost(ctx)) return sendRaw(sock, { t: 'error', msg: 'Only the host can do that' });
        paused = msg.t === 'pause';
        return broadcastLobby();
      }
      case 'endGame': {
        if (!isHost(ctx)) return sendRaw(sock, { t: 'error', msg: 'Only the host can do that' });
        const standings = publicPlayers().map((p) => ({ seat: p.seat, name: p.name, stack: p.stack != null ? p.stack : settings.stack, avatar: p.avatar }));
        hand = null;
        for (const id of sockets.keys()) sendToId(id, { t: 'gameOver', standings });
        return broadcastLobby();
      }
      case 'ping':
        return sendRaw(sock, { t: 'pong' });
      default:
        return undefined;
    }
  }

  server.on('upgrade', (req, sock) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const ctx = { clientId: null };
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = readFrames(Buffer.concat([buf, d]), (op, data) => {
        if (op === 8) return sock.end();
        if (op !== 1) return undefined;
        let msg;
        try { msg = JSON.parse(data.toString('utf8')); } catch (e) { return undefined; }
        return handle(sock, ctx, msg);
      });
    });
    sock.on('close', () => {
      if (!ctx.clientId || sockets.get(ctx.clientId) !== sock) return;
      sockets.delete(ctx.clientId);
      const p = byId(ctx.clientId);
      if (p) p.connected = false;
      broadcastLobby();
    });
    sock.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(port || 0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => {
          for (const s of sockets.values()) s.destroy();
          server.close();
        }
      });
    });
  });
}

// Minimal WebSocket client for tests. Resolves once the handshake succeeds.
function connectWs(port, path) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(port, '127.0.0.1');
    const inbox = [];
    let buf = Buffer.alloc(0);
    let up = false;
    const api = {
      inbox,
      send(obj) { sock.write(encodeMaskedText(JSON.stringify(obj))); },
      close() { sock.destroy(); },
      // Waits for the last message matching pred (default: any). Polls the inbox.
      waitFor(pred, ms) {
        const test = pred || (() => true);
        const limit = Date.now() + (ms || 3000);
        return new Promise((res, rej) => {
          (function poll() {
            const hit = inbox.filter(test).pop();
            if (hit) return res(hit);
            if (Date.now() > limit) return rej(new Error('timed out waiting for message'));
            setTimeout(poll, 10);
          })();
        });
      }
    };
    sock.on('error', (e) => { if (!up) reject(e); });
    sock.on('connect', () => {
      sock.write('GET ' + (path || '/ws') + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!up) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        if (!buf.toString('latin1', 0, i).startsWith('HTTP/1.1 101')) return reject(new Error('handshake failed'));
        buf = buf.subarray(i + 4);
        up = true;
        resolve(api);
      }
      buf = readFrames(buf, (op, data) => {
        if (op === 1) inbox.push(JSON.parse(data.toString('utf8')));
      });
    });
  });
}

module.exports = { startMockServer, connectWs };
