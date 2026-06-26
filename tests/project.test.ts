import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandHomePath, resolveProject } from "../src/project";

describe("expandHomePath", () => {
  it("expands shell-style home aliases", () => {
    expect(expandHomePath("~")).toBe(os.homedir());
    expect(expandHomePath("~/workspace/demo")).toBe(path.join(os.homedir(), "workspace/demo"));
  });

  it("leaves ordinary paths untouched", () => {
    expect(expandHomePath("/tmp/demo")).toBe("/tmp/demo");
    expect(expandHomePath("./demo")).toBe("./demo");
  });
});

describe("resolveProject git worktrees", () => {
  let tmp: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "ignore"] });

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "artifacts-wt-")));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("gives a linked worktree its own projectId without clobbering the main repo", () => {
    const main = path.join(tmp, "repo");
    fs.mkdirSync(main);
    git(main, "init", "-q");
    git(main, "config", "user.email", "t@t.test");
    git(main, "config", "user.name", "Test");
    fs.writeFileSync(path.join(main, "README.md"), "hi\n");
    git(main, "add", ".");
    git(main, "commit", "-q", "-m", "init");

    const wt = path.join(tmp, "wt-feature");
    git(main, "worktree", "add", "-q", wt, "-b", "feature");

    const mainProj = resolveProject(main);
    const wtProj = resolveProject(wt);

    // Both share the same first commit, so the buggy behavior was identical ids.
    expect(wtProj.projectId).not.toBe(mainProj.projectId);
    expect(mainProj.path).toBe(main);
    expect(wtProj.path).toBe(wt);

    // The main checkout id must stay keyed purely on the first commit so
    // existing registrations remain stable.
    expect(resolveProject(main).projectId).toBe(mainProj.projectId);
  });
});
