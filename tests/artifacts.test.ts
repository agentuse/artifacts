import { describe, expect, it } from "vitest";
import { viewerArtifactUrl, viewerProjectUrl } from "../src/artifacts";

describe("viewer URL helpers", () => {
  it("builds a project home URL", () => {
    expect(viewerProjectUrl({ port: 7878 }, "proj_abc")).toBe(
      "http://127.0.0.1:7878/p/proj_abc",
    );
  });

  it("encodes the artifact name into an /a/:name link", () => {
    expect(viewerArtifactUrl({ port: 7878 }, "proj_abc", "docs/report.md")).toBe(
      "http://127.0.0.1:7878/p/proj_abc/a/docs%2Freport.md",
    );
  });

  it("appends ?full=1 when full is requested", () => {
    expect(
      viewerArtifactUrl({ port: 7878 }, "proj_abc", "docs/report.md", { full: true }),
    ).toBe("http://127.0.0.1:7878/p/proj_abc/a/docs%2Freport.md?full=1");
  });

  it("omits the query when full is false", () => {
    expect(
      viewerArtifactUrl({ port: 7878 }, "proj_abc", "report.md", { full: false }),
    ).toBe("http://127.0.0.1:7878/p/proj_abc/a/report.md");
  });
});
