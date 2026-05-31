import type {
  ProjectInfo,
  SettingsResponse,
  ViewerSettings,
  Manifest,
  ProjectIndex,
  ProjectManifest,
} from "./types";

export interface ManifestFetchResult {
  raw: string | null;
  etag: string | null;
  notModified: boolean;
}

export async function fetchManifestRaw(etag?: string | null): Promise<ManifestFetchResult> {
  const res = await fetch("/api/manifest", {
    cache: "no-store",
    headers: etag ? { "if-none-match": etag } : undefined,
  });
  if (res.status === 304) {
    return {
      raw: null,
      etag: res.headers.get("etag") ?? etag ?? null,
      notModified: true,
    };
  }
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
  return {
    raw: await res.text(),
    etag: res.headers.get("etag"),
    notModified: false,
  };
}

export async function fetchManifest(): Promise<Manifest> {
  const result = await fetchManifestRaw();
  if (!result.raw) throw new Error("manifest fetch returned no content");
  return JSON.parse(result.raw) as Manifest;
}

export async function fetchProjects(): Promise<ProjectIndex> {
  return jsonRequest<ProjectIndex>("/api/projects", { method: "GET" });
}

export async function fetchProjectManifestRaw(
  projectId: string,
  etag?: string | null,
): Promise<ManifestFetchResult> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/manifest`, {
    cache: "no-store",
    headers: etag ? { "if-none-match": etag } : undefined,
  });
  if (res.status === 304) {
    return {
      raw: null,
      etag: res.headers.get("etag") ?? etag ?? null,
      notModified: true,
    };
  }
  if (!res.ok) throw new Error(`project manifest fetch failed: ${res.status}`);
  return {
    raw: await res.text(),
    etag: res.headers.get("etag"),
    notModified: false,
  };
}

export async function fetchProjectManifest(projectId: string): Promise<ProjectManifest> {
  const result = await fetchProjectManifestRaw(projectId);
  if (!result.raw) throw new Error("project manifest fetch returned no content");
  return JSON.parse(result.raw) as ProjectManifest;
}

export async function fetchArtifact(idOrUrl: string): Promise<string> {
  const url = idOrUrl.startsWith("/") ? idOrUrl : `/api/artifact/${idOrUrl}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`artifact fetch failed: ${res.status}`);
  return res.text();
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

export async function fetchSettings(): Promise<SettingsResponse> {
  return jsonRequest<SettingsResponse>("/api/settings", { method: "GET" });
}

export async function updateSettings(settings: ViewerSettings): Promise<SettingsResponse> {
  return jsonRequest<SettingsResponse>("/api/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function addProject(path: string): Promise<{
  project: ProjectInfo;
  artifactsDir: string;
}> {
  return jsonRequest("/api/projects", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

export async function removeProject(projectId: string): Promise<void> {
  await jsonRequest(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  });
}

export async function pruneProjects(): Promise<void> {
  await jsonRequest("/api/projects/prune", { method: "POST" });
}
