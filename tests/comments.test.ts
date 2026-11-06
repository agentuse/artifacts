import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addComment,
  commentsFor,
  markCommentsNotified,
  openCommentsFor,
  readComments,
  resolveComments,
} from "../src/comments.js";
import { commentsPath } from "../src/paths.js";
import { forgetProjectArtifacts, submitArtifact } from "../src/store.js";
import { rmStorageRoot, tempProjectDir, tempStorageRoot } from "./helpers.js";

const entry = { projectId: "proj_a", slug: "report", rev: 2 };

describe("comments", () => {
  let root: string;
  beforeEach(() => {
    root = tempStorageRoot();
  });
  afterEach(() => rmStorageRoot(root));

  it("records which revision was on screen and carries across revisions", () => {
    const first = addComment(entry, "  fix the chart  ");
    addComment({ ...entry, rev: 3 }, "and the title");
    expect(first.body).toBe("fix the chart");
    expect(commentsFor("proj_a", "report").map((c) => c.rev)).toEqual([2, 3]);
  });

  it("folds later state onto the comment without rewriting the log", () => {
    const comment = addComment(entry, "hi");
    const before = fs.readFileSync(commentsPath(), "utf8");
    markCommentsNotified([comment.id]);
    resolveComments([comment.id]);
    expect(fs.readFileSync(commentsPath(), "utf8").startsWith(before)).toBe(true);
    const [folded] = readComments();
    expect(folded?.notifiedAt).toBeTruthy();
    expect(folded?.resolvedAt).toBeTruthy();
    expect(openCommentsFor("proj_a", "report")).toEqual([]);
  });

  it("refuses empty and oversized comments, and an unknown id in a resolve", () => {
    expect(() => addComment(entry, "   ")).toThrow("Write a comment first");
    expect(() => addComment(entry, "x".repeat(4097))).toThrow("too long");
    expect(fs.existsSync(commentsPath())).toBe(false);
    expect(() => resolveComments(["cmt_missing"])).toThrow("no such comment");
  });

  it("refuses a comment whose JSON escaping would break the atomic line limit", () => {
    expect(() => addComment(entry, '"'.repeat(4096))).toThrow("too long");
    expect(readComments()).toEqual([]);
  });

  it("skips malformed lines instead of failing", () => {
    const comment = addComment(entry, "kept");
    fs.appendFileSync(commentsPath(), 'not json\n{"type":"comment","id":5}\n');
    expect(readComments().map((c) => c.id)).toEqual([comment.id]);
  });

  it("forgetting a project drops its comments and their state, and no one else's", async () => {
    const dir = tempProjectDir();
    fs.writeFileSync(path.join(dir, "a.md"), "# A");
    const { entry: submitted } = await submitArtifact({ target: path.join(dir, "a.md") });
    const mine = addComment(submitted, "mine");
    resolveComments([mine.id]);
    const other = addComment(entry, "other project");
    await forgetProjectArtifacts(submitted.projectId);
    expect(readComments().map((c) => c.id)).toEqual([other.id]);
    expect(fs.readFileSync(commentsPath(), "utf8")).not.toContain(mine.id);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
