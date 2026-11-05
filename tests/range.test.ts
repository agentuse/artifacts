import { describe, expect, it } from "vitest";
import { parseRange } from "../src/server";

describe("parseRange", () => {
  it("no header serves the whole file", () => {
    expect(parseRange(undefined, 100)).toBeNull();
  });
  it("open-ended and closed ranges", () => {
    expect(parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
  });
  it("suffix range", () => {
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
  });
  it("unsatisfiable", () => {
    expect(parseRange("bytes=100-", 100)).toBe("bad");
    expect(parseRange("bytes=20-10", 100)).toBe("bad");
  });
  it("multi-range falls back to the whole file", () => {
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
  });
});
