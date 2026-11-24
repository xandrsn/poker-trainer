'use strict';
/* Accounts, ratings, ranked matches and moving rooms between servers. Runs in memory; with REDIS_URL set it
 * also runs two servers against that Redis (use an empty one). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { createServer } = require('../server.js');
const { createStore } = require('../server/store.js');
const { eloDelta } = require('../server/ranked.js');
const { Room } = require('../server/room.js');
const NN = require('../server/nnbot.js');
const G = require('../public/game.js');
const E = require('../public/engine.js');
const Ladder = require('../public/ladder.js');

const FAST = { botDelay: [0, 0], showWindowMs: 5, nextHandMs: 5 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms) {
  const end = Date.now() + (ms || 5000);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout: ' + what);
    await wait(10);
  }
}

async function start(timing) {
  const server = createServer({ diagFile: false, timing: Object.assign({}, FAST, timing) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const host = '127.0.0.1:' + server.address().port;
  return {
    server, host,
    async api(name, body, cookie, headers) {
      const res = await fetch('http://' + host + '/api/' + name, {
        method: body ? 'POST' : 'GET', redirect: 'manual',
        headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { Cookie: cookie } : {}, headers),
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.getSetCookie().join(', ') || null;
      const own = res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !/=$/.test(c));
      return { status: res.status, cookie: own.join('; ') || null, set, location: res.headers.get('location'), data: res.status === 302 ? null : await res.json() };
    },
    close() { server.multiplayer.close(); server.closeAllConnections(); server.close(); },
  };
}

function client(s, cookie, origin) {
  const c = { msgs: [], state: null, closed: false, rated: null };
  const ws = new WebSocket('ws://' + s.host + '/ws', { headers: Object.assign({ Origin: origin || 'http://' + s.host }, cookie ? { Cookie: cookie } : {}) });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    c.msgs.push(m);
    if (m.t === 'state') { c.state = m; if (c.onState) c.onState(m); }
    if (m.t === 'rated') c.rated = m;
  });
  ws.on('close', () => { c.closed = true; });
  ws.on('error', () => {});
  c.send = (o) => ws.send(JSON.stringify(o));
  c.open = new Promise((r) => ws.on('open', r));
  c.kill = () => ws.terminate();
  c.join = async (room, extra) => {
    await c.open;
    c.send({ t: 'joinRoom', id: room });
    c.send(Object.assign({ t: 'join', name: 'x', clientId: 'guest_' + Math.random().toString(36).slice(2, 12) }, extra));
    await until(() => c.msgs.some((m) => m.t === 'welcome' || m.t === 'error'), 'join');
  };
  c.act = (action, amount) => {
    const h = c.state.hand;
    c.send({ t: 'act', action, amount, turn: h.id + '|' + h.street + '|' + h.toAct });
  };
  return c;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
let uid = Date.now() % 100000;
const newName = () => 'p' + (uid++) + '_t';
// Every test comes from one address: with Redis the sign-in limit would carry over from test to test.
const shared = process.env.REDIS_URL ? createStore({}) : null;
async function signUp(s) {
  if (shared) await shared.del('rl:127.0.0.1');
  const name = newName();
  const r = await s.api('register', { name, password: 'correct horse' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return { name, cookie: r.cookie, code: r.data.code };
}
async function pair(s1, s2) {
  const a = await signUp(s1), b = await signUp(s2);
  assert.strictEqual((await s1.api('queue', {}, a.cookie)).data.status, 'waiting');
  const m = (await s2.api('queue', {}, b.cookie)).data;
  assert.strictEqual(m.status, 'matched');
  assert.strictEqual((await s1.api('queue', {}, a.cookie)).data.room, m.room, 'both get the same room');
  return { a, b, room: m.room };
}

test('elo: zero sum at equal K, favourites gain less, new players move faster', () => {
  const duel = (rating, opp, won, games) => eloDelta(rating, [{ rating: opp, won }], games);
  assert.strictEqual(duel(1200, 1200, true, 0), 20);
  assert.strictEqual(duel(1200, 1200, false, 0), -20);
  assert.ok(duel(1600, 1200, true, 50) < duel(1200, 1600, true, 50));
  assert.strictEqual(duel(1200, 1200, true, 20), 10);
  const table = [1, 2, 3, 4, 5].map((place) => eloDelta(1200, [1, 2, 3, 4].map((i) => ({ rating: 1200, won: i >= place })), 50));
  assert.deepStrictEqual(table, [10, 5, 0, -5, -10], 'places at a table of five');
});

test('memory store: survives a restart through its file, expires keys', async () => {
  const file = path.join(os.tmpdir(), 'pt-store-' + process.pid + '.json');
  const s = createStore({ file, memory: true });
  await s.hset('h', { a: 1 });
  await s.set('gone', 'x', { px: 1 });
  assert.strictEqual(await s.set('k', '1', { nx: true }), true);
  assert.strictEqual(await s.set('k', '2', { nx: true }), false);
  await wait(400);
  const again = createStore({ file, memory: true });
  assert.deepStrictEqual(await again.hgetall('h'), { a: '1' });
  assert.strictEqual(await again.get('gone'), null);
  fs.unlinkSync(file);
});

test('accounts: register, sign in, sign out; wrong password, taken name, bad input refused', async (s) => {
  const { name, cookie } = await signUp(s);
  assert.strictEqual((await s.api('me', null, cookie)).data.user.rating, 1200);
  assert.strictEqual(JSON.stringify((await s.api('profile?name=' + name)).data).includes('hash'), false);
  assert.strictEqual((await s.api('register', { name: name.toUpperCase(), password: 'correct horse' })).status, 409);
  assert.strictEqual((await s.api('login', { name, password: 'wrong wrong' })).status, 401);
  assert.strictEqual((await s.api('login', { name: 'nobody_here', password: 'wrong wrong' })).status, 401);
  assert.strictEqual((await s.api('login', { name: { $: 1 }, password: 'wrong wrong' })).status, 400);
  assert.strictEqual((await s.api('register', { name: 'ok_name', password: 'short' })).status, 400);
  assert.strictEqual((await s.api('logout', {}, cookie, { 'Content-Type': 'text/plain' })).status, 415);
  const login = await s.api('login', { name, password: 'correct horse' });
  assert.ok(/HttpOnly/.test(login.set) && /SameSite=Lax/.test(login.set));
  await s.api('logout', {}, login.cookie);
  assert.strictEqual((await s.api('me', null, login.cookie)).data.user, null);
  assert.strictEqual((await s.api('queue', {}, login.cookie)).status, 401);
});

test('recovery code: sets a new password once, ends other sessions, can be renewed', async () => {
  const s = await start();
  const a = await signUp(s);
  const recover = (code, password) => s.api('recover', { name: a.name, code, password: password || 'new password 1' });
  assert.ok(/^([A-Z2-9]{4}-){3}[A-Z2-9]{4}$/.test(a.code));
  assert.strictEqual((await recover('AAAA-AAAA-AAAA-AAAA')).status, 401);
  assert.strictEqual((await recover(undefined)).status, 401);
  assert.strictEqual((await s.api('recover', { name: 'nobody_here', code: a.code, password: 'new password 1' })).status, 401);
  assert.strictEqual((await recover(a.code, 'short')).status, 400);
  const r = await recover(a.code.toLowerCase().replace(/-/g, ' '));
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await s.api('me', null, a.cookie)).data.user, null, 'the old session ended');
  assert.strictEqual((await s.api('me', null, r.cookie)).data.user.name, a.name);
  assert.strictEqual((await recover(a.code)).status, 401, 'a code works once');
  assert.strictEqual((await s.api('login', { name: a.name, password: 'new password 1' })).status, 200);
  assert.strictEqual((await s.api('recovery-code', { password: 'wrong password' }, r.cookie)).status, 403);
  const fresh = (await s.api('recovery-code', { password: 'new password 1' }, r.cookie)).data.code;
  assert.ok(fresh !== r.data.code);
  if (shared) await shared.del('rl:127.0.0.1');
  s.close();
});

test('google: needs its own browser and nonce, new players choose a name, accounts can be connected', async () => {
  process.env.GOOGLE_CLIENT_ID = 'cid';
  process.env.GOOGLE_CLIENT_SECRET = 'secret';
  const s = await start(), real = globalThis.fetch;
  let claims = null, sent = null;
  globalThis.fetch = (url, o) => {
    if (url !== 'https://oauth2.googleapis.com/token') return real(url, o);
    sent = o.body;
    return Promise.resolve(new Response(JSON.stringify({ id_token: 'x.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.x' })));
  };
  try {
    const sub = String(Date.now());
    // One trip to Google and back. Returns where the player lands and the cookies of that browser.
    const trip = async (o) => {
      o = o || {};
      const go = await s.api('google', { link: !!o.link }, o.cookie);
      const q = new URL(go.data.url).searchParams;
      assert.strictEqual(q.get('redirect_uri'), 'http://' + s.host + '/api/google/callback');
      claims = Object.assign({ iss: 'https://accounts.google.com', aud: 'cid', sub, exp: Date.now() / 1000 + 60, nonce: q.get('nonce') }, o.claims);
      const jar = [o.noState ? '' : go.cookie, o.cookie || ''].filter(Boolean).join('; ');
      const path = 'google/callback?code=c&state=' + q.get('state');
      const back = await s.api(path, null, jar);
      assert.strictEqual(back.status, 302);
      return { to: back.location, cookie: back.cookie, again: () => s.api(path, null, jar), challenge: q.get('code_challenge') };
    };
    assert.strictEqual((await s.api('me')).data.google, true);
    assert.strictEqual((await trip({ noState: true })).to, '/?google=error');
    for (const bad of [{ aud: 'other' }, { nonce: 'other' }, { iss: 'https://evil.example' }, { exp: 1 }, { sub: '../x' }]) {
      assert.strictEqual((await trip({ claims: bad })).to, '/?google=error', JSON.stringify(bad));
    }
    const first = await trip();
    assert.strictEqual(first.to, '/?google=name');
    assert.strictEqual(require('crypto').createHash('sha256').update(sent.get('code_verifier')).digest('base64url'), first.challenge);
    assert.strictEqual((await first.again()).location, '/?google=error', 'a callback works once');
    assert.strictEqual((await s.api('google/finish', { name: 'nopending' })).status, 410);
    const a = await signUp(s), name = newName();
    assert.strictEqual((await s.api('google/finish', { name: a.name }, first.cookie)).status, 409);
    const made = await s.api('google/finish', { name }, first.cookie);
    assert.strictEqual(made.status, 200);
    const me = (await s.api('me', null, made.cookie)).data.user;
    assert.deepStrictEqual([me.name, me.password, me.google, me.rating], [name, false, true, 1200]);
    assert.strictEqual((await s.api('login', { name, password: 'correct horse' })).status, 401, 'no password to sign in with');
    const back = await trip();
    assert.strictEqual(back.to, '/?google=ok');
    assert.strictEqual((await s.api('me', null, back.cookie)).data.user.name, name);
    assert.strictEqual((await trip({ link: true, cookie: a.cookie })).to, '/?google=taken');
    const linked = await trip({ link: true, cookie: a.cookie, claims: { sub: sub + '1' } });
    assert.strictEqual(linked.to, '/?google=linked');
    assert.strictEqual((await s.api('me', null, a.cookie)).data.user.google, true);
    assert.strictEqual((await s.api('profile?name=' + name)).data.player.google, undefined, 'not public');
  } finally {
    globalThis.fetch = real;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    if (shared) await shared.del('rl:127.0.0.1');
    s.close();
  }
});

test('sign-in attempts are limited', async (s) => {
  let last;
  for (let i = 0; i < 12; i++) last = await s.api('login', { name: 'limit_me', password: 'wrong wrong' });
  assert.strictEqual(last.status, 429);
});

test('ranked: two players meet, outsiders and foreign origins are kept out, resigning settles the ratings once', async (s) => {
  const { a, b, room } = await pair(s, s);
  const guest = client(s, null);
  await guest.join(room);
  assert.ok(guest.msgs.some((m) => m.t === 'error' && /other players/.test(m.msg)));
  const foreign = client(s, a.cookie, 'https://evil.example');
  await foreign.join(room);
  assert.ok(foreign.msgs.some((m) => m.t === 'error'), 'a cookie sent by another site does not count');
  const ca = client(s, a.cookie), cb = client(s, b.cookie);
  await ca.join(room);
  await cb.join(room);
  await until(() => ca.state && ca.state.hand && cb.state && cb.state.hand, 'first hand');
  const lobby = ca.msgs.filter((m) => m.t === 'lobby').pop();
  assert.deepStrictEqual(lobby.players.map((p) => p.name).sort(), [a.name, b.name].sort());
  assert.ok(lobby.players.every((p) => p.rating === 1200 && !p.host) && lobby.settings.ranked);
  for (const t of [{ t: 'endGame' }, { t: 'pause' }, { t: 'addBot' }, { t: 'kick', seat: 1 }, { t: 'rebuy' }, { t: 'settings', bb: 2 }]) ca.send(t);
  await until(() => ca.msgs.filter((m) => m.t === 'error').length === 6, 'host actions refused');
  assert.strictEqual((await s.api('queue', {}, a.cookie)).data.room, room, 'a running match is resumed');
  cb.send({ t: 'resign' });
  cb.send({ t: 'resign' });
  await until(() => ca.rated && cb.rated, 'result');
  assert.strictEqual(ca.rated.winner, a.name);
  assert.strictEqual((await s.api('me', null, a.cookie)).data.user.rating, 1220);
  assert.strictEqual((await s.api('me', null, b.cookie)).data.user.rating, 1180);
  const p = (await s.api('profile?name=' + a.name)).data.player;
  assert.deepStrictEqual([p.games, p.wins, p.history.length, p.history[0].delta, p.history[0].opp], [1, 1, 1, 20, b.name]);
  assert.ok((await s.api('leaderboard')).data.players.some((x) => x.name === a.name && x.rating === 1220));
  assert.strictEqual((await s.api('queue', {}, a.cookie)).data.status, 'waiting', 'free to play again');
  await s.api('queue/cancel', {}, a.cookie);
  [ca, cb, guest, foreign].forEach((c) => c.kill());
});

test('ranked: leaving for too long loses the match; a no-show voids it', async () => {
  const s = await start({ abandonedMs: 150 });
  const { a, b, room } = await pair(s, s);
  const ca = client(s, a.cookie), cb = client(s, b.cookie);
  await ca.join(room);
  await cb.join(room);
  await until(() => ca.state && ca.state.hand, 'hand');
  cb.kill();
  await until(() => ca.rated, 'forfeit');
  assert.deepStrictEqual([ca.rated.winner, ca.rated.reason], [a.name, 'left']);
  const two = await pair(s, s);
  const lone = client(s, two.a.cookie);
  await lone.join(two.room);
  lone.send({ t: 'resign' }); // leaving before the opponent arrives
  await until(() => lone.rated, 'void');
  assert.strictEqual(lone.rated.void, true);
  assert.strictEqual((await s.api('me', null, two.a.cookie)).data.user.games, 0);
  s.close();
});

test('ranked: a match against a neural bot plays to the end and is rated', async (s) => {
  const a = await signUp(s);
  const bot = (await s.api('bots')).data.bots[0];
  assert.strictEqual((await s.api('queue', { bot: 'nope' }, a.cookie)).status, 404);
  const m = (await s.api('queue', { bot: bot.id }, a.cookie)).data;
  const c = client(s, a.cookie);
  c.onState = (st) => {
    const L = st.hand && st.hand.legal;
    if (L) setImmediate(() => { if (c.state.hand && c.state.hand.legal) c.act(L.raise ? 'raise' : 'call', L.maxRaiseTo); });
  };
  await c.join(m.room);
  await until(() => c.rated, 'match end', 30000);
  const me = (await s.api('me', null, a.cookie)).data.user;
  assert.strictEqual(me.games, 1);
  assert.strictEqual(me.rating, 1200 + c.rated.players[0].delta);
  assert.strictEqual(c.rated.winner === a.name, c.rated.players[0].delta > 0);
  c.kill();
});

async function seatAt(s, n) { // n players waiting for a table, all matched
  const ps = [];
  for (let i = 0; i < n; i++) ps.push(await signUp(s));
  s.server.multiplayer.manager.opts.rankedService.tableWaitMs = 400;
  await until(async () => {
    for (const p of ps) p.q = (await s.api('queue', { mode: 'table' }, p.cookie)).data;
    return ps.every((p) => p.q.status === 'matched');
  }, 'table');
  assert.strictEqual(new Set(ps.map((p) => p.q.room)).size, 1, 'one table');
  return ps;
}
const pushAll = (c) => {
  c.onState = (st) => {
    if (st.hand && st.hand.legal) setImmediate(() => { const L = c.state.hand && c.state.hand.legal; if (L) c.act(L.raise ? 'raise' : 'call', L.maxRaiseTo); });
  };
};

test('ranked table: bots fill it, a resigned player is last at once, the others play on and are rated by place', async (s) => {
  const ps = await seatAt(s, 3);
  for (const p of ps) { p.c = client(s, p.cookie); if (p !== ps[0]) pushAll(p.c); await p.c.join(p.q.room); }
  await until(() => ps.every((p) => p.c.state && p.c.state.hand), 'hand');
  const lobby = ps[0].c.msgs.filter((m) => m.t === 'lobby').pop();
  assert.deepStrictEqual([lobby.players.length, lobby.players.filter((p) => p.bot).length, lobby.settings.kind], [6, 3, 'table']);
  assert.strictEqual(new Set(lobby.players.filter((p) => p.bot).map((p) => p.name)).size, 3);
  ps[0].c.send({ t: 'resign' });
  await until(() => ps[0].c.rated, 'resigned');
  assert.deepStrictEqual([ps[0].c.rated.place, ps[0].c.rated.of, ps[0].c.rated.reason], [6, 6, 'resign']);
  assert.ok(!ps[1].c.rated || ps[1].c.rated.place < 6);
  assert.strictEqual((await s.api('queue', { mode: 'table' }, ps[0].cookie)).data.status, 'waiting', 'free to play again');
  await s.api('queue/cancel', {}, ps[0].cookie);
  await until(() => ps[1].c.rated && ps[2].c.rated, 'the others', 60000);
  assert.ok(ps[1].c.rated.place !== ps[2].c.rated.place);
  for (const p of ps) {
    const u = (await s.api('profile?name=' + p.name)).data.player;
    const h = u.history[0];
    assert.deepStrictEqual([u.games, u.wins, h.place, h.of, 1200 + h.delta], [1, h.place === 1 ? 1 : 0, p.c.rated.place, 6, u.rating]);
    p.c.kill();
  }
});

test('ranked table: six players start at once; one who does not arrive is dropped unrated', async () => {
  const s = await start({ noShowMs: 300, abandonedMs: 150 });
  const ps = await seatAt(s, 6);
  for (const p of ps.slice(1)) { p.c = client(s, p.cookie); await p.c.join(p.q.room); }
  await until(() => ps.slice(1).every((p) => p.c.state && p.c.state.hand), 'starts without the missing player');
  const late = client(s, ps[0].cookie);
  await late.join(ps[0].q.room);
  assert.ok(late.msgs.some((m) => m.t === 'error'));
  ps[1].c.kill();
  await until(async () => (await s.api('me', null, ps[1].cookie)).data.user.games === 1, 'away too long');
  const h = (await s.api('profile?name=' + ps[1].name)).data.player.history[0];
  assert.deepStrictEqual([h.place, h.of, h.delta, h.reason], [5, 5, -20, 'left']);
  assert.strictEqual((await s.api('me', null, ps[0].cookie)).data.user.games, 0);
  ps.slice(2).forEach((p) => p.c.kill());
  late.kill();
  s.close();
});

test('neural bots: legal play with 3 to 9 players, in tournaments and as casual bots, chips conserved', () => {
  let seed = 11;
  const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let m = 3; m <= 9; m++) {
    const t = G.newTable({ maxSeats: 9, seed: m });
    t.cfg.bb = 1000; t.cfg.sb = 500;
    for (let i = 0; i < m; i++) Object.assign(t.seats[i], { stack: 1000 * Math.ceil(rng() * 60), busted: false });
    const total = G.totalChips(t);
    for (let h = 0; h < 25; h++) {
      const active = t.seats.map((x, i) => i).filter((i) => t.seats[i].stack >= 1000);
      if (active.length < 2) break;
      const hand = G.startHand(t, { active });
      for (let n = 0; !hand.over; n++) {
        assert.ok(n < 200, 'hand does not end');
        NN.step(t, hand.toAct, NN.LADDER[hand.toAct % NN.LADDER.length].id, rng);
        assert.strictEqual(G.totalChips(t), total);
      }
    }
    const solo = G.newSession({ cpus: m - 1, stackBB: 30, seed: m, allBots: true, personalities: ['lv1', 'lv6'] });
    const chips = G.totalChips(solo);
    for (let h = 0; h < 10 && !solo.over; h++) {
      const hand = G.startHand(solo);
      if (!hand) break;
      while (!hand.over) G.stepBot(solo);
      assert.strictEqual(G.totalChips(solo), chips);
    }
  }
});

test('bots: at every Elo they bluff, vary their play and never repeat one action', () => {
  const rivers = { n: 0, bet: 0 };
  for (const bot of NN.LADDER) {
    const rng = G.newTable({ seed: 11 }).rng;
    const counts = {}, weak = { n: 0, bet: 0 }, river = { n: 0, bet: 0 }, sure = { n: 0, all: 0 };
    const run = new Array(6).fill(0), last = new Array(6).fill('');
    let longest = 0, total = 0;
    const t = G.newTable({ maxSeats: 9, seed: 3 });
    t.cfg.bb = 1000; t.cfg.sb = 500;
    for (let h = 0; h < 600; h++) {
      for (let i = 0; i < 6; i++) Object.assign(t.seats[i], { stack: 40000, busted: false });
      const hand = G.startHand(t, { active: [0, 1, 2, 3, 4, 5] });
      while (!hand.over) {
        const seat = hand.toAct, street = hand.street, L = G.legal(t, seat);
        const { p } = NN.policy(t, seat, bot, rng);
        const eq = hand.board.length && L.toCall === 0 ? E.equity(hand.seats[seat].cards, hand.board, 1, { samples: 100, rng }) : 1;
        sure.n++; if (Math.max(...p) > 0.98) sure.all++;
        const a = NN.step(t, seat, bot.id, rng).action;
        counts[a] = (counts[a] || 0) + 1; total++;
        // A bet or a raise is what counts as repeating: folding bad hands six times in a row is poker.
        if (a === 'raise' || a === 'bet') run[seat] = last[seat] === a ? run[seat] + 1 : 1;
        else run[seat] = 0;
        last[seat] = a;
        longest = Math.max(longest, run[seat]);
        if (L.toCall === 0 && L.canRaise && eq < 0.42) {
          const bet = a === 'bet' || a === 'raise';
          weak.n++; weak.bet += bet;
          if (street === 'river') { river.n++; river.bet += bet; }
        }
      }
    }
    const say = bot.id + ' ' + JSON.stringify({ counts, weak, river, sure, longest });
    assert.ok(weak.bet / weak.n > 0.1 && weak.bet / weak.n < 0.8, 'bluffs sometimes, not always: ' + say);
    rivers.n += river.n; rivers.bet += river.bet;
    assert.ok(Math.max(...Object.values(counts)) / total < 0.7, 'one action most of the time: ' + say);
    assert.ok(sure.all / sure.n < 0.4, 'the same choice every time: ' + say);
    assert.ok(longest < 12, 'bets every time: ' + say);
    if (process.env.BOT_STATS) console.log(say);
  }
  // All levels together: the weakest ones reach few rivers with a weak hand and the choice to bet.
  assert.ok(rivers.n > 50 && rivers.bet / rivers.n > 0.1, 'bluffs on the river: ' + JSON.stringify(rivers));
});

test('neural bots: legal play in 400 heads-up hands at every ladder level, chips conserved', () => {
  let seed = 7;
  const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (const bot of NN.LADDER) {
    const t = G.newTable({ maxSeats: 9, seed: 5 });
    t.cfg.bb = 1000; t.cfg.sb = 500;
    for (let h = 0; h < 400 / NN.LADDER.length; h++) {
      [0, 1].forEach((i) => Object.assign(t.seats[i], { stack: 50000, busted: false }));
      const hand = G.startHand(t, { active: [0, 1] });
      const total = G.totalChips(t);
      for (let n = 0; !hand.over; n++) {
        assert.ok(n < 60, 'hand does not end');
        const { p } = NN.policy(t, hand.toAct, bot, rng);
        assert.ok(Math.abs(p.reduce((x, y) => x + y, 0) - 1) < 1e-9);
        NN.step(t, hand.toAct, bot.id, rng);
        assert.strictEqual(G.totalChips(t), total);
      }
    }
  }
});

test('solo tables: bots of one Elo or a mix, with different names and the Elo in brackets', () => {
  const one = G.newSession({ cpus: 8, seed: 1, personalities: ['lv3'] }).seats.slice(1);
  assert.ok(one.every((x) => x.persona.type === 'lv3' && x.name.endsWith(' (' + Ladder.level('lv3').table + ')')));
  assert.strictEqual(new Set(one.map((x) => x.name)).size, 8);
  const all = Ladder.LADDER.map((b) => b.id), mixed = new Set();
  for (let s = 0; s < 10; s++) G.newSession({ cpus: 8, seed: s, personalities: all }).seats.slice(1).forEach((x) => mixed.add(x.persona.type));
  assert.deepStrictEqual([...mixed].sort(), all);
  const names = [].concat(...Ladder.LADDER.map((b) => b.names));
  assert.strictEqual(new Set(names).size, names.length);
  assert.ok(names.every((n) => n.length <= 16), 'room names hold 16 characters');
});

test('snapshot: a room saved mid-hand as JSON continues with the same cards, chips and turn', () => {
  const conn = () => ({ out: [], send(o) { this.out.push(o); }, close() {} });
  const room = new Room({ diagFile: false, timing: FAST });
  const x = conn(), y = conn();
  [[x, 'clientAAAA'], [y, 'clientBBBB']].forEach(([c, id]) => {
    room.connect(c);
    room.receive(c, { t: 'join', name: id.slice(-4), clientId: id });
  });
  room.receive(x, { t: 'start' });
  const before = room.table.hand;
  const copy = Room.restore(JSON.parse(JSON.stringify(room.snapshot())), { diagFile: false, timing: FAST });
  room.dispose();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(copy.table.hand)), JSON.parse(JSON.stringify(before)));
  assert.strictEqual(copy.chipsInPlay(), copy.netChips);
  const z = conn();
  copy.connect(z);
  copy.receive(z, { t: 'join', name: 'thief', clientId: 'clientAAAA' });
  assert.strictEqual(z.seat, null, 'the token is still needed');
  copy.receive(z, { t: 'join', name: 'AAAA', clientId: 'clientAAAA', token: x.out.find((m) => m.t === 'welcome').you.token });
  assert.strictEqual(z.seat, 0);
  const seat = copy.table.hand.toAct;
  copy._act({ seat }, { action: 'fold' });
  assert.ok(copy.table.hand.over);
  assert.strictEqual(copy.chipsInPlay(), copy.netChips);
  copy.dispose();
});

if (process.env.REDIS_URL) {
  test('two servers: players on different servers share a match, which survives losing its server', async () => {
    const s1 = await start(), s2 = await start();
    const { a, b, room } = await pair(s1, s2);
    const ca = client(s1, a.cookie), cb = client(s2, b.cookie);
    await ca.join(room);
    await cb.join(room);
    await until(() => ca.state && ca.state.hand && cb.state && cb.state.hand, 'hand on both servers');
    const turn = ca.state.hand.legal ? ca : cb;
    const id = ca.state.hand.id;
    turn.act('call');
    await until(() => ca.state.hand.toAct !== null && cb.state.hand.seats.some((x) => x.lastAction === 'call' || x.lastAction === 'limp'), 'the act crosses servers');
    const board = cb.state.hand.youCards;
    await wait(300);
    ca.kill(); // s1 has no socket left in the room: it lets the room go and cb is told to reconnect
    await until(() => cb.closed, 'handover');
    const cb2 = client(s2, b.cookie);
    await cb2.join(room);
    await until(() => cb2.state && cb2.state.hand, 'room restored on the second server');
    assert.strictEqual(cb2.state.hand.id, id);
    assert.deepStrictEqual(cb2.state.hand.youCards, board);
    const ca2 = client(s1, a.cookie);
    await ca2.join(room);
    await until(() => ca2.state, 'back through the other server');
    ca2.send({ t: 'resign' });
    await until(() => cb2.rated, 'result across servers');
    assert.strictEqual(cb2.rated.winner, b.name);
    s1.close();
    s2.close();
  });

  test('two servers: a casual room is listed and joinable on the other one, seat tokens work after a handover', async () => {
    const s1 = await start(), s2 = await start();
    const h = client(s1);
    await h.open;
    h.send({ t: 'createRoom', name: 'Cluster ' + newName() });
    const id = (await until(() => h.msgs.find((m) => m.t === 'roomJoined'), 'created')).id;
    h.send({ t: 'join', name: 'Host', clientId: 'host_client_1' });
    const w = await until(() => h.msgs.find((m) => m.t === 'welcome'), 'welcome');
    const g = client(s2);
    await g.open;
    g.send({ t: 'rooms' });
    await until(() => g.msgs.some((m) => m.t === 'roomList' && m.rooms.some((r) => r.id === id)), 'listed');
    await g.join(id, { clientId: 'guest_client_1' });
    await until(() => h.msgs.some((m) => m.t === 'lobby' && m.players.length === 2), 'guest seen by the host');
    await wait(300);
    h.kill();
    await until(() => g.closed, 'handover');
    const h2 = client(s2);
    await h2.join(id, { clientId: 'host_client_1', token: w.you.token, name: 'Host' });
    assert.strictEqual(h2.msgs.find((m) => m.t === 'welcome').you.seat, w.you.seat);
    s1.close();
    s2.close();
  });
}

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    const s = fn.length ? await start() : null;
    try {
      await fn(s);
      console.log('  ok   ' + name);
    } catch (e) {
      failed++;
      console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e));
    }
    if (s) s.close();
  }
  console.log(failed ? failed + ' ranked test(s) failed' : 'all ranked tests passed');
  process.exit(failed ? 1 : 0);
})();
