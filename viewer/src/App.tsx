import { useEffect, useMemo, useState } from "react";
import { Menu, X } from "lucide-react";
import { fetchManifest } from "./api";
import type { ArtifactRecord, Manifest } from "./types";
import { Sidebar } from "./components/Sidebar";
import { ArtifactList, artifactMatchesGroup, latestGroupFor } from "./components/ArtifactList";
import { Canvas } from "./components/Canvas";
import { loadSort, saveSort, type SortMode } from "./sort";

interface Route {
  projectId?: string;
  artifactName?: string;
  group?: string;
  expandedId?: string;
  drawerOpen?: boolean;
  panesHidden?: boolean;
}

function parseRoute(href: string): Route {
  const u = new URL(href);
  const parts = u.pathname.split("/").filter(Boolean);
  const route: Route = {};
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const next = parts[i + 1];
    if (part === "p" && next) route.projectId = decodeURIComponent(next);
    if (part === "a" && next) route.artifactName = decodeURIComponent(next);
    if (part === "g" && next) route.group = decodeURIComponent(next);
    if (part === "f" && next) route.expandedId = decodeURIComponent(next);
  }
  if (u.searchParams.get("d") === "1") route.drawerOpen = true;
  if (u.searchParams.get("panes") === "0") route.panesHidden = true;
  return route;
}

function navRoute(r: Route, replace = false): void {
  const parts: string[] = [];
  if (r.projectId) parts.push("p", encodeURIComponent(r.projectId));
  if (r.artifactName) {
    parts.push("a", encodeURIComponent(r.artifactName));
  } else if (r.group) {
    parts.push("g", encodeURIComponent(r.group));
  }
  if (r.expandedId) parts.push("f", encodeURIComponent(r.expandedId));
  const params = new URLSearchParams();
  if (r.drawerOpen) params.set("d", "1");
  if (r.panesHidden) params.set("panes", "0");
  const query = params.toString();
  const path = "/" + parts.join("/") + (query ? `?${query}` : "");
  const cur = window.location.pathname + window.location.search;
  if (path !== cur) {
    if (replace) window.history.replaceState({}, "", path);
    else window.history.pushState({}, "", path);
  }
}

export function App() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.href));
  const [sort, setSortState] = useState<SortMode>(() => loadSort());
  const setSort = (next: SortMode) => {
    setSortState(next);
    saveSort(next);
  };

  // Initial fetch + 2s polling per spec.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const m = await fetchManifest();
        if (alive) setManifest(m);
      } catch {
        /* show empty until next poll */
      }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.href));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Default selection on first manifest load: pick a project and land on
  // its most-recently-updated folder so the user sees fresh work without an
  // extra click. Falls back to "All" when the project has no folders.
  useEffect(() => {
    if (!manifest || route.projectId) return;
    const projectIds = Object.keys(manifest.projects);
    const first = projectIds[0];
    if (first) {
      const group = latestGroupFor(manifest, first);
      const next: Route = { projectId: first, group };
      setRoute(next);
      navRoute(next);
    }
  }, [manifest, route.projectId]);

  const selectedArtifacts = useMemo<Array<[string, ArtifactRecord]>>(() => {
    if (!manifest || !route.projectId) return [];
    const all = Object.entries(manifest.artifacts).filter(
      ([, a]) => a.projectId === route.projectId,
    );
    if (route.artifactName) {
      return all.filter(([, a]) => a.name === route.artifactName);
    }
    const latestMap = manifest.latest[route.projectId] ?? {};
    const latest = Object.values(latestMap)
      .map((id) => [id, manifest.artifacts[id]] as [string, ArtifactRecord | undefined])
      .filter((e): e is [string, ArtifactRecord] => !!e[1]);
    if (route.group != null) {
      return latest.filter(([, a]) => artifactMatchesGroup(a, route.group!));
    }
    return latest;
  }, [manifest, route.projectId, route.artifactName, route.group]);

  const drawerOpen = !!route.drawerOpen;
  const panesHidden = !!route.panesHidden;

  const onSelectProject = (projectId: string) => {
    if (!manifest) return;
    // Auto-select the most-recently-updated folder for the new project so
    // the user lands on fresh work. If there are no folders, fall back to
    // "All".
    const group = latestGroupFor(manifest, projectId);
    const next: Route = {
      projectId,
      group,
      drawerOpen: route.drawerOpen,
      panesHidden: route.panesHidden,
    };
    setRoute(next);
    navRoute(next);
  };

  const onSelectArtifact = (artifactName: string | undefined) => {
    const next: Route = {
      projectId: route.projectId,
      artifactName,
      drawerOpen: route.drawerOpen,
      panesHidden: route.panesHidden,
    };
    setRoute(next);
    navRoute(next);
  };

  const onSelectGroup = (group: string | undefined) => {
    const next: Route = {
      projectId: route.projectId,
      group,
      drawerOpen: route.drawerOpen,
      panesHidden: route.panesHidden,
    };
    setRoute(next);
    navRoute(next);
  };

  const onExpandedChange = (id: string | null) => {
    // Fullscreen toggle is transient UI — replaceState so back/forward
    // doesn't flip-flop through every expand/collapse.
    const next: Route = { ...route, expandedId: id ?? undefined };
    setRoute(next);
    navRoute(next, true);
  };

  const setDrawerOpen = (open: boolean) => {
    // One menu button controls panes on every screen size. On desktop the
    // panes are a left overlay; on narrow screens they behave like a drawer.
    const next: Route = {
      ...route,
      drawerOpen: open || undefined,
      panesHidden: open ? undefined : true,
    };
    setRoute(next);
    navRoute(next, true);
  };

  if (!manifest) {
    return <div className="empty">Loading…</div>;
  }

  return (
    <div className={"app" + (drawerOpen ? " drawer-open" : "") + (panesHidden ? " panes-hidden" : "")}>
      <button
        className="menu-btn"
        onClick={() => setDrawerOpen(panesHidden)}
        aria-label={panesHidden ? "show panes" : "hide panes"}
        title={panesHidden ? "show panes" : "hide panes"}
      >
        {panesHidden ? <Menu size={16} strokeWidth={1.75} /> : <X size={14} strokeWidth={1.5} />}
      </button>
      <div className="drawer">
        <div className="drawer-head">
          <div className="sort-toggle" aria-label="sort projects and artifacts">
            <button
              className={sort === "name" ? "active" : ""}
              onClick={() => setSort("name")}
              type="button"
            >
              Name
            </button>
            <button
              className={sort === "updated" ? "active" : ""}
              onClick={() => setSort("updated")}
              type="button"
            >
              Updated
            </button>
          </div>
        </div>
        <Sidebar
          projects={manifest.projects}
          selected={route.projectId}
          sort={sort}
          onSelect={onSelectProject}
        />
        <ArtifactList
          manifest={manifest}
          projectId={route.projectId}
          selected={route.artifactName}
          selectedGroup={route.group}
          sort={sort}
          onSelect={onSelectArtifact}
          onSelectGroup={onSelectGroup}
        />
      </div>
      <div className="backdrop" onClick={() => setDrawerOpen(false)} />
      <Canvas
        artifacts={selectedArtifacts}
        expandedId={route.expandedId ?? null}
        panesHidden={panesHidden}
        onExpandedChange={onExpandedChange}
      />
    </div>
  );
}
