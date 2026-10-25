/**
 * Discovery tests with real directories and the real `git` binary: a
 * container directory holding repositories, plain folders and a skipped
 * `node_modules` tree.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { discoverRepositories, parseBranchLine } from '../lib/git/discover.mjs';
import { runGit } from '../lib/git/exec.mjs';

const ROOT = join(process.cwd(), '.tmp', 'discover');
mkdirSync(ROOT, { recursive: true });

const IDENTITY = [
  '-c', 'user.name=Fixture',
  '-c', 'user.email=fixture@example.invalid',
  '-c', 'commit.gpgsign=false',
];

function git(cwd, ...args) {
  return execFileSync('git', [...IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

function repo(parent, name) {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

test('the branch header parser handles tracked, detached and unborn branches', () => {
  assert.deepEqual(parseBranchLine('main...origin/main [ahead 1]'), { branch: 'main', detached: false });
  assert.deepEqual(parseBranchLine('feat/x...origin/feat/x'), { branch: 'feat/x', detached: false });
  assert.deepEqual(parseBranchLine('main'), { branch: 'main', detached: false });
  assert.deepEqual(parseBranchLine('HEAD (no branch)'), { branch: null, detached: true });
  assert.deepEqual(parseBranchLine('No commits yet on main'), { branch: 'main', detached: false });
  assert.deepEqual(parseBranchLine(''), { branch: null, detached: false });
});

test('repositories are found one level down and summarised', async () => {
  const container = join(ROOT, 'container');
  mkdirSync(container, { recursive: true });

  const clean = repo(container, 'clean-repo');
  const dirty = repo(container, 'dirty-repo');
  writeFileSync(join(dirty, 'b.txt'), 'b\n');

  mkdirSync(join(container, 'plain-folder'), { recursive: true });
  mkdirSync(join(container, 'node_modules', 'fake-repo', '.git'), { recursive: true });
  mkdirSync(join(container, '.hidden-repo', '.git'), { recursive: true });

  const repos = await discoverRepositories(container, { runGit });
  assert.deepEqual(repos.map((entry) => entry.name), ['clean-repo', 'dirty-repo']);

  const cleanEntry = repos.find((entry) => entry.name === 'clean-repo');
  assert.equal(cleanEntry.branch, 'main');
  assert.equal(cleanEntry.changed, 0);
  assert.equal(cleanEntry.clean, true);
  assert.equal(cleanEntry.path, clean);

  const dirtyEntry = repos.find((entry) => entry.name === 'dirty-repo');
  assert.equal(dirtyEntry.changed, 1);
  assert.equal(dirtyEntry.clean, false);
});

test('a plain container yields no repositories', async () => {
  const container = join(ROOT, 'empty');
  mkdirSync(container, { recursive: true });
  assert.deepEqual(await discoverRepositories(container, { runGit }), []);
});

test('a missing directory is not an error', async () => {
  assert.deepEqual(await discoverRepositories(join(ROOT, 'nope'), { runGit }), []);
});

test('the repository cap is honoured', async () => {
  const container = join(ROOT, 'many');
  mkdirSync(container, { recursive: true });
  repo(container, 'one');
  repo(container, 'two');
  repo(container, 'three');

  const repos = await discoverRepositories(container, { runGit, maxRepos: 2 });
  assert.equal(repos.length, 2);
  assert.deepEqual(repos.map((entry) => entry.name), ['one', 'three']);
});
