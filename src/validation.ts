import path from "node:path";
import { CliError } from "./errors.js";

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
