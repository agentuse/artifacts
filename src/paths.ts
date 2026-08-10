import os from "node:os";
import path from "node:path";

export function rootDir(): string {
  return process.env.AGENTUSE_ARTIFACTS_HOME
    ? path.resolve(process.env.AGENTUSE_ARTIFACTS_HOME)
    : path.join(os.homedir(), ".agentuse", "artifacts");
}

export function manifestPath(): string {
  return path.join(rootDir(), "manifest.json");
}
/** Append-only submission log. One JSON object per line, oldest first. */
export function feedPath(): string {
  return path.join(rootDir(), "feed.jsonl");
}
/** Root of the copied artifact bundles: store/<projectId>/<slug>/<rev>/. */
export function storeDir(): string {
  return path.join(rootDir(), "store");
}
export function previewCacheDir(): string {
  return path.join(rootDir(), "preview-cache");
}
export function lockPath(): string {
  return path.join(rootDir(), ".lock");
}
export function servePidPath(): string {
  return path.join(rootDir(), ".serve.pid");
}
