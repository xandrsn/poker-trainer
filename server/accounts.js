'use strict';
/* Accounts: name + password (scrypt) or Google (server/google.js), session cookie, rating record. A lost password is
 * replaced with a one-time recovery code, shown when the account is made. Every rating starts at START_RATING. */
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const START_RATING = 800; // as a chess beginner; the bots run from 300 to 3000
const SESSION_MS = 30 * 24 * 3600 * 1000;
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const COOKIE = 'pt_session';
const LIMIT = 10, LIMIT_MS = 10 * 60 * 1000; // sign-in attempts per address
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + (await scrypt(pw, salt, 32)).toString('hex');
}
async function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  const want = Buffer.from(hash || '', 'hex');
  const got = await scrypt(pw, Buffer.from(salt || '', 'hex'), 32);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
let dummyHash = null; // compared against for unknown names, so the reply time does not reveal which names exist

function cookieValue(req, name) {
  const m = new RegExp('(?:^|;\\s*)' + name + '=([A-Za-z0-9_-]{20,64})').exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
// Vercel sets x-forwarded-for itself; anywhere else the header could be forged.
function ipOf(req) {
  if (process.env.VERCEL) return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || '?';
  return req.socket.remoteAddress || '?';
}
function isHttps(req) {
  return !!(process.env.VERCEL || req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted);
}
function addCookie(req, res, name, value, maxAge) {
  const c = name + '=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (isHttps(req) ? '; Secure' : '');
  res.setHeader('Set-Cookie', [].concat(res.getHeader('Set-Cookie') || [], c));
}

// 80 random bits, easy to copy by hand: no 0/O or 1/I. Its SHA-256 is enough in the store, it cannot be guessed.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  return Array.from(crypto.randomBytes(16), (b) => CODE_CHARS[b & 31]).join('').match(/.{4}/g).join('-');
}
const hashCode = (code) => sha(String(code).toUpperCase().replace(/[^A-Z0-9]/g, ''));

class Accounts {
  constructor(store) { this.store = store; }

  // Public record of a user, or null. Never includes the password hash or how the player signs in.
  async user(id) {
    const u = await this.store.hgetall('user:' + String(id).toLowerCase());
    if (!u || !u.name) return null;
    return { id: String(id).toLowerCase(), name: u.name, rating: Number(u.rating), games: Number(u.games), wins: Number(u.wins),
      peak: Number(u.peak) || Number(u.rating), created: Number(u.created) };
  }

  // The signed-in user of an HTTP (or WebSocket upgrade) request, or null.
  async fromRequest(req) {
    const token = cookieValue(req, COOKIE);
    const s = token && await this.store.get('sess:' + sha(token));
    if (!s) return null;
    const [id, epoch] = s.split(' ');
    // Recovering the account raises its epoch, which ends every older session.
    const now = (await this.store.hgetall('user:' + id)).epoch;
    return Number(epoch || 0) === Number(now || 0) ? this.user(id) : null;
  }

  // The signed-in user with how they can sign in, for their own eyes.
  async me(req) {
    const user = await this.fromRequest(req);
    if (!user) return null;
    const u = await this.store.hgetall('user:' + user.id);
    return Object.assign(user, { password: !!u.hash, google: !!u.google });
  }

  async _limit(req) {
    const n = await this.store.incr('rl:' + ipOf(req), LIMIT_MS);
    if (n > LIMIT) throw new HttpError(429, 'too many attempts, try again in a few minutes');
  }

  _name(body) {
    const name = body && body.name;
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw new HttpError(400, 'name must be 3-16 letters, numbers or _');
    return name;
  }
  _credentials(body) {
    const name = this._name(body), password = body.password;
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw new HttpError(400, 'password must be 8-128 characters');
    return { name, password, id: name.toLowerCase() };
  }

  async startSession(req, res, id) {
    const token = crypto.randomBytes(32).toString('base64url');
    const epoch = (await this.store.hgetall('user:' + id)).epoch || 0;
    await this.store.set('sess:' + sha(token), id + ' ' + epoch, { px: SESSION_MS });
    addCookie(req, res, COOKIE, token, SESSION_MS / 1000);
  }

  // The claim key is atomic: two sign-ups with the same name cannot both pass.
  async _create(name, secrets) {
    const id = name.toLowerCase();
    if (!(await this.store.set('name:' + id, '1', { nx: true }))) throw new HttpError(409, 'that name is taken');
    await this.store.hset('user:' + id, Object.assign({ name, rating: START_RATING, games: 0, wins: 0, peak: START_RATING, created: Date.now() }, secrets));
    return id;
  }

  async register(req, res, body) {
    await this._limit(req);
    const c = this._credentials(body);
    const code = newCode();
    const id = await this._create(c.name, { hash: await hashPassword(c.password), recovery: hashCode(code) });
    await this.startSession(req, res, id);
    return { user: await this.user(id), code };
  }

  // A new account that signs in with Google only.
  async createWithGoogle(req, body, sub) {
    await this._limit(req);
    const name = this._name(body), id = name.toLowerCase();
    if (!(await this.store.set('google:' + sub, id, { nx: true }))) throw new HttpError(410, 'start again with Google');
    try {
      return await this._create(name, { google: sub });
    } catch (e) {
      await this.store.del('google:' + sub);
      throw e;
    }
  }

  // A new password with the recovery code. The code is used up; every other session ends.
  async recover(req, res, body) {
    await this._limit(req);
    const c = this._credentials(body);
    const u = await this.store.hgetall('user:' + c.id);
    const got = Buffer.from(hashCode(body.code)), want = Buffer.from(u.recovery || sha(''));
    if (!u.recovery || !crypto.timingSafeEqual(got, want)) throw new HttpError(401, 'wrong name or recovery code');
    const code = newCode();
    await this.store.hset('user:' + c.id, { hash: await hashPassword(c.password), recovery: hashCode(code) });
    await this.store.hincr('user:' + c.id, 'epoch', 1);
    await this.startSession(req, res, c.id);
    return { user: await this.user(c.id), code };
  }

  // A new recovery code for the signed-in player, who proves it with the password. The old code stops working.
  async newRecovery(req, body) {
    const user = await this.fromRequest(req);
    if (!user) throw new HttpError(401, 'sign in first');
    await this._limit(req);
    const u = await this.store.hgetall('user:' + user.id);
    if (!u.hash || typeof body.password !== 'string' || body.password.length > 128 || !(await checkPassword(body.password, u.hash))) {
      throw new HttpError(403, 'wrong password');
    }
    const code = newCode();
    await this.store.hset('user:' + user.id, { recovery: hashCode(code) });
    return { code };
  }

  async login(req, res, body) {
    await this._limit(req);
    const c = this._credentials(body);
    const u = await this.store.hgetall('user:' + c.id);
    if (!dummyHash) dummyHash = await hashPassword('-');
    const ok = await checkPassword(c.password, (u && u.hash) || dummyHash);
    if (!ok || !u || !u.hash) throw new HttpError(401, 'wrong name or password');
    await this.startSession(req, res, c.id);
    return this.user(c.id);
  }

  async logout(req, res) {
    const token = cookieValue(req, COOKIE);
    if (token) await this.store.del('sess:' + sha(token));
    addCookie(req, res, COOKIE, '', 0);
  }
}

module.exports = { Accounts, HttpError, START_RATING, addCookie, cookieValue, isHttps, sha };
