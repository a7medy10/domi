// store.js — persistent player stats / leaderboard (all-time + weekly) with derived badges.
// Uses MongoDB when MONGODB_URI is set; otherwise an in-memory map (resets on restart).
const TIERS = [
  { name: 'Diamond',  min: 3000 },
  { name: 'Platinum', min: 1500 },
  { name: 'Gold',     min: 600 },
  { name: 'Silver',   min: 200 },
  { name: 'Bronze',   min: 0 }
];
function tierFor(points) { return (TIERS.find(t => points >= t.min) || TIERS[TIERS.length - 1]).name; }

function weekKey(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const ys = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wk = Math.ceil((((t - ys) / 86400000) + 1) / 7);
  return t.getUTCFullYear() + '-W' + String(wk).padStart(2, '0');
}

function badgesFor(r) {
  const b = [];
  const w = r.wins || 0, g = r.gamesPlayed || 0, p = r.points || 0;
  if (w >= 1) b.push('🥇 First Win');
  if (w >= 10) b.push('🏅 10 Wins');
  if (w >= 50) b.push('👑 50 Wins');
  if (g >= 25) b.push('🎖️ Veteran');
  if (p >= 1000) b.push('💎 1k Club');
  if (tierFor(p) === 'Diamond') b.push('💠 Diamond');
  return b;
}

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
    await coll.createIndex({ weekKey: 1, weekPoints: -1 });
    mode = 'mongo';
    console.log('[store] connected to MongoDB — leaderboard is persistent');
  } catch (e) {
    console.log('[store] MongoDB connection failed, using in-memory store:', e.message);
  }
}

function keyOf(name) { return (String(name || '').trim().toLowerCase().slice(0, 24)) || 'anon'; }
function clampName(name) { return (String(name || 'Anon').trim().slice(0, 24)) || 'Anon'; }
function baseDoc(_id, name) { return { _id, name, avatar: null, gamesPlayed: 0, points: 0, roundsWon: 0, wins: 0, losses: 0, weekKey: '', weekPoints: 0, weekWins: 0, weekGames: 0, history: [] }; }

async function getDoc(_id) {
  if (mode === 'mongo') return await coll.findOne({ _id });
  return mem.get(_id) || null;
}
async function putDoc(c) {
  if (mode === 'mongo') await coll.replaceOne({ _id: c._id }, c, { upsert: true });
  else mem.set(c._id, c);
}
async function allDocs() {
  if (mode === 'mongo') return await coll.find({}).toArray();
  return [...mem.values()];
}

async function recordResult({ name, won, points = 0, roundsWon = 0, avatar }) {
  const _id = keyOf(name), disp = clampName(name), wk = weekKey(), p = Math.max(0, points | 0);
  const c = (await getDoc(_id)) || baseDoc(_id, disp);
  c.name = disp;
  if (avatar) c.avatar = String(avatar).slice(0, 8);
  c.gamesPlayed = (c.gamesPlayed || 0) + 1;
  c.points = (c.points || 0) + p;
  c.roundsWon = (c.roundsWon || 0) + (roundsWon | 0);
  c.wins = (c.wins || 0) + (won ? 1 : 0);
  c.losses = (c.losses || 0) + (won ? 0 : 1);
  if (c.weekKey !== wk) { c.weekKey = wk; c.weekPoints = 0; c.weekWins = 0; c.weekGames = 0; }
  c.weekPoints = (c.weekPoints || 0) + p;
  c.weekWins = (c.weekWins || 0) + (won ? 1 : 0);
  c.weekGames = (c.weekGames || 0) + 1;
  c.history = (c.history || []).concat({ won: !!won, points: p, ts: Date.now() }).slice(-20);
  c.lastSeen = Date.now();
  await putDoc(c);
}

async function setAvatar(name, avatar) {
  if (!avatar) return;
  const _id = keyOf(name);
  const c = (await getDoc(_id)) || baseDoc(_id, clampName(name));
  c.avatar = String(avatar).slice(0, 8);
  await putDoc(c);
}

async function leaderboard(limit = 20, period = 'all') {
  let rows = await allDocs();
  if (period === 'week') {
    const wk = weekKey();
    rows = rows.filter(r => r.weekKey === wk && (r.weekPoints || 0) > 0)
               .sort((a, b) => (b.weekPoints || 0) - (a.weekPoints || 0) || (b.weekWins || 0) - (a.weekWins || 0))
               .slice(0, limit);
    return rows.map((r, i) => ({ rank: i + 1, name: r.name, avatar: r.avatar || null, points: r.weekPoints || 0, wins: r.weekWins || 0, games: r.weekGames || 0, tier: tierFor(r.points || 0) }));
  }
  rows = rows.sort((a, b) => (b.points || 0) - (a.points || 0) || (b.wins || 0) - (a.wins || 0)).slice(0, limit);
  return rows.map((r, i) => ({ rank: i + 1, name: r.name, avatar: r.avatar || null, points: r.points || 0, wins: r.wins || 0, games: r.gamesPlayed || 0, tier: tierFor(r.points || 0) }));
}

async function profile(name) {
  const _id = keyOf(name);
  const r = await getDoc(_id);
  if (!r) return { name: clampName(name), avatar: null, points: 0, wins: 0, losses: 0, games: 0, roundsWon: 0, tier: tierFor(0), rank: null, weekPoints: 0, badges: [], history: [] };
  const all = await allDocs();
  const rank = all.filter(x => (x.points || 0) > (r.points || 0)).length + 1;
  const wk = weekKey();
  return {
    name: r.name, avatar: r.avatar || null, points: r.points || 0, wins: r.wins || 0, losses: r.losses || 0,
    games: r.gamesPlayed || 0, roundsWon: r.roundsWon || 0, tier: tierFor(r.points || 0), rank,
    weekPoints: r.weekKey === wk ? (r.weekPoints || 0) : 0,
    badges: badgesFor(r), history: (r.history || []).slice(-10)
  };
}

function storeMode() { return mode; }
module.exports = { initStore, recordResult, setAvatar, leaderboard, profile, tierFor, storeMode };
