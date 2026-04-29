import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { fetchArtifact } from "../api";
import type { ArtifactRecord } from "../types";

function encodeLocalEntry(entry: string): string {
  return entry.split("/").map(encodeURIComponent).join("/");
}

function cacheBust(url: string, record: ArtifactRecord): string {
  // contentHash is mtime+size for local artifacts (stable id, mutable content)
  // and a content hash for stored ones. Either way, it changes iff the bytes
  // change, so it's the right cache-busting key for both iframes and fetches.
  if (!record.contentHash) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${encodeURIComponent(record.contentHash)}`;
}

function artifactUrl(artifactId: string, record: ArtifactRecord): string {
  const base = record.local && record.localEntry
    ? `/api/project-artifacts/${encodeURIComponent(record.projectId)}/${encodeLocalEntry(record.localEntry)}`
    : `/api/artifact/${artifactId}`;
  return cacheBust(base, record);
}

function rewriteRelativeAsset(baseUrl: string, src: string | undefined): string | undefined {
  if (!src) return src;
  if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(src)) return src;
  return new URL(src, window.location.origin + baseUrl).pathname;
}

function isExternalHref(href: string | undefined): boolean {
  if (!href) return false;
  return /^(?:https?:|mailto:|tel:)/i.test(href) || href.startsWith("//");
}

export function Tile(props: { artifactId: string; record: ArtifactRecord }) {
  const url = artifactUrl(props.artifactId, props.record);
  if (props.record.type === "html") {
    // The iframe loads /api/render/:id directly. The server attaches CSP
    // there; sandbox="allow-scripts" (no allow-same-origin) keeps the iframe
    // in an opaque origin so its scripts cannot reach the parent viewer.
    return (
      <div className="tile-body html">
        <iframe
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          src={props.record.local ? url : `/api/render/${props.artifactId}`}
          title="artifact"
        />
      </div>
    );
  }
  if (props.record.type === "pdf") {
    // Firefox renders PDFs via PDF.js (a real JS app), so the iframe needs
    // allow-scripts. Withholding allow-same-origin keeps it in an opaque
    // origin, isolated from the viewer DOM.
    return (
      <div className="tile-body pdf">
        <iframe
          sandbox="allow-scripts"
          src={url}
          title="artifact"
        />
      </div>
    );
  }
  if (props.record.type === "png" || props.record.type === "jpg" || props.record.type === "webp") {
    return (
      <div className="tile-body image">
        <img src={url} alt="artifact" />
      </div>
    );
  }
  return <MarkdownTile artifactId={props.artifactId} url={url} />;
}

function MarkdownTile(props: { artifactId: string; url: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setContent(null);
    setError(null);
    fetchArtifact(props.url)
      .then((c) => {
        if (alive) setContent(c);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [props.artifactId, props.url]);

  if (error) return <div className="tile-body">error: {error}</div>;
  if (content == null) return <div className="tile-body">loading…</div>;
  return (
    <div className="tile-body markdown-body">
      <div className="markdown">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={{
            img: ({ src, ...imgProps }) => (
              <img {...imgProps} src={rewriteRelativeAsset(props.url, src)} />
            ),
            a: ({ href, children, ...anchorProps }) =>
              isExternalHref(href) ? (
                <a {...anchorProps} href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              ) : (
                <a {...anchorProps} href={href}>
                  {children}
                </a>
              ),
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
