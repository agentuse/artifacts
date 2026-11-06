import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { addComment, commentsFor, commentsStamp, resolveComments } from "./comments.js";
import { CliError } from "./errors.js";
import {
  feedEntryRevisions,
  feedStamp,
  queryFeed,
  readFeedEntries,
  type FeedEntry,
} from "./feed.js";
import { deliverPendingComments } from "./notify.js";
import { previewCacheDir, rootDir, servePidPath } from "./paths.js";
import { buildSafeSrcdoc, META_CSP } from "./sanitize.js";
import { resolveBundleFile } from "./store.js";
import { allowShareRequest, isSharingConfigured, listSharedArtifacts, removeSharedArtifact, sharingState, shareArtifact, ShareError, syncSharedArtifacts } from "./share.js";

export const DEFAULT_PORT = 7878;
const HOST = "127.0.0.1";

export interface ServeStatus {
  pid: number;
  port: number;
  startedAt: string;
}

export function isServerRunning(): ServeStatus | null {
  if (!fs.existsSync(servePidPath())) return null;
  try {
    const rec: ServeStatus = JSON.parse(fs.readFileSync(servePidPath(), "utf8"));
    process.kill(rec.pid, 0);
    return rec;
  } catch {
    try {
      fs.unlinkSync(servePidPath());
    } catch {
      /* ignore */
    }
    return null;
  }
}

function viewerDistDir(): string {
  // When compiled, this file lives at <pkg>/dist/server.js, viewer at <pkg>/viewer-dist.
  // In dev (tsx), src/server.ts → ../viewer-dist.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "viewer-dist"),
    path.join(here, "..", "..", "viewer-dist"),
    path.join(here, "..", "viewer", "dist"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "index.html"))) return c;
  }
  return candidates[0]!;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".agentuse": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".flac": "audio/flac",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
  ...Object.fromEntries(
    [".txt", ".log", ".jsonl", ".yaml", ".yml", ".toml", ".xml", ".srt", ".diff", ".patch", ".sql",
      ".ts", ".tsx", ".mjs", ".cjs", ".py", ".sh", ".rb", ".go", ".rs", ".swift"]
      .map((ext) => [ext, "text/plain; charset=utf-8"]),
  ),
};

/** Served as inert bytes: nothing in them should ever run or load anything. */
const INERT_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg",
  ".mp4", ".m4v", ".mov", ".webm", ".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".flac",
]);

// CSP for the viewer SPA itself. HTML artifacts are loaded via
// <iframe src="/api/store/:id/..."> — that response carries its own CSP header
// (META_CSP) and the parent SPA's CSP does NOT inherit into a src=-loaded
// document, so this policy can stay tight without affecting artifact rendering.
const SPA_CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self' data:; " +
  "frame-src 'self' data:; " +
  "object-src 'none'; " +
  "base-uri 'none'; " +
  "connect-src 'self'";

// Images don't execute, but defense in depth: kill everything but the bytes.
const IMAGE_CSP = "default-src 'none'";

const PREVIEW_WIDTHS = [320, 480, 720, 960, 1280, 1600, 2048];
const PREVIEW_FORMAT = "webp";
const PREVIEW_MIME = "image/webp";
// Stored bundles are immutable: a re-submit writes a new rev with a new id.
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

function responseHeaders(
  headers: Record<string, string>,
  opts: { csp?: string | null },
): Record<string, string> {
  const merged: Record<string, string> = {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  };
  // csp: undefined -> default SPA_CSP, string -> custom, null -> omit entirely
  // (used for PDF responses so Firefox PDF.js isn't constrained by SPA_CSP).
  if (opts.csp === undefined) {
    if (!merged["content-security-policy"]) merged["content-security-policy"] = SPA_CSP;
  } else if (opts.csp !== null) merged["content-security-policy"] = opts.csp;
  return merged;
}

function send(
  res: http.ServerResponse,
  status: number,
  body: string | Buffer,
  headers: Record<string, string> = {},
  opts: { csp?: string | null } = {},
): void {
  res.writeHead(status, responseHeaders(headers, opts));
  res.end(body);
}

/** Parse a single `bytes=` range. null = whole file, "bad" = unsatisfiable. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "bad" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return null; // multi-range or junk: serve it all
  let start: number;
  let end: number;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return "bad";
  return { start, end };
}

/**
 * Stream a file instead of buffering it, with byte-range support: Safari will
 * not play a video without 206 responses, and a 1GB render should never sit
 * in memory.
 */
function sendFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  absPath: string,
  headers: Record<string, string>,
  opts: { csp?: string | null } = {},
): void {
  const size = fs.statSync(absPath).size;
  const range = parseRange(req.headers.range, size);
  const base = responseHeaders({ ...headers, "accept-ranges": "bytes" }, opts);
  if (range === "bad") {
    res.writeHead(416, { ...base, "content-range": `bytes */${size}` });
    res.end();
    return;
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const length = size === 0 ? 0 : end - start + 1;
  res.writeHead(range ? 206 : 200, {
    ...base,
    "content-length": String(length),
    ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
  });
  if (length === 0) {
    res.end();
    return;
  }
  const stream = fs.createReadStream(absPath, { start, end });
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

function sendJson(res: http.ServerResponse, body: unknown, headers: Record<string, string> = {}): void {
  send(res, 200, JSON.stringify(body), { "content-type": MIME[".json"]!, ...headers });
}

function sendNotModified(res: http.ServerResponse, etag: string, cacheControl: string): void {
  res.writeHead(304, {
    "cache-control": cacheControl,
    etag,
    "x-content-type-options": "nosniff",
  });
  res.end();
}

/** Which pane and session made an artifact is the server's business, not the viewer's. */
function publicEntry(entry: FeedEntry): Omit<FeedEntry, "origin"> {
  const { origin: _origin, ...rest } = entry;
  return rest;
}

const MAX_JSON_BODY_BYTES = 64 * 1024;

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_JSON_BODY_BYTES) throw new CliError("INVALID_INPUT", "Request is too large.");
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    /* reported below */
  }
  throw new CliError("INVALID_INPUT", "Request body must be a JSON object.");
}

function findEntry(id: string): FeedEntry | undefined {
  return readFeedEntries().find((e) => e.id === id);
}

function etagOf(...parts: string[]): string {
  return `"${createHash("sha256").update(parts.join("\0")).digest("base64url").slice(0, 24)}"`;
}

function previewWidth(raw: string | null): number {
  const requested = Number.parseInt(raw ?? "", 10);
  const target = Number.isFinite(requested) ? requested : 960;
  const clamped = Math.min(
    PREVIEW_WIDTHS[PREVIEW_WIDTHS.length - 1]!,
    Math.max(PREVIEW_WIDTHS[0]!, target),
  );
  return PREVIEW_WIDTHS.find((w) => w >= clamped) ?? PREVIEW_WIDTHS[PREVIEW_WIDTHS.length - 1]!;
}

async function readOrCreatePreview(entry: FeedEntry, absPath: string, width: number): Promise<Buffer> {
  const key = createHash("sha256")
    .update(`${entry.id}\0${entry.contentHash}\0${width}`)
    .digest("hex");
  const outPath = path.join(previewCacheDir(), `${key}.${PREVIEW_FORMAT}`);
  if (fs.existsSync(outPath)) return fs.readFileSync(outPath);

  const buf = await sharp(absPath, { failOn: "none" })
    .rotate()
    .resize({ width, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 78, effort: 4 })
    .toBuffer();

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  try {
    fs.renameSync(tmp, outPath);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
  return buf;
}

function isImageType(type: FeedEntry["type"]): boolean {
  return type === "png" || type === "jpg" || type === "webp";
}

/**
 * Serve one file out of a stored bundle. HTML is sanitized on every read (so
 * sanitizer fixes apply to already-stored artifacts); support files pass
 * through with a type-appropriate CSP.
 */
function sendBundleFile(req: http.IncomingMessage, res: http.ServerResponse, absPath: string): void {
  if (!fs.existsSync(absPath) || fs.statSync(absPath).isDirectory()) {
    send(res, 404, "not found");
    return;
  }
  const ext = path.extname(absPath).toLowerCase();
  if (ext === ".html" || ext === ".htm") {
    const safe = buildSafeSrcdoc(fs.readFileSync(absPath, "utf8"));
    send(res, 200, safe, {
      "content-type": MIME[".html"]!,
      "content-security-policy": META_CSP,
      "x-frame-options": "SAMEORIGIN",
      "cache-control": IMMUTABLE_CACHE,
    });
    return;
  }
  const csp = ext === ".pdf" ? null : INERT_EXTENSIONS.has(ext) ? IMAGE_CSP : undefined;
  sendFile(
    req,
    res,
    absPath,
    {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "content-disposition": "inline",
      "cache-control": IMMUTABLE_CACHE,
    },
    { csp },
  );
}

function serveStatic(res: http.ServerResponse, dir: string, file: string): void {
  const ext = path.extname(file).toLowerCase();
  const abs = path.join(dir, file);
  // Defense-in-depth: confine to dir.
  if (!path.resolve(abs).startsWith(path.resolve(dir) + path.sep) &&
      path.resolve(abs) !== path.resolve(dir)) {
    send(res, 403, "forbidden");
    return;
  }
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    // Fall back to index.html for SPA routes.
    const idx = path.join(dir, "index.html");
    if (fs.existsSync(idx)) {
      send(res, 200, fs.readFileSync(idx), { "content-type": MIME[".html"]! });
      return;
    }
    send(res, 404, "not found");
    return;
  }
  send(res, 200, fs.readFileSync(abs), {
    "content-type": MIME[ext] ?? "application/octet-stream",
  });
}

export async function handle(req: http.IncomingMessage, res: http.ServerResponse, opts: { dist: string }): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const pathname = url.pathname;

  if (pathname === "/api/sharing" && req.method === "GET") {
    sendJson(res, { enabled: isSharingConfigured() }, { "cache-control": "no-store" });
    return;
  }
  const managedShare = /^\/api\/shares\/(shr_[a-f0-9]{32})$/.exec(pathname);
  if ((pathname === "/api/shares" && req.method === "GET") || (managedShare && req.method === "DELETE")) {
    if (!allowShareRequest(req)) { send(res, 403, "Share management requires the local viewer."); return; }
    try {
      if (managedShare) {
        await removeSharedArtifact(managedShare[1]!);
        res.writeHead(204, { "cache-control": "no-store" }); res.end();
      } else sendJson(res, await listSharedArtifacts(url.searchParams.get("cursor") ?? undefined), { "cache-control": "no-store" });
    } catch (error) {
      send(res, error instanceof ShareError ? error.status : 500,
        error instanceof ShareError ? error.message : "Could not manage shared artifacts. Please retry.");
    }
    return;
  }

  const shareMatch = /^\/api\/entry\/([A-Za-z0-9_]+)\/share$/.exec(pathname);
  if (shareMatch && req.method === "POST") {
    if (!allowShareRequest(req)) {
      send(res, 403, "Sharing requires a request from the local artifact viewer.");
      return;
    }
    const entry = findEntry(shareMatch[1]!);
    if (!entry) { send(res, 404, "Artifact not found."); return; }
    try { sendJson(res, await shareArtifact(entry), { "cache-control": "no-store" }); }
    catch (error) {
      send(res, error instanceof ShareError ? error.status : 500,
        error instanceof ShareError ? error.message : "Sharing failed. Please retry.");
    }
    return;
  }

  // Comments wake an agent, so they sit behind the same same-origin gate as
  // publishing: a cross-site page or a rebound host must never reach them.
  const commentPost = /^\/api\/entry\/([A-Za-z0-9_]+)\/comments$/.exec(pathname);
  const commentResolve = /^\/api\/comments\/(cmt_[a-f0-9]+)\/resolve$/.exec(pathname);
  if ((commentPost || commentResolve) && req.method === "POST") {
    if (!allowShareRequest(req)) {
      send(res, 403, "Comments require a request from the local artifact viewer.");
      return;
    }
    try {
      if (commentResolve) {
        const [comment] = resolveComments([commentResolve[1]!]);
        sendJson(res, comment, { "cache-control": "no-store" });
        return;
      }
      const entry = findEntry(commentPost![1]!);
      if (!entry) { send(res, 404, "Artifact not found."); return; }
      const { body, quote } = await readJsonBody(req);
      sendJson(res, addComment(entry, typeof body === "string" ? body : "", quote), { "cache-control": "no-store" });
      kickCommentDelivery();
    } catch (e) {
      send(res, e instanceof CliError && e.code === "INVALID_INPUT" ? 400 : 500, (e as Error).message);
    }
    return;
  }

  // /api/feed -> newest-first page plus project/tag facets for the chips.
  if (pathname === "/api/feed" && req.method === "GET") {
    try {
      const page = queryFeed({
        projectId: url.searchParams.get("project") ?? undefined,
        tag: url.searchParams.get("tag") ?? undefined,
        q: url.searchParams.get("q") ?? undefined,
        limit: numberParam(url.searchParams.get("limit")),
        cursor: numberParam(url.searchParams.get("cursor")),
      });
      const sharingEnabled = isSharingConfigured();
      const entries = page.entries.map((entry) => ({
        ...entry,
        cloudShared: sharingEnabled && sharingState(entry).state !== "share",
      }));
      // A cloud share can be created or revoked without changing the append-only
      // feed. Include the card-level share state so polling does not incorrectly
      // return 304 after that status changes.
      const etag = etagOf(
        feedStamp(),
        url.search,
        entries.map((entry) => `${entry.id}:${entry.cloudShared}`).join(","),
      );
      if (req.headers["if-none-match"] === etag) {
        sendNotModified(res, etag, "no-store");
        return;
      }
      sendJson(res, { ...page, entries: entries.map(publicEntry) }, { etag });
    } catch (e) {
      send(res, 500, (e as Error).message);
    }
    return;
  }

  // /api/entry/{id} -> one entry plus its revision history.
  // /api/latest/{projectId}/{slug} -> the same for whichever revision is newest.
  const entryMatch = /^\/api\/entry\/([A-Za-z0-9_]+)$/.exec(pathname);
  const latestMatch = /^\/api\/latest\/([^/]+)\/([^/]+)$/.exec(pathname);
  if ((entryMatch || latestMatch) && req.method === "GET") {
    try {
      // Same conditional-request scheme as /api/feed: the detail view polls
      // this route to notice new revisions, and a 304 keeps that poll cheap.
      const sharingEnabled = isSharingConfigured();
      const entries = readFeedEntries();
      let entry: FeedEntry | undefined;
      if (entryMatch) entry = entries.find((e) => e.id === entryMatch[1]!);
      else {
        let projectId: string, slug: string;
        try {
          projectId = decodeURIComponent(latestMatch![1]!);
          slug = decodeURIComponent(latestMatch![2]!);
        } catch { send(res, 400, "Malformed artifact link."); return; }
        entry = feedEntryRevisions(entries, projectId, slug)[0];
      }
      if (!entry) {
        send(res, 404, "not found");
        return;
      }
      const sharing = sharingState(entry);
      const etag = etagOf(feedStamp(), commentsStamp(), entry.id, String(sharingEnabled), JSON.stringify(sharing));
      if (req.headers["if-none-match"] === etag) {
        sendNotModified(res, etag, "no-store");
        return;
      }
      sendJson(res, {
        entry: publicEntry(entry),
        revisions: feedEntryRevisions(entries, entry.projectId, entry.slug).map(publicEntry),
        comments: commentsFor(entry.projectId, entry.slug),
        sharingEnabled,
        sharing,
      }, { etag });
    } catch (e) {
      send(res, 500, (e as Error).message);
    }
    return;
  }

  // /api/store/{entryId}/{path...} -> a file inside the stored bundle. An
  // empty path serves the entry file, so relative URLs inside HTML resolve
  // against a real directory.
  const storeMatch = /^\/api\/store\/([A-Za-z0-9_]+)(?:\/(.*))?$/.exec(pathname);
  if (storeMatch && req.method === "GET") {
    try {
      const entry = findEntry(storeMatch[1]!);
      if (!entry) {
        send(res, 404, "not found");
        return;
      }
      sendBundleFile(req, res, resolveBundleFile(entry, storeMatch[2] ?? ""));
    } catch (e) {
      const code = e instanceof CliError && e.code === "INVALID_INPUT" ? 400 : 500;
      send(res, code, (e as Error).message);
    }
    return;
  }

  // /api/preview/{entryId}?w=960 -> cached WebP thumbnail for image entries.
  // Feed cards use this; the detail view requests the original bytes.
  const previewMatch = /^\/api\/preview\/([A-Za-z0-9_]+)$/.exec(pathname);
  if (previewMatch && req.method === "GET") {
    try {
      const entry = findEntry(previewMatch[1]!);
      if (!entry) {
        send(res, 404, "not found");
        return;
      }
      if (!isImageType(entry.type)) {
        send(res, 400, "not an image artifact");
        return;
      }
      const width = previewWidth(url.searchParams.get("w"));
      const etag = `"${entry.contentHash}:${width}:${PREVIEW_FORMAT}"`;
      if (req.headers["if-none-match"] === etag) {
        sendNotModified(res, etag, IMMUTABLE_CACHE);
        return;
      }
      const absPath = resolveBundleFile(entry, entry.entry);
      const buf = await readOrCreatePreview(entry, absPath, width);
      send(
        res,
        200,
        buf,
        {
          "content-type": PREVIEW_MIME,
          "content-disposition": "inline",
          "cache-control": IMMUTABLE_CACHE,
          etag,
        },
        { csp: IMAGE_CSP },
      );
    } catch (e) {
      send(res, 500, (e as Error).message);
    }
    return;
  }

  // /api/raw/{entryId} -> the entry file exactly as submitted, as an
  // attachment. Safe to expose unsanitized because octet-stream + attachment
  // makes the browser save it instead of executing it at this origin.
  const rawMatch = /^\/api\/raw\/([A-Za-z0-9_]+)$/.exec(pathname);
  if (rawMatch && req.method === "GET") {
    try {
      const entry = findEntry(rawMatch[1]!);
      if (!entry) {
        send(res, 404, "not found");
        return;
      }
      const absPath = resolveBundleFile(entry, entry.entry);
      if (!fs.existsSync(absPath)) {
        send(res, 404, "not found");
        return;
      }
      const basename = (entry.entry.split("/").pop() || entry.entry).replace(/[\r\n"\\]/g, "_");
      sendFile(
        req,
        res,
        absPath,
        {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${basename}"`,
        },
        { csp: null },
      );
    } catch (e) {
      send(res, 500, (e as Error).message);
    }
    return;
  }

  // API mistakes must not look like successful HTML responses to the viewer.
  if (pathname.startsWith("/api/")) {
    send(res, 404, "API endpoint not found.");
    return;
  }

  // Static viewer. Everything that isn't a real asset falls back to the SPA.
  const file = pathname.replace(/^\/+/, "");
  serveStatic(res, opts.dist, file || "index.html");
}

function numberParam(raw: string | null): number | undefined {
  if (raw == null) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

export interface StartOptions {
  preferredPort: number;
  detach: boolean;
}

export async function startServer(opts: StartOptions): Promise<ServeStatus> {
  if (opts.detach) {
    return spawnDetached(opts.preferredPort);
  }
  const dist = viewerDistDir();
  if (!fs.existsSync(path.join(dist, "index.html"))) {
    throw new CliError(
      "IO_ERROR",
      `viewer dist not found at ${dist}; run 'npm run build:viewer'`,
    );
  }
  const server = http.createServer((req, res) => {
    handle(req, res, { dist }).catch((e) => {
      if (res.headersSent) {
        res.destroy(e);
        return;
      }
      send(res, 500, (e as Error).message);
    });
  });
  const port = await listenWithFallback(server, opts.preferredPort);
  startShareSync();
  startCommentDelivery();
  const rec: ServeStatus = {
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
  };
  fs.mkdirSync(rootDir(), { recursive: true });
  fs.writeFileSync(servePidPath(), JSON.stringify(rec, null, 2));
  const cleanup = () => {
    try {
      const cur = JSON.parse(fs.readFileSync(servePidPath(), "utf8")) as ServeStatus;
      if (cur.pid === process.pid) fs.unlinkSync(servePidPath());
    } catch {
      /* ignore */
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
  return rec;
}

const SHARE_SYNC_INTERVAL_MS = 5_000;
const SHARE_RETRY_MS = 60_000;

/**
 * Pushes new revisions of shared artifacts to their cloud links. The server
 * runs this, not `submit`, because only the server holds the cloud key. Runs
 * on every feed change; a failed push stays in "update" and retries each minute.
 */
function startShareSync(): void {
  let lastStamp: string | undefined;
  let retryAt = Infinity;
  let running = false;
  const tick = async () => {
    const stamp = feedStamp();
    if (running || (stamp === lastStamp && Date.now() < retryAt)) return;
    running = true;
    lastStamp = stamp;
    try {
      const { updated, failed } = await syncSharedArtifacts();
      if (updated) console.log(`Updated ${updated} shared artifact${updated === 1 ? "" : "s"} in the cloud.`);
      for (const { entry, error } of failed) {
        console.error(`Could not update the cloud copy of ${entry.slug}: ${(error as Error).message}`);
      }
      retryAt = failed.length ? Date.now() + SHARE_RETRY_MS : Infinity;
    } finally { running = false; }
  };
  void tick();
  setInterval(() => void tick(), SHARE_SYNC_INTERVAL_MS).unref();
}

const COMMENT_DELIVERY_INTERVAL_MS = 30_000;
let deliveryRunning = false;
let deliveryAgain = false;

/**
 * Tell agents about comments waiting on their artifacts. Runs right after a new
 * comment and on a timer, because an agent at an approval prompt can't take the
 * message yet and a later revision can bring a new agent to notify.
 */
function kickCommentDelivery(): void {
  if (deliveryRunning) {
    deliveryAgain = true;
    return;
  }
  deliveryRunning = true;
  deliverPendingComments()
    .catch((e: unknown) => console.error(`Could not notify agents about comments: ${(e as Error).message}`))
    .finally(() => {
      deliveryRunning = false;
      if (deliveryAgain) {
        deliveryAgain = false;
        kickCommentDelivery();
      }
    });
}

function startCommentDelivery(): void {
  kickCommentDelivery();
  setInterval(kickCommentDelivery, COMMENT_DELIVERY_INTERVAL_MS).unref();
}

async function listenWithFallback(
  server: http.Server,
  preferred: number,
): Promise<number> {
  let port = preferred;
  while (port < preferred + 50) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, HOST);
      });
      return port;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
        port += 1;
        continue;
      }
      throw e;
    }
  }
  throw new CliError("IO_ERROR", `no available port in range ${preferred}..${preferred + 50}`);
}

function spawnDetached(preferredPort: number): Promise<ServeStatus> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Resolve the bin entry — works for both compiled and tsx-dev.
  const compiledBin = path.join(here, "bin.js");
  const args = ["serve", "--port", String(preferredPort)];
  const child = spawn(process.execPath, [compiledBin, ...args], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, AGENTUSE_ARTIFACTS_FOREGROUND: "1" },
  });
  child.unref();
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const status = isServerRunning();
      if (status) return resolve(status);
      if (Date.now() - start > 5000) {
        return reject(new CliError("IO_ERROR", "detached server failed to start"));
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

export async function stopServer(): Promise<{ stopped: boolean; pid?: number }> {
  const rec = isServerRunning();
  if (!rec) return { stopped: false };
  try {
    process.kill(rec.pid, "SIGTERM");
  } catch {
    /* ignore */
  }
  // Wait briefly for cleanup.
  for (let i = 0; i < 30; i++) {
    if (!fs.existsSync(servePidPath())) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    fs.unlinkSync(servePidPath());
  } catch {
    /* ignore */
  }
  return { stopped: true, pid: rec.pid };
}
