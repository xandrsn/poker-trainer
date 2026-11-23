'use strict';
/* Media diagnostics log: JSON lines, one per accepted client report.
 * Rotated at maxBytes (old file kept as <file>.1). Reports are sanitised: keys that could carry
 * camera, audio, chat or SDP content are dropped, long strings are cut. */
const fs = require('fs');
const path = require('path');

const DROP_KEYS = /chat|text|msg|message|audio|video|frame|stream|camera|mic|sdp/i;
const MAX_STR = 300;

function sanitize(v, depth) {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > MAX_STR ? v.slice(0, MAX_STR) : v;
  if (depth <= 0) return undefined;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => sanitize(x, depth - 1)).filter((x) => x !== undefined);
  if (typeof v === 'object') {
    const out = {};
    Object.keys(v).forEach((k) => {
      if (DROP_KEYS.test(k)) return;
      const s = sanitize(v[k], depth - 1);
      if (s !== undefined) out[k] = s;
    });
    return out;
  }
  return undefined;
}

class DiagLog {
  // file: absolute path; maxBytes: rotate size.
  constructor(file, maxBytes) {
    this.file = file;
    this.maxBytes = maxBytes || 5 * 1024 * 1024;
  }

  append(entry) {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      clientId: entry.clientId,
      name: entry.name,
      kind: entry.kind,
      data: sanitize(entry.data, 4),
    }) + '\n';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try {
      if (fs.statSync(this.file).size >= this.maxBytes) fs.renameSync(this.file, this.file + '.1');
    } catch (e) { /* no file yet */ }
    fs.appendFileSync(this.file, line);
  }
}

module.exports = { DiagLog, sanitize };
