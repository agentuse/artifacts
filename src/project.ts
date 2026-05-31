import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export interface ProjectInfo {
  projectId: string;
  path: string;
  name: string;
}

/**
 * Resolve a project from cwd. ProjectId is derived from the git root's first-commit SHA
 * when available, otherwise it's deterministic for a non-git directory based on its
 * realpath; if even that fails (e.g. truly transient), we fall back to a UUID.
 */
export function resolveProject(cwd: string = process.cwd()): ProjectInfo {
  const expandedCwd = expandHomePath(cwd);
  const gitRoot = findGitRoot(expandedCwd);
  const rootPath = gitRoot ?? expandedCwd;
  const realPath = fs.realpathSync(rootPath);
  const name = path.basename(realPath);

  let projectId: string;
  if (gitRoot) {
    const firstSha = firstCommitSha(gitRoot);
    if (firstSha) {
      projectId = "proj_" + sha12("git:" + firstSha);
    } else {
      // Empty git repo: stable on the realpath of the root.
      projectId = "proj_" + sha12("path:" + realPath);
    }
  } else {
    projectId = "proj_" + sha12("path:" + realPath);
  }

  return { projectId, path: realPath, name };
}

export function expandHomePath(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function findGitRoot(start: string): string | null {
  let dir = path.resolve(expandHomePath(start));
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function firstCommitSha(repo: string): string | null {
  try {
    const out = execFileSync("git", ["-C", repo, "rev-list", "--max-parents=0", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return null;
    return out.split("\n")[0] ?? null;
  } catch {
    return null;
  }
}

function sha12(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}
