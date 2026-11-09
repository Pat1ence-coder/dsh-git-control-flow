import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGitStatus, readGitStatusLight } from '../lib/git/status.mjs';
import { readReviewPayload } from '../lib/flow/review.mjs';
import { discoverRepositories } from '../lib/git/discover.mjs';

const session = { id: 'fixture' };
const signal = new AbortController().signal;

test('full/light status and graph calls preserve the caller session and cancellation', async () => {
  for (const read of [readGitStatus, readGitStatusLight]) {
    const calls = [];
    const runGit = async (_cwd, argv, options) => {
      calls.push(argv);
      assert.equal(options.session, session);
      assert.equal(options.signal, signal);
      const stdout = argv.includes('--show-toplevel') ? '/fixture\n'
        : argv.includes('--absolute-git-dir') ? '/fixture/.git\n'
        : argv[0] === 'status' ? '# branch.oid (initial)\0# branch.head main\0' : '';
      return { code: 0, stdout, stderr: '' };
    };
    await read('/fixture', { runGit, session, signal });
    assert.ok(calls.length >= 6);
    assert.equal(calls.some((argv) => argv.includes('--all')), read === readGitStatus);
  }
});

test('review config and patch reads use the same session and disable external diff/textconv', async () => {
  const calls = [];
  await readReviewPayload({ root: '/fixture', branch: { name: 'main' },
    counts: { conflicts: 0, staged: 1 }, untracked: { files: [] } }, async (_cwd, argv, options) => {
    assert.equal(options.session, session);
    assert.equal(options.signal, signal);
    calls.push(argv);
    return { code: 0, stdout: '', stderr: '' };
  }, { session, signal });
  const patch = calls.find((argv) => argv.includes('-U3'));
  assert.ok(patch.includes('--no-ext-diff'));
  assert.ok(patch.includes('--no-textconv'));
});

test('repository discovery propagates context and fails visibly when confinement fails', async () => {
  const base = await mkdtemp(join(tmpdir(), 'git-flow-discovery-'));
  try {
    await mkdir(join(base, 'repo', '.git'), { recursive: true });
    const runGit = async (_cwd, _argv, options) => {
      assert.equal(options.session, session);
      assert.equal(options.signal, signal);
      throw new Error('sandbox unavailable');
    };
    await assert.rejects(discoverRepositories(base, { runGit, session, signal }), /sandbox unavailable/);
  } finally { await rm(base, { recursive: true, force: true }); }
});
