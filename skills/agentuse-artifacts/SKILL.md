---
name: agentuse-artifacts
description: Submit substantial deliverables to the @agentuse/artifacts feed so the user can browse them on desktop or phone. Use proactively whenever you generate a report, plan, spec, HTML page, dashboard, chart, screenshot, or rendered document the user will want to look at. Also triggers on "save as artifact", "preview this", "render this", "make it viewable", "artifact".
---

# agentuse-artifacts

`@agentuse/artifacts` is a feed of things agents made. You write files as usual, then **submit** them. Submitting copies the files into a central store and adds one entry to a reverse-chronological feed the user browses at `http://127.0.0.1:7878/`.

Submitting is the only way an artifact reaches the feed. Writing a file into `.agentuse/artifacts/` no longer publishes it on its own.

## When to use this

Use this skill when:
- You produced a substantial markdown report, plan, spec, analysis, or summary.
- You generated an HTML page, dashboard, chart, slide, mockup, or rendered document.
- You captured a screenshot or produced an image or PDF worth keeping.
- The user said "save this", "preview this", "render this", "make it viewable", or "artifact".

Do NOT submit ephemeral one-line answers or ordinary source-code changes.

## CLI invocation

Prefer:

```bash
npx @agentuse/artifacts <command> [options]
```

Inside the package checkout, use `npm run dev -- <command>`. Most commands accept `--json`.

## Standard workflow

1. **Write the file(s).** Put generated output in `./.agentuse/artifacts/<name>/`, which is gitignored scratch space in most projects. A single file is fine too.

2. **Submit it.**

   ```bash
   npx @agentuse/artifacts submit .agentuse/artifacts/q2-market-analysis --tag research --tag q2
   ```

   `submit` prints the artifact's URL. It registers the project on its own, so `init` is optional.

3. **Give the user the URL** that `submit` printed. If the viewer is not running yet, start it once:

   ```bash
   npx @agentuse/artifacts open
   ```

## What a bundle is

`submit` takes either a single file or a directory.

- **A directory is one artifact.** Its entry file is `index.html`, `index.md`, or `index.agentuse`; every sibling file (CSS, images, fonts, SVG) is copied with it, so relative paths keep working.
- **A single file is a one-file artifact.** `report.md`, `chart.png`, `deck.pdf`.

```txt
.agentuse/artifacts/customer-report/
  index.html        <- entry file
  style.css
  chart.png
```

If a directory has several renderable files and no `index.*`, `submit` fails and asks for one. That is deliberate: an artifact has exactly one thing to open.

Limits: 25MB and 200 files per bundle. `node_modules`, `.git`, `dist`, `build`, and dotfiles are skipped.

## Titles, tags, and slugs

- **Title** comes from `--title`, else markdown frontmatter `title:`, else the first `#` heading, else the HTML `<title>`, else the slug. Pass `--title` when the file's own heading would read badly in a feed.
- **Tags** come from `--tag`, repeatable or comma-separated. Tags become filter chips in the viewer, so use ones the user would filter by: the client, the project area, the kind of work. Lowercase, max 12.
- **Slug** is the artifact's identity, derived from the path. Re-submitting the same slug adds a **revision** instead of a second card. Pass `--slug` to control it.

Re-submitting byte-identical content with the same title and tags is a no-op, it will not spam the feed, so it is safe to submit again after a re-run.

## Command reference

| Command | Purpose |
| --- | --- |
| `submit <path> [--title T] [--tag T...] [--slug S] [--open]` | Copy a file or directory into the store and add it to the feed. Prints the URL. |
| `feed [--project ID] [--tag T] [--limit N] [--all-revisions]` | List submitted artifacts, newest first. |
| `import [dir]` | One-shot migration: submit everything already in `<dir>/.agentuse/artifacts/`. |
| `prune [--keep N]` | Delete superseded revisions from the store (default: keep 5 per artifact). |
| `open [--port N] [--detach] [--no-browser]` | Register the project, ensure the viewer is running, open the feed filtered to it. |
| `url [--all]` | Print the feed URL, filtered to the current project unless `--all`. |
| `serve [--port N] [--detach] [--stop] [--fail-if-running]` | Start/stop the viewer server only. Does not register the cwd. |
| `init` | Create `./.agentuse/artifacts/` and register the project. Optional; `submit` registers too. |
| `project list` | List registered projects. |
| `project add [dir]` | Register a project directory. |
| `project forget <projectId\|path> [--keep-artifacts]` | Forget a project and delete its submitted artifacts. `--keep-artifacts` keeps them. |
| `project prune` | Forget registry entries whose paths no longer exist. |
| `where` | Print the storage root, default `~/.agentuse/artifacts/`. |

## Naming

Name the slug after the deliverable, not the file type. Lowercase kebab case, shortest unambiguous form:

```txt
<scope>-<subject>-<artifact-kind>
```

- `scope`: optional app, package, client, or platform. Include it in monorepos or multi-client work.
- `subject`: required feature, page, flow, campaign, research topic, or decision area.
- `artifact-kind`: optional report, mockup, audit, plan, spec, dashboard, review.

Good: `checkout-redesign`, `web-checkout-mockup`, `q2-market-analysis`, `pricing-page-cro-report`.
Avoid: `report`, `notes`, `final`, `artifact`.

## Examples

### An HTML artifact with support files

```bash
mkdir -p .agentuse/artifacts/customer-report
cat > .agentuse/artifacts/customer-report/index.html <<'EOF'
<!doctype html>
<html>
<head>
  <title>Customer report</title>
  <link rel="stylesheet" href="./style.css">
</head>
<body>
  <h1>Customer report</h1>
  <img src="./chart.png" alt="Chart">
</body>
</html>
EOF
cat > .agentuse/artifacts/customer-report/style.css <<'EOF'
body { font-family: system-ui; padding: 32px; }
EOF
npx @agentuse/artifacts submit .agentuse/artifacts/customer-report --tag client-acme
```

### A standalone markdown report

```bash
cat > .agentuse/artifacts/q2-market-analysis.md <<'EOF'
# Q2 market analysis
...
EOF
npx @agentuse/artifacts submit .agentuse/artifacts/q2-market-analysis.md --tag research
```

### An existing project file

Nothing needs moving, submit it where it is. The store keeps a copy, and the entry records the original path.

```bash
npx @agentuse/artifacts submit docs/architecture.md --tag docs
```

### A screenshot

```bash
npx @agentuse/artifacts submit tmp/checkout-flow.png --title "Checkout flow, step 3" --tag qa
```

### Migrating a project that predates the feed

```bash
npx @agentuse/artifacts import
```

## Important behavior

- **`submit` copies.** Editing the original file afterwards does not change what was submitted; submit again to add a revision. This is intentional, a feed entry is a snapshot of a moment.
- The store grows with every revision. Run `prune` occasionally, or when the user asks about disk use.
- `project forget` **does** delete that project's submitted artifacts from the store (use `--keep-artifacts` to keep them). It never touches the project's own files.
- HTML is sanitized at render time and runs in a sandboxed iframe. Keep using relative paths for local CSS and images.
- `serve` is server lifecycle only; it does not register the current directory.

## Safety notes

- Never submit secrets, `.env` files, credentials, or private keys. The store is plain files on disk and the viewer may be reachable from the user's other devices.
- Use relative asset paths in HTML and markdown.
- Prefer `submit` + the printed URL over hand-building viewer links.
