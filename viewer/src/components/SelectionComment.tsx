import { useEffect, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { buildQuote } from "../quote";
import type { CommentQuote } from "../types";

/** The bodies rendered in the viewer's own DOM. HTML and PDF are sandboxed frames it can't see into. */
const SELECTABLE_BODY = ".markdown-body, .plain-text";
/**
 * Tapping the button can clear the selection before the click lands on a
 * phone, so a cleared selection only hides the button after a moment.
 */
const HIDE_DELAY_MS = 250;

function elementOf(node: Node | null): Element | null {
  return node instanceof Element ? node : node?.parentElement ?? null;
}

function readSelectedQuote(): CommentQuote | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const root = elementOf(selection.anchorNode)?.closest(SELECTABLE_BODY);
  if (!root || !root.contains(selection.focusNode)) return null;
  const range = selection.getRangeAt(0);
  const before = document.createRange();
  before.selectNodeContents(root);
  // The metadata panel isn't prose, so it's no help locating a passage.
  const frontmatter = root.querySelector(".frontmatter");
  if (frontmatter && !frontmatter.contains(range.startContainer)) before.setStartAfter(frontmatter);
  before.setEnd(range.startContainer, range.startOffset);
  const after = document.createRange();
  after.selectNodeContents(root);
  after.setStart(range.endContainer, range.endOffset);
  return buildQuote(selection.toString(), before.toString(), after.toString());
}

/**
 * Sits at the bottom of the screen rather than beside the selection: on a phone
 * the system's copy menu and selection handles take the space around it.
 */
export function SelectionComment(props: { disabled: boolean; onComment: (quote: CommentQuote) => void }) {
  const [quote, setQuote] = useState<CommentQuote | null>(null);

  useEffect(() => {
    if (props.disabled) {
      setQuote(null);
      return;
    }
    let hide: number | undefined;
    const onChange = () => {
      window.clearTimeout(hide);
      const next = readSelectedQuote();
      if (next) setQuote(next);
      else hide = window.setTimeout(() => setQuote(null), HIDE_DELAY_MS);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      window.clearTimeout(hide);
      document.removeEventListener("selectionchange", onChange);
    };
  }, [props.disabled]);

  if (!quote) return null;
  return (
    <button
      type="button"
      className="btn selection-comment"
      // Keep the desktop selection alive through the press.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        window.getSelection()?.removeAllRanges();
        setQuote(null);
        props.onComment(quote);
      }}
    >
      <MessageSquarePlus size={16} strokeWidth={2} aria-hidden="true" />
      Comment
    </button>
  );
}
