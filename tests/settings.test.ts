import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { rmStorageRoot, tempStorageRoot } from "./helpers";
import { settingsPath } from "../src/paths";
import { readSettings, writeSettings } from "../src/settings";

describe("viewer settings", () => {
  let storageRoot: string;

  beforeEach(() => {
    storageRoot = tempStorageRoot();
  });

  afterEach(() => {
    rmStorageRoot(storageRoot);
  });

  it("defaults project-wide discovery to enabled", () => {
    expect(readSettings().projectWideDiscoveryEnabled).toBe(true);
  });

  it("treats older settings files as project-wide discovery enabled", () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ ignorePatterns: ["dist/**"] }));

    expect(readSettings()).toMatchObject({
      ignorePatterns: ["dist/**"],
      projectWideDiscoveryEnabled: true,
    });
  });

  it("persists project-wide discovery when disabled", () => {
    writeSettings({
      ignorePatterns: [],
      projectWideDiscoveryEnabled: false,
    });

    expect(readSettings().projectWideDiscoveryEnabled).toBe(false);
  });
});
