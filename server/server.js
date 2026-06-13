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
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function json(res, code, obj) { cors(res); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

async function handleApi(req, res, urlObj) {
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
  try {
    if (urlObj.pathname === '/api/healthz' || urlObj.pathname === '/healthz') {
      return json(res, 200, { ok: true, ts: Date.now() });
    }
    if (urlObj.pathname === '/api/version' || urlObj.pathname === '/version') {
      return json(res, 200, {
        commit: process.env.RENDER_GIT_COMMIT || 'local',
        store: DB.storeMode(),
        rooms: rooms.size,
        uptimeSec: Math.round(process.uptime())
      });
    }
    if (urlObj.pathname === '/api/leaderboard' && req.method === 'GET') {
      const limit = Math.min(50, parseInt(urlObj.searchParams.get('limit')) || 20);
      const period = urlObj.searchParams.get('period') === 'week' ? 'week' : 'all';
      return json(res, 200, { rows: await DB.leaderboard(limit, period), period });
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
          await DB.recordResult({ name: d.name, won: !!d.won, points: d.points, roundsWon: d.roundsWon, avatar: d.avatar });
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
  if (urlObj.pathname.startsWith('/api/') || urlObj.pathname === '/healthz' || urlObj.pathname === '/version') return handleApi(req, res, urlObj);
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
    winnerTeam: null,               // teams mode winner
    winnerSeat: -1,                 // ffa mode winner
    lastRound: null,
    // mode config
    teams: true,                    // true = 2v2 teams; false = free-for-all
    numPlayers: 4,                  // active seats (2/3/4)
    draw: true,                     // true = draw from boneyard when stuck; false = block (pass)
    logs: [],
    turnEndsAt: null,
    turnTimer: null,
    botTimer: null,
    roundTimer: null,
    seats: [0, 1, 2, 3].map(i => ({
      seat: i, name: `Seat ${i + 1}`, avatar: '🙂', occupied: false, isBot: false,
      connected: false, token: null, ws: null, lastMove: ''
    })),
    spectators: [],   // ws list of watchers
    isPublic: false,  // discoverable via quick-match
    roundHistory: [], // per-round results for the current match
    game: null
  };
}
function activeSeats(room) { return room.seats.slice(0, room.numPlayers); }

function roomLog(room, msg) {
  room.logs.push(msg);
  if (room.logs.length > 30) room.logs.shift();
}

function roomLog(room, msg) {
  room.logs.push(msg);
  if (room.logs.length > 30) room.logs.shift();
}

// ---------- state serialization (redacted per viewer) ----------
function buildState(room, viewerSeat) {
  const g = room.game;
  const seats = activeSeats(room).map(s => ({
    seat: s.seat, name: s.name, avatar: s.isBot ? '🤖' : (s.avatar || '🙂'),
    occupied: s.occupied, isBot: s.isBot,
    connected: s.connected, team: E.teamOf(s.seat),
    handCount: g ? g.hands[s.seat].length : 0,
    score: (g && !room.teams && g.scores[s.seat] != null) ? g.scores[s.seat] : 0,
    lastMove: s.lastMove || ''
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
      const canPullFromBone = room.draw && g.boneyard.length > 0;
      canDraw = !hasMove && canPullFromBone;
      canPass = !hasMove && !canPullFromBone;
    }
  } else if (g && viewerSeat >= 0) {
    hand = g.hands[viewerSeat].map(t => ({ id: t.id, top: t.top, bottom: t.bottom, playable: false, sides: [] }));
  }

  return {
    type: 'state',
    code: room.code, phase: room.phase, hostSeat: room.hostSeat,
    target: room.target, roundNum: room.roundNum,
    teams: room.teams, numPlayers: room.numPlayers, draw: room.draw,
    current: g ? g.current : -1, yourSeat: viewerSeat,
    turnEndsAt: room.turnEndsAt,
    seats,
    board: g ? g.board.map(it => ({ top: it.dTop, bottom: it.dBottom, double: it.tile.top === it.tile.bottom })) : [],
    ends: g ? E.getEnds(g.board) : null,
    boneyardCount: g ? g.boneyard.length : 0,
    scores: (g && room.teams) ? g.scores : { A: 0, B: 0 },
    hand, hasMove, canDraw, canPass,
    lastRound: room.lastRound, winnerTeam: room.winnerTeam, winnerSeat: room.winnerSeat,
    spectators: room.spectators.length,
    roundHistory: room.roundHistory,
    logs: room.logs.slice(-6)
  };
}

function broadcastRaw(room, obj) {
  const str = JSON.stringify(obj);
  for (const s of room.seats) {
    if (s.ws && s.ws.readyState === 1) { try { s.ws.send(str); } catch {} }
  }
  for (const sp of room.spectators) {
    if (sp.readyState === 1) { try { sp.send(str); } catch {} }
  }
}
function broadcast(room) {
  for (const s of room.seats) {
    if (s.ws && s.ws.readyState === 1) {
      try { s.ws.send(JSON.stringify(buildState(room, s.seat))); } catch {}
    }
  }
  if (room.spectators.length) {
    const specState = JSON.stringify(buildState(room, -1));
    for (const sp of room.spectators) {
      if (sp.readyState === 1) { try { sp.send(specState); } catch {} }
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
  while (room.draw && !E.anyCanPlay(g, seat) && g.boneyard.length) {
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
  room.seats[seat].lastMove = `[${tile.top}|${tile.bottom}] ${side === 'left' ? '⟵' : '⟶'}`;
  roomLog(room, `${g.names[seat]} played [${tile.top}|${tile.bottom}] ${side === 'left' ? '⟵' : '⟶'}`);

  if (!g.hands[seat].length) return endRound(room, seat, `${g.names[seat]} cleared their hand`);
  g.current = (g.current + 1) % g.numPlayers;
  beginTurn(room);
}

function doDraw(room, seat) {
  const g = room.game;
  if (room.phase !== 'playing' || g.current !== seat) return;
  if (!room.draw || !g.boneyard.length || E.anyCanPlay(g, seat)) return; // only draw when allowed & stuck
  g.hands[seat].push(g.boneyard.pop());
  g.passes = 0;
  room.seats[seat].lastMove = 'drew';
  roomLog(room, `${g.names[seat]} drew a tile`);
  beginTurn(room); // same seat keeps the turn; recomputes options
}

function doPass(room, seat, isAutoMove) {
  const g = room.game;
  if (room.phase !== 'playing' || g.current !== seat) return;
  if (E.anyCanPlay(g, seat)) return;                  // can't pass with a legal move
  if (room.draw && g.boneyard.length) return;          // must draw first
  g.passes++;
  room.seats[seat].lastMove = 'passed';
  roomLog(room, `${g.names[seat]} passed`);
  if (g.passes >= g.numPlayers || E.isBlocked(g)) return endBlocked(room);
  g.current = (g.current + 1) % g.numPlayers;
  beginTurn(room);
}

function endBlocked(room) {
  const g = room.game;
  if (room.teams) {
    const sa = E.teamHandScore(g, 'A'), sb = E.teamHandScore(g, 'B');
    const wt = sa <= sb ? 'A' : 'B';
    endRound(room, E.teamSeats(wt)[0], `Blocked — Team ${wt} had the lower pip count`);
  } else {
    // free-for-all: lowest hand pips wins
    let best = 0, bestScore = Infinity;
    for (let i = 0; i < g.numPlayers; i++) { const s = E.handScore(g.hands[i]); if (s < bestScore) { bestScore = s; best = i; } }
    endRound(room, best, `Blocked — ${g.names[best]} had the fewest pips`);
  }
}

function endRound(room, winnerSeat, reason) {
  const g = room.game;
  clearTimers(room);
  room.turnEndsAt = null;
  room.lastWinner = winnerSeat;

  let over = false;
  if (room.teams) {
    const team = E.teamOf(winnerSeat);
    const pts = E.teamHandScore(g, team === 'A' ? 'B' : 'A');
    g.scores[team] += pts;
    room.lastRound = { teams: true, team, points: pts, reason, a: g.scores.A, b: g.scores.B };
    room.roundHistory.push({ round: room.roundNum, teams: true, scorer: team, points: pts, a: g.scores.A, b: g.scores.B });
    roomLog(room, `Round ${room.roundNum}: Team ${team} +${pts}`);
    if (g.scores.A >= room.target || g.scores.B >= room.target) { over = true; room.winnerTeam = g.scores.A >= room.target ? 'A' : 'B'; }
  } else {
    const pts = E.othersHandScore(g, winnerSeat);
    g.scores[winnerSeat] += pts;
    const scores = {}; for (let i = 0; i < g.numPlayers; i++) scores[i] = g.scores[i];
    room.lastRound = { teams: false, winnerSeat, winnerName: g.names[winnerSeat], points: pts, reason, scores };
    room.roundHistory.push({ round: room.roundNum, teams: false, winner: g.names[winnerSeat], points: pts });
    roomLog(room, `Round ${room.roundNum}: ${g.names[winnerSeat]} +${pts}`);
    let topSeat = -1, topScore = -1;
    for (let i = 0; i < g.numPlayers; i++) if (g.scores[i] > topScore) { topScore = g.scores[i]; topSeat = i; }
    if (topScore >= room.target) { over = true; room.winnerSeat = topSeat; }
  }

  if (over) {
    room.phase = 'gameOver';
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
  for (const s of activeSeats(room)) {
    if (!s.occupied || s.isBot || !s.name) continue;
    let won, points;
    if (room.teams) { const team = E.teamOf(s.seat); won = team === room.winnerTeam; points = g.scores[team]; }
    else { won = s.seat === room.winnerSeat; points = g.scores[s.seat] || 0; }
    DB.recordResult({ name: s.name, won, points, roundsWon: 0, avatar: s.avatar }).catch(() => {});
  }
}

function startNextRound(room) {
  if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }
  if (room.phase !== 'roundEnd') return;
  room.roundNum++;
  room.seats.forEach(s => s.lastMove = '');
  E.startRound(room.game, room.lastWinner);
  room.lastRound = null;
  room.phase = 'playing';   // beginTurn() bails unless room phase is 'playing'
  beginTurn(room);
}

function startGame(room) {
  const botNames = ['Bot Alpha', 'Bot Beta', 'Bot Gamma', 'Bot Delta'];
  // Fill empty ACTIVE seats with bots.
  activeSeats(room).forEach((s, i) => {
    if (!s.occupied) { s.isBot = true; s.name = botNames[i]; }
  });
  room.seats.forEach(s => s.lastMove = '');
  const names = activeSeats(room).map(s => s.name);
  const scores = room.teams ? { A: 0, B: 0 } : {};
  if (!room.teams) for (let i = 0; i < room.numPlayers; i++) scores[i] = 0;
  room.game = { hands: [], boneyard: [], board: [], scores,
                current: 0, passes: 0, phase: 'playing', names,
                numPlayers: room.numPlayers, teams: room.teams, draw: room.draw };
  room.roundNum = 1;
  room.lastWinner = -1;
  room.winnerTeam = null;
  room.winnerSeat = -1;
  room.lastRound = null;
  room.roundHistory = [];
  room.phase = 'playing';
  E.startRound(room.game, -1);
  roomLog(room, `Game started (${room.teams ? '2v2 teams' : room.numPlayers + 'p free-for-all'}, ${room.draw ? 'draw' : 'block'})`);
  beginTurn(room);
}

function firstFreeSeat(room) {
  const s = activeSeats(room).find(s => !s.occupied);
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
        seatPlayer(ws, r, 0, m.name || 'Player 1', m.avatar);
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
        seatPlayer(ws, r, seat, m.name || `Player ${seat + 1}`, m.avatar);
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
      case 'quickmatch': {
        // join the first open public lobby, else create a new public room
        let target = null;
        for (const r of rooms.values()) {
          if (r.isPublic && r.phase === 'lobby' && firstFreeSeat(r) >= 0) { target = r; break; }
        }
        if (target) {
          const seat = firstFreeSeat(target);
          seatPlayer(ws, target, seat, m.name || `Player ${seat + 1}`, m.avatar);
          send(ws, { type: 'joined', code: target.code, token: ws.ctx.token, yourSeat: seat });
          broadcast(target);
        } else {
          const code = genCode(); const r = newRoom(code); r.isPublic = true; rooms.set(code, r);
          seatPlayer(ws, r, 0, m.name || 'Player 1', m.avatar); r.hostSeat = 0;
          send(ws, { type: 'joined', code, token: ws.ctx.token, yourSeat: 0 });
          broadcast(r);
        }
        break;
      }
      case 'spectate': {
        const r = rooms.get((m.code || '').toUpperCase());
        if (!r) return err(ws, 'Room not found');
        if (!r.spectators.includes(ws)) r.spectators.push(ws);
        ws.ctx = { code: r.code, seat: -1, token: null, spectator: true };
        send(ws, { type: 'joined', code: r.code, token: null, yourSeat: -1, spectator: true });
        send(ws, buildState(r, -1));
        break;
      }
      case 'addBot': {
        if (!room || room.phase !== 'lobby') return;
        if (ws.ctx.seat !== room.hostSeat) return err(ws, 'Only the host can edit seats');
        if (m.seat >= room.numPlayers) return;
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
      case 'kick': {
        if (!room || room.phase !== 'lobby') return;
        if (ws.ctx.seat !== room.hostSeat) return err(ws, 'Only the host can remove players');
        if (m.seat === room.hostSeat) return;
        const s = room.seats[m.seat];
        if (!s || !s.occupied) return;
        if (s.ws) { try { s.ws.send(JSON.stringify({ type: 'kicked' })); } catch {} ; s.ws.ctx = { code: null, seat: -1, token: null }; }
        s.occupied = false; s.isBot = false; s.connected = false; s.token = null; s.ws = null;
        s.name = `Seat ${m.seat + 1}`; s.avatar = '🙂';
        broadcast(room);
        break;
      }
      case 'setTarget': {
        if (!room || room.phase !== 'lobby') return;
        if (ws.ctx.seat !== room.hostSeat) return;
        if ([51, 101, 201].includes(m.target)) { room.target = m.target; broadcast(room); }
        break;
      }
      case 'setMode': {
        if (!room || room.phase !== 'lobby') return;
        if (ws.ctx.seat !== room.hostSeat) return err(ws, 'Only the host can change the mode');
        const teams = m.mode === 'teams';
        const np = teams ? 4 : Math.min(4, Math.max(2, parseInt(m.numPlayers) || room.numPlayers));
        const maxOcc = room.seats.reduce((mx, s, i) => s.occupied ? i : mx, -1);
        if (np < maxOcc + 1) return err(ws, `Seat ${maxOcc + 1} is occupied — they must leave first`);
        room.teams = teams;
        room.numPlayers = np;
        if (typeof m.draw === 'boolean') room.draw = m.draw;
        broadcast(room);
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
        const period = m.period === 'week' ? 'week' : 'all';
        Promise.all([DB.leaderboard(20, period), myName ? DB.profile(myName) : null])
          .then(([rows, you]) => send(ws, { type: 'leaderboard', rows, you, period }))
          .catch(() => {});
        break;
      }
      case 'chat': {
        if (!room || ws.ctx.seat < 0) return;
        const s = room.seats[ws.ctx.seat];
        const text = String(m.text || '').slice(0, 160).trim();
        if (!text) return;
        broadcastRaw(room, { type: 'chat', seat: ws.ctx.seat, name: s.name, team: E.teamOf(ws.ctx.seat), text, ts: Date.now() });
        break;
      }
      case 'emote': {
        if (!room || ws.ctx.seat < 0) return;
        const ALLOWED = ['👍', '😂', '🔥', '😮', '😢', '🎉', '🤔', '👏'];
        if (!ALLOWED.includes(m.emote)) return;
        broadcastRaw(room, { type: 'emote', seat: ws.ctx.seat, name: room.seats[ws.ctx.seat].name, emote: m.emote, ts: Date.now() });
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
    if (ws.ctx.spectator) {
      room.spectators = room.spectators.filter(x => x !== ws);
      return;
    }
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

function seatPlayer(ws, room, seat, name, avatar) {
  const s = room.seats[seat];
  s.occupied = true; s.isBot = false; s.connected = true;
  s.name = String(name).slice(0, 16);
  s.avatar = avatar ? String(avatar).slice(0, 8) : (s.avatar || '🙂');
  s.token = genToken();
  s.ws = ws;
  ws.ctx = { code: room.code, seat, token: s.token };
}

httpServer.listen(PORT, () => {
  console.log(`Dominoes server on http://localhost:${PORT}  (WebSocket on same port)`);
});

// Keep-alive: ping our own public URL so the free instance stays awake while running.
// (For a fully reliable wake-from-sleep, also add an external pinger like cron-job.org.)
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
if (SELF_URL && typeof fetch === 'function') {
  setInterval(() => { fetch(SELF_URL.replace(/\/$/, '') + '/healthz').catch(() => {}); }, 10 * 60 * 1000);
}
