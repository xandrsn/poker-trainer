# Multiplayer v5 contract (server <-> client)

Both the SERVER agent (server/room.js, server/mp.js, test/mp.test.js, MP_PROTOCOL.md) and the CLIENT agent
(public/mp.js, public/mp.css, test/e2e-*.js, test/mp-client.test.js) implement exactly this. The server agent
copies it into MP_PROTOCOL.md. Additions are backward compatible: old fields keep working.

## Turn idempotency (bug: double click on Check)
- Client `act` gets an optional `turn` string = `hand.id + '|' + hand.street + '|' + hand.toAct` (same as core.turnKey).
- Server: if `turn` is present and differs from the current turn key, the action is ignored SILENTLY (no error, no state
  change, diag log). Without `turn` the old 'not your turn' error stays. Duplicates never evict anyone.

## Pause (server authoritative)
- state.paused: `null` or `{by:<seat>, name, since:<epoch ms>, autoResumeAt:<epoch ms>}` (clients treat any truthy value as paused).
- state.serverNow: epoch ms when the message was built (client clock offset = serverNow - receivedAt).
- state.hand.turnLeftMs: ms left on the current turn clock (frozen while paused, null if no clock); hand.nextLeftMs: ms to
  the next deal between hands (null when none). Clients draw rings/countdowns from these, never from Date.now() guesses.
- Disconnecting or reconnecting NEVER restarts an existing turn clock; a disconnect only shortens it to min(left, disconnectMs)
  if that is lower, a reconnect keeps what is left (never gives a fresh full clock either).
- While paused the server refuses (error 'the game is paused'): act, rebuy, reset, start, addBot, removeBot, kick, settings,
  doubleBlinds. Allowed: chat, resume (any host), endGame, profile, emojiSet/emojiGet, ping, rtc/needKey.
- Auto resume after 10 minutes (autoResumeAt). Pausing twice / resuming when not paused is a silent no-op.

## Blinds
- settings.blindUpMin: 0 (off, default) or integer 1..10 = minutes between automatic doublings. Timer starts at `start`, freezes
  with pause, doubling is applied at the next hand boundary only. settings.sb / settings.bb are the CURRENT blinds.
- `{t:'doubleBlinds'}` host only: doubles sb and bb for the NEXT hand (cap bb at 512000), allowed mid-hand (does not touch the
  running hand). Broadcast lobby+state; server also sends `{t:'notice', kind:'blinds', sb, bb}` to everybody.
- lobby.settings gets blindLevel (int, 0 = base) and nextBlindUpAt (epoch ms or null when off/paused/idle).
- endGame/reset restore the base blinds. The client must NEVER send hardcoded sb/bb when it edits other settings
  (only send fields the user changed, or the current values from state).

## Spectators (busted humans) and card visibility
- lobby.spectators: `[{seat, clientId, name, avatar, connected}]` = out seats (busted humans). lobby.players stays players only.
- settings.spectatorCards: 'live' (default: spectators see every dealt seat's hole cards at once), 'afterHand' (only when the
  hand is over, plus folded seats), 'off'. Only applies to viewers whose seat is out; players never get others' hidden cards.
- state.hand.seats[i].revealed: true when that seat's cards are already face-up for everybody (showdown/shown).
- showHand is refused for out seats (error 'you are out - spectating').
- state.hand.pots (only when hand.over): `[{amount, winners:[seat,...]}]` pots paid in the hand, for money animations.

## Chat, custom emoji, bubbles
- Chat message unchanged: `{t:'chat', from, name, text, time}`. Tokens `:id:` inside text are replaced client-side by the
  sender's emoji if the sender has an emoji with that id, else shown literally.
- Client -> server `{t:'emojiSet', emojis:[{id, data}]}` replaces the sender's whole set. Validation: max 12 items, id
  /^[a-z0-9_]{1,12}$/ unique, data = 'data:image/png;base64,...' decoded <= 8 KB, PNG signature, IHDR width,height <= 64, no acTL
  chunk, rate limit 1 per 2 s. Error strings: 'bad emoji' / 'too many emojis' / 'slow down'.
- Server -> all seated conns `{t:'emojiPack', clientId, emojis}` on change; on join the server sends every existing pack that
  is non-empty as separate emojiPack messages to the joiner (packs are small). `{t:'emojiGet', clientIds:[...]}` -> reply
  `{t:'emojiPacks', packs:{clientId:[...]}}`.
- Bubbles are purely client side from chat messages (not history): over the seat on the table, next to the player's cam tile in
  the left column, and for spectators next to their tile / in a corner bench.

## Connection health
- Client `{t:'ping', ts}` every 15 s; server replies `{t:'pong', ts, sv}`; the client computes rtt and shows a small dot + ms.
- Server also sends ws-level ping frames every 25 s and terminates sockets that miss 2 pongs (grace: the seat stays reserved,
  `connected=false` is shown only after 5 s without a socket).
- Relay backlog per receiver lowered to 64 KB (game JSON must not wait behind video).
- Reconnect backoff with +-30% jitter; client also reconnects on window 'online' and 'pageshow'.
- act sent while disconnected: the UI shows 'No connection, action not sent' and re-sends once after welcome only if the turn key
  is unchanged.

## Show your hand
- Existing `{t:'showHand'}` unchanged (whole hand). Clicking/tapping/Enter on your own hole cards in the dock sends it when
  hand.over and the window is open; the client shows 'Shown' (from seats[me].shown / revealed).
