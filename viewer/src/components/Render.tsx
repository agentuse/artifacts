import { memo, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeHighlight from "rehype-highlight";
import { bundleUrl, fetchText, previewUrl, rawUrl } from "../api";
import { parseMarkdownFrontmatter, type FrontmatterField, type FrontmatterValue } from "../frontmatter";
import type { FeedEntry } from "../types";

const PREVIEW_WIDTHS = [320, 480, 720, 960, 1280, 1600, 2048];
const PREVIEW_CHARS = 320;
/** Past this a text file is a download, not something to paint into the page. */
const MAX_INLINE_TEXT_BYTES = 2 * 1024 * 1024;
const textCache = new Map<string, string>();
const textPromises = new Map<string, Promise<string>>();

export function isImageEntry(entry: FeedEntry): boolean {
  return entry.type === "png" || entry.type === "jpg" || entry.type === "webp";
}

export function isTextEntry(entry: FeedEntry): boolean {
  return entry.type === "markdown" || entry.type === "agentuse";
}

/** Plain text, code, and data files: shown verbatim, never parsed as markdown. */
export function isPlainTextEntry(entry: FeedEntry): boolean {
  return entry.type === "text";
}

export function fileName(entry: FeedEntry): string {
  return entry.entry.split("/").pop() || entry.entry;
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** For text and file entries the extension says more than the kind ("CSV", "ZIP"). */
export function typeLabel(entry: FeedEntry): string {
  if (entry.type === "markdown") return "MD";
  if (entry.type === "agentuse") return "AGENTUSE";
  if (entry.type === "text" || entry.type === "file") {
    const name = fileName(entry);
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1).toUpperCase() : entry.type.toUpperCase();
  }
  return entry.type.toUpperCase();
}

function cachedText(url: string): Promise<string> {
  const cached = textCache.get(url);
  if (cached != null) return Promise.resolve(cached);
  const pending = textPromises.get(url);
  if (pending) return pending;
  const next = fetchText(url).then((text) => {
    textCache.set(url, text);
    textPromises.delete(url);
    return text;
  });
  textPromises.set(url, next);
  return next;
}

/** Snap to a bucket so the server caches one thumbnail per size, not per device. */
function bucketWidth(cssWidth: number): number {
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const target = Math.ceil(cssWidth * dpr);
  return PREVIEW_WIDTHS.find((w) => w >= target) ?? PREVIEW_WIDTHS[PREVIEW_WIDTHS.length - 1]!;
}

/** Resolve a relative asset in markdown against the entry file's directory. */
function assetUrl(entry: FeedEntry, src: string | undefined): string | undefined {
  if (!src) return src;
  if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(src)) return src;
  const dir = entry.entry.split("/").slice(0, -1);
  const parts = [...dir, ...src.split("/")];
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return bundleUrl(entry, resolved.join("/"));
}

function isExternalHref(href: string | undefined): boolean {
  if (!href) return false;
  return /^(?:https?:|mailto:|tel:)/i.test(href) || href.startsWith("//");
}

/**
 * Full-size artifact body. HTML and PDF run in a sandboxed iframe without
 * allow-same-origin, so scripts inside an artifact live in an opaque origin
 * and cannot touch the viewer's DOM, storage, or cookies.
 */
export function ArtifactBody(props: { entry: FeedEntry }) {
  const { entry } = props;
  if (entry.type === "html") {
    return (
      <div className="body html">
        <iframe
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          allow="clipboard-write"
          src={bundleUrl(entry)}
          title={entry.title}
        />
      </div>
    );
  }
  if (entry.type === "pdf") {
    return (
      <div className="body pdf">
        <iframe sandbox="allow-scripts" src={bundleUrl(entry)} title={entry.title} />
      </div>
    );
  }
  if (isImageEntry(entry)) {
    return (
      <div className="body image">
        <img src={bundleUrl(entry)} alt={entry.title} decoding="async" />
      </div>
    );
  }
  if (entry.type === "video") {
    return (
      <div className="body media">
        <video src={bundleUrl(entry)} controls playsInline preload="metadata" />
      </div>
    );
  }
  if (entry.type === "audio") {
    return (
      <div className="body media audio">
        <audio src={bundleUrl(entry)} controls preload="metadata" />
      </div>
    );
  }
  if (isPlainTextEntry(entry)) {
    return entry.size > MAX_INLINE_TEXT_BYTES ? <FileBody entry={entry} /> : <PlainTextBody entry={entry} />;
  }
  if (entry.type === "file") return <FileBody entry={entry} />;
  return <MarkdownBody entry={entry} />;
}

/** A kind the browser can't show: say what it is and hand it over. */
function FileBody(props: { entry: FeedEntry }) {
  const name = fileName(props.entry);
  return (
    <div className="body file">
      <div className="file-card">
        <span className="file-card-type">{typeLabel(props.entry)}</span>
        <span className="file-card-name">{name}</span>
        <span className="file-card-size">{fmtSize(props.entry.size)}</span>
        <a className="file-card-download" href={rawUrl(props.entry)} download={name}>
          Download
        </a>
      </div>
    </div>
  );
}

function PlainTextBody(props: { entry: FeedEntry }) {
  const { text, error } = useArtifactText(bundleUrl(props.entry));
  if (error) return <div className="body body-message">could not load: {error}</div>;
  if (text == null) return <div className="body body-message">loading…</div>;
  return (
    <div className="body plain-text">
      <pre>{text}</pre>
    </div>
  );
}

function MarkdownBody(props: { entry: FeedEntry }) {
  const url = bundleUrl(props.entry);
  const { text, error } = useArtifactText(url);

  const rendered = useMemo(() => {
    if (text == null) return null;
    const parsed = parseMarkdownFrontmatter(text);
    return (
      <div className="body markdown-body">
        <div className="markdown">
          <Frontmatter fields={parsed.fields} />
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkBreaks]}
            rehypePlugins={[rehypeHighlight]}
            components={{
              img: ({ src, ...imgProps }) => (
                <img {...imgProps} src={assetUrl(props.entry, src)} />
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
  }, [text, props.entry]);

  if (error) return <div className="body body-message">could not load: {error}</div>;
  if (rendered == null) return <div className="body body-message">loading…</div>;
  return rendered;
}

function useArtifactText(url: string): { text: string | null; error: string | null } {
  const [text, setText] = useState<string | null>(() => textCache.get(url) ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    cachedText(url)
      .then((next) => {
        if (!alive) return;
        setText(next);
        setError(null);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [url]);

  return { text, error };
}

/**
 * Card thumbnail. Only mounted once the card scrolls into view, because an
 * HTML preview is a real iframe and a markdown preview is a fetch — doing
 * either for every card at once is what makes a long feed crawl on a phone.
 */
export const ArtifactPreview = memo(function ArtifactPreview(props: {
  entry: FeedEntry;
  width: number;
}) {
  const { entry } = props;
  if (isImageEntry(entry)) {
    return (
      <img
        className="card-preview-image"
        src={previewUrl(entry, bucketWidth(props.width))}
        alt=""
        loading="lazy"
        decoding="async"
        style={aspectStyle(entry)}
      />
    );
  }
  if (entry.type === "html") {
    return (
      <div className="card-preview-frame">
        <iframe sandbox="" src={bundleUrl(entry)} title="" tabIndex={-1} />
      </div>
    );
  }
  if (entry.type === "video") {
    // #t= makes Safari paint a real frame instead of a black box.
    return (
      <div className="card-preview-video">
        <video src={`${bundleUrl(entry)}#t=0.5`} muted playsInline preload="metadata" tabIndex={-1} />
      </div>
    );
  }
  if (isTextEntry(entry)) return <MarkdownExcerpt entry={entry} />;
  if (isPlainTextEntry(entry) && entry.size <= MAX_INLINE_TEXT_BYTES) return <PlainTextExcerpt entry={entry} />;
  return null;
});

function PlainTextExcerpt(props: { entry: FeedEntry }) {
  const { text } = useArtifactText(bundleUrl(props.entry));
  if (!text) return null;
  return <p className="card-excerpt mono">{text.slice(0, PREVIEW_CHARS)}</p>;
}

function aspectStyle(entry: FeedEntry): { aspectRatio?: string } {
  if (!entry.naturalWidth || !entry.naturalHeight) return {};
  return { aspectRatio: `${entry.naturalWidth} / ${entry.naturalHeight}` };
}

function MarkdownExcerpt(props: { entry: FeedEntry }) {
  const { text } = useArtifactText(bundleUrl(props.entry));
  const excerpt = useMemo(() => (text == null ? null : excerptOf(text)), [text]);
  if (!excerpt) return null;
  return <p className="card-excerpt">{excerpt}</p>;
}

/**
 * Strip frontmatter, headings, and markup so the card shows readable prose.
 * Headings are dropped rather than flattened: the card already shows the
 * title, and keeping them made every excerpt open by repeating it.
 */
function excerptOf(raw: string): string {
  const body = parseMarkdownFrontmatter(raw)
    .body.replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ");
  const withoutHeadings = body
    .split("\n")
    .filter((line) => !/^\s{0,3}#{1,6}\s+/.test(line))
    .join("\n");
  // A doc that is almost all headings would leave nothing, so fall back to
  // the flattened text rather than showing an empty card.
  const source = clean(withoutHeadings) || clean(body.replace(/^\s{0,3}#{1,6}\s+/gm, ""));
  return source.length > PREVIEW_CHARS ? source.slice(0, PREVIEW_CHARS - 1) + "…" : source;
}

function clean(text: string): string {
  return text
    .replace(/[*_`>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function Frontmatter(props: { fields: FrontmatterField[] }) {
  if (props.fields.length === 0) return null;
  return (
    <section className="frontmatter" aria-label="frontmatter">
      {props.fields.map((field) => (
        <FrontmatterTreeNode field={field} key={field.key} />
      ))}
    </section>
  );
}

function FrontmatterTreeNode(props: { field: FrontmatterField }) {
  const nested = getNestedFrontmatterFields(props.field.value);
  if (nested) {
    return (
      <div className="frontmatter-node frontmatter-branch">
        <div className="frontmatter-row frontmatter-branch-row">
          <div className="frontmatter-key">{props.field.key}</div>
        </div>
        <div className="frontmatter-children">
          {nested.map((field) => (
            <FrontmatterTreeNode field={field} key={field.key} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="frontmatter-node">
      <div className="frontmatter-row">
        <div className="frontmatter-key">{props.field.key}</div>
        <div className="frontmatter-value">
          <FrontmatterValueView value={props.field.value} />
        </div>
      </div>
    </div>
  );
}

function FrontmatterValueView(props: { value: FrontmatterValue }) {
  if (Array.isArray(props.value)) {
    const items = props.value.filter((item): item is string => typeof item === "string");
    return items.length ? (
      <div className="frontmatter-tags">
        {items.map((item, index) => (
          <span className="frontmatter-tag" key={`${item}-${index}`}>{item}</span>
        ))}
      </div>
    ) : (
      <span className="frontmatter-empty">empty</span>
    );
  }
  return props.value ? props.value : <span className="frontmatter-empty">empty</span>;
}

function getNestedFrontmatterFields(value: FrontmatterValue): FrontmatterField[] | null {
  if (!Array.isArray(value)) return null;
  return value.every(isFrontmatterField) ? value : null;
}

function isFrontmatterField(value: unknown): value is FrontmatterField {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as FrontmatterField).key === "string" &&
    "value" in value
  );
}
