import { useEffect, useRef, useState } from "react";
import { FolderCog, Search, X } from "lucide-react";
import { ArtifactPreview, isImageEntry, typeLabel } from "./Render";
import { RelativeTime } from "./RelativeTime";
import type { FeedEntry, FeedPage } from "../types";

export interface FeedFilterState {
  projectId?: string;
  tag?: string;
  q?: string;
}

export function Feed(props: {
  page: FeedPage | null;
  entries: FeedEntry[];
  filter: FeedFilterState;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  onFilterChange: (next: FeedFilterState) => void;
  onOpen: (entry: FeedEntry) => void;
  onLoadMore: () => void;
  onOpenProjects: () => void;
}) {
  const { page, entries, filter } = props;
  const hasFilter = !!(filter.projectId || filter.tag || filter.q);

  return (
    <div className="feed">
      <header className="feed-head">
        <div className="feed-head-row">
          <h1>Artifacts</h1>
          <button
            type="button"
            className="icon-btn"
            onClick={props.onOpenProjects}
            aria-label="manage projects"
            title="manage projects"
          >
            <FolderCog size={18} strokeWidth={1.75} />
          </button>
        </div>
        <SearchBox value={filter.q ?? ""} onChange={(q) => props.onFilterChange({ ...filter, q: q || undefined })} />
        <div className="chips" role="group" aria-label="filters">
          <button
            type="button"
            className={"chip" + (hasFilter ? "" : " active")}
            onClick={() => props.onFilterChange({})}
          >
            All{page ? ` ${page.total}` : ""}
          </button>
          {page?.projects.map((p) => (
            <button
              key={p.projectId}
              type="button"
              className={"chip" + (filter.projectId === p.projectId ? " active" : "")}
              onClick={() =>
                props.onFilterChange({
                  ...filter,
                  projectId: filter.projectId === p.projectId ? undefined : p.projectId,
                })
              }
            >
              {p.projectName} {p.count}
            </button>
          ))}
          {page?.tags.map((t) => (
            <button
              key={t.tag}
              type="button"
              className={"chip tag" + (filter.tag === t.tag ? " active" : "")}
              onClick={() =>
                props.onFilterChange({ ...filter, tag: filter.tag === t.tag ? undefined : t.tag })
              }
            >
              #{t.tag} {t.count}
            </button>
          ))}
        </div>
      </header>

      {props.error && <div className="feed-message error">{props.error}</div>}

      {!props.error && entries.length === 0 && !props.loading && (
        <div className="feed-message">
          {hasFilter ? (
            <>
              <p>Nothing matches this filter.</p>
              <button type="button" className="link-btn" onClick={() => props.onFilterChange({})}>
                Clear filters
              </button>
            </>
          ) : (
            <>
              <p>No artifacts yet.</p>
              <p className="mono">artifacts submit ./report.md --tag weekly</p>
            </>
          )}
        </div>
      )}

      <div className="cards">
        {entries.map((entry) => (
          <Card
            key={entry.id}
            entry={entry}
            onOpen={() => props.onOpen(entry)}
            onTag={(tag) => props.onFilterChange({ ...filter, tag })}
            onProject={(projectId) => props.onFilterChange({ ...filter, projectId })}
          />
        ))}
      </div>

      {page?.nextCursor != null && (
        <button type="button" className="load-more" onClick={props.onLoadMore} disabled={props.loadingMore}>
          {props.loadingMore ? "Loading…" : `Load more (${page.total - entries.length} left)`}
        </button>
      )}
    </div>
  );
}

function SearchBox(props: { value: string; onChange: (value: string) => void }) {
  // Local state so typing stays responsive; the parent filter (and the URL)
  // only updates after a pause, which also keeps history entries readable.
  const [text, setText] = useState(props.value);
  const onChange = props.onChange;

  useEffect(() => setText(props.value), [props.value]);

  useEffect(() => {
    if (text === props.value) return;
    const id = window.setTimeout(() => onChange(text.trim()), 250);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  return (
    <div className="search">
      <Search size={16} strokeWidth={1.75} />
      <input
        type="search"
        value={text}
        placeholder="Search titles, projects, tags"
        onChange={(e) => setText(e.target.value)}
        aria-label="search artifacts"
      />
      {text && (
        <button type="button" className="icon-btn" onClick={() => setText("")} aria-label="clear search">
          <X size={14} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

function Card(props: {
  entry: FeedEntry;
  onOpen: () => void;
  onTag: (tag: string) => void;
  onProject: (projectId: string) => void;
}) {
  const { entry } = props;
  const { ref, seen } = useSeen<HTMLElement>();
  // Images and HTML get a thumbnail above the title; text gets an excerpt
  // below it, because a title under three lines of prose reads backwards.
  const hasThumbnail = entry.type === "html" || isImageEntry(entry);

  return (
    <article className="card" ref={ref}>
      <button type="button" className="card-hit" onClick={props.onOpen}>
        {hasThumbnail && (
          <div className={"card-preview " + entry.type}>
            {seen ? <ArtifactPreview entry={entry} width={640} /> : null}
            <span className="card-type">{typeLabel(entry.type)}</span>
          </div>
        )}
        <h2 className="card-title">{entry.title}</h2>
        {!hasThumbnail && seen && <ArtifactPreview entry={entry} width={640} />}
      </button>
      <div className="card-sub">
        {!hasThumbnail && <span className="badge">{typeLabel(entry.type)}</span>}
        <button type="button" className="chip small" onClick={() => props.onProject(entry.projectId)}>
          {entry.projectName}
        </button>
        {entry.tags.map((tag) => (
          <button key={tag} type="button" className="chip small tag" onClick={() => props.onTag(tag)}>
            #{tag}
          </button>
        ))}
        <RelativeTime iso={entry.submittedAt} />
        {entry.rev > 1 && <span className="rev">rev {entry.rev}</span>}
      </div>
    </article>
  );
}

/** True once the element has been on screen; it never flips back, so a card
 *  that scrolls away keeps its rendered preview instead of thrashing. */
function useSeen<T extends HTMLElement>(): { ref: (node: T | null) => void; seen: boolean } {
  const [seen, setSeen] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  const ref = (node: T | null) => {
    observerRef.current?.disconnect();
    if (!node || seen) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((r) => r.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(node);
    observerRef.current = observer;
  };

  return { ref, seen };
}
