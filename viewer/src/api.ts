import type { Comment, CommentQuote, EntryDetail, FeedEntry, FeedPage } from "./types";

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

/**
 * What a detail page shows: one immutable revision, or whichever revision of
 * an artifact is newest. The newest revision is always shown via "latest", so
 * the address bar holds the permalink and copying it hands out a link that
 * keeps working as the artifact is re-submitted.
 */
export type EntryTarget = { kind: "entry"; id: string } | { kind: "latest"; projectId: string; slug: string };

export function latestTarget(entry: FeedEntry): EntryTarget {
  return { kind: "latest", projectId: entry.projectId, slug: entry.slug };
}

export function targetPath(target: EntryTarget): string {
  return target.kind === "entry"
    ? `/a/${encodeURIComponent(target.id)}`
    : `/p/${encodeURIComponent(target.projectId)}/${encodeURIComponent(target.slug)}`;
}

export async function fetchEntry(target: EntryTarget, etag?: string | null): Promise<EntryFetchResult> {
  // Page paths and API paths are named independently; never derive one from the other.
  const api = target.kind === "entry"
    ? `/api/entry/${encodeURIComponent(target.id)}`
    : `/api/latest/${encodeURIComponent(target.projectId)}/${encodeURIComponent(target.slug)}`;
  const res = await fetch(api, {
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

export async function shareEntry(id: string): Promise<{ id: string; url: string }> {
  const response = await fetch(`/api/entry/${encodeURIComponent(id)}/share`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-artifacts-share": "1" },
    body: "{}",
  });
  if (response.headers.get("content-type")?.includes("text/html")) {
    throw new Error("The artifact server is out of date. Rebuild and restart it to enable sharing.");
  }
  if (!response.ok) throw new Error(await response.text());
  const result = await response.json() as { id?: unknown; url?: unknown };
  if (typeof result.id !== "string" || typeof result.url !== "string") {
    throw new Error("The sharing service returned an invalid link. Please retry.");
  }
  return { id: result.id, url: result.url };
}

/** Sends the same gate header as sharing: comments wake agents, so the same origin rules apply. */
async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-artifacts-share": "1" },
    body: JSON.stringify(body),
  });
  if (response.headers.get("content-type")?.includes("text/html")) {
    throw new Error("The artifact server is out of date. Rebuild and restart it to enable comments.");
  }
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

export function postComment(entryId: string, body: string, quote?: CommentQuote): Promise<Comment> {
  return postJson(`/api/entry/${encodeURIComponent(entryId)}/comments`, { body, quote });
}

export function resolveComment(id: string): Promise<Comment> {
  return postJson(`/api/comments/${encodeURIComponent(id)}/resolve`, {});
}

const managementHeaders = { "content-type": "application/json", "x-artifacts-share": "1" };
export async function fetchSharedArtifacts(cursor?: string): Promise<{ shares: import("./types").ManagedShare[]; nextCursor: string | null }> {
  const response = await fetch(`/api/shares${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { headers: managementHeaders, cache: "no-store" });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
export async function removeSharedArtifact(id: string): Promise<void> {
  const response = await fetch(`/api/shares/${encodeURIComponent(id)}`, { method: "DELETE", headers: managementHeaders });
  if (!response.ok) throw new Error(await response.text());
}
