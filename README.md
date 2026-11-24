# Poker Trainer

Poker trainer for solo play against CPUs, plus a multiplayer table with a server.

## Run
    npm install
    npm start              # http://localhost:3000 (PORT overrides)
    npm test               # all suites
    npm run cert           # once, for LAN HTTPS (see below)

## Ports
- `PORT` (default 3000): HTTP and `/ws`.
- `HTTPS_PORT` (default 3443): HTTPS and `wss://…/ws`, started only when `certs/` exists.

## Ranked play and accounts
Players sign up with a name and a password, or with Google, and play for an Elo rating: duels against a player of similar rating or a trained bot, and tables of six where bots take the empty seats after 20 seconds. At a table the rating change is the average over the opponents: those placed below count as beaten. Rules: `server/ranked.js`. Without Redis, accounts are saved in `data/store.json`; with `REDIS_URL` or `KV_URL` set they are saved there.

Password recovery: a one-time code shown at sign-up (and again from the own profile). Nothing is sent by email; a player who loses both password and code, and has not connected Google, cannot get the account back.

Google sign-in (optional; hidden until set up):
1. In the Google Cloud console create an OAuth client of type "Web application" with the redirect URI `https://<site>/api/google/callback` (locally `http://localhost:3000/api/google/callback`).
2. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Set `PUBLIC_URL` (for example `https://poker.example`) if the site is behind a proxy that changes the host or the protocol.

Only Google's account number is stored, no email.

## Bots
Every bot is a neural network, known by its Elo. There are no personalities. At a table you can have bots of one Elo or a mix: in solo games tick the levels under "Bot Elo" (one level: all bots have that Elo; several: a mix), in multiplayer choose "Mixed" or an Elo each time you add a bot. Every bot has a name with its Elo in brackets, such as `Bluffalo (1181)`.

### How they work
There are two networks, both small: two hidden layers, with a choice of five actions (fold, check or call, bet half the pot, bet the pot, all-in).

| | Duels (ranked, heads-up) | Tables (solo, multiplayer, ranked tables of six) |
|---|---|---|
| Trained by | `ml/train.py` | `ml/train_multi.py` |
| Saved in | `server/models.json` (server only) | `public/nn-models.json` (also sent to the browser) |
| Layers | 45, 96, 96, 5 (14,213 weights) | 56, 112, 112, 5 (19,605 weights) |

- **What it sees:** its chance of winning with its cards and the board, the street, its position, the price of a call, the pot, the stacks, how many opponents are left and who has bet. It never sees other players' cards.
- **How it plays:** the network gives each action a probability and the bot draws one. The same hand is sometimes bet and sometimes checked, which is where bluffs come from.
- **How it learns:** by playing against itself (PPO). Each round it plays thousands of hands, compares the chips won with what was expected, and makes the actions that did better more likely. While training only, a second network that sees all the cards estimates what was expected. Nobody taught it poker rules of thumb.
- **Not repetitive:** training pays for variety (entropy bonus). `test/ranked.test.js` checks at every Elo that bots bluff, mix their actions and do not bet every time; `BOT_STATS=1 node test/ranked.test.js` (Git Bash or Linux) prints the numbers.

### Copies a to e
Training saves five copies, from beginner to finished. `public/ladder.js` makes six levels out of them: a copy plus a temperature (above 1 it plays more at random, so weaker).

| Copy | Duels: rounds of 5000 | Tables: rounds of 5000 |
|---|---|---|
| a | 60 | 75 |
| b | 200 | 250 |
| c | 600 | 700 |
| d | 1750 | 2000 |
| e | 5000 | 5000 |

The table training has only run to about round 1800, so tables have a, b and c so far. The levels in `public/ladder.js` use only those.

### Train other versions
Needs Python with PyTorch (a GPU is recommended), from the project folder. The number after the script is the rounds: more is longer and usually stronger. 5000 rounds of tables took about 0.55 s each on the GPU used here, so roughly 45 to 50 minutes. Training starts from zero and replaces the old copies as it goes, so each command keeps a backup first. Stop the server while it runs, and close other programs: the last run stopped for lack of memory.

Tables, PowerShell:

    cd C:\dev\poker-trainer
    Copy-Item public\nn-models.json ml\nn-models.backup.json
    python ml/train_multi.py 5000; if ($?) { node scripts/rate-bots.js 4000 table "a=4,a=2,b=1,c=1,d=1,e=1" --write }

Tables, Git Bash or Linux:

    cd /c/dev/poker-trainer
    cp public/nn-models.json ml/nn-models.backup.json
    python ml/train_multi.py 5000 && node scripts/rate-bots.js 4000 table a=4,a=2,b=1,c=1,d=1,e=1 --write

Duels, PowerShell:

    cd C:\dev\poker-trainer
    Copy-Item server\models.json ml\models.backup.json
    python ml/train.py 5000; if ($?) { node scripts/rate-bots.js 800 "a=6,a=2,b=1,c=1,d=1,e=1" --write }

Duels, Git Bash or Linux:

    cd /c/dev/poker-trainer
    cp server/models.json ml/models.backup.json
    python ml/train.py 5000 && node scripts/rate-bots.js 800 a=6,a=2,b=1,c=1,d=1,e=1 --write

Other lengths: `python ml/train_multi.py 2000` (short), `python ml/train_multi.py 20000` (long). Use more than 100; below that it is only a smoke test.

`rate-bots.js` plays the bots against each other and `--write` puts their Elo into `public/ladder.js`, weakest first. The list is `copy=temperature`, always six. Then run `npm test`.

## Deploy on Vercel
The page is served from `public/`; the API and `/ws` run in one function (`api/server.mjs`, WebSocket public beta).
1. Import the repository in Vercel and add a Redis database from the Marketplace to the project. Check that `REDIS_URL` or `KV_URL` exists in its environment variables. Without Redis, sign-in answers 503 and players on different function instances do not see each other's tables.
2. Deploy. Optional: `GOOGLE_*` as above, `TURN_*` as below.

Vercel closes each socket after the function's time limit (300 s). The client reconnects by itself and the table continues from Redis.

## Internet access (tunnel)
Any tunnel that passes WebSockets works (for example a Cloudflare Tunnel pointing at `http://localhost:3000`). Players then open the tunnel URL; the page connects to `/ws` on the same host.

## LAN HTTPS mode
Phones and laptops on the same network can use the server directly.
1. `npm run cert` creates `certs/key.pem` and `certs/cert.pem` (self-signed, valid for localhost, 127.0.0.1 and this machine's LAN IPv4 addresses; needs `openssl` on PATH or Git for Windows).
2. `npm start` also listens on HTTPS. `GET /lan-info` lists the LAN URLs.
3. Accept the self-signed certificate once in the browser.
4. Allow the port through Windows Firewall, from an admin shell:
   `netsh advfirewall firewall add rule name="Poker Trainer HTTPS 3443" dir=in action=allow protocol=TCP localport=3443`

Certificates and logs are not committed (`.gitignore`).

## TURN (for players behind strict NATs)
The server hands ICE servers to the page from `GET /rtc-config`. STUN is always included. Set these variables to add TURN:
- `TURN_URLS`: comma-separated `turn:` / `turns:` URLs.
- `TURN_USER`, `TURN_PASS`: credentials (never stored in the code).

Examples of providers: Cloudflare Calls TURN, Metered, or a self-hosted coturn. Check credentials with `npm run turn-test -- --urls <url> --user <u> --pass <p>` (needs `playwright-core` and Chrome; not part of `npm test`).

## Diagnostics
Clients report media connection details (ICE types, connection states, bytes, packet loss, codecs). Reports are appended as JSON lines to `logs/mp-diag.log` (rotated to `mp-diag.log.1` at 5 MB). Camera, audio and chat content is never logged.

## Protocol
See `MP_PROTOCOL.md` for every message and field.
