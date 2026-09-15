import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse as parseHtml } from "node-html-parser";
import { CliError } from "./errors.js";
import {
  appendFeedEntry,
  entryStoreRel,
  nextRevision,
  normalizeTags,
  readFeedEntries,
  writeFeedAtomic,
  type FeedEntry,
} from "./feed.js";
import { readImageDims } from "./imageDims.js";
import { withLock } from "./lock.js";
import { storeDir } from "./paths.js";
import { resolveProject } from "./project.js";
import { inferType, type ArtifactType } from "./validation.js";

/**
 * A submitted artifact is copied into the store rather than referenced in
 * place. Agent output lives in gitignored scratch directories, so a pointer
 * would 404 after a branch switch or `git clean`; a feed entry also has to
 * mean "this is what was submitted at that moment", which a mutable file
 * cannot promise. The copy makes both true, and makes revisions free.
 */
export const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;
export const MAX_BUNDLE_FILES = 200;
const IMAGE_HEADER_BYTES = 256 * 1024;
const DEFAULT_KEEP_REVISIONS = 5;

/** Directories never worth copying into a bundle. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "coverage",
  "__pycache__",
]);

const ENTRY_CANDIDATES = ["index.html", "index.htm", "index.md", "index.markdown", "index.agentuse"];

/** Pre-0.4 drop zone. Only `import` still reads it; nothing writes it. */
const LOCAL_ARTIFACTS_REL = path.join(".agentuse", "artifacts");

export interface SubmitOptions {
  /** File or directory to submit. */
  target: string;
  title?: string;
  tags?: string[];
  slug?: string;
  /** Directory used to resolve the owning project; defaults to the target's. */
  cwd?: string;
}

export interface SubmitResult {
  entry: FeedEntry;
  /** True when identical content was already the newest revision. */
  deduped: boolean;
}

interface BundleFile {
  rel: string;
  abs: string;
  size: number;
}

export async function submitArtifact(opts: SubmitOptions): Promise<SubmitResult> {
  const abs = path.resolve(opts.target);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new CliError("INVALID_INPUT", `no such file or directory: ${opts.target}`);
  }

  const files = stat.isDirectory() ? collectBundleFiles(abs) : [singleFile(abs)];
  if (files.length === 0) {
    throw new CliError("INVALID_INPUT", `no supported files to submit in ${opts.target}`);
  }
  const entryRel = pickEntryFile(files, stat.isDirectory());
  const entryType = inferType(entryRel);

  const project = resolveProject(opts.cwd ?? (stat.isDirectory() ? abs : path.dirname(abs)));
  const slug = makeSlug(opts.slug ?? (stat.isDirectory() ? path.basename(abs) : stripExt(path.basename(abs))));
  const contentHash = hashBundle(files);

  const entryAbs = files.find((f) => f.rel === entryRel)!.abs;
  const title = opts.title?.trim() || deriveTitle(entryAbs, entryType, slug);
  const tags = normalizeTags(opts.tags ?? []);

  const existing = readFeedEntries();
  const newest = existing
    .filter((e) => e.projectId === project.projectId && e.slug === slug)
    .sort((a, b) => b.rev - a.rev)[0];
  // Agents re-run. A re-submit that changes nothing — same bytes, same title,
  // same tags — should not push a duplicate card to the top of the feed. A
  // changed title or tag is a real edit, so that still becomes a revision.
  if (
    newest &&
    newest.contentHash === contentHash &&
    newest.title === title &&
    sameTags(newest.tags, tags) &&
    fs.existsSync(bundleDir(newest))
  ) {
    return { entry: newest, deduped: true };
  }

  const rev = nextRevision(existing, project.projectId, slug);
  const entry: FeedEntry = {
    id: entryId(project.projectId, slug, rev),
    projectId: project.projectId,
    projectName: project.name,
    slug,
    rev,
    title,
    tags,
    type: entryType,
    entry: entryRel,
    files: files.length,
    size: files.reduce((sum, f) => sum + f.size, 0),
    contentHash,
    sourcePath: abs,
    submittedAt: new Date().toISOString(),
    ...imageDimsFor(entryType, entryAbs),
  };

  copyBundle(files, path.join(storeDir(), entryStoreRel(entry)));
  appendFeedEntry(entry);
  return { entry, deduped: false };
}

/** One-shot migration: submit everything under <project>/.agentuse/artifacts/. */
export async function importLocalArtifacts(cwd = process.cwd()): Promise<SubmitResult[]> {
  const project = resolveProject(cwd);
  const root = path.join(project.path, LOCAL_ARTIFACTS_REL);
  if (!fs.existsSync(root)) {
    throw new CliError("INVALID_INPUT", `no artifacts directory at ${root}`);
  }
  const results: SubmitResult[] = [];
  for (const ent of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (ent.name.startsWith(".")) continue;
    const abs = path.join(root, ent.name);
    if (ent.isDirectory()) {
      results.push(await submitArtifact({ target: abs, cwd: project.path }));
      continue;
    }
    if (!ent.isFile()) continue;
    try {
      inferType(ent.name);
    } catch {
      continue;
    }
    results.push(await submitArtifact({ target: abs, cwd: project.path }));
  }
  return results;
}

/**
 * Keep the newest `keep` revisions per artifact and delete the rest, both from
 * the log and from disk. Without this the store grows without bound, because
 * every re-submit writes a fresh copy of the whole bundle.
 */
export async function pruneStore(keep = DEFAULT_KEEP_REVISIONS): Promise<{
  removed: Array<{ id: string; slug: string; rev: number }>;
  freedBytes: number;
}> {
  const limit = Math.max(1, Math.floor(keep));
  const removed: Array<{ id: string; slug: string; rev: number }> = [];
  let freedBytes = 0;

  await withLock(async () => {
    const entries = readFeedEntries();
    const bySlug = new Map<string, FeedEntry[]>();
    for (const entry of entries) {
      const key = `${entry.projectId}\0${entry.slug}`;
      const list = bySlug.get(key) ?? [];
      list.push(entry);
      bySlug.set(key, list);
    }

    const drop = new Set<string>();
    for (const list of bySlug.values()) {
      list.sort((a, b) => b.rev - a.rev);
      for (const entry of list.slice(limit)) {
        drop.add(entry.id);
        removed.push({ id: entry.id, slug: entry.slug, rev: entry.rev });
        freedBytes += entry.size;
        removeBundle(entry);
      }
    }
    if (drop.size > 0) writeFeedAtomic(entries.filter((e) => !drop.has(e.id)));
  });

  return { removed, freedBytes };
}

/** Delete every stored revision of a project, then forget its feed lines. */
export async function forgetProjectArtifacts(projectId: string): Promise<number> {
  let dropped = 0;
  await withLock(async () => {
    const entries = readFeedEntries();
    const keep = entries.filter((e) => e.projectId !== projectId);
    dropped = entries.length - keep.length;
    // A typo'd id would otherwise report a cheerful "dropped 0".
    if (dropped === 0) {
      throw new CliError("INVALID_INPUT", `no artifacts from project: ${projectId}`);
    }
    writeFeedAtomic(keep);
  });
  rmDir(path.join(storeDir(), projectId));
  return dropped;
}

export function bundleDir(entry: FeedEntry): string {
  return path.join(storeDir(), entryStoreRel(entry));
}

/**
 * Map a request path inside a bundle to a real file. Bundles are copied by us
 * and contain no symlinks, but the containment check stays as defense in depth
 * against a crafted URL.
 */
export function resolveBundleFile(entry: FeedEntry, relInput: string): string {
  let rel: string;
  try {
    rel = decodeURIComponent(relInput);
  } catch {
    throw new CliError("INVALID_INPUT", "bad bundle path encoding");
  }
  rel = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel) rel = entry.entry;
  if (/[\x00-\x1f\x7f]/.test(rel)) throw new CliError("INVALID_INPUT", "bad bundle path");
  const parts = rel.split("/");
  if (parts.some((p) => p === ".." || p === "" || p === ".")) {
    throw new CliError("INVALID_INPUT", "bundle path must not contain '..' or empty segments");
  }
  const root = bundleDir(entry);
  const abs = path.resolve(root, ...parts);
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new CliError("INVALID_INPUT", "bundle path escapes the bundle root");
  }
  return abs;
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}

function singleFile(abs: string): BundleFile {
  inferType(abs); // throws on unsupported extension
  const stat = fs.statSync(abs);
  if (stat.size > MAX_BUNDLE_BYTES) {
    throw new CliError("INVALID_INPUT", `file is larger than the ${fmtMb(MAX_BUNDLE_BYTES)} bundle limit`);
  }
  return { rel: path.basename(abs), abs, size: stat.size };
}

/**
 * Walk the directory, enforcing both caps before anything is copied so a
 * runaway bundle fails loudly instead of half-copying. Support files (css,
 * svg, fonts, json) come along; unsupported ones are skipped silently because
 * a design folder routinely holds sources we don't need to serve.
 */
function collectBundleFiles(root: string): BundleFile[] {
  const files: BundleFile[] = [];
  let total = 0;
  const stack: Array<{ abs: string; rel: string }> = [{ abs: root, rel: "" }];

  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;
      if (ent.isSymbolicLink()) continue;
      const abs = path.join(cur.abs, ent.name);
      const rel = cur.rel ? `${cur.rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) stack.push({ abs, rel });
        continue;
      }
      if (!ent.isFile()) continue;
      if (!isBundleFile(ent.name)) continue;
      const size = fs.statSync(abs).size;
      total += size;
      files.push({ rel, abs, size });
      if (files.length > MAX_BUNDLE_FILES) {
        throw new CliError(
          "INVALID_INPUT",
          `bundle has more than ${MAX_BUNDLE_FILES} files; submit a narrower directory`,
        );
      }
      if (total > MAX_BUNDLE_BYTES) {
        throw new CliError(
          "INVALID_INPUT",
          `bundle is larger than ${fmtMb(MAX_BUNDLE_BYTES)}; submit a narrower directory`,
        );
      }
    }
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Renderable artifact types plus the support files their markup references. */
const SUPPORT_EXTENSIONS = new Set([
  ".css", ".svg", ".ico", ".json", ".woff2", ".woff", ".ttf", ".otf", ".gif",
  ".csv", ".tsv", ".txt", ".xlsx", ".docx", ".pptx", ".zip",
]);

function isBundleFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  if (SUPPORT_EXTENSIONS.has(ext)) return true;
  try {
    inferType(name);
    return true;
  } catch {
    return false;
  }
}

function pickEntryFile(files: BundleFile[], fromDirectory: boolean): string {
  if (!fromDirectory) return files[0]!.rel;
  for (const candidate of ENTRY_CANDIDATES) {
    if (files.some((f) => f.rel === candidate)) return candidate;
  }
  const renderable = files.filter((f) => isRenderable(f.rel));
  const topLevel = renderable.filter((f) => !f.rel.includes("/"));
  const pool = topLevel.length > 0 ? topLevel : renderable;
  if (pool.length === 1) return pool[0]!.rel;
  if (pool.length === 0) {
    throw new CliError(
      "INVALID_INPUT",
      "no renderable file in the directory; add an index.html or index.md",
    );
  }
  throw new CliError(
    "INVALID_INPUT",
    `directory has ${pool.length} renderable files and no index.*; add one or submit a single file`,
  );
}

function isRenderable(name: string): boolean {
  try {
    inferType(name);
    return true;
  } catch {
    return false;
  }
}

function copyBundle(files: BundleFile[], destRoot: string): void {
  // Copy into a sibling temp dir and rename, so a crash mid-copy can never
  // leave a half-written bundle behind the feed line that points at it.
  const tmpRoot = `${destRoot}.tmp.${process.pid}`;
  rmDir(tmpRoot);
  try {
    for (const file of files) {
      const dest = path.join(tmpRoot, ...file.rel.split("/"));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file.abs, dest);
    }
    fs.mkdirSync(path.dirname(destRoot), { recursive: true });
    rmDir(destRoot);
    fs.renameSync(tmpRoot, destRoot);
  } catch (e) {
    rmDir(tmpRoot);
    throw new CliError("IO_ERROR", `could not store bundle: ${(e as Error).message}`);
  }
}

function removeBundle(entry: FeedEntry): void {
  rmDir(bundleDir(entry));
  // Drop the slug directory too once its last revision is gone.
  const slugDir = path.dirname(bundleDir(entry));
  try {
    if (fs.readdirSync(slugDir).length === 0) fs.rmdirSync(slugDir);
  } catch {
    /* not empty, or already gone */
  }
}

function rmDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function hashBundle(files: BundleFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    hash.update(file.rel);
    hash.update("\0");
    hash.update(fs.readFileSync(file.abs));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 32);
}

function entryId(projectId: string, slug: string, rev: number): string {
  return (
    "art_" +
    createHash("sha256").update(`${projectId}\0${slug}\0${rev}`).digest("hex").slice(0, 16)
  );
}

export function makeSlug(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 64);
  if (!slug) throw new CliError("INVALID_INPUT", `cannot derive a slug from "${input}"`);
  return slug;
}

function stripExt(name: string): string {
  const ext = path.extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

/**
 * Title precedence: markdown frontmatter or first heading, HTML <title> or
 * first <h1>, else a humanized slug. Agents rarely pass --title, and "Weekly
 * Report" reads better in a feed than "weekly-report".
 */
function deriveTitle(absPath: string, type: ArtifactType, slug: string): string {
  const fallback = humanize(slug);
  if (type === "markdown" || type === "agentuse") {
    const text = readTextHead(absPath);
    return firstMarkdownTitle(text) ?? fallback;
  }
  if (type === "html") {
    const text = readTextHead(absPath);
    try {
      const root = parseHtml(text);
      const title = root.querySelector("title")?.text?.trim();
      if (title) return clampTitle(title);
      const h1 = root.querySelector("h1")?.text?.trim();
      if (h1) return clampTitle(h1);
    } catch {
      /* fall through to the slug */
    }
  }
  return fallback;
}

function firstMarkdownTitle(text: string): string | undefined {
  const lines = text.split("\n");
  let inFrontmatter = false;
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (i === 0 && line.trim() === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line.trim() === "---") {
        inFrontmatter = false;
        continue;
      }
      const match = /^title:\s*(.+)$/i.exec(line);
      if (match) return clampTitle(match[1]!.trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    // Shell snippets are full of `# comment` lines, and a README's first
    // fenced block usually comes before any real heading. Skipping fences
    // keeps "# or globally for every project" out of the feed.
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^#\s+(.+)$/.exec(line);
    if (heading) return clampTitle(heading[1]!.trim());
    const htmlHeading = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(line);
    if (htmlHeading) {
      const inner = htmlHeading[1]!.replace(/<[^>]+>/g, "").trim();
      if (inner) return clampTitle(inner);
    }
  }
  return undefined;
}

function clampTitle(title: string): string {
  const clean = title.replace(/\s+/g, " ").trim();
  return clean.length > 120 ? clean.slice(0, 119) + "…" : clean;
}

function humanize(slug: string): string {
  const words = slug.replace(/[-_.]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function readTextHead(absPath: string): string {
  try {
    const buf = readFilePrefix(absPath, 64 * 1024);
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

function imageDimsFor(
  type: ArtifactType,
  absPath: string,
): { naturalWidth?: number; naturalHeight?: number } {
  if (type !== "png" && type !== "jpg" && type !== "webp") return {};
  try {
    const dims = readImageDims(type, readFilePrefix(absPath, IMAGE_HEADER_BYTES));
    if (dims) return { naturalWidth: dims.width, naturalHeight: dims.height };
  } catch {
    /* malformed header: no dimensions */
  }
  return {};
}

function readFilePrefix(absPath: string, maxBytes: number): Buffer {
  const size = fs.statSync(absPath).size;
  const len = Math.min(Math.max(0, size), maxBytes);
  if (len === 0) return Buffer.alloc(0);
  const fd = fs.openSync(absPath, "r");
  try {
    const buf = Buffer.allocUnsafe(len);
    const bytesRead = fs.readSync(fd, buf, 0, len, 0);
    return bytesRead === len ? buf : buf.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function fmtMb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}
