/**
 * Real React/Chromium regression for the card's animation lifecycle.
 * Supply GCF_PLAYWRIGHT (module path) and GCF_REACT_RUNTIME (a browser script
 * exposing React and ReactDOM.createRoot), optionally GCF_MOTION_ARTIFACTS.
 * Uses only local fixtures, blocks network, and never connects to a session.
 */
import assert from 'node:assert/strict';
import { mkdir, rename, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.env.GCF_MOTION_ARTIFACTS ?? `${root}/.tmp/motion`);
await mkdir(out, { recursive: true });
const { chromium } = await import(pathToFileURL(process.env.GCF_PLAYWRIGHT).href);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1000, height: 900 }, recordVideo: { dir: out, size: { width: 1000, height: 900 } } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/*', (route) => route.abort());
try {
  await page.setContent('<!doctype html><html lang="zh"><head><meta charset="utf-8"><base href="http://fixture.local/"></head><body><main id="app"></main><div class="composer">输入消息…</div></body></html>');
  await page.addStyleTag({ content: 'body{margin:0;padding:44px 0;background:#f7f8fa;font-family:Arial,sans-serif}#app,.composer{width:720px;margin:auto}.composer{box-sizing:border-box;margin-top:8px;height:88px;background:white;border:1px solid #ddd;border-radius:14px;padding:20px;color:#999}*{box-sizing:border-box}' });
  if (process.env.GCF_FONT) {
    const font = (await readFile(process.env.GCF_FONT)).toString('base64');
    await page.addStyleTag({ content: `@font-face{font-family:"Noto Sans SC";src:url(data:font/ttf;base64,${font})}body{font-family:"Noto Sans SC",Arial,sans-serif}` });
  }
  await page.addScriptTag({ path: process.env.GCF_REACT_RUNTIME });
  await page.evaluate(() => {
    window.__ModuleLoader__ = { load(definition) { window.plugin = definition.factory(() => window.React); } };
  });
  await page.addScriptTag({ path: resolve(root, 'client.js') });
  await page.evaluate(() => {
    let dict;
    window.plugin.apply({
      effect: (fn) => fn(), locale: { register: (_ns, dictionaries) => { dict = dictionaries.zh; return () => {}; } },
      slots: { inject: () => {}, register: () => {} }, sessions: { binding: () => undefined },
    });
    window.t = (key) => dict[key] ?? key;
    window.reactRoot = window.ReactDOM.createRoot(document.getElementById('app'));
    window.show = (view) => {
      window.currentView = view;
      window.reactRoot.render(window.React.createElement(window.plugin.components.GitFlowView, {
        view, t: window.t, now: Date.now(), collapsed: false, onToggle: () => {}, onAction: () => {},
      }));
    };
  });
  const timing = await page.evaluate(() => window.plugin.motion.timings);
  const sha = (id) => id.repeat(40);
  const commit = (id, title, lane, parents, refs = []) => ({ kind: 'commit', id: id.repeat(7), sha: sha(id), subject: title, lane, parentShas: parents.map(sha), refs, author: 'Fixture', time: Math.floor(Date.now() / 1000) - 300 });
  const history = [
    commit('a', 'Refresh sessions near expiry', 0, ['c'], [{ kind: 'head', name: 'feat/session-refresh' }]),
    commit('b', 'Read sessions with the current key', 1, ['c'], [{ kind: 'branch', name: 'main' }]),
    commit('c', 'Add analytics consent banner', 0, ['d']),
    commit('d', 'Track checkout funnel events', 0, ['e']),
    commit('e', 'Initial session middleware', 0, []),
  ];
  const edges = (rows) => rows.flatMap((row, from) => {
    const targets = row.kind === 'commit' ? row.parentShas : [rows.find((r) => r.kind === 'commit')?.sha];
    return targets.flatMap((parent) => {
      const to = rows.findIndex((r) => r.sha === parent);
      return to < 0 ? [] : [{ from, to, fromLane: row.lane ?? 0, toLane: rows[to].lane ?? 0 }];
    });
  });
  const makeView = (rows, extra = {}) => ({
    presence: 'repo', repoRoot: '/fixture', revision: 1, updatedAt: 1, readAt: 1,
    phase: 'changes', operation: null, clean: false, branch: { name: 'feat/session-refresh', oid: sha('a'), upstream: null, detached: false, ahead: 0, behind: 0 },
    rows, edges: edges(rows), counts: { working: 2, staged: 0, unstaged: 2, untracked: 0, conflicts: 0 },
    diffStat: { add: 48, del: 7 }, hiddenCommits: 0, conflictRows: [], checks: [], pr: null, pending: null, completion: null, ...extra,
  });
  const working = { kind: 'working', id: 'working', files: 2 };
  const initial = makeView([working, ...history]);
  const send = (view) => page.evaluate((v) => window.show(v), view);
  const shot = (name) => page.screenshot({ path: resolve(out, `${name}.png`) });
  await send(initial);
  await page.waitForTimeout(150);
  const grow = await page.locator('.gcf-card').evaluate((el) => getComputedStyle(el).opacity);
  assert.ok(Number(grow) > 0 && Number(grow) < 1, 'the card entrance survives its first animation frame');
  await page.waitForTimeout(timing.enter + 100);
  await shot('01-working');
  await page.evaluate(() => {
    window.keptRow = document.querySelector('[data-row="' + 'a'.repeat(40) + '"]');
    window.keptNode = document.querySelector('[data-node="' + 'a'.repeat(40) + '"]');
    window.keptEdge = document.querySelector('[data-edge="' + 'a'.repeat(40) + '>' + 'c'.repeat(40) + '"]');
  });

  // A paused merge and its conflicts do not mean an approved merge is running.
  const op = { kind: 'operation', id: 'op:merge', operation: 'merge', action: 'resolve', conflicts: 2 };
  const conflicted = makeView([working, ...history], {
    phase: 'conflicts', operation: 'merge',
    counts: { ...initial.counts, conflicts: 2 },
    conflictRows: ['src/auth.ts', 'src/session.ts'].map((path, index) => ({ id: `conflict:${path}`, path, index: index + 1, code: 'UU' })),
  });
  await send(conflicted);
  await page.waitForTimeout(timing.graph + 100);
  assert.equal(await page.locator('[data-kind="operation"]').count(), 0, 'undecided conflicts have no executing merge node');
  await shot('02-conflicts-awaiting-decision');
  const awaiting = { ...conflicted, pending: { phase: 'awaiting-approval', action: 'resolve', reason: 'Resolve the two conflict files' } };
  await send(awaiting);
  await page.waitForTimeout(400);
  assert.equal(await page.locator('[data-kind="operation"]').count(), 0, 'asking for approval still does not execute a merge');
  assert.equal(await page.locator('.gcf-orbit').evaluateAll((els) => els.filter((el) => Number(getComputedStyle(el).opacity) > .001).length), 0, 'approval waiting does not spin an execution node');
  await shot('03-awaiting-approval');

  // Approval starts execution; only now is its operation node inserted.
  const runningRows = [op, working, ...history];
  const running = { ...conflicted, rows: runningRows, edges: edges(runningRows), pending: { phase: 'running', action: 'resolve', reason: 'Resolve the two conflict files' } };
  await send(running);
  await page.waitForTimeout(500);
  const moving = await page.evaluate(() => {
    const rowY = new DOMMatrix(getComputedStyle(window.keptRow).transform).m42;
    const nodeY = window.keptNode.transform.baseVal.consolidate().matrix.f;
    const path = window.keptEdge.getAttribute('d');
    return { rowY, nodeY, path, same: window.keptRow.isConnected && window.keptNode.isConnected && window.keptEdge.isConnected };
  });
  assert.ok(moving.same, 'existing row, node and edge retain their DOM identity');
  assert.ok(moving.rowY > 30 && moving.rowY < 60, `the slowed transition is still in flight: ${moving.rowY}`);
  assert.ok(Math.abs(moving.nodeY - moving.rowY - 15) < .01, `node and row share the same animated position: ${JSON.stringify(moving)}`);
  assert.ok(Math.abs(Number(moving.path.match(/^M[\d.]+ ([\d.]+)/)[1]) - moving.nodeY) < .01, 'edge stays attached to its moving node');
  await shot('04-inserting-mid');
  await page.waitForTimeout(timing.graph + 100);
  assert.equal(await page.locator('[data-kind="operation"]').count(), 1);
  await shot('04-resolving');
  const newCommit = commit('f', 'Merge main into feat/session-refresh', 0, ['a', 'b'], [{ kind: 'head', name: 'feat/session-refresh' }]);
  const completed = makeView([newCommit, ...history], {
    phase: 'clean', clean: true, branch: { ...initial.branch, oid: sha('f') },
    counts: { working: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
    completion: { id: 'resolve-1', action: 'resolve', operation: 'merge', outcome: 'succeeded', repoRoot: '/fixture', previousHead: sha('a'), head: sha('f') },
  });
  await page.evaluate(() => { window.operationNode = document.querySelector('[data-node="op:merge"]'); window.operationRow = document.querySelector('[data-row="op:merge"]'); });
  await send(completed);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.operationRow.isConnected && window.operationNode.isConnected), true, 'operation seat morphs into the real commit');
  assert.equal(await page.locator('[data-conflict].is-resolved').count(), 2, 'resolved files show a check before leaving');
  await shot('05-completing-mid');
  await page.waitForTimeout(timing.conflict + 100);
  assert.equal(await page.locator('[data-conflict]').count(), 0, 'resolved files leave after their exit animation');
  assert.equal(await page.locator('[data-row]').count(), completed.rows.length);
  assert.equal(await page.locator('.gcf-state').innerText(), '已合并');
  const visibleOrbits = await page.locator('.gcf-orbit').evaluateAll((els) => els.filter((el) => Number(getComputedStyle(el).opacity) > .001).length);
  assert.equal(visibleOrbits, 0, 'completed activity has no visible spinning orbit');
  await shot('06-completed');

  // Same data with new object references must not replay entrance or draw effects.
  await send(structuredClone(completed));
  await page.waitForTimeout(60);
  assert.equal(await page.locator('.gcf-edge').evaluateAll((els) => els.every((el) => parseFloat(getComputedStyle(el).strokeDashoffset) === 0)), true);
  assert.equal(await page.evaluate(() => window.operationRow.isConnected), true);

  // Rapid retarget: keep all in-flight geometry continuous and avoid duplicates.
  await send(running);
  await page.waitForTimeout(90);
  await send(completed);
  await page.waitForTimeout(90);
  await send(running);
  await page.waitForTimeout(timing.graph + 100);
  const keys = await page.locator('[data-row]').evaluateAll((els) => els.map((el) => el.dataset.row));
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(keys.length, running.rows.length);

  // A failure stays amber and stops activity; it must not show a success state.
  await send({ ...conflicted, completion: { id: 'failed', action: 'resolve', outcome: 'failed', repoRoot: '/fixture', head: null } });
  await page.waitForTimeout(timing.graph + 100);
  assert.notEqual(await page.locator('.gcf-state').innerText(), '已合并');
  assert.match(await page.locator('.gcf-foot-state').innerText(), /未完成/);
  await shot('07-failed');

  // The host hides (but keeps) the composer fallback during a stock approval.
  // Changes received while hidden must animate when it becomes visible again.
  await send(initial);
  await page.waitForTimeout(timing.graph + 100);
  await page.evaluate(() => { document.getElementById('app').style.display = 'none'; });
  await send(running);
  await page.waitForTimeout(500);
  await page.evaluate(() => { document.getElementById('app').style.display = ''; });
  await page.waitForTimeout(90);
  const resumedY = await page.locator(`[data-row="${sha('a')}"]`).evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m42);
  assert.ok(resumedY > 30 && resumedY < 60, `hidden approval transition resumes at an intermediate position: ${resumedY}`);
  await page.waitForTimeout(timing.graph + 100);
  await shot('08-approval-resumed');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await send(completed);
  await page.waitForTimeout(60);
  assert.equal(await page.locator('[data-row]').count(), completed.rows.length);
  assert.equal(await page.locator('[data-conflict]').count(), 0);
  await page.evaluate(() => {
    document.body.setAttribute('data-ds-dark-theme', '');
    document.body.style.cssText = 'background:#15181e;--dsw-alias-bg-layer-1:#20252e;--dsw-alias-label-primary:#e6e7eb';
  });
  await shot('09-dark-reduced');

  // Exercise the real dock's projection/poll reconciliation with late responses.
  await page.evaluate((first) => {
    window.requests = [];
    window.fetch = (url, options) => new Promise((resolve) => {
      window.requests.push({ url, signal: options.signal, resolve: (value) => resolve({ ok: true, json: async () => value }) });
    });
    window.projectedValue = first;
    const listeners = new Set();
    const projection = { getSnapshot: () => window.projectedValue, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
    window.publishProjection = (value) => { window.projectedValue = value; for (const fn of listeners) fn(); };
    window.reactRoot.render(window.React.createElement(window.plugin.components.GitFlowDock, {
      projection, sessionId: 'fixture', t: window.t,
    }));
  }, initial);
  await page.waitForFunction(() => window.requests.length === 1);
  await page.evaluate((value) => window.requests[0].resolve(value), { ...initial, readAt: 2 });
  await page.waitForTimeout(50);
  await page.evaluate((value) => window.publishProjection(value), { ...running, revision: 2, readAt: 3 });
  await page.waitForFunction(() => window.requests.some((request) => !request.signal.aborted));
  await page.waitForTimeout(50);
  const staleRequest = await page.evaluate(() => window.requests.length - 1);
  await page.evaluate((value) => window.publishProjection(value), { ...completed, revision: 3, readAt: 5 });
  await page.waitForTimeout(70);
  assert.equal(await page.locator('.gcf-state').innerText(), '已合并', 'the successful projection takes effect before the next poll returns');
  await page.evaluate(({ index, value }) => window.requests[index].resolve(value), { index: staleRequest, value: { ...running, readAt: 4 } });
  await page.waitForTimeout(70);
  assert.equal(await page.locator('.gcf-state').innerText(), '已合并', 'a late stale poll cannot undo completion');
  assert.equal(await page.locator('.gcf-activity.is-visible .gcf-pending').count(), 0);
  await page.evaluate(() => window.reactRoot.unmount());
  assert.deepEqual(errors, []);
  console.log('PASS browser: continuous geometry, stable DOM, completion, interruption, approval visibility, failure, reduced motion and stale-response isolation');
} finally {
  const video = page.video();
  await context.close();
  if (video) await rename(await video.path(), resolve(out, 'git-flow-motion.webm'));
  await browser.close();
}
