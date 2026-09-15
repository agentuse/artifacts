import { useState } from "react";
import { Check, Share2 } from "lucide-react";
import { shareEntry } from "../api";

export function ShareButton({ entryId }: { entryId: string }) {
  const [state, setState] = useState<"idle" | "sharing" | "copied" | "ready" | "error">("idle");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setState("copied"); }
    catch { setState("ready"); }
  }
  async function share() {
    if (state === "sharing") return;
    // A second click on the fallback copy button retains browser user activation.
    if (state === "ready") { await copy(url); return; }
    setState("sharing"); setError("");
    try {
      const result = await shareEntry(entryId);
      setUrl(result.url);
      await copy(result.url);
    } catch (e) { setError(e instanceof Error ? e.message : "Sharing failed. Please retry."); setState("error"); }
  }
  return (
    <div className="share-control">
      <button type="button" className="share-button" onClick={share} disabled={state === "sharing"}
        title="Anyone with the link can view this artifact and its supplementary files">
        {state === "copied" ? <Check size={15} /> : <Share2 size={15} />}
        <span>{state === "sharing" ? "Sharing…" : state === "copied" ? "Link copied" : state === "ready" ? "Copy link" : state === "error" ? "Retry share" : "Share"}</span>
      </button>
      <span className="sr-only" role="status">{state === "sharing" ? "Uploading artifact" : state === "copied" ? "Share link copied to clipboard" : ""}</span>
      {state === "ready" && <div className="share-feedback" role="status">
        <p>Your link is ready. Copy it below.</p>
        <input aria-label="Share URL" readOnly value={url} onFocus={e => e.currentTarget.select()} />
      </div>}
      {state === "error" && <div className="share-feedback" role="alert">{error}</div>}
    </div>
  );
}
