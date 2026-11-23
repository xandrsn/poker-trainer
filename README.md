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
