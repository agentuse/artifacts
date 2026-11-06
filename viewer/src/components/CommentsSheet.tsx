import { useEffect, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { postComment, resolveComment } from "../api";
import { RelativeTime } from "./RelativeTime";
import type { Comment, FeedEntry } from "../types";

function commentStatus(comment: Comment): string {
  if (comment.resolvedAt) return "Resolved";
  return comment.notifiedAt ? "Agent notified" : "Waiting for the agent";
}

/** Notes for the agent that made this artifact. They carry over to new revisions. */
export function CommentsSheet(props: {
  entry: FeedEntry;
  comments: Comment[];
  draft: string;
  onDraftChange: (draft: string) => void;
  onChanged: (comment: Comment) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (sending || !props.draft.trim()) return;
    setSending(true);
    setError(null);
    try {
      props.onChanged(await postComment(props.entry.id, props.draft));
      props.onDraftChange("");
    } catch (err) {
      // The draft stays put so nothing typed is lost.
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const resolve = async (comment: Comment) => {
    setError(null);
    try {
      props.onChanged(await resolveComment(comment.id));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <dialog
      className="sheet details-sheet comments-sheet"
      ref={dialog}
      aria-labelledby="comments-sheet-heading"
      onCancel={props.onClose}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === dialog.current) props.onClose();
      }}
    >
      <header className="sheet-head">
        <h2 id="comments-sheet-heading">Comments</h2>
        <button type="button" className="icon-btn" onClick={props.onClose} aria-label="Close comments">
          <X size={18} />
        </button>
      </header>

      <div className="sheet-list">
        {props.comments.length === 0 ? (
          <p className="comments-empty">Tell the agent what to change. It sees comments when it next works on this artifact.</p>
        ) : (
          props.comments.map((comment) => (
            <article key={comment.id} className={"comment" + (comment.resolvedAt ? " resolved" : "")}>
              <p className="comment-body">{comment.body}</p>
              <div className="comment-meta">
                <span>{commentStatus(comment)}</span>
                <span aria-hidden="true">·</span>
                <span>rev {comment.rev}</span>
                <span aria-hidden="true">·</span>
                <RelativeTime iso={comment.createdAt} />
                {comment.resolvedAt ? null : (
                  <button type="button" className="link-btn" onClick={() => void resolve(comment)}>
                    Resolve
                  </button>
                )}
              </div>
            </article>
          ))
        )}
      </div>

      <form className="comment-form" onSubmit={(e) => void send(e)}>
        <textarea
          value={props.draft}
          onChange={(e) => props.onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
          }}
          placeholder="Add a comment"
          aria-label="Add a comment"
          rows={3}
        />
        {error ? <p className="comment-error" role="alert">{error}</p> : null}
        <div className="comment-form-row">
          <button type="submit" className="btn" disabled={sending || !props.draft.trim()}>
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
