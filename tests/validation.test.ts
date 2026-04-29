import { describe, expect, it } from "vitest";
import { inferType } from "../src/validation";
import { CliError } from "../src/errors";

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
