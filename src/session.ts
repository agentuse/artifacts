import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { sessionsDir } from "./paths.js";

const TTL_MS = 4 * 60 * 60 * 1000;

interface SessionRecord {
  runId: string;
  projectId: string;
  parentPid: number;
  tty: string;
  updatedAt: string;
}

function tupleHash(projectId: string, parentPid: number, tty: string): string {
  return createHash("sha256")
    .update(`${projectId}|${parentPid}|${tty}`)
    .digest("hex")
    .slice(0, 16);
}

function getTty(): string {
  // Best-effort terminal identifier. process.stdout.isTTY + ppid keep separate
  // terminals separated; non-TTY agents fall back to an empty string and lean
  // entirely on the parent_pid component.
  if (process.stdout.isTTY && (process.stdout as unknown as { fd: number }).fd != null) {
    try {
      // On *nix, process.env.TTY is sometimes set; otherwise just use an opaque marker.
      return process.env.TTY || `tty:${process.stdout.columns}x${process.stdout.rows}`;
    } catch {
      return "tty";
    }
  }
  return "no-tty";
}

function sessionFilePath(projectId: string, parentPid: number, tty: string): string {
  return path.join(sessionsDir(), `${tupleHash(projectId, parentPid, tty)}.json`);
}

export function getCachedRunId(projectId: string): string | null {
  const parentPid = process.ppid;
  const tty = getTty();
  const file = sessionFilePath(projectId, parentPid, tty);
  if (!fs.existsSync(file)) return null;
  try {
    const rec: SessionRecord = JSON.parse(fs.readFileSync(file, "utf8"));
    const age = Date.now() - new Date(rec.updatedAt).getTime();
    if (age > TTL_MS) return null;
    if (rec.projectId !== projectId) return null;
    return rec.runId;
  } catch {
    return null;
  }
}

export function setCachedRunId(projectId: string, runId: string): void {
  fs.mkdirSync(sessionsDir(), { recursive: true });
  const parentPid = process.ppid;
  const tty = getTty();
  const file = sessionFilePath(projectId, parentPid, tty);
  const rec: SessionRecord = {
    runId,
    projectId,
    parentPid,
    tty,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(rec, null, 2));
}
