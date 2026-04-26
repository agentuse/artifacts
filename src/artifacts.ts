import fs from "node:fs";
import { CliError } from "./errors.js";
import {
  artifactFilePath,
  projectFilesDir,
} from "./paths.js";
import {
  ArtifactRecord,
  ensureProject,
  Manifest,
  RunRecord,
  readManifest,
  withLock,
  writeManifestAtomic,
} from "./manifest.js";
import { sha256, shortId } from "./hash.js";
import {
  ArtifactType,
  assertExtCompatible,
  extFromType,
  inferType,
  resolveLogicalName,
} from "./validation.js";
import { ProjectInfo, resolveProject } from "./project.js";

export const DEFAULT_MAX_SIZE = 25 * 1024 * 1024;

export interface AddInput {
  /** A filesystem path or "-" for stdin. */
  source: string;
  /** Optional explicit logical name. */
  name?: string;
  /** Force a new revision even on identical hash. */
  forceRevision?: boolean;
  /** Optional run tag. The string is the tag's identity within the project:
   *  same string = same run, fresh string = fresh run. Absent = untagged. */
  run?: string;
  /** Override max-size (bytes). */
  maxSize?: number;
}

export interface AddResult {
  artifactId: string;
  name: string;
  type: ArtifactType;
  revision: number;
  previousRevision?: number;
  previousArtifactId?: string;
  size: number;
  contentHash: string;
  skipped: boolean;
}

export interface AddBatchResult {
  project: ProjectInfo;
  /** The run tag applied to this batch, if any. */
  runId?: string;
  results: AddResult[];
}

async function readSource(
  source: string,
  maxSize: number,
): Promise<{ buf: Buffer }> {
  if (source === "-") {
    const chunks: Buffer[] = [];
    let total = 0;
    return await new Promise((resolve, reject) => {
      process.stdin.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxSize) {
          reject(
            new CliError("INVALID_INPUT", `stdin exceeds max-size of ${maxSize} bytes`),
          );
          return;
        }
        chunks.push(chunk);
      });
      process.stdin.on("end", () => resolve({ buf: Buffer.concat(chunks) }));
      process.stdin.on("error", reject);
    });
  }
  const real = fs.realpathSync(source);
  const stat = fs.statSync(real);
  if (!stat.isFile()) {
    throw new CliError("INVALID_INPUT", `not a regular file: ${source}`);
  }
  if (stat.size > maxSize) {
    throw new CliError(
      "INVALID_INPUT",
      `file exceeds max-size of ${maxSize} bytes (got ${stat.size})`,
    );
  }
  return { buf: fs.readFileSync(real) };
}

function resolveSourceForName(source: string): string | undefined {
  if (source === "-") return undefined;
  return fs.realpathSync(source);
}

export async function addArtifacts(inputs: AddInput[]): Promise<AddBatchResult> {
  if (inputs.length === 0) throw new CliError("INVALID_INPUT", "no inputs");

  const project = resolveProject();
  const maxSize = inputs[0]?.maxSize ?? DEFAULT_MAX_SIZE;

  // Read all sources up-front (outside the lock).
  type Prepared = {
    input: AddInput;
    name: string;
    type: ArtifactType;
    buf: Buffer;
    contentHash: string;
  };
  const prepared: Prepared[] = [];
  for (const input of inputs) {
    const isStdin = input.source === "-";
    const resolvedSource = isStdin ? undefined : resolveSourceForName(input.source);
    assertExtCompatible({
      sourcePath: isStdin ? undefined : input.source,
      explicitName: input.name,
    });
    const name = resolveLogicalName({
      explicitName: input.name,
      resolvedSource,
      projectPath: project.path,
      isStdin,
    });
    const type = inferType(name);
    const { buf } = await readSource(input.source, maxSize);
    prepared.push({ input, name, type, buf, contentHash: sha256(buf) });
  }

  const results: AddResult[] = [];
  let runId: string | undefined;

  // A batch is tagged with at most one run. Prefer the first explicit --run
  // value among the inputs, else the env var. No implicit auto-run.
  const explicitRun = inputs.find((i) => i.run)?.run;

  await withLock(async () => {
    const manifest = readManifest();
    ensureProject(manifest, project);

    runId = resolveRunId({
      manifest,
      projectId: project.projectId,
      explicit: explicitRun,
    });

    for (const p of prepared) {
      const latestId = manifest.latest[project.projectId]?.[p.name];
      const latest = latestId ? manifest.artifacts[latestId] : undefined;

      const isDup = latest && latest.contentHash === p.contentHash;
      if (isDup && !p.input.forceRevision) {
        results.push({
          artifactId: latestId!,
          name: p.name,
          type: p.type,
          revision: latest!.revision,
          previousRevision: latest!.revision,
          previousArtifactId: latestId,
          size: p.buf.length,
          contentHash: p.contentHash,
          skipped: true,
        });
        continue;
      }

      const artifactId = shortId("art");
      const revision = (latest?.revision ?? 0) + 1;
      const ext = extFromType(p.type);
      const targetPath = artifactFilePath(project.projectId, artifactId, ext);

      fs.mkdirSync(projectFilesDir(project.projectId), { recursive: true });
      const tmp = targetPath + ".tmp";
      const fd = fs.openSync(tmp, "w");
      try {
        fs.writeFileSync(fd, p.buf);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, targetPath);

      const record: ArtifactRecord = {
        projectId: project.projectId,
        ...(runId ? { runId } : {}),
        name: p.name,
        type: p.type,
        revision,
        previousArtifactId: latestId,
        contentHash: p.contentHash,
        size: p.buf.length,
        createdAt: new Date().toISOString(),
      };
      manifest.artifacts[artifactId] = record;
      manifest.latest[project.projectId] ??= {};
      manifest.latest[project.projectId]![p.name] = artifactId;

      results.push({
        artifactId,
        name: p.name,
        type: p.type,
        revision,
        previousRevision: latest?.revision,
        previousArtifactId: latestId,
        size: p.buf.length,
        contentHash: p.contentHash,
        skipped: false,
      });
    }

    writeManifestAtomic(manifest);
  });

  return { project, runId, results };
}

/** The run tag is whatever string the user supplied (--run or env). Same
 *  string = same tag (reuse). New string = new tag (create record). No
 *  auto-tagging when neither is supplied. */
function resolveRunId(opts: {
  manifest: Manifest;
  projectId: string;
  explicit?: string;
}): string | undefined {
  const { manifest, projectId, explicit } = opts;
  const tag = explicit ?? process.env.AGENTUSE_RUN_ID;
  if (!tag) return undefined;
  if (!manifest.runs[tag]) {
    const rec: RunRecord = {
      projectId,
      createdAt: new Date().toISOString(),
    };
    manifest.runs[tag] = rec;
  }
  return tag;
}

// ---------- list ----------

export interface ListFilter {
  projectId?: string;
  projectName?: string;
  runId?: string;
  name?: string;
  revisions?: boolean;
}

export interface ListedArtifact {
  artifactId: string;
  record: ArtifactRecord;
  isLatest: boolean;
}

export function listArtifacts(filter: ListFilter): ListedArtifact[] {
  const manifest = readManifest();
  let projectId = filter.projectId;
  if (!projectId && filter.projectName) {
    const match = Object.entries(manifest.projects).find(
      ([, p]) => p.name === filter.projectName,
    );
    if (!match) {
      throw new CliError("NOT_FOUND", `project not found: ${filter.projectName}`);
    }
    projectId = match[0];
  }
  if (!projectId) {
    // Default: current cwd's project.
    projectId = resolveProject().projectId;
  }

  const latestMap = manifest.latest[projectId] ?? {};
  const latestIds = new Set(Object.values(latestMap));

  const all = Object.entries(manifest.artifacts).filter(
    ([, a]) => a.projectId === projectId,
  );

  let filtered = all;
  if (filter.runId) filtered = filtered.filter(([, a]) => a.runId === filter.runId);
  if (filter.name) filtered = filtered.filter(([, a]) => a.name === filter.name);

  if (!filter.revisions) {
    // Only the latest revision per name.
    filtered = filtered.filter(([id]) => latestIds.has(id));
  }

  return filtered
    .map(([id, record]) => ({
      artifactId: id,
      record,
      isLatest: latestIds.has(id),
    }))
    .sort(
      (a, b) =>
        a.record.name.localeCompare(b.record.name) ||
        a.record.revision - b.record.revision,
    );
}

// ---------- url / where helpers ----------

export function findArtifact(
  manifest: Manifest,
  projectId: string,
  name: string,
  revision?: number,
): { artifactId: string; record: ArtifactRecord } {
  if (revision == null) {
    const id = manifest.latest[projectId]?.[name];
    if (!id || !manifest.artifacts[id]) {
      throw new CliError("NOT_FOUND", `no artifact: ${name}`);
    }
    return { artifactId: id, record: manifest.artifacts[id] };
  }
  const match = Object.entries(manifest.artifacts).find(
    ([, a]) => a.projectId === projectId && a.name === name && a.revision === revision,
  );
  if (!match) {
    throw new CliError("NOT_FOUND", `no revision ${revision} of ${name}`);
  }
  return { artifactId: match[0], record: match[1] };
}

// ---------- revert ----------

export async function revertArtifact(opts: {
  name: string;
  to: number;
}): Promise<AddResult> {
  const project = resolveProject();
  let result!: AddResult;
  await withLock(async () => {
    const manifest = readManifest();
    const target = findArtifact(manifest, project.projectId, opts.name, opts.to);
    const ext = extFromType(target.record.type);
    const sourcePath = artifactFilePath(project.projectId, target.artifactId, ext);
    if (!fs.existsSync(sourcePath)) {
      throw new CliError("IO_ERROR", `revision file missing: ${sourcePath}`);
    }
    const buf = fs.readFileSync(sourcePath);
    const contentHash = sha256(buf);

    const latestId = manifest.latest[project.projectId]?.[opts.name];
    const latest = latestId ? manifest.artifacts[latestId] : undefined;
    const newId = shortId("art");
    const revision = (latest?.revision ?? 0) + 1;
    const newPath = artifactFilePath(project.projectId, newId, ext);
    fs.copyFileSync(sourcePath, newPath);

    // Revert is administrative; only inherits a run tag if the env var is
    // set. No implicit re-tagging from the source revision.
    const runId = resolveRunId({
      manifest,
      projectId: project.projectId,
    });

    const record: ArtifactRecord = {
      projectId: project.projectId,
      ...(runId ? { runId } : {}),
      name: opts.name,
      type: target.record.type,
      revision,
      previousArtifactId: latestId,
      contentHash,
      size: buf.length,
      createdAt: new Date().toISOString(),
    };
    manifest.artifacts[newId] = record;
    manifest.latest[project.projectId] ??= {};
    manifest.latest[project.projectId]![opts.name] = newId;
    writeManifestAtomic(manifest);

    result = {
      artifactId: newId,
      name: opts.name,
      type: target.record.type,
      revision,
      previousRevision: latest?.revision,
      previousArtifactId: latestId,
      size: buf.length,
      contentHash,
      skipped: false,
    };
  });
  return result;
}

// ---------- rm ----------

export async function removeRevision(opts: {
  name: string;
  revision: number;
}): Promise<{ artifactId: string }> {
  const project = resolveProject();
  let removedId = "";
  await withLock(async () => {
    const manifest = readManifest();
    const target = findArtifact(manifest, project.projectId, opts.name, opts.revision);
    removedId = target.artifactId;
    const ext = extFromType(target.record.type);
    const file = artifactFilePath(project.projectId, target.artifactId, ext);
    try {
      fs.unlinkSync(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    delete manifest.artifacts[target.artifactId];

    // Fix up any child pointers.
    for (const a of Object.values(manifest.artifacts)) {
      if (a.previousArtifactId === target.artifactId) {
        a.previousArtifactId = target.record.previousArtifactId;
      }
    }

    // If we removed the latest, fall back to the predecessor.
    const latestId = manifest.latest[project.projectId]?.[opts.name];
    if (latestId === target.artifactId) {
      const predecessor = target.record.previousArtifactId;
      if (predecessor && manifest.artifacts[predecessor]) {
        manifest.latest[project.projectId]![opts.name] = predecessor;
      } else {
        delete manifest.latest[project.projectId]![opts.name];
      }
    }

    writeManifestAtomic(manifest);
  });
  return { artifactId: removedId };
}

// ---------- prune ----------

export interface PruneOptions {
  olderThanMs?: number;
  keepLatestOnly?: boolean;
}

export async function prune(
  options: PruneOptions,
): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  await withLock(async () => {
    const manifest = readManifest();
    // If both flags are set, --keep-latest-only takes precedence and ignores --older-than
    // (the union semantics are not defined by the spec; this is the most defensible default).
    const cutoff = options.olderThanMs != null ? Date.now() - options.olderThanMs : null;
    const latestSet = new Set<string>();
    for (const proj of Object.values(manifest.latest)) {
      for (const id of Object.values(proj)) latestSet.add(id);
    }
    for (const [id, a] of Object.entries(manifest.artifacts)) {
      const ageOk = cutoff == null ? true : new Date(a.createdAt).getTime() < cutoff;
      const keepLatest = options.keepLatestOnly ? !latestSet.has(id) : false;
      const shouldRemove =
        (options.keepLatestOnly && keepLatest) ||
        (!options.keepLatestOnly && cutoff != null && ageOk && !latestSet.has(id));
      if (!shouldRemove) continue;
      const ext = extFromType(a.type);
      const file = artifactFilePath(a.projectId, id, ext);
      try {
        fs.unlinkSync(file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      delete manifest.artifacts[id];
      removed.push(id);
      // Repair previous pointers.
      for (const child of Object.values(manifest.artifacts)) {
        if (child.previousArtifactId === id) {
          child.previousArtifactId = a.previousArtifactId;
        }
      }
    }
    writeManifestAtomic(manifest);
  });
  return { removed };
}

// ---------- fsck ----------

export async function fsck(): Promise<{ rebuilt: boolean; issues: string[] }> {
  const issues: string[] = [];
  await withLock(async () => {
    const manifest = readManifest();
    const newLatest: Manifest["latest"] = {};
    for (const [id, a] of Object.entries(manifest.artifacts)) {
      const ext = extFromType(a.type);
      const file = artifactFilePath(a.projectId, id, ext);
      if (!fs.existsSync(file)) {
        issues.push(`missing file for ${id} (${a.name} v${a.revision})`);
        continue;
      }
      const cur = newLatest[a.projectId]?.[a.name];
      if (!cur || (manifest.artifacts[cur]?.revision ?? -1) < a.revision) {
        newLatest[a.projectId] ??= {};
        newLatest[a.projectId]![a.name] = id;
      }
    }
    manifest.latest = newLatest;
    writeManifestAtomic(manifest);
  });
  return { rebuilt: true, issues };
}

// ---------- viewer URL helpers ----------

export interface ViewerLocation {
  port: number;
}

export function viewerProjectUrl(loc: ViewerLocation, projectId: string): string {
  return `http://127.0.0.1:${loc.port}/p/${projectId}`;
}

export function viewerRunUrl(loc: ViewerLocation, projectId: string, runId: string): string {
  return `http://127.0.0.1:${loc.port}/p/${projectId}/r/${encodeURIComponent(runId)}`;
}

export function viewerArtifactUrl(
  loc: ViewerLocation,
  projectId: string,
  name: string,
  revision?: number,
): string {
  const base = `http://127.0.0.1:${loc.port}/p/${projectId}/a/${encodeURIComponent(name)}`;
  return revision == null ? base : `${base}/v/${revision}`;
}

export function pathFor(record: ArtifactRecord, artifactId: string): string {
  const ext = extFromType(record.type);
  return artifactFilePath(record.projectId, artifactId, ext);
}
