import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";

export type FilterKind = "project" | "tag";

interface Option {
  value: string;
  label: string;
  count: number;
}

// Below this many options a search box is just noise.
const SEARCH_MIN = 8;

/**
 * The phone's project/tag picker. Choosing an option applies it and closes
 * the sheet: the counts are already in each row, so a separate confirm step
 * would only add a tap.
 */
export function FilterSheet(props: {
  kind: FilterKind;
  options: Option[];
  allCount: number;
  selected?: string;
  onSelect: (value?: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const noun = props.kind === "project" ? "project" : "tag";
  const needle = query.trim().toLowerCase();
  const visible = needle ? props.options.filter((o) => o.label.toLowerCase().includes(needle)) : props.options;

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog
      className="sheet filter-sheet"
      ref={dialog}
      aria-labelledby="filter-sheet-heading"
      onCancel={props.onClose}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === dialog.current) props.onClose();
      }}
    >
      <header className="sheet-head">
        <h2 id="filter-sheet-heading">{props.kind === "project" ? "Project" : "Tag"}</h2>
        <button type="button" className="icon-btn" onClick={props.onClose} aria-label={`Close ${noun} filter`}>
          <X size={18} />
        </button>
      </header>
      {props.options.length >= SEARCH_MIN && (
        <div className="search">
          <Search size={16} strokeWidth={1.75} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder={`Find a ${noun}`}
            aria-label={`Find a ${noun}`}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}
      <fieldset className="sheet-list filter-options">
        <legend className="sr-only">{props.kind === "project" ? "Project" : "Tag"}</legend>
        {!needle && (
          <FilterOption
            name={props.kind}
            label={props.kind === "project" ? "All projects" : "Any tag"}
            count={props.allCount}
            checked={!props.selected}
            onSelect={() => props.onSelect(undefined)}
          />
        )}
        {visible.map((o) => (
          <FilterOption
            key={o.value}
            name={props.kind}
            label={o.label}
            count={o.count}
            checked={props.selected === o.value}
            onSelect={() => props.onSelect(o.value)}
          />
        ))}
        {visible.length === 0 && <p className="secondary">No {noun} matches “{query.trim()}”.</p>}
      </fieldset>
    </dialog>
  );
}

function FilterOption(props: { name: string; label: string; count: number; checked: boolean; onSelect: () => void }) {
  return (
    <label className={"filter-option" + (props.checked ? " checked" : "")}>
      {/* onClick, not onChange: re-picking the current option must still close
          the sheet, and arrow-key selection fires click on radios too. */}
      <input type="radio" name={props.name} checked={props.checked} onChange={() => undefined} onClick={props.onSelect} />
      <span className="filter-option-label">{props.label}</span>
      <span className="mono">{props.count}</span>
    </label>
  );
}
