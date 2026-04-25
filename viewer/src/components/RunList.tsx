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

export function RunList(props: {
  manifest: Manifest;
  projectId?: string;
  selected?: string;
  onSelect: (runId: string) => void;
}) {
  if (!props.projectId) {
    return (
      <div className="pane">
        <h2>Runs</h2>
        <div className="list-item secondary">select a project</div>
      </div>
    );
  }
  const runs = Object.entries(props.manifest.runs)
    .filter(([, r]) => r.projectId === props.projectId)
    .sort(
      (a, b) => new Date(b[1].createdAt).getTime() - new Date(a[1].createdAt).getTime(),
    );

  const counts = new Map<string, number>();
  for (const a of Object.values(props.manifest.artifacts)) {
    counts.set(a.runId, (counts.get(a.runId) ?? 0) + 1);
  }

  return (
    <div className="pane">
      <h2>Runs</h2>
      {runs.length === 0 && <div className="list-item secondary">no runs yet</div>}
      {runs.map(([id, r]) => (
        <div
          key={id}
          className={`list-item${id === props.selected ? " selected" : ""}`}
          onClick={() => props.onSelect(id)}
        >
          <div>{r.label ?? fmtDate(r.createdAt)}</div>
          <div className="secondary">
            {fmtDate(r.createdAt)} · {counts.get(id) ?? 0} artifact(s)
          </div>
        </div>
      ))}
    </div>
  );
}
