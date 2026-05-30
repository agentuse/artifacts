---
name: agentuse-artifacts
description: Save substantial markdown/HTML deliverables as project-local, viewable artifacts using @agentuse/artifacts. Generated outputs should usually be grouped under ./.agentuse/artifacts/, while existing supported project files can be viewed in place. Use proactively whenever you generate or identify a report, plan, spec, HTML page, dashboard, chart, or rendered document the user will want to preview in a browser. Also triggers on "save as artifact", "preview this", "render this", "make it viewable", "artifact".
---

# agentuse-artifacts

Use `@agentuse/artifacts` to save AI-generated deliverables into a project-local artifact directory and preview generated or existing project files in the local viewer.

Primary model for newly generated outputs: create one folder per artifact group under `./.agentuse/artifacts/`. If multiple outputs come from the same task, topic, report, or deliverable package, put them in the same folder so the viewer canvas shows them together. Single standalone outputs can still use their own folder.

```txt
<project>/.agentuse/artifacts/
  client-report/
    summary.md
    findings.md
    dashboard.html
  market-analysis/
    index.md
  dashboard/
    index.html
    style.css
    chart.png
```

Artifacts are normal project files. The viewer also discovers supported files that already live elsewhere in the registered project, so do not copy an existing `docs/report.md`, `screenshots/flow.png`, or similar project file just to make it visible. Support files work through relative paths.

## When to use this

Use this skill when:
- You produced a substantial markdown report, plan, spec, analysis, or summary.
- You generated an HTML page, dashboard, chart, slide, mockup, or rendered document.
- Multiple generated files belong to the same topic, report, client, analysis, or task.
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

2. Choose the artifact group folder.

   Use one URL-safe folder for everything the user will think of as one package:

   ```txt
   .agentuse/artifacts/<artifact-group>/
   ```

   Put related files in that same folder instead of creating many sibling folders:

   ```txt
   .agentuse/artifacts/<artifact-group>/summary.md
   .agentuse/artifacts/<artifact-group>/details.md
   .agentuse/artifacts/<artifact-group>/dashboard.html
   ```

   For a single standalone deliverable, use one folder with an entry file such as `index.md` or `index.html`.

3. Put support files next to the files that use them and reference them relatively:

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

## Existing project files

When the user asks to "send", "save", or "preview" an existing project file as an artifact (e.g. `/agentuse-artifacts send path/to/foo.md`), treat the original file as the source of truth and leave it in place. The viewer scans supported files across the registered project, so a copy under `.agentuse/artifacts/<group>/` is no longer required for plain Markdown, HTML, PNG/JPG/WebP, or PDF files.

Rules:
- Do not move, delete, or duplicate an existing supported project file just to make it viewable.
- If the file is already in a supported format, register/open the project and point the user to the viewer.
- If the project file needs a derived artifact (for example, rendering a Markdown source into a richer HTML dashboard), write the derived output under `.agentuse/artifacts/<group>/` and say which original file it came from.
- If the user edits the original source later, update only the source unless there is an intentional derived artifact that must be regenerated.

## Command reference

| Command | Purpose |
| --- | --- |
| `init` | Create `./.agentuse/artifacts/` and register current project. Safe to rerun. |
| `open [--port N] [--detach] [--no-browser]` | Register current project, ensure viewer is running, and open/print URL. |
| `serve [--port N] [--detach] [--stop] [--fail-if-running]` | Start/stop/reuse viewer server only. No cwd registration. |
| `list` | List supported artifacts discovered in the current project. |
| `project list` | List registered projects. |
| `project add [dir]` | Register a project directory and create its `.agentuse/artifacts` folder. |
| `project forget <projectId\|path>` | Remove project from registry only; does not delete files. |
| `project prune` | Forget registry entries whose paths no longer exist; does not delete files. |
| `where` | Print global registry/storage root, default `~/.agentuse/artifacts/`. |

## Artifact layout conventions

Use one subdirectory per artifact group. Preferred grouped package:

```txt
.agentuse/artifacts/research-package/
  summary.md
  evidence.md
  recommendations.md
  dashboard.html
```

Preferred HTML artifact with support files:

```txt
.agentuse/artifacts/customer-report/
  index.html
  style.css
  chart.png
```

Preferred standalone markdown artifact:

```txt
.agentuse/artifacts/market-analysis/
  index.md
```

Directory artifacts are detected when they contain supported files such as `index.html`, `index.md`, or other markdown/HTML files. The viewer canvas shows files in the artifact group together, so do not create separate sibling folders for files that belong to the same package.

Name artifact group folders after the user-facing deliverable, not the file type. Use lowercase URL-safe kebab case.

Naming pattern:

```txt
<scope>-<subject>-<artifact-kind>
```

Use the shortest name that stays unambiguous:

- `scope`: optional app, package, client, domain, platform, or audience. Include this in monorepos or multi-client work.
- `subject`: required feature, page, flow, campaign, research topic, client problem, or decision area.
- `artifact-kind`: optional report, package, mockup, audit, plan, spec, dashboard, or review.

Good names:

```txt
checkout-redesign
web-checkout-mockup
admin-settings-review
mobile-onboarding-flow
q2-market-analysis
customer-support-audit
pricing-page-cro-report
```

Avoid vague catch-all names:

```txt
design-mockup
report
notes
final
artifact
```

If related outputs share the same scope and subject, keep them in one folder. If they are different apps, features, clients, or decisions, use separate folders.

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

### Save a grouped artifact package

```bash
npx @agentuse/artifacts init
mkdir -p .agentuse/artifacts/research-package
cat > .agentuse/artifacts/research-package/summary.md <<'EOF'
# Summary
...
EOF
cat > .agentuse/artifacts/research-package/recommendations.md <<'EOF'
# Recommendations
...
EOF
cat > .agentuse/artifacts/research-package/evidence.md <<'EOF'
# Evidence
...
EOF
npx @agentuse/artifacts list --json
```

### Save a design or mockup package

```bash
npx @agentuse/artifacts init
mkdir -p .agentuse/artifacts/web-checkout-mockup
cat > .agentuse/artifacts/web-checkout-mockup/index.html <<'EOF'
<!doctype html>
<html>
<head>
  <link rel="stylesheet" href="./style.css">
</head>
<body>
  <main>Mockup content...</main>
</body>
</html>
EOF
cat > .agentuse/artifacts/web-checkout-mockup/notes.md <<'EOF'
# Design Notes
...
EOF
npx @agentuse/artifacts open
```

For monorepos, include app/package/platform context in the folder name, such as `web-checkout-mockup`, `ios-onboarding-flow`, or `admin-settings-review`.

### Save a standalone markdown report

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

- Save newly generated artifact packages under `./.agentuse/artifacts/` by default. Existing supported project files can stay where they already live.
- Use relative asset paths in HTML/markdown.
- Do not tell users that `project prune` deletes files; it only forgets missing project registry entries.
- Prefer `open` when the user wants to view the artifact; prefer `serve` only when managing the server itself.
