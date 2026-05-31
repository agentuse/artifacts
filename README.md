<h1 align="center">@agentuse/artifacts</h1>

<p align="center">
  <strong>A local-first artifact viewer for AI agents.</strong><br/>
  Save reports, dashboards, screenshots, and plans as real files, then browse them in one live gallery.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@agentuse/artifacts"><img src="https://img.shields.io/npm/v/@agentuse/artifacts.svg?color=cb3837&label=npm" alt="npm version"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/@agentuse/artifacts.svg?color=43853d" alt="node"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/@agentuse/artifacts.svg?color=blue" alt="license"></a>
</p>

<p align="center">
  <img src="screenshot.png" alt="@agentuse/artifacts viewer screenshot" width="900">
</p>

AI agents produce useful files, but those files often end up buried in a transcript or scattered across a project. `@agentuse/artifacts` gives them a predictable home and gives you a fast local viewer for everything they make.

Version 0.2.0 adds project-wide discovery: the viewer can find supported artifact files across registered project directories, not only inside `.agentuse/artifacts`. You can turn that broader scan off in the viewer Settings sheet if you only want the dedicated artifact folder.

## Install

Install the Skill for your coding agent:

```bash
npx skills add agentuse/artifacts
```

Install it globally if you want every project to use the same artifact behavior:

```bash
npx skills add agentuse/artifacts -g
```

Optionally install the CLI globally so the viewer starts instantly:

```bash
npm install -g @agentuse/artifacts
```

Requires Node.js 20+.

## Use With Different Agents

`@agentuse/artifacts` is agent-agnostic. There are two ways to use it:

| Agent type | Recommended setup |
| --- | --- |
| Claude Code, Cursor, Codex, Windsurf, Cline, and other interactive coding agents | Install the Skill with `npx skills add agentuse/artifacts`, then ask the agent to save reports or dashboards as artifacts. |
| AgentUse and other async/scheduled agents | Install the same Skill globally with `npx skills add agentuse/artifacts -g`, then tell the agent to write outputs under `.agentuse/artifacts/<name>/index.md` or `.html`. |
| Custom runners, CI jobs, and shell scripts | Write supported files directly into `.agentuse/artifacts` or anywhere in a registered project, then open the viewer with `npx @agentuse/artifacts open`. |
| Remote VMs or chat-based agents | Run the viewer on the machine where artifacts are written. It binds to `127.0.0.1:7878`; use SSH port forwarding, Tailscale Serve, or another private tunnel to view it from your laptop. |

If the `skills` CLI does not know your agent yet, copy `skills/agentuse-artifacts/SKILL.md` into that agent's skill or instruction directory. The underlying contract is just files on disk plus the local viewer.

## Use

Ask your agent to save something as an artifact:

```text
save this report as an artifact
render this plan as a viewable HTML artifact
/agentuse-artifacts drop this to artifacts
```

The Skill guides the agent toward this layout:

```text
<project>/.agentuse/artifacts/
  market-analysis/index.md
  customer-report/index.html
  customer-report/chart.png
```

Open the viewer from any registered project:

```bash
npx @agentuse/artifacts open
```

The viewer renders Markdown, AgentUse `.agentuse`, HTML, PNG/JPG/WebP, and PDF files. HTML artifacts are sanitized and loaded in a sandboxed iframe.

## What 0.2.0 Changes

- Project-wide artifact discovery is on by default for registered projects.
- The Settings sheet can add/remove projects, edit ignore patterns, and disable project-wide discovery.
- The viewer lazy-loads only the selected project's artifact inventory for better performance.
- Markdown, AgentUse, HTML, image, and PDF previews render directly on the canvas.
- Canvas navigation, image zoom, mobile behavior, and hot reload performance are improved.

## Discovery Rules

The dedicated `.agentuse/artifacts` folder is always scanned. This is still the best place for generated agent output.

When project-wide discovery is enabled, the viewer also scans registered project roots for supported files:

```text
docs/report.md
agents/daily.agentuse
screenshots/flow.png
dashboards/revenue.html
```

Dependency, build, cache, VCS, hidden dot paths, and configured ignore patterns are skipped. Manage these patterns in Settings.

Viewer state lives under:

```text
~/.agentuse/artifacts/
  manifest.json
  settings.json
  preview-cache/
  .serve.pid
```

Set `AGENTUSE_ARTIFACTS_HOME` to use a different storage root.

## CLI

Every command supports `--json`.

| Command | Description |
| --- | --- |
| `artifacts init` | Register the current directory and create `.agentuse/artifacts`. |
| `artifacts open [--port N] [--detach] [--no-browser]` | Register the current project, start or reuse the viewer, and print its URL. |
| `artifacts serve [--port N] [--detach] [--stop] [--fail-if-running]` | Manage only the local viewer server. |
| `artifacts list` | List supported artifacts discovered in the current project. |
| `artifacts url [name]` | Print a viewer URL for the project or a specific artifact name. |
| `artifacts where` | Print the global storage path. |
| `artifacts project list / add / forget / prune` | Manage registered project directories. |

## Security

Stored HTML artifacts are treated as untrusted:

- HTML is parsed and sanitized at render time.
- Rendered HTML gets a strict CSP with `connect-src 'none'`.
- HTML runs inside an iframe sandbox without `allow-same-origin`.

Do not relax these defaults casually. Artifacts are often generated from untrusted web pages, PRs, scraped docs, and model output.

## Development

```bash
npm install
npm run build
npm test
npm run typecheck
```

For local development:

```bash
npm run dev:server
npm run dev:viewer
```

## License

[MIT](LICENSE) (c) 2026 Leon Ho.
