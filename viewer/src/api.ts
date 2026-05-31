import type { ProjectInfo, SettingsResponse, Manifest } from "./types";

export async function fetchManifestRaw(): Promise<string> {
  const res = await fetch("/api/manifest", { cache: "no-store" });
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
  return res.text();
}

export async function fetchManifest(): Promise<Manifest> {
  return JSON.parse(await fetchManifestRaw()) as Manifest;
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

export async function updateSettings(ignorePatterns: string[]): Promise<SettingsResponse> {
  return jsonRequest<SettingsResponse>("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ ignorePatterns }),
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
