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
 * Clip noisy Git output before it reaches the model.
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
export function clipOutput(text, limit = 800) {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}
