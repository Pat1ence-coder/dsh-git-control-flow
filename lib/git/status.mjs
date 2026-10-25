/**
 * Read one repository's working state into a whole-value JSON snapshot.
 *
 * The snapshot is the contract between the Host and the card: it is complete
 * on every read (never a delta), safe to fold into a projection, and carries
 * no credentials, no remote URLs and no file contents.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { GitError, runGit } from './exec.mjs';
import { MAX_GRAPH_ROWS, readCommitGraph } from './graph.mjs';
import { parseLog, parseNumstat, parsePorcelainV2, statusWord } from './parse.mjs';

/** Files listed per bucket; the counts stay exact beyond this. */
export const MAX_LISTED_FILES = 200;
export const MAX_COMMITS = 20;

/**
 * Resolve the repository root that owns `directory`.
 * @param {string} directory
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<string | null>} canonical root, or null when not a repository
 */
export async function resolveRepoRoot(directory, options = {}) {
  const result = await runGit(directory, ['rev-parse', '--show-toplevel'], options);
  if (result.code !== 0) return null;
  const root = result.stdout.trim();
  return root === '' ? null : root;
}

/**
 * @typedef {{ path: string, code: string, kind: string, origPath?: string }} StatusFile
 * @typedef {{
 *   kind: 'git-status',
 *   root: string,
 *   branch: { name: string | null, detached: boolean, oid: string | null, upstream: string | null, ahead: number, behind: number },
 *   operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null,
 *   staged: { count: number, files: StatusFile[] },
 *   unstaged: { count: number, files: StatusFile[] },
 *   untracked: { count: number, files: string[] },
 *   conflicts: { count: number, files: Array<{ path: string, code: string, kind: string }> },
 *   counts: { staged: number, unstaged: number, untracked: number, conflicts: number, working: number },
 *   diffStat: { add: number, del: number, binaryFiles: number },
 *   recentCommits: Array<{ short: string, author: string, time: number, subject: string }>,
 *   graph: import('./graph.mjs').GraphRow[],
 *   clean: boolean,
 *   truncated: { files: boolean, commits: boolean },
 *   readAt: number,
 * }} GitStatusSnapshot
 */

/**
 * Read `directory`'s repository state.
 * @param {string} directory - any directory inside the repository
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<GitStatusSnapshot | null>} null when `directory` is not inside a repository
 */
export async function readGitStatus(directory, options = {}) {
  const root = await resolveRepoRoot(directory, options);
  if (root === null) return null;

  const [status, workNumstat, indexNumstat, gitDirResult, logResult, graph] = await Promise.all([
    runGit(
      root,
      ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignored=no'],
      options,
    ),
    runGit(root, ['diff', '--numstat', '-z', '--no-ext-diff', '--no-color', '--no-textconv'], options),
    runGit(root, ['diff', '--cached', '--numstat', '-z', '--no-ext-diff', '--no-color', '--no-textconv'], options),
    runGit(root, ['rev-parse', '--absolute-git-dir'], options),
    runGit(
      root,
      ['log', '-n', String(MAX_COMMITS), '--no-color', '--no-show-signature', '--pretty=format:%h%x1f%an%x1f%at%x1f%s'],
      options,
    ),
    readCommitGraph(root, { runGit, signal: options.signal, maxRows: MAX_GRAPH_ROWS }),
  ]);

  if (status.code !== 0) {
    throw new GitError('git status failed', {
      code: status.code,
      argv: ['status', '--porcelain=v2', '-z', '--branch'],
      stderr: status.stderr.trim(),
    });
  }

  const parsed = parsePorcelainV2(status.stdout);
  const work = workNumstat.code === 0 ? parseNumstat(workNumstat.stdout) : { add: 0, del: 0, binaryFiles: 0, files: [] };
  const index = indexNumstat.code === 0 ? parseNumstat(indexNumstat.stdout) : { add: 0, del: 0, binaryFiles: 0, files: [] };

  const gitDir =
    gitDirResult.code === 0 && gitDirResult.stdout.trim() !== ''
      ? gitDirResult.stdout.trim()
      : join(root, '.git');

  const operation = readOperation(gitDir);

  const recentCommits = parsed.branch.oid === null ? [] : logResult.code === 0 ? parseLog(logResult.stdout) : [];

  const workingPaths = new Set();
  for (const file of parsed.staged) workingPaths.add(file.path);
  for (const file of parsed.unstaged) workingPaths.add(file.path);
  for (const path of parsed.untracked) workingPaths.add(path);

  const counts = {
    staged: parsed.staged.length,
    unstaged: parsed.unstaged.length,
    untracked: parsed.untracked.length,
    conflicts: parsed.conflicts.length,
    working: workingPaths.size,
  };

  const listed = (files) => files.slice(0, MAX_LISTED_FILES);
  const truncatedFiles =
    counts.staged > MAX_LISTED_FILES || counts.unstaged > MAX_LISTED_FILES || counts.untracked > MAX_LISTED_FILES;

  return {
    kind: 'git-status',
    root: resolve(root),
    branch: {
      name: parsed.branch.name,
      detached: parsed.branch.detached,
      oid: parsed.branch.oid,
      upstream: parsed.branch.upstream,
      ahead: parsed.branch.ahead,
      behind: parsed.branch.behind,
    },
    operation,
    staged: {
      count: counts.staged,
      files: listed(parsed.staged).map((file) => ({
        path: file.path,
        code: file.code,
        kind: statusWord(file.code),
        ...(file.origPath ? { origPath: file.origPath } : {}),
      })),
    },
    unstaged: {
      count: counts.unstaged,
      files: listed(parsed.unstaged).map((file) => ({
        path: file.path,
        code: file.code,
        kind: statusWord(file.code),
        ...(file.origPath ? { origPath: file.origPath } : {}),
      })),
    },
    untracked: {
      count: counts.untracked,
      files: listed(parsed.untracked),
    },
    conflicts: {
      count: counts.conflicts,
      files: listed(parsed.conflicts).map((file) => ({
        path: file.path,
        code: file.code,
        kind: 'conflict',
      })),
    },
    counts,
    diffStat: {
      add: work.add + index.add,
      del: work.del + index.del,
      binaryFiles: work.binaryFiles + index.binaryFiles,
    },
    recentCommits: recentCommits.slice(0, MAX_COMMITS),
    graph,
    clean: counts.staged + counts.unstaged + counts.untracked + counts.conflicts === 0,
    truncated: {
      files: truncatedFiles,
      commits: recentCommits.length > MAX_COMMITS,
    },
    readAt: Date.now(),
  };
}

/**
 * Which multi-commit operation is mid-flight, if any.
 * @param {string} gitDir - absolute `--absolute-git-dir`
 * @returns {'merge' | 'rebase' | 'cherry-pick' | 'revert' | null}
 */
export function readOperation(gitDir) {
  const has = (name) => existsSync(join(gitDir, name));
  if (has('MERGE_HEAD')) return 'merge';
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (has('REVERT_HEAD')) return 'revert';
  return null;
}
