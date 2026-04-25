import { useEffect, useMemo, useState } from "react";
import { fetchManifest } from "./api";
import type { ArtifactRecord, Manifest } from "./types";
import { Sidebar } from "./components/Sidebar";
import { RunList } from "./components/RunList";
import { Canvas } from "./components/Canvas";

interface Route {
  projectId?: string;
  runId?: string;
  artifactName?: string;
  revision?: number;
  expandedId?: string;
  drawerOpen?: boolean;
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
  const path = "/" + parts.join("/") + (r.drawerOpen ? "?d=1" : "");
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

  // Default selection on first manifest load.
  useEffect(() => {
    if (!manifest || route.projectId) return;
    const projectIds = Object.keys(manifest.projects);
    const first = projectIds[0];
    if (first) {
      const runs = Object.entries(manifest.runs)
        .filter(([, r]) => r.projectId === first)
        .sort(
          (a, b) =>
            new Date(b[1].createdAt).getTime() - new Date(a[1].createdAt).getTime(),
        );
      const firstRun = runs[0]?.[0];
      const next: Route = { projectId: first, runId: firstRun };
      setRoute(next);
      navRoute(next);
    }
  }, [manifest, route.projectId]);

  const selectedArtifacts = useMemo<Array<[string, ArtifactRecord]>>(() => {
    if (!manifest || !route.projectId) return [];
    const all = Object.entries(manifest.artifacts).filter(
      ([, a]) => a.projectId === route.projectId,
    );
    if (route.runId) {
      const byName = new Map<string, [string, ArtifactRecord]>();
      for (const entry of all) {
        const [, rec] = entry;
        if (rec.runId !== route.runId) continue;
        const cur = byName.get(rec.name);
        if (!cur || cur[1].revision < rec.revision) byName.set(rec.name, entry);
      }
      return [...byName.values()];
    }
    if (route.artifactName) {
      return all
        .filter(([, a]) => a.name === route.artifactName)
        .filter(([, a]) => route.revision == null || a.revision === route.revision);
    }
    const latestMap = manifest.latest[route.projectId] ?? {};
    return Object.values(latestMap)
      .map((id) => [id, manifest.artifacts[id]] as [string, ArtifactRecord | undefined])
      .filter((e): e is [string, ArtifactRecord] => !!e[1]);
  }, [manifest, route.projectId, route.runId, route.artifactName, route.revision]);

  const drawerOpen = !!route.drawerOpen;

  const onSelectProject = (projectId: string) => {
    if (!manifest) return;
    const runs = Object.entries(manifest.runs)
      .filter(([, r]) => r.projectId === projectId)
      .sort(
        (a, b) =>
          new Date(b[1].createdAt).getTime() - new Date(a[1].createdAt).getTime(),
      );
    const next: Route = { projectId, runId: runs[0]?.[0], drawerOpen: route.drawerOpen };
    setRoute(next);
    navRoute(next);
  };

  const onSelectRun = (runId: string) => {
    // Close the drawer on a run pick (navigation is intentional, the user
    // wants the canvas next). Use replace so the closing isn't a history step.
    const next: Route = { projectId: route.projectId, runId };
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
    // Drawer toggle is transient too.
    const next: Route = { ...route, drawerOpen: open || undefined };
    setRoute(next);
    navRoute(next, true);
  };

  if (!manifest) {
    return <div className="empty">Loading…</div>;
  }

  return (
    <div className={"app" + (drawerOpen ? " drawer-open" : "")}>
      <button
        className="menu-btn"
        onClick={() => setDrawerOpen(!drawerOpen)}
        aria-label={drawerOpen ? "close menu" : "open menu"}
      >
        {drawerOpen ? "✕" : "☰"}
      </button>
      <div className="drawer">
        <Sidebar
          projects={manifest.projects}
          selected={route.projectId}
          onSelect={onSelectProject}
        />
        <RunList
          manifest={manifest}
          projectId={route.projectId}
          selected={route.runId}
          onSelect={onSelectRun}
        />
      </div>
      <div className="backdrop" onClick={() => setDrawerOpen(false)} />
      <Canvas
        manifest={manifest}
        artifacts={selectedArtifacts}
        expandedId={route.expandedId ?? null}
        onExpandedChange={onExpandedChange}
      />
    </div>
  );
}
