import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.js";
import { rootDir, servePidPath, artifactFilePath } from "./paths.js";
import { readManifest } from "./manifest.js";
import { extFromType } from "./validation.js";
import { buildSafeSrcdoc } from "./sanitize.js";

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
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Browsers inherit the parent SPA's CSP into iframe srcdoc documents (same
// origin). When two CSPs apply, the strictest wins, so the meta-CSP we inject
// inside the srcdoc cannot be MORE permissive than this one for any directive.
// Concretely: artifacts use inline <style> and style="" attributes, so the
// parent must allow 'unsafe-inline' for style. We also widen img-src/font-src
// to match the meta-CSP. script-src stays locked to 'self' — meta-CSP's
// default-src 'none' ensures no script in the artifact runs anyway.
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
): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": SPA_CSP,
    ...headers,
  });
  res.end(body);
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

function handle(req: http.IncomingMessage, res: http.ServerResponse, opts: { dist: string }): void {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const pathname = url.pathname;

  if (pathname === "/api/manifest") {
    try {
      const m = readManifest();
      send(res, 200, JSON.stringify(m), { "content-type": MIME[".json"]! });
    } catch (e) {
      send(res, 500, (e as Error).message);
    }
    return;
  }

  // /api/artifact/{artifactId}  -> raw content (markdown text or sanitized HTML srcdoc)
  const artMatch = /^\/api\/artifact\/([A-Za-z0-9_]+)$/.exec(pathname);
  if (artMatch) {
    const id = artMatch[1]!;
    try {
      const m = readManifest();
      const rec = m.artifacts[id];
      if (!rec) {
        send(res, 404, "not found");
        return;
      }
      const ext = extFromType(rec.type);
      const file = artifactFilePath(rec.projectId, id, ext);
      const buf = fs.readFileSync(file);
      if (rec.type === "html") {
        const safe = buildSafeSrcdoc(buf.toString("utf8"));
        // We ship the *sanitized* srcdoc as text/plain so the browser cannot
        // interpret it at this origin. The SPA reads it and assigns it to
        // an iframe's srcdoc attribute with sandbox="".
        send(res, 200, safe, { "content-type": "text/plain; charset=utf-8" });
      } else {
        send(res, 200, buf, { "content-type": "text/markdown; charset=utf-8" });
      }
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
