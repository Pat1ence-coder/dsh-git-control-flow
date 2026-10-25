# dsh-git-control-flow

Generative Git workflow card for the DSH Web conversation: a strip that grows out of the composer into a branch graph with conflicts, checks and a merge state — driven by real Git facts and the session log.

## Status

**Step 1 · skeleton.** The bundle files are written and the Client module contract is covered by a local smoke test. Installation into the profile is **not yet granted**, so the dock seat is not live-verified.

| Step | Content | State |
|---|---|---|
| 1 | Bundle skeleton + dock seat | written, install pending approval |
| 2a | Git read layer: `runGit`, porcelain v2 / numstat / log parsers, status snapshot | done, 8 real-Git tests |
| 2b | `git_flow` tool + `gitFlow` projection + wire | pending |
| 3 | Card rendering (graph lanes, rows, tags, chips) | pending |
| 4 | Motion (grow, stagger, scramble, progress, fold) | pending |
| 5 | Mutations (stage / commit / merge / resolve) + approval | pending |
| 6 | Checks mapping, conflict popover, push (opt-in) | pending |

## Layout

```
package.json        bundle manifest (dsh.bundle.patch + dsh.client)
cordis.patch.yml    one inserted row: git-control-flow
index.js            Host half (empty in step 1)
client.js           Client half: conversation.input.dock strip
lib/git/exec.mjs    argv-only git runner (no shell, bounded, timed out)
lib/git/parse.mjs   porcelain v2 / numstat / log parsers (pure)
lib/git/status.mjs  whole-value GitStatusSnapshot reader
locale/{en,zh}.json Plugin Manager display metadata
icon.svg            original artwork
test/               real-Git status tests + client contract smoke test
```

## Development notes

- Full design, frame-by-frame video analysis, decision log and step-by-step journal:
  `DSH-GIT-FLOW-DEVELOPMENT.md`, kept outside this repository next to it.
- Plain JavaScript client module: no build step, no Harness Client package imports. React comes from the browser module table.
- Visible text goes through the Client locale service; styles are registered once in `apply` and removed with the client run.
- Dock geometry mirrors the host's own dock strip so the card lines up with the composer in both themes.

## Install

Target: the `web` DSH profile, as a local bundle whose patch inserts the `git-control-flow` row. The install itself escalates plugin management to full access, so it waits for explicit approval; nothing is installed yet.

```bash
# once approved, from the DSH session:
# plugin_manager { action: "install_bundle",
#                  target: "<absolute path to this checkout>" }
```

## Local checks

```bash
npm run check   # node --check on both module halves and the git layer
npm test        # 8 real-Git status tests + client contract smoke test
```
