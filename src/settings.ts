import fs from "node:fs";
import path from "node:path";
import { settingsPath } from "./paths.js";

export interface ViewerSettings {
  ignorePatterns: string[];
  projectWideDiscoveryEnabled: boolean;
  maxProjectScanEntries: number;
}

export interface WriteSettingsInput {
  ignorePatterns: unknown[];
  projectWideDiscoveryEnabled?: boolean;
  maxProjectScanEntries?: number;
}

// Cap on directory entries visited per project during whole-project discovery.
// Whole-project discovery is a synchronous filesystem walk (and reads image
// headers for every matched image), so an unbounded scan of a pathological
// project (e.g. a CMS export with a multi-GB media library of millions of
// images) blocks the Node event loop and makes the viewer hang. The manifest
// cache rebuilds this scan periodically in the background, so the cap also
// keeps each rebuild cheap enough not to stall the server. 10k is far more
// than the stray docs/screenshots discovery is meant to surface, while keeping
// a worst-case cold scan to a few seconds. 0 means unlimited (opt-in).
export const DEFAULT_MAX_PROJECT_SCAN_ENTRIES = 10_000;

export const DEFAULT_IGNORE_PATTERNS = [
  ".git/**",
  ".hg/**",
  ".svn/**",
  "node_modules/**",
  "bower_components/**",
  "dist/**",
  "viewer-dist/**",
  "build/**",
  "out/**",
  "coverage/**",
  "target/**",
  ".next/**",
  ".nuxt/**",
  ".svelte-kit/**",
  ".vite/**",
  ".turbo/**",
  ".cache/**",
  "__pycache__/**",
  "tmp/**",
  "temp/**",
  "logs/**",
];

export function readSettings(): ViewerSettings {
  if (!fs.existsSync(settingsPath())) return defaultSettings();
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch {
    return defaultSettings();
  }
  if (!raw || typeof raw !== "object") return defaultSettings();
  const ignorePatterns = normalizeIgnorePatterns(
    Array.isArray((raw as ViewerSettings).ignorePatterns)
      ? (raw as ViewerSettings).ignorePatterns
      : DEFAULT_IGNORE_PATTERNS,
  );
  const projectWideDiscoveryEnabled =
    typeof (raw as ViewerSettings).projectWideDiscoveryEnabled === "boolean"
      ? (raw as ViewerSettings).projectWideDiscoveryEnabled
      : true;
  const maxProjectScanEntries = normalizeMaxScanEntries(
    (raw as ViewerSettings).maxProjectScanEntries,
  );
  return { ignorePatterns, projectWideDiscoveryEnabled, maxProjectScanEntries };
}

export function writeSettings(next: WriteSettingsInput): ViewerSettings {
  const settings: ViewerSettings = {
    ignorePatterns: normalizeIgnorePatterns(next.ignorePatterns),
    projectWideDiscoveryEnabled: next.projectWideDiscoveryEnabled !== false,
    maxProjectScanEntries: normalizeMaxScanEntries(next.maxProjectScanEntries),
  };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  const tmp = `${settingsPath()}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, settingsPath());
  return settings;
}

export function defaultSettings(): ViewerSettings {
  return {
    ignorePatterns: [...DEFAULT_IGNORE_PATTERNS],
    projectWideDiscoveryEnabled: true,
    maxProjectScanEntries: DEFAULT_MAX_PROJECT_SCAN_ENTRIES,
  };
}

// A missing/invalid value falls back to the default cap; a finite, non-negative
// number is honored (0 = unlimited). This keeps older settings files working
// and prevents a malformed value from silently disabling the cap.
export function normalizeMaxScanEntries(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return DEFAULT_MAX_PROJECT_SCAN_ENTRIES;
}

export function normalizeIgnorePatterns(patterns: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of patterns) {
    if (typeof raw !== "string") continue;
    const pattern = raw
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");
    if (!pattern || pattern.startsWith("#")) continue;
    if (/[\x00-\x1f\x7f]/.test(pattern)) continue;
    if (pattern.startsWith("!")) continue;
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    out.push(pattern);
    if (out.length >= 200) break;
  }
  return out;
}

export function isIgnoredByPatterns(relPath: string, patterns: string[]): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) return false;
  return patterns.some((pattern) => ignorePatternMatchesPath(pattern, normalized));
}

function ignorePatternMatchesPath(patternInput: string, relPath: string): boolean {
  const anchored = patternInput.startsWith("/");
  let pattern = anchored ? patternInput.replace(/^\/+/, "") : patternInput;
  if (!pattern) return false;
  if (pattern.endsWith("/")) pattern += "**";

  const candidates = anchored ? [relPath] : pathSuffixes(relPath);
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return candidates.some((candidate) => candidate === prefix || candidate.startsWith(prefix + "/"));
  }

  const regex = globToRegExp(pattern);
  return candidates.some((candidate) => regex.test(candidate));
}

function pathSuffixes(relPath: string): string[] {
  const parts = relPath.split("/");
  const suffixes: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    suffixes.push(parts.slice(i).join("/"));
  }
  return suffixes;
}

function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    const next = pattern[i + 1];
    if (char === "*" && next === "*") {
      out += ".*";
      i += 1;
      continue;
    }
    if (char === "*") {
      out += "[^/]*";
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += escapeRegExp(char);
  }
  out += "$";
  return new RegExp(out);
}

function escapeRegExp(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? "\\" + char : char;
}
