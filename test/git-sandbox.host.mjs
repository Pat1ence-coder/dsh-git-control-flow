/**
 * Real Host-provider integration, separate from the dependency-free unit suite.
 * DSH_HOST_MODULES points to an installed DSH node_modules directory. Uses only
 * disposable repositories; never loads a live profile or changes session policy.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm, access, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createManagedGitRunner } from '../lib/git/exec.mjs';
import { readGitStatus, readGitStatusLight } from '../lib/git/status.mjs';
import { canonicalDirectory } from '../lib/git/scope.mjs';
import { registerGitFlow } from '../lib/flow/register.mjs';
import { runGit as setupGit } from './support/git.mjs';

const modules = process.env.DSH_HOST_MODULES;
if (!modules) throw new Error('Set DSH_HOST_MODULES to an installed DSH node_modules directory');
const hostImport = (name) => import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib/index.js')).href);
const [{ Context }, { default: Subprocess }, { default: Sandbox }, diagnostics] = await Promise.all([
  hostImport('cordis'), hostImport('dsh-subprocess-local'), hostImport('dsh-sandbox-local'), hostImport('dsh-sandbox'),
]);
const fixtureBase = resolve('.tmp');
await mkdir(fixtureBase, { recursive: true });
const base = await mkdtemp(join(fixtureBase, 'sandbox-host-'));
const workspace = join(base, 'workspace'), repo = join(workspace, 'repo'), outside = join(base, 'outside');
await mkdir(repo, { recursive: true });
await mkdir(outside);
const ctx = new Context();
await ctx.plugin(Subprocess);
await ctx.plugin(Sandbox, {});
const session = { id: 'sandbox-fixture', header: { cwd: workspace }, mode: 'workspace-write' };
const execution = { agent: { session }, callId: 'fixture-call', signal: new AbortController().signal };
const managed = createManagedGitRunner({
  subprocess: ctx.subprocess, sandbox: ctx.sandbox,
  sandboxPolicy: { resolve: ({ session: current }) => ({ mode: current.mode, workspaceRoot: current.header.cwd, sessionId: current.id }) },
}, diagnostics);
const run = (argv, options = {}) => managed(repo, argv, { session, ...options });
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const setup = async (cwd, ...argv) => {
  const result = await setupGit(cwd, ['-c', 'core.hooksPath=/dev/null', ...argv]);
  assert.equal(result.code, 0, result.stderr);
};
let tool, approvals = 0;
registerGitFlow({
  workingDirectory: { get: (current) => current.header.cwd },
  sessionProjections: { register: () => () => {} },
  tools: { register: (definition) => { tool = definition; return () => {}; } },
  commands: { register: () => () => {} }, effect: (fn) => fn(),
  approval: { request: async () => { approvals += 1; return 'allowed-once'; } },
}, {
  defineTool: (definition) => definition, runGit: managed, prepareWrite: managed.prepareWrite, canonicalDirectory,
  readStatus: (cwd, options) => readGitStatus(cwd, { ...options, runGit: managed }),
  readStatusLight: (cwd, options) => readGitStatusLight(cwd, { ...options, runGit: managed }),
});
const invoke = (args, exec = execution) => tool.execute({ repo: 'repo', ...args }, exec);
const hookPath = join(repo, '.git', 'hooks', 'pre-commit');
const hook = (body) => writeFile(hookPath, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
const sentinels = ['GCF_FIXTURE_SECRET', 'DSH_FIXTURE_SENTINEL'];
const priorEnv = new Map(sentinels.map((key) => [key, process.env[key]]));
try {
  await setup(repo, 'init', '-q', '-b', 'main');
  await setup(repo, 'config', 'user.name', 'Fixture');
  await setup(repo, 'config', 'user.email', 'fixture@example.invalid');
  await setup(repo, 'config', 'commit.gpgsign', 'false');
  await setup(repo, 'config', 'core.hooksPath', join(repo, '.git', 'hooks'));
  await writeFile(join(repo, 'file.txt'), 'base\n');
  await setup(repo, 'add', '--all');
  await setup(repo, 'commit', '-qm', 'base');
  const status = await invoke({ action: 'status' });
  assert.equal(status.clean, true);
  assert.ok(status.graph.length > 0);

  process.env.GCF_FIXTURE_SECRET = 'synthetic-fixture-value';
  process.env.DSH_FIXTURE_SENTINEL = 'synthetic-fixture-value';
  await hook('test -z "$GCF_FIXTURE_SECRET" || exit 31\ntest -z "$DSH_FIXTURE_SENTINEL" || exit 32\ntest -n "$HOME" || exit 33');
  await writeFile(join(repo, 'file.txt'), 'inside\n');
  await invoke({ action: 'stage', all: true });
  const committed = await invoke({ action: 'commit', message: 'inside write' });
  assert.equal(committed.clean, true);
  assert.deepEqual(committed.write.sandbox, { mode: 'workspace-write', enforcement: 'full' });
  console.log('PASS actual providers: approved stage/commit, full confinement, scrubbed environment');

  await writeFile(join(repo, 'file.txt'), 'denied outside write\n');
  await invoke({ action: 'stage', all: true });
  const blocked = join(outside, 'must-not-exist');
  await hook(`printf forbidden > ${quote(blocked)}`);
  await assert.rejects(invoke({ action: 'commit', message: 'blocked hook' }), { kind: 'sandbox-denied' });
  assert.equal(await exists(blocked), false);
  assert.equal((await invoke({ action: 'status' })).staged.count, 1, 'failed commit does not undo staging');
  console.log('PASS actual providers: a Git hook cannot write outside the authorized workspace');

  const ready = join(workspace, 'hook-ready'), escaped = join(workspace, 'child-survived');
  const hangingHook = `trap '' TERM\nsh -c ${quote(`trap '' TERM; sleep 2; printf survivor > ${quote(escaped)}; sleep 30`)} &\nprintf ready > ${quote(ready)}\nwait`;
  await hook(hangingHook);
  const controller = new AbortController();
  const cancelling = invoke({ action: 'commit', message: 'cancelled hook' }, { ...execution, signal: controller.signal });
  cancelling.catch(() => {});
  const deadline = Date.now() + 5000;
  while (!await exists(ready) && Date.now() < deadline) await delay(20);
  assert.equal(await exists(ready), true, 'the hook started before cancellation');
  controller.abort();
  await assert.rejects(cancelling, { name: 'AbortError' });
  await delay(2200);
  assert.equal(await exists(escaped), false, 'a TERM-ignoring descendant was killed before it could write');
  console.log('PASS actual providers: cancellation joins TERM-ignoring Git hook descendants');

  await rm(ready, { force: true });
  await assert.rejects(run(['commit', '-m', 'timed out hook'], { write: true, timeoutMs: 1000 }), { kind: 'timeout' });
  assert.equal(await exists(ready), true);
  await delay(2200);
  assert.equal(await exists(escaped), false);
  console.log('PASS actual providers: deadline escalates and joins descendants');

  await hook('exit 0');
  await invoke({ action: 'commit', message: 'after cancellation' });
  const wt = join(workspace, 'linked');
  await setup(repo, 'worktree', 'add', '-q', '-b', 'linked', wt);
  await writeFile(join(wt, 'file.txt'), 'linked worktree\n');
  const beforeDenied = approvals;
  const narrow = { ...session, header: { cwd: wt } };
  await assert.rejects(tool.execute({ action: 'stage', all: true }, { ...execution, agent: { session: narrow } }), { kind: 'sandbox-denied' });
  assert.equal(approvals, beforeDenied, 'external metadata is rejected before asking for approval');
  await invoke({ action: 'stage', repo: 'linked', all: true });
  assert.equal((await invoke({ action: 'commit', repo: 'linked', message: 'linked change' })).clean, true);
  console.log('PASS actual providers: worktrees succeed inside the authorized root, external metadata fails closed');

  await setup(repo, 'switch', '-qc', 'feature');
  await writeFile(join(repo, 'file.txt'), 'feature change\n');
  await setup(repo, 'commit', '-qam', 'feature change');
  await setup(repo, 'switch', '-q', 'main');
  await writeFile(join(repo, 'file.txt'), 'main change\n');
  await setup(repo, 'commit', '-qam', 'main change');
  assert.equal((await invoke({ action: 'merge', branch: 'feature' })).kind, 'failed');
  assert.equal((await invoke({ action: 'status' })).counts.conflicts, 1);
  await writeFile(join(repo, 'file.txt'), 'resolved change\n');
  const approvalsBeforeResolve = approvals;
  const resolved = await invoke({ action: 'resolve', paths: ['file.txt'] });
  assert.equal(approvals, approvalsBeforeResolve + 1);
  assert.equal(resolved.clean, true);
  assert.equal(resolved.operation, null);
  assert.equal(resolved.write.sandbox.enforcement, 'full');
  assert.equal(resolved.graph.find((commit) => commit.sha === resolved.branch.oid).parentShas.length, 2);
  console.log('PASS actual providers: conflicted merge and approved add/continue resolution');

  const readOnly = { ...session, mode: 'read-only' };
  const approvalsBeforeReadOnly = approvals;
  await assert.rejects(invoke({ action: 'stage', all: true }, { ...execution, agent: { session: readOnly } }), { kind: 'sandbox-denied' });
  assert.equal(approvals, approvalsBeforeReadOnly);
  await symlink(outside, join(workspace, 'escape'), 'dir');
  await assert.rejects(invoke({ action: 'status', repo: 'escape' }), /escapes/);
  await writeFile(join(repo, 'file.txt'), 'x'.repeat(10_000));
  await assert.rejects(run(['diff', '--no-ext-diff', '--no-textconv'], { maxBytes: 100 }), { kind: 'output-limit' });
  console.log('PASS actual providers: read-only policy, symlink selection and output limits');
} finally {
  for (const [key, value] of priorEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  managed.dispose();
  await ctx.fiber.dispose();
  await rm(base, { recursive: true, force: true });
}
