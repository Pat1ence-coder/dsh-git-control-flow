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
function harness({ readStatus, agents, connection } = {}) {
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
          captured.route = spec;
          return () => {};
        },
      },
    };
  }

  const deps = {
    defineTool: (options) => options,
    readStatus:
      readStatus ??
      (async (directory, options) => {
        calls.push({ directory, options });
        return snapshot({ root: directory });
      }),
  };

  registerGitFlow(ctx, deps);
  return { captured, effects, calls };
}

test('registers the projection, the tool and the command as effects', () => {
  const { captured, effects } = harness();
  assert.equal(effects.length, 4);
  assert.deepEqual(effects, [
    'git-control-flow: projection',
    'git-control-flow: status route',
    'git-control-flow: git_flow tool',
    'git-control-flow: /git-flow command',
  ]);
  assert.equal(captured.projection.key, 'gitFlow');
  assert.equal(captured.tool.name, 'git_flow');
  assert.equal(captured.command.name, 'git-flow');
});

test('the tool declares a single status action', () => {
  const { captured } = harness();
  assert.deepEqual(captured.tool.parameters.action.enum, ['status']);
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
  assert.deepEqual(value, { kind: 'not-a-repository' });
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
