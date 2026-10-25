/**
 * Public names and parameter spec shared by the Host registration and tests.
 * Keeping them here (instead of inline in `index.js`) lets the offline tests
 * assert the surface without importing any Harness package.
 */

/** Wire/tool name the model calls. */
export const GIT_FLOW_TOOL = 'git_flow';

/** Slash command name, without the leading slash. */
export const GIT_FLOW_COMMAND = 'git-flow';

/** Actions this step supports. Mutations arrive in step 5. */
export const GIT_FLOW_ACTIONS = ['status'];

/** Projection key the Client reads from `projectionsBySession`. */
export const GIT_FLOW_KEY = 'gitFlow';

/** Value schema DSL for the tool parameters. */
export const GIT_FLOW_PARAMETERS = {
  action: {
    type: 'string',
    enum: GIT_FLOW_ACTIONS,
    required: true,
    description: 'What to read. "status" returns the working tree, branch and recent commits of the session working directory.',
  },
};
