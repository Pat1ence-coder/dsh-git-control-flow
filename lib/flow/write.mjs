/**
 * Write-side Git actions.
 *
 * Only the model reaches these, through the `git_flow` tool, and every action
 * runs after an explicit approval decision. Nothing here talks to the Client
 * and nothing here accepts a command line: arguments are assembled locally
 * from validated values.
 */

/** Longest commit message accepted from the model. */
export const MAX_MESSAGE_LENGTH = 2000;

/** Paths listed in one approval reason before eliding the rest. */
const REASON_PATH_LIMIT = 8;

/**
 * Validate model-supplied pathspecs.
 *
 * Rejected: empty values, absolute paths, parent traversal, anything starting
 * with `-` (would read as an option), and embedded NUL bytes.
 * @param {unknown} value
 * @returns {{ ok: true, paths: string[] } | { ok: false, reason: string }}
 */
export function normalizePaths(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, reason: 'paths must be a non-empty array' };
  }
  const paths = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return { ok: false, reason: 'every path must be a string' };
    const path = entry.trim();
    if (path === '') return { ok: false, reason: 'paths must not be empty' };
    if (path.includes('\0')) return { ok: false, reason: 'paths must not contain NUL' };
    if (path.startsWith('-')) return { ok: false, reason: `path must not start with "-": ${path}` };
    if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) {
      return { ok: false, reason: `path must be relative to the repository: ${path}` };
    }
    if (path.split(/[\\/]/).includes('..')) {
      return { ok: false, reason: `path must not escape the repository: ${path}` };
    }
    paths.push(path);
  }
  return { ok: true, paths };
}

/**
 * @param {unknown} value
 * @returns {{ ok: true, message: string } | { ok: false, reason: string }}
 */
export function normalizeMessage(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'message must be a string' };
  const message = value.trim();
  if (message === '') return { ok: false, reason: 'message must not be empty' };
  if (message.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, reason: `message must be at most ${MAX_MESSAGE_LENGTH} characters` };
  }
  if (message.includes('\0')) return { ok: false, reason: 'message must not contain NUL' };
  return { ok: true, message };
}

/**
 * Human-readable approval reason for a stage action.
 * @param {{ branch: string, paths?: string[], all?: boolean, working: number }} input
 * @returns {string}
 */
export function stageReason({ branch, paths, all, working }) {
  if (all === true) {
    return `Stage every change in ${branch} (${working} working file(s)).`;
  }
  const list = paths.slice(0, REASON_PATH_LIMIT).join(', ');
  const rest = paths.length > REASON_PATH_LIMIT ? `, … ${paths.length - REASON_PATH_LIMIT} more` : '';
  return `Stage ${paths.length} path(s) in ${branch}: ${list}${rest}`;
}

/**
 * Human-readable approval reason for a commit action; the message is shown in
 * full so the decision is made on the actual text.
 * @param {{ branch: string, message: string, staged: number }} input
 * @returns {string}
 */
export function commitReason({ branch, message, staged }) {
  return `Commit ${staged} staged file(s) on ${branch}.\n\nMessage:\n${message}`;
}

/**
 * Build the argv for a stage action.
 * @param {{ all?: boolean, paths?: string[] }} input
 * @returns {string[]}
 */
export function stageArgv({ all, paths }) {
  return all === true ? ['add', '--all'] : ['add', '--', ...paths];
}

/**
 * Build the argv for a commit action.
 * @param {string} message
 * @returns {string[]}
 */
export function commitArgv(message) {
  return ['commit', '-m', message];
}

/**
 * Validate a branch name supplied by the model.
 * Rejects empty, absolute-path-like, traversal, NUL, and leading "-".
 * @param {unknown} value
 * @returns {{ ok: true, branch: string } | { ok: false, reason: string }}
 */
export function normalizeBranch(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'branch must be a string' };
  const branch = value.trim();
  if (branch === '') return { ok: false, reason: 'branch must not be empty' };
  if (branch.includes('\0')) return { ok: false, reason: 'branch must not contain NUL' };
  if (branch.startsWith('-')) return { ok: false, reason: 'branch must not start with "-"' };
  if (branch.includes('..')) return { ok: false, reason: 'branch must not contain ".."' };
  return { ok: true, branch };
}

/**
 * Human-readable approval reason for a merge action.
 * @param {{ sourceBranch: string, targetBranch: string }} input
 * @returns {string}
 */
export function mergeReason({ sourceBranch, targetBranch }) {
  return `Merge branch "${sourceBranch}" into "${targetBranch}".`;
}

/**
 * Human-readable approval reason for an abort action.
 * @param {{ operation: string, branch: string }} input
 * @returns {string}
 */
export function abortReason({ operation, branch }) {
  return `Abort the in-progress ${operation} on ${branch}. All changes will be reset to before the operation started.`;
}

/**
 * Human-readable approval reason for a resolve action.
 * @param {{ operation: string, branch: string, paths: string[] }} input
 * @returns {string}
 */
export function resolveReason({ operation, branch, paths }) {
  const list = paths.slice(0, REASON_PATH_LIMIT).join(', ');
  const rest = paths.length > REASON_PATH_LIMIT ? `, … ${paths.length - REASON_PATH_LIMIT} more` : '';
  return `Mark ${paths.length} conflict file(s) as resolved and continue the ${operation} on ${branch}: ${list}${rest}`;
}

/**
 * Build the argv for a merge action.
 * @param {string} branch
 * @returns {string[]}
 */
export function mergeArgv(branch) {
  return ['merge', '--no-edit', '--', branch];
}

/**
 * Build the argv to abort an in-progress operation.
 * @param {string} operation
 * @returns {string[]}
 */
export function abortArgv(operation) {
  const op = operation === 'cherry-pick' ? 'cherry-pick' : operation;
  return [op, '--abort'];
}

/**
 * Build the argv to continue an in-progress operation after resolving conflicts.
 * @param {string} operation
 * @returns {string[]}
 */
export function continueArgv(operation) {
  const op = operation === 'cherry-pick' ? 'cherry-pick' : operation;
  return [op, '--continue', '--no-edit'];
}

/**
 * Clip noisy Git output before it reaches the model.
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
export function clipOutput(text, limit = 800) {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}
