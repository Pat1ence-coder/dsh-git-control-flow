/**
 * Commit graph reading: the visual spine of the card.
 *
 * The video draws a real branch graph (lanes, curved merge edges, coloured
 * nodes), so the card cannot be a flat commit list. This module turns
 * `git log` into rows the Client can draw without any graph logic of its own:
 * every row carries its lane, the lanes before/after it, and the lanes its
 * parents continue into.
 */

/** Graph rows kept for the card; deeper history is reachable through git. */
export const MAX_GRAPH_ROWS = 40;

const FIELD = '\x1f';
const LOG_FORMAT = ['%H', '%h', '%P', '%an', '%at', '%D', '%s'].join(FIELD);

/**
 * @typedef {{ name: string, kind: 'head' | 'branch' | 'remote' | 'tag' }} GraphRef
 * @typedef {{
 *   kind: 'commit',
 *   sha: string,
 *   short: string,
 *   subject: string,
 *   author: string,
 *   time: number,
 *   refs: GraphRef[],
 *   parentShas: string[],
 *   lane: number,
 *   parents: number[],
 *   before: number[],
 *   after: number[],
 *   columns: number,
 * }} GraphRow
 */

/**
 * Turn `%D` ref decorations into pill-ready entries.
 * @param {string} decoration
 * @returns {GraphRef[]}
 */
export function parseRefs(decoration) {
  if (decoration.trim() === '') return [];
  const refs = [];
  for (const part of decoration.split(',')) {
    const text = part.trim();
    if (text === '') continue;
    if (text.startsWith('HEAD -> ')) {
      refs.push({ name: text.slice('HEAD -> '.length), kind: 'head' });
    } else if (text.startsWith('tag: ')) {
      refs.push({ name: text.slice('tag: '.length), kind: 'tag' });
    } else if (text === 'HEAD') {
      continue;
    } else if (/^(origin|upstream|fork)\//.test(text) || text.endsWith('/HEAD')) {
      refs.push({ name: text, kind: 'remote' });
    } else {
      refs.push({ name: text, kind: 'branch' });
    }
  }
  return refs;
}

/**
 * Parse `git log` output into commit rows (no lanes yet).
 * @param {string} stdout
 * @returns {Array<{ sha: string, short: string, parents: string[], author: string, time: number, refs: GraphRef[], subject: string }>}
 */
export function parseGraphLog(stdout) {
  const commits = [];
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const parts = line.split(FIELD);
    if (parts.length < 7) continue;
    const [sha, short, parentText, author, timeText, decoration, subject] = parts;
    const time = Number.parseInt(timeText, 10);
    commits.push({
      sha,
      short,
      parents: parentText === '' ? [] : parentText.split(' '),
      author,
      time: Number.isFinite(time) ? time : 0,
      refs: parseRefs(decoration),
      subject,
    });
  }
  return commits;
}

/**
 * Assign lanes so the Client can draw straight lines, nodes and merge curves.
 *
 * Lanes are a stable array of SHA slots: a commit occupies the lane that
 * already waits for it (or the first free one), its first parent inherits that
 * lane, and extra parents get their own lane. `before`/`after` are the lane
 * snapshots the row is drawn between.
 *
 * @param {Array<ReturnType<typeof parseGraphLog>[number]>} commits
 * @returns {GraphRow[]}
 */
export function assignLanes(commits) {
  /** @type {Array<string | null>} */
  const lanes = [];
  const rows = [];

  const claim = (sha) => {
    let lane = lanes.indexOf(sha);
    if (lane !== -1) return lane;
    lane = lanes.indexOf(null);
    if (lane === -1) {
      lane = lanes.length;
      lanes.push(null);
    }
    lanes[lane] = sha;
    return lane;
  };

  const freeLane = (from) => {
    for (let lane = from; lane < lanes.length; lane += 1) {
      if (lanes[lane] === null) return lane;
    }
    lanes.push(null);
    return lanes.length - 1;
  };

  /** Drop duplicate occurrences of the same SHA so lanes merge instead of fork. */
  const dedupe = (keepLane) => {
    const sha = lanes[keepLane];
    if (sha === null) return;
    for (let index = 0; index < lanes.length; index += 1) {
      if (index !== keepLane && lanes[index] === sha) lanes[index] = null;
    }
  };

  for (const commit of commits) {
    const lane = claim(commit.sha);
    const occupied = (slots) => slots.reduce((acc, slot, index) => (slot === null ? acc : [...acc, index]), []);

    // Capture the lanes before collapsing duplicates: the duplicate lane is a
    // branch converging into this commit, which the Client draws as a curve.
    const before = occupied(lanes);
    dedupe(lane);

    lanes[lane] = commit.parents[0] ?? null;
    dedupe(lane);

    const parents = [lane];
    for (const parent of commit.parents.slice(1)) {
      let parentLane = lanes.indexOf(parent);
      if (parentLane === -1) {
        parentLane = freeLane(lane + 1);
        lanes[parentLane] = parent;
      }
      parents.push(parentLane);
    }

    // Collapse duplicate parents (a merge whose parents already share a lane).
    const uniqueParents = [...new Set(parents)];
    const after = occupied(lanes);

    rows.push({
      kind: 'commit',
      sha: commit.sha,
      short: commit.short,
      subject: commit.subject,
      author: commit.author,
      time: commit.time,
      refs: commit.refs,
      parentShas: commit.parents,
      lane,
      parents: uniqueParents,
      before,
      after,
      columns: Math.max(before.length, after.length, lane + 1, ...uniqueParents.map((p) => p + 1)),
    });

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
  }

  return rows;
}

/**
 * Read the graph rows for `root`.
 * @param {string} root
 * @param {{ runGit: Function, signal?: AbortSignal, maxRows?: number, all?: boolean }} deps
 * @returns {Promise<GraphRow[]>}
 */
export async function readCommitGraph(root, deps) {
  const maxRows = deps.maxRows ?? MAX_GRAPH_ROWS;
  const argv = [
    'log',
    '--no-color',
    '--no-show-signature',
    '--date-order',
    '-n',
    String(maxRows),
    `--pretty=format:${LOG_FORMAT}`,
  ];
  if (deps.all !== false) argv.splice(2, 0, '--all');
  const result = await deps.runGit(root, argv, { signal: deps.signal });
  if (result.code !== 0) return [];
  return assignLanes(parseGraphLog(result.stdout));
}
