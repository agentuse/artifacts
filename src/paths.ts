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
export function filesDir(): string {
  return path.join(rootDir(), "files");
}
export function servePidPath(): string {
  return path.join(rootDir(), ".serve.pid");
}

export function projectFilesDir(projectId: string): string {
  return path.join(filesDir(), projectId);
}

export function artifactFilePath(projectId: string, artifactId: string, ext: string): string {
  return path.join(projectFilesDir(projectId), `${artifactId}.${ext}`);
}
