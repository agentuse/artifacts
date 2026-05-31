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

// HTML artifacts run in a sandboxed iframe without allow-same-origin. That is
// the security boundary, but it also means browser APIs tied to origin/storage
// can be missing or throw SecurityError. Install small same-document shims
// before artifact scripts run:
// - localStorage/sessionStorage become in-memory stores when the browser denies
//   real storage for the sandbox's opaque origin. This prevents one storage read
//   from aborting the whole artifact script before event handlers are attached.
// - navigator.clipboard.writeText uses the legacy copy command synchronously, so
//   artifact buttons keep working during the user's click.
export const ARTIFACT_RUNTIME_SHIM = `<script>
(() => {
  const createMemoryStorage = () => {
    const store = new Map();
    return {
      get length() { return store.size; },
      clear() { store.clear(); },
      getItem(key) {
        key = String(key);
        return store.has(key) ? store.get(key) : null;
      },
      key(index) { return Array.from(store.keys())[Number(index)] ?? null; },
      removeItem(key) { store.delete(String(key)); },
      setItem(key, value) { store.set(String(key), String(value)); },
    };
  };

  const installStorageShim = (name) => {
    try {
      const storage = window[name];
      const testKey = "__agentuse_artifacts_storage_test__";
      storage.setItem(testKey, testKey);
      storage.removeItem(testKey);
    } catch {
      const memoryStorage = createMemoryStorage();
      try {
        Object.defineProperty(window, name, {
          configurable: true,
          enumerable: true,
          get: () => memoryStorage,
        });
      } catch {}
    }
  };

  installStorageShim("localStorage");
  installStorageShim("sessionStorage");

  const copyViaExecCommand = (text) => new Promise((resolve, reject) => {
    const doc = document;
    const root = doc.body || doc.documentElement;
    if (!root || typeof doc.execCommand !== "function") {
      reject(new Error("clipboard copy is not available"));
      return;
    }

    const active = doc.activeElement;
    const selection = typeof doc.getSelection === "function" ? doc.getSelection() : null;
    const ranges = [];
    if (selection) {
      for (let i = 0; i < selection.rangeCount; i += 1) ranges.push(selection.getRangeAt(i));
    }

    const textarea = doc.createElement("textarea");
    textarea.value = String(text ?? "");
    textarea.setAttribute("readonly", "");
    textarea.setAttribute("aria-hidden", "true");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "-9999px";
    textarea.style.width = "1px";
    textarea.style.height = "1px";
    textarea.style.opacity = "0";

    const cleanup = () => {
      textarea.remove();
      if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
      if (active && typeof active.focus === "function") {
        try { active.focus({ preventScroll: true }); } catch { active.focus(); }
      }
    };

    root.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    let ok = false;
    try {
      ok = doc.execCommand("copy");
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }
    cleanup();
    if (ok) {
      resolve();
    } else {
      reject(new Error("clipboard copy was denied"));
    }
  });

  const nativeClipboard = navigator.clipboard;
  const clipboard = nativeClipboard
    ? new Proxy(nativeClipboard, {
        get(target, prop) {
          if (prop === "writeText") return copyViaExecCommand;
          const value = target[prop];
          return typeof value === "function" ? value.bind(target) : value;
        },
      })
    : { writeText: copyViaExecCommand };

  try {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      enumerable: true,
      get: () => clipboard,
    });
  } catch {
    try { navigator.clipboard.writeText = copyViaExecCommand; } catch {}
  }
})();
</script>`;

// Scroll-preservation shim. The artifact iframe is an opaque origin, so the
// parent viewer cannot read contentWindow.scrollY directly. Instead the iframe
// posts its scroll position to the parent on scroll (rAF-throttled), and on
// load it reads `#sy=NNN` from location.hash (set by the parent before src
// change) and scrolls to it. Without this, every hot reload jumps the user
// back to the top of the document.
export const ARTIFACT_SCROLL_SHIM = `<script>
(() => {
  const restoreFromHash = () => {
    try {
      const h = window.location.hash || "";
      if (!h.startsWith("#")) return;
      const params = new URLSearchParams(h.slice(1));
      const sy = Number(params.get("sy"));
      const sx = Number(params.get("sx"));
      if (Number.isFinite(sy) && sy > 0) {
        window.scrollTo({
          left: Number.isFinite(sx) ? sx : 0,
          top: sy,
          behavior: "instant",
        });
      }
    } catch {}
  };

  // Restore as early as possible. Run once now (in case content is already
  // laid out), and again after load (when fonts/images may have shifted layout).
  restoreFromHash();
  if (document.readyState === "complete") {
    restoreFromHash();
  } else {
    window.addEventListener("load", restoreFromHash, { once: true });
  }

  let pending = false;
  const post = () => {
    pending = false;
    try {
      const y = window.scrollY || (document.scrollingElement && document.scrollingElement.scrollTop) || 0;
      const x = window.scrollX || (document.scrollingElement && document.scrollingElement.scrollLeft) || 0;
      window.parent.postMessage(
        { type: "agentuse:scroll", y: Math.round(y), x: Math.round(x) },
        "*",
      );
    } catch {}
  };
  window.addEventListener(
    "scroll",
    () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(post);
    },
    { passive: true },
  );

  // Forward Shift+wheel to the parent canvas. Browser/iframe boundaries keep
  // wheel events from bubbling to the viewer, so without this the artifact
  // document can consume native horizontal scrolling until Shift is released.
  window.addEventListener(
    "wheel",
    (event) => {
      if (!event.shiftKey || event.ctrlKey) return;
      try {
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
        window.parent.postMessage(
          {
            type: "agentuse:wheel",
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            deltaMode: event.deltaMode,
            shiftKey: event.shiftKey,
            ctrlKey: event.ctrlKey,
          },
          "*",
        );
      } catch {}
    },
    { capture: true, passive: false },
  );
})();
</script>`;

// HTML artifacts often omit a page background because browsers normally paint
// documents white. In the viewer they live inside dark-mode tiles, so a
// transparent iframe document can look incorrectly dark. Inject this before
// authored styles: it restores the browser-like white page default, while
// still letting explicit artifact CSS override it.
export const ARTIFACT_DEFAULT_STYLE =
  `<style id="agentuse-artifact-defaults">html{background:#fff;color-scheme:light;}body{background:#fff;}</style>`;

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
      if (tag === "a") retargetExternalAnchor(el);
      walk(el);
    }
  };
  walk(root);
  return root.toString();
}

function retargetExternalAnchor(el: HTMLElement): void {
  const href = el.getAttribute("href");
  if (!href) return;
  if (!/^(?:https?:|mailto:|tel:)/i.test(href) && !href.startsWith("//")) return;
  el.setAttribute("target", "_blank");
  const rel = (el.getAttribute("rel") ?? "").trim();
  const tokens = new Set(rel ? rel.split(/\s+/) : []);
  tokens.add("noopener");
  tokens.add("noreferrer");
  el.setAttribute("rel", [...tokens].join(" "));
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
  const headInjection = cspMeta + ARTIFACT_DEFAULT_STYLE + ARTIFACT_RUNTIME_SHIM + ARTIFACT_SCROLL_SHIM;

  // If the document has a <head>, inject as the first child of head; otherwise
  // prepend a synthetic <head>.
  const lower = scrubbed.toLowerCase();
  const headIdx = lower.indexOf("<head>");
  if (headIdx >= 0) {
    const insertAt = headIdx + "<head>".length;
    return scrubbed.slice(0, insertAt) + headInjection + scrubbed.slice(insertAt);
  }
  const htmlIdx = lower.indexOf("<html");
  if (htmlIdx >= 0) {
    const closeBracket = scrubbed.indexOf(">", htmlIdx);
    if (closeBracket > 0) {
      return (
        scrubbed.slice(0, closeBracket + 1) +
        `<head>${headInjection}</head>` +
        scrubbed.slice(closeBracket + 1)
      );
    }
  }
  return `<!DOCTYPE html><html><head>${headInjection}</head><body>${scrubbed}</body></html>`;
}
