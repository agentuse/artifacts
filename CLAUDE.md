# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@agentuse/artifacts`: a Node CLI plus a local web viewer for collecting markdown/HTML artifacts emitted by AI agents. The CLI ingests files (or stdin) into a content-addressed store under `~/.agentuse/artifacts/`, and the viewer is a single-page React app served from the same CLI process.

## Commands

- `npm run dev -- <args>` runs the CLI via `tsx` against `src/bin.ts`. Example: `npm run dev -- add path/to/file.md`.
- `npm run build` builds the viewer first (`viewer/` -> `viewer-dist/`) then compiles the CLI (`src/` -> `dist/`). The viewer must exist before `serve` will start.
- `npm run build:cli` and `npm run build:viewer` run the two halves independently. Touching only `src/` -> rebuild CLI; touching only `viewer/src/` -> rebuild viewer.
- `npm run typecheck` does a no-emit `tsc` over `src/` only. The viewer has its own `tsconfig.json` and is typechecked as part of `build:viewer`.
- `npm test` runs vitest once. `npm run test:watch` for watch mode. Run a single file: `npx vitest run tests/manifest.test.ts`. Run a single test: `npx vitest run -t "name fragment"`. Tests use `pool: forks` with `singleFork: true` because they touch a shared on-disk store.
- Tests must isolate state by setting `AGENTUSE_ARTIFACTS_HOME` to a temp dir (see `tests/helpers.ts`). Otherwise they will read/write the user's real `~/.agentuse/artifacts/`.

## Architecture

### Two packages, one repo

- Root package = the CLI (`src/`, ESM, Node 20+, output to `dist/`). Bin entry is `dist/bin.js` -> `runCli()` in `src/cli.ts`.
- `viewer/` = a separate Vite + React 18 SPA with its own `package.json` and `node_modules`. It builds into `viewer-dist/` at the repo root (note: `--outDir ../viewer-dist`), which is what gets shipped in the npm package alongside `dist/`.
- Both `dist/` and `viewer-dist/` are gitignored but listed under `package.json#files` for publish.

### Storage layout (filesystem is the source of truth)

Everything lives under `rootDir()` (default `~/.agentuse/artifacts/`, overridable via `AGENTUSE_ARTIFACTS_HOME`):

- `manifest.json` - single JSON document holding `projects`, `runs`, `artifacts`, and a `latest` map of `projectId -> name -> artifactId`. Schema versioned (`SCHEMA_VERSION = 1`).
- `files/<projectId>/<artifactId>.{md,html}` - immutable content blobs.
- `.lock` - advisory lock file for cross-process manifest writes.
- `.serve.pid` - JSON record of the running viewer server (pid + port + startedAt).

### Manifest concurrency

All mutations go through `withLock()` in `src/manifest.ts`:
1. Atomic `open(..., "wx")` on `.lock` with a JSON body (`pid`, `host`, `acquiredAt`).
2. Stale lock detection: locks older than 60s OR same-host with a dead pid get reclaimed.
3. Acquisition timeout is 5s; failure throws `LOCK_TIMEOUT` and includes the holder.
4. SIGINT/SIGTERM release the lock before exit.
5. Manifest writes use a `tmp` + `rename` pattern with `fsync`.

Anything that mutates state (`add`, `revert`, `rm`, `prune`, `fsck`) reads -> mutates in memory -> writes through `withLock`. Reads outside `withLock` are tolerated (manifest writes are atomic).

### Project identity

`resolveProject()` in `src/project.ts` derives a stable `projectId`:
- If the cwd is in a git repo: `proj_` + `sha12("git:" + first-commit-sha)`. This survives moves, rebases, and clones because the root commit is fixed.
- Empty git repo or non-git: `proj_` + `sha12("path:" + realpath)`.

This is why moving a project directory keeps its artifacts; rewriting git history (changing the root commit) creates a new project.

### Runs are tags, not auto-grouping

A "run" is just a string the user supplies via `--run <tag>` or the `AGENTUSE_RUN_ID` env var. Same string = same run; new string = new run record (created lazily). Untagged adds have no `runId`. There is no implicit auto-run.

### Add semantics (`addArtifacts` in `src/artifacts.ts`)

- Sources are read outside the lock (large I/O), then a single `withLock` call ingests the batch. A batch gets at most one `runId`, taken from the first input that supplies one (or the env var).
- Duplicate detection is by `contentHash` against the latest revision of the same logical name. A duplicate is `{ skipped: true }` and reuses the existing `artifactId` unless `--force-revision`.
- Revision numbers are per-name, monotonically increasing (`latest.revision + 1`).
- File write is `tmp` + `fsync` + `rename` into `files/<projectId>/`.
- Logical name resolution (`resolveLogicalName` in `src/validation.ts`): explicit `--name` wins; else POSIX-style path relative to project root if the source is inside it; else basename. Names are validated against absolute paths, `..` segments, control chars, and a 512-byte cap.
- Type inference is by extension only: `.md|.markdown` -> markdown, `.html|.htm` -> html. Anything else throws `INVALID_INPUT`.

### Pointer fixups

`rm` and `prune` rewrite `previousArtifactId` chains so deleting a middle revision leaves a connected history. `rm` of the latest falls back to the predecessor in `latest`. `fsck` rebuilds `latest` from scratch by scanning `artifacts` and verifying file existence.

### Viewer server (`src/server.ts`)

Two shapes of route:
- `/api/manifest` -> raw manifest JSON.
- `/api/artifact/:artifactId` -> markdown bytes as `text/markdown`. HTML artifacts are rejected here (400); use `/api/render/:id`.
- `/api/render/:artifactId` -> sanitized HTML as `text/html` with its own `Content-Security-Policy` and `X-Frame-Options: SAMEORIGIN` response headers. The SPA loads this via `<iframe src="/api/render/:id" sandbox="allow-scripts">`. Going through `src=` (not `srcdoc`) is what lets the artifact have its own CSP — srcdoc inherits the parent SPA CSP, `src=` does not.
- Everything else falls back to `viewer-dist/index.html` for SPA routes (`/p/:projectId`, `/p/:projectId/r/:runId`, `/p/:projectId/a/:name/v/:rev`, etc.).

Server lifecycle:
- `serve` writes `.serve.pid`. `serve --detach` re-spawns `dist/bin.js serve --port N` with `detached: true` and `stdio: "ignore"`, then polls `.serve.pid` for up to 5s. `serve --stop` SIGTERMs and cleans up.
- Default port `7878`, with sequential fallback up to `+50` on `EADDRINUSE`.
- `viewerDistDir()` probes three candidate paths so it works in compiled (`dist/server.js -> ../viewer-dist`), tsx-dev (`src/server.ts -> ../viewer-dist`), and `viewer/dist` layouts. Edit this if you change the build output location.

### HTML sanitization (security-critical)

`src/sanitize.ts` is the trust boundary for ingested HTML artifacts. It runs at **serve time**, not ingest time, so changes to the sanitizer take effect for already-stored artifacts. Two layers:

1. `scrubHtml()` parses with `node-html-parser` (no regex on tags) and removes: `<base>`, `<meta http-equiv="refresh">`, `<link rel>` with `preload|prefetch|dns-prefetch|preconnect|modulepreload`.
2. `buildSafeSrcdoc()` injects `META_CSP` as a `<meta http-equiv="Content-Security-Policy">` as the first child of `<head>` (creating one if missing). The same policy is also sent as a response header from `/api/render/:id` — the meta tag is defense in depth (survives if the file is saved or opened directly).

**Threat model:** the agent producing artifacts is developer-controlled, but its inputs (web pages, PRs, docs) aren't. The realistic risk is prompt-injection routing through the agent into artifact markup. So `META_CSP` permits external `https:` for script/style/font/img (designs use Tailwind Play CDN, Google Fonts) but locks `connect-src 'none'` to deny `fetch`/`XHR`/`WebSocket` — kills exfil + LAN scan. `frame-src 'none'`, `object-src 'none'`, `base-uri 'none'` close the rest.

**Origin isolation comes from the iframe, not the CSP.** `viewer/src/components/Tile.tsx` sets `sandbox="allow-scripts"` *without* `allow-same-origin`, so the iframe lives in an opaque origin. Scripts in the artifact cannot read the parent viewer DOM, localStorage, or cookies regardless of what the CSP allows. Do not add `allow-same-origin` to the sandbox attribute — it would defeat the isolation and the threat model assumes scripts run.

`SPA_CSP` (the viewer SPA's own CSP) is independent because the artifact is loaded via `src=`, not `srcdoc`. No inheritance. Keep `SPA_CSP` tight.

When modifying sanitization: do not switch to regex; do not relax `connect-src` (that's the lever holding back exfil); do not add `allow-same-origin` to the iframe sandbox.

### CLI conventions

- Every command supports a global `--json` that swaps the human output for a structured envelope. Errors use `{ error: { code, message, detail? } }` with stable `ErrorCode` values mapping to fixed exit codes (see `src/errors.ts`). Don't add a new error class without adding it to both `ErrorCode` and `EXIT`.
- `runCli` takes `argv` and uses `commander`'s `from: "user"` parser, which means callers pass post-`process.argv.slice(2)` arguments. `bin.ts` does this slicing.
- Human output goes to stdout for success, stderr for errors. JSON envelopes always go to stdout (including errors).

### Viewer SPA (`viewer/src/`)

- React 18 + Vite, no router library. Routing is a hand-rolled `parseRoute` / `navRoute` over `window.location` in `App.tsx`. Path shape: `/p/:projectId[/r/:runId | /a/:name[/v/:rev]][/f/:expandedId]?d=1`.
- Manifest is polled every 2s from `/api/manifest`. There is no websocket or SSE.
- HTML artifacts render via `<iframe src="/api/render/:id" sandbox="allow-scripts">`. Markdown is fetched from `/api/artifact/:id` and rendered with `react-markdown` + `remark-gfm` + `rehype-highlight`.
- `react-zoom-pan-pinch` powers the canvas pan/zoom. If you touch gestures here, mind the conflict between iframe scrolling and the parent pan handler.

## Conventions specific to this repo

- TypeScript: `strict` + `noUncheckedIndexedAccess`. Indexed access into `manifest.artifacts[id]` returns `T | undefined`; respect this rather than `!`-asserting blindly. `latest[projectId]` is the same.
- ESM throughout. Imports use `.js` extensions even for `.ts` source (NodeNext-style for `Bundler` resolution).
- Never call `process.exit` outside `cli.ts`'s `fail()` / commander callbacks. Library code throws `CliError`.
- All filesystem writes that need durability go `tmp + fsync + rename`. Don't introduce direct `writeFileSync` for manifest or artifact blobs.
- When adding a CLI flag, also add a JSON-output shape to the corresponding `emit()` call so `--json` consumers see it.
