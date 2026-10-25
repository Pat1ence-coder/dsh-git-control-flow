/**
 * Contract smoke test for `client.js` — no browser, no Host, no install.
 *
 * It loads the Client module the way the browser module table would, drives
 * `apply` with a minimal context, and asserts:
 *   1. the `conversation.input.dock` entry with its id/order/locale;
 *   2. the locale dictionaries for `zh` and `en`;
 *   3. one injected stylesheet;
 *   4. the pure card component renders every phase from the Host model.
 *
 * Run: node test/client-smoke.mjs
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', 'client.js');

const appended = [];
const documentStub = {
  getElementById(id) {
    return appended.find((el) => el.id === id) ?? null;
  },
  createElement() {
    return {
      id: '',
      dataset: {},
      textContent: '',
      remove() {
        const at = appended.indexOf(this);
        if (at >= 0) appended.splice(at, 1);
      },
    };
  },
  head: {
    appendChild(el) {
      appended.push(el);
    },
  },
};
globalThis.document = documentStub;

let definition = null;
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      definition = def;
    },
  },
};

const reactStub = {
  createElement(type, props, ...children) {
    // Function components are expanded eagerly so the assertions see the tree.
    if (typeof type === 'function') return type({ ...(props ?? {}), children });
    return { type, props: props ?? {}, children };
  },
  useCallback(fn) {
    return fn;
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot();
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useEffect() {
    // Effects drive rAF/animation; the contract test asserts the static tree.
  },
  useRef(initial) {
    return { current: initial };
  },
};

await import(pathToFileURL(clientPath).href);
if (definition === null) throw new Error('client.js did not call window.__ModuleLoader__.load');

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

check(definition.id === '@local/dsh-git-control-flow', `loader id is ${definition.id}`);

const plugin = definition.factory((name) => {
  if (name === 'react') return reactStub;
  throw new Error(`unexpected require(${name})`);
});

check(Array.isArray(plugin.inject), 'plugin.inject must be an array');
check(plugin.inject?.includes('slots'), 'plugin.inject must declare slots');
check(plugin.inject?.includes('locale'), 'plugin.inject must declare locale');
check(plugin.inject?.includes('sessions'), 'plugin.inject must declare sessions');
check(typeof plugin.apply === 'function', 'plugin.apply must be a function');
check(typeof plugin.components?.GitFlowView === 'function', 'plugin must expose GitFlowView');
check(typeof plugin.components?.GitFlowDock === 'function', 'plugin must expose GitFlowDock');

const registered = [];
const effects = [];
const locales = [];
const injectedSlots = [];

const ctx = {
  effect(fn, label) {
    effects.push(label);
    return fn();
  },
  locale: {
    register(ns, dicts) {
      locales.push({ ns, dicts });
      return () => {};
    },
  },
  sessions: {
    binding() {
      return undefined;
    },
  },
  slots: {
    inject(slot, callback) {
      injectedSlots.push(slot);
      return callback();
    },
    register(options, Component) {
      registered.push({ options, Component });
      return () => {};
    },
  },
};

plugin.apply(ctx);

check(injectedSlots.length === 2, `injected slots: ${injectedSlots.join(',')}`);
check(injectedSlots.includes('conversation.input.dock'), 'the dock slot must be injected');
check(injectedSlots.includes('conversation.composer'), 'the composer slot must be injected');
check(registered.length === 2, `expected 2 slot registrations, got ${registered.length}`);

const entry = registered.find((item) => item.options.name === 'conversation.input.dock');
const approvalEntry = registered.find((item) => item.options.name === 'conversation.composer');
check(entry?.options?.name === 'conversation.input.dock', 'slot name must be conversation.input.dock');
check(entry?.options?.id === 'git-control-flow', `slot id is ${entry?.options?.id}`);
check(entry?.options?.order === 10, `slot order is ${entry?.options?.order}`);
check(entry?.options?.locale === 'gitControlFlow', `slot locale is ${entry?.options?.locale}`);
check(typeof entry?.options?.inject === 'function', 'slot registration must inject props');
check(entry?.Component === plugin.components.GitFlowDock, 'the dock component must be registered');
check(approvalEntry?.Component === plugin.components.GitFlowApproval, 'the approval component must be registered');
check(
  approvalEntry?.options?.priority === 0.5,
  'the approval takeover must be tried before the stock panel (priority 1)',
);

const select = approvalEntry?.options?.select;
const ourApproval = { kind: 'approval', toolName: 'git_flow', reason: 'Stage 1 path(s)' };
check(select?.({ pendingInteraction: ourApproval }) === ourApproval, 'our approval is selected');
check(select?.({ pendingInteraction: { kind: 'approval', toolName: 'bash' } }) === null, 'other approvals keep the stock panel');
check(select?.({ pendingInteraction: { kind: 'question', toolName: 'git_flow' } }) === null, 'only approvals are taken over');
check(select?.({ pendingInteraction: null }) === null, 'no pending interaction selects nothing');

const props = entry?.options?.inject?.('session-test');
check(props?.projection === null, 'a missing session binding injects a null projection');
check(props?.sessionId === 'session-test', 'the session id is forwarded for the status route');

check(locales.length === 1 && locales[0].ns === 'gitControlFlow', 'one locale namespace registration');
check(!!locales[0]?.dicts?.zh && !!locales[0]?.dicts?.en, 'both zh and en dictionaries must exist');
const requiredKeys = [
  'app.title', 'status.clean', 'status.changes', 'status.conflicts',
  'row.working', 'row.files', 'action.commit', 'time.now',
];
for (const key of requiredKeys) {
  check(!!locales[0]?.dicts?.zh?.[key], `zh dictionary missing ${key}`);
  check(!!locales[0]?.dicts?.en?.[key], `en dictionary missing ${key}`);
}

check(effects.length >= 2, `expected locale + style effects, got ${effects.length}`);
check(appended.length === 1 && appended[0].id === 'gcf-styles', 'one stylesheet must be appended');
check(/\.gcf-card/.test(appended[0]?.textContent ?? ''), 'stylesheet must style .gcf-card');

const { GitFlowView } = plugin.components;
const t = (key) => key;
const now = 1_700_000_000_000;

const cleanView = {
  presence: 'repo',
  revision: 1,
  updatedAt: 1,
  branch: { name: 'feat/x', detached: false, oid: 'a'.repeat(40), upstream: 'origin/feat/x', ahead: 1, behind: 0 },
  phase: 'clean',
  operation: null,
  clean: true,
  counts: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0, working: 0 },
  diffStat: { add: 0, del: 0 },
  rows: [],
  hiddenCommits: 0,
  truncatedFiles: false,
};

const dirtyView = {
  ...cleanView,
  phase: 'changes',
  clean: false,
  counts: { staged: 1, unstaged: 1, untracked: 0, conflicts: 0, working: 2 },
  diffStat: { add: 12, del: 3 },
  rows: [
    { kind: 'working', id: 'working', files: 2 },
    {
      kind: 'commit',
      id: 'abc1234',
      subject: 'fix: something',
      author: 'You',
      time: Math.floor(now / 1000) - 120,
      refs: [{ name: 'main', kind: 'head' }],
      lane: 0,
      parents: [0],
      before: [0],
      after: [0],
      columns: 1,
    },
  ],
  hiddenCommits: 3,
};

const conflictView = {
  ...dirtyView,
  phase: 'conflicts',
  operation: 'merge',
  counts: { staged: 0, unstaged: 0, untracked: 0, conflicts: 2, working: 2 },
  rows: [
    { kind: 'operation', id: 'op:merge', operation: 'merge', conflicts: 2 },
    { kind: 'working', id: 'working', files: 2 },
  ],
  conflictRows: [
    { id: 'c:1', index: 1, path: 'src/auth.ts', code: 'UU' },
    { id: 'c:2', index: 2, path: 'src/middleware.ts', code: 'AA' },
  ],
};

function render(view) {
  return JSON.stringify(GitFlowView({ view, t, now }));
}

check(render(null) === 'null', 'no projection renders nothing');

check(render({ presence: 'unknown', revision: 0, updatedAt: null }) === 'null', 'unknown renders nothing');
check(render({ presence: 'absent', revision: 0, updatedAt: null }) === 'null', 'absent renders nothing');

const repositories = render({
  presence: 'absent',
  revision: 0,
  updatedAt: null,
  repositories: [
    { name: 'alpha', branch: 'main', detached: false, changed: 2, clean: false },
    { name: 'beta', branch: 'feat/x', detached: false, changed: 0, clean: true },
  ],
});
check(repositories.includes('gcf-repo-row'), 'discovered repositories render as rows');
check(repositories.includes('repos.title'), 'discovered repositories render a title');
check(repositories.includes('alpha') && repositories.includes('status.changes'), 'a dirty repository shows its change count');
check(repositories.includes('beta') && repositories.includes('status.clean'), 'a clean repository shows its state');

const clean = render(cleanView);
check(clean.includes('gcf-card') && clean.includes('gcf-chips'), 'clean renders the card and the chips');
check(clean.includes('status.clean'), 'clean renders its status label');
check(clean.includes('feat/x'), 'clean renders the branch name');
check(clean.includes('gcf-ahead') && clean.includes('↑1'), 'clean shows the ahead count as an arrow');
check(!clean.includes('gcf-behind'), 'a zero behind count is not rendered');

const behindView = {
  ...cleanView,
  branch: { ...cleanView.branch, ahead: 0, behind: 3 },
};
const behind = render(behindView);
check(behind.includes('gcf-behind') && behind.includes('↓3'), 'a behind count renders as a down arrow');
check(!behind.includes('gcf-ahead'), 'a zero ahead count is not rendered');

const dirty = render(dirtyView);
check(dirty.includes('gcf-card'), 'dirty renders the card');
check(dirty.includes('gcf-rows'), 'dirty renders rows');
check(dirty.includes('row.working'), 'dirty leads with the working row');
check(dirty.includes('fix: something'), 'dirty renders commit subjects');
check(dirty.includes('gcf-rail'), 'commit rows draw the graph rail');
check(dirty.includes('gcf-pill'), 'commit rows render branch pills');
check(dirty.includes('rows.more'), 'dirty reports hidden commits');
check(dirty.includes('+12') && dirty.includes('−3'), 'dirty renders the diff stat');
check(dirty.includes('status.changes'), 'dirty renders its state in the footer');
check(dirty.includes('action.commit'), 'dirty renders the primary action');
check(dirty.includes('"disabled":true'), 'the primary action is disabled');

const conflict = render(conflictView);
check(conflict.includes('"data-phase":"conflicts"'), 'conflicts set the phase attribute');
check(conflict.includes('is-conflict'), 'conflicts set the conflict class');
check(conflict.includes('foot.conflicts'), 'conflicts render the conflict summary in the footer');
check(conflict.includes('gcf-conflict-list'), 'conflicts render a separate conflict list below the graph');
check(conflict.includes('gcf-row--conflict'), 'conflicts render the conflict file rows');
check(conflict.includes('gcf-badge'), 'conflicts number their rows with badges');
check(conflict.includes('1') && conflict.includes('2'), 'both conflict numbers are rendered');
check(conflict.includes('action.resolve'), 'conflicts offer the resolve action');
// Conflict file rows must NOT appear inside the graph rail (would break y-coordinates).
const conflictListIdx = conflict.indexOf('gcf-conflict-list');
const graphRailIdx = conflict.indexOf('gcf-graph');
check(conflictListIdx > graphRailIdx, 'conflict list appears after the graph, not inside it');

const readyView = {
  ...cleanView,
  phase: 'ready',
  checks: [
    { id: 'tests', label: 'Tests 42 passed', state: 'passed' },
    { id: 'lint', label: 'Lint passed', state: 'passed' },
    { id: 'types', label: 'Types failed', state: 'failed' },
  ],
};
const ready = render(readyView);
check(ready.includes('gcf-checks'), 'checks render as chips');
check(ready.includes('Tests 42 passed'), 'a passing check shows its label');
check(ready.includes('gcf-check is-failed'), 'a failing check is marked');

const expanded = JSON.stringify(
  GitFlowView({ view: dirtyView, t, now, collapsed: false, onToggle: () => {} }),
);
check(expanded.includes('gcf-card'), 'an expanded card renders the card');
check(expanded.includes('gcf-chips'), 'an expanded card keeps the chips row');
check(expanded.includes('"aria-expanded":true'), 'the toggle reports the expanded state');
check(expanded.includes('action.collapse'), 'the expanded toggle offers to collapse');
check(expanded.includes('"className":"gcf-body is-open"'), 'an expanded card opens its body');

const collapsed = JSON.stringify(
  GitFlowView({ view: dirtyView, t, now, collapsed: true, onToggle: () => {} }),
);
check(!collapsed.includes('gcf-card'), 'a collapsed card renders no card');
check(collapsed.includes('gcf-chips'), 'a collapsed card keeps the chips row');
check(collapsed.includes('"aria-expanded":false'), 'the chips toggle reports the collapsed state');
check(collapsed.includes('action.expand'), 'the chips toggle offers to expand');
check(collapsed.includes('state.changes'), 'the chips still show the state');

const reposExpanded = JSON.stringify(
  GitFlowView({
    view: {
      presence: 'absent',
      revision: 0,
      updatedAt: null,
      repositories: [{ name: 'alpha', branch: 'main', detached: false, changed: 1, clean: false }],
    },
    t,
    now,
    collapsed: false,
    onToggle: () => {},
  }),
);
check(reposExpanded.includes('gcf-body is-open'), 'the repository list expands too');
check(reposExpanded.includes('gcf-repo-row'), 'an expanded repository list shows its rows');

const reposCollapsed = JSON.stringify(
  GitFlowView({
    view: {
      presence: 'absent',
      revision: 0,
      updatedAt: null,
      repositories: [{ name: 'alpha', branch: 'main', detached: false, changed: 1, clean: false }],
    },
    t,
    now,
    collapsed: true,
    onToggle: () => {},
  }),
);
check(reposCollapsed.includes('"className":"gcf-body"'), 'the repository list collapses too');
check(reposCollapsed.includes('gcf-toggle'), 'the repository list has a toggle');
check(reposCollapsed.includes('alpha'), 'collapsed repository rows stay in the DOM for the height transition');

const pendingWrite = {
  phase: 'awaiting-approval',
  action: 'stage',
  reason: 'Stage 1 path(s) in test: scratch-dirty.md',
};

const dirtyPending = render({ ...dirtyView, pending: pendingWrite });
check(dirtyPending.includes('gcf-pending'), 'a pending write renders inside the card');
check(dirtyPending.includes('pending.awaiting'), 'a pending write is labelled as awaiting approval');
check(dirtyPending.includes('Stage 1 path'), 'the approval reason is shown in the card');
check(dirtyPending.includes('gcf-spinner'), 'a pending write shows a spinner');

const cleanPending = render({ ...cleanView, pending: pendingWrite });
check(cleanPending.includes('gcf-card'), 'a clean repository keeps the card while a write is pending');
check(cleanPending.includes('gcf-pending'), 'the clean card shows the pending write');

const unknownPending = render({ presence: 'unknown', revision: 0, updatedAt: null, pending: pendingWrite });
check(unknownPending.includes('gcf-pending'), 'a pending write renders even before the first read');
check(unknownPending.includes('app.title'), 'the pre-read card still has a title');

const runningPending = render({
  ...dirtyView,
  pending: { phase: 'running', action: 'commit', reason: 'Commit 1 staged file(s) on main.' },
});
check(runningPending.includes('pending.running'), 'a running write is labelled as running');

const { GitFlowApproval } = plugin.components;
const answers = [];
const approvalHtml = JSON.stringify(
  GitFlowApproval({
    t,
    matched: {
      sessionId: 'session-test',
      reason: 'Stage 1 path(s) in test: test.txt',
      answer: (outcome) => answers.push(outcome),
    },
  }),
);
check(approvalHtml.includes('gcf-approval'), 'the approval renders as the card shell');
check(approvalHtml.includes('gcf-card'), 'the approval keeps the card chrome');
check(approvalHtml.includes('pending.awaiting'), 'the approval shows the waiting state');
check(approvalHtml.includes('Stage 1 path'), 'the approval shows its reason in the card');
check(approvalHtml.includes('approval.reject'), 'the approval offers reject');
check(approvalHtml.includes('approval.allow'), 'the approval offers allow once');
check(approvalHtml.includes('"data-gcf":"reject"') && approvalHtml.includes('"data-gcf":"allow"'), 'both decisions are buttons');

function findBy(node, predicate) {
  if (node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findBy(child, predicate);
      if (found !== null) return found;
    }
    return null;
  }
  if (predicate(node)) return node;
  return findBy(node.children, predicate);
}

const approvalTree = GitFlowApproval({
  t,
  matched: { sessionId: 'session-test', reason: 'Stage 1 path(s)', answer: (outcome) => answers.push(outcome) },
});
findBy(approvalTree, (node) => node?.props?.['data-gcf'] === 'allow')?.props?.onClick?.();
check(answers.at(-1) === 'allowed-once', 'allow answers allowed-once');
findBy(approvalTree, (node) => node?.props?.['data-gcf'] === 'reject')?.props?.onClick?.();
check(answers.at(-1) === 'rejected', 'reject answers rejected');

if (failures.length > 0) {
  console.error('FAIL');
  for (const failure of failures) console.error(' -', failure);
  process.exit(1);
}
console.log('PASS  client module: 1 dock entry, 2 dictionaries, 1 stylesheet, 5 render phases, collapse/expand');
