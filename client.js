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

    /** Same-origin URL for the Host status route; the session id is the only input. */
    function statusUrl(sessionId) {
      return new URL(`${STATUS_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, document.baseURI).toString();
    }

    function diffUrl(sessionId) {
      return new URL(`${DIFF_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, document.baseURI).toString();
    }

    /** Build the user-visible review request message injected into the session. */
    function buildReviewMessage(diff, t) {
      const lines = [];
      const lang = document.documentElement.lang || 'zh';
      const isChinese = lang.startsWith('zh');

      if (isChinese) {
        lines.push('请帮我 review 以下暂存的改动，检查是否有敏感信息或风险，然后生成合适的 commit message 并提交。');
      } else {
        lines.push('Please review the following staged changes, check for any sensitive information or risks, then generate an appropriate commit message and commit.');
      }

      if (diff.author.name === null || diff.author.email === null) {
        lines.push('');
        lines.push(isChinese
          ? '⚠️ 注意：git config 中未配置 user.name 或 user.email，提交前请先询问我。'
          : '⚠️ Note: git config user.name or user.email is not set. Please ask me for these before committing.');
      }

      lines.push('');
      lines.push(isChinese ? `分支：${diff.branch}，已暂存 ${diff.stagedCount} 个文件` : `Branch: ${diff.branch}, ${diff.stagedCount} staged file(s)`);

      if (diff.stat) {
        lines.push('');
        lines.push('```');
        lines.push(diff.stat);
        lines.push('```');
      }

      if (diff.patch) {
        lines.push('');
        lines.push(isChinese ? '**改动内容（已过滤敏感信息）：**' : '**Diff (sensitive lines redacted):**');
        lines.push('');
        lines.push('```diff');
        lines.push(diff.patch);
        lines.push('```');
      }

      if (diff.truncated) {
        lines.push('');
        lines.push(isChinese ? '_（diff 过大，已截断）_' : '_(diff truncated — too large)_');
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
    function CardHeader({ view, t, collapsed, onToggle, scrambleStatus }) {
      const pr = view.pr ?? null;
      const title = pr !== null && typeof pr.title === 'string' ? pr.title : branchText(view, t);
      const number = pr !== null && Number.isInteger(pr.number) ? `#${pr.number}` : null;
      const state = stateText(view, t);
      return h(
        'header',
        { className: 'gcf-head' },
        h('span', { className: 'gcf-title', title }, title),
        number === null ? null : h('span', { className: 'gcf-prnum' }, number),
        h(
          'span',
          { className: `gcf-state is-${stateOf(view)}` },
          h('i', null),
          scrambleStatus === true ? h(Scramble, { text: state }) : state,
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
      if (pending === null || pending === undefined) return null;
      const label = pending.phase === 'awaiting-approval' ? t('pending.awaiting') : t('pending.running');
      return h(
        'div',
        { className: `gcf-pending is-${pending.phase}`, 'data-gcf': 'pending' },
        h(Spinner),
        h('span', { className: 'gcf-pending-label' }, label),
        typeof pending.reason === 'string' && pending.reason !== ''
          ? h('span', { className: 'gcf-pending-reason', title: pending.reason }, pending.reason)
          : null,
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
      const approvalRows = view === null ? [] : [...view.rows];
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
          view !== null
            ? h(CardHeader, { view, t, collapsed: false, scrambleStatus: false })
            : h(
                'header',
                { className: 'gcf-head' },
                h('span', { className: 'gcf-glyph' }, h(BranchGlyph)),
                h('span', { className: 'gcf-title' }, t('app.title')),
              ),
          h(PendingLine, { pending, t }),
          reason !== '' ? h('div', { className: 'gcf-approval-reason' }, reason) : null,
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
  transition: grid-template-rows 360ms cubic-bezier(0.4, 0, 0.2, 1);
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
  transition: grid-template-rows 360ms cubic-bezier(0.4, 0, 0.2, 1);
}
.gcf-card-wrap.is-open { grid-template-rows: 1fr; }
.gcf-card-wrap > * { min-height: 0; overflow: hidden; }
.gcf-reveal { }
.gcf-reveal-inner { overflow: hidden; }
.gcf-reveal .gcf-card { animation: gcf-card-grow 450ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }
.gcf-reveal.is-entered .gcf-card { animation: none; }
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
  transition: transform 320ms var(--ease, cubic-bezier(0.2, 0.8, 0.2, 1));
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
  animation: gcf-draw 700ms var(--ease, cubic-bezier(0.2, 0.8, 0.2, 1)) both 100ms;
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
@keyframes gcf-draw {
  /* Draw from bottom to top: -1 means the path is drawn in reverse. */
  from { stroke-dashoffset: -1; }
  to { stroke-dashoffset: 0; }
}
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
/* Row entrance and exit: only applied by useStableRows, not unconditionally. */
.gcf-row.is-entering {
  animation: gcf-row-in 300ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
  animation-delay: calc(var(--rev, 0) * 45ms + 60ms);
}
.gcf-row.is-exiting {
  pointer-events: none;
  opacity: 0;
  transition: opacity 260ms ease;
}
.gcf-swap {
  animation: gcf-decode 420ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
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

  flex: none;
  font-size: 13px;
  font-weight: 500;
  line-height: 24px;
  color: var(--dsw-alias-label-primary, #1d1d1f);
  white-space: nowrap;
}
`;

    const zh = {
      'app.title': 'Git 工作流',
      'branch.detached': '游离 HEAD @ {oid}',
      'branch.unknown': '未知分支',
      'tracking.ahead': '领先上游的提交数',
      'tracking.behind': '落后上游的提交数',
      'status.clean': '干净',
      'status.changes': '{n} 处变更',
      'status.conflicts': '{n} 处冲突',
      'status.merge': '合并中',
      'status.rebase': '变基中',
      'status.cherry-pick': '拣选中',
      'status.revert': '回滚中',
      'row.working': '未提交的改动',
      'row.files': '{n} 个文件',
      'rows.more': '还有 {n} 条提交',
      'repos.title': '{n} 个 Git 仓库',
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
      'row.operation.merge': 'Merge into main',
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
      'app.title': 'Git workflow',
      'branch.detached': 'detached HEAD @ {oid}',
      'branch.unknown': 'unknown branch',
      'tracking.ahead': 'Commits ahead of upstream',
      'tracking.behind': 'Commits behind upstream',
      'status.clean': 'Clean',
      'status.changes': '{n} changes',
      'status.conflicts': '{n} conflicts',
      'status.merge': 'Merging',
      'status.rebase': 'Rebasing',
      'status.cherry-pick': 'Cherry-picking',
      'status.revert': 'Reverting',
      'row.working': 'Uncommitted changes',
      'row.files': '{n} files',
      'rows.more': '{n} more commits',
      'repos.title': '{n} Git repositories',
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
      'row.operation.merge': 'Merge into main',
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
    const SCRAMBLE_MS = 420;

    function prefersReducedMotion() {
      try {
        return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch {
        return false;
      }
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
      const [entered, setEntered] = React.useState(false);
      React.useEffect(() => {
        const raf = requestAnimationFrame(() => setEntered(true));
        return () => cancelAnimationFrame(raf);
      }, []);
      return h(
        'div',
        { className: `gcf-reveal${entered ? ' is-entered' : ''}` },
        children,
      );
    }

    /** Branch glyph: one trunk with a forked commit, drawn for this plugin. */
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

    /** One state word for the header pill: open / conflicts / ready / merged. */
    function stateOf(view) {
      if (view.pr !== null && view.pr !== undefined && typeof view.pr.state === 'string') return view.pr.state;
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

    /**
     * The whole card's graph in one SVG (replica render.ts): long edges between
     * rows, nodes on top, draw-on animation via `pathLength`.
     */
    /**
     * Stable keyed row list: nodes survive re-renders so CSS
     * `transition: transform` can slide them when --y changes.
     * New rows get `is-entering`; removed rows get `is-exiting` and are
     * removed from the DOM after 300ms (or immediately if reduced-motion).
     */
    function useStableRows(nextRows, reduced) {
      // stableMap: id → { row, y } for currently rendered rows.
      const stableRef = React.useRef(new Map());
      // exitSet: id → true, rows fading out but not yet removed.
      const exitRef = React.useRef(new Set());
      const [tick, setTick] = React.useState(0);
      const bump = React.useCallback(() => setTick((n) => n + 1), []);

      // Derive the next stable map from the incoming rows.
      const nextIds = new Set(nextRows.map((r) => r.id));
      const prevIds = new Set(stableRef.current.keys());

      // Added rows: mark as entering.
      const entering = new Set();
      for (const row of nextRows) {
        if (!prevIds.has(row.id) && !exitRef.current.has(row.id)) entering.add(row.id);
      }

      // Removed rows: start exit timer.
      React.useEffect(() => {
        for (const id of prevIds) {
          if (!nextIds.has(id) && !exitRef.current.has(id)) {
            exitRef.current.add(id);
            if (reduced) {
              exitRef.current.delete(id);
              stableRef.current.delete(id);
            } else {
              const timerId = setTimeout(() => {
                exitRef.current.delete(id);
                stableRef.current.delete(id);
                bump();
              }, 300);
              // Ignore cleanup: the timeout is short and bump is stable.
              void timerId;
            }
          }
        }
        bump();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [nextRows]);

      // Rebuild the stable map for this render.
      const newMap = new Map();
      // Keep existing rows (including those exiting).
      for (const [id, entry] of stableRef.current) newMap.set(id, entry);
      // Update y for rows that stayed, add new ones.
      nextRows.forEach((row, index) => {
        newMap.set(row.id, { row, y: index * ROW_HEIGHT });
      });
      stableRef.current = newMap;

      // Build ordered output: next-order first, then exiting rows at the end.
      const ordered = nextRows.map((row, index) => ({
        row,
        y: index * ROW_HEIGHT,
        entering: entering.has(row.id),
        exiting: false,
      }));
      for (const [id, entry] of newMap) {
        if (exitRef.current.has(id)) {
          ordered.push({ row: entry.row, y: entry.y, entering: false, exiting: true });
        }
      }
      return ordered;
    }

    function GraphSection({ rows, edges, t, now, reduced }) {
      const entries = useStableRows(rows, reduced);
      const graphHeight = rows.length * ROW_HEIGHT;
      return h(
        'div',
        { className: 'gcf-graph', style: { height: `${graphHeight}px` } },
        h(GraphRail, { rows, edges }),
        h(
          'div',
          { className: 'gcf-rows', 'data-gcf': 'rows' },
          entries.map(({ row, y, entering, exiting }, index) =>
            h(Row, {
              key: exiting ? `exit:${row.id}` : row.id,
              row,
              t,
              now,
              index: Math.round(y / ROW_HEIGHT),
              total: rows.length,
              scramble: !exiting && row.kind === 'commit' && index === 0,
              entering,
              exiting,
            }),
          ),
        ),
      );
    }

    function GraphRail({ rows, edges }) {
      const commits = rows.filter((row) => row.kind === 'commit');
      const maxLane = Math.max(0, ...commits.map((row) => (Number.isInteger(row.lane) ? row.lane : 0)));
      const width = LANE_X0 * 2 + (maxLane + 1) * LANE_WIDTH;
      const height = rows.length * ROW_HEIGHT;
      // index < 0 → top of window (y=0); index >= rows.length → bottom (y=height)
      const y = (index) => (index < 0 ? 0 : index >= rows.length ? height : index * ROW_HEIGHT + ROW_HEIGHT / 2);
      const x = (lane) => LANE_X0 + lane * LANE_WIDTH;
      const edgeParts = [];
      const nodeParts = [];

      for (const edge of edges) {
        const x1 = x(edge.fromLane);
        const x2 = x(edge.toLane);
        // Skip continuation edges (no node at one end) — they look broken regardless
        // of styling. The "N more commits" footer already signals truncated history.
        if (edge.from < 0 || edge.to >= rows.length) continue;

        const y1 = y(edge.from);
        const y2 = y(edge.to);
        const bend = Math.max(y1, y2 - ROW_HEIGHT);
        const mid = (bend + y2) / 2;
        const tone = laneTone(edge.fromLane === 0 ? edge.toLane : edge.fromLane);
        edgeParts.push(
          h('path', {
            key: `e${edge.from}>${edge.to}>${edge.fromLane}`,
            className: `gcf-edge t-${tone}`,
            d: `M${x1} ${y1}L${x1} ${bend}C${x1} ${mid},${x2} ${mid},${x2} ${y2}`,
            pathLength: 1,
          }),
        );
      }

      rows.forEach((row, index) => {
        if (row.kind !== 'commit') {
          // working/operation rows get a distinct node in the rail at lane 0.
          if (row.kind === 'working' || row.kind === 'operation') {
            const cx = x(0), cy = y(index);
            if (row.kind === 'operation') {
              // Merge/rebase in-progress: filled amber dot with white halo
              const fill = row.operation === 'merge' ? 'var(--warn, #e3a21a)' : 'var(--base, #bdbdbd)';
              nodeParts.push(h('g', { key: `n${row.id}`, transform: `translate(${cx} ${cy})` },
                h('circle', { r: 9, fill: 'var(--dsw-alias-bg-layer-1, #fff)' }),
                h('circle', { r: 6, fill }),
              ));
            } else {
              // Working changes: hollow dashed ring with white background halo
              nodeParts.push(h('g', { key: `n${row.id}`, transform: `translate(${cx} ${cy})` },
                h('circle', { r: 7, fill: 'var(--dsw-alias-bg-layer-1, #fff)' }),
                h('circle', {
                  r: 5, fill: 'none',
                  stroke: 'var(--base-line, #dedede)',
                  strokeWidth: 1.5,
                  strokeDasharray: '3 3',
                }),
              ));
            }
          }
          return;
        }
        const lane = Number.isInteger(row.lane) ? row.lane : 0;
        // White halo ring before the coloured dot so the line visually stops
        // short of the node — matching the reference video gap.
        nodeParts.push(
          h(
            'g',
            { key: `n${row.id}`, className: `gcf-node t-${toneOfRow(row)}`, transform: `translate(${x(lane)} ${y(index)})` },
            h('circle', { r: 6.5, fill: 'var(--dsw-alias-bg-layer-1, #fff)' }),
            h('circle', { className: 'gcf-n-dot', r: 3.5 }),
          ),
        );
      });

      // Edges rendered first, nodes on top — so nodes cover the lines at their centers.
      return h(
        'svg',
        { className: 'gcf-rail', width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': true },
        null,
        h('g', { className: 'gcf-edges' }, edgeParts),
        h('g', { className: 'gcf-nodes' }, nodeParts),
      );
    }

    function shortRef(name) {
      return name.startsWith('origin/') ? name.slice('origin/'.length) : name;
    }

    function Row({ row, t, now, index, total, scramble, entering, exiting }) {
      const motionClass = exiting ? ' is-exiting' : (entering === false ? '' : ' is-entering');
      if (row.kind === 'operation') {
        return h(
          'div',
          {
            className: `gcf-row gcf-row--operation${motionClass}`,
            'data-gcf': 'row',
            'data-kind': 'operation',
            style: { '--gcf-i': String(index), '--y': `${index * ROW_HEIGHT}px` },
          },
          h('span', { className: 'gcf-op-icon' }, h(WarnGlyph)),
          h('span', { className: 'gcf-subject' }, format(t, `row.operation.${row.operation}`)),
          h(
            'span',
            { className: `gcf-meta${row.conflicts > 0 ? ' is-warn' : ''}` },
            row.conflicts > 0 ? format(t, 'row.conflicts', { n: row.conflicts }) : t('row.merging'),
          ),
        );
      }
      if (row.kind === 'conflict') {
        return h(
          'div',
          {
            className: 'gcf-row gcf-row--conflict',
            'data-gcf': 'row',
            'data-kind': 'conflict',
            style: { '--gcf-i': String(index), '--y': `${index * ROW_HEIGHT}px` },
          },
          h('span', { className: 'gcf-badge', 'aria-hidden': true }, String(row.index)),
          h('span', { className: 'gcf-subject' }, row.path),
          h('span', { className: 'gcf-meta' }, h('code', null, row.code)),
        );
      }
      if (row.kind === 'working') {
        return h(
          'div',
          {
            className: `gcf-row gcf-row--working${motionClass}`,
            'data-gcf': 'row',
            'data-kind': 'working',
            style: {
              '--gcf-i': String(index),
              '--rev': String(Math.max(0, (total ?? index + 1) - 1 - index)),
              '--y': `${index * ROW_HEIGHT}px`,
            },
          },
          h('span', { className: 'gcf-rail-wait' }, h(Spinner)),
          h('span', { className: 'gcf-subject' }, t('row.working')),
          h('span', { className: 'gcf-meta' }, format(t, 'row.files', { n: row.files })),
        );
      }
      return h(
        'div',
        {
          className: `gcf-row${(row.lane ?? 0) === 0 ? ' is-strong' : ''}${motionClass}`,
          'data-gcf': 'row',
          'data-kind': 'commit',
          style: {
            '--gcf-i': String(index),
            '--rev': String(Math.max(0, (total ?? index + 1) - 1 - index)),
            '--y': `${index * ROW_HEIGHT}px`,
          },
        },
        h(
          'span',
          { className: 'gcf-subject' },
          scramble ? h(Scramble, { text: row.subject }) : row.subject,
        ),
        h(
          'span',
          { className: 'gcf-meta' },
          Array.isArray(row.refs) && row.refs.length > 0
            ? h(
                'span',
                { className: 'gcf-pills' },
                // Deduplicate by display name (e.g. HEAD -> feat/x and feat/x
                // both shorten to the same label; keep the first / higher-priority one).
                row.refs.reduce((acc, ref) => {
                  const label = shortRef(ref.name);
                  if (!acc.seen.has(label)) { acc.seen.add(label); acc.list.push(ref); }
                  return acc;
                }, { seen: new Set(), list: [] }).list.slice(0, 2).map((ref) =>
                  h('span', { key: ref.name, className: `gcf-pill is-${ref.kind}` }, shortRef(ref.name)),
                ),
              )
            : null,
          h('code', null, row.id),
          h('span', null, row.author),
          h('span', null, relativeTime(row.time, now, t)),
        ),
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
          expanded ? stateText(view, t) : branchName,
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
            h('b', null, `+${view.diffStat.add}`),
            h('em', null, `\u2212${view.diffStat.del}`),
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

    function RepositoryList({ repositories, t, collapsed = false, onToggle, pending }) {
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
                        style: { '--gcf-i': String(index) },
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

    function GitFlowView({ view, t, now, collapsed = false, onToggle, onAction, reviewing = false }) {
      if (view === undefined || view === null) return null;
      if (view.presence !== 'repo') {
        if (Array.isArray(view.repositories) && view.repositories.length > 0) {
          return h(RepositoryList, { repositories: view.repositories, t, collapsed, onToggle, pending: view.pending });
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

      // Conflict files are shown as a separate list below the graph, not as
      // graph rows, so the SVG y-coordinates stay correct.
      const conflictRows = (view.conflictRows ?? []).map((row) => ({ ...row, kind: 'conflict' }));
      const graphRows = view.rows;

      const bodyRef = useBodyRef(collapsed);
      // cardWrapRef drives the outer grid collapse — the entire card incl. header.
      const cardWrapRef = useBodyRef(collapsed);

      const card = h(
            Reveal,
            null,
            h(
              'section',
              {
                className: `gcf-card${view.phase === 'conflicts' ? ' is-conflict' : ''}`,
                'data-gcf': 'card',
                'data-phase': view.phase,
                'aria-label': t('app.title'),
              },
              h(CardHeader, { view, t, collapsed, onToggle, scrambleStatus: true }),
              h(PendingLine, { pending: view.pending, t }),
              h(
                'div',
                { className: 'gcf-body', ref: bodyRef, 'data-gcf': 'body', 'aria-hidden': collapsed },
                h(
                  'div',
                  { className: 'gcf-body-inner' },
                  h(GraphSection, { rows: graphRows, edges: view.edges ?? [], t, now, reduced: prefersReducedMotion() }),
                  view.hiddenCommits > 0
                    ? h('div', { className: 'gcf-more' }, format(t, 'rows.more', { n: view.hiddenCommits }))
                    : null,
                  // Conflict files are listed below the graph with amber badges.
                  conflictRows.length > 0
                    ? h(
                        'div',
                        { className: 'gcf-conflict-list', 'data-gcf': 'conflict-list' },
                        conflictRows.map((row, index) =>
                          h(
                            'div',
                            {
                              key: row.id,
                              className: 'gcf-row gcf-row--conflict',
                              'data-gcf': 'conflict-row',
                              style: { '--gcf-i': String(index), '--rev': String(Math.max(0, conflictRows.length - 1 - index)) },
                            },
                            h('span', { className: 'gcf-badge', 'aria-hidden': true }, String(row.index)),
                            h('span', { className: 'gcf-subject' }, row.path),
                            h('span', { className: 'gcf-meta' }, h('code', null, row.code)),
                          ),
                        ),
                      )
                    : null,
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
                    h(
                      'span',
                      { className: `gcf-foot-state is-${stateOf(view)}` },
                      h('i', null),
                      view.counts.conflicts > 0
                        ? format(t, 'foot.conflicts', { n: view.counts.conflicts })
                        : statusText(view, t),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: `gcf-action${view.counts.conflicts > 0 ? ' is-warn' : ''}`,
                        disabled: reviewing || view.pending !== null || typeof onAction !== 'function',
                        title: reviewing ? t('action.reviewing') : (view.pending !== null ? t('action.pending') : undefined),
                        'data-gcf': view.counts.conflicts > 0 ? 'resolve' : 'commit',
                        onClick: onAction,
                      },
                      reviewing
                        ? h('span', { className: 'gcf-action-spinner' }, h(Spinner))
                        : (view.counts.conflicts > 0 ? t('action.resolve') : t('action.commit')),
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

    function GitFlowDock({ projection, sessionId, t, sendReview }) {
      const subscribe = React.useCallback(
        (notify) => (projection === null || projection === undefined ? () => {} : projection.subscribe(notify)),
        [projection],
      );
      const getSnapshot = React.useCallback(
        () => (projection === null || projection === undefined ? undefined : projection.getSnapshot()),
        [projection],
      );
      const projected = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

      // Live status: the card reflects the repository now, not only after a
      // tool call. The projection stays as the fallback (and as the audit
      // trail of what the model saw).
      const [live, setLive] = React.useState(null);
      React.useEffect(() => {
        if (typeof document === 'undefined' || typeof fetch !== 'function') return () => {};
        let cancelled = false;
        setLive(null);

        const load = async () => {
          if (typeof document !== 'undefined' && document.hidden === true) return;
          try {
            const response = await fetch(statusUrl(sessionId), {
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
          }
        };

        load();
        const timer = setInterval(load, POLL_MS);
        const onFocus = () => load();
        window.addEventListener('focus', onFocus);
        return () => {
          cancelled = true;
          clearInterval(timer);
          window.removeEventListener('focus', onFocus);
        };
      }, [sessionId]);

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

      const view = live ?? projected;

      // onAction: handles the primary button click (commit / resolve).
      // Fetches staged diff, builds a review message, and injects it as a
      // user message so the LLM reviews and then calls git_flow commit/resolve.
      const [reviewing, setReviewing] = React.useState(false);
      const onAction = React.useCallback(async () => {
        if (reviewing || typeof sendReview !== 'function') return;
        setReviewing(true);
        try {
          const resp = await fetch(diffUrl(sessionId), { headers: { accept: 'application/json' }, cache: 'no-store' });
          if (!resp.ok) return;
          const diff = await resp.json();
          if (diff.kind !== 'diff') return;
          const message = buildReviewMessage(diff, t);
          await sendReview(message);
        } catch {
          /* silently fail — user can retry */
        } finally {
          setReviewing(false);
        }
      }, [sessionId, sendReview, reviewing, t]);

      return h(GitFlowView, { view, t, now: Date.now(), collapsed, onToggle: toggle, onAction, reviewing });
    }

    return {
      inject: ['slots', 'locale', 'sessions'],
      /** Exposed for the contract smoke test; the module loader ignores extra fields. */
      components: { GitFlowView, GitFlowDock, GitFlowApproval },
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
        // Take over the composer only for our own approvals: the card carries
        // the decision, so it stays in place and the chat area makes room for
        // it instead of the stock panel replacing the input area.
        ctx.slots.inject('conversation.composer', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer',
              // Chain entries are tried in ascending priority and the first
              // non-null selection wins; the stock approval panel sits at 1,
              // so ours has to be tried before it.
              priority: 0.5,
              locale: NS,
              select: ({ pendingInteraction }) => {
                if (pendingInteraction === null || pendingInteraction === undefined) return null;
                if (pendingInteraction.kind !== 'approval') return null;
                return pendingInteraction.toolName === 'git_flow' ? pendingInteraction : null;
              },
            },
            GitFlowApproval,
          ),
        );
      },
    };
  },
});
