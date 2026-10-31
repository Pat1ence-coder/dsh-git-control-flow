/**
 * Client half of `@local/dsh-git-control-flow`.
 *
 * Step 3: render the Host-computed card model. The Client does no folding,
 * no phase derivation and no sorting — it reads `gitFlow` from the session
 * projections and maps the model to DOM, labels and relative time only.
 *
 * Constraints honoured here:
 * - no Harness Client package is imported as a module (React comes from the
 *   browser module table);
 * - all visible text goes through `ctx.locale`;
 * - styles are registered in `apply` and removed with the client run;
 * - dock geometry mirrors the host's own dock strip so the card lines up with
 *   the composer in both themes.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-git-control-flow',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'gitControlFlow';
    const STYLE_ID = 'gcf-styles';
    const PROJECTION_KEY = 'gitFlow';
    const DIFF_ROUTE = 'api/git-flow.diff';
    const STATUS_ROUTE = 'api/git-flow.status';
    const POLL_MS = 6000;
    const MOTION = Object.freeze({ graph: 1200, enter: 1500, conflict: 1800, text: 900, width: 540 });
    /** How long a footer notice (e.g. "nothing to commit") stays visible. */
    const NOTICE_MS = 4000;

    /** Same-origin URL for the Host status route; the session id is the only input. */
    function statusUrl(sessionId, repo) {
      const base = `${STATUS_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`;
      return new URL(repo ? `${base}&repo=${encodeURIComponent(repo)}` : base, document.baseURI).toString();
    }

    function diffUrl(sessionId, repo) {
      const base = `${DIFF_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`;
      return new URL(repo ? `${base}&repo=${encodeURIComponent(repo)}` : base, document.baseURI).toString();
    }

    /**
     * Build the user-visible review request injected into the session. The
     * text depends on the payload: resolve conflicts, commit staged work, or
     * stage-then-commit working changes. `repo` names the sub-repository the
     * card is drilled into, so the model passes it back to `git_flow`.
     */
    function buildReviewMessage(payload, repo) {
      const lang = document.documentElement.lang || 'zh';
      const zh = lang.startsWith('zh');
      const lines = [];

      if (payload.kind === 'conflicts') {
        const op = payload.operation ?? 'merge';
        if (zh) {
          lines.push(`请帮我解决当前 ${op} 中的冲突。`);
          lines.push('');
          lines.push('操作步骤：');
          lines.push('1. 用 git_flow 的 status 动作查看当前仓库状态，确认冲突文件列表；');
          lines.push('2. 逐一读取冲突文件，找到 <<<<<<<、=======、>>>>>>> 标记，理解两侧意图；');
          lines.push('3. 有拿不准的地方先问我，不要猜；');
          lines.push('4. 直接编辑文件，去掉全部冲突标记，保留正确内容；');
          lines.push('5. 检查合并结果中没有敏感信息；');
          lines.push('6. 调用 git_flow 的 resolve 动作（会弹出审批）。');
        } else {
          lines.push(`Please help me resolve the conflicts in the current ${op}.`);
          lines.push('');
          lines.push('Steps:');
          lines.push('1. Call git_flow status to check the current state and confirm the conflicted files;');
          lines.push('2. Read each conflicted file and understand both sides (<<<<<<< / ======= / >>>>>>>);');
          lines.push('3. Ask me if anything is unclear — do not guess;');
          lines.push('4. Edit the files to resolve each conflict and remove all markers;');
          lines.push('5. Check that no sensitive information is exposed in the merged result;');
          lines.push('6. Call git_flow resolve (this asks for approval).');
        }
        lines.push('');
        lines.push(zh
          ? '要求：commit message 不得包含密钥、令牌、内部地址或个人信息；不要 push。'
          : 'Rules: no keys, tokens, internal addresses or personal information in the commit message; do not push.');
        if (payload.author && (payload.author.name === null || payload.author.email === null)) {
          lines.push(zh
            ? '⚠️ 注意：git config 中未配置 user.name 或 user.email，提交前请先询问我。'
            : '⚠️ Note: git config user.name or user.email is not set. Please ask me for these before committing.');
        }
        lines.push('');
        const branch = payload.branch ?? (zh ? '游离 HEAD' : 'detached HEAD');
        if (typeof repo === 'string' && repo !== '') {
          lines.push(zh
            ? `仓库：${repo}（调用 git_flow 时请传 repo: "${repo}"）`
            : `Repository: ${repo} (pass repo: "${repo}" to git_flow)`);
        }
        lines.push(zh
          ? `分支：${branch}，${payload.conflictCount} 个冲突文件`
          : `Branch: ${branch}, ${payload.conflictCount} conflicted file(s)`);
        return lines.join('\n');
      }

      // staged / working
      if (payload.scope === 'working') {
        lines.push(zh
          ? '请帮我 review 下面尚未暂存的改动和未跟踪文件，检查是否有敏感信息或风险。确认后用 git_flow 的 stage 暂存应该提交的文件（不该提交的请列出并说明原因），再生成合适的 commit message 并 commit。'
          : 'Please review the unstaged changes and untracked files below for sensitive information or risks. Then stage what should be committed with git_flow "stage" (list anything that should not be committed, and why), write an appropriate commit message and commit.');
      } else {
        lines.push(zh
          ? '请帮我 review 以下暂存的改动，检查是否有敏感信息或风险，然后生成合适的 commit message 并提交。'
          : 'Please review the following staged changes, check for any sensitive information or risks, then generate an appropriate commit message and commit.');
      }
      lines.push('');
      lines.push(zh
        ? '要求：commit message 不得包含密钥、令牌、内部地址或个人信息；不要 push。'
        : 'Rules: the commit message must not contain keys, tokens, internal addresses or personal information; do not push.');
      if (payload.author && (payload.author.name === null || payload.author.email === null)) {
        lines.push(zh
          ? '⚠️ 注意：git config 中未配置 user.name 或 user.email，提交前请先询问我。'
          : '⚠️ Note: git config user.name or user.email is not set. Please ask me for these before committing.');
      }
      lines.push('');
      if (typeof repo === 'string' && repo !== '') {
        lines.push(zh
          ? `仓库：${repo}（调用 git_flow 时请传 repo: "${repo}"）`
          : `Repository: ${repo} (pass repo: "${repo}" to git_flow)`);
      }
      const branch = payload.branch ?? (zh ? '游离 HEAD' : 'detached HEAD');
      if (payload.scope === 'working') {
        lines.push(zh
          ? `分支：${branch}，${payload.workingCount} 个文件有改动（尚未暂存）`
          : `Branch: ${branch}, ${payload.workingCount} changed file(s) (nothing staged yet)`);
        if (payload.stat) { lines.push('', '\`\`\`', payload.stat, '\`\`\`'); }
        if (payload.untracked.length > 0) {
          lines.push('', zh ? '**未跟踪文件：**' : '**Untracked files:**');
          const more = payload.moreUntracked > 0 ? [zh ? `… 另有 ${payload.moreUntracked} 个` : `… ${payload.moreUntracked} more`] : [];
          lines.push('\`\`\`'); lines.push([...payload.untracked, ...more].join('\n')); lines.push('\`\`\`');
        }
      } else {
        lines.push(zh
          ? `分支：${branch}，已暂存 ${payload.stagedCount} 个文件`
          : `Branch: ${branch}, ${payload.stagedCount} staged file(s)`);
        if (payload.stat) { lines.push('', '\`\`\`', payload.stat, '\`\`\`'); }
      }
      if (payload.patch) {
        lines.push('', zh ? '**改动内容（已过滤疑似敏感行）：**' : '**Diff (secret-looking lines redacted):**');
        lines.push('', '\`\`\`diff', payload.patch, '\`\`\`');
      }
      if (payload.truncated) {
        lines.push('', zh ? '_（diff 过大，已截断）_' : '_(diff truncated — too large)_');
      }
      return lines.join('\n');
    }

    const COLLAPSE_KEY = 'gcf:collapsed:';

    function readCollapsed(sessionId) {
      try {
        return window.localStorage.getItem(COLLAPSE_KEY + sessionId) === '1';
      } catch {
        return false;
      }
    }

    function writeCollapsed(sessionId, value) {
      try {
        window.localStorage.setItem(COLLAPSE_KEY + sessionId, value ? '1' : '0');
      } catch {
        /* private mode: the state is simply not remembered */
      }
    }

    /** Chevron toggle: points right when collapsed, down when expanded. */
    function Toggle({ collapsed, onToggle, t }) {
      if (typeof onToggle !== 'function') return null;
      const label = collapsed ? t('action.expand') : t('action.collapse');
      return h(
        'button',
        {
          type: 'button',
          className: 'gcf-toggle',
          'data-gcf': 'toggle',
          'aria-expanded': !collapsed,
          'aria-label': label,
          title: label,
          onClick: onToggle,
        },
        h(
          'svg',
          {
            width: 12,
            height: 12,
            viewBox: '0 0 12 12',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': true,
            focusable: false,
          },
          h('path', { d: 'M4.5 2.5L8 6l-3.5 3.5' }),
        ),
      );
    }

    /** Header: title (+ reserved PR number) and one state pill, as in the reference. */
    function CardHeader({ view, t, collapsed, onToggle, scrambleStatus, onBack, repoName }) {
      const pr = view.pr ?? null;
      const title = pr !== null && typeof pr.title === 'string' ? pr.title : branchText(view, t);
      const number = pr !== null && Number.isInteger(pr.number) ? `#${pr.number}` : null;
      const state = stateText(view, t);
      return h(
        'header',
        { className: `gcf-head${onBack ? ' has-back' : ''}` },
        onBack
          ? h(
              'button',
              {
                className: 'gcf-back-btn',
                type: 'button',
                onClick: onBack,
                title: t('nav.back'),
                'aria-label': t('nav.back'),
              },
              h(BackGlyph),
              repoName ? h('span', null, repoName) : null,
            )
          : null,
        h('span', { className: 'gcf-title', title }, title),
        number === null ? null : h('span', { className: 'gcf-prnum' }, number),
        h(
          'span',
          { className: `gcf-state is-${stateOf(view)}` },
          h('i', null),
          h(ChangeText, { text: state }),
        ),
        h(Toggle, { collapsed, onToggle, t }),
      );
    }

    /** Ring with a halo ripple (video 3.0s): SVG geometry, so it is always a circle. */
    function Spinner() {
      return h(
        'svg',
        {
          className: 'gcf-spinner',
          width: 14,
          height: 14,
          viewBox: '0 0 14 14',
          'aria-hidden': true,
          focusable: false,
        },
        h('circle', {
          className: 'gcf-spinner-halo',
          cx: 7,
          cy: 7,
          r: 4.2,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
        }),
        h('circle', {
          className: 'gcf-spinner-core',
          cx: 7,
          cy: 7,
          r: 4.2,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
        }),
      );
    }

    /** In-flight write: waiting for the approval dialog, or running after it was allowed. */
    function PendingLine({ pending, t }) {
      const [retained, setRetained] = React.useState(pending);
      React.useEffect(() => {
        if (pending) { setRetained(pending); return; }
        const timer = setTimeout(() => setRetained(null), 360);
        return () => clearTimeout(timer);
      }, [pending?.phase, pending?.reason]);
      const shown = pending ?? retained;
      return h('div', { className: `gcf-activity${pending ? ' is-visible' : ''}`, 'aria-hidden': !pending },
        h('div', null, shown ? h('div', { className: `gcf-pending is-${shown.phase}`, 'data-gcf': 'pending' },
          h(Spinner),
          h('span', { className: 'gcf-pending-label' }, h(ChangeText, { text: t(shown.phase === 'awaiting-approval' ? 'pending.awaiting' : 'pending.running') })),
          shown.reason ? h('span', { className: 'gcf-pending-reason', title: shown.reason }, shown.reason) : null,
        ) : null),
      );
    }

    /**
     * Composer takeover for a `git_flow` approval: the card itself carries the
     * decision, so it stays where the dock sits instead of the host replacing
     * the input area with its own panel.
     */
    function GitFlowApproval({ t, matched }) {
      const [view, setView] = React.useState(null);
      const sessionId = typeof matched?.sessionId === 'string' ? matched.sessionId : null;

      React.useEffect(() => {
        if (sessionId === null || typeof fetch !== 'function') return () => {};
        let cancelled = false;
        const load = async () => {
          try {
            const response = await fetch(statusUrl(sessionId), {
              headers: { accept: 'application/json' },
              cache: 'no-store',
            });
            if (!response.ok) return;
            const payload = await response.json();
            if (!cancelled) setView(payload);
          } catch {
            /* keep the last value */
          }
        };
        load();
        const timer = setInterval(load, 3000);
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, [sessionId]);

      const reason = typeof matched?.reason === 'string' ? matched.reason : '';
      const decide = (outcome) => {
        if (matched === null || matched === undefined) return;
        if (typeof matched.answer !== 'function' || matched.answerable === false) return;
        matched.answer(outcome);
      };

      const pending = view?.pending ?? { phase: 'awaiting-approval', action: null, reason: reason === '' ? null : reason };
      const approvalRows = view === null || view.presence !== 'repo' ? [] : [...(view.rows ?? [])];
      const approvalHeight = approvalRows.length * ROW_HEIGHT;

      return h(
        'div',
        { className: 'gcf-approval', 'data-gcf': 'approval' },
        h(
          'section',
          {
            className: 'gcf-card is-approval',
            'data-gcf': 'card',
            'data-phase': 'approval',
            'aria-label': t('app.title'),
          },
          view !== null && view.presence === 'repo'
            ? h(CardHeader, { view, t, collapsed: false, scrambleStatus: false })
            : h(
                'header',
                { className: 'gcf-head' },
                h('span', { className: 'gcf-glyph' }, h(BranchGlyph)),
                h('span', { className: 'gcf-title' }, t('app.title')),
              ),
          h(PendingLine, { pending, t }),
          reason !== '' ? h(
            'div',
            { className: 'gcf-approval-reason' },
            // Show only the first 2 lines of the reason — the full text is the
            // review message which can be very long.
            reason.split('\n').slice(0, 2).join('\n').slice(0, 200) + (reason.length > 200 ? '…' : ''),
          ) : null,
          view !== null && approvalRows.length > 0
            ? h(
                'div',
                { className: 'gcf-graph', style: { height: `${approvalHeight}px` } },
                h(GraphRail, { rows: approvalRows, edges: view.edges ?? [] }),
                h(
                  'div',
                  { className: 'gcf-rows', 'data-gcf': 'rows' },
                  approvalRows.map((row, index) =>
                    h(Row, { key: row.id, row, t, now: Date.now(), index, total: approvalRows.length }),
                  ),
                ),
              )
            : null,
          h(
            'div',
            { className: 'gcf-approval-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'gcf-approval-button is-reject',
                'data-gcf': 'reject',
                onClick: () => decide('rejected'),
              },
              t('approval.reject'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'gcf-approval-button is-allow',
                'data-gcf': 'allow',
                onClick: () => decide('allowed-once'),
              },
              t('approval.allow'),
            ),
          ),
        ),
      );
    }

    const CSS = `
.gcf-dock {
  /* Node palette: git-control-dev @ origin/feat/thread-ui-replica, media/thread.css.
     Light values are the replica's; the dark block below overrides them. */
  --gcf-node: #4a7fdc;
  --gcf-node-ring: #4a7fdc24;
  --gcf-node-warn: #dca329;
  --gcf-node-warn-ring: #dca3291f;
  --gcf-rail: #c6d6f2;
  box-sizing: border-box;
  width: calc(100% - var(--dsh-composer-side-clearance, 0px) - var(--dsh-composer-side-clearance, 0px) - var(--dsh-composer-dock-inset, 0px) - var(--dsh-composer-dock-inset, 0px) - var(--dsh-composer-dock-inset, 0px) - var(--dsh-composer-dock-inset, 0px));
  margin: 0 auto;
  max-width: calc(var(--dsh-composer-card-max-width, 760px) - 4 * var(--dsh-composer-dock-inset, 0px));
}
.gcf-bar,
.gcf-card {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
  border-radius: var(--dsw-radius-md, 10px);
  background: var(--dsw-alias-bg-layer-1, #fff);
  box-shadow: var(--dsw-elevation-panel, 0 1px 2px rgba(16, 24, 40, 0.05));
  color: var(--dsw-alias-label-primary, #1d1d1f);
}
.gcf-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 4px 6px 4px 12px;
}
.gcf-card { padding: 10px 0 0; overflow: hidden; }
/* RepositoryList collapses the body under a fixed header. */
.gcf-body {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 540ms cubic-bezier(0.4, 0, 0.2, 1);
}
.gcf-body.is-open { grid-template-rows: 1fr; }
.gcf-body-inner {
  min-height: 0;
  overflow: hidden;
  opacity: 0;
  transition: opacity 200ms cubic-bezier(0.4, 0, 0.2, 1) 0ms;
}
.gcf-body.is-open .gcf-body-inner {
  max-height: 42vh;
  overflow-y: auto;
  overscroll-behavior: contain;
  opacity: 1;
  transition: opacity 220ms cubic-bezier(0.4, 0, 0.2, 1) 100ms;
}
/* GitFlowView collapses the entire card (header + body) down to the chips. */
.gcf-card-wrap {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 540ms cubic-bezier(0.4, 0, 0.2, 1);
}
.gcf-card-wrap.is-open { grid-template-rows: 1fr; }
.gcf-card-wrap > * { min-height: 0; overflow: hidden; }
.gcf-reveal { }
.gcf-reveal-inner { overflow: hidden; }
.gcf-reveal .gcf-card { animation: gcf-card-grow 1050ms cubic-bezier(.25, .1, .25, 1) both; }
@keyframes gcf-card-grow {
  from { opacity: 0; transform: translateY(8px) scale(0.985); }
  to   { opacity: 1; transform: none; }
}
.gcf-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
  padding: 0 14px 8px;
}
.gcf-glyph {
  flex: none;
  display: inline-flex;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
}
.gcf-title {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 13px;
  font-weight: 500;
  line-height: 22px;
  color: var(--dsw-alias-label-primary, #1d1d1f);
}
.gcf-tracking {
  flex: none;
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  font-size: 11px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.gcf-tracking .gcf-upstream {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gcf-ahead { color: var(--dsw-alias-file-diff-added-marker, #1f9a63); }
.gcf-behind { color: var(--dsw-alias-file-diff-deleted-marker, #c3514a); }
.gcf-status {
  transition: color 300ms ease;
  flex: none;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, #5f5f5f);
  white-space: nowrap;
}
.gcf-status i {
  transition: background-color 300ms ease;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.gcf-card.is-conflict .gcf-status { color: var(--dsw-alias-state-error-primary, #c0394b); }
.gcf-card.is-clean .gcf-status { color: var(--dsw-alias-state-success-primary, #2e8f55); }
.gcf-pending {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 0 14px 8px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-warn-primary, #d89614);
}
.gcf-pending.is-running { color: var(--dsw-alias-label-secondary, #5f5f5f); }
.gcf-pending-label { flex: none; font-weight: 500; }
.gcf-pending-reason {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
}
.gcf-spinner {
  flex: none;
  display: block;
  overflow: visible;
  color: inherit;
}
.gcf-row--working .gcf-spinner { color: var(--gcf-node, #4a7fdc); }
.gcf-spinner-core {
  transform-origin: 7px 7px;
  animation: gcf-breathe 1.8s ease-in-out infinite;
}
.gcf-spinner-halo {
  transform-origin: 7px 7px;
  animation: gcf-ripple 1.8s ease-out infinite;
}
@keyframes gcf-breathe {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}
@keyframes gcf-ripple {
  0% { transform: scale(1); opacity: 0.55; }
  70%, 100% { transform: scale(1.15); opacity: 0; }
}
/* Kept mounted: the parent rotates while activity controls opacity. */
.gcf-node-arc {
  stroke: var(--c, #4a7fdc);
  stroke-width: 1.5;
  fill: none;
  stroke-linecap: round;
}
.gcf-graph { position: relative; overflow: visible; }
.gcf-graph > .gcf-rows {
  position: absolute;
  inset: 0;
}
.gcf-rows {
  max-height: none;
  overflow: visible;
  overscroll-behavior: contain;
  padding: 2px 6px 6px;
}
.gcf-row {
  position: relative;
  isolation: isolate;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  min-height: 30px;
  padding: 0 8px 0 61px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary, #1d1d1f);
}
.gcf-graph > .gcf-rows > .gcf-row {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  /* The rail owns the first 61px; keep the text column clear of the nodes. */
  padding: 0 8px 0 61px;
  transform: translateY(var(--y, 0));
  transition: none;
}
/* Hover paint starts after the rail column so it never hides a node. */
.gcf-row::before {
  content: '';
  position: absolute;
  z-index: -1;
  inset: 2px 6px 2px 52px;
  border-radius: 6px;
  background: transparent;
  pointer-events: none;
}
.gcf-row:hover::before { background: var(--soft, #f5f5f5); }
.gcf-rail { position: absolute; left: 0; top: 0; display: block; overflow: visible; }
.gcf-edge {
  fill: none;
  stroke-width: 1.5;
  stroke: var(--base-line, #dedede);
  stroke-dasharray: 1;
  stroke-dashoffset: 0;
  transition: stroke 500ms ease;
}
/* Continuation lines (from top / to bottom of window): faded via SVG gradient. */
.gcf-edge.is-continuation {
  stroke-dasharray: none;
  stroke-dashoffset: 0;
  animation: none;
}
.gcf-edge.t-ours { stroke: var(--blue-line, #93b4ee); }
.gcf-edge.t-other { stroke: var(--teal-line, #5ecfb5); }
.gcf-edge.t-merged { stroke: var(--merged-line, #cfbdf8); }
.gcf-edge.t-warn { stroke: var(--warn-line, #ecc68a); }
.gcf-edge.t-ok { stroke: var(--ok-line, #a8e0c0); }
.gcf-node { --c: var(--base, #bdbdbd); }
.gcf-node.t-ours { --c: var(--blue, #4a7fdc); }
.gcf-node.t-other { --c: var(--teal, #22c4a0); }
.gcf-node.t-merged { --c: var(--merged, #8b5cf6); }
.gcf-node.t-warn { --c: var(--warn, #e3a21a); }
.gcf-node.t-ok { --c: var(--ok, #2fb46c); }
.gcf-n-dot { fill: var(--c); }
.gcf-rail-wait {
  flex: none;
  overflow: visible;
  width: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-right: 2px;
}
.gcf-pills {
  display: inline-flex;
  gap: 6px;
  margin-left: 8px;
  vertical-align: baseline;
}
.gcf-pill {
  font: 11px/16px var(--dsh-mono-font, "SFMono-Regular", Menlo, Consolas, monospace);
  padding: 0 6px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2, #f2f2f2);
  color: var(--dsw-alias-label-secondary, #5f5f5f);
  white-space: nowrap;
}
.gcf-pill.is-head { background: #efe8ff; color: #7c5cd6; }
.gcf-pill.is-branch { background: #f2f2f2; color: #5f5f5f; }
.gcf-pill.is-remote { background: #e6f4f1; color: #2f9e8f; }
.gcf-pill.is-tag { background: #fdf3e2; color: #b07a2a; }
.gcf-swap {
  animation: gcf-decode 900ms cubic-bezier(.25, .1, .25, 1) both;
}
@keyframes gcf-decode {
  from { opacity: 0.35; filter: blur(6px); }
  to { opacity: 1; filter: none; }
}
.gcf-checks {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 2px 14px 10px;
}
.gcf-check {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
  border-radius: 999px;
  font-size: 12px;
  line-height: 22px;
  color: var(--dsw-alias-state-success-primary, #2e8f55);
  background: var(--dsw-alias-bg-layer-1, #fff);
}
.gcf-check.is-failed { color: var(--dsw-alias-state-error-primary, #c0394b); }
.gcf-check.is-pending { color: var(--dsw-alias-label-tertiary, #8a8a8a); }
.gcf-check-label { white-space: nowrap; }
@keyframes gcf-row-in {
  from { opacity: 0; translate: 0 4px; }
  to { opacity: 1; translate: 0 0; }
}
.gcf-dot {
  position: absolute;
  left: 14px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--gcf-node, #4a7fdc);
  box-shadow:
    0 0 0 2px var(--dsw-alias-bg-layer-1, #fff),
    0 0 0 3px var(--gcf-node-ring, #4a7fdc24);
}
.gcf-dot--hollow {
  background: var(--dsw-alias-bg-layer-1, #fff);
  border: 1.5px solid var(--gcf-node-warn, #dca329);
  box-shadow:
    0 0 0 2px var(--dsw-alias-bg-layer-1, #fff),
    0 0 0 3px var(--gcf-node-warn-ring, #dca3291f);
  box-sizing: border-box;
}
.gcf-card.is-conflict .gcf-row--working .gcf-dot { border-color: var(--gcf-node-warn, #dca329); }
.gcf-subject {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.gcf-row--operation { color: var(--dsw-alias-state-warn-primary, #b07a2a); }
.gcf-op-icon { flex: none; display: inline-flex; margin-left: 4px; }
.gcf-meta.is-warn { color: var(--dsw-alias-state-warn-primary, #b07a2a); }
.gcf-row--conflict { background: var(--dsw-alias-state-warn-tertiary, #fdf3e2); }
.gcf-row--conflict .gcf-subject { color: var(--dsw-alias-state-warn-primary, #8a5a15); }
.gcf-badge {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-left: 4px;
  border-radius: 50%;
  background: var(--dsw-alias-state-warn-primary, #d89614);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
}
.gcf-action.is-warn {
  border-color: var(--dsw-alias-state-warn-secondary, #e5c37a);
  color: var(--dsw-alias-state-warn-primary, #b07a2a);
}
.gcf-meta {
  flex: none;
  margin-left: auto;
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  font-size: 11px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
  font-variant-numeric: tabular-nums;
}
.gcf-meta code {
  font: 10px/1.5 var(--dsh-mono-font, "SFMono-Regular", Menlo, Consolas, monospace);
  color: var(--dsw-alias-label-tertiary, #a6a6a6);
}
.gcf-prnum {
  flex: none;
  font: 12px/18px var(--dsh-mono-font, "SFMono-Regular", Menlo, Consolas, monospace);
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
}
.gcf-state {
  flex: none;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, #5f5f5f);
}
.gcf-state i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.gcf-state.is-clean { color: var(--dsw-alias-state-success-primary, #2e8f55); }
.gcf-state.is-changes { color: var(--dsw-alias-state-warn-primary, #d89614); }
.gcf-state.is-conflicts { color: var(--dsw-alias-state-error-primary, #c0394b); }
.gcf-state.is-merged, .gcf-state.is-ready { color: #7c5cd6; }
.gcf-chips {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 4px 0;
}
.gcf-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-secondary, #5f5f5f);
  font-size: 12px;
  line-height: 24px;
  white-space: nowrap;
}
.gcf-chip.is-clean { color: var(--dsw-alias-state-success-primary, #2e8f55); }
.gcf-chip.is-changes { color: var(--dsw-alias-state-warn-primary, #d89614); }
.gcf-chip.is-conflicts { color: var(--dsw-alias-state-error-primary, #c0394b); }
.gcf-chip.is-merged, .gcf-chip.is-ready { color: #7c5cd6; }
.gcf-chip i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.gcf-chip--diff b { font-weight: 500; color: var(--dsw-alias-file-diff-added-marker, #1f9a63); }
.gcf-chip--diff em { font-style: normal; color: var(--dsw-alias-file-diff-deleted-marker, #c3514a); }
.gcf-chip--tracking .gcf-ahead { color: var(--dsw-alias-state-success-primary, #2e8f55); }
.gcf-chip--tracking .gcf-behind { color: var(--dsw-alias-state-error-primary, #c0394b); }
.gcf-heat { display: inline-flex; gap: 2px; }
.gcf-heat i { width: 5px; height: 5px; border-radius: 1px; }
.gcf-heat i.is-add { background: var(--dsw-alias-file-diff-added-marker, #3fae74); }
.gcf-heat i.is-del { background: var(--dsw-alias-file-diff-deleted-marker, #dd6b62); }
.gcf-chip--toggle {
  cursor: pointer;
  font: inherit;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
}
.gcf-chip--toggle:hover { background: var(--dsw-alias-interactive-bg-hover, #f2f2f2); }
.gcf-foot-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
}
.gcf-foot-state i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.gcf-foot-state.is-conflicts { color: var(--dsw-alias-state-error-primary, #c0394b); }
.gcf-foot-state.is-clean { color: var(--dsw-alias-state-success-primary, #2e8f55); }
.gcf-foot-note {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--dsw-alias-label-secondary, #5e5e5e);
  animation: gcf-row-in 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.gcf-card[data-gcf='repositories'] .gcf-rows { padding: 2px 6px 6px; }
.gcf-repo-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 28px;
  padding: 0 14px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary, #1d1d1f);
  animation: gcf-row-in 300ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
  animation-delay: calc(var(--rev, 0) * 45ms + 120ms);
}
.gcf-repo-row:hover { background: var(--dsw-alias-bg-layer-2, #f6f6f6); }
.gcf-repo-row[role='button'] { cursor: pointer; }
.gcf-repo-row[role='button']:focus-visible { outline: 2px solid var(--dsw-alias-state-focus-primary, #0071e3); outline-offset: -2px; }
.gcf-repo-row[role='button']:active { background: var(--dsw-alias-bg-layer-3, #ebebeb); }
.gcf-back-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
  flex: none;
}
.gcf-back-btn:hover { color: var(--dsw-alias-label-primary, #1d1d1f); }
.gcf-back-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-focus-primary, #0071e3); border-radius: 3px; }
.gcf-back-btn svg { width: 12px; height: 12px; }
.gcf-head.has-back { gap: 6px; }
.gcf-repo-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-weight: 500;
}
.gcf-repo-branch {
  flex: none;
  max-width: 180px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font: 11px/1.5 var(--dsh-mono-font, "SFMono-Regular", Menlo, Consolas, monospace);
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
}
.gcf-repo-state {
  flex: none;
  min-width: 56px;
  text-align: right;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
}
.gcf-repo-state.is-dirty { color: var(--gcf-node-warn, #dca329); }
.gcf-more {
  padding: 0 14px 8px;
  font-size: 11px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
}
.gcf-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 40px;
  padding: 6px 10px 6px 14px;
  border-top: 1px solid var(--dsw-alias-border-l1, #ececec);
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
}
.gcf-diff {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  font-variant-numeric: tabular-nums;
}
.gcf-diff b { font-weight: 500; color: var(--dsw-alias-file-diff-added-marker, #1f9a63); }
.gcf-diff em { font-style: normal; color: var(--dsw-alias-file-diff-deleted-marker, #c3514a); }
.gcf-counts {
  display: inline-flex;
  gap: 10px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.gcf-toggle {
  flex: none;
  width: 22px;
  height: 22px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
  cursor: pointer;
}
.gcf-approval {
  display: flex;
  justify-content: center;
  padding: 8px var(--dsh-composer-side-clearance, 16px) 12px;
}
.gcf-card.is-approval {
  width: 100%;
  max-width: var(--dsh-chat-content-width, 760px);
  border-color: var(--dsw-alias-state-warn-secondary, #e5c37a);
  box-shadow: var(--dsw-shadow-lv2, 0 6px 24px rgba(16, 24, 40, 0.12));
}
.gcf-approval-reason {
  padding: 0 14px 8px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary, #1d1d1f);
  white-space: pre-wrap;
  word-break: break-word;
}
.gcf-approval-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 14px 12px;
}
.gcf-approval-button {
  border-radius: var(--dsw-radius-md, 10px);
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
  background: transparent;
  color: var(--dsw-alias-label-primary, #1d1d1f);
  font-size: 13px;
  line-height: 20px;
  padding: 5px 14px;
  cursor: pointer;
}
.gcf-approval-button.is-allow {
  background: var(--dsw-alias-label-primary, #1d1d1f);
  border-color: var(--dsw-alias-label-primary, #1d1d1f);
  color: var(--dsw-alias-bg-base, #fff);
}
.gcf-approval-button:hover:not(:disabled) {
  filter: brightness(1.05);
}
.gcf-approval-button:disabled {
  opacity: 0.5;
  cursor: default;
}
.gcf-toggle:hover {
  background: var(--dsw-alias-interactive-bg-hover, #ececec);
  color: var(--dsw-alias-label-primary, #1d1d1f);
}
.gcf-toggle:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4a7fdc);
  outline-offset: 1px;
}
.gcf-toggle svg { transition: transform 200ms ease; }
.gcf-toggle[aria-expanded='true'] svg { transform: rotate(90deg); }
.gcf-action {
  flex: none;
  margin-left: auto;
  height: 26px;
  padding: 0 12px;
  border: 0;
  border-radius: 999px;
  font: 500 12px/1 inherit;
  color: var(--dsw-alias-label-secondary, #5f5f5f);
  background: var(--dsw-alias-bg-layer-2, #f4f4f4);
  cursor: pointer;
}
.gcf-action:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, #ececec);
  color: var(--dsw-alias-label-primary, #1d1d1f);
}
.gcf-action:disabled { opacity: 0.55; cursor: default; }
.gcf-action-spinner { display: inline-flex; align-items: center; gap: 5px; pointer-events: none; }
.gcf-action:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4a7fdc); outline-offset: 1px; }
.gcf-num {
  display: inline-block;
  animation: gcf-pop 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
@keyframes gcf-pop {
  from { opacity: 0; transform: translateY(45%); }
}
body[data-ds-dark-theme] .gcf-dock {
  --gcf-node: #7aa2f7;
  --gcf-node-ring: #7aa2f733;
  --gcf-node-warn: #e3a21a;
  --gcf-node-warn-ring: #e3a21a2e;
  --gcf-rail: #33405c;
}
/* ---- Replica pass: values measured from media/thread.css ---- */
.gcf-dock {
  --ink: #1d1d1f; --ink-2: #3a3a3c; --muted: #7a7a7a; --faint: #a6a6a6;
  --hair: #ececec; --soft: #f5f5f5;
  --blue: #4a7fdc; --blue-line: #93b4ee; --blue-tag-bg: #eef4ff; --blue-tag: #3866c4;
  --teal: #22c4a0; --teal-line: #5ecfb5; --teal-tag-bg: #ecfaf5; --teal-tag: #16876c;
  --base: #bdbdbd; --base-line: #dedede;
  --warn: #e3a21a; --warn-ink: #b5682b; --warn-line: #ecc68a; --warn-bg: #fdf6e6;
  --ok: #2fb46c; --ok-ink: #2e8f55; --ok-line: #a8e0c0;
  --merged: #8b5cf6; --merged-ink: #7a45e0; --merged-line: #cfbdf8; --merged-bg: #f5f0ff;
  --accent-bg: #eef2fd; --accent-ink: #3553b5;
  --add: #2f8a4f; --del: #c0394b; --add-block: #3fb950; --del-block: #e5534b;
  --ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  --ui: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Noto Sans SC', sans-serif;
  --mono: 'SFMono-Regular', 'JetBrains Mono', Menlo, Consolas, monospace;
  font: 13px/1.45 var(--ui);
  color: var(--ink);
}
.gcf-card {
  border: 1px solid var(--hair);
  border-radius: 12px;
  box-shadow: 0 1px 2px #00000008;
  padding: 14px 16px 12px;
}
.gcf-head { height: 20px; margin-bottom: 9px; padding: 0; gap: 12px; min-height: 0; }
.gcf-title { font-size: 14px; font-weight: 600; letter-spacing: -0.1px; line-height: 20px; }
.gcf-prnum { font-size: 14px; font-weight: 400; color: var(--muted); }
.gcf-state { font-size: 12.5px; }
.gcf-state.is-clean { color: var(--ok-ink); }
.gcf-state.is-changes { color: var(--warn-ink); }
.gcf-state.is-merged, .gcf-state.is-ready { color: var(--merged-ink); }
.gcf-state.is-conflicts { color: var(--warn-ink); }
.gcf-rows { padding: 0; max-height: 42vh; }
.gcf-row {
  height: 30px;
  min-height: 30px;
  gap: 8px;
  padding: 0 6px 0 10px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--muted);
}
.gcf-row.is-strong { color: var(--ink); }
.gcf-railbox { flex: none; width: 43px; display: flex; align-items: center; overflow: visible; }
.gcf-rail { overflow: visible; }
.gcf-subject { font-size: 13px; flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.gcf-pills { gap: 6px; margin-left: 2px; flex: none; max-width: 44%; overflow: hidden; }
.gcf-pill {
  padding: 1px 6px;
  border-radius: 4px;
  font: 11px/1.5 var(--mono);
  background: var(--soft);
  color: #707070;
}
.gcf-pill.is-head { background: var(--blue-tag-bg); color: var(--blue-tag); }
.gcf-pill.is-branch { background: var(--soft); color: #707070; }
.gcf-pill.is-remote { background: var(--teal-tag-bg); color: var(--teal-tag); }
.gcf-pill.is-tag { background: var(--warn-bg); color: var(--warn-ink); }
.gcf-meta { font-size: 12.5px; gap: 4px; color: var(--muted); }
.gcf-meta code { font: 11.5px var(--mono); color: var(--faint); margin-right: 3px; }
.gcf-meta.is-warn { color: var(--warn-ink); }
.gcf-more { padding: 6px 6px 4px 61px; font-size: 12.5px; color: var(--faint); }
.gcf-row--operation { color: var(--warn-ink); height: 30px; }
/* Gutter glyphs sit in the rail column so every row's text starts at 61px. */
.gcf-row--working .gcf-rail-wait { position: absolute; left: 3px; top: 8px; width: 14px; margin: 0; }
.gcf-row--operation .gcf-op-icon { position: absolute; left: 3px; top: 8px; margin: 0; }
.gcf-row--conflict .gcf-badge { position: absolute; left: 2px; top: 7px; margin: 0; }
.gcf-row--conflict { background: var(--warn-bg); color: var(--warn-ink); }
.gcf-badge { width: 16px; height: 16px; font-size: 10.5px; border-radius: 8px; background: var(--warn-bg); color: var(--warn-ink); }
.gcf-checks { gap: 6px; margin: 13px 0 0 -4px; padding: 0; }
.gcf-check {
  height: 24px;
  padding: 0 10px 0 8px;
  border: 1px solid var(--hair);
  border-radius: 12px;
  font-size: 12.5px;
  color: var(--muted);
}
.gcf-check svg { color: var(--ok); width: 11px; height: 11px; }
.gcf-check.is-failed { color: var(--warn-ink); }
.gcf-check.is-failed svg { color: var(--warn); }
.gcf-foot { min-height: 32px; margin-top: 11px; padding: 0; border-top: 0; font-size: 13px; color: var(--ink); }
.gcf-foot-state { color: var(--ink); font-size: 13px; }
.gcf-foot-state.is-conflicts { color: var(--warn-ink); }
.gcf-foot-state.is-clean { color: var(--ink); }
.gcf-action {
  height: 30px;
  padding: 0 14px;
  border: 0;
  border-radius: 15px;
  background: var(--accent-bg);
  color: var(--accent-ink);
  font: 500 13px var(--ui);
  margin-left: auto;
}
.gcf-action:disabled { opacity: 1; cursor: default; }
.gcf-action.is-warn { background: var(--warn-bg); color: var(--warn-ink); }
.gcf-chips { gap: 6px; padding: 6px 0 0; }
.gcf-chip {
  height: 28px;
  padding: 0 11px;
  border: 1px solid var(--hair);
  border-radius: 14px;
  background: #fff;
  font: 12.5px var(--ui);
  color: var(--ink);
}
.gcf-chip i { width: 7px; height: 7px; }
.gcf-chip.is-clean, .gcf-chip.is-changes { color: var(--ink); }
.gcf-chip.is-clean i { background: var(--ok); }
.gcf-chip.is-changes i { background: var(--warn); }
.gcf-chip.is-conflicts i { background: var(--warn); }
.gcf-chip.is-merged i { background: var(--merged); }
.gcf-heat i { width: 7px; height: 7px; border-radius: 1.5px; }
.gcf-heat i.is-add { background: var(--add-block); }
.gcf-heat i.is-del { background: var(--del-block); }
.gcf-chip--diff b { color: var(--add); }
.gcf-chip--diff em { color: var(--del); }
@media (prefers-reduced-motion: reduce) {
  .gcf-swap { animation: none; }
  .gcf-reveal { transition: none; }
  .gcf-body { transition: none; }
  .gcf-row, .gcf-num { animation: none; }
  .gcf-status, .gcf-status i { transition: none; }
  .gcf-toggle svg { transition: none; }
  .gcf-spinner-core { animation: none; }
  .gcf-spinner-halo { animation: none; opacity: 0.35; transform: scale(1.35); }
}
.gcf-conflict-list {
  margin-top: 8px;
  border-top: 1px solid var(--warn-line, #ecc68a);
  padding-top: 4px;
}
.gcf-conflict-list .gcf-row--conflict {
  position: relative;
  transform: none;
  transition: none;
}
.gcf-conflict-list .gcf-badge { position: absolute; left: 2px; top: 7px; margin: 0; }

/* Conflict peek popover ---------------------------------------------------- */
.gcf-conflict-peek {
  position: relative;
  display: contents;
}
.gcf-peek-popover {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  z-index: 20;
  min-width: 340px;
  max-width: min(480px, calc(100cqw - 32px));
  background: var(--dsw-alias-bg-layer-1, #fff);
  border: 1px solid var(--dsw-alias-border-l1, #ececec);
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(16, 24, 40, 0.12), 0 2px 6px rgba(16, 24, 40, 0.06);
  overflow: hidden;
  pointer-events: none;
  opacity: 0;
  transform: translateY(4px);
  transition: opacity 140ms ease, transform 140ms ease;
}
.gcf-row--conflict:hover .gcf-peek-popover,
.gcf-row--conflict:focus-within .gcf-peek-popover {
  opacity: 1;
  transform: none;
  pointer-events: auto;
}
.gcf-peek-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 12px 5px;
  font-size: 11px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, #5e5e5e);
  border-bottom: 1px solid var(--dsw-alias-border-l1, #ececec);
}
.gcf-peek-header span { font-weight: 400; color: var(--dsw-alias-label-tertiary, #8a8a8a); margin-left: 6px; }
.gcf-peek-hunk {
  padding: 6px 0;
}
.gcf-peek-line {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr);
  align-items: baseline;
  gap: 4px;
  padding: 3px 12px 3px 10px;
  border-left: 3px solid transparent;
}
.gcf-peek-line.is-ours { border-color: var(--warn, #e3a21a); background: rgba(227, 162, 26, 0.06); }
.gcf-peek-line.is-theirs { border-color: var(--blue, #4a7fdc); background: rgba(74, 127, 220, 0.05); }
.gcf-peek-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  font-weight: 600;
}
.gcf-peek-line.is-ours .gcf-peek-label { color: var(--warn-ink, #b5682b); }
.gcf-peek-line.is-theirs .gcf-peek-label { color: var(--blue, #4a7fdc); }
.gcf-peek-code {
  font: 11px/1.5 var(--dsh-mono-font, "SFMono-Regular", Menlo, Consolas, monospace);
  color: var(--dsw-alias-label-primary, #1d1d1f);
  overflow-x: auto;
  white-space: pre;
  scrollbar-width: none;
}
.gcf-peek-empty {
  padding: 10px 12px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
  font-style: italic;
}
@media (prefers-reduced-motion: reduce) {
  .gcf-peek-popover { transition: none; }
}

/* Continuous scene motion: geometry is sampled once for rows and SVG. */
.gcf-graph > .gcf-rows > .gcf-row { transition: none; animation: none; }
.gcf-edge { animation: none; transition: stroke 1100ms ease; }
.gcf-node { transition: color 1100ms ease; }
.gcf-node.t-base { --c: var(--base, #bdbdbd); }
.gcf-n-dot { transition: fill 1100ms ease, stroke 750ms ease, r 900ms ease; }
.gcf-node-arc { animation: none; stroke: var(--c); stroke-dasharray: .64 .36; }
.gcf-orbit { transform-origin: 0 0; animation: gcf-orbit-turn 2s linear infinite; }
@keyframes gcf-orbit-turn { to { transform: rotate(360deg); } }
.gcf-row-content { display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; }
.gcf-row-content.is-previous { position: absolute; left: 61px; right: 8px; width: auto; pointer-events: none; }
.gcf-row.is-completed::before { background: var(--ok-bg, #eaf7ef); animation: gcf-complete-glow 2000ms ease-out forwards; }
.gcf-row.is-merged-commit::before { background: var(--merged-bg); }
.gcf-row.is-merged-commit .gcf-pill.is-head { background: var(--merged-bg); color: var(--merged-ink); }
@keyframes gcf-complete-glow { from { opacity: .8; } to { opacity: 0; } }
.gcf-card { transition: border-color 1100ms ease, background-color 1100ms ease; }
.gcf-card.is-merged { border-color: var(--merged-line); }
.gcf-card.is-merged .gcf-state, .gcf-card.is-merged .gcf-foot-state { color: var(--merged-ink); }
.gcf-pill, .gcf-state, .gcf-chip, .gcf-badge { transition: background-color 400ms ease, color 400ms ease, border-color 400ms ease; }
.gcf-chip { background: var(--dsw-alias-bg-layer-1, #fff); }
body[data-ds-dark-theme] .gcf-dock {
  --ink: #e6e7eb; --ink-2: #cfd2da; --muted: #a6acb9; --faint: #858c9b;
  --hair: #353b47; --soft: #2a303b; --base-line: #586173;
  --blue-tag-bg: #263852; --blue-tag: #9fbeff; --teal-tag-bg: #203d37; --teal-tag: #72d9bd;
  --warn-ink: #efbe78; --warn-bg: #3d3322; --warn-line: #755b30;
  --ok-ink: #80d7a1; --ok-bg: #203c30; --merged-ink: #c0a5ff; --merged-line: #665383;
  --merged-bg: #352b48;
  --accent-bg: #2c3856; --accent-ink: #b4c9ff;
}
.gcf-change-text { display: inline-block; position: relative; vertical-align: bottom; white-space: nowrap; max-width: 100%; }
.gcf-text-in { display: inline-block; animation: gcf-text-in 540ms cubic-bezier(.25,.1,.25,1) both; }
.gcf-text-out { position: absolute; left: 0; top: 0; pointer-events: none; animation: gcf-text-out 450ms ease forwards; }
@keyframes gcf-text-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
@keyframes gcf-text-out { to { opacity: 0; transform: translateY(-3px); } }
.gcf-activity { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows 360ms ease, opacity 270ms ease; }
.gcf-activity.is-visible { grid-template-rows: 1fr; opacity: 1; }
.gcf-activity > div { min-height: 0; overflow: hidden; }
.gcf-action { display: inline-flex; align-items: center; gap: 0; }
.gcf-button-busy { display: inline-flex; width: 0; opacity: 0; overflow: hidden; transition: width 180ms ease, opacity 150ms ease, margin-right 180ms ease; }
.gcf-button-busy.is-visible { width: 14px; opacity: 1; margin-right: 5px; }
.gcf-conflict-list { position: relative; border: 0; padding: 0; transition: margin-top 320ms ease; }
.gcf-conflict-list .gcf-row--conflict { position: absolute; top: 0; left: 0; right: 0; height: 30px; padding: 0 8px 0 28px; transition: color 240ms ease, background-color 240ms ease; }
.gcf-conflict-list .is-resolved, .gcf-conflict-list .is-resolved .gcf-badge { color: var(--ok-ink); background: color-mix(in srgb, var(--ok) 10%, transparent); }
.gcf-conflict-list .gcf-badge svg { width: 12px; height: 12px; }
@media (prefers-reduced-motion: reduce) {
  .gcf-dock *, .gcf-dock *::before { animation: none !important; transition: none !important; }
  .gcf-row.is-completed::before { opacity: 0; }
}
`;

    const zh = {
      'action.resolving': '处理中',
      'action.done': '已完成',
      'conflict.resolved': '已解决',
      'activity.review': '模型处理中',
      'activity.stage': '正在暂存改动',
      'activity.commit': '正在提交改动',
      'activity.merge': '正在合并分支',
      'activity.resolve': '正在完成冲突解决',
      'activity.abort': '正在中止操作',
      'activity.working': '执行中',
      'activity.failed': '操作未完成，请查看对话中的结果',
      'done.stage': '改动已暂存',
      'done.commit': '提交完成',
      'done.merge': '合并完成',
      'done.resolve': '冲突处理完成',
      'done.abort': '操作已中止',
      'app.title': 'Git 工作流',
      'branch.detached': '游离 HEAD @ {oid}',
      'branch.unknown': '未知分支',
      'tracking.ahead': '领先上游的提交数',
      'tracking.behind': '落后上游的提交数',
      'status.clean': '干净',
      'status.changes': '{n} 处变更',
      'status.conflicts': '{n} 处冲突',
      'status.merge': '合并待继续',
      'status.rebase': '变基待继续',
      'status.cherry-pick': '拣选待继续',
      'status.revert': '回滚待继续',
      'row.working': '未提交的改动',
      'row.files': '{n} 个文件',
      'rows.more': '还有 {n} 条提交',
      'repos.title': '{n} 个 Git 仓库',
      'nav.back': '返回',
      'notice.clean': '没有可提交的改动',
      'notice.failed': '读取改动失败，请重试',
      'notice.unavailable': '当前会话无法发送 review 消息',
      'conflict.ours': '当前 (HEAD)',
      'conflict.theirs': '传入',
      'conflict.peekEmpty': '无法预览：没有标准冲突块',
      'conflict.moreHunks': '还有 {n} 处冲突块',
      'branch.detachedShort': '游离 HEAD',
      'foot.staged': '暂存 {n}',
      'foot.unstaged': '未暂存 {n}',
      'foot.untracked': '未跟踪 {n}',
      'action.commit': '提交',
      'action.pending': '写操作由 AI 在对话中执行，需你审批',
      'action.reviewing': '正在 review…',
      'action.expand': '展开',
      'action.collapse': '收起',
      'state.clean': '干净',
      'state.changes': '有改动',
      'state.conflicts': '{n} 处冲突',
      'state.open': 'Open',
      'state.ready': '可合并',
      'state.merged': '已合并',
      'row.operation.merge': '合并进行中',
      'row.operation.rebase': 'Rebase onto upstream',
      'row.operation.cherry-pick': 'Cherry-pick in progress',
      'row.operation.revert': 'Revert in progress',
      'row.merging': '进行中',
      'row.conflicts': '{n} 处冲突',
      'foot.conflicts': '{n} 处冲突待解决',
      'action.resolve': '解决冲突',
      'pending.awaiting': '等待审批',
      'pending.running': '执行中',
      'approval.reject': '拒绝',
      'approval.allow': '允许一次',
      'time.now': '刚刚',
      'time.minutes': '{n} 分钟前',
      'time.hours': '{n} 小时前',
      'time.days': '{n} 天前',
    };

    const en = {
      'action.resolving': 'Working',
      'action.done': 'Done',
      'conflict.resolved': 'Resolved',
      'activity.review': 'Model is working',
      'activity.stage': 'Staging changes',
      'activity.commit': 'Committing changes',
      'activity.merge': 'Merging the branch',
      'activity.resolve': 'Completing conflict resolution',
      'activity.abort': 'Aborting the operation',
      'activity.working': 'Running',
      'activity.failed': 'Operation incomplete — see the result in the conversation',
      'done.stage': 'Changes staged',
      'done.commit': 'Commit completed',
      'done.merge': 'Merge completed',
      'done.resolve': 'Conflict resolution completed',
      'done.abort': 'Operation aborted',
      'app.title': 'Git workflow',
      'branch.detached': 'detached HEAD @ {oid}',
      'branch.unknown': 'unknown branch',
      'tracking.ahead': 'Commits ahead of upstream',
      'tracking.behind': 'Commits behind upstream',
      'status.clean': 'Clean',
      'status.changes': '{n} changes',
      'status.conflicts': '{n} conflicts',
      'status.merge': 'Merge awaiting continuation',
      'status.rebase': 'Rebase awaiting continuation',
      'status.cherry-pick': 'Cherry-pick awaiting continuation',
      'status.revert': 'Revert awaiting continuation',
      'row.working': 'Uncommitted changes',
      'row.files': '{n} files',
      'rows.more': '{n} more commits',
      'repos.title': '{n} Git repositories',
      'nav.back': 'Back',
      'notice.clean': 'Nothing to commit',
      'notice.failed': 'Could not read the changes — try again',
      'notice.unavailable': 'This session cannot send a review message',
      'conflict.ours': 'Current (HEAD)',
      'conflict.theirs': 'Incoming',
      'conflict.peekEmpty': 'No standard conflict markers found',
      'conflict.moreHunks': '{n} more conflict hunk(s)',
      'branch.detachedShort': 'detached HEAD',
      'foot.staged': 'staged {n}',
      'foot.unstaged': 'unstaged {n}',
      'foot.untracked': 'untracked {n}',
      'action.commit': 'Commit',
      'action.pending': 'The AI performs writes in the conversation, with your approval',
      'action.reviewing': 'Reviewing…',
      'action.expand': 'Expand',
      'action.collapse': 'Collapse',
      'state.clean': 'Clean',
      'state.changes': 'Changes',
      'state.conflicts': '{n} conflicts',
      'state.open': 'Open',
      'state.ready': 'Ready',
      'state.merged': 'Merged',
      'row.operation.merge': 'Merge in progress',
      'row.operation.rebase': 'Rebase onto upstream',
      'row.operation.cherry-pick': 'Cherry-pick in progress',
      'row.operation.revert': 'Revert in progress',
      'row.merging': 'in progress',
      'row.conflicts': '{n} conflicts',
      'foot.conflicts': '{n} conflicts to resolve',
      'action.resolve': 'Resolve conflicts',
      'pending.awaiting': 'Waiting for approval',
      'pending.running': 'Running',
      'approval.reject': 'Reject',
      'approval.allow': 'Allow once',
      'time.now': 'just now',
      'time.minutes': '{n}m ago',
      'time.hours': '{n}h ago',
      'time.days': '{n}d ago',
    };

    /** Locale lookup plus `{name}` interpolation. */
    function format(t, key, vars) {
      const template = t(key);
      if (vars === undefined) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        vars[name] === undefined ? match : String(vars[name]),
      );
    }

    const GLYPHS = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const SCRAMBLE_MS = MOTION.text;

    function prefersReducedMotion() {
      try {
        return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch {
        return false;
      }
    }

    function useReducedMotion() {
      const subscribe = React.useCallback((notify) => {
        if (typeof matchMedia !== 'function') return () => {};
        const media = matchMedia('(prefers-reduced-motion: reduce)');
        media.addEventListener('change', notify);
        return () => media.removeEventListener('change', notify);
      }, []);
      return React.useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
    }

    /** Keep old text just long enough to crossfade; unchanged polls do nothing. */
    function ChangeText({ text, decode = false }) {
      const reduced = useReducedMotion();
      const [content, setContent] = React.useState({ text, previous: null });
      const element = React.useRef(null);
      const width = React.useRef(null);
      React.useEffect(() => {
        if (content.text === text) return;
        setContent({ text, previous: reduced ? null : content.text });
      }, [text, reduced]);
      React.useEffect(() => {
        if (content.previous === null) return;
        const timer = setTimeout(() => setContent((value) => ({ ...value, previous: null })), MOTION.text);
        return () => clearTimeout(timer);
      }, [content.text]);
      React.useLayoutEffect(() => {
        const el = element.current;
        if (!el) return;
        const next = el.scrollWidth;
        const old = width.current;
        width.current = next;
        if (!reduced && old !== null && Math.abs(old - next) > .5 && typeof el.animate === 'function') {
          const animation = el.animate([{ width: `${old}px` }, { width: `${next}px` }], { duration: MOTION.width, easing: 'cubic-bezier(.25,.1,.25,1)' });
          return () => animation.cancel();
        }
      }, [content.text, reduced]);
      return h('span', { className: 'gcf-change-text', ref: element },
        h('span', { key: content.text, className: content.previous !== null && !reduced ? 'gcf-text-in' : '' },
          decode && content.previous !== null && !reduced ? h(Scramble, { text: content.text }) : content.text),
        content.previous !== null && !reduced ? h('span', { key: `old:${content.text}`, className: 'gcf-text-out', 'aria-hidden': true }, content.previous) : null,
      );
    }

    /** Random glyphs resolving left to right into the final text (video 4.0s / 5.5s). */
    function Scramble({ text, duration = SCRAMBLE_MS }) {
      const [shown, setShown] = React.useState(text);
      React.useEffect(() => {
        if (prefersReducedMotion()) {
          setShown(text);
          return () => {};
        }
        const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
        let raf = 0;
        const tick = (now) => {
          const progress = Math.min(1, (now - start) / duration);
          const fixed = Math.floor(progress * text.length);
          let out = text.slice(0, fixed);
          for (let i = fixed; i < text.length; i += 1) {
            out += /\s/.test(text[i]) ? text[i] : GLYPHS[(Math.random() * GLYPHS.length) | 0];
          }
          setShown(out);
          if (progress < 1) raf = requestAnimationFrame(tick);
          else setShown(text);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
      }, [text, duration]);
      return shown;
    }

    /** Card entrance: fade + lift + scale (replica gg-card-grow, video 2.5s).
     *  Wraps the card section so the animation fires exactly once on mount. */
    function Reveal({ children }) {
      // CSS owns the complete entrance lifetime; no next-frame cancellation.
      return h('div', { className: 'gcf-reveal' }, children);
    }

    /** Branch glyph: one trunk with a forked commit, drawn for this plugin. */
    /**
     * Parse a combined diff (with <<<<<</s/=======/>>>>>>>> markers) into a
     * per-file map of { ours: string, theirs: string, label: string }[].
     * Used by ConflictPeekPopover to render the hover preview without a
     * separate request: the diff payload already contains the patch.
     * Returns { [path]: hunk[] } where each hunk has one representative line
     * per side (the first non-empty line from each side of the first block).
     * @param {string} patch - raw diff text with conflict markers
     * @returns {Record<string, { ours: string, theirs: string }[]>}
     */
    function parseConflictPeek(patch) {
      const result = {};
      let currentFile = null;
      let inOurs = false;
      let inTheirs = false;
      let oursLines = [];
      let theirsLines = [];

      const push = () => {
        if (currentFile === null) return;
        const ours = oursLines.find((l) => l.trim() !== '') ?? '';
        const theirs = theirsLines.find((l) => l.trim() !== '') ?? '';
        if (ours === '' && theirs === '') { oursLines = []; theirsLines = []; return; }
        if (!result[currentFile]) result[currentFile] = [];
        result[currentFile].push({ ours, theirs });
        oursLines = [];
        theirsLines = [];
      };

      for (const line of patch.split('\n')) {
        // New file in diff output.
        const m = /^\+\+\+ b\/(.+)/.exec(line) ?? /^\+\+\+ (.+)/.exec(line);
        if (m) {
          push();
          currentFile = m[1].replace(/\t.*$/, '').trim();
          inOurs = false;
          inTheirs = false;
          continue;
        }
        // Combined diff: <<<<<<< HEAD or <<<<<<< label
        if (/^[+ ]{0,2}<{7}/.test(line)) { push(); inOurs = true; inTheirs = false; continue; }
        if (/^[+ ]{0,2}={7}\s*$/.test(line)) { inOurs = false; inTheirs = true; continue; }
        if (/^[+ ]{0,2}>{7}/.test(line)) { push(); inOurs = false; inTheirs = false; continue; }
        if (inOurs && currentFile !== null) oursLines.push(line.replace(/^[+ -]/, ''));
        if (inTheirs && currentFile !== null) theirsLines.push(line.replace(/^[+ -]/, ''));
      }
      push();
      return result;
    }

    /** Hover popover for one conflict file row: shows ours vs theirs. */
    function ConflictPeekPopover({ hunks, t }) {
      if (!hunks || hunks.length === 0) {
        return h('div', { className: 'gcf-peek-popover' },
          h('div', { className: 'gcf-peek-empty' }, t('conflict.peekEmpty')));
      }
      const h0 = hunks[0];
      return h(
        'div',
        { className: 'gcf-peek-popover', role: 'tooltip' },
        h(
          'div',
          { className: 'gcf-peek-hunk' },
          h('div', { className: 'gcf-peek-line is-ours' },
            h('span', { className: 'gcf-peek-label' }, t('conflict.ours')),
            h('code', { className: 'gcf-peek-code' }, h0.ours || '（空）'),
          ),
          h('div', { className: 'gcf-peek-line is-theirs' },
            h('span', { className: 'gcf-peek-label' }, t('conflict.theirs')),
            h('code', { className: 'gcf-peek-code' }, h0.theirs || '（空）'),
          ),
        ),
        hunks.length > 1
          ? h('div', { className: 'gcf-peek-header' },
              null,
              h('span', null, t('conflict.moreHunks').replace('{n}', String(hunks.length - 1))))
          : null,
      );
    }

    /** Left-chevron used by the back button. */
    function BackGlyph() {
      return h(
        'svg',
        {
          width: 12,
          height: 12,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        h('path', { d: 'M10 3 5 8l5 5' }),
      );
    }

    function BranchGlyph() {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        h('path', { d: 'M4 2.8v10.4' }),
        h('circle', { cx: 4, cy: 2.6, r: 1.4 }),
        h('circle', { cx: 4, cy: 13.4, r: 1.4 }),
        h('path', { d: 'M12 4.2v3.1a3 3 0 0 1-3 3H6.6' }),
        h('circle', { cx: 12, cy: 2.8, r: 1.4 }),
      );
    }

    /** Warning triangle for conflict rows and the conflict footer. */
    function WarnGlyph() {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        h('path', { d: 'M8 2.2 14.2 13H1.8L8 2.2Z' }),
        h('path', { d: 'M8 6.2v3.2' }),
        h('path', { d: 'M8 11.4h.01' }),
      );
    }

    /** Circle-check used by the checks chips (video 24s). */
    function CheckGlyph() {
      return h(
        'svg',
        {
          width: 13,
          height: 13,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        h('circle', { cx: 8, cy: 8, r: 6.2 }),
        h('path', { d: 'm5.4 8.2 1.8 1.8 3.5-3.6' }),
      );
    }

    function relativeTime(seconds, nowMs, t) {
      const elapsed = Math.max(0, Math.floor(nowMs / 1000 - seconds));
      if (elapsed < 60) return t('time.now');
      if (elapsed < 3600) return format(t, 'time.minutes', { n: Math.floor(elapsed / 60) });
      if (elapsed < 86400) return format(t, 'time.hours', { n: Math.floor(elapsed / 3600) });
      return format(t, 'time.days', { n: Math.floor(elapsed / 86400) });
    }

    function statusText(view, t) {
      if (view.phase === 'conflicts') return format(t, 'status.conflicts', { n: view.counts.conflicts });
      if (view.phase === 'merge') return t('status.merge');
      if (view.phase === 'rebase') return t('status.rebase');
      if (view.phase === 'cherry-pick') return t('status.cherry-pick');
      if (view.phase === 'revert') return t('status.revert');
      if (view.phase === 'changes') return format(t, 'status.changes', { n: view.counts.working });
      return t('status.clean');
    }

    function completionOf(view) {
      const result = view.completion;
      if (!result || view.pending || result.repoRoot !== view.repoRoot) return null;
      if (result.statusKey && result.statusKey !== view.statusKey) return null;
      if (result.outcome === 'succeeded' && result.head !== view.branch?.oid) return null;
      return result;
    }

    function activityText(view, t, reviewing, running) {
      if (view.pending) return t(view.pending.phase === 'awaiting-approval' ? 'pending.awaiting' : `activity.${view.pending.action ?? 'working'}`);
      const done = completionOf(view);
      if (done) return t(done.outcome === 'succeeded' ? `done.${done.action}` : 'activity.failed');
      if (reviewing || (running && view.counts.conflicts > 0)) return t('activity.review');
      return view.counts.conflicts > 0 ? format(t, 'foot.conflicts', { n: view.counts.conflicts }) : statusText(view, t);
    }

    function ConflictList({ rows, view, t, conflictPeekHunks, completion }) {
      const containerRef = React.useRef(null);
      const previousCount = React.useRef(view.counts.conflicts);
      const resolving = view.counts.conflicts < previousCount.current
        && (view.operation !== null || (completion?.outcome === 'succeeded' && ['merge', 'resolve'].includes(completion.action)));
      React.useEffect(() => { previousCount.current = view.counts.conflicts; }, [view.counts.conflicts]);
      const frame = useGraphMotion(rows, [], false, null, { rowHeight: 32, resolved: resolving, containerRef });
      return h('div', { className: 'gcf-conflict-list', 'data-gcf': 'conflict-list', ref: containerRef,
        style: { height: `${frame.height}px`, marginTop: frame.height > 0 ? 8 : 0, opacity: frame.height > 0 ? 1 : 0 } },
        frame.rows.map((entry) => h('div', {
          key: entry.key, className: `gcf-row gcf-row--conflict${entry.resolved ? ' is-resolved' : ''}`,
          'data-gcf': 'conflict-row', 'data-conflict': entry.row.path, tabIndex: entry.exiting ? -1 : 0,
          'aria-hidden': entry.exiting || undefined,
          style: { transform: `translateY(${entry.y}px)`, opacity: entry.opacity, pointerEvents: entry.exiting ? 'none' : undefined },
        },
        h('span', { className: 'gcf-badge', 'aria-hidden': true }, entry.resolved ? h(CheckGlyph) : String(entry.row.index)),
        h('span', { className: 'gcf-subject' }, entry.row.path),
        h('span', { className: 'gcf-meta' }, entry.resolved ? t('conflict.resolved') : h('code', null, entry.row.code)),
        h(ConflictPeekPopover, { hunks: conflictPeekHunks?.[entry.row.path] ?? null, t }),
        )),
      );
    }

    /** One state word for the header pill: open / conflicts / ready / merged. */
    function stateOf(view) {
      if (view.pr !== null && view.pr !== undefined && typeof view.pr.state === 'string') return view.pr.state;
      const done = completionOf(view);
      if (done?.outcome === 'succeeded' && view.clean && view.operation === null && (done.action === 'merge' || (done.action === 'resolve' && done.operation === 'merge'))) return 'merged';
      if (view.phase === 'conflicts') return 'conflicts';
      if (view.clean) return 'clean';
      return 'changes';
    }

    function stateText(view, t) {
      const state = stateOf(view);
      if (state === 'merged') return t('state.merged');
      if (state === 'ready') return t('state.ready');
      if (state === 'open') return t('state.open');
      if (state === 'conflicts') return format(t, 'state.conflicts', { n: view.counts.conflicts });
      if (state === 'clean') return t('state.clean');
      return t('state.changes');
    }

    function branchText(view, t) {
      if (view.branch.detached) {
        return format(t, 'branch.detached', { oid: String(view.branch.oid ?? '').slice(0, 7) });
      }
      return view.branch.name ?? t('branch.unknown');
    }

    function Tracking({ view, t }) {
      if (view.branch.upstream === null) return null;
      const { ahead, behind } = view.branch;
      return h(
        'span',
        { className: 'gcf-tracking', 'data-gcf': 'tracking' },
        h('span', { className: 'gcf-upstream' }, view.branch.upstream),
        ahead > 0 ? h('span', { className: 'gcf-ahead', title: t('tracking.ahead') }, `↑${ahead}`) : null,
        behind > 0 ? h('span', { className: 'gcf-behind', title: t('tracking.behind') }, `↓${behind}`) : null,
      );
    }

    // Replica lane tones: lane 0 is "ours" (blue), lane 1 "other" (teal),
    // later lanes cycle through the remaining tones.
    const LANE_TONES = ['ours', 'other', 'merged', 'warn', 'ok'];
    const TONE_COLORS = {
      base: '#bdbdbd',
      ours: '#4a7fdc',
      other: '#22c4a0',
      merged: '#8b5cf6',
      warn: '#e3a21a',
      ok: '#2fb46c',
    };

    function laneTone(lane) {
      return LANE_TONES[lane % LANE_TONES.length];
    }
    const LANE_X0 = 10;
    const LANE_WIDTH = 17;
    const ROW_HEIGHT = 30;
    const TEXT_X = 61;

    function laneX(lane) {
      return LANE_X0 + lane * LANE_WIDTH;
    }

    function laneStroke(lane) {
      return TONE_COLORS[laneTone(lane)];
    }

    /** One row of the commit graph: lanes, node and merge curves (video 8.6s). */
    /** Tone for a commit row: lane 0 is "ours", later lanes cycle. */
    function toneOfRow(row) {
      return laneTone(Number.isInteger(row.lane) ? row.lane : 0);
    }

    const GRAPH_MS = MOTION.graph;
    const rowIdentity = (row) => row.kind === 'commit' ? (row.sha ?? row.id) : row.id;
    const mix = (from, to, p) => from + (to - from) * p;
    // One easing clock for text, nodes, edges and container height.
    function motionEase(p) {
      let lo = 0, hi = 1;
      for (let i = 0; i < 10; i += 1) {
        const t = (lo + hi) / 2;
        const x = 3 * (1 - t) * (1 - t) * t * .25 + 3 * (1 - t) * t * t * .25 + t * t * t;
        if (x < p) lo = t; else hi = t;
      }
      const t = (lo + hi) / 2;
      return p <= 0 ? 0 : p >= 1 ? 1 : 3 * (1 - t) * (1 - t) * t * .1 + 3 * (1 - t) * t * t + t * t * t;
    }

    function graphTarget(rows, edges, current, busy, completion, rowHeight = ROW_HEIGHT) {
      const existing = new Map((current?.rows ?? []).map((entry) => [rowIdentity(entry.row), entry]));
      const write = completion?.outcome === 'succeeded' ? completion : null;
      const targetIds = new Set(rows.map(rowIdentity));
      // The exact write result identifies the new HEAD. No guessed commit or
      // fabricated progress: only that commit can inherit the operation seat.
      const replacement = write && write.previousHead !== write.head
        ? (current?.rows ?? []).find((entry) => !targetIds.has(rowIdentity(entry.row))
          && entry.row.kind === (write.action === 'commit' ? 'working' : 'operation')
          && (write.action === 'commit' || entry.row.operation === (write.action === 'merge' ? 'merge' : write.operation)))
          // A fast resolve can finish before an approved operation node paints.
          // Reuse its disappearing working seat, never a still-dirty row.
          ?? (write.action === 'resolve' ? (current?.rows ?? []).find((entry) =>
            entry.row.kind === 'working' && !targetIds.has(rowIdentity(entry.row))) : null)
        : null;
      const entries = rows.map((row, index) => {
        const old = existing.get(rowIdentity(row));
        const replace = !old && replacement && row.kind === 'commit' && row.sha === write.head
          && (row.parentShas ?? []).includes(write.previousHead) ? replacement : null;
        return {
          key: old?.key ?? replace?.key ?? rowIdentity(row), row,
          x: laneX(row.kind === 'commit' ? (row.lane ?? 0) : 0), y: index * rowHeight,
          opacity: 1, arc: busy && (row.kind === 'working' || row.kind === 'operation') ? 1 : 0,
          success: Boolean(write && row.kind === 'commit' && row.sha === write.head && ['commit', 'merge', 'resolve'].includes(write.action)),
        };
      });
      const links = edges.flatMap((edge) => {
        const from = entries[edge.from], to = entries[edge.to];
        if (!from || !to) return [];
        return [{ key: `${from.key}>${to.key}`, from: from.key, to: to.key,
          tone: from.success && from.row.parentShas?.length > 1 ? 'merged' : laneTone(edge.fromLane === 0 ? edge.toLane : edge.fromLane), opacity: 1, draw: 1 }];
      });
      return { rows: entries, edges: links, height: rows.length * rowHeight };
    }

    /** Sample from the currently displayed frame, including mid-flight changes. */
    function interpolateGraph(from, to, progress, { initial = false, resolved = false } = {}) {
      const p = motionEase(resolved ? Math.max(0, (progress - .4) / .6) : progress);
      const oldRows = new Map(from.rows.map((entry) => [entry.key, entry]));
      const nextRows = new Map(to.rows.map((entry) => [entry.key, entry]));
      const rows = to.rows.map((entry, index) => {
        const previous = oldRows.get(entry.key);
        const delay = initial ? Math.min(0.3, (to.rows.length - 1 - index) * .025) : 0;
        const enter = motionEase(Math.max(0, (progress - delay) / (1 - delay)));
        const start = previous ?? { ...entry, y: entry.y + 6, opacity: 0, arc: 0 };
        const changed = previous && (rowIdentity(previous.row) !== rowIdentity(entry.row));
        return { ...entry,
          x: mix(start.x, entry.x, p), y: mix(start.y, entry.y, p),
          opacity: mix(start.opacity, 1, enter), arc: mix(start.arc, entry.arc, p),
          previousRow: changed ? previous.row : previous?.previousRow,
          contentMix: changed ? p : mix(previous?.contentMix ?? 1, 1, p),
        };
      });
      for (const entry of from.rows) {
        if (nextRows.has(entry.key)) continue;
        const exit = resolved ? motionEase(Math.max(0, (progress - .4) / .6)) : motionEase(Math.min(1, progress * 2.2));
        if (progress < 1) rows.push({ ...entry, opacity: entry.opacity * (1 - exit), arc: entry.arc * (1 - p),
          exiting: true, resolved, y: entry.y });
      }
      const oldEdges = new Map(from.edges.map((edge) => [edge.key, edge]));
      const newEdges = new Set(to.edges.map((edge) => edge.key));
      const edges = to.edges.map((edge) => {
        const old = oldEdges.get(edge.key);
        return { ...edge, opacity: mix(old?.opacity ?? 0, 1, p), draw: mix(old?.draw ?? 0, 1, p) };
      });
      if (progress < 1) for (const edge of from.edges) {
        if (!newEdges.has(edge.key)) edges.push({ ...edge, opacity: edge.opacity * (1 - p) });
      }
      return { rows, edges, height: mix(from.height, to.height, p) };
    }

    function useGraphMotion(rows, edges, busy, completion, { rowHeight = ROW_HEIGHT, resolved = false, containerRef } = {}) {
      const reduced = useReducedMotion();
      const initial = React.useRef(true);
      const first = graphTarget(rows, edges, null, busy, completion, rowHeight);
      const [frame, setFrame] = React.useState(() => reduced ? first : {
        ...first, rows: first.rows.map((entry) => ({ ...entry, opacity: 0, arc: 0 })),
        edges: first.edges.map((edge) => ({ ...edge, opacity: 0, draw: 0 })),
      });
      const displayed = React.useRef(frame);
      const signature = JSON.stringify([rows, edges, busy, completion, rowHeight]);
      React.useEffect(() => {
        const from = displayed.current;
        const to = graphTarget(rows, edges, from, busy, completion, rowHeight);
        const wasInitial = initial.current;
        initial.current = false;
        if (reduced) { displayed.current = to; setFrame(to); return; }
        const duration = resolved ? MOTION.conflict : wasInitial ? MOTION.enter : GRAPH_MS;
        let lastTime = performance.now();
        let elapsed = 0;
        let raf;
        const tick = (now) => {
          const hidden = containerRef?.current?.getClientRects().length === 0;
          if (!hidden) elapsed += now - lastTime;
          lastTime = now;
          if (hidden) { raf = requestAnimationFrame(tick); return; }
          const p = Math.min(1, elapsed / duration);
          const next = p >= 1 ? to : interpolateGraph(from, to, p, { initial: wasInitial, resolved });
          displayed.current = next;
          setFrame(next);
          if (p < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
      }, [signature, reduced]);
      return frame;
    }

    function GraphSection({ rows, edges, t, now, hasPending = false, completion = null }) {
      const containerRef = React.useRef(null);
      const frame = useGraphMotion(rows, edges, hasPending, completion, { containerRef });
      return h('div', { className: 'gcf-graph', ref: containerRef, style: { height: `${frame.height}px` } },
        h(GraphRail, { frame }),
        h('div', { className: 'gcf-rows', 'data-gcf': 'rows' }, frame.rows.map((entry) =>
          h(Row, { key: entry.key, row: entry.row, entry, t, now }),
        )),
      );
    }

    function GraphRail({ frame, rows = [], edges = [] }) {
      // The retained approval component also uses this renderer without motion.
      frame = frame ?? graphTarget(rows, edges, null, false, null);
      const entries = new Map(frame.rows.map((entry) => [entry.key, entry]));
      const width = Math.max(LANE_X0 * 2 + LANE_WIDTH, ...frame.rows.map((entry) => entry.x + 18));
      return h('svg', { className: 'gcf-rail', width, height: Math.max(1, frame.height), 'aria-hidden': true },
        h('g', { className: 'gcf-edges' }, frame.edges.map((edge) => {
          const from = entries.get(edge.from), to = entries.get(edge.to);
          if (!from || !to) return null;
          const y1 = from.y + ROW_HEIGHT / 2, y2 = to.y + ROW_HEIGHT / 2;
          const bend = Math.max(y1, y2 - ROW_HEIGHT), mid = (bend + y2) / 2;
          return h('path', {
            key: edge.key, 'data-edge': edge.key, className: `gcf-edge t-${edge.tone}`,
            d: `M${from.x} ${y1}L${from.x} ${bend}C${from.x} ${mid},${to.x} ${mid},${to.x} ${y2}`,
            pathLength: 1, style: { opacity: Math.min(edge.opacity, from.opacity, to.opacity), strokeDashoffset: -(1 - edge.draw) },
          });
        })),
        h('g', { className: 'gcf-nodes' }, frame.rows.map((entry) => {
          const { row } = entry;
          const working = row.kind === 'working';
          const tone = entry.success ? (row.parentShas?.length > 1 ? 'merged' : 'ok')
            : row.kind === 'operation' ? 'warn' : row.kind === 'commit' ? toneOfRow(row) : 'base';
          return h('g', {
            key: entry.key, 'data-node': entry.key, className: `gcf-node t-${tone}`,
            transform: `translate(${entry.x} ${entry.y + ROW_HEIGHT / 2})`, style: { opacity: entry.opacity },
          },
          h('circle', { r: 6.5, fill: 'var(--dsw-alias-bg-layer-1, #fff)' }),
          h('circle', { className: 'gcf-n-dot', r: working ? 5 : row.kind === 'operation' ? 5 : 3.5,
            style: { fill: working ? 'none' : undefined, stroke: working ? 'var(--c)' : 'none' }, strokeDasharray: working ? '3 3' : undefined }),
          h('g', { className: 'gcf-orbit', style: { opacity: entry.arc, animationPlayState: entry.arc > .001 ? 'running' : 'paused' } },
            h('circle', { className: 'gcf-node-arc', r: 9, pathLength: 1, strokeDasharray: '.64 .36' })),
          );
        })),
      );
    }

    function shortRef(name) {
      return name.startsWith('origin/') ? name.slice('origin/'.length) : name;
    }

    function RowContents({ row, t, now, decoding = false }) {
      const title = row.kind === 'working' ? t('row.working')
        : row.kind === 'operation' ? (row.action ? t(`activity.${row.action}`) : format(t, `row.operation.${row.operation}`)) : row.subject;
      const refs = (row.refs ?? []).filter((ref, index, all) => all.findIndex((other) => shortRef(other.name) === shortRef(ref.name)) === index).slice(0, 2);
      return h(React.Fragment, null,
        h('span', { className: 'gcf-subject' }, decoding ? h(Scramble, { text: title }) : h(ChangeText, { text: title, decode: row.kind === 'commit' })),
        h('span', { className: 'gcf-meta' },
          row.kind === 'working' ? h(ChangeText, { text: format(t, 'row.files', { n: row.files }) })
          : row.kind === 'operation' ? h(ChangeText, { text: row.conflicts > 0 ? format(t, 'row.conflicts', { n: row.conflicts }) : t('row.merging') })
          : h(React.Fragment, null,
            h('span', { className: 'gcf-pills' }, refs.map((ref) => h('span', { key: ref.name, className: `gcf-pill is-${ref.kind}` }, shortRef(ref.name)))),
            h('code', null, row.id), h('span', null, row.author), h('span', null, relativeTime(row.time, now, t)),
          ),
        ),
      );
    }

    function Row({ row, entry, t, now, index = 0 }) {
      const y = entry?.y ?? index * ROW_HEIGHT;
      const blending = entry?.previousRow && (entry.contentMix ?? 1) < 1;
      return h('div', {
        className: `gcf-row gcf-row--${row.kind}${entry?.success ? ' is-completed' : ''}${entry?.success && row.parentShas?.length > 1 ? ' is-merged-commit' : ''}`,
        'data-gcf': 'row', 'data-kind': row.kind, 'data-row': entry?.key ?? rowIdentity(row),
        'data-exiting': entry?.exiting || undefined,
        'aria-hidden': entry?.exiting || undefined,
        style: { '--y': `${y}px`, opacity: entry?.opacity ?? 1, pointerEvents: entry?.exiting ? 'none' : undefined },
      },
      h('div', { className: 'gcf-row-content', style: { opacity: blending ? entry.contentMix : 1 } }, h(RowContents, { key: rowIdentity(row), row, t, now, decoding: Boolean(blending && row.kind === 'commit') })),
      blending ? h('div', { className: 'gcf-row-content is-previous', 'aria-hidden': true, style: { opacity: 1 - entry.contentMix } },
        h(RowContents, { row: entry.previousRow, t, now })) : null,
      );
    }

    /** Five squares sized by the add/delete ratio, like the reference's diff chip. */
    function heatSquares(diffStat) {
      const total = diffStat.add + diffStat.del;
      if (total === 0) return [];
      const addSquares = Math.round((diffStat.add / total) * 5);
      const squares = [];
      for (let index = 0; index < 5; index += 1) squares.push(index < addSquares ? 'is-add' : 'is-del');
      return squares;
    }

    /**
     * Smoothly expand/collapse a body element by toggling `is-open` one rAF
     * after the React render, so the CSS transition always has two distinct
     * paint frames (open → closed or closed → open) to interpolate between.
     */
    function useBodyRef(collapsed) {
      const ref = React.useRef(null);
      const prevCollapsed = React.useRef(collapsed);
      React.useEffect(() => {
        const el = ref.current;
        if (!el) return;
        if (collapsed === prevCollapsed.current) {
          // Initial mount: set the correct state without transition.
          if (collapsed) el.classList.remove('is-open');
          else el.classList.add('is-open');
          prevCollapsed.current = collapsed;
          return;
        }
        prevCollapsed.current = collapsed;
        if (!collapsed) {
          // Opening: add is-open on the next frame so the transition plays.
          const raf = requestAnimationFrame(() => el.classList.add('is-open'));
          return () => cancelAnimationFrame(raf);
        } else {
          // Closing: remove is-open on the next frame.
          const raf = requestAnimationFrame(() => el.classList.remove('is-open'));
          return () => cancelAnimationFrame(raf);
        }
      }, [collapsed]);
      return ref;
    }


    function Chips({ view, t, onToggle, expanded }) {
      const chips = [];
      // When collapsed: show branch name + state colour as the primary chip.
      // When expanded: show just the state word (branch is visible in the card header).
      const branchName = view.branch?.detached
        ? t('branch.detachedShort')
        : (view.branch?.name ?? t('branch.unknown'));
      chips.push(
        h(
          'span',
          { key: 'state', className: `gcf-chip is-${stateOf(view)}` },
          h('i', null),
          h(ChangeText, { text: expanded ? stateText(view, t) : branchName }),
        ),
      );
      if (view.branch?.upstream !== null && view.branch?.upstream !== undefined) {
        const { ahead, behind } = view.branch;
        if (expanded) {
          // Expanded: show upstream name + arrows in one chip.
          chips.push(
            h(
              'span',
              { key: 'tracking', className: 'gcf-chip gcf-chip--tracking' },
              h('span', { className: 'gcf-upstream' }, view.branch.upstream),
              ahead > 0 ? h('span', { className: 'gcf-ahead' }, `\u2191${ahead}`) : null,
              behind > 0 ? h('span', { className: 'gcf-behind' }, `\u2193${behind}`) : null,
            ),
          );
        } else if (ahead > 0 || behind > 0) {
          // Collapsed: show only the numeric deltas.
          chips.push(
            h(
              'span',
              { key: 'tracking', className: 'gcf-chip gcf-chip--tracking' },
              ahead > 0 ? h('span', { className: 'gcf-ahead' }, `\u2191${ahead}`) : null,
              behind > 0 ? h('span', { className: 'gcf-behind' }, `\u2193${behind}`) : null,
            ),
          );
        }
      }
      if (view.diffStat.add > 0 || view.diffStat.del > 0) {
        chips.push(
          h(
            'span',
            { key: 'diff', className: 'gcf-chip gcf-chip--diff' },
            h('b', null, h(ChangeText, { text: `+${view.diffStat.add}` })),
            h('em', null, h(ChangeText, { text: `\u2212${view.diffStat.del}` })),
            h(
              'span',
              { className: 'gcf-heat' },
              heatSquares(view.diffStat).map((kind, index) => h('i', { key: index, className: kind })),
            ),
          ),
        );
      }
      if (typeof onToggle === 'function') {
        chips.push(
          h(
            'button',
            {
              key: 'toggle',
              type: 'button',
              className: 'gcf-chip gcf-chip--toggle',
              'aria-expanded': expanded === true,
              onClick: onToggle,
            },
            expanded === true ? t('action.collapse') : t('action.expand'),
          ),
        );
      }
      return h('div', { className: 'gcf-chips', 'data-gcf': 'chips' }, chips);
    }

    function RepositoryList({ repositories, t, collapsed = false, onToggle, pending, onSelectRepo }) {
      const bodyRef = useBodyRef(collapsed);
      return h(
        'div',
        { className: 'gcf-dock', 'data-gcf': 'dock' },
        h(Reveal, null,
          h(
            'section',
            { className: 'gcf-card', 'data-gcf': 'repositories' },
            h(
              'header',
              { className: 'gcf-head' },
              h('span', { className: 'gcf-glyph' }, h(BranchGlyph)),
              h('span', { className: 'gcf-title' }, format(t, 'repos.title', { n: repositories.length })),
              h(Toggle, { collapsed, onToggle, t }),
            ),
            h(PendingLine, { pending, t }),
            h(
              'div',
              {
                className: 'gcf-body',
                ref: bodyRef,
                'data-gcf': 'body',
                'aria-hidden': collapsed,
              },
              h(
                'div',
                { className: 'gcf-body-inner' },
                h(
                  'div',
                  { className: 'gcf-rows' },
                  repositories.map((repo, index) =>
                    h(
                      'div',
                      {
                        key: repo.name,
                        className: 'gcf-repo-row',
                        'data-gcf': 'repo',
                        role: typeof onSelectRepo === 'function' ? 'button' : undefined,
                        tabIndex: typeof onSelectRepo === 'function' ? 0 : undefined,
                        style: { '--gcf-i': String(index) },
                        onClick: typeof onSelectRepo === 'function' ? () => onSelectRepo(repo.name) : undefined,
                        onKeyDown: typeof onSelectRepo === 'function'
                          ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectRepo(repo.name); } }
                          : undefined,
                      },
                      h('span', { className: 'gcf-repo-name' }, repo.name),
                      h('span', { className: 'gcf-repo-branch' }, repo.detached ? t('branch.detachedShort') : repo.branch ?? t('branch.unknown')),
                      h(
                        'span',
                        { className: `gcf-repo-state${repo.clean ? '' : ' is-dirty'}` },
                        repo.clean ? t('status.clean') : format(t, 'status.changes', { n: repo.changed }),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    }

    function GitFlowView({ view, t, now, collapsed = false, onToggle, onAction, reviewing = false, notice = null, onSelectRepo, onBack, selectedRepo, conflictPeekHunks = null, sessionRunning = false }) {
      if (view === undefined || view === null) return null;
      if (view.presence !== 'repo') {
        if (Array.isArray(view.repositories) && view.repositories.length > 0) {
          return h(RepositoryList, { repositories: view.repositories, t, collapsed, onToggle, pending: view.pending, onSelectRepo });
        }
        if (view.pending !== null && view.pending !== undefined) {
          return h(
            'div',
            { className: 'gcf-dock', 'data-gcf': 'dock' },
            h(
              'section',
              { className: 'gcf-card', 'data-gcf': 'card', 'data-phase': 'pending', 'aria-label': t('app.title') },
              h(
                'header',
                { className: 'gcf-head' },
                h('span', { className: 'gcf-glyph' }, h(BranchGlyph)),
                h('span', { className: 'gcf-title' }, t('app.title')),
              ),
              h(PendingLine, { pending: view.pending, t }),
            ),
          );
        }
        return null;
      }

      return h(RepositoryCard, { key: view.repoRoot ?? selectedRepo ?? 'repo', view, t, now, collapsed, onToggle,
        onAction, reviewing, notice, onSelectRepo, onBack, selectedRepo, conflictPeekHunks, sessionRunning });
    }

    function RepositoryCard({ view, t, now, collapsed, onToggle, onAction, reviewing, notice, onBack, selectedRepo, conflictPeekHunks, sessionRunning }) {
      // Conflict files are shown as a separate list below the graph, not as
      // graph rows, so the SVG y-coordinates stay correct.
      const conflictRows = (view.conflictRows ?? []).map((row) => ({ ...row, kind: 'conflict' }));
      const graphRows = view.rows;
      const completion = completionOf(view);
      const busy = Boolean(view.pending) || reviewing || (sessionRunning && view.counts.conflicts > 0 && !completion);
      const graphBusy = view.pending ? view.pending.phase === 'running' : busy;

      const bodyRef = useBodyRef(collapsed);
      // cardWrapRef drives the outer grid collapse — the entire card incl. header.
      const cardWrapRef = useBodyRef(collapsed);

      const card = h(
            Reveal,
            null,
            h(
              'section',
              {
                className: `gcf-card${view.phase === 'conflicts' ? ' is-conflict' : ''}${stateOf(view) === 'merged' ? ' is-merged' : ''}`,
                'data-gcf': 'card',
                'data-phase': view.phase,
                'aria-label': t('app.title'),
              },
              h(CardHeader, { view, t, collapsed, onToggle, scrambleStatus: true, onBack, repoName: selectedRepo }),
              h(PendingLine, { pending: view.pending, t }),
              h(
                'div',
                { className: 'gcf-body', ref: bodyRef, 'data-gcf': 'body', 'aria-hidden': collapsed },
                h(
                  'div',
                  { className: 'gcf-body-inner' },
                  h(GraphSection, { rows: graphRows, edges: view.edges ?? [], t, now, hasPending: graphBusy, completion }),
                  view.hiddenCommits > 0
                    ? h('div', { className: 'gcf-more' }, format(t, 'rows.more', { n: view.hiddenCommits }))
                    : null,
                  h(ConflictList, { rows: conflictRows, view, t, conflictPeekHunks, completion }),
                  Array.isArray(view.checks) && view.checks.length > 0
                    ? h(
                        'div',
                        { className: 'gcf-checks', 'data-gcf': 'checks' },
                        view.checks.map((check) =>
                          h(
                            'span',
                            { key: check.id, className: `gcf-check is-${check.state ?? 'passed'}` },
                            h(CheckGlyph),
                            h('span', { className: 'gcf-check-label' }, check.label),
                          ),
                        ),
                      )
                    : null,
                  h(
                    'footer',
                    { className: 'gcf-foot' },
                    notice !== null
                      ? h('span', { className: 'gcf-foot-note', role: 'status', 'data-gcf': 'notice' }, notice)
                      : h(
                          'span',
                          { className: `gcf-foot-state is-${stateOf(view)}` },
                          h('i', null),
                          h(ChangeText, { text: activityText(view, t, reviewing, sessionRunning) }),
                        ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: `gcf-action${view.counts.conflicts > 0 ? ' is-warn' : ''}`,
                        disabled: busy || typeof onAction !== 'function'
                          || (view.counts.conflicts === 0 && view.clean === true),
                        title: reviewing ? t('action.reviewing') : (view.pending !== null ? t('action.pending') : undefined),
                        'data-gcf': view.counts.conflicts > 0 ? 'resolve' : 'commit',
                        onClick: onAction,
                      },
                      h('span', { className: `gcf-button-busy${busy ? ' is-visible' : ''}`, 'aria-hidden': !busy }, h(Spinner)),
                      h(ChangeText, { text: busy ? t(view.pending?.phase === 'awaiting-approval' ? 'pending.awaiting' : 'action.resolving')
                        : view.clean && completion?.outcome === 'succeeded' ? t('action.done') : view.counts.conflicts > 0 ? t('action.resolve') : t('action.commit') }),
                    ),
                  ),
                ),
              ),
            ),
          );

      return h(
        'div',
        { className: 'gcf-dock', 'data-gcf': 'dock' },
        // gcf-card-wrap animates the entire card (header + body) via grid-template-rows.
        h('div', { className: 'gcf-card-wrap', ref: cardWrapRef, 'aria-hidden': collapsed },
          h('div', null, card),
        ),
        h(Chips, { view, t, onToggle, expanded: !collapsed }),
      );
    }

    function GitFlowDock({ projection, sessionId, t, sendReview, sessionStore }) {
      const subscribe = React.useCallback(
        (notify) => (projection === null || projection === undefined ? () => {} : projection.subscribe(notify)),
        [projection],
      );
      const getSnapshot = React.useCallback(
        () => (projection === null || projection === undefined ? undefined : projection.getSnapshot()),
        [projection],
      );
      const projected = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
      const subscribeSession = React.useCallback((notify) => sessionStore?.subscribe(notify) ?? (() => {}), [sessionStore]);
      const readRunning = React.useCallback(() => sessionStore?.getSnapshot()?.running === true, [sessionStore]);
      const sessionRunning = React.useSyncExternalStore(subscribeSession, readRunning, () => false);

      // selectedRepo: name of the sub-repository the user drilled into, or null
      // for the container-level list.
      const [selectedRepo, setSelectedRepo] = React.useState(null);

      // Live status: the card reflects the repository now, not only after a
      // tool call. The projection stays as the fallback (and as the audit
      // trail of what the model saw).
      const [live, setLive] = React.useState(null);
      React.useEffect(() => {
        if (typeof document === 'undefined' || typeof fetch !== 'function') return () => {};
        let cancelled = false;
        let inFlight = false;
        const controller = new AbortController();

        const load = async () => {
          if (cancelled || inFlight || document.hidden === true) return;
          inFlight = true;
          try {
            const response = await fetch(statusUrl(sessionId, selectedRepo), {
              signal: controller.signal,
              headers: { accept: 'application/json' },
              cache: 'no-store',
            });
            if (!response.ok) {
              console.warn('git-control-flow: status route returned', response.status);
              return;
            }
            const payload = await response.json();
            if (!cancelled) setLive(payload);
          } catch {
            /* keep the last known value */
          } finally { inFlight = false; }
        };

        load();
        const timer = setInterval(load, projected?.pending || sessionRunning ? 1000 : POLL_MS);
        const onFocus = () => load();
        window.addEventListener('focus', onFocus);
        return () => {
          cancelled = true;
          clearInterval(timer);
          controller.abort();
          window.removeEventListener('focus', onFocus);
        };
      }, [sessionId, selectedRepo, projected?.revision, projected?.pending?.phase, sessionRunning]);

      const [collapsed, setCollapsed] = React.useState(() => readCollapsed(sessionId));
      React.useEffect(() => {
        setCollapsed(readCollapsed(sessionId));
      }, [sessionId]);
      React.useEffect(() => {
        writeCollapsed(sessionId, collapsed);
      }, [sessionId, collapsed]);

      const toggle = React.useCallback(() => {
        setCollapsed((value) => !value);
      }, []);

      const onSelectRepo = React.useCallback((name) => {
        setSelectedRepo(name);
        setLive(null);
      }, []);

      const onBack = React.useCallback(() => {
        setSelectedRepo(null);
        setLive(null);
      }, []);

      // Prefer the newest snapshot of THIS repository. Projection changes also
      // trigger a fresh read, so tool completion never waits six seconds.
      const sameRepo = live?.repoRoot && live.repoRoot === projected?.repoRoot;
      const facts = sameRepo && (projected.readAt ?? 0) >= (live.readAt ?? 0) ? projected : live ?? (selectedRepo === null ? projected : null);
      const view = facts && projected ? { ...facts, pending: projected.pending ?? null,
        completion: sameRepo ? projected.completion ?? null : facts.completion ?? null } : facts;

      // onAction: the primary button (commit / resolve). Reads the review
      // payload for the repository on screen and injects it as a user
      // message, so the LLM reviews first and then calls git_flow itself.
      // Anything that cannot be sent becomes a short notice in the footer.
      const [reviewing, setReviewing] = React.useState(false);
      const [notice, setNotice] = React.useState(null);
      // conflictPeekHunks: parsed from the diff payload while conflicts are active.
      // shape: { [path: string]: { ours: string, theirs: string }[] }
      const [conflictPeekHunks, setConflictPeekHunks] = React.useState(null);
      React.useEffect(() => {
        if (notice === null) return () => {};
        const timer = setTimeout(() => setNotice(null), NOTICE_MS);
        return () => clearTimeout(timer);
      }, [notice]);
      React.useEffect(() => {
        setNotice(null);
        setConflictPeekHunks(null);
      }, [sessionId, selectedRepo]);

      // Lazily fetch conflict peek data when the view shows conflicts.
      const viewConflicts = view?.counts?.conflicts ?? 0;
      React.useEffect(() => {
        if (viewConflicts === 0) { setConflictPeekHunks(null); return () => {}; }
        let cancelled = false;
        (async () => {
          try {
            const resp = await fetch(diffUrl(sessionId, selectedRepo), { headers: { accept: 'application/json' }, cache: 'no-store' });
            if (!resp.ok || cancelled) return;
            const payload = await resp.json();
            if (cancelled) return;
            if (payload.kind === 'conflicts' && typeof payload.patch === 'string') {
              setConflictPeekHunks(parseConflictPeek(payload.patch));
            }
          } catch { /* non-fatal: popover stays empty */ }
        })();
        return () => { cancelled = true; };
      }, [sessionId, selectedRepo, viewConflicts]);

      const onAction = React.useCallback(async () => {
        if (reviewing) return;
        if (typeof sendReview !== 'function') {
          setNotice(t('notice.unavailable'));
          return;
        }
        setReviewing(true);
        setNotice(null);
        try {
          const resp = await fetch(diffUrl(sessionId, selectedRepo), { headers: { accept: 'application/json' }, cache: 'no-store' });
          if (!resp.ok) {
            setNotice(t('notice.failed'));
            return;
          }
          const payload = await resp.json();
          if (payload.kind === 'clean') {
            setNotice(t('notice.clean'));
            return;
          }
          if (payload.kind !== 'diff' && payload.kind !== 'conflicts') {
            setNotice(t('notice.failed'));
            return;
          }
          await sendReview(buildReviewMessage(payload, selectedRepo));
        } catch {
          setNotice(t('notice.failed'));
        } finally {
          setReviewing(false);
        }
      }, [sessionId, selectedRepo, sendReview, reviewing, t]);

      return h(GitFlowView, { view, t, now: Date.now(), collapsed, onToggle: toggle, onAction, reviewing, notice, onSelectRepo, onBack, selectedRepo, conflictPeekHunks, sessionRunning });
    }

    return {
      inject: ['slots', 'locale', 'sessions'],
      /** Exposed for the contract smoke test; the module loader ignores extra fields. */
      components: { GitFlowView, GitFlowDock, GitFlowApproval },
      motion: { graphTarget, interpolateGraph, motionEase, timings: MOTION },
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { zh, en }),
          'git-control-flow: dictionaries',
        );
        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {};
          const existing = document.getElementById(STYLE_ID);
          if (existing !== null) return () => existing.remove();
          const style = document.createElement('style');
          style.id = STYLE_ID;
          style.dataset.plugin = '@local/dsh-git-control-flow';
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => style.remove();
        }, 'git-control-flow: styles');
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'git-control-flow',
              order: 10,
              locale: NS,
              inject: (sessionId) => {
                const binding = ctx.sessions.binding(sessionId);
                return {
                  sessionId,
                  sessionStore: binding?.session ?? null,
                  projection:
                    binding === undefined
                      ? null
                      : binding.session.projections.faceOf(PROJECTION_KEY),
                  // sendReview: inject a user message into this session so the
                  // LLM can review the staged diff before committing.
                  sendReview: binding === undefined
                    ? null
                    : (text) => binding.session.prompt([{ type: 'text', text }], 'queue'),
                };
              },
            },
            GitFlowDock,
          ),
        );
      },
    };
  },
});
