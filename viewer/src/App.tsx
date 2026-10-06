import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchFeed, feedQuery, latestTarget, targetPath, type EntryTarget, type FeedFilter } from "./api";
import { Feed, type FeedFilterState } from "./components/Feed";
import { Detail } from "./components/Detail";
import { SharesSheet } from "./components/SharesSheet";
import type { FeedEntry, FeedPage } from "./types";

const POLL_MS = 5_000;

interface Route {
  detail?: EntryTarget;
  filter: FeedFilterState;
}

function parseRoute(href: string): Route {
  const url = new URL(href);
  const parts = url.pathname.split("/").filter(Boolean);
  let detail: EntryTarget | undefined;
  try {
    if (parts[0] === "a" && parts[1]) detail = { kind: "entry", id: decodeURIComponent(parts[1]) };
    if (parts[0] === "p" && parts[1] && parts[2]) {
      detail = { kind: "latest", projectId: decodeURIComponent(parts[1]), slug: decodeURIComponent(parts[2]) };
    }
  } catch { /* A malformed link falls back to the feed. */ }
  return {
    detail,
    filter: {
      projectId: url.searchParams.get("project") ?? undefined,
      tag: url.searchParams.get("tag") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
    },
  };
}

function routePath(route: Route): string {
  const base = route.detail ? targetPath(route.detail) : "/";
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
  const [sharesOpen, setSharesOpen] = useState(false);
  const [sharingEnabled, setSharingEnabled] = useState(false);
  useEffect(() => {
    fetch("/api/sharing", { cache: "no-store" }).then(r => r.json()).then(value => setSharingEnabled(value.enabled === true)).catch(() => {});
  }, []);
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

  if (route.detail) {
    return (
      <div className="app">
        <Detail
          target={route.detail}
          onBack={() => navigate({ filter: route.filter })}
          onOpenTarget={(detail) => navigate({ detail, filter: route.filter }, true)}
          onFilter={(filter) => navigate({ filter })}
        />
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
        onFilterChange={(filter) => navigate({ filter })}
        onOpen={(entry) => navigate({ detail: latestTarget(entry), filter: route.filter })}
        onLoadMore={onLoadMore}
        onOpenShares={sharingEnabled ? () => setSharesOpen(true) : undefined}
      />
      {sharesOpen && <SharesSheet onClose={() => setSharesOpen(false)} />}
    </div>
  );
}

