import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readComments } from "../src/comments.js";
import { appendFeedEntry, type FeedEntry } from "../src/feed.js";
import { handle } from "../src/server.js";
import { rmStorageRoot, tempProjectDir, tempStorageRoot } from "./helpers.js";

const entry: FeedEntry = {
  id: "art_1", projectId: "proj_a", projectName: "a", slug: "report", rev: 1, title: "T", tags: [],
  type: "markdown", entry: "a.md", files: 1, size: 1, contentHash: "h", sourcePath: "/a.md",
  submittedAt: new Date().toISOString(),
  origin: { kind: "herdr", paneId: "w1:p2", sessionId: "sess-secret" },
};
const allowed = { "content-type": "application/json", "x-artifacts-share": "1" };

describe("comment routes", () => {
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
    appendFeedEntry(entry);
  });
  afterEach(() => rmStorageRoot(root));

  const post = (url: string, body: unknown, headers: Record<string, string> = allowed) =>
    fetch(base + url, { method: "POST", headers, body: JSON.stringify(body) });

  it("adds, lists and resolves a comment, and changes the entry's ETag each time", async () => {
    const first = await fetch(`${base}/api/entry/art_1`);
    const etag = first.headers.get("etag")!;
    expect((await first.json()).comments).toEqual([]);

    const created = await post("/api/entry/art_1/comments", { body: "fix it" });
    expect(created.status).toBe(200);
    const comment = await created.json();
    expect(comment).toMatchObject({ body: "fix it", rev: 1 });

    const after = await fetch(`${base}/api/entry/art_1`, { headers: { "if-none-match": etag } });
    expect(after.status).toBe(200);
    expect((await after.json()).comments).toHaveLength(1);

    const resolved = await post(`/api/comments/${comment.id}/resolve`, {});
    expect((await resolved.json()).resolvedAt).toBeTruthy();
  });

  it("saves a highlighted passage and rejects a bad one", async () => {
    const created = await post("/api/entry/art_1/comments", { body: "too strong", quote: { text: "Churn is flat.", before: "Risks" } });
    expect(await created.json()).toMatchObject({ quote: { text: "Churn is flat.", before: "Risks" } });
    expect((await post("/api/entry/art_1/comments", { body: "x", quote: { text: " " } })).status).toBe(400);
  });

  it("refuses cross-site, rebound and headerless writes", async () => {
    const attempts: Array<Record<string, string>> = [
      { ...allowed, origin: "https://evil.example" },
      { "content-type": "application/json" },
      { "x-artifacts-share": "1", "content-type": "text/plain" },
    ];
    for (const headers of attempts) {
      expect((await post("/api/entry/art_1/comments", { body: "forged" }, headers)).status).toBe(403);
    }
    const rebound = await new Promise<number>((resolve) => {
      const req = http.request(`${base}/api/entry/art_1/comments`, {
        method: "POST",
        headers: { ...allowed, host: "evil.example" },
      }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.end('{"body":"forged"}');
    });
    expect(rebound).toBe(403);
    expect(readComments()).toEqual([]);
  });

  it("reports bad input and missing artifacts", async () => {
    expect((await post("/api/entry/art_1/comments", { body: "  " })).status).toBe(400);
    expect((await post("/api/entry/art_1/comments", { body: 5 })).status).toBe(400);
    expect((await post("/api/entry/art_none/comments", { body: "x" })).status).toBe(404);
    expect((await post("/api/comments/cmt_abc/resolve", {})).status).toBe(400);
    const huge = await fetch(`${base}/api/entry/art_1/comments`, { method: "POST", headers: allowed, body: "x".repeat(70_000) });
    expect(huge.status).toBe(400);
  });

  it("never exposes which pane or session made an artifact", async () => {
    for (const url of ["/api/feed", "/api/entry/art_1", "/api/latest/proj_a/report"]) {
      const text = await (await fetch(base + url)).text();
      expect(text).not.toContain("sess-secret");
      expect(text).not.toContain("w1:p2");
    }
  });
});
