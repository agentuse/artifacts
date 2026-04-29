---
name: agentuse-artifacts
description: Save substantial markdown/HTML deliverables as project-local, viewable artifacts using @agentuse/artifacts. Each artifact lives in its own subdirectory under ./.agentuse/artifacts/ (e.g. report/index.html, market-analysis/index.md) so related files stay grouped. Use proactively whenever you generate a report, plan, spec, HTML page, dashboard, chart, or rendered document the user will want to preview in a browser. Also triggers on "save as artifact", "preview this", "render this", "make it viewable", "artifact".
---

# agentuse-artifacts

Use `@agentuse/artifacts` to save AI-generated deliverables into a project-local artifact directory and preview them in the local viewer.

Primary model: every artifact lives in its own subdirectory under `./.agentuse/artifacts/`, even single-file markdown. This keeps related files grouped together and makes it trivial to add support files later.

```txt
<project>/.agentuse/artifacts/
  report/index.html
  report/style.css
  report/chart.png
  notes/notes.md
  market-analysis/index.md
```

Artifacts are normal project files. Support files work through relative paths.

## When to use this

Use this skill when:
- You produced a substantial markdown report, plan, spec, analysis, or summary.
- You generated an HTML page, dashboard, chart, slide, mockup, or rendered document.
- The artifact needs support files like CSS, PNG/JPG/WebP images, fonts, etc.
- The user said "save this", "preview this", "render this", "make it viewable", or "artifact".

Do NOT use for ephemeral one-line answers or normal source-code changes that already belong elsewhere in the repo.

## CLI invocation

Prefer:

```bash
npx @agentuse/artifacts <command> [options]
```

If working inside the package checkout, use:

```bash
npm run dev -- <command> [options]
```

Most commands accept `--json`.

## Standard workflow for agents

1. Initialize the project once if needed:

   ```bash
   npx @agentuse/artifacts init
   ```

2. Always write the deliverable inside a subdirectory named after the artifact, never as a bare file at the artifacts root:

   ```txt
   .agentuse/artifacts/<artifact-name>/index.html
   ```

   or for markdown:

   ```txt
   .agentuse/artifacts/<artifact-name>/index.md
   ```

   Do this even for single-file artifacts. Grouping by folder keeps related artifacts together and lets you add support files later without restructuring.

3. Put support files next to the entry file and reference them relatively:

   ```html
   <link rel="stylesheet" href="./style.css">
   <img src="./chart.png" alt="Chart">
   ```

4. List/check artifacts:

   ```bash
   npx @agentuse/artifacts list --json
   ```

5. Tell the user how to view it:

   ```bash
   npx @agentuse/artifacts open
   ```

   `open` registers the current project, ensures the viewer server is running, and opens/prints the project URL.

## Important behavior

- `serve` is server lifecycle only. It does **not** register the current directory.
- `init` creates `./.agentuse/artifacts/` and registers the current project.
- `open` registers/updates the current project and starts/reuses the viewer.
- Project files are never deleted by registry commands.
- HTML is sanitized when rendered; keep using relative files for local CSS/images.

## Command reference

| Command | Purpose |
| --- | --- |
| `init` | Create `./.agentuse/artifacts/` and register current project. Safe to rerun. |
| `open [--port N] [--detach] [--no-browser]` | Register current project, ensure viewer is running, and open/print URL. |
| `serve [--port N] [--detach] [--stop] [--fail-if-running]` | Start/stop/reuse viewer server only. No cwd registration. |
| `list` | List local artifacts in current project's `./.agentuse/artifacts/`. |
| `project list` | List registered projects. |
| `project add [dir]` | Register a project directory and create its `.agentuse/artifacts` folder. |
| `project forget <projectId\|path>` | Remove project from registry only; does not delete files. |
| `project prune` | Forget registry entries whose paths no longer exist; does not delete files. |
| `where` | Print global registry/storage root, default `~/.agentuse/artifacts/`. |

## Artifact layout conventions

Always use a subdirectory per artifact. Preferred HTML artifact:

```txt
.agentuse/artifacts/customer-report/
  index.html
  style.css
  chart.png
```

Preferred markdown artifact:

```txt
.agentuse/artifacts/market-analysis/
  index.md
```

Directory artifacts are detected when they contain `index.html` or `index.md`. The viewer also detects standalone root files (`*.html`, `*.md`, `*.png`, `*.pdf`, etc.), but do not produce those: a folder with `index.md` is preferred even when there are no support files, so artifacts stay grouped.

Use simple, URL-safe artifact folder names, e.g. `market-analysis`, `landing-page`, `qa-report`.

## Examples

### Save an HTML artifact with CSS and image support files

```bash
npx @agentuse/artifacts init
mkdir -p .agentuse/artifacts/demo
cat > .agentuse/artifacts/demo/index.html <<'EOF'
<!doctype html>
<html>
<head>
  <link rel="stylesheet" href="./style.css">
</head>
<body>
  <h1>Demo</h1>
  <img src="./chart.png" alt="Chart">
</body>
</html>
EOF
cat > .agentuse/artifacts/demo/style.css <<'EOF'
body { font-family: system-ui; padding: 32px; }
h1 { color: #c2410c; }
EOF
npx @agentuse/artifacts open
```

Then tell the user:

> Saved to `.agentuse/artifacts/demo/index.html`. View it with `npx @agentuse/artifacts open`.

### Save a markdown report

```bash
npx @agentuse/artifacts init
mkdir -p .agentuse/artifacts/market-analysis
cat > .agentuse/artifacts/market-analysis/index.md <<'EOF'
# Market Analysis
...
EOF
npx @agentuse/artifacts list --json
```

### Register another project

```bash
npx @agentuse/artifacts project add /path/to/project
npx @agentuse/artifacts project list
```

### Remove a stale project from viewer registry

```bash
npx @agentuse/artifacts project forget proj_abc123
```

This only removes the registry entry. It does not delete `.agentuse/artifacts` files.

## Safety notes

- Do not save artifacts outside `./.agentuse/artifacts/` unless the user explicitly asks for another location.
- Use relative asset paths in HTML/markdown.
- Do not tell users that `project prune` deletes files; it only forgets missing project registry entries.
- Prefer `open` when the user wants to view the artifact; prefer `serve` only when managing the server itself.
