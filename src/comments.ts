import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { CliError } from "./errors.js";
import { appendJsonLine, type FeedEntry } from "./feed.js";
import { commentsPath } from "./paths.js";

/**
 * Comments belong to the artifact (project + slug), not to one revision, so
 * they carry over when it is resubmitted; `rev` records what the user was
 * looking at. The log is append-only like the feed: a comment's later state is
 * another line, folded on read, so concurrent agents never need the lock.
 */
export interface Comment {
  id: string;
  projectId: string;
  slug: string;
  rev: number;
  body: string;
  createdAt: string;
  /** The agent accepted a message saying this comment exists. */
  notifiedAt?: string;
  resolvedAt?: string;
}

type CommentLine =
  | ({ type: "comment" } & Comment)
  | { type: "notified" | "resolved"; id: string; at: string };

const MAX_COMMENT_BYTES = 4096;

export function commentsStamp(): string {
  const file = commentsPath();
  try {
    const stat = fs.statSync(file);
    return `${file}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return `${file}:empty`;
  }
}

function parseLine(raw: string): CommentLine | undefined {
  if (!raw.trim()) return undefined;
  try {
    const line = JSON.parse(raw) as CommentLine;
    if (line.type === "comment") {
      const valid = typeof line.id === "string" && typeof line.projectId === "string" &&
        typeof line.slug === "string" && typeof line.rev === "number" &&
        typeof line.body === "string" && typeof line.createdAt === "string";
      return valid ? line : undefined;
    }
    if (line.type === "notified" || line.type === "resolved") {
      return typeof line.id === "string" && typeof line.at === "string" ? line : undefined;
    }
  } catch {
    /* A hand-edited log should degrade, not brick the viewer. */
  }
  return undefined;
}

function readLines(): CommentLine[] {
  let raw: string;
  try {
    raw = fs.readFileSync(commentsPath(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new CliError("IO_ERROR", `cannot read comments: ${(e as Error).message}`);
  }
  return raw.split("\n").map(parseLine).filter((line): line is CommentLine => !!line);
}

/** Every comment with its current state, oldest first. */
export function readComments(): Comment[] {
  const byId = new Map<string, Comment>();
  for (const line of readLines()) {
    if (line.type === "comment") {
      const { type: _type, ...comment } = line;
      byId.set(line.id, comment);
      continue;
    }
    const comment = byId.get(line.id);
    if (!comment) continue;
    if (line.type === "notified") comment.notifiedAt = line.at;
    else comment.resolvedAt = line.at;
  }
  return [...byId.values()];
}

export function commentsFor(projectId: string, slug?: string): Comment[] {
  return readComments().filter((c) => c.projectId === projectId && (slug === undefined || c.slug === slug));
}

export function openCommentsFor(projectId: string, slug?: string): Comment[] {
  return commentsFor(projectId, slug).filter((c) => !c.resolvedAt);
}

export function addComment(entry: Pick<FeedEntry, "projectId" | "slug" | "rev">, rawBody: string): Comment {
  const body = rawBody.trim();
  if (!body) throw new CliError("INVALID_INPUT", "Write a comment first.");
  if (Buffer.byteLength(body) > MAX_COMMENT_BYTES) {
    throw new CliError("INVALID_INPUT", "That comment is too long. The limit is 4 KB.");
  }
  const comment: Comment = {
    id: `cmt_${randomBytes(8).toString("hex")}`,
    projectId: entry.projectId,
    slug: entry.slug,
    rev: entry.rev,
    body,
    createdAt: new Date().toISOString(),
  };
  appendJsonLine(commentsPath(), { type: "comment", ...comment }, "That comment is too long.");
  return comment;
}

/** Already-resolved ids are left as they are; an unknown id is a mistake and fails the batch. */
export function resolveComments(ids: string[]): Comment[] {
  const known = new Map(readComments().map((c) => [c.id, c]));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) throw new CliError("INVALID_INPUT", `no such comment: ${missing.join(", ")}`);
  const at = new Date().toISOString();
  return ids.map((id) => {
    const comment = known.get(id)!;
    if (comment.resolvedAt) return comment;
    appendJsonLine(commentsPath(), { type: "resolved", id, at }, "comment line too large");
    comment.resolvedAt = at;
    return comment;
  });
}

export function markCommentsNotified(ids: string[]): void {
  const at = new Date().toISOString();
  for (const id of ids) appendJsonLine(commentsPath(), { type: "notified", id, at }, "comment line too large");
}

/** Forget a project's comments and their state lines. The caller holds the store lock. */
export function dropProjectComments(projectId: string): void {
  const lines = readLines();
  const dropped = new Set(
    lines.flatMap((line) => (line.type === "comment" && line.projectId === projectId ? [line.id] : [])),
  );
  if (!dropped.size) return;
  const keep = lines.filter((line) => !dropped.has(line.id));
  const tmp = `${commentsPath()}.tmp.${process.pid}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, keep.map((line) => JSON.stringify(line) + "\n").join(""));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, commentsPath());
}
