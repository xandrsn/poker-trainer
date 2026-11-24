'use strict';
/* Sign in with Google: authorization code flow with state, nonce and PKCE. On when GOOGLE_CLIENT_ID and
 * GOOGLE_CLIENT_SECRET are set. The redirect URI to register with Google is <site>/api/google/callback.
 * Only Google's account number (sub) is kept: no email, no profile. */
const crypto = require('crypto');
const { HttpError, addCookie, cookieValue, isHttps, sha } = require('./accounts.js');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const FLOW_MS = 10 * 60 * 1000;    // time to get through Google's pages
const PENDING_MS = 15 * 60 * 1000; // time to choose a name
const STATE = 'pt_oauth', PENDING = 'pt_pending';
const random = () => crypto.randomBytes(32).toString('base64url');

class Google {
  constructor(store, accounts) {
    this.store = store;
    this.accounts = accounts;
    this.id = process.env.GOOGLE_CLIENT_ID;
    this.secret = process.env.GOOGLE_CLIENT_SECRET;
  }
  get on() { return !!(this.id && this.secret); }

  // Google only redirects to registered addresses, so a forged Host header leads nowhere.
  _redirectUri(req) {
    const base = process.env.PUBLIC_URL || (isHttps(req) ? 'https://' : 'http://') + req.headers.host;
    return base.replace(/\/+$/, '') + '/api/google/callback';
  }

  // Starts the flow: the address of Google's page. user: the signed-in player who wants to connect Google, or null.
  async start(req, res, user) {
    if (!this.on) throw new HttpError(404, 'Google sign-in is not set up');
    const state = random(), nonce = random(), verifier = random();
    await this.store.set('goog:' + sha(state), JSON.stringify({ nonce, verifier, link: user ? user.id : null }), { px: FLOW_MS });
    addCookie(req, res, STATE, state, FLOW_MS / 1000);
    return AUTH_URL + '?' + new URLSearchParams({
      client_id: this.id, redirect_uri: this._redirectUri(req), response_type: 'code', scope: 'openid', state, nonce,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      prompt: 'select_account',
    });
  }

  // Google sends the player back here. Returns what the page shows next: ok, linked, taken, name or error.
  async callback(req, res) {
    const q = new URL(req.url, 'http://x').searchParams;
    const state = q.get('state') || '';
    const mine = cookieValue(req, STATE);
    addCookie(req, res, STATE, '', 0);
    if (!this.on || !state || state !== mine) return 'error'; // the flow must have started in this browser
    const raw = await this.store.get('goog:' + sha(state));
    await this.store.del('goog:' + sha(state));
    if (!raw || !q.get('code')) return 'error';
    const flow = JSON.parse(raw);
    const sub = await this._exchange(req, q.get('code'), flow);
    if (!sub) return 'error';
    const key = 'google:' + sub;
    if (flow.link) {
      const now = await this.accounts.fromRequest(req);
      if (!now || now.id !== flow.link) return 'error';
      await this.store.set(key, now.id, { nx: true });
      if ((await this.store.get(key)) !== now.id) return 'taken';
      await this.store.hset('user:' + now.id, { google: sub });
      return 'linked';
    }
    const id = await this.store.get(key);
    if (id) {
      await this.accounts.startSession(req, res, id);
      return 'ok';
    }
    const token = random();
    await this.store.set('gpend:' + sha(token), sub, { px: PENDING_MS });
    addCookie(req, res, PENDING, token, PENDING_MS / 1000);
    return 'name';
  }

  // The player's Google account number, or null. The ID token comes straight from Google over TLS,
  // which is what proves it; its claims still have to be meant for this site and this flow.
  async _exchange(req, code, flow) {
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      body: new URLSearchParams({ code, client_id: this.id, client_secret: this.secret, redirect_uri: this._redirectUri(req),
        grant_type: 'authorization_code', code_verifier: flow.verifier }),
    }).catch((e) => { console.error('google: ' + e.message); return null; });
    if (!r || !r.ok) { if (r) console.error('google: token request refused, ' + r.status); return null; }
    try {
      const c = JSON.parse(Buffer.from((await r.json()).id_token.split('.')[1], 'base64url').toString());
      const ok = ISSUERS.indexOf(c.iss) >= 0 && c.aud === this.id && c.exp * 1000 > Date.now() && c.nonce === flow.nonce;
      return ok && /^\d{1,64}$/.test(c.sub) ? c.sub : null;
    } catch (e) { return null; }
  }

  // A new player chose a name.
  async finish(req, res, body) {
    const token = cookieValue(req, PENDING);
    const sub = token && await this.store.get('gpend:' + sha(token));
    if (!sub) throw new HttpError(410, 'start again with Google');
    const id = await this.accounts.createWithGoogle(req, body, sub);
    await this.store.del('gpend:' + sha(token));
    addCookie(req, res, PENDING, '', 0);
    await this.accounts.startSession(req, res, id);
    return this.accounts.user(id);
  }
}

module.exports = { Google };
