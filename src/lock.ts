import fs from "node:fs";
import os from "node:os";
import { CliError } from "./errors.js";
import { lockPath, rootDir } from "./paths.js";

/**
 * Advisory lock for whole-file rewrites of `feed.jsonl` (prune, forget).
 * Appending a single feed line deliberately does NOT take this lock: one
 * `O_APPEND` write under the pipe-buffer size is atomic, so concurrent agents
 * can submit without contending.
 */

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
      throw new CliError("LOCK_TIMEOUT", "could not acquire artifact store lock", {
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
