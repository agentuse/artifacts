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
const PREVIEW_WIDTH_BUCKETS = [128, 160, 240, 320, 480, 720, 960, 1280];
const artifactTextCache = new Map<string, string>();
const artifactTextPromiseCache = new Map<string, Promise<string>>();

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

function previewWidthForCss(cssWidth: number | undefined): number {
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const maxWidth =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia(TOUCH_CANVAS_QUERY).matches
      ? MAX_TOUCH_CANVAS_PREVIEW_W
      : MAX_CANVAS_PREVIEW_W;
  const rawWidth = Math.max(128, Math.ceil((cssWidth ?? 720) * dpr));
  return (
    PREVIEW_WIDTH_BUCKETS.find((w) => w >= rawWidth && w <= maxWidth) ??
    maxWidth
  );
}

function imagePreviewUrl(
  artifactId: string,
  record: ArtifactRecord,
  requestedWidth: number,
): string {
  return cacheBust(`/api/preview/${artifactId}?w=${requestedWidth}`, record);
}

function useStickyPreviewWidth(
  contentHash: string,
  desiredWidth: number | undefined,
): number | undefined {
  const [loaded, setLoaded] = useState(() => ({
    contentHash,
    width: desiredWidth,
  }));

  useEffect(() => {
    setLoaded((prev) => {
      if (prev.contentHash !== contentHash) {
        return { contentHash, width: desiredWidth };
      }
      if (desiredWidth == null) return prev;
      if (prev.width == null || desiredWidth > prev.width) {
        return { contentHash, width: desiredWidth };
      }
      return prev;
    });
  }, [contentHash, desiredWidth]);

  if (loaded.contentHash !== contentHash) return desiredWidth;
  if (desiredWidth == null) return undefined;
  if (loaded.width == null) return desiredWidth;
  return Math.max(loaded.width, desiredWidth);
}

function artifactDisplayName(record: ArtifactRecord): string {
  const label = record.localEntry ?? record.projectRelPath ?? record.name;
  return label.split("/").filter(Boolean).pop() ?? label;
}

function artifactTypeLabel(type: ArtifactRecord["type"]): string {
  if (type === "markdown") return "Markdown";
  return type.toUpperCase();
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

function cachedFetchArtifact(url: string): Promise<string> {
  const cached = artifactTextCache.get(url);
  if (cached != null) return Promise.resolve(cached);
  const pending = artifactTextPromiseCache.get(url);
  if (pending) return pending;
  const next = fetchArtifact(url).then((content) => {
    artifactTextCache.set(url, content);
    artifactTextPromiseCache.delete(url);
    return content;
  });
  artifactTextPromiseCache.set(url, next);
  return next;
}

export function Tile(props: {
  artifactId: string;
  record: ArtifactRecord;
  previewWidth?: number;
  preview?: boolean;
  zoomable?: boolean;
}) {
  const url = artifactUrl(props.artifactId, props.record);
  const isImage =
    props.record.type === "png" ||
    props.record.type === "jpg" ||
    props.record.type === "webp";

  if (props.preview && props.record.type === "markdown") {
    return <MarkdownPreview artifactId={props.artifactId} url={url} record={props.record} />;
  }

  if (props.preview && props.record.type === "html") {
    const baseSrc = props.record.local ? url : `/api/render/${props.artifactId}`;
    return <HtmlTile baseSrc={baseSrc} preview />;
  }

  if (props.preview && !isImage) {
    return <PreviewBody record={props.record} />;
  }

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
  if (isImage) {
    return (
      <ImageTile
        artifactId={props.artifactId}
        record={props.record}
        originalUrl={url}
        previewWidth={props.previewWidth}
        zoomable={props.zoomable}
      />
    );
  }
  return <MarkdownTile artifactId={props.artifactId} url={url} />;
}

function ImageTile(props: {
  artifactId: string;
  record: ArtifactRecord;
  originalUrl: string;
  previewWidth?: number;
  zoomable?: boolean;
}) {
  const desiredPreviewWidth =
    props.previewWidth == null ? undefined : previewWidthForCss(props.previewWidth);
  const stickyPreviewWidth = useStickyPreviewWidth(
    props.record.contentHash,
    desiredPreviewWidth,
  );
  const imageUrl =
    stickyPreviewWidth == null
      ? props.originalUrl
      : imagePreviewUrl(props.artifactId, props.record, stickyPreviewWidth);

  return props.zoomable ? (
    <ZoomableImage src={imageUrl} />
  ) : (
    <ImageBody src={imageUrl} />
  );
}

function PreviewBody(props: { record: ArtifactRecord }) {
  const name = artifactDisplayName(props.record);
  const parent = (props.record.localEntry ?? props.record.projectRelPath ?? props.record.name)
    .split("/")
    .slice(0, -1)
    .join("/");
  return (
    <div className="tile-body lod-preview">
      <div className="lod-preview-type">{artifactTypeLabel(props.record.type)}</div>
      <div className="lod-preview-name">{name}</div>
      {parent ? <div className="lod-preview-path">{parent}</div> : null}
    </div>
  );
}

function MarkdownPreview(props: {
  artifactId: string;
  url: string;
  record: ArtifactRecord;
}) {
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    cachedFetchArtifact(props.url)
      .then((c) => {
        if (alive) setContent(c);
      })
      .catch(() => {
        if (alive) setContent("");
      });
    return () => {
      alive = false;
    };
  }, [props.artifactId, props.url]);

  const parsed = useMemo(
    () => (content == null ? null : parseMarkdownFrontmatter(content)),
    [content],
  );

  return (
    <div className="tile-body markdown-preview">
      <div className="preview-kicker">Markdown</div>
      <div className="markdown-preview-content">
        {content == null ? (
          <p>{artifactDisplayName(props.record)}</p>
        ) : parsed?.body.trim() ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              img: ({ src, ...imgProps }) => (
                <img
                  {...imgProps}
                  src={rewriteRelativeAsset(props.url, src)}
                  loading="lazy"
                />
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
        ) : (
          <p>{artifactDisplayName(props.record)}</p>
        )}
      </div>
    </div>
  );
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

function HtmlTile(props: { baseSrc: string; preview?: boolean }) {
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
    <div className={"tile-body html" + (props.preview ? " html-preview" : "")}>
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
