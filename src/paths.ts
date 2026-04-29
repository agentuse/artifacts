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
export function lockPath(): string {
  return path.join(rootDir(), ".lock");
}
export function servePidPath(): string {
  return path.join(rootDir(), ".serve.pid");
}
