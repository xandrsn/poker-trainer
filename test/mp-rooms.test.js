'use strict';
// Room system tests: real ws clients against createServer() on an ephemeral port.
// Run alone: node test/mp-rooms.test.js
const assert = require('assert');
const path = require('path');
const WebSocket = require('ws');
const { createServer } = require(path.join(__dirname, '..', 'server.js'));
const { ID_CHARS, ID_LEN } = require(path.join(__dirname, '..', 'server', 'rooms.js'));

const FAST = { botDelay: [1, 3], actionMs: 20000, disconnectMs: 20000, nextHandMs: 5, disconnectGraceMs: 50,
  roomSweepMs: 20, roomPushMs: 40, roomEmptyMs: 150 };

let failures = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function until(fn, ms, label) {
  const end = Date.now() + (ms || 5000);
  for (;;) {
    let ok = false;
    try { ok = fn(); } catch (e) { ok = false; }
    if (ok) return;
    if (Date.now() > end) throw new Error('timed out waiting for ' + (label || fn.toString()));
    await new Promise((r) => setTimeout(r, 5));
  }
}

class Client {
  constructor(port) {
    this.port = port;
    this.msgs = [];
    this.closed = false;
    this.ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    this.ws.on('message', (raw, isBinary) => { if (!isBinary) this.msgs.push(JSON.parse(raw.toString())); });
    this.ws.on('close', () => { this.closed = true; });
  }
  open() {
    return new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  // Last message of a type (optionally matching pred), or null.
  last(t, pred) {
    for (let i = this.msgs.length - 1; i >= 0; i--) {
      const m = this.msgs[i];
      if (m.t === t && (!pred || pred(m))) return m;
    }
    return null;
  }
  errors() { return this.msgs.filter((m) => m.t === 'error').map((m) => m.msg); }
  get lobby() { return this.last('lobby'); }
  get state() { return this.last('state'); }
  close() { try { this.ws.close(); } catch (e) { /* closed */ } }
}

async function start(extra) {
  const timing = Object.assign({}, FAST, (extra && extra.timing) || {});
  const server = createServer(Object.assign({ seed: 7, timing, diagFile: false }, extra || {}, { timing }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const clients = [];
  return {
    server,
    manager: server.multiplayer.manager,
    port: server.address().port,
    async client() {
      const c = new Client(server.address().port);
      clients.push(c);
      await c.open();
      return c;
    },
    async stop() {
      clients.forEach((c) => c.close());
      server.multiplayer.close();
      await new Promise((r) => server.close(r));
    },
  };
}

// Creates a room with a fresh client; returns { client, id }.
async function createRoom(t, name) {
  const c = await t.client();
  c.send({ t: 'createRoom', name });
  await until(() => c.last('roomJoined'), 2000, 'roomJoined');
  return { client: c, id: c.last('roomJoined').id };
}

async function seat(client, name, extra) {
  const before = client.msgs.length;
  client.send(Object.assign({ t: 'join', name }, extra || {}));
  await until(() => client.msgs.slice(before).some((m) => m.t === 'welcome'), 2000, 'welcome ' + name);
  return client.msgs.slice(before).find((m) => m.t === 'welcome').you;
}

test('create a room: code, name sanitized, joined as host', async () => {
  const t = await start();
  try {
    const { client, id } = await createRoom(t, '  <b>Fun</b> & "games"  ');
    assert.strictEqual(id.length, ID_LEN);
    for (const ch of id) assert.ok(ID_CHARS.indexOf(ch) >= 0, 'alphabet: ' + ch);
    const entry = t.manager.entries.get(id);
    assert.strictEqual(entry.name, 'b Fun /b games');
    assert.ok(!/[<>&"]/.test(entry.name), 'no html characters');
    const named = await createRoom(t, '');
    assert.strictEqual(t.manager.entries.get(named.id).name, 'Room ' + named.id);
    const long = await createRoom(t, 'x'.repeat(60));
    assert.strictEqual(t.manager.entries.get(long.id).name.length, 24);
    client.close(); named.client.close(); long.client.close();
  } finally { await t.stop(); }
});

test('list: public rooms with the summary fields, pushed live to subscribers', async () => {
  const t = await start();
  try {
    const watcher = await t.client();
    watcher.send({ t: 'rooms' });
    await until(() => watcher.last('roomList'), 2000, 'roomList');
    assert.deepStrictEqual(watcher.last('roomList').rooms, []);
    const { client, id } = await createRoom(t, 'Table one');
    await seat(client, 'Ann');
    await until(() => {
      const l = watcher.last('roomList');
      return l && l.rooms.some((r) => r.id === id && r.players === 1);
    }, 2000, 'live list update');
    const r = watcher.last('roomList').rooms.find((x) => x.id === id);
    assert.strictEqual(r.name, 'Table one');
    assert.strictEqual(r.max, 6);
    assert.strictEqual(r.bots, 0);
    assert.strictEqual(r.status, 'lobby');
    assert.strictEqual(r.host, 'Ann');
    assert.deepStrictEqual(r.blinds, { sb: 500, bb: 1000 });
    assert.strictEqual(typeof r.createdAt, 'number');
    assert.strictEqual(r.isPublic, true);
    watcher.send({ t: 'unsubscribeRooms' });
    client.close(); watcher.close();
  } finally { await t.stop(); }
});

test('join: by code, errors for unknown room and a full room', async () => {
  const t = await start();
  try {
    const { client, id } = await createRoom(t, 'Full');
    const guest = await t.client();
    guest.send({ t: 'joinRoom', id: 'ZZZZZ' });
    await until(() => guest.errors().length, 2000, 'error');
    assert.strictEqual(guest.errors()[0], 'room not found');
    guest.send({ t: 'joinRoom', id: id.toLowerCase() });
    await until(() => guest.last('roomJoined'), 2000, 'joined');
    assert.strictEqual(guest.last('roomJoined').id, id);
    // Six humans seated; the seventh is refused.
    await seat(client, 'P1');
    const names = ['P2', 'P3', 'P4', 'P5', 'P6'];
    for (const n of names) {
      const c = n === 'P2' ? guest : await t.client();
      if (n !== 'P2') { c.send({ t: 'joinRoom', id }); await until(() => c.last('roomJoined'), 2000, 'join ' + n); }
      await seat(c, n);
    }
    const seventh = await t.client();
    seventh.send({ t: 'joinRoom', id });
    await until(() => seventh.errors().length, 2000, 'full');
    assert.strictEqual(seventh.errors()[0], 'room full');
    client.close(); guest.close(); seventh.close();
  } finally { await t.stop(); }
});

test('limits: max rooms refused, rate limit on createRoom per connection', async () => {
  const t = await start({ timing: { maxRooms: 2 } });
  try {
    await createRoom(t, 'A');
    await createRoom(t, 'B');
    const c = await t.client();
    c.send({ t: 'createRoom', name: 'C' });
    await until(() => c.errors().length, 2000, 'too many');
    assert.ok(/too many rooms/.test(c.errors()[0]), c.errors()[0]);
    c.send({ t: 'createRoom', name: 'C2' });
    await until(() => c.errors().length >= 2, 2000, 'slow down');
    assert.strictEqual(c.errors()[1], 'slow down');
    c.close();
  } finally { await t.stop(); }
});

test('isolation: chat and seats never leak between rooms', async () => {
  const t = await start();
  try {
    const a = await createRoom(t, 'A');
    const b = await createRoom(t, 'B');
    const ann = a.client, bob = b.client;
    await seat(ann, 'Ann');
    await seat(bob, 'Bob');
    ann.send({ t: 'chat', text: 'only in A' });
    await until(() => ann.last('chat', (m) => m.text === 'only in A'), 2000, 'own chat');
    bob.send({ t: 'chat', text: 'only in B' });
    await until(() => bob.last('chat', (m) => m.text === 'only in B'), 2000, 'bob chat');
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!bob.msgs.some((m) => m.text === 'only in A'), 'B never sees A chat');
    assert.ok(!ann.msgs.some((m) => m.text === 'only in B'), 'A never sees B chat');
    const lobbyA = ann.last('lobby');
    assert.strictEqual(lobbyA.players.length, 1);
    assert.strictEqual(lobbyA.players[0].name, 'Ann');
    // Settings in A do not touch B.
    ann.send({ t: 'settings', bb: 2000, sb: 1000 });
    await until(() => ann.last('lobby', (m) => m.settings.bb === 2000), 2000, 'A settings');
    assert.strictEqual(t.manager.get(a.id).settings.bb, 2000);
    assert.strictEqual(t.manager.get(b.id).settings.bb, 1000);
    // A chat history of B does not contain A's message either.
    const late = await t.client();
    late.send({ t: 'joinRoom', id: b.id });
    await until(() => late.last('roomJoined'), 2000, 'late join');
    await seat(late, 'Late');
    assert.ok(late.last('chatHistory').messages.every((m) => m.text !== 'only in A'));
    ann.close(); bob.close(); late.close();
  } finally { await t.stop(); }
});

test('empty room is destroyed after the grace; a room with a player is kept', async () => {
  const t = await start();
  try {
    const gone = await createRoom(t, 'Gone');
    const kept = await createRoom(t, 'Kept');
    gone.client.close();
    await until(() => !t.manager.entries.has(gone.id), 3000, 'empty room removed');
    assert.ok(t.manager.entries.has(kept.id), 'occupied room kept');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(t.manager.entries.has(kept.id), 'still kept after the grace');
    kept.client.close();
  } finally { await t.stop(); }
});

test('reconnect with the seat token restores the client into its room', async () => {
  const t = await start();
  try {
    const { client, id } = await createRoom(t, 'Back');
    const you = await seat(client, 'Ann', { clientId: 'ann-client-id-1234' });
    client.close();
    await new Promise((r) => setTimeout(r, 20));
    const again = await t.client();
    again.send({ t: 'joinRoom', id });
    await until(() => again.last('roomJoined'), 2000, 'rejoin room');
    const back = await seat(again, 'Ann', { clientId: 'ann-client-id-1234', token: you.token });
    assert.strictEqual(back.seat, you.seat, 'same seat');
    assert.strictEqual(back.token, you.token, 'same token');
    again.close();
  } finally { await t.stop(); }
});

test('host kick and leave work inside one room only', async () => {
  const t = await start();
  try {
    const a = await createRoom(t, 'Kick');
    const b = await createRoom(t, 'Other');
    const host = a.client;
    const guest = await t.client();
    guest.send({ t: 'joinRoom', id: a.id });
    await until(() => guest.last('roomJoined'), 2000, 'guest joined');
    await seat(host, 'Host');
    const g = await seat(guest, 'Guest');
    host.send({ t: 'kick', seat: g.seat });
    await until(() => guest.closed || guest.errors().some((e) => /removed/.test(e)), 2000, 'guest kicked');
    assert.ok(t.manager.get(b.id).recs.every((r) => !r), 'room B has no seats');
    assert.strictEqual(t.manager.get(a.id).recs.filter(Boolean).length, 1, 'room A keeps only the host');
    // A leaves room A: back to the room list, not in any room.
    const leaver = await t.client();
    leaver.send({ t: 'joinRoom', id: b.id });
    await until(() => leaver.last('roomJoined'), 2000, 'leaver joined');
    leaver.send({ t: 'leaveRoom' });
    await until(() => leaver.last('roomLeft'), 2000, 'left');
    leaver.send({ t: 'chat', text: 'hi' });
    await until(() => leaver.errors().length, 2000, 'no room');
    assert.strictEqual(leaver.errors()[0], 'join first');
    leaver.send({ t: 'createRoom', name: 'After leave' });
    await until(() => leaver.msgs.filter((m) => m.t === 'roomJoined').length >= 2, 2000, 'can create after leave');
    host.close(); guest.close(); leaver.close();
  } finally { await t.stop(); }
});

test('late join: a newcomer during a running hand waits for the next deal; late-stack modes', async () => {
  const t = await start({ timing: { botDelay: [1, 3], actionMs: 20000, disconnectMs: 20000, nextHandMs: 60000, disconnectGraceMs: 50, roomSweepMs: 20, roomPushMs: 40, roomEmptyMs: 150 } });
  try {
    const { client: ann, id } = await createRoom(t, 'Late');
    const ben = await t.client();
    ben.send({ t: 'joinRoom', id });
    await until(() => ben.last('roomJoined'), 2000, 'ben joined');
    await seat(ann, 'Ann');
    await seat(ben, 'Ben');
    ann.send({ t: 'start' });
    await until(() => ann.state && ann.state.hand && !ann.state.hand.over, 3000, 'hand running');
    const room = t.manager.get(id);
    const startStack = room.settings.stack;
    // Default mode: the newcomer takes the starting stack, waits, and sees no cards.
    const carol = await t.client();
    carol.send({ t: 'joinRoom', id });
    await until(() => carol.last('roomJoined'), 2000, 'carol joined');
    const cy = await seat(carol, 'Carol');
    await until(() => carol.lobby && carol.lobby.players.some((p) => p.name === 'Carol'), 2000, 'carol in lobby');
    const cp = carol.lobby.players.find((p) => p.name === 'Carol');
    assert.strictEqual(cp.waiting, true, 'waits for the next hand');
    assert.strictEqual(cp.stack, startStack, 'starting stack by default');
    assert.ok(!carol.state || !carol.state.hand || carol.state.hand.youCards.length === 0, 'no cards mid-hand');
    assert.ok(cy.seat >= 0);
    const chipsBefore = room.netChips;
    // Half the starting stack (on the 0.5 BB grid).
    ann.send({ t: 'settings', lateStack: 'half' });
    await until(() => ann.lobby && ann.lobby.settings.lateStack === 'half', 2000, 'half set');
    const dave = await t.client();
    dave.send({ t: 'joinRoom', id });
    await until(() => dave.last('roomJoined'), 2000, 'dave joined');
    await seat(dave, 'Dave');
    await until(() => dave.lobby && dave.lobby.players.some((p) => p.name === 'Dave'), 2000, 'dave in lobby');
    assert.strictEqual(dave.lobby.players.find((p) => p.name === 'Dave').stack, startStack / 2, 'half stack');
    assert.strictEqual(room.netChips - chipsBefore, startStack / 2, 'new chips are the buy-in (ledger)');
    // Fixed amount in BB, and invalid values refused.
    ann.send({ t: 'settings', lateStack: 'fixed', lateFixedBB: 12.5 });
    await until(() => ann.lobby && ann.lobby.settings.lateFixedBB === 12.5, 2000, 'fixed set');
    ann.send({ t: 'settings', lateStack: 'fixed', lateFixedBB: 4 });
    await until(() => ann.errors().length, 2000, 'bad fixed');
    assert.ok(/late fixed stack|5 to 1000 BB/.test(ann.errors()[ann.errors().length - 1]));
    const eve = await t.client();
    eve.send({ t: 'joinRoom', id });
    await until(() => eve.last('roomJoined'), 2000, 'eve joined');
    await seat(eve, 'Eve');
    await until(() => eve.lobby && eve.lobby.players.some((p) => p.name === 'Eve'), 2000, 'eve in lobby');
    assert.strictEqual(eve.lobby.players.find((p) => p.name === 'Eve').stack, 12.5 * room.settings.bb, 'fixed 12.5 BB');
    // Average of the others, rounded to the nearest half big blind.
    ann.send({ t: 'settings', lateStack: 'avg' });
    await until(() => ann.lobby && ann.lobby.settings.lateStack === 'avg', 2000, 'avg set');
    const fay = await t.client();
    fay.send({ t: 'joinRoom', id });
    await until(() => fay.last('roomJoined'), 2000, 'fay joined');
    await seat(fay, 'Fay');
    await until(() => fay.lobby && fay.lobby.players.some((p) => p.name === 'Fay'), 2000, 'fay in lobby');
    const fp = fay.lobby.players.find((p) => p.name === 'Fay').stack;
    assert.strictEqual(fp % (room.settings.bb / 2), 0, 'on the half-BB grid');
    [ann, ben, carol, dave, eve, fay].forEach((c) => c.close());
  } finally { await t.stop(); }
});

test('names are unique: a taken name is refused case-insensitively, with a suggestion', async () => {
  const t = await start();
  try {
    const a = await createRoom(t, 'Mesa de Ana');
    // roomNameCheck: free, taken (any case, extra spaces), empty.
    const c = await t.client();
    c.send({ t: 'roomNameCheck', name: 'Mesa Nueva' });
    await until(() => c.last('roomNameCheck', (m) => m.name === 'Mesa Nueva'), 2000, 'free check');
    assert.strictEqual(c.last('roomNameCheck', (m) => m.name === 'Mesa Nueva').ok, true);
    c.send({ t: 'roomNameCheck', name: '  mesa   DE ana ' });
    await until(() => c.last('roomNameCheck', (m) => m.name === '  mesa   DE ana '), 2000, 'taken check');
    const taken = c.last('roomNameCheck', (m) => m.name === '  mesa   DE ana ');
    assert.strictEqual(taken.ok, false);
    assert.strictEqual(taken.reason, 'taken');
    assert.strictEqual(taken.suggest, 'mesa DE ana 2', 'suggests the next free name, in the typed casing');
    c.send({ t: 'roomNameCheck', name: '   ' });
    await until(() => c.last('roomNameCheck', (m) => m.name === '   '), 2000, 'empty check');
    assert.strictEqual(c.last('roomNameCheck', (m) => m.name === '   ').ok, false);
    // createRoom refuses the same name (any case) with an error and no room.
    const before = t.manager.entries.size;
    c.send({ t: 'createRoom', name: 'MESA DE ANA' });
    await until(() => c.last('error', (m) => m.msg === 'name taken'), 2000, 'name taken error');
    assert.strictEqual(c.last('error', (m) => m.msg === 'name taken').suggest, 'MESA DE ANA 2');
    assert.strictEqual(t.manager.entries.size, before, 'no room was created');
    assert.ok(!c.last('roomJoined'), 'not joined');
    // A free name still works after the refusal (the rate gap is per connection: use a new client).
    const d = await t.client();
    d.send({ t: 'createRoom', name: 'Mesa de Ana 2' });
    await until(() => d.last('roomJoined'), 2000, 'free name created');
    a.client.close(); c.close(); d.close();
  } finally { await t.stop(); }
});

test('settings at creation: the create panel settings are applied to the room', async () => {
  const t = await start();
  try {
    const c = await t.client();
    c.send({ t: 'createRoom', name: 'Ajustes', settings: { stack: 50000, sb: 500, bb: 1000, blindUpMin: 5, lateStack: 'half', lateFixedBB: 20, spectatorCards: 'off' } });
    await until(() => c.last('roomJoined'), 2000, 'joined');
    const room = t.manager.get(c.last('roomJoined').id);
    assert.strictEqual(room.settings.stack, 50000);
    assert.strictEqual(room.settings.bb, 1000);
    assert.strictEqual(room.settings.blindUpMin, 5);
    assert.strictEqual(room.settings.lateStack, 'half');
    assert.strictEqual(room.settings.spectatorCards, 'off');
    // Same rules as the host settings: a stack outside 5-1000 BB is refused and no room is left behind.
    const d = await t.client();
    const before = t.manager.entries.size;
    d.send({ t: 'createRoom', name: 'Demasiado', settings: { stack: 2000, sb: 500, bb: 1000 } });
    await until(() => d.last('error'), 2000, 'bad stack error');
    assert.ok(/5 to 1000 BB/.test(d.last('error').msg), d.last('error').msg);
    assert.strictEqual(t.manager.entries.size, before, 'refused room is not kept');
    c.close(); d.close();
  } finally { await t.stop(); }
});

(async () => {
  console.log('Poker Trainer room tests');
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log('  ok   ' + name);
    } catch (e) {
      failures += 1;
      console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e));
    }
  }
  console.log(failures ? '\n' + failures + ' test(s) failed' : '\nall room tests passed');
  process.exit(failures ? 1 : 0);
})();
