'use strict';
/* Key-value store for accounts, ratings, matchmaking and room snapshots.
 * REDIS_URL (or KV_URL) set: Redis, shared by every server instance. Otherwise: memory, saved to a JSON
 * file when `file` is given (single local server). Same small async API for both. */
const fs = require('fs');
const path = require('path');

function redisUrl() { return process.env.REDIS_URL || process.env.KV_URL || ''; }

function redisStore(url) {
  const Redis = require('ioredis');
  const make = () => {
    const c = new Redis(url, { maxRetriesPerRequest: 3 });
    c.on('error', (e) => console.error('redis: ' + e.message)); // ioredis reconnects by itself
    return c;
  };
  const r = make();
  return {
    kind: 'redis',
    raw: r,
    subscriber: make,
    get: (k) => r.get(k),
    async set(k, v, o) {
      const a = [k, v];
      if (o && o.px) a.push('PX', o.px);
      if (o && o.nx) a.push('NX');
      return (await r.set(...a)) === 'OK';
    },
    del: (k) => r.del(k),
    hgetall: (k) => r.hgetall(k),
    hset: (k, o) => r.hset(k, o),
    hdel: (k, f) => r.hdel(k, f),
    hincr: (k, f, n) => r.hincrby(k, f, n),
    zadd: (k, score, m) => r.zadd(k, score, m),
    async ztop(k, n) {
      const a = await r.zrevrange(k, 0, n - 1, 'WITHSCORES');
      const out = [];
      for (let i = 0; i < a.length; i += 2) out.push([a[i], Number(a[i + 1])]);
      return out;
    },
    zrank: (k, m) => r.zrevrank(k, m),
    async lpush(k, v, max) { await r.multi().lpush(k, v).ltrim(k, 0, max - 1).exec(); },
    lrange: (k, n) => r.lrange(k, 0, n - 1),
    async incr(k, px) {
      const n = await r.incr(k);
      if (n === 1) await r.pexpire(k, px);
      return n;
    },
  };
}

function memoryStore(file) {
  let data = {}; // key -> { v, exp }
  if (file && fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8'));
  let timer = null;
  const save = () => {
    if (!file || timer) return;
    timer = setTimeout(() => {
      timer = null;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(data));
      fs.renameSync(file + '.tmp', file); // never leaves a half-written file behind
    }, 300);
  };
  const live = (k) => {
    const e = data[k];
    if (e && e.exp && e.exp <= Date.now()) { delete data[k]; return undefined; }
    return e;
  };
  const obj = (k, empty) => {
    if (!live(k)) data[k] = { v: empty };
    return data[k].v;
  };
  const peek = (k, empty) => (live(k) ? data[k].v : empty);
  const ranked = (k) => Object.entries(peek(k, {})).sort((a, b) => b[1] - a[1]);
  return {
    kind: 'memory',
    async get(k) { return peek(k, null); },
    async set(k, v, o) {
      if (o && o.nx && live(k)) return false;
      data[k] = { v: String(v) };
      if (o && o.px) data[k].exp = Date.now() + o.px;
      save();
      return true;
    },
    async del(k) { delete data[k]; save(); },
    async hgetall(k) { return Object.assign({}, peek(k, {})); },
    async hset(k, o) { const h = obj(k, {}); Object.keys(o).forEach((f) => { h[f] = String(o[f]); }); save(); },
    async hdel(k, f) { delete peek(k, {})[f]; save(); },
    async hincr(k, f, n) { const h = obj(k, {}); h[f] = String((Number(h[f]) || 0) + n); save(); return Number(h[f]); },
    async zadd(k, score, m) { obj(k, {})[m] = Number(score); save(); },
    async ztop(k, n) { return ranked(k).slice(0, n); },
    async zrank(k, m) { const i = ranked(k).findIndex((e) => e[0] === m); return i < 0 ? null : i; },
    async lpush(k, v, max) { const l = obj(k, []); l.unshift(v); l.length = Math.min(l.length, max); save(); },
    async lrange(k, n) { return peek(k, []).slice(0, n); },
    async incr(k, px) {
      const e = live(k);
      if (!e) data[k] = { v: 0, exp: Date.now() + px };
      save();
      return (data[k].v = Number(data[k].v) + 1);
    },
  };
}

function createStore(opts) {
  const url = redisUrl();
  if (url && !(opts && opts.memory)) return redisStore(url);
  return memoryStore(opts && opts.file);
}

module.exports = { createStore, redisUrl };
