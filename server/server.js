// server.js — authoritative WebSocket dominoes server + static file host.
// Run: npm install && node server.js   (serves client on http://localhost:3000)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const E = require('./engine');
const DB = require('./store');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const TURN_MS = 180000;      // 3 minutes per turn
const BOT_DELAY = [900, 1700];
const ROUND_GAP_MS = 6000;   // auto-advance to next round after this

DB.initStore();

// ---------- static file server + leaderboard REST API ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon', '.png': 'image/png', '.svg': 'image/svg+xml' };
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function json(res, code, obj) { cors(res); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

async function handleApi(req, res, urlObj) {
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
  try {
    if (urlObj.pathname === '/api/leaderboard' && req.method === 'GET') {
      const limit = Math.min(50, parseInt(urlObj.searchParams.get('limit')) || 20);
      return json(res, 200, { rows: await DB.leaderboard(limit) });
    }
    if (urlObj.pathname === '/api/profile' && req.method === 'GET') {
      return json(res, 200, await DB.profile(urlObj.searchParams.get('name') || ''));
    }
    if (urlObj.pathname === '/api/result' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 2000) req.destroy(); });
      req.on('end', async () => {
        try {
          const d = JSON.parse(body || '{}');
          if (!d.name) return json(res, 400, { error: 'name required' });
          await DB.recordResult({ name: d.name, won: !!d.won, points: d.points, roundsWon: d.roundsWon });
          json(res, 200, { ok: true, profile: await DB.profile(d.name) });
        } catch (e) { json(res, 400, { error: 'bad request' }); }
      });
      return;
    }
    json(res, 404, { error: 'not found' });
  } catch (e) { json(res, 500, { error: 'server error' }); }
}

const httpServer = http.createServer((req, res) => {
  const urlObj = new URL(req.url, 'http://localhost');
  if (urlObj.pathname.startsWith('/api/')) return handleApi(req, res, urlObj);
  let urlPath = decodeURIComponent(urlObj.pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer });

// ---------- rooms ----------
const rooms = new Map(); // code -> room
function genCode() {
  let c;
  do { c = Math.random().toString(36).slice(2, 6).toUpperCase(); } while (rooms.has(c));
  return c;
}
function genToken() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

function newRoom(code) {
  return {
    code,
    phase: 'lobby',                 // lobby | playing | roundEnd | gameOver
    hostSeat: 0,
    target: 101,
    roundNum: 1,
    lastWinner: -1,
    winnerTeam: null,
    lastRound: null,
    logs: [],
    turnEndsAt: null,
    turnTimer: null,
    botTimer: null,
    roundTimer: null,
    seats: [0, 1, 2, 3].map(i => ({
      seat: i, name: `Seat ${i + 1}`, occupied: false, isBot: false,
      connected: false, token: null, ws: null
    })),
    game: null
  };
}

function roomLog(room, msg) {
  room.logs.push(msg);
  if (room.logs.length > 30) room.logs.shift();
}

// ---------- state serialization (redacted per viewer) ----------
function buildState(room, viewerSeat) {
  const g = room.game;
  const seats = room.seats.map(s => ({
    seat: s.seat, name: s.name, occupied: s.occupied, isBot: s.isBot,
    connected: s.connected, team: E.teamOf(s.seat),
    handCount: g ? g.hands[s.seat].length : 0
  }));

  let hand = [], hasMove = false, canDraw = false, canPass = false;
  if (g && viewerSeat >= 0 && room.phase === 'playing') {
    const myTurn = g.current === viewerSeat;
    hand = g.hands[viewerSeat].map(t => {
      const playable = myTurn && E.canPlay(t, g.board);
      return { id: t.id, top: t.top, bottom: t.bottom, playable,
               sides: playable ? E.getSides(t, g.board) : [] };
    });
    if (myTurn) {
      hasMove = E.anyCanPlay(g, viewerSeat);
      canDraw = !hasMove && g.boneyard.length > 0;
      canPass = !hasMove && g.boneyard.length === 0;
    }
  } else if (g && viewerSeat >= 0) {
    hand = g.hands[viewerSeat].map(t => ({ id: t.id, top: t.top, bottom: t.bottom, playable: false, sides: [] }));
  }

  return {
    type: 'state',
    code: room.code, phase: room.phase, hostSeat: room.hostSeat,
    target: room.target, roundNum: room.roundNum,
    current: g ? g.current : -1, yourSeat: viewerSeat,
    turnEndsAt: room.turnEndsAt,
    seats,
    board: g ? g.board.map(it => ({ top: it.dTop, bottom: it.dBottom, double: it.tile.top === it.tile.bottom })) : [],
    ends: g ? E.getEnds(g.board) : null,
    boneyardCount: g ? g.boneyard.length : 0,
    scores: g ? g.scores : { A: 0, B: 0 },
    hand, hasMove, canDraw, canPass,
    lastRound: room.lastRound, winnerTeam: room.winnerTeam,
    logs: room.logs.slice(-6)
  };
}

function broadcast(room) {
  for (const s of room.seats) {
    if (s.ws && s.ws.readyState === 1) {
      try { s.ws.send(JSON.stringify(buildState(room, s.seat))); } catch {}
    }
  }
}
function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
function err(ws, message) { send(ws, { type: 'error', message }); }

// A seat is "auto" (server plays for it) if it is a bot, or a human who is disconnected.
function isAuto(room, seat) {
  const s = room.seats[seat];
  return s.isBot || !s.occupied || !s.connected;
}

// ---------- turn flow ----------
function clearTimers(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  if (room.botTimer) { clearTimeout(room.botTimer); room.botTimer = null; }
}

function beginTurn(room) {
  clearTimers(room);
  const g = room.game;
  if (room.phase !== 'playing') return;
  room.turnEndsAt = Date.now() + TURN_MS;
  broadcast(room);

  if (isAuto(room, g.current)) {
    const d = BOT_DELAY[0] + Math.random() * (BOT_DELAY[1] - BOT_DELAY[0]);
    room.botTimer = setTimeout(() => autoResolve(room, g.current), d);
  } else {
    room.turnTimer = setTimeout(() => {
      roomLog(room, `${room.seats[g.current].name} timed out`);
      autoResolve(room, g.current);
    }, TURN_MS);
  }
}

// Fully resolve a turn for a seat (used by bots, disconnected players, and timeouts):
// draw until a legal move exists (or boneyard empties), then play it, else pass.
function autoResolve(room, seat) {
  const g = room.game;
  if (room.phase !== 'playing' || g.current !== seat) return;
  while (!E.anyCanPlay(g, seat) && g.boneyard.length) {
    g.hands[seat].push(g.boneyard.pop());
    roomLog(room, `${g.names[seat]} drew`);
  }
  const mv = E.chooseMove(g, seat);
  if (mv) doPlay(room, seat, mv.tile.id, mv.side, true);
  else doPass(room, seat, true);
}

function doPlay(room, seat, tileId, side, isAutoMove) {
  const g = room.game;
  if (room.phase !== 'playing' || g.current !== seat) return;
  const tile = g.hands[seat].find(t => t.id === tileId);
  if (!tile) return;
  if (!E.canPlay(tile, g.board)) return;
  const sides = E.getSides(tile, g.board);
  if (!sides.includes(side)) side = sides[0];
  if (!side) return;

  g.hands[seat] = g.hands[seat].filter(t => t.id !== tileId);
  E.placeTile(g, seat, tile, side);
  g.passes = 0;
  roomLog(room, `${g.names[seat]} played [${tile.top}|${tile.bottom}] ${side === 'left' ? '⟵' : '⟶'}`);

  if (!g.hands[seat].length) return endRound(room, seat, `${g.names[seat]} cleared their hand`);
  g.current = (g.current + 1) % 4;
  beginTurn(room);
}

function doDraw(room, seat) {
  const g = room.game;
  if (room.phase !== 'playing' || g.current !== seat) return;
  if (!g.boneyard.length || E.anyCanPlay(g, seat)) return; // only draw when stuck
  g.hands[seat].push(g.boneyard.pop());
  g.passes = 0;
  roomLog(room, `${g.names[seat]} drew a tile`);
  beginTurn(room); // same seat keeps the turn; recomputes options
}

function doPass(room, seat, isAutoMove) {
  const g = room.game;
  if (room.phase !== 'playing' || g.current !== seat) return;
  if (E.anyCanPlay(g, seat) || g.boneyard.length) return; // can't pass with a move or tiles to draw
  g.passes++;
  roomLog(room, `${g.names[seat]} passed`);
  if (g.passes >= 4 || E.isBlocked(g)) return endBlocked(room);
  g.current = (g.current + 1) % 4;
  beginTurn(room);
}

function endBlocked(room) {
  const g = room.game;
  const sa = E.teamHandScore(g, 'A'), sb = E.teamHandScore(g, 'B');
  const wt = sa <= sb ? 'A' : 'B';
  const winnerSeat = E.teamSeats(wt)[0];
  endRound(room, winnerSeat, `Blocked — Team ${wt} had the lower pip count`);
}

function endRound(room, winnerSeat, reason) {
  const g = room.game;
  clearTimers(room);
  room.turnEndsAt = null;
  const team = E.teamOf(winnerSeat);
  const loser = team === 'A' ? 'B' : 'A';
  const pts = E.teamHandScore(g, loser);
  g.scores[team] += pts;
  room.lastWinner = winnerSeat;
  room.lastRound = { team, points: pts, reason, a: g.scores.A, b: g.scores.B };
  roomLog(room, `Round ${room.roundNum}: Team ${team} +${pts}`);

  if (g.scores.A >= room.target || g.scores.B >= room.target) {
    room.phase = 'gameOver';
    room.winnerTeam = g.scores.A >= room.target ? 'A' : 'B';
    recordGameResults(room);
    broadcast(room);
    return;
  }
  room.phase = 'roundEnd';
  broadcast(room);
  room.roundTimer = setTimeout(() => startNextRound(room), ROUND_GAP_MS);
}

// Record leaderboard stats for each human seat when a game finishes.
function recordGameResults(room) {
  const g = room.game;
  for (const s of room.seats) {
    if (!s.occupied || s.isBot || !s.name) continue;
    const team = E.teamOf(s.seat);
    DB.recordResult({
      name: s.name,
      won: team === room.winnerTeam,
      points: g.scores[team],
      roundsWon: 0
    }).catch(() => {});
  }
}

function startNextRound(room) {
  if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }
  if (room.phase !== 'roundEnd') return;
  room.roundNum++;
  E.startRound(room.game, room.lastWinner);
  room.lastRound = null;
  room.phase = 'playing';   // beginTurn() bails unless room phase is 'playing'
  beginTurn(room);
}

function startGame(room) {
  // Fill any empty seat with a bot.
  room.seats.forEach((s, i) => {
    if (!s.occupied) { s.isBot = true; s.name = ['Bot Alpha', 'Bot Beta', 'Bot Gamma', 'Bot Delta'][i]; }
  });
  const names = room.seats.map(s => s.name);
  room.game = { hands: [[], [], [], []], boneyard: [], board: [], scores: { A: 0, B: 0 },
                current: 0, passes: 0, phase: 'playing', names };
  room.roundNum = 1;
  room.lastWinner = -1;
  room.winnerTeam = null;
  room.lastRound = null;
  room.phase = 'playing';
  E.startRound(room.game, -1);
  roomLog(room, 'Game started');
  beginTurn(room);
}

function firstFreeSeat(room) {
  const s = room.seats.find(s => !s.occupied);
  return s ? s.seat : -1;
}

// ---------- connection handling ----------
wss.on('connection', (ws) => {
  ws.ctx = { code: null, seat: -1, token: null };

  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    const room = ws.ctx.code ? rooms.get(ws.ctx.code) : null;

    switch (m.type) {
      case 'create': {
        const code = genCode();
        const r = newRoom(code);
        rooms.set(code, r);
        seatPlayer(ws, r, 0, m.name || 'Player 1');
        r.hostSeat = 0;
        send(ws, { type: 'joined', code, token: ws.ctx.token, yourSeat: 0 });
        broadcast(r);
        break;
      }
      case 'join': {
        const r = rooms.get((m.code || '').toUpperCase());
        if (!r) return err(ws, 'Room not found');
        if (r.phase !== 'lobby') return err(ws, 'Game already started — ask the host for a rematch or rejoin');
        const seat = firstFreeSeat(r);
        if (seat < 0) return err(ws, 'Room is full');
        seatPlayer(ws, r, seat, m.name || `Player ${seat + 1}`);
        send(ws, { type: 'joined', code: r.code, token: ws.ctx.token, yourSeat: seat });
        broadcast(r);
        break;
      }
      case 'rejoin': {
        const r = rooms.get((m.code || '').toUpperCase());
        if (!r) return err(ws, 'Room not found');
        const s = r.seats.find(s => s.token && s.token === m.token);
        if (!s) return err(ws, 'Could not restore your seat');
        s.ws = ws; s.connected = true;
        ws.ctx = { code: r.code, seat: s.seat, token: s.token };
        send(ws, { type: 'joined', code: r.code, token: s.token, yourSeat: s.seat });
        broadcast(r);
        break;
      }
      case 'addBot': {
        if (!room || room.phase !== 'lobby') return;
        if (ws.ctx.seat !== room.hostSeat) return err(ws, 'Only the host can edit seats');
        const s = room.seats[m.seat];
        if (s && !s.occupied) { s.isBot = true; s.name = ['Bot Alpha', 'Bot Beta', 'Bot Gamma', 'Bot Delta'][m.seat]; broadcast(room); }
        break;
      }
      case 'removeBot': {
        if (!room || room.phase !== 'lobby') return;
        if (ws.ctx.seat !== room.hostSeat) return err(ws, 'Only the host can edit seats');
        const s = room.seats[m.seat];
        if (s && s.isBot) { s.isBot = false; s.name = `Seat ${m.seat + 1}`; broadcast(room); }
        break;
      }
      case 'setTarget': {
        if (!room || room.phase !== 'lobby') return;
        if (ws.ctx.seat !== room.hostSeat) return;
        if ([51, 101, 201].includes(m.target)) { room.target = m.target; broadcast(room); }
        break;
      }
      case 'setName': {
        if (!room) return;
        const s = room.seats[ws.ctx.seat];
        if (s && m.name) { s.name = String(m.name).slice(0, 16); broadcast(room); }
        break;
      }
      case 'getLeaderboard': {
        const myName = (room && ws.ctx.seat >= 0) ? room.seats[ws.ctx.seat].name : m.name;
        Promise.all([DB.leaderboard(20), myName ? DB.profile(myName) : null])
          .then(([rows, you]) => send(ws, { type: 'leaderboard', rows, you }))
          .catch(() => {});
        break;
      }
      case 'start': {
        if (!room || room.phase !== 'lobby') return;
        if (ws.ctx.seat !== room.hostSeat) return err(ws, 'Only the host can start');
        const humans = room.seats.filter(s => s.occupied).length;
        if (humans < 1) return err(ws, 'Need at least one player');
        startGame(room);
        break;
      }
      case 'play': if (room) doPlay(room, ws.ctx.seat, m.tileId, m.side, false); break;
      case 'draw': if (room) doDraw(room, ws.ctx.seat); break;
      case 'pass': if (room) doPass(room, ws.ctx.seat, false); break;
      case 'nextRound': {
        if (room && ws.ctx.seat === room.hostSeat && room.phase === 'roundEnd') startNextRound(room);
        break;
      }
      case 'rematch': {
        if (!room || ws.ctx.seat !== room.hostSeat) return;
        clearTimers(room);
        if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }
        // keep seats; reset bots assigned at previous start back to open if they were auto-filled? keep as-is.
        startGame(room);
        break;
      }
    }
  });

  ws.on('close', () => {
    const room = ws.ctx.code ? rooms.get(ws.ctx.code) : null;
    if (!room) return;
    const s = room.seats[ws.ctx.seat];
    if (s && s.ws === ws) {
      s.connected = false; s.ws = null;
      if (room.phase === 'lobby') {
        // free the seat in lobby
        s.occupied = false; s.token = null; s.name = `Seat ${s.seat + 1}`;
        // reassign host if needed
        if (ws.ctx.seat === room.hostSeat) {
          const next = room.seats.find(x => x.occupied);
          if (next) room.hostSeat = next.seat;
        }
        if (!room.seats.some(x => x.occupied)) { rooms.delete(room.code); return; }
      }
      roomLog(room, `${s.name || 'A player'} disconnected`);
      broadcast(room);
      // if it was their turn mid-game, let the server play for them
      if (room.phase === 'playing' && room.game.current === ws.ctx.seat) {
        clearTimers(room);
        room.botTimer = setTimeout(() => autoResolve(room, ws.ctx.seat), 1200);
      }
    }
  });
});

function seatPlayer(ws, room, seat, name) {
  const s = room.seats[seat];
  s.occupied = true; s.isBot = false; s.connected = true;
  s.name = String(name).slice(0, 16);
  s.token = genToken();
  s.ws = ws;
  ws.ctx = { code: room.code, seat, token: s.token };
}

httpServer.listen(PORT, () => {
  console.log(`Dominoes server on http://localhost:${PORT}  (WebSocket on same port)`);
});
