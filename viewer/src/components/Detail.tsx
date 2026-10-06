import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Copy, Download, FileText, MoreHorizontal } from "lucide-react";
import { bundleUrl, fetchEntry, rawUrl } from "../api";
import { ArtifactBody, isTextEntry, typeLabel } from "./Render";
import { RelativeTime } from "./RelativeTime";
import { ShareButton } from "./ShareButton";
import type { EntryDetail, FeedEntry } from "../types";

const POLL_MS = 5_000;

export function Detail(props: {
  entryId: string;
  onBack: () => void;
  onOpenEntry: (entryId: string) => void;
  onFilter: (filter: { projectId?: string; tag?: string }) => void;
}) {
  const [detail, setDetail] = useState<EntryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Owned here, not inside Actions, so Escape can dismiss the menu without
  // also leaving the page — both listeners see the same keydown.
  const [menuOpen, setMenuOpen] = useState(false);
  // Ref so the poll effect doesn't restart when the parent re-renders and
  // hands down a fresh callback identity.
  const onOpenEntryRef = useRef(props.onOpenEntry);
  onOpenEntryRef.current = props.onOpenEntry;

  // Poll like the feed does: a 304 costs one conditional request. When a new
  // revision lands while the user is on the latest one, follow it — that is
  // what "staying on the artifact" means. A deliberately opened older
  // revision is left alone.
  useEffect(() => {
    let alive = true;
    let etag: string | null = null;
    let wasLatest: boolean | null = null;
    setDetail(null);
    setError(null);

    const tick = async () => {
      const first = wasLatest === null;
      try {
        const result = await fetchEntry(props.entryId, etag);
        if (!alive) return;
        etag = result.etag;
        if (result.notModified || !result.detail) return;
        const next = result.detail;
        const newest = next.revisions[0];
        if (wasLatest === null) wasLatest = !newest || newest.rev <= next.entry.rev;
        setDetail(next);
        if (wasLatest && newest && newest.rev > next.entry.rev) {
          onOpenEntryRef.current(newest.id);
        }
      } catch (e) {
        // Only the initial load surfaces an error; a transient poll failure
        // shouldn't replace a page the user is reading.
        if (alive && first) setError((e as Error).message);
      }
    };

    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [props.entryId]);

  const onBack = props.onBack;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (menuOpen) {
        setMenuOpen(false);
        return;
      }
      onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen, onBack]);

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
      <DetailHead
        title={entry.title}
        onBack={props.onBack}
        entry={entry}
        sharingEnabled={detail.sharingEnabled === true}
        sharing={detail.sharing}
        menuOpen={menuOpen}
        onMenuOpenChange={setMenuOpen}
      />
      <div className="detail-sub">
        {/* Chips look tappable, so they are: both jump to the filtered feed. */}
        <button
          type="button"
          className="chip small"
          onClick={() => props.onFilter({ projectId: entry.projectId })}
        >
          {entry.projectName}
        </button>
        {entry.tags.map((tag) => (
          <button
            key={tag}
            type="button"
            className="chip small tag"
            onClick={() => props.onFilter({ tag })}
          >
            #{tag}
          </button>
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

function DetailHead(props: {
  title: string;
  onBack: () => void;
  entry?: FeedEntry;
  sharingEnabled?: boolean;
  sharing?: { state: "share" | "shared" | "update"; url?: string };
  menuOpen?: boolean;
  onMenuOpenChange?: (open: boolean) => void;
}) {
  return (
    <header className="detail-head">
      <button type="button" className="icon-btn" onClick={props.onBack} aria-label="back to feed" title="back (esc)">
        <ArrowLeft size={18} strokeWidth={1.75} />
      </button>
      <h1>{props.title}</h1>
      {props.entry && props.sharingEnabled && <ShareButton key={props.entry.id} entryId={props.entry.id} sharing={props.sharing} />}
      {props.entry && (
        <Actions
          entry={props.entry}
          open={!!props.menuOpen}
          onOpenChange={props.onMenuOpenChange ?? (() => {})}
        />
      )}
    </header>
  );
}

type CopyState = null | "path" | "content" | "link";

/** Opens whatever revision is newest when followed; mirrors the server's /latest route. */
function latestLink(entry: FeedEntry): string {
  return `${window.location.origin}/latest/${encodeURIComponent(entry.projectId)}/${encodeURIComponent(entry.slug)}`;
}

/**
 * Download and "copy content" go through /api/raw/:id so they hand back the
 * exact file the agent submitted — notably the original, unsanitized HTML
 * rather than what the iframe renders.
 */
function Actions(props: { entry: FeedEntry; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { open, onOpenChange } = props;
  const [copied, setCopied] = useState<CopyState>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const filename = props.entry.entry.split("/").pop() || props.entry.entry;
  const setOpen = onOpenChange;

  // Escape is handled by the parent, which knows whether the menu or the page
  // should close. Here we only need the click-outside dismissal.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open, onOpenChange]);

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
        onClick={() => setOpen(!open)}
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
            onClick={() => copy("link", () => latestLink(props.entry))}
          >
            <Copy size={14} strokeWidth={2} />
            <span>Copy link</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="action-menu-item"
            onClick={() => copy("link", () => window.location.href)}
          >
            <Copy size={14} strokeWidth={2} />
            <span>Copy link to rev {props.entry.rev}</span>
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
