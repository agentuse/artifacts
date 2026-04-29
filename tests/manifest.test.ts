import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { tempStorageRoot, rmStorageRoot } from "./helpers";
import {
  readManifest,
  withLock,
  writeManifestAtomic,
  SCHEMA_VERSION,
} from "../src/manifest";
import { lockPath, manifestPath } from "../src/paths";

describe("manifest read/write/lock", () => {
  let root: string;
  beforeEach(() => {
    root = tempStorageRoot();
  });
  afterEach(() => {
    rmStorageRoot(root);
  });

  it("returns empty manifest when missing", () => {
    const m = readManifest();
    expect(m.schemaVersion).toBe(SCHEMA_VERSION);
    expect(m.projects).toEqual({});
  });

  it("round-trips a project write", async () => {
    await withLock(async () => {
      const m = readManifest();
      m.projects.proj_a = {
        name: "A",
        path: "/tmp/a",
        createdAt: new Date().toISOString(),
      };
      writeManifestAtomic(m);
    });
    const reread = readManifest();
    expect(reread.projects.proj_a?.name).toBe("A");
  });

  it("reclaims a stale lock from a non-existent pid", async () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      lockPath(),
      JSON.stringify({
        pid: 999999,
        host: require("os").hostname(),
        acquiredAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    let ran = false;
    await withLock(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("rejects mismatched schemaVersion", () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(manifestPath(), JSON.stringify({ schemaVersion: 99 }));
    expect(() => readManifest()).toThrow(/schemaVersion/i);
  });
});
