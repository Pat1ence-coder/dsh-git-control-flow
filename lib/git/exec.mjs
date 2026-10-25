/**
 * Minimal, argv-only Git runner for the read side of the Git workflow card.
 *
 * Security posture (see DSH-GIT-FLOW-DEVELOPMENT.md §5):
 * - never a shell: `spawn('git', args)` with `shell: false`;
 * - no interactive credential prompt and no optional index locks for reads;
 * - bounded output and a hard deadline, so a pathological repository cannot
 *   wedge the Host or the conversation;
 * - the caller passes a directory, never a command line.
 */
import { spawn } from 'node:child_process';

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 256 * 1024;
const KILL_GRACE_MS = 500;

export class GitError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: number | null, argv?: string[], stderr?: string, kind?: string }} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'GitError';
    this.kind = info.kind ?? 'git-failed';
    this.code = info.code ?? null;
    this.argv = info.argv ?? [];
    this.stderr = info.stderr ?? '';
  }
}

/** Environment for every Git child: quiet, non-interactive, locale-stable. */
export function gitEnvironment(extra = {}) {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    LC_ALL: 'C',
    ...extra,
  };
}

/**
 * Run one Git command.
 * @param {string} cwd - working directory; the only place Git looks for a repository.
 * @param {readonly string[]} args - argv after the `git` word (never a shell string).
 * @param {{ timeoutMs?: number, maxBytes?: number, signal?: AbortSignal, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function runGit(cwd, args, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    signal,
    env = gitEnvironment(),
  } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new GitError('git aborted before start', { kind: 'aborted', argv: [...args] }));
      return;
    }

    const child = spawn('git', args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    let timer = null;
    let graceTimer = null;

    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      if (graceTimer !== null) clearTimeout(graceTimer);
      signal?.removeEventListener('abort', onAbort);
    };

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    const terminate = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      graceTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS);
      graceTimer.unref?.();
    };

    function onAbort() {
      terminate();
    }

    signal?.addEventListener('abort', onAbort, { once: true });

    timer = setTimeout(() => {
      terminate();
      finish(reject, new GitError('git timed out', { kind: 'timeout', argv: [...args] }));
    }, timeoutMs);
    timer.unref?.();

    const take = (chunks, seen, chunk) => {
      const length = seen + chunk.length;
      if (length > maxBytes) {
        terminate();
        finish(
          reject,
          new GitError('git output exceeded the configured limit', {
            kind: 'output-limit',
            argv: [...args],
          }),
        );
        return seen;
      }
      chunks.push(chunk);
      return length;
    };

    child.stdout.on('data', (chunk) => {
      outBytes = take(out, outBytes, chunk);
    });
    child.stderr.on('data', (chunk) => {
      errBytes = take(err, errBytes, chunk);
    });

    child.on('error', (cause) => {
      finish(
        reject,
        new GitError(`git could not be started: ${cause.message}`, {
          kind: 'spawn-failed',
          argv: [...args],
        }),
      );
    });

    child.on('close', (code) => {
      finish(resolve, {
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

/**
 * Run one Git command and require success.
 * @param {string} cwd
 * @param {readonly string[]} args
 * @param {{ timeoutMs?: number, maxBytes?: number, signal?: AbortSignal, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<string>} stdout
 */
export async function runGitText(cwd, args, options = {}) {
  const result = await runGit(cwd, args, options);
  if (result.code !== 0) {
    throw new GitError(`git ${args.join(' ')} failed with exit code ${result.code}`, {
      code: result.code,
      argv: [...args],
      stderr: result.stderr.trim(),
    });
  }
  return result.stdout;
}
