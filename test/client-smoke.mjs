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

check(injectedSlots.length === 1 && injectedSlots[0] === 'conversation.input.dock', `injected slots: ${injectedSlots.join(',')}`);
check(registered.length === 1, `expected 1 slot registration, got ${registered.length}`);

const entry = registered[0];
check(entry?.options?.name === 'conversation.input.dock', 'slot name must be conversation.input.dock');
check(entry?.options?.id === 'git-control-flow', `slot id is ${entry?.options?.id}`);
check(entry?.options?.order === 10, `slot order is ${entry?.options?.order}`);
check(entry?.options?.locale === 'gitControlFlow', `slot locale is ${entry?.options?.locale}`);
check(typeof entry?.options?.inject === 'function', 'slot registration must inject props');
check(entry?.Component === plugin.components.GitFlowDock, 'the dock component must be registered');

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
    { kind: 'commit', id: 'abc1234', subject: 'fix: something', author: 'You', time: Math.floor(now / 1000) - 120 },
  ],
  hiddenCommits: 3,
};

const conflictView = {
  ...dirtyView,
  phase: 'conflicts',
  operation: 'merge',
  counts: { staged: 0, unstaged: 0, untracked: 0, conflicts: 2, working: 2 },
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
check(clean.includes('gcf-bar') && !clean.includes('gcf-card'), 'clean renders the slim bar, not the card');
check(clean.includes('status.clean'), 'clean renders its status label');
check(clean.includes('feat/x'), 'clean renders the branch name');
check(clean.includes('gcf-ahead') && clean.includes('+1'), 'clean colours the ahead count');
check(clean.includes('gcf-behind') && clean.includes('−0'), 'clean colours the behind count');

const dirty = render(dirtyView);
check(dirty.includes('gcf-card'), 'dirty renders the card');
check(dirty.includes('gcf-rows'), 'dirty renders rows');
check(dirty.includes('row.working'), 'dirty leads with the working row');
check(dirty.includes('fix: something'), 'dirty renders commit subjects');
check(dirty.includes('rows.more'), 'dirty reports hidden commits');
check(dirty.includes('+12') && dirty.includes('−3'), 'dirty renders the diff stat');
check(dirty.includes('foot.staged') && dirty.includes('foot.unstaged'), 'dirty renders bucket counts');
check(dirty.includes('action.commit'), 'dirty renders the primary action');
check(dirty.includes('"disabled":true'), 'the primary action is disabled');

const conflict = render(conflictView);
check(conflict.includes('"data-phase":"conflicts"'), 'conflicts set the phase attribute');
check(conflict.includes('is-conflict'), 'conflicts set the conflict class');
check(conflict.includes('status.conflicts'), 'conflicts render the conflict label');

if (failures.length > 0) {
  console.error('FAIL');
  for (const failure of failures) console.error(' -', failure);
  process.exit(1);
}
console.log('PASS  client module: 1 dock entry, 2 dictionaries, 1 stylesheet, 5 render phases');
