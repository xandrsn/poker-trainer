# Multiplayer protocol (WebSocket JSON on `/ws`, library `ws`), v5

One shared table per server ("mesa"): up to 9 seats (humans and bots), no accounts. Everyone with the link can join.
Up to **6 humans** can be seated (media is sized for that); bots fill the other seats. A fresh table has only the humans who joined.

Money model: there is no real currency. Every amount the players see is in **BB** (big blinds): BB = chips / bb, shown with at most one decimal ("12.5 BB"). The server counts whole integer chips; the chips never change meaning. Default starting stack 100000 chips (100 BB at 500/1000 blinds); default blinds 500/1000. Progressive blinds are optional (see Blinds).

Display rule (client, `fmtBB(chips, bb)` in public/mp.js): seats, pot, bets, chips on the table, raise presets and the exact-entry popover, win lines and the lobby stacks all use the **current** bb. When blinds double, the same chips show half as many BB. The host types starting stacks and per-seat stacks in BB; the client converts them to chips (`bbToChips`) before sending. System win lines carry the bb in effect when the hand ended, so they read the same as the table did.
A raise may be any amount from the legal minimum up to all-in.

## Money and settings
`settings` (host; most keys between hands, see Refusals):
- `stack` (100..1e9) equal starting stack. `sb`, `bb` (sb <= bb, stack >= bb). Setting `sb`/`bb` makes them the new **base** blinds.
- `stacks`: `'equal'` (everyone gets `stack`), `'varied'` (each seat gets a random 0.4x-1.6x of `stack`, whole big blinds; redrawn at join, reset and rebuy) or `'custom'` (per-seat starting stacks set with `setStack`/`setStacks`). Switching to equal or varied puts every seat on the new stacks at once.
- `externalCallUrl`: `https://...` or `http://...` (<= 200 chars) or `null`/`''` to clear. Allowed mid-hand.
- `botShowCards`: `true|false` (default `false`). Controls whether PLAYERS see bot cards at showdown. Spectators are not affected (see Spectators). Allowed mid-hand.
- `blindUpMin`: integer 0..10 (default 0 = off). Minutes between automatic blind doublings (see Blinds). Allowed mid-hand.
- `spectatorCards`: `'live'` (default), `'afterHand'` or `'off'` (see Spectators). Allowed mid-hand.
- `lateStack`: `'start'` (default, the starting stack), `'half'` (half the starting stack), `'avg'` (average of the other stacks) or `'fixed'`. Applies to a player who joins while a game runs (see Rooms). `lateFixedBB`: number >= 5 in steps of 0.5 (default 20), used by `'fixed'`. Amounts are rounded to whole half big blinds. Allowed mid-hand.
- `randomness` and `personalities` are retired: accepted and ignored so old clients keep working.
- Server-added read-only fields in every settings object sent out: `blindLevel` (int, 0 = base blinds, count of doublings in effect) and `nextBlindUpAt` (epoch ms of the next progressive doubling, or `null` when off, paused or idle).

## Rooms
Many tables run side by side on one server. Each room has its own state, seats, bots, chat, host and settings; nothing is shared between rooms. Rooms are public (no password yet; `isPublic` is always `true`).
- Connections start with no room. Room messages before entering one get `{t:'error', msg:'join first'}`.
- `{t:'rooms'}` (client -> server) subscribes the connection to the room list: the server replies `{t:'roomList', rooms:[...]}` and pushes it every 2 s. `{t:'unsubscribeRooms'}` stops the pushes.
  - Each room: `{id, name, players (seated humans), max (6), bots, status:'lobby'|'playing', host (name or null), blinds:{sb,bb}, createdAt (epoch ms), isPublic}`. Both playing and lobby rooms are listed.
- `{t:'roomNameCheck', name}` (list and create screens; the client debounces it) replies `{t:'roomNameCheck', name, ok, reason:'empty'|'taken'|null, suggest?}`. Names are compared with the createRoom key: cleaned, trimmed, spaces collapsed, case-insensitive. `suggest` is the first free `<name> 2`, `<name> 3`, ... (max 24 characters).
- `{t:'createRoom', name?, settings?}` creates a room and joins it as host. Replies `{t:'roomJoined', id}`. A taken name replies `{t:'error', msg:'name taken', suggest}` and creates nothing. `name` is cleaned (HTML-special and control characters become spaces, at most 24 characters); empty gives `Room <id>`. `settings` (optional, checked like the host's settings message): `{stack, sb, bb, blindUpMin, lateStack:'start'|'half'|'avg'|'fixed', lateFixedBB, spectatorCards:'live'|'afterHand'|'off'}`; chips for `stack`, `sb`, `bb`, applied at creation before anyone sits. Errors: `'too many rooms (max 50)'`, `'slow down'` (one create per 5 s per connection), `'leave the room first'`.
- Name rules: a player name is 1 to 16 characters after cleaning (`join`, `profile`); the client refuses longer names with the same message. A table name is at most 24 characters and must be unique among open tables.
- `{t:'joinRoom', id}` joins by code (case-insensitive). Replies `{t:'roomJoined', id}`. Errors: `'room not found'`, `'room full'` (6 seated humans).
- `{t:'leaveRoom'}` leaves the room (`{t:'roomLeft'}`). Closing the socket leaves too.
- Room codes: 5 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no I, L, O, 0, 1).
- A room with no connection for 2 minutes is destroyed (reconnects within that time keep it). Tokens restore a seat in its room as before.
- The client sends `joinRoom` (with the room code) right after the socket opens, then `join` as before. A direct `join` without a room goes to a hidden default room (legacy, used by tests).
- **Late join**: a player who joins while a game runs is seated at once but `waiting: true` in `lobby.players` until the next deal: `hand.seats` has no cards for them and they play from the next hand. Their entry stack follows `settings.lateStack`: `start` (starting stack), `half` (half the starting stack), `avg` (average of the other seats' stacks, rounded to the nearest half BB) or `fixed` (`lateFixedBB` BB). The new chips are a buy-in, counted in the ledger (`netChips`).

## Ranked matches
A ranked match is a room with `settings.ranked` and `settings.kind`: `duel` (two seats) or `table` (six, some may be bots), 50 BB, blinds double every 2 minutes, no host controls. The seats belong to the session cookie's account; nobody else can join, and the room is not listed.
- `{t:'resign'}` (client -> server) loses the match; at a table the player takes the lowest place still open and the others play on. Refused elsewhere with 'not a ranked match'.
- `{t:'rated', kind, void, reason, winner, place, of, players:[...]}` (server -> client) ends the match for that player: `winner` is a name or null, `place` of `of` is their result, `players` holds the accounts rated so far with rating before and after, `delta` and `place`. A void match changes nothing. At a table, a player who has not arrived after 45 s is dropped unrated.
- A player who stays away too long loses; an opponent who never arrives (45 s) voids the match.
- `lobby.players` entries carry `rating`.

## Client -> server
- `{t:'join', name, clientId?, token?, avatar?, highlight?}` name 1-16 chars. `clientId` (public: peers see it, kept in localStorage) and `token` (secret, from the `welcome` of that seat, kept in localStorage) reclaim the seat after a refresh. **A clientId alone never reclaims a seat**: a wrong or missing `token` gets `'this seat belongs to another player'`. A valid reclaim while the seat is connected elsewhere takes it over and closes the old socket. A seat that was abandoned (below) is gone: the same clientId then joins as a new player with a new seat and a fresh stack.
- `{t:'profile', name?, avatar?, highlight?}` your name, avatar and highlight colour (any time once seated).
  - `avatar`: `null` to clear, or a data URL `data:image/jpeg|png|webp;base64,...` of at most **64 KB decoded** (exact: 65536 bytes accepted, 65537 refused, the size is the base64 length times 3/4 minus the `=` padding). Anything else is refused.
  - `highlight`: `#rrggbb` (lowercased by the server) or `null`.
- `{t:'addBot', style?, name?, avatar?}` host; style is an Elo level, `lv1` (weakest) to `lv6`, see `public/ladder.js`; omitted = a random level. Any other value: 'unknown style'. Without a name the bot gets a free one of its level.
- `{t:'editBot', seat, name?, avatar?, style?}` host. Name and avatar any time; `style` only between hands.
- `{t:'removeBot', seat}` host, between hands.
- `{t:'kick', seat}` host. Between hands the seat is freed at once. Mid-hand the player is removed from `lobby.players` and `state` at once and their socket is closed; they fold on their turn (at once if it is their turn now). Chips already in the pot stay there and are awarded normally. The seat is held until the hand ends, then freed. A second kick of that seat is refused ('that player is already leaving'), and the old clientId cannot rejoin meanwhile ('you were removed from this table').
- `{t:'settings', ...}` see above.
- `{t:'doubleBlinds'}` host. Doubles sb and bb at once (bb capped at 512000 and at the starting stack). Allowed mid-hand: the running hand keeps its blinds (`hand.bb`), the next hand uses the new ones. Refused with 'blinds cannot go higher' at the cap.
- `{t:'setStack', seat, stack}` / `{t:'setStacks', stacks:{seat:amount,...}}` host, between hands, only when `stacks` is `'custom'`. Amount integer, at least `bb`.
- `{t:'start'}` host starts a game; hands repeat automatically after each showdown while a human has chips and two seats can play. Starts the blind clock when `blindUpMin` > 0.
- `{t:'pause'}` host. Freezes every clock (turn, bot actions, next deal, blind clock). Pausing while paused is a silent no-op.
- `{t:'resume'}` any host (the current host, see Host below). Resuming when not paused is a silent no-op.
- `{t:'endGame'}` host. Refunds a running hand, stops hands, timers and autoplay, clears any pause, restores the base blinds, sends `gameOver` to everyone, then resets every seated stack (bots too) to its starting stack. Bots stay seated. Nothing is dealt until the host sends `start` again.
- `{t:'reset'}` host, between hands: stacks back to starting stacks, base blinds restored.
- `{t:'rebuy'}` a seated human with 0 chips buys back in with their starting stack. Allowed mid-hand if that seat is not in the running hand.
- **Busted bots** are removed when their hand ends: the seat is freed and the bot is not refilled, so its chips never return. Only `addBot` (host) seats a new bot. Humans who bust stay seated as spectators instead.
- `{t:'act', action:'fold'|'call'|'raise', amount?, turn?}` amount is the total raise-to in chips (raise only).
  - `turn` (optional, recommended): `hand.id + '|' + hand.street + '|' + hand.toAct`. If present and different from the current decision, the act is **ignored silently** (no error, no state change, no eviction). This makes a double click harmless. Without `turn` the usual 'not your turn' error applies.
- `{t:'showHand'}` between hands (the hand is over) reveal this seat's two cards to everyone. During a hand it shows them to the observers only (`shownTo: 'observers'`, see below): any seated player who was dealt in may do it, folded or not. Refused if you were not dealt in, or if you are out ('you are out - spectating'). Repeating it is a no-op.
- `{t:'chat', text}` text is trimmed, control characters are removed, max 200 chars, one message per 700 ms per client.
- `{t:'emojiSet', emojis:[{id, data}]}` replaces the sender's whole custom emoji set (see Custom emoji).
- `{t:'emojiGet', clientIds:[...]}` asks for packs; reply `{t:'emojiPacks', packs:{clientId:[...]}}`. Allowed while paused.
- `{t:'ping', ts}` every 15 s from the client (see Connection health).

### Refusals (error text in `{t:'error', msg}`)
While the game is **paused** the server refuses, with 'the game is paused': `act`, `start`, `settings` (all keys), `reset`, `rebuy`, `addBot`, `removeBot`, `kick`, `setStack(s)`, `doubleBlinds`. Still allowed while paused: `chat`, `resume` (any host), `endGame`, `profile`, `emojiSet`, `emojiGet`, `ping`, `rtc`, `needKey`, `showHand`, `diag`.

Mid-hand refusals (wait until the hand ends): `reset`, `setStack(s)`, `removeBot`, `start`, `editBot` style, and `settings` for `stack`, `sb`, `bb`, `stacks`.

Out seats (spectators): `act` and `showHand` are refused ('you are out - spectating'). `rebuy` brings them back in, and the host's `reset` puts every seat back on its starting stack.

One chip holder left: once a hand is over and fewer than two seats hold chips, the game ends like `endGame` (`gameOver` standings, autoplay stops, blind clock stops).

## Host
The host is the earliest joiner who is still connected. When the host drops (grace period passed) the role moves to the next connected player.

## Server -> client
- `{t:'welcome', you:{clientId, token, seat, name, avatar, highlight, host}, settings}` `token` is the seat's secret: keep it with the clientId and send both in `join` to reclaim the seat. It is sent only to that socket.
- `{t:'chatHistory', messages:[chat...]}` sent once after `welcome`: the last 50 chat messages.
- `{t:'emojiPack', clientId, emojis}` every non-empty custom emoji pack, once per pack to a joiner, and to all seated connections whenever a pack changes.
- `{t:'lobby', name, players:[...], spectators:[...], settings}` sent on every change. `name` is the table name (the room name from create, cleaned, max 24 chars; `null` if unset). `welcome` carries the same `name` at the top level, next to `you` and `settings`. The lobby title and the code chip show it; guests pick the table by this name in the list.
  - Each player: `{seat, clientId? (humans), name, avatar:string|null, highlight:string|null, bot, style? (bots), rating? (bots, and everyone in ranked: the Elo), stack, startStack, connected, host, camera:false}`. `stack` is the current stack, `startStack` the seat's starting stack. `connected` turns false only after the 5 s grace.
  - Each spectator (busted human, see below): `{seat, clientId, name, avatar, connected, stack}`. `stack` is the chips they still hold (under 1 BB; they count in `netChips` until a rebuy). `players` never contains spectators.
  - `settings` is the current settings object (see Money and settings, including `blindLevel` and `nextBlindUpAt`).
- `{t:'state', paused:null | {by, name, since, autoResumeAt}, serverNow, hand:null | {...}}` sent to every seated client on every change.
  - `paused` is an object while paused (banner data: who paused, when, and when it auto-resumes), `null` otherwise. A truthy value means paused.
  - `serverNow`: epoch ms when the message was built. Client clock offset = `serverNow - receivedAt`.
  - `hand` is null until a hand is dealt. Fields:
    - `id`, `street`, `over`, `pot` (0 once over), `board`, `dealer`, `toAct` (null once over), `minRaise` (raise-to minimum), `toCall` (for you).
    - `youCards` (yours, or `[]`), `legal` (only when it is your turn: `{fold, call, raise, minRaiseTo, maxRaiseTo}`), `winners` (only when over: `[{seat, amount, hand}]`, hand null if uncontested).
    - `pots` (only when over): `[{amount, winners:[seat,...]}]`, the pots paid in the hand, for money animations.
    - `turnLeftMs`: ms left on the current turn clock (frozen while paused, null if no clock). `nextLeftMs`: ms to the next deal between hands (null when none). Clients draw countdowns from these, never from guesses about `Date.now()`.
    - `showWindowMs`: the between-hands window (5000 by default). `nextHandAt`: epoch ms of the next deal, or null while paused or when none is scheduled.
    - `seats`: `[{seat, name, avatar, highlight, bot, style?, rating?, stack, bet, inHand, folded, allIn, position, lastAction, cards, shown, revealed, connected}]`. Out seats are not listed.
      - `cards` is `[c,c]` when you are allowed to see them, otherwise `null` (see Card visibility).
      - `shown`: this seat chose to show between hands (showHand). `revealed`: the cards are face-up for everybody (showdown or shown, bots only when `botShowCards`).
      - `shownTo: 'observers'` (only while a hand runs): this seat showed mid-hand. Present only in the state of the shower and of observers (folded, not dealt in, or spectators); the cards come with it in `cards`. Absent for every other viewer, so active players get no cards, no marker and no hint.
      - `lastAction` is e.g. "call", "check", "raise to 3000", "fold", optionally with " (all-in)"; empty until the seat acts on the current street.
- `{t:'chat', from:<clientId>, name, text, time}` a chat message (time in epoch ms).
- `{t:'chat', system:true, kind:'win'|'winFold', name, hand?, amount, bb, time}` a system line when a hand ends, one per winning seat. `kind:'win'` (showdown) carries `hand: {rank, cards}` (the best five); `winFold` means everyone else folded. `amount` is in chips and `bb` is the big blind of that hand; the client words the line in its own language and shows the amount in BB.
- `{t:'notice', kind:'blinds', sb, bb}` to every connection when the blinds change (doubling, reset or endGame restore).
- `{t:'peers', ids:[clientId...]}` the connected humans, when someone joins or leaves.
- `{t:'gameOver', standings:[{seat, name, stack, avatar}]}` sorted by stack; sent when the game ends.
- `{t:'emojiPacks', packs:{clientId:[{id, data}...]}}` reply to `emojiGet`.
- `{t:'error', msg}` a refusal with a reason. Also sent before a socket closes when kicked, or when the same clientId connects from another window.
- `{t:'pong', ts, sv}` reply to `ping`: `ts` echoes the client's value, `sv` is the server's epoch ms.

Cards are strings like `"As"`.

## Card visibility
- Players: a player sees their own two cards, cards of players who reached showdown, and cards of seats that used `showHand` between hands. Mid-hand shows (`shownTo: 'observers'`) are visible only to folded players, players not dealt in and spectators, computed per viewer on every state build (a viewer who folds later sees them then); they are never sent to a player still in the hand, and the mark ends with the hand. Never another player's hidden cards. Bot cards only when `botShowCards` is on (at showdown or when shown).
- Spectators (busted humans) follow `settings.spectatorCards`:
  - `live` (default): every dealt seat's cards at once, bots included.
  - `afterHand`: all dealt seats (bots included) once `hand.over`; while the hand runs, folded seats only.
  - `off`: only the normal player rules.
- A spectator's own view never includes their own cards (they are not dealt in).

## Spectators (busted humans)
- A human under 1 BB (including 0 chips) is out of the table. `lobby.spectators` lists them; out seats are left out of `lobby.players` and `state.hand.seats` from the next deal on (the showdown of the hand they busted in stays visible).
- They keep their connection, chat and camera, see the table, and cannot act (`act` and `showHand` refused).

## Chat, custom emoji, bubbles
- Chat message unchanged: `{t:'chat', from, name, text, time}`. Tokens `:id:` inside text are replaced client-side by the sender's emoji if the sender has an emoji with that id, else shown literally.
- Bubbles are purely client side from chat messages (not history).

### Custom emoji
- `emojiSet` replaces the sender's whole set. Packs are kept in memory per clientId (not persisted). A pack of a clientId with no seat is dropped once it has been unseated for 1 h, and at most 40 packs are kept (the least recently seated goes first).
- Validation, for each item `{id, data}`:
  - `id`: matches `/^[a-z0-9_]{1,12}$/`, unique within the set.
  - `data`: `'data:image/png;base64,...'` (PNG only). Decoded size at most **8 KB** (checked from the base64 length and padding, then the decoded length).
  - PNG signature; the first chunk is IHDR with width and height each 1..64; the chunks are well-formed and end in IEND; **no `acTL` chunk** (animated PNG / APNG is refused).
  - Set size: at most **12** items.
- Whole-message rules: at most one `emojiSet` per 2 s per connection (`'slow down'`). Error strings: `'bad emoji'` (any item or shape problem), `'too many emojis'` (more than 12), `'slow down'` (rate limit). A refused set changes nothing.
- Only seated humans can set emoji (bots and unseated sockets get an error).
- Server -> all seated connections: `{t:'emojiPack', clientId, emojis}` on every change. On join the server sends every non-empty existing pack as separate `emojiPack` messages to the joiner.
- `emojiGet` (up to 64 clientIds, any connection): reply `{t:'emojiPacks', packs}`; unknown ids get `[]`.

## Blinds
- Progressive blinds: `settings.blindUpMin` = 0 (off, default) or integer 1..10 minutes between automatic doublings. The clock is armed at `start`, freezes with pause, and continues across hands.
- Each tick queues one doubling. Queued doublings are applied at the **next hand boundary only** (before the next deal), never to a running hand.
- `{t:'doubleBlinds'}` (host) doubles immediately for the next hand (see Client -> server).
- Doubling: bb doubles, capped at 512000; sb doubles, capped at bb. No doubling when bb would exceed the starting stack.
- `lobby.settings.blindLevel` counts doublings in effect; `nextBlindUpAt` is the epoch ms of the next tick (null when off, paused or idle).
- Host sets of `sb`/`bb` become the base and reset `blindLevel` to 0.
- `endGame` and `reset` restore the base blinds (and `reset` restarts the blind clock when a game is running).
- Clients must never send hardcoded sb/bb when editing other settings: send only fields the user changed.

## Pause
- Server authoritative: `state.paused` carries `{by:<seat>, name, since, autoResumeAt}`; `hand.turnLeftMs` and `hand.nextLeftMs` are frozen while paused, so both clients see the same clock.
- Auto resume after `autoResumeMs` (10 minutes). Pause ends at `endGame` too.
- Only the host may pause or resume the game. Resume by whoever is host at that moment.

## Turn clocks and disconnects
- Action timer: 45 s per human turn. A disconnected player on turn gets at most 30 s (`disconnectMs`), and is auto-played when it runs out (check if free, otherwise fold).
- A disconnect never restarts a clock: the running clock shortens to `min(left, disconnectMs)`. A reconnect keeps whatever is left (never a fresh full clock).
- A seat stays reserved on disconnect. `connected=false` is sent only after a 5 s grace (`disconnectGraceMs`) without a socket.
- **Abandoned seats**: a human seat with no socket for longer than `abandonedMs` (3 min) is vacated automatically, as the host's `kick` would do: its chips leave the table and the ledger (`netChips`) follows. A seat that a running hand has dealt in is kept until that hand ends, then freed. Bots are never abandoned. Spectators (busted humans) count the same way.
- A reclaim with the token before `abandonedMs` runs out keeps the seat and its stack.
- **Full room**: at 6 humans, a join takes the oldest abandoned seat (not in a running hand) at once instead of failing with `'room is full'`. Connected players are never displaced; when no seat is abandoned the join is refused as before.
- Bots act after 500-1200 ms. Between hands: `showWindowMs` (5 s) before the next deal. Every timer stops while the game is paused.

## Connection health
- Client `{t:'ping', ts}` every 15 s; server replies `{t:'pong', ts, sv}`. The client computes rtt from `ts`.
- Server ws-level ping frames every 25 s; a socket that misses 2 pongs is terminated (its seat stays reserved until the grace ends).
- A text (JSON) frame over 256 KB is answered with `{t:'error', msg:'message too large'}` and the socket stays open. The ws-level limit is 512 KB; a larger frame closes the socket with 1009.
- Clients reconnect with backoff and +-30% jitter, and also on window 'online' and 'pageshow'.

## HTTP endpoints (same origin as the page, also on HTTPS)
- `/api` (JSON, no-store; errors are `{error}` with the status code; 503 when nothing can be saved):
  - `GET me` `{user, google}` (`google`: Google sign-in is set up), `GET bots`, `GET leaderboard`, `GET profile?name=`.
  - `POST register` and `POST login` `{name, password}`, `POST logout`. They set or clear an HttpOnly cookie. `register` also replies with `code`, the recovery code.
  - `POST recover` `{name, code, password}`: sets a new password, ends other sessions, replies `{user, code}` with the next code. `POST recovery-code` `{password}` (signed in): a new code.
  - `POST google` `{link?}` replies `{url}` of Google's page (`link`: connect to the signed-in account). `GET google/callback` redirects to `/?google=ok|linked|taken|name|error`; after `name`, `POST google/finish` `{name}` creates the account.
  - `POST queue` `{bot?, mode?}`: poll for a duel, start one against a bot, or with `mode:'table'` poll for a table. Replies `{status:'matched', room}` or `{status:'waiting', waited, players?}`. `POST queue/cancel` leaves the queue.
- `GET /lan-info` (no-store): `{urls:['https://<lan-ip>:<HTTPS_PORT>', ...], https:boolean}`; `https` is true when the server also listens on HTTPS.

## Media
Camera, microphone and WebRTC are removed from the protocol: no `rtc`, `needKey`, `diag` or binary frames, and no `camera` or media fields. Players send chat and emoji only.

## Server, ports and certificates
- `npm start` serves `public/` and `/ws` on `PORT` (default 3000).
- If `certs/key.pem` and `certs/cert.pem` exist, the same app (static files, `/rtc-config`, `/lan-info`, wss `/ws`) also listens on `HTTPS_PORT` (default 3443), sharing one room.
- `npm run cert` creates the self-signed certificate (SAN: localhost, 127.0.0.1 and LAN IPv4 addresses) with openssl. Keys are never committed (`certs/`, `logs/` are in `.gitignore`).

## Test-only timing options
`createServer({timing})` accepts `botDelay`, `actionMs`, `disconnectMs`, `nextHandMs`, `showWindowMs`, `disconnectGraceMs`, `autoResumeMs`, `blindMinuteMs` (one blind-up minute, default 60000), `abandonedMs` (default 180000), `emojiGoneMs` (default 3600000) and `wsPingMs` (default 25000).
