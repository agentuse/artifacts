import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchFeed, feedQuery, type FeedFilter } from "./api";
import { Feed, type FeedFilterState } from "./components/Feed";
import { Detail } from "./components/Detail";
import { ProjectsSheet } from "./components/ProjectsSheet";
import type { FeedEntry, FeedPage } from "./types";

const POLL_MS = 5_000;

interface Route {
  entryId?: string;
  filter: FeedFilterState;
}

function parseRoute(href: string): Route {
  const url = new URL(href);
  const parts = url.pathname.split("/").filter(Boolean);
  const entryId = parts[0] === "a" && parts[1] ? decodeURIComponent(parts[1]) : undefined;
  return {
    entryId,
    filter: {
      projectId: url.searchParams.get("project") ?? undefined,
      tag: url.searchParams.get("tag") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
    },
  };
}

function routePath(route: Route): string {
  const base = route.entryId ? `/a/${encodeURIComponent(route.entryId)}` : "/";
  const params = new URLSearchParams();
  if (route.filter.projectId) params.set("project", route.filter.projectId);
  if (route.filter.tag) params.set("tag", route.filter.tag);
  if (route.filter.q) params.set("q", route.filter.q);
  const query = params.toString();
  return base + (query ? `?${query}` : "");
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.href));
  const [pages, setPages] = useState<FeedPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [notification, setNotification] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const etagRef = useRef<string | null>(null);

  const navigate = useCallback((next: Route, replace = false) => {
    setRoute(next);
    const path = routePath(next);
    if (path === window.location.pathname + window.location.search) return;
    if (replace) window.history.replaceState({}, "", path);
    else window.history.pushState({}, "", path);
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.href));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (!notification) return;
    const id = window.setTimeout(() => setNotification(null), 3600);
    return () => window.clearTimeout(id);
  }, [notification]);

  const filterKey = feedQuery(route.filter as FeedFilter);

  // Poll the first page for the active filter. A 304 means nothing changed, so
  // the common case costs one conditional request and no re-render. When the
  // log does change, pagination resets to page one — new artifacts belong at
  // the top, and silently splicing them into a scrolled list reads as a jump.
  useEffect(() => {
    let alive = true;
    etagRef.current = null;
    setLoading(true);

    const tick = async () => {
      try {
        const result = await fetchFeed(route.filter as FeedFilter, etagRef.current);
        if (!alive) return;
        etagRef.current = result.etag;
        if (!result.notModified && result.page) setPages([result.page]);
        setError(null);
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    };

    void tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  const onLoadMore = useCallback(async () => {
    const last = pages[pages.length - 1];
    if (!last || last.nextCursor == null || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await fetchFeed({ ...(route.filter as FeedFilter), cursor: last.nextCursor });
      if (result.page) setPages((prev) => [...prev, result.page!]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }, [pages, loadingMore, route.filter]);

  const entries = useMemo<FeedEntry[]>(() => {
    const seen = new Set<string>();
    const out: FeedEntry[] = [];
    for (const page of pages) {
      for (const entry of page.entries) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        out.push(entry);
      }
    }
    return out;
  }, [pages]);

  // Facets and total come from page one; nextCursor from the last page loaded.
  const page = useMemo<FeedPage | null>(() => {
    const first = pages[0];
    if (!first) return null;
    return { ...first, nextCursor: pages[pages.length - 1]!.nextCursor };
  }, [pages]);

  if (route.entryId) {
    return (
      <div className="app">
        <Detail
          entryId={route.entryId}
          onBack={() => navigate({ entryId: undefined, filter: route.filter })}
          onOpenEntry={(entryId) => navigate({ entryId, filter: route.filter }, true)}
          onFilter={(filter) => navigate({ entryId: undefined, filter })}
        />
        <Notice notification={notification} />
      </div>
    );
  }

  return (
    <div className="app">
      <Feed
        page={page}
        entries={entries}
        filter={route.filter}
        loading={loading}
        loadingMore={loadingMore}
        error={error}
        onFilterChange={(filter) => navigate({ entryId: undefined, filter })}
        onOpen={(entry) => navigate({ entryId: entry.id, filter: route.filter })}
        onLoadMore={onLoadMore}
        onOpenProjects={() => setProjectsOpen(true)}
      />
      <ProjectsSheet
        open={projectsOpen}
        onClose={() => setProjectsOpen(false)}
        onChanged={() => {
          etagRef.current = null;
        }}
        onNotify={(type, text) => setNotification({ type, text })}
      />
      <Notice notification={notification} />
    </div>
  );
}

function Notice(props: { notification: { type: "success" | "error"; text: string } | null }) {
  if (!props.notification) return null;
  return (
    <div className={`app-notice ${props.notification.type}`} role="status">
      {props.notification.text}
    </div>
  );
}
