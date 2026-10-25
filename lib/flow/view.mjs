/**
 * Host-computed card model.
 *
 * The Client renders; it does not derive. `wire.view` publishes exactly this
 * shape, so the browser half needs no folding, no phase logic and no sorting —
 * only labels, formatting and DOM.
 *
 * The model carries stable keys and dynamic values (branch names, subjects,
 * authors, epoch seconds); human wording stays in the Client locale.
 */
/** Commit rows rendered without scrolling. */
/** @typedef {{ presence: 'absent', revision: number, updatedAt: number | null } | {
 *   presence: 'repo', revision: number, updatedAt: number | null,
 *   branch: { name: string | null, detached: boolean, oid: string | null, upstream: string | null, ahead: number, behind: number },
 *   phase: string, operation: string | null, clean: boolean,
 *   counts: { staged: number, unstaged: number, untracked: number, conflicts: number, working: number },
 *   diffStat: { add: number, del: number },
 *   rows: Array<{ kind: 'working', id: string, files: number } | { kind: 'commit', id: string, subject: string, author: string, time: number }>,
 *   hiddenCommits: number, truncatedFiles: boolean,
 * }} GitFlowView */

export const MAX_CARD_COMMITS = 6;

const OPERATIONS = new Set(['merge', 'rebase', 'cherry-pick', 'revert']);
const PHASES = new Set(['clean', 'changes', 'conflicts', ...OPERATIONS]);

/**
 * @param {import('./state.mjs').GitFlowState} state
 * @returns {GitFlowView}
 */
export function buildGitFlowView(state) {
  if (state.presence !== 'repo' || state.status === null) {
    return { presence: state.presence === 'repo' ? 'absent' : state.presence, revision: state.revision, updatedAt: state.updatedAt };
  }

  const status = state.status;
  const commits = status.recentCommits.slice(0, MAX_CARD_COMMITS);

  const rows = [];
  if (!status.clean) rows.push({ kind: 'working', id: 'working', files: status.counts.working });
  for (const commit of commits) {
    rows.push({
      kind: 'commit',
      id: commit.short,
      subject: commit.subject,
      author: commit.author,
      time: commit.time,
    });
  }

  return {
    presence: 'repo',
    revision: state.revision,
    updatedAt: state.updatedAt,
    branch: {
      name: status.branch.name,
      detached: status.branch.detached,
      oid: status.branch.oid,
      upstream: status.branch.upstream,
      ahead: status.branch.ahead,
      behind: status.branch.behind,
    },
    phase: phaseOf(status),
    operation: status.operation,
    clean: status.clean,
    counts: {
      staged: status.counts.staged,
      unstaged: status.counts.unstaged,
      untracked: status.counts.untracked,
      conflicts: status.counts.conflicts,
      working: status.counts.working,
    },
    diffStat: { add: status.diffStat.add, del: status.diffStat.del },
    rows,
    hiddenCommits: Math.max(0, status.recentCommits.length - commits.length),
    truncatedFiles: status.truncated.files === true,
  };
}

/**
 * Which single state the card shows.
 * Conflicts win over an in-flight operation, which wins over plain changes.
 * @param {import('../git/status.mjs').GitStatusSnapshot} status
 * @returns {'clean' | 'changes' | 'conflicts' | 'merge' | 'rebase' | 'cherry-pick' | 'revert'}
 */
export function phaseOf(status) {
  if (status.counts.conflicts > 0) return 'conflicts';
  if (status.operation !== null && OPERATIONS.has(status.operation)) return status.operation;
  if (!status.clean) return 'changes';
  return 'clean';
}

/**
 * @param {unknown} value
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateGitFlowView(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'must be an object' };
  }
  const view = /** @type {Record<string, any>} */ (value);

  if (view.presence !== 'unknown' && view.presence !== 'absent' && view.presence !== 'repo') {
    return { ok: false, reason: 'presence must be "unknown", "absent" or "repo"' };
  }
  if (!Number.isInteger(view.revision) || view.revision < 0) {
    return { ok: false, reason: 'revision must be a non-negative integer' };
  }
  if (view.updatedAt !== null && typeof view.updatedAt !== 'number') {
    return { ok: false, reason: 'updatedAt must be a number or null' };
  }
  if (view.presence !== 'repo') return { ok: true };

  const branch = view.branch;
  if (branch === null || typeof branch !== 'object') return { ok: false, reason: 'branch must be an object' };
  if (branch.name !== null && typeof branch.name !== 'string') return { ok: false, reason: 'branch.name must be a string or null' };
  if (typeof branch.detached !== 'boolean') return { ok: false, reason: 'branch.detached must be a boolean' };
  if (branch.upstream !== null && typeof branch.upstream !== 'string') return { ok: false, reason: 'branch.upstream must be a string or null' };
  if (!Number.isInteger(branch.ahead) || branch.ahead < 0) return { ok: false, reason: 'branch.ahead must be a non-negative integer' };
  if (!Number.isInteger(branch.behind) || branch.behind < 0) return { ok: false, reason: 'branch.behind must be a non-negative integer' };

  if (typeof view.phase !== 'string' || !PHASES.has(view.phase)) return { ok: false, reason: 'phase is not a known phase' };
  if (view.operation !== null && !OPERATIONS.has(view.operation)) return { ok: false, reason: 'operation is not a known operation' };
  if (typeof view.clean !== 'boolean') return { ok: false, reason: 'clean must be a boolean' };

  const counts = view.counts;
  if (counts === null || typeof counts !== 'object') return { ok: false, reason: 'counts must be an object' };
  for (const key of ['staged', 'unstaged', 'untracked', 'conflicts', 'working']) {
    if (!Number.isInteger(counts[key]) || counts[key] < 0) {
      return { ok: false, reason: `counts.${key} must be a non-negative integer` };
    }
  }

  const diffStat = view.diffStat;
  if (diffStat === null || typeof diffStat !== 'object') return { ok: false, reason: 'diffStat must be an object' };
  if (typeof diffStat.add !== 'number' || typeof diffStat.del !== 'number') {
    return { ok: false, reason: 'diffStat numbers are required' };
  }

  if (!Array.isArray(view.rows)) return { ok: false, reason: 'rows must be an array' };
  for (const row of view.rows) {
    if (row === null || typeof row !== 'object') return { ok: false, reason: 'row must be an object' };
    if (row.kind === 'working') {
      if (!Number.isInteger(row.files) || row.files < 0) return { ok: false, reason: 'working row needs files' };
    } else if (row.kind === 'commit') {
      if (typeof row.id !== 'string' || typeof row.subject !== 'string') return { ok: false, reason: 'commit row needs id and subject' };
      if (typeof row.author !== 'string') return { ok: false, reason: 'commit row needs author' };
      if (typeof row.time !== 'number') return { ok: false, reason: 'commit row needs time' };
    } else {
      return { ok: false, reason: 'row.kind must be "working" or "commit"' };
    }
  }

  if (!Number.isInteger(view.hiddenCommits) || view.hiddenCommits < 0) {
    return { ok: false, reason: 'hiddenCommits must be a non-negative integer' };
  }
  if (typeof view.truncatedFiles !== 'boolean') return { ok: false, reason: 'truncatedFiles must be a boolean' };

  return { ok: true };
}
