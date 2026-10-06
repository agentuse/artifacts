import { useEffect, useRef, useState } from "react";
import { ChevronDown, Cloud, Folder, Hash, Search, X } from "lucide-react";
import { ArtifactPreview, isImageEntry, typeLabel } from "./Render";
import { FilterSheet, type FilterKind } from "./FilterSheet";
import { RelativeTime } from "./RelativeTime";
import type { FeedEntry, FeedPage } from "../types";

export interface FeedFilterState {
  projectId?: string;
  tag?: string;
  q?: string;
}

// The desktop sidebar shows this many before "Show all"; the long tail of
// one-off tags is what turned the old chip row into a wall.
const SIDE_PROJECTS = 6;
const SIDE_TAGS = 12;
const CARD_TAGS = 2;

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
  onOpenShares?: () => void;
}) {
  const { page, entries, filter } = props;
  const [sheet, setSheet] = useState<FilterKind | null>(null);
  const hasFilter = !!(filter.projectId || filter.tag || filter.q);
  // Facets are computed over the whole feed, so their sum is the unfiltered count.
  const allCount = page?.projects.reduce((sum, p) => sum + p.count, 0) ?? 0;
  const projectName = page?.projects.find((p) => p.projectId === filter.projectId)?.projectName;
  const setProject = (projectId?: string) => props.onFilterChange({ ...filter, projectId });
  const setTag = (tag?: string) => props.onFilterChange({ ...filter, tag });

  return (
    <div className="feed">
      <header className="feed-head">
        <div className="feed-head-row">
          <div className="feed-title">
            <h1>Artifacts</h1>
            {page && <span className="mono secondary">{allCount}</span>}
          </div>
          <SearchBox value={filter.q ?? ""} onChange={(q) => props.onFilterChange({ ...filter, q: q || undefined })} />
          {props.onOpenShares && (
            <button type="button" className="pill-btn" onClick={props.onOpenShares}>
              <Cloud size={18} strokeWidth={1.75} aria-hidden="true" />
              <span>Shared</span>
            </button>
          )}
        </div>
        <div className="filter-bar">
          <button
            type="button"
            className={"filter-btn" + (filter.projectId ? " active" : "")}
            onClick={() => setSheet("project")}
            aria-label={filter.projectId ? `Project: ${projectName ?? "unknown"}. Change project` : "Filter by project"}
          >
            <Folder size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>{filter.projectId ? projectName ?? "Unknown project" : "All projects"}</span>
            <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={"filter-btn" + (filter.tag ? " active" : "")}
            onClick={() => setSheet("tag")}
            aria-label={filter.tag ? `Tag: ${filter.tag}. Change tag` : "Filter by tag"}
          >
            <Hash size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>{filter.tag ?? "Any tag"}</span>
            <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
        {hasFilter && page && (
          <div className="filter-summary">
            <span className="mono secondary">
              {page.total} of {allCount}
            </span>
            <button type="button" className="link-btn" onClick={() => props.onFilterChange({})}>
              Clear filters
            </button>
          </div>
        )}
      </header>

      <div className="feed-body">
        {page && (
          <SideFilters page={page} filter={filter} allCount={allCount} onProject={setProject} onTag={setTag} />
        )}

        <main className="feed-main">
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
                showProject={!filter.projectId}
                onOpen={() => props.onOpen(entry)}
              />
            ))}
          </div>

          {page?.nextCursor != null && (
            <button type="button" className="load-more" onClick={props.onLoadMore} disabled={props.loadingMore}>
              {props.loadingMore ? "Loading…" : `Load more (${page.total - entries.length} left)`}
            </button>
          )}
        </main>
      </div>

      {sheet && page && (
        <FilterSheet
          kind={sheet}
          options={
            sheet === "project"
              ? page.projects.map((p) => ({ value: p.projectId, label: p.projectName, count: p.count }))
              : page.tags.map((t) => ({ value: t.tag, label: `#${t.tag}`, count: t.count }))
          }
          allCount={allCount}
          selected={sheet === "project" ? filter.projectId : filter.tag}
          onSelect={(value) => {
            if (sheet === "project") setProject(value);
            else setTag(value);
            setSheet(null);
          }}
          onClose={() => setSheet(null)}
        />
      )}
    </div>
  );
}

/** Desktop only (CSS hides it on a phone, where the filter bar opens a sheet). */
function SideFilters(props: {
  page: FeedPage;
  filter: FeedFilterState;
  allCount: number;
  onProject: (projectId?: string) => void;
  onTag: (tag?: string) => void;
}) {
  const { page, filter } = props;
  const [allProjects, setAllProjects] = useState(false);
  const [allTags, setAllTags] = useState(false);
  const projects = allProjects ? page.projects : page.projects.slice(0, SIDE_PROJECTS);
  const tags = allTags ? page.tags : page.tags.slice(0, SIDE_TAGS);

  return (
    <nav className="feed-side" aria-label="Filters">
      <section>
        <h2 className="side-heading">Projects</h2>
        <button
          type="button"
          className={"side-item" + (filter.projectId ? "" : " active")}
          aria-pressed={!filter.projectId}
          onClick={() => props.onProject(undefined)}
        >
          <span>All projects</span>
          <span className="mono">{props.allCount}</span>
        </button>
        {projects.map((p) => (
          <button
            key={p.projectId}
            type="button"
            className={"side-item" + (filter.projectId === p.projectId ? " active" : "")}
            aria-pressed={filter.projectId === p.projectId}
            onClick={() => props.onProject(filter.projectId === p.projectId ? undefined : p.projectId)}
          >
            <span>{p.projectName}</span>
            <span className="mono">{p.count}</span>
          </button>
        ))}
        {page.projects.length > SIDE_PROJECTS && (
          <button type="button" className="side-more" onClick={() => setAllProjects(!allProjects)}>
            {allProjects ? "Show fewer" : `Show all ${page.projects.length}`}
          </button>
        )}
      </section>

      {page.tags.length > 0 && (
        <section>
          <h2 className="side-heading">Tags</h2>
          <div className="side-tags">
            {tags.map((t) => (
              <button
                key={t.tag}
                type="button"
                className={"chip tag" + (filter.tag === t.tag ? " active" : "")}
                aria-pressed={filter.tag === t.tag}
                onClick={() => props.onTag(filter.tag === t.tag ? undefined : t.tag)}
              >
                #{t.tag} {t.count}
              </button>
            ))}
          </div>
          {page.tags.length > SIDE_TAGS && (
            <button type="button" className="side-more" onClick={() => setAllTags(!allTags)}>
              {allTags ? "Show fewer" : `Show all ${page.tags.length} tags`}
            </button>
          )}
        </section>
      )}
    </nav>
  );
}

function SearchBox(props: { value: string; onChange: (value: string) => void }) {
  // Local state so typing stays responsive; the parent filter (and the URL)
  // only updates after a pause, which also keeps history entries readable.
  const [text, setText] = useState(props.value);
  const inputRef = useRef<HTMLInputElement>(null);
  const onChange = props.onChange;

  useEffect(() => setText(props.value), [props.value]);

  useEffect(() => {
    if (text === props.value) return;
    const id = window.setTimeout(() => onChange(text.trim()), 250);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // "/" focuses search, unless the user is already typing somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="search">
      <Search size={16} strokeWidth={1.75} aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        value={text}
        placeholder="Search artifacts"
        onChange={(e) => setText(e.target.value)}
        aria-label="Search artifacts"
      />
      {text ? (
        <button type="button" className="icon-btn" onClick={() => setText("")} aria-label="Clear search">
          <X size={14} strokeWidth={2} />
        </button>
      ) : (
        <kbd className="search-key" aria-hidden="true">/</kbd>
      )}
    </div>
  );
}

function Card(props: { entry: FeedEntry; showProject: boolean; onOpen: () => void }) {
  const { entry } = props;
  const { ref, seen } = useSeen<HTMLElement>();
  // Images and HTML get a thumbnail above the title; text gets an excerpt
  // below it, because a title under three lines of prose reads backwards.
  const hasThumbnail = entry.type === "html" || isImageEntry(entry);
  const extraTags = entry.tags.length - CARD_TAGS;

  return (
    <article className="card" ref={ref}>
      <button type="button" className="card-hit" onClick={props.onOpen}>
        {hasThumbnail && (
          <div className={"card-preview " + entry.type}>
            {seen ? <ArtifactPreview entry={entry} width={640} /> : null}
            <span className="card-type">{typeLabel(entry.type)}</span>
          </div>
        )}
        <span className="card-head">
          <h2 className="card-title">{entry.title}</h2>
          {!hasThumbnail && <span className="card-type inline">{typeLabel(entry.type)}</span>}
        </span>
        {!hasThumbnail && seen && <ArtifactPreview entry={entry} width={640} />}
        <span className="card-meta">
          {props.showProject && <span>{entry.projectName}</span>}
          <RelativeTime iso={entry.submittedAt} />
          {entry.rev > 1 && <span>rev {entry.rev}</span>}
          {entry.cloudShared && (
            <span className="card-shared">
              <Cloud size={14} strokeWidth={2} aria-hidden="true" />
              Shared
            </span>
          )}
        </span>
        {entry.tags.length > 0 && (
          <span className="card-tags">
            {entry.tags.slice(0, CARD_TAGS).map((tag) => `#${tag}`).join("  ")}
            {extraTags > 0 ? `  +${extraTags}` : ""}
          </span>
        )}
      </button>
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
