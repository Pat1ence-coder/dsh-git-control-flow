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
 * - a directory that is not a repository is only *scanned for immediate
 *   children* that are; nothing above the session directory is read;
 * - the response is the card model only: no file contents, no remote URLs and
 *   no credentials.
 */
import { buildGitFlowView } from './view.mjs';

export const GIT_FLOW_ROUTE = '/api/git-flow.status';

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
      try {
        const projected = typeof deps.projectionState === 'function' ? deps.projectionState(agent) : undefined;
        const hasGraph = Array.isArray(projected?.status?.graph) && projected.status.graph.length > 0;
        // Use the light reader only when the projection already has a graph to
        // carry forward. On first load (no projection yet), fall back to the
        // full reader so refs and branch tags appear immediately.
        const readFn = (hasGraph && deps.readStatusLight) ? deps.readStatusLight : deps.readStatus;
        const status = await readFn(directory, { signal: request.signal });
        // Carry forward the last projection's graph so a light read does not
        // flatten the tree back to a straight line or lose branch refs.
        if (status !== null && hasGraph
            && (!Array.isArray(status.graph) || status.graph.length === 0)) {
          status.graph = projected.status.graph;
        }
        const view = buildGitFlowView({
          presence: status === null ? 'absent' : 'repo',
          status,
          revision: 0,
          updatedAt: Date.now(),
          pending: projected?.pending ?? null,
        });

        if (status === null && typeof deps.discover === 'function') {
          const repositories = await deps.discover(directory, { signal: request.signal });
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
