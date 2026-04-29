# @agentuse/artifacts

A small CLI plus local web viewer for collecting markdown and HTML artifacts emitted by AI agents. The CLI ingests files (or stdin) into a content-addressed store under `~/.agentuse/artifacts/`. The viewer is a single-page React app served by the same CLI process.

[![npm](https://img.shields.io/npm/v/@agentuse/artifacts.svg)](https://www.npmjs.com/package/@agentuse/artifacts)
[![node](https://img.shields.io/node/v/@agentuse/artifacts.svg)](https://nodejs.org)

## Install

```bash
npm install -g @agentuse/artifacts
# or run ad-hoc
npx @agentuse/artifacts --help
```

Requires Node.js >= 20.

## Quick start

```bash
# Register the current directory as a project
artifacts init

# Add a markdown or HTML file
artifacts add ./report.md

# Tag a batch of artifacts as belonging to a run
artifacts add ./plan.md ./summary.html --run my-run-2026-04

# Pipe from stdin (requires --name)
some-agent | artifacts add - --name daily-summary.md

# Open the viewer
artifacts open
```

The viewer is a local SPA at `http://127.0.0.1:7878/` that lists projects, runs, and individual artifact revisions, and renders both markdown and sandboxed HTML.

## Commands

| Command | What it does |
| --- | --- |
| `artifacts init` | Create `.agentuse/artifacts/` and register the current project. |
| `artifacts add <sources...>` | Ingest files or stdin (`-`) as new artifact revisions. |
| `artifacts list` | List project-local artifacts in `.agentuse/artifacts`. |
| `artifacts open` | Register the project, ensure the viewer is running, and open it. |
| `artifacts url [name]` | Print the viewer URL for the project, run (`--run`), or artifact (`--revision`). |
| `artifacts where` | Print the global storage path. |
| `artifacts revert <name> --to <rev>` | Roll back: create a new revision with the content of an older one. |
| `artifacts rm <name> --revision <n>` | Delete a single revision. |
| `artifacts prune --older-than 30d` | Remove old artifacts, or use `--keep-latest-only`. |
| `artifacts fsck` | Verify the manifest and rebuild the `latest` map. |
| `artifacts project list / add / forget / prune` | Manage the cross-project registry. |
| `artifacts serve [--port N] [--detach] [--stop]` | Run the viewer server. |

Every command supports a global `--json` flag that swaps the human output for a stable JSON envelope, with non-zero exit codes mapped to `ErrorCode` values for scripting.

### Adding artifacts with run tags

A run is just a string. Same string = same run, new string = new run record (created lazily). Untagged adds have no run.

```bash
artifacts add report.md --run release-2026-04
# or via env, useful inside agent runners:
AGENTUSE_RUN_ID=release-2026-04 artifacts add report.md
```

### Suggested viewer tile size

```bash
artifacts add dashboard.html --width 1200 --height 800
```

User resize wins; the viewer floors small values.

## Storage layout

Everything lives under `rootDir()`, default `~/.agentuse/artifacts/`:

```
~/.agentuse/artifacts/
  manifest.json           # projects, runs, artifacts, latest{} map (atomic + locked writes)
  files/<projectId>/      # immutable content blobs (.md or .html)
  .lock                   # advisory lock for cross-process manifest writes
  .serve.pid              # JSON record of the running viewer (pid + port)
```

Override the root with `AGENTUSE_ARTIFACTS_HOME` (also how the test suite isolates state).

`projectId` is derived stably:
- Inside a git repo: hash of the first commit SHA, so it survives moves, rebases, and clones.
- Otherwise: hash of the realpath.

## Security model for HTML artifacts

The agent producing artifacts is developer-controlled, but its inputs (web pages, PRs, docs) are not. The realistic risk is prompt injection routing through the agent into artifact markup, so HTML artifacts are sanitized on render and shipped through a CSP that:

- Permits external `https:` for `script`, `style`, `font`, `img` (designs commonly use Tailwind Play CDN, Google Fonts).
- Locks `connect-src 'none'` to deny `fetch` / `XHR` / `WebSocket`, killing exfiltration and LAN scans.
- Sets `frame-src 'none'`, `object-src 'none'`, `base-uri 'none'`.

Origin isolation comes from the iframe `sandbox="allow-scripts"` (no `allow-same-origin`), so scripts run in an opaque origin and cannot read the parent viewer's DOM, localStorage, or cookies.

## License

MIT (c) 2026 Leon Ho. See [LICENSE](LICENSE).
