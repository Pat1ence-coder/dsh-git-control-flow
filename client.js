/**
 * Client half of `@local/dsh-git-control-flow`.
 *
 * Step 1 (skeleton): a slim `conversation.input.dock` strip that proves the
 * seat, the theme tokens, the locale plumbing and bundle installation. It
 * renders the idle row of the design (glyph + label + primary action) without
 * repository data; step 2 replaces the placeholder action state with the
 * projected `gitFlow` snapshot.
 *
 * Constraints honoured here:
 * - no Harness Client package is required as a module (React comes from the
 *   browser module table);
 * - all visible text goes through `ctx.locale`;
 * - styles are registered in `apply` and removed with the effect;
 * - dock geometry mirrors the host's own dock strip (GoalBar) so the card
 *   lines up with the composer in both themes.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-git-control-flow',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'gitControlFlow';
    const STYLE_ID = 'gcf-styles';

    const CSS = `
.gcf-dock {
  box-sizing: border-box;
  width: calc(100% - var(--dsh-composer-side-clearance, 0px) - var(--dsh-composer-side-clearance, 0px) - var(--dsh-composer-dock-inset, 0px) - var(--dsh-composer-dock-inset, 0px) - var(--dsh-composer-dock-inset, 0px) - var(--dsh-composer-dock-inset, 0px));
  margin: 0 auto;
}
.gcf-bar {
  box-sizing: border-box;
  width: 100%;
  max-width: calc(var(--dsh-composer-card-max-width, 760px) - 4 * var(--dsh-composer-dock-inset, 0px));
  min-height: 36px;
  margin: 0 auto;
  padding: 4px 6px 4px 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  border-radius: var(--dsw-radius-md, 10px);
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
  background: var(--dsw-alias-bg-layer-1, #fff);
  box-shadow: var(--dsw-elevation-panel, 0 1px 2px rgba(16, 24, 40, 0.05));
}
.gcf-glyph {
  flex: none;
  display: inline-flex;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
}
.gcf-label {
  flex: none;
  font-size: 13px;
  font-weight: 500;
  line-height: 24px;
  color: var(--dsw-alias-label-primary, #1d1d1f);
  white-space: nowrap;
}
.gcf-hint {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
}
.gcf-spacer { flex: 1; }
.gcf-action {
  flex: none;
  height: 26px;
  padding: 0 10px;
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
`;

    const zh = {
      'strip.label': 'Git 工作流',
      'strip.createPr': '创建 PR',
      'strip.createPrPending': '仓库状态接入后可用',
    };
    const en = {
      'strip.label': 'Git workflow',
      'strip.createPr': 'Create PR',
      'strip.createPrPending': 'Available once repository status is wired',
    };

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

    function GitFlowStrip({ t }) {
      return h(
        'div',
        { className: 'gcf-dock', 'data-gcf': 'dock' },
        h(
          'div',
          { className: 'gcf-bar', 'data-gcf': 'bar' },
          h('span', { className: 'gcf-glyph' }, h(BranchGlyph)),
          h('span', { className: 'gcf-label' }, t('strip.label')),
          h('span', { className: 'gcf-spacer' }),
          h(
            'button',
            {
              type: 'button',
              className: 'gcf-action',
              disabled: true,
              title: t('strip.createPrPending'),
              'data-gcf': 'create-pr',
            },
            t('strip.createPr'),
          ),
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
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
              inject: (sessionId) => ({ sessionId }),
            },
            GitFlowStrip,
          ),
        );
      },
    };
  },
});
