import { describe, expect, it } from "vitest";
import { buildSafeSrcdoc, scrubHtml, META_CSP } from "../src/sanitize";

describe("scrubHtml", () => {
  it("strips meta http-equiv=refresh", () => {
    const out = scrubHtml(`<html><head><meta http-equiv="refresh" content="0;url=https://x"></head><body>ok</body></html>`);
    expect(out.toLowerCase()).not.toContain("refresh");
  });

  it("strips meta refresh with mixed case and spacing", () => {
    const out = scrubHtml(`<meta HTTP-EQUIV = "Refresh" content="0">`);
    expect(out.toLowerCase()).not.toContain("refresh");
  });

  it("strips <base>", () => {
    const out = scrubHtml(`<head><base href="https://attacker.test/"></head>`);
    expect(out.toLowerCase()).not.toContain("<base");
  });

  it("strips <link rel=preload/prefetch/dns-prefetch/preconnect>", () => {
    for (const rel of ["preload", "prefetch", "dns-prefetch", "preconnect", "modulepreload"]) {
      const out = scrubHtml(`<link rel="${rel}" href="https://x">`);
      expect(out).not.toContain("<link");
    }
  });

  it("preserves benign <link rel=stylesheet> attribute (CSP blocks the network)", () => {
    // Stylesheet links are not stripped; the meta-CSP style-src 'unsafe-inline'
    // (no remote origin) prevents the actual fetch. We do not strip because
    // some authors include them legitimately for offline screenshots.
    const out = scrubHtml(`<link rel="stylesheet" href="x.css">`);
    expect(out).toContain("<link");
  });

  it("space-separated rel still matched", () => {
    const out = scrubHtml(`<link rel="stylesheet preload" href="x">`);
    expect(out).not.toContain("<link");
  });
});

describe("buildSafeSrcdoc", () => {
  it("injects meta-CSP into <head>", () => {
    const out = buildSafeSrcdoc(`<html><head><title>t</title></head><body>x</body></html>`);
    expect(out).toContain(`http-equiv="Content-Security-Policy"`);
    expect(out).toContain(META_CSP);
  });

  it("creates <head> if missing", () => {
    const out = buildSafeSrcdoc(`<html><body>x</body></html>`);
    expect(out).toContain(`http-equiv="Content-Security-Policy"`);
  });

  it("wraps fragments", () => {
    const out = buildSafeSrcdoc(`<p>hi</p>`);
    expect(out).toContain(META_CSP);
    expect(out).toContain("<p>hi</p>");
  });

  it("scrubs and CSP-injects in one pass", () => {
    const out = buildSafeSrcdoc(
      `<html><head><meta http-equiv="refresh" content="0;url=x"></head><body><img src="https://attacker.test/?leak"></body></html>`,
    );
    expect(out.toLowerCase()).not.toContain("refresh");
    expect(out).toContain(META_CSP);
    // Image stays in DOM; CSP img-src data: blocks the network.
    expect(out).toContain("attacker.test");
  });
});
