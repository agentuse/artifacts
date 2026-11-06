# Changelog

## Unreleased

### Added

- **Any single file can be submitted.** Video (mp4, m4v, mov, webm) and audio (mp3, m4a, aac, wav, ogg, flac) play inline, with a video frame as the feed thumbnail. Text, code, and data files (txt, log, csv, json, yaml, srt, vtt, ts, py, ...) show verbatim with a short excerpt on the card. Anything else becomes a `file` entry with a download card instead of being refused.
- Single files may be up to 2GB (directory bundles keep the 25MB cap). Bundle files are streamed with HTTP byte ranges, so Safari can play and seek large videos, and hashing reads in chunks instead of loading whole files.
- **Comment on an artifact from the viewer and the agent that made it finds out.** Comments stay with the artifact across revisions. Agents read them with `artifacts comments [slug]`, close them with `artifacts resolve <id...>`, and see open ones every time they `submit`. An agent running in a Herdr pane also gets a short message pointing it at the new comment, with no setup; the comment text itself is never typed into the terminal.
- **Highlight text in a markdown or plain text artifact to comment on that passage.** The agent gets the quote with the words around it.
- `ARTIFACTS_VIEWER_URL` sets the origin of every printed link (for example the viewer's Tailscale address), so a link from `submit` opens on other devices.

### Unchanged on purpose

- Directory bundles pick their entry file and count toward the cap exactly as before: media and data files are not entry candidates and are still skipped inside a directory, so existing design folders submit the same way.

## 0.6.0 - 2026-10-05

### Added

- **Permalinks that follow the newest revision.** `/p/:projectId/:slug` always shows an artifact's latest revision, and it is now the address feed cards open and "Copy link" hands out. `submit` prints it as `url`; the specific-revision `/a/:entryId` link moves to `revisionUrl` in `--json`. New `GET /api/latest/:projectId/:slug` route backs it.
- Shared artifacts update themselves: while `serve` runs, a new revision of an already-shared slug is pushed to its existing cloud URL. Failed pushes retry every 60s. Shares are never created automatically.
- Shared cards are marked in the feed.
- Share management works through the viewer served over Tailscale (`*.ts.net`), not only on loopback.

### Changed

- **Feed filters redesigned.** On a phone, project and tag buttons open a bottom-sheet picker with counts and search; from 800px a sidebar keeps projects and top tags in view and cards flow into a grid. Card metadata is a single non-interactive line plus at most two tags. `/` focuses search.
- Filter options narrow by the other filters: picking a project shows only that project's tags, and vice versa. `FeedPage` gains `all` and `facetTotals`.
- The feed header hides on scroll down at phone widths and returns on scroll up.
- The artifact page header is one row (back, title, share, full screen, more). The title opens a details sheet with revisions, project, tags, type and size. Older revisions are marked and offer Go to latest.
- A Full screen toggle on the artifact page hides the header; Esc or the floating button brings it back without reloading the artifact.

### Removed

- The viewer's Projects sheet and `DELETE /api/projects/:id`. Use `artifacts project forget` to drop a project.

## 0.5.0 - 2026-09-15

This is a breaking upgrade from 0.3.0. Version 0.4.0 was an unreleased development version; the changes below cover the entire transition from the last npm release.

A rewrite around one idea: an artifact reaches the viewer because an agent **submitted** it, not because a scanner found it.

### Breaking changes from 0.3.0

- Existing files do not appear until submitted or imported. The project registry and whole-project scanner are no longer used.
- Existing `/p/:projectId/a/:name` links and the old local HTTP API are not compatible. New submissions return `/a/:entryId` links.
- `init`, `list`, `project add`, `project prune`, and `url <target> --full` are removed. Update agent instructions and scripts before upgrading.
- Source edits no longer change a displayed artifact automatically. Submit again to create a revision; use **Update** separately to publish that revision to an existing cloud link.
- `project forget` deletes stored local copies as well as feed entries. It does not revoke cloud shares. Use Shared artifacts to remove those separately.

### Added

- Optional cloud sharing with **Share**, **Shared**, and **Update** states. Updates retain the same URL, and successful copying displays a confirmation.
- Shared-artifact management with authenticated listing, published revision metadata, copy/open actions, and cloud removal independent of local deletion.
- Supplementary files in directory bundles, including CSV, TSV, text, Office documents, and ZIP files. Cloud downloads include the complete original bundle as a ZIP.
- Cloud upload credentials remain on the local server. Sharing controls are hidden when configuration is missing. Local use does not require a cloud account or key.

- `artifacts submit <path>` copies a file or a whole directory bundle into `~/.agentuse/artifacts/store/` and appends one line to an append-only feed log. Prints the artifact's URL. No setup step is needed.
- `--title`, `--tag` (repeatable or comma-separated), and `--slug` on submit. Titles fall back to markdown frontmatter, the first heading, or the HTML `<title>`.
- `artifacts feed` lists submissions newest-first, with `--project`, `--tag`, `--limit`, and `--all-revisions`.
- `artifacts import` submits everything already sitting in a project's `.agentuse/artifacts/`, the migration path from 0.3.x.
- `artifacts prune [--keep N]` deletes superseded revisions from the store.
- Revisions: re-submitting the same slug adds `rev N` instead of a duplicate card, and the detail page links every revision. Byte-identical re-submits with unchanged title and tags are a no-op.

### Changed

- **The viewer is a feed.** One reverse-chronological column with filter chips for project and tag, search, and a detail page per artifact. Routes are now `/` and `/a/:entryId`.
- **Mobile is the primary target.** Single column, 44px touch targets, lazy card previews, safe-area insets, and pinch-zoom re-enabled.
- Artifacts are copied into the store rather than referenced in place, so a feed entry keeps working after the source file is edited, gitignored away, or deleted with its branch.
- `artifacts url` now prints the feed URL for the current project; `open` opens the feed filtered to it.
- `project list` now lists the projects the feed actually reports, with an artifact count each. `project forget <projectId>` deletes every artifact from a project, feed lines and stored bundles.

### Removed

- Project-wide file discovery, along with the ignore-pattern settings, the `maxProjectScanEntries` cap, and the Settings sheet that configured them.
- **The project registry.** `manifest.json` is no longer read or written. Registering a project only mattered while a scanner needed to know where to look; a project is now simply whatever the feed reports. Gone with it: `artifacts init`, `artifacts project add`, `artifacts project prune`, the `--keep-artifacts` flag on `project forget`, and the `GET`/`POST /api/projects` and `POST /api/projects/prune` routes. The viewer's Projects sheet now lists projects by artifact count and only deletes.
- The pan/zoom canvas, tile resizing, and persisted tile sizes.
- `artifacts list`, `artifacts url <target> --full`, and the `/api/manifest`, `/api/artifact/:id`, `/api/render/:id`, `/api/project-files/…`, `/api/project-artifacts/…`, and `/api/settings` routes.

### Fixed

- Preserve project identity when resubmitting imported legacy files and bundles outside Git repositories, so edits create revisions instead of duplicate artifacts.

### Upgrading

Existing artifacts are no longer discovered automatically. Run `npx @agentuse/artifacts import` once per project to publish what is already in `.agentuse/artifacts/`, and update any agent instructions to call `submit` after writing a file. Old `/p/:projectId/a/:name` links do not resolve; the feed is at `/`. `~/.agentuse/artifacts/manifest.json` is now unused and safe to delete.

## 0.3.0 - 2026-06-09

### Added

- Added path-based artifact deep links through `artifacts url <target> --full`, so agents can hand users a stable link that opens a specific file fullscreen.
- Added a `maxProjectScanEntries` setting to bound project-wide discovery in very large repositories while keeping the dedicated `.agentuse/artifacts` folder uncapped.

### Improved

- Rendered single newlines as line breaks in markdown previews, matching the way agent-written reports and notes are usually formatted.
- Added the AgentUse mark as the viewer favicon.
- Allowed text selection in fullscreen markdown artifacts so users can copy content directly from expanded reports.

### Fixed

- Stopped pathological project-wide scans from hanging the viewer indefinitely by capping synchronous directory traversal and warning once when the cap is reached.

## 0.2.1 - 2026-05-31

### Added

- Added a project-wide discovery setting so teams can choose whether the viewer scans all supported files in registered project directories or stays limited to explicit artifact folders.

### Improved

- Improved fullscreen image zoom controls so image artifacts remain easier to inspect without unnecessary control noise.
- Improved native Shift+wheel canvas panning so horizontal navigation works reliably across browser wheel event paths.

### Fixed

- Fixed embedded HTML artifacts intercepting native Shift+wheel events before the parent canvas could pan.

## 0.2.0 - 2026-05-31

### Added

- Discover supported artifact files across registered project directories, so artifacts no longer need to be copied into `.agentuse/artifacts` to appear in the viewer.
- Added a viewer settings sheet for project registry management and project scan ignore patterns.
- Added support for AgentUse `.agentuse` previews, including nested frontmatter rendering.
- Added full markdown and HTML preview rendering on the canvas.
- Added keyboard canvas navigation with arrow keys and fullscreen toggle via Space.
- Added fullscreen image zoom.
- Added mouse wheel, trackpad scroll, and native Shift+wheel horizontal canvas panning.

### Improved

- Reworked artifact organization into project files and artifact packages with tree-style browsing.
- Improved canvas performance with selected-project lazy loading, virtualized rendering, lighter mobile previews, and cached preview sizing.
- Improved mobile behavior for the project/artifact panes and low-zoom canvas views.
- Improved canvas layout with roughly ten artifacts per row and consistent spacing.
- Improved fullscreen open/close animation from the originating canvas tile.
- Improved image previews to resize without cropping.
- Defaulted HTML artifact backgrounds to white when the artifact does not declare its own background.

### Fixed

- Reduced mobile Safari crash risk when zoomed out on large artifact sets.
- Fixed slow/jittery canvas panning paths on mobile and desktop.
- Fixed repeated image reloads while zooming out.
- Fixed nested YAML frontmatter display for markdown and AgentUse artifacts.

## 0.1.0 - 2026-04-29

### Added

- Initial public release of `@agentuse/artifacts`.
- Added the `artifacts` CLI for registering projects, starting the local viewer, and opening artifact URLs.
- Added the local viewer server and SPA canvas for browsing AI agent artifacts.
- Added project-local artifact discovery under `.agentuse/artifacts`.
- Added markdown and sandboxed HTML artifact rendering.
- Added image, PDF, and binary artifact serving with type-specific CSP handling.
- Added raw artifact download and copy actions.
- Added project registry storage under the user's home directory.
- Added responsive canvas layout, focused tile mode, resizable tiles, and persisted tile sizes.
- Added overlay project/artifact panes, directory grouping, project sorting, and artifact metadata display.
- Added AgentUse skill documentation for saving artifacts into project-local artifact folders.

### Improved

- Styled the viewer with the AgentUse palette and Geist fonts.
- Improved artifact tile refresh with content-hash cache busting.
- Preserved iframe scroll position across artifact hot reloads.
- Collapsed tile actions into a compact action menu.
- Documented the registry, viewer model, async/interactive agent usage, and committed-artifact workflow.

### Security

- Rendered stored HTML artifacts through a sanitizer and strict CSP.
- Kept sandboxed artifact rendering isolated from the parent viewer where possible.
