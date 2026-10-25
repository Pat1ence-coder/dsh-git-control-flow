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
import { validatePendingWrite } from './state.mjs';

/** Commit rows rendered without scrolling. */
/** @typedef {{ presence: 'absent', revision: number, updatedAt: number | null, pending?: { phase: string, action: string | null, reason: string | null } | null } | {
 *   presence: 'repo', revision: number, updatedAt: number | null,
 *   branch: { name: string | null, detached: boolean, oid: string | null, upstream: string | null, ahead: number, behind: number },
 *   phase: string, operation: string | null, clean: boolean,
 *   counts: { staged: number, unstaged: number, untracked: number, conflicts: number, working: number },
 *   diffStat: { add: number, del: number },
 *   rows: Array<{ kind: 'working', id: string, files: number } | { kind: 'commit', id: string, subject: string, author: string, time: number }>,
 *   hiddenCommits: number, truncatedFiles: boolean,
 *   pending: { phase: string, action: string | null, reason: string | null } | null,
 * }} GitFlowView */

export const MAX_CARD_COMMITS = 14;

/**
 * Edges between visible rows: header rows chain down to the first commit, and
 * every commit links to the row that owns one of its parents. The Client draws
 * straight into SVG paths, so no graph work happens there.
 * @param {any[]} rows
 * @returns {Array<{ from: number, to: number, fromLane: number, toLane: number }>}
 */
export function buildEdges(rows) {
  const position = new Map();
  rows.forEach((row, index) => {
    if (row.kind === 'commit' && typeof row.sha === 'string') position.set(row.sha, index);
  });

  const edges = [];
  rows.forEach((row, index) => {
    const lane = Number.isInteger(row.lane) ? row.lane : 0;
    if (row.kind !== 'commit') return;
    for (const sha of Array.isArray(row.parentShas) ? row.parentShas : []) {
      const to = position.get(sha);
      if (to === undefined) continue;
      edges.push({ from: index, to, fromLane: lane, toLane: Number.isInteger(rows[to].lane) ? rows[to].lane : 0 });
    }
  });

  // For any commit that still has no outgoing edge (parentShas absent or all
  // parents outside the window), draw an edge to the next commit on the same
  // lane so the rail always looks connected inside the visible window.
  const hasOutgoing = new Set(edges.map((e) => e.from));
  rows.forEach((row, index) => {
    if (row.kind !== 'commit' || hasOutgoing.has(index)) return;
    const lane = Number.isInteger(row.lane) ? row.lane : 0;
    // Find next row on the same lane.
    for (let j = index + 1; j < rows.length; j++) {
      if (rows[j].kind === 'commit') {
        const toLane = Number.isInteger(rows[j].lane) ? rows[j].lane : 0;
        edges.push({ from: index, to: j, fromLane: lane, toLane });
        break;
      }
    }
  });

  // A lane whose tip is above the window, or whose parent is below it, keeps
  // drawing to the edge so the graph reads as connected (from = -1 is the top).
  const laneRows = new Map();
  rows.forEach((row, index) => {
    if (row.kind !== 'commit') return;
    const lane = Number.isInteger(row.lane) ? row.lane : 0;
    if (!laneRows.has(lane)) laneRows.set(lane, []);
    laneRows.get(lane).push(index);
  });
  for (const [lane, list] of laneRows) {
    if (list[0] > 0) edges.push({ from: -1, to: list[0], fromLane: lane, toLane: lane });
    const last = list[list.length - 1];
    const leaves = edges.some((edge) => edge.from === last);
    if (!leaves && last < rows.length - 1) {
      edges.push({ from: last, to: rows.length, fromLane: lane, toLane: lane });
    }
  }

  return edges;
}
/** Conflict files listed with numbered badges. */
export const MAX_CONFLICT_ROWS = 6;

const OPERATIONS = new Set(['merge', 'rebase', 'cherry-pick', 'revert']);
const PHASES = new Set(['clean', 'changes', 'conflicts', 'ready', ...OPERATIONS]);

/**
 * @param {import('./state.mjs').GitFlowState} state
 * @returns {GitFlowView}
 */
export function buildGitFlowView(state) {
  const pending =
    state.pending === null || state.pending === undefined
      ? null
      : { phase: state.pending.phase, action: state.pending.action, reason: state.pending.reason };

  if (state.presence !== 'repo' || state.status === null) {
    return {
      presence: state.presence === 'repo' ? 'absent' : state.presence,
      revision: state.revision,
      updatedAt: state.updatedAt,
      pending,
    };
  }

  const status = state.status;
  // Older snapshots (and hand-built fixtures) only carry `recentCommits`; give
  // them a flat single-lane graph so the Client still draws a rail.
  const graph =
    Array.isArray(status.graph) && status.graph.length > 0
      ? status.graph
      : (Array.isArray(status.recentCommits) ? status.recentCommits : []).map((commit) => ({
          ...commit,
          refs: [],
          lane: 0,
          parents: [],
          before: [0],
          after: [0],
          columns: 1,
        }));
  const commits = graph.slice(0, MAX_CARD_COMMITS);

  const rows = [];
  if (status.operation !== null) {
    rows.push({
      kind: 'operation',
      id: `op:${status.operation}`,
      operation: status.operation,
      conflicts: status.counts.conflicts,
    });
  }
  if (!status.clean) rows.push({ kind: 'working', id: 'working', files: status.counts.working });
  for (const commit of commits) {
    rows.push({
      kind: 'commit',
      id: commit.short,
      sha: commit.sha,
      subject: commit.subject,
      author: commit.author,
      time: commit.time,
      refs: commit.refs,
      parentShas: commit.parentShas,
      lane: commit.lane,
      parents: commit.parents,
      before: commit.before,
      after: commit.after,
      columns: commit.columns,
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
    edges: buildEdges(rows),
    conflictRows: (Array.isArray(status.conflicts?.files) ? status.conflicts.files : [])
      .slice(0, MAX_CONFLICT_ROWS)
      .map((file, index) => ({
        id: `c:${index + 1}`,
        index: index + 1,
        path: file.path,
        code: file.code,
      })),
    hiddenCommits: Math.max(0, graph.length - commits.length),
    truncatedFiles: status.truncated.files === true,
    checks: [],
    pr: null,
    pending,
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
  if (view.pending !== undefined && view.pending !== null) {
    const pending = validatePendingWrite(view.pending);
    if (!pending.ok) return pending;
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
    } else if (row.kind === 'operation') {
      if (!OPERATIONS.has(row.operation)) return { ok: false, reason: 'operation row needs a known operation' };
      if (!Number.isInteger(row.conflicts) || row.conflicts < 0) {
        return { ok: false, reason: 'operation row needs a conflict count' };
      }
    } else if (row.kind === 'commit') {
      if (typeof row.id !== 'string' || typeof row.subject !== 'string') return { ok: false, reason: 'commit row needs id and subject' };
      if (typeof row.author !== 'string') return { ok: false, reason: 'commit row needs author' };
      if (typeof row.time !== 'number') return { ok: false, reason: 'commit row needs time' };
      if (!Number.isInteger(row.lane) || row.lane < 0) return { ok: false, reason: 'commit row needs a lane' };
    } else {
      return { ok: false, reason: 'row.kind must be "operation", "working" or "commit"' };
    }
  }

  if (view.edges !== undefined) {
    if (!Array.isArray(view.edges)) return { ok: false, reason: 'edges must be an array' };
    for (const edge of view.edges) {
      if (edge === null || typeof edge !== 'object') return { ok: false, reason: 'edge must be an object' };
      if (!Number.isInteger(edge.from) || edge.from < -1) return { ok: false, reason: 'edge.from must be an integer >= -1' };
      if (!Number.isInteger(edge.to) || edge.to < 0) return { ok: false, reason: 'edge.to must be a non-negative integer' };
      if (!Number.isInteger(edge.fromLane) || edge.fromLane < 0) return { ok: false, reason: 'edge.fromLane must be >= 0' };
      if (!Number.isInteger(edge.toLane) || edge.toLane < 0) return { ok: false, reason: 'edge.toLane must be >= 0' };
    }
  }

  if (view.conflictRows !== undefined) {
    if (!Array.isArray(view.conflictRows)) return { ok: false, reason: 'conflictRows must be an array' };
    for (const row of view.conflictRows) {
      if (row === null || typeof row !== 'object') return { ok: false, reason: 'conflict row must be an object' };
      if (!Number.isInteger(row.index) || row.index < 1) return { ok: false, reason: 'conflict row needs a 1-based index' };
      if (typeof row.path !== 'string') return { ok: false, reason: 'conflict row needs a path' };
    }
  }

  if (view.checks !== undefined) {
    if (!Array.isArray(view.checks)) return { ok: false, reason: 'checks must be an array' };
    for (const check of view.checks) {
      if (check === null || typeof check !== 'object') return { ok: false, reason: 'check must be an object' };
      if (typeof check.id !== 'string' || typeof check.label !== 'string') {
        return { ok: false, reason: 'check needs id and label' };
      }
    }
  }

  if (view.pr !== undefined && view.pr !== null) {
    if (typeof view.pr !== 'object') return { ok: false, reason: 'pr must be an object or null' };
    if (!Number.isInteger(view.pr.number)) return { ok: false, reason: 'pr.number must be an integer' };
    if (typeof view.pr.title !== 'string') return { ok: false, reason: 'pr.title must be a string' };
  }

  if (!Number.isInteger(view.hiddenCommits) || view.hiddenCommits < 0) {
    return { ok: false, reason: 'hiddenCommits must be a non-negative integer' };
  }
  if (typeof view.truncatedFiles !== 'boolean') return { ok: false, reason: 'truncatedFiles must be a boolean' };

  return { ok: true };
}
