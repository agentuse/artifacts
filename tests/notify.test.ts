import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addComment, readComments, resolveComments } from "../src/comments.js";
import { appendFeedEntry, type FeedEntry } from "../src/feed.js";
import { captureOrigin, deliverPendingComments, notificationText, type AgentOrigin } from "../src/notify.js";
import { rmStorageRoot, tempProjectDir, tempStorageRoot } from "./helpers.js";

/**
 * A real executable stands in for herdr, so argument passing, exit codes and
 * stderr parsing run the way they do in the server. It answers from scenario
 * files and logs every call.
 */
function fakeHerdr(dir: string, get: string, promptError?: string): string {
  const log = path.join(dir, "calls.log");
  const bin = path.join(dir, "herdr");
  fs.writeFileSync(path.join(dir, "get.txt"), get);
  fs.writeFileSync(path.join(dir, "prompt-error.txt"), promptError ?? "");
  fs.writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
if [ "$2" = get ]; then
  case "$(cat "${dir}/get.txt")" in
    GONE) echo '{"error":{"code":"agent_not_found"}}' >&2; exit 1;;
    *) cat "${dir}/get.txt"; exit 0;;
  esac
fi
if [ -s "${dir}/prompt-error.txt" ]; then cat "${dir}/prompt-error.txt" >&2; exit 1; fi
echo '{"result":{}}'
`, { mode: 0o755 });
  process.env.HERDR_BIN_PATH = bin;
  return log;
}

const agentJson = (session: string) => JSON.stringify({ result: { agent: { agent_session: { value: session } } } });
const origin: AgentOrigin = { kind: "herdr", paneId: "w1:p2", sessionId: "sess-1" };

function feedLine(rev: number, withOrigin?: AgentOrigin): FeedEntry {
  return {
    id: `art_${rev}`, projectId: "proj_a", projectName: "a", slug: "report", rev, title: "T", tags: [],
    type: "markdown", entry: "a.md", files: 1, size: 1, contentHash: "h", sourcePath: "/a.md",
    submittedAt: new Date().toISOString(), ...(withOrigin ? { origin: withOrigin } : {}),
  };
}

const prompts = (log: string) =>
  (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "").split("\n").filter((l) => l.includes("agent prompt"));

describe("comment delivery", () => {
  let root: string;
  let dir: string;
  beforeEach(() => {
    root = tempStorageRoot();
    dir = tempProjectDir();
  });
  afterEach(() => {
    delete process.env.HERDR_BIN_PATH;
    rmStorageRoot(root);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sends one pointer per artifact, never the comment text, and only once", async () => {
    const log = fakeHerdr(dir, agentJson("sess-1"));
    appendFeedEntry(feedLine(1, origin));
    addComment(feedLine(1), "SECRET-BODY first");
    addComment(feedLine(1), "SECRET-BODY second");
    expect(await deliverPendingComments()).toBe(2);
    const sent = prompts(log);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("agent prompt w1:p2");
    expect(sent[0]).toContain("comments report --project proj_a");
    expect(sent[0]).not.toContain("SECRET-BODY");
    expect(readComments().every((c) => c.notifiedAt)).toBe(true);
    expect(await deliverPendingComments()).toBe(0);
    expect(prompts(log)).toHaveLength(1);
  });

  it("does not write to a pane now running a different agent", async () => {
    const log = fakeHerdr(dir, agentJson("someone-else"));
    appendFeedEntry(feedLine(1, origin));
    addComment(feedLine(1), "hi");
    expect(await deliverPendingComments()).toBe(0);
    expect(prompts(log)).toEqual([]);
    expect(readComments()[0]?.notifiedAt).toBeUndefined();
  });

  it("leaves the comment pending when the agent is gone", async () => {
    const log = fakeHerdr(dir, "GONE");
    appendFeedEntry(feedLine(1, origin));
    addComment(feedLine(1), "hi");
    expect(await deliverPendingComments()).toBe(0);
    expect(prompts(log)).toEqual([]);
  });

  it("retries a blocked agent until it accepts", async () => {
    const log = fakeHerdr(dir, agentJson("sess-1"), '{"error":{"code":"agent_blocked"}}');
    appendFeedEntry(feedLine(1, origin));
    addComment(feedLine(1), "hi");
    expect(await deliverPendingComments()).toBe(0);
    expect(readComments()[0]?.notifiedAt).toBeUndefined();
    fs.writeFileSync(path.join(dir, "prompt-error.txt"), "");
    expect(await deliverPendingComments()).toBe(1);
    expect(prompts(log)).toHaveLength(2);
  });

  it("targets the newest revision's agent, and nobody if that revision has none", async () => {
    const log = fakeHerdr(dir, agentJson("sess-2"));
    appendFeedEntry(feedLine(1, origin));
    appendFeedEntry(feedLine(2, { ...origin, paneId: "w1:p9", sessionId: "sess-2" }));
    addComment(feedLine(1), "on an old revision");
    await deliverPendingComments();
    expect(prompts(log)[0]).toContain("w1:p9");
    appendFeedEntry(feedLine(3));
    addComment(feedLine(3), "newest has no agent");
    expect(await deliverPendingComments()).toBe(0);
  });

  it("skips resolved comments and stops trying after a day", async () => {
    const log = fakeHerdr(dir, agentJson("sess-1"));
    appendFeedEntry(feedLine(1, origin));
    resolveComments([addComment(feedLine(1), "done already").id]);
    expect(await deliverPendingComments()).toBe(0);
    addComment(feedLine(1), "old");
    expect(await deliverPendingComments(Date.now() + 25 * 60 * 60 * 1000)).toBe(0);
    expect(prompts(log)).toEqual([]);
  });

  it("ignores a hand-edited feed line that could smuggle text or flags", async () => {
    const log = fakeHerdr(dir, agentJson("sess-1"));
    appendFeedEntry({ ...feedLine(1, { ...origin, paneId: "--help" }), slug: "ok" });
    appendFeedEntry({ ...feedLine(1, origin), slug: "x\nrm -rf /" });
    addComment({ projectId: "proj_a", slug: "ok", rev: 1 }, "a");
    addComment({ projectId: "proj_a", slug: "x\nrm -rf /", rev: 1 }, "b");
    expect(await deliverPendingComments()).toBe(0);
    expect(prompts(log)).toEqual([]);
  });

  it("captures the pane and session inside Herdr, and nothing outside it or on failure", () => {
    fakeHerdr(dir, agentJson("sess-1"));
    expect(captureOrigin()).toBeUndefined();
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p2";
    try {
      expect(captureOrigin()).toMatchObject({ kind: "herdr", paneId: "w1:p2", sessionId: "sess-1" });
      fs.writeFileSync(path.join(dir, "get.txt"), "GONE");
      expect(captureOrigin()).toBeUndefined();
      process.env.HERDR_BIN_PATH = path.join(dir, "missing");
      expect(captureOrigin()).toBeUndefined();
    } finally {
      delete process.env.HERDR_ENV;
      delete process.env.HERDR_PANE_ID;
    }
  });

  it("names a command that reads the same store from any directory", () => {
    const text = notificationText("proj_a", "report");
    expect(text).toContain("comments report --project proj_a");
    expect(text).toContain(`AGENTUSE_ARTIFACTS_HOME=${root}`);
    process.env.AGENTUSE_ARTIFACTS_HOME = "/tmp/it's a store";
    expect(notificationText("proj_a", "report")).toContain(`AGENTUSE_ARTIFACTS_HOME='/tmp/it'\\''s a store'`);
    process.env.AGENTUSE_ARTIFACTS_HOME = root;
  });
});
