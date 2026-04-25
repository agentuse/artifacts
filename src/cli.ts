import { Command } from "commander";
import { CliError, ErrorEnvelope, envelope, exitCodeFor } from "./errors.js";
import {
  AddInput,
  DEFAULT_MAX_SIZE,
  addArtifacts,
  fsck,
  listArtifacts,
  prune,
  removeRevision,
  revertArtifact,
  viewerArtifactUrl,
  viewerRunUrl,
} from "./artifacts.js";
import { rootDir } from "./paths.js";
import { readManifest } from "./manifest.js";
import { resolveProject } from "./project.js";
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
    .command("add")
    .description("Add (auto-version) one or more artifacts")
    .argument("<sources...>", 'file paths, or "-" for stdin (one source only)')
    .option("--name <name>", "explicit logical name (required for stdin)")
    .option("--label <label>", "label for the auto-created run")
    .option("--new-run", "force a new run even if a session is active")
    .option("--force-revision", "create a new revision even on identical hash")
    .option("--max-size <bytes>", `per-artifact byte cap (default ${DEFAULT_MAX_SIZE})`)
    .action(async (sources: string[], opts: Record<string, string | boolean>) => {
      const global = program.opts<GlobalOpts>();
      try {
        if (sources.includes("-") && sources.length > 1) {
          throw new CliError("INVALID_INPUT", 'cannot combine "-" stdin with other sources');
        }
        const maxSize = opts["max-size"]
          ? parseInt(String(opts["max-size"]), 10)
          : DEFAULT_MAX_SIZE;
        const inputs: AddInput[] = sources.map((source) => ({
          source,
          name: typeof opts.name === "string" ? opts.name : undefined,
          label: typeof opts.label === "string" ? opts.label : undefined,
          newRun: !!opts["new-run"],
          forceRevision: !!opts["force-revision"],
          maxSize,
        }));
        const out = await addArtifacts(inputs);
        const port = isServerRunning()?.port ?? DEFAULT_PORT;
        const viewerUrl = viewerRunUrl({ port }, out.project.projectId, out.runId);

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
            human(`✓ Run: ${out.runId}`);
            const real = out.results.filter((r) => !r.skipped);
            const skipped = out.results.filter((r) => r.skipped);
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
            if (skipped.length === out.results.length && out.results.length > 0) {
              // already covered per-line
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
    .description("List artifacts")
    .option("--project <name>", "filter by project name")
    .option("--run <runId>", "filter by run id")
    .option("--name <name>", "filter by artifact name")
    .option("--revisions", "include all revisions, not just latest")
    .action((opts: Record<string, string | boolean>) => {
      const global = program.opts<GlobalOpts>();
      try {
        const items = listArtifacts({
          projectName: typeof opts.project === "string" ? opts.project : undefined,
          runId: typeof opts.run === "string" ? opts.run : undefined,
          name: typeof opts.name === "string" ? opts.name : undefined,
          revisions: !!opts.revisions,
        });
        emit(
          global.json,
          { artifacts: items },
          () => {
            if (items.length === 0) {
              human("(no artifacts)");
              return;
            }
            for (const it of items) {
              const tag = it.isLatest ? "latest" : "      ";
              human(
                `  ${tag}  ${it.record.name}  v${it.record.revision}  ${fmtSize(it.record.size)}  ${it.artifactId}  run=${it.record.runId}`,
              );
            }
          },
        );
      } catch (e) {
        fail(global.json, e);
      }
    });

  program
    .command("url")
    .description("Print viewer URL for the current run, or for a named artifact")
    .argument("[name]", "artifact name (latest revision unless --revision)")
    .option("--revision <n>", "specific revision number")
    .action((name: string | undefined, opts: Record<string, string>) => {
      const global = program.opts<GlobalOpts>();
      try {
        const port = isServerRunning()?.port ?? DEFAULT_PORT;
        const project = resolveProject();
        let url: string;
        if (name) {
          const rev = opts.revision ? parseInt(opts.revision, 10) : undefined;
          url = viewerArtifactUrl({ port }, project.projectId, name, rev);
        } else {
          // Current run from manifest if any.
          const manifest = readManifest();
          const runs = Object.entries(manifest.runs).filter(
            ([, r]) => r.projectId === project.projectId,
          );
          runs.sort(
            (a, b) =>
              new Date(b[1].createdAt).getTime() - new Date(a[1].createdAt).getTime(),
          );
          const latestRun = runs[0]?.[0];
          if (!latestRun) {
            throw new CliError("NOT_FOUND", "no runs for current project");
          }
          url = viewerRunUrl({ port }, project.projectId, latestRun);
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
