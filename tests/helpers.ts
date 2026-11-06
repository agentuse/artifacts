import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function tempStorageRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentuse-artifacts-"));
  process.env.AGENTUSE_ARTIFACTS_HOME = dir;
  // Tests run inside real agent sessions; never record or wake the one running them.
  delete process.env.HERDR_ENV;
  delete process.env.HERDR_PANE_ID;
  return dir;
}

export function rmStorageRoot(dir: string): void {
  process.env.AGENTUSE_ARTIFACTS_HOME = undefined;
  delete process.env.AGENTUSE_ARTIFACTS_HOME;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function tempProjectDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentuse-proj-"));
}
