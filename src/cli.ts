import { Command } from "commander";
import { CliError, ErrorEnvelope, envelope, exitCodeFor } from "./errors.js";
import { viewerEntryUrl, viewerFeedUrl, viewerLatestUrl } from "./artifacts.js";
import { queryFeed, type FeedEntry } from "./feed.js";
import { rootDir } from "./paths.js";
import { resolveProject } from "./project.js";
import { openBrowser } from "./browser.js";
import { forgetProjectArtifacts, importLocalArtifacts, pruneStore, submitArtifact } from "./store.js";
import {
  DEFAULT_PORT,
  isServerRunning,
  startServer,
  stopServer,
} from "./server.js";

interface GlobalOpts {
  json: boolean;
}

function emit(json: boolean, value: unknown, human: () => void): void {
  if (json) {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  } else {
    human();
  }
}

function human(line: string): void {
  process.stdout.write(line + "\n");
}

function fail(json: boolean, err: unknown): never {
  const env: ErrorEnvelope = envelope(err);
  if (json) {
    process.stdout.write(JSON.stringify(env, null, 2) + "\n");
  } else {
    const code = env.error.code;
    process.stderr.write(`error[${code}]: ${env.error.message}\n`);
    if (env.error.detail) {
      process.stderr.write(JSON.stringify(env.error.detail, null, 2) + "\n");
    }
  }
  process.exit(exitCodeFor(env.error.code));
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtEntry(entry: FeedEntry): string {
  const tags = entry.tags.length ? `  [${entry.tags.join(" ")}]` : "";
  return `  ${entry.submittedAt}  ${entry.projectName}  ${entry.title}${tags}  (${entry.id})`;
}

function currentPort(): number {
  return isServerRunning()?.port ?? DEFAULT_PORT;
}

function positiveInt(raw: string | undefined, label: string): number | undefined {
  if (raw == null) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliError("INVALID_INPUT", `${label} must be a positive integer`);
  }
  return n;
}

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("artifacts")
    .description("Submit artifacts from AI agents and browse them in a local feed")
    .option("--json", "emit machine-readable JSON")
    .allowExcessArguments(false);

  program
    .command("submit")
    .description(
      "Copy a file or directory into the artifact store and add it to the feed. " +
        "A directory becomes one bundle (index.html/index.md plus its assets).",
    )
    .argument("<path>", "file or directory to submit")
    .option("--title <title>", "feed title (default: derived from the file)")
    .option("--tag <tag...>", "tag for filtering; repeatable or comma-separated")
    .option("--slug <slug>", "stable key for this artifact (default: derived from the path)")
    .option("--open", "open the artifact in the browser after submitting")
    .action(async (target: string, opts: Record<string, string | string[] | boolean>) => {
      const global = program.opts<GlobalOpts>();
      try {
        const result = await submitArtifact({
          target,
          title: typeof opts.title === "string" ? opts.title : undefined,
          tags: Array.isArray(opts.tag) ? opts.tag : typeof opts.tag === "string" ? [opts.tag] : [],
          slug: typeof opts.slug === "string" ? opts.slug : undefined,
        });
        // The permalink, not the revision link: it is what someone bookmarks,
        // and it keeps working as the artifact is re-submitted.
        const url = viewerLatestUrl({ port: currentPort() }, result.entry.projectId, result.entry.slug);
        const revisionUrl = viewerEntryUrl({ port: currentPort() }, result.entry.id);
        if (opts.open && !global.json) openBrowser(url);
        emit(global.json, { ...result, url, revisionUrl }, () => {
          const what = result.deduped ? "unchanged" : `rev ${result.entry.rev}`;
          human(`✓ ${result.entry.title} (${what})`);
          human(`  ${url}`);
        });
      } catch (e) {
        fail(global.json, e);
      }
    });

  program
    .command("feed")
    .description("List submitted artifacts, newest first")
    .option("--project <projectId>", "only this project")
    .option("--tag <tag>", "only this tag")
    .option("--limit <n>", "maximum entries (default 30)")
    .option("--all-revisions", "include superseded revisions")
    .action((opts: Record<string, string | boolean>) => {
      const global = program.opts<GlobalOpts>();
      try {
        const page = queryFeed({
          projectId: typeof opts.project === "string" ? opts.project : undefined,
          tag: typeof opts.tag === "string" ? opts.tag : undefined,
          limit: positiveInt(typeof opts.limit === "string" ? opts.limit : undefined, "--limit"),
          allRevisions: !!opts.allRevisions,
        });
        emit(global.json, page, () => {
          if (!page.entries.length) {
            human("(no artifacts submitted yet)");
            human("Submit one with: artifacts submit <path>");
            return;
          }
          for (const entry of page.entries) human(fmtEntry(entry));
          human(`  — ${page.entries.length} of ${page.total}`);
        });
      } catch (e) {
        fail(global.json, e);
      }
    });

  program
    .command("import")
    .description("Submit everything already in this project's .agentuse/artifacts directory")
    .argument("[dir]", "project directory", ".")
    .action(async (dir: string) => {
      const global = program.opts<GlobalOpts>();
      try {
        const results = await importLocalArtifacts(dir);
        const added = results.filter((r) => !r.deduped).length;
        emit(global.json, { imported: results.length, added, results }, () => {
          human(`✓ imported ${results.length} artifact(s), ${added} new`);
          for (const r of results) human(fmtEntry(r.entry));
        });
      } catch (e) {
        fail(global.json, e);
      }
    });

  program
    .command("prune")
    .description("Delete superseded revisions from the store, keeping the newest few")
    .option("--keep <n>", "revisions to keep per artifact (default 5)")
    .action(async (opts: Record<string, string>) => {
      const global = program.opts<GlobalOpts>();
      try {
        const keep = positiveInt(opts.keep, "--keep") ?? 5;
        const out = await pruneStore(keep);
        emit(global.json, out, () =>
          human(`✓ removed ${out.removed.length} revision(s), freed ${fmtSize(out.freedBytes)}`),
        );
      } catch (e) {
        fail(global.json, e);
      }
    });

  program
    .command("open")
    .description("Ensure the viewer is running, then print/open this project's feed URL")
    .option("--port <n>", `preferred port when starting the server (default ${DEFAULT_PORT})`)
    .option("--detach", "run server in background when starting it")
    .option("--no-browser", "do not open the browser")
    .action(async (opts: Record<string, string | boolean>) => {
      const global = program.opts<GlobalOpts>();
      try {
        const project = resolveProject();
        const existing = isServerRunning();
        const status = existing ?? await startServer({
          preferredPort: opts.port ? parseInt(String(opts.port), 10) : DEFAULT_PORT,
          detach: !!opts.detach,
        });
        const url = viewerFeedUrl({ port: status.port }, { projectId: project.projectId });
        if (opts.browser !== false && !global.json) openBrowser(url);
        emit(global.json, { project, server: status, url }, () => human(`viewer: ${url}`));
      } catch (e) {
        fail(global.json, e);
      }
    });

  program
    .command("url")
    .description("Print the viewer feed URL, filtered to the current project")
    .option("--all", "link to the unfiltered feed")
    .action((opts: { all?: boolean }) => {
      const global = program.opts<GlobalOpts>();
      try {
        const projectId = opts.all ? undefined : resolveProject().projectId;
        const url = viewerFeedUrl({ port: currentPort() }, { projectId });
        emit(global.json, { url, projectId }, () => human(url));
      } catch (e) {
        fail(global.json, e);
      }
    });

  program
    .command("where")
    .description("Print storage path")
    .action(() => {
      const global = program.opts<GlobalOpts>();
      emit(global.json, { path: rootDir() }, () => human(rootDir()));
    });

  // Projects are not registered anywhere: they are whatever the feed reports.
  // `resolveProject()` derives the id from the git root at submit time.
  const project = program
    .command("project")
    .description("Inspect and delete artifacts by project");

  project
    .command("list")
    .description("List projects that have submitted artifacts")
    .action(() => {
      const global = program.opts<GlobalOpts>();
      try {
        const { projects } = queryFeed({ limit: 1 });
        emit(global.json, { projects }, () => {
          if (projects.length === 0) {
            human("(no artifacts submitted yet)");
            return;
          }
          for (const p of projects) human(`  ${p.projectId}  ${p.projectName}  ${p.count}`);
        });
      } catch (e) {
        fail(global.json, e);
      }
    });

  project
    .command("forget")
    .description("Delete every artifact submitted from a project, from the feed and from disk")
    .argument("<projectId>")
    .action(async (projectId: string) => {
      const global = program.opts<GlobalOpts>();
      try {
        const droppedArtifacts = await forgetProjectArtifacts(projectId);
        emit(global.json, { projectId, droppedArtifacts }, () =>
          human(`✓ dropped ${droppedArtifacts} artifact(s) from ${projectId}`),
        );
      } catch (e) {
        fail(global.json, e);
      }
    });

  program
    .command("serve")
    .description("Start local viewer server")
    .option("--port <n>", `preferred port (default ${DEFAULT_PORT})`)
    .option("--detach", "run in background")
    .option("--stop", "stop a running detached server")
    .option("--fail-if-running", "exit non-zero if a server is already running")
    .action(async (opts: Record<string, string | boolean>) => {
      const global = program.opts<GlobalOpts>();
      try {
        if (opts.stop) {
          const stopped = await stopServer();
          emit(global.json, stopped, () =>
            human(stopped.stopped ? `✓ stopped pid ${stopped.pid}` : "no server running"),
          );
          return;
        }
        const existing = isServerRunning();
        if (existing) {
          if (opts["fail-if-running"]) {
            throw new CliError(
              "INVALID_INPUT",
              `server already running (pid ${existing.pid}, port ${existing.port})`,
            );
          }
          const url = viewerFeedUrl({ port: existing.port });
          emit(global.json, { ...existing, url }, () => human(`already running: ${url}`));
          return;
        }
        const preferredPort = opts.port ? parseInt(String(opts.port), 10) : DEFAULT_PORT;
        const detach = !!opts.detach;
        const out = await startServer({ preferredPort, detach });
        const url = viewerFeedUrl({ port: out.port });
        emit(global.json, { ...out, url }, () => human(`viewer: ${url}`));
      } catch (e) {
        fail(global.json, e);
      }
    });

  await program.parseAsync(argv, { from: "user" });
}
