import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tempProjectDir, tempStorageRoot, rmStorageRoot } from "./helpers";
import {
  addArtifacts,
  listArtifacts,
  removeRevision,
  revertArtifact,
} from "../src/artifacts";

const origCwd = process.cwd();
let root: string;
let proj: string;

beforeEach(() => {
  root = tempStorageRoot();
  proj = tempProjectDir();
  process.chdir(proj);
});
afterEach(() => {
  process.chdir(origCwd);
  rmStorageRoot(root);
  try {
    fs.rmSync(proj, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function writeFile(name: string, body: string): string {
  const full = path.join(proj, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
}

describe("revision logic", () => {
  it("first add creates v1", async () => {
    writeFile("a.md", "# v1");
    const out = await addArtifacts([{ source: path.join(proj, "a.md") }]);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.revision).toBe(1);
    expect(out.results[0]?.skipped).toBe(false);
  });

  it("identical content is a no-op", async () => {
    writeFile("a.md", "# v1");
    await addArtifacts([{ source: path.join(proj, "a.md") }]);
    const second = await addArtifacts([{ source: path.join(proj, "a.md") }]);
    expect(second.results[0]?.skipped).toBe(true);
    expect(second.results[0]?.revision).toBe(1);
  });

  it("changed content increments revision", async () => {
    writeFile("a.md", "# v1");
    await addArtifacts([{ source: path.join(proj, "a.md") }]);
    writeFile("a.md", "# v2");
    const second = await addArtifacts([{ source: path.join(proj, "a.md") }]);
    expect(second.results[0]?.revision).toBe(2);
    expect(second.results[0]?.previousRevision).toBe(1);
  });

  it("--force-revision creates a new revision on identical hash", async () => {
    writeFile("a.md", "# v1");
    await addArtifacts([{ source: path.join(proj, "a.md") }]);
    const second = await addArtifacts([
      { source: path.join(proj, "a.md"), forceRevision: true },
    ]);
    expect(second.results[0]?.skipped).toBe(false);
    expect(second.results[0]?.revision).toBe(2);
  });

  it("revert creates a new revision pointing at older content", async () => {
    writeFile("a.md", "# v1");
    await addArtifacts([{ source: path.join(proj, "a.md") }]);
    writeFile("a.md", "# v2");
    await addArtifacts([{ source: path.join(proj, "a.md") }]);
    const out = await revertArtifact({ name: "a.md", to: 1 });
    expect(out.revision).toBe(3);

    const all = listArtifacts({ name: "a.md", revisions: true });
    expect(all.map((a) => a.record.revision).sort()).toEqual([1, 2, 3]);
  });

  it("rm a single revision falls latest back to predecessor", async () => {
    writeFile("a.md", "# v1");
    await addArtifacts([{ source: path.join(proj, "a.md") }]);
    writeFile("a.md", "# v2");
    await addArtifacts([{ source: path.join(proj, "a.md") }]);
    await removeRevision({ name: "a.md", revision: 2 });
    const latest = listArtifacts({ name: "a.md" });
    expect(latest).toHaveLength(1);
    expect(latest[0]?.record.revision).toBe(1);
  });

  it("size cap rejects oversized input", async () => {
    writeFile("a.md", "x".repeat(11));
    await expect(
      addArtifacts([{ source: path.join(proj, "a.md"), maxSize: 10 }]),
    ).rejects.toThrow(/max-size/);
  });

  it("rejects malicious explicit names", async () => {
    writeFile("a.md", "# v1");
    await expect(
      addArtifacts([
        { source: path.join(proj, "a.md"), name: "../../etc/passwd" },
      ]),
    ).rejects.toThrow(/\.\./);
  });
});
