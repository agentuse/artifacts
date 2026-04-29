import type { ArtifactRecord, Manifest } from "../types";

function typeLabel(rec: ArtifactRecord): string {
  if (rec.localEntry?.endsWith("/index.html") || rec.localEntry?.endsWith("/index.md")) {
    return rec.localEntry;
  }
  return rec.localEntry ?? rec.type;
}

export function ArtifactList(props: {
  manifest: Manifest;
  projectId?: string;
  selected?: string;
  onSelect: (name: string | undefined) => void;
}) {
  const { manifest, projectId, selected, onSelect } = props;
  if (!projectId) {
    return (
      <div className="pane">
        <h2>Artifacts</h2>
        <div className="list-item secondary">pick a project</div>
      </div>
    );
  }

  const latestMap = manifest.latest[projectId] ?? {};
  const artifacts = Object.values(latestMap)
    .map((id) => manifest.artifacts[id])
    .filter((rec): rec is ArtifactRecord => !!rec)
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="pane">
      <h2>Artifacts</h2>
      <div
        className={`list-item${selected == null ? " selected" : ""}`}
        onClick={() => onSelect(undefined)}
      >
        <div>All</div>
        <div className="secondary">all artifacts in project</div>
      </div>
      {artifacts.length === 0 && (
        <div className="list-item secondary">no artifacts yet</div>
      )}
      {artifacts.map((rec) => (
        <div
          key={rec.name}
          className={`list-item${rec.name === selected ? " selected" : ""}`}
          onClick={() => onSelect(rec.name)}
          title={rec.localEntry ?? rec.name}
        >
          <div>{rec.name}</div>
          <div className="secondary">{typeLabel(rec)}</div>
        </div>
      ))}
    </div>
  );
}
