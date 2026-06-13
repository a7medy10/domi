// store.js — persistent player stats / leaderboard.
// Uses MongoDB when MONGODB_URI is set; otherwise falls back to an in-memory map
// (so the server still runs locally / on Render before a DB is configured).
const TIERS = [
  { name: 'Diamond',  min: 3000 },
  { name: 'Platinum', min: 1500 },
  { name: 'Gold',     min: 600 },
  { name: 'Silver',   min: 200 },
  { name: 'Bronze',   min: 0 }
];
function tierFor(points) { return (TIERS.find(t => points >= t.min) || TIERS[TIERS.length - 1]).name; }

let coll = null;            // mongo collection (when connected)
const mem = new Map();      // fallback store
let mode = 'memory';

async function initStore() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.log('[store] no MONGODB_URI set — using in-memory leaderboard (NOT persistent)'); return; }
  try {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const db = client.db(process.env.MONGODB_DB || 'domi');
    coll = db.collection('players');
    await coll.createIndex({ points: -1 });
    mode = 'mongo';
    console.log('[store] connected to MongoDB — leaderboard is persistent');
  } catch (e) {
    console.log('[store] MongoDB connection failed, using in-memory store:', e.message);
  }
}

function keyOf(name) { return (String(name || '').trim().toLowerCase().slice(0, 24)) || 'anon'; }
function clampName(name) { return (String(name || 'Anon').trim().slice(0, 24)) || 'Anon'; }

async function recordResult({ name, won, points = 0, roundsWon = 0, avatar }) {
  const _id = keyOf(name), disp = clampName(name);
  const inc = { gamesPlayed: 1, points: Math.max(0, points | 0), roundsWon: roundsWon | 0, wins: won ? 1 : 0, losses: won ? 0 : 1 };
  const histItem = { won: !!won, points: inc.points, ts: Date.now() };
  if (mode === 'mongo') {
    const set = { name: disp, lastSeen: new Date() };
    if (avatar) set.avatar = String(avatar).slice(0, 8);
    await coll.updateOne({ _id },
      { $inc: inc, $set: set, $push: { history: { $each: [histItem], $slice: -20 } } },
      { upsert: true });
  } else {
    const c = mem.get(_id) || { _id, name: disp, gamesPlayed: 0, points: 0, roundsWon: 0, wins: 0, losses: 0, history: [] };
    c.gamesPlayed += 1; c.points += inc.points; c.roundsWon += inc.roundsWon; c.wins += inc.wins; c.losses += inc.losses;
    c.name = disp; c.lastSeen = Date.now();
    if (avatar) c.avatar = String(avatar).slice(0, 8);
    c.history = (c.history || []).concat(histItem).slice(-20);
    mem.set(_id, c);
  }
}
async function setAvatar(name, avatar) {
  if (!avatar) return;
  const _id = keyOf(name), av = String(avatar).slice(0, 8);
  if (mode === 'mongo') await coll.updateOne({ _id }, { $set: { avatar: av, name: clampName(name) } }, { upsert: true });
  else { const c = mem.get(_id) || { _id, name: clampName(name), gamesPlayed: 0, points: 0, roundsWon: 0, wins: 0, losses: 0, history: [] }; c.avatar = av; mem.set(_id, c); }
}

async function leaderboard(limit = 20) {
  let rows;
  if (mode === 'mongo') rows = await coll.find({}).sort({ points: -1, wins: -1 }).limit(limit).toArray();
  else rows = [...mem.values()].sort((a, b) => b.points - a.points || b.wins - a.wins).slice(0, limit);
  return rows.map((r, i) => ({ rank: i + 1, name: r.name, avatar: r.avatar || null, points: r.points, wins: r.wins, games: r.gamesPlayed, tier: tierFor(r.points) }));
}

async function profile(name) {
  const _id = keyOf(name);
  let r;
  if (mode === 'mongo') r = await coll.findOne({ _id });
  else r = mem.get(_id);
  if (!r) return { name: clampName(name), avatar: null, points: 0, wins: 0, losses: 0, games: 0, roundsWon: 0, tier: tierFor(0), rank: null, history: [] };
  let rank;
  if (mode === 'mongo') rank = (await coll.countDocuments({ points: { $gt: r.points } })) + 1;
  else rank = [...mem.values()].filter(x => x.points > r.points).length + 1;
  return { name: r.name, avatar: r.avatar || null, points: r.points, wins: r.wins, losses: r.losses, games: r.gamesPlayed, roundsWon: r.roundsWon || 0, tier: tierFor(r.points), rank, history: (r.history || []).slice(-10) };
}

function storeMode() { return mode; }
module.exports = { initStore, recordResult, setAvatar, leaderboard, profile, tierFor, storeMode };
