/**
 * Tests for the Host-computed card model. Pure functions, no Harness import.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_CARD_COMMITS, buildGitFlowView, phaseOf, validateGitFlowView } from '../lib/flow/view.mjs';

function snapshot(overrides = {}) {
  return {
    kind: 'git-status',
    root: '/repo',
    branch: { name: 'main', detached: false, oid: 'a'.repeat(40), upstream: 'origin/main', ahead: 2, behind: 1 },
    operation: null,
    staged: { count: 0, files: [] },
    unstaged: { count: 0, files: [] },
    untracked: { count: 0, files: [] },
    conflicts: { count: 0, files: [] },
    counts: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0, working: 0 },
    diffStat: { add: 0, del: 0, binaryFiles: 0 },
    recentCommits: [],
    clean: true,
    truncated: { files: false, commits: false },
    readAt: 1,
    ...overrides,
  };
}

function state(status, revision = 3) {
  return { presence: status === null ? 'absent' : 'repo', status, revision, updatedAt: 9000 };
}

function commit(index) {
  return {
    short: `abc${index}`,
    author: `Author ${index}`,
    time: 1000 + index,
    subject: `Commit ${index}`,
  };
}

test('a clean repository yields a repo view without a working row', () => {
  const view = buildGitFlowView(state(snapshot({ recentCommits: [commit(1), commit(2)] })));
  assert.equal(view.presence, 'repo');
  assert.equal(view.phase, 'clean');
  assert.equal(view.clean, true);
  assert.deepEqual(view.branch, {
    name: 'main',
    detached: false,
    oid: 'a'.repeat(40),
    upstream: 'origin/main',
    ahead: 2,
    behind: 1,
  });
  assert.deepEqual(view.rows.map((row) => row.kind), ['commit', 'commit']);
  assert.equal(view.hiddenCommits, 0);
  assert.deepEqual(view.counts, { staged: 0, unstaged: 0, untracked: 0, conflicts: 0, working: 0 });
});

test('a dirty repository leads with one working row carrying the file count', () => {
  const view = buildGitFlowView(
    state(
      snapshot({
        clean: false,
        counts: { staged: 1, unstaged: 2, untracked: 0, conflicts: 0, working: 4 },
        diffStat: { add: 12, del: 3, binaryFiles: 0 },
        recentCommits: [commit(1)],
      }),
    ),
  );
  assert.equal(view.phase, 'changes');
  assert.deepEqual(view.rows[0], { kind: 'working', id: 'working', files: 4 });
  assert.equal(view.rows.length, 2);
  assert.deepEqual(view.diffStat, { add: 12, del: 3 });
});

test('conflicts win over an in-flight operation and over plain changes', () => {
  const conflicted = buildGitFlowView(
    state(
      snapshot({
        clean: false,
        operation: 'merge',
        counts: { staged: 0, unstaged: 0, untracked: 0, conflicts: 2, working: 2 },
        conflicts: { count: 2, files: [{ path: 'a.txt', code: 'UU', kind: 'conflict' }] },
      }),
    ),
  );
  assert.equal(conflicted.phase, 'conflicts');

  const merging = buildGitFlowView(state(snapshot({ clean: false, operation: 'merge' })));
  assert.equal(merging.phase, 'merge');

  assert.equal(phaseOf(snapshot({ clean: false })), 'changes');
  assert.equal(phaseOf(snapshot()), 'clean');
  assert.equal(phaseOf(snapshot({ operation: 'rebase', clean: false })), 'rebase');
  assert.equal(phaseOf(snapshot({ operation: 'cherry-pick', clean: false })), 'cherry-pick');
});

test('only the newest commits are listed and the rest are counted', () => {
  const commits = Array.from({ length: MAX_CARD_COMMITS + 3 }, (_, index) => commit(index));
  const view = buildGitFlowView(state(snapshot({ recentCommits: commits })));
  assert.equal(view.rows.length, MAX_CARD_COMMITS);
  assert.equal(view.hiddenCommits, 3);
  assert.equal(view.rows[0].id, 'abc0');
});

test('a detached head keeps its oid and drops the branch name', () => {
  const view = buildGitFlowView(
    state(
      snapshot({
        branch: { name: null, detached: true, oid: 'b'.repeat(40), upstream: null, ahead: 0, behind: 0 },
      }),
    ),
  );
  assert.equal(view.branch.detached, true);
  assert.equal(view.branch.name, null);
  assert.equal(view.branch.oid, 'b'.repeat(40));
});

test('an absent state yields a minimal view', () => {
  const view = buildGitFlowView(state(null, 7));
  assert.deepEqual(view, { presence: 'absent', revision: 7, updatedAt: 9000 });
  assert.equal(validateGitFlowView(view).ok, true);
});

test('the view validator accepts real views and rejects malformed ones', () => {
  const good = buildGitFlowView(state(snapshot({ clean: false, recentCommits: [commit(1)] })));
  assert.equal(validateGitFlowView(good).ok, true);

  const broken = (mutate) => {
    const copy = JSON.parse(JSON.stringify(good));
    mutate(copy);
    return validateGitFlowView(copy);
  };

  assert.equal(broken((view) => { view.presence = 'maybe'; }).ok, false);
  assert.equal(broken((view) => { view.phase = 'pushing'; }).ok, false);
  assert.equal(broken((view) => { view.counts.staged = -1; }).ok, false);
  assert.equal(broken((view) => { view.rows[1].id = 42; }).ok, false);
  assert.equal(broken((view) => { view.rows[0].kind = 'mystery'; }).ok, false);
  assert.equal(broken((view) => { view.hiddenCommits = -1; }).ok, false);
  assert.equal(broken((view) => { view.truncatedFiles = 'no'; }).ok, false);
});
