import path from "node:path";
import { CliError } from "./errors.js";

const MAX_NAME_BYTES = 512;

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

export type ArtifactType = "markdown" | "html" | "png" | "jpg" | "webp" | "pdf";

const EXT_TO_TYPE: Record<string, ArtifactType> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".html": "html",
  ".htm": "html",
  ".png": "png",
  ".jpg": "jpg",
  ".jpeg": "jpg",
  ".webp": "webp",
  ".pdf": "pdf",
};

export function inferType(name: string): ArtifactType {
  const ext = path.extname(name).toLowerCase();
  const type = EXT_TO_TYPE[ext];
  if (!type) {
    throw new CliError("INVALID_INPUT", `unsupported file type: ${ext || "(none)"}`);
  }
  return type;
}
