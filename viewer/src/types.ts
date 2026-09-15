export type ArtifactType =
  | "markdown"
  | "agentuse"
  | "html"
  | "png"
  | "jpg"
  | "webp"
  | "pdf";

/** One submission, as returned by /api/feed and /api/entry/:id. */
export interface FeedEntry {
  id: string;
  projectId: string;
  projectName: string;
  slug: string;
  rev: number;
  title: string;
  tags: string[];
  type: ArtifactType;
  /** Entry file path relative to the bundle root. */
  entry: string;
  files: number;
  size: number;
  contentHash: string;
  sourcePath: string;
  submittedAt: string;
  naturalWidth?: number;
  naturalHeight?: number;
}

export interface FeedPage {
  entries: FeedEntry[];
  nextCursor: number | null;
  total: number;
  projects: Array<{ projectId: string; projectName: string; count: number }>;
  tags: Array<{ tag: string; count: number }>;
}

export interface EntryDetail {
  sharingEnabled?: boolean;
  entry: FeedEntry;
  revisions: FeedEntry[];
}
