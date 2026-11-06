import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appendFeedEntry, queryFeed, type FeedEntry } from "../src/feed.js";
import { pinsPath } from "../src/paths.js";
import { readPins, setPinned } from "../src/pins.js";
import { handle } from "../src/server.js";
import { forgetProjectArtifacts } from "../src/store.js";
import { rmStorageRoot, tempProjectDir, tempStorageRoot } from "./helpers.js";

function entry(slug: string, rev: number, minute: number, extra: Partial<FeedEntry> = {}): FeedEntry {
  return {
    id: `art_${slug}_${rev}`, projectId: "proj_a", projectName: "a", slug, rev, title: slug, tags: [],
    type: "markdown", entry: "a.md", files: 1, size: 1, contentHash: `h${rev}`, sourcePath: "/a.md",
    submittedAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
    ...extra,
  };
}
const ref = (slug: string) => ({ projectId: "proj_a", slug });

describe("pins", () => {
  let root: string;
  beforeEach(() => { root = tempStorageRoot(); });
  afterEach(() => rmStorageRoot(root));

  it("lets the last line win and keeps pins in the order they were pinned", () => {
    setPinned(ref("one"), true);
    setPinned(ref("two"), true);
    setPinned(ref("three"), true);
    setPinned(ref("two"), false);
    expect(readPins().map((p) => p.slug)).toEqual(["one", "three"]);
    setPinned(ref("two"), true);
    expect(readPins().map((p) => p.slug)).toEqual(["one", "three", "two"]);
  });

  it("writes nothing when the state doesn't change, so a repeat can't reorder", () => {
    setPinned(ref("one"), true);
    setPinned(ref("two"), true);
    const before = fs.readFileSync(pinsPath(), "utf8");
    setPinned(ref("one"), true);
    setPinned(ref("none"), false);
    expect(fs.readFileSync(pinsPath(), "utf8")).toBe(before);
  });

  it("skips malformed lines", () => {
    setPinned(ref("one"), true);
    fs.appendFileSync(pinsPath(), "not json\n{\"slug\":5}\n");
    expect(readPins().map((p) => p.slug)).toEqual(["one"]);
  });

  it("lifts pins out of the page, follows the newest revision, and doesn't move on resubmit", () => {
    appendFeedEntry(entry("board", 1, 1));
    appendFeedEntry(entry("old", 1, 2));
    appendFeedEntry(entry("new", 1, 3));
    const pins = [ref("board")];
    expect(queryFeed({ pins }).entries.map((e) => e.slug)).toEqual(["new", "old"]);

    appendFeedEntry(entry("board", 2, 4));
    const page = queryFeed({ pins });
    expect(page.pinned.map((e) => e.id)).toEqual(["art_board_2"]);
    expect(page.entries.map((e) => e.slug)).toEqual(["new", "old"]);
    expect(page.total).toBe(3);
    expect(page.all).toBe(3);
  });

  it("applies filters to pins, still counts them in facets, and pages only the rest", () => {
    appendFeedEntry(entry("board", 1, 1, { tags: ["ops"] }));
    appendFeedEntry(entry("b", 1, 2));
    appendFeedEntry(entry("c", 1, 3));
    const pins = [ref("board"), ref("gone")];

    expect(queryFeed({ pins, tag: "other" }).pinned).toEqual([]);
    expect(queryFeed({ pins, q: "board" }).pinned.map((e) => e.slug)).toEqual(["board"]);
    expect(queryFeed({ pins }).tags).toEqual([{ tag: "ops", count: 1 }]);

    const first = queryFeed({ pins, limit: 1 });
    expect(first.entries.map((e) => e.slug)).toEqual(["c"]);
    expect(first.nextCursor).toBe(1);
    const second = queryFeed({ pins, limit: 1, cursor: 1 });
    expect(second.entries.map((e) => e.slug)).toEqual(["b"]);
    expect(second.nextCursor).toBeNull();
  });

  it("leaves everything in the list when no pins are passed, as the CLI does", () => {
    appendFeedEntry(entry("board", 1, 1));
    setPinned(ref("board"), true);
    const page = queryFeed();
    expect(page.pinned).toEqual([]);
    expect(page.entries.map((e) => e.slug)).toEqual(["board"]);
  });

  it("drops a forgotten project's pins and only that project's", () => {
    appendFeedEntry(entry("board", 1, 1));
    fs.mkdirSync(path.join(root, "store"), { recursive: true });
    setPinned(ref("board"), true);
    setPinned({ projectId: "proj_b", slug: "other" }, true);
    forgetProjectArtifacts("proj_a");
    expect(readPins()).toEqual([{ projectId: "proj_b", slug: "other" }]);
  });
});

describe("pin route", () => {
  const allowed = { "content-type": "application/json", "x-artifacts-share": "1" };
  let server: http.Server;
  let base: string;
  let root: string;
  let dist: string;

  beforeAll(async () => {
    dist = tempProjectDir();
    server = http.createServer((req, res) => void handle(req, res, { dist }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dist, { recursive: true, force: true });
  });
  beforeEach(() => {
    root = tempStorageRoot();
    appendFeedEntry(entry("board", 1, 1, { origin: { kind: "herdr", paneId: "w1:p2", sessionId: "sess-secret" } }));
    appendFeedEntry(entry("note", 1, 2));
  });
  afterEach(() => rmStorageRoot(root));

  const pin = (id: string, body: unknown, headers: Record<string, string> = allowed) =>
    fetch(`${base}/api/entry/${id}/pin`, { method: "POST", headers, body: JSON.stringify(body) });

  it("pins, moves the card, and changes both ETags so polls notice", async () => {
    const feedBefore = await fetch(`${base}/api/feed`);
    const detailBefore = await fetch(`${base}/api/entry/art_board_1`);
    expect((await detailBefore.json()).pinned).toBe(false);

    const res = await pin("art_board_1", { pinned: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pinned: true });

    const feed = await fetch(`${base}/api/feed`, { headers: { "if-none-match": feedBefore.headers.get("etag")! } });
    expect(feed.status).toBe(200);
    const page = await feed.json();
    expect(page.pinned.map((e: FeedEntry) => e.slug)).toEqual(["board"]);
    expect(page.entries.map((e: FeedEntry) => e.slug)).toEqual(["note"]);

    const detail = await fetch(`${base}/api/latest/proj_a/board`, { headers: { "if-none-match": detailBefore.headers.get("etag")! } });
    expect(detail.status).toBe(200);
    expect((await detail.json()).pinned).toBe(true);

    await pin("art_board_1", { pinned: false });
    expect((await (await fetch(`${base}/api/feed`)).json()).pinned).toEqual([]);
  });

  it("never exposes which pane or session made a pinned artifact", async () => {
    await pin("art_board_1", { pinned: true });
    const text = await (await fetch(`${base}/api/feed`)).text();
    expect(text).not.toContain("sess-secret");
    expect(text).not.toContain("w1:p2");
  });

  it("refuses cross-site and headerless writes", async () => {
    expect((await pin("art_board_1", { pinned: true }, { ...allowed, origin: "https://evil.example" })).status).toBe(403);
    expect((await pin("art_board_1", { pinned: true }, { "content-type": "application/json" })).status).toBe(403);
    expect(readPins()).toEqual([]);
  });

  it("reports bad input and missing artifacts", async () => {
    expect((await pin("art_board_1", { pinned: "yes" })).status).toBe(400);
    expect((await pin("art_none", { pinned: true })).status).toBe(404);
    expect(readPins()).toEqual([]);
  });
});
