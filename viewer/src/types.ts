export type ArtifactType =
  | "markdown"
  | "agentuse"
  | "html"
  | "png"
  | "jpg"
  | "webp"
  | "pdf";

export interface ProjectRecord {
  name: string;
  path: string;
  createdAt: string;
  updatedAt?: string;
}

export interface ProjectInfo {
  projectId: string;
  name: string;
  path: string;
}

export interface ArtifactRecord {
  projectId: string;
  name: string;
  type: ArtifactType;
  revision: number;
  contentHash: string;
  size: number;
  createdAt: string;
  /** Agent-supplied initial tile size in CSS px. Suggestion only — the
   *  viewer's persisted user-resize wins, and small values get floored. */
  suggestedWidth?: number;
  suggestedHeight?: number;
  /** Natural pixel dimensions for image artifacts (png/jpg/webp), probed at
   *  ingest. Used to pick a tile default whose aspect ratio matches the
   *  image so non-square images don't letterbox. Lower precedence than a
   *  user resize or the agent-supplied suggestedWidth/Height. */
  naturalWidth?: number;
  naturalHeight?: number;
  local?: boolean;
  localEntry?: string;
  /** POSIX path relative to the registered project root for project-wide
   *  artifact discovery. */
  projectRelPath?: string;
  /** Host-native on-disk path for the primary file. Set by the server for
   *  local artifacts; used by the "Copy path" action. */
  absolutePath?: string;
}

export interface Manifest {
  schemaVersion: number;
  projects: Record<string, ProjectRecord>;
  artifacts: Record<string, ArtifactRecord>;
  latest: Record<string, Record<string, string>>;
}

export interface ProjectIndex {
  schemaVersion: number;
  projects: Record<string, ProjectRecord>;
}

export interface ProjectManifest {
  projectId: string;
  artifacts: Record<string, ArtifactRecord>;
  latest: Record<string, string>;
}

export interface ViewerSettings {
  ignorePatterns: string[];
}

export interface SettingsResponse {
  defaultIgnorePatterns: string[];
  settings: ViewerSettings;
}
