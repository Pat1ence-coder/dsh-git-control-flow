/**
 * Registration body, parameterised over the Harness imports it needs
 * (`defineTool` and the Git transport). `index.js` injects the real ones;
 * tests inject fakes, so the whole surface — read, approval-gated writes,
 * projection and command — is covered without importing any Harness package.
 */
import {
  GIT_FLOW_COMMAND,
  GIT_FLOW_PARAMETERS,
  GIT_FLOW_TOOL,
} from './contract.mjs';
import { createGitFlowProjection } from './projection.mjs';
import { GIT_FLOW_KEY } from './state.mjs';
import { registerGitFlowRoute, registerGitFlowDiffRoute } from './route.mjs';
import { renderStatusText as defaultRenderStatusText, renderToolValue } from './render.mjs';
import {
  clipOutput,
  commitArgv,
  commitReason,
  normalizeMessage,
  normalizeBranch,
  normalizePaths,
  stageArgv,
  stageReason,
  mergeArgv,
  mergeReason,
  abortArgv,
  abortReason,
  continueArgv,
  resolveReason,
} from './write.mjs';

/**
 * @param {any} ctx - Cordis context (Host)
 * @param {{
 *   defineTool: (options: any) => any,
 *   readStatus: (directory: string, options: { signal?: AbortSignal }) => Promise<any>,
 *   readStatusLight?: (directory: string, options: { signal?: AbortSignal }) => Promise<any>,
 *   runGit: (cwd: string, argv: string[], options: { signal?: AbortSignal }) => Promise<{ code: number, stdout: string, stderr: string }>,
 *   discover?: (directory: string, options: { signal?: AbortSignal }) => Promise<any[]>,
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
    // Full read (with graph) for first load and missing projections.
    readStatus: deps.readStatus,
    // Light read (no `git log --all`) for 6s polling when graph is carried forward.
    readStatusLight: deps.readStatusLight,
    discover: deps.discover,
    projectionState: (agent) => ctx.sessionProjections.stateOf(agent.session, GIT_FLOW_KEY),
  };
  const diffRouteDeps = {
    getAgent: (sessionId) => ctx.agents.get(sessionId),
    directoryOf,
    readStatus: deps.readStatus,
    runGit: deps.runGit,
  };
  const registerRoute = (inner) => {
    const disposeStatus = inner.effect(() => registerGitFlowRoute(inner, routeDeps), 'git-control-flow: status route');
    const disposeDiff = inner.effect(() => registerGitFlowDiffRoute(inner, diffRouteDeps), 'git-control-flow: diff route');
    return () => { disposeStatus(); disposeDiff(); };
  };

  // `connection` is optional: the Web profile has it, headless profiles may not.
  if (typeof ctx.inject === 'function') ctx.inject(['connection'], registerRoute);
  else if (ctx.connection !== undefined) registerRoute(ctx);

  /**
   * Ask the configured approval answerer. Any failure — missing service,
   * thrown request, unexpected outcome — is treated as "not allowed".
   * @returns {Promise<string>} the outcome
   */
  const requestApproval = async ({ agent, callId, reason, signal }) => {
    const approval = ctx.approval;
    if (approval === undefined || typeof approval.request !== 'function') return 'unavailable';
    try {
      return await approval.request({ agent, toolName: GIT_FLOW_TOOL, callId, reason, signal });
    } catch {
      return 'unavailable';
    }
  };

  const branchLabel = (status) =>
    status.branch.detached ? 'a detached HEAD' : status.branch.name ?? 'an unknown branch';

  /** Reject, fail, or return the fresh snapshot after a write. */
  async function finishWrite(action, exec, root, argv, reason) {
    const outcome = await requestApproval({
      agent: exec.agent,
      callId: exec.callId,
      reason,
      signal: exec.signal,
    });
    if (outcome !== 'allowed-once') return { kind: 'rejected', action, outcome, reason };

    const result = await deps.runGit(root, argv, { signal: exec.signal });
    if (result.code !== 0) {
      return { kind: 'failed', action, message: clipOutput(result.stderr || result.stdout) };
    }
    const after = await deps.readStatus(directoryOf(exec.agent), { signal: exec.signal });
    return after ?? { kind: 'not-a-repository' };
  }

  async function stageAction(args, exec) {
    const before = await deps.readStatus(directoryOf(exec.agent), { signal: exec.signal });
    if (before === null) return { kind: 'not-a-repository' };

    const wantsAll = args?.all === true;
    let paths = null;
    if (!wantsAll) {
      const normalised = normalizePaths(args?.paths);
      if (!normalised.ok) throw new Error(normalised.reason);
      paths = normalised.paths;
    }
    if (wantsAll && Array.isArray(args?.paths) && args.paths.length > 0) {
      throw new Error('pass either "paths" or "all", not both');
    }

    const reason = stageReason({
      branch: branchLabel(before),
      paths,
      all: wantsAll,
      working: before.counts.working,
    });
    return finishWrite('stage', exec, before.root, stageArgv({ all: wantsAll, paths }), reason);
  }

  async function commitAction(args, exec) {
    const before = await deps.readStatus(directoryOf(exec.agent), { signal: exec.signal });
    if (before === null) return { kind: 'not-a-repository' };

    const message = normalizeMessage(args?.message);
    if (!message.ok) throw new Error(message.reason);
    if (before.staged.count === 0) return { kind: 'nothing-to-commit' };

    const reason = commitReason({
      branch: branchLabel(before),
      message: message.message,
      staged: before.staged.count,
    });
    return finishWrite('commit', exec, before.root, commitArgv(message.message), reason);
  }

  /** Maximum bytes of diff content sent to the LLM. */
  const DIFF_LIMIT = 8000;

  /**
   * Sensitive pattern filter: replace matching diff lines with a placeholder.
   * Covers common secret patterns — env keys, tokens, private keys, passwords.
   * @param {string} text
   * @returns {string}
   */
  function filterSensitive(text) {
    // Lines starting with + or - that contain common secret key names.
    const keyPattern = /^([+-][ \t]*)(\S[^\n]*?(?:secret|token|password|passwd|api[_-]?key|private[_-]?key|auth[_-]?key|access[_-]?key|client[_-]?secret|credential|bearer)[^\n]*)/gim;
    // Lines with PEM headers, JWT prefixes (eyJ...), or long hex strings.
    const valuePattern = /^([+-][^\n]*(?:-----BEGIN|eyJ[A-Za-z0-9+/]{20,}|[0-9a-f]{40,})[^\n]*)/gm;
    return text
      .replace(keyPattern, '$1[REDACTED — possible secret]')
      .replace(valuePattern, (line) => `${line.slice(0, 4)}[REDACTED]`);
  }

  async function diffAction(_args, exec) {
    const directory = directoryOf(exec.agent);
    const status = await deps.readStatus(directory, { signal: exec.signal });
    if (status === null) return { kind: 'not-a-repository' };
    if (status.staged.count === 0) return { kind: 'nothing-staged' };

    // Read git config for author info.
    const [diffResult, nameResult, emailResult] = await Promise.all([
      deps.runGit(status.root, ['diff', '--cached', '--stat', '--no-color'], { signal: exec.signal }),
      deps.runGit(status.root, ['config', 'user.name'], { signal: exec.signal }),
      deps.runGit(status.root, ['config', 'user.email'], { signal: exec.signal }),
    ]);

    // Full staged patch, bounded.
    const patchResult = await deps.runGit(
      status.root,
      ['diff', '--cached', '--no-color', '-U3'],
      { signal: exec.signal },
    );
    const rawPatch = patchResult.code === 0 ? patchResult.stdout : '';
    const filtered = filterSensitive(rawPatch);
    const truncated = filtered.length > DIFF_LIMIT;
    const patch = truncated ? filtered.slice(0, DIFF_LIMIT) + '\n… (truncated)' : filtered;

    return {
      kind: 'diff',
      branch: status.branch.name,
      stagedCount: status.staged.count,
      stat: diffResult.code === 0 ? diffResult.stdout.trim() : '',
      patch,
      truncated,
      author: {
        name: nameResult.code === 0 ? nameResult.stdout.trim() : null,
        email: emailResult.code === 0 ? emailResult.stdout.trim() : null,
      },
    };
  }

  async function mergeAction(args, exec) {
    const before = await deps.readStatus(directoryOf(exec.agent), { signal: exec.signal });
    if (before === null) return { kind: 'not-a-repository' };
    if (before.operation !== null) {
      return { kind: 'error', message: `cannot merge: a ${before.operation} is already in progress` };
    }

    const validated = normalizeBranch(args?.branch);
    if (!validated.ok) throw new Error(validated.reason);

    const reason = mergeReason({
      sourceBranch: validated.branch,
      targetBranch: branchLabel(before),
    });
    return finishWrite('merge', exec, before.root, mergeArgv(validated.branch), reason);
  }

  async function abortAction(args, exec) {
    const before = await deps.readStatus(directoryOf(exec.agent), { signal: exec.signal });
    if (before === null) return { kind: 'not-a-repository' };
    if (before.operation === null) return { kind: 'nothing-to-abort' };

    const reason = abortReason({ operation: before.operation, branch: branchLabel(before) });
    return finishWrite('abort', exec, before.root, abortArgv(before.operation), reason);
  }

  async function resolveAction(args, exec) {
    const before = await deps.readStatus(directoryOf(exec.agent), { signal: exec.signal });
    if (before === null) return { kind: 'not-a-repository' };
    if (before.operation === null) return { kind: 'nothing-to-resolve' };
    if (before.counts.conflicts === 0) return { kind: 'no-conflicts' };

    const normalised = normalizePaths(args?.paths);
    if (!normalised.ok) throw new Error(normalised.reason);

    const reason = resolveReason({
      operation: before.operation,
      branch: branchLabel(before),
      paths: normalised.paths,
    });

    // Stage the resolved files, then continue the in-progress operation.
    const stageOutcome = await requestApproval({
      agent: exec.agent,
      callId: exec.callId,
      reason,
      signal: exec.signal,
    });
    if (stageOutcome !== 'allowed-once') return { kind: 'rejected', action: 'resolve', outcome: stageOutcome, reason };

    const addResult = await deps.runGit(before.root, ['add', '--', ...normalised.paths], { signal: exec.signal });
    if (addResult.code !== 0) {
      return { kind: 'failed', action: 'resolve', message: clipOutput(addResult.stderr || addResult.stdout) };
    }

    const continueResult = await deps.runGit(before.root, continueArgv(before.operation), { signal: exec.signal });
    if (continueResult.code !== 0) {
      return { kind: 'failed', action: 'resolve', message: clipOutput(continueResult.stderr || continueResult.stdout) };
    }

    const after = await deps.readStatus(directoryOf(exec.agent), { signal: exec.signal });
    return after ?? { kind: 'not-a-repository' };
  }

  ctx.effect(
    () =>
      ctx.tools.register(
        deps.defineTool({
          name: GIT_FLOW_TOOL,
          description:
            'Read or change the Git state of the session working directory. "status" reads branch, upstream, counts, conflicts, diff size and recent commits. "stage" stages explicit paths or every change. "commit" commits staged changes with a message. "merge" merges a named branch into the current branch. "abort" aborts an in-progress merge/rebase/cherry-pick/revert. "resolve" stages resolved conflict files and continues the operation. Every write asks the user for approval first and never pushes.',
          parameters: GIT_FLOW_PARAMETERS,
          output: {
            schema: { type: 'json' },
            render(args, value) {
              return [{ type: 'text', text: renderToolValue(value) }];
            },
            presentationMeta(args, value) {
              return { gitFlow: value };
            },
          },
          async execute(args, exec) {
            const agent = exec.agent;
            if (agent === undefined) throw new Error('git_flow requires an agent context');
            const action = args?.action;

            if (action === 'status') {
              const directory = directoryOf(agent);
              const status = await deps.readStatus(directory, { signal: exec.signal });
              if (status !== null) return status;
              const repositories =
                typeof deps.discover === 'function'
                  ? await deps.discover(directory, { signal: exec.signal })
                  : [];
              return { kind: 'not-a-repository', repositories };
            }
            if (action === 'diff') return diffAction(args, exec);
            if (action === 'stage') return stageAction(args, exec);
            if (action === 'commit') return commitAction(args, exec);
            if (action === 'merge') return mergeAction(args, exec);
            if (action === 'abort') return abortAction(args, exec);
            if (action === 'resolve') return resolveAction(args, exec);
            throw new Error(`unsupported action: ${String(action)}`);
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
