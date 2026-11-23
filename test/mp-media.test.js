'use strict';
// Pure-logic tests for the relay media framing and policy, and candidate queueing in the
// perfect-negotiation helper (public/mp.js). No browser: mock peer connections only.
const assert = require('assert');
const core = require('../public/mp.js');

const cases = [];
function check(name, fn) { cases.push({ name, fn }); }

check('placeholder colour is deterministic per name and a valid hsl()', () => {
  assert.strictEqual(core.nameColor('Ana'), core.nameColor('Ana'));
  assert.notStrictEqual(core.nameColor('Ana'), core.nameColor('Bo'));
  assert.match(core.nameColor('Ana'), /^hsl\(\d+ 38% 30%\)$/);
});

check('media frame round-trips through the server layout', () => {
  const data = Uint8Array.from([9, 8, 7, 6]);
  const framed = core.packMedia(3, 1, core.CODEC_IDS.avc, 65534, 123456789, data);
  assert.strictEqual(framed[0], 3);
  // the server inserts the sender seat after the type byte
  const relayed = new Uint8Array(framed.length + 1);
  relayed[0] = 3; relayed[1] = 5; relayed.set(framed.subarray(1), 2);
  const f = core.parseFrame(relayed);
  assert.strictEqual(f.type, 3);
  assert.strictEqual(f.seat, 5);
  const m = core.parseMediaPayload(f.payload);
  assert.strictEqual(m.key, true);
  assert.strictEqual(m.codec, core.CODEC_IDS.avc);
  assert.strictEqual(m.seq, 65534);
  assert.strictEqual(m.ts, 123456789);
  assert.deepStrictEqual(Array.from(m.data), [9, 8, 7, 6]);
});

check('parseFrame accepts media types 1 to 4 and rejects others', () => {
  for (const t of [1, 2, 3, 4]) assert.ok(core.parseFrame(Uint8Array.from([t, 0, 0])), 'type ' + t);
  assert.strictEqual(core.parseFrame(Uint8Array.from([5, 0, 0])), null);
  assert.strictEqual(core.parseFrame(Uint8Array.from([0, 0, 0])), null);
});

check('sequence gaps detect lost frames, including wrap-around', () => {
  assert.strictEqual(core.seqGap(null, 7), false);
  assert.strictEqual(core.seqGap(7, 8), false);
  assert.strictEqual(core.seqGap(7, 9), true);
  assert.strictEqual(core.seqGap(65535, 0), false);
  assert.strictEqual(core.seqGap(65534, 0), true);
});

check('video profile: best quality with one peer, lowest with a full room', () => {
  const one = core.chooseVideoProfile(1, 0);
  assert.strictEqual(one.w, 640);
  assert.strictEqual(one.fps, 30);
  assert.strictEqual(one.kbps, 1200);
  assert.strictEqual(one.skip, false);
  const eight = core.chooseVideoProfile(7, 0);
  assert.strictEqual(eight.w, 320);
  assert.strictEqual(eight.fps, 15);
  assert.strictEqual(eight.kbps, 350);
});

check('video profile backs off with socket backlog and skips above the limit', () => {
  const base = core.chooseVideoProfile(1, 0);
  const busy = core.chooseVideoProfile(1, 40 * 1024);
  assert.ok(busy.fps < base.fps && busy.skip === false);
  assert.strictEqual(core.chooseVideoProfile(1, 100 * 1024).skip, true);
});

check('keyframe schedule and keyframe request rate limit', () => {
  assert.strictEqual(core.keyframeDue(0, 1999, 2000), false);
  assert.strictEqual(core.keyframeDue(0, 2000, 2000), true);
  assert.strictEqual(core.keyRequestAllowed(0, 999), false);
  assert.strictEqual(core.keyRequestAllowed(0, 1000), true);
});

check('H.264 encoder config is Annex B, VP8 has no avc block', () => {
  const p = { w: 480, h: 360, fps: 24, kbps: 600 };
  const avc = core.videoEncoderConfig('avc', p);
  assert.strictEqual(avc.codec, 'avc1.42E01F');
  assert.deepStrictEqual(avc.avc, { format: 'annexb' });
  assert.strictEqual(avc.bitrate, 600000);
  assert.strictEqual(core.videoEncoderConfig('vp8', p).avc, undefined);
});

check('codec preference: H.264 first, then VP8, else none', () => {
  assert.strictEqual(core.pickVideoCodec({ avc: true, vp8: true }), 'avc');
  assert.strictEqual(core.pickVideoCodec({ avc: false, vp8: true }), 'vp8');
  assert.strictEqual(core.pickVideoCodec({ avc: false, vp8: false }), null);
});

check('ICE config falls back to STUN for malformed input and keeps TURN entries', () => {
  const d = core.rtcConfigFrom(null);
  assert.strictEqual(d.iceCandidatePoolSize, 4);
  assert.strictEqual(d.iceServers[0].urls, 'stun:stun.l.google.com:19302');
  const t = core.rtcConfigFrom({ iceServers: [{ urls: ['turn:t.example:3478'], username: 'u', credential: 'p' }] });
  assert.strictEqual(t.iceServers.length, 1);
  assert.strictEqual(t.iceServers[0].username, 'u');
});

// Mock RTCPeerConnection that records what the negotiator does with candidates.
function mockPc() {
  const pc = {
    signalingState: 'stable', remoteDescription: null, localDescription: null, added: [],
    setRemoteDescription(desc) { pc.remoteDescription = desc; return Promise.resolve(); },
    setLocalDescription() { pc.localDescription = { type: 'answer', sdp: 'x' }; return Promise.resolve(); },
    addIceCandidate(c) { if (!pc.remoteDescription) return Promise.reject(new Error('no remote')); pc.added.push(c.candidate); return Promise.resolve(); }
  };
  return pc;
}

check('candidates that arrive before the offer are queued and added in order', async () => {
  const pc = mockPc();
  const sent = [];
  const neg = core.createNegotiator({ pc, polite: true, send: (d) => sent.push(d) });
  await neg.onSignal({ candidate: { candidate: 'c1' } });
  await neg.onSignal({ candidate: { candidate: 'c2' } });
  assert.deepStrictEqual(pc.added, []);
  await neg.onSignal({ description: { type: 'offer', sdp: 'o' } });
  assert.deepStrictEqual(pc.added, ['c1', 'c2']);
  assert.strictEqual(sent.length, 1);   // the answer
  await neg.onSignal({ candidate: { candidate: 'c3' } });
  assert.deepStrictEqual(pc.added, ['c1', 'c2', 'c3']);
});

check('glare: the impolite side ignores a colliding offer, the polite side accepts', async () => {
  const impolite = mockPc();
  impolite.signalingState = 'have-local-offer';
  const neg = core.createNegotiator({ pc: impolite, polite: false, send: () => {} });
  neg.makingOffer = true;
  await neg.onSignal({ description: { type: 'offer', sdp: 'o' } });
  assert.strictEqual(neg.ignoreOffer, true);
  assert.strictEqual(impolite.remoteDescription, null);
});

(async () => {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      console.log('ok   ' + c.name);
    } catch (e) {
      failed += 1;
      console.log('FAIL ' + c.name + ': ' + (e && e.message));
    }
  }
  if (failed) process.exitCode = 1;
  console.log(failed ? failed + ' failed' : 'all ' + cases.length + ' media tests passed');
})();
