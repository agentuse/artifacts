import fs from "node:fs";
import os from "node:os";
import { CliError } from "./errors.js";
import { lockPath, manifestPath, rootDir } from "./paths.js";

export const SCHEMA_VERSION = 1;

export interface ProjectRecord {
  name: string;
  path: string;
  createdAt: string;
  updatedAt?: string;
}

export interface ArtifactRecord {
  projectId: string;
  name: string;
  type: "markdown" | "agentuse" | "html" | "png" | "jpg" | "webp" | "pdf";
  revision: number;
  contentHash: string;
  size: number;
  createdAt: string;
  /** Agent-supplied initial tile size (pixels) for the viewer. The viewer
   *  treats these as suggestions only — the user's persisted resize wins,
   *  and the viewer floors them at its own minimums. Adding these is a
   *  purely additive schema change; old manifests read fine (missing =
   *  undefined), so we deliberately do NOT bump SCHEMA_VERSION. */
  suggestedWidth?: number;
  suggestedHeight?: number;
  /** Natural pixel dimensions for image artifacts (png/jpg/webp), probed
   *  from the file header at ingest time. The viewer uses these to pick a
   *  default tile size that matches the image's aspect ratio so square
   *  tiles don't letterbox portrait/landscape images. Lower precedence
   *  than suggestedWidth/Height and a user resize. Additive, no schema
   *  bump. */
  naturalWidth?: number;
  naturalHeight?: number;
  /** Project-local live artifact fields. projectRelPath is the primary file's
   *  path relative to the project root (POSIX separators). localEntry is still
   *  set for artifacts under <project>/.agentuse/artifacts/ and remains
   *  relative to that artifact root for backwards-compatible URLs/grouping.
   *  absolutePath is host-native so the viewer can offer "copy path" without
   *  reconstructing it client-side. These fields are never persisted into the
   *  on-disk manifest (buildLocalManifest fills them on every read). */
  local?: boolean;
  localEntry?: string;
  projectRelPath?: string;
  absolutePath?: string;
}

export interface Manifest {
  schemaVersion: number;
  projects: Record<string, ProjectRecord>;
  artifacts: Record<string, ArtifactRecord>;
  /** project_id -> name -> latest artifact_id */
  latest: Record<string, Record<string, string>>;
}

function emptyManifest(): Manifest {
  return {
    schemaVersion: SCHEMA_VERSION,
    projects: {},
    artifacts: {},
    latest: {},
  };
}

export function readManifest(): Manifest {
  if (!fs.existsSync(manifestPath())) return emptyManifest();
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath(), "utf8");
  } catch (e) {
    throw new CliError("IO_ERROR", `cannot read manifest: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CliError("CORRUPT_MANIFEST", `manifest JSON parse failed: ${(e as Error).message}`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as Manifest).schemaVersion !== "number"
  ) {
    throw new CliError("CORRUPT_MANIFEST", "manifest missing schemaVersion");
  }
  const m = parsed as Manifest;
  if (m.schemaVersion !== SCHEMA_VERSION) {
    throw new CliError(
      "CORRUPT_MANIFEST",
      `manifest schemaVersion ${m.schemaVersion} != ${SCHEMA_VERSION}`,
    );
  }
  // Defensive defaults for forward-compat reads.
  m.projects ??= {};
  m.artifacts ??= {};
  m.latest ??= {};
  return m;
}

export function writeManifestAtomic(manifest: Manifest): void {
  fs.mkdirSync(rootDir(), { recursive: true });
  const tmp = manifestPath() + ".tmp." + process.pid;
  const data = JSON.stringify(manifest, null, 2);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, manifestPath());
}

interface LockBody {
  pid: number;
  host: string;
  acquiredAt: string;
}

const STALE_LOCK_MS = 60_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 50;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function tryAcquire(): boolean {
  fs.mkdirSync(rootDir(), { recursive: true });
  const body: LockBody = {
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: new Date().toISOString(),
  };
  try {
    const fd = fs.openSync(lockPath(), "wx");
    fs.writeFileSync(fd, JSON.stringify(body));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  // Existing lock - check if stale.
  let existing: LockBody | null = null;
  try {
    existing = JSON.parse(fs.readFileSync(lockPath(), "utf8"));
  } catch {
    // unreadable: treat as stale
  }
  const age = existing ? Date.now() - new Date(existing.acquiredAt).getTime() : Infinity;
  const sameHost = existing?.host === os.hostname();
  const dead = sameHost && existing && !pidAlive(existing.pid);
  if (age > STALE_LOCK_MS || dead) {
    try {
      fs.unlinkSync(lockPath());
    } catch {
      /* ignore race */
    }
    return tryAcquire();
  }
  return false;
}

export async function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const start = Date.now();
  while (!tryAcquire()) {
    if (Date.now() - start > LOCK_TIMEOUT_MS) {
      let holder: LockBody | null = null;
      try {
        holder = JSON.parse(fs.readFileSync(lockPath(), "utf8"));
      } catch {
        /* ignore */
      }
      throw new CliError("LOCK_TIMEOUT", "could not acquire manifest lock", {
        holder,
      });
    }
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      fs.unlinkSync(lockPath());
    } catch {
      /* ignore */
    }
  };
  const onSig = () => {
    release();
    process.exit(130);
  };
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);
  try {
    return await fn();
  } finally {
    process.removeListener("SIGINT", onSig);
    process.removeListener("SIGTERM", onSig);
    release();
  }
}
