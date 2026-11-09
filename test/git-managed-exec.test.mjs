import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createManagedGitRunner, gitEnvironment } from '../lib/git/exec.mjs';
import { readGitStatus } from '../lib/git/status.mjs';
import { canonicalDirectory } from '../lib/git/scope.mjs';
import { abortable } from '../lib/git/cancel.mjs';

const base = await mkdtemp(join(tmpdir(), 'git-flow-managed-'));
const workspace = join(base, 'workspace');
const outside = join(base, 'outside');
await mkdir(join(workspace, '.git'), { recursive: true });
await mkdir(outside);
after(() => rm(base, { recursive: true, force: true }));
const session = { id: 'fixture', cwd: workspace };

function harness(config = {}) {
  const calls = { policies: [], confined: [], spawns: [], handles: [] };
  const ctx = {
    sandboxPolicy: { resolve(request) {
      calls.policies.push(request);
      return { mode: config.mode ?? 'workspace-write', workspaceRoot: workspace, sessionId: session.id };
    } },
    sandbox: { async confine(argv, policy, signal) {
      calls.confined.push({ argv, policy, signal });
      if (config.confineError) throw config.confineError;
      return { argv: ['sandbox-runner', '--', ...argv], enforcement: config.enforcement ?? 'full', denialSignatures: ['denied'], runnerFailureRules: [] };
    } },
    subprocess: {
      resolveExecutable: async () => '/usr/bin/git',
      spawn(spec) {
        calls.spawns.push(spec);
        if (config.spawnError) throw config.spawnError;
        const stdout = new PassThrough(), stderr = new PassThrough();
        let resolveDone, resolveRange;
        const done = new Promise((resolve) => { resolveDone = resolve; });
        const range = new Promise((resolve) => { resolveRange = resolve; });
        const state = { stopped: false, terminating: false, terminateCalls: 0 };
        const finish = (exitCode = 0) => {
          stdout.end(); stderr.end();
          resolveDone({ exitCode, signal: exitCode === null ? 'SIGKILL' : null });
          if (!config.survivor && !config.hang && !config.cleanupNever) { state.stopped = true; resolveRange(true); }
        };
        const handle = {
          stdout, stderr, done,
          terminate() {
            state.terminateCalls += 1;
            if (state.stopped || state.terminating) return;
            state.terminating = true;
            if (config.cleanupNever) return;
            setTimeout(() => { state.stopped = true; finish(null); resolveRange(true); }, config.stopDelay ?? 0);
          },
          waitForExit: (signal) => config.cleanupNever ? new Promise(() => {}) : abortable(range, signal),
        };
        calls.handles.push(state);
        spec.signal.addEventListener('abort', () => handle.terminate(), { once: true });
        queueMicrotask(() => {
          if (config.output) stdout.write(config.output);
          if (config.stderr) stderr.write(config.stderr);
          if (!config.hang) {
            if (spec.argv.includes('rev-parse')) stdout.write(`${config.metadata ?? join(workspace, '.git')}\n`);
            else if (!config.output) stdout.write('ok\n');
            finish(config.exitCode ?? 0);
          }
          config.onSpawn?.();
        });
        return handle;
      },
    },
  };
  if (config.noSandbox) delete ctx.sandbox;
  const diagnostics = {
    classifyRunnerFailure: () => config.runnerFailure ? { detail: 'fixture runner failure' } : undefined,
    matchesSignature: () => config.denied === true,
    isRunnerSpawnFailure: () => config.runnerSpawnFailure === true,
  };
  return { ctx, calls, run: createManagedGitRunner(ctx, diagnostics, { cleanupMs: config.cleanupMs ?? 200, graceMs: 10 }) };
}

test('all reads narrow to read-only and spawn the confined argv with explicit bounded pipes', async () => {
  const { run, calls } = harness({ mode: 'danger-full-access' });
  const result = await run(workspace, ['status', '--porcelain=v2'], { session });
  assert.equal(result.stdout, 'ok\n');
  assert.equal(calls.confined[0].policy.mode, 'read-only');
  assert.equal(calls.policies[0].session, session);
  assert.equal(calls.spawns[0].argv[0], 'sandbox-runner');
  assert.deepEqual(calls.spawns[0].stdio, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  assert.equal(calls.spawns[0].env.GIT_CONFIG_PARAMETERS, undefined);
  assert.equal(Object.hasOwn(calls.spawns[0].env, 'PATH'), false);
  assert.equal(Object.hasOwn(calls.spawns[0].env, 'HOME'), false);
  assert.equal(calls.handles[0].stopped, true);
});

test('writes require approval context and cannot widen a read-only session', async () => {
  const noApproval = harness();
  await assert.rejects(noApproval.run(workspace, ['add', '--all'], { session }), { kind: 'approval-required' });
  assert.equal(noApproval.calls.spawns.length, 0);
  const readOnly = harness({ mode: 'read-only' });
  await assert.rejects(readOnly.run(workspace, ['add', '--all'], { session, write: true }), { kind: 'sandbox-denied' });
  assert.equal(readOnly.calls.spawns.length, 0);
});

test('write preflight and execution preserve the session workspace boundary', async () => {
  const { run, calls } = harness();
  await run.prepareWrite(workspace, { session });
  await run(workspace, ['add', '--all'], { session, write: true });
  const write = calls.confined.find((call) => call.argv.includes('add'));
  assert.equal(write.policy.mode, 'workspace-write');
  assert.equal(write.policy.workspaceRoot, workspace);
  assert.ok(calls.confined.filter((call) => call.argv.includes('rev-parse')).every((call) => call.policy.mode === 'read-only'));
  await assert.rejects(run(outside, ['add', '--all'], { session, write: true }), { kind: 'sandbox-denied' });
});

test('external worktree metadata fails preflight without a write or automatic root expansion', async () => {
  const { run, calls } = harness({ metadata: outside });
  await assert.rejects(run.prepareWrite(workspace, { session }), { kind: 'sandbox-denied' });
  assert.equal(calls.confined.some((call) => call.policy.mode === 'workspace-write'), false);
  await assert.rejects(run(workspace, ['commit', '-m', 'fixture'], { session, write: true }), { kind: 'sandbox-denied' });
  assert.equal(calls.spawns.some((spec) => spec.argv.includes('commit')), false);
});

test('missing, failed and partial sandbox providers never fall back to an unconfined spawn', async () => {
  for (const config of [{ noSandbox: true }, { enforcement: 'partial' }, { confineError: new Error('no runner') }]) {
    const { run, calls } = harness(config);
    await assert.rejects(run(workspace, ['status'], { session }));
    assert.equal(calls.spawns.length, 0);
  }
});

test('an explicitly selected full-access write is reported as unconfined, never selected as a fallback', async () => {
  const { run, calls } = harness({ mode: 'danger-full-access', noSandbox: true });
  const result = await run(workspace, ['add', '--all'], { session, write: true });
  assert.deepEqual(result.sandbox, { mode: 'danger-full-access', enforcement: 'none' });
  assert.equal(calls.spawns[0].argv[0], '/usr/bin/git');
});

test('caller cancellation waits for managed descendants to stop', async () => {
  const controller = new AbortController();
  const { run, calls } = harness({ hang: true, stopDelay: 25, onSpawn: () => controller.abort() });
  await assert.rejects(run(workspace, ['status'], { session, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.handles[0].stopped, true);
});

test('timeout and excessive output terminate and join the managed range before returning', async () => {
  for (const [config, options, kind] of [
    [{ hang: true, stopDelay: 25 }, { timeoutMs: 15 }, 'timeout'],
    [{ hang: true, stopDelay: 25, output: 'x'.repeat(50) }, { maxBytes: 10 }, 'output-limit'],
  ]) {
    const { run, calls } = harness(config);
    await assert.rejects(run(workspace, ['status'], { session, ...options }), { kind });
    assert.equal(calls.handles[0].stopped, true, 'cleanup escalation was not cancelled early');
  }
});

test('normal command completion also joins leftover descendants', async () => {
  const { run, calls } = harness({ survivor: true, stopDelay: 25 });
  assert.equal((await run(workspace, ['status'], { session })).code, 0);
  assert.equal(calls.handles[0].stopped, true);
  assert.ok(calls.handles[0].terminateCalls > 0);
});

test('failure to prove cleanup is surfaced and bounded even if a provider ignores the wait signal', async () => {
  const { run } = harness({ cleanupNever: true, cleanupMs: 15 });
  await assert.rejects(run(workspace, ['status'], { session }), { kind: 'cleanup-incomplete' });
});

test('cancellation during preparation cannot launch a late command', async () => {
  const { run, calls, ctx } = harness();
  let finish;
  ctx.subprocess.resolveExecutable = () => new Promise((resolve) => { finish = resolve; });
  await assert.rejects(run(workspace, ['status'], { session, timeoutMs: 15 }), { kind: 'timeout' });
  finish('/usr/bin/git');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.spawns.length, 0);
});

test('sandbox runner failure, spawn failure and access denial remain distinguishable', async () => {
  for (const [config, kind] of [
    [{ exitCode: 1, runnerFailure: true }, 'sandbox-unavailable'],
    [{ spawnError: new Error('runner missing'), runnerSpawnFailure: true }, 'sandbox-unavailable'],
    [{ exitCode: 1, denied: true }, 'sandbox-denied'],
  ]) {
    const { run } = harness(config);
    await assert.rejects(run(workspace, ['status'], { session }), { kind });
  }
});

test('unload cancels active work and rejects later starts', async () => {
  let run;
  ({ run } = harness({ hang: true, onSpawn: () => run.dispose() }));
  await assert.rejects(run(workspace, ['status'], { session }), { kind: 'aborted' });
  await assert.rejects(run(workspace, ['status'], { session }), { kind: 'aborted' });
});

test('readers have no default raw-spawn fallback and the runner rejects arbitrary commands', async () => {
  await assert.rejects(readGitStatus(workspace), { kind: 'executor-unavailable' });
  const { run } = harness();
  for (const args of [['push'], ['config', '--global', 'user.name', 'x'], ['status\0']]) {
    await assert.rejects(run(workspace, args, { session, write: true }));
  }
  assert.equal(Object.hasOwn(gitEnvironment(), 'HOME'), false);
});

test('symlink selections cannot escape the session directory', async () => {
  await symlink(outside, join(workspace, 'escape'), 'dir');
  await assert.rejects(canonicalDirectory(workspace, join(workspace, 'escape')), /escapes/);
  assert.equal(await canonicalDirectory(workspace, workspace), workspace);
});
