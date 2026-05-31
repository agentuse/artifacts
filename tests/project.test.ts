import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expandHomePath } from "../src/project";

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
