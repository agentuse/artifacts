import { describe, expect, it } from "vitest";
import { viewerEntryUrl, viewerFeedUrl } from "../src/artifacts";

describe("viewer URL helpers", () => {
  it("builds the unfiltered feed URL", () => {
    expect(viewerFeedUrl({ port: 7878 })).toBe("http://127.0.0.1:7878/");
  });

  it("puts the project filter in the query", () => {
    expect(viewerFeedUrl({ port: 7878 }, { projectId: "proj_abc" })).toBe(
      "http://127.0.0.1:7878/?project=proj_abc",
    );
  });

  it("combines project and tag filters", () => {
    expect(viewerFeedUrl({ port: 7878 }, { projectId: "proj_abc", tag: "weekly" })).toBe(
      "http://127.0.0.1:7878/?project=proj_abc&tag=weekly",
    );
  });

  it("links to a single entry by id", () => {
    expect(viewerEntryUrl({ port: 7878 }, "art_0123456789abcdef")).toBe(
      "http://127.0.0.1:7878/a/art_0123456789abcdef",
    );
  });
});
