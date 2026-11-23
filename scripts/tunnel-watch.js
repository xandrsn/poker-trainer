'use strict';
/* Keeps a Cloudflare quick tunnel to the local server alive: starts cloudflared over HTTP/2 (TCP, works where
 * UDP/QUIC is filtered), reads the public URL, probes it every 20 s and restarts the tunnel when it stops
 * answering. The current URL is written to public-url.txt. Usage: node scripts/tunnel-watch.js [port] */
const { spawn } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2]) || 3000;
const EXE = process.env.CLOUDFLARED || 'C:/Program Files (x86)/cloudflared/cloudflared.exe';
const OUT = path.join(__dirname, '..', 'public-url.txt');
let child = null;
let url = '';
let fails = 0;
let urlAt = 0;
const GRACE_MS = 150000;   // a brand-new quick-tunnel name takes a while to resolve: do not judge it earlier
const MAX_FAILS = 4;

function log(m) { console.log(new Date().toISOString() + ' ' + m); }

function probe(u) {
  return new Promise((resolve) => {
    const req = https.get(u + '/', { timeout: 10000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function stop() {
  if (child) { try { child.kill(); } catch (e) { /* already gone */ } child = null; }
  url = '';
  try { fs.writeFileSync(OUT, ''); } catch (e) { /* ignore */ }
}

function start() {
  stop();
  fails = 0;
  log('starting tunnel (http2) to localhost:' + PORT);
  child = spawn(EXE, ['tunnel', '--protocol', 'http2', '--no-autoupdate', '--url', 'http://localhost:' + PORT], { windowsHide: true });
  const onData = (d) => {
    const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !url) { url = m[0]; fs.writeFileSync(OUT, url + '\n'); log('url ' + url); }
  };
  child.on('error', (e) => { log('spawn error ' + e.message); child = null; });
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (c) => { log('cloudflared exited ' + c); child = null; });
}

setInterval(async () => {
  if (!child) { start(); return; }
  if (!url) return;
  if (await probe(url)) { fails = 0; return; }
  if (Date.now() - urlAt < GRACE_MS) return;
  fails += 1;
  log('probe failed ' + fails + '/' + MAX_FAILS);
  if (fails >= MAX_FAILS) start();
}, 20000);
start();
