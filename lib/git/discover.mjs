/**
 * Discover Git repositories directly inside a directory.
 *
 * A session opened on a container directory (a workspace root that is not
 * itself a repository) should still show the repositories it holds. Only
 * immediate children are considered, symlinks are never followed, and each
 * candidate is confirmed with one `git status` call so the card can show a
 * branch and a dirty marker without paying a full snapshot per repository.
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Repositories listed for one directory. */
export const MAX_DISCOVERED_REPOS = 12;

/** Directory names never scanned: package trees, VCS internals, caches. */
const SKIP_NAMES = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'target']);

/**
 * @typedef {{
 *   name: string,
 *   path: string,
 *   branch: string | null,
 *   detached: boolean,
 *   changed: number,
 *   clean: boolean,
 * }} DiscoveredRepository
 */

/**
 * List the repositories directly under `directory`.
 *
 * @param {string} directory - container directory (the session working directory)
 * @param {{
 *   runGit: (cwd: string, argv: string[], options: { signal?: AbortSignal }) => Promise<{ code: number, stdout: string, stderr: string }>,
 *   signal?: AbortSignal,
 *   maxRepos?: number,
 * }} deps
 * @returns {Promise<DiscoveredRepository[]>}
 */
export async function discoverRepositories(directory, deps) {
  const maxRepos = deps.maxRepos ?? MAX_DISCOVERED_REPOS;

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('.') && !SKIP_NAMES.has(name))
    .sort()
    .slice(0, maxRepos * 4);

  const repos = [];
  for (const name of candidates) {
    if (repos.length >= maxRepos) break;
    if (deps.signal?.aborted === true) break;

    const path = join(directory, name);
    if (!existsSync(join(path, '.git'))) continue;

    const summary = await summarise(path, deps);
    if (summary === null) continue;
    repos.push({ name, path, ...summary });
  }

  return repos;
}

/**
 * One `git status` call per repository: branch line plus a changed-file count.
 * @param {string} path
 * @param {{ runGit: Function, signal?: AbortSignal }} deps
 * @returns {Promise<{ branch: string | null, detached: boolean, changed: number, clean: boolean } | null>}
 */
async function summarise(path, deps) {
  let result;
  try {
    result = await deps.runGit(path, ['status', '--porcelain=v1', '--branch'], { signal: deps.signal });
  } catch {
    return null;
  }
  if (result.code !== 0) return null;

  const lines = result.stdout.split('\n');
  const header = lines[0]?.startsWith('## ') === true ? lines[0].slice(3) : '';
  const { branch, detached } = parseBranchLine(header);
  const changed = lines.slice(1).filter((line) => line.trim() !== '').length;

  return { branch, detached, changed, clean: changed === 0 };
}

/**
 * Parse the `## …` header of `git status --porcelain=v1 --branch`.
 *
 * Shapes seen in practice:
 *   main...origin/main [ahead 1]
 *   feat/x...origin/feat/x
 *   HEAD (no branch)
 *   No commits yet on main
 *
 * @param {string} header
 * @returns {{ branch: string | null, detached: boolean }}
 */
export function parseBranchLine(header) {
  if (header === '') return { branch: null, detached: false };
  if (header.startsWith('HEAD (no branch)')) return { branch: null, detached: true };
  const unborn = /^No commits yet on (.+)$/.exec(header);
  if (unborn !== null) return { branch: unborn[1].trim(), detached: false };

  const name = header.split('...')[0].split(' ')[0].trim();
  return { branch: name === '' ? null : name, detached: false };
}
