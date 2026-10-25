/**
 * Registration body, parameterised over the one Harness import it needs
 * (`defineTool`). `index.js` injects the real DSL; tests inject a fake, so the
 * wiring — tool name/parameters, projection key, command behaviour — is
 * covered without importing any Harness package.
 */
import {
  GIT_FLOW_COMMAND,
  GIT_FLOW_PARAMETERS,
  GIT_FLOW_TOOL,
} from './contract.mjs';
import { createGitFlowProjection } from './projection.mjs';
import { registerGitFlowRoute } from './route.mjs';
import { renderStatusText as defaultRenderStatusText } from './render.mjs';

/**
 * @param {any} ctx - Cordis context (Host)
 * @param {{
 *   defineTool: (options: any) => any,
 *   readStatus: (directory: string, options: { signal?: AbortSignal }) => Promise<any>,
 *   renderStatusText?: (status: any) => string,
 * }} deps
 */
export function registerGitFlow(ctx, deps) {
  const renderStatusText = deps.renderStatusText ?? defaultRenderStatusText;
  const directoryOf = (agent) => ctx.workingDirectory.get(agent.session);

  ctx.effect(
    () => ctx.sessionProjections.register(createGitFlowProjection()),
    'git-control-flow: projection',
  );

  const routeDeps = {
    getAgent: (sessionId) => ctx.agents.get(sessionId),
    directoryOf,
    readStatus: deps.readStatus,
  };
  const registerRoute = (inner) =>
    inner.effect(() => registerGitFlowRoute(inner, routeDeps), 'git-control-flow: status route');

  // `connection` is optional: the Web profile has it, headless profiles may not.
  if (typeof ctx.inject === 'function') ctx.inject(['connection'], registerRoute);
  else if (ctx.connection !== undefined) registerRoute(ctx);

  ctx.effect(
    () =>
      ctx.tools.register(
        deps.defineTool({
          name: GIT_FLOW_TOOL,
          description:
            'Read the Git state of the session working directory: branch and upstream, ahead/behind, staged/unstaged/untracked counts, conflicts, diff size and recent commits. Read-only; it never changes the repository.',
          parameters: GIT_FLOW_PARAMETERS,
          output: {
            schema: { type: 'json' },
            render(args, value) {
              return [
                { type: 'text', text: renderStatusText(value?.kind === 'git-status' ? value : null) },
              ];
            },
            presentationMeta(args, value) {
              return { gitFlow: value };
            },
          },
          async execute(args, exec) {
            if (args?.action !== 'status') throw new Error(`unsupported action: ${String(args?.action)}`);
            const agent = exec.agent;
            if (agent === undefined) throw new Error('git_flow requires an agent context');
            const status = await deps.readStatus(directoryOf(agent), { signal: exec.signal });
            return status ?? { kind: 'not-a-repository' };
          },
        }),
      ),
    'git-control-flow: git_flow tool',
  );

  ctx.effect(
    () =>
      ctx.commands.register({
        name: GIT_FLOW_COMMAND,
        description: 'Read the Git state of the session working directory',
        async handler({ agent, rawInput, signal }) {
          const action = rawInput.trim() === '' ? 'status' : rawInput.trim();
          if (action !== 'status') return { kind: 'error', text: `unknown action: ${action}` };
          try {
            const status = await deps.readStatus(directoryOf(agent), { signal });
            return { kind: 'success', text: renderStatusText(status) };
          } catch (error) {
            return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
          }
        },
      }),
    'git-control-flow: /git-flow command',
  );
}
