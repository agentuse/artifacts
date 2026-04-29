import { describe, expect, it } from "vitest";
import { buildSafeSrcdoc, scrubHtml, META_CSP, ARTIFACT_RUNTIME_SHIM } from "../src/sanitize";

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

  it("preserves benign <link rel=stylesheet> attribute", () => {
    // Stylesheet links are not stripped; the meta-CSP allows style-src https:
    // so external CSS will load (designs commonly use Google Fonts, Tailwind
    // Play, etc.). connect-src 'none' still prevents JS exfil.
    const out = scrubHtml(`<link rel="stylesheet" href="x.css">`);
    expect(out).toContain("<link");
  });

  it("space-separated rel still matched", () => {
    const out = scrubHtml(`<link rel="stylesheet preload" href="x">`);
    expect(out).not.toContain("<link");
  });

  it("retargets external <a href> to open in a new tab", () => {
    const out = scrubHtml(`<a href="https://example.com/page">x</a>`);
    expect(out).toContain(`target="_blank"`);
    expect(out).toMatch(/rel="[^"]*\bnoopener\b[^"]*"/);
    expect(out).toMatch(/rel="[^"]*\bnoreferrer\b[^"]*"/);
  });

  it("retargets protocol-relative and mailto/tel anchors", () => {
    for (const href of ["//example.com", "mailto:a@b.c", "tel:+15551234"]) {
      const out = scrubHtml(`<a href="${href}">x</a>`);
      expect(out).toContain(`target="_blank"`);
    }
  });

  it("leaves relative and fragment anchors alone", () => {
    const out = scrubHtml(`<a href="#section">x</a><a href="/local">y</a><a href="rel.html">z</a>`);
    expect(out).not.toContain(`target="_blank"`);
  });

  it("preserves existing rel tokens when adding noopener/noreferrer", () => {
    const out = scrubHtml(`<a href="https://example.com" rel="nofollow">x</a>`);
    expect(out).toMatch(/rel="[^"]*\bnofollow\b[^"]*"/);
    expect(out).toMatch(/rel="[^"]*\bnoopener\b[^"]*"/);
    expect(out).toMatch(/rel="[^"]*\bnoreferrer\b[^"]*"/);
  });
});

describe("buildSafeSrcdoc", () => {
  it("injects meta-CSP and artifact runtime shim into <head>", () => {
    const out = buildSafeSrcdoc(`<html><head><title>t</title></head><body>x</body></html>`);
    expect(out).toContain(`http-equiv="Content-Security-Policy"`);
    expect(out).toContain(META_CSP);
    expect(out).toContain(ARTIFACT_RUNTIME_SHIM);
    expect(out.indexOf(`http-equiv="Content-Security-Policy"`)).toBeLessThan(
      out.indexOf(ARTIFACT_RUNTIME_SHIM),
    );
  });

  it("creates <head> if missing", () => {
    const out = buildSafeSrcdoc(`<html><body>x</body></html>`);
    expect(out).toContain(`http-equiv="Content-Security-Policy"`);
  });

  it("wraps fragments", () => {
    const out = buildSafeSrcdoc(`<p>hi</p>`);
    expect(out).toContain(META_CSP);
    expect(out).toContain(ARTIFACT_RUNTIME_SHIM);
    expect(out).toContain("<p>hi</p>");
  });

  it("runtime shim covers sandbox-hostile storage and clipboard APIs", () => {
    expect(ARTIFACT_RUNTIME_SHIM).toContain(`installStorageShim("localStorage")`);
    expect(ARTIFACT_RUNTIME_SHIM).toContain(`installStorageShim("sessionStorage")`);
    expect(ARTIFACT_RUNTIME_SHIM).toContain("writeText");
    expect(ARTIFACT_RUNTIME_SHIM).toContain("execCommand");
  });

  it("scrubs and CSP-injects in one pass", () => {
    const out = buildSafeSrcdoc(
      `<html><head><meta http-equiv="refresh" content="0;url=x"></head><body><img src="https://attacker.test/?leak"></body></html>`,
    );
    expect(out.toLowerCase()).not.toContain("refresh");
    expect(out).toContain(META_CSP);
    // Image stays in DOM; CSP img-src https: data: allows it to load.
    expect(out).toContain("attacker.test");
  });
});

describe("META_CSP", () => {
  it("blocks fetch/XHR/WebSocket via connect-src 'none'", () => {
    expect(META_CSP).toContain("connect-src 'none'");
  });

  it("permits external https for script/style/font/img so CDN designs render", () => {
    expect(META_CSP).toMatch(/script-src[^;]*\bhttps:/);
    expect(META_CSP).toMatch(/style-src[^;]*\bhttps:/);
    expect(META_CSP).toMatch(/font-src[^;]*\bhttps:/);
    expect(META_CSP).toMatch(/img-src[^;]*\bhttps:/);
  });

  it("denies framing children and plugin objects", () => {
    expect(META_CSP).toContain("frame-src 'none'");
    expect(META_CSP).toContain("object-src 'none'");
    expect(META_CSP).toContain("base-uri 'none'");
  });
});
