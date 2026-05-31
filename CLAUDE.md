# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@agentuse/artifacts`: a Node CLI plus a local web viewer for collecting markdown/HTML artifacts emitted by AI agents. The recommended generated-output drop zone is each project's `./.agentuse/artifacts/` directory, but the viewer discovers supported artifact files across registered projects. The CLI registers project paths in a small index at `~/.agentuse/artifacts/manifest.json` and serves the registered projects through a local React SPA.

## Commands

- `npm run dev -- <args>` runs the CLI via `tsx` against `src/bin.ts`. Example: `npm run dev -- list`.
- `npm run build` builds the viewer first (`viewer/` -> `viewer-dist/`) then compiles the CLI (`src/` -> `dist/`). The viewer must exist before `serve` will start.
- `npm run build:cli` and `npm run build:viewer` run the two halves independently. Touching only `src/` -> rebuild CLI; touching only `viewer/src/` -> rebuild viewer.
- `npm run watch` runs both watchers in one shell: `tsx watch` for the server (auto-restart on `src/` changes) and `vite build --watch` for the viewer (incremental rebuild into `viewer-dist/`). Stop any detached server first (`npm run dev -- serve --stop`); otherwise the watcher's server falls back to port 7879 silently. Refresh the browser to pick up viewer rebuilds.
- `npm run dev:viewer` runs the Vite dev server with HMR (port 5173) — `/api/*` is proxied to `127.0.0.1:7878`, so a separate server (`npm run dev:server` or a detached `serve`) must be running. Use this for fast iteration on `viewer/src/`; use `npm run watch` when you also need the production-build output in `viewer-dist/`.
- `npm run typecheck` does a no-emit `tsc` over `src/` only. The viewer has its own `tsconfig.json` and is typechecked as part of `build:viewer`.
- `npm test` runs vitest once. `npm run test:watch` for watch mode. Run a single file: `npx vitest run tests/manifest.test.ts`. Run a single test: `npx vitest run -t "name fragment"`. Tests use `pool: forks` with `singleFork: true` because they touch a shared on-disk store.
- Tests must isolate state by setting `AGENTUSE_ARTIFACTS_HOME` to a temp dir (see `tests/helpers.ts`). Otherwise they will read/write the user's real `~/.agentuse/artifacts/`.

## Architecture

### Two packages, one repo

- Root package = the CLI (`src/`, ESM, Node 20+, output to `dist/`). Bin entry is `dist/bin.js` -> `runCli()` in `src/cli.ts`.
- `viewer/` = a separate Vite + React 18 SPA with its own `package.json` and `node_modules`. It builds into `viewer-dist/` at the repo root (note: `--outDir ../viewer-dist`), which is what gets shipped in the npm package alongside `dist/`.
- Both `dist/` and `viewer-dist/` are gitignored but listed under `package.json#files` for publish.

### Storage layout (filesystem is the source of truth)

Two layers, both filesystem-backed:

1. **Per-project artifacts** are supported files in each registered project (`.md/.markdown`, `.html/.htm`, `.png/.jpg/.jpeg/.webp`, `.pdf`). Generated agent output should still live at `<project>/.agentuse/artifacts/<name>/index.{md,html}` (with sibling support files), but existing project docs/screenshots/reports are discovered in place. Dependency, build, cache, temp, VCS, and hidden config directories are ignored, except `.agentuse/artifacts/`.
2. **Cross-project index** lives under `rootDir()` (default `~/.agentuse/artifacts/`, overridable via `AGENTUSE_ARTIFACTS_HOME`):
   - `manifest.json` - the project registry: `projects: Record<projectId, { name, path, createdAt, updatedAt? }>`. Schema versioned (`SCHEMA_VERSION = 1`). The runtime `Manifest` type still carries `runs`/`artifacts`/`latest` because `buildLocalManifest()` populates them on every `/api/manifest` response from the on-disk scan; only `projects` is persisted.
   - `.lock` - advisory lock file for cross-process registry writes.
   - `.serve.pid` - JSON record of the running viewer server (pid + port + startedAt).

### Registry concurrency

Project-registry mutations go through `withLock()` in `src/manifest.ts`:
1. Atomic `open(..., "wx")` on `.lock` with a JSON body (`pid`, `host`, `acquiredAt`).
2. Stale lock detection: locks older than 60s OR same-host with a dead pid get reclaimed.
3. Acquisition timeout is 5s; failure throws `LOCK_TIMEOUT` and includes the holder.
4. SIGINT/SIGTERM release the lock before exit.
5. Writes use a `tmp` + `rename` pattern with `fsync`.

Reads outside `withLock` are tolerated (writes are atomic). The only writers today are `init`, `open`, and `project add/forget/prune` — adding/editing artifact files themselves does not touch the lock.

### Project identity

`resolveProject()` in `src/project.ts` derives a stable `projectId`:
- If the cwd is in a git repo: `proj_` + `sha12("git:" + first-commit-sha)`. This survives moves, rebases, and clones because the root commit is fixed.
- Empty git repo or non-git: `proj_` + `sha12("path:" + realpath)`.

This is why moving a project directory keeps its artifacts; rewriting git history (changing the root commit) creates a new project.

### Listing semantics (`src/localArtifacts.ts`)

`listLocalArtifactsForProject()` now merges two scans:
- First, it walks each registered project's `.agentuse/artifacts/` directory with legacy semantics: a subdirectory containing `index.html` or `index.md` becomes one artifact named `<dir>`, sibling `.html`/`.md` files become `<dir>/<file>`, and IDs keep using the artifact-root-relative entry so old URLs remain stable.
- Then it recursively scans the registered project for supported artifact files, skipping dependency/build/cache/temp/VCS/hidden config paths. Project-wide files use `projectRelPath` for serving and IDs are namespaced with `project:` to avoid collisions.
- `ArtifactRecord.localEntry` remains artifact-root-relative and only exists for legacy `.agentuse/artifacts/` files. `ArtifactRecord.projectRelPath` is project-root-relative and is available for all discovered project-local files.
- The synthetic `contentHash` for a legacy directory entry still folds in every sibling's `mtimeMs+size` so the viewer's iframe cache-busts when an asset (image, css) referenced via a relative URL is updated, even though the index file itself hasn't changed.

### Viewer server (`src/server.ts`)

Routes:
- `/api/manifest` -> the live manifest JSON (`buildLocalManifest()` scans every registered project on each call).
- `/api/artifact/:artifactId` -> markdown / image / pdf bytes for the artifact ID. HTML artifacts are rejected here (400); use `/api/render/:id`.
- `/api/raw/:artifactId` -> original file bytes as `application/octet-stream` with `Content-Disposition: attachment` (powers Download / Copy actions; never rendered inline).
- `/api/render/:artifactId` -> sanitized HTML as `text/html` with its own `Content-Security-Policy` and `X-Frame-Options: SAMEORIGIN` response headers. The SPA loads this via `<iframe src="/api/render/:id" sandbox="allow-scripts">`. Going through `src=` (not `srcdoc`) is what lets the artifact have its own CSP — srcdoc inherits the parent SPA CSP, `src=` does not.
- `/api/project-artifacts/:projectId/:path...` -> legacy route serving files inside `<project>/.agentuse/artifacts/` directly so existing HTML artifacts can resolve relative URLs. HTML is sanitized; other types pass through with a type-appropriate CSP.
- `/api/project-files/:projectId/:path...` -> project-root route for whole-project discovery. It rejects ignored paths and unsupported extensions so the viewer does not become a general-purpose source/config file server. HTML is sanitized; safe support files such as CSS/images/fonts pass through with type-appropriate headers.
- Everything else falls back to `viewer-dist/index.html` for SPA routes (`/p/:projectId`, `/p/:projectId/a/:name`, `/p/:projectId/a/:name/f/:expandedId`, etc.).

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

- React 18 + Vite, no router library. Routing is a hand-rolled `parseRoute` / `navRoute` over `window.location` in `App.tsx`. Path shape: `/p/:projectId[/a/:name[/v/:rev]][/f/:expandedId]?d=1`. The `r/:runId` and `v/:rev` segments still parse for backward-compat with bookmarked URLs, but local-fs artifacts always have one revision and no run tag.
- Manifest is polled every 2s from `/api/manifest`. There is no websocket or SSE.
- HTML artifacts render via `<iframe src="/api/render/:id" sandbox="allow-scripts">` for ID-based fallback, or through project-local file routes when a project-relative path is available. Markdown is fetched from the corresponding local file route or `/api/artifact/:id`; leading YAML-style frontmatter is parsed client-side into a metadata panel, then the remaining body is rendered with `react-markdown` + `remark-gfm` + `rehype-highlight`.
- `react-zoom-pan-pinch` powers the canvas pan/zoom. If you touch gestures here, mind the conflict between iframe scrolling and the parent pan handler.

## Conventions specific to this repo

- TypeScript: `strict` + `noUncheckedIndexedAccess`. Indexed access into `manifest.artifacts[id]` returns `T | undefined`; respect this rather than `!`-asserting blindly. `latest[projectId]` is the same.
- ESM throughout. Imports use `.js` extensions even for `.ts` source (NodeNext-style for `Bundler` resolution).
- Never call `process.exit` outside `cli.ts`'s `fail()` / commander callbacks. Library code throws `CliError`.
- Registry writes go `tmp + fsync + rename` through `writeManifestAtomic`. Artifact files themselves are owned by the user/agent and the CLI does not write to them.
- When adding a CLI flag, also add a JSON-output shape to the corresponding `emit()` call so `--json` consumers see it.
