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
    const STATUS_ROUTE = 'api/git-flow.status';
    const POLL_MS = 6000;

    /** Same-origin URL for the Host status route; the session id is the only input. */
    function statusUrl(sessionId) {
      return new URL(`${STATUS_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, document.baseURI).toString();
    }

    const COLLAPSE_KEY = 'gcf:collapsed:';

    /**
     * The dock lives inside the composer fallback, which the host replaces with
     * the approval panel while an approval is pending. This module-level store
     * keeps the last session and view so a `shell.overlay` entry can keep
     * showing the pending card for exactly that window.
     */
    const pendingListeners = new Set();
    let pendingSnapshot = { sessionId: null, view: null };

    function publishPendingState(sessionId, view) {
      const next = { sessionId, view: view ?? null };
      if (pendingSnapshot.sessionId === next.sessionId && pendingSnapshot.view === next.view) return;
      pendingSnapshot = next;
      for (const listener of pendingListeners) listener();
    }

    function subscribePending(listener) {
      pendingListeners.add(listener);
      return () => pendingListeners.delete(listener);
    }

    function usePendingState() {
      return React.useSyncExternalStore(
        subscribePending,
        () => pendingSnapshot,
        () => pendingSnapshot,
      );
    }

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

    /** Header shared by the card and by the "clean but a write is pending" shell. */
    function CardHeader({ view, t, collapsed, onToggle, scrambleStatus }) {
      const status = statusText(view, t);
      return h(
        'header',
        { className: 'gcf-head' },
        h('span', { className: 'gcf-glyph' }, h(BranchGlyph)),
        h('span', { className: 'gcf-title', title: branchText(view, t) }, branchText(view, t)),
        h(Tracking, { view, t }),
        h(
          'span',
          { className: 'gcf-status' },
          h('i', null),
          scrambleStatus === true ? h(Scramble, { text: status }) : status,
        ),
        h(Toggle, { collapsed, onToggle, t }),
      );
    }

    /** In-flight write: waiting for the approval dialog, or running after it was allowed. */
    function PendingLine({ pending, t }) {
      if (pending === null || pending === undefined) return null;
      const label = pending.phase === 'awaiting-approval' ? t('pending.awaiting') : t('pending.running');
      return h(
        'div',
        { className: `gcf-pending is-${pending.phase}`, 'data-gcf': 'pending' },
        h('span', { className: 'gcf-spinner', 'aria-hidden': true }),
        h('span', { className: 'gcf-pending-label' }, label),
        typeof pending.reason === 'string' && pending.reason !== ''
          ? h('span', { className: 'gcf-pending-reason', title: pending.reason }, pending.reason)
          : null,
      );
    }

    /** Floating copy of the pending card, shown while the approval replaces the composer. */
    function PendingOverlay({ t, view }) {
      const stored = usePendingState();
      const [polled, setPolled] = React.useState(null);

      // Robust path: the dock may be unmounted before it ever saw the pending
      // state, so the overlay asks the status route directly (the Host merges
      // the projection's pending state into that response).
      React.useEffect(() => {
        const sessionId = stored.sessionId;
        if (sessionId === null || typeof fetch !== 'function') return () => {};
        let cancelled = false;
        setPolled(null);

        const load = async () => {
          try {
            const response = await fetch(statusUrl(sessionId), {
              headers: { accept: 'application/json' },
              cache: 'no-store',
            });
            if (!response.ok) return;
            const payload = await response.json();
            if (!cancelled) setPolled(payload);
          } catch {
            /* keep the last value */
          }
        };

        load();
        const timer = setInterval(load, 4000);
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, [stored.sessionId]);

      const model =
        view !== undefined
          ? view
          : polled !== null && polled.pending !== null && polled.pending !== undefined
            ? polled
            : stored.view;
      if (model === null || model === undefined) return null;
      const pending = model.pending;
      if (pending === null || pending === undefined) return null;
      return h(
        'div',
        { className: 'gcf-overlay', 'data-gcf': 'overlay' },
        h(
          'div',
          { className: 'gcf-overlay-card', 'data-phase': pending.phase },
          h(
            'div',
            { className: 'gcf-overlay-head' },
            h('span', { className: 'gcf-glyph' }, h(BranchGlyph)),
            h(
              'span',
              { className: 'gcf-overlay-title' },
              model.presence === 'repo' ? branchText(model, t) : t('app.title'),
            ),
            model.presence === 'repo'
              ? h('span', { className: 'gcf-overlay-status' }, h('i', null), statusText(model, t))
              : null,
          ),
          h(PendingLine, { pending, t }),
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
.gcf-body {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 280ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.gcf-body.is-open { grid-template-rows: 1fr; }
.gcf-body-inner { min-height: 0; overflow: hidden; }
.gcf-reveal {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 500ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.gcf-reveal.is-open { grid-template-rows: 1fr; }
.gcf-reveal-inner { min-height: 0; overflow: hidden; }
.gcf-reveal.is-settled .gcf-reveal-inner { overflow: visible; }
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
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  animation: gcf-spin 800ms linear infinite;
}
@keyframes gcf-spin {
  to { transform: rotate(360deg); }
}
.gcf-rows {
  max-height: 38vh;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 2px 6px 6px;
}
.gcf-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  padding: 0 8px 0 30px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary, #1d1d1f);
}
.gcf-row:hover { background: var(--dsw-alias-bg-layer-2, #f6f6f6); }
.gcf-row::before {
  content: '';
  position: absolute;
  left: 17px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--gcf-rail, var(--dsw-alias-border-l1, #e8e8e8));
}
.gcf-row:first-child::before { top: 14px; }
.gcf-row:last-child::before { bottom: 50%; }
.gcf-row {
  animation: gcf-row-in 320ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
  animation-delay: calc(var(--gcf-i, 0) * 24ms);
}
@keyframes gcf-row-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
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
.gcf-repo-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 28px;
  padding: 0 14px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary, #1d1d1f);
  animation: gcf-row-in 320ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
  animation-delay: calc(var(--gcf-i, 0) * 24ms);
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
.gcf-overlay {
  position: fixed;
  top: 72px;
  right: 20px;
  z-index: 60;
  width: min(320px, calc(100vw - 40px));
  pointer-events: none;
}
.gcf-overlay-card {
  pointer-events: auto;
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
  border-radius: var(--dsw-radius-md, 10px);
  background: var(--dsw-alias-bg-layer-1, #fff);
  box-shadow: var(--dsw-elevation-panel, 0 6px 24px rgba(16, 24, 40, 0.12));
  padding: 10px 0 0;
}
.gcf-overlay-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px 6px;
}
.gcf-overlay-title {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 13px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary, #1d1d1f);
}
.gcf-overlay-status {
  flex: none;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #5f5f5f);
}
.gcf-overlay-status i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
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
@media (prefers-reduced-motion: reduce) {
  .gcf-reveal { transition: none; }
  .gcf-body { transition: none; }
  .gcf-row, .gcf-num { animation: none; }
  .gcf-status, .gcf-status i { transition: none; }
  .gcf-toggle svg { transition: none; }
  .gcf-spinner { animation: none; }
}
.gcf-label {
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
      'action.expand': '展开',
      'action.collapse': '收起',
      'pending.awaiting': '等待审批',
      'pending.running': '执行中',
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
      'action.expand': 'Expand',
      'action.collapse': 'Collapse',
      'pending.awaiting': 'Waiting for approval',
      'pending.running': 'Running',
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

    /** Bottom-up reveal for a card that appears where the composer is (video 2.5s). */
    function Reveal({ children }) {
      const [open, setOpen] = React.useState(false);
      const [settled, setSettled] = React.useState(false);
      React.useEffect(() => {
        const raf = requestAnimationFrame(() => setOpen(true));
        // Release the clipping once the growth is done so the card keeps its
        // shadow and any later content growth is not cut off.
        const timer = setTimeout(() => setSettled(true), 540);
        return () => {
          cancelAnimationFrame(raf);
          clearTimeout(timer);
        };
      }, []);
      return h(
        'div',
        { className: `gcf-reveal${open ? ' is-open' : ''}${settled ? ' is-settled' : ''}` },
        h('div', { className: 'gcf-reveal-inner' }, children),
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

    function branchText(view, t) {
      if (view.branch.detached) {
        return format(t, 'branch.detached', { oid: String(view.branch.oid ?? '').slice(0, 7) });
      }
      return view.branch.name ?? t('branch.unknown');
    }

    function Tracking({ view, t }) {
      if (view.branch.upstream === null) return null;
      return h(
        'span',
        { className: 'gcf-tracking', 'data-gcf': 'tracking' },
        h('span', { className: 'gcf-upstream' }, view.branch.upstream),
        h('span', { className: 'gcf-ahead', title: t('tracking.ahead') }, `+${view.branch.ahead}`),
        h('span', { className: 'gcf-behind', title: t('tracking.behind') }, `\u2212${view.branch.behind}`),
      );
    }

    function Row({ row, t, now, index, scramble }) {
      if (row.kind === 'working') {
        return h(
          'div',
          {
            className: 'gcf-row gcf-row--working',
            'data-gcf': 'row',
            'data-kind': 'working',
            style: { '--gcf-i': String(index) },
          },
          h('span', { className: 'gcf-dot gcf-dot--hollow' }),
          h('span', { className: 'gcf-subject' }, t('row.working')),
          h('span', { className: 'gcf-meta' }, format(t, 'row.files', { n: row.files })),
        );
      }
      return h(
        'div',
        { className: 'gcf-row', 'data-gcf': 'row', 'data-kind': 'commit', style: { '--gcf-i': String(index) } },
        h('span', { className: 'gcf-dot' }),
        h('span', { className: 'gcf-subject' }, scramble ? h(Scramble, { text: row.subject }) : row.subject),
        h(
          'span',
          { className: 'gcf-meta' },
          h('code', null, row.id),
          h('span', null, row.author),
          h('span', null, relativeTime(row.time, now, t)),
        ),
      );
    }

    function CleanBar({ view, t }) {
      return h(
        'div',
        { className: 'gcf-dock', 'data-gcf': 'dock' },
        h(
          'div',
          { className: 'gcf-bar', 'data-gcf': 'bar', 'data-phase': 'clean' },
          h('span', { className: 'gcf-glyph' }, h(BranchGlyph)),
          h('span', { className: 'gcf-label' }, branchText(view, t)),
          h(Tracking, { view, t }),
          h('span', { className: 'gcf-status', style: { marginLeft: 'auto' } }, h('i', null), t('status.clean')),
        ),
      );
    }

    function RepositoryList({ repositories, t, collapsed = false, onToggle, pending }) {
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
              className: `gcf-body${collapsed ? '' : ' is-open'}`,
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

    function GitFlowView({ view, t, now, collapsed = false, onToggle }) {
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
      if (view.phase === 'clean' && (view.pending === null || view.pending === undefined)) {
        return h(CleanBar, { view, t });
      }

      const counts = [
        view.counts.staged > 0 ? format(t, 'foot.staged', { n: view.counts.staged }) : null,
        view.counts.unstaged > 0 ? format(t, 'foot.unstaged', { n: view.counts.unstaged }) : null,
        view.counts.untracked > 0 ? format(t, 'foot.untracked', { n: view.counts.untracked }) : null,
      ].filter((part) => part !== null);

      return h(
        'div',
        { className: 'gcf-dock', 'data-gcf': 'dock' },
        h(Reveal, null,
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
            {
              className: `gcf-body${collapsed ? '' : ' is-open'}`,
              'data-gcf': 'body',
              'aria-hidden': collapsed,
            },
            h(
              'div',
              { className: 'gcf-body-inner' },
              h(
                'div',
                { className: 'gcf-rows', 'data-gcf': 'rows' },
                view.rows.map((row, index) =>
                  h(Row, { key: row.id, row, t, now, index, scramble: index === 0 }),
                ),
              ),
              view.hiddenCommits > 0
                ? h('div', { className: 'gcf-more' }, format(t, 'rows.more', { n: view.hiddenCommits }))
                : null,
              h(
                'footer',
                { className: 'gcf-foot' },
                h(
                  'span',
                  { className: 'gcf-diff' },
                  h('b', { key: `a${view.diffStat.add}`, className: 'gcf-num' }, `+${view.diffStat.add}`),
                  h('em', { key: `d${view.diffStat.del}`, className: 'gcf-num' }, `−${view.diffStat.del}`),
                ),
                h('span', { className: 'gcf-counts' }, counts.join(' · ')),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'gcf-action',
                    disabled: true,
                    title: t('action.pending'),
                    'data-gcf': 'commit',
                  },
                  t('action.commit'),
                ),
              ),
            ),
          ),
        ),
        ),
      );
    }

    function GitFlowDock({ projection, sessionId, t }) {
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
      React.useEffect(() => {
        publishPendingState(sessionId, view);
      }, [sessionId, view]);
      return h(GitFlowView, { view, t, now: Date.now(), collapsed, onToggle: toggle });
    }

    return {
      inject: ['slots', 'locale', 'sessions'],
      /** Exposed for the contract smoke test; the module loader ignores extra fields. */
      components: { GitFlowView, GitFlowDock, PendingOverlay },
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
                };
              },
            },
            GitFlowDock,
          ),
        );
        // The approval panel replaces the composer fallback, which unmounts the
        // dock; this frame-wide entry keeps the pending card visible instead.
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'git-control-flow-pending', order: 50, locale: NS },
            PendingOverlay,
          ),
        );
      },
    };
  },
});
