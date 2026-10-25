/**
 * Text renderings of a status snapshot.
 *
 * Two audiences: the model/tool result and the `/git-flow status` command.
 * Both are deliberately compact and free of file contents, remote URLs and
 * credentials.
 */

/**
 * @param {import('../git/status.mjs').GitStatusSnapshot | null} status
 * @returns {string}
 */
export function renderStatusText(status) {
  if (status === null) return 'Not a Git repository.';

  const branch = status.branch.detached
    ? `detached at ${short(status.branch.oid)}`
    : status.branch.name ?? 'unknown branch';

  const tracking =
    status.branch.upstream === null
      ? ''
      : ` → ${status.branch.upstream} (+${status.branch.ahead}/-${status.branch.behind})`;

  const lines = [`Repository ${status.root} (branch ${branch}${tracking})`];

  if (status.operation !== null) lines.push(`Operation in progress: ${status.operation}`);

  if (status.clean) {
    lines.push('Working tree clean.');
  } else {
    const { counts, diffStat } = status;
    lines.push(
      `Uncommitted ${counts.working} file(s): staged ${counts.staged}, unstaged ${counts.unstaged}, untracked ${counts.untracked}` +
        `; conflicts ${counts.conflicts}; diff +${diffStat.add} -${diffStat.del}`,
    );
    const names = [
      ...status.conflicts.files.map((file) => `conflict ${file.path}`),
      ...status.staged.files.slice(0, 5).map((file) => `staged ${file.kind} ${file.path}`),
      ...status.unstaged.files.slice(0, 5).map((file) => `modified ${file.path}`),
      ...status.untracked.files.slice(0, 5).map((path) => `untracked ${path}`),
    ];
    for (const name of names.slice(0, 10)) lines.push(`  ${name}`);
    if (names.length > 10) lines.push(`  … ${names.length - 10} more`);
    if (status.truncated.files) lines.push('  (file lists truncated)');
  }

  if (status.recentCommits.length > 0) {
    lines.push('Recent commits:');
    for (const commit of status.recentCommits.slice(0, 5)) {
      lines.push(`  ${commit.short} ${commit.subject} — ${commit.author}`);
    }
    if (status.recentCommits.length > 5) lines.push(`  … ${status.recentCommits.length - 5} more`);
  }

  return lines.join('\n');
}

/**
 * @param {string | null} oid
 * @returns {string}
 */
function short(oid) {
  return oid === null ? 'unknown' : oid.slice(0, 7);
}
