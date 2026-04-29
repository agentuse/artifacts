import { describe, expect, it } from "vitest";
import { validateName, inferType } from "../src/validation";
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

describe("inferType", () => {
  it("md/markdown", () => {
    expect(inferType("a.md")).toBe("markdown");
    expect(inferType("a.markdown")).toBe("markdown");
  });
  it("html/htm", () => {
    expect(inferType("a.html")).toBe("html");
    expect(inferType("a.htm")).toBe("html");
  });
  it("png/jpg/jpeg/webp", () => {
    expect(inferType("a.png")).toBe("png");
    expect(inferType("a.jpg")).toBe("jpg");
    expect(inferType("a.jpeg")).toBe("jpg");
    expect(inferType("a.webp")).toBe("webp");
  });
  it("pdf", () => {
    expect(inferType("a.pdf")).toBe("pdf");
  });
  it("rejects others", () => {
    expect(() => inferType("a.svg")).toThrow(CliError);
    expect(() => inferType("a.gif")).toThrow(CliError);
    expect(() => inferType("a")).toThrow(CliError);
  });
});
