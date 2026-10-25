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

    const CSS = `
.gcf-dock {
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
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.gcf-card.is-conflict .gcf-status { color: var(--dsw-alias-state-error-primary, #c0394b); }
.gcf-card.is-clean .gcf-status { color: var(--dsw-alias-state-success-primary, #2e8f55); }
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
  background: var(--dsw-alias-border-l1, #e8e8e8);
}
.gcf-row:first-child::before { top: 14px; }
.gcf-row:last-child::before { bottom: 50%; }
.gcf-dot {
  position: absolute;
  left: 14px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--dsw-alias-brand-primary, #4a7fdc);
  box-shadow: 0 0 0 2px var(--dsw-alias-bg-layer-1, #fff);
}
.gcf-dot--hollow {
  background: var(--dsw-alias-bg-layer-1, #fff);
  border: 1.5px solid var(--dsw-alias-state-warn-primary, #d89614);
  box-sizing: border-box;
}
.gcf-card.is-conflict .gcf-row--working .gcf-dot { border-color: var(--dsw-alias-state-error-primary, #c0394b); }
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
      'foot.staged': '暂存 {n}',
      'foot.unstaged': '未暂存 {n}',
      'foot.untracked': '未跟踪 {n}',
      'action.commit': '提交',
      'action.pending': '写操作将在后续步骤开放',
      'time.now': '刚刚',
      'time.minutes': '{n} 分钟前',
      'time.hours': '{n} 小时前',
      'time.days': '{n} 天前',
    };

    const en = {
      'app.title': 'Git workflow',
      'branch.detached': 'detached HEAD @ {oid}',
      'branch.unknown': 'unknown branch',
      'tracking.ahead': '领先上游的提交数',
      'tracking.behind': '落后上游的提交数',
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
      'foot.staged': 'staged {n}',
      'foot.unstaged': 'unstaged {n}',
      'foot.untracked': 'untracked {n}',
      'action.commit': 'Commit',
      'action.pending': 'Write actions arrive in a later step',
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

    function Row({ row, t, now }) {
      if (row.kind === 'working') {
        return h(
          'div',
          { className: 'gcf-row gcf-row--working', 'data-gcf': 'row', 'data-kind': 'working' },
          h('span', { className: 'gcf-dot gcf-dot--hollow' }),
          h('span', { className: 'gcf-subject' }, t('row.working')),
          h('span', { className: 'gcf-meta' }, format(t, 'row.files', { n: row.files })),
        );
      }
      return h(
        'div',
        { className: 'gcf-row', 'data-gcf': 'row', 'data-kind': 'commit' },
        h('span', { className: 'gcf-dot' }),
        h('span', { className: 'gcf-subject' }, row.subject),
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

    function GitFlowView({ view, t, now }) {
      if (view === undefined || view === null) return null;
      if (view.presence !== 'repo') return null;
      if (view.phase === 'clean') return h(CleanBar, { view, t });

      const counts = [
        view.counts.staged > 0 ? format(t, 'foot.staged', { n: view.counts.staged }) : null,
        view.counts.unstaged > 0 ? format(t, 'foot.unstaged', { n: view.counts.unstaged }) : null,
        view.counts.untracked > 0 ? format(t, 'foot.untracked', { n: view.counts.untracked }) : null,
      ].filter((part) => part !== null);

      return h(
        'div',
        { className: 'gcf-dock', 'data-gcf': 'dock' },
        h(
          'section',
          {
            className: `gcf-card${view.phase === 'conflicts' ? ' is-conflict' : ''}`,
            'data-gcf': 'card',
            'data-phase': view.phase,
            'aria-label': t('app.title'),
          },
          h(
            'header',
            { className: 'gcf-head' },
            h('span', { className: 'gcf-glyph' }, h(BranchGlyph)),
            h('span', { className: 'gcf-title', title: branchText(view, t) }, branchText(view, t)),
            h(Tracking, { view, t }),
            h('span', { className: 'gcf-status' }, h('i', null), statusText(view, t)),
          ),
          h(
            'div',
            { className: 'gcf-rows', 'data-gcf': 'rows' },
            view.rows.map((row) => h(Row, { key: row.id, row, t, now })),
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
              h('b', null, `+${view.diffStat.add}`),
              h('em', null, `−${view.diffStat.del}`),
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

      const view = live ?? projected;
      return h(GitFlowView, { view, t, now: Date.now() });
    }

    return {
      inject: ['slots', 'locale', 'sessions'],
      /** Exposed for the contract smoke test; the module loader ignores extra fields. */
      components: { GitFlowView, GitFlowDock },
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
      },
    };
  },
});
