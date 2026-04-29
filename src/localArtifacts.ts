import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { CliError } from "./errors.js";
import type { ArtifactRecord, Manifest, ProjectRecord } from "./manifest.js";
import { readManifest, withLock, writeManifestAtomic } from "./manifest.js";
import { resolveProject, type ProjectInfo } from "./project.js";
import { inferType, type ArtifactType } from "./validation.js";
import { readImageDims } from "./imageDims.js";

export const LOCAL_ARTIFACTS_REL = path.join(".agentuse", "artifacts");

export interface LocalArtifact {
  artifactId: string;
  record: ArtifactRecord;
  entry: string;
  absPath: string;
}

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
  try {
    return fs.realpathSync(input);
  } catch {
    return path.resolve(input);
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

export function buildLocalManifest(): Manifest {
  const base = readManifest();
  const manifest: Manifest = {
    schemaVersion: base.schemaVersion,
    projects: base.projects,
    runs: {},
    artifacts: {},
    latest: {},
  };

  for (const [projectId, project] of uniqueProjects(base)) {
    const artifacts = listLocalArtifactsForProject(projectId, project);
    if (artifacts.length > 0) manifest.latest[projectId] = {};
    for (const artifact of artifacts) {
      manifest.artifacts[artifact.artifactId] = artifact.record;
      manifest.latest[projectId]![artifact.record.name] = artifact.artifactId;
    }
  }
  return manifest;
}

export function listLocalArtifactsForCurrentProject(cwd = process.cwd()): {
  project: ProjectInfo;
  artifactsDir: string;
  artifacts: LocalArtifact[];
} {
  const project = resolveProject(cwd);
  const artifactsDir = projectLocalArtifactsDir(project.path);
  const projectRecord: ProjectRecord = {
    name: project.name,
    path: project.path,
    createdAt: new Date().toISOString(),
  };
  return {
    project,
    artifactsDir,
    artifacts: listLocalArtifactsForProject(project.projectId, projectRecord),
  };
}

export function listLocalArtifactsForProject(
  projectId: string,
  project: ProjectRecord,
): LocalArtifact[] {
  const root = projectLocalArtifactsDir(project.path);
  if (!fs.existsSync(root)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const artifacts: LocalArtifact[] = [];
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    const abs = path.join(root, ent.name);
    if (ent.isDirectory()) {
      let sub: fs.Dirent[];
      try {
        sub = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        sub = [];
      }
      // The index entry's contentHash folds in every sibling's mtime+size so
      // that updating an asset (image, css) referenced via a relative URL
      // bumps the iframe's cache-busting key, even though the index file
      // itself hasn't changed.
      const dirSig = directorySignature(abs, sub);
      const html = path.join(abs, "index.html");
      const md = path.join(abs, "index.md");
      const entryAbs = fs.existsSync(html) ? html : fs.existsSync(md) ? md : undefined;
      if (entryAbs) {
        const rel = toPosix(path.relative(root, entryAbs));
        const type = inferType(rel);
        artifacts.push(makeLocalArtifact(projectId, ent.name, type, rel, entryAbs, dirSig));
      }
      // Sibling .html / .md files in the same dir become additional artifacts
      // named `<dir>/<file>`, so multiple artifacts can share supporting
      // assets (css, images) in the same dir.
      for (const f of sub) {
        if (!f.isFile()) continue;
        if (f.name.startsWith(".")) continue;
        if (f.name === "index.html" || f.name === "index.md") continue;
        let type: ArtifactType;
        try {
          type = inferType(f.name);
        } catch {
          continue;
        }
        if (type !== "html" && type !== "markdown") continue;
        const rel = toPosix(path.join(ent.name, f.name));
        const fAbs = path.join(abs, f.name);
        artifacts.push(makeLocalArtifact(projectId, rel, type, rel, fAbs));
      }
      continue;
    }
    if (!ent.isFile()) continue;
    try {
      const type = inferType(ent.name);
      const rel = toPosix(ent.name);
      artifacts.push(makeLocalArtifact(projectId, ent.name, type, rel, abs));
    } catch {
      // Non-artifact support files at the root are ignored.
    }
  }

  return artifacts.sort((a, b) => a.record.name.localeCompare(b.record.name));
}

function makeLocalArtifact(
  projectId: string,
  name: string,
  type: ArtifactType,
  entry: string,
  absPath: string,
  contentHashOverride?: string,
): LocalArtifact {
  const stat = fs.statSync(absPath);
  const artifactId = localArtifactId(projectId, entry);
  const record: ArtifactRecord = {
    projectId,
    name,
    type,
    revision: 1,
    contentHash: contentHashOverride ?? `local:${stat.mtimeMs}:${stat.size}`,
    size: stat.size,
    createdAt: stat.mtime.toISOString(),
    local: true,
    localEntry: entry,
  };
  if (type === "png" || type === "jpg" || type === "webp") {
    try {
      const dims = readImageDims(type, fs.readFileSync(absPath));
      if (dims) {
        record.naturalWidth = dims.width;
        record.naturalHeight = dims.height;
      }
    } catch {
      // ignore malformed image headers in listings
    }
  }
  return { artifactId, record, entry, absPath };
}

export function findLocalArtifactById(artifactId: string): LocalArtifact | undefined {
  const manifest = readManifest();
  for (const [projectId, project] of Object.entries(manifest.projects)) {
    const artifact = listLocalArtifactsForProject(projectId, project).find(
      (a) => a.artifactId === artifactId,
    );
    if (artifact) return artifact;
  }
  return undefined;
}

export function resolveLocalProjectFile(projectId: string, relInput: string): {
  project: ProjectRecord;
  root: string;
  absPath: string;
  relPath: string;
} {
  const project = readManifest().projects[projectId];
  if (!project) throw new CliError("INVALID_INPUT", `project not found: ${projectId}`);

  let relPath: string;
  try {
    relPath = decodeURIComponent(relInput);
  } catch {
    throw new CliError("INVALID_INPUT", "bad artifact path encoding");
  }
  relPath = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!relPath || /[\x00-\x1f\x7f]/.test(relPath)) {
    throw new CliError("INVALID_INPUT", "bad artifact path");
  }
  const parts = relPath.split("/");
  if (parts.some((p) => p === ".." || p === "")) {
    throw new CliError("INVALID_INPUT", "artifact path must not contain '..' or empty segments");
  }

  const root = projectLocalArtifactsDir(project.path);
  const absPath = path.resolve(root, ...parts);
  const rootAbs = path.resolve(root);
  if (absPath !== rootAbs && !absPath.startsWith(rootAbs + path.sep)) {
    throw new CliError("INVALID_INPUT", "artifact path escapes artifact root");
  }
  return { project, root, absPath, relPath: toPosix(relPath) };
}

export function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function localArtifactId(projectId: string, entry: string): string {
  return "local_" + createHash("sha256").update(`${projectId}\0${entry}`).digest("hex").slice(0, 16);
}

function directorySignature(absDir: string, entries: fs.Dirent[]): string {
  const hash = createHash("sha256");
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const e of sorted) {
    if (!e.isFile()) continue;
    if (e.name.startsWith(".")) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(path.join(absDir, e.name));
    } catch {
      continue;
    }
    hash.update(`${e.name}\0${st.mtimeMs}\0${st.size}\n`);
  }
  return `local-dir:${hash.digest("hex").slice(0, 32)}`;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}
