// End-to-end smoke test: boots the server on a temp port/data dir and plays a 4-player game.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const PORT = 3999;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecount-'));
const base = `http://localhost:${PORT}`;
const srv = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT, DATA_DIR }, stdio: 'pipe' });
await new Promise((r) => srv.stdout.once('data', r));

const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw Object.assign(new Error(json.error), { status: res.status });
  return json;
};

try {
  const { code, playerId: a } = await call('POST', '/api/sessions', { name: 'Ada', commander: 'Atraxa' });
  const ids = [a];
  for (const [name, commander] of [['Bo', 'Krenko'], ['Cy', 'Yuriko'], ['Di', 'Edgar Markov']]) {
    ids.push((await call('POST', `/api/sessions/${code}/join`, { name, commander })).playerId);
  }
  const [, b, c, d] = ids;
  const act = (by, body) => call('POST', `/api/sessions/${code}/action`, { playerId: by, ...body });

  // A second phone listening over SSE must see changes made by the first.
  const ctrl = new AbortController();
  const seen = [];
  const sse = fetch(`${base}/api/sessions/${code}/stream?playerId=${b}`, { signal: ctrl.signal }).then(async (res) => {
    const reader = res.body.getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      for (const m of buf.split('\n\n').slice(0, -1)) if (m.startsWith('data: ')) seen.push(JSON.parse(m.slice(6)));
      buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
    }
  }).catch(() => {});

  await act(a, { type: 'seats', order: [a, b, c, d] });
  await act(a, { type: 'start', firstId: a });
  await act(b, { type: 'adjust', target: a, field: 'life', delta: -3 });
  await act(b, { type: 'adjust', target: a, field: 'life', delta: -2 }); // coalesces with previous
  await act(a, { type: 'adjust', target: b, field: 'cmdr', delta: 7, source: a });
  await act(a, { type: 'adjust', target: c, field: 'poison', delta: 4 });
  await act(a, { type: 'passTurn' });
  let { state } = await act(c, { type: 'undo' }).catch(() => ({})); // c has nothing to undo -> error is fine
  state = (await act(a, { type: 'monarch', target: d })).state;

  // Table action: everyone else loses 1 as a single undoable group.
  const before = state.players.map((p) => p.life);
  state = (await act(d, { type: 'bulk', label: 'Opponents lose 1', ops: [a, b, c].map((t) => ({ target: t, field: 'life', delta: -1 })) })).state;
  assert.deepEqual(state.players.map((p) => p.life), before.map((l, i) => (i === 3 ? l : l - 1)));
  state = (await act(d, { type: 'undo' })).state;
  assert.deepEqual(state.players.map((p) => p.life), before, 'undo reverts the whole table action');

  assert.equal(state.players.find((p) => p.id === a).life, 35);
  assert.equal(state.players.find((p) => p.id === b).life, 33, 'commander damage subtracts life');
  assert.equal(state.players.find((p) => p.id === b).cmdr[a], 7);
  assert.equal(state.game.activeId, b, 'turn passed clockwise');
  assert.equal(state.game.log.filter((e) => e.kind === 'adjust' && e.by === b).length, 1, 'rapid taps coalesce');

  await act(a, { type: 'eliminate', target: c });
  await act(a, { type: 'eliminate', target: d });
  state = (await act(b, { type: 'eliminate', target: b })).state;
  assert.equal(state.status, 'ended', 'last player standing ends the game');
  assert.equal(state.game.winnerId, a);
  assert.deepEqual(Object.fromEntries(state.players.map((p) => [p.name, p.place])), { Ada: 1, Bo: 2, Di: 3, Cy: 4 });

  await new Promise((r) => setTimeout(r, 100));
  assert.ok(seen.some((s) => s.status === 'ended'), 'SSE subscriber received the final state');

  const stats = await call('GET', '/api/stats');
  assert.equal(stats.games, 1);
  const ada = stats.players.find((p) => p.name === 'Ada');
  assert.equal(ada.wins, 1);
  assert.equal(ada.damage, 7);
  assert.equal(stats.players.find((p) => p.name === 'Bo').damage, 5);

  // Rematch, then host closes mid-game -> archived as abandoned, session gone.
  await act(a, { type: 'start' });
  await act(a, { type: 'close' });
  await assert.rejects(call('GET', `/api/sessions/${code}`), (e) => e.status === 404);
  const all = await call('GET', '/api/games');
  assert.deepEqual(all.map((g) => g.reason), ['finished', 'abandoned']);

  // A player without a phone: added and edited from someone else's phone, removable by anyone, then claimed.
  const t2 = await call('POST', '/api/sessions', { name: 'Host' });
  const guestBody = { type: 'addPlayer', name: 'Paper', commander: 'Krenko' };
  let s2 = (await call('POST', `/api/sessions/${t2.code}/action`, { playerId: t2.playerId, ...guestBody })).state;
  const joiner = (await call('POST', `/api/sessions/${t2.code}/join`, { name: 'Phone' })).playerId;
  await assert.rejects(call('POST', `/api/sessions/${t2.code}/join`, { name: ' paper ' }), (e) => e.status === 400, 'duplicate names are refused');
  await assert.rejects(call('POST', `/api/sessions/${t2.code}/action`, { playerId: joiner, type: 'profile', name: 'HOST' }), (e) => e.status === 400, 'renaming onto a taken name is refused');
  const guest = s2.players.find((p) => p.name === 'Paper');
  assert.equal(s2.hostId, t2.playerId, 'adding a player does not change the host');
  s2 = (await call('POST', `/api/sessions/${t2.code}/action`, { playerId: joiner, type: 'profile', target: guest.id, commander: 'Yuriko' })).state;
  assert.equal(s2.players.find((p) => p.id === guest.id).commander, 'Yuriko', 'anyone can edit a seat');
  await call('POST', `/api/sessions/${t2.code}/action`, { playerId: joiner, type: 'start', firstId: guest.id });
  s2 = (await call('POST', `/api/sessions/${t2.code}/action`, { playerId: joiner, type: 'passTurn', turn: 1 })).state;
  s2 = (await call('POST', `/api/sessions/${t2.code}/action`, { playerId: t2.playerId, type: 'passTurn', turn: 1 })).state;
  assert.equal(s2.game.turnNumber, 2, 'a stale pass (same turn number) is ignored');
  await call('POST', `/api/sessions/${t2.code}/action`, { playerId: joiner, type: 'end' });
  await call('POST', `/api/sessions/${t2.code}/action`, { playerId: joiner, type: 'backToLobby' });
  s2 = (await call('POST', `/api/sessions/${t2.code}/action`, { playerId: joiner, type: 'kick', target: guest.id })).state;
  assert.ok(!s2.players.some((p) => p.id === guest.id), 'a seat with no phone can be removed by anyone');
  await call('POST', `/api/sessions/${t2.code}/action`, { playerId: t2.playerId, type: 'close' });

  ctrl.abort();
  await sse;
  console.log(`smoke test passed (${seen.length} SSE updates received)`);
} finally {
  srv.kill();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}
