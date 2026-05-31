import type { Manifest } from "./types";

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
