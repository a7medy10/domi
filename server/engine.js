// engine.js — pure, server-authoritative dominoes logic (no DOM, no network).
// Mirrors the rules used in the single-player domi.html.

function createDeck() {
  const d = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) {
    d.push({ top: i, bottom: j, id: `${i}-${j}` });
  }
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function getEnds(board) {
  if (!board.length) return null;
  if (board.length === 1) return { left: board[0].tile.top, right: board[0].tile.bottom };
  return { left: board[0].exTop, right: board[board.length - 1].exBottom };
}

// Both ends of the board stay open: a player may always play on either end that
// matches, including the opening tile. Doubles are placed crossways for looks only
// (no forced "spinner" side). Kept as a stub so call sites stay simple.
function getSpinner(board) {
  return null;
}

function canPlay(tile, board) {
  const ends = getEnds(board);
  if (!ends) return true;
  const sp = getSpinner(board);
  if (sp) return tile.top === sp.num || tile.bottom === sp.num;
  return tile.top === ends.left || tile.bottom === ends.left ||
         tile.top === ends.right || tile.bottom === ends.right;
}

function getSides(tile, board) {
  const ends = getEnds(board);
  if (!ends) return ['right'];
  const sp = getSpinner(board);
  if (sp) {
    const s = [];
    if (tile.top === sp.num || tile.bottom === sp.num) {
      if (sp.needsLeft) s.push('left');
      if (sp.needsRight) s.push('right');
    }
    return s;
  }
  const s = [];
  if (tile.top === ends.left || tile.bottom === ends.left) s.push('left');
  if (tile.top === ends.right || tile.bottom === ends.right) s.push('right');
  return s;
}

function orient(tile, side, board) {
  const ends = getEnds(board);
  if (!ends) return { dTop: tile.top, dBottom: tile.bottom, exTop: tile.top, exBottom: tile.bottom };
  const end = side === 'left' ? ends.left : ends.right;
  if (side === 'left') {
    if (tile.bottom === end) return { dTop: tile.top, dBottom: tile.bottom, exTop: tile.top, exBottom: tile.bottom };
    return { dTop: tile.bottom, dBottom: tile.top, exTop: tile.bottom, exBottom: tile.top };
  }
  if (tile.top === end) return { dTop: tile.top, dBottom: tile.bottom, exTop: tile.top, exBottom: tile.bottom };
  return { dTop: tile.bottom, dBottom: tile.top, exTop: tile.bottom, exBottom: tile.top };
}

function placeTile(game, seat, tile, side) {
  const o = orient(tile, side, game.board);
  const item = { tile, dTop: o.dTop, dBottom: o.dBottom, exTop: o.exTop, exBottom: o.exBottom,
                 by: seat, on: !game.board.length ? 'center' : side };
  if (!game.board.length || side === 'right') game.board.push(item);
  else game.board.unshift(item);
}

function handScore(hand) { return hand.reduce((s, t) => s + t.top + t.bottom, 0); }
function teamOf(seat) { return (seat === 0 || seat === 1) ? 'A' : 'B'; }
function teamSeats(team) { return team === 'A' ? [0, 1] : [2, 3]; }
function teamHandScore(game, team) { return teamSeats(team).reduce((s, i) => s + handScore(game.hands[i]), 0); }

function anyCanPlay(game, seat) { return game.hands[seat].some(t => canPlay(t, game.board)); }
function isBlocked(game) {
  if (game.draw && game.boneyard.length) return false; // can still draw to get unstuck
  for (let i = 0; i < game.numPlayers; i++) if (anyCanPlay(game, i)) return false;
  return true;
}

// Hand size scales down a little for fewer players so there's a boneyard to draw from.
function handSizeFor(numPlayers) { return numPlayers <= 2 ? 7 : 7; }

// Deal a fresh round. opener: seat to open, or -1 to auto-pick highest double across all hands.
function startRound(game, opener) {
  const n = game.numPlayers;
  const deck = createDeck();
  const hs = handSizeFor(n);
  game.hands = [];
  for (let i = 0; i < n; i++) game.hands.push(deck.splice(0, hs));
  game.boneyard = deck;
  game.board = [];
  game.passes = 0;
  game.phase = 'playing';

  if (opener === -1) {
    // First round: whoever holds the highest double opens with it.
    let hd = -1, st = -1;
    for (let i = 0; i < n; i++) for (const t of game.hands[i]) {
      if (t.top === t.bottom && t.top > hd) { hd = t.top; st = i; }
    }
    if (st === -1) {
      st = Math.floor(Math.random() * n);
      game.current = (st + 1) % n;
      return `${game.names[st]} opens`;
    }
    const dt = game.hands[st].find(t => t.top === hd && t.bottom === hd);
    game.hands[st] = game.hands[st].filter(t => t.id !== dt.id);
    placeTile(game, st, dt, 'right');
    game.current = (st + 1) % n;
    return `${game.names[st]} opens [${hd}|${hd}]`;
  }

  // Later rounds: the previous winner opens (highest double, else highest tile).
  const w = opener;
  let hd = -1;
  game.hands[w].forEach(t => { if (t.top === t.bottom && t.top > hd) hd = t.top; });
  let tile;
  if (hd !== -1) tile = game.hands[w].find(t => t.top === hd && t.bottom === hd);
  else tile = game.hands[w].reduce((b, t) => (t.top + t.bottom) > (b.top + b.bottom) ? t : b);
  game.hands[w] = game.hands[w].filter(t => t.id !== tile.id);
  placeTile(game, w, tile, 'right');
  game.current = (w + 1) % n;
  return `${game.names[w]} opens [${tile.top}|${tile.bottom}]`;
}

// Sum of every other player's pips (for free-for-all scoring).
function othersHandScore(game, seat) {
  let s = 0;
  for (let i = 0; i < game.numPlayers; i++) if (i !== seat) s += handScore(game.hands[i]);
  return s;
}

// Bot / auto-resolve picks a tile (and side) for the current seat, or null if it must pass.
function chooseMove(game, seat) {
  const playable = game.hands[seat].filter(t => canPlay(t, game.board));
  if (!playable.length) return null;
  const tile = playable.reduce((b, c) => {
    const sp = getSpinner(game.board);
    if (sp) {
      const cd = c.top === c.bottom && c.top === sp.num, bd = b.top === b.bottom && b.top === sp.num;
      if (cd && !bd) return c; if (!cd && bd) return b;
    }
    const cd = c.top === c.bottom, bd = b.top === b.bottom;
    if (cd && !bd) return c; if (!cd && bd) return b;
    return (c.top + c.bottom) > (b.top + b.bottom) ? c : b;
  });
  const sides = getSides(tile, game.board);
  const side = sides.includes('right') ? 'right' : 'left';
  return { tile, side };
}

module.exports = {
  createDeck, getEnds, getSpinner, canPlay, getSides, orient, placeTile,
  handScore, teamOf, teamSeats, teamHandScore, othersHandScore, anyCanPlay, isBlocked,
  startRound, chooseMove
};
