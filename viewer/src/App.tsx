import { useEffect, useMemo, useState } from "react";
import { Menu } from "lucide-react";
import { fetchManifest } from "./api";
import type { ArtifactRecord, Manifest } from "./types";
import { Sidebar } from "./components/Sidebar";
import { ArtifactList } from "./components/ArtifactList";
import { Canvas } from "./components/Canvas";

interface Route {
  projectId?: string;
  runId?: string;
  artifactName?: string;
  revision?: number;
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
    if (part === "r" && next) route.runId = decodeURIComponent(next);
    if (part === "a" && next) route.artifactName = decodeURIComponent(next);
    if (part === "v" && next) route.revision = parseInt(next, 10);
    if (part === "f" && next) route.expandedId = decodeURIComponent(next);
  }
  if (u.searchParams.get("d") === "1") route.drawerOpen = true;
  if (u.searchParams.get("panes") === "0") route.panesHidden = true;
  return route;
}

function navRoute(r: Route, replace = false): void {
  const parts: string[] = [];
  if (r.projectId) parts.push("p", encodeURIComponent(r.projectId));
  if (r.runId) {
    parts.push("r", encodeURIComponent(r.runId));
  } else if (r.artifactName) {
    parts.push("a", encodeURIComponent(r.artifactName));
    if (r.revision != null) parts.push("v", String(r.revision));
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

  // Default selection on first manifest load: just the project. Run is now
  // an optional filter, not the primary lens, so we land on "all latest
  // artifacts" (project home) rather than auto-picking a run.
  useEffect(() => {
    if (!manifest || route.projectId) return;
    const projectIds = Object.keys(manifest.projects);
    const first = projectIds[0];
    if (first) {
      const next: Route = { projectId: first };
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
      return all
        .filter(([, a]) => a.name === route.artifactName)
        .filter(([, a]) => route.revision == null || a.revision === route.revision);
    }
    const latestMap = manifest.latest[route.projectId] ?? {};
    return Object.values(latestMap)
      .map((id) => [id, manifest.artifacts[id]] as [string, ArtifactRecord | undefined])
      .filter((e): e is [string, ArtifactRecord] => !!e[1]);
  }, [manifest, route.projectId, route.artifactName, route.revision]);

  const drawerOpen = !!route.drawerOpen;
  const panesHidden = !!route.panesHidden;

  const onSelectProject = (projectId: string) => {
    if (!manifest) return;
    // Land on project home (all latest), not a specific run.
    const next: Route = { projectId, drawerOpen: route.drawerOpen, panesHidden: route.panesHidden };
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
      {panesHidden && (
        <button
          className="menu-btn"
          onClick={() => setDrawerOpen(true)}
          aria-label="show panes"
          title="show panes"
        >
          <Menu size={18} strokeWidth={2} />
        </button>
      )}
      <div className="drawer">
        <Sidebar
          projects={manifest.projects}
          selected={route.projectId}
          onSelect={onSelectProject}
          onClose={() => setDrawerOpen(false)}
        />
        <ArtifactList
          manifest={manifest}
          projectId={route.projectId}
          selected={route.artifactName}
          onSelect={onSelectArtifact}
        />
      </div>
      <div className="backdrop" onClick={() => setDrawerOpen(false)} />
      <Canvas
        manifest={manifest}
        artifacts={selectedArtifacts}
        expandedId={route.expandedId ?? null}
        panesHidden={panesHidden}
        onExpandedChange={onExpandedChange}
      />
    </div>
  );
}
