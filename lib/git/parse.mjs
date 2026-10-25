/**
 * Pure parsers for the Git plumbing formats the card reads.
 *
 * Every format here is `-z` (NUL separated), so paths with spaces, quotes or
 * newlines survive untouched; nothing in this module touches the filesystem or
 * spawns a process.
 */

/** Human word for one porcelain status letter. */
const STATUS_WORD = {
  M: 'modified',
  T: 'typechange',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'unmerged',
};

/**
 * @param {string} letter
 * @returns {string}
 */
export function statusWord(letter) {
  return STATUS_WORD[letter] ?? 'unknown';
}

/**
 * Parse `git status --porcelain=v2 -z --branch`.
 *
 * Record shapes (from git-status(1)):
 *   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
 *   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path><NUL><origPath>
 *   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
 *   ? <path>
 *   ! <path>
 *
 * @param {string} stdout
 * @returns {{
 *   branch: { oid: string | null, name: string | null, detached: boolean, upstream: string | null, ahead: number, behind: number },
 *   staged: Array<{ path: string, code: string, origPath?: string }>,
 *   unstaged: Array<{ path: string, code: string }>,
 *   untracked: string[],
 *   conflicts: Array<{ path: string, code: string, stages: { base: string, ours: string, theirs: string } }>,
 * }}
 */
export function parsePorcelainV2(stdout) {
  const branch = {
    oid: null,
    name: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
  };
  const staged = [];
  const unstaged = [];
  const untracked = [];
  const conflicts = [];

  const tokens = stdout.split('\0');

  for (let i = 0; i < tokens.length; i += 1) {
    const record = tokens[i];
    if (!record) continue;

    if (record.startsWith('# ')) {
      const value = record.slice(2);
      if (value.startsWith('branch.oid ')) {
        const oid = value.slice('branch.oid '.length).trim();
        branch.oid = oid === '(initial)' ? null : oid;
      } else if (value.startsWith('branch.head ')) {
        const head = value.slice('branch.head '.length).trim();
        if (head === '(detached)') {
          branch.detached = true;
          branch.name = null;
        } else {
          branch.name = head;
        }
      } else if (value.startsWith('branch.upstream ')) {
        branch.upstream = value.slice('branch.upstream '.length).trim();
      } else if (value.startsWith('branch.ab ')) {
        const match = /\+(\d+)\s+-(\d+)/.exec(value);
        if (match !== null) {
          branch.ahead = Number(match[1]);
          branch.behind = Number(match[2]);
        }
      }
      continue;
    }

    const tag = record[0];

    if (tag === '1') {
      const parts = record.split(' ', 9);
      const xy = parts[1];
      const path = parts[8];
      if (typeof xy !== 'string' || path === undefined) continue;
      if (xy[0] !== '.') staged.push({ path, code: xy[0] });
      if (xy[1] !== '.') unstaged.push({ path, code: xy[1] });
      continue;
    }

    if (tag === '2') {
      const parts = record.split(' ', 10);
      const xy = parts[1];
      const path = parts[9];
      const origPath = tokens[i + 1];
      i += 1;
      if (typeof xy !== 'string' || path === undefined) continue;
      if (xy[0] !== '.') staged.push({ path, code: xy[0], origPath: origPath ?? '' });
      if (xy[1] !== '.') unstaged.push({ path, code: xy[1], origPath: origPath ?? '' });
      continue;
    }

    if (tag === 'u') {
      const parts = record.split(' ', 11);
      const xy = parts[1];
      const path = parts[10];
      if (typeof xy !== 'string' || path === undefined) continue;
      conflicts.push({
        path,
        code: xy,
        stages: { base: parts[3], ours: parts[4], theirs: parts[5] },
      });
      continue;
    }

    if (tag === '?') {
      untracked.push(record.slice(2));
      continue;
    }

    // '!' ignored entries are not requested; anything else is unknown and skipped.
  }

  return { branch, staged, unstaged, untracked, conflicts };
}

/**
 * Parse `git diff --numstat -z` (worktree or `--cached`).
 *
 * Each record is `added<TAB>deleted<TAB>path<NUL>`; a rename emits an empty
 * path followed by `<old><NUL><new><NUL>`. Binary files report `-` for both
 * counts.
 *
 * @param {string} stdout
 * @returns {{ add: number, del: number, binaryFiles: number, files: Array<{ path: string, add: number, del: number, binary: boolean }> }}
 */
export function parseNumstat(stdout) {
  const tokens = stdout.split('\0');
  const files = [];
  let add = 0;
  let del = 0;
  let binaryFiles = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const record = tokens[i];
    if (!record) continue;

    const firstTab = record.indexOf('\t');
    if (firstTab < 0) continue;
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (secondTab < 0) continue;

    const rawAdd = record.slice(0, firstTab);
    const rawDel = record.slice(firstTab + 1, secondTab);
    const path = record.slice(secondTab + 1);

    let finalPath = path;
    if (path === '') {
      // Rename: the next two NUL fields are the old and new path.
      const oldPath = tokens[i + 1] ?? '';
      const newPath = tokens[i + 2] ?? '';
      i += 2;
      finalPath = newPath || oldPath;
    }

    const binary = rawAdd === '-' || rawDel === '-';
    const added = binary ? 0 : Number(rawAdd);
    const deleted = binary ? 0 : Number(rawDel);

    add += Number.isFinite(added) ? added : 0;
    del += Number.isFinite(deleted) ? deleted : 0;
    if (binary) binaryFiles += 1;

    files.push({ path: finalPath, add: added, del: deleted, binary });
  }

  return { add, del, binaryFiles, files };
}

/**
 * Parse `git log --pretty=format:%h%x1f%an%x1f%at%x1f%s`.
 * @param {string} stdout
 * @returns {Array<{ short: string, author: string, time: number, subject: string }>}
 */
export function parseLog(stdout) {
  const commits = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\x1f');
    if (parts.length < 4) continue;
    const time = Number(parts[2]);
    commits.push({
      short: parts[0],
      author: parts[1],
      time: Number.isFinite(time) ? time : 0,
      subject: parts.slice(3).join('\x1f'),
    });
  }
  return commits;
}
