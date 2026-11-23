# Multiplayer measured results

## v5 server results (node test/mp.test.js)

Server-side tests on ephemeral ports, real ws clients. 40 tests: 26 from before v5, 14 new. Intermittent: the
"3 humans + 2 bots play 20 hands" observer test failed in 2 of about 12 full runs (a chip total 100000 short in
the observer, which only sums the seats in each state message); the room ledger check passed in those runs. Not
root-caused yet; 6 consecutive runs after the failures were green.
`node test/mp-client.test.js` green (26 unit checks + integration).

Covered by v5 tests:
- Turn idempotency: duplicate or stale `act` (turn key) ignored silently, nobody evicted; no key keeps 'not your turn'.
- Pause: server banner (`paused` object), frozen `turnLeftMs` equal for two clients, refusals list, pause twice
  silent, disconnect and reconnect keep the clock, new host resumes after the host drops, endGame during pause,
  auto-resume (timing override).
- Blinds: `blindUpMin` 0..10 validation, host-only `doubleBlinds` affecting only the next hand, cap 512000,
  notice to everybody, base restored by endGame and reset, progressive doubling only at the hand boundary,
  blind clock frozen by pause, `chipsInPlay() === netChips`.
- Spectators: `lobby.spectators`, `spectatorCards` live / afterHand / off (bots included for spectators),
  players never see hidden cards (human or bot), out seats cannot act or show, `hand.pots` sums to the pot.
- Emoji: validator unit matrix (PNG only, 8 KB decoded, dims 1..64, IEND, no APNG, malformed chunks),
  socket matrix (bad id, duplicate id, svg, 13 items, 12 accepted, non-array), rate limit 2 s ('slow down'),
  replace-the-whole-set, broadcast, joiner gets existing packs, `emojiGet` (unknown ids get `[]`), `emojiGet`
  allowed while paused, unseated socket refused.
- Connection: pong echoes `ts` and carries `sv`; a socket that does not answer ws pings is dropped after missed pongs.
- Relay: receiver with 64 KB+ queued misses video frames, game JSON still arrives.

Not covered by the server tests: real-network timing, the client UI for emoji and bubbles (client agent).

## Critical finding: server relay filter (resolved)

Earlier, `server/mp.js` had `MEDIA_TYPES = new Set([1, 2])`, so relay video (type 3) and Opus audio (type 4)
were dropped by the server. The current `server/mp.js` uses `new Set([1, 2, 3, 4])`. The measurements
below predate that change and used a scratch copy with the same four types.

## Relay path, alone (test/relay-measure via scratch copy)

| Path | Sender codec | Receiver drawn fps | Receiver kbps (video in) | Audio chunks/s | Audio level (peak) |
|---|---|---|---|---|---|
| H.264 (avc1.42E01F, annexb) | avc | 24.5 | 406 | 50 | 0.486 |
| Forced JPEG (`?codec=jpeg`) | jpeg | 7.0 | 186 | 50 | 0.005 |

## Full flow (test/e2e-mp-flow.js, project server): 22 of 23 checks pass, 0 console errors

Run on the current client and again on the original client (same result): the check `bot edit saves a name`
fails in both, so it predates the layout work. Its check reads the page right after Save with no wait; not
yet diagnosed. The test now exits after reporting, and its relay phase no longer awaits a server close that
the open late-joiner socket kept from ever finishing.

Earlier run (patched server copy, before the layout work): 23 of 23.

- Relay phase on a fresh server: drawn 29.8 fps, decoded 30 fps, 522 kbps in, 61 audio chunks/s,
  audio peak 0.438, canvas 250 px wide (displayed).
- WebRTC (getStats over 3 s): 19 fps, 320x240 frames, 191 kbps, audio energy delta 0.813,
  remote audio elements not muted and playing (currentTime 16.8 to 18.4 s).
- Camera toggle: tile rect identical on and off; tile at least 240x180.

## Layout matrix (test/e2e-layout.js): 18 of 18 PASS, 0 intersections

Run: `node test/e2e-layout.js` (E2E_PORT, VIEWPORT_ONLY and PLAYERS_ONLY filter the run). Each case
seats 2, 5 or 9 players (bots fill the seats) and measures the running hand. Checked in every case:

- pairwise intersections (1px tolerance) between seat boxes, bet chips, the pot, the board, the
  banner, hero cards, the action row, the raise popover and the toolbar groups: must be 0;
- every seat, chip, card, button and raise preset inside the viewport and not clipped by an
  overflow ancestor; board cards inside the board box; raise presets inside their box;
- felt (table oval): at least 60% of the viewport height in landscape, at least 40% otherwise, and at
  least 50% of the width; no page scroll; text 12px or more; hero cards 44 wide in landscape;
  F/C/R at least 44px tall; every seat shown.

| Viewport | 2 players | 5 players | 9 players | Level used (lv0 full ... lv3 name + stack) |
|---|---|---|---|---|
| 844x390 (landscape phone) | 0 | 0 | 0 | lv3 / lv1 / lv2 |
| 1024x600 | 0 | 0 | 0 | lv2 |
| 1280x720 | 0 | 0 | 0 | lv0 / lv1 / lv2 |
| 390x844 (phone) | 0 | 0 | 0 | lv0 / lv3 / lv3 |
| 360x640 (phone) | 0 | 0 | 0 | lv0 / lv3 / lv3 |
| 1920x1080 | 0 | 0 | 0 | lv0 |

Screenshots were read for 844x390 (5 and 9 players), 390x844 (9), 1024x600 (9) and 360x640 (9).

The viewports 800x1280, 1280x800 and 1366x768 from the earlier matrix were not in this run.

## Not verified

- The landscape raise popover (opens on the first tap of Raise, a second tap sends the raise): the
  Raise button is only enabled on the player's own turn, which the matrix does not reach.
- Chat bubble expansion in landscape (collapsed bubble is checked visually only).
- Real cross-network ICE (only same-machine candidates here).
- Real cameras and real audio devices.
- Photo tile rendering on screen (not screenshot-read in this run).
