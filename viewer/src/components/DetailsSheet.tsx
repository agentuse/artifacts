import { useEffect, useRef } from "react";
import { Cloud, Folder, X } from "lucide-react";
import { fmtSize, typeLabel } from "./Render";
import { RelativeTime } from "./RelativeTime";
import type { FeedEntry } from "../types";

/**
 * Revisions and details for the artifact on screen. Everything that used to
 * sit in two always-visible rows under the title bar lives here, so the
 * artifact gets the screen.
 */
export function DetailsSheet(props: {
  entry: FeedEntry;
  revisions: FeedEntry[];
  /** True when the newest revision is what the cloud link serves. */
  latestShared: boolean;
  onOpenRevision: (rev: FeedEntry) => void;
  onFilter: (filter: { projectId?: string; tag?: string }) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { entry, revisions } = props;
  const latestId = revisions[0]?.id;

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog
      className="sheet details-sheet"
      ref={dialog}
      aria-labelledby="details-sheet-heading"
      onCancel={props.onClose}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === dialog.current) props.onClose();
      }}
    >
      <header className="sheet-head">
        <h2 id="details-sheet-heading">{entry.title}</h2>
        <button type="button" className="icon-btn" onClick={props.onClose} aria-label="Close details">
          <X size={18} />
        </button>
      </header>

      <div className="sheet-list">
        {revisions.length > 1 && (
          <fieldset className="filter-options">
            <legend className="details-heading">Revisions</legend>
            {revisions.map((rev) => (
              <label key={rev.id} className={"filter-option" + (rev.id === entry.id ? " checked" : "")}>
                <input
                  type="radio"
                  name="revision"
                  checked={rev.id === entry.id}
                  onChange={() => undefined}
                  onClick={() => props.onOpenRevision(rev)}
                />
                <span className="filter-option-label">rev {rev.rev}</span>
                {rev.id === latestId && <span className="badge-latest">Latest</span>}
                {rev.id === latestId && props.latestShared && (
                  <span className="badge-shared">
                    <Cloud size={14} strokeWidth={2} aria-hidden="true" />
                    Shared
                  </span>
                )}
                <RelativeTime iso={rev.submittedAt} />
              </label>
            ))}
          </fieldset>
        )}

        <section className="details-info" aria-labelledby="details-info-heading">
          <h3 id="details-info-heading" className="details-heading">Details</h3>
          <button type="button" className="details-project" onClick={() => props.onFilter({ projectId: entry.projectId })}>
            <Folder size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>{entry.projectName}</span>
            <span className="details-link">Show in feed</span>
          </button>
          {entry.tags.length > 0 && (
            <div className="details-tags">
              {entry.tags.map((tag) => (
                <button key={tag} type="button" className="chip tag" onClick={() => props.onFilter({ tag })}>
                  #{tag}
                </button>
              ))}
            </div>
          )}
          <p className="mono secondary details-facts">
            {typeLabel(entry)} · {fmtSize(entry.size)}
            {entry.files > 1 ? ` · ${entry.files} files` : ""}
          </p>
        </section>
      </div>
    </dialog>
  );
}


