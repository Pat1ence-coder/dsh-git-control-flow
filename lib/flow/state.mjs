/**
 * The `gitFlow` session-projection unit: state shape, pure fold, and the
 * client-visible view.
 *
 * The projection is the only channel the card reads. It is derived from the
 * session log alone — a `tool/result` carrying our `meta.gitFlow` payload —
 * so fork, resume and replay reconstruct the same card without any plugin
 * memory. State is plain JSON and is exactly what the client may see.
 */

/** Projection key; also the wire key the Client reads. */
export const GIT_FLOW_KEY = 'gitFlow';

/** Bump when the serialized state fields or the fold semantics change. */
export const GIT_FLOW_STATE_VERSION = 4;

/** Facts that invalidate a completion banner when the worktree changes again. */
export function gitFlowStatusKey(status) {
  return JSON.stringify([status.branch.oid, status.branch.name, status.operation,
    ...['working', 'staged', 'unstaged', 'untracked', 'conflicts'].map((key) => status.counts[key]),
    status.diffStat.add, status.diffStat.del]);
}

/** @typedef {'absent' | 'repo'} Presence */
/** @typedef {{ phase: 'awaiting-approval' | 'running', action: string | null, reason: string | null, approvalId?: string | null, callId?: string | null }} PendingWrite */
/** @typedef {{
 *   presence: Presence,
 *   status: import('../git/status.mjs').GitStatusSnapshot | null,
 *   revision: number,
 *   updatedAt: number | null,
 *   pending: PendingWrite | null,
 *   completion?: { id: string | null, action: string | null, outcome: string, repoRoot: string | null, operation: string | null, previousHead: string | null, head: string | null } | null,
 * }} GitFlowState */

/** @returns {GitFlowState} */
export function initialGitFlowState() {
  return { presence: 'unknown', status: null, revision: 0, updatedAt: null, pending: null, completion: null };
}

/**
 * Which write action an approval reason describes, when it is ours.
 * @param {unknown} reason
 * @returns {string | null}
 */
export function actionOfReason(reason) {
  if (typeof reason !== 'string') return null;
  if (/^Stage\b/.test(reason)) return 'stage';
  if (/^Commit\b/.test(reason)) return 'commit';
  if (/^Merge\b/.test(reason)) return 'merge';
  if (/^Abort\b/.test(reason)) return 'abort';
  if (/^Mark\b/.test(reason)) return 'resolve';
  return null;
}

/**
 * Fold one committed session event.
 *
 * A `tool/result` carrying this plugin's `meta.gitFlow` payload is the only
 * event that changes the repository state; the approval audit pair tracks an
 * in-flight write so the card can show "waiting for approval" / "running".
 * Every ignored event returns the same reference so the registry publishes
 * nothing.
 *
 * @param {GitFlowState} state
 * @param {{ type: string, time?: number, data?: any }} event
 * @returns {GitFlowState}
 */
export function applyGitFlowEvent(state, event) {
  if (event.type === 'approval/asked') {
    if (event.data?.toolName !== 'git_flow') return state;
    return {
      ...state,
      completion: null,
      pending: {
        approvalId: event.data?.id ?? null,
        callId: event.data?.callId ?? null,
        phase: 'awaiting-approval',
        action: actionOfReason(event.data?.reason),
        reason: typeof event.data?.reason === 'string' ? event.data.reason : null,
      },
    };
  }

  if (event.type === 'approval/decided') {
    if (state.pending === null) return state;
    if (state.pending.approvalId != null && event.data?.id !== state.pending.approvalId) return state;
    if (event.data?.outcome === 'allowed-once') {
      return { ...state, pending: { ...state.pending, phase: 'running' } };
    }
    return { ...state, pending: null };
  }

  // A stopped/failed turn can end without presentation metadata. Never replay
  // an unfinished spinner into the next turn (or a resumed session).
  if (event.type === 'turn/end') {
    return state.pending === null ? state : { ...state, pending: null };
  }

  if (event.type !== 'tool/result') return state;

  const flow = event.data?.meta?.gitFlow;
  const callId = event.data?.message?.source?.callId ?? event.data?.message?.toolCallId;
  const settled = state.pending !== null && (
    state.pending.callId != null
      ? callId === state.pending.callId
      : flow !== null && typeof flow === 'object' && typeof flow.kind === 'string'
  );
  // Completion ends the activity even if Git failed, the tool threw, or the
  // result is a no-op. Repository facts are updated separately below.
  if (settled) state = { ...state, pending: null, completion: {
    id: callId ?? state.pending.approvalId ?? null,
    action: state.pending.action,
    outcome: flow?.kind === 'git-status' ? 'succeeded' : flow?.kind ?? 'failed',
    repoRoot: state.status?.root ?? null,
    operation: state.status?.operation ?? null,
    previousHead: state.status?.branch?.oid ?? null,
    head: flow?.branch?.oid ?? null,
    statusKey: flow?.kind === 'git-status' ? gitFlowStatusKey(flow) : null,
  } };
  if (flow === null || typeof flow !== 'object' || typeof flow.kind !== 'string') return state;

  const updatedAt = typeof event.time === 'number' ? event.time : state.updatedAt;

  if (flow.kind === 'git-status') {
    return { presence: 'repo', status: flow, revision: state.revision + 1, updatedAt, pending: state.pending,
      completion: flow.write ?? state.completion ?? null };
  }

  if (flow.kind === 'not-a-repository') {
    if (state.presence === 'absent' && state.status === null && state.pending === null) return state;
    return { presence: 'absent', status: null, revision: state.revision + 1, updatedAt, pending: state.pending, completion: null };
  }

  return state;
}

const PRESENCE = new Set(['unknown', 'absent', 'repo']);

/**
 * @param {unknown} value
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateGitFlowState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'must be an object' };
  }
  const state = /** @type {Record<string, unknown>} */ (value);

  if (typeof state.presence !== 'string' || !PRESENCE.has(state.presence)) {
    return { ok: false, reason: 'presence must be "unknown", "absent" or "repo"' };
  }
  if (!Number.isInteger(state.revision) || state.revision < 0) {
    return { ok: false, reason: 'revision must be a non-negative integer' };
  }
  if (state.updatedAt !== null && typeof state.updatedAt !== 'number') {
    return { ok: false, reason: 'updatedAt must be a number or null' };
  }
  if (state.pending !== null) {
    const pending = validatePendingWrite(state.pending);
    if (!pending.ok) return pending;
  }
  if (state.completion != null) {
    if (typeof state.completion !== 'object' || Array.isArray(state.completion)) {
      return { ok: false, reason: 'completion must be an object or null' };
    }
    if (typeof state.completion.outcome !== 'string') return { ok: false, reason: 'completion.outcome must be a string' };
    for (const field of ['id', 'action', 'repoRoot', 'operation', 'previousHead', 'head', 'statusKey']) {
      if (state.completion[field] != null && typeof state.completion[field] !== 'string') {
        return { ok: false, reason: `completion.${field} must be a string or null` };
      }
    }
  }
  if (state.status !== null) {
    const status = validateStatusObject(state.status);
    if (!status.ok) return status;
    if (state.presence !== 'repo') return { ok: false, reason: 'presence must be "repo" when status is present' };
  } else if (state.presence !== 'absent' && state.presence !== 'unknown') {
    return { ok: false, reason: 'presence must be "unknown" or "absent" when status is null' };
  }

  return { ok: true };
}

const PENDING_PHASES = new Set(['awaiting-approval', 'running']);

/**
 * @param {unknown} value
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validatePendingWrite(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'pending must be an object or null' };
  }
  const pending = /** @type {Record<string, unknown>} */ (value);
  if (typeof pending.phase !== 'string' || !PENDING_PHASES.has(pending.phase)) {
    return { ok: false, reason: 'pending.phase must be "awaiting-approval" or "running"' };
  }
  if (pending.action !== null && typeof pending.action !== 'string') {
    return { ok: false, reason: 'pending.action must be a string or null' };
  }
  if (pending.reason !== null && typeof pending.reason !== 'string') {
    return { ok: false, reason: 'pending.reason must be a string or null' };
  }
  for (const key of ['approvalId', 'callId']) {
    if (pending[key] != null && typeof pending[key] !== 'string') {
      return { ok: false, reason: `pending.${key} must be a string or null` };
    }
  }
  return { ok: true };
}

/**
 * Structural validation of one snapshot. Deliberately shallow on nested
 * collections: the snapshot is produced by this plugin, and the values the
 * card depends on are checked explicitly.
 * @param {unknown} value
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateStatusObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'status must be an object' };
  }
  const status = /** @type {Record<string, any>} */ (value);

  if (status.kind !== 'git-status') return { ok: false, reason: 'status.kind must be "git-status"' };
  if (typeof status.root !== 'string' || status.root === '') return { ok: false, reason: 'status.root must be a path' };

  const branch = status.branch;
  if (branch === null || typeof branch !== 'object') return { ok: false, reason: 'status.branch must be an object' };
  if (branch.name !== null && typeof branch.name !== 'string') return { ok: false, reason: 'branch.name must be a string or null' };
  if (typeof branch.detached !== 'boolean') return { ok: false, reason: 'branch.detached must be a boolean' };
  if (branch.oid !== null && typeof branch.oid !== 'string') return { ok: false, reason: 'branch.oid must be a string or null' };
  if (branch.upstream !== null && typeof branch.upstream !== 'string') return { ok: false, reason: 'branch.upstream must be a string or null' };
  if (!Number.isInteger(branch.ahead) || branch.ahead < 0) return { ok: false, reason: 'branch.ahead must be a non-negative integer' };
  if (!Number.isInteger(branch.behind) || branch.behind < 0) return { ok: false, reason: 'branch.behind must be a non-negative integer' };

  const counts = status.counts;
  if (counts === null || typeof counts !== 'object') return { ok: false, reason: 'status.counts must be an object' };
  for (const key of ['staged', 'unstaged', 'untracked', 'conflicts', 'working']) {
    if (!Number.isInteger(counts[key]) || counts[key] < 0) {
      return { ok: false, reason: `counts.${key} must be a non-negative integer` };
    }
  }

  if (typeof status.clean !== 'boolean') return { ok: false, reason: 'status.clean must be a boolean' };
  if (!Array.isArray(status.recentCommits)) return { ok: false, reason: 'status.recentCommits must be an array' };
  if (!Array.isArray(status.conflicts?.files)) return { ok: false, reason: 'status.conflicts.files must be an array' };

  const diffStat = status.diffStat;
  if (diffStat === null || typeof diffStat !== 'object') return { ok: false, reason: 'status.diffStat must be an object' };
  if (typeof diffStat.add !== 'number' || typeof diffStat.del !== 'number') {
    return { ok: false, reason: 'diffStat.add and diffStat.del must be numbers' };
  }

  return { ok: true };
}
