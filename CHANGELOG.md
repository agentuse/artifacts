# Changelog

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
