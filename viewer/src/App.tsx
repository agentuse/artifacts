import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Menu, Settings, X } from "lucide-react";
import { fetchProjectManifestRaw, fetchProjects } from "./api";
import type { ArtifactRecord, Manifest, ProjectIndex, ProjectManifest } from "./types";
import { Sidebar } from "./components/Sidebar";
import { ArtifactList, artifactMatchesGroup, latestGroupFor } from "./components/ArtifactList";
import { Canvas } from "./components/Canvas";
import { SettingsSheet } from "./components/SettingsSheet";
import { loadSort, saveSort, type SortMode } from "./sort";

const MANIFEST_POLL_MS = 5_000;

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
  const [projectIndex, setProjectIndex] = useState<ProjectIndex | null>(null);
  const [projectManifest, setProjectManifest] = useState<ProjectManifest | null>(null);
  const projectManifestRawRef = useRef<Record<string, string>>({});
  const projectManifestEtagRef = useRef<Record<string, string | null>>({});
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.href));
  const [sort, setSortState] = useState<SortMode>(() => loadSort());
  const isMobileNav = useMediaQuery("(max-width: 900px)");
  const [mobileNavPane, setMobileNavPane] = useState<"projects" | "artifacts">("projects");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [flashedProjectId, setFlashedProjectId] = useState<string | null>(null);
  const [notification, setNotification] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const setSort = (next: SortMode) => {
    setSortState(next);
    saveSort(next);
  };

  const notify = useCallback((type: "success" | "error", text: string) => {
    setNotification({ type, text });
  }, []);

  const flashProject = useCallback((projectId: string) => {
    setFlashedProjectId(projectId);
  }, []);

  const refreshProjects = useCallback(async () => {
    setProjectIndex(await fetchProjects());
  }, []);

  useEffect(() => {
    let alive = true;
    fetchProjects()
      .then((next) => {
        if (alive) setProjectIndex(next);
      })
      .catch(() => {
        /* show empty until a user-triggered refresh succeeds */
      });
    return () => {
      alive = false;
    };
  }, []);

  const refreshProjectManifest = useCallback(async (projectId: string) => {
    const result = await fetchProjectManifestRaw(
      projectId,
      projectManifestEtagRef.current[projectId],
    );
    projectManifestEtagRef.current[projectId] = result.etag;
    if (result.notModified || !result.raw) return;
    if (result.raw === projectManifestRawRef.current[projectId]) return;
    projectManifestRawRef.current[projectId] = result.raw;
    setProjectManifest(JSON.parse(result.raw) as ProjectManifest);
  }, []);

  // Poll only the selected project's artifact inventory. The project index is
  // loaded on open and refreshed after settings mutations, not on an interval.
  useEffect(() => {
    if (!route.projectId) return;
    let alive = true;
    const projectId = route.projectId;
    const tick = async () => {
      try {
        await refreshProjectManifest(projectId);
      } catch {
        if (alive && projectManifest?.projectId === projectId) setProjectManifest(null);
      }
    };
    void tick();
    const id = setInterval(tick, MANIFEST_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [refreshProjectManifest, route.projectId, projectManifest?.projectId]);

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

  useEffect(() => {
    if (!flashedProjectId) return;
    const id = window.setTimeout(() => setFlashedProjectId(null), 2400);
    return () => window.clearTimeout(id);
  }, [flashedProjectId]);

  // Default selection on first load: pick a project from the cheap index.
  // Once that project's artifacts arrive, a separate effect lands on its
  // most-recently-updated folder.
  useEffect(() => {
    if (!projectIndex || route.projectId) return;
    const projectIds = Object.keys(projectIndex.projects);
    const first = projectIds[0];
    if (first) {
      const next: Route = { projectId: first };
      setRoute(next);
      navRoute(next);
    }
  }, [projectIndex, route.projectId]);

  const manifest = useMemo<Manifest | null>(() => {
    if (!projectIndex) return null;
    const selectedProjectManifest =
      projectManifest && projectManifest.projectId === route.projectId ? projectManifest : null;
    return {
      schemaVersion: projectIndex.schemaVersion,
      projects: projectIndex.projects,
      artifacts: selectedProjectManifest?.artifacts ?? {},
      latest:
        selectedProjectManifest && route.projectId
          ? { [route.projectId]: selectedProjectManifest.latest }
          : {},
    };
  }, [projectIndex, projectManifest, route.projectId]);

  useEffect(() => {
    if (!manifest || !route.projectId || route.artifactName || route.group != null) return;
    if (projectManifest?.projectId !== route.projectId) return;
    const group = latestGroupFor(manifest, route.projectId);
    if (!group) return;
    const next: Route = { ...route, group };
    setRoute(next);
    navRoute(next, true);
  }, [manifest, projectManifest?.projectId, route]);

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
    const next: Route = {
      projectId,
      drawerOpen: route.drawerOpen,
      panesHidden: route.panesHidden,
    };
    setRoute(next);
    navRoute(next);
    if (isMobileNav) setMobileNavPane("artifacts");
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

  const refreshVisibleData = useCallback(async () => {
    await refreshProjects();
    if (route.projectId) {
      projectManifestEtagRef.current[route.projectId] = null;
      await refreshProjectManifest(route.projectId);
    }
  }, [refreshProjectManifest, refreshProjects, route.projectId]);

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
    if (open && isMobileNav) setMobileNavPane("projects");
  };

  if (!manifest) {
    return <div className="empty">Loading…</div>;
  }

  const selectedProjectName = route.projectId ? manifest.projects[route.projectId]?.name : undefined;

  return (
    <div
      className={
        "app" +
        (drawerOpen ? " drawer-open" : "") +
        (panesHidden ? " panes-hidden" : "") +
        (mobileNavPane === "artifacts" ? " mobile-nav-artifacts" : " mobile-nav-projects")
      }
    >
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
          <button
            className="settings-btn"
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label="open settings"
            title="settings"
          >
            <Settings size={16} strokeWidth={1.75} />
          </button>
        </div>
        <Sidebar
          projects={manifest.projects}
          selected={route.projectId}
          sort={sort}
          flashedProjectId={flashedProjectId}
          onSelect={onSelectProject}
        />
        <ArtifactList
          manifest={manifest}
          projectId={route.projectId}
          selected={route.artifactName}
          selectedGroup={route.group}
          sort={sort}
          mobileBackLabel={selectedProjectName}
          onMobileBack={() => setMobileNavPane("projects")}
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
      <SettingsSheet
        open={settingsOpen}
        manifest={manifest}
        flashedProjectId={flashedProjectId}
        onClose={() => setSettingsOpen(false)}
        onChanged={refreshVisibleData}
        onNotify={notify}
        onProjectAdded={flashProject}
      />
      {notification && (
        <div className={`app-notice ${notification.type}`} role="status">
          {notification.text}
        </div>
      )}
    </div>
  );
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && window.matchMedia(query).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
