'use strict';
/* JSON API under /api: accounts, matchmaking, leaderboard. Requests that change something are POST with a
 * JSON body: with the SameSite cookie, another site cannot send them in the user's name. */
const { HttpError } = require('./accounts.js');
const { Ranked } = require('./ranked.js');
const { Google } = require('./google.js');

const MAX_BODY = 4096;

function reply(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function readJson(req) {
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'send JSON');
  const parts = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'too large');
    parts.push(c);
  }
  try { return JSON.parse(Buffer.concat(parts).toString() || '{}') || {}; } catch (e) { throw new HttpError(400, 'bad json'); }
}

// store and accounts are null where nothing can be saved (Vercel without Redis).
function createApi(store, accounts, manager) {
  const ranked = store && new Ranked(store, accounts, manager);
  const google = store && new Google(store, accounts);
  if (ranked) manager.opts.rankedService = ranked;

  async function user(req) {
    const u = await accounts.fromRequest(req);
    if (!u) throw new HttpError(401, 'sign in first');
    return u;
  }
  const routes = {
    'GET me': async (req) => ({ user: await accounts.me(req), google: google.on }),
    'GET bots': async () => ({ bots: ranked.bots() }),
    'GET leaderboard': async () => ({ players: await ranked.leaderboard() }),
    'GET profile': async (req) => ({ player: await ranked.profile(new URL(req.url, 'http://x').searchParams.get('name') || '') }),
    'POST register': async (req, res) => accounts.register(req, res, await readJson(req)),
    'POST login': async (req, res) => ({ user: await accounts.login(req, res, await readJson(req)) }),
    'POST recover': async (req, res) => accounts.recover(req, res, await readJson(req)),
    'POST recovery-code': async (req) => accounts.newRecovery(req, await readJson(req)),
    'POST google': async (req, res) => { const body = await readJson(req); return { url: await google.start(req, res, body.link ? await user(req) : null) }; },
    'POST google/finish': async (req, res) => ({ user: await google.finish(req, res, await readJson(req)) }),
    'GET google/callback': async (req, res) => {
      const next = await google.callback(req, res);
      res.writeHead(302, { Location: '/?google=' + next, 'Cache-Control': 'no-store' });
      res.end();
    },
    'POST logout': async (req, res) => { await readJson(req); await accounts.logout(req, res); return {}; },
    'POST queue': async (req) => { const body = await readJson(req); return ranked.find(await user(req), body); },
    'POST queue/cancel': async (req) => { await readJson(req); await ranked.cancel(await user(req)); return {}; },
  };

  return async function api(req, res, name) {
    try {
      const key = req.method + ' ' + name;
      const route = Object.prototype.hasOwnProperty.call(routes, key) && routes[key];
      if (!route) throw new HttpError(404, 'not found');
      if (!store) throw new HttpError(503, 'accounts are not set up on this server');
      const out = await route(req, res);
      if (!res.writableEnded) reply(res, 200, out);
    } catch (e) {
      if (!e.status) console.error('api: ' + (e && e.stack || e));
      reply(res, e.status || 500, { error: e.status ? e.message : 'server error' });
    }
  };
}

module.exports = { createApi };
