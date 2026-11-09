/** Git transport through the Host's sandbox and managed subprocess services. */
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { cancellation, abortable } from './cancel.mjs';
import { containsPath } from './scope.mjs';

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 256 * 1024;
const GRACE_MS = 500;
const CLEANUP_MS = 3000;
const READS = new Set(['status', 'log', 'diff', 'rev-parse']);
const WRITES = new Set(['add', 'commit', 'merge', 'rebase', 'cherry-pick', 'revert']);

export class GitError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'GitError';
    this.kind = info.kind ?? 'git-failed';
    this.code = info.code ?? null;
    this.argv = info.argv ?? [];
    this.stderr = info.stderr ?? '';
  }
}

/** Explicit overrides only: never reintroduce the Host's scrubbed credentials. */
export function gitEnvironment(extra = {}) {
  return {
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat',
    GIT_ASKPASS: '', SSH_ASKPASS: '', LC_ALL: 'C',
    // Ambient repository/config selectors must not redirect a fixed-cwd call.
    GIT_DIR: undefined, GIT_COMMON_DIR: undefined, GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined, GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined, GIT_CONFIG: undefined,
    GIT_CONFIG_PARAMETERS: undefined, GIT_CONFIG_COUNT: undefined,
    GIT_EXEC_PATH: undefined,
    ...extra,
  };
}

export function requireGitRunner(options) {
  if (typeof options?.runGit !== 'function') throw new GitError('A managed Git runner is required', { kind: 'executor-unavailable' });
  return options.runGit;
}

function commandAccess(args, write) {
  if (!Array.isArray(args) || args.length === 0 || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new GitError('Git arguments must be a non-empty argv array without NUL', { kind: 'invalid-argv' });
  }
  if (READS.has(args[0]) || (args[0] === 'config' && args.length === 2 && ['user.name', 'user.email'].includes(args[1]))) return 'read';
  if (!WRITES.has(args[0])) throw new GitError('Git command is not allowed', { kind: 'invalid-command' });
  if (write !== true) throw new GitError('Git writes require an approved write context', { kind: 'approval-required' });
  return 'write';
}

function positive(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error(`${name} must be a positive bounded integer`);
  return value;
}

/**
 * The returned runner has no raw-spawn fallback. Read calls narrow to read-only;
 * writes honor the session policy, including an explicitly selected full-access
 * mode. Missing/partial confinement fails closed rather than escalating itself.
 */
export function createManagedGitRunner(ctx, diagnostics = {}, limits = {}) {
  const active = new Set();
  let disposed = false;
  const cleanupMs = positive(limits.cleanupMs ?? CLEANUP_MS, 'cleanupMs');
  const graceMs = positive(limits.graceMs ?? GRACE_MS, 'graceMs');

  function policyOf(session, access) {
    if (!session) throw new GitError('Git execution requires a session', { kind: 'missing-session' });
    if (typeof ctx.sandboxPolicy?.resolve !== 'function') throw new GitError('Sandbox policy service is unavailable', { kind: 'sandbox-unavailable' });
    const policy = ctx.sandboxPolicy.resolve({ session });
    if (!policy || !['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode)
        || typeof policy.workspaceRoot !== 'string' || !isAbsolute(policy.workspaceRoot)) {
      throw new GitError('Invalid session sandbox policy', { kind: 'sandbox-unavailable' });
    }
    if (access === 'write' && policy.mode === 'read-only') {
      throw new GitError('Git write denied: this session is read-only; write approval does not widen its sandbox policy', { kind: 'sandbox-denied' });
    }
    return access === 'read' ? { ...policy, mode: 'read-only' } : { ...policy };
  }

  async function runGit(cwd, args, options = {}) {
    if (disposed) throw new GitError('Git runner has been disposed', { kind: 'aborted' });
    const access = commandAccess(args, options.write);
    const timeoutMs = positive(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs');
    const maxBytes = positive(options.maxBytes ?? DEFAULT_MAX_BYTES, 'maxBytes');
    const scope = cancellation({ signal: options.signal, timeoutMs,
      timeoutReason: new GitError('Git execution timed out', { kind: 'timeout' }) });
    active.add(scope);
    let handle;
    let prepared;
    let directory;
    const streams = [];
    let result;
    let failure;
    try {
      scope.check();
      const policy = policyOf(options.session, access);
      directory = await abortable(realpath(cwd), scope.signal);
      if (access === 'write' && policy.mode === 'workspace-write') {
        const root = await abortable(realpath(policy.workspaceRoot), scope.signal);
        if (!containsPath(root, directory)) throw new GitError('Git repository is outside the session writable workspace', { kind: 'sandbox-denied' });
        policy.workspaceRoot = root;
        // Recheck after approval too: a linked gitdir may have changed while
        // the approval panel was open. Never silently grant a common ancestor.
        await runGit.prepareWrite(directory, { ...options, write: false, signal: scope.signal });
      }
      if (typeof ctx.subprocess?.spawn !== 'function' || typeof ctx.subprocess?.resolveExecutable !== 'function') {
        throw new GitError('Managed subprocess service is unavailable', { kind: 'executor-unavailable' });
      }
      const executable = await abortable(ctx.subprocess.resolveExecutable('git', undefined, scope.signal), scope.signal);
      const argv = [executable, '-c', 'core.fsmonitor=false', ...args];
      if (policy.mode !== 'danger-full-access') {
        if (typeof ctx.sandbox?.confine !== 'function') throw new GitError('Sandbox service is unavailable; refusing to run Git unconfined', { kind: 'sandbox-unavailable' });
        prepared = await abortable(ctx.sandbox.confine(argv, policy, scope.signal), scope.signal);
        if (prepared?.enforcement !== 'full') throw new GitError('Sandbox cannot fully enforce the requested file policy; Git was not started', { kind: 'sandbox-incomplete' });
        if (!Array.isArray(prepared.argv) || prepared.argv.length === 0) throw new GitError('Sandbox returned no executable command', { kind: 'sandbox-unavailable' });
      }
      scope.check();
      handle = ctx.subprocess.spawn({ argv: prepared?.argv ?? argv, cwd: directory,
        env: gitEnvironment(options.env), stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs, signal: scope.signal });
      const commandDone = Promise.resolve(handle.done);
      commandDone.catch(() => {});
      scope.check();

      const capture = (stream) => {
        if (!stream) throw new GitError('Managed Git output stream is unavailable', { kind: 'executor-unavailable' });
        const chunks = [];
        let bytes = 0;
        const data = (chunk) => {
          if (scope.signal.aborted) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > maxBytes) {
            scope.abort(new GitError('Git output exceeded the configured limit', { kind: 'output-limit' }));
            return;
          }
          chunks.push(buffer);
        };
        const done = new Promise((resolve, reject) => {
          const end = () => resolve(Buffer.concat(chunks).toString('utf8'));
          const error = (cause) => reject(cause);
          stream.on('data', data);
          stream.once('end', end);
          stream.once('error', error);
          streams.push(() => { stream.off('data', data); stream.off('end', end); stream.off('error', error); stream.destroy(); });
          if (stream.readableEnded) end();
        });
        done.catch(() => {});
        return done;
      };
      const outputs = Promise.all([commandDone, capture(handle.stdout), capture(handle.stderr)]);
      const [outcome, stdout, stderr] = await abortable(outputs, scope.signal);
      scope.check();
      const runnerFailure = prepared && diagnostics.classifyRunnerFailure?.(outcome.exitCode, stderr, prepared.runnerFailureRules);
      if (runnerFailure) throw new GitError('Sandbox runner failed; Git did not run', { kind: 'sandbox-unavailable', code: 'SANDBOX_UNAVAILABLE' });
      if (prepared && diagnostics.matchesSignature?.(outcome.exitCode, stderr, prepared.denialSignatures)) {
        throw new GitError(`Git file access denied under ${policy.mode}`, { kind: 'sandbox-denied' });
      }
      result = { code: outcome.exitCode ?? -1, stdout, stderr,
        sandbox: { mode: policy.mode, enforcement: prepared?.enforcement ?? 'none' } };
    } catch (error) {
      failure = scope.signal.aborted ? scope.signal.reason : error;
      if (!scope.signal.aborted && prepared && diagnostics.isRunnerSpawnFailure?.(error, prepared.argv[0], directory)) {
        failure = new GitError('Sandbox runner could not start; refusing an unconfined retry', { kind: 'sandbox-unavailable', code: 'SANDBOX_UNAVAILABLE' });
      }
    } finally {
      if (handle) {
        // Provider owns TERM/KILL for the WHOLE managed range. Use a fresh bound
        // to join it even after cancellation; clearing our deadline cannot cancel
        // the provider's escalation. Do not return success while a hook survives.
        const cleanup = cancellation({ timeoutMs: cleanupMs });
        try {
          handle.terminate();
          const empty = await abortable(handle.waitForExit(cleanup.signal), cleanup.signal);
          if (!empty) throw new Error('managed process range is not empty');
        } catch {
          failure = new GitError('Git cleanup could not confirm that all managed processes stopped', { kind: 'cleanup-incomplete' });
        } finally { cleanup.dispose(); }
        for (const release of streams) release();
        // Observe any late provider rejection even if stream setup failed.
        Promise.resolve(handle.done).catch(() => {});
      }
      if (!failure && scope.signal.aborted) failure = scope.signal.reason;
      scope.dispose();
      active.delete(scope);
    }
    if (failure) throw failure;
    return result;
  }

  /** Preflight write authority and linked-worktree metadata before asking approval. */
  runGit.prepareWrite = async (cwd, options = {}) => {
    const scope = cancellation({ signal: options.signal, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      timeoutReason: new GitError('Git write preflight timed out', { kind: 'timeout' }) });
    try {
      scope.check();
      const policy = policyOf(options.session, 'write');
      if (policy.mode === 'danger-full-access') return;
      const [root, directory] = await abortable(Promise.all([realpath(policy.workspaceRoot), realpath(cwd)]), scope.signal);
      if (!containsPath(root, directory)) throw new GitError('Repository lies outside the session writable workspace; open the session at an authorized repository root', { kind: 'sandbox-denied' });
      for (const argv of [['rev-parse', '--absolute-git-dir'], ['rev-parse', '--path-format=absolute', '--git-common-dir']]) {
        const result = await runGit(directory, argv, { ...options, signal: scope.signal });
        if (result.code !== 0 || !result.stdout.trim()) throw new GitError('Could not resolve Git metadata for this write', { kind: 'invalid-repository' });
        const metadata = await abortable(realpath(result.stdout.trim()), scope.signal);
        if (!containsPath(root, metadata)) throw new GitError('Worktree Git metadata is outside the session writable workspace; use a session whose authorized workspace contains both locations', { kind: 'sandbox-denied' });
      }
      scope.check();
    } finally { scope.dispose(); }
  };
  runGit.dispose = () => {
    disposed = true;
    for (const scope of active) scope.abort(new GitError('Git plugin unloaded', { kind: 'aborted' }));
  };
  return runGit;
}
