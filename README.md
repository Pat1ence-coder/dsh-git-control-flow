# dsh-git-control-flow

Generative Git workflow card for the DSH Web conversation: a strip that grows out of the composer into a branch graph with conflicts, checks and a merge state — driven by real Git facts and the session log.

## Status

The card reads real Git state, draws the commit graph, previews conflicts and supports approved `stage`, `commit`, `merge`, `abort` and `resolve` operations. Graph transitions use shared geometry and stable identities; execution nodes appear only after approval. Check execution, remote PR integration and push are not implemented.

## Execution boundary

The Host must provide `sandboxPolicy`, `sandbox` and `subprocess` (tested with DSH `0.2.1-rc.5`). Every production Git call, including polling, graph reads and review material, uses the managed runner. There is no direct-process fallback.

- Reads use `read-only` confinement. Writes require both tool approval and a session policy permitting writes; approving an operation does not widen the session's sandbox.
- Under `workspace-write`, the repository and its Git metadata must lie inside the authorized workspace. Linked worktrees work when their working tree and common Git directory are both inside that boundary. External metadata is rejected before approval; the plugin never grants a broader common ancestor automatically.
- An explicitly selected `danger-full-access` session permits unconfined writes. This is recorded in write-result metadata; it is never selected as recovery from a broken sandbox. Missing or partial confinement fails closed for confined calls.
- Child environment overrides contain only deliberate Git settings, preserving the Host's ambient credential scrub. Repository-selector variables are cleared. Git commands use argv arrays, not shell strings.
- Approval waits expire after 15 seconds and respond to caller cancellation on Node 18 as well. Each Git call has a 10-second deadline and a 256 KiB limit per output stream. Cancellation, deadlines and excessive output terminate the provider-managed process range, including owned hook descendants; a separate bounded cleanup wait verifies that range is empty.
- Cancellation preserves changes already made, such as successful staging. It does not run an automatic reset. Failure to confirm process cleanup is reported explicitly.

This is the Host's file-write policy, not network isolation. Process cleanup has the guarantees and limitations of the selected subprocess provider.

## Layout

```
package.json        bundle manifest (dsh.bundle.patch + dsh.client)
cordis.patch.yml    one inserted row: git-control-flow
index.js            Host half: harness imports only, delegates to lib/flow/register
client.js           Client half: conversation.input.dock strip
lib/git/exec.mjs    sandboxed managed Git runner, output/deadline/range cleanup
lib/git/cancel.mjs  linked cancellation and bounded awaits
lib/git/scope.mjs   canonical directory containment
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

> A locally linked bundle must declare every Harness package it imports under `peerDependencies`; the profile's module-resolution router only redirects an import for a linked root when that root declares the name. `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-sandbox` are declared for this reason. `engines.dsh` pins the compatible runtime range.

Install as a local bundle in the intended DSH profile. The patch inserts the `git-control-flow` row and uses the existing Host services; it does not change the session permission mode. After Host or manifest changes, reload the bundle/restart the Host. Client changes need a hard refresh.

```bash
# once approved, from the DSH session:
# plugin_manager { action: "install_bundle",
#                  target: "<absolute path to this checkout>" }
```

## Local checks

```bash
npm run check   # node --check across both halves, the git layer and the flow layer
npm test        # real-Git fixtures, transport/policy/cancellation, projections and client contract
```

Host-provider integration is separate from the dependency-free suite. With a matching DSH Node runtime and an installed DSH dependency tree:

```bash
DSH_HOST_MODULES=/path/to/dsh/node_modules node test/git-sandbox.host.mjs
```

It creates disposable repositories and hooks, checks denied outside writes, environment scrubbing, cancellation/deadlines, worktree boundaries and real conflict resolution, then cleans up. It does not load a live profile. The browser animation regression remains in `test/client-motion.browser.mjs` with its documented environment inputs.
