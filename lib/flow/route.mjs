/**
 * Read-only status route for the card.
 *
 * The card must reflect the repository as it is now, not only after the model
 * calls `git_flow`. This route lets the Client ask the Host for the current
 * card model on mount and on focus.
 *
 * Boundaries:
 * - the session is resolved from the Host's agent registry, never from a path
 *   in the query string;
 * - the working directory comes from `ctx.workingDirectory`, so the read stays
 *   inside the session's own directory;
 * - when `repo` is supplied it must be a relative path with no `..` traversal,
 *   and is joined to the session directory — nothing above it can be reached;
 * - a directory that is not a repository is only *scanned for immediate
 *   children* that are; nothing above the session directory is read;
 * - the response is the card model only: no file contents, no remote URLs and
 *   no credentials.
 */
import { join } from 'node:path';
import { readReviewPayload } from './review.mjs';
import { buildGitFlowView } from './view.mjs';

export const GIT_FLOW_ROUTE = '/api/git-flow.status';
export const GIT_FLOW_DIFF_ROUTE = '/api/git-flow.diff';

/**
 * Validate and resolve an optional `repo` query parameter.
 * Returns `{ ok: true, dir }` with the resolved directory, or
 * `{ ok: false, reason }` when the value is unsafe.
 * @param {string} base - session working directory
 * @param {string | null} repo - raw query param value, may be null
 * @returns {{ ok: true, dir: string } | { ok: false, reason: string }}
 */
function resolveSubDir(base, repo) {
  if (repo === null || repo === '') return { ok: true, dir: base };
  const trimmed = repo.trim();
  if (trimmed === '') return { ok: true, dir: base };
  if (trimmed.includes('\0')) return { ok: false, reason: 'repo must not contain NUL' };
  if (trimmed.startsWith('-')) return { ok: false, reason: 'repo must not start with "-"' };
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return { ok: false, reason: 'repo must be relative to the session working directory' };
  }
  if (trimmed.split(/[\\/]/).includes('..')) {
    return { ok: false, reason: 'repo must not escape the session working directory' };
  }
  return { ok: true, dir: join(base, trimmed) };
}

/**
 * @param {any} ctx - Host context carrying `connection`
 * @param {{
 *   getAgent: (sessionId: string) => any,
 *   directoryOf: (agent: any) => string,
 *   readStatus: (directory: string, options: { signal?: AbortSignal }) => Promise<any>,
 *   runGit: (cwd: string, argv: string[], options: { signal?: AbortSignal }) => Promise<{ code: number, stdout: string, stderr: string }>,
 * }} deps
 * @returns {() => void} disposer
 */
export function registerGitFlowDiffRoute(ctx, deps) {
  const register = ctx.connection?.fetch?.register;
  if (typeof register !== 'function') return () => {};

  return register.call(ctx.connection.fetch, {
    path: GIT_FLOW_DIFF_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url);
      const sessionId = url.searchParams.get('sessionId');
      if (sessionId === null || sessionId === '') {
        return jsonResponse({ error: 'missing sessionId' }, 400);
      }

      const agent = deps.getAgent(sessionId);
      if (agent === undefined || agent === null) {
        return jsonResponse({ error: 'unknown session' }, 404);
      }

      const directory = deps.directoryOf(agent);
      const repoParamDiff = url.searchParams.get('repo');
      const subDirDiff = resolveSubDir(directory, repoParamDiff);
      if (!subDirDiff.ok) return jsonResponse({ error: subDirDiff.reason }, 400);
      try {
        const status = await deps.readStatus(subDirDiff.dir, { signal: request.signal });
        if (status === null) return jsonResponse({ kind: 'not-a-repository' }, 200);
        return jsonResponse(await readReviewPayload(status, deps.runGit, { signal: request.signal }), 200);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    },
  });
}

/**
 * @param {any} ctx - Host context carrying `connection`
 * @param {{
 *   getAgent: (sessionId: string) => any,
 *   directoryOf: (agent: any) => string,
 *   readStatus: (directory: string, options: { signal?: AbortSignal }) => Promise<any>,
 *   discover?: (directory: string, options: { signal?: AbortSignal }) => Promise<any[]>,
 *   projectionState?: (agent: any) => any,
 * }} deps
 * @returns {() => void} disposer
 */
export function registerGitFlowRoute(ctx, deps) {
  const register = ctx.connection?.fetch?.register;
  if (typeof register !== 'function') return () => {};

  return register.call(ctx.connection.fetch, {
    path: GIT_FLOW_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url);
      const sessionId = url.searchParams.get('sessionId');
      if (sessionId === null || sessionId === '') {
        return jsonResponse({ error: 'missing sessionId' }, 400);
      }

      const agent = deps.getAgent(sessionId);
      if (agent === undefined || agent === null) {
        return jsonResponse({ error: 'unknown session' }, 404);
      }

      const directory = deps.directoryOf(agent);
      const repoParam = url.searchParams.get('repo');
      const subDir = resolveSubDir(directory, repoParam);
      if (!subDir.ok) return jsonResponse({ error: subDir.reason }, 400);
      const targetDir = subDir.dir;
      try {
        const projected = typeof deps.projectionState === 'function' ? deps.projectionState(agent) : undefined;
        const hasGraph = Array.isArray(projected?.status?.graph) && projected.status.graph.length > 0;
        // Use the light reader only when the projection already has a graph to
        // carry forward. On first load (no projection yet), fall back to the
        // full reader so refs and branch tags appear immediately.
        const readFn = (hasGraph && deps.readStatusLight) ? deps.readStatusLight : deps.readStatus;
        let status = await readFn(targetDir, { signal: request.signal });
        // A light read may discover a different repository or a new HEAD.
        // Never combine that snapshot with another repository's/HEAD's tree.
        const sameGraph = status !== null && hasGraph
          && status.root === projected.status.root
          && status.branch.oid === projected.status.branch.oid
          && status.branch.name === projected.status.branch.name;
        if (readFn === deps.readStatusLight && !sameGraph) {
          status = await deps.readStatus(targetDir, { signal: request.signal });
        }
        // Carry forward the last projection's graph so a light read does not
        // flatten the tree back to a straight line or lose branch refs.
        if (status !== null && sameGraph
            && (!Array.isArray(status.graph) || status.graph.length === 0)) {
          status.graph = projected.status.graph;
        }
        const view = buildGitFlowView({
          presence: status === null ? 'absent' : 'repo',
          status,
          revision: 0,
          updatedAt: Date.now(),
          pending: projected?.pending ?? null,
          completion: projected?.completion ?? null,
        });

        if (status === null && typeof deps.discover === 'function') {
          const repositories = await deps.discover(targetDir, { signal: request.signal });
          if (repositories.length > 0) {
            view.repositories = repositories.map((repo) => ({
              name: repo.name,
              branch: repo.branch,
              detached: repo.detached,
              changed: repo.changed,
              clean: repo.clean,
            }));
          }
        }

        return jsonResponse(view, 200);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    },
  });
}

/**
 * @param {unknown} body
 * @param {number} status
 * @returns {Response}
 */
function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
