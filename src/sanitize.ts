import { parse, HTMLElement, Node, NodeType } from "node-html-parser";

export const META_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

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
 * Wrap arbitrary HTML for safe rendering inside an iframe srcdoc.
 *
 *  1. Inject a <meta http-equiv="Content-Security-Policy"> with default-src 'none'.
 *     The parent SPA's CSP header does NOT propagate into iframe srcdoc, so we put
 *     it in the document itself.
 *  2. Pre-injection scrub: strip meta-refresh, base, and preload-family <link>.
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
