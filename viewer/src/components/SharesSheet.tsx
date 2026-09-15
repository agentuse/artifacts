import { useEffect, useRef, useState } from "react";
import { Copy, ExternalLink, Trash2, X } from "lucide-react";
import { fetchSharedArtifacts, removeSharedArtifact } from "../api";
import type { ManagedShare } from "../types";

export function SharesSheet({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [shares, setShares] = useState<ManagedShare[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copyUrl, setCopyUrl] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    let alive = true;
    fetchSharedArtifacts().then(page => {
      if (alive) { setShares(page.shares); setCursor(page.nextCursor); }
    }).catch(e => { if (alive) setError(String(e.message)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);
  async function loadMore() {
    setLoading(true); setError("");
    try {
      const page = await fetchSharedArtifacts(cursor ?? undefined);
      setShares(previous => cursor ? [...previous, ...page.shares.filter(s => !previous.some(p => p.id === s.id))] : page.shares);
      setCursor(page.nextCursor);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }
  async function remove(share: ManagedShare) {
    setBusy(share.id); setError("");
    try {
      await removeSharedArtifact(share.id);
      setShares(previous => previous.filter(s => s.id !== share.id));
      setConfirm(null); setNotice(`Removed “${share.title}”. Its shared link is now disabled.`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }
  async function copy(share: ManagedShare) {
    setNotice(""); setCopyUrl("");
    try { await navigator.clipboard.writeText(share.url); setNotice("Link copied"); }
    catch { setCopyUrl(share.url); }
  }
  return <dialog className="sheet shared-dialog" ref={dialog} aria-labelledby="shares-heading" onCancel={onClose}>
    <header className="sheet-head">
      <h2 id="shares-heading">Shared artifacts</h2>
      <button type="button" className="icon-btn" onClick={onClose} aria-label="Close shared artifacts"><X size={18} /></button>
    </header>
    <p className="secondary">Manage published copies. Removing a share keeps your local artifact.</p>
    {error && <div role="alert" className="feed-message error">{error} <button className="link-btn" onClick={loadMore} disabled={loading}>Retry</button></div>}
    {notice && <p role="status" className="secondary">{notice}</p>}
    {copyUrl && <input aria-label="Share URL" readOnly value={copyUrl} onFocus={e => e.currentTarget.select()} />}
    <div className="sheet-list" aria-busy={loading}>
      {!loading && !error && shares.length === 0 && <p className="secondary">No shared artifacts.</p>}
      {shares.map(share => <div className="shared-row" key={share.id}>
        <div className="sheet-item">
          <div className="sheet-item-text">
            <div className="shared-title">{share.title}</div>
            <div className="secondary">{share.artifact ? `Published rev ${share.artifact.revision}` : "Revision unknown"}{share.status === "expired" ? " · Expired" : ""}</div>
            <div className="secondary">{share.publishedAt ? `Published ${new Date(share.publishedAt).toLocaleString()}` : "Publication time unknown"}</div>
          </div>
          <div className="shared-actions">
            {share.status === "active" && <>
              <a className="icon-btn" href={share.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${share.title}`} title="Open shared artifact"><ExternalLink size={16} /></a>
              <button className="icon-btn" onClick={() => copy(share)} aria-label={`Copy link for ${share.title}`} title="Copy link"><Copy size={16} /></button>
            </>}
            <button className="icon-btn danger" onClick={() => setConfirm(share.id)} disabled={busy !== null} aria-label={`Remove ${share.title}`} title="Remove share"><Trash2 size={16} /></button>
          </div>
        </div>
        {confirm === share.id && <div className="shared-confirm">
          <p>Disable this shared link? Your local artifact stays available.</p>
          <div className="shared-actions">
            <button className="share-button danger" onClick={() => remove(share)} disabled={busy !== null}>{busy === share.id ? "Removing…" : "Remove share"}</button>
            <button className="share-button" onClick={() => setConfirm(null)} disabled={busy !== null}>Cancel</button>
          </div>
        </div>}
      </div>)}
      {loading && <p role="status" className="secondary">Loading shares…</p>}
      {cursor && !loading && <button className="share-button" onClick={loadMore}>Load more</button>}
    </div>
  </dialog>;
}
