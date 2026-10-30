/**
 * Review payload: what the card's primary button (and the model's `diff`
 * action) hands to the LLM before any write.
 *
 * One reader serves both callers so the redaction and size rules cannot drift
 * apart. The payload depends on the working tree:
 *
 * - `conflicts`: an operation stopped on unmerged paths — the conflicted files
 *   and their combined diff (with conflict markers), for a resolve review;
 * - `diff` / scope `staged`: the staged patch, for a commit review;
 * - `diff` / scope `working`: nothing staged but tracked changes or untracked
 *   files exist — the unstaged patch plus untracked names, for a
 *   stage-then-commit review;
 * - `clean`: nothing to review.
 *
 * Every patch goes through `filterSensitive` and is bounded by `DIFF_LIMIT`.
 * Untracked file *contents* are never read here.
 */

/** Maximum characters of patch text handed to the LLM. */
export const DIFF_LIMIT = 8000;

/** File names listed per payload before eliding the rest. */
export const REVIEW_FILE_LIMIT = 20;

const SECRET_KEY =
  /secret|token|password|passwd|api[_-]?key|private[_-]?key|auth[_-]?key|access[_-]?key|client[_-]?secret|credential|bearer/i;
const SECRET_VALUE =
  /-----BEGIN|eyJ[A-Za-z0-9_-]{20,}|\b[0-9a-f]{40,}\b|\b(?:sk|ghp|gho|ghs|github_pat|xox[abprs]|AKIA)[A-Za-z0-9_-]{8,}/;
/** Diff structure lines: never content, never redacted. */
const DIFF_HEADER =
  /^(?:diff |index |@@|--- (?:a\/|\/dev\/null)|\+\+\+ (?:b\/|\/dev\/null)|new file mode|deleted file mode|old mode|new mode|similarity index|rename from|rename to|Binary files)/;

/**
 * Redact diff body lines that look like they carry a secret. Added, removed
 * and context lines are all checked (a secret in unchanged context leaks just
 * the same); the 1–2 column diff prefix is kept so the hunk still reads.
 * @param {string} text
 * @returns {string}
 */
export function filterSensitive(text) {
  return text
    .split('\n')
    .map((line) => {
      if (DIFF_HEADER.test(line)) return line;
      if (!SECRET_KEY.test(line) && !SECRET_VALUE.test(line)) return line;
      const prefix = /^[ +-]{0,2}/.exec(line)[0];
      return `${prefix}[REDACTED — possible secret]`;
    })
    .join('\n');
}

/**
 * @param {string} text
 * @returns {{ patch: string, truncated: boolean }}
 */
function bound(text) {
  const filtered = filterSensitive(text);
  if (filtered.length <= DIFF_LIMIT) return { patch: filtered, truncated: false };
  return { patch: `${filtered.slice(0, DIFF_LIMIT)}\n… (truncated)`, truncated: true };
}

/**
 * @param {string[]} items
 * @returns {{ list: string[], more: number }}
 */
function listed(items) {
  return { list: items.slice(0, REVIEW_FILE_LIMIT), more: Math.max(0, items.length - REVIEW_FILE_LIMIT) };
}

/**
 * Build the review payload for one repository snapshot.
 * @param {any} status - snapshot from `readGitStatus` (non-null)
 * @param {(cwd: string, argv: string[], options: { signal?: AbortSignal }) => Promise<{ code: number, stdout: string, stderr: string }>} runGit
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<any>}
 */
export async function readReviewPayload(status, runGit, options = {}) {
  const run = (argv) => runGit(status.root, argv, { signal: options.signal });
  const text = (result) => (result.code === 0 ? result.stdout : '');

  const conflicts = status.counts.conflicts;
  const staged = status.counts.staged;
  const pendingWork = status.counts.unstaged + status.counts.untracked;
  if (conflicts === 0 && staged === 0 && pendingWork === 0) return { kind: 'clean' };

  const [nameResult, emailResult] = await Promise.all([
    run(['config', 'user.name']),
    run(['config', 'user.email']),
  ]);
  const value = (result) => {
    const trimmed = text(result).trim();
    return trimmed === '' ? null : trimmed;
  };
  const author = { name: value(nameResult), email: value(emailResult) };
  const branch = status.branch.detached ? null : status.branch.name;

  if (conflicts > 0) {
    const paths = (status.conflicts?.files ?? []).map((file) => file.path);
    const files = listed(paths);
    // Unmerged paths diff as a combined diff that keeps the conflict markers.
    const patchResult = files.list.length > 0
      ? await run(['diff', '--no-color', '--no-ext-diff', '-U3', '--', ...files.list])
      : { code: 0, stdout: '', stderr: '' };
    return {
      kind: 'conflicts',
      branch,
      operation: status.operation,
      conflictCount: conflicts,
      files: files.list,
      moreFiles: files.more,
      ...bound(text(patchResult)),
      author,
    };
  }

  if (staged > 0) {
    const [statResult, patchResult] = await Promise.all([
      run(['diff', '--cached', '--stat', '--no-color']),
      run(['diff', '--cached', '--no-color', '--no-ext-diff', '-U3']),
    ]);
    return {
      kind: 'diff',
      scope: 'staged',
      branch,
      stagedCount: staged,
      workingCount: status.counts.working,
      stat: text(statResult).trim(),
      ...bound(text(patchResult)),
      untracked: [],
      moreUntracked: 0,
      author,
    };
  }

  const [statResult, patchResult] = await Promise.all([
    run(['diff', '--stat', '--no-color']),
    run(['diff', '--no-color', '--no-ext-diff', '-U3']),
  ]);
  const untracked = listed(status.untracked?.files ?? []);
  return {
    kind: 'diff',
    scope: 'working',
    branch,
    stagedCount: 0,
    workingCount: status.counts.working,
    stat: text(statResult).trim(),
    ...bound(text(patchResult)),
    untracked: untracked.list,
    moreUntracked: untracked.more + Math.max(0, status.counts.untracked - (status.untracked?.files?.length ?? 0)),
    author,
  };
}
