---
name: agentuse-artifacts
description: Save markdown or HTML deliverables as versioned, viewable artifacts using the @agentuse/artifacts CLI. Use proactively whenever you generate a substantial markdown report, HTML page, plan, spec, or any rendered document the user will want to view, share, or revisit. Also triggers on "save as artifact", "preview this", "render this for me to view", "make it shareable", "version this output".
---

# agentuse-artifacts

A content-addressed store + local web viewer for markdown/HTML outputs from AI agents. Each artifact is auto-versioned by content hash, grouped by project (git-root-stable) and optionally by a run tag.

## When to use this

Use this skill when:
- You produced a markdown report, plan, spec, summary, or analysis the user will want to read in a browser, not the terminal.
- You generated an HTML page, dashboard, chart, or rendered document.
- The user said "save this", "preview this", "render this", "make it shareable", or "version this".
- The output is large enough that scrolling chat is annoying.

Do NOT use for: ephemeral one-line answers, code edits to repo files, or things already written to a meaningful location in the user's project.

## Invocation

The CLI is `artifacts`. Prefer `npx @agentuse/artifacts` so it works without a global install:

```bash
npx @agentuse/artifacts <command> [options]
```

If the package is checked out locally (e.g. you are in the agentuse-artifacts repo), use `node dist/bin.js` after `npm run build`, or `npm run dev --` for source.

All commands accept `--json` for parseable output. Errors go to stderr (text mode) or stdout (JSON mode) with stable error codes.

## Standard workflow

1. **Write the content to a file** in `tmp/` (or anywhere). Markdown gets `.md`, HTML gets `.html`. Extension determines type; anything else is rejected.
2. **Determine a run tag** (see "Run tagging" below). Set it once per session.
3. **Add the artifact**:
   ```bash
   AGENTUSE_RUN_ID="$RUN_TAG" npx @agentuse/artifacts add tmp/report.md --json
   ```
4. **Read the `viewerUrl` from the JSON output** and surface it to the user.
5. **If the viewer server is not running**, tell the user to start it themselves:
   > To view this in the browser, run: `npx @agentuse/artifacts serve --detach`

   Do not auto-start the server. The user controls server lifecycle.

## Run tagging

A "run" groups related artifacts in the viewer. The CLI reads `AGENTUSE_RUN_ID` from env, or `--run <tag>` on the command line. Same tag = same run; new tag = new run.

Pick a run tag in this priority order, and reuse it for every `add` in the session:

1. `$AGENTUSE_RUN_ID` if already set in the environment.
2. The host agent's session id, if exposed:
   - Claude Code: `$CLAUDE_SESSION_ID` (available in hook context; in skill context, check `printenv CLAUDE_SESSION_ID` first)
   - Codex: `$CODEX_SESSION_ID`
   - Cursor: `$CURSOR_SESSION_ID`
   - Generic: any env var matching `*_SESSION_ID` or `*_RUN_ID`
3. Fallback: generate one once and reuse it. Format: `<agent>-<YYYYMMDD-HHMMSS>`, e.g. `claude-20260425-143022`. Store it in a shell var for the session and pass via `--run`.

Once decided, prefer the env var form so you do not have to repeat `--run`:

```bash
export AGENTUSE_RUN_ID="${AGENTUSE_RUN_ID:-claude-$(date +%Y%m%d-%H%M%S)}"
```

Untagged artifacts still work; they just don't show up under a "run" view.

## Command reference

| Command | Purpose |
| --- | --- |
| `add <files...>` | Ingest one or more artifacts. Pipe stdin with `-` and `--name`. Auto-versions per logical name; identical content is skipped (use `--force-revision` to override). |
| `list` | List artifacts. Filters: `--project`, `--run`, `--name`, `--revisions`. |
| `url [name]` | Print viewer URL: project home by default, artifact when name given (`--revision N` for a specific rev), run when `--run TAG` given. |
| `where` | Print storage root (default `~/.agentuse/artifacts/`, override with `AGENTUSE_ARTIFACTS_HOME`). |
| `revert <name> --to <rev>` | Roll back: create a new revision with the content of an older one. |
| `rm <name> --revision <n>` | Delete a single revision. |
| `prune --older-than <30d\|24h\|...> \| --keep-latest-only` | Remove old artifacts. |
| `fsck` | Verify manifest + files, rebuild `latest` map. |
| `migrate` | Run pending schema migrations. |
| `serve [--port N] [--detach] [--stop] [--fail-if-running]` | Start/stop the local viewer (default port 7878, sequential fallback +50). |

### `add` options worth knowing

- `--name <name>` — explicit logical name. Required when source is `-` (stdin). Otherwise inferred: POSIX path relative to project root if inside it, else basename.
- `--run <tag>` — see "Run tagging" above. Equivalent to `AGENTUSE_RUN_ID`.
- `--force-revision` — create a new revision even if content hash is unchanged.
- `--max-size <bytes>` — per-artifact byte cap.

A batch `add` call gets at most one run tag (the first one it sees).

## Examples

### Save a generated report and show the user where to find it

```bash
# 1. Write the content
cat > tmp/market-analysis.md <<'EOF'
# Market Analysis
...
EOF

# 2. Pick / reuse a run tag
export AGENTUSE_RUN_ID="${AGENTUSE_RUN_ID:-claude-$(date +%Y%m%d-%H%M%S)}"

# 3. Add it, parse JSON for the viewer URL
npx @agentuse/artifacts add tmp/market-analysis.md --json
```

JSON output includes:
```json
{
  "runId": "claude-20260425-143022",
  "project": { "projectId": "proj_...", "name": "...", "path": "..." },
  "artifacts": [{
    "name": "market-analysis.md",
    "revision": 1,
    "artifactId": "art_...",
    "size": 1234,
    "skipped": false
  }],
  "viewerUrl": "http://127.0.0.1:7878/p/proj_.../r/claude-20260425-143022"
}
```

Then tell the user:
> Saved as `market-analysis.md` (v1). View at `http://127.0.0.1:7878/...` — start the viewer with `npx @agentuse/artifacts serve --detach` if it's not running.

### Save HTML from stdin

```bash
echo "<h1>Hello</h1>" | npx @agentuse/artifacts add - --name hello.html --json
```

### Add several files in one batch (single run)

```bash
npx @agentuse/artifacts add tmp/plan.md tmp/diagram.html --run "$AGENTUSE_RUN_ID" --json
```

### Get the viewer URL for an existing artifact

```bash
npx @agentuse/artifacts url market-analysis.md --json
npx @agentuse/artifacts url market-analysis.md --revision 2 --json
npx @agentuse/artifacts url --run "$AGENTUSE_RUN_ID" --json
```

### List what's already saved for this project

```bash
npx @agentuse/artifacts list --json
npx @agentuse/artifacts list --run "$AGENTUSE_RUN_ID" --json
npx @agentuse/artifacts list --revisions --json   # include non-latest
```

## Conventions

- **Markdown extension**: `.md` or `.markdown`. **HTML**: `.html` or `.htm`. Anything else returns `INVALID_INPUT`.
- **Project identity** is stable across moves and clones (derived from the git root commit, or realpath if non-git). Reuse of the same project does not require any flag.
- **Idempotency**: re-running `add` on identical content reuses the existing revision and reports `skipped: true`. Safe to re-run.
- **Storage**: everything lives under `~/.agentuse/artifacts/` (or `$AGENTUSE_ARTIFACTS_HOME`). Run `where` to print it.
- **Server**: do not auto-start. Suggest `serve --detach` to the user when surfacing a URL.

## Failure handling

- `LOCK_TIMEOUT` — another process is holding the manifest lock; retry once after a brief wait, then surface the holder info to the user.
- `INVALID_INPUT` — bad extension, bad name, or wrong stdin/`--name` combo. Fix the input; do not retry blindly.
- `NOT_FOUND` (revert/rm/url) — the named artifact or revision does not exist. List first to confirm.
- Always prefer `--json` when scripting decisions on the output.

## Installing this skill

End users install it with `npx skills`:

```bash
npx skills add agentuse/artifacts --skill agentuse-artifacts -a claude-code
```

Other supported agents include `cursor`, `codex`, etc. Run `npx skills --help` for the full list.
