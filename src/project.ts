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
      // A linked git worktree shares its main repo's first-commit SHA, so
      // keying purely on `firstSha` makes every worktree collide with the
      // main checkout — and because the projectId then matches, registering
      // a worktree clobbers the main project's stored path. Fold in the
      // worktree's stable git identity so each linked worktree is its own
      // project; the main worktree keeps the bare `git:<sha>` id (unchanged).
      const worktreeId = linkedWorktreeId(gitRoot);
      const key = worktreeId ? `git:${firstSha}:wt:${worktreeId}` : `git:${firstSha}`;
      projectId = "proj_" + sha12(key);
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

/**
 * If `repo` is a linked git worktree, return a stable identifier for it (the
 * worktree's name under `.git/worktrees/<name>`, which survives `git worktree
 * move`). Returns null for the main worktree or when git can't be consulted, so
 * the main checkout keeps its bare first-commit projectId.
 */
function linkedWorktreeId(repo: string): string | null {
  const gitDir = gitRevParse(repo, "--absolute-git-dir");
  const commonDir = gitRevParse(repo, "--path-format=absolute", "--git-common-dir");
  if (!gitDir || !commonDir) return null;
  if (path.resolve(gitDir) === path.resolve(commonDir)) return null; // main worktree
  return path.basename(gitDir);
}

function gitRevParse(repo: string, ...args: string[]): string | null {
  try {
    const out = execFileSync("git", ["-C", repo, "rev-parse", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function sha12(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}
