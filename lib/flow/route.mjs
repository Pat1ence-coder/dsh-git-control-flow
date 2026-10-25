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
 * - the response is the card model only: no file contents, no remote URLs and
 *   no credentials.
 */
import { buildGitFlowView } from './view.mjs';

export const GIT_FLOW_ROUTE = '/api/git-flow.status';

/**
 * @param {any} ctx - Host context carrying `connection`
 * @param {{ getAgent: (sessionId: string) => any, directoryOf: (agent: any) => string, readStatus: (directory: string, options: { signal?: AbortSignal }) => Promise<any> }} deps
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

      try {
        const status = await deps.readStatus(deps.directoryOf(agent), { signal: request.signal });
        const view = buildGitFlowView({
          presence: status === null ? 'absent' : 'repo',
          status,
          revision: 0,
          updatedAt: Date.now(),
        });
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
