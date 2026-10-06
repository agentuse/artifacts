import { useEffect, useRef, useState } from "react";
import { Check, Share2, RefreshCw } from "lucide-react";
import { shareEntry } from "../api";

type SharingState = { state: "share" | "shared" | "update"; url?: string };
export function ShareButton({ entryId, sharing }: { entryId: string; sharing?: SharingState }) {
  const [publishedUrl, setPublishedUrl] = useState("");
  useEffect(() => { setPublishedUrl(""); }, [sharing?.state, sharing?.url]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  const [fallback, setFallback] = useState(false);
  const [error, setError] = useState("");
  const state = publishedUrl ? "shared" : sharing?.state ?? "share";
  const url = publishedUrl || sharing?.url || "";
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      clearTimeout(copiedTimer.current);
      setCopied(true); setFallback(false);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    }
    catch { setFallback(true); setCopied(false); }
  }
  async function share() {
    if (busy) return;
    clearTimeout(copiedTimer.current);
    setError(""); setCopied(false);
    if (state === "shared" && url) { await copy(url); return; }
    setBusy(true);
    try {
      const result = await shareEntry(entryId);
      setPublishedUrl(result.url);
      await copy(result.url);
    } catch (e) { setError(e instanceof Error ? e.message : "Sharing failed. Please retry."); }
    finally { setBusy(false); }
  }
  const label = busy ? state === "update" ? "Updating…" : "Sharing…" : copied ? "Link copied" : state === "shared" ? "Shared" : state === "update" ? "Update" : "Share";
  return (
    <div className="share-control">
      <button type="button" className={`share-button state-${copied ? "shared" : state}`} onClick={share} disabled={busy} aria-label={label}
        title={state === "shared" ? "Copy shared link" : state === "update" ? "Publish this revision to the existing shared link" : "Anyone with the link can view this artifact and its supplementary files"}>
        {state === "shared" ? <Check size={15} /> : state === "update" ? <RefreshCw size={15} /> : <Share2 size={15} />}
        {/* The word hides at phone widths, where the header row is tight; the
            icon and colour carry the state and aria-label names it. */}
        <span className="share-label" aria-hidden="true">{label}</span>
      </button>
      <span className="sr-only" role="status">{busy ? "Uploading artifact" : copied ? "Share link copied to clipboard" : ""}</span>
      {fallback && <div className="share-feedback" role="status">
        <p>Your link is ready. Copy it below.</p>
        <input aria-label="Share URL" readOnly value={url} onFocus={e => e.currentTarget.select()} />
      </div>}
      {error && <div className="share-feedback" role="alert">{error}</div>}
    </div>
  );
}
