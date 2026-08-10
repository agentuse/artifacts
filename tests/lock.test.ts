import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import { tempStorageRoot, rmStorageRoot } from "./helpers";
import { withLock } from "../src/lock";
import { lockPath } from "../src/paths";

describe("withLock", () => {
  let root: string;
  beforeEach(() => {
    root = tempStorageRoot();
  });
  afterEach(() => {
    rmStorageRoot(root);
  });

  it("runs the body and releases the lock", async () => {
    let ran = false;
    await withLock(async () => {
      expect(fs.existsSync(lockPath())).toBe(true);
      ran = true;
    });
    expect(ran).toBe(true);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("releases the lock when the body throws", async () => {
    await expect(
      withLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("reclaims a stale lock from a non-existent pid", async () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      lockPath(),
      JSON.stringify({
        pid: 999999,
        host: os.hostname(),
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
});
