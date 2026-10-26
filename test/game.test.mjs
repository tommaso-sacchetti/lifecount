// Unit tests for the game rules: act() applied to a session object, no HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Finished games are archived to DATA_DIR; keep that out of the repo.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecount-unit-'));
const { createSession, join, act, cleanCard, ActionError } = await import('../server.js');

// A started game with the given players seated in order; returns the session and their ids.
function game(names = ['Ada', 'Bo', 'Cy'], settings = {}) {
  const s = createSession();
  const ids = names.map((name) => join(s, { name }).id);
  Object.assign(s.settings, settings);
  act(s, ids[0], { type: 'start', firstId: ids[0] });
  return { s, ids, p: (id) => s.players.find((x) => x.id === id) };
}

test('lowering an opponent\'s life is credited to whoever tapped', () => {
  const { s, ids: [a, b] } = game();
  act(s, a, { type: 'adjust', target: b, field: 'life', delta: -3 });
  const e = s.game.log.at(-1);
  assert.equal(e.source, a);
  act(s, b, { type: 'adjust', target: b, field: 'life', delta: -1 });
  assert.equal(s.game.log.at(-1).source, null, 'changes to your own life have no source');
});

test('rapid taps on the same counter merge into one log entry', () => {
  const { s, ids: [a, b], p } = game();
  for (let i = 0; i < 4; i++) act(s, a, { type: 'adjust', target: b, field: 'life', delta: -1 });
  act(s, a, { type: 'adjust', target: b, field: 'poison', delta: 1 });
  const adjusts = s.game.log.filter((e) => e.kind === 'adjust');
  assert.deepEqual(adjusts.map((e) => [e.field, e.delta]), [['life', -4], ['poison', 1]]);
  assert.equal(p(b).life, 36);
});

test('commander damage needs another player as source and also removes life', () => {
  const { s, ids: [a, b], p } = game();
  act(s, b, { type: 'adjust', target: a, field: 'cmdr', delta: 5, source: b });
  assert.equal(p(a).cmdr[b], 5);
  assert.equal(p(a).life, 35);
  assert.throws(() => act(s, a, { type: 'adjust', target: a, field: 'cmdr', delta: 1, source: a }), ActionError);
  assert.throws(() => act(s, a, { type: 'adjust', target: a, field: 'cmdr', delta: 1 }), ActionError);
});

test('poison and commander damage never go below zero', () => {
  const { s, ids: [a, b], p } = game();
  act(s, a, { type: 'adjust', target: b, field: 'poison', delta: -3 });
  act(s, a, { type: 'adjust', target: b, field: 'cmdr', delta: -2, source: a });
  assert.equal(p(b).poison, 0);
  assert.equal(p(b).cmdr[a] || 0, 0);
  assert.equal(p(b).life, 40, 'a no-op change does not touch life');
});

test('undo reverts a whole table action, and only the caller\'s own changes', () => {
  const { s, ids: [a, b, c], p } = game();
  act(s, b, { type: 'adjust', target: c, field: 'life', delta: -2 });
  act(s, a, { type: 'bulk', label: 'Drain 1', ops: [
    { target: b, field: 'life', delta: -1 }, { target: c, field: 'life', delta: -1 }, { target: a, field: 'life', delta: 2 },
  ] });
  act(s, a, { type: 'undo' });
  assert.deepEqual([a, b, c].map((id) => p(id).life), [40, 40, 38], "Bo's earlier change stays");
  assert.throws(() => act(s, a, { type: 'undo' }), ActionError, 'nothing left to undo for Ada');
});

test('passing the turn skips eliminated players and ignores a stale pass', () => {
  const { s, ids: [a, b, c] } = game();
  act(s, a, { type: 'eliminate', target: b });
  act(s, a, { type: 'passTurn', turn: 1 });
  assert.equal(s.game.activeId, c);
  act(s, a, { type: 'passTurn', turn: 1 }); // second phone, same turn
  assert.equal(s.game.activeId, c);
  assert.equal(s.game.turnNumber, 2);
});

test('eliminations set places and the last player standing wins', () => {
  const { s, ids: [a, b, c], p } = game();
  act(s, a, { type: 'eliminate', target: c });
  act(s, a, { type: 'eliminate', target: b });
  assert.equal(s.status, 'ended');
  assert.equal(s.game.winnerId, a);
  assert.deepEqual([a, b, c].map((id) => p(id).place), [1, 2, 3]);
});

test('reviving a player gives back their place', () => {
  const { s, ids: [a, b, c], p } = game(['Ada', 'Bo', 'Cy', 'Di']);
  act(s, a, { type: 'eliminate', target: c });
  act(s, a, { type: 'eliminate', target: b });
  act(s, a, { type: 'revive', target: c });
  assert.equal(p(c).place, null);
  assert.equal(p(b).place, 3, 'places of players still out are unchanged');
});

test('only one monarch at a time', () => {
  const { s, ids: [a, b], p } = game();
  act(s, a, { type: 'monarch', target: a });
  act(s, a, { type: 'monarch', target: b });
  assert.deepEqual([p(a).monarch, p(b).monarch], [false, true]);
});

test('turn tracking off: no active player, no passing; can be switched on mid-game', () => {
  const { s, ids: [a, b] } = game(['Ada', 'Bo'], { turns: false });
  assert.equal(s.game.activeId, null);
  assert.throws(() => act(s, a, { type: 'passTurn' }), ActionError);
  act(s, a, { type: 'turnTracking', on: true, firstId: b });
  assert.equal(s.game.activeId, b);
});

test('names are unique per table, ignoring case and spaces', () => {
  const s = createSession();
  const a = join(s, { name: 'Marco' });
  join(s, { name: 'Luca' });
  assert.throws(() => join(s, { name: ' marco ' }), /already at this table/);
  assert.throws(() => act(s, a.id, { type: 'profile', name: 'LUCA' }), /already at this table/);
  act(s, a.id, { type: 'profile', name: 'Marco' }); // keeping your own name is fine
});

test('players can only be added in the lobby', () => {
  const { s, ids: [a] } = game();
  assert.throws(() => act(s, a, { type: 'addPlayer', name: 'Late' }), ActionError);
});

test('commander cards keep only Scryfall URLs', () => {
  const ok = cleanCard({ name: 'Atraxa', art: 'https://cards.scryfall.io/art_crop/front/d/0/x.jpg?1', colors: ['W', 'U', 'X'] });
  assert.equal(ok.art, 'https://cards.scryfall.io/art_crop/front/d/0/x.jpg?1');
  assert.deepEqual(ok.colors, ['W', 'U']);
  assert.equal(cleanCard({ name: 'X', art: 'https://evil.example/x.jpg' }).art, null);
  assert.equal(cleanCard({ name: 'X', art: "https://cards.scryfall.io/a.jpg');background:url(x" }).art, null, 'no CSS injection');
  assert.equal(cleanCard({ name: '' }), null);
});
