import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.js";
import { rootDir, servePidPath, artifactFilePath } from "./paths.js";
import { readManifest } from "./manifest.js";
import { extFromType } from "./validation.js";
import { buildSafeSrcdoc, META_CSP } from "./sanitize.js";
import {
  buildLocalManifest,
  findLocalArtifactById,
  resolveLocalProjectFile,
} from "./localArtifacts.js";

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
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
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

function handle(req: http.IncomingMessage, res: http.ServerResponse, opts: { dist: string }): void {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const pathname = url.pathname;

  if (pathname === "/api/manifest") {
    try {
      const m = buildLocalManifest();
      send(res, 200, JSON.stringify(m), { "content-type": MIME[".json"]! });
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
      const local = findLocalArtifactById(id);
      const m = local ? undefined : readManifest();
      const rec = local?.record ?? m?.artifacts[id];
      if (!rec) {
        send(res, 404, "not found");
        return;
      }
      if (rec.type === "html") {
        send(res, 400, "use /api/render/:id for HTML artifacts");
        return;
      }
      const ext = extFromType(rec.type);
      const file = local?.absPath ?? artifactFilePath(rec.projectId, id, ext);
      const buf = fs.readFileSync(file);
      if (rec.type === "markdown") {
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
      const local = findLocalArtifactById(id);
      const m = local ? undefined : readManifest();
      const rec = local?.record ?? m?.artifacts[id];
      if (!rec) {
        send(res, 404, "not found");
        return;
      }
      const ext = extFromType(rec.type);
      const file = local?.absPath ?? artifactFilePath(rec.projectId, id, ext);
      const buf = fs.readFileSync(file);
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
        const indexMd = path.join(abs, "index.md");
        abs = fs.existsSync(indexHtml) ? indexHtml : indexMd;
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
      if (ext === ".md" || ext === ".markdown") {
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

  // /api/render/{artifactId}  -> sanitized HTML served as text/html with its
  // own CSP header. Loaded via <iframe src=...> with sandbox="allow-scripts"
  // (no allow-same-origin), so it lives in an opaque origin isolated from the
  // viewer. Direct browser navigation here is rare; the CSP still applies
  // (connect-src 'none') so even direct nav cannot phone home or scan LAN.
  const renderMatch = /^\/api\/render\/([A-Za-z0-9_]+)$/.exec(pathname);
  if (renderMatch) {
    const id = renderMatch[1]!;
    try {
      const local = findLocalArtifactById(id);
      const m = local ? undefined : readManifest();
      const rec = local?.record ?? m?.artifacts[id];
      if (!rec) {
        send(res, 404, "not found");
        return;
      }
      if (rec.type !== "html") {
        send(res, 400, "not an html artifact");
        return;
      }
      const file = local?.absPath ?? artifactFilePath(rec.projectId, id, extFromType(rec.type));
      const buf = fs.readFileSync(file);
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
  const server = http.createServer((req, res) => handle(req, res, { dist }));
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
