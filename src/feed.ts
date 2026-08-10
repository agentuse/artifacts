import fs from "node:fs";
import path from "node:path";
import { CliError } from "./errors.js";
import { feedPath, rootDir } from "./paths.js";
import type { ArtifactType } from "./validation.js";

/**
 * One submission. The feed log is append-only: a line is never edited in
 * place, so a re-submit of the same slug appends a new line with a higher
 * `rev`. Readers fold the log down to the newest rev per (projectId, slug).
 */
export interface FeedEntry {
  id: string;
  projectId: string;
  projectName: string;
  /** Stable per-project key for "the same artifact, resubmitted". */
  slug: string;
  rev: number;
  title: string;
  tags: string[];
  /** Type of the bundle's entry file — what the viewer renders. */
  type: ArtifactType;
  /** Entry file path relative to the bundle root, e.g. "index.html". */
  entry: string;
  files: number;
  size: number;
  contentHash: string;
  /** Where the bundle was copied from, so the viewer can point back at it. */
  sourcePath: string;
  submittedAt: string;
  naturalWidth?: number;
  naturalHeight?: number;
}

export interface FeedQuery {
  projectId?: string;
  tag?: string;
  q?: string;
  limit?: number;
  cursor?: number;
  /** Include superseded revisions instead of only the newest per slug. */
  allRevisions?: boolean;
}

export interface FeedPage {
  entries: FeedEntry[];
  nextCursor: number | null;
  total: number;
  projects: Array<{ projectId: string; projectName: string; count: number }>;
  tags: Array<{ tag: string; count: number }>;
}

const MAX_TAGS = 12;
const MAX_TAG_LEN = 32;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;

export function normalizeTags(input: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    for (const piece of raw.split(",")) {
      const tag = piece.trim().toLowerCase().replace(/\s+/g, "-");
      if (!tag || tag.length > MAX_TAG_LEN) continue;
      if (/[\x00-\x1f\x7f]/.test(tag)) continue;
      if (seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
      if (out.length >= MAX_TAGS) return out;
    }
  }
  return out;
}

/**
 * Append one entry. A single write under the platform pipe-buffer size to a
 * file opened with O_APPEND is atomic, so concurrent agents can submit without
 * taking the registry lock — an interleaved write can never split a line.
 */
export function appendFeedEntry(entry: FeedEntry): void {
  fs.mkdirSync(rootDir(), { recursive: true });
  const line = JSON.stringify(entry) + "\n";
  if (Buffer.byteLength(line) > 8192) {
    throw new CliError("INVALID_INPUT", "feed entry too large");
  }
  const fd = fs.openSync(feedPath(), "a");
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Identity of the log's current contents. Cheap enough to call per request,
 * and it doubles as the viewer's ETag so polling costs one stat, not a parse.
 */
export function feedStamp(): string {
  // The path is part of the stamp because AGENTUSE_ARTIFACTS_HOME can change
  // within a process (tests do exactly this), and mtime+size alone would let
  // one store's cache answer for another's.
  const file = feedPath();
  try {
    const stat = fs.statSync(file);
    return `${file}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return `${file}:empty`;
  }
}

let cache: { stamp: string; entries: FeedEntry[] } | null = null;

/** Every entry, oldest first. Malformed lines are skipped, not fatal. */
export function readFeedEntries(): FeedEntry[] {
  const stamp = feedStamp();
  if (cache && cache.stamp === stamp) return cache.entries;
  if (!fs.existsSync(feedPath())) {
    cache = { stamp, entries: [] };
    return cache.entries;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(feedPath(), "utf8");
  } catch (e) {
    throw new CliError("IO_ERROR", `cannot read feed: ${(e as Error).message}`);
  }
  const entries: FeedEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isFeedEntry(parsed)) continue;
    // A hand-edited or older line may lack tags; downstream filters index it
    // directly, so normalize once here instead of guarding at every use.
    if (!Array.isArray(parsed.tags)) parsed.tags = [];
    entries.push(parsed);
  }
  cache = { stamp, entries };
  return entries;
}

function isFeedEntry(value: unknown): value is FeedEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as FeedEntry;
  return (
    typeof e.id === "string" &&
    typeof e.projectId === "string" &&
    typeof e.slug === "string" &&
    typeof e.rev === "number" &&
    typeof e.entry === "string" &&
    typeof e.submittedAt === "string"
  );
}

/** Rewrite the whole log. Only `prune` needs this; callers hold the lock. */
export function writeFeedAtomic(entries: FeedEntry[]): void {
  fs.mkdirSync(rootDir(), { recursive: true });
  const tmp = `${feedPath()}.tmp.${process.pid}`;
  const data = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, feedPath());
}

/** All revisions of one artifact, newest first. */
export function feedEntryRevisions(entries: FeedEntry[], projectId: string, slug: string): FeedEntry[] {
  return entries
    .filter((e) => e.projectId === projectId && e.slug === slug)
    .sort((a, b) => b.rev - a.rev);
}

export function nextRevision(entries: FeedEntry[], projectId: string, slug: string): number {
  let max = 0;
  for (const e of entries) {
    if (e.projectId === projectId && e.slug === slug && e.rev > max) max = e.rev;
  }
  return max + 1;
}

/**
 * Newest-first page plus the facet counts the viewer's filter chips need.
 * Facets are computed over the whole (deduped, project/tag-unfiltered) set so
 * the chips don't disappear as you filter.
 */
export function queryFeed(query: FeedQuery = {}): FeedPage {
  const all = readFeedEntries();
  const visible = query.allRevisions ? all : latestPerSlug(all);
  visible.sort(compareNewestFirst);

  const projects = countProjects(visible);
  const tags = countTags(visible);

  const filtered = visible.filter((e) => matches(e, query));
  const limit = clampLimit(query.limit);
  const start = Number.isFinite(query.cursor) && (query.cursor ?? 0) > 0 ? Math.floor(query.cursor!) : 0;
  const page = filtered.slice(start, start + limit);
  const nextCursor = start + limit < filtered.length ? start + limit : null;

  return { entries: page, nextCursor, total: filtered.length, projects, tags };
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || (limit ?? 0) <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(limit!));
}

function matches(entry: FeedEntry, query: FeedQuery): boolean {
  if (query.projectId && entry.projectId !== query.projectId) return false;
  if (query.tag && !entry.tags.includes(query.tag)) return false;
  if (query.q) {
    const needle = query.q.toLowerCase();
    const haystack = `${entry.title}\n${entry.slug}\n${entry.projectName}\n${entry.tags.join(" ")}`;
    if (!haystack.toLowerCase().includes(needle)) return false;
  }
  return true;
}

function latestPerSlug(entries: FeedEntry[]): FeedEntry[] {
  const byKey = new Map<string, FeedEntry>();
  for (const entry of entries) {
    const key = `${entry.projectId}\0${entry.slug}`;
    const cur = byKey.get(key);
    if (!cur || entry.rev > cur.rev) byKey.set(key, entry);
  }
  return [...byKey.values()];
}

function compareNewestFirst(a: FeedEntry, b: FeedEntry): number {
  const byTime = entryTime(b) - entryTime(a);
  if (byTime !== 0) return byTime;
  return b.id.localeCompare(a.id);
}

function entryTime(entry: FeedEntry): number {
  return new Date(entry.submittedAt).getTime() || 0;
}

function countProjects(entries: FeedEntry[]): FeedPage["projects"] {
  const counts = new Map<string, { projectId: string; projectName: string; count: number }>();
  for (const entry of entries) {
    const cur = counts.get(entry.projectId);
    if (cur) cur.count += 1;
    else counts.set(entry.projectId, { projectId: entry.projectId, projectName: entry.projectName, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.projectName.localeCompare(b.projectName));
}

function countTags(entries: FeedEntry[]): FeedPage["tags"] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const tag of entry.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Bundle directory for an entry, relative to the store root. */
export function entryStoreRel(entry: FeedEntry): string {
  return path.join(entry.projectId, entry.slug, revDirName(entry.rev));
}

function revDirName(rev: number): string {
  return String(rev).padStart(4, "0");
}
