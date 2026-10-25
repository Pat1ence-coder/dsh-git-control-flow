/**
 * Host half of `@local/dsh-git-control-flow`.
 *
 * Registers:
 *  - the `gitFlow` session projection (the card's data source);
 *  - the `git_flow` model tool: one read (`status`) and two approval-gated
 *    writes (`stage`, `commit`);
 *  - the `/git-flow` command (read-only, for humans);
 *  - a read-only status route for the Client card.
 *
 * The working directory always comes from the session, never from model
 * arguments. Writes ask the configured approval answerer first and never push.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

import { readGitStatus, readGitStatusLight } from './lib/git/status.mjs';
import { runGit } from './lib/git/exec.mjs';
import { discoverRepositories } from './lib/git/discover.mjs';
import { registerGitFlow } from './lib/flow/register.mjs';

export const name = 'git-control-flow';

export const inject = [
  'agents',
  'approval',
  'commands',
  'sessionProjections',
  'tools',
  'workingDirectory',
];

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  registerGitFlow(ctx, {
    defineTool,
    readStatus: readGitStatus,
    readStatusLight: readGitStatusLight,
    runGit,
    discover: (directory, options) => discoverRepositories(directory, { runGit, ...options }),
  });
}
