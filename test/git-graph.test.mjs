/**
 * Tests for the commit-graph reader: refs, parsing, lane assignment and the
 * transport wrapper. Fixtures are plain strings, so no repository is needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assignLanes, parseGraphLog, parseRefs, readCommitGraph } from '../lib/git/graph.mjs';

const F = '\x1f';

function line(sha, short, parents, author, time, decoration, subject) {
  return [sha, short, parents, author, time, decoration, subject].join(F);
}

test('ref decorations become pill-ready entries', () => {
  assert.deepEqual(parseRefs(''), []);
  assert.deepEqual(parseRefs('HEAD -> main, origin/main, tag: v1.0'), [
    { name: 'main', kind: 'head' },
    { name: 'origin/main', kind: 'remote' },
    { name: 'v1.0', kind: 'tag' },
  ]);
  assert.deepEqual(parseRefs('feat/x'), [{ name: 'feat/x', kind: 'branch' }]);
});

test('the log parser keeps parents, refs and timestamps', () => {
  const commits = parseGraphLog(`${line('a1', 'abc1234', 'b2 c3', 'Ann', '1700', 'HEAD -> main', 'root')}\n`);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].sha, 'a1');
  assert.equal(commits[0].short, 'abc1234');
  assert.deepEqual(commits[0].parents, ['b2', 'c3']);
  assert.equal(commits[0].author, 'Ann');
  assert.equal(commits[0].time, 1700);
  assert.deepEqual(commits[0].refs, [{ name: 'main', kind: 'head' }]);
});

test('a linear history stays in one lane', () => {
  const commits = parseGraphLog(
    [
      line('c3', 'ccc', 'c2', 'A', '3', 'HEAD -> main', 'third'),
      line('c2', 'bbb', 'c1', 'A', '2', '', 'second'),
      line('c1', 'aaa', '', 'A', '1', '', 'first'),
    ].join('\n'),
  );
  const rows = assignLanes(commits);
  assert.deepEqual(rows.map((row) => row.lane), [0, 0, 0]);
  assert.deepEqual(rows.map((row) => row.parents), [[0], [0], [0]]);
  assert.equal(rows[0].columns, 1);
  assert.deepEqual(rows[0].before, [0]);
  assert.deepEqual(rows[2].after, []);
});

test('a merge opens a second lane and draws two parents', () => {
  const commits = parseGraphLog(
    [
      line('m5', 'mmm', 'c3 f2', 'A', '5', 'HEAD -> main', 'Merge feature'),
      line('c3', 'ccc', 'c2', 'A', '3', '', 'main work'),
      line('f2', 'fff', 'f1', 'B', '2', '', 'feature work'),
      line('c2', 'bbb', 'c1', 'A', '1', '', 'main root'),
      line('f1', 'ggg', 'c1', 'B', '1', '', 'feature root'),
      line('c1', 'aaa', '', 'A', '0', '', 'root'),
    ].join('\n'),
  );
  const rows = assignLanes(commits);
  const merge = rows[0];
  assert.equal(merge.lane, 0);
  assert.deepEqual(merge.parents, [0, 1], 'the merge keeps lane 0 and forks lane 1');
  assert.deepEqual(merge.before, [0]);
  assert.deepEqual(merge.after, [0, 1]);
  assert.equal(merge.columns, 2);

  const feature = rows.find((row) => row.short === 'fff');
  assert.equal(feature.lane, 1, 'the feature commits continue in the new lane');
});

test('readCommitGraph asks git for decorations and assigns lanes', async () => {
  const calls = [];
  const stdout = [
    line('m5', 'mmm', 'c3 f2', 'A', '5', 'HEAD -> main', 'Merge feature'),
    line('c3', 'ccc', 'c2', 'A', '3', '', 'main work'),
    line('f2', 'fff', 'c1', 'B', '2', '', 'feature work'),
  ].join('\n');

  const rows = await readCommitGraph('/repo', {
    runGit: async (root, argv) => {
      calls.push({ root, argv });
      return { code: 0, stdout, stderr: '' };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].root, '/repo');
  assert.ok(calls[0].argv.includes('--all'));
  assert.ok(calls[0].argv.includes('--date-order'));
  assert.ok(calls[0].argv.some((arg) => arg.startsWith('--pretty=format:')));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].refs, [{ name: 'main', kind: 'head' }]);
});

test('readCommitGraph degrades to no rows when git fails', async () => {
  const rows = await readCommitGraph('/repo', {
    runGit: async () => ({ code: 128, stdout: '', stderr: 'fatal' }),
  });
  assert.deepEqual(rows, []);
});
