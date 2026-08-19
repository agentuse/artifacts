import type { EntryDetail, FeedEntry, FeedPage } from "./types";

export interface FeedFilter {
  projectId?: string;
  tag?: string;
  q?: string;
  cursor?: number;
  limit?: number;
}

export interface FeedFetchResult {
  page: FeedPage | null;
  etag: string | null;
  notModified: boolean;
}

export function feedQuery(filter: FeedFilter): string {
  const params = new URLSearchParams();
  if (filter.projectId) params.set("project", filter.projectId);
  if (filter.tag) params.set("tag", filter.tag);
  if (filter.q) params.set("q", filter.q);
  if (filter.cursor) params.set("cursor", String(filter.cursor));
  if (filter.limit) params.set("limit", String(filter.limit));
  const query = params.toString();
  return query ? `?${query}` : "";
}

export async function fetchFeed(
  filter: FeedFilter,
  etag?: string | null,
): Promise<FeedFetchResult> {
  const res = await fetch(`/api/feed${feedQuery(filter)}`, {
    cache: "no-store",
    headers: etag ? { "if-none-match": etag } : undefined,
  });
  if (res.status === 304) {
    return { page: null, etag: res.headers.get("etag") ?? etag ?? null, notModified: true };
  }
  if (!res.ok) throw new Error(`feed fetch failed: ${res.status}`);
  return { page: (await res.json()) as FeedPage, etag: res.headers.get("etag"), notModified: false };
}

export interface EntryFetchResult {
  detail: EntryDetail | null;
  etag: string | null;
  notModified: boolean;
}

export async function fetchEntry(id: string, etag?: string | null): Promise<EntryFetchResult> {
  const res = await fetch(`/api/entry/${encodeURIComponent(id)}`, {
    cache: "no-store",
    headers: etag ? { "if-none-match": etag } : undefined,
  });
  if (res.status === 304) {
    return { detail: null, etag: res.headers.get("etag") ?? etag ?? null, notModified: true };
  }
  if (res.status === 404) throw new Error("This artifact is no longer in the feed.");
  if (!res.ok) throw new Error(`entry fetch failed: ${res.status}`);
  return { detail: (await res.json()) as EntryDetail, etag: res.headers.get("etag"), notModified: false };
}

/** Bundle file URL. Bundles are immutable, so no cache-busting is needed. */
export function bundleUrl(entry: FeedEntry, relPath = entry.entry): string {
  const encoded = relPath.split("/").map(encodeURIComponent).join("/");
  return `/api/store/${encodeURIComponent(entry.id)}/${encoded}`;
}

export function previewUrl(entry: FeedEntry, width: number): string {
  return `/api/preview/${encodeURIComponent(entry.id)}?w=${width}`;
}

export function rawUrl(entry: FeedEntry): string {
  return `/api/raw/${encodeURIComponent(entry.id)}`;
}

export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  return res.text();
}

/** Delete every artifact submitted from a project, feed lines and bundles. */
export async function removeProject(projectId: string): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await res.text());
}
