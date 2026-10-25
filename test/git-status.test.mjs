/**
 * Real-Git tests for the status snapshot.
 *
 * Every case builds a throwaway repository with the actual `git` binary, so
 * the parsers are verified against git's own output rather than fixtures we
 * invented. Run: node --test test/git-status.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { readGitStatus, resolveRepoRoot } from '../lib/git/status.mjs';
import { gitEnvironment } from '../lib/git/exec.mjs';

const ROOT = join(process.cwd(), '.tmp', 'tests');
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

/** Run a Git command expected to fail; returns its combined output. */
function gitFails(cwd, ...args) {
  try {
    git(cwd, ...args);
    return '';
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
}

function repo(name) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  return dir;
}

function write(dir, name, content) {
  const target = join(dir, name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

test('a plain directory is not a repository', async () => {
  const dir = join(ROOT, 'plain');
  mkdirSync(dir, { recursive: true });
  // The fixture lives inside this repository, so cap discovery at the fixture
  // root; the code under test still performs ordinary upward discovery.
  const env = { ...gitEnvironment(), GIT_CEILING_DIRECTORIES: ROOT };
  assert.equal(await readGitStatus(dir, { env }), null);
  assert.equal(await resolveRepoRoot(dir, { env }), null);
});

test('a fresh repository has a branch, no commit and a clean tree', async () => {
  const dir = repo('fresh');
  const status = await readGitStatus(dir);
  assert.equal(status.branch.name, 'main');
  assert.equal(status.branch.oid, null);
  assert.equal(status.branch.detached, false);
  assert.equal(status.branch.upstream, null);
  assert.equal(status.clean, true);
  assert.deepEqual(status.recentCommits, []);
  assert.equal(status.counts.working, 0);
  assert.equal(status.operation, null);
});

test('staged, unstaged, rename and untracked are separated', async () => {
  const dir = repo('worktree');
  write(dir, 'a.txt', '1\n2\n3\n');
  write(dir, 'b.txt', 'b\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');

  write(dir, 'a.txt', '1\n2\n3\n4\n');       // unstaged modification
  git(dir, 'mv', 'b.txt', 'b-renamed.txt');  // staged rename
  write(dir, 'c.txt', 'c\n');
  git(dir, 'add', 'c.txt');                  // staged addition
  write(dir, 'u.txt', 'u\n');                // untracked

  const status = await readGitStatus(dir);
  assert.equal(status.clean, false);
  assert.equal(status.counts.staged, 2);
  assert.equal(status.counts.unstaged, 1);
  assert.equal(status.counts.untracked, 1);
  assert.equal(status.counts.working, 4);
  assert.equal(status.counts.conflicts, 0);

  const renamed = status.staged.files.find((file) => file.path === 'b-renamed.txt');
  assert.equal(renamed?.kind, 'renamed');
  assert.equal(renamed?.origPath, 'b.txt');
  assert.equal(status.staged.files.find((file) => file.path === 'c.txt')?.kind, 'added');
  assert.equal(status.unstaged.files[0].path, 'a.txt');
  assert.equal(status.unstaged.files[0].kind, 'modified');
  assert.deepEqual(status.untracked.files, ['u.txt']);

  assert.equal(status.diffStat.add, 2);
  assert.equal(status.diffStat.del, 0);
});

test('a merge conflict is reported as unmerged paths, not staged work', async () => {
  const dir = repo('conflict');
  write(dir, 'a.txt', 'base\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');

  git(dir, 'checkout', '-q', '-b', 'other');
  write(dir, 'a.txt', 'theirs\n');
  git(dir, 'commit', '-q', '-a', '-m', 'theirs');

  git(dir, 'checkout', '-q', 'main');
  write(dir, 'a.txt', 'ours\n');
  git(dir, 'commit', '-q', '-a', '-m', 'ours');

  gitFails(dir, 'merge', 'other');

  const status = await readGitStatus(dir);
  assert.equal(status.operation, 'merge');
  assert.equal(status.conflicts.count, 1);
  assert.equal(status.conflicts.files[0].path, 'a.txt');
  assert.equal(status.conflicts.files[0].code, 'UU');
  assert.equal(status.clean, false);
  assert.equal(status.counts.staged, 0);
  assert.equal(status.counts.unstaged, 0);
});

test('a detached HEAD has an object id and no branch name', async () => {
  const dir = repo('detached');
  write(dir, 'a.txt', 'a\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'checkout', '-q', '--detach');

  const status = await readGitStatus(dir);
  assert.equal(status.branch.detached, true);
  assert.equal(status.branch.name, null);
  assert.match(status.branch.oid ?? '', /^[0-9a-f]{40}$/);
  assert.equal(status.recentCommits.length, 1);
});

test('tracking a remote reports the ahead count', async () => {
  const remote = join(ROOT, 'remote.git');
  mkdirSync(remote, { recursive: true });
  git(remote, 'init', '--bare', '-q');

  const dir = repo('ahead');
  write(dir, 'a.txt', 'a\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'one');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', '-u', 'origin', 'main');

  write(dir, 'a.txt', 'a2\n');
  git(dir, 'commit', '-q', '-a', '-m', 'two');

  const status = await readGitStatus(dir);
  assert.equal(status.branch.upstream, 'origin/main');
  assert.equal(status.branch.ahead, 1);
  assert.equal(status.branch.behind, 0);
  assert.equal(status.clean, true);
});

test('a subdirectory resolves to its repository root', async () => {
  const dir = repo('nested');
  write(dir, 'src/deep/file.txt', 'x\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');

  const sub = join(dir, 'src', 'deep');
  const expected = realpathSync(dir);
  assert.equal(await resolveRepoRoot(sub), expected);

  const status = await readGitStatus(sub);
  assert.equal(status.root, expected);
  assert.equal(status.branch.name, 'main');
});

test('recent commits are newest first and carry author and time', async () => {
  const dir = repo('log');
  for (const message of ['one', 'two', 'three']) {
    write(dir, 'a.txt', `${message}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', message);
  }

  const status = await readGitStatus(dir);
  assert.equal(status.recentCommits.length, 3);
  assert.equal(status.recentCommits[0].subject, 'three');
  assert.equal(status.recentCommits[2].subject, 'one');
  assert.match(status.recentCommits[0].short, /^[0-9a-f]{7,}$/);
  assert.equal(status.recentCommits[0].author, 'Fixture');
  assert.ok(status.recentCommits[0].time > 0);
});
