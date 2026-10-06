// Viewer URL helpers. Artifacts are submitted into the store and listed by the
// feed log; the viewer is a feed at `/` plus a detail page per entry.

export interface ViewerLocation {
  port: number;
}

export function viewerFeedUrl(
  loc: ViewerLocation,
  filter: { projectId?: string; tag?: string } = {},
): string {
  const params = new URLSearchParams();
  if (filter.projectId) params.set("project", filter.projectId);
  if (filter.tag) params.set("tag", filter.tag);
  const query = params.toString();
  return `http://127.0.0.1:${loc.port}/${query ? `?${query}` : ""}`;
}

export function viewerEntryUrl(loc: ViewerLocation, entryId: string): string {
  return `http://127.0.0.1:${loc.port}/a/${encodeURIComponent(entryId)}`;
}

/** A permalink that always opens the newest revision of one artifact. */
export function viewerLatestUrl(loc: ViewerLocation, projectId: string, slug: string): string {
  return `http://127.0.0.1:${loc.port}/latest/${encodeURIComponent(projectId)}/${encodeURIComponent(slug)}`;
}
