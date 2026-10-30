/**
 * Review payload tests: which material the commit/resolve button hands to the
 * LLM for each working-tree state, and what the redaction keeps or removes.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runGit } from '../lib/git/exec.mjs';
import { readGitStatus } from '../lib/git/status.mjs';
import { DIFF_LIMIT, REVIEW_FILE_LIMIT, filterSensitive, readReviewPayload } from '../lib/flow/review.mjs';

function snapshot(overrides = {}) {
  return {
    kind: 'git-status',
    root: '/repo',
    branch: { name: 'main', detached: false, oid: 'a'.repeat(40), upstream: null, ahead: 0, behind: 0 },
    operation: null,
    staged: { count: 0, files: [] },
    unstaged: { count: 0, files: [] },
    untracked: { count: 0, files: [] },
    conflicts: { count: 0, files: [] },
    counts: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0, working: 0 },
    clean: true,
    ...overrides,
  };
}

/** Fake transport that answers by argv shape and records every call. */
function fakeGit(answers = {}) {
  const calls = [];
  const runGit = async (cwd, argv) => {
    calls.push({ cwd, argv });
    if (argv[0] === 'config') {
      const value = answers[argv[1]];
      return value === undefined ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: `${value}\n`, stderr: '' };
    }
    const key = argv.includes('--stat') ? 'stat' : 'patch';
    return { code: 0, stdout: answers[key] ?? '', stderr: '' };
  };
  return { runGit, calls };
}

test('a clean tree has nothing to review and runs no git', async () => {
  const git = fakeGit();
  assert.deepEqual(await readReviewPayload(snapshot(), git.runGit), { kind: 'clean' });
  assert.equal(git.calls.length, 0);
});

test('conflicts win over staged work and diff only the conflicted paths', async () => {
  const git = fakeGit({
    'user.name': 'Pat1ence-coder',
    'user.email': '',
    patch: 'diff --cc src/a.ts\n++<<<<<<< HEAD\n +ours\n++=======\n+ theirs\n++>>>>>>> feat\n',
  });
  const status = snapshot({
    operation: 'merge',
    conflicts: { count: 2, files: [{ path: 'src/a.ts', code: 'UU' }, { path: 'src/b.ts', code: 'AA' }] },
    counts: { staged: 3, unstaged: 0, untracked: 0, conflicts: 2, working: 5 },
    clean: false,
  });
  const value = await readReviewPayload(status, git.runGit);

  assert.equal(value.kind, 'conflicts');
  assert.equal(value.operation, 'merge');
  assert.equal(value.conflictCount, 2);
  assert.deepEqual(value.files, ['src/a.ts', 'src/b.ts']);
  assert.match(value.patch, /<<<<<<< HEAD/);
  assert.deepEqual(value.author, { name: 'Pat1ence-coder', email: null });

  const diff = git.calls.find((call) => call.argv[0] === 'diff');
  assert.deepEqual(diff.argv.slice(-3), ['--', 'src/a.ts', 'src/b.ts']);
  assert.equal(git.calls.some((call) => call.argv.includes('--cached')), false);
});

test('conflict file lists are bounded', async () => {
  const files = Array.from({ length: REVIEW_FILE_LIMIT + 3 }, (_, i) => ({ path: `f${i}.ts`, code: 'UU' }));
  const status = snapshot({
    operation: 'rebase',
    conflicts: { count: files.length, files },
    counts: { staged: 0, unstaged: 0, untracked: 0, conflicts: files.length, working: files.length },
  });
  const value = await readReviewPayload(status, fakeGit().runGit);
  assert.equal(value.files.length, REVIEW_FILE_LIMIT);
  assert.equal(value.moreFiles, 3);
});

test('staged work is reviewed from the index', async () => {
  const git = fakeGit({ stat: ' a.ts | 1 +\n', patch: '+x\n' });
  const status = snapshot({ counts: { staged: 1, unstaged: 2, untracked: 0, conflicts: 0, working: 3 }, clean: false });
  const value = await readReviewPayload(status, git.runGit);

  assert.equal(value.kind, 'diff');
  assert.equal(value.scope, 'staged');
  assert.equal(value.stagedCount, 1);
  assert.match(value.stat, /a\.ts/);
  assert.ok(git.calls.filter((call) => call.argv[0] === 'diff').every((call) => call.argv.includes('--cached')));
});

test('unstaged and untracked work is reviewed when nothing is staged', async () => {
  const git = fakeGit({ patch: '+y\n' });
  const status = snapshot({
    untracked: { count: 2, files: ['new.ts', 'notes.md'] },
    counts: { staged: 0, unstaged: 1, untracked: 2, conflicts: 0, working: 3 },
    clean: false,
  });
  const value = await readReviewPayload(status, git.runGit);

  assert.equal(value.kind, 'diff');
  assert.equal(value.scope, 'working');
  assert.equal(value.workingCount, 3);
  assert.deepEqual(value.untracked, ['new.ts', 'notes.md']);
  assert.equal(value.moreUntracked, 0);
  assert.ok(git.calls.filter((call) => call.argv[0] === 'diff').every((call) => !call.argv.includes('--cached')));
});

test('a detached HEAD reports no branch name', async () => {
  const status = snapshot({
    branch: { name: null, detached: true, oid: 'b'.repeat(40), upstream: null, ahead: 0, behind: 0 },
    counts: { staged: 1, unstaged: 0, untracked: 0, conflicts: 0, working: 1 },
  });
  assert.equal((await readReviewPayload(status, fakeGit().runGit)).branch, null);
});

test('large patches are truncated after redaction', async () => {
  const git = fakeGit({ patch: `+${'x'.repeat(DIFF_LIMIT + 10)}` });
  const status = snapshot({ counts: { staged: 1, unstaged: 0, untracked: 0, conflicts: 0, working: 1 } });
  const value = await readReviewPayload(status, git.runGit);
  assert.equal(value.truncated, true);
  assert.match(value.patch, /truncated\)$/);
});

test('filterSensitive redacts added, removed and context lines', () => {
  const out = filterSensitive([
    '+API_TOKEN=abc',
    '-password: hunter2',
    ' const secret = load();',
    '+plain line',
  ].join('\n')).split('\n');
  assert.equal(out[0], '+[REDACTED — possible secret]');
  assert.equal(out[1], '-[REDACTED — possible secret]');
  assert.equal(out[2], ' [REDACTED — possible secret]');
  assert.equal(out[3], '+plain line');
});

test('filterSensitive handles combined-diff prefixes and value shapes', () => {
  const out = filterSensitive([
    '++<<<<<<< HEAD',
    ' +key = "ghp_abcdefghijklmnop"',
    '+ -----BEGIN RSA PRIVATE KEY-----',
    '+jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  ].join('\n')).split('\n');
  assert.equal(out[0], '++<<<<<<< HEAD');
  assert.equal(out[1], ' +[REDACTED — possible secret]');
  assert.equal(out[2], '+ [REDACTED — possible secret]');
  assert.equal(out[3], '+[REDACTED — possible secret]');
});

test('filterSensitive leaves diff headers alone', () => {
  const headers = [
    'diff --git a/src/token.ts b/src/token.ts',
    'index 1111111..2222222 100644',
    '--- a/src/token.ts',
    '+++ b/src/token.ts',
    '@@ -1,2 +1,2 @@ function readToken()',
  ].join('\n');
  assert.equal(filterSensitive(headers), headers);
});

// ── against a real repository ────────────────────────────────────────────────

const ROOT = join(process.cwd(), '.tmp', 'review-tests');
after(() => rmSync(ROOT, { recursive: true, force: true }));

function git(cwd, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  );
}

test('a real merge conflict yields its markers with secrets redacted', async () => {
  const dir = join(ROOT, 'conflict');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'app.txt'), 'base\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feat');
  writeFileSync(join(dir, 'app.txt'), 'feature\nAPI_KEY=feature-secret\n');
  git(dir, 'commit', '-q', '-am', 'feat');
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'app.txt'), 'mainline\n');
  git(dir, 'commit', '-q', '-am', 'main');
  try {
    git(dir, 'merge', 'feat');
  } catch {
    /* the conflict is the point */
  }

  const status = await readGitStatus(dir);
  const value = await readReviewPayload(status, runGit);
  assert.equal(value.kind, 'conflicts');
  assert.equal(value.operation, 'merge');
  assert.deepEqual(value.files, ['app.txt']);
  assert.match(value.patch, /<<<<<<< HEAD/);
  assert.match(value.patch, />>>>>>> feat/);
  assert.match(value.patch, /mainline/);
  assert.doesNotMatch(value.patch, /feature-secret/);
  assert.match(value.patch, /REDACTED/);
});
