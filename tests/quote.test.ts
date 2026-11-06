import { describe, expect, it } from "vitest";
import { buildQuote } from "../viewer/src/quote";

describe("buildQuote", () => {
  it("ignores a selection with nothing in it", () => {
    expect(buildQuote("  \n ", "before", "after")).toBeNull();
  });

  it("trims the passage and collapses whitespace in its context", () => {
    expect(buildQuote("  Churn is flat. ", "## Risks\n\n  ", "\n\nNext  section ")).toEqual({
      text: "Churn is flat.",
      before: "## Risks ",
      after: " Next section",
    });
  });

  it("keeps the space around a passage in its context, so words don't read as joined", () => {
    expect(buildQuote(" ship it ", "We", "today")).toEqual({ text: "ship it", before: "We ", after: " today" });
  });

  it("keeps only the words nearest the passage", () => {
    const quote = buildQuote("x", `${"far ".repeat(50)}near`, `near${" far".repeat(50)}`)!;
    expect(quote.before?.length).toBeLessThanOrEqual(80);
    expect(quote.before?.endsWith("near")).toBe(true);
    expect(quote.after?.startsWith("near")).toBe(true);
    expect(quote.after?.length).toBeLessThanOrEqual(80);
  });

  it("omits empty context at the start or end of a document", () => {
    expect(buildQuote("all of it", "", "")).toEqual({ text: "all of it" });
  });

  it("clips a long selection under the server's limit, even in multi-byte text", () => {
    const quote = buildQuote("字".repeat(5000), "", "")!;
    expect(quote.text.endsWith("…")).toBe(true);
    expect(Buffer.byteLength(quote.text)).toBeLessThanOrEqual(3072);
  });

  it("never leaves half an emoji behind", () => {
    const clipped = buildQuote("😀".repeat(600), "", "")!.text.slice(0, -1);
    expect(clipped).toBe("😀".repeat(500));
    const context = buildQuote("x", "😀".repeat(100), "😀".repeat(100))!;
    expect(context.before).not.toMatch(/^[\uDC00-\uDFFF]/);
    expect(context.after).not.toMatch(/[\uD800-\uDBFF]$/);
  });
});
