import type { ArtifactRecord, Manifest } from "../types";

const ROOT_GROUP = "";

export function groupKeyOf(rec: ArtifactRecord): string {
  const ref = rec.localEntry ?? rec.name;
  const slash = ref.lastIndexOf("/");
  return slash === -1 ? ROOT_GROUP : ref.slice(0, slash);
}

function leafLabel(rec: ArtifactRecord): string {
  // Inside a directory group we show only the filename so the dir prefix
  // doesn't repeat on every row. The dir-artifact (name === groupKey) is
  // the implicit `index.html`/`index.md` entry — render it as that filename.
  const group = groupKeyOf(rec);
  if (group === ROOT_GROUP) return rec.name;
  if (rec.name === group) {
    const entry = rec.localEntry ?? "";
    const slash = entry.lastIndexOf("/");
    return slash === -1 ? rec.name : entry.slice(slash + 1);
  }
  const slash = rec.name.lastIndexOf("/");
  return slash === -1 ? rec.name : rec.name.slice(slash + 1);
}

export function ArtifactList(props: {
  manifest: Manifest;
  projectId?: string;
  selected?: string;
  selectedGroup?: string;
  onSelect: (name: string | undefined) => void;
  onSelectGroup: (group: string | undefined) => void;
}) {
  const { manifest, projectId, selected, selectedGroup, onSelect, onSelectGroup } = props;
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
    .filter((rec): rec is ArtifactRecord => !!rec);

  const groups = new Map<string, ArtifactRecord[]>();
  for (const rec of artifacts) {
    const key = groupKeyOf(rec);
    const list = groups.get(key) ?? [];
    list.push(rec);
    groups.set(key, list);
  }
  const orderedGroups = [...groups.entries()].sort(([a], [b]) => {
    if (a === b) return 0;
    if (a === ROOT_GROUP) return -1;
    if (b === ROOT_GROUP) return 1;
    return a.localeCompare(b);
  });
  for (const [, list] of orderedGroups) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }

  const allSelected = selected == null && selectedGroup == null;

  return (
    <div className="pane">
      <h2>Artifacts</h2>
      <div
        className={`list-item${allSelected ? " selected" : ""}`}
        onClick={() => {
          onSelect(undefined);
          onSelectGroup(undefined);
        }}
      >
        <div>All</div>
        <div className="secondary">all artifacts in project</div>
      </div>
      {artifacts.length === 0 && (
        <div className="list-item secondary">no artifacts yet</div>
      )}
      {orderedGroups.map(([key, list]) => {
        if (key === ROOT_GROUP) {
          // Root-level files have no directory to collapse into — render
          // each as its own row so they can still be opened directly.
          return (
            <div className="artifact-group" key="__root__">
              {list.map((rec) => (
                <div
                  key={rec.name}
                  className={`list-item${rec.name === selected ? " selected" : ""}`}
                  onClick={() => onSelect(rec.name)}
                  title={rec.localEntry ?? rec.name}
                >
                  <div>{leafLabel(rec)}</div>
                  <div className="secondary">{rec.localEntry ?? rec.name}</div>
                </div>
              ))}
            </div>
          );
        }
        const groupSelected = key === selectedGroup;
        return (
          <div
            className={`group-head${groupSelected ? " selected" : ""}`}
            key={key}
            onClick={() => onSelectGroup(key)}
            title={`open all artifacts under ${key}/`}
          >
            <span>{key}/</span>
            <span className="group-count">{list.length}</span>
          </div>
        );
      })}
    </div>
  );
}
