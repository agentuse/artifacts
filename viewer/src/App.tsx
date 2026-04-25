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
}

function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  const route: Route = {};
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const next = parts[i + 1];
    if (part === "p" && next) route.projectId = decodeURIComponent(next);
    if (part === "r" && next) route.runId = decodeURIComponent(next);
    if (part === "a" && next) route.artifactName = decodeURIComponent(next);
    if (part === "v" && next) route.revision = parseInt(next, 10);
  }
  return route;
}

function pushRoute(r: Route): void {
  const parts: string[] = [];
  if (r.projectId) parts.push("p", encodeURIComponent(r.projectId));
  if (r.runId) parts.push("r", encodeURIComponent(r.runId));
  else if (r.artifactName) {
    parts.push("a", encodeURIComponent(r.artifactName));
    if (r.revision != null) parts.push("v", String(r.revision));
  }
  const path = "/" + parts.join("/");
  if (path !== window.location.pathname) {
    window.history.pushState({}, "", path);
  }
}

export function App() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

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
    const onPop = () => setRoute(parseRoute(window.location.pathname));
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
      pushRoute(next);
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
  }, [manifest, route]);

  const onSelectProject = (projectId: string) => {
    if (!manifest) return;
    const runs = Object.entries(manifest.runs)
      .filter(([, r]) => r.projectId === projectId)
      .sort(
        (a, b) =>
          new Date(b[1].createdAt).getTime() - new Date(a[1].createdAt).getTime(),
      );
    const next: Route = { projectId, runId: runs[0]?.[0] };
    setRoute(next);
    pushRoute(next);
  };

  const onSelectRun = (runId: string) => {
    const next: Route = { projectId: route.projectId, runId };
    setRoute(next);
    pushRoute(next);
  };

  if (!manifest) {
    return <div className="empty">Loading…</div>;
  }

  return (
    <div className="app">
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
      <Canvas
        manifest={manifest}
        artifacts={selectedArtifacts}
      />
    </div>
  );
}
