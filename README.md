# Team 101 Dominoes — Online Multiplayer

Server-authoritative online dominoes for **up to 4 humans**; any empty seat is filled
with a bot when the host starts. Teams are fixed and partners sit **across** the table:
**Team A = seats 1 & 3**, **Team B = seats 2 & 4**, so turn order alternates **A, B, A, B**.
3-minute turns, reconnect support, room codes.

## Layout
```
C:\domi\
  domi.html          # original single-player game (offline, bots only)
  server\
    server.js        # WebSocket server + static host (authoritative game state)
    engine.js        # pure dominoes rules (shared logic)
    package.json
  public\
    index.html       # online client (lobby + game)
```

## Run locally
```bash
cd C:\domi\server
npm install
npm start
```
Open http://localhost:3000 in several browser tabs/devices on your LAN.
One player clicks **Create Room**, shares the 4-letter code, others **Join**.
The host can add bots to empty seats, set the target score, and **Start**.

To let phones on your Wi-Fi join, use your PC's LAN IP, e.g. `http://192.168.1.20:3000`.

## How it works
- All game logic runs on the server (`engine.js`). Clients only render state and send
  intents (`play` / `draw` / `pass`). This prevents cheating (you never receive other
  players' hands).
- Each turn has a **3-minute** timer; on timeout (or for bots / disconnected players)
  the server auto-resolves: draw until a move is possible, then play, else pass.
- Disconnect mid-game: your seat is played by the server until you return. Reload the
  page to auto-**rejoin** (token saved in `localStorage`).

## Android app (Google Play)
The site is a PWA (manifest + service worker + 192/512 icons), so you wrap the **live URL**
into an Android package — a **Trusted Web Activity (TWA)**. You don't rebuild the game; the
app loads `https://domi-dominoes.onrender.com` fullscreen.

### Easiest — PWABuilder (no local tools)
1. Go to **https://www.pwabuilder.com** → enter `https://domi-dominoes.onrender.com` → **Start**.
2. **Package For Stores → Android → Download** (defaults are fine; package id `com.team101.dominos`).
3. The zip contains a signed **`.aab`** (upload to Play), a test **`.apk`** (sideload), and
   **`assetlinks.json`** plus the signing **SHA-256 fingerprint**.
4. Put that fingerprint into `public/.well-known/assetlinks.json` (replace the placeholder),
   commit + push, so `https://domi-dominoes.onrender.com/.well-known/assetlinks.json` is live —
   this removes the browser URL bar in the app.
5. Play Console → create app → upload the `.aab` → fill listing → submit.

### Alternative — Bubblewrap CLI (local; needs JDK 17 + Android SDK)
```bash
npm i -g @bubblewrap/cli
cd C:\domi\android
bubblewrap init --manifest https://domi-dominoes.onrender.com/manifest.json   # or reuse twa-manifest.json here
bubblewrap build      # produces app-release-signed.apk + .aab; prints the SHA-256 for assetlinks
```
`android/twa-manifest.json` is pre-filled (package `com.team101.dominos`, host, icons, colors).

### Alternative — Capacitor (full WebView project, offline-capable)
Use if you want to bundle assets or add native plugins; heavier setup (Android Studio).

> **Notes:** A Play listing needs a Play Console account (one-time $25), an app icon (use
> `icon-512.png`), a feature graphic, and screenshots. Bump `appVersionCode` in
> `android/twa-manifest.json` for each new upload. The web app updates instantly on deploy —
> only ship a new APK/AAB when you change icons/package settings.

## Deploying
> **Vercel note:** Vercel's serverless functions cannot hold persistent WebSocket
> connections, so the **game server cannot run on Vercel**. Host the Node server on a
> platform with long-lived connections, then (optionally) put the static client on Vercel.

**Server** (Render / Railway / Fly.io / any VPS):
- Start command: `node server.js`
- It listens on `process.env.PORT` (set automatically by those platforms).
- It also serves `../public/index.html`, so the server URL alone is playable.

**Client on Vercel (optional):** deploy the `public/` folder as a static site and set
`WS_URL` in `index.html` to your server's `wss://...` URL (currently it auto-derives
from `location.host`, which is correct when the Node server serves the page itself).

## Game modes (online lobby)
The host picks in the lobby before starting:
- **2v2 Teams** (4 players) — classic team scoring (the only mode in single-player `domi.html`).
- **1v1 / 3P / 4P Free-for-all** — no teams; the player who goes out scores the sum of *everyone else's* pips; first to the target wins.
- **Draw vs Block** — Draw lets a stuck player pull from the boneyard; Block forces a pass instead. (With 4 players the set is fully dealt, so the boneyard only matters in 2–3 player games.)
Empty active seats are filled with bots at start.

## Leaderboard / ranks (persistent)
- The server tracks per-player stats keyed by **name** (lowercased), so the same name
  accumulates wins/points across the online client *and* single-player. Tiers by points:
  Bronze (0) → Silver (200) → Gold (600) → Platinum (1500) → Diamond (3000).
- **Storage:** set `MONGODB_URI` (and optionally `MONGODB_DB`, default `domi`) to a MongoDB
  Atlas connection string. Without it, the server falls back to an **in-memory** board that
  resets on restart. On Render, add `MONGODB_URI` under the service's *Environment* tab.
  - Atlas: create a DB user, allow network access from `0.0.0.0/0` (Render has no fixed IP),
    and copy the `mongodb+srv://...` URI.
- **REST API** (CORS-enabled): `GET /api/leaderboard?limit=20`, `GET /api/profile?name=...`,
  `POST /api/result {name, won, points}`.
- **Single-player** posts results to a server too — edit `LEADERBOARD_API` near the top of the
  `<script>` in `domi.html` (default `http://localhost:3000`) to point at your hosted URL,
  e.g. `https://domi-dominoes.onrender.com`, so single-player games join the same board.
- The online client needs no config — its 🏆 button uses the same origin it's served from.
