export type SortMode = "name" | "updated";

const SORT_KEY = "agentuse-artifacts.sort.v1";
// Old per-pane keys — read once on first load so users keep their
// previously-chosen order after the migration to a shared toggle.
const LEGACY_PROJECT_KEY = "agentuse-artifacts.project-sort.v1";
const LEGACY_ARTIFACT_KEY = "agentuse-artifacts.artifact-sort.v1";

function readMode(raw: string | null): SortMode | undefined {
  return raw === "updated" || raw === "name" ? raw : undefined;
}

export function loadSort(): SortMode {
  try {
    const cur = readMode(localStorage.getItem(SORT_KEY));
    if (cur) return cur;
    // Prefer the artifact toggle when migrating — that's the more
    // task-relevant scope on this tool.
    const legacy =
      readMode(localStorage.getItem(LEGACY_ARTIFACT_KEY)) ??
      readMode(localStorage.getItem(LEGACY_PROJECT_KEY));
    return legacy ?? "name";
  } catch {
    return "name";
  }
}

export function saveSort(sort: SortMode): void {
  try {
    localStorage.setItem(SORT_KEY, sort);
  } catch {
    // ignore private mode / quota failures
  }
}
