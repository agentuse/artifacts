import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { CliError } from "./errors.js";
import { SCHEMA_VERSION } from "./manifest.js";
import { rootDir, servePidPath } from "./paths.js";
import { buildSafeSrcdoc, META_CSP } from "./sanitize.js";
import {
  buildLocalProjectSnapshot,
  buildLocalManifestSnapshot,
  forgetProject,
  initProject,
  listRegisteredProjects,
  pruneMissingProjects,
  type LocalArtifact,
  resolveLocalProjectFile,
  resolveProjectFile,
} from "./localArtifacts.js";
import {
  DEFAULT_IGNORE_PATTERNS,
  readSettings,
  writeSettings,
} from "./settings.js";

export const DEFAULT_PORT = 7878;
const HOST = "127.0.0.1";
const MANIFEST_CACHE_MS = 10_000;

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
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".agentuse": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

// CSP for the viewer SPA itself. HTML artifacts are loaded via
// <iframe src="/api/render/:id"> — that response carries its own CSP header
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

function send(
  res: http.ServerResponse,
  status: number,
  body: string | Buffer,
  headers: Record<string, string> = {},
  opts: { csp?: string | null } = {},
): void {
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
  res.writeHead(status, merged);
  res.end(body);
}

// Lockdown CSP for image responses. Images don't execute, but defense in depth:
// kill everything but the image itself.
const IMAGE_CSP = "default-src 'none'";

const BINARY_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  pdf: "application/pdf",
};

const PREVIEW_WIDTHS = [320, 480, 720, 960, 1280, 1600, 2048];
const PREVIEW_FORMAT = "webp";
const PREVIEW_MIME = "image/webp";

interface ManifestCache {
  builtAt: number;
  json: string;
  etag: string;
  localArtifacts: Map<string, LocalArtifact>;
}

interface ProjectCache {
  builtAt: number;
  json: string;
  etag: string;
  localArtifacts: Map<string, LocalArtifact>;
}

let manifestCache: ManifestCache | null = null;
let manifestRefreshQueued = false;
const projectCaches = new Map<string, ProjectCache>();
const projectRefreshQueued = new Set<string>();

function invalidateManifestCache(): void {
  manifestCache = null;
  manifestRefreshQueued = false;
  projectCaches.clear();
  projectRefreshQueued.clear();
}

function rebuildManifestCache(): ManifestCache {
  const snapshot = buildLocalManifestSnapshot();
  const json = JSON.stringify(snapshot.manifest);
  manifestCache = {
    builtAt: Date.now(),
    json,
    etag: `"${createHash("sha256").update(json).digest("base64url").slice(0, 24)}"`,
    localArtifacts: snapshot.localArtifacts,
  };
  return manifestCache;
}

function queueManifestRefresh(): void {
  if (manifestRefreshQueued) return;
  manifestRefreshQueued = true;
  setTimeout(() => {
    try {
      rebuildManifestCache();
    } catch (e) {
      console.warn(`manifest refresh failed: ${(e as Error).message}`);
    } finally {
      manifestRefreshQueued = false;
    }
  }, 0);
}

function getManifestCache(): ManifestCache {
  if (!manifestCache) return rebuildManifestCache();
  if (Date.now() - manifestCache.builtAt >= MANIFEST_CACHE_MS) {
    queueManifestRefresh();
  }
  return manifestCache;
}

function getCachedLocalArtifactById(id: string): LocalArtifact | undefined {
  for (const cache of projectCaches.values()) {
    const artifact = cache.localArtifacts.get(id);
    if (artifact) return artifact;
  }
  return getManifestCache().localArtifacts.get(id);
}

function buildProjectCache(projectId: string): ProjectCache {
  const snapshot = buildLocalProjectSnapshot(projectId);
  const json = JSON.stringify({
    projectId,
    artifacts: snapshot.artifacts,
    latest: snapshot.latest,
  });
  const cache = {
    builtAt: Date.now(),
    json,
    etag: `"${createHash("sha256").update(json).digest("base64url").slice(0, 24)}"`,
    localArtifacts: snapshot.localArtifacts,
  };
  projectCaches.set(projectId, cache);
  return cache;
}

function queueProjectRefresh(projectId: string): void {
  if (projectRefreshQueued.has(projectId)) return;
  projectRefreshQueued.add(projectId);
  setTimeout(() => {
    try {
      buildProjectCache(projectId);
    } catch (e) {
      console.warn(`project manifest refresh failed: ${(e as Error).message}`);
    } finally {
      projectRefreshQueued.delete(projectId);
    }
  }, 0);
}

function getProjectCache(projectId: string): ProjectCache {
  const cache = projectCaches.get(projectId);
  if (!cache) return buildProjectCache(projectId);
  if (Date.now() - cache.builtAt >= MANIFEST_CACHE_MS) {
    queueProjectRefresh(projectId);
  }
  return cache;
}

const PROJECT_FILE_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".md",
  ".markdown",
  ".agentuse",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".pdf",
  ".css",
  ".svg",
  ".ico",
  ".woff2",
  ".woff",
  ".ttf",
  ".otf",
]);

function projectFileCsp(ext: string): string | null | undefined {
  if (ext === ".pdf") return null;
  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp" || ext === ".svg") {
    return IMAGE_CSP;
  }
  return undefined;
}

function sendJson(res: http.ServerResponse, body: unknown, status = 200): void {
  send(res, status, JSON.stringify(body), { "content-type": MIME[".json"]! });
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 128 * 1024) throw new CliError("INVALID_INPUT", "request body too large");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new CliError("INVALID_INPUT", "request body must be JSON");
  }
}

function bodyObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CliError("INVALID_INPUT", "request body must be an object");
  }
  return body as Record<string, unknown>;
}

function isImageArtifact(local: LocalArtifact): boolean {
  return (
    local.record.type === "png" ||
    local.record.type === "jpg" ||
    local.record.type === "webp"
  );
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

function previewCachePath(local: LocalArtifact, width: number): string {
  const key = createHash("sha256")
    .update(local.artifactId)
    .update("\0")
    .update(local.record.contentHash)
    .update("\0")
    .update(String(width))
    .digest("hex");
  return path.join(rootDir(), "preview-cache", `${key}.${PREVIEW_FORMAT}`);
}

async function readOrCreatePreview(local: LocalArtifact, width: number): Promise<Buffer> {
  const outPath = previewCachePath(local, width);
  if (fs.existsSync(outPath)) return fs.readFileSync(outPath);

  const buf = await sharp(local.absPath, { failOn: "none" })
    .rotate()
    .resize({
      width,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({
      quality: 78,
      effort: 4,
    })
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
  return fs.existsSync(outPath) ? fs.readFileSync(outPath) : buf;
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

async function handle(req: http.IncomingMessage, res: http.ServerResponse, opts: { dist: string }): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const pathname = url.pathname;

  if (pathname === "/api/manifest") {
    try {
      const cache = getManifestCache();
      if (req.headers["if-none-match"] === cache.etag) {
        res.writeHead(304, {
          "cache-control": "no-store",
          "etag": cache.etag,
          "x-content-type-options": "nosniff",
        });
        res.end();
        return;
      }
      send(res, 200, cache.json, {
        "content-type": MIME[".json"]!,
        "etag": cache.etag,
      });
    } catch (e) {
      send(res, 500, (e as Error).message);
    }
    return;
  }

  if (pathname === "/api/projects" && req.method === "GET") {
    try {
      sendJson(res, {
        schemaVersion: SCHEMA_VERSION,
        projects: Object.fromEntries(listRegisteredProjects()),
      });
    } catch (e) {
      send(res, 500, (e as Error).message);
    }
    return;
  }

  const projectManifestMatch = /^\/api\/projects\/([^/]+)\/manifest$/.exec(pathname);
  if (projectManifestMatch && req.method === "GET") {
    try {
      const projectId = decodeURIComponent(projectManifestMatch[1]!);
      const cache = getProjectCache(projectId);
      if (req.headers["if-none-match"] === cache.etag) {
        res.writeHead(304, {
          "cache-control": "no-store",
          "etag": cache.etag,
          "x-content-type-options": "nosniff",
        });
        res.end();
        return;
      }
      send(res, 200, cache.json, {
        "content-type": MIME[".json"]!,
        "etag": cache.etag,
      });
    } catch (e) {
      const code = e instanceof CliError && e.code === "INVALID_INPUT" ? 404 : 500;
      send(res, code, (e as Error).message);
    }
    return;
  }

  if (pathname === "/api/settings") {
    try {
      if (req.method === "GET") {
        sendJson(res, {
          defaultIgnorePatterns: DEFAULT_IGNORE_PATTERNS,
          settings: readSettings(),
        });
        return;
      }
      if (req.method === "PUT") {
        const body = bodyObject(await readJsonBody(req));
        const ignorePatterns = body.ignorePatterns;
        if (!Array.isArray(ignorePatterns)) {
          throw new CliError("INVALID_INPUT", "ignorePatterns must be an array");
        }
        const projectWideDiscoveryEnabled =
          typeof body.projectWideDiscoveryEnabled === "boolean"
            ? body.projectWideDiscoveryEnabled
            : readSettings().projectWideDiscoveryEnabled;
        const settings = writeSettings({ ignorePatterns, projectWideDiscoveryEnabled });
        invalidateManifestCache();
        sendJson(res, { defaultIgnorePatterns: DEFAULT_IGNORE_PATTERNS, settings });
        return;
      }
      send(res, 405, "method not allowed");
    } catch (e) {
      const code = e instanceof CliError && e.code === "INVALID_INPUT" ? 400 : 500;
      send(res, code, (e as Error).message);
    }
    return;
  }

  if (pathname === "/api/projects" && req.method === "POST") {
    try {
      const body = bodyObject(await readJsonBody(req));
      if (typeof body.path !== "string" || !body.path.trim()) {
        throw new CliError("INVALID_INPUT", "path is required");
      }
      const out = await initProject(body.path);
      invalidateManifestCache();
      sendJson(res, out);
    } catch (e) {
      const code = e instanceof CliError && e.code === "INVALID_INPUT" ? 400 : 500;
      send(res, code, (e as Error).message);
    }
    return;
  }

  if (pathname === "/api/projects/prune" && req.method === "POST") {
    try {
      const removed = await pruneMissingProjects();
      invalidateManifestCache();
      sendJson(res, { removed });
    } catch (e) {
      send(res, 500, (e as Error).message);
    }
    return;
  }

  const deleteProjectMatch = /^\/api\/projects\/([^/]+)$/.exec(pathname);
  if (deleteProjectMatch && req.method === "DELETE") {
    try {
      const out = await forgetProject(decodeURIComponent(deleteProjectMatch[1]!));
      invalidateManifestCache();
      sendJson(res, out);
    } catch (e) {
      const code = e instanceof CliError && e.code === "INVALID_INPUT" ? 400 : 500;
      send(res, code, (e as Error).message);
    }
    return;
  }

  // /api/preview/{artifactId}?w=960 -> cached WebP thumbnail for image
  // artifacts. Canvas tiles use this path; fullscreen/download still request
  // the original bytes. The contentHash query param from the viewer makes
  // these effectively immutable until the source file changes.
  const previewMatch = /^\/api\/preview\/([A-Za-z0-9_]+)$/.exec(pathname);
  if (previewMatch) {
    const id = previewMatch[1]!;
    try {
      const local = getCachedLocalArtifactById(id);
      if (!local) {
        send(res, 404, "not found");
        return;
      }
      if (!isImageArtifact(local)) {
        send(res, 400, "not an image artifact");
        return;
      }
      const width = previewWidth(url.searchParams.get("w"));
      const buf = await readOrCreatePreview(local, width);
      const etag = `"${local.record.contentHash}:${width}:${PREVIEW_FORMAT}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, {
          "cache-control": "public, max-age=31536000, immutable",
          "etag": etag,
        });
        res.end();
        return;
      }
      send(
        res,
        200,
        buf,
        {
          "content-type": PREVIEW_MIME,
          "content-disposition": "inline",
          "cache-control": "public, max-age=31536000, immutable",
          "etag": etag,
        },
        { csp: IMAGE_CSP },
      );
    } catch (e) {
      send(res, 500, (e as Error).message);
    }
    return;
  }

  // /api/artifact/{artifactId}  -> raw bytes for everything except HTML
  // (HTML routes through /api/render/:id for sanitization).
  const artMatch = /^\/api\/artifact\/([A-Za-z0-9_]+)$/.exec(pathname);
  if (artMatch) {
    const id = artMatch[1]!;
    try {
      const local = getCachedLocalArtifactById(id);
      if (!local) {
        send(res, 404, "not found");
        return;
      }
      const rec = local.record;
      if (rec.type === "html") {
        send(res, 400, "use /api/render/:id for HTML artifacts");
        return;
      }
      const buf = fs.readFileSync(local.absPath);
      if (rec.type === "markdown" || rec.type === "agentuse") {
        send(res, 200, buf, { "content-type": "text/markdown; charset=utf-8" });
        return;
      }
      const mime = BINARY_MIME[rec.type];
      if (!mime) {
        send(res, 500, `unhandled type: ${rec.type}`);
        return;
      }
      // PDF: omit CSP so the browser's PDF viewer (Firefox PDF.js especially)
      // can run unconstrained. Origin isolation comes from the iframe sandbox
      // in the viewer, not from CSP. Image: lock down with default-src 'none'.
      send(
        res,
        200,
        buf,
        {
          "content-type": mime,
          "content-disposition": "inline",
        },
        { csp: rec.type === "pdf" ? null : IMAGE_CSP },
      );
    } catch (e) {
      send(res, 500, (e as Error).message);
    }
    return;
  }

  // /api/raw/{artifactId}  -> original file bytes, octet-stream + attachment.
  // Used by the viewer's Download and Copy actions so they hand back the
  // exact file the agent wrote (notably: unsanitized HTML, no CSP meta tag).
  // Safe to expose because the response is `application/octet-stream` with
  // `Content-Disposition: attachment` — the browser saves it instead of
  // rendering, so no script execution happens at this origin. In-viewer
  // rendering still routes through /api/render/:id, which keeps the
  // sanitizer.
  const rawMatch = /^\/api\/raw\/([A-Za-z0-9_]+)$/.exec(pathname);
  if (rawMatch) {
    const id = rawMatch[1]!;
    try {
      const local = getCachedLocalArtifactById(id);
      if (!local) {
        send(res, 404, "not found");
        return;
      }
      const rec = local.record;
      const buf = fs.readFileSync(local.absPath);
      const basename = (rec.name.split("/").pop() || rec.name).replace(
        /[\r\n"\\]/g,
        "_",
      );
      send(
        res,
        200,
        buf,
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

  // /api/project-artifacts/{projectId}/{path...} -> project-local live
  // artifact files rooted at <project>/.agentuse/artifacts/. HTML is
  // sanitized; other files are served as static bytes. Relative URLs inside
  // HTML work naturally because the iframe URL is the real file path.
  const localPrefixMatch = /^\/api\/project-artifacts\/([A-Za-z0-9_]+)\/(.*)$/.exec(pathname);
  if (localPrefixMatch) {
    const projectId = localPrefixMatch[1]!;
    const relInput = localPrefixMatch[2]!;
    try {
      const file = resolveLocalProjectFile(projectId, relInput);
      let abs = file.absPath;
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
        const indexHtml = path.join(abs, "index.html");
        const indexAgentuse = path.join(abs, "index.agentuse");
        const indexMd = path.join(abs, "index.md");
        abs = fs.existsSync(indexHtml)
          ? indexHtml
          : fs.existsSync(indexAgentuse)
            ? indexAgentuse
            : indexMd;
      }
      if (!abs || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
        send(res, 404, "not found");
        return;
      }
      const ext = path.extname(abs).toLowerCase();
      if (ext === ".html" || ext === ".htm") {
        const safe = buildSafeSrcdoc(fs.readFileSync(abs, "utf8"));
        send(res, 200, safe, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": META_CSP,
          "x-frame-options": "SAMEORIGIN",
        });
        return;
      }
      if (ext === ".md" || ext === ".markdown" || ext === ".agentuse") {
        send(res, 200, fs.readFileSync(abs), { "content-type": "text/markdown; charset=utf-8" });
        return;
      }
      const csp = ext === ".pdf" ? null : ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp" ? IMAGE_CSP : undefined;
      send(
        res,
        200,
        fs.readFileSync(abs),
        { "content-type": MIME[ext] ?? "application/octet-stream" },
        { csp },
      );
    } catch (e) {
      const code = e instanceof CliError && e.code === "INVALID_INPUT" ? 400 : 500;
      send(res, code, (e as Error).message);
    }
    return;
  }

  // /api/project-files/{projectId}/{path...} -> project-local live files
  // rooted at the registered project. This powers whole-project discovery
  // while avoiding a general-purpose file server: ignored paths and
  // unsupported extensions are rejected before bytes are returned.
  const projectFileMatch = /^\/api\/project-files\/([A-Za-z0-9_]+)\/(.*)$/.exec(pathname);
  if (projectFileMatch) {
    const projectId = projectFileMatch[1]!;
    const relInput = projectFileMatch[2]!;
    try {
      const file = resolveProjectFile(projectId, relInput);
      let abs = file.absPath;
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
        const indexHtml = path.join(abs, "index.html");
        const indexAgentuse = path.join(abs, "index.agentuse");
        const indexMd = path.join(abs, "index.md");
        abs = fs.existsSync(indexHtml)
          ? indexHtml
          : fs.existsSync(indexAgentuse)
            ? indexAgentuse
            : indexMd;
      }
      if (!abs || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
        send(res, 404, "not found");
        return;
      }
      const ext = path.extname(abs).toLowerCase();
      if (!PROJECT_FILE_EXTENSIONS.has(ext)) {
        send(res, 404, "not found");
        return;
      }
      if (ext === ".html" || ext === ".htm") {
        const safe = buildSafeSrcdoc(fs.readFileSync(abs, "utf8"));
        send(res, 200, safe, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": META_CSP,
          "x-frame-options": "SAMEORIGIN",
        });
        return;
      }
      if (ext === ".md" || ext === ".markdown" || ext === ".agentuse") {
        send(res, 200, fs.readFileSync(abs), { "content-type": "text/markdown; charset=utf-8" });
        return;
      }
      send(
        res,
        200,
        fs.readFileSync(abs),
        { "content-type": MIME[ext] ?? "application/octet-stream" },
        { csp: projectFileCsp(ext) },
      );
    } catch (e) {
      const code = e instanceof CliError && e.code === "INVALID_INPUT" ? 400 : 500;
      send(res, code, (e as Error).message);
    }
    return;
  }

  // /api/render/{artifactId}  -> sanitized HTML served as text/html with its
  // own CSP header. Loaded via <iframe src=...> with sandbox="allow-scripts"
  // (no allow-same-origin), so it lives in an opaque origin isolated from the
  // viewer. Direct browser navigation here is rare; the CSP still applies
  // (connect-src 'none') so even direct nav cannot phone home or scan LAN.
  const renderMatch = /^\/api\/render\/([A-Za-z0-9_]+)$/.exec(pathname);
  if (renderMatch) {
    const id = renderMatch[1]!;
    try {
      const local = getCachedLocalArtifactById(id);
      if (!local) {
        send(res, 404, "not found");
        return;
      }
      if (local.record.type !== "html") {
        send(res, 400, "not an html artifact");
        return;
      }
      const buf = fs.readFileSync(local.absPath);
      const safe = buildSafeSrcdoc(buf.toString("utf8"));
      send(res, 200, safe, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": META_CSP,
        "x-frame-options": "SAMEORIGIN",
      });
    } catch (e) {
      send(res, 500, (e as Error).message);
    }
    return;
  }

  // Static viewer.
  let file = pathname.replace(/^\/+/, "");
  if (file === "" || file.startsWith("p/") || file.startsWith("a/")) {
    file = "index.html";
  }
  serveStatic(res, opts.dist, file);
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
