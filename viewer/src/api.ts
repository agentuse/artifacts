import type { Manifest } from "./types";

export async function fetchManifest(): Promise<Manifest> {
  const res = await fetch("/api/manifest", { cache: "no-store" });
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchArtifact(id: string): Promise<string> {
  const res = await fetch(`/api/artifact/${id}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`artifact fetch failed: ${res.status}`);
  return res.text();
}
