/**
 * Write-side tests: path/message validation, approval gating, argv assembly
 * and the result the model sees. No Harness package is imported.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerGitFlow } from '../lib/flow/register.mjs';
import {
  clipOutput,
  commitArgv,
  commitReason,
  normalizeMessage,
  normalizeBranch,
  normalizePaths,
  stageArgv,
  stageReason,
  mergeArgv,
  mergeReason,
  abortArgv,
  abortReason,
  continueArgv,
  resolveReason,
} from '../lib/flow/write.mjs';

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

function harness({ statuses, runGit, approval } = {}) {
  const captured = { approvals: [], git: [], statuses: [] };
  const queue = Array.isArray(statuses) ? [...statuses] : null;

  const ctx = {
    workingDirectory: { get: (session) => session.cwd },
    sessionProjections: { register: () => () => {} },
    tools: {
      register(definition) {
        captured.tool = definition;
        return () => {};
      },
    },
    commands: { register: () => () => {} },
    agents: { get: () => undefined },
    effect(callback) {
      callback();
      return () => {};
    },
    inject(_deps, callback) {
      callback(ctx);
      return () => {};
    },
  };
  if (approval !== undefined) {
    ctx.approval = {
      async request(request) {
        captured.approvals.push(request);
        return approval;
      },
    };
  }

  const deps = {
    defineTool: (options) => options,
    readStatus: async (directory) => {
      captured.statuses.push(directory);
      if (queue === null) return snapshot({ root: directory });
      return queue.length > 1 ? queue.shift() : queue[0];
    },
    runGit: async (root, argv, options) => {
      captured.git.push({ root, argv, options });
      return runGit === undefined ? { code: 0, stdout: '', stderr: '' } : runGit(root, argv);
    },
  };

  registerGitFlow(ctx, deps);
  return captured;
}

const agent = { session: { cwd: '/repo' } };
const exec = { agent, callId: 'call-1', signal: new AbortController().signal };

test('paths are validated before they reach git', () => {
  assert.deepEqual(normalizePaths(['src/a.ts', 'docs/b.md']), { ok: true, paths: ['src/a.ts', 'docs/b.md'] });
  assert.equal(normalizePaths([]).ok, false);
  assert.equal(normalizePaths('a.ts').ok, false);
  assert.equal(normalizePaths(['/etc/passwd']).ok, false);
  assert.equal(normalizePaths(['../outside.ts']).ok, false);
  assert.equal(normalizePaths(['-p']).ok, false);
  assert.equal(normalizePaths(['a\0b']).ok, false);
  assert.equal(normalizePaths([42]).ok, false);
});

test('commit messages are trimmed and bounded', () => {
  assert.deepEqual(normalizeMessage('  fix: x  '), { ok: true, message: 'fix: x' });
  assert.equal(normalizeMessage('').ok, false);
  assert.equal(normalizeMessage('   ').ok, false);
  assert.equal(normalizeMessage('x'.repeat(2001)).ok, false);
  assert.equal(normalizeMessage('a\0b').ok, false);
});

test('approval reasons are explicit and bounded', () => {
  assert.match(stageReason({ branch: 'main', paths: ['a.ts', 'b.ts'], working: 2 }), /Stage 2 path\(s\) in main: a\.ts, b\.ts/);
  const many = Array.from({ length: 11 }, (_, index) => `f${index}.ts`);
  assert.match(stageReason({ branch: 'main', paths: many, working: 11 }), /… 3 more/);
  assert.match(stageReason({ branch: 'main', all: true, working: 4 }), /Stage every change in main \(4 working file\(s\)\)/);

  const reason = commitReason({ branch: 'feat/x', message: 'fix: refresh sessions', staged: 2 });
  assert.match(reason, /Commit 2 staged file\(s\) on feat\/x/);
  assert.match(reason, /fix: refresh sessions/);
});

test('argv assembly never builds a shell string', () => {
  assert.deepEqual(stageArgv({ paths: ['a.ts', 'b c.ts'] }), ['add', '--', 'a.ts', 'b c.ts']);
  assert.deepEqual(stageArgv({ all: true }), ['add', '--all']);
  assert.deepEqual(commitArgv('fix: x'), ['commit', '-m', 'fix: x']);
  assert.match(clipOutput('x'.repeat(1000)), /…$/);
});

test('stage asks for approval and then stages exactly the listed paths', async () => {
  const captured = harness({ approval: 'allowed-once' });
  const value = await captured.tool.execute({ action: 'stage', paths: ['src/a.ts'] }, exec);

  assert.equal(captured.approvals.length, 1);
  assert.match(captured.approvals[0].reason, /Stage 1 path\(s\) in main: src\/a\.ts/);
  assert.equal(captured.approvals[0].toolName, 'git_flow');
  assert.equal(captured.approvals[0].callId, 'call-1');

  assert.equal(captured.git.length, 1);
  assert.deepEqual(captured.git[0].argv, ['add', '--', 'src/a.ts']);
  assert.equal(value.kind, 'git-status');
  assert.equal(captured.statuses.length, 2, 'reads the state before and after the write');
});

test('stage --all uses the same approval gate', async () => {
  const captured = harness({ approval: 'allowed-once' });
  await captured.tool.execute({ action: 'stage', all: true }, exec);
  assert.match(captured.approvals[0].reason, /Stage every change/);
  assert.deepEqual(captured.git[0].argv, ['add', '--all']);
});

test('a rejected stage changes nothing', async () => {
  const captured = harness({ approval: 'rejected' });
  const value = await captured.tool.execute({ action: 'stage', paths: ['src/a.ts'] }, exec);
  assert.equal(value.kind, 'rejected');
  assert.equal(value.outcome, 'rejected');
  assert.equal(captured.git.length, 0);
  assert.equal(captured.statuses.length, 1);
});

test('a missing approval service fails closed', async () => {
  const captured = harness({});
  const value = await captured.tool.execute({ action: 'stage', all: true }, exec);
  assert.equal(value.kind, 'rejected');
  assert.equal(value.outcome, 'unavailable');
  assert.equal(captured.git.length, 0);
});

test('stage rejects mixing paths and all', async () => {
  const captured = harness({ approval: 'allowed-once' });
  await assert.rejects(
    captured.tool.execute({ action: 'stage', all: true, paths: ['a.ts'] }, exec),
    /either "paths" or "all"/,
  );
});

test('commit skips the ask when nothing is staged', async () => {
  const captured = harness({ approval: 'allowed-once', statuses: [snapshot()] });
  const value = await captured.tool.execute({ action: 'commit', message: 'fix: x' }, exec);
  assert.equal(value.kind, 'nothing-to-commit');
  assert.equal(captured.approvals.length, 0);
  assert.equal(captured.git.length, 0);
});

test('commit shows the message in the approval and commits after it is allowed', async () => {
  const captured = harness({
    approval: 'allowed-once',
    statuses: [
      snapshot({ staged: { count: 2, files: [] }, counts: { staged: 2, unstaged: 0, untracked: 0, conflicts: 0, working: 2 } }),
      snapshot(),
    ],
  });
  const value = await captured.tool.execute({ action: 'commit', message: '  fix: refresh sessions  ' }, exec);

  assert.equal(captured.approvals.length, 1);
  assert.match(captured.approvals[0].reason, /Commit 2 staged file\(s\) on main/);
  assert.match(captured.approvals[0].reason, /Message:\nfix: refresh sessions/);
  assert.deepEqual(captured.git[0].argv, ['commit', '-m', 'fix: refresh sessions']);
  assert.equal(value.kind, 'git-status');
  assert.equal(value.staged.count, 0);
});

test('a rejected commit does not touch the repository', async () => {
  const captured = harness({
    approval: 'rejected',
    statuses: [snapshot({ staged: { count: 1, files: [] }, counts: { staged: 1, unstaged: 0, untracked: 0, conflicts: 0, working: 1 } })],
  });
  const value = await captured.tool.execute({ action: 'commit', message: 'fix: x' }, exec);
  assert.equal(value.kind, 'rejected');
  assert.equal(captured.git.length, 0);
});

test('a failing git write surfaces the clipped stderr without lying about state', async () => {
  const captured = harness({
    approval: 'allowed-once',
    statuses: [snapshot({ staged: { count: 1, files: [] }, counts: { staged: 1, unstaged: 0, untracked: 0, conflicts: 0, working: 1 } })],
    runGit: async () => ({ code: 1, stdout: '', stderr: 'fatal: empty ident name\nsecond line' }),
  });
  const value = await captured.tool.execute({ action: 'commit', message: 'fix: x' }, exec);
  assert.equal(value.kind, 'failed');
  assert.match(value.message, /fatal: empty ident name/);
  assert.equal(captured.statuses.length, 1, 'no post-write read after a failure');
});

test('an invalid message fails before any approval is requested', async () => {
  const captured = harness({ approval: 'allowed-once' });
  await assert.rejects(captured.tool.execute({ action: 'commit', message: '  ' }, exec), /must not be empty/);
  assert.equal(captured.approvals.length, 0);
});

// ── merge ──────────────────────────────────────────────────────────────────

test('branch names are validated before reaching git', () => {
  assert.deepEqual(normalizeBranch('feat/x'), { ok: true, branch: 'feat/x' });
  assert.equal(normalizeBranch('').ok, false);
  assert.equal(normalizeBranch('  ').ok, false);
  assert.equal(normalizeBranch('-x').ok, false);
  assert.equal(normalizeBranch('a..b').ok, false);
  assert.equal(normalizeBranch('a\0b').ok, false);
  assert.equal(normalizeBranch(42).ok, false);
});

test('merge approval reason names both branches', () => {
  const reason = mergeReason({ sourceBranch: 'feat/x', targetBranch: 'main' });
  assert.match(reason, /Merge branch "feat\/x" into "main"/);
});

test('merge argv is safe', () => {
  assert.deepEqual(mergeArgv('feat/x'), ['merge', '--no-edit', '--', 'feat/x']);
});

test('merge asks for approval and runs git merge', async () => {
  const captured = harness({ approval: 'allowed-once' });
  const value = await captured.tool.execute({ action: 'merge', branch: 'feat/x' }, exec);

  assert.equal(captured.approvals.length, 1);
  assert.match(captured.approvals[0].reason, /Merge branch "feat\/x"/);
  assert.deepEqual(captured.git[0].argv, ['merge', '--no-edit', '--', 'feat/x']);
  assert.equal(value.kind, 'git-status');
});

test('merge is blocked when an operation is already in progress', async () => {
  const captured = harness({
    approval: 'allowed-once',
    statuses: [snapshot({ operation: 'rebase' })],
  });
  const value = await captured.tool.execute({ action: 'merge', branch: 'feat/x' }, exec);
  assert.equal(value.kind, 'error');
  assert.match(value.message, /rebase is already in progress/);
  assert.equal(captured.git.length, 0);
});

test('a rejected merge changes nothing', async () => {
  const captured = harness({ approval: 'rejected' });
  const value = await captured.tool.execute({ action: 'merge', branch: 'feat/x' }, exec);
  assert.equal(value.kind, 'rejected');
  assert.equal(captured.git.length, 0);
});

// ── abort ──────────────────────────────────────────────────────────────────

test('abort argv covers merge and rebase', () => {
  assert.deepEqual(abortArgv('merge'), ['merge', '--abort']);
  assert.deepEqual(abortArgv('rebase'), ['rebase', '--abort']);
  assert.deepEqual(abortArgv('cherry-pick'), ['cherry-pick', '--abort']);
});

test('abort approval reason names the operation and warns about reset', () => {
  const reason = abortReason({ operation: 'merge', branch: 'main' });
  assert.match(reason, /Abort the in-progress merge on main/);
  assert.match(reason, /reset to before/);
});

test('abort asks for approval and runs the abort command', async () => {
  const captured = harness({
    approval: 'allowed-once',
    statuses: [snapshot({ operation: 'merge' }), snapshot()],
  });
  const value = await captured.tool.execute({ action: 'abort' }, exec);

  assert.equal(captured.approvals.length, 1);
  assert.match(captured.approvals[0].reason, /Abort the in-progress merge/);
  assert.deepEqual(captured.git[0].argv, ['merge', '--abort']);
  assert.equal(value.kind, 'git-status');
});

test('abort with no operation in progress returns nothing-to-abort', async () => {
  const captured = harness({ approval: 'allowed-once', statuses: [snapshot()] });
  const value = await captured.tool.execute({ action: 'abort' }, exec);
  assert.equal(value.kind, 'nothing-to-abort');
  assert.equal(captured.approvals.length, 0);
  assert.equal(captured.git.length, 0);
});

// ── resolve ────────────────────────────────────────────────────────────────

test('resolve approval reason names the operation and the resolved files', () => {
  const reason = resolveReason({ operation: 'merge', branch: 'main', paths: ['src/a.ts'] });
  assert.match(reason, /Mark 1 conflict file\(s\) as resolved/);
  assert.match(reason, /continue the merge/);
  assert.match(reason, /src\/a\.ts/);
});

test('continue argv covers merge and rebase', () => {
  assert.deepEqual(continueArgv('merge'), ['merge', '--continue', '--no-edit']);
  assert.deepEqual(continueArgv('rebase'), ['rebase', '--continue', '--no-edit']);
});

test('resolve stages the paths and continues the operation', async () => {
  const captured = harness({
    approval: 'allowed-once',
    statuses: [
      snapshot({ operation: 'merge', counts: { staged: 0, unstaged: 0, untracked: 0, conflicts: 1, working: 1 } }),
      snapshot(),
    ],
  });
  const value = await captured.tool.execute({ action: 'resolve', paths: ['src/a.ts'] }, exec);

  assert.equal(captured.approvals.length, 1);
  assert.match(captured.approvals[0].reason, /Mark 1 conflict file/);
  assert.equal(captured.git.length, 2);
  assert.deepEqual(captured.git[0].argv, ['add', '--', 'src/a.ts']);
  assert.deepEqual(captured.git[1].argv, ['merge', '--continue', '--no-edit']);
  assert.equal(value.kind, 'git-status');
});

test('resolve with no operation returns nothing-to-resolve', async () => {
  const captured = harness({ approval: 'allowed-once', statuses: [snapshot()] });
  const value = await captured.tool.execute({ action: 'resolve', paths: ['src/a.ts'] }, exec);
  assert.equal(value.kind, 'nothing-to-resolve');
  assert.equal(captured.git.length, 0);
});

test('resolve with no conflicts returns no-conflicts', async () => {
  const captured = harness({
    approval: 'allowed-once',
    statuses: [snapshot({ operation: 'merge' })],
  });
  const value = await captured.tool.execute({ action: 'resolve', paths: ['src/a.ts'] }, exec);
  assert.equal(value.kind, 'no-conflicts');
  assert.equal(captured.git.length, 0);
});

test('a rejected resolve changes nothing', async () => {
  const captured = harness({
    approval: 'rejected',
    statuses: [snapshot({ operation: 'merge', counts: { staged: 0, unstaged: 0, untracked: 0, conflicts: 1, working: 1 } })],
  });
  const value = await captured.tool.execute({ action: 'resolve', paths: ['src/a.ts'] }, exec);
  assert.equal(value.kind, 'rejected');
  assert.equal(captured.git.length, 0);
});
