import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CliError } from "./errors.js";
import type { Manifest, ProjectRecord } from "./manifest.js";
import { readManifest, withLock, writeManifestAtomic } from "./manifest.js";
import { expandHomePath, resolveProject, type ProjectInfo } from "./project.js";

/** Recommended drop zone for agent-generated files before they are submitted. */
export const LOCAL_ARTIFACTS_REL = path.join(".agentuse", "artifacts");

export function projectLocalArtifactsDir(projectPath: string): string {
  return path.join(projectPath, LOCAL_ARTIFACTS_REL);
}

export async function initProject(cwd = process.cwd()): Promise<{
  project: ProjectInfo;
  artifactsDir: string;
}> {
  const project = resolveProject(cwd);
  const artifactsDir = projectLocalArtifactsDir(project.path);
  fs.mkdirSync(artifactsDir, { recursive: true });
  await registerProjectPath(project.path);
  return { project, artifactsDir };
}

export async function registerProjectPath(cwdOrPath: string): Promise<ProjectInfo> {
  const project = resolveProject(cwdOrPath);
  await withLock(async () => {
    const manifest = readManifest();
    upsertProject(manifest, project);
    writeManifestAtomic(manifest);
  });
  return project;
}

function upsertProject(manifest: Manifest, project: ProjectInfo): void {
  const existing = manifest.projects[project.projectId];
  const now = new Date().toISOString();
  const projectPath = canonicalPath(project.path);
  let createdAt = existing?.createdAt ?? now;

  // Older versions and command flows may have registered the same directory
  // under a different projectId. Keep one registry row per real project path.
  for (const [id, rec] of Object.entries(manifest.projects)) {
    if (id === project.projectId) continue;
    if (canonicalPath(rec.path) !== projectPath) continue;
    if (rec.createdAt < createdAt) createdAt = rec.createdAt;
    delete manifest.projects[id];
  }

  manifest.projects[project.projectId] = {
    name: project.name,
    path: project.path,
    createdAt,
    updatedAt: now,
  };
}

export type ProjectSort = "name" | "updated";

export function listRegisteredProjects(sort: ProjectSort = "name"): Array<[string, ProjectRecord]> {
  return uniqueProjects(readManifest()).sort((a, b) => {
    if (sort === "updated") {
      const byTime = projectTime(b[1]) - projectTime(a[1]);
      if (byTime !== 0) return byTime;
    }
    return a[1].name.localeCompare(b[1].name);
  });
}

export function findProjectById(projectId: string): ProjectRecord | undefined {
  return readManifest().projects[projectId];
}

export async function forgetProject(ref: string): Promise<{ projectId: string; project: ProjectRecord }> {
  let removed: { projectId: string; project: ProjectRecord } | undefined;
  await withLock(async () => {
    const manifest = readManifest();
    const found = findRegisteredProject(manifest, ref);
    if (!found) throw new CliError("INVALID_INPUT", `project not found: ${ref}`);
    removed = found;
    delete manifest.projects[found.projectId];
    writeManifestAtomic(manifest);
  });
  return removed!;
}

export async function pruneMissingProjects(): Promise<Array<{ projectId: string; project: ProjectRecord }>> {
  const removed: Array<{ projectId: string; project: ProjectRecord }> = [];
  await withLock(async () => {
    const manifest = readManifest();
    for (const [projectId, project] of Object.entries(manifest.projects)) {
      if (!fs.existsSync(project.path)) {
        removed.push({ projectId, project });
        delete manifest.projects[projectId];
      }
    }
    writeManifestAtomic(manifest);
  });
  return removed;
}

function projectTime(project: ProjectRecord): number {
  return new Date(project.updatedAt ?? project.createdAt).getTime() || 0;
}

function uniqueProjects(manifest: Manifest): Array<[string, ProjectRecord]> {
  const byPath = new Map<string, [string, ProjectRecord]>();
  for (const entry of Object.entries(manifest.projects)) {
    const [, rec] = entry;
    const key = canonicalPath(rec.path);
    const cur = byPath.get(key);
    if (!cur) {
      byPath.set(key, entry);
      continue;
    }
    // Prefer the entry most recently touched by init/open/project add; this
    // is usually the current projectId. Otherwise keep the older one stable.
    const curTime = cur[1].updatedAt ?? cur[1].createdAt;
    const nextTime = rec.updatedAt ?? rec.createdAt;
    if (nextTime > curTime) byPath.set(key, entry);
  }
  return [...byPath.values()];
}

function canonicalPath(input: string): string {
  const expanded = expandHomePath(input);
  try {
    return fs.realpathSync(expanded);
  } catch {
    return path.resolve(expanded);
  }
}

function findRegisteredProject(
  manifest: Manifest,
  ref: string,
): { projectId: string; project: ProjectRecord } | undefined {
  const byId = manifest.projects[ref];
  if (byId) return { projectId: ref, project: byId };
  const abs = canonicalPath(path.resolve(ref));
  for (const [projectId, project] of Object.entries(manifest.projects)) {
    if (canonicalPath(project.path) === abs) return { projectId, project };
  }
  return undefined;
}

export function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.unref();
}
