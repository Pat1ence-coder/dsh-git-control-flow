import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runGit, gitEnvironment } from '../lib/git/exec.mjs';
import { readGitStatus } from '../lib/git/status.mjs';
import { registerGitFlow } from '../lib/flow/register.mjs';
import { applyGitFlowEvent, initialGitFlowState } from '../lib/flow/state.mjs';

test('real merge: failed continuation clears pending, staged resolutions can retry to completion', async () => {
  const base = join(process.cwd(), '.tmp');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'resolve-regression-'));
  const env = gitEnvironment({
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_EDITOR: 'true',
  });
  const git = (args, options = {}) => runGit(root, ['-c', 'commit.gpgsign=false', ...args], {
    ...options, env: { ...env, ...options.env,
      GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: env.GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL: env.GIT_COMMITTER_EMAIL },
  });
  const ok = async (...args) => {
    const result = await git(args);
    assert.equal(result.code, 0, result.stderr);
  };
  try {
    await ok('init', '-q', '-b', 'main');
    await writeFile(join(root, 'conflict.txt'), 'base\n');
    await ok('add', 'conflict.txt');
    await ok('commit', '-qm', 'base');
    await ok('switch', '-qc', 'feature');
    await writeFile(join(root, 'conflict.txt'), 'feature\n');
    await ok('commit', '-qam', 'feature');
    await ok('switch', '-q', 'main');
    await writeFile(join(root, 'conflict.txt'), 'main\n');
    await ok('commit', '-qam', 'main');
    assert.notEqual((await git(['merge', '--no-edit', 'feature'])).code, 0);
    await writeFile(join(root, 'conflict.txt'), 'resolved\n');

    let tool;
    let state = initialGitFlowState();
    let reproduceOldBug = true;
    let approvals = 0;
    const fold = (event) => { state = applyGitFlowEvent(state, event); };
    const ctx = {
      workingDirectory: { get: () => root },
      sessionProjections: { register: () => () => {} },
      tools: { register: (value) => { tool = value; return () => {}; } },
      commands: { register: () => () => {} },
      effect: (fn) => fn(),
      approval: { request: async ({ toolName, callId, reason }) => {
        const id = `approval-${++approvals}`;
        fold({ type: 'approval/asked', data: { id, toolName, callId, reason } });
        fold({ type: 'approval/decided', data: { id, outcome: 'allowed-once' } });
        return 'allowed-once';
      } },
    };
    registerGitFlow(ctx, {
      defineTool: (value) => value, readStatus: readGitStatus,
      runGit: (_cwd, argv, options) => git(
        reproduceOldBug && argv[1] === '--continue' ? [...argv, '--no-edit'] : argv, options,
      ),
    });
    const resolve = async (callId) => {
      const args = { action: 'resolve', paths: ['conflict.txt'] };
      const value = await tool.execute(args, { agent: { session: {} }, callId });
      fold({ type: 'tool/result', data: {
        message: { source: { kind: 'tool', callId } },
        meta: tool.output.presentationMeta(args, value),
      } });
      return value;
    };

    const failed = await resolve('first');
    assert.equal(failed.kind, 'failed');
    assert.match(failed.message, /--continue expects no arguments/);
    assert.equal(state.pending, null, 'failure must stop the spinner');
    const staged = await readGitStatus(root);
    assert.equal(staged.operation, 'merge');
    assert.equal(staged.counts.conflicts, 0);
    assert.equal(staged.staged.count, 1);

    reproduceOldBug = false;
    const completed = await resolve('retry');
    assert.equal(approvals, 2, 'retry requires its own approval');
    assert.equal(completed.kind, 'git-status');
    assert.equal(completed.operation, null);
    assert.equal(completed.clean, true);
    assert.equal(state.pending, null);
    assert.equal(state.status.operation, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
