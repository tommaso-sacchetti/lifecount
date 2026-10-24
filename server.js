// Lifecount — synced EDH life counter.
// Zero-dependency Node server: static files + JSON API + Server-Sent Events.
// The server is authoritative: clients send actions, the server reduces them
// into session state and broadcasts the full state to every connected phone.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 3000);
const IDLE_MINUTES = Number(process.env.IDLE_MINUTES || 180);
const COALESCE_MS = 4000; // rapid taps on the same counter merge into one log entry
const MAX_PLAYERS = 8;

fs.mkdirSync(DATA, { recursive: true });
const SESSIONS_FILE = path.join(DATA, 'sessions.json');
const GAMES_FILE = path.join(DATA, 'games.jsonl');

/** @type {Map<string, any>} */
const sessions = new Map();
/** @type {Map<string, Set<http.ServerResponse>>} */
const streams = new Map();

// ---------- persistence ----------

function loadSessions() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    for (const s of raw) if (s.status !== 'closed') sessions.set(s.code, s);
    console.log(`restored ${sessions.size} session(s)`);
  } catch { /* first run */ }
}

let saveTimer = null;
function saveSessionsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = SESSIONS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...sessions.values()]));
    fs.renameSync(tmp, SESSIONS_FILE);
  }, 500);
}

function readGames() {
  try {
    return fs.readFileSync(GAMES_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

function archiveGame(s, reason) {
  const g = s.game;
  if (!g || !g.startedAt || g.archived) return;
  const endedAt = g.endedAt || Date.now();
  const record = {
    id: crypto.randomUUID(),
    session: s.code,
    reason, // 'finished' | 'abandoned'
    startedAt: g.startedAt,
    endedAt,
    durationMs: endedAt - g.startedAt,
    startingLife: s.settings.startingLife,
    turns: g.turns,
    winnerId: g.winnerId,
    players: s.players.map((p) => ({
      id: p.id, name: p.name, commander: p.commander, color: p.color, seat: p.seat,
      finalLife: p.life, poison: p.poison, cmdr: p.cmdr,
      eliminatedAt: p.eliminatedAt || null, place: p.place || null,
    })),
    log: g.log,
  };
  fs.appendFileSync(GAMES_FILE, JSON.stringify(record) + '\n');
  g.archived = true;
}

// ---------- session model ----------

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O
function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (sessions.has(code));
  return code;
}

const COLORS = ['sky', 'crimson', 'jade', 'violet', 'amber', 'teal', 'orange', 'rose'];

function createSession() {
  const s = {
    code: newCode(),
    createdAt: Date.now(),
    lastActivity: Date.now(),
    status: 'lobby', // lobby | playing | ended | closed
    hostId: null,
    version: 0,
    settings: { startingLife: 40 },
    players: [],
    game: null,
  };
  sessions.set(s.code, s);
  return s;
}

function freshGame(s) {
  return { startedAt: null, endedAt: null, winnerId: null, activeId: null, turnNumber: 0, turnStartedAt: null, turns: [], log: [], archived: false };
}

function resetPlayer(p, life) {
  p.life = life;
  p.poison = 0;
  p.cmdr = {};
  p.monarch = false;
  p.eliminatedAt = null;
  p.place = null;
}

function player(s, id) {
  return s.players.find((p) => p.id === id);
}

function alive(s) {
  return s.players.filter((p) => !p.eliminatedAt);
}

class ActionError extends Error {}
const must = (cond, msg) => { if (!cond) throw new ActionError(msg); };

function join(s, { name, commander, color, playerId }) {
  if (playerId && player(s, playerId)) return player(s, playerId); // reconnect
  must(s.status === 'lobby', 'Game already started — rejoin as an existing seat');
  must(s.players.length < MAX_PLAYERS, 'Table is full');
  name = String(name || '').trim().slice(0, 20);
  must(name, 'Name required');
  const used = new Set(s.players.map((p) => p.color));
  const p = {
    id: crypto.randomUUID(),
    name,
    commander: String(commander || '').trim().slice(0, 40),
    color: COLORS.includes(color) && !used.has(color) ? color : COLORS.find((c) => !used.has(c)) || 'amber',
    seat: s.players.length,
  };
  resetPlayer(p, s.settings.startingLife);
  s.players.push(p);
  if (!s.hostId) s.hostId = p.id;
  return p;
}

function logChange(s, by, target, field, delta, source, group) {
  const g = s.game;
  const now = Date.now();
  if (group) { g.log.push({ kind: 'adjust', t: now, by, target, field, delta, source, turn: g.turnNumber, group }); return; }
  const last = g.log[g.log.length - 1];
  if (last && !last.group && last.kind === 'adjust' && last.by === by && last.target === target && last.field === field &&
      last.source === source && now - last.t < COALESCE_MS) {
    last.delta += delta;
    last.t = now;
    if (last.delta === 0) g.log.pop();
    return;
  }
  g.log.push({ kind: 'adjust', t: now, by, target, field, delta, source, turn: g.turnNumber });
}

function adjust(s, by, { target, field, delta, source }, group = null) {
  must(s.status === 'playing', 'Game is not running');
  const p = player(s, target);
  must(p, 'Unknown player');
  delta = Math.trunc(Number(delta));
  must(Number.isFinite(delta) && delta !== 0 && Math.abs(delta) <= 999, 'Bad delta');

  if (field === 'life') {
    p.life += delta;
    // Life lost to an opponent's tap is attributed to that opponent unless a source is given.
    const src = source || (by !== target ? by : null);
    logChange(s, by, target, 'life', delta, src, group);
  } else if (field === 'poison') {
    const next = Math.max(0, p.poison + delta);
    if (next === p.poison) return;
    logChange(s, by, target, 'poison', next - p.poison, source || null, group);
    p.poison = next;
  } else if (field === 'cmdr') {
    must(player(s, source) && source !== target, 'Commander damage needs a source');
    const cur = p.cmdr[source] || 0;
    const next = Math.max(0, cur + delta);
    if (next === cur) return;
    const d = next - cur;
    p.cmdr[source] = next;
    p.life -= d; // commander damage is also life loss
    logChange(s, by, target, 'cmdr', d, source, group);
  } else {
    throw new ActionError('Unknown field');
  }
}

function startTurn(s, playerId) {
  const g = s.game;
  const now = Date.now();
  const cur = g.turns[g.turns.length - 1];
  if (cur && !cur.end) cur.end = now;
  g.turnNumber += 1;
  g.activeId = playerId;
  g.turnStartedAt = now;
  g.turns.push({ n: g.turnNumber, playerId, start: now, end: null });
}

function nextAlive(s, fromId) {
  const seats = [...s.players].sort((a, b) => a.seat - b.seat);
  const i = seats.findIndex((p) => p.id === fromId);
  for (let k = 1; k <= seats.length; k++) {
    const p = seats[(i + k) % seats.length];
    if (!p.eliminatedAt) return p;
  }
  return null;
}

function eliminate(s, p, by) {
  if (p.eliminatedAt) return;
  p.eliminatedAt = Date.now();
  p.place = alive(s).length + 1; // alive() already excludes p
  if (p.monarch) p.monarch = false;
  s.game.log.push({ kind: 'eliminate', t: p.eliminatedAt, by, target: p.id, turn: s.game.turnNumber });
  if (s.game.activeId === p.id) {
    const n = nextAlive(s, p.id);
    if (n) startTurn(s, n.id);
  }
  const left = alive(s);
  if (left.length === 1) finish(s, left[0].id);
}

function finish(s, winnerId) {
  const g = s.game;
  const now = Date.now();
  const cur = g.turns[g.turns.length - 1];
  if (cur && !cur.end) cur.end = now;
  g.endedAt = now;
  g.winnerId = winnerId || null;
  const w = winnerId && player(s, winnerId);
  if (w) w.place = 1;
  s.status = 'ended';
  archiveGame(s, 'finished');
}

function act(s, by, a) {
  const actor = player(s, by);
  must(actor, 'Join the session first');
  const isHost = by === s.hostId;

  switch (a.type) {
    case 'settings': {
      must(s.status === 'lobby', 'Settings locked once the game starts');
      const life = Number(a.startingLife);
      must([20, 25, 30, 40, 50, 60].includes(life), 'Bad starting life');
      s.settings.startingLife = life;
      s.players.forEach((p) => resetPlayer(p, life));
      break;
    }
    case 'profile': {
      if (a.name !== undefined) actor.name = String(a.name).trim().slice(0, 20) || actor.name;
      if (a.commander !== undefined) actor.commander = String(a.commander).trim().slice(0, 40);
      if (a.color && COLORS.includes(a.color) && !s.players.some((p) => p.color === a.color && p !== actor)) actor.color = a.color;
      break;
    }
    case 'seats': {
      must(s.status === 'lobby', 'Seats are locked once the game starts');
      const order = a.order;
      must(Array.isArray(order) && order.length === s.players.length && order.every((id) => player(s, id)), 'Bad seat order');
      order.forEach((id, i) => { player(s, id).seat = i; });
      s.players.sort((x, y) => x.seat - y.seat);
      break;
    }
    case 'shuffleSeats': {
      must(s.status === 'lobby', 'Seats are locked once the game starts');
      const ids = s.players.map((p) => p.id);
      for (let i = ids.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [ids[i], ids[j]] = [ids[j], ids[i]]; }
      ids.forEach((id, i) => { player(s, id).seat = i; });
      s.players.sort((x, y) => x.seat - y.seat);
      break;
    }
    case 'kick': {
      must(s.status === 'lobby' && isHost && a.target !== by, 'Only the host can remove players in the lobby');
      s.players = s.players.filter((p) => p.id !== a.target);
      s.players.forEach((p, i) => { p.seat = i; });
      break;
    }
    case 'start': {
      must(s.status === 'lobby' || s.status === 'ended', 'Already playing');
      must(s.players.length >= 1, 'Need players');
      s.players.forEach((p) => resetPlayer(p, s.settings.startingLife));
      s.game = freshGame(s);
      s.game.startedAt = Date.now();
      s.status = 'playing';
      const first = a.firstId && player(s, a.firstId) ? a.firstId : s.players[crypto.randomInt(s.players.length)].id;
      startTurn(s, first);
      s.game.log.push({ kind: 'start', t: Date.now(), by, target: first, turn: 1 });
      break;
    }
    case 'adjust':
      adjust(s, by, a);
      break;
    case 'bulk': {
      // Table-wide effects ("each opponent loses 2", drain, proliferate...) as one undoable group.
      must(Array.isArray(a.ops) && a.ops.length && a.ops.length <= 16, 'Bad bulk action');
      must(a.ops.every((op) => op.field !== 'cmdr'), 'Commander damage is per player');
      const group = crypto.randomUUID().slice(0, 8);
      s.game.log.push({ kind: 'table', t: Date.now(), by, label: String(a.label || 'Table action').slice(0, 60), group, turn: s.game.turnNumber });
      for (const op of a.ops) adjust(s, by, op, group);
      break;
    }
    case 'passTurn': {
      must(s.status === 'playing', 'Game is not running');
      const n = nextAlive(s, s.game.activeId);
      if (n) startTurn(s, n.id);
      break;
    }
    case 'setActive': {
      must(s.status === 'playing', 'Game is not running');
      const p = player(s, a.target);
      must(p && !p.eliminatedAt, 'Unknown player');
      startTurn(s, p.id);
      break;
    }
    case 'monarch': {
      must(s.status === 'playing', 'Game is not running');
      const p = player(s, a.target);
      must(p, 'Unknown player');
      const was = p.monarch;
      s.players.forEach((q) => { q.monarch = false; });
      p.monarch = !was;
      s.game.log.push({ kind: 'monarch', t: Date.now(), by, target: p.id, on: p.monarch, turn: s.game.turnNumber });
      break;
    }
    case 'eliminate': {
      must(s.status === 'playing', 'Game is not running');
      const p = player(s, a.target);
      must(p, 'Unknown player');
      eliminate(s, p, by);
      break;
    }
    case 'revive': {
      must(s.status === 'playing', 'Game is not running');
      const p = player(s, a.target);
      must(p && p.eliminatedAt, 'Player is not out');
      const place = p.place;
      p.eliminatedAt = null;
      p.place = null;
      s.players.forEach((q) => { if (q.place && q.place > place) q.place -= 1; });
      s.game.log.push({ kind: 'revive', t: Date.now(), by, target: p.id, turn: s.game.turnNumber });
      break;
    }
    case 'undo': {
      must(s.status === 'playing', 'Game is not running');
      const log = s.game.log;
      let idx = -1;
      for (let i = log.length - 1; i >= 0; i--) if (log[i].kind === 'adjust' && log[i].by === by) { idx = i; break; }
      must(idx >= 0, 'Nothing to undo');
      const { group } = log[idx];
      const doomed = group ? log.filter((e) => e.group === group) : [log[idx]];
      for (const e of doomed) {
        const p = player(s, e.target);
        if (!p || e.kind !== 'adjust') continue;
        if (e.field === 'life') p.life -= e.delta;
        if (e.field === 'poison') p.poison = Math.max(0, p.poison - e.delta);
        if (e.field === 'cmdr') { p.cmdr[e.source] = Math.max(0, (p.cmdr[e.source] || 0) - e.delta); p.life += e.delta; }
      }
      s.game.log = log.filter((e) => !doomed.includes(e));
      break;
    }
    case 'end': {
      must(s.status === 'playing', 'Game is not running');
      finish(s, a.winnerId && player(s, a.winnerId) ? a.winnerId : null);
      break;
    }
    case 'backToLobby': {
      must(s.status === 'ended', 'Finish the game first');
      s.status = 'lobby';
      s.game = null;
      s.players.forEach((p) => resetPlayer(p, s.settings.startingLife));
      break;
    }
    case 'close': {
      must(isHost, 'Only the host can close the session');
      closeSession(s, 'closed by host');
      return;
    }
    default:
      throw new ActionError('Unknown action');
  }
}

function closeSession(s, why) {
  if (s.status === 'playing') archiveGame(s, 'abandoned');
  s.status = 'closed';
  s.closedReason = why;
  broadcast(s);
  for (const res of streams.get(s.code) || []) res.end();
  streams.delete(s.code);
  sessions.delete(s.code);
  saveSessionsSoon();
}

function publicState(s) {
  return {
    code: s.code, status: s.status, hostId: s.hostId, version: s.version,
    settings: s.settings, players: s.players, game: s.game, closedReason: s.closedReason,
    idleMinutes: IDLE_MINUTES, lastActivity: s.lastActivity, serverNow: Date.now(),
    online: [...(streams.get(s.code) || [])].map((r) => r.playerId).filter(Boolean),
  };
}

function broadcast(s) {
  const data = `data: ${JSON.stringify(publicState(s))}\n\n`;
  for (const res of streams.get(s.code) || []) res.write(data);
}

function touch(s) {
  s.version += 1;
  s.lastActivity = Date.now();
  saveSessionsSoon();
  broadcast(s);
}

// Idle sweep: sessions with no actions for IDLE_MINUTES close themselves.
setInterval(() => {
  const cutoff = Date.now() - IDLE_MINUTES * 60_000;
  for (const s of sessions.values()) if (s.lastActivity < cutoff) closeSession(s, 'closed after inactivity');
}, 60_000).unref();

// Keep SSE connections alive through proxies / phone sleep.
setInterval(() => {
  for (const set of streams.values()) for (const res of set) res.write(': ping\n\n');
}, 20_000).unref();

// ---------- stats ----------

function computeStats() {
  const games = readGames().filter((g) => g.reason === 'finished');
  const byName = new Map();
  const byCmdr = new Map();
  let totalMs = 0, totalTurns = 0;
  for (const g of games) {
    totalMs += g.durationMs;
    totalTurns += g.turns.length;
    const dmg = damageDealt(g);
    for (const p of g.players) {
      const key = p.name.trim().toLowerCase();
      const row = byName.get(key) || { name: p.name, games: 0, wins: 0, damage: 0, kos: 0, turnMs: 0, turnCount: 0, commanders: {} };
      row.games += 1;
      if (g.winnerId === p.id) row.wins += 1;
      row.damage += dmg[p.id] || 0;
      for (const t of g.turns) if (t.playerId === p.id && t.end) { row.turnMs += t.end - t.start; row.turnCount += 1; }
      if (p.commander) row.commanders[p.commander] = (row.commanders[p.commander] || 0) + 1;
      byName.set(key, row);
      if (p.commander) {
        const ck = p.commander.trim().toLowerCase();
        const c = byCmdr.get(ck) || { commander: p.commander, games: 0, wins: 0 };
        c.games += 1;
        if (g.winnerId === p.id) c.wins += 1;
        byCmdr.set(ck, c);
      }
    }
    for (const [killer, n] of Object.entries(knockouts(g))) {
      const p = g.players.find((x) => x.id === killer);
      if (p) byName.get(p.name.trim().toLowerCase()).kos += n;
    }
  }
  const players = [...byName.values()].map((r) => ({
    name: r.name, games: r.games, wins: r.wins, winRate: r.games ? r.wins / r.games : 0,
    damage: r.damage, kos: r.kos, avgTurnMs: r.turnCount ? r.turnMs / r.turnCount : 0,
    favorite: Object.entries(r.commanders).sort((a, b) => b[1] - a[1])[0]?.[0] || '',
  })).sort((a, b) => b.wins - a.wins || b.winRate - a.winRate);
  return {
    games: games.length,
    avgDurationMs: games.length ? totalMs / games.length : 0,
    avgTurns: games.length ? totalTurns / games.length : 0,
    players,
    commanders: [...byCmdr.values()].sort((a, b) => b.games - a.games),
    recent: games.slice(-20).reverse().map((g) => ({
      id: g.id, endedAt: g.endedAt, durationMs: g.durationMs, turns: g.turns.length,
      winner: g.players.find((p) => p.id === g.winnerId)?.name || null,
      players: g.players.map((p) => ({ name: p.name, commander: p.commander, color: p.color, place: p.place })),
    })),
  };
}

function damageDealt(g) {
  const out = {};
  for (const e of g.log) {
    if (e.kind === 'adjust' && e.source && e.source !== e.target) {
      const loss = e.field === 'life' ? -e.delta : e.field === 'cmdr' ? e.delta : 0;
      if (loss > 0) out[e.source] = (out[e.source] || 0) + loss;
    }
  }
  return out;
}

// Knockout credit: whoever last dealt attributed damage to a player before they were eliminated.
function knockouts(g) {
  const out = {};
  const lastHit = {};
  for (const e of g.log) {
    if (e.kind === 'adjust' && e.source && e.source !== e.target && (e.field === 'cmdr' || e.delta < 0)) lastHit[e.target] = e.source;
    if (e.kind === 'eliminate' && lastHit[e.target]) out[lastHit[e.target]] = (out[lastHit[e.target]] || 0) + 1;
  }
  return out;
}

// ---------- http ----------

function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${PORT}`);
  }
  return out;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2' };

function sendJson(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 64_000) throw new ActionError('Body too large'); }
  return raw ? JSON.parse(raw) : {};
}

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC)) return sendJson(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html'); // SPA fallback
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (parts[0] !== 'api') return serveStatic(req, res, url.pathname);

    if (req.method === 'GET' && parts[1] === 'info') return sendJson(res, 200, { lan: lanUrls(), idleMinutes: IDLE_MINUTES });
    if (req.method === 'GET' && parts[1] === 'stats') return sendJson(res, 200, computeStats());
    if (req.method === 'GET' && parts[1] === 'games' && parts[2]) {
      const g = readGames().find((x) => x.id === parts[2]);
      return g ? sendJson(res, 200, g) : sendJson(res, 404, { error: 'Game not found' });
    }
    if (req.method === 'GET' && parts[1] === 'games') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="lifecount-games.json"' });
      return res.end(JSON.stringify(readGames(), null, 2));
    }

    if (parts[1] === 'sessions') {
      if (req.method === 'POST' && !parts[2]) {
        const s = createSession();
        const body = await readBody(req);
        const p = join(s, body);
        touch(s);
        return sendJson(res, 200, { code: s.code, playerId: p.id, state: publicState(s) });
      }
      const s = sessions.get((parts[2] || '').toUpperCase());
      if (!s) return sendJson(res, 404, { error: 'Session not found or closed' });

      if (req.method === 'GET' && !parts[3]) return sendJson(res, 200, publicState(s));

      if (req.method === 'GET' && parts[3] === 'stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.playerId = url.searchParams.get('playerId');
        if (!streams.has(s.code)) streams.set(s.code, new Set());
        streams.get(s.code).add(res);
        broadcast(s); // includes updated online list
        res.on('close', () => {
          streams.get(s.code)?.delete(res);
          if (sessions.has(s.code)) broadcast(s);
        });
        return;
      }

      if (req.method === 'POST' && parts[3] === 'join') {
        const p = join(s, await readBody(req));
        touch(s);
        return sendJson(res, 200, { playerId: p.id, state: publicState(s) });
      }

      if (req.method === 'POST' && parts[3] === 'action') {
        const body = await readBody(req);
        act(s, body.playerId, body);
        if (sessions.has(s.code)) touch(s);
        return sendJson(res, 200, { state: publicState(s) });
      }
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    if (err instanceof ActionError || err instanceof SyntaxError) return sendJson(res, 400, { error: err.message });
    console.error(err);
    sendJson(res, 500, { error: 'Server error' });
  }
});

loadSessions();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Lifecount running\n  local:  http://localhost:${PORT}`);
  for (const u of lanUrls()) console.log(`  phones: ${u}`);
  console.log(`  idle sessions close after ${IDLE_MINUTES} min\n`);
});
