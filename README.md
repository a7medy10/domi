# Team 101 Dominoes — Online Multiplayer

Server-authoritative online dominoes for **up to 4 humans**; any empty seat is filled
with a bot when the host starts. Teams are fixed: **Team A = seats 1 & 2**, **Team B = seats 3 & 4**.
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
