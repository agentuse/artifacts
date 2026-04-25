import type { Manifest } from "../types";

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/**
 * Run is an optional grouping tag. The default lens is "all latest artifacts
 * in the project," shown as the "Latest" pseudo-entry. Run rows only appear
 * when the project actually has tagged runs, keeping the panel quiet for
 * agents that never opt in.
 */
export function RunList(props: {
  manifest: Manifest;
  projectId?: string;
  selected?: string;
  onSelect: (runId: string | undefined) => void;
}) {
  const { manifest, projectId, selected, onSelect } = props;
  if (!projectId) {
    return (
      <div className="pane">
        <h2>Runs</h2>
        <div className="list-item secondary">pick a project</div>
      </div>
    );
  }

  const runs = Object.entries(manifest.runs)
    .filter(([, r]) => r.projectId === projectId)
    .sort(
      (a, b) =>
        new Date(b[1].createdAt).getTime() - new Date(a[1].createdAt).getTime(),
    );

  return (
    <div className="pane">
      <h2>Runs (filter)</h2>
      <div
        className={`list-item${selected == null ? " selected" : ""}`}
        onClick={() => onSelect(undefined)}
      >
        <div>Latest</div>
        <div className="secondary">all artifacts in project</div>
      </div>
      {runs.length === 0 && (
        <div className="list-item secondary">no tagged runs</div>
      )}
      {runs.map(([id, r]) => (
        <div
          key={id}
          className={`list-item${id === selected ? " selected" : ""}`}
          onClick={() => onSelect(id)}
          title={id}
        >
          <div>{id}</div>
          <div className="secondary">{fmtDate(r.createdAt)}</div>
        </div>
      ))}
    </div>
  );
}
