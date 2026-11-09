/** Explicit, unsandboxed transport for disposable test fixtures only. */
import { execFile } from 'node:child_process';
import { gitEnvironment } from '../../lib/git/exec.mjs';
import { readGitStatus as readStatus, resolveRepoRoot as resolveRoot } from '../../lib/git/status.mjs';

export function runGit(cwd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: options.timeoutMs ?? 10_000,
      maxBuffer: options.maxBytes ?? 256 * 1024, signal: options.signal,
      env: { ...process.env, ...gitEnvironment(options.env) } }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}
export const readGitStatus = (directory, options = {}) => readStatus(directory, { ...options, runGit });
export const resolveRepoRoot = (directory, options = {}) => resolveRoot(directory, { ...options, runGit });
export { gitEnvironment };
