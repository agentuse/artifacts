import { parse, HTMLElement, Node, NodeType } from "node-html-parser";

// CSP applied to the iframe document that renders an HTML artifact.
//
// Threat model: the agent that wrote the artifact is the developer's own, but
// its inputs (web pages, PRs, docs the agent reads) are not. The realistic
// risk is prompt-injection routing through the agent into artifact markup.
//
// The iframe is loaded with sandbox="allow-scripts" (no allow-same-origin), so
// scripts run in an opaque origin and cannot reach the parent viewer DOM,
// localStorage, or cookies. What scripts CAN still do without further limits
// is fetch arbitrary URLs (data exfil + localhost/LAN scan). We block that
// with connect-src 'none'. External https for script/style/font/img is
// allowed so designs that pull from CDNs (Tailwind Play, Google Fonts) and
// inline their config render correctly.
export const META_CSP =
  "default-src 'none'; " +
  "script-src 'unsafe-inline' 'unsafe-eval' https:; " +
  "style-src 'self' 'unsafe-inline' https:; " +
  "font-src 'self' https: data:; " +
  "img-src 'self' https: data: blob:; " +
  "connect-src 'none'; " +
  "frame-src 'none'; " +
  "object-src 'none'; " +
  "base-uri 'none'";

const PRELOAD_REL = new Set(["preload", "prefetch", "dns-prefetch", "preconnect", "modulepreload"]);

/**
 * Remove the inert exfiltration vectors that survive even with no scripts:
 * <meta http-equiv="refresh">, <base>, and <link rel> in the preload family.
 *
 * Implementation uses an HTML parser, not regex, so attribute-quoting tricks
 * (`<meta http-equiv = "refresh">`, mixed case, missing quotes) cannot bypass.
 */
export function scrubHtml(input: string): string {
  const root = parse(input, {
    lowerCaseTagName: false,
    comment: true,
  });

  const walk = (node: Node): void => {
    // Iterate over a copy because we mutate.
    const children = [...node.childNodes];
    for (const child of children) {
      if (child.nodeType !== NodeType.ELEMENT_NODE) continue;
      const el = child as HTMLElement;
      const tag = el.tagName?.toLowerCase();
      if (!tag) continue;
      if (shouldRemove(tag, el)) {
        el.remove();
        continue;
      }
      walk(el);
    }
  };
  walk(root);
  return root.toString();
}

function shouldRemove(tag: string, el: HTMLElement): boolean {
  if (tag === "base") return true;
  if (tag === "meta") {
    const httpEquiv = (el.getAttribute("http-equiv") ?? "").toLowerCase().trim();
    return httpEquiv === "refresh";
  }
  if (tag === "link") {
    const rel = (el.getAttribute("rel") ?? "").toLowerCase().trim();
    if (!rel) return false;
    // rel can be a space-separated list.
    return rel.split(/\s+/).some((r) => PRELOAD_REL.has(r));
  }
  return false;
}

/**
 * Wrap arbitrary HTML for safe rendering inside an iframe.
 *
 *  1. Scrub: strip meta-refresh, <base>, and preload-family <link>.
 *  2. Inject a <meta http-equiv="Content-Security-Policy">. The server also
 *     sends the same policy as a response header — the meta tag is defense
 *     in depth (it survives if the file is saved, opened directly, etc.).
 */
export function buildSafeSrcdoc(input: string): string {
  const scrubbed = scrubHtml(input);
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${META_CSP}">`;

  // If the document has a <head>, inject as the first child of head; otherwise
  // prepend a synthetic <head>.
  const lower = scrubbed.toLowerCase();
  const headIdx = lower.indexOf("<head>");
  if (headIdx >= 0) {
    const insertAt = headIdx + "<head>".length;
    return scrubbed.slice(0, insertAt) + cspMeta + scrubbed.slice(insertAt);
  }
  const htmlIdx = lower.indexOf("<html");
  if (htmlIdx >= 0) {
    const closeBracket = scrubbed.indexOf(">", htmlIdx);
    if (closeBracket > 0) {
      return (
        scrubbed.slice(0, closeBracket + 1) +
        `<head>${cspMeta}</head>` +
        scrubbed.slice(closeBracket + 1)
      );
    }
  }
  return `<!DOCTYPE html><html><head>${cspMeta}</head><body>${scrubbed}</body></html>`;
}
