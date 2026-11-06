import type { CommentQuote } from "./types";

const MAX_QUOTE_CHARS = 1000;
const CONTEXT_CHARS = 80;

/** A cut can land between the two halves of an emoji; drop the stray half. */
function dropBrokenPairs(text: string): string {
  return text.replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/g, "");
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ");
}

/**
 * What gets saved for a selection. The context is what tells apart a phrase
 * that appears more than once, so it survives the quote being long. Returns
 * null for a selection with nothing in it.
 */
export function buildQuote(selected: string, textBefore: string, textAfter: string): CommentQuote | null {
  const text = selected.trim();
  if (!text) return null;
  const clipped = text.length > MAX_QUOTE_CHARS ? `${dropBrokenPairs(text.slice(0, MAX_QUOTE_CHARS))}…` : text;
  // Whitespace trimmed off the selection belongs to the context, or the words
  // on either side of the passage read as joined to it.
  const lead = selected.slice(0, selected.length - selected.trimStart().length);
  const trail = selected.slice(selected.trimEnd().length);
  const before = dropBrokenPairs(collapse(textBefore + lead).slice(-CONTEXT_CHARS)).trimStart();
  const after = dropBrokenPairs(collapse(trail + textAfter).slice(0, CONTEXT_CHARS)).trimEnd();
  return { text: clipped, ...(before ? { before } : {}), ...(after ? { after } : {}) };
}
