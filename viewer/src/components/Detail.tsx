import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronDown, Cloud, Copy, Download, FileText, History, Link, Maximize2, Minimize2, MoreHorizontal } from "lucide-react";
import { bundleUrl, fetchEntry, latestTarget, rawUrl, targetPath, type EntryTarget } from "../api";
import { ArtifactBody, isPlainTextEntry, isTextEntry } from "./Render";
import { RelativeTime } from "./RelativeTime";
import { ShareButton } from "./ShareButton";
import { DetailsSheet } from "./DetailsSheet";
import type { EntryDetail, FeedEntry } from "../types";

const POLL_MS = 5_000;

export function Detail(props: {
  target: EntryTarget;
  onBack: () => void;
  onOpenTarget: (target: EntryTarget) => void;
  onFilter: (filter: { projectId?: string; tag?: string }) => void;
}) {
  const [detail, setDetail] = useState<EntryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Owned here, not inside Actions, so Escape can dismiss the menu without
  // also leaving the page — both listeners see the same keydown.
  const [menuOpen, setMenuOpen] = useState(false);
  // Full screen hides the title bar, chips and revisions so the artifact gets
  // the whole screen. An explicit toggle, not hide-on-scroll: an HTML artifact
  // scrolls inside its iframe in any direction (wide tables, dashboards), and
  // guessing intent from that kept hiding the header at the wrong moment.
  const [fullscreen, setFullscreen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Ref so the poll effect doesn't restart when the parent re-renders and
  // hands down a fresh callback identity.
  const onOpenTargetRef = useRef(props.onOpenTarget);
  onOpenTargetRef.current = props.onOpenTarget;
  const targetKey = targetPath(props.target);

  // Poll like the feed does: a 304 costs one conditional request. A "latest"
  // target follows new revisions by itself, since the server resolves it on
  // every poll. An /a/:id link that turns out to be the newest revision is
  // swapped for the permalink, so the address bar always holds the link that
  // stays current. A deliberately opened older revision is left alone.
  useEffect(() => {
    let alive = true;
    let etag: string | null = null;
    let loaded = false;
    setDetail(null);
    setError(null);

    const tick = async () => {
      const first = !loaded;
      try {
        const result = await fetchEntry(props.target, etag);
        if (!alive) return;
        etag = result.etag;
        if (result.notModified || !result.detail) return;
        const next = result.detail;
        loaded = true;
        if (first && props.target.kind === "entry" && next.revisions[0]?.id === next.entry.id) {
          onOpenTargetRef.current(latestTarget(next.entry));
          return;
        }
        setDetail(next);
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
    // targetKey stands in for props.target, whose identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  const onBack = props.onBack;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The details sheet is a modal <dialog>: Escape closes it natively.
      if (detailsOpen) return;
      if (menuOpen) {
        setMenuOpen(false);
        return;
      }
      if (fullscreen) {
        setFullscreen(false);
        return;
      }
      onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen, fullscreen, detailsOpen, onBack]);

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
  const latest = revisions[0] ?? entry;
  const isLatest = latest.id === entry.id;
  const openRevision = (rev: FeedEntry) =>
    props.onOpenTarget(rev.id === latest.id ? latestTarget(rev) : { kind: "entry", id: rev.id });
  // With share sync on, the cloud link always serves the newest revision once
  // it says "shared"; "update" means a push is still pending.
  const latestShared = detail.sharingEnabled === true && detail.sharing?.state === "shared";

  // Every slot stays in place whether or not it renders, so toggling full
  // screen never remounts ArtifactBody: an iframe would reload and lose its
  // scroll position.
  return (
    <div className={"detail" + (fullscreen ? " fullscreen" : "")}>
      {fullscreen ? null : (
        <div className="detail-top">
          <DetailHead
            title={entry.title}
            onBack={props.onBack}
            entry={entry}
            revLabel={isLatest ? `rev ${entry.rev}` : `rev ${entry.rev} of ${latest.rev}`}
            isLatest={isLatest}
            onDetails={() => {
              setMenuOpen(false);
              setDetailsOpen(true);
            }}
            sharingEnabled={detail.sharingEnabled === true}
            sharing={detail.sharing}
            menuOpen={menuOpen}
            onMenuOpenChange={setMenuOpen}
            onFullscreen={() => {
              setMenuOpen(false);
              setFullscreen(true);
            }}
          />
          {!isLatest && (
            // An older revision is frozen; the permalink isn't. Say so, since
            // links now follow the newest revision everywhere else.
            <div className="old-rev-banner" role="status">
              <History size={16} strokeWidth={1.75} aria-hidden="true" />
              <span>Older revision. It won't update.</span>
              <button type="button" className="link-btn" onClick={() => openRevision(latest)}>
                Go to latest
              </button>
            </div>
          )}
        </div>
      )}
      {fullscreen ? (
        <button
          type="button"
          className="icon-btn exit-fullscreen"
          onClick={() => setFullscreen(false)}
          aria-label="Exit full screen"
          title="Exit full screen (esc)"
        >
          <Minimize2 size={18} strokeWidth={1.75} />
        </button>
      ) : null}
      <ArtifactBody entry={entry} />
      {detailsOpen ? (
        <DetailsSheet
          entry={entry}
          revisions={revisions}
          latestShared={latestShared}
          onOpenRevision={(rev) => {
            setDetailsOpen(false);
            openRevision(rev);
          }}
          onFilter={props.onFilter}
          onClose={() => setDetailsOpen(false)}
        />
      ) : null}
    </div>
  );
}

function DetailHead(props: {
  title: string;
  onBack: () => void;
  entry?: FeedEntry;
  revLabel?: string;
  isLatest?: boolean;
  onDetails?: () => void;
  sharingEnabled?: boolean;
  sharing?: { state: "share" | "shared" | "update"; url?: string };
  menuOpen?: boolean;
  onMenuOpenChange?: (open: boolean) => void;
  onFullscreen?: () => void;
}) {
  const { entry } = props;
  return (
    <header className="detail-head">
      <button type="button" className="icon-btn" onClick={props.onBack} aria-label="back to feed" title="back (esc)">
        <ArrowLeft size={18} strokeWidth={1.75} />
      </button>
      {entry && props.onDetails ? (
        // The title block is the way into revisions and details, so the
        // whole two-line block is one 48px target.
        <h1 className="detail-title">
          <button
            type="button"
            onClick={props.onDetails}
            aria-label={`${props.title}, ${props.revLabel ?? ""}. Show revisions and details`}
          >
            <span className="detail-title-text">{props.title}</span>
            <span className="detail-meta">
              <span className={props.isLatest ? undefined : "rev-old"}>{props.revLabel}</span>
              <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />
              <span aria-hidden="true">·</span>
              <RelativeTime iso={entry.submittedAt} />
              <span className="detail-meta-wide">
                <span aria-hidden="true">·</span>
                <span>{entry.projectName}</span>
                {entry.tags.map((tag) => (
                  <span key={tag}>#{tag}</span>
                ))}
              </span>
            </span>
          </button>
        </h1>
      ) : (
        <h1 className="detail-title plain">{props.title}</h1>
      )}
      {entry && props.sharingEnabled && <ShareButton key={entry.id} entryId={entry.id} sharing={props.sharing} />}
      {props.onFullscreen && (
        <button type="button" className="icon-btn" onClick={props.onFullscreen} aria-label="Full screen" title="Full screen">
          <Maximize2 size={18} strokeWidth={1.75} />
        </button>
      )}
      {props.entry && (
        <Actions
          entry={props.entry}
          isLatest={props.isLatest !== false}
          sharedUrl={props.sharingEnabled && props.sharing?.state !== "share" ? props.sharing?.url : undefined}
          open={!!props.menuOpen}
          onOpenChange={props.onMenuOpenChange ?? (() => {})}
        />
      )}
    </header>
  );
}

type CopyState = null | "path" | "content" | "link" | "shared";

/**
 * Download and "copy content" go through /api/raw/:id so they hand back the
 * exact file the agent submitted — notably the original, unsanitized HTML
 * rather than what the iframe renders.
 */
function Actions(props: {
  entry: FeedEntry;
  isLatest: boolean;
  sharedUrl?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
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
        <div className="action-menu-panel" role="menu" aria-label="More actions">
          <div className="action-menu-title" aria-hidden="true">
            {props.entry.title} · rev {props.entry.rev}
          </div>
          <button
            type="button"
            role="menuitem"
            className="action-menu-item"
            onClick={() => copy("link", () => window.location.href)}
          >
            <Link size={14} strokeWidth={2} />
            <span>Copy link</span>
            <span className="action-menu-hint">{props.isLatest ? "always latest" : `rev ${props.entry.rev} only`}</span>
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
          {isTextEntry(props.entry) || isPlainTextEntry(props.entry) || props.entry.type === "html" ? (
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
            <span className="action-menu-hint">{filename}</span>
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
          {props.sharedUrl ? (
            <button
              type="button"
              role="menuitem"
              className="action-menu-item accent"
              onClick={() => copy("shared", () => props.sharedUrl ?? "")}
            >
              <Cloud size={14} strokeWidth={2} />
              <span>Copy shared link</span>
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

