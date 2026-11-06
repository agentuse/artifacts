import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { X } from "lucide-react";
import { postComment, resolveComment } from "../api";
import { RelativeTime } from "./RelativeTime";
import type { Comment, CommentQuote, FeedEntry } from "../types";

/**
 * A highlighted passage waiting to be sent. It remembers its revision so the
 * comment says what the user was reading, even if a new one arrives meanwhile.
 */
export interface PendingQuote {
  quote: CommentQuote;
  entryId: string;
}

function commentStatus(comment: Comment): string {
  if (comment.resolvedAt) return "Resolved";
  return comment.notifiedAt ? "Agent notified" : "Waiting for the agent";
}

/**
 * iOS keeps the page full height under the on-screen keyboard, so a sheet
 * anchored to the bottom of the screen sits behind it. Follow the visible area
 * instead while the keyboard is up.
 */
function useKeyboardAvoidance(): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties>();
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const covered = Math.round(window.innerHeight - viewport.height - viewport.offsetTop);
      setStyle(covered > 0 ? { bottom: covered, maxHeight: Math.round(viewport.height) - 8 } : undefined);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return style;
}

/** Notes for the agent that made this artifact. They carry over to new revisions. */
export function CommentsSheet(props: {
  entry: FeedEntry;
  comments: Comment[];
  draft: string;
  onDraftChange: (draft: string) => void;
  pendingQuote: PendingQuote | null;
  onClearQuote: () => void;
  onChanged: (comment: Comment) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const keyboardStyle = useKeyboardAvoidance();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
    // showModal focuses the close button. Arriving from a highlight means the
    // next thing to do is type; opening from the header might only be to read.
    if (props.pendingQuote) textarea.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (sending || !props.draft.trim()) return;
    setSending(true);
    setError(null);
    try {
      const pending = props.pendingQuote;
      props.onChanged(await postComment(pending?.entryId ?? props.entry.id, props.draft, pending?.quote));
      props.onDraftChange("");
      props.onClearQuote();
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
      style={keyboardStyle}
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
          props.pendingQuote ? null : <p className="comments-empty">Tell the agent what to change. It sees comments when it next works on this artifact.</p>
        ) : (
          props.comments.map((comment) => (
            <article key={comment.id} className={"comment" + (comment.resolvedAt ? " resolved" : "")}>
              {comment.quote ? <blockquote className="comment-quote">{comment.quote.text}</blockquote> : null}
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
        {props.pendingQuote ? (
          <div className="comment-pending-quote">
            <blockquote className="comment-quote">{props.pendingQuote.quote.text}</blockquote>
            <button type="button" className="icon-btn" onClick={props.onClearQuote} aria-label="Remove highlighted text">
              <X size={16} />
            </button>
          </div>
        ) : null}
        <textarea
          ref={textarea}
          value={props.draft}
          onChange={(e) => props.onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
          }}
          placeholder={props.pendingQuote ? "Comment on this passage" : "Add a comment"}
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
