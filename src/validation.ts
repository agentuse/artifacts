import path from "node:path";
import { CliError } from "./errors.js";

export type ArtifactType =
  | "markdown"
  | "agentuse"
  | "html"
  | "png"
  | "jpg"
  | "webp"
  | "pdf"
  | "video"
  | "audio"
  | "text"
  | "file";

/** Types that can be a directory bundle's entry file. */
const EXT_TO_TYPE: Record<string, ArtifactType> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".agentuse": "agentuse",
  ".html": "html",
  ".htm": "html",
  ".png": "png",
  ".jpg": "jpg",
  ".jpeg": "jpg",
  ".webp": "webp",
  ".pdf": "pdf",
};

/**
 * Extra kinds a single submitted file can be. They are not directory entry
 * candidates: a design folder holding a clip or a data.json next to its
 * page must keep picking the page, and must not start counting those files
 * toward the bundle cap.
 */
const SINGLE_FILE_TYPES: Record<string, ArtifactType> = {
  ".mp4": "video",
  ".m4v": "video",
  ".mov": "video",
  ".webm": "video",
  ".mp3": "audio",
  ".m4a": "audio",
  ".aac": "audio",
  ".wav": "audio",
  ".ogg": "audio",
  ".oga": "audio",
  ".flac": "audio",
  ...Object.fromEntries(
    [
      ".txt", ".log", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".toml",
      ".xml", ".srt", ".vtt", ".diff", ".patch", ".sql", ".ts", ".tsx", ".js",
      ".mjs", ".cjs", ".py", ".sh", ".rb", ".go", ".rs", ".swift", ".css",
    ].map((ext) => [ext, "text" as const]),
  ),
};

export function inferType(name: string): ArtifactType {
  const ext = path.extname(name).toLowerCase();
  const type = EXT_TO_TYPE[ext];
  if (!type) {
    throw new CliError("INVALID_INPUT", `unsupported file type: ${ext || "(none)"}`);
  }
  return type;
}

/** A file submitted on its own. Any file is accepted; unknown kinds become "file" (a download card). */
export function inferFileType(name: string): ArtifactType {
  const ext = path.extname(name).toLowerCase();
  return EXT_TO_TYPE[ext] ?? SINGLE_FILE_TYPES[ext] ?? "file";
}
