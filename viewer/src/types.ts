export type ArtifactType =
  | "markdown"
  | "html"
  | "png"
  | "jpg"
  | "webp"
  | "pdf";

export interface ProjectRecord {
  name: string;
  path: string;
  createdAt: string;
}

export interface RunRecord {
  projectId: string;
  createdAt: string;
}

export interface ArtifactRecord {
  projectId: string;
  runId?: string;
  name: string;
  type: ArtifactType;
  revision: number;
  previousArtifactId?: string;
  contentHash: string;
  size: number;
  createdAt: string;
}

export interface Manifest {
  schemaVersion: number;
  projects: Record<string, ProjectRecord>;
  runs: Record<string, RunRecord>;
  artifacts: Record<string, ArtifactRecord>;
  latest: Record<string, Record<string, string>>;
}
