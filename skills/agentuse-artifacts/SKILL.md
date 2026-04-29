---
name: agentuse-artifacts
description: Save substantial markdown/HTML deliverables as project-local, viewable artifacts using @agentuse/artifacts. Use proactively whenever you generate a report, plan, spec, HTML page, dashboard, chart, or rendered document the user will want to preview in a browser. Supports artifact folders with CSS/images/fonts under ./.agentuse/artifacts/. Also triggers on "save as artifact", "preview this", "render this", "make it viewable", "artifact".
---

# agentuse-artifacts

Use `@agentuse/artifacts` to save AI-generated deliverables into a project-local artifact directory and preview them in the local viewer.

Primary model:

```txt
<project>/.agentuse/artifacts/
  report/index.html
  report/style.css
  report/chart.png
  notes.md
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

2. Write the deliverable under:

   ```txt
   .agentuse/artifacts/<artifact-name>/index.html
   ```

   or for standalone markdown:

   ```txt
   .agentuse/artifacts/<artifact-name>.md
   ```

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

Preferred HTML artifact:

```txt
.agentuse/artifacts/customer-report/
  index.html
  style.css
  chart.png
```

Preferred markdown artifact:

```txt
.agentuse/artifacts/customer-report.md
```

Directory artifacts are detected when they contain:

```txt
index.html
index.md
```

Standalone root files detected:

```txt
*.html
*.htm
*.md
*.markdown
*.png
*.jpg
*.jpeg
*.webp
*.pdf
```

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
cat > .agentuse/artifacts/market-analysis.md <<'EOF'
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
