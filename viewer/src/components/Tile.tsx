import { useEffect, useMemo, useRef, useState } from "react";
import {
  TransformComponent,
  TransformWrapper,
} from "react-zoom-pan-pinch";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Minus, Plus } from "lucide-react";
import { fetchArtifact } from "../api";
import { parseMarkdownFrontmatter, type FrontmatterField } from "../frontmatter";
import type { ArtifactRecord } from "../types";

const TOUCH_CANVAS_QUERY = "(max-width: 900px), (pointer: coarse)";
const MAX_CANVAS_PREVIEW_W = 1280;
const MAX_TOUCH_CANVAS_PREVIEW_W = 720;

function encodePath(entry: string): string {
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
    ? `/api/project-artifacts/${encodeURIComponent(record.projectId)}/${encodePath(record.localEntry)}`
    : record.local && record.projectRelPath
      ? `/api/project-files/${encodeURIComponent(record.projectId)}/${encodePath(record.projectRelPath)}`
      : `/api/artifact/${artifactId}`;
  return cacheBust(base, record);
}

function imagePreviewUrl(
  artifactId: string,
  record: ArtifactRecord,
  cssWidth: number | undefined,
): string {
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const maxWidth =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia(TOUCH_CANVAS_QUERY).matches
      ? MAX_TOUCH_CANVAS_PREVIEW_W
      : MAX_CANVAS_PREVIEW_W;
  const requestedWidth = Math.min(
    maxWidth,
    Math.max(320, Math.ceil((cssWidth ?? 720) * dpr)),
  );
  return cacheBust(`/api/preview/${artifactId}?w=${requestedWidth}`, record);
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

export function Tile(props: {
  artifactId: string;
  record: ArtifactRecord;
  previewWidth?: number;
  zoomable?: boolean;
}) {
  const url = artifactUrl(props.artifactId, props.record);
  if (props.record.type === "html") {
    // Routed through HtmlTile so we can preserve scroll across hot reloads:
    // when the file changes, the iframe src changes (cache-bust) and the
    // iframe navigates from scratch. The shim injected by the server posts
    // scrollY back here on scroll; HtmlTile remembers it and re-attaches it
    // as a #sy=NNN hash on the next src so the iframe restores on load.
    const baseSrc = props.record.local ? url : `/api/render/${props.artifactId}`;
    return <HtmlTile baseSrc={baseSrc} />;
  }
  if (props.record.type === "pdf") {
    // Firefox renders PDFs via PDF.js (a real JS app), so the iframe needs
    // allow-scripts. Withholding allow-same-origin keeps it in an opaque
    // origin, isolated from the viewer DOM.
    return (
      <div className="tile-body pdf">
        <iframe
          sandbox="allow-scripts"
          loading="lazy"
          src={url}
          title="artifact"
        />
      </div>
    );
  }
  if (props.record.type === "png" || props.record.type === "jpg" || props.record.type === "webp") {
    const imageUrl = props.previewWidth
      ? imagePreviewUrl(props.artifactId, props.record, props.previewWidth)
      : url;
    return props.zoomable ? (
      <ZoomableImage src={imageUrl} />
    ) : (
      <ImageBody src={imageUrl} />
    );
  }
  return <MarkdownTile artifactId={props.artifactId} url={url} />;
}

function ImageBody(props: { src: string }) {
  return (
    <div className="tile-body image">
      <img src={props.src} alt="artifact" loading="lazy" decoding="async" />
    </div>
  );
}

function ZoomableImage(props: { src: string }) {
  return (
    <div className="tile-body image image-zoom">
      <TransformWrapper
        minScale={1}
        maxScale={8}
        initialScale={1}
        centerOnInit
        limitToBounds={false}
        smooth
        wheel={{ step: 0.12 }}
        doubleClick={{ mode: "toggle", step: 1.6, animationTime: 180 }}
        panning={{ velocityDisabled: false }}
        alignmentAnimation={{ disabled: true }}
      >
        {({ zoomIn, zoomOut, resetTransform }) => (
          <>
            <div className="image-zoom-toolbar" aria-label="image zoom controls">
              <button onClick={() => zoomOut()} aria-label="zoom out" title="zoom out">
                <Minus size={16} strokeWidth={2} />
              </button>
              <button onClick={() => resetTransform(180)} title="fit">
                fit
              </button>
              <button onClick={() => zoomIn()} aria-label="zoom in" title="zoom in">
                <Plus size={16} strokeWidth={2} />
              </button>
            </div>
            <TransformComponent
              wrapperStyle={{ width: "100%", height: "100%" }}
              contentStyle={{ width: "100%", height: "100%" }}
            >
              <div className="image-zoom-content">
                <img src={props.src} alt="artifact" decoding="async" />
              </div>
            </TransformComponent>
          </>
        )}
      </TransformWrapper>
    </div>
  );
}

function HtmlTile(props: { baseSrc: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Latest scroll position the iframe reported via postMessage. Stored in a
  // ref (not state) so scroll updates do not trigger a parent re-render, and
  // do not feed back into the iframe's `src` to cause a reload mid-scroll.
  // The ref is read only when baseSrc changes.
  const lastScrollRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Only trust messages coming from this specific iframe's window. The
      // sandbox (no allow-same-origin) gives it an opaque origin (e.origin is
      // "null"), so a source-identity check is the only reliable filter.
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      const data = e.data as { type?: unknown; y?: unknown; x?: unknown } | null;
      if (!data || data.type !== "agentuse:scroll") return;
      if (typeof data.y !== "number") return;
      lastScrollRef.current = {
        x: typeof data.x === "number" ? data.x : 0,
        y: data.y,
      };
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Recompute the src only when baseSrc (i.e. the cache-busted URL) changes.
  // At that moment we read the latest known scroll from the ref and append it
  // as a hash, so the in-iframe shim can restore the position on load. Reading
  // a mutable ref during useMemo is intentional: we want a snapshot taken at
  // the precise moment the src rebuild happens.
  const src = useMemo(() => {
    const stored = lastScrollRef.current;
    if (!stored || stored.y <= 0) return props.baseSrc;
    const sep = props.baseSrc.includes("#") ? "&" : "#";
    return `${props.baseSrc}${sep}sy=${Math.round(stored.y)}&sx=${Math.round(stored.x)}`;
  }, [props.baseSrc]);

  return (
    <div className="tile-body html">
      <iframe
        ref={iframeRef}
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        allow="clipboard-write"
        loading="lazy"
        src={src}
        title="artifact"
      />
    </div>
  );
}

function MarkdownTile(props: { artifactId: string; url: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // Don't blank `content` here on URL change. The URL changes whenever the
    // file's contentHash changes (hot reload), and blanking would collapse
    // the scrollable container's height, losing the user's scroll position
    // mid-read. Keep showing the previous content until the new fetch resolves.
    fetchArtifact(props.url)
      .then((c) => {
        if (alive) {
          setContent(c);
          setError(null);
        }
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
  const parsed = parseMarkdownFrontmatter(content);
  return (
    <div className="tile-body markdown-body">
      <div className="markdown">
        <Frontmatter fields={parsed.fields} />
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
          {parsed.body}
        </ReactMarkdown>
      </div>
    </div>
  );
}

function Frontmatter(props: { fields: FrontmatterField[] }) {
  if (props.fields.length === 0) return null;
  return (
    <section className="frontmatter" aria-label="frontmatter">
      {props.fields.map((field) => (
        <div className="frontmatter-row" key={field.key}>
          <div className="frontmatter-key">{field.key}</div>
          <div className="frontmatter-value">
            {Array.isArray(field.value) ? (
              field.value.length ? (
                <div className="frontmatter-tags">
                  {field.value.map((item) => (
                    <span className="frontmatter-tag" key={item}>{item}</span>
                  ))}
                </div>
              ) : (
                <span className="frontmatter-empty">empty</span>
              )
            ) : field.value ? (
              field.value
            ) : (
              <span className="frontmatter-empty">empty</span>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}
