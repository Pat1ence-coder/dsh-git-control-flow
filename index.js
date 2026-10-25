/**
 * Host half of `@local/dsh-git-control-flow`.
 *
 * Step 2b registers three things, all of them read-only:
 *  - the `gitFlow` session projection (the card's only data source);
 *  - the `git_flow` model tool (returns a whole-value status snapshot);
 *  - the `/git-flow` command (same reader, for the UI and for humans).
 *
 * The working directory always comes from the session, never from model
 * arguments, and no write command exists here yet.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

import { readGitStatus } from './lib/git/status.mjs';
import { registerGitFlow } from './lib/flow/register.mjs';

export const name = 'git-control-flow';

export const inject = ['commands', 'sessionProjections', 'tools', 'workingDirectory'];

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  registerGitFlow(ctx, { defineTool, readStatus: readGitStatus });
}
