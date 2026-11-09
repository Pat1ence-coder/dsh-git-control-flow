/**
 * Host half of `@local/dsh-git-control-flow`.
 *
 * Registers:
 *  - the `gitFlow` session projection (the card's data source);
 *  - the `git_flow` model tool: reads (`status`, `diff`) and approval-gated
 *    writes (`stage`, `commit`, `merge`, `abort`, `resolve`);
 *  - the `/git-flow` command (read-only, for humans);
 *  - a read-only status route for the Client card.
 *
 * The working directory always comes from the session, never from model
 * arguments. Writes ask the configured approval answerer first and never push.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

import { readGitStatus, readGitStatusLight } from './lib/git/status.mjs';
import { createManagedGitRunner } from './lib/git/exec.mjs';
import { canonicalDirectory } from './lib/git/scope.mjs';
import { classifyRunnerFailure, isRunnerSpawnFailure, matchesSignature } from '@deepseek-ai/dsh-sandbox';
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
  'subprocess',
  'sandbox',
  'sandboxPolicy',
];

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const runGit = createManagedGitRunner(ctx, { classifyRunnerFailure, isRunnerSpawnFailure, matchesSignature });
  ctx.effect(() => () => runGit.dispose(), 'git-control-flow: execution lifetime');
  registerGitFlow(ctx, {
    defineTool,
    readStatus: (directory, options) => readGitStatus(directory, { ...options, runGit }),
    readStatusLight: (directory, options) => readGitStatusLight(directory, { ...options, runGit }),
    canonicalDirectory,
    prepareWrite: runGit.prepareWrite,
    runGit,
    discover: (directory, options) => discoverRepositories(directory, { ...options, runGit }),
  });
}
