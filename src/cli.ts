import { Command } from "commander";
import { CliError, ErrorEnvelope, envelope, exitCodeFor } from "./errors.js";
import {
  AddInput,
  DEFAULT_MAX_SIZE,
  addArtifacts,
  fsck,
  prune,
  removeRevision,
  revertArtifact,
  viewerArtifactUrl,
  viewerProjectUrl,
  viewerRunUrl,
} from "./artifacts.js";
import { rootDir } from "./paths.js";
import { resolveProject } from "./project.js";
import {
  forgetProject,
  initProject,
  listLocalArtifactsForCurrentProject,
  listRegisteredProjects,
  openBrowser,
  pruneMissingProjects,
  registerProjectPath,
} from "./localArtifacts.js";
import {
  DEFAULT_PORT,
  isServerRunning,
  startServer,
  stopServer,
} from "./server.js";

interface GlobalOpts {
  json: boolean;
}

function parseDuration(input: string): number {
  const m = /^(\d+)\s*([smhdw])?$/.exec(input.trim());
  if (!m) throw new CliError("INVALID_INPUT", `bad duration: ${input}`);
  const n = parseInt(m[1] ?? "0", 10);
  const unit = (m[2] ?? "s") as "s" | "m" | "h" | "d" | "w";
  const factor = { s: 1e3, m: 60e3, h: 3.6e6, d: 8.64e7, w: 6.048e8 }[unit];
  return n * factor;
}

/** Suggested-dimension bounds. Matches what the viewer can usefully render:
 *  smaller than 100px and the tile loses its resize handle / chrome; larger
 *  than 10000px is well past any realistic display. The viewer also clamps
 *  on read (defense in depth). */
const MIN_SUGGESTED_PX = 100;
const MAX_SUGGESTED_PX = 10000;

function parseDimension(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new CliError("INVALID_INPUT", `${flag} must be an integer (got ${raw})`);
  }
  if (n < MIN_SUGGESTED_PX || n > MAX_SUGGESTED_PX) {
    throw new CliError(
      "INVALID_INPUT",
      `${flag} out of range: ${n} (allowed ${MIN_SUGGESTED_PX}..${MAX_SUGGESTED_PX})`,
    );
  }
  return n;
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

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("artifacts")
    .description("Collect and view artifacts emitted by AI agents")
    .option("--json", "emit machine-readable JSON")
    .allowExcessArguments(false);

  program
    .command("init")
    .description("Create .agentuse/artifacts and register the current project")
    .action(async () => {
      const global = program.opts<GlobalOpts>();
      try {
        const out = await initProject();
        emit(global.json, out, () => {
          human(`✓ initialized ${out.project.name}`);
          human(`  ${out.artifactsDir}`);
        });
      } catch (e) {
        fail(global.json, e);
      }
    });

  program
    .command("open")
    .description("Register current project, ensure the viewer is running, and print/open its URL")
    .option("--port <n>", `preferred port when starting the server (default ${DEFAULT_PORT})`)
    .option("--detach", "run server in background when starting it")
    .option("--no-browser", "do not open the browser")
    .action(async (opts: Record<string, string | boolean>) => {
      const global = program.opts<GlobalOpts>();
      try {
        const project = await registerProjectPath(process.cwd());
        const existing = isServerRunning();
        const status = existing ?? await startServer({
          preferredPort: opts.port ? parseInt(String(opts.port), 10) : DEFAULT_PORT,
          detach: !!opts.detach,
        });
        const url = `http://127.0.0.1:${status.port}/p/${encodeURIComponent(project.projectId)}`;
        if (opts.browser !== false && !global.json) openBrowser(url);
        emit(global.json, { project, server: status, url }, () => human(`viewer: ${url}`));
      } catch (e) {
        fail(global.json, e);
      }
    });

  program
    .command("add")
    .description("Add (auto-version) one or more artifacts")
    .argument("<sources...>", 'file paths, or "-" for stdin (one source only)')
    .option("--name <name>", "explicit logical name (required for stdin)")
    .option(
      "--run <tag>",
      "tag this batch with a run (same tag = same run; default is untagged). " +
        "Also reads AGENTUSE_RUN_ID from env.",
    )
    .option("--force-revision", "create a new revision even on identical hash")
    .option("--max-size <bytes>", `per-artifact byte cap (default ${DEFAULT_MAX_SIZE})`)
    .option(
      "--width <px>",
      "suggested initial tile width in the viewer (integer px). " +
        "User resize wins; the viewer floors small values.",
    )
    .option(
      "--height <px>",
      "suggested initial tile height in the viewer (integer px). " +
        "User resize wins; the viewer floors small values.",
    )
    .action(async (sources: string[], opts: Record<string, string | boolean>) => {
      const global = program.opts<GlobalOpts>();
      try {
        if (sources.includes("-") && sources.length > 1) {
          throw new CliError("INVALID_INPUT", 'cannot combine "-" stdin with other sources');
        }
        const maxSize = opts["max-size"]
          ? parseInt(String(opts["max-size"]), 10)
          : DEFAULT_MAX_SIZE;
        const run = typeof opts.run === "string" ? opts.run : undefined;
        const suggestedWidth =
          typeof opts.width === "string"
            ? parseDimension("--width", opts.width)
            : undefined;
        const suggestedHeight =
          typeof opts.height === "string"
            ? parseDimension("--height", opts.height)
            : undefined;
        const inputs: AddInput[] = sources.map((source) => ({
          source,
          name: typeof opts.name === "string" ? opts.name : undefined,
          run,
          forceRevision: !!opts["force-revision"],
          maxSize,
          suggestedWidth,
          suggestedHeight,
        }));
        const out = await addArtifacts(inputs);
        const port = isServerRunning()?.port ?? DEFAULT_PORT;
        const viewerUrl = out.runId
          ? viewerRunUrl({ port }, out.project.projectId, out.runId)
          : viewerProjectUrl({ port }, out.project.projectId);

        emit(
          global.json,
          {
            runId: out.runId,
            project: out.project,
            artifacts: out.results,
            viewerUrl,
          },
          () => {
            human(`✓ Project: ${out.project.name} (${out.project.path})`);
            if (out.runId) human(`✓ Run: ${out.runId}`);
            const real = out.results.filter((r) => !r.skipped);
            if (real.length > 0) human(`✓ Added ${real.length} artifact(s)`);
            for (const r of out.results) {
              const tag = r.skipped
                ? `no change (matches v${r.previousRevision})`
                : r.previousRevision
                  ? `was v${r.previousRevision}: ${r.previousArtifactId}`
                  : "new";
              human(
                `  • ${r.name}  v${r.revision}  ${fmtSize(r.size)}  ${r.artifactId}  (${tag})`,
              );
            }
            human(`→ ${viewerUrl}`);
          },
        );
      } catch (e) {
        fail(global.json, e);
      }
    });

  program
    .command("list")
    .description("List project-local artifacts in .agentuse/artifacts")
    .action(() => {
      const global = program.opts<GlobalOpts>();
      try {
        const out = listLocalArtifactsForCurrentProject();
        emit(
          global.json,
          {
            project: out.project,
            artifactsDir: out.artifactsDir,
            artifacts: out.artifacts.map((a) => ({
              artifactId: a.artifactId,
              name: a.record.name,
              type: a.record.type,
              entry: a.entry,
              size: a.record.size,
            })),
          },
          () => {
            if (!out.artifacts.length) {
              human(`No local artifacts found in ${out.artifactsDir}`);
              human("Run `artifacts init`, then save files under .agentuse/artifacts/.");
              return;
            }
            human(`Artifacts in ${out.project.name}:`);
            for (const a of out.artifacts) {
              human(`  ${a.record.name}  ${a.record.type}  ${fmtSize(a.record.size)}  ${a.entry}`);
            }
          },
        );
      } catch (e) {
        fail(global.json, e);
      }
    });

  program
    .command("url")
    .description(
      "Print viewer URL: project home by default, an artifact when name is given, " +
        "a run when --run is given.",
    )
    .argument("[name]", "artifact name (latest revision unless --revision)")
    .option("--revision <n>", "specific revision number")
    .option("--run <tag>", "show URL for a specific run tag")
    .action((name: string | undefined, opts: Record<string, string>) => {
      const global = program.opts<GlobalOpts>();
      try {
        const port = isServerRunning()?.port ?? DEFAULT_PORT;
        const project = resolveProject();
        let url: string;
        if (name) {
          const rev = opts.revision ? parseInt(opts.revision, 10) : undefined;
          url = viewerArtifactUrl({ port }, project.projectId, name, rev);
        } else if (opts.run) {
          url = viewerRunUrl({ port }, project.projectId, opts.run);
        } else {
          url = viewerProjectUrl({ port }, project.projectId);
        }
        emit(global.json, { url }, () => human(url));
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

  program
    .command("revert")
    .description("Roll back: create a new revision with the content of an older one")
    .argument("<name>")
    .requiredOption("--to <revision>", "revision number to revert to")
    .action(async (name: string, opts: { to: string }) => {
      const global = program.opts<GlobalOpts>();
      try {
        const to = parseInt(opts.to, 10);
        if (!Number.isFinite(to)) throw new CliError("INVALID_INPUT", "bad --to");
        const result = await revertArtifact({ name, to });
        emit(global.json, { artifact: result }, () =>
          human(`✓ ${name} reverted to v${to}; new revision v${result.revision} (${result.artifactId})`),
        );
      } catch (e) {
        fail(global.json, e);
      }
    });

  program
    .command("rm")
    .description("Delete a single revision")
    .argument("<name>")
    .requiredOption("--revision <n>", "revision number to delete")
    .action(async (name: string, opts: { revision: string }) => {
      const global = program.opts<GlobalOpts>();
      try {
        const revision = parseInt(opts.revision, 10);
        if (!Number.isFinite(revision)) throw new CliError("INVALID_INPUT", "bad --revision");
        const out = await removeRevision({ name, revision });
        emit(global.json, { removed: out }, () =>
          human(`✓ removed ${name} v${revision} (${out.artifactId})`),
        );
      } catch (e) {
        fail(global.json, e);
      }
    });

  program
    .command("prune")
    .description("Remove old artifacts")
    .option("--older-than <duration>", "e.g. 30d, 24h, 7d")
    .option("--keep-latest-only", "keep only the latest revision per name")
    .action(async (opts: Record<string, string | boolean>) => {
      const global = program.opts<GlobalOpts>();
      try {
        if (!opts["older-than"] && !opts["keep-latest-only"]) {
          throw new CliError(
            "INVALID_INPUT",
            "specify --older-than <duration> or --keep-latest-only",
          );
        }
        const olderThanMs =
          typeof opts["older-than"] === "string"
            ? parseDuration(opts["older-than"])
            : undefined;
        const out = await prune({
          olderThanMs,
          keepLatestOnly: !!opts["keep-latest-only"],
        });
        emit(global.json, out, () => human(`✓ pruned ${out.removed.length} artifact(s)`));
      } catch (e) {
        fail(global.json, e);
      }
    });

  program
    .command("fsck")
    .description("Verify manifest + files; rebuild latest map")
    .action(async () => {
      const global = program.opts<GlobalOpts>();
      try {
        const out = await fsck();
        emit(global.json, out, () => {
          human(`✓ fsck complete${out.issues.length ? "; issues:" : ""}`);
          for (const issue of out.issues) human(`  ! ${issue}`);
        });
      } catch (e) {
        fail(global.json, e);
      }
    });

  program
    .command("migrate")
    .description("Run pending schema migrations")
    .action(() => {
      const global = program.opts<GlobalOpts>();
      emit(global.json, { schemaVersion: 1, ranMigrations: [] }, () =>
        human("schema is up to date (v1)"),
      );
    });

  const project = program
    .command("project")
    .description("Manage registered project directories");

  project
    .command("list")
    .description("List registered projects")
    .action(() => {
      const global = program.opts<GlobalOpts>();
      try {
        const projects = listRegisteredProjects();
        emit(
          global.json,
          { projects: projects.map(([projectId, p]) => ({ projectId, ...p })) },
          () => {
            if (projects.length === 0) {
              human("(no registered projects)");
              return;
            }
            for (const [projectId, p] of projects) {
              human(`  ${projectId}  ${p.name}  ${p.path}`);
            }
          },
        );
      } catch (e) {
        fail(global.json, e);
      }
    });

  project
    .command("add")
    .description("Register a project directory and create its .agentuse/artifacts folder")
    .argument("[dir]", "project directory", ".")
    .action(async (dir: string) => {
      const global = program.opts<GlobalOpts>();
      try {
        const out = await initProject(dir);
        emit(global.json, out, () => human(`✓ registered ${out.project.name} (${out.project.path})`));
      } catch (e) {
        fail(global.json, e);
      }
    });

  project
    .command("forget")
    .description("Remove a project from the registry without deleting files")
    .argument("<projectIdOrPath>")
    .action(async (ref: string) => {
      const global = program.opts<GlobalOpts>();
      try {
        const out = await forgetProject(ref);
        emit(global.json, out, () => human(`✓ forgot ${out.project.name} (${out.projectId})`));
      } catch (e) {
        fail(global.json, e);
      }
    });

  project
    .command("prune")
    .description("Forget registered projects whose paths no longer exist")
    .action(async () => {
      const global = program.opts<GlobalOpts>();
      try {
        const removed = await pruneMissingProjects();
        emit(global.json, { removed }, () => human(`✓ pruned ${removed.length} project(s)`));
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
          const url = `http://127.0.0.1:${existing.port}/`;
          emit(global.json, { ...existing, url }, () => human(`already running: ${url}`));
          return;
        }
        const preferredPort = opts.port ? parseInt(String(opts.port), 10) : DEFAULT_PORT;
        const detach = !!opts.detach;
        const out = await startServer({ preferredPort, detach });
        const url = `http://127.0.0.1:${out.port}/`;
        emit(global.json, { ...out, url }, () => human(`viewer: ${url}`));
      } catch (e) {
        fail(global.json, e);
      }
    });

  await program.parseAsync(argv, { from: "user" });
}
