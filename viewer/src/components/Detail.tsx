import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Copy, Download, FileText, MoreHorizontal } from "lucide-react";
import { bundleUrl, fetchEntry, rawUrl } from "../api";
import { ArtifactBody, isTextEntry, typeLabel } from "./Render";
import { RelativeTime } from "./RelativeTime";
import type { EntryDetail, FeedEntry } from "../types";

export function Detail(props: {
  entryId: string;
  onBack: () => void;
  onOpenEntry: (entryId: string) => void;
}) {
  const [detail, setDetail] = useState<EntryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError(null);
    fetchEntry(props.entryId)
      .then((next) => {
        if (alive) setDetail(next);
      })
      .catch((e) => {
        if (alive) setError((e as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [props.entryId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  if (error) {
    return (
      <div className="detail">
        <DetailHead title="Not found" onBack={props.onBack} />
        <div className="feed-message error">
          <p>{error}</p>
          <button type="button" className="link-btn" onClick={props.onBack}>
            Back to the feed
          </button>
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="detail">
        <DetailHead title="Loading…" onBack={props.onBack} />
      </div>
    );
  }

  const { entry, revisions } = detail;
  return (
    <div className="detail">
      <DetailHead title={entry.title} onBack={props.onBack} entry={entry} />
      <div className="detail-sub">
        <span className="chip small">{entry.projectName}</span>
        {entry.tags.map((tag) => (
          <span key={tag} className="chip small tag">#{tag}</span>
        ))}
        <span className="badge">{typeLabel(entry.type)}</span>
        <RelativeTime iso={entry.submittedAt} />
        <span className="secondary">{fmtSize(entry.size)}{entry.files > 1 ? ` · ${entry.files} files` : ""}</span>
      </div>
      {revisions.length > 1 && (
        <div className="revisions" aria-label="revisions">
          {revisions.map((rev) => (
            <button
              key={rev.id}
              type="button"
              className={"chip small" + (rev.id === entry.id ? " active" : "")}
              onClick={() => props.onOpenEntry(rev.id)}
            >
              rev {rev.rev}
            </button>
          ))}
        </div>
      )}
      <ArtifactBody entry={entry} />
    </div>
  );
}

function DetailHead(props: { title: string; onBack: () => void; entry?: FeedEntry }) {
  return (
    <header className="detail-head">
      <button type="button" className="icon-btn" onClick={props.onBack} aria-label="back to feed" title="back (esc)">
        <ArrowLeft size={18} strokeWidth={1.75} />
      </button>
      <h1>{props.title}</h1>
      {props.entry && <Actions entry={props.entry} />}
    </header>
  );
}

type CopyState = null | "path" | "content" | "link";

/**
 * Download and "copy content" go through /api/raw/:id so they hand back the
 * exact file the agent submitted — notably the original, unsanitized HTML
 * rather than what the iframe renders.
 */
function Actions(props: { entry: FeedEntry }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<CopyState>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const filename = props.entry.entry.split("/").pop() || props.entry.entry;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const flash = (which: Exclude<CopyState, null>) => {
    setCopied(which);
    setOpen(false);
    window.setTimeout(() => setCopied((v) => (v === which ? null : v)), 1200);
  };

  const copy = async (which: Exclude<CopyState, null>, value: () => Promise<string> | string) => {
    try {
      await navigator.clipboard.writeText(await value());
      flash(which);
    } catch {
      // Clipboard blocked (insecure context or denied permission) — the menu
      // stays put rather than claiming a copy that didn't happen.
    }
  };

  return (
    <div className="action-menu" ref={rootRef}>
      <button
        type="button"
        className="icon-btn"
        onClick={() => setOpen((v) => !v)}
        aria-label="more actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {copied ? <Check size={18} strokeWidth={2} /> : <MoreHorizontal size={18} strokeWidth={2} />}
      </button>
      {open && (
        <div className="action-menu-panel" role="menu">
          <button
            type="button"
            role="menuitem"
            className="action-menu-item"
            onClick={() => copy("link", () => window.location.href)}
          >
            <Copy size={14} strokeWidth={2} />
            <span>Copy link</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="action-menu-item"
            onClick={() => copy("path", () => props.entry.sourcePath)}
            title={props.entry.sourcePath}
          >
            <FileText size={14} strokeWidth={2} />
            <span>Copy source path</span>
          </button>
          {isTextEntry(props.entry) || props.entry.type === "html" ? (
            <button
              type="button"
              role="menuitem"
              className="action-menu-item"
              onClick={() =>
                copy("content", async () => {
                  const res = await fetch(rawUrl(props.entry), { cache: "no-store" });
                  if (!res.ok) throw new Error(String(res.status));
                  return res.text();
                })
              }
            >
              <Copy size={14} strokeWidth={2} />
              <span>Copy content</span>
            </button>
          ) : null}
          <a
            role="menuitem"
            className="action-menu-item"
            href={rawUrl(props.entry)}
            download={filename}
            onClick={() => setOpen(false)}
          >
            <Download size={14} strokeWidth={2} />
            <span>Download</span>
          </a>
          <a
            role="menuitem"
            className="action-menu-item"
            href={bundleUrl(props.entry)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
          >
            <FileText size={14} strokeWidth={2} />
            <span>Open standalone</span>
          </a>
        </div>
      )}
    </div>
  );
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
