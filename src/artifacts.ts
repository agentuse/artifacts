// Viewer URL helpers. Artifacts are submitted into the store and listed by the
// feed log; the viewer is a feed at `/` plus a detail page per entry.

export interface ViewerLocation {
  port: number;
}

/**
 * Where links point. ARTIFACTS_VIEWER_URL (e.g. the viewer's Tailscale name)
 * makes every printed link open on the user's other devices too; without it
 * links are loopback and only work on this machine.
 */
function viewerOrigin(loc: ViewerLocation): string {
  const configured = process.env.ARTIFACTS_VIEWER_URL?.trim().replace(/\/+$/, "");
  return configured || `http://127.0.0.1:${loc.port}`;
}

export function viewerFeedUrl(
  loc: ViewerLocation,
  filter: { projectId?: string; tag?: string } = {},
): string {
  const params = new URLSearchParams();
  if (filter.projectId) params.set("project", filter.projectId);
  if (filter.tag) params.set("tag", filter.tag);
  const query = params.toString();
  return `${viewerOrigin(loc)}/${query ? `?${query}` : ""}`;
}

export function viewerEntryUrl(loc: ViewerLocation, entryId: string): string {
  return `${viewerOrigin(loc)}/a/${encodeURIComponent(entryId)}`;
}

/** A permalink that always opens the newest revision of one artifact. */
export function viewerLatestUrl(loc: ViewerLocation, projectId: string, slug: string): string {
  return `${viewerOrigin(loc)}/p/${encodeURIComponent(projectId)}/${encodeURIComponent(slug)}`;
}
