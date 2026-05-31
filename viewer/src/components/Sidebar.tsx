import type { ProjectRecord } from "../types";
import type { SortMode } from "../sort";

function projectTime(p: ProjectRecord): number {
  return new Date(p.updatedAt ?? p.createdAt).getTime() || 0;
}

export function Sidebar(props: {
  projects: Record<string, ProjectRecord>;
  selected?: string;
  sort: SortMode;
  flashedProjectId?: string | null;
  onSelect: (projectId: string) => void;
}) {
  const entries = Object.entries(props.projects).sort((a, b) => {
    if (props.sort === "updated") {
      const byTime = projectTime(b[1]) - projectTime(a[1]);
      if (byTime !== 0) return byTime;
    }
    return a[1].name.localeCompare(b[1].name);
  });

  return (
    <div className="pane projects-pane">
      <h2>Projects</h2>
      {entries.length === 0 && <div className="list-item secondary">no projects yet</div>}
      {entries.map(([id, p]) => (
        <div
          key={id}
          className={
            "list-item" +
            (id === props.selected ? " selected" : "") +
            (id === props.flashedProjectId ? " project-flash" : "")
          }
          onClick={() => props.onSelect(id)}
        >
          <div>{p.name}</div>
          <div className="secondary">{p.path}</div>
        </div>
      ))}
    </div>
  );
}
