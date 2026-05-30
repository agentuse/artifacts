// Viewer URL helpers. The artifact store itself lives in each project's
// registered project and are scanned on demand by `src/localArtifacts.ts`;
// `./.agentuse/artifacts/` remains the recommended generated-output drop
// zone. The CLI no longer ingests blobs into a central manifest store.

export interface ViewerLocation {
  port: number;
}

export function viewerProjectUrl(loc: ViewerLocation, projectId: string): string {
  return `http://127.0.0.1:${loc.port}/p/${projectId}`;
}

export function viewerArtifactUrl(
  loc: ViewerLocation,
  projectId: string,
  name: string,
): string {
  return `http://127.0.0.1:${loc.port}/p/${projectId}/a/${encodeURIComponent(name)}`;
}
