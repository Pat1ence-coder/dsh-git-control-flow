/**
 * Public names and parameter spec shared by the Host registration and tests.
 * Keeping them here (instead of inline in `index.js`) lets the offline tests
 * assert the surface without importing any Harness package.
 */

/** Wire/tool name the model calls. */
export const GIT_FLOW_TOOL = 'git_flow';

/** Slash command name, without the leading slash. */
export const GIT_FLOW_COMMAND = 'git-flow';

/** Actions this step supports: one read and two approval-gated writes. */
export const GIT_FLOW_ACTIONS = ['status', 'stage', 'commit'];

/** Projection key the Client reads from `projectionsBySession`. */
export const GIT_FLOW_KEY = 'gitFlow';

/** Value schema DSL for the tool parameters. */
export const GIT_FLOW_PARAMETERS = {
  action: {
    type: 'string',
    enum: GIT_FLOW_ACTIONS,
    required: true,
    description:
      'What to do. "status" reads the working tree, branch and recent commits; "stage" stages paths (or every change); "commit" commits the staged changes with the given message. "stage" and "commit" ask the user for approval first.',
  },
  paths: {
    type: 'array',
    items: { type: 'string' },
    description:
      'For "stage": repository-relative paths to stage. Rejects absolute paths, "..", and leading "-".',
  },
  all: {
    type: 'boolean',
    description: 'For "stage": stage every change instead of a path list.',
  },
  message: {
    type: 'string',
    description: 'For "commit": the commit message. Shown verbatim in the approval request.',
  },
};
