import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { CliError, ErrorEnvelope, envelope, exitCodeFor } from "./errors.js";
import { viewerArtifactUrl, viewerProjectUrl } from "./artifacts.js";
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

function realpathOrResolve(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Turn a `url` target into a `{ projectId, name }` pair. The viewer's `/a/:name`
 * route matches on the artifact's `name`, which is NOT always the file's
 * project-relative path: legacy `.agentuse/artifacts/<group>/index.*` files are
 * named `<group>`, siblings are `<group>/<file>`, while discovered project files
 * are named by their project-relative path. To avoid duplicating that logic, we
 * scan the project and match the target file's realpath against each artifact's
 * absolute path, then use the scanned `name` as the source of truth.
 *
 * Fallbacks: an existing file that isn't a discovered artifact uses its
 * project-relative path; a target that isn't a file on disk is treated as a
 * literal artifact name in the cwd's project.
 */
function resolveArtifactName(target: string): { projectId: string; name: string } {
  const abs = path.resolve(target);
  let isFile = false;
  try {
    isFile = fs.statSync(abs).isFile();
  } catch {
    isFile = false;
  }
  if (isFile) {
    const real = realpathOrResolve(abs);
    const { project, artifacts } = listLocalArtifactsForCurrentProject(path.dirname(real));
    const match = artifacts.find((a) => realpathOrResolve(a.absPath) === real);
    if (match) return { projectId: project.projectId, name: match.record.name };
    // File exists but isn't a discovered artifact (unsupported type, ignored
    // path, or discovery disabled): best-effort project-relative path.
    const name = path.relative(project.path, real).split(path.sep).join("/");
    return { projectId: project.projectId, name };
  }
  // Not a file on disk: treat as a literal artifact name in the cwd's project.
  const project = resolveProject();
  return { projectId: project.projectId, name: target };
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
    .command("list")
    .description("List supported artifacts discovered in the current project")
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
              projectRelPath: a.projectRelPath,
              size: a.record.size,
            })),
          },
          () => {
            if (!out.artifacts.length) {
              human(`No supported artifacts found in ${out.project.path}`);
              human("Supported files include markdown, AgentUse, HTML, images, and PDFs.");
              return;
            }
            human(`Artifacts in ${out.project.name}:`);
            for (const a of out.artifacts) {
              human(`  ${a.record.name}  ${a.record.type}  ${fmtSize(a.record.size)}  ${a.projectRelPath}`);
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
      "Print viewer URL: project home by default, or a deep link to an artifact. " +
        "The target may be a file path (resolved to its project-relative name) or a literal artifact name.",
    )
    .argument("[target]", "artifact file path or name")
    .option("--full", "deep link that opens the artifact in fullscreen on load")
    .action((target: string | undefined, opts: { full?: boolean }) => {
      const global = program.opts<GlobalOpts>();
      try {
        const port = isServerRunning()?.port ?? DEFAULT_PORT;
        if (!target) {
          const project = resolveProject();
          const url = viewerProjectUrl({ port }, project.projectId);
          emit(global.json, { url }, () => human(url));
          return;
        }
        // A skill knows the path it wrote, not the artifact's internal name.
        // If the target points at a real file, resolve the project from that
        // file's location and use its project-relative path as the stable
        // artifact name. Otherwise treat the target as a literal name.
        const resolved = resolveArtifactName(target);
        const url = viewerArtifactUrl({ port }, resolved.projectId, resolved.name, {
          full: !!opts.full,
        });
        emit(global.json, { url, projectId: resolved.projectId, name: resolved.name }, () =>
          human(url),
        );
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

  const project = program
    .command("project")
    .description("Manage registered project directories");

  project
    .command("list")
    .description("List registered projects")
    .option("--sort <name|updated>", "sort projects by name or last updated", "name")
    .action((opts: { sort: string }) => {
      const global = program.opts<GlobalOpts>();
      try {
        if (opts.sort !== "name" && opts.sort !== "updated") {
          throw new CliError("INVALID_INPUT", "--sort must be 'name' or 'updated'");
        }
        const projects = listRegisteredProjects(opts.sort);
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
