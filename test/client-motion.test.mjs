import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

let plugin;
runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load: (definition) => { plugin = definition.factory(() => ({})); } } },
});
const { graphTarget, interpolateGraph } = plugin.motion;
const commit = (id, parents = []) => ({ kind: 'commit', id: id.slice(0, 7), sha: id, lane: 0, subject: id, parentShas: parents });
const a = commit('a'), b = commit('b');
const link = (from, to) => ({ from, to, fromLane: 0, toLane: 0 });

test('inserting a row keeps old node/edge identities and samples intermediate geometry', () => {
  const before = graphTarget([a, b], [link(0, 1)], null, false, null);
  const after = graphTarget([commit('new'), a, b], [link(0, 1), link(1, 2)], before, false, null);
  const mid = interpolateGraph(before, after, .35);
  const row = mid.rows.find((entry) => entry.key === 'a');
  assert.ok(row.y > 0 && row.y < 30);
  assert.ok(mid.height > before.height && mid.height < after.height);
  assert.equal(mid.edges.find((edge) => edge.key === 'a>b').draw, 1, 'existing edges do not redraw');
  assert.ok(mid.edges.find((edge) => edge.key === 'new>a').draw > 0);
  assert.ok(mid.edges.find((edge) => edge.key === 'new>a').draw < 1);
});

test('rapid retarget starts at the actual displayed positions without a jump', () => {
  const before = graphTarget([a, b], [link(0, 1)], null, false, null);
  const target = graphTarget([commit('new'), a, b], [link(0, 1), link(1, 2)], before, false, null);
  const mid = interpolateGraph(before, target, .3);
  const reverse = graphTarget([a, b], [link(0, 1)], mid, false, null);
  const start = interpolateGraph(mid, reverse, 0);
  for (const row of mid.rows) {
    const continuing = start.rows.find((entry) => entry.key === row.key);
    assert.equal(continuing.y, row.y);
    assert.equal(continuing.opacity, row.opacity);
  }
  assert.equal(new Set(start.rows.map((entry) => entry.key)).size, start.rows.length);
});

test('only the successful write and its parent relationship allow operation-to-commit replacement', () => {
  const op = { kind: 'operation', id: 'op:merge', operation: 'merge' };
  const before = graphTarget([op, a, b], [link(0, 1), link(1, 2)], null, true, null);
  const merged = commit('merged', ['a', 'b']);
  const completion = { outcome: 'succeeded', action: 'resolve', operation: 'merge', previousHead: 'a', head: 'merged' };
  const after = graphTarget([merged, a, b], [link(0, 1), link(0, 2)], before, false, completion);
  assert.equal(after.rows[0].key, 'op:merge');
  const mid = interpolateGraph(before, after, .3);
  assert.equal(mid.rows[0].previousRow.kind, 'operation');
  assert.ok(mid.rows[0].arc > 0 && mid.rows[0].arc < 1);
  assert.equal(after.rows[0].arc, 0);
  assert.equal(graphTarget([merged, a, b], [], before, false, { ...completion, outcome: 'failed' }).rows[0].key, 'merged');
  assert.equal(graphTarget([commit('merged', ['different']), a, b], [], before, false, completion).rows[0].key, 'merged');
});

test('resolved conflict exits hold their feedback before collapsing, without changing identity', () => {
  const rows = [{ kind: 'conflict', id: 'conflict:a', path: 'a' }, { kind: 'conflict', id: 'conflict:b', path: 'b' }];
  const before = graphTarget(rows, [], null, false, null, 32);
  const target = graphTarget([rows[1]], [], before, false, null, 32);
  const held = interpolateGraph(before, target, .2, { resolved: true });
  const removed = held.rows.find((entry) => entry.key === 'conflict:a');
  assert.equal(removed.opacity, 1);
  assert.equal(removed.resolved, true);
  assert.equal(held.height, before.height);
  assert.equal(held.rows.find((entry) => entry.key === 'conflict:b').y, 32);
  assert.equal(interpolateGraph(before, target, 1, { resolved: true }).rows.length, 1);
});

test('a fast approved resolve can morph the working seat without inventing a running merge node', () => {
  const working = { kind: 'working', id: 'working', files: 1 };
  const before = graphTarget([working, a], [link(0, 1)], null, false, null);
  const completion = { outcome: 'succeeded', action: 'resolve', operation: 'merge', previousHead: 'a', head: 'merged' };
  const after = graphTarget([commit('merged', ['a', 'b']), a], [link(0, 1)], before, false, completion);
  assert.equal(after.rows[0].key, 'working');
  assert.equal(after.rows.some((entry) => entry.row.kind === 'operation'), false);
});

test('a partial commit keeps the remaining working row separate from the new commit', () => {
  const working = { kind: 'working', id: 'working', files: 2 };
  const before = graphTarget([working, a], [link(0, 1)], null, false, null);
  const completion = { outcome: 'succeeded', action: 'commit', previousHead: 'a', head: 'new' };
  const after = graphTarget([{ ...working, files: 1 }, commit('new', ['a']), a], [link(0, 1), link(1, 2)], before, false, completion);
  assert.equal(new Set(after.rows.map((entry) => entry.key)).size, 3);
  assert.equal(after.rows[0].key, 'working');
  assert.equal(after.rows[1].key, 'new');
});
