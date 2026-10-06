# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@agentuse/artifacts`: a Node CLI plus a local web viewer for artifacts emitted by AI agents. Agents call `artifacts submit <path>`; the CLI copies that file (or directory bundle) into a central store and appends one line to an append-only feed log. The viewer is a mobile-first React SPA showing that feed newest-first, filterable by project and tag.

**Submit, not discovery.** Before 0.4.0 the viewer scanned registered projects for supported files. That is gone: nothing reaches the feed unless it was submitted. Don't reintroduce a scanner, it made "what's new" unanswerable (mtime lies) and cost a full filesystem walk per manifest poll.

**No project registry either.** Registering a project only ever existed to tell the scanner where to look, so it went with the scanner. `resolveProject()` derives a `projectId` from the git root on the fly, and everything downstream (feed chips, `project list`) reads the projects out of the feed entries themselves. Don't add a registry back: an "add project" button that makes nothing appear is worse than no button.

## Commands

- `npm run dev -- <args>` runs the CLI via `tsx` against `src/bin.ts`. Example: `npm run dev -- feed`.
- `npm run build` builds the viewer first (`viewer/` -> `viewer-dist/`) then compiles the CLI (`src/` -> `dist/`). The viewer must exist before `serve` will start.
- **The always-on viewer is the pm2 process `agentuse-artifacts`** (`dist/bin.js serve --port 7878`, no watch). It reads `viewer-dist/` per request, so a viewer-only rebuild goes live on reload, but it holds `dist/` in memory: after any `src/` change, `npm run build:cli && pm2 restart agentuse-artifacts`. Otherwise a rebuilt viewer can call routes the old server lacks and artifacts fail to open. Restart through pm2 (no `--update-env`), never `serve --stop`/`--detach` from an agent shell: pm2 holds `ARTIFACTS_CLOUD_URL`/`ARTIFACTS_CLOUD_API_KEY`, agent shells don't.
- `npm run build:cli` and `npm run build:viewer` run the two halves independently. Touching only `src/` -> rebuild CLI; touching only `viewer/src/` -> rebuild viewer.
- `npm run watch` runs both watchers in one shell: `tsx watch` for the server (auto-restart on `src/` changes) and `vite build --watch` for the viewer (incremental rebuild into `viewer-dist/`). Stop any detached server first (`npm run dev -- serve --stop`); otherwise the watcher's server falls back to port 7879 silently. Refresh the browser to pick up viewer rebuilds.
- `npm run dev:viewer` runs the Vite dev server with HMR (port 5173), `/api/*` is proxied to `127.0.0.1:7878`, so a separate server (`npm run dev:server` or a detached `serve`) must be running. Use this for fast iteration on `viewer/src/`; use `npm run watch` when you also need the production-build output in `viewer-dist/`.
- `npm run typecheck` does a no-emit `tsc` over `src/` only. The viewer has its own `tsconfig.json` and is typechecked as part of `build:viewer`.
- `npm test` runs vitest once. `npm run test:watch` for watch mode. Run a single file: `npx vitest run tests/store.test.ts`. Run a single test: `npx vitest run -t "name fragment"`. Tests use `pool: forks` with `singleFork: true` because they touch a shared on-disk store.
- Tests must isolate state by setting `AGENTUSE_ARTIFACTS_HOME` to a temp dir (see `tests/helpers.ts`). Otherwise they will read/write the user's real `~/.agentuse/artifacts/`.

## Architecture

### Two packages, one repo

- Root package = the CLI (`src/`, ESM, Node 20+, output to `dist/`). Bin entry is `dist/bin.js` -> `runCli()` in `src/cli.ts`.
- `viewer/` = a separate Vite + React 18 SPA with its own `package.json` and `node_modules`. It builds into `viewer-dist/` at the repo root (note: `--outDir ../viewer-dist`), which is what gets shipped in the npm package alongside `dist/`.
- Both `dist/` and `viewer-dist/` are gitignored but listed under `package.json#files` for publish.

### Storage layout

Everything lives under `rootDir()` (default `~/.agentuse/artifacts/`, overridable via `AGENTUSE_ARTIFACTS_HOME`):

- `feed.jsonl`, the append-only submission log. One `FeedEntry` per line, oldest first. This is the source of truth for what exists.
- `store/<projectId>/<slug>/<rev>/…`, the copied bundles. Immutable once written; a re-submit writes a new `<rev>`.
- `preview-cache/`, generated WebP thumbnails, keyed by entry id + contentHash + width.
- `.lock`, advisory lock for whole-file feed rewrites.
- `.serve.pid`, JSON record of the running viewer server (pid + port + startedAt).

**Why the store copies instead of pointing at the project file.** Three reasons, all load-bearing:
1. A feed entry is a snapshot of a moment. Pointing at a mutable file makes the feed lie about what was submitted.
2. Agent output lives in gitignored scratch dirs. A branch switch, `git clean`, or a deleted worktree would 404 half the feed.
3. Revisions come free, the old bundle is still on disk under its own `<rev>`.

The cost is disk. `pruneStore()` (CLI: `artifacts prune`) keeps the newest N revisions per slug and deletes the rest, from both the log and disk.

### Feed log semantics (`src/feed.ts`)

- **Appends do not take the lock.** A single `O_APPEND` write under the pipe-buffer size is atomic, so concurrent agents can submit without contending. `appendFeedEntry()` rejects lines over 8KB to keep that guarantee. Only `writeFeedAtomic()` (prune / forget) needs `withLock`.
- **Readers fold the log.** `queryFeed()` keeps the newest `rev` per `(projectId, slug)` unless `allRevisions` is set. Facet counts (`projects`, `tags`) are faceted search: each counts the entries matching every *other* filter plus the search, never its own, so choosing a project narrows the tags to that project's while the other projects stay listed (switching is one tap). A selected value that no longer matches is kept at count 0 so it can be cleared. `all` is the unfiltered count and `facetTotals` what each facet counted (the "All projects" / "Any tag" figures).
- **Malformed lines are skipped, not fatal.** A hand-edited log should degrade, not brick the viewer.
- `readFeedEntries()` caches on `feedStamp()` (`path:mtimeMs:size`). The path is in the stamp because `AGENTUSE_ARTIFACTS_HOME` changes within a process in tests.
- Pagination is an integer offset into the sorted, filtered list. Fine because the whole log is read anyway; revisit only if a log gets large enough that parsing it dominates.

### Bundle semantics (`src/store.ts`)

- `submitArtifact()` takes a file or a directory. A directory's entry file is the first of `index.html/htm/md/markdown/agentuse`; failing that, the single renderable file; failing that it throws rather than guessing.
- Support files (css, svg, ico, json, fonts, gif) are copied alongside renderable types so relative URLs resolve. `node_modules`, `.git`, `dist`, `build`, `coverage`, `__pycache__`, dotfiles, and symlinks are skipped.
- Caps are checked **during the walk, before any copy**: `MAX_BUNDLE_FILES` (200) and `MAX_BUNDLE_BYTES` (25MB). A too-large bundle fails loudly and leaves nothing behind.
- The copy goes to a `.tmp.<pid>` sibling and is renamed into place, so a crash mid-copy can't leave a half-written bundle behind a feed line that points at it.
- **Dedupe requires content *and* metadata to match.** Same `contentHash` + same title + same tags → return the existing entry, `deduped: true`, no new line. A changed title or tag is a real edit and becomes a revision. This is what keeps agent re-runs from spamming the feed while still letting a re-tag land.
- `deriveTitle()` precedence: `--title`, frontmatter `title:`, first `#` heading (fenced code blocks skipped, READMEs are full of `# comment` lines), HTML `<title>` then `<h1>`, humanized slug.

### Feed-rewrite concurrency

Whole-file rewrites of `feed.jsonl` go through `withLock()` in `src/lock.ts`:
1. Atomic `open(..., "wx")` on `.lock` with a JSON body (`pid`, `host`, `acquiredAt`).
2. Stale lock detection: locks older than 60s OR same-host with a dead pid get reclaimed.
3. Acquisition timeout is 5s; failure throws `LOCK_TIMEOUT` and includes the holder.
4. SIGINT/SIGTERM release the lock before exit.
5. Writes use a `tmp` + `rename` pattern with `fsync`.

Reads outside `withLock` are tolerated (the rewrite is a `tmp` + `rename`). There are exactly two writers: `pruneStore()` and `forgetProjectArtifacts()`. Appending to the feed deliberately does **not** take the lock, see "Feed log semantics".

### Project identity

`resolveProject()` in `src/project.ts` derives a stable `projectId`:
- If the cwd is in a git repo: `proj_` + `sha12("git:" + first-commit-sha)`. This survives moves, rebases, and clones because the root commit is fixed.
- Empty git repo or non-git: `proj_` + `sha12("path:" + realpath)`.

This is why moving a project directory keeps its artifacts; rewriting git history (changing the root commit) creates a new project.

Note the ordering consequence: `submit` derives the project from the **target's** directory (or `opts.cwd`), not the process cwd, so submitting a path in another repo files the artifact under that repo.

### Identity of an artifact

- `slug`, the artifact's identity within a project, derived from the path basename unless `--slug` is given. **Same slug = same artifact**, so two unrelated files that reduce to the same slug become revisions of each other. That is the intended trade-off; `--slug` is the escape hatch.
- `rev`, 1-based ordinal, zero-padded to 4 digits in the store path. Not a hash: hashing a whole directory per lookup is slow and the paths should stay human-readable.
- `id`, `art_` + `sha16(projectId \0 slug \0 rev)`. Stable, so a deep link keeps working; and because it folds in `rev`, an entry id always names one immutable bundle. That is what lets `/api/store/:id/*` be `immutable`-cacheable.

### Viewer server (`src/server.ts`)

Routes:
- `GET /api/feed?project&tag&q&limit&cursor` -> a `FeedPage`: entries, `nextCursor`, `total`, and the project/tag facets. ETag is `sha(feedStamp + query)`, so the viewer's 5s poll is a conditional request that normally 304s.
- `GET /api/entry/:id` -> `{ entry, revisions }` for the detail page. Same ETag scheme as the feed (`feedStamp` + id): the detail view polls this every 5s so a new revision shows up while you're on the page, and it 304s while nothing changes. The viewer auto-follows the newest revision only when the latest one is on screen; an explicitly opened older revision stays put.
- `GET /api/store/:entryId/:path...` -> one file out of the stored bundle. An empty path serves the entry file. HTML is sanitized on every read; other types get a type-appropriate CSP. `cache-control: immutable` is safe here **only** because an entry id names one immutable revision.
- `GET /api/preview/:entryId?w=` -> cached WebP thumbnail for image entries. 400 for non-images.
- `GET /api/raw/:entryId` -> the entry file exactly as submitted, `application/octet-stream` + `Content-Disposition: attachment` (powers Download / Copy content; never rendered inline).
- `GET /api/latest/:projectId/:slug` -> the same payload and ETag scheme as `/api/entry/:id`, for whichever revision is newest. Backs the viewer's `/p/:projectId/:slug` permalink route.
- Everything else falls back to `viewer-dist/index.html` for SPA routes (`/`, `/p/:projectId/:slug`, `/a/:entryId`).

There is no `/api/manifest`, `/api/artifact/:id`, `/api/render/:id`, `/api/project-files/…`, `/api/project-artifacts/…`, `/api/settings`, or `/api/projects` any more. Most belonged to the scanner and the registry it needed; the last, `DELETE /api/projects/:id` behind the viewer's Projects sheet, was dropped because the chips already show the projects and a one-tap delete-a-whole-project was a phone-sized footgun. `artifacts project forget` is the way to drop a project.

Cloud share sync: a share link names the artifact (project + slug), not a revision. While `serve` runs, `startShareSync()` checks `feedStamp()` every 5s and calls `syncSharedArtifacts()`, which pushes the newest revision of every already-shared slug to its existing URL (`PUT`). It never creates a share (`existingOnly`): a link revoked in the cloud is marked revoked locally and left alone. Failed pushes keep the card in "update" and retry every 60s. This lives in the server, not `submit`, because only the server holds `ARTIFACTS_CLOUD_API_KEY`. To freeze a shared snapshot, submit later versions under a different `--slug`.

Share routes (`/api/entry/:id/share`, `/api/shares*`) are gated by `allowShareRequest()`: they publish private artifacts, so a cross-site page or a DNS-rebinding host must never reach them. Accepted: a loopback `Host` with a loopback or absent `Origin`, or a `*.ts.net` `Host` (the viewer through `tailscale serve` / a Tailscale Service) whose `Origin` is exactly `https://<host>`, or, on same-origin GETs where browsers omit `Origin`, `Sec-Fetch-Site: same-origin`. Every case also needs `x-artifacts-share: 1` and a JSON content type. `ts.net` names are safe to trust because only Tailscale can point one at this machine; this does mean any device on the tailnet can share. Never widen this to arbitrary hosts.

Server lifecycle:
- `serve` writes `.serve.pid`. `serve --detach` re-spawns `dist/bin.js serve --port N` with `detached: true` and `stdio: "ignore"`, then polls `.serve.pid` for up to 5s. `serve --stop` SIGTERMs and cleans up.
- Default port `7878`, with sequential fallback up to `+50` on `EADDRINUSE`.
- `viewerDistDir()` probes three candidate paths so it works in compiled (`dist/server.js -> ../viewer-dist`), tsx-dev (`src/server.ts -> ../viewer-dist`), and `viewer/dist` layouts. Edit this if you change the build output location.

### HTML sanitization (security-critical)

`src/sanitize.ts` is the trust boundary for ingested HTML artifacts. It runs at **serve time**, not ingest time, so changes to the sanitizer take effect for already-stored artifacts. Two layers:

1. `scrubHtml()` parses with `node-html-parser` (no regex on tags) and removes: `<base>`, `<meta http-equiv="refresh">`, `<link rel>` with `preload|prefetch|dns-prefetch|preconnect|modulepreload`.
2. `buildSafeSrcdoc()` injects `META_CSP` as a `<meta http-equiv="Content-Security-Policy">` as the first child of `<head>` (creating one if missing). The same policy is also sent as a response header from `/api/store/:id/…`, the meta tag is defense in depth (survives if the file is saved or opened directly).

**Threat model:** the agent producing artifacts is developer-controlled, but its inputs (web pages, PRs, docs) aren't. The realistic risk is prompt-injection routing through the agent into artifact markup. So `META_CSP` permits external `https:` for script/style/font/img (designs use Tailwind Play CDN, Google Fonts) but locks `connect-src 'none'` to deny `fetch`/`XHR`/`WebSocket`, kills exfil + LAN scan. `frame-src 'none'`, `object-src 'none'`, `base-uri 'none'` close the rest.

**Origin isolation comes from the iframe, not the CSP.** `viewer/src/components/Render.tsx` sets `sandbox="allow-scripts"` on the detail view *without* `allow-same-origin`, so the iframe lives in an opaque origin. Scripts in the artifact cannot read the parent viewer DOM, localStorage, or cookies regardless of what the CSP allows. Do not add `allow-same-origin` to the sandbox attribute, it would defeat the isolation and the threat model assumes scripts run. Feed card thumbnails go further with a bare `sandbox=""` (no scripts at all), a preview should never execute anything, and a feed can show dozens at once.

Path containment for `/api/store/:id/*` lives in `resolveBundleFile()`: it decodes once, normalizes backslashes, rejects `..`/`.`/empty segments, then re-checks that the resolved absolute path is still under the bundle root. Bundles contain no symlinks because `collectBundleFiles()` skips them at copy time.

`SPA_CSP` (the viewer SPA's own CSP) is independent because the artifact is loaded via `src=`, not `srcdoc`. No inheritance. Keep `SPA_CSP` tight.

When modifying sanitization: do not switch to regex; do not relax `connect-src` (that's the lever holding back exfil); do not add `allow-same-origin` to the iframe sandbox.

### CLI conventions

- Every command supports a global `--json` that swaps the human output for a structured envelope. Errors use `{ error: { code, message, detail? } }` with stable `ErrorCode` values mapping to fixed exit codes (see `src/errors.ts`). Don't add a new error class without adding it to both `ErrorCode` and `EXIT`.
- `runCli` takes `argv` and uses `commander`'s `from: "user"` parser, which means callers pass post-`process.argv.slice(2)` arguments. `bin.ts` does this slicing.
- Human output goes to stdout for success, stderr for errors. JSON envelopes always go to stdout (including errors).

### Viewer SPA (`viewer/src/`)

- React 18 + Vite, no router library. Routing is a hand-rolled `parseRoute` / `routePath` over `window.location` in `App.tsx`. Routes: `/` (feed), `/p/:projectId/:slug` (the artifact: always its newest revision), and `/a/:entryId` (one specific older revision). The newest revision is always shown at `/p/...`, so the address bar holds the permalink and "Copy link" (which copies `location.href`) hands out a link that keeps working as the artifact is re-submitted: feed cards and the newest revision chip open it, and an `/a/:id` that turns out to be the newest is swapped for it on load. A `/p` page follows new revisions on its own because the server resolves it on every poll. `submit` prints the permalink as `url` (`revisionUrl` in `--json` is the `/a/:id` one). Filter state lives in the query string (`?project=&tag=&q=`) so a filtered feed is linkable and survives reload.
- Files: `App.tsx` (routing + polling + pagination), `components/Feed.tsx` (header, filter bar, sidebar, cards), `components/FilterSheet.tsx` (phone project/tag picker), `components/Detail.tsx` (header, actions, revisions), `components/Render.tsx` (all artifact bodies and card previews), `components/RelativeTime.tsx`, `frontmatter.ts`.
- The feed polls `/api/feed` every 5s with an `if-none-match`; a 304 costs one request and no re-render. When the log *does* change, pagination resets to page one, new artifacts belong at the top, and splicing them into a scrolled list reads as a jump.
- **Card previews are lazy and mount once.** `useSeen` (IntersectionObserver, 400px rootMargin) gates them, and the flag never flips back, so scrolling away doesn't tear down a rendered preview. Without this a long feed mounts one iframe per HTML card at once. Note when screenshotting: `Page.captureScreenshot` with `captureBeyondViewport` does not paint off-screen iframes, so a blank card in a full-page capture is usually the capture, not a bug, scroll it into the viewport and take a normal shot.
- Card layout differs by type: images and HTML get a thumbnail above the title; markdown gets a three-line text excerpt below it (a title under three lines of prose reads backwards).
- **Filters are one responsive layout, broken at 800px.** On a phone: two buttons (project, tag) that each open `FilterSheet`, a bottom-sheet radio list that applies on tap and closes. From 800px: `SideFilters` keeps projects (top 6) and tags (top 12) in view, each with "Show all", and the cards become an auto-fill grid (min 280px columns). Card metadata is one non-interactive mono line plus at most two tags: filtering only happens through the filter controls, because tappable chips inside a card were a mis-tap magnet on a phone. Don't bring back the horizontally scrolling chip row: with ~60 tags it was unusable. "N of M" uses `page.all` as M. `/` focuses search.
- **Headers hide on scroll down, return on scroll up, at phone widths only** (`useAutoHide`, CSS under `max-width: 799px`). The feed and markdown/image detail scroll the window, so the sticky block just slides out. HTML and PDF scroll inside their iframe, so the page never scrolls: there the whole top block (title bar, chips, revisions) collapses with a negative `margin-bottom` of its measured height (`--top-h`) to hand the space to the artifact, and the scroll signal is the `agentuse:scroll` message the artifact's `ARTIFACT_SCROLL_SHIM` already posts, accepted only from the artifact iframe's own window. An open menu or filter sheet pins the header.
- Markdown is fetched from the bundle route; leading YAML-style frontmatter is parsed client-side into a metadata panel, then the body renders with `react-markdown` + `remark-gfm` + `remark-breaks` + `rehype-highlight`. `remark-breaks` makes single newlines render as `<br>` (GitHub-comment style) because agent-emitted markdown often uses single newlines instead of blank-line paragraph breaks. Relative image `src`s are rewritten against the entry file's directory inside the bundle.
- Mobile is the primary target: single column, 44px minimum touch targets, 16px inputs (smaller makes iOS Safari zoom on focus), safe-area insets, and pinch-zoom left enabled in `index.html` (the old pan/zoom canvas is why it used to be disabled).

## Conventions specific to this repo

- TypeScript: `strict` + `noUncheckedIndexedAccess`. Indexed access returns `T | undefined`; respect this rather than `!`-asserting blindly.
- ESM throughout. Imports use `.js` extensions even for `.ts` source (NodeNext-style for `Bundler` resolution).
- Never call `process.exit` outside `cli.ts`'s `fail()` / commander callbacks. Library code throws `CliError`.
- Feed rewrites go `tmp + fsync + rename` through `writeFeedAtomic`. Bundle copies use the same pattern at directory level. The CLI never writes to the user's own project files, it only reads them at submit time.
- When adding a CLI flag, also add a JSON-output shape to the corresponding `emit()` call so `--json` consumers see it.
