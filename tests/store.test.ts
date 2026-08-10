import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { rmStorageRoot, tempProjectDir, tempStorageRoot } from "./helpers";
import { readFeedEntries, type FeedEntry } from "../src/feed";
import { storeDir } from "../src/paths";
import {
  MAX_BUNDLE_FILES,
  bundleDir,
  importLocalArtifacts,
  makeSlug,
  pruneStore,
  resolveBundleFile,
  submitArtifact,
} from "../src/store";

function write(dir: string, rel: string, content: string): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

describe("makeSlug", () => {
  it("lowercases and replaces unsafe characters", () => {
    expect(makeSlug("Weekly Report (Q3)")).toBe("weekly-report-q3");
  });

  it("trims separators from both ends", () => {
    expect(makeSlug("--report--")).toBe("report");
  });

  it("rejects input with nothing usable left", () => {
    expect(() => makeSlug("///")).toThrow(/slug/i);
  });
});

describe("submitArtifact", () => {
  let root: string;
  let project: string;
  beforeEach(() => {
    root = tempStorageRoot();
    project = tempProjectDir();
  });
  afterEach(() => {
    rmStorageRoot(root);
    fs.rmSync(project, { recursive: true, force: true });
  });

  it("copies a single file into the store and logs one entry", async () => {
    const file = write(project, "report.md", "# Weekly numbers\n\nbody\n");
    const { entry, deduped } = await submitArtifact({ target: file });

    expect(deduped).toBe(false);
    expect(entry.slug).toBe("report");
    expect(entry.rev).toBe(1);
    expect(entry.title).toBe("Weekly numbers");
    expect(entry.entry).toBe("report.md");
    expect(entry.sourcePath).toBe(path.resolve(file));
    expect(fs.existsSync(path.join(bundleDir(entry), "report.md"))).toBe(true);
    expect(readFeedEntries()).toHaveLength(1);
  });

  it("keeps a directory's support files together and picks index.html", async () => {
    write(project, "site/index.html", "<html><head><title>Dash</title></head><body>hi</body></html>");
    write(project, "site/styles.css", "body{}");
    write(project, "site/assets/logo.svg", "<svg/>");

    const { entry } = await submitArtifact({ target: path.join(project, "site") });
    expect(entry.entry).toBe("index.html");
    expect(entry.title).toBe("Dash");
    expect(entry.files).toBe(3);
    expect(fs.existsSync(path.join(bundleDir(entry), "assets", "logo.svg"))).toBe(true);
  });

  it("skips dependency directories and dotfiles", async () => {
    write(project, "site/index.md", "# Hi");
    write(project, "site/node_modules/pkg/readme.md", "# nope");
    write(project, "site/.hidden.md", "# nope");

    const { entry } = await submitArtifact({ target: path.join(project, "site") });
    expect(entry.files).toBe(1);
  });

  it("returns the existing entry when nothing changed", async () => {
    const file = write(project, "report.md", "# Same\n");
    const first = await submitArtifact({ target: file });
    const second = await submitArtifact({ target: file });

    expect(second.deduped).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
    expect(readFeedEntries()).toHaveLength(1);
  });

  it("adds a revision when the content changes", async () => {
    const file = write(project, "report.md", "# One\n");
    const first = await submitArtifact({ target: file });
    write(project, "report.md", "# Two\n");
    const second = await submitArtifact({ target: file });

    expect(second.deduped).toBe(false);
    expect(second.entry.rev).toBe(2);
    expect(second.entry.slug).toBe(first.entry.slug);
    expect(readFeedEntries()).toHaveLength(2);
  });

  it("adds a revision when only the tags change", async () => {
    const file = write(project, "report.md", "# One\n");
    await submitArtifact({ target: file });
    const second = await submitArtifact({ target: file, tags: ["weekly"] });

    expect(second.deduped).toBe(false);
    expect(second.entry.tags).toEqual(["weekly"]);
  });

  it("honours an explicit title, slug, and tags", async () => {
    const file = write(project, "report.md", "# Ignored\n");
    const { entry } = await submitArtifact({
      target: file,
      title: "Board update",
      slug: "Board Update",
      tags: ["exec, weekly"],
    });
    expect(entry.title).toBe("Board update");
    expect(entry.slug).toBe("board-update");
    expect(entry.tags).toEqual(["exec", "weekly"]);
  });

  it("does not take a heading out of a fenced code block", async () => {
    const file = write(project, "readme.md", "```sh\n# not a title\n```\n\n# Real title\n");
    const { entry } = await submitArtifact({ target: file });
    expect(entry.title).toBe("Real title");
  });

  it("prefers frontmatter title over the first heading", async () => {
    const file = write(project, "doc.md", "---\ntitle: From frontmatter\n---\n\n# Heading\n");
    const { entry } = await submitArtifact({ target: file });
    expect(entry.title).toBe("From frontmatter");
  });

  it("falls back to a humanized slug", async () => {
    const file = write(project, "quarterly-plan.md", "just prose, no heading\n");
    const { entry } = await submitArtifact({ target: file });
    expect(entry.title).toBe("Quarterly plan");
  });

  it("rejects an unsupported single file", async () => {
    const file = write(project, "notes.txt", "hello");
    await expect(submitArtifact({ target: file })).rejects.toThrow(/unsupported file type/i);
  });

  it("rejects a directory with several renderable files and no index", async () => {
    write(project, "mixed/a.md", "# A");
    write(project, "mixed/b.md", "# B");
    await expect(submitArtifact({ target: path.join(project, "mixed") })).rejects.toThrow(
      /index/i,
    );
  });

  it("rejects a directory over the file cap before copying anything", async () => {
    for (let i = 0; i <= MAX_BUNDLE_FILES; i += 1) {
      write(project, `big/f${i}.md`, `# ${i}`);
    }
    await expect(submitArtifact({ target: path.join(project, "big") })).rejects.toThrow(
      /more than/i,
    );
    expect(fs.existsSync(storeDir())).toBe(false);
  });

  it("rejects a missing target", async () => {
    await expect(submitArtifact({ target: path.join(project, "nope.md") })).rejects.toThrow(
      /no such file/i,
    );
  });
});

describe("resolveBundleFile", () => {
  let root: string;
  let project: string;
  beforeEach(() => {
    root = tempStorageRoot();
    project = tempProjectDir();
  });
  afterEach(() => {
    rmStorageRoot(root);
    fs.rmSync(project, { recursive: true, force: true });
  });

  it("resolves a file inside the bundle and defaults to the entry file", async () => {
    write(project, "site/index.html", "<html><body>hi</body></html>");
    write(project, "site/styles.css", "body{}");
    const { entry } = await submitArtifact({ target: path.join(project, "site") });

    expect(resolveBundleFile(entry, "styles.css")).toBe(
      path.join(bundleDir(entry), "styles.css"),
    );
    expect(resolveBundleFile(entry, "")).toBe(path.join(bundleDir(entry), "index.html"));
  });

  it("refuses to escape the bundle root", async () => {
    const file = write(project, "report.md", "# Hi");
    const { entry } = await submitArtifact({ target: file });

    expect(() => resolveBundleFile(entry, "../../manifest.json")).toThrow(/\.\./);
    expect(() => resolveBundleFile(entry, "..\\..\\manifest.json")).toThrow(/\.\./);
    expect(() => resolveBundleFile(entry, "a/../../b")).toThrow(/\.\./);
  });
});

describe("pruneStore", () => {
  let root: string;
  let project: string;
  beforeEach(() => {
    root = tempStorageRoot();
    project = tempProjectDir();
  });
  afterEach(() => {
    rmStorageRoot(root);
    fs.rmSync(project, { recursive: true, force: true });
  });

  it("keeps the newest revisions and deletes the rest from disk", async () => {
    const file = path.join(project, "report.md");
    const entries: FeedEntry[] = [];
    for (let i = 1; i <= 4; i += 1) {
      write(project, "report.md", `# Version ${i}\n`);
      entries.push((await submitArtifact({ target: file })).entry);
    }
    expect(readFeedEntries()).toHaveLength(4);

    const out = await pruneStore(2);
    expect(out.removed.map((r) => r.rev).sort()).toEqual([1, 2]);
    expect(readFeedEntries().map((e) => e.rev).sort()).toEqual([3, 4]);
    expect(fs.existsSync(bundleDir(entries[0]!))).toBe(false);
    expect(fs.existsSync(bundleDir(entries[3]!))).toBe(true);
  });
});

describe("importLocalArtifacts", () => {
  let root: string;
  let project: string;
  beforeEach(() => {
    root = tempStorageRoot();
    project = tempProjectDir();
  });
  afterEach(() => {
    rmStorageRoot(root);
    fs.rmSync(project, { recursive: true, force: true });
  });

  it("submits every artifact already in .agentuse/artifacts", async () => {
    write(project, ".agentuse/artifacts/dash/index.html", "<html><body>d</body></html>");
    write(project, ".agentuse/artifacts/notes.md", "# Notes");
    write(project, ".agentuse/artifacts/ignored.txt", "nope");

    const results = await importLocalArtifacts(project);
    expect(results.map((r) => r.entry.slug).sort()).toEqual(["dash", "notes"]);
    expect(readFeedEntries()).toHaveLength(2);
  });

  it("fails clearly when there is nothing to import", async () => {
    await expect(importLocalArtifacts(project)).rejects.toThrow(/no artifacts directory/i);
  });
});
