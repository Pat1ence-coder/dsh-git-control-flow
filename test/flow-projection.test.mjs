/**
 * Offline tests for the `gitFlow` projection, its schema adapter and the text
 * rendering. No Harness package is imported, so this runs in plain Node.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGitFlowProjection } from '../lib/flow/projection.mjs';
import {
  GIT_FLOW_KEY,
  GIT_FLOW_STATE_VERSION,
  applyGitFlowEvent,
  initialGitFlowState,
  validateGitFlowState,
} from '../lib/flow/state.mjs';
import { defineSchema } from '../lib/flow/schema.mjs';
import { renderStatusText } from '../lib/flow/render.mjs';
import { GIT_FLOW_ACTIONS, GIT_FLOW_COMMAND, GIT_FLOW_TOOL } from '../lib/flow/contract.mjs';

function snapshot(overrides = {}) {
  return {
    kind: 'git-status',
    root: '/repo',
    branch: { name: 'main', detached: false, oid: 'a'.repeat(40), upstream: null, ahead: 0, behind: 0 },
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

function resultEvent(flow, time = 1000) {
  return {
    type: 'tool/result',
    seq: 7,
    time,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'tool', toolCallId: 'call-1', content: [] },
      meta: { gitFlow: flow },
    },
  };
}

test('contract names stay aligned', () => {
  assert.equal(GIT_FLOW_TOOL, 'git_flow');
  assert.equal(GIT_FLOW_COMMAND, 'git-flow');
  assert.equal(GIT_FLOW_KEY, 'gitFlow');
  assert.deepEqual(GIT_FLOW_ACTIONS, ['status']);
});

test('the projection exposes the registered key, version and a cached card view', () => {
  const projection = createGitFlowProjection();
  assert.equal(projection.key, 'gitFlow');
  assert.equal(projection.stateVersion, GIT_FLOW_STATE_VERSION);

  const state = projection.init({}, 0);
  assert.deepEqual(state, { presence: 'unknown', status: null, revision: 0, updatedAt: null });

  const view = projection.wire.view(state);
  assert.deepEqual(view, { presence: 'unknown', revision: 0, updatedAt: null });
  assert.equal(projection.wire.view(state), view, 'the view is cached per state object');
  assert.equal(projection.stateSchema.parse(state), state);
  assert.equal(projection.wire.viewSchema.parse(view), view);
});

test('an unrelated event keeps the same state reference', () => {
  const projection = createGitFlowProjection();
  const state = projection.init({}, 0);
  assert.equal(projection.apply(state, { type: 'user/message', data: {} }), state);
  assert.equal(projection.apply(state, resultEvent(undefined)), state);
  assert.equal(
    projection.apply(state, { type: 'tool/result', time: 1, data: { meta: { other: { kind: 'x' } } } }),
    state,
  );
});

test('a git-status result becomes the whole card state', () => {
  const projection = createGitFlowProjection();
  const status = snapshot({
    counts: { staged: 1, unstaged: 2, untracked: 3, conflicts: 0, working: 6 },
    clean: false,
  });

  const next = projection.apply(projection.init({}, 0), resultEvent(status, 4242));
  assert.equal(next.presence, 'repo');
  assert.equal(next.status, status);
  assert.equal(next.revision, 1);
  assert.equal(next.updatedAt, 4242);

  const again = projection.apply(next, resultEvent(snapshot({ clean: false }), 5000));
  assert.equal(again.revision, 2);
  assert.equal(again.updatedAt, 5000);
  assert.notEqual(again.status, next.status);
});

test('a not-a-repository result clears the card', () => {
  const projection = createGitFlowProjection();
  const withRepo = projection.apply(projection.init({}, 0), resultEvent(snapshot()));
  const cleared = projection.apply(withRepo, resultEvent({ kind: 'not-a-repository' }, 6000));

  assert.equal(cleared.presence, 'absent');
  assert.equal(cleared.status, null);
  assert.equal(cleared.revision, 2);

  // Repeating the same absent result publishes nothing.
  assert.equal(projection.apply(cleared, resultEvent({ kind: 'not-a-repository' }, 7000)), cleared);
});

test('the wire view survives a JSON round trip whole', () => {
  const projection = createGitFlowProjection();
  const state = projection.apply(projection.init({}, 0), resultEvent(snapshot({ clean: false })));
  const view = projection.wire.view(state);
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view);
});

test('the schema rejects malformed state', () => {
  const schema = defineSchema('gitFlow state', validateGitFlowState);
  const good = initialGitFlowState();
  assert.doesNotThrow(() => schema.parse(good));

  assert.throws(() => schema.parse(null), /must be an object/);
  assert.throws(() => schema.parse({ ...good, presence: 'weird' }), /presence/);
  assert.throws(() => schema.parse({ ...good, revision: -1 }), /revision/);
  assert.throws(() => schema.parse({ ...good, status: snapshot() }), /presence must be "repo"/);
  assert.throws(
    () => schema.parse({ presence: 'repo', status: null, revision: 0, updatedAt: null }),
    /presence must be "unknown" or "absent"/,
  );
  assert.throws(
    () => schema.parse({ presence: 'repo', status: snapshot({ counts: { staged: -1 } }), revision: 1, updatedAt: 1 }),
    /counts\.staged/,
  );

  const bad = schema.safeParse({ ...good, presence: 'weird' });
  assert.equal(bad.success, false);
  assert.match(bad.error.message, /presence/);
});

test('renders a clean repository, a dirty one and a non-repository', () => {
  assert.match(renderStatusText(null), /Not a Git repository/);

  const clean = renderStatusText(
    snapshot({ branch: { name: 'main', detached: false, oid: 'a'.repeat(40), upstream: 'origin/main', ahead: 2, behind: 1 } }),
  );
  assert.match(clean, /branch main/);
  assert.match(clean, /origin\/main \(\+2\/-1\)/);
  assert.match(clean, /Working tree clean/);

  const dirty = renderStatusText(
    snapshot({
      clean: false,
      counts: { staged: 1, unstaged: 1, untracked: 1, conflicts: 1, working: 3 },
      diffStat: { add: 12, del: 3, binaryFiles: 0 },
      operation: 'merge',
      conflicts: { count: 1, files: [{ path: 'a.txt', code: 'UU', kind: 'conflict' }] },
      staged: { count: 1, files: [{ path: 'b.txt', code: 'A', kind: 'added' }] },
      unstaged: { count: 1, files: [{ path: 'a.txt', code: 'M', kind: 'modified' }] },
      untracked: { count: 1, files: ['u.txt'] },
      recentCommits: [{ short: 'abc1234', author: 'Fixture', time: 1, subject: 'init' }],
    }),
  );
  assert.match(dirty, /Operation in progress: merge/);
  assert.match(dirty, /staged 1, unstaged 1, untracked 1/);
  assert.match(dirty, /conflicts 1; diff \+12 -3/);
  assert.match(dirty, /conflict a\.txt/);
  assert.match(dirty, /staged added b\.txt/);
  assert.match(dirty, /untracked u\.txt/);
  assert.match(dirty, /abc1234 init — Fixture/);

  const detached = renderStatusText(
    snapshot({ branch: { name: null, detached: true, oid: 'b'.repeat(40), upstream: null, ahead: 0, behind: 0 } }),
  );
  assert.match(detached, /detached at bbbbbbb/);
});
