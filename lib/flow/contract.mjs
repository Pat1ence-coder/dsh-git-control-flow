/**
 * Public names and parameter spec shared by the Host registration and tests.
 * Keeping them here (instead of inline in `index.js`) lets the offline tests
 * assert the surface without importing any Harness package.
 */

/** Wire/tool name the model calls. */
export const GIT_FLOW_TOOL = 'git_flow';

/** Slash command name, without the leading slash. */
export const GIT_FLOW_COMMAND = 'git-flow';

/** Actions this step supports: one read, one diff-read, and five approval-gated writes. */
export const GIT_FLOW_ACTIONS = ['status', 'diff', 'stage', 'commit', 'merge', 'abort', 'resolve'];

/** Projection key the Client reads from `projectionsBySession`. */
export const GIT_FLOW_KEY = 'gitFlow';

/** Value schema DSL for the tool parameters. */
export const GIT_FLOW_PARAMETERS = {
  action: {
    type: 'string',
    enum: GIT_FLOW_ACTIONS,
    required: true,
    description:
      'What to do. "status" reads the working tree, branch and recent commits; "diff" returns the staged diff for LLM review; "stage" stages paths (or every change); "commit" commits the staged changes with the given message; "merge" merges a branch into the current branch; "abort" aborts an in-progress merge/rebase/cherry-pick/revert; "resolve" stages resolved conflict files and continues the in-progress operation. All writes ask the user for approval first.',
  },
  paths: {
    type: 'array',
    items: { type: 'string' },
    description:
      'For "stage": repository-relative paths to stage. For "resolve": the conflict files that have been resolved. Rejects absolute paths, "..", and leading "-".',
  },
  all: {
    type: 'boolean',
    description: 'For "stage": stage every change instead of a path list.',
  },
  message: {
    type: 'string',
    description: 'For "commit": the commit message. Shown verbatim in the approval request.',
  },
  branch: {
    type: 'string',
    description: 'For "merge": the branch name to merge into the current branch.',
  },
  repo: {
    type: 'string',
    description:
      'Sub-repository name relative to the session working directory. Use when the session directory contains multiple repositories and you want to target a specific one (e.g. "alpha"). Must be a plain name or relative path — no absolute paths, "..", or leading "-".',
  },
};
