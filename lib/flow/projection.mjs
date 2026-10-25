/**
 * The projection definition handed to `ctx.sessionProjections.register()`.
 *
 * `wire.view` returns the state object itself: state is already exactly the
 * client-visible shape, and an identity view keeps the registry's `Object.is`
 * comparison cheap and stable.
 */
import { defineSchema } from './schema.mjs';
import {
  GIT_FLOW_KEY,
  GIT_FLOW_STATE_VERSION,
  applyGitFlowEvent,
  initialGitFlowState,
  validateGitFlowState,
} from './state.mjs';

/**
 * @returns {{
 *   key: string,
 *   stateSchema: ReturnType<typeof defineSchema>,
 *   init: () => import('./state.mjs').GitFlowState,
 *   apply: typeof applyGitFlowEvent,
 *   wire: { viewSchema: ReturnType<typeof defineSchema>, view: (state: import('./state.mjs').GitFlowState) => import('./state.mjs').GitFlowState },
 *   stateVersion: number,
 * }}
 */
export function createGitFlowProjection() {
  return {
    key: GIT_FLOW_KEY,
    stateSchema: defineSchema('gitFlow state', validateGitFlowState),
    init: () => initialGitFlowState(),
    apply: applyGitFlowEvent,
    wire: {
      viewSchema: defineSchema('gitFlow view', validateGitFlowState),
      view: (state) => state,
    },
    stateVersion: GIT_FLOW_STATE_VERSION,
  };
}
