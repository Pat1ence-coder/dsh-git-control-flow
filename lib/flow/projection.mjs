/**
 * The projection definition handed to `ctx.sessionProjections.register()`.
 *
 * State is internal and validated as persisted JSON; the wire view is the
 * Host-computed card model (`buildGitFlowView`). The view is cached per state
 * object so the registry's `Object.is` comparison suppresses publication when
 * nothing the Client can see has changed.
 */
import { defineSchema } from './schema.mjs';
import {
  GIT_FLOW_KEY,
  GIT_FLOW_STATE_VERSION,
  applyGitFlowEvent,
  initialGitFlowState,
  validateGitFlowState,
} from './state.mjs';
import { buildGitFlowView, validateGitFlowView } from './view.mjs';

/** @returns {{ key: string, stateSchema: any, init: () => any, apply: any, wire: { viewSchema: any, view: (state: any) => any }, stateVersion: number }} */
export function createGitFlowProjection() {
  const views = new WeakMap();

  const view = (state) => {
    let cached = views.get(state);
    if (cached === undefined) {
      cached = buildGitFlowView(state);
      views.set(state, cached);
    }
    return cached;
  };

  return {
    key: GIT_FLOW_KEY,
    stateSchema: defineSchema('gitFlow state', validateGitFlowState),
    init: () => initialGitFlowState(),
    apply: applyGitFlowEvent,
    wire: {
      viewSchema: defineSchema('gitFlow view', validateGitFlowView),
      view,
    },
    stateVersion: GIT_FLOW_STATE_VERSION,
  };
}
