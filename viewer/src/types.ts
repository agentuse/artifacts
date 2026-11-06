export type ArtifactType =
  | "markdown"
  | "agentuse"
  | "html"
  | "png"
  | "jpg"
  | "webp"
  | "pdf"
  | "video"
  | "audio"
  | "text"
  | "file";

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
  /** A published cloud copy exists, including when this revision needs an update. */
  cloudShared?: boolean;
}

export interface FeedPage {
  entries: FeedEntry[];
  /** Pins matching the filters, kept out of `entries`. Missing from a server older than this viewer. */
  pinned?: FeedEntry[];
  nextCursor: number | null;
  /** Everything matching the filters, pinned included. */
  total: number;
  projects: Array<{ projectId: string; projectName: string; count: number }>;
  tags: Array<{ tag: string; count: number }>;
  all: number;
  facetTotals: { projects: number; tags: number };
}

/** A note the user left for the agent. Belongs to the artifact; `rev` is what they were viewing. */
export interface CommentQuote {
  text: string;
  before?: string;
  after?: string;
}

export interface Comment {
  id: string;
  rev: number;
  body: string;
  quote?: CommentQuote;
  createdAt: string;
  notifiedAt?: string;
  resolvedAt?: string;
}

export interface EntryDetail {
  sharingEnabled?: boolean;
  sharing?: { state: "share" | "shared" | "update"; url?: string };
  entry: FeedEntry;
  revisions: FeedEntry[];
  comments?: Comment[];
  pinned?: boolean;
}

export interface ManagedShare {
  id: string;
  url: string;
  title: string;
  status: string;
  artifact: { projectId: string; slug: string; revision: number } | null;
  publishedAt: string | null;
  createdAt: string;
  expiresAt: string | null;
  files: number;
  size: number;
}
