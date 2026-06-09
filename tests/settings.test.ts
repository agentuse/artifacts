import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { rmStorageRoot, tempStorageRoot } from "./helpers";
import { settingsPath } from "../src/paths";
import {
  DEFAULT_MAX_PROJECT_SCAN_ENTRIES,
  readSettings,
  writeSettings,
} from "../src/settings";

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

  it("defaults the project scan cap and treats older settings files as capped", () => {
    expect(readSettings().maxProjectScanEntries).toBe(DEFAULT_MAX_PROJECT_SCAN_ENTRIES);

    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ ignorePatterns: ["dist/**"] }));
    expect(readSettings().maxProjectScanEntries).toBe(DEFAULT_MAX_PROJECT_SCAN_ENTRIES);
  });

  it("persists a custom project scan cap and honors 0 as unlimited", () => {
    writeSettings({ ignorePatterns: [], maxProjectScanEntries: 1234 });
    expect(readSettings().maxProjectScanEntries).toBe(1234);

    writeSettings({ ignorePatterns: [], maxProjectScanEntries: 0 });
    expect(readSettings().maxProjectScanEntries).toBe(0);
  });

  it("falls back to the default cap for invalid values", () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify({ ignorePatterns: [], maxProjectScanEntries: -5 }),
    );
    expect(readSettings().maxProjectScanEntries).toBe(DEFAULT_MAX_PROJECT_SCAN_ENTRIES);
  });
});
