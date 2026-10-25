# dsh-git-control-flow

Generative Git workflow card for the DSH Web conversation: a strip that grows out of the composer into a branch graph with conflicts, checks and a merge state — driven by real Git facts and the session log.

## Status

**Step 1 · skeleton.** The bundle files are written and the Client module contract is covered by a local smoke test. Installation into the profile is **not yet granted**, so the dock seat is not live-verified.

| Step | Content | State |
|---|---|---|
| 1 | Bundle skeleton + dock seat | written, install pending approval |
| 2a | Git read layer: `runGit`, porcelain v2 / numstat / log parsers, status snapshot | done, 8 real-Git tests |
| 2b | `git_flow` tool + `gitFlow` projection + `/git-flow` command | done, 15 offline tests |
| 3 | Card rendering from the Host-computed view model | done, 30 tests; visual pending install |
| 4 | Motion (grow, stagger, scramble, progress, fold) | pending |
| 5 | Mutations (stage / commit / merge / resolve) + approval | pending |
| 6 | Checks mapping, conflict popover, push (opt-in) | pending |

## Layout

```
package.json        bundle manifest (dsh.bundle.patch + dsh.client)
cordis.patch.yml    one inserted row: git-control-flow
index.js            Host half: harness imports only, delegates to lib/flow/register
client.js           Client half: conversation.input.dock strip
lib/git/exec.mjs    argv-only git runner (no shell, bounded, timed out)
lib/git/parse.mjs   porcelain v2 / numstat / log parsers (pure)
lib/git/status.mjs  whole-value GitStatusSnapshot reader
lib/flow/contract.mjs  tool name, command name, parameter spec
lib/flow/state.mjs     gitFlow state, pure fold, structural validation
lib/flow/schema.mjs    ZodType-compatible subset (parse/safeParse), zero deps
lib/flow/projection.mjs session projection definition + identity wire view
lib/flow/register.mjs   registration body, injectable for offline tests
lib/flow/render.mjs     snapshot → compact text (model result, command)
lib/flow/view.mjs       Host-computed card model (phases, rows, validation)
locale/{en,zh}.json Plugin Manager display metadata
icon.svg            original artwork
test/               real-Git status tests, projection/register tests, client smoke test
```

## Development notes

- Full design, frame-by-frame video analysis, decision log and step-by-step journal:
  `DSH-GIT-FLOW-DEVELOPMENT.md`, kept outside this repository next to it.
- Plain JavaScript client module: no build step, no Harness Client package imports. React comes from the browser module table.
- Visible text goes through the Client locale service; styles are registered once in `apply` and removed with the client run.
- Dock geometry mirrors the host's own dock strip so the card lines up with the composer in both themes.

## Install

> A locally linked bundle must declare every Harness package it imports under `peerDependencies`; the profile's module-resolution router only redirects an import for a linked root when that root declares the name. `@deepseek-ai/dsh-tools` is declared for this reason. `engines.dsh` pins the compatible runtime range.

Target: the `web` DSH profile, as a local bundle whose patch inserts the `git-control-flow` row. The install itself escalates plugin management to full access, so it waits for explicit approval; nothing is installed yet.

```bash
# once approved, from the DSH session:
# plugin_manager { action: "install_bundle",
#                  target: "<absolute path to this checkout>" }
```

## Local checks

```bash
npm run check   # node --check across both halves, the git layer and the flow layer
npm test        # 30 tests: real-Git status, view model, projection/register wiring, client contract
```
