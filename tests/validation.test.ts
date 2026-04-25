import { describe, expect, it } from "vitest";
import { resolveLogicalName, validateName, inferType } from "../src/validation";
import { CliError } from "../src/errors";

describe("validateName", () => {
  it("rejects absolute paths", () => {
    expect(() => validateName("/etc/passwd")).toThrow(CliError);
    expect(() => validateName("C:/x")).toThrow(CliError);
  });

  it("rejects .. segments", () => {
    expect(() => validateName("../etc/passwd")).toThrow(CliError);
    expect(() => validateName("a/../b")).toThrow(CliError);
  });

  it("rejects control characters", () => {
    expect(() => validateName("a\x00b")).toThrow(CliError);
  });

  it("rejects empty after normalization", () => {
    expect(() => validateName("./")).toThrow(CliError);
  });

  it("rejects > 512 bytes", () => {
    expect(() => validateName("a".repeat(513))).toThrow(CliError);
  });

  it("normalizes backslashes and ./", () => {
    expect(validateName("./foo\\bar.md")).toBe("foo/bar.md");
  });

  it("accepts simple names", () => {
    expect(validateName("docs/spec.md")).toBe("docs/spec.md");
    expect(validateName("prd.md")).toBe("prd.md");
  });
});

describe("resolveLogicalName", () => {
  it("requires --name on stdin", () => {
    expect(() =>
      resolveLogicalName({ projectPath: "/tmp", isStdin: true }),
    ).toThrow(CliError);
  });

  it("uses basename for outside-project sources", () => {
    expect(
      resolveLogicalName({
        projectPath: "/tmp/proj-A",
        resolvedSource: "/tmp/elsewhere/report.md",
        isStdin: false,
      }),
    ).toBe("report.md");
  });

  it("uses project-relative path for inside-project sources", () => {
    expect(
      resolveLogicalName({
        projectPath: "/tmp/proj-A",
        resolvedSource: "/tmp/proj-A/docs/spec.md",
        isStdin: false,
      }),
    ).toBe("docs/spec.md");
  });

  it("rejects malicious explicit names", () => {
    expect(() =>
      resolveLogicalName({
        explicitName: "../../etc/passwd",
        projectPath: "/tmp",
        isStdin: true,
      }),
    ).toThrow(CliError);
  });
});

describe("inferType", () => {
  it("md/markdown", () => {
    expect(inferType("a.md")).toBe("markdown");
    expect(inferType("a.markdown")).toBe("markdown");
  });
  it("html/htm", () => {
    expect(inferType("a.html")).toBe("html");
    expect(inferType("a.htm")).toBe("html");
  });
  it("rejects others", () => {
    expect(() => inferType("a.png")).toThrow(CliError);
    expect(() => inferType("a")).toThrow(CliError);
  });
});
