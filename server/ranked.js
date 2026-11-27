'use strict';
/* Ranked play for rating points: duels against a player of similar rating or a trained bot, and tables of 4 to 6.
 * The room itself (locked settings, forfeits, places) is server/room.js with `ranked` set. */
const crypto = require('crypto');
const NN = require('./nnbot.js');
const { HttpError } = require('./accounts.js');

const SETTINGS = { stack: 50000, sb: 500, bb: 1000, blindUpMin: 2, spectatorCards: 'off', botShowCards: true }; // 50 BB, blinds double every 2 min
const QUEUE_SEEN_MS = 8000;       // a waiting player who stops polling leaves the queue
const STALE_MS = 2 * 60 * 1000;   // a match nobody is connected to for this long is over
const ACTIVE_MS = 6 * 3600 * 1000;

const TABLE_SEATS = 6;            // at most; at least 4
const TABLE_WAIT_MS = 20000;      // then bots take the empty seats of a table

// Seats of a table that starts with `humans` waiting: as many as wait (4 to 6), or a random 4 to 6 filled by bots.
function tableSize(humans, rng) { return humans >= 4 ? Math.min(humans, TABLE_SEATS) : 4 + Math.floor(rng() * 3); }

// Rating change against opps [{ rating, won }]: the average over all of them. New players move faster.
function eloDelta(rating, opps, games) {
  const k = games < 20 ? 40 : 20;
  const sum = opps.reduce((n, o) => n + (o.won ? 1 : 0) - 1 / (1 + Math.pow(10, (o.rating - rating) / 400)), 0);
  return Math.round(k * sum / opps.length);
}

class Ranked {
  // rooms: the RoomManager (createRanked, status).
  constructor(store, accounts, rooms) {
    this.store = store;
    this.accounts = accounts;
    this.rooms = rooms;
    this.tableWaitMs = TABLE_WAIT_MS;
    this.rng = Math.random;
  }

  bots() { return NN.LADDER.map((b) => ({ id: b.id, name: b.name, rating: b.rating, table: b.table })); }

  // One poll of "find me a match": a duel (with `bot`: against it, now) or, with mode 'table', a table.
  // Returns { status:'matched', room } or { status:'waiting', waited }.
  async find(user, want) {
    const botId = want.bot;
    const resume = await this._resume(user);
    if (resume) return { status: 'matched', room: resume };
    if (botId !== undefined) {
      const bot = NN.LADDER.find((b) => b.id === botId);
      if (!bot) throw new HttpError(404, 'no such bot');
      await this.cancel(user);
      return { status: 'matched', room: await this._create('duel', [user], [bot]) };
    }
    const now = Date.now();
    if (!(await this.store.set('qlock', '1', { nx: true, px: 3000 }))) return { status: 'waiting', waited: 0 };
    try {
      if (want.mode === 'table') return await this._findTable(user, now);
      await this.store.hdel('queue:table', user.id);
      const q = await this.store.hgetall('queue');
      const mine = q[user.id] ? JSON.parse(q[user.id]) : null;
      const at = mine && now - mine.seen <= QUEUE_SEEN_MS ? mine.at : now;
      let best = null;
      for (const id of Object.keys(q)) {
        const e = JSON.parse(q[id]);
        if (now - e.seen > QUEUE_SEEN_MS) { await this.store.hdel('queue', id); continue; }
        if (id === user.id) continue;
        // The search widens with the longer of the two waits.
        const gap = Math.abs(e.rating - user.rating);
        if (gap <= 100 + 15 * (now - Math.min(at, e.at)) / 1000 && (!best || gap < best.gap)) best = { id, gap };
      }
      const opp = best && await this.accounts.user(best.id);
      if (opp) {
        await this.store.hdel('queue', opp.id);
        await this.store.hdel('queue', user.id);
        return { status: 'matched', room: await this._create('duel', [opp, user], []) };
      }
      await this.store.hset('queue', { [user.id]: JSON.stringify({ rating: user.rating, at, seen: now }) });
      return { status: 'waiting', waited: now - at };
    } finally {
      await this.store.del('qlock');
    }
  }

  // Six waiting players, or those who wait once the first has waited long enough, with bots on the other seats (tableSize).
  // shortcut: ratings are not compared, add bands when more than one table fills at a time.
  async _findTable(user, now) {
    await this.store.hdel('queue', user.id);
    const q = await this.store.hgetall('queue:table');
    const wait = [];
    for (const id of Object.keys(q)) {
      const e = JSON.parse(q[id]);
      if (id === user.id) continue;
      if (now - e.seen > QUEUE_SEEN_MS) await this.store.hdel('queue:table', id);
      else wait.push({ id, at: e.at });
    }
    const mine = q[user.id] ? JSON.parse(q[user.id]) : null;
    const me = { id: user.id, at: mine && now - mine.seen <= QUEUE_SEEN_MS ? mine.at : now };
    wait.sort((a, b) => a.at - b.at);
    const group = wait.slice(0, TABLE_SEATS - 1).concat(me);
    if (group.length === TABLE_SEATS || now - Math.min(...group.map((e) => e.at)) >= this.tableWaitMs) {
      const users = [];
      for (const e of group) {
        const u = await this.accounts.user(e.id);
        if (u) users.push(u);
        await this.store.hdel('queue:table', e.id);
      }
      const mean = users.reduce((n, u) => n + u.rating, 0) / users.length;
      const bots = NN.LADDER.slice().sort((a, b) => Math.abs(a.table - mean) - Math.abs(b.table - mean)).slice(0, tableSize(users.length, this.rng) - users.length);
      return { status: 'matched', room: await this._create('table', users, bots) };
    }
    await this.store.hset('queue:table', { [user.id]: JSON.stringify({ at: me.at, seen: now }) });
    return { status: 'waiting', waited: now - me.at, players: group.length };
  }

  async cancel(user) {
    await this.store.hdel('queue', user.id);
    await this.store.hdel('queue:table', user.id);
  }

  // The unfinished match of a user: its room while it lives. A match everybody left is settled first.
  async _resume(user) {
    const raw = await this.store.get('active:' + user.id);
    if (!raw) return null;
    const m = JSON.parse(raw);
    const st = await this.rooms.status(m.room, STALE_MS);
    if (st === 'live') return m.room;
    // Leaving a match against bots only is last place. With other players and nobody left, the match is void.
    if (m.ranked.players.length === 1) await this.settle(m.ranked, user.id, [], 1 + m.ranked.bots.length, 'left');
    else await this.abort(m.ranked, m.ranked.players);
    return null;
  }

  async _create(kind, users, bots) {
    const ranked = {
      matchId: crypto.randomBytes(9).toString('base64url'), kind,
      players: users.map((u) => ({ id: u.id, name: u.name, rating: u.rating })),
      bots: bots.map((b) => ({ id: b.id, name: b.name, rating: kind === 'table' ? b.table : b.rating })),
    };
    const room = await this.rooms.createRanked(ranked, SETTINGS);
    for (const u of users) await this.store.set('active:' + u.id, JSON.stringify({ room, ranked }), { px: ACTIVE_MS });
    return room;
  }

  _claim(ranked, id, value) {
    return this.store.set('settled:' + ranked.matchId + ':' + id, value, { nx: true, px: 7 * 24 * 3600 * 1000 });
  }

  // Frees the player, unless another match has started meanwhile.
  async _free(ranked, id) {
    const raw = await this.store.get('active:' + id);
    if (raw && JSON.parse(raw).ranked.matchId === ranked.matchId) await this.store.del('active:' + id);
  }

  // Applies one player's result once. beaten: keys ('user_' + id, 'bot_' + id) of those placed below.
  // Opponents count with their rating at the start of the match. Returns the rating change.
  async settle(ranked, id, beaten, place, reason) {
    if (!(await this._claim(ranked, id, '1'))) return null;
    const u = await this.accounts.user(id);
    if (!u) return null;
    const opps = ranked.players.map((p) => ({ key: 'user_' + p.id, name: p.name, rating: p.rating }))
      .concat(ranked.bots.map((b) => ({ key: 'bot_' + b.id, name: b.name, rating: b.rating })))
      .filter((o) => o.key !== 'user_' + id).map((o) => Object.assign(o, { won: beaten.indexOf(o.key) >= 0 }));
    const won = place === 1;
    const delta = eloDelta(u.rating, opps, u.games);
    const after = await this.store.hincr('user:' + id, 'rating', delta);
    await this.store.hincr('user:' + id, 'games', 1);
    if (won) await this.store.hincr('user:' + id, 'wins', 1);
    if (after > u.peak) await this.store.hset('user:' + id, { peak: after });
    await this.store.zadd('board', after, id);
    const game = { at: Date.now(), won, delta, after, reason };
    if (ranked.kind === 'table') Object.assign(game, { place, of: opps.length + 1 });
    else Object.assign(game, { opp: opps[0].name, oppRating: opps[0].rating, bot: !!ranked.bots.length });
    await this.store.lpush('hist:' + id, JSON.stringify(game), 50);
    await this._free(ranked, id);
    return { id, name: u.name, before: after - delta, after, delta, won, place };
  }

  // These players never played: no rating change.
  async abort(ranked, players) {
    for (const p of players) {
      await this._claim(ranked, p.id, 'void');
      await this._free(ranked, p.id);
    }
  }

  async leaderboard() {
    const top = await this.store.ztop('board', 50);
    const out = [];
    for (const [id] of top) {
      const u = await this.accounts.user(id);
      if (u) out.push({ name: u.name, rating: u.rating, games: u.games, wins: u.wins });
    }
    return out;
  }

  async profile(name) {
    const u = await this.accounts.user(name);
    if (!u) throw new HttpError(404, 'no such player');
    const rank = await this.store.zrank('board', u.id);
    const history = (await this.store.lrange('hist:' + u.id, 50)).map((s) => JSON.parse(s));
    return Object.assign(u, { rank: rank == null ? null : rank + 1, history });
  }
}

module.exports = { Ranked, eloDelta, tableSize, SETTINGS };
