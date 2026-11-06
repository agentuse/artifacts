import fs from "node:fs";
import { CliError } from "./errors.js";
import { appendJsonLine, artifactKey, type ArtifactRef } from "./feed.js";
import { pinsPath } from "./paths.js";

/**
 * A pin belongs to the artifact (project + slug), not a revision, so a pinned
 * dashboard stays pinned as its agent keeps resubmitting. Append-only like the
 * other logs: the last line for an artifact wins when the file is folded.
 */
interface PinLine extends ArtifactRef {
  pinned: boolean;
  at: string;
}

export function pinsStamp(): string {
  const file = pinsPath();
  try {
    const stat = fs.statSync(file);
    return `${file}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return `${file}:empty`;
  }
}

function parseLine(raw: string): PinLine | undefined {
  if (!raw.trim()) return undefined;
  try {
    const line = JSON.parse(raw) as PinLine;
    const valid = typeof line.projectId === "string" && typeof line.slug === "string" &&
      typeof line.pinned === "boolean";
    return valid ? line : undefined;
  } catch {
    /* A hand-edited log should degrade, not brick the viewer. */
    return undefined;
  }
}

function readLines(): PinLine[] {
  let raw: string;
  try {
    raw = fs.readFileSync(pinsPath(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new CliError("IO_ERROR", `cannot read pins: ${(e as Error).message}`);
  }
  return raw.split("\n").map(parseLine).filter((line): line is PinLine => !!line);
}

/** Pinned artifacts, in the order they were pinned, so a pin keeps its place. */
export function readPins(): ArtifactRef[] {
  const pins = new Map<string, ArtifactRef>();
  for (const line of readLines()) {
    const key = artifactKey(line);
    if (line.pinned) {
      if (!pins.has(key)) pins.set(key, { projectId: line.projectId, slug: line.slug });
    } else {
      pins.delete(key);
    }
  }
  return [...pins.values()];
}

export function isPinned(artifact: ArtifactRef): boolean {
  const key = artifactKey(artifact);
  return readPins().some((pin) => artifactKey(pin) === key);
}

/** Setting the state it is already in writes nothing, so a repeat can't reorder pins. */
export function setPinned(artifact: ArtifactRef, pinned: boolean): void {
  if (isPinned(artifact) === pinned) return;
  const line: PinLine = {
    projectId: artifact.projectId,
    slug: artifact.slug,
    pinned,
    at: new Date().toISOString(),
  };
  appendJsonLine(pinsPath(), line, "pin line too large");
}

/** Forget a project's pins. The caller holds the store lock. */
export function dropProjectPins(projectId: string): void {
  const lines = readLines();
  const keep = lines.filter((line) => line.projectId !== projectId);
  if (keep.length === lines.length) return;
  const tmp = `${pinsPath()}.tmp.${process.pid}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, keep.map((line) => JSON.stringify(line) + "\n").join(""));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, pinsPath());
}
