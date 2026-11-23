'use strict';
/* npm run cert: self-signed certificate for LAN HTTPS (certs/key.pem, certs/cert.pem).
 * SAN: localhost, 127.0.0.1 and every non-internal IPv4 address of this machine.
 * Needs openssl: found on PATH, else C:\Program Files\Git\usr\bin\openssl.exe. Keys are never committed. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CERT_DIR = path.join(__dirname, '..', 'certs');
const GIT_OPENSSL = 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe';

function findOpenssl() {
  const onPath = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  if (onPath.status === 0) return 'openssl';
  if (fs.existsSync(GIT_OPENSSL)) return GIT_OPENSSL;
  return null;
}

function lanIps() {
  const ips = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach((name) => {
    (nets[name] || []).forEach((n) => {
      if (n.family === 'IPv4' && !n.internal && ips.indexOf(n.address) < 0) ips.push(n.address);
    });
  });
  return ips;
}

function main() {
  const openssl = findOpenssl();
  if (!openssl) {
    console.error('openssl not found on PATH or at ' + GIT_OPENSSL + '. Install Git for Windows or OpenSSL.');
    process.exit(1);
  }
  const ips = lanIps();
  const san = ['DNS:localhost', 'IP:127.0.0.1'].concat(ips.map((ip) => 'IP:' + ip)).join(',');
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const keyFile = path.join(CERT_DIR, 'key.pem');
  const certFile = path.join(CERT_DIR, 'cert.pem');
  const res = spawnSync(openssl, [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
    '-keyout', keyFile, '-out', certFile,
    '-subj', '/CN=poker-trainer LAN',
    '-addext', 'subjectAltName=' + san,
  ], { encoding: 'utf8' });
  if (res.status !== 0) {
    console.error('openssl failed:\n' + (res.stderr || res.stdout));
    process.exit(1);
  }
  console.log('Certificate written to ' + certFile + ' and ' + keyFile);
  console.log('SAN: localhost, 127.0.0.1' + ips.map((ip) => ', ' + ip).join(''));
}

if (require.main === module) main();

module.exports = { lanIps };
