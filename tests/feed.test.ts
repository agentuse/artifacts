import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { rmStorageRoot, tempStorageRoot } from "./helpers";
import {
  appendFeedEntry,
  nextRevision,
  normalizeTags,
  queryFeed,
  readFeedEntries,
  writeFeedAtomic,
  type FeedEntry,
} from "../src/feed";
import { feedPath } from "../src/paths";

function entry(overrides: Partial<FeedEntry> = {}): FeedEntry {
  return {
    id: "art_0000000000000001",
    projectId: "proj_a",
    projectName: "alpha",
    slug: "report",
    rev: 1,
    title: "Report",
    tags: [],
    type: "markdown",
    entry: "index.md",
    files: 1,
    size: 10,
    contentHash: "hash",
    sourcePath: "/tmp/report.md",
    submittedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("normalizeTags", () => {
  it("lowercases, splits commas, and dedupes", () => {
    expect(normalizeTags(["Weekly, Report", "weekly", " Ops "])).toEqual([
      "weekly",
      "report",
      "ops",
    ]);
  });

  it("turns inner whitespace into dashes", () => {
    expect(normalizeTags(["quarterly review"])).toEqual(["quarterly-review"]);
  });

  it("drops empties and over-long tags", () => {
    expect(normalizeTags(["", "  ", "x".repeat(33), "ok"])).toEqual(["ok"]);
  });

  it("caps the tag count", () => {
    const many = Array.from({ length: 30 }, (_, i) => `t${i}`);
    expect(normalizeTags(many)).toHaveLength(12);
  });
});

describe("feed log", () => {
  let root: string;
  beforeEach(() => {
    root = tempStorageRoot();
  });
  afterEach(() => {
    rmStorageRoot(root);
  });

  it("returns no entries when the log is missing", () => {
    expect(readFeedEntries()).toEqual([]);
  });

  it("appends and reads back in order", () => {
    appendFeedEntry(entry({ id: "art_1" }));
    appendFeedEntry(entry({ id: "art_2", slug: "other" }));
    expect(readFeedEntries().map((e) => e.id)).toEqual(["art_1", "art_2"]);
  });

  it("skips malformed lines instead of failing", () => {
    appendFeedEntry(entry({ id: "art_1" }));
    fs.appendFileSync(feedPath(), "not json\n{}\n");
    appendFeedEntry(entry({ id: "art_2", slug: "other" }));
    expect(readFeedEntries().map((e) => e.id)).toEqual(["art_1", "art_2"]);
  });

  it("defaults missing tags to an empty list", () => {
    fs.mkdirSync(root, { recursive: true });
    const raw = entry({ id: "art_1" }) as Partial<FeedEntry>;
    delete raw.tags;
    fs.writeFileSync(feedPath(), JSON.stringify(raw) + "\n");
    expect(readFeedEntries()[0]!.tags).toEqual([]);
  });

  it("counts the next revision per project and slug", () => {
    const entries = [
      entry({ id: "a", rev: 1 }),
      entry({ id: "b", rev: 2 }),
      entry({ id: "c", slug: "other", rev: 7 }),
      entry({ id: "d", projectId: "proj_b", rev: 9 }),
    ];
    expect(nextRevision(entries, "proj_a", "report")).toBe(3);
    expect(nextRevision(entries, "proj_a", "other")).toBe(8);
    expect(nextRevision(entries, "proj_a", "missing")).toBe(1);
  });
});

describe("queryFeed", () => {
  let root: string;
  beforeEach(() => {
    root = tempStorageRoot();
  });
  afterEach(() => {
    rmStorageRoot(root);
  });

  const seed = (entries: FeedEntry[]) => writeFeedAtomic(entries);

  it("shows only the newest revision per slug, newest first", () => {
    seed([
      entry({ id: "a", rev: 1, submittedAt: "2026-01-01T00:00:00.000Z" }),
      entry({ id: "b", rev: 2, submittedAt: "2026-01-03T00:00:00.000Z" }),
      entry({ id: "c", slug: "plan", submittedAt: "2026-01-02T00:00:00.000Z" }),
    ]);
    const page = queryFeed();
    expect(page.entries.map((e) => e.id)).toEqual(["b", "c"]);
    expect(page.total).toBe(2);
  });

  it("can include superseded revisions", () => {
    seed([entry({ id: "a", rev: 1 }), entry({ id: "b", rev: 2 })]);
    expect(queryFeed({ allRevisions: true }).total).toBe(2);
  });

  it("filters by project, tag, and free text", () => {
    seed([
      entry({ id: "a", slug: "one", title: "Weekly numbers", tags: ["ops"] }),
      entry({ id: "b", slug: "two", projectId: "proj_b", projectName: "beta", title: "Design" }),
      entry({ id: "c", slug: "three", title: "Roadmap", tags: ["ops", "plan"] }),
    ]);
    expect(queryFeed({ projectId: "proj_b" }).entries.map((e) => e.id)).toEqual(["b"]);
    expect(queryFeed({ tag: "plan" }).entries.map((e) => e.id)).toEqual(["c"]);
    expect(queryFeed({ q: "weekly" }).entries.map((e) => e.id)).toEqual(["a"]);
    expect(queryFeed({ q: "beta" }).entries.map((e) => e.id)).toEqual(["b"]);
  });

  it("reports facets over the whole set, not the filtered slice", () => {
    seed([
      entry({ id: "a", slug: "one", tags: ["ops"] }),
      entry({ id: "b", slug: "two", projectId: "proj_b", projectName: "beta", tags: ["ops"] }),
    ]);
    const page = queryFeed({ projectId: "proj_b" });
    expect(page.entries).toHaveLength(1);
    expect(page.projects.map((p) => p.projectId).sort()).toEqual(["proj_a", "proj_b"]);
    expect(page.tags).toEqual([{ tag: "ops", count: 2 }]);
  });

  it("pages with a cursor", () => {
    seed(
      Array.from({ length: 5 }, (_, i) =>
        entry({
          id: `art_${i}`,
          slug: `s${i}`,
          submittedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
        }),
      ),
    );
    const first = queryFeed({ limit: 2 });
    expect(first.entries.map((e) => e.id)).toEqual(["art_4", "art_3"]);
    expect(first.nextCursor).toBe(2);

    const second = queryFeed({ limit: 2, cursor: first.nextCursor! });
    expect(second.entries.map((e) => e.id)).toEqual(["art_2", "art_1"]);

    const last = queryFeed({ limit: 2, cursor: 4 });
    expect(last.entries.map((e) => e.id)).toEqual(["art_0"]);
    expect(last.nextCursor).toBeNull();
  });
});
