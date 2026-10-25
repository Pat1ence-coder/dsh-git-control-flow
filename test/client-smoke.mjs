/**
 * Contract smoke test for `client.js` — no browser, no Host, no install.
 *
 * It loads the Client module the way the browser module table would, then
 * drives `apply` with a minimal context and asserts the registrations the
 * plugin must make:
 *   1. the `conversation.input.dock` entry with the documented id/order/locale;
 *   2. the locale dictionaries for `zh` and `en`;
 *   3. one injected stylesheet;
 *   4. a component that renders without throwing and carries the visible parts.
 *
 * Run: node test/client-smoke.mjs
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    return { type, props: props ?? {}, children };
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
check(typeof plugin.apply === 'function', 'plugin.apply must be a function');

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
check(typeof entry?.Component === 'function', 'slot registration must provide a component');

const props = entry?.options?.inject?.('session-test');
check(props?.sessionId === 'session-test', 'injected props must carry the session id');

check(locales.length === 1 && locales[0].ns === 'gitControlFlow', 'one locale namespace registration');
check(!!locales[0]?.dicts?.zh && !!locales[0]?.dicts?.en, 'both zh and en dictionaries must exist');
for (const key of ['strip.label', 'strip.createPr', 'strip.createPrPending']) {
  check(!!locales[0]?.dicts?.zh?.[key], `zh dictionary missing ${key}`);
  check(!!locales[0]?.dicts?.en?.[key], `en dictionary missing ${key}`);
}

check(effects.length >= 2, `expected locale + style effects, got ${effects.length}`);
check(appended.length === 1 && appended[0].id === 'gcf-styles', 'one stylesheet must be appended');
check(/\.gcf-bar/.test(appended[0]?.textContent ?? ''), 'stylesheet must style .gcf-bar');

const tree = entry?.Component({ t: (key) => key });
const flat = JSON.stringify(tree);
check(flat.includes('gcf-bar'), 'component must render .gcf-bar');
check(flat.includes('gcf-action'), 'component must render the primary action');
check(flat.includes('创建 PR') === false, 'component text must come from t(), not literals');
check(flat.includes('strip.createPr'), 'component must request the Create PR label from t()');

if (failures.length > 0) {
  console.error('FAIL');
  for (const failure of failures) console.error(' -', failure);
  process.exit(1);
}
console.log('PASS  client module contract: 1 dock entry, 2 dictionaries, 1 stylesheet, component renders');
