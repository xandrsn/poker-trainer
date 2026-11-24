'use strict';
// Tests for the multiplayer client's pure logic (public/mp.js), the perfect-negotiation helper
// with mock peer connections, and a run against the development mock server.
const assert = require('assert');
const core = require('../public/mp.js');
const { startMockServer, connectWs } = require('./mp-mock-server.js');

// Tests are queued and awaited in order, so both sync and async checks work.
const tests = [];
function check(name, fn) { tests.push({ name, fn }); }

// ---------- chip formatting ----------
check('formatChips', () => {
  assert.strictEqual(core.formatChips(100000), '100k');
  assert.strictEqual(core.formatChips(99500), '99.5k');
  assert.strictEqual(core.formatChips(1000), '1k');
  assert.strictEqual(core.formatChips(1234), '1.2k');
  assert.strictEqual(core.formatChips(500), '500');
  assert.strictEqual(core.formatChips(0), '0');
  assert.strictEqual(core.formatChips(1234567), '1.2M');
  assert.strictEqual(core.formatChips(-2500), '-2.5k');
});

// ---------- money model: every amount is in BB (chips / bb) ----------
check('fmtBB: chips over bb, one decimal, same text for the same situation', () => {
  assert.strictEqual(core.fmtBB(1000, 1000), '1 BB');
  assert.strictEqual(core.fmtBB(12500, 1000), '12.5 BB');
  assert.strictEqual(core.fmtBB(100000, 1000), '100 BB');
  assert.strictEqual(core.fmtBB(250, 1000), '0.3 BB'); // 0.25 rounds to one decimal
  assert.strictEqual(core.fmtBB(0, 1000), '0 BB');
  assert.strictEqual(core.fmtBB(-500, 1000), '-0.5 BB');
  assert.strictEqual(core.fmtBB(-1, 1000), '0 BB'); // no -0 BB
  assert.strictEqual(core.fmtBB(1000, 0), '1000 chips'); // no bb known: never NaN
  assert.strictEqual(core.fmtBB(1000, 1000, true), '1');
});
check('fmtBB halves after blinds double (same chips, half the BB)', () => {
  assert.strictEqual(core.fmtBB(20000, 1000), '20 BB');
  assert.strictEqual(core.fmtBB(20000, 2000), '10 BB');
  assert.strictEqual(core.fmtBB(20000, 4000), '5 BB');
});
check('bbToChips: typed BB back to whole chips', () => {
  assert.strictEqual(core.bbToChips(12.5, 1000), 12500);
  assert.strictEqual(core.bbToChips('3', 500), 1500);
  assert.strictEqual(core.bbToChips('', 1000), 0);
  assert.strictEqual(core.clampAmount(core.bbToChips(500, 1000), 2000, 100000), 100000); // 500 BB clamps to the max raise
});

// ---------- positions from the dealer button ----------
check('positionLabels 9 seats', () => {
  const seats = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const l = core.positionLabels(seats, 0);
  assert.deepStrictEqual(
    [0, 1, 2, 3, 4, 5, 6, 7, 8].map((s) => l[s]),
    ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'UTG+2', 'LJ', 'HJ', 'CO']
  );
});
check('positionLabels 5 seats and heads-up', () => {
  const five = core.positionLabels([0, 1, 2, 3, 4], 0);
  assert.deepStrictEqual([0, 1, 2, 3, 4].map((s) => five[s]), ['BTN', 'SB', 'BB', 'HJ', 'CO']);
  const hu = core.positionLabels([3, 7], 7);
  assert.strictEqual(hu[7], 'BTN');
  assert.strictEqual(hu[3], 'BB');
});

// ---------- seat geometry, clamps, names, cards ----------
check('seatPoint puts the local seat at the bottom', () => {
  const p = core.seatPoint(4, 4);
  assert.ok(Math.abs(p.x - 50) < 0.01);
  assert.ok(p.y > 85);
  const opposite = core.seatPoint(8, 4);
  assert.ok(opposite.y < 50);
});

check('clampAmount and raisePresets', () => {
  assert.strictEqual(core.clampAmount(10, 2000, 5000), 2000);
  assert.strictEqual(core.clampAmount(9000, 2000, 5000), 5000);
  assert.strictEqual(core.clampAmount(NaN, 2000, 5000), 2000);
  const hand = { pot: 3000, toCall: 1000, legal: { raise: true, minRaiseTo: 2000, maxRaiseTo: 99500 } };
  // potAfterCall = 4000, base = myBet 500 + toCall 1000 = 1500
  const p = core.raisePresets(hand, 500);
  assert.deepStrictEqual(p, { min: 2000, half: 3500, threeq: 4500, pot: 5500, allin: 99500 });
  assert.strictEqual(core.raisePresets({ legal: {} }, 0), null);
});

check('cleanName, initials, cardInfo', () => {
  assert.strictEqual(core.cleanName('  Ana   Maria '), 'Ana Maria');
  assert.strictEqual(core.cleanName(''), '');
  assert.strictEqual(core.cleanName('x'.repeat(17)), '');
  assert.strictEqual(core.initials('Ana Maria'), 'AM');
  assert.strictEqual(core.initials(''), '?');
  assert.deepStrictEqual(
    { rank: core.cardInfo('Td').rank, cls: core.cardInfo('Td').cls },
    { rank: '10', cls: 's-d' }
  );
  assert.strictEqual(core.cardInfo('back'), null);
});

check('reconnectDelay grows and is capped', () => {
  assert.ok(core.reconnectDelay(1) < core.reconnectDelay(2));
  assert.strictEqual(core.reconnectDelay(50), 8000);
});

check('turn countdown', () => {
  assert.strictEqual(core.turnRemaining(0, 0), core.TURN_MS);
  assert.strictEqual(core.turnRemaining(0, core.TURN_MS + 5000), 0);
});

// ---------- server clocks, jitter, pause info, digits ----------
check('remainingFrom: frozen while paused, counts down otherwise, null without a clock', () => {
  assert.strictEqual(core.remainingFrom(null, 0, 100, false), null);
  assert.strictEqual(core.remainingFrom(10000, 1000, 4000, true), 10000);
  assert.strictEqual(core.remainingFrom(10000, 1000, 4000, false), 7000);
  assert.strictEqual(core.remainingFrom(10000, 1000, 99999, false), 0);
});
check('clockText is mm:ss and rounds up', () => {
  assert.strictEqual(core.clockText(0), '00:00');
  assert.strictEqual(core.clockText(61200), '01:02');
  assert.strictEqual(core.clockText(600000), '10:00');
});
check('groupDigits adds thousands separators', () => {
  assert.strictEqual(core.groupDigits(1000), '1,000');
  assert.strictEqual(core.groupDigits(512000), '512,000');
  assert.strictEqual(core.groupDigits(50), '50');
});
check('reconnectDelay jitter stays within +-30% and the default is unchanged', () => {
  const base = core.reconnectDelay(3);
  assert.strictEqual(core.reconnectDelay(3, 0.5), base);
  assert.ok(core.reconnectDelay(3, 0) >= Math.round(base * 0.7) - 1);
  assert.ok(core.reconnectDelay(3, 0.999) <= Math.round(base * 1.3) + 1);
});

// ---------- state reducer ----------
check('reduce follows welcome, lobby, state, peers, error', () => {
  let st = core.initialState();
  st = core.reduce(st, { t: 'welcome', you: { clientId: 'c1', seat: 0, name: 'Ana', host: false }, settings: { stack: 50000, sb: 500, bb: 1000 } });
  assert.strictEqual(st.me.clientId, 'c1');
  assert.strictEqual(st.settings.stack, 50000);
  assert.strictEqual(st.settings.bb, 1000, 'blinds come from the server, never hardcoded');
  st = core.reduce(st, { t: 'lobby', players: [{ seat: 0, clientId: 'c1', name: 'Ana', bot: false, host: true, connected: true }] });
  assert.strictEqual(st.me.host, true, 'host flag comes from the lobby row');
  st = core.reduce(st, { t: 'state', hand: { id: 1, seats: [], toAct: null } });
  assert.strictEqual(st.hand.id, 1);
  st = core.reduce(st, { t: 'state', hand: null });
  assert.strictEqual(st.hand, null);
  st = core.reduce(st, { t: 'peers', ids: ['c1', 'c2'] });
  assert.deepStrictEqual(st.peers, ['c1', 'c2']);
  st = core.reduce(st, { t: 'error', msg: 'nope' });
  assert.strictEqual(st.error, 'nope');
  assert.strictEqual(core.reduce(st, null), st);
});

check('isMyTurn needs legal and the hero seat', () => {
  const st = { me: { seat: 2 }, hand: { toAct: 2, legal: { fold: true } } };
  assert.strictEqual(core.isMyTurn(st), true);
  assert.strictEqual(core.isMyTurn({ me: { seat: 3 }, hand: { toAct: 2, legal: {} } }), false);
  assert.strictEqual(core.isMyTurn({ me: { seat: 2 }, hand: { toAct: 2 } }), false);
});

// ---------- perfect negotiation with mock peer connections ----------
class FakePC {
  constructor(name) {
    this.name = name;
    this.signalingState = 'stable';
    this.localDescription = null;
    this.remoteDescription = null;
    this.candidates = [];
  }
  async setLocalDescription(d) {
    if (!d) d = { type: this.signalingState === 'have-remote-offer' ? 'answer' : 'offer', sdp: this.name };
    if (d.type === 'offer') {
      if (this.signalingState !== 'stable') throw new Error('offer while ' + this.signalingState);
      this.signalingState = 'have-local-offer';
    } else {
      if (this.signalingState !== 'have-remote-offer') throw new Error('answer while ' + this.signalingState);
      this.signalingState = 'stable';
    }
    this.localDescription = d;
  }
  async setRemoteDescription(d) {
    if (d.type === 'offer') {
      // Implicit rollback of a local offer is allowed, as in browsers.
      if (this.signalingState !== 'stable' && this.signalingState !== 'have-local-offer') throw new Error('bad offer state');
      this.signalingState = 'have-remote-offer';
    } else {
      if (this.signalingState !== 'have-local-offer') throw new Error('answer without offer');
      this.signalingState = 'stable';
    }
    this.remoteDescription = d;
  }
  async addIceCandidate(c) {
    if (!this.remoteDescription) throw new Error('no remote description');
    this.candidates.push(c);
  }
}

function pair() {
  const pcA = new FakePC('a');
  const pcB = new FakePC('b');
  const queue = [];
  const flush = () => new Promise((resolve) => {
    const step = () => {
      if (!queue.length) return setImmediate(resolve);
      const { to, data } = queue.shift();
      to.onSignal(data).then(() => setImmediate(step));
    };
    setImmediate(step);
  });
  // a is polite, b is impolite (the client picks politeness by comparing clientIds).
  const negA = core.createNegotiator({ pc: pcA, polite: true, send: (data) => queue.push({ to: negB, data }) });
  const negB = core.createNegotiator({ pc: pcB, polite: false, send: (data) => queue.push({ to: negA, data }) });
  return { pcA, pcB, negA, negB, flush };
}

check('negotiation without glare', async () => {
  const { pcA, pcB, negA, flush } = pair();
  await negA.onNegotiationNeeded();
  await flush();
  assert.strictEqual(pcA.signalingState, 'stable');
  assert.strictEqual(pcB.signalingState, 'stable');
  assert.strictEqual(pcB.localDescription.type, 'answer');
});

check('negotiation resolves glare (both offer at once)', async () => {
  const { pcA, pcB, negA, negB, flush } = pair();
  await Promise.all([negA.onNegotiationNeeded(), negB.onNegotiationNeeded()]);
  await flush();
  assert.strictEqual(pcA.signalingState, 'stable');
  assert.strictEqual(pcB.signalingState, 'stable');
  // The polite peer rolled back and answered; the impolite peer kept its own offer.
  assert.strictEqual(pcA.localDescription.type, 'answer');
  assert.strictEqual(pcB.localDescription.type, 'offer');
  // The impolite peer ignored the colliding offer, so its remote description is the answer.
  assert.strictEqual(pcB.remoteDescription.type, 'answer');
});

check('a candidate that arrives before the remote description is queued, then added', async () => {
  const { pcB, negB, flush } = pair();
  await negB.onSignal({ candidate: { candidate: 'x' } });
  await flush();
  assert.strictEqual(pcB.candidates.length, 0);
  assert.strictEqual(negB.lastError, null, 'queued, not an error');
});

// ---------- helpers for the new logic ----------
check('peerIds merges server peers with connected humans only', () => {
  const players = [
    { clientId: 'a', connected: true }, { clientId: 'b', connected: false },
    { bot: true, connected: true }, { clientId: 'c', connected: true }
  ];
  assert.deepStrictEqual(core.peerIds(players, ['d', 'a'], 'a'), ['d', 'c']);
});

check('rankInfo gives rank and distance from the average', () => {
  const r = core.rankInfo([100000, 50000, 50000], 100000);
  assert.deepStrictEqual(r, { rank: 1, of: 3, pct: 50 });
  assert.strictEqual(core.rankInfo([60000, 60000], 60000).pct, 0);
});

check('pickAvatar keeps the best quality under the byte budget', () => {
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(200000);
  assert.strictEqual(core.pickAvatar(() => big, 30 * 1024), null);
  const quality = [];
  const small = core.pickAvatar((q) => { quality.push(q); return 'data:image/jpeg;base64,' + 'A'.repeat(q > 0.5 ? 60000 : 20000); }, 30 * 1024);
  assert.ok(small, 'a smaller encoding is found');
  assert.strictEqual(quality[0], 0.85);
  assert.ok(core.dataUrlBytes(small) <= 30 * 1024);
});

check('reduce handles gameOver and paused flags', () => {
  let st = core.initialState();
  st = core.reduce(st, { t: 'lobby', players: [], settings: {}, paused: true });
  assert.strictEqual(st.paused, true);
  st = core.reduce(st, { t: 'gameOver', standings: [{ name: 'Ana', stack: 1 }] });
  assert.strictEqual(st.gameOverId, 1);
  assert.strictEqual(st.standings[0].name, 'Ana');
});

// ---------- two simulated peers: createPeerLink with mock RTCPeerConnections ----------
class SimStream {
  constructor() { this.tracks = []; }
  addTrack(t) { this.tracks.push(t); }
  getTracks() { return this.tracks.slice(); }
}

class SimPC {
  constructor(name) {
    this.name = name;
    this.signalingState = 'stable';
    this.connectionState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
    this.transceivers = [];
    this.candidates = [];
    this.negotiations = 0;
    this.tracksFired = false;
    this.negPending = false;
    this.closed = false;
  }
  addTransceiver(kind) {
    const t = { kind, sender: { track: null, replaceTrack(track) { this.track = track; return Promise.resolve(); } } };
    this.transceivers.push(t);
    if (!this.negPending) {
      this.negPending = true;
      setImmediate(() => {
        this.negPending = false;
        this.negotiations += 1;
        if (this.onnegotiationneeded) this.onnegotiationneeded();
      });
    }
    return t;
  }
  _connectedIfReady() {
    if (this.signalingState === 'stable' && this.localDescription && this.remoteDescription && this.connectionState !== 'connected') {
      this.connectionState = 'connected';
      if (this.onconnectionstatechange) this.onconnectionstatechange();
    }
  }
  async setLocalDescription(d) {
    if (!d) d = { type: this.signalingState === 'have-remote-offer' ? 'answer' : 'offer', sdp: this.name + Math.random() };
    if (d.type === 'offer') {
      if (this.signalingState !== 'stable') throw new Error('offer while ' + this.signalingState);
      this.signalingState = 'have-local-offer';
    } else {
      if (this.signalingState !== 'have-remote-offer') throw new Error('answer while ' + this.signalingState);
      this.signalingState = 'stable';
    }
    this.localDescription = d;
    this._connectedIfReady();
    setImmediate(() => { if (this.onicecandidate) this.onicecandidate({ candidate: { candidate: 'cand-' + this.name } }); });
  }
  async setRemoteDescription(d) {
    if (d.type === 'offer') {
      if (this.signalingState !== 'stable' && this.signalingState !== 'have-local-offer') throw new Error('bad offer state');
      this.signalingState = 'have-remote-offer';
    } else {
      if (this.signalingState !== 'have-local-offer') throw new Error('answer without offer');
      this.signalingState = 'stable';
    }
    this.remoteDescription = d;
    if (!this.tracksFired) {
      this.tracksFired = true;
      setImmediate(() => {
        ['video', 'audio'].forEach((kind) => {
          if (this.ontrack) this.ontrack({ track: { kind, id: this.name + '-' + kind } });
        });
      });
    }
    this._connectedIfReady();
  }
  async addIceCandidate(c) {
    if (!this.remoteDescription) throw new Error('no remote description');
    this.candidates.push(c);
  }
  restartIce() {}
  close() { this.closed = true; this.connectionState = 'closed'; }
}

async function simPair() {
  const links = {};
  const queue = [];
  const pumpAll = () => new Promise((resolve) => {
    const step = () => {
      if (!queue.length) return setImmediate(resolve);
      const m = queue.shift();
      links[m.to].signal(m.data).then(() => setImmediate(step));
    };
    setImmediate(step);
  });
  const make = (me, other, polite) => core.createPeerLink({
    makePC: () => new SimPC(me),
    makeStream: () => new SimStream(),
    remoteId: other,
    polite,
    send: (data) => queue.push({ to: other, data })
  });
  links.a = make('a', 'b', true);
  links.b = make('b', 'a', false);
  await pumpAll();
  return { A: links.a, B: links.b, pumpAll, queue };
}

check('two peers connect when both start negotiating at once (glare)', async () => {
  const { A, B, pumpAll } = await simPair();
  await pumpAll();
  assert.strictEqual(A.status(), 'connected');
  assert.strictEqual(B.status(), 'connected');
  assert.strictEqual(A.pc.localDescription.type, 'answer', 'polite peer rolled back and answered');
  assert.strictEqual(B.pc.localDescription.type, 'offer');
});

check('remote tracks reach each peer stream and ICE candidates are relayed', async () => {
  const { A, B, pumpAll } = await simPair();
  await pumpAll();
  // video goes to link.stream, audio to link.audStream (sound plays from its own <audio> element)
  assert.strictEqual(A.stream.getTracks().length + A.audStream.getTracks().length, 2);
  assert.strictEqual(B.stream.getTracks().length + B.audStream.getTracks().length, 2);
  assert.strictEqual(A.audStream.getAudioTracks ? A.audStream.getAudioTracks().length : A.audStream.getTracks().length, 1);
  assert.ok(B.pc.candidates.length > 0, 'the impolite peer received candidates');
});

check('turning the camera on after connecting needs no renegotiation', async () => {
  const { A, B, pumpAll } = await simPair();
  await pumpAll();
  const before = [A.pc.negotiations, B.pc.negotiations];
  const cam = { kind: 'video', id: 'cam' };
  A.setLocalTracks(cam, null);
  await pumpAll();
  assert.strictEqual(A.pc.transceivers[0].sender.track, cam);
  assert.deepStrictEqual([A.pc.negotiations, B.pc.negotiations], before);
});

check('a peer that leaves is closed and reports closed', async () => {
  const { A, pumpAll } = await simPair();
  await pumpAll();
  A.close();
  assert.strictEqual(A.status(), 'closed');
  assert.strictEqual(A.pc.closed, true);
});

check('a failed connection is reported as failed', async () => {
  const { A, pumpAll } = await simPair();
  await pumpAll();
  A.pc.connectionState = 'failed';
  assert.strictEqual(A.status(), 'failed');
});

// ---------- integration with the development mock server ----------
async function integration() {
  const srv = await startMockServer();
  const a = await connectWs(srv.port);
  const b = await connectWs(srv.port);
  try {
    a.send({ t: 'join', name: 'Ana' });
    const wa = await a.waitFor((m) => m.t === 'welcome');
    assert.strictEqual(wa.you.host, true);
    b.send({ t: 'join', name: 'Bo' });
    const wb = await b.waitFor((m) => m.t === 'welcome');
    assert.strictEqual(wb.you.host, false);

    a.send({ t: 'addBot', style: 'lv1' });
    await a.waitFor((m) => m.t === 'lobby' && m.players.some((p) => p.bot));

    let st = core.initialState();
    for (const m of a.inbox) st = core.reduce(st, m);
    assert.strictEqual(st.me.host, true);
    assert.strictEqual(st.players.length, 3);
    assert.strictEqual(st.settings.stack, 100000);

    a.send({ t: 'start' });
    const sa = await a.waitFor((m) => m.t === 'state' && m.hand && m.hand.legal);
    assert.strictEqual(sa.hand.youCards.length, 2);
    const sb = await b.waitFor((m) => m.t === 'state' && m.hand);
    assert.strictEqual(sb.hand.youCards.length, 2, 'each player gets only their own cards');
    const hidden = sb.hand.seats.find((x) => x.seat === wa.you.seat);
    assert.strictEqual(hidden.cards, null, 'other players cards stay hidden');

    // rtc relay: a -> b with the sender id attached
    a.send({ t: 'rtc', to: wb.you.clientId, data: { description: { type: 'offer', sdp: 'x' } } });
    const relay = await b.waitFor((m) => m.t === 'rtc' && m.from === wa.you.clientId);
    assert.strictEqual(relay.data.description.type, 'offer');

    // peers list contains both humans
    await a.waitFor((m) => m.t === 'peers' && m.ids.length === 2);

    // profile: avatar travels in the lobby; a non-JPEG avatar is dropped by the server
    const photo = 'data:image/jpeg;base64,' + 'QUFB';
    b.send({ t: 'profile', name: 'Bo', avatar: photo });
    const withPhoto = await a.waitFor((m) => m.t === 'lobby' && m.players.some((p) => p.avatar === photo));
    assert.ok(withPhoto, 'lobby carries the avatar');
    b.send({ t: 'profile', name: 'Bo', avatar: 'javascript:alert(1)' });
    const noPhoto = await a.waitFor((m) => m.t === 'lobby' && m.players.every((p) => p.avatar !== 'javascript:alert(1)'));
    assert.ok(noPhoto);

    // pause flag reaches the lobby, endGame sends standings to everyone
    a.send({ t: 'pause' });
    await a.waitFor((m) => m.t === 'lobby' && m.paused === true);
    a.send({ t: 'resume' });
    a.send({ t: 'endGame' });
    const over = await b.waitFor((m) => m.t === 'gameOver');
    assert.ok(Array.isArray(over.standings) && over.standings.length >= 2);
    let st2 = core.reduce(core.initialState(), over);
    assert.strictEqual(st2.gameOverId, 1);

    // reconnect with the clientId reclaims the same seat
    a.close();
    const a2 = await connectWs(srv.port);
    try {
      a2.send({ t: 'join', name: 'Ana', clientId: wa.you.clientId });
      const again = await a2.waitFor((m) => m.t === 'welcome');
      assert.strictEqual(again.you.clientId, wa.you.clientId);
      assert.strictEqual(again.you.seat, wa.you.seat);
    } finally {
      a2.close();
    }
  } finally {
    a.close();
    b.close();
    srv.close();
  }
}

// ---------- B: chat, emoji tokens, toast and bubble rules ----------
const PNG_OK = 'data:image/png;base64,iVBORw0KGgo=';
check('emoji background knock-out: opaque border colour becomes transparent, the subject stays', () => {
  const w = 6, h = 6, px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { px[i * 4] = 240; px[i * 4 + 1] = 240; px[i * 4 + 2] = 250; px[i * 4 + 3] = 255; }
  for (let y = 2; y < 4; y++) for (let x = 2; x < 4; x++) { const k = (y * w + x) * 4; px[k] = 229; px[k + 1] = 72; px[k + 2] = 77; }
  core.chat.knockOutBg(px, w, h);
  assert.strictEqual(px[3], 0, 'corner becomes transparent');
  assert.strictEqual(px[((2 * w) + 2) * 4 + 3], 255, 'red subject stays opaque');
  assert.strictEqual(px[((2 * w) + 2) * 4], 229);
  // an image that already has transparency is left as it is
  const t = new Uint8ClampedArray(w * h * 4).fill(255); t[3] = 0;
  const before = t.slice();
  core.chat.knockOutBg(t, w, h);
  assert.deepStrictEqual(Array.from(t), Array.from(before));
});
check('emoji tokens: HTML is escaped, known id becomes img, unknown id stays literal', () => {
  const pack = { smile: PNG_OK };
  assert.strictEqual(core.chat.renderEmojiText('<b>hi</b> & :nope:', pack),
    '&lt;b&gt;hi&lt;/b&gt; &amp; :nope:');
  const html = core.chat.renderEmojiText('<i>:smile:</i>', pack);
  assert.strictEqual(html, '&lt;i&gt;<img class="mp-emoji" src="' + PNG_OK + '" alt=":smile:">&lt;/i&gt;');
  assert.ok(!/<script|<\/?i>/.test(html));
});
check('emoji tokens: non-PNG, oversized or malformed data is never an img', () => {
  assert.strictEqual(core.chat.renderEmojiText(':a:', { a: 'data:image/jpeg;base64,AAAA' }), ':a:');
  assert.strictEqual(core.chat.renderEmojiText(':a:', { a: 'data:image/png;base64,' + 'A'.repeat(12000) }), ':a:');
  const quoted = 'data:image/png;base64,AA"><script>';
  assert.strictEqual(core.chat.emojiDataOk(quoted), false);
  assert.strictEqual(core.chat.renderEmojiText(':a:', { a: quoted }), ':a:');
  assert.strictEqual(core.chat.renderEmojiText(':a:', { a: 'javascript:1' }), ':a:');
});
check('emoji tokens: a message that is only one known emoji is big', () => {
  assert.strictEqual(core.chat.isOnlyEmoji(' :smile: ', { smile: PNG_OK }), true);
  assert.strictEqual(core.chat.isOnlyEmoji('hi :smile:', { smile: PNG_OK }), false);
  assert.strictEqual(core.chat.isOnlyEmoji(':nope:', {}), false);
});
check('toast and bubble rules: history never toasts or bubbles; new messages toast only when chat hidden', () => {
  assert.deepStrictEqual(core.chat.chatEffects(true, false), { toast: false, bubble: false });
  assert.deepStrictEqual(core.chat.chatEffects(true, true), { toast: false, bubble: false });
  assert.deepStrictEqual(core.chat.chatEffects(false, false), { toast: true, bubble: true });
  assert.deepStrictEqual(core.chat.chatEffects(false, true), { toast: false, bubble: true });
  assert.strictEqual(core.chat.toastText('Ana', 'x'.repeat(60)), 'Ana: ' + 'x'.repeat(40));
  assert.strictEqual(core.chat.toastText('Ana', '  hola \n  que tal '), 'Ana: hola que tal');
});
check('bubble expiry after 5 s', () => {
  const now = 100000;
  assert.strictEqual(core.chat.bubbleLive({ at: now - 4999 }, now), true);
  assert.strictEqual(core.chat.bubbleLive({ at: now - 5000 }, now), false);
  assert.strictEqual(core.chat.bubbleLive(undefined, now), false);
});
check('emoji store: corrupt or missing localStorage loads as empty, bad entries dropped', () => {
  assert.deepStrictEqual(core.chat.loadEmojiSet(null), []);
  assert.deepStrictEqual(core.chat.loadEmojiSet('{not json'), []);
  assert.deepStrictEqual(core.chat.loadEmojiSet('"text"'), []);
  const raw = JSON.stringify([{ id: 'ok', data: PNG_OK }, { id: 'Bad!', data: PNG_OK }, { id: 'ok', data: PNG_OK },
    { id: 'jpg', data: 'data:image/jpeg;base64,AAAA' }]);
  assert.deepStrictEqual(core.chat.loadEmojiSet(raw), [{ id: 'ok', data: PNG_OK }]);
  assert.strictEqual(core.chat.emojiIdOk('abcdefghijklm'), false);
  assert.strictEqual(core.chat.emojiIdOk('abcdefghijkl'), true);
});
check('emoji store: add validates id, size, duplicates and the 12 limit', () => {
  let set = [];
  assert.strictEqual(core.chat.emojiAdd(set, 'Nope', PNG_OK).err, 'id');
  assert.strictEqual(core.chat.emojiAdd(set, 'big', 'data:image/png;base64,' + 'A'.repeat(12000)).err, 'size');
  set = core.chat.emojiAdd(set, 'a', PNG_OK).set;
  assert.strictEqual(core.chat.emojiAdd(set, 'a', PNG_OK).err, 'dup');
  for (let i = 1; i < 12; i++) set = core.chat.emojiAdd(set, 'e' + i, PNG_OK).set;
  assert.strictEqual(set.length, 12);
  assert.strictEqual(core.chat.emojiAdd(set, 'z', PNG_OK).err, 'max');
  assert.deepStrictEqual(core.chat.emojiRemove(set, 'a').length, 11);
  assert.strictEqual(core.chat.isPngHeader(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])), true);
  assert.strictEqual(core.chat.isPngHeader(new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70])), false);
});

(async () => {
  for (const t of tests) {
    try {
      await t.fn();
    } catch (e) {
      console.error('FAIL ' + t.name);
      throw e;
    }
  }
  await integration();
  console.log('mp-client tests passed (' + tests.length + ' unit checks + integration)');
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
