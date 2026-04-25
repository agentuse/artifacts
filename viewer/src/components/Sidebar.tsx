import type { ProjectRecord } from "../types";

export function Sidebar(props: {
  projects: Record<string, ProjectRecord>;
  selected?: string;
  onSelect: (projectId: string) => void;
}) {
  const entries = Object.entries(props.projects).sort((a, b) =>
    a[1].name.localeCompare(b[1].name),
  );
  return (
    <div className="pane">
      <h2>Projects</h2>
      {entries.length === 0 && <div className="list-item secondary">no projects yet</div>}
      {entries.map(([id, p]) => (
        <div
          key={id}
          className={`list-item${id === props.selected ? " selected" : ""}`}
          onClick={() => props.onSelect(id)}
        >
          <div>{p.name}</div>
          <div className="secondary">{p.path}</div>
        </div>
      ))}
    </div>
  );
}
