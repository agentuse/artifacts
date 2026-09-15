import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { FeedEntry } from "./feed.js";
import { rootDir } from "./paths.js";
import { bundleDir, MAX_BUNDLE_BYTES, MAX_BUNDLE_FILES } from "./store.js";

export interface SharedArtifact { id: string; url: string }
export class ShareError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const pending = new Map<string, Promise<SharedArtifact>>();
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** A cross-origin form must never be able to publish a private local artifact. */
export function allowShareRequest(req: Pick<IncomingMessage, "headers">): boolean {
  if (req.headers["x-artifacts-share"] !== "1" ||
      !/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? "") ||
      !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.headers.host ?? "")) return false;
  const origin = req.headers.origin;
  if (!origin) return true; // Non-browser clients still need the explicit header.
  try {
    const url = new URL(origin);
    return ["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch { return false; }
}

function config() {
  const raw = process.env.ARTIFACTS_CLOUD_URL?.trim();
  const key = process.env.ARTIFACTS_CLOUD_API_KEY?.trim();
  if (!raw || !key) throw new ShareError(503, "Sharing is not configured. Set ARTIFACTS_CLOUD_URL and ARTIFACTS_CLOUD_API_KEY on the local server.");
  let url: URL;
  try { url = new URL(raw); } catch { throw new ShareError(503, "ARTIFACTS_CLOUD_URL must be a valid server origin."); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) {
    throw new ShareError(503, "ARTIFACTS_CLOUD_URL must be HTTPS, or a local development server.");
  }
  return { origin: url.origin, key };
}

/** Reports configuration availability without exposing any credentials. */
export function isSharingConfigured(): boolean {
  try { config(); return true; } catch { return false; }
}

export async function shareArtifact(entry: FeedEntry): Promise<SharedArtifact> {
  const { origin, key } = config();
  const scope = digest(JSON.stringify([rootDir(), entry.id, entry.contentHash, origin, digest(key)]));
  const existing = pending.get(scope);
  if (existing) return existing;
  const request = upload(entry, origin, key, scope).finally(() => pending.delete(scope));
  pending.set(scope, request);
  return request;
}

async function cloudFetch(url: string, key: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${key}` },
      redirect: "error", signal: AbortSignal.timeout(120_000) });
  } catch { throw new ShareError(502, "Could not reach the sharing service. Please retry."); }
}

function failure(status: number): ShareError {
  const messages: Record<number, string> = {
    401: "The sharing API key was rejected. Check the local server configuration.",
    409: "This artifact is already being shared. Please retry shortly.",
    413: "The artifact is too large to share. Bundles allow 25 MiB; HTML and Markdown files allow 2 MiB each.",
    429: "Too many sharing requests. Please retry shortly.",
  };
  return new ShareError(502, messages[status] ?? "The sharing service could not accept this artifact. Please retry.");
}

async function upload(entry: FeedEntry, origin: string, key: string, scope: string): Promise<SharedArtifact> {
  const cacheDir = path.join(rootDir(), "share-cache");
  const cachePath = path.join(cacheDir, `${scope}.json`);
  let cached: SharedArtifact | undefined;
  try { cached = JSON.parse(fs.readFileSync(cachePath, "utf8")); } catch { /* No cached share. */ }
  if (cached && /^shr_[a-f0-9]{32}$/.test(cached.id) && validShareUrl(cached.url)) {
    const status = await cloudFetch(`${origin}/v1/shares/${cached.id}`, key);
    if (status.ok) {
      const value = await status.json() as { status: string };
      if (value.status === "active") return cached;
    } else if (status.status !== 404) throw failure(status.status);
  }

  const root = bundleDir(entry);
  const files: Array<{ path: string; bytes: Buffer }> = [];
  let size = 0;
  function walk(dir: string, prefix = "") {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isSymbolicLink()) throw new ShareError(400, "The stored bundle contains a symbolic link.");
      const abs = path.join(dir, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { walk(abs, rel); continue; }
      if (!ent.isFile()) throw new ShareError(400, "The stored bundle contains an unsupported filesystem entry.");
      // Check before reading so externally modified stores cannot exhaust memory.
      size += fs.statSync(abs).size;
      if (size > MAX_BUNDLE_BYTES || files.length >= MAX_BUNDLE_FILES) throw new ShareError(413, "The artifact exceeds the 25 MiB or 200-file sharing limit.");
      files.push({ path: rel, bytes: fs.readFileSync(abs) });
    }
  }
  try { walk(root); } catch (error) {
    if (error instanceof ShareError) throw error;
    throw new ShareError(404, "The stored artifact is no longer available.");
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = { version: 1, title: entry.title, entry: entry.entry,
    files: files.map((f, i) => ({ part: `file${i}`, path: f.path, size: f.bytes.length, sha256: digest(f.bytes) })) };
  const manifestJson = JSON.stringify(manifest);
  const body = new FormData();
  body.append("manifest", manifestJson);
  files.forEach((f, i) => body.append(`file${i}`, new Blob([new Uint8Array(f.bytes)]), f.path));
  const response = await cloudFetch(`${origin}/v1/shares`, key, { method: "POST", body,
    headers: { "idempotency-key": digest(JSON.stringify([entry.id, manifestJson])) } });
  if (!response.ok) throw failure(response.status);
  let result: SharedArtifact;
  try { result = await response.json() as SharedArtifact; }
  catch { throw new ShareError(502, "The sharing service returned an invalid response."); }
  if (!/^shr_[a-f0-9]{32}$/.test(result.id) || !validShareUrl(result.url)) throw new ShareError(502, "The sharing service returned an invalid link.");
  const shared = { id: result.id, url: result.url };
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const temp = `${cachePath}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(shared), { mode: 0o600 });
  fs.renameSync(temp, cachePath);
  return shared;
}

function validShareUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash && /^\/s\/[A-Za-z0-9_-]{43}$/.test(url.pathname) &&
      (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)));
  } catch { return false; }
}
