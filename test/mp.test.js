'use strict';
// Multiplayer server tests: real ws clients against createServer() on an ephemeral port.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const { createServer, createHttpsServer, loadCerts } = require(path.join(__dirname, '..', 'server.js'));
const { Room } = require(path.join(__dirname, '..', 'server', 'room.js'));

const FAST = { botDelay: [1, 3], actionMs: 20000, disconnectMs: 20000, nextHandMs: 5, disconnectGraceMs: 50 };
const SLOW = { botDelay: [1, 3], actionMs: 60000, disconnectMs: 60000, nextHandMs: 60000, disconnectGraceMs: 50 };

let failures = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function rngFrom(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

async function until(fn, ms, label) {
  const end = Date.now() + (ms || 10000);
  for (;;) {
    let ok = false;
    try { ok = fn(); } catch (e) { ok = false; }
    if (ok) return;
    if (Date.now() > end) throw new Error('timed out waiting for ' + (label || fn.toString()));
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function start(opts) {
  const server = createServer(Object.assign({ seed: 7, timing: FAST }, opts || {}));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    server,
    port: server.address().port,
    room: server.multiplayer.room,
    async stop() {
      server.multiplayer.close();
      await new Promise((r) => server.close(r));
    },
  };
}

// A test client: records every message; listeners get (parsed, rawText).
class Client {
  constructor(port) {
    this.port = port;
    this.msgs = [];
    this.binary = [];
    this.errors = [];
    this.errors = [];
    this.rtc = [];
    this.listeners = [];
    this.welcome = null;
    this.lobby = null;
    this.state = null;
    this.peers = null;
    this.seat = null;
    this.clientId = null;
    this.closed = false;
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket('ws://127.0.0.1:' + this.port + '/ws');
      this.ws.on('open', () => resolve(this));
      this.ws.on('error', reject);
      this.ws.on('message', (raw, isBinary) => {
        if (isBinary) this.binary.push(Buffer.from(raw));
        else this._on(raw.toString());
      });
      this.ws.on('close', () => { this.closed = true; });
    });
  }
  _on(text) {
    const m = JSON.parse(text);
    this.msgs.push(m);
    if (m.t === 'welcome') { this.welcome = m; this.seat = m.you.seat; this.clientId = m.you.clientId; }
    if (m.t === 'lobby') this.lobby = m;
    if (m.t === 'state') this.state = m;
    if (m.t === 'peers') this.peers = m;
    if (m.t === 'rtc') this.rtc.push(m);
    if (m.t === 'error') this.errors.push(m.msg);
    if (m.t === 'kicked') this.kicked = m;
    this.listeners.forEach((fn) => fn(m, text));
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  close() { this.ws.close(); }
}

// A seat is reclaimed only with the secret token from its welcome (the clientId is public).
const SEAT_TOKENS = new Map();
async function connect(port, name, clientId) {
  const c = await new Client(port).open();
  c.send(Object.assign({ t: 'join', name: name }, clientId ? { clientId: clientId, token: SEAT_TOKENS.get(port + ':' + clientId) } : {}));
  await until(() => c.welcome, 5000, 'welcome for ' + name);
  if (c.welcome.you && c.welcome.you.token) SEAT_TOKENS.set(port + ':' + c.welcome.you.clientId, c.welcome.you.token);
  return c;
}

// Random legal play for a human client (also re-buys when busted between hands).
function attachDriver(client, rng) {
  let lastKey = null;
  client.rebuyFor = null;
  client.listeners.push(() => {
    const h = client.state && client.state.hand;
    if (!h) return;
    const me = h.seats.find((s) => s.seat === client.seat);
    if (h.over && me && me.stack === 0 && client.rebuyFor !== h.id) {
      client.rebuyFor = h.id;
      client.send({ t: 'rebuy' });
    }
    if (h.toAct !== client.seat || !h.legal) return;
    const key = [h.id, h.street, h.pot, h.toCall, h.minRaise, h.board.length].join('|');
    if (key === lastKey) return;
    lastKey = key;
    const L = h.legal;
    const r = rng();
    if (h.toCall > 0 && r < 0.12) client.send({ t: 'act', action: 'fold' });
    else if (L.raise && r < 0.3) {
      const lo = L.minRaiseTo, hi = L.maxRaiseTo;
      const amount = rng() < 0.5 ? lo : lo + Math.floor(rng() * (hi - lo + 1));
      client.send({ t: 'act', action: 'raise', amount: amount });
    } else client.send({ t: 'act', action: 'call' });
  });
}

// ------------------------------------------------------------------ tests

test('join, lobby, host flags, peers, rtc relay, bad input', async () => {
  const t = await start();
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0001');
    const b = await connect(t.port, 'Ben', 'ben-client-0002');
    assert.strictEqual(a.welcome.you.seat, 0);
    assert.strictEqual(a.welcome.you.host, true, 'first human is host');
    assert.strictEqual(b.welcome.you.seat, 1);
    assert.strictEqual(b.welcome.you.host, false);
    assert.deepStrictEqual(a.welcome.settings,
      { stack: 100000, sb: 500, bb: 1000, personalities: ['tight', 'loose', 'aggressive', 'passive', 'balanced'], stacks: 'equal', externalCallUrl: null, botShowCards: false, blindUpMin: 0, spectatorCards: 'live', lateStack: 'start', lateFixedBB: 20, blindLevel: 0, nextBlindUpAt: null });
    await until(() => a.lobby && a.lobby.players.length === 2, 3000, 'lobby with 2');
    assert.strictEqual(a.lobby.players[0].host, true);
    assert.strictEqual(a.lobby.players[1].host, false);
    assert.strictEqual(a.lobby.players[1].clientId, 'ben-client-0002');
    await until(() => a.peers && a.peers.ids.length === 2, 3000, 'peers');
    assert.deepStrictEqual(a.peers.ids.sort(), ['ann-client-0001', 'ben-client-0002']);

    a.send({ t: 'addBot', style: 'tight' });
    await until(() => a.lobby.players.length === 3, 3000, 'bot in lobby');
    const bot = a.lobby.players[2];
    assert.strictEqual(bot.bot, true);
    assert.strictEqual(bot.style, 'tight');
    assert.strictEqual(bot.seat, 2);

    a.send({ t: 'rtc', to: 'ben-client-0002', data: { sdp: 'offer-x' } });
    await until(() => b.rtc.length === 1, 3000, 'rtc relay');
    assert.deepStrictEqual(b.rtc[0], { t: 'rtc', from: 'ann-client-0001', data: { sdp: 'offer-x' } });

    const c = await new Client(t.port).open();
    c.send({ t: 'act', action: 'call' });
    c.send({ t: 'join', name: '   ' });
    c.send({ t: 'ping' });
    await until(() => c.errors.length === 2, 3000, 'two errors');
    assert.strictEqual(c.errors[0], 'join first');
    assert.match(c.errors[1], /1-16 characters/);
    await until(() => c.msgs.some((m) => m.t === 'pong'), 3000, 'pong');
    c.send({ t: 'join', name: 'Cy' });
    await until(() => c.welcome, 3000, 'welcome Cy');
    assert.strictEqual(c.welcome.you.seat, 3, 'next free seat');
    c.close();
    a.close(); b.close();
  } finally {
    await t.stop();
  }
});

test('host-only rules and settings validation', async () => {
  const t = await start({ timing: SLOW });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0011');
    const b = await connect(t.port, 'Ben', 'ben-client-0012');
    a.send({ t: 'addBot', style: 'aggressive' });
    await until(() => a.lobby && a.lobby.players.length === 3, 3000);
    b.send({ t: 'addBot', style: 'tight' });
    b.send({ t: 'start' });
    b.send({ t: 'settings', stack: 5000 });
    b.send({ t: 'kick', seat: 0 });
    b.send({ t: 'removeBot', seat: 2 });
    b.send({ t: 'reset' });
    await until(() => b.errors.length === 6, 3000, 'six host-only errors');
    assert.ok(b.errors.every((e) => e === 'host only'), b.errors.join(' / '));

    a.send({ t: 'settings', sb: 1000, bb: 500 });
    await until(() => a.errors.length === 1, 3000);
    assert.strictEqual(a.errors[0], 'sb must not exceed bb');
    a.send({ t: 'settings', botShowCards: 'yes' });
    await until(() => a.errors.length === 2, 3000);
    a.send({ t: 'settings', stack: 20000, bb: 200, sb: 100, botShowCards: true });
    await until(() => a.lobby.settings.stack === 20000, 3000, 'settings applied');
    assert.strictEqual(a.lobby.settings.sb, 100);
    assert.strictEqual(a.lobby.settings.bb, 200);
    assert.strictEqual(a.lobby.settings.botShowCards, true);

    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand, 3000, 'hand started');
    await until(() => t.room._handActive(), 3000, 'hand active');
    a.send({ t: 'start' });
    await until(() => a.errors.length === 3, 3000, 'start refused while a hand runs');
    a.send({ t: 'kick', seat: 1 });
    await until(() => t.room.recs[1] && t.room.recs[1].kickPending, 3000, 'mid-hand kick is marked');
    assert.strictEqual(a.errors.length, 3);
    assert.strictEqual(a.errors[2], 'a hand is already running');
    a.close(); b.close();
  } finally {
    await t.stop();
  }
});

test('kick, removeBot and table-full rules between hands', async () => {
  const t = await start();
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0021');
    const b = await connect(t.port, 'Ben', 'ben-client-0022');
    a.send({ t: 'addBot', style: 'loose' });
    await until(() => a.lobby && a.lobby.players.length === 3, 3000);
    a.send({ t: 'removeBot', seat: 2 });
    await until(() => a.lobby.players.length === 2, 3000, 'bot removed');
    a.send({ t: 'kick', seat: 1 });
    await until(() => b.kicked && b.kicked.reason === 'host', 3000, 'kicked message');
    await until(() => b.closed, 3000, 'kicked socket closed');
    await until(() => a.lobby.players.length === 1, 3000, 'kicked player gone');
    assert.strictEqual(t.room.recs[1], null);
    // A rejoin with the old clientId and token is refused once, with the host's reason.
    const again = await new Client(t.port).open();
    again.send({ t: 'join', name: 'Ben', clientId: b.clientId, token: SEAT_TOKENS.get(t.port + ':' + b.clientId) });
    await until(() => again.errors.length === 1, 3000, 'rejoin refused');
    assert.strictEqual(again.errors[0], 'you were removed by the host');
    assert.strictEqual(a.lobby.players.length, 1, 'the refused rejoin takes no seat');
    again.close();
    a.close();
  } finally {
    await t.stop();
  }
});

test('illegal actions are rejected with a reason and legal ones apply', async () => {
  const t = await start({ timing: SLOW });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0031');
    const b = await connect(t.port, 'Ben', 'ben-client-0032');
    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand && a.state.hand.toAct != null, 3000, 'turn');
    await until(() => a.state.hand.toAct === 0 || b.state.hand.toAct === 1, 3000);
    const actor = a.state.hand.toAct === 0 ? a : b;
    const other = actor === a ? b : a;
    const h = actor.state.hand;
    assert.ok(h.legal, 'actor has legal options');
    assert.strictEqual(h.legal.minRaiseTo, h.minRaise, 'minimum raise to the hand minimum');
    const beforeErrors = actor.errors.length;

    other.send({ t: 'act', action: 'call' });
    await until(() => other.errors.length >= 1, 3000);
    assert.strictEqual(other.errors[other.errors.length - 1], 'not your turn');

    actor.send({ t: 'act', action: 'bet', amount: 2000 });
    actor.send({ t: 'act', action: 'raise' });
    actor.send({ t: 'act', action: 'raise', amount: h.legal.minRaiseTo - 1 });
    actor.send({ t: 'act', action: 'raise', amount: h.legal.maxRaiseTo + 1 });
    actor.send({ t: 'act', action: 'raise', amount: 'lots' });
    await until(() => actor.errors.length === beforeErrors + 5, 3000, 'five rejections');
    const rej = actor.errors.slice(beforeErrors);
    assert.deepStrictEqual(rej, ['unknown action', 'raise needs an amount', 'raise below the minimum',
      'raise exceeds stack', 'raise needs an amount']);

    // Still the same turn after rejections.
    assert.strictEqual(actor.state.hand.toAct, h.toAct);
    actor.send({ t: 'act', action: 'call' });
    await until(() => actor.state.hand.toAct !== h.toAct || actor.state.hand.street !== h.street ||
      actor.state.hand.pot !== h.pot, 3000, 'call applied');
    a.close(); b.close();
  } finally {
    await t.stop();
  }
});

test('reconnect with clientId reclaims the seat and keeps the stack', async () => {
  const t = await start({ timing: SLOW });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0041');
    const b = await connect(t.port, 'Ben', 'ben-client-0042');
    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand, 3000, 'hand');
    const seat = a.seat;
    const stackBefore = t.room.table.seats[seat].stack;
    a.close();
    await until(() => b.lobby && b.lobby.players.find((p) => p.seat === seat).connected === false, 3000, 'disconnect seen');

    const a2 = await connect(t.port, 'Ann', 'ann-client-0041');
    assert.strictEqual(a2.welcome.you.seat, seat, 'same seat');
    assert.strictEqual(a2.welcome.you.name, 'Ann');
    assert.strictEqual(a2.welcome.you.host, true, 'still host');
    await until(() => b.lobby.players.find((p) => p.seat === seat).connected === true, 3000, 'reconnect seen');
    assert.strictEqual(t.room.table.seats[seat].stack, stackBefore, 'stack kept across reconnect');

    // A second window with the same clientId takes over; the old socket is dropped.
    const a3 = await connect(t.port, 'Ann', 'ann-client-0041');
    assert.strictEqual(a3.welcome.you.seat, seat);
    await until(() => a2.errors.includes('connected from another window') && a2.closed, 3000, 'old socket dropped');
    assert.strictEqual(t.room.recs.filter((r) => r && r.clientId === 'ann-client-0041').length, 1);
    a3.close(); b.close();
  } finally {
    await t.stop();
  }
});

test('rebuy for a busted player and host reset of stacks', async () => {
  const t = await start({ timing: SLOW });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0051');
    const b = await connect(t.port, 'Ben', 'ben-client-0052');
    a.send({ t: 'settings', stack: 20000 });
    await until(() => a.lobby.settings.stack === 20000, 3000);
    // Bust Ben between hands (no hand running), then he buys back in.
    t.room._setStack(1, 0);
    b.send({ t: 'rebuy' });
    await until(() => t.room.table.seats[1].stack === 20000, 3000, 'rebuy');
    b.send({ t: 'rebuy' });
    await until(() => b.errors.includes('you still have chips'), 3000);
    t.room._setStack(0, 1234);
    a.send({ t: 'reset' });
    await until(() => t.room.table.seats[0].stack === 20000 && t.room.table.seats[1].stack === 20000, 3000, 'reset');
    assert.strictEqual(t.room.chipsInPlay(), t.room.netChips, 'ledger matches the table');
    a.close(); b.close();
  } finally {
    await t.stop();
  }
});

test('3 humans + 2 bots play 20 hands: chips conserved, hidden cards hidden, showdowns reveal', async () => {
  const t = await start({ seed: 99, timing: FAST });
  const rng = rngFrom(4242);
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0061');
    const b = await connect(t.port, 'Ben', 'ben-client-0062');
    const c = await connect(t.port, 'Cy', 'cy-client-0063');
    a.send({ t: 'addBot', style: 'tight' });
    a.send({ t: 'addBot', style: 'aggressive' });
    await until(() => a.lobby && a.lobby.players.length === 5, 3000, 'five seats');

    const obs = { hands: new Set(), reveals: 0, failures: [], expected: null, prevStacks: null, rawChecks: 0, seen: {} };
    // Observer: everything Ann receives must respect the rules.
    // Game over (one chip holder left) stops autoplay: the host starts a new game once two seats hold chips
    // again (busted humans rebuy through their driver).
    a.listeners.push((m) => {
      if (m.t !== 'gameOver') return;
      obs.gameOvers = (obs.gameOvers || 0) + 1;
      const again = () => {
        const chipped = a.state && a.state.hand ? a.state.hand.seats.filter((s) => s.stack > 0).length : 0;
        if (chipped >= 2) a.send({ t: 'start' }); else setTimeout(again, 10);
      };
      setTimeout(again, 20);
    });
    a.listeners.push((m, raw) => {
      if (m.t !== 'state' || !m.hand) return;
      const h = m.hand;
      const stacks = {};
      const bets = {};
      h.seats.forEach((s) => { stacks[s.seat] = s.stack; bets[s.seat] = s.bet || 0; });
      // A spectator (busted, under 1 BB) is left out of h.seats but still holds chips: lobby.spectators carries
      // them, and the lobby and this state come from one broadcast, so they are counted together.
      const outChips = (a.lobby && a.lobby.spectators || []).reduce((x, s) => x + (s.stack || 0), 0);
      const total = h.seats.reduce((x, s) => x + s.stack, 0) + h.pot + outChips;
      if (obs.prevStacks) {
        // A stack only grows from zero through a rebuy (bots: automatic, humans: rebuy message).
        // Winnings also turn an all-in zero into chips, but only in the first over state (pot paid
        // out), so a rebuy is a zero -> chips step between two states when the earlier one is over.
        Object.keys(stacks).forEach((seat) => {
          // the rebuy and the blind it posts can arrive in the same state, so count the posted bet too
          // a busted seat leaves the state (spectator) and comes back with its rebuy: count that as a rebuy too
          const wasOut = obs.prevStacks[seat] === 0 || (obs.prevStacks[seat] === undefined && obs.seen[seat]);
          if (obs.prevOver && wasOut && stacks[seat] > 0) obs.expected += stacks[seat] + (bets[seat] || 0);
        });
      } else {
        obs.expected = total;
      }
      // the room ledger (netChips) only changes on joins, rebuys and resets, so it is the reference for conservation
      // a rebuy updates the ledger and the next broadcast a moment apart: only a mismatch that lasts 3 states is a leak
      obs.bad = total !== t.room.netChips ? (obs.bad || 0) + 1 : 0;
      if (obs.bad === 3) obs.failures.push('chips ' + total + ' != ' + t.room.netChips + ' in hand ' + h.id);
      Object.keys(stacks).forEach((seat) => { obs.seen[seat] = true; });
      obs.prevStacks = stacks;
      obs.prevOver = h.over;
      if (h.over) {
        obs.hands.add(h.id);
        h.seats.forEach((s) => { if (s.seat !== a.seat && s.cards) obs.reveals++; });
        if (obs.hands.size >= 20) finish();
        return;
      }
      h.seats.forEach((s) => {
        // a busted player is a spectator and sees every dealt seat (settings.spectatorCards 'live')
        const outNow = a.lobby && (a.lobby.spectators || []).some((x) => x.seat === a.seat);
        if (!outNow && s.seat !== a.seat && s.cards !== null) obs.failures.push('cards of seat ' + s.seat + ' visible mid-hand');
      });
      // Other humans' hole cards must not appear anywhere in Ann's raw messages during the hand.
      // A spectator sees every dealt seat by design (spectatorCards 'live'), so the check applies to seated Ann only.
      const annOut = !!(a.lobby && (a.lobby.spectators || []).some((x) => x.seat === a.seat));
      if (annOut) return;
      [b, c].forEach((x) => {
        if (!x.state || !x.state.hand || x.state.hand.id !== h.id || x.state.hand.over) return;
        x.state.hand.youCards.forEach((card) => {
          obs.rawChecks++;
          if (raw.indexOf('"' + card + '"') >= 0) obs.failures.push('hole card ' + card + ' leaked to another seat');
        });
      });
    });
    let finish;
    const done = new Promise((r) => { finish = r; });

    [a, b, c].forEach((x) => attachDriver(x, rng));
    a.send({ t: 'start' });
    let guard;
    const limit = new Promise((_, rej) => { guard = setTimeout(() => rej(new Error('20 hands not reached (got ' + obs.hands.size + ', failures ' + obs.failures.slice(0, 3).join('; ') + ', toAct ' + (a.state && a.state.hand && a.state.hand.toAct) + ')')), 90000); });
    try {
      await Promise.race([done, limit]);
    } finally {
      clearTimeout(guard);
    }

    assert.deepStrictEqual(obs.failures, [], obs.failures.slice(0, 5).join('; '));
    assert.ok(obs.rawChecks > 0, 'hole cards were compared against raw messages');
    assert.ok(obs.reveals > 0, 'showdown revealed cards');
    assert.ok(obs.hands.size >= 20);
    [a, b, c].forEach((x) => assert.deepStrictEqual(x.errors, [], 'no errors for ' + x.clientId));
    assert.strictEqual(t.room.chipsInPlay(), t.room.netChips, 'table ledger matches chips in play');
    a.close(); b.close(); c.close();
  } finally {
    await t.stop();
  }
});

// A real 1x1 PNG data URL (small enough for the avatar limit).
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('fresh room has no default bot; one human + bots play 30 hands without stalling', async () => {
  const t = await start({ seed: 5, timing: FAST });
  const rng = rngFrom(77);
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0071');
    await until(() => a.lobby, 3000, 'lobby');
    assert.strictEqual(a.lobby.players.length, 1, 'a fresh room has only the human');
    assert.strictEqual(a.lobby.players.filter((p) => p.bot).length, 0);
    a.send({ t: 'addBot', style: 'tight' });
    a.send({ t: 'addBot', style: 'aggressive' });
    await until(() => a.lobby.players.length === 3, 3000, 'two bots');
    attachDriver(a, rng); // the human plays and rebuys when busted
    const hands = new Set(), botHands = new Set();
    a.listeners.push((m) => {
      if (m.t !== 'state' || !m.hand) return;
      if (m.hand.over) hands.add(m.hand.id);
      if (m.hand.seats.some((s) => s.bot && s.lastAction)) botHands.add(m.hand.id);
    });
    a.send({ t: 'start' });
    await until(() => hands.size >= 30, 60000, '30 hands');
    assert.ok(botHands.size >= 25, 'bots acted in ' + botHands.size + ' hands');
    assert.deepStrictEqual(a.errors, []);
    a.close();
  } finally {
    await t.stop();
  }
});

test('avatars: join, profile and editBot carry them; bad images are rejected', async () => {
  const t = await start({ timing: SLOW });
  try {
    const a = await new Client(t.port).open();
    a.send({ t: 'join', name: 'Ann', clientId: 'ann-client-0081', avatar: PNG });
    await until(() => a.welcome, 3000);
    assert.strictEqual(a.welcome.you.avatar, PNG);
    const b = await new Client(t.port).open();
    b.send({ t: 'join', name: 'Ben', clientId: 'ben-client-0082', avatar: 'data:image/svg+xml;base64,PHN2Zy8+' });
    await until(() => b.errors.length === 1, 3000);
    assert.match(b.errors[0], /avatar must be/);
    assert.strictEqual(b.welcome, null, 'not joined');
    b.send({ t: 'join', name: 'Ben', clientId: 'ben-client-0082', avatar: 'data:image/png;base64,' + 'A'.repeat(90000) });
    await until(() => b.errors.length === 2, 3000);
    b.send({ t: 'join', name: 'Ben', clientId: 'ben-client-0082' });
    await until(() => b.welcome, 3000);
    b.send({ t: 'profile', avatar: PNG, name: 'Benji' });
    await until(() => a.lobby && a.lobby.players.some((p) => p.name === 'Benji' && p.avatar === PNG), 3000, 'profile in lobby');
    b.send({ t: 'profile', avatar: 'data:image/gif;base64,R0lGOD' });
    await until(() => b.errors.length === 3, 3000);

    a.send({ t: 'addBot', style: 'loose', name: 'Robo' });
    await until(() => a.lobby.players.length === 3, 3000);
    a.send({ t: 'editBot', seat: 2, avatar: PNG });
    await until(() => a.lobby.players[2].avatar === PNG, 3000, 'bot avatar');
    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand, 3000, 'hand');
    const seatAv = a.state.hand.seats.find((s) => s.seat === 2);
    assert.strictEqual(seatAv.avatar, PNG, 'avatar on the state seat');
    assert.strictEqual(a.state.hand.seats.find((s) => s.seat === 0).avatar, PNG);
    a.close(); b.close();
  } finally {
    await t.stop();
  }
});

test('editBot: host only; name and avatar any time, style only between hands', async () => {
  const t = await start({ timing: SLOW });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0091');
    const b = await connect(t.port, 'Ben', 'ben-client-0092');
    a.send({ t: 'addBot', style: 'balanced' });
    await until(() => a.lobby && a.lobby.players.length === 3, 3000);
    b.send({ t: 'editBot', seat: 2, name: 'Nope' });
    await until(() => b.errors.includes('host only'), 3000);
    a.send({ t: 'editBot', seat: 0, name: 'Nope' });
    a.send({ t: 'editBot', seat: 2, name: 'Robo', style: 'loose', avatar: PNG });
    await until(() => a.lobby.players[2].name === 'Robo', 3000);
    assert.strictEqual(a.lobby.players[2].style, 'loose');
    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand, 3000);
    a.send({ t: 'editBot', seat: 2, name: 'Robo2', avatar: null });
    await until(() => a.lobby.players[2].name === 'Robo2', 3000, 'name mid-hand');
    a.send({ t: 'editBot', seat: 2, style: 'tight' });
    await until(() => a.errors.length === 2, 3000);
    assert.deepStrictEqual(a.errors, ['no bot at that seat', 'wait until the hand ends']);
    a.close(); b.close();
  } finally {
    await t.stop();
  }
});

test('endGame refunds the running hand, sends standings and returns to the lobby', async () => {
  const t = await start({ timing: SLOW });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0101');
    const b = await connect(t.port, 'Ben', 'ben-client-0102');
    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand, 3000);
    a.send({ t: 'endGame' });
    await until(() => b.msgs.some((m) => m.t === 'gameOver'), 3000, 'gameOver');
    const go = b.msgs.find((m) => m.t === 'gameOver');
    assert.strictEqual(go.standings.length, 2);
    assert.deepStrictEqual(Object.keys(go.standings[0]).sort(), ['avatar', 'name', 'seat', 'stack']);
    await until(() => a.state && a.state.hand === null, 3000, 'lobby state');
    assert.strictEqual(t.room.table.seats[0].stack + t.room.table.seats[1].stack, 200000, 'refund keeps all chips');
    assert.strictEqual(t.room.autoplay, false);
    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand, 3000, 'new game');
    a.close(); b.close();
  } finally {
    await t.stop();
  }
});

test('pause freezes turn timers and bot actions; actions are refused; resume continues', async () => {
  const t = await start({ timing: { botDelay: [300, 300], actionMs: 900, disconnectMs: 900, nextHandMs: 50 } });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0111');
    const b = await connect(t.port, 'Ben', 'ben-client-0112');
    a.send({ t: 'addBot', style: 'passive' });
    await until(() => a.lobby && a.lobby.players.length === 3, 3000);
    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand, 3000);
    a.send({ t: 'pause' });
    await until(() => !!a.state.paused, 3000, 'paused flag');
    const frozen = JSON.stringify(a.state.hand);
    await new Promise((r) => setTimeout(r, 2500)); // well past every timer
    assert.strictEqual(JSON.stringify(a.state.hand), frozen, 'nothing moved while paused');
    const h = a.state.hand;
    const onClock = [a, b].find((c) => c.seat === h.toAct);
    if (onClock) {
      onClock.send({ t: 'act', action: 'call' });
      await until(() => onClock.errors.length === 1, 3000);
      assert.strictEqual(onClock.errors[0], 'the game is paused');
    }
    a.send({ t: 'resume' });
    await until(() => !a.state.paused && JSON.stringify(a.state.hand) !== frozen, 5000, 'resumed');
    a.close(); b.close();
  } finally {
    await t.stop();
  }
});

test('custom stacks: unequal stacks, short stacks cannot over-raise, chips conserved over 30 hands', async () => {
  const t = await start({ seed: 21, timing: FAST });
  const rng = rngFrom(909);
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0121');
    const b = await connect(t.port, 'Ben', 'ben-client-0122');
    const c = await connect(t.port, 'Cy', 'cy-client-0123');
    a.send({ t: 'addBot', style: 'tight' });
    await until(() => a.lobby && a.lobby.players.length === 4, 3000);
    a.send({ t: 'setStack', seat: 0, stack: 4000 });
    await until(() => a.errors.length === 1, 3000);
    assert.strictEqual(a.errors[0], "set stacks to 'custom' first");
    a.send({ t: 'settings', stacks: 'custom' });
    await until(() => a.lobby.settings.stacks === 'custom', 3000);
    a.send({ t: 'setStacks', stacks: { 0: 5000, 1: 100000, 2: 25000, 3: 60000 } });
    await until(() => a.lobby.players.find((p) => p.seat === 3).stack === 60000, 3000, 'custom stacks applied');
    a.send({ t: 'setStack', seat: 9, stack: 5000 });
    await until(() => a.errors.length === 2, 3000);
    a.send({ t: 'setStack', seat: 2, stack: 10 });
    await until(() => a.errors.length === 3, 3000);
    assert.strictEqual(a.errors[2], STACK_RULE);

    const obs = { hands: new Set(), failures: [], expected: null, prev: null, allIn: 0, shortCapped: 0, over: false };
    a.listeners.push((m) => {
      if (m.t === 'gameOver') obs.over = true;
      if (m.t !== 'state' || !m.hand) return;
      const h = m.hand;
      const stacks = {};
      h.seats.forEach((s) => { stacks[s.seat] = s.stack; });
      // Seats out of the hand (busted humans, spectators) are not in the state: their stacks count from the server.
      const outChips = t.room.table.seats.reduce((x, es, seat) => x + (t.room.recs[seat] && stacks[seat] === undefined ? es.stack : 0), 0);
      const total = h.seats.reduce((x, s) => x + s.stack, 0) + h.pot + outChips;
      if (obs.prev) {
        Object.keys(stacks).forEach((seat) => {
          if (obs.prev.over && obs.prev.stacks[seat] === 0 && stacks[seat] > 0) {
            const lobbyRow = a.lobby.players.find((p) => p.seat === Number(seat));
            obs.expected += lobbyRow.startStack;
          }
        });
      } else obs.expected = total;
      obs.bad = total !== t.room.netChips ? (obs.bad || 0) + 1 : 0;
      if (obs.bad === 3) obs.failures.push('chips ' + total + ' != ' + t.room.netChips);
      obs.prev = { stacks: stacks, over: h.over };
      if (h.seats.some((s) => s.allIn)) obs.allIn++;
      if (h.legal) {
        const me = h.seats.find((s) => s.seat === a.seat);
        if (h.legal.maxRaiseTo > me.bet + me.stack + 1e-9) obs.failures.push('over-raise allowed');
        else obs.shortCapped += me.stack < 100000 ? 1 : 0;
      }
      if (h.over) obs.hands.add(h.id);
    });
    [a, b, c].forEach((x) => attachDriver(x, rng));
    a.send({ t: 'start' });
    // Ends at 30 hands, or earlier once one chip holder is left (the server ends the game then).
    await until(() => obs.hands.size >= 30 || obs.over, 90000, '30 hands or game over with custom stacks');
    assert.deepStrictEqual(obs.failures, [], obs.failures.slice(0, 3).join('; '));
    assert.ok(obs.allIn > 0 || obs.over, 'all-ins happened with unequal stacks');
    assert.strictEqual(t.room.chipsInPlay(), t.room.netChips, 'ledger matches');
    // Ann's first three errors are the rejections this test asks for (custom mode, bad seat, bad stack).
    assert.strictEqual(a.errors.length, 3 + 0 * a.errors.length, 'Ann: only the three expected refusals');
    [b, c].forEach((x) => assert.deepStrictEqual(x.errors, [], 'no errors for ' + x.clientId));
    a.close(); b.close(); c.close();
  } finally {
    await t.stop();
  }
});

// ----------------------------------------------------------------- runner
test('showHand: between hands the seat cards are shown to everyone; refused mid-hand', async () => {
  const t = await start({ timing: SLOW });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0131');
    const b = await connect(t.port, 'Ben', 'ben-client-0132');
    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand && a.state.hand.toAct === 0, 3000, 'Ann to act');
    a.send({ t: 'act', action: 'fold' });
    await until(() => b.state && b.state.hand && b.state.hand.over, 3000, 'hand over');
    assert.strictEqual(b.state.hand.seats[0].cards, null, 'folded cards hidden');
    assert.strictEqual(b.state.hand.showWindowMs, 5000);
    assert.strictEqual(typeof b.state.hand.nextHandAt, 'number', 'next deal time is announced');
    a.send({ t: 'showHand' });
    await until(() => b.state.hand.seats[0].shown === true, 3000, 'shown flag');
    assert.strictEqual(b.state.hand.seats[0].cards.length, 2, 'shown cards visible to others');
    assert.strictEqual(b.state.hand.seats[1].shown, false, 'winner did not show');
    b.send({ t: 'showHand' });
    await until(() => a.state.hand.seats[1].shown === true, 3000, 'winner can show too');
    a.send({ t: 'start' });
    await until(() => a.state.hand && !a.state.hand.over, 3000, 'next hand');
    assert.strictEqual(a.state.hand.seats[0].shown, false, 'shows reset for the new hand');
    a.close(); b.close();
  } finally {
    await t.stop();
  }
});

test('chat: broadcast, history for joiners, control characters stripped, limits', async () => {
  const t = await start({ timing: SLOW });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0141');
    const b = await connect(t.port, 'Ben', 'ben-client-0142');
    a.send({ t: 'chat', text: '  hi\u0007 there  ' });
    await until(() => b.msgs.some((m) => m.t === 'chat'), 3000, 'chat broadcast');
    const c1 = b.msgs.find((m) => m.t === 'chat');
    assert.strictEqual(c1.text, 'hi there');
    assert.strictEqual(c1.from, 'ann-client-0141');
    assert.strictEqual(c1.name, 'Ann');
    assert.strictEqual(typeof c1.time, 'number');
    a.send({ t: 'chat', text: 'again' });
    await until(() => a.errors.length === 1, 3000);
    assert.strictEqual(a.errors[0], 'chat too fast');
    await new Promise((r) => setTimeout(r, 750));
    a.send({ t: 'chat', text: 'x'.repeat(201) });
    await until(() => a.errors.length === 2, 3000);
    assert.match(a.errors[1], /longer than 200/);
    a.send({ t: 'chat', text: '   ' });
    await until(() => a.errors.length === 3, 3000);
    const c = await connect(t.port, 'Cy', 'cy-client-0143');
    await until(() => c.msgs.some((m) => m.t === 'chatHistory'), 3000, 'history');
    const hist = c.msgs.find((m) => m.t === 'chatHistory').messages;
    assert.ok(hist.some((m) => m.text === 'hi there'), 'history has the earlier message');
    a.close(); b.close(); c.close();
  } finally {
    await t.stop();
  }
});

test('highlight colour: validated, in welcome, lobby and state seats', async () => {
  const t = await start({ timing: SLOW });
  try {
    const a = await new Client(t.port).open();
    a.send({ t: 'join', name: 'Ann', clientId: 'ann-client-0151', highlight: '#FF8800' });
    await until(() => a.welcome, 3000);
    assert.strictEqual(a.welcome.you.highlight, '#ff8800');
    const b = await connect(t.port, 'Ben', 'ben-client-0152');
    a.send({ t: 'profile', highlight: 'red' });
    await until(() => a.errors.length === 1, 3000);
    assert.match(a.errors[0], /highlight must be/);
    b.send({ t: 'profile', highlight: '#00ff00' });
    await until(() => a.lobby && a.lobby.players.some((p) => p.highlight === '#00ff00'), 3000, 'lobby highlight');
    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand, 3000);
    assert.strictEqual(a.state.hand.seats.find((s) => s.seat === 1).highlight, '#00ff00');
    a.close(); b.close();
  } finally {
    await t.stop();
  }
});

// Starting stacks: 5 to 1000 BB in half-BB steps (bb 1000 here, so 5000 to 1000000 chips in 500s).
const STACK_RULE = 'The starting stack must be from 5 to 1000 BB, in steps of 0.5 BB.';
test('starting stacks and late fixed stack: 5 to 1000 BB in half-BB steps', async () => {
  const t = await start({ timing: SLOW });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0170');
    await until(() => !!a.lobby, 3000, 'lobby');
    const setStack = async (stack, ok) => {
      const n = a.errors.length;
      a.send({ t: 'settings', stack });
      if (ok) {
        await until(() => a.lobby.settings.stack === stack, 3000, 'stack ' + stack + ' accepted');
      } else {
        await until(() => a.errors.length === n + 1, 3000, 'stack ' + stack + ' refused');
        assert.strictEqual(a.errors[n], STACK_RULE, 'friendly refusal for ' + stack);
      }
    };
    await setStack(1000, false);   // 1 BB
    await setStack(1500, false);   // 1.5 BB
    await setStack(5250, false);   // 5.25 BB: not a half-BB step
    await setStack(1000500, false); // 1000.5 BB
    await setStack(5000, true);    // 5 BB, the minimum
    await setStack(1000000, true); // 1000 BB, the maximum
    const n = a.errors.length;
    a.send({ t: 'settings', lateStack: 'fixed', lateFixedBB: 4.5 });
    await until(() => a.errors.length === n + 1, 3000, 'late fixed refused');
    assert.strictEqual(a.errors[n], 'The late fixed stack must be from 5 to 1000 BB, in steps of 0.5 BB.');
    a.send({ t: 'settings', lateFixedBB: 1000.5 });
    await until(() => a.errors.length === n + 2, 3000, 'late fixed max refused');
    a.send({ t: 'settings', lateFixedBB: 5.5 });
    await until(() => a.lobby.settings.lateFixedBB === 5.5, 3000, 'late fixed accepted');
    a.close();
  } finally {
    await t.stop();
  }
});

test('settings: externalCallUrl, personalities list, varied stacks', async () => {
  const t = await start({ timing: SLOW });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0161');
    const b = await connect(t.port, 'Ben', 'ben-client-0162');
    const c = await connect(t.port, 'Cy', 'cy-client-0163');
    a.send({ t: 'settings', externalCallUrl: 'ftp://meet.example' });
    await until(() => a.errors.length === 1, 3000);
    assert.strictEqual(a.errors[0], 'externalCallUrl must be an http(s) URL');
    a.send({ t: 'settings', externalCallUrl: 'https://meet.example.com/room' });
    await until(() => a.lobby.settings.externalCallUrl === 'https://meet.example.com/room', 3000, 'call url');
    a.send({ t: 'settings', personalities: ['tight', 'nope'] });
    await until(() => a.errors.length === 2, 3000);
    assert.strictEqual(a.errors[1], 'unknown personality nope');
    a.send({ t: 'settings', personalities: ['tight', 'aggressive'] });
    await until(() => a.lobby.settings.personalities.length === 2, 3000, 'personalities');
    assert.deepStrictEqual(a.lobby.settings.personalities, ['tight', 'aggressive']);
    a.send({ t: 'settings', stacks: 'bogus' });
    await until(() => a.errors.length === 3, 3000);
    a.send({ t: 'settings', stacks: 'varied' });
    await until(() => a.lobby.settings.stacks === 'varied', 3000, 'varied');
    const starts = a.lobby.players.map((p) => p.startStack);
    assert.ok(new Set(starts).size > 1, 'varied starting stacks differ: ' + starts.join(','));
    starts.forEach((s) => {
      assert.strictEqual(s % 1000, 0, 'whole big blinds');
      assert.ok(s >= 1000 && s <= 160000, 'within 0.4x-1.6x: ' + s);
    });
    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand, 3000);
    a.send({ t: 'settings', externalCallUrl: 'https://meet.example.com/other' });
    await until(() => a.lobby.settings.externalCallUrl === 'https://meet.example.com/other', 3000, 'url mid-hand');
    a.send({ t: 'settings', stack: 5000 });
    await until(() => a.errors.length === 4, 3000);
    assert.strictEqual(a.errors[3], 'wait until the hand ends');
    a.close(); b.close(); c.close();
  } finally {
    await t.stop();
  }
});

test('lobby settings reach every client at once (blinds, spectator cards)', async () => {
  const t = await start({ timing: SLOW });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0170');
    const b = await connect(t.port, 'Ben', 'ben-client-0171');
    a.send({ t: 'settings', blindUpMin: 4, spectatorCards: 'afterHand' });
    const t0 = Date.now();
    await until(() => b.lobby && b.lobby.settings.blindUpMin === 4 && b.lobby.settings.spectatorCards === 'afterHand', 900, 'guest sees host settings');
    assert.ok(Date.now() - t0 < 900, 'within 0.9 s');
    assert.strictEqual(a.lobby.settings.blindUpMin, 4);
    a.send({ t: 'settings', blindUpMin: 0, spectatorCards: 'off' });
    await until(() => b.lobby.settings.blindUpMin === 0 && b.lobby.settings.spectatorCards === 'off', 900, 'guest sees reset');
    a.send({ t: 'settings', blindUpMin: 11 });
    await until(() => a.errors.length === 1, 2000, 'blindUpMin range');
    assert.strictEqual(b.lobby.settings.blindUpMin, 0, 'refused value not broadcast');
    a.send({ t: 'settings', spectatorCards: 'all' });
    await until(() => a.errors.length === 2, 2000, 'spectatorCards validation');
    assert.match(a.errors[1], /spectatorCards must be/);
    a.close(); b.close();
  } finally {
    await t.stop();
  }
});

test('avatars up to 64 KB are accepted; larger ones refused', async () => {
  const t = await start({ timing: SLOW });
  try {
    const a = await new Client(t.port).open();
    const ok = 'data:image/jpeg;base64,' + 'A'.repeat(Math.ceil(50 * 1024 * 4 / 3));
    a.send({ t: 'join', name: 'Ann', clientId: 'ann-client-0171', avatar: ok });
    await until(() => a.welcome, 3000, 'join with 50 KB avatar');
    assert.strictEqual(a.welcome.you.avatar, ok);
    const big = 'data:image/webp;base64,' + 'A'.repeat(Math.ceil(70 * 1024 * 4 / 3));
    a.send({ t: 'profile', avatar: big });
    await until(() => a.errors.length === 1, 3000);
    assert.match(a.errors[0], /at most 30 KB|JPEG, PNG or WebP/);
    a.close();
  } finally {
    await t.stop();
  }
});

test('rtc-config and lan-info over HTTP, TURN only from environment', async () => {
  const t = await start({ timing: SLOW });
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: t.port, path: p }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(body) }));
    }).on('error', reject);
  });
  const saved = { u: process.env.TURN_URLS, n: process.env.TURN_USER, p: process.env.TURN_PASS };
  try {
    delete process.env.TURN_URLS; delete process.env.TURN_USER; delete process.env.TURN_PASS;
    const r1 = await get('/rtc-config');
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r1.headers['cache-control'], 'no-store');
    assert.deepStrictEqual(r1.json.iceServers, [{ urls: ['stun:stun.l.google.com:19302'] }]);
    process.env.TURN_URLS = 'turn:turn.example.org:3478, turns:turn.example.org:5349';
    process.env.TURN_USER = 'u1';
    process.env.TURN_PASS = 'p1';
    const r2 = await get('/rtc-config');
    assert.deepStrictEqual(r2.json.iceServers[1], {
      urls: ['turn:turn.example.org:3478', 'turns:turn.example.org:5349'], username: 'u1', credential: 'p1',
    });
    const lan = await get('/lan-info');
    assert.strictEqual(lan.status, 200);
    assert.strictEqual(lan.json.https, false, 'plain HTTP server');
    assert.ok(Array.isArray(lan.json.urls));
    lan.json.urls.forEach((u) => assert.match(u, /^https:\/\/\d+\.\d+\.\d+\.\d+:\d+$/));
  } finally {
    if (saved.u === undefined) delete process.env.TURN_URLS; else process.env.TURN_URLS = saved.u;
    if (saved.n === undefined) delete process.env.TURN_USER; else process.env.TURN_USER = saved.n;
    if (saved.p === undefined) delete process.env.TURN_PASS; else process.env.TURN_PASS = saved.p;
    await t.stop();
  }
});

test('diagnostics: JSON lines, sanitised, one per second, size-capped and rotated', async () => {
  const file = path.join(os.tmpdir(), 'mp-diag-' + process.pid + '-' + Date.now() + '.log');
  const t = await start({ timing: SLOW, diagFile: file });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0181');
    a.send({ t: 'diag', kind: 'ice', data: { type: 'relay', chat: 'secret', sdp: 'v=0', nested: { audio: 1, ok: 2 } } });
    await until(() => fs.existsSync(file), 3000, 'diag file');
    a.send({ t: 'diag', kind: 'ice', data: { again: true } }); // too soon: ignored
    a.send({ t: 'diag', kind: 'big', data: { s: 'x'.repeat(5000) } }); // oversize: ignored
    await new Promise((r) => setTimeout(r, 1100));
    a.send({ t: 'diag', kind: 'stats', data: { fps: 24 } });
    await until(() => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length === 2, 3000, 'two lines');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.strictEqual(lines[0].kind, 'ice');
    assert.strictEqual(lines[0].name, 'Ann');
    assert.strictEqual(lines[0].clientId, 'ann-client-0181');
    assert.strictEqual(lines[0].data.type, 'relay');
    assert.ok(!('chat' in lines[0].data) && !('sdp' in lines[0].data), 'chat and sdp dropped');
    assert.deepStrictEqual(lines[0].data.nested, { ok: 2 }, 'audio key dropped inside nested data');
    assert.strictEqual(lines[1].data.fps, 24);
    a.close();
  } finally {
    await t.stop();
  }
  // Rotation at the size cap (the real log rotates at 5 MB).
  const { DiagLog } = require(path.join(__dirname, '..', 'server', 'diag.js'));
  const log = new DiagLog(file + '.rot', 200);
  for (let i = 0; i < 10; i++) log.append({ clientId: 'c', name: 'n', kind: 'k', data: { i: i, pad: 'y'.repeat(60) } });
  assert.ok(fs.existsSync(file + '.rot.1'), 'old file rotated');
  fs.rmSync(file + '.rot', { force: true });
  fs.rmSync(file + '.rot.1', { force: true });
  fs.rmSync(file, { force: true });
});

test('relay: needKey routed; binary frames forwarded with sender seat; budget and max 6 humans', async () => {
  const t = await start({ timing: SLOW });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0191');
    const b = await connect(t.port, 'Ben', 'ben-client-0192');
    a.send({ t: 'needKey', to: 'ben-client-0192' });
    await until(() => b.msgs.some((m) => m.t === 'needKey'), 3000, 'needKey routed');
    assert.strictEqual(b.msgs.find((m) => m.t === 'needKey').from, 'ann-client-0191');

    b.ws.send(Buffer.from([1, 0xaa, 0xbb]), { binary: true });
    await until(() => a.binary.length === 1, 3000, 'binary frame');
    assert.deepStrictEqual([...a.binary[0]], [1, 1, 0xaa, 0xbb], 'type, sender seat, payload');

    // Budget: a 512 KB burst lets about five 100 KB frames through; the rest is dropped.
    const frame = Buffer.concat([Buffer.from([1, 0]), Buffer.alloc(100 * 1024, 7)]);
    const before = t.server.multiplayer.stats.relayDropped;
    for (let i = 0; i < 12; i++) b.ws.send(frame, { binary: true });
    await new Promise((r) => setTimeout(r, 400));
    const got = a.binary.length - 1;
    assert.ok(got >= 4 && got <= 7, 'frames through the budget: ' + got);
    assert.ok(t.server.multiplayer.stats.relayDropped > before, 'drops counted');

    // Max 6 humans for media; the seventh is refused.
    const extra = [a, b];
    for (let i = 0; i < 4; i++) extra.push(await connect(t.port, 'P' + i, 'player-client-' + i + '-01'));
    const seventh = await new Client(t.port).open();
    seventh.send({ t: 'join', name: 'Late', clientId: 'late-client-0001' });
    await until(() => seventh.errors.length === 1, 3000);
    assert.strictEqual(seventh.errors[0], 'room is full (max 6 players)');
    extra.forEach((c) => c.close());
    seventh.close();
  } finally {
    await t.stop();
  }
});

test('LAN HTTPS serves the same app and wss /ws (uses certs/ when present)', async () => {
  const creds = loadCerts();
  if (!creds) { console.log('       (skipped: no certs/, run npm run cert)'); return; }
  const room = new Room({ timing: SLOW, diagFile: false });
  const server = createHttpsServer(room, creds, { httpsActive: true, httpsPort: 3443 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const body = await new Promise((resolve, reject) => {
      https.get({ host: '127.0.0.1', port: port, path: '/lan-info', rejectUnauthorized: false }, (res) => {
        let s = '';
        res.on('data', (d) => { s += d; });
        res.on('end', () => resolve({ code: res.statusCode, json: JSON.parse(s) }));
      }).on('error', reject);
    });
    assert.strictEqual(body.code, 200);
    assert.strictEqual(body.json.https, true);
    const c = new Client(port);
    c.ws = new WebSocket('wss://127.0.0.1:' + port + '/ws', { rejectUnauthorized: false });
    await new Promise((resolve, reject) => { c.ws.on('open', resolve); c.ws.on('error', reject); });
    c.ws.on('message', (raw) => c._on(raw.toString()));
    c.send({ t: 'join', name: 'Tls', clientId: 'tls-client-0001' });
    await until(() => c.welcome, 3000, 'welcome over wss');
    assert.strictEqual(c.welcome.you.name, 'Tls');
    c.close();
  } finally {
    room.dispose();
    await new Promise((r) => server.close(r));
  }
});

test('host role moves to a connected player when the first one drops', async () => {
  const t = await start();
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0001');
    a.ws.close();
    await new Promise((r) => setTimeout(r, 300));
    const b = await connect(t.port, 'Ben', 'ben-client-0002');
    await until(() => b.lobby && b.lobby.players.some((p) => p.name === 'Ben'), 3000, 'lobby');
    assert.strictEqual(b.lobby.players.find((p) => p.name === 'Ben').host, true, 'the connected player is host');
    assert.strictEqual(b.lobby.players.find((p) => p.name === 'Ann').host, false);
  } finally {
    await t.stop();
  }
});


test('busted human leaves the seats; a spectator cannot act; positions re-adjust', async () => {
  const t = await start({ timing: SLOW });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0401');
    const b = await connect(t.port, 'Ben', 'ben-client-0402');
    a.send({ t: 'addBot', style: 'balanced' });
    await until(() => a.lobby && a.lobby.players.length === 3, 3000);
    t.room._setStack(1, 0);
    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand, 3000, 'hand started');
    assert.deepStrictEqual(a.state.hand.seats.map((s) => s.seat).sort(), [0, 2], 'busted seat is not shown');
    assert.ok(!a.lobby.players.some((p) => p.seat === 1), 'busted seat is not in the lobby');
    assert.ok(b.welcome && b.seat === 1, 'spectator stays seated and connected');
    b.send({ t: 'act', action: 'call' });
    await until(() => b.errors.includes('you are out - spectating'), 3000, 'spectator refused');
    assert.ok(t.room._isOut(1));
    // Positions re-adjust on the next deal: the two seats in play are dealt in, the out seat is not.
    a.close(); b.close();
  } finally {
    await t.stop();
  }
});

test('bot hole cards stay hidden by default; botShowCards shows them at showdown only when on', async () => {
  const t = await start({ timing: SLOW });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0411');
    a.send({ t: 'addBot', style: 'balanced' });
    await until(() => a.lobby && a.lobby.players.length === 2, 3000);
    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand, 3000);
    const botSeat = t.room.recs.findIndex((r) => r && r.bot);
    t.room.table.hand.seats[botSeat].reveal = true;
    const hidden = t.room._viewFor(0).seats.find((s) => s.seat === botSeat);
    assert.strictEqual(hidden.cards, null, 'bot cards hidden by default');
    a.send({ t: 'settings', botShowCards: true });
    await until(() => a.lobby.settings.botShowCards === true, 3000, 'setting applied');
    const shown = t.room._viewFor(0).seats.find((s) => s.seat === botSeat);
    assert.ok(Array.isArray(shown.cards) && shown.cards.length === 2, 'bot cards shown when the setting is on');
    a.send({ t: 'settings', botShowCards: 'yes' });
    await until(() => a.errors.includes('botShowCards must be true or false'), 3000);
    a.close();
  } finally {
    await t.stop();
  }
});

test('End game: every seat back to starting stacks, no hand dealt until the host starts again', async () => {
  const t = await start({ timing: FAST });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0421');
    const b = await connect(t.port, 'Ben', 'ben-client-0422');
    a.send({ t: 'addBot', style: 'tight' });
    await until(() => a.lobby && a.lobby.players.length === 3, 3000);
    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand, 3000);
    a.send({ t: 'endGame' });
    await until(() => a.state && a.state.hand === null && b.state && b.state.hand === null, 3000, 'lobby for everyone');
    await until(() => a.msgs.some((m) => m.t === 'gameOver') && b.msgs.some((m) => m.t === 'gameOver'), 3000, 'standings');
    t.room.recs.forEach((rec, seat) => { if (rec) assert.strictEqual(t.room.table.seats[seat].stack, t.room._startOf(rec), 'seat ' + seat + ' back to start'); });
    assert.strictEqual(t.room.recs.filter((r) => r && r.bot).length, 1, 'bots stay seated');
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(a.state.hand, null, 'no hand dealt after End game');
    a.close(); b.close();
  } finally {
    await t.stop();
  }
});

test('duplicate or stale acts are ignored silently; nobody is evicted; no turn key keeps "not your turn"', async () => {
  const t = await start({ timing: SLOW });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0301');
    const b = await connect(t.port, 'Ben', 'ben-client-0302');
    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand, 3000);
    const h = a.state.hand;
    const actor = [a, b].find((c) => c.seat === h.toAct);
    const other = actor === a ? b : a;
    const key = h.id + '|' + h.street + '|' + h.toAct;
    actor.send({ t: 'act', action: 'call', turn: key });
    await until(() => other.state.hand.toAct === other.seat, 3000, 'turn passed');
    const before = a.errors.length + b.errors.length;
    actor.send({ t: 'act', action: 'call', turn: key });
    actor.send({ t: 'act', action: 'fold', turn: key });
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(a.errors.length + b.errors.length, before, 'stale acts are silent');
    assert.ok(!a.closed && !b.closed, 'nobody evicted');
    assert.strictEqual(other.state.hand.toAct, other.seat, 'the stale fold did not act for the other player');
    actor.send({ t: 'act', action: 'call' });
    await until(() => actor.errors.includes('not your turn'), 3000, 'not your turn');
    a.close(); b.close();
  } finally {
    await t.stop();
  }
});

test('pause: server banner, frozen turn clock equal for everyone, refusals, pause twice, disconnect and reconnect keep the clock', async () => {
  const t = await start({ timing: { botDelay: [1, 3], actionMs: 8000, disconnectMs: 6000, nextHandMs: 60000, disconnectGraceMs: 50 } });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0401');
    const b = await connect(t.port, 'Ben', 'ben-client-0402');
    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand, 3000);
    a.send({ t: 'pause' });
    await until(() => a.state.paused && b.state.paused, 3000, 'paused');
    assert.strictEqual(a.state.paused.by, 0, 'banner: who paused');
    assert.strictEqual(a.state.paused.name, 'Ann');
    assert.ok(a.state.paused.autoResumeAt > a.state.paused.since, 'banner: auto resume time');
    const left1 = a.state.hand.turnLeftMs;
    assert.strictEqual(b.state.hand.turnLeftMs, left1, 'same frozen clock for both');
    assert.ok(left1 > 0 && left1 <= 8000, 'clock within the turn time');
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(a.state.hand.turnLeftMs, left1, 'clock does not move while paused');
    a.send({ t: 'pause' });
    a.send({ t: 'settings', stack: 20000 });
    await until(() => a.errors.includes('the game is paused'), 2000, 'settings refused');
    a.send({ t: 'reset' });
    a.send({ t: 'doubleBlinds' });
    a.send({ t: 'addBot', style: 'tight' });
    await until(() => a.errors.filter((e) => e === 'the game is paused').length >= 4, 2000, 'refusals');
    assert.strictEqual(a.errors.filter((e) => e === 'the game is paused').length, 4, 'pausing twice is silent');
    const onClock = a.state.hand.toAct === b.seat;
    b.ws.close();
    await new Promise((r) => setTimeout(r, 200));
    const b2 = await connect(t.port, 'Ben', 'ben-client-0402');
    await until(() => b2.state && b2.state.hand, 3000);
    if (onClock) assert.ok(b2.state.hand.turnLeftMs <= Math.min(left1, 6000), 'short clock after a drop, never fresh');
    else assert.strictEqual(b2.state.hand.turnLeftMs, left1, 'reconnect keeps the clock');
    assert.ok(b2.state.paused, 'still paused after reconnect');
    a.send({ t: 'resume' });
    await until(() => !a.state.paused && !b2.state.paused, 3000, 'resumed');
    a.send({ t: 'resume' });
    a.close(); b2.close();
  } finally {
    await t.stop();
  }
});

test('pause: a new host resumes after the host drops; endGame works during a pause; auto-resume', async () => {
  const timing = { botDelay: [1, 3], actionMs: 8000, disconnectMs: 6000, nextHandMs: 60000, disconnectGraceMs: 30, autoResumeMs: 400 };
  const t = await start({ timing: timing });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0421');
    const b = await connect(t.port, 'Ben', 'ben-client-0422');
    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand, 3000);
    a.send({ t: 'pause' });
    await until(() => a.state.paused, 3000, 'paused');
    a.ws.close();
    await until(() => b.lobby && b.lobby.players.find((p) => p.name === 'Ben').host, 3000, 'Ben is host');
    b.send({ t: 'resume' });
    await until(() => !b.state.paused, 3000, 'resumed by new host');
    b.send({ t: 'pause' });
    await until(() => b.state.paused, 3000, 'paused again');
    b.send({ t: 'endGame' });
    await until(() => b.state.hand === null && !b.state.paused, 3000, 'endGame during pause');
    assert.strictEqual(b.state.paused, null, 'endGame clears the pause');
    b.close();
  } finally {
    await t.stop();
  }
  const t3 = await start({ timing: timing });
  try {
    const a = await connect(t3.port, 'Ann', 'ann-client-0431');
    const b = await connect(t3.port, 'Ben', 'ben-client-0432');
    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand, 3000);
    a.send({ t: 'pause' });
    await until(() => a.state.paused, 3000, 'paused');
    await until(() => !a.state.paused && !b.state.paused, 3000, 'auto resumed');
    a.close(); b.close();
  } finally {
    await t3.stop();
  }
});

test('blinds: validation, host-only doubleBlinds that only affects the NEXT hand, cap, base restored by endGame and reset', async () => {
  const t = await start({ timing: SLOW });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0501');
    const b = await connect(t.port, 'Ben', 'ben-client-0502');
    a.send({ t: 'settings', blindUpMin: 11 });
    a.send({ t: 'settings', blindUpMin: 1.5 });
    await until(() => a.errors.length === 2, 2000, 'blindUpMin refused');
    a.send({ t: 'settings', blindUpMin: 10 });
    await until(() => a.lobby && a.lobby.settings.blindUpMin === 10, 2000);
    a.send({ t: 'settings', blindUpMin: 0 });
    b.send({ t: 'doubleBlinds' });
    await until(() => b.errors.includes('host only'), 2000, 'host only');
    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand, 3000);
    a.send({ t: 'doubleBlinds' });
    await until(() => t.room.pendingDoubles === 1, 2000, 'doubling queued');
    assert.strictEqual(a.lobby.settings.bb, 1000, 'mid-hand: the shown BB does not change');
    assert.strictEqual(t.room.table.hand.bb, 1000, 'the running hand keeps its blinds');
    const notices0 = [a, b].map((c) => c.msgs.filter((m) => m.t === 'notice' && m.kind === 'blinds').length);
    assert.ok(notices0[0] === 0 && notices0[1] === 0, 'no notice until the hand boundary');
    const h = a.state.hand;
    [a, b].find((c) => c.seat === h.toAct).send({ t: 'act', action: 'fold' });
    await until(() => a.state.hand.over, 3000, 'hand over');
    a.send({ t: 'start' });
    await until(() => a.state.hand && a.state.hand.id !== h.id, 3000, 'next hand');
    assert.strictEqual(t.room.table.hand.bb, 2000, 'next hand uses doubled blinds');
    assert.strictEqual(a.lobby.settings.bb, 2000, 'lobby shows doubled blinds from the boundary');
    assert.ok([a, b].every((c) => c.msgs.some((m) => m.t === 'notice' && m.kind === 'blinds' && m.bb === 2000)), 'notice at the boundary');
    assert.strictEqual(t.room.table.hand.sb, 1000);
    assert.strictEqual(t.room.chipsInPlay(), t.room.netChips, 'chips conserved after changes');
    a.send({ t: 'endGame' });
    await until(() => a.state.hand === null, 3000, 'endGame');
    assert.strictEqual(a.lobby.settings.bb, 1000, 'endGame restores base blinds');
    assert.strictEqual(a.lobby.settings.sb, 500);
    a.close(); b.close();
  } finally {
    await t.stop();
  }
  const t2 = await start({ timing: SLOW });
  try {
    const a = await connect(t2.port, 'Ann', 'ann-client-0511');
    a.send({ t: 'settings', stack: 300000000, sb: 150000, bb: 300000 });  // 1000 BB at 300000 blinds
    await until(() => a.lobby && a.lobby.settings.bb === 300000, 2000, 'big blinds');
    a.send({ t: 'doubleBlinds' });
    await until(() => a.lobby.settings.bb === 512000, 2000, 'capped');
    a.send({ t: 'doubleBlinds' });
    await until(() => a.errors.includes('blinds cannot go higher'), 2000, 'cap reached');
    a.send({ t: 'reset' });
    await until(() => a.lobby.settings.bb === 300000, 2000, 'reset restores base');
    a.close();
  } finally {
    await t2.stop();
  }
});

test('blinds: progressive doubling only at the hand boundary; the blind clock freezes with pause', async () => {
  const t = await start({ timing: Object.assign({}, SLOW, { blindMinuteMs: 120 }) });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0521');
    const b = await connect(t.port, 'Ben', 'ben-client-0522');
    a.send({ t: 'settings', blindUpMin: 1 });
    await until(() => a.lobby && a.lobby.settings.blindUpMin === 1, 2000);
    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand && a.lobby.settings.nextBlindUpAt, 2000, 'blind clock armed');
    a.send({ t: 'pause' });
    await until(() => a.state.paused, 2000, 'paused');
    assert.strictEqual(a.lobby.settings.nextBlindUpAt, null, 'no blind clock while paused');
    const frozen = t.room._blindClock.left;
    await new Promise((r) => setTimeout(r, 250));
    assert.strictEqual(t.room._blindClock.left, frozen, 'blind clock frozen by the pause');
    a.send({ t: 'resume' });
    await until(() => !a.state.paused && a.lobby.settings.nextBlindUpAt, 2000, 'clock resumed');
    await until(() => t.room.pendingDoubles >= 1, 2000, 'a doubling is queued');
    assert.strictEqual(t.room.table.hand.bb, 1000, 'not applied mid-hand');
    assert.strictEqual(a.lobby.settings.bb, 1000, 'lobby still shows the running blinds');
    // Stop the clock so the number of queued doublings is fixed for the check below.
    t.room._blindDisarm();
    const queued = t.room.pendingDoubles;
    const h = a.state.hand;
    [a, b].find((c) => c.seat === h.toAct).send({ t: 'act', action: 'fold' });
    await until(() => a.state.hand.over, 3000, 'hand over');
    a.send({ t: 'start' });
    await until(() => a.state.hand && a.state.hand.id !== h.id, 3000, 'next hand');
    assert.strictEqual(t.room.table.hand.bb, Math.min(512000, 1000 * Math.pow(2, queued)), 'doubled at the boundary');
    assert.strictEqual(t.room.pendingDoubles, 0);
    assert.strictEqual(a.lobby.settings.blindLevel, queued);
    a.close(); b.close();
  } finally {
    await t.stop();
  }
});

test('spectators: busted humans are listed; spectatorCards setting; players never see hidden cards; out seats cannot act or show', async () => {
  const t = await start({ timing: SLOW });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0601');
    const b = await connect(t.port, 'Ben', 'ben-client-0602');
    const c = await connect(t.port, 'Cy', 'cy-client-0603');
    t.room._setStack(c.seat, 0);
    t.room._changed({});
    await until(() => a.lobby && a.lobby.spectators.length === 1, 2000, 'spectator listed');
    assert.strictEqual(a.lobby.spectators[0].seat, c.seat);
    assert.strictEqual(a.lobby.players.length, 2, 'players exclude spectators');
    a.send({ t: 'start' });
    await until(() => c.state && c.state.hand && c.state.hand.toAct != null, 3000);
    assert.ok(!c.state.hand.seats.some((s) => s.seat === c.seat), 'spectator is not a seat in the hand');
    const bForC = c.state.hand.seats.find((s) => s.seat === b.seat);
    assert.ok(bForC && bForC.cards && bForC.cards.length === 2, 'spectator sees the players cards (live)');
    const bForA = a.state.hand.seats.find((s) => s.seat === b.seat);
    assert.strictEqual(bForA.cards, null, 'a player never sees the hidden cards of another player');
    c.send({ t: 'act', action: 'call' });
    await until(() => c.errors.includes('you are out - spectating'), 2000, 'act refused');
    c.send({ t: 'showHand' });
    await until(() => c.errors.filter((e) => e === 'you are out - spectating').length === 2, 2000, 'showHand refused');
    a.send({ t: 'settings', spectatorCards: 'off' });
    await until(() => a.lobby.settings.spectatorCards === 'off', 2000, 'setting off');
    await until(() => c.state.hand.seats.find((s) => s.seat === b.seat).cards === null, 2000, 'cards hidden for spectator');
    a.send({ t: 'settings', spectatorCards: 'bogus' });
    await until(() => a.errors.some((e) => /spectatorCards/.test(e)), 2000, 'bad setting refused');
    a.close(); b.close(); c.close();
  } finally {
    await t.stop();
  }
});

test('showdown: hand.pots lists the pots paid and they sum to the chips in the pot', async () => {
  const t = await start({ timing: SLOW });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0701');
    const b = await connect(t.port, 'Ben', 'ben-client-0702');
    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand, 3000);
    const h = a.state.hand;
    [a, b].find((c) => c.seat === h.toAct).send({ t: 'act', action: 'fold' });
    await until(() => a.state.hand.over && a.state.hand.pots, 3000, 'pots');
    const pots = a.state.hand.pots;
    assert.strictEqual(pots.reduce((s, p) => s + p.amount, 0), 1500, 'pots sum to the blinds');
    assert.deepStrictEqual(pots[0].winners, [b.seat], 'the other player wins the pot');
    a.close(); b.close();
  } finally {
    await t.stop();
  }
});

test('connection: pong echoes ts and carries the server time; a silent socket is dropped after missed pongs', async () => {
  const t = await start({ timing: Object.assign({}, FAST, { wsPingMs: 40 }) });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0801');
    a.send({ t: 'ping', ts: 12345 });
    await until(() => a.msgs.some((m) => m.t === 'pong' && m.ts === 12345), 2000, 'pong');
    const pong = a.msgs.find((m) => m.t === 'pong' && m.ts === 12345);
    assert.ok(typeof pong.sv === 'number' && Math.abs(pong.sv - Date.now()) < 5000, 'server time');
    // ws clients answer ping frames automatically; turning autoPong off makes this one silent.
    const silent = new WebSocket('ws://127.0.0.1:' + t.port + '/ws', { autoPong: false });
    await new Promise((r, j) => { silent.on('open', r); silent.on('error', j); });
    silent.send(JSON.stringify({ t: 'join', name: 'Silent', clientId: 'silent-client-0802' }));
    const dropped = new Promise((r) => silent.on('close', r));
    await Promise.race([dropped, new Promise((_, j) => setTimeout(() => j(new Error('silent socket not dropped')), 2000))]);
    assert.ok(!a.closed, 'the responsive client stays connected');
    a.close();
  } finally {
    await t.stop();
  }
});

// Round 2: spectator bot cards, emoji protocol, relay backlog.
const { checkEmojiPng, EMOJI_MAX, EMOJI_BYTES, EMOJI_DIM, EMOJI_GAP_MS } = require(path.join(__dirname, '..', 'server', 'room.js'));
const { RELAY_BACKLOG } = require(path.join(__dirname, '..', 'server', 'mp.js'));

test('spectators see every dealt seat, bots included (live); afterHand shows bots once the hand is over; players never see bot cards', async () => {
  const t = await start({ timing: SLOW });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-1001');
    const b = await connect(t.port, 'Ben', 'ben-client-1002');
    const c = await connect(t.port, 'Cy', 'cy-client-1003');
    t.room._setStack(c.seat, 0);
    t.room._changed({});
    await until(() => a.lobby && a.lobby.spectators.length === 1, 2000, 'spectator listed');
    a.send({ t: 'addBot', style: 'passive' });
    await until(() => a.lobby && a.lobby.players.length === 3 && a.lobby.players.some((p) => p.bot), 2000, 'bot added');
    const botSeat = a.lobby.players.find((p) => p.bot).seat;
    a.send({ t: 'start' });
    await until(() => c.state && c.state.hand && c.state.hand.toAct != null, 3000, 'hand running');
    const botForC = c.state.hand.seats.find((s) => s.seat === botSeat);
    assert.ok(botForC && botForC.inHand && botForC.cards && botForC.cards.length === 2, 'live: spectator sees the bot cards');
    const bForC = c.state.hand.seats.find((s) => s.seat === b.seat);
    assert.ok(bForC.cards && bForC.cards.length === 2, 'live: spectator sees the human cards');
    const botForA = a.state.hand.seats.find((s) => s.seat === botSeat);
    assert.strictEqual(botForA.cards, null, 'players never see bot cards while botShowCards is off');
    const bForA = a.state.hand.seats.find((s) => s.seat === b.seat);
    assert.strictEqual(bForA.cards, null, 'players never see another human hidden cards');
    a.send({ t: 'settings', spectatorCards: 'afterHand' });
    await until(() => c.lobby && c.lobby.settings.spectatorCards === 'afterHand', 2000, 'afterHand');
    const botNow = c.state.hand.seats.find((s) => s.seat === botSeat);
    if (!botNow.folded) assert.strictEqual(botNow.cards, null, 'afterHand: a live bot is hidden while the hand runs');
    a.close(); b.close(); c.close();
  } finally {
    await t.stop();
  }
});

test('emoji validator: PNG only, decoded <= 8 KB, IHDR dims 1..64, no APNG, well-formed chunks', () => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  const png = (w, h, opts) => {
    const o = opts || {};
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    const parts = [sig, chunk('IHDR', ihdr)];
    if (o.acTL) parts.push(chunk('acTL', Buffer.alloc(8)));
    parts.push(chunk('IDAT', Buffer.alloc(o.idat || 32)));
    if (!o.noEnd) parts.push(chunk('IEND', Buffer.alloc(0)));
    return Buffer.concat(parts);
  };
  const url = (buf) => 'data:image/png;base64,' + buf.toString('base64');
  const bad = (data, why) => assert.throws(() => checkEmojiPng(data), /bad emoji/, why);
  assert.doesNotThrow(() => checkEmojiPng(url(png(64, 64))), 'a 64x64 PNG is fine');
  assert.doesNotThrow(() => checkEmojiPng(url(png(1, 1))), 'a 1x1 PNG is fine');
  bad(url(png(65, 64)), 'width above 64');
  bad(url(png(64, 65)), 'height above 64');
  bad(url(png(0, 10)), 'zero width');
  bad(url(png(10, 10, { acTL: true })), 'APNG (acTL) refused');
  bad(url(png(10, 10, { noEnd: true })), 'no IEND chunk');
  bad(url(png(10, 10, { idat: 9000 })), 'decoded size above 8 KB');
  bad('data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64'), 'svg refused');
  bad('data:image/jpeg;base64,' + png(10, 10).toString('base64'), 'jpeg prefix refused');
  bad('data:image/png;base64,' + Buffer.from('not a png at all, plainly').toString('base64'), 'non-PNG bytes');
  bad('data:image/png;base64,@@@', 'bad base64');
  bad(42, 'not a string');
  assert.strictEqual(EMOJI_MAX, 12);
  assert.strictEqual(EMOJI_BYTES, 8192);
  assert.strictEqual(EMOJI_DIM, 64);
  assert.strictEqual(EMOJI_GAP_MS, 2000);
});

// Emoji over the socket: one room per case (each case uses a fresh connection, no rate-limit overlap).
const PNG_OK = (() => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(16, 0); ihdr.writeUInt32BE(16, 4); ihdr[8] = 8; ihdr[9] = 6;
  return 'data:image/png;base64,' + Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', Buffer.alloc(32)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
})();
const emo = (id, data) => ({ id: id, data: data === undefined ? PNG_OK : data });

async function emojiCase(name, emojis, expectErr) {
  const t = await start();
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-1101');
    a.send({ t: 'emojiSet', emojis: emojis });
    await until(() => a.errors.length >= 1 || a.msgs.some((m) => m.t === 'emojiPack'), 2000, name);
    assert.deepStrictEqual(a.errors, expectErr ? [expectErr] : [], name);
    a.close();
  } finally {
    await t.stop();
  }
}

test('emoji validation over the socket: bad id, duplicate id, svg, too many, oversize, APNG, bad dims', async () => {
  await emojiCase('bad id (uppercase)', [emo('Smile')], 'bad emoji');
  await emojiCase('bad id (too long)', [emo('abcdefghijklmn')], 'bad emoji');
  await emojiCase('duplicate id', [emo('x'), emo('x')], 'bad emoji');
  await emojiCase('svg', [emo('svg', 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64'))], 'bad emoji');
  await emojiCase('thirteen', Array.from({ length: 13 }, (_, i) => emo('e' + i)), 'too many emojis');
  await emojiCase('valid twelve accepted', Array.from({ length: 12 }, (_, i) => emo('e' + i)), null);
  await emojiCase('not an array', 'nope', 'bad emoji');
  await emojiCase('valid set accepted', [emo('ok_1')], null);
});

test('emoji: rate limit (1 per 2 s), replace-the-whole-set, packs broadcast and delivered to joiners, emojiGet', async () => {
  const t = await start();
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-1201');
    const b = await connect(t.port, 'Ben', 'ben-client-1202');
    a.send({ t: 'emojiSet', emojis: [emo('one')] });
    await until(() => b.msgs.some((m) => m.t === 'emojiPack' && m.clientId === 'ann-client-1201'), 2000, 'broadcast to others');
    a.send({ t: 'emojiSet', emojis: [emo('two')] });
    await until(() => a.errors.includes('slow down'), 2000, 'rate limit');
    await new Promise((r) => setTimeout(r, EMOJI_GAP_MS + 50));
    a.send({ t: 'emojiSet', emojis: [emo('two')] });
    await until(() => b.msgs.filter((m) => m.t === 'emojiPack' && m.clientId === 'ann-client-1201').slice(-1)[0].emojis[0].id === 'two', 2000, 'replaced set');
    const c = await connect(t.port, 'Cy', 'cy-client-1203');
    await until(() => c.msgs.some((m) => m.t === 'emojiPack' && m.clientId === 'ann-client-1201'), 2000, 'joiner gets existing packs');
    const sentToC = c.msgs.filter((m) => m.t === 'emojiPack' && m.clientId === 'ann-client-1201').slice(-1)[0];
    assert.deepStrictEqual(sentToC.emojis.map((e) => e.id), ['two'], 'the joiner gets the current set');
    assert.ok(!c.msgs.some((m) => m.t === 'emojiPack' && m.clientId === 'ben-client-1202'), 'no pack for a player with none');
    c.send({ t: 'emojiGet', clientIds: ['ann-client-1201', 'nobody-here-0000'] });
    await until(() => c.msgs.some((m) => m.t === 'emojiPacks'), 2000, 'emojiPacks');
    const reply = c.msgs.find((m) => m.t === 'emojiPacks');
    assert.deepStrictEqual(reply.packs['ann-client-1201'].map((e) => e.id), ['two']);
    assert.deepStrictEqual(reply.packs['nobody-here-0000'], []);
    a.close(); b.close(); c.close();
  } finally {
    await t.stop();
  }
});

test('emoji: a bot or unseated socket cannot set emoji; emojiGet is allowed while paused', async () => {
  const t = await start({ timing: SLOW });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-1301');
    const b = await connect(t.port, 'Ben', 'ben-client-1302');
    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand, 3000);
    a.send({ t: 'pause' });
    await until(() => a.state.paused, 2000, 'paused');
    b.send({ t: 'emojiGet', clientIds: ['ann-client-1301'] });
    await until(() => b.msgs.some((m) => m.t === 'emojiPacks'), 2000, 'emojiGet while paused');
    const raw = new WebSocket('ws://127.0.0.1:' + t.port + '/ws');
    await new Promise((r, j) => { raw.on('open', r); raw.on('error', j); });
    raw.send(JSON.stringify({ t: 'emojiSet', emojis: [] }));
    await new Promise((r) => setTimeout(r, 100));
    raw.close();
    a.close(); b.close();
  } finally {
    await t.stop();
  }
});

test('relay backlog: a receiver with 64 KB+ queued misses video, but game JSON still arrives', async () => {
  assert.strictEqual(RELAY_BACKLOG, 64 * 1024, 'backlog is 64 KB');
  const t = await start();
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-1401');
    const b = await connect(t.port, 'Ben', 'ben-client-1402');
    const serverB = [...t.room.conns].find((c) => c.clientId === 'ben-client-1402').ws;
    Object.defineProperty(serverB, 'bufferedAmount', { get: () => RELAY_BACKLOG + 1, configurable: true });
    const dropped0 = t.server.multiplayer.stats.relayDropped;
    a.ws.send(Buffer.from([1, 9, 9, 9, 9]), { binary: true });
    await until(() => t.server.multiplayer.stats.relayDropped > dropped0, 2000, 'frame dropped for the backed-up receiver');
    assert.strictEqual(b.binary.length, 0, 'no video frame reached the backed-up receiver');
    a.send({ t: 'chat', text: 'still here' });
    await until(() => b.msgs.some((m) => m.t === 'chat' && m.text === 'still here'), 2000, 'JSON still delivered');
    delete serverB.bufferedAmount;
    a.close(); b.close();
  } finally {
    await t.stop();
  }
});

test('seat hijack: a public clientId without the seat token cannot take the seat over', async () => {
  const t = await start();
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0099');
    const token = a.welcome.you.token;
    assert.ok(token && token.length >= 20, 'welcome carries a secret token');
    const m = await new Client(t.port).open();
    m.send({ t: 'join', name: 'Mallory', clientId: 'ann-client-0099' });
    await until(() => m.errors.length === 1, 3000, 'refusal');
    assert.match(m.errors[0], /belongs to another player/);
    const m2 = await new Client(t.port).open();
    m2.send({ t: 'join', name: 'Mallory', clientId: 'ann-client-0099', token: 'x'.repeat(24) });
    await until(() => m2.errors.length === 1, 3000, 'refusal 2');
    assert.strictEqual(a.errors.length, 0, 'the owner is not evicted');
    assert.ok(!m.welcome && !m2.welcome);
    a.close();
    await new Promise((r) => setTimeout(r, 200));
    const back = await connect(t.port, 'Ann', 'ann-client-0099');
    assert.strictEqual(back.welcome.you.seat, 0, 'the owner reclaims with the token');
    back.close(); m.close(); m2.close();
  } finally {
    await t.stop();
  }
});

// Room-level driver: a fake connection that records what the room sends.
function fakeConn(room) {
  const conn = { sent: [], send(o) { this.sent.push(o); }, close() {} };
  room.connect(conn);
  return conn;
}

test('abandoned seats: a dropped human is freed after abandonedMs and the ledger holds; a quick reclaim keeps the seat', async () => {
  const t = await start({ timing: Object.assign({}, SLOW, { abandonedMs: 400 }) });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0501');
    const b = await connect(t.port, 'Ben', 'ben-client-0502');
    const bSeat = b.seat;
    b.close();
    await until(() => t.room.recs[bSeat] && !t.room.recs[bSeat].conn, 2000, 'b dropped');
    await new Promise((r) => setTimeout(r, 150));
    const b2 = await connect(t.port, 'Ben', 'ben-client-0502');
    assert.strictEqual(b2.seat, bSeat, 'reclaimed within abandonedMs');
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(t.room.recs[bSeat] && t.room.recs[bSeat].conn, 'a connected player is never freed');
    b2.close();
    await until(() => t.room.recs[bSeat] && !t.room.recs[bSeat].conn, 2000, 'b dropped again');
    await until(() => t.room.recs[bSeat] === null, 2000, 'seat freed after abandonedMs');
    assert.strictEqual(t.room.recs[a.seat].clientId, 'ann-client-0501', 'the connected player keeps the seat');
    assert.strictEqual(t.room.netChips, t.room.chipsInPlay(), 'ledger holds after the seat is freed');
    assert.strictEqual(t.room.table.seats[bSeat].stack, 0, 'chips left the table');
    a.close();
  } finally {
    await t.stop();
  }
});

test('abandoned seats: a seat dealt into a running hand is held until the hand ends', async () => {
  const t = await start({ timing: Object.assign({}, SLOW, { abandonedMs: 200 }) });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0511');
    const b = await connect(t.port, 'Ben', 'ben-client-0512');
    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand, 3000, 'hand');
    const bSeat = b.seat;
    b.close();
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(t.room.recs[bSeat], 'held while the hand runs');
    assert.ok(t.room.table.hand.seats[bSeat].dealt, 'the seat is dealt in');
    a.close();
  } finally {
    await t.stop();
  }
});

test('full room: a newcomer takes the oldest abandoned seat; connected players are never displaced', async () => {
  const t = await start({ timing: Object.assign({}, SLOW, { abandonedMs: 60000 }) });
  try {
    const cs = [];
    for (let i = 0; i < 6; i++) cs.push(await connect(t.port, 'P' + i, 'player-client-06' + i));
    const late = await new Client(t.port).open();
    late.send({ t: 'join', name: 'Late', clientId: 'late-client-0601' });
    await until(() => late.errors.length === 1, 2000, 'room full');
    assert.match(late.errors[0], /room is full/);
    assert.ok(cs.every((c) => t.room.recs[c.seat] && t.room.recs[c.seat].conn), 'all six still seated and connected');
    const seats = cs.map((c) => c.seat);
    cs[1].close();
    cs[3].close();
    await until(() => !t.room.recs[seats[1]].conn && !t.room.recs[seats[3]].conn, 2000, 'two drops');
    // Both are abandoned; seat 1 has been away longer, so it is the oldest.
    t.room.recs[seats[1]].droppedAt -= 120000;
    t.room.recs[seats[3]].droppedAt -= 30000;   // away 30 s: not abandoned yet
    const n = await connect(t.port, 'New', 'new-client-0602');
    assert.strictEqual(n.seat, seats[1], 'takes the oldest abandoned seat');
    assert.strictEqual(t.room.recs[seats[1]].clientId, 'new-client-0602');
    assert.ok(t.room.recs[seats[3]] && t.room.recs[seats[3]].clientId === 'player-client-063', 'the newer abandoned seat is untouched');
    assert.strictEqual(t.room.netChips, t.room.chipsInPlay(), 'ledger holds after the takeover');
    n.close(); late.close(); cs.forEach((c) => c.close());
  } finally {
    await t.stop();
  }
});

test('avatar size is the exact decoded size: 65536 bytes accepted, 65537 refused', () => {
  const room = new Room({ timing: FAST, diagFile: false });
  const enc = (n) => 'data:image/jpeg;base64,' + Buffer.alloc(n, 7).toString('base64');
  const c1 = fakeConn(room);
  room.receive(c1, { t: 'join', name: 'Ann', clientId: 'ann-avatar-01', avatar: enc(65536) });
  assert.ok(c1.sent.some((m) => m.t === 'welcome'), 'exactly 64 KB is accepted');
  const c2 = fakeConn(room);
  room.receive(c2, { t: 'join', name: 'Ben', clientId: 'ben-avatar-01', avatar: enc(65537) });
  assert.ok(c2.sent.some((m) => m.t === 'error' && /64 KB/.test(m.msg)), '64 KB + 1 byte is refused');
  assert.ok(!c2.sent.some((m) => m.t === 'welcome'));
  room.dispose();
});

test('a 300 KB JSON frame gets the app-level "message too large" error and the socket stays open', async () => {
  const t = await start();
  try {
    const c = await new Client(t.port).open();
    c.send({ t: 'chat', text: 'x'.repeat(300 * 1024) });
    await until(() => c.errors.includes('message too large'), 3000, 'too large');
    assert.ok(!c.closed, 'socket stays open');
    c.send({ t: 'ping', ts: 5 });
    await until(() => c.msgs.some((m) => m.t === 'pong' && m.ts === 5), 2000, 'pong after oversize frame');
    c.close();
  } finally {
    await t.stop();
  }
});

test('emoji packs: a seatless clientId is pruned after emojiGoneMs; at most 40 packs are kept', async () => {
  const room = new Room({ timing: Object.assign({}, FAST, { emojiGoneMs: 200 }), diagFile: false });
  const a = fakeConn(room);
  room.receive(a, { t: 'join', name: 'Ann', clientId: 'ann-emoji-0001' });
  room.receive(a, { t: 'emojiSet', emojis: [emo('smile')] });
  assert.ok(room.emojis.has('ann-emoji-0001'));
  room._vacate(a.seat);
  await new Promise((r) => setTimeout(r, 250));
  const b = fakeConn(room);
  room.receive(b, { t: 'join', name: 'Ben', clientId: 'ben-emoji-0002' });
  assert.ok(!room.emojis.has('ann-emoji-0001'), 'gone for longer than emojiGoneMs: pruned');
  for (let i = 0; i < 45; i++) room.emojis.set('gone-' + i, { emojis: [], seenAt: Date.now() - i });
  const c = fakeConn(room);
  room.receive(c, { t: 'join', name: 'Cy', clientId: 'cy-emoji-0003' });
  assert.ok(room.emojis.size <= 40, 'capped at 40 packs');
  assert.ok(!room.emojis.has('gone-44') && room.emojis.has('gone-0'), 'the least recently seen goes first');
  room.dispose();
});

test('reconnect during a hand with the same clientId and token keeps the remaining turn clock', async () => {
  const t = await start({ timing: { botDelay: [1, 3], actionMs: 8000, disconnectMs: 60000, nextHandMs: 60000, disconnectGraceMs: 50 } });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0701');
    const b = await connect(t.port, 'Ben', 'ben-client-0702');
    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand && a.state.hand.toAct != null, 3000, 'hand');
    await new Promise((r) => setTimeout(r, 1000));
    const onTurn = a.state.hand.toAct === a.seat ? a : b;
    const [name, id] = onTurn === a ? ['Ann', 'ann-client-0701'] : ['Ben', 'ben-client-0702'];
    assert.strictEqual(t.room._turn.seat, onTurn.seat, 'the clock belongs to the player who drops');
    const before = t.room._leftOf(t.room._turn);
    assert.ok(before > 0 && before < 7500, 'the clock is already running down');
    onTurn.close();
    await until(() => t.room.recs[onTurn.seat] && !t.room.recs[onTurn.seat].conn, 2000, 'dropped');
    await new Promise((r) => setTimeout(r, 300));
    const back = await connect(t.port, name, id);
    assert.strictEqual(back.seat, onTurn.seat, 'same seat');
    await until(() => back.state && back.state.hand, 3000, 'state after reconnect');
    const after = back.state.hand.turnLeftMs;
    assert.ok(after <= before, 'no fresh full clock');
    assert.ok(after >= before - 2000, 'the remaining clock is kept, not reset');
    back.close(); (onTurn === a ? b : a).close();
  } finally {
    await t.stop();
  }
});

// Busted bots leave for good (never refilled); humans who bust stay seated as spectators; the
// ledger holds through all of it.
test('bots: a busted bot leaves its seat for good and never returns with chips; humans bust to spectators', async () => {
  const t = await start({ seed: 31, timing: FAST });
  const rng = rngFrom(4242);
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0701');
    const b = await connect(t.port, 'Ben', 'ben-client-0702');
    attachDriver(a, rng); attachDriver(b, rng);
    for (let i = 0; i < 4; i++) a.send({ t: 'addBot', style: ['tight', 'loose', 'aggressive', 'passive'][i] });
    await until(() => a.lobby && a.lobby.players.length === 6, 3000, 'four bots seated');
    a.send({ t: 'settings', stacks: 'custom' });
    await until(() => a.lobby.settings.stacks === 'custom', 3000);
    rawStacks(t, { 0: 20000, 1: 20000, 2: 1000, 3: 1000, 4: 1500, 5: 1500 });
    await until(() => a.lobby.players.find((p) => p.seat === 5).stack === 1500, 3000, 'short stacks');
    const busted = new Map();      // seat -> id of the hand it busted in
    const badReturn = [];
    a.listeners.push(() => {
      const h = a.state && a.state.hand;
      if (!h) return;
      // Only hands dealt after the bust count (earlier messages may still show the old hand).
      for (const [seat, bustedIn] of busted) {
        if (h.id > bustedIn && h.seats.some((s) => s.seat === seat)) badReturn.push('seat ' + seat + ' came back in hand ' + h.id);
      }
    });
    const bots = [2, 3, 4, 5];
    a.send({ t: 'start' });
    await until(() => {
      for (const seat of bots) {
        if (!busted.has(seat) && t.room.recs[seat] === null) busted.set(seat, t.room.table.hand ? t.room.table.hand.no : 0);
      }
      return busted.size >= 2 || (a.state && a.state.hand && a.state.hand.id > 300);
    }, 60000, 'two bots bust');
    assert.ok(busted.size >= 2, 'at least two bots busted by hand ' + (a.state && a.state.hand && a.state.hand.id));
    // Stop dealing: the next hand is armed far away, so once the running hand ends the table holds
    // still at a hand boundary and the state can be checked without racing a new deal.
    t.room.timing.nextHandMs = 600000;
    t.room._clearNext();
    await until(() => !t.room._handActive(), 20000, 'the hand ends after the busts');
    // The busted seats must stay empty.
    for (const seat of busted.keys()) {
      assert.strictEqual(t.room.recs[seat], null, 'busted bot seat ' + seat + ' is free');
      assert.strictEqual(t.room.table.seats[seat].stack, 0, 'no chips on busted seat ' + seat);
    }
    assert.deepStrictEqual(badReturn, [], 'a busted bot never came back');
    // The lobby message trails the server by one broadcast: wait until it matches the server's lists.
    const seatsOf = (list) => JSON.stringify(list.map((s) => s.seat).sort());
    await until(() => seatsOf(a.lobby.players) === seatsOf(t.room._players()) &&
      seatsOf(a.lobby.spectators) === seatsOf(t.room._spectators()), 3000, 'lobby matches the server');
    assert.ok(!a.lobby.players.some((p) => busted.has(p.seat)), 'busted seats are not in the lobby');
    // Humans stay seated. A human is a spectator exactly when the server says it is out of the hand
    // (no chips and not dealt in the last hand); an all-in human with zero stack is still playing.
    for (const c of [a, b]) {
      assert.ok(t.room.recs[c.seat] && t.room.recs[c.seat].conn, 'a human stays seated');
      const out = t.room._isOut(c.seat);
      assert.strictEqual(a.lobby.spectators.some((s) => s.seat === c.seat), out, 'human ' + c.seat + ' spectator flag matches the server');
    }
    assert.strictEqual(t.room.netChips, t.room.chipsInPlay(), 'ledger matches after busts');
    a.close(); b.close();
  } finally {
    await t.stop();
  }
});

// Admin kicks mid-hand: removed from the lobby at once, the socket closed, the seat held until the
// hand ends, the chips in the pot stay there, no second kick later, no rejoin with the old token.
async function kickMidHand(who) {
  const t = await start({ seed: 41, timing: SLOW });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0801');
    const b = await connect(t.port, 'Ben', 'ben-client-0802');
    const c = await connect(t.port, 'Cy', 'cy-client-0803');
    let armed = who !== 'acting'; // 'acting': guests hold their turn until the kick is sent, so a guest stays on turn
    for (const p of [a, b, c]) {   // every player calls on their own turn so the hand moves on
      p.listeners.push(() => {
        const h = p.state && p.state.hand;
        if (p !== a && !armed) return;
        if (h && h.toAct === p.seat && h.legal && !h.over) p.send({ t: 'act', action: 'call', turn: h.id + '|' + h.street + '|' + h.toAct });
      });
    }
    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand && a.state.hand.toAct != null, 3000, 'hand running');
    let target;
    if (who === 'host') {
      a.send({ t: 'kick', seat: a.seat });
      await until(() => a.errors.includes('cannot kick yourself'), 3000, 'host refused');
      assert.ok(t.room.recs[a.seat] && !t.room.recs[a.seat].kickPending, 'the host is not kicked');
      a.close(); b.close(); c.close();
      return;
    }
    if (who === 'acting') {
      // Wait for a guest to be on turn (the host calls on its own turn).
      await until(() => [b, c].some((p) => p.seat === a.state.hand.toAct), 3000, 'a guest to act');
      target = [b, c].find((p) => p.seat === a.state.hand.toAct);
    } else {
      target = [b, c].find((p) => p.seat !== a.state.hand.toAct);
    }
    const tseat = target.seat, tid = target.clientId, tok = SEAT_TOKENS.get(t.port + ':' + tid);
    const wasActing = a.state.hand.toAct === tseat;
    // The rejoin attempt and the second kick go out in the same tick as the kick: the hand may end fast.
    const again = await new Client(t.port).open();
    a.send({ t: 'kick', seat: tseat });
    a.send({ t: 'kick', seat: tseat });
    armed = true;
    again.send({ t: 'join', name: 'Ben', clientId: tid, token: tok });
    await until(() => target.closed, 3000, 'kicked socket closed');
    assert.ok(target.kicked && target.kicked.reason === 'host', 'kicked message');
    // Checked in the message history: the leaving lobby is sent with the kick itself, before the hand can end,
    // so a fast hand (every seat calling) can no longer free the seat before this check runs.
    await until(() => a.msgs.some((m) => m.t === 'lobby' && m.players.some((p) => p.seat === tseat && p.leaving === true)), 3000, 'marked leaving in the lobby');
    await until(() => again.errors.length === 1, 3000, 'rejoin refused');
    assert.strictEqual(again.errors[0], 'you were removed by the host');
    again.close();
    await until(() => a.errors.includes('that player is already leaving') || a.errors.includes('no player at that seat'), 3000, 'second kick refused');
    assert.ok(!a.errors.includes('that player is already leaving') || t.room.table.hand, 'second kick only while the hand runs');
    if (t.room.recs[tseat] === null) assert.ok(!t.room.table.hand || t.room.table.hand.over, 'a seat is freed only after the hand');
    if (wasActing && t.room.table.hand) {
      // The kicked player was to act: they fold on the zero clock; the hand moves on without them.
      await until(() => !t.room.table.hand || t.room.table.hand.over || t.room.table.hand.seats[tseat].folded, 3000, 'kicked player folded');
    }
    await until(() => t.room.table.hand && t.room.table.hand.over, 20000, 'hand ends');
    await until(() => t.room.recs[tseat] === null, 3000, 'seat freed after the hand');
    // The server frees the seat before the lobby broadcast reaches the client: wait on the client's view.
    await until(() => !a.lobby.players.some((p) => p.seat === tseat), 3000, 'lobby drops the player');
    assert.strictEqual(t.room.netChips, t.room.chipsInPlay(), 'ledger holds after the kick');
    assert.strictEqual(a.errors.filter((e) => /removed|kicked/.test(e)).length, 0, 'the host got no error');
    assert.ok(!a.lobby.players.some((p) => p.seat === tseat), 'gone from the lobby after the hand');
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(t.room.recs[tseat], null, 'no second kick at the next deal');
    a.close(); b.close(); c.close();
  } finally {
    await t.stop();
  }
}
test('kick mid-hand: the player to act is marked leaving, folds, and leaves when the hand ends', () => kickMidHand('acting'));
test('kick mid-hand: a player not to act is marked leaving and their seat is freed after the hand', () => kickMidHand('nonacting'));
test('kick mid-hand: the host cannot kick itself', () => kickMidHand('host'));

// Names are never identifiers: two players with the same name are told apart by clientId and seat.
test('names are not identifiers: identical names kick, chat and emoji address the right player', async () => {
  const t = await start({ seed: 51, timing: SLOW });
  try {
    const a = await connect(t.port, 'Same', 'same-client-0901');
    const b = await connect(t.port, 'Same', 'same-client-0902');
    const c = await connect(t.port, 'Same', 'same-client-0903');
    assert.notStrictEqual(a.seat, b.seat);
    b.send({ t: 'chat', text: 'hola' });
    await until(() => a.msgs.some((m) => m.t === 'chat' && m.text === 'hola'), 2000, 'chat');
    const chat = a.msgs.find((m) => m.t === 'chat' && m.text === 'hola');
    assert.strictEqual(chat.from, b.clientId, 'chat is attributed by clientId');
    b.send({ t: 'emojiSet', emojis: [] });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!a.msgs.some((m) => m.t === 'emojiPack' && m.clientId === c.clientId), 'no pack for the other Same');
    a.send({ t: 'kick', seat: c.seat });
    await until(() => c.closed, 3000, 'c kicked');
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(t.room.recs[b.seat] && t.room.recs[b.seat].conn, 'b is untouched');
    assert.ok(t.room.recs[a.seat] && t.room.recs[a.seat].conn, 'a is untouched');
    assert.ok(!b.closed && !a.closed, 'only the kicked socket was closed');
    // cleanName: control characters stripped, trimmed, collapsed; 1-16 characters.
    const d = await connect(t.port, '\u0007  Dee\u0001 ', 'dee-client-0904');
    assert.strictEqual(t.room.recs[d.seat].name, 'Dee', 'sanitised name');
    d.send({ t: 'profile', name: 'x'.repeat(17) });
    await until(() => d.errors.length === 1, 2000, 'long name refused');
    assert.match(d.errors[0], /1-16 characters/);
    a.close(); b.close(); d.close();
  } finally {
    await t.stop();
  }
});

test('last-action labels: every seat shows its last real action of the street, matching hand.history; blinds never; reset at each street', async () => {
  const t = await start({ seed: 311, timing: FAST });
  const rng = rngFrom(311);
  const room = t.room;
  const orig = room._changed.bind(room);
  const stats = { checks: 0, labels: {}, hands: new Set(), bad: [] };
  // Checked synchronously after every change, so the room state and the hand history agree.
  room._changed = function (opts) {
    const hand = this.table.hand;
    if (hand) {
      stats.hands.add(hand.no);
      const hist = hand.history || [];
      for (let seat = 0; seat < 9; seat++) {
        if (!this.recs[seat]) continue;
        const text = this._lastActionText(seat);
        const mine = hist.filter((h) => h.seat === seat && h.street === hand.street);
        const last = mine[mine.length - 1];
        stats.checks++;
        if (!last) {
          if (text !== '') stats.bad.push('hand ' + hand.no + ' seat ' + seat + ' ' + hand.street + ': shows "' + text + '" with no action this street');
          continue;
        }
        const word = text.split(' ')[0];
        stats.labels[last.action] = (stats.labels[last.action] || 0) + 1;
        if (word !== last.action) stats.bad.push('hand ' + hand.no + ' seat ' + seat + ' ' + hand.street + ': shows "' + text + '" but history says ' + last.action);
      }
    }
    return orig(opts);
  };
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0311');
    a.send({ t: 'addBot', style: 'tight' });
    a.send({ t: 'addBot', style: 'aggressive' });
    a.send({ t: 'addBot', style: 'balanced' });
    await until(() => a.lobby && a.lobby.players.length === 4, 3000, 'four seats');
    attachDriver(a, rng);
    a.send({ t: 'start' });
    await until(() => stats.hands.size >= 40, 90000, '40 hands');
    assert.deepStrictEqual(stats.bad.slice(0, 5), [], stats.bad.length + ' mismatches; first: ' + stats.bad[0]);
    assert.ok(stats.checks > 200, 'seats were checked (' + stats.checks + ')');
    ['raise', 'call', 'check', 'fold'].forEach((k) => assert.ok(stats.labels[k] > 0, 'saw a ' + k + ' label'));
    a.close();
  } finally {
    room._changed = orig;
    await t.stop();
  }
});

test('showHand mid-hand: only folded and out viewers see the cards; active players never do', async () => {
  const t = await start({ timing: SLOW });
  try {
    const cs = [];
    const ids = ['ann', 'ben', 'cy', 'dan'];
    for (let i = 0; i < 4; i++) cs.push(await connect(t.port, ids[i][0].toUpperCase() + ids[i].slice(1), ids[i] + '-client-0601'));
    const [c0] = cs;
    c0.send({ t: 'start' });
    await until(() => c0.state && c0.state.hand && c0.state.hand.toAct != null, 3000, 'hand running');
    const turn = () => cs.find((x) => x.seat === c0.state.hand.toAct);
    const seatOf = (x) => x.state.hand.seats[x.seat];
    // The first to act folds: he becomes an observer.
    const folder = turn();
    folder.send({ t: 'act', action: 'fold' });
    await until(() => cs.every((x) => x.state.hand.seats[folder.seat].folded), 3000, 'fold seen');
    // An active player shows mid-hand.
    const shower = turn();
    shower.send({ t: 'showHand' });
    await until(() => folder.state.hand.seats[shower.seat].cards && folder.state.hand.seats[shower.seat].cards.length === 2, 3000, 'folded viewer sees the shown cards');
    const others = cs.filter((x) => x !== folder && x !== shower);
    const [p, q] = others;
    assert.strictEqual(folder.state.hand.seats[shower.seat].shownTo, 'observers', 'observers see the marker');
    assert.strictEqual(seatOf(shower).shownTo, 'observers', 'the shower sees the marker too');
    assert.strictEqual(seatOf(shower).shown, false, 'mid-hand show is not the public reveal flag');
    for (const x of [p, q]) {
      const sh = x.state.hand.seats[shower.seat];
      assert.strictEqual(sh.cards, null, 'active player ' + x.seat + ' sees no shown cards');
      assert.strictEqual(sh.shownTo, undefined, 'active player gets no marker');
      assert.strictEqual(sh.shown, false, 'active player gets no shown flag');
      assert.strictEqual(x.state.hand.seats[folder.seat].shown, false, 'no reveal for the folder');
    }
    // An active player who later folds starts to see the shown cards.
    const late = p;
    for (let i = 0; i < 8 && !late.state.hand.over && late.state.hand.toAct !== late.seat; i++) {
      const prev = late.state.hand.toAct;
      cs.find((x) => x.seat === prev).send({ t: 'act', action: 'call' });
      await until(() => late.state.hand.toAct !== prev || late.state.hand.over, 3000, 'call applied');
    }
    assert.strictEqual(late.state.hand.toAct, late.seat, 'the late player is on turn');
    late.send({ t: 'act', action: 'fold' });
    await until(() => late.state.hand.seats[late.seat].folded && late.state.hand.seats[shower.seat].cards, 3000, 'late fold');
    await until(() => late.state.hand.seats[shower.seat].cards && late.state.hand.seats[shower.seat].cards.length === 2, 3000, 'late folder sees the shown cards');
    assert.strictEqual(late.state.hand.seats[shower.seat].shownTo, 'observers');
    cs.forEach((x) => x.close());
  } finally {
    await t.stop();
  }
});

test('removeBot mid-hand is accepted: no error, the bot leaves when the hand ends', async () => {
  const t = await start({ timing: SLOW });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0701');
    const b = await connect(t.port, 'Ben', 'ben-client-0702');
    a.send({ t: 'addBot', style: 'tight' });
    await until(() => a.state && a.lobby && a.lobby.players.some((p) => p.bot), 3000, 'bot added');
    const botSeat = a.lobby.players.find((p) => p.bot).seat;
    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand && a.state.hand.toAct != null, 3000, 'hand running');
    const dealt = a.state.hand.seats[botSeat].inHand;
    assert.ok(dealt, 'the bot is dealt in');
    a.send({ t: 'removeBot', seat: botSeat });
    await new Promise((r) => setTimeout(r, 200));
    assert.deepStrictEqual(a.errors, [], 'no error message for a mid-hand removal');
    assert.ok(a.lobby.players.some((p) => p.seat === botSeat && p.leaving), 'the bot is marked leaving');
    // The two humans fold whenever it is their turn (the bot acts on its own); the hand then ends.
    for (let i = 0; i < 20 && !(a.state.hand && a.state.hand.over); i++) {
      await until(() => a.state.hand && (a.state.hand.over || a.state.hand.toAct === 0 || a.state.hand.toAct === 1), 3000, 'a human to act');
      if (a.state.hand.over) break;
      (a.state.hand.toAct === 0 ? a : b).send({ t: 'act', action: 'fold' });
      await new Promise((r) => setTimeout(r, 50));
    }
    await until(() => a.state.hand && a.state.hand.over, 3000, 'hand over');
    await until(() => !a.lobby.players.some((p) => p.seat === botSeat), 3000, 'bot removed at hand end');
    assert.deepStrictEqual(a.errors, [], 'still no error');
    a.close(); b.close();
  } finally {
    await t.stop();
  }
});

test('late join during a hand: waiting until the next deal includes him, not cleared at hand end', async () => {
  const t = await start({ timing: SLOW });
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0801');
    const b = await connect(t.port, 'Ben', 'ben-client-0802');
    a.send({ t: 'start' });
    await until(() => a.state && a.state.hand && a.state.hand.toAct != null, 3000, 'hand running');
    const c = await connect(t.port, 'Cy', 'cy-client-0803');
    const cy = () => a.lobby && a.lobby.players.find((p) => p.name === 'Cy');
    await until(() => cy() && cy().seat === 2, 3000, 'Cy seated');
    assert.strictEqual(cy().waiting, true, 'waiting while the hand runs');
    for (let i = 0; i < 30 && !(a.state.hand && a.state.hand.over); i++) {
      await until(() => a.state.hand && (a.state.hand.over || a.state.hand.toAct === 0 || a.state.hand.toAct === 1), 3000, 'a human to act');
      if (a.state.hand.over) break;
      (a.state.hand.toAct === 0 ? a : b).send({ t: 'act', action: 'fold' });
      await new Promise((r) => setTimeout(r, 50));
    }
    await until(() => a.state.hand && a.state.hand.over, 3000, 'hand over');
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(cy().waiting, true, 'still waiting at hand end: not dealt yet');
    a.send({ t: 'start' });
    // The state lists only the seats dealt into the hand (no 'dealt' flag): Cy is dealt in when seat 2 appears.
    await until(() => a.state.hand && !a.state.hand.over && a.state.hand.seats.some((s) => s.seat === 2), 3000, 'Cy dealt in');
    assert.strictEqual(cy().waiting, false, 'no longer waiting once dealt in');
    a.close(); b.close(); c.close();
  } finally {
    await t.stop();
  }
});

// ------------------------------------------------- elimination (under 1 BB), chips and soak
// Plays one hand to its end from the lobby: the host starts it, the drivers play it out.
async function playHand(a, t) {
  const no = t.room.table.hand ? t.room.table.hand.no : 0;
  a.send({ t: 'start' });
  await until(() => t.room.table.hand && t.room.table.hand.no > no, 3000, 'hand dealt');
  await until(() => !t.room._handActive(), 30000, 'hand ends');
}

// Counts the chips a bot takes out of the game when it is removed (the stack it leaves with).
function trackRemovedChips(room) {
  const tracked = { chips: 0, bots: [] };
  const orig = room._vacate.bind(room);
  room._vacate = (seat) => {
    const rec = room.recs[seat];
    if (rec && rec.bot) { tracked.chips += room.table.seats[seat].stack; tracked.bots.push(rec.name); }
    orig(seat);
  };
  return tracked;
}

async function seatTwoHumansAndBots(t, a, b, botStyles, botStack) {
  for (let i = 0; i < botStyles.length; i++) a.send({ t: 'addBot', style: botStyles[i] });
  await until(() => a.lobby && a.lobby.players.length === 2 + botStyles.length, 3000, 'bots seated');
  a.send({ t: 'settings', stacks: 'custom' });
  await until(() => a.lobby.settings.stacks === 'custom', 3000);
  const stacks = { 0: 20000, 1: 20000 };
  botStyles.forEach((_, i) => { stacks[2 + i] = botStack; });
  rawStacks(t, stacks);
  await until(() => a.lobby.players.find((p) => p.seat === 2).stack === botStack, 3000, 'bot stacks');
}
// Test setup only: sets seat stacks directly, below the 5 BB rule that setStacks enforces, because the
// elimination tests need sub-BB stacks. Keeps the chip ledger (_setStack) and broadcasts the lobby.
function rawStacks(t, stacks) {
  for (const k of Object.keys(stacks)) {
    const seat = Number(k), amount = stacks[k];
    t.room.recs[seat].startStack = amount;
    t.room._setStack(seat, amount);
  }
  t.room._changed({});
}

test('elimination: a bot under 1 BB is removed at hand end with a botOut chat line; the table goes on; chips conserved', async () => {
  const t = await start({ seed: 77, timing: FAST });
  const rng = rngFrom(777);
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0901');
    const b = await connect(t.port, 'Ben', 'ben-client-0902');
    attachDriver(a, rng); attachDriver(b, rng);
    await seatTwoHumansAndBots(t, a, b, ['tight', 'loose'], 1000);
    const botSeats = [2, 3];
    const names = {};
    botSeats.forEach((s) => { names[s] = t.room.recs[s].name; });
    t.room.timing.nextHandMs = 600000;   // the table holds at each hand boundary; the test deals each hand
    const tracked = trackRemovedChips(t.room);
    const total0 = t.room.chipsInPlay();
    let dead;
    for (let i = 0; i < 60 && dead === undefined; i++) {
      await playHand(a, t);
      assert.strictEqual(t.room.chipsInPlay() + tracked.chips, total0, 'chips conserved after hand ' + i);
      dead = botSeats.find((s) => t.room.recs[s] === null);
    }
    assert.ok(dead !== undefined, 'a bot busted within 60 hands');
    assert.strictEqual(t.room.table.seats[dead].stack, 0, 'seat vacated, no chips left on it');
    assert.ok(tracked.bots.indexOf(names[dead]) >= 0, 'the removal went through _vacate at hand end');
    const entries = t.room.chat.filter((e) => e.kind === 'botOut');
    assert.strictEqual(entries.length, 1, 'one botOut chat entry');
    assert.strictEqual(entries[0].name, names[dead]);
    assert.strictEqual(entries[0].system, true);
    await until(() => a.msgs.some((m) => m.t === 'chat' && m.kind === 'botOut' && m.name === names[dead]), 3000, 'botOut reaches the client');
    // The table continues: humans are still seated and the next hand deals without the removed seat.
    await playHand(a, t);
    const hs = t.room.table.hand.seats[dead];
    assert.ok(!(hs && hs.dealt), 'the removed seat is not dealt in');
    assert.ok(t.room.recs[0] && t.room.recs[1], 'both humans stay seated');
    assert.strictEqual(t.room.chipsInPlay() + tracked.chips, total0, 'chips conserved incl. removal');
    a.close(); b.close();
  } finally {
    await t.stop();
  }
});

test('elimination: a human under 1 BB becomes a spectator at hand end (not removed) and cannot be dealt in', async () => {
  const t = await start({ seed: 78, timing: FAST });
  const rng = rngFrom(778);
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0911');
    const b = await connect(t.port, 'Ben', 'ben-client-0912');
    attachDriver(a, rng); attachDriver(b, rng);
    await seatTwoHumansAndBots(t, a, b, ['tight'], 20000);
    t.room.timing.nextHandMs = 600000;
    await playHand(a, t);
    t.room._setStack(1, 500);            // Ben ends the hand under 1 BB (1000)
    t.room._changed({});
    assert.ok(t.room.recs[1] && t.room.recs[1].conn, 'a busted human is not removed at hand end');
    // Out of the seats once no hand deals them in: the next hand is the first without Ben.
    await playHand(a, t);
    assert.ok(t.room.recs[1] && t.room.recs[1].conn, 'a busted human is not removed');
    assert.strictEqual(t.room._isOut(1), true, 'a busted human is out (spectator)');
    await until(() => a.lobby && a.lobby.spectators.some((s) => s.seat === 1), 3000, 'Ben listed as spectator');
    const hs = t.room.table.hand.seats[1];
    assert.ok(!(hs && hs.dealt), 'the spectator is not dealt in');
    assert.ok(t.room.recs[1] && t.room.recs[1].conn, 'still seated as a spectator after the hand');
    assert.ok(!a.msgs.some((m) => m.t === 'chat' && m.kind === 'botOut' && m.name === 'Ben'), 'no botOut line for a human');
    a.close(); b.close();
  } finally {
    await t.stop();
  }
});

test('elimination: a seat all-in at 0 mid-hand is not eliminated and keeps its place until the hand ends', async () => {
  const t = await start({ seed: 79, timing: FAST });
  const rng = rngFrom(779);
  let zeroWon = 0, zeroLost = 0;
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0921');
    const b = await connect(t.port, 'Ben', 'ben-client-0922');
    attachDriver(a, rng); attachDriver(b, rng);
    await seatTwoHumansAndBots(t, a, b, ['loose', 'aggressive'], 1000);
    t.room.timing.nextHandMs = 600000;
    const tracked = trackRemovedChips(t.room);
    const total0 = t.room.chipsInPlay();
    const zeroSeats = new Set();          // seats at 0 while dealt in the running hand
    let mid = 0;
    a.listeners.push(() => {
      const h = t.room.table.hand;
      if (!h || h.over) return;
      h.seats.forEach((hs, seat) => {
        if (!hs || !hs.dealt || t.room.table.seats[seat].stack !== 0) return;
        zeroSeats.add(seat);
        mid++;
        assert.ok(t.room.recs[seat] !== null, 'an all-in seat is not removed mid-hand');
        assert.strictEqual(t.room._isOut(seat), false, 'an all-in seat is not a spectator mid-hand');
      });
    });
    for (let i = 0; i < 150 && zeroWon === 0; i++) {
      zeroSeats.clear();
      await playHand(a, t);
      for (const seat of zeroSeats) {
        if (t.room.table.seats[seat].stack > 0) zeroWon++; else zeroLost++;
      }
      assert.strictEqual(t.room.chipsInPlay() + tracked.chips, total0, 'chips conserved after hand ' + i);
    }
    assert.ok(mid > 0, 'an all-in at 0 happened within 60 hands');
    assert.ok(zeroWon > 0, 'a seat that went all-in at 0 can win the hand (won ' + zeroWon + ', lost ' + zeroLost + ')');
    a.close(); b.close();
  } finally {
    await t.stop();
  }
});

test('soak: 300 hands, 3 humans on autoplay + 2 bots (seed 2026): no stall, no off-grid amounts, chips conserved', async () => {
  const t = await start({ seed: 2026, timing: FAST });
  const rng = rngFrom(2026);
  try {
    const a = await connect(t.port, 'Ann', 'ann-client-0931');
    const b = await connect(t.port, 'Ben', 'ben-client-0932');
    const c = await connect(t.port, 'Cy', 'cy-client-0933');
    attachDriver(a, rng); attachDriver(b, rng); attachDriver(c, rng);
    await until(() => a.lobby && a.lobby.players.length === 3, 3000, 'three humans');
    a.send({ t: 'addBot', style: 'tight' });
    a.send({ t: 'addBot', style: 'aggressive' });
    await until(() => a.lobby.players.length === 5, 3000, 'two bots');
    const tracked = trackRemovedChips(t.room);
    const total0 = t.room.chipsInPlay();
    const grid = 500;                     // the small blind: every stack and pot is a multiple of it
    let stalls = 0, offGrid = 0, hands = 0, checkedHand = -1, zeroWon = 0, zeroMid = new Set();
    const problems = [];
    const monitor = () => {
      const h = t.room.table.hand;
      if (!h) return;
      if (!h.over && h.toAct == null) { stalls++; if (problems.length < 5) problems.push('stall in hand ' + h.no + ' street ' + h.street); }
      t.room.table.seats.forEach((es, seat) => {
        if (es.stack % grid !== 0) { offGrid++; if (problems.length < 5) problems.push('stack ' + es.stack + ' seat ' + seat); }
      });
      if (!h.over) {
        h.seats.forEach((hs, seat) => {
          if (!hs || !hs.dealt) return;
          if (t.room.table.seats[seat].stack === 0) {
            zeroMid.add(h.no + ':' + seat);
            if (t.room.recs[seat] === null) problems.push('all-in seat ' + seat + ' removed mid-hand');
          }
        });
      } else if (checkedHand !== h.no) {
        checkedHand = h.no;
        hands = h.no;
        for (const k of zeroMid) {
          const [no, seat] = k.split(':').map(Number);
          if (no === h.no && t.room.table.seats[seat].stack > 0) zeroWon++;
        }
        zeroMid = new Set([...zeroMid].filter((k) => Number(k.split(':')[0]) !== h.no));
        if (t.room.chipsInPlay() !== t.room.netChips) problems.push('chips not conserved at hand ' + h.no);
      }
    };
    a.listeners.push(monitor);
    // A game ends when fewer than two players have chips: the host resets the stacks and starts again
    // (no reset is needed for the hand count itself). Stops at hand 300 or after 30 games.
    let games = 0;
    a.send({ t: 'start' });
    await until(() => t.room.autoplay, 3000, 'autoplay on');
    for (;;) {
      await until(() => !t.room.autoplay || t.room.table.hand.no >= 300, 240000, 'hands run or the game ends');
      if (t.room.table.hand.no >= 300 || ++games > 30) break;
      a.send({ t: 'reset' });
      await until(() => t.room.table.seats.every((es, seat) => !t.room.recs[seat] || es.stack > 0), 10000, 'stacks reset');
      // A fresh game can end inside its first hand (two humans bust at once): then autoplay is off again
      // and the next pass of the loop starts a new game. Either way the hand counter moves on.
      const noBefore = t.room.table.hand ? t.room.table.hand.no : 0;
      a.send({ t: 'start' });
      await until(() => t.room.autoplay || (t.room.table.hand && t.room.table.hand.no > noBefore), 10000, 'game restarted');
    }
    monitor();
    assert.deepStrictEqual(problems, [], 'soak problems at hand ' + (t.room.table.hand && t.room.table.hand.no) + ': ' + JSON.stringify(problems));
    assert.strictEqual(stalls, 0);
    assert.strictEqual(offGrid, 0);
    console.log('       soak: games=' + games + ' hands=' + hands + ' removed=' + JSON.stringify(tracked.bots) + ' allInAt0Won=' + zeroWon);
    a.close(); b.close(); c.close();
  } finally {
    await t.stop();
  }
});

(async () => {
  console.log('Poker Trainer multiplayer tests');
  for (const t of tests) {
    if (process.env.MP_ONLY && !t.name.includes(process.env.MP_ONLY)) continue;
    const t0 = Date.now();
    try {
      await t.fn();
      console.log('  ok   ' + t.name + ' (' + (Date.now() - t0) + ' ms)');
    } catch (e) {
      failures++;
      console.log('  FAIL ' + t.name + '\n       ' + e.message);
    }
  }
  console.log(failures ? '\n' + failures + ' test(s) failed' : '\nall multiplayer tests passed');
  process.exitCode = failures ? 1 : 0;
})();
