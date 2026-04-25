import path from "node:path";
import { CliError } from "./errors.js";

const MAX_NAME_BYTES = 512;

/**
 * Resolve a logical artifact name from an optional source path and explicit name.
 * Caller has already resolved symlinks where appropriate.
 *
 * Rules (§5.1):
 *  - If `explicitName` is provided, use it (subject to validation).
 *  - Else if `resolvedSource` is inside the project root, use POSIX path relative to root.
 *  - Else use basename of source.
 */
export function resolveLogicalName(opts: {
  explicitName?: string;
  resolvedSource?: string;
  projectPath: string;
  isStdin: boolean;
}): string {
  const { explicitName, resolvedSource, projectPath, isStdin } = opts;

  if (explicitName) return validateName(explicitName);

  if (isStdin) {
    throw new CliError("INVALID_INPUT", "--name is required when reading from stdin");
  }

  if (!resolvedSource) {
    throw new CliError("INVALID_INPUT", "no source path provided");
  }

  const projAbs = path.resolve(projectPath);
  const srcAbs = path.resolve(resolvedSource);
  const rel = path.relative(projAbs, srcAbs);

  let name: string;
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
    name = rel.split(path.sep).join("/");
  } else {
    name = path.basename(srcAbs);
  }
  return validateName(name);
}

export function validateName(input: string): string {
  if (typeof input !== "string") {
    throw new CliError("INVALID_NAME", "name must be a string", { name: String(input) });
  }
  // Normalize backslashes to forward slashes for cross-platform.
  const normalized = input.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");

  if (normalized.length === 0) {
    throw new CliError("INVALID_NAME", "name must not be empty", { name: input });
  }
  if (Buffer.byteLength(normalized, "utf8") > MAX_NAME_BYTES) {
    throw new CliError("INVALID_NAME", "name exceeds 512 bytes", { name: input });
  }
  // No control characters (incl. NUL).
  if (/[\x00-\x1f\x7f]/.test(normalized)) {
    throw new CliError("INVALID_NAME", "name contains control characters", { name: input });
  }
  // Reject absolute paths (POSIX leading / or Windows drive letter).
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new CliError("INVALID_NAME", "name must not be absolute", { name: input });
  }
  // Reject any `..` segment.
  const parts = normalized.split("/");
  if (parts.some((p) => p === "..")) {
    throw new CliError("INVALID_NAME", "name must not contain '..' segments", { name: input });
  }
  return normalized;
}

export function inferType(name: string): "markdown" | "html" {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext === ".html" || ext === ".htm") return "html";
  throw new CliError("INVALID_INPUT", `unsupported file type: ${ext || "(none)"}`);
}

export function extFromType(type: "markdown" | "html"): string {
  return type === "markdown" ? "md" : "html";
}
