/**
 * Wiring tests for the Host registration: projection key, tool surface,
 * working-directory source and command behaviour — with a fake `defineTool`
 * and a fake status reader, so no Harness package is imported.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerGitFlow } from '../lib/flow/register.mjs';

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

/** Minimal Cordis-like context that records what the plugin registers. */
function harness({ readStatus, agents, connection, runGit, approval, discover, projectionState } = {}) {
  const captured = {};
  const effects = [];
  const calls = [];
  const ctx = {
    workingDirectory: { get: (session) => session.cwd },
    sessionProjections: {
      register(definition) {
        captured.projection = definition;
        return () => {};
      },
      stateOf() {
        return projectionState;
      },
    },
    tools: {
      register(definition) {
        captured.tool = definition;
        return () => {};
      },
    },
    commands: {
      register(definition) {
        captured.command = definition;
        return () => {};
      },
    },
    agents: agents ?? { get: () => undefined },
    effect(callback, label) {
      effects.push(label);
      callback();
      return () => {};
    },
    inject(_deps, callback) {
      callback(ctx);
      return () => {};
    },
  };

  if (connection !== undefined) {
    ctx.connection = {
      fetch: {
        register(spec) {
          // Store by path so status and diff routes don't overwrite each other.
          if (spec.path === '/api/git-flow.status') captured.route = spec;
          else if (spec.path === '/api/git-flow.diff') captured.diffRoute = spec;
          else captured.route = spec;
          return () => {};
        },
      },
    };
  }
  if (approval !== undefined) ctx.approval = approval;

  const deps = {
    defineTool: (options) => options,
    readStatus:
      readStatus ??
      (async (directory, options) => {
        calls.push({ directory, options });
        return snapshot({ root: directory });
      }),
    runGit:
      runGit ??
      (async () => {
        return { code: 0, stdout: '', stderr: '' };
      }),
    discover,
  };

  registerGitFlow(ctx, deps);
  return { captured, effects, calls };
}

test('registers the projection, the tool and the command as effects', () => {
  const { captured, effects } = harness();
  assert.equal(effects.length, 5);
  assert.deepEqual(effects, [
    'git-control-flow: projection',
    'git-control-flow: status route',
    'git-control-flow: diff route',
    'git-control-flow: git_flow tool',
    'git-control-flow: /git-flow command',
  ]);
  assert.equal(captured.projection.key, 'gitFlow');
  assert.equal(captured.tool.name, 'git_flow');
  assert.equal(captured.command.name, 'git-flow');
});

test('the tool declares one read and five approval-gated writes', () => {
  const { captured } = harness();
  assert.deepEqual(captured.tool.parameters.action.enum, ['status', 'diff', 'stage', 'commit', 'merge', 'abort', 'resolve']);
  assert.equal(captured.tool.parameters.action.required, true);
  assert.deepEqual(captured.tool.output.schema, { type: 'json' });
});

test('the tool reads the session working directory, never model input', async () => {
  const { captured, calls } = harness();
  const signal = new AbortController().signal;
  const value = await captured.tool.execute(
    { action: 'status' },
    { agent: { session: { cwd: '/sessions/repo' } }, signal },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].directory, '/sessions/repo');
  assert.equal(calls[0].options.signal, signal);
  assert.deepEqual(value, snapshot({ root: '/sessions/repo' }));
});

test('the tool reports a non-repository without throwing', async () => {
  const { captured } = harness({ readStatus: async () => null });
  const value = await captured.tool.execute(
    { action: 'status' },
    { agent: { session: { cwd: '/plain' } }, signal: new AbortController().signal },
  );
  assert.deepEqual(value, { kind: 'not-a-repository', repositories: [] });
});

test('the tool rejects a missing agent and an unknown action', async () => {
  const { captured } = harness();
  await assert.rejects(
    captured.tool.execute({ action: 'status' }, { signal: new AbortController().signal }),
    /agent context/,
  );
  await assert.rejects(
    captured.tool.execute(
      { action: 'push' },
      { agent: { session: { cwd: '/repo' } }, signal: new AbortController().signal },
    ),
    /unsupported action: push/,
  );
});

test('the tool result carries the snapshot as presentation meta', () => {
  const { captured } = harness();
  const value = snapshot({ clean: false });
  assert.deepEqual(captured.tool.output.presentationMeta({ action: 'status' }, value), { gitFlow: value });

  const [block] = captured.tool.output.render({ action: 'status' }, value);
  assert.equal(block.type, 'text');
  assert.match(block.text, /branch main/);
});

test('the command renders status and reports failures as command errors', async () => {
  const ok = harness();
  const success = await ok.captured.command.handler({
    agent: { session: { cwd: '/repo' } },
    rawInput: '',
    signal: new AbortController().signal,
  });
  assert.equal(success.kind, 'success');
  assert.match(success.text, /Working tree clean/);

  const bogus = await ok.captured.command.handler({
    agent: { session: { cwd: '/repo' } },
    rawInput: 'push',
    signal: new AbortController().signal,
  });
  assert.equal(bogus.kind, 'error');
  assert.match(bogus.text, /unknown action: push/);

  const failing = harness({
    readStatus: async () => {
      throw new Error('git exploded');
    },
  });
  const failed = await failing.captured.command.handler({
    agent: { session: { cwd: '/repo' } },
    rawInput: 'status',
    signal: new AbortController().signal,
  });
  assert.equal(failed.kind, 'error');
  assert.equal(failed.text, 'git exploded');
});

test('the status route serves the card model for a known session', async () => {
  const read = [];
  const session = { session: { cwd: '/sessions/repo' } };
  const { captured } = harness({
    readStatus: async (directory, options) => {
      read.push({ directory, signal: options?.signal });
      return snapshot({ root: directory });
    },
    agents: { get: (id) => (id === 'session-1' ? session : undefined) },
    connection: {},
  });

  assert.equal(captured.route.path, '/api/git-flow.status');
  assert.deepEqual(captured.route.methods, ['GET']);

  const response = await captured.route.fetch(
    new Request('http://local/api/git-flow.status?sessionId=session-1'),
  );
  assert.equal(response.status, 200);
  const view = await response.json();
  assert.equal(view.presence, 'repo');
  assert.equal(view.branch.name, 'main');
  assert.equal(read.length, 1);
  assert.equal(read[0].directory, '/sessions/repo');
});

test('the status route carries the projection pending state for the overlay', async () => {
  const pending = { phase: 'awaiting-approval', action: 'stage', reason: 'Stage 1 path(s) in test: a.ts' };
  const { captured } = harness({
    readStatus: async (directory) => snapshot({ root: directory }),
    agents: { get: () => ({ session: { cwd: '/repo' } }) },
    connection: {},
    projectionState: { presence: 'repo', status: null, revision: 1, updatedAt: 1, pending },
  });

  const response = await captured.route.fetch(
    new Request('http://local/api/git-flow.status?sessionId=s'),
  );
  const view = await response.json();
  assert.deepEqual(view.pending, pending);
});

test('the status route omits pending when the projection has none', async () => {
  const { captured } = harness({
    readStatus: async (directory) => snapshot({ root: directory }),
    agents: { get: () => ({ session: { cwd: '/repo' } }) },
    connection: {},
  });

  const response = await captured.route.fetch(
    new Request('http://local/api/git-flow.status?sessionId=s'),
  );
  assert.equal((await response.json()).pending, null);
});

test('the status route rejects a missing or unknown session', async () => {
  const { captured } = harness({ connection: {}, agents: { get: () => undefined } });

  const missing = await captured.route.fetch(new Request('http://local/api/git-flow.status'));
  assert.equal(missing.status, 400);

  const unknown = await captured.route.fetch(
    new Request('http://local/api/git-flow.status?sessionId=nope'),
  );
  assert.equal(unknown.status, 404);
});

test('the status route reports a non-repository and a failed read', async () => {
  const absent = harness({
    readStatus: async () => null,
    agents: { get: () => ({ session: { cwd: '/plain' } }) },
    connection: {},
  });
  const absentResponse = await absent.captured.route.fetch(
    new Request('http://local/api/git-flow.status?sessionId=s'),
  );
  assert.equal((await absentResponse.json()).presence, 'absent');

  const failing = harness({
    readStatus: async () => {
      throw new Error('git exploded');
    },
    agents: { get: () => ({ session: { cwd: '/repo' } }) },
    connection: {},
  });
  const failingResponse = await failing.captured.route.fetch(
    new Request('http://local/api/git-flow.status?sessionId=s'),
  );
  assert.equal(failingResponse.status, 500);
  assert.match((await failingResponse.json()).error, /git exploded/);
});

// Discovery: a container directory reports the repositories one level down.
test('a non-repository session reports the repositories found one level down', async () => {
  const { captured } = harness({
    readStatus: async () => null,
    agents: { get: () => ({ session: { cwd: '/container' } }) },
    connection: {},
    discover: async (directory) => [
      { name: 'alpha', branch: 'main', detached: false, changed: 2, clean: false },
      { name: 'beta', branch: 'feat/x', detached: false, changed: 0, clean: true },
    ],
  });

  const response = await captured.route.fetch(
    new Request('http://local/api/git-flow.status?sessionId=s'),
  );
  const view = await response.json();
  assert.equal(view.presence, 'absent');
  assert.deepEqual(view.repositories.map((repo) => repo.name), ['alpha', 'beta']);
  assert.equal(view.repositories[0].changed, 2);
  assert.equal(view.repositories[1].clean, true);
});

test('the tool reports discovered repositories instead of a bare not-a-repository', async () => {
  const { captured } = harness({
    readStatus: async () => null,
    discover: async () => [{ name: 'alpha', branch: 'main', detached: false, changed: 1, clean: false }],
  });

  const value = await captured.tool.execute(
    { action: 'status' },
    { agent: { session: { cwd: '/container' } }, signal: new AbortController().signal },
  );
  assert.equal(value.kind, 'not-a-repository');
  assert.equal(value.repositories.length, 1);
  assert.equal(value.repositories[0].name, 'alpha');
});

// ── sub-repo routing ─────────────────────────────────────────────────────────

test('status with repo param resolves to the sub-directory', async () => {
  const { captured, calls } = harness();
  const signal = new AbortController().signal;
  await captured.tool.execute(
    { action: 'status', repo: 'alpha' },
    { agent: { session: { cwd: '/container' } }, signal },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].directory, '/container/alpha');
});

test('status with multi-segment repo resolves correctly', async () => {
  const { captured, calls } = harness();
  const signal = new AbortController().signal;
  await captured.tool.execute(
    { action: 'status', repo: 'sub/alpha' },
    { agent: { session: { cwd: '/container' } }, signal },
  );
  assert.equal(calls[0].directory, '/container/sub/alpha');
});

test('status without repo uses session directory', async () => {
  const { captured, calls } = harness();
  const signal = new AbortController().signal;
  await captured.tool.execute(
    { action: 'status' },
    { agent: { session: { cwd: '/sessions/repo' } }, signal },
  );
  assert.equal(calls[0].directory, '/sessions/repo');
});

test('write action with repo param targets the sub-directory', async () => {
  const gitCalls = [];
  const { captured } = harness({
    readStatus: async (directory) =>
      snapshot({ root: directory, staged: { count: 1, files: [] }, counts: { staged: 1, unstaged: 0, untracked: 0, conflicts: 0, working: 1 } }),
    runGit: async (cwd, argv) => { gitCalls.push({ cwd, argv }); return { code: 0, stdout: '', stderr: '' }; },
    approval: { request: async () => 'allowed-once' },
  });
  const signal = new AbortController().signal;
  await captured.tool.execute(
    { action: 'commit', repo: 'alpha', message: 'fix: something' },
    { agent: { session: { cwd: '/container' } }, callId: 'c1', signal },
  );
  // Git must have been run against the sub-repo's root.
  const commitCall = gitCalls.find((c) => c.argv[0] === 'commit');
  assert.ok(commitCall, 'expected a commit git call');
  assert.equal(commitCall.cwd, '/container/alpha');
});

test('invalid repo value throws before touching the filesystem', async () => {
  const { captured } = harness();
  const signal = new AbortController().signal;
  await assert.rejects(
    captured.tool.execute(
      { action: 'status', repo: '/absolute' },
      { agent: { session: { cwd: '/container' } }, signal },
    ),
    /relative/,
  );
  await assert.rejects(
    captured.tool.execute(
      { action: 'status', repo: 'foo/../../../etc' },
      { agent: { session: { cwd: '/container' } }, signal },
    ),
    /escape/,
  );
});
