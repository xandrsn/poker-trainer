const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { attachMultiplayer } = require('./server/mp.js');
const { RoomManager } = require('./server/rooms.js');
const { createStore, redisUrl } = require('./server/store.js');
const { Accounts } = require('./server/accounts.js');
const { createApi } = require('./server/api.js');
const { Cluster } = require('./server/cluster.js');

const PORT = process.env.PORT || 3000;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;
const ROOT = path.join(__dirname, 'public');
const CERT_DIR = path.join(__dirname, 'certs');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ICE servers for WebRTC. STUN always; TURN only when TURN_URLS is set (comma-separated).
// Credentials come from TURN_USER / TURN_PASS at request time and are never stored here.
function rtcConfig(env) {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
  const urls = String(env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (urls.length) {
    const turn = { urls: urls };
    if (env.TURN_USER) turn.username = env.TURN_USER;
    if (env.TURN_PASS) turn.credential = env.TURN_PASS;
    iceServers.push(turn);
  }
  return { iceServers: iceServers };
}

// Non-internal IPv4 addresses of this machine (for the LAN HTTPS URLs).
function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach((name) => {
    (nets[name] || []).forEach((n) => {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    });
  });
  return out;
}

// Key and certificate from certs/ (see npm run cert), or null when absent.
function loadCerts(dir) {
  const keyFile = path.join(dir || CERT_DIR, 'key.pem');
  const certFile = path.join(dir || CERT_DIR, 'cert.pem');
  if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) return null;
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}

function sendJson(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Request handler shared by the HTTP and HTTPS servers.
// opts: { httpsActive, httpsPort } (for /lan-info), { api } (accounts and ranked play).
function createHandler(opts) {
  const o = opts || {};
  return (req, res) => {
    const pathOnly = req.url.split('?')[0];
    if (o.api && pathOnly.startsWith('/api/')) return o.api(req, res, pathOnly.slice(5));
    if (pathOnly === '/rtc-config') return sendJson(res, rtcConfig(process.env));
    if (pathOnly === '/lan-info') {
      const port = o.httpsPort || HTTPS_PORT;
      return sendJson(res, {
        urls: lanAddresses().map((ip) => 'https://' + ip + ':' + port),
        https: !!o.httpsActive,
      });
    }
    let urlPath;
    try { urlPath = decodeURIComponent(pathOnly); } catch (e) { res.writeHead(400).end('Bad request'); return; }
    if (urlPath === '/') urlPath = '/index.html';
    const file = path.normalize(path.join(ROOT, urlPath));
    if (!file.startsWith(ROOT + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  };
}

// Static files from public/, /rtc-config, /lan-info, and the multiplayer table on WebSocket /ws.
// opts (optional): { seed, timing, diagFile, httpsActive, httpsPort, storeFile (accounts without Redis) }.
// Accounts and room sharing use Redis when REDIS_URL is set. On Vercel without it there are no accounts
// (its memory and disk do not last), and rooms live in one function instance only.
function createServer(opts) {
  const o = Object.assign({}, opts);
  const store = redisUrl() || !process.env.VERCEL ? createStore({ file: o.storeFile }) : null;
  const accounts = store && new Accounts(store);
  const manager = new RoomManager(o);
  if (store && store.kind === 'redis') new Cluster(manager, store);
  o.api = createApi(store, accounts, manager);
  const server = http.createServer(createHandler(o));
  server.api = o.api;
  server.multiplayer = attachMultiplayer(server, Object.assign({}, o, { manager, accounts }));
  return server;
}

// The same app over HTTPS (wss for /ws), sharing the rooms of an existing HTTP server
// (pass its RoomManager, or a single Room which then becomes the default room).
function createHttpsServer(roomsOrRoom, creds, opts) {
  const server = https.createServer(creds, createHandler(opts));
  attachMultiplayer(server, roomsOrRoom instanceof RoomManager ? { manager: roomsOrRoom } : { room: roomsOrRoom });
  return server;
}

module.exports = { createServer, createHttpsServer, rtcConfig, lanAddresses, loadCerts, createHandler };

if (require.main === module) {
  const creds = loadCerts();
  const handlerOpts = { httpsActive: !!creds, httpsPort: HTTPS_PORT };
  const httpServer = createServer(Object.assign({ storeFile: path.join(__dirname, 'data', 'store.json') }, handlerOpts));
  handlerOpts.api = httpServer.api;
  httpServer.listen(PORT, () => console.log(`Poker Trainer running at http://localhost:${PORT}`));
  if (creds) {
    const httpsServer = createHttpsServer(httpServer.multiplayer.manager, creds, handlerOpts);
    httpsServer.listen(HTTPS_PORT, () => console.log(`LAN HTTPS at https://localhost:${HTTPS_PORT} (certs/)`));
  } else {
    console.log('No certs/ found: LAN HTTPS is off (run npm run cert to enable it).');
  }
}
