import { useState } from "react";
import { X } from "lucide-react";
import type { ProjectRecord } from "../types";

type ProjectSort = "name" | "updated";

const SORT_KEY = "agentuse-artifacts.project-sort.v1";

function loadSort(): ProjectSort {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    return raw === "updated" ? "updated" : "name";
  } catch {
    return "name";
  }
}

function saveSort(sort: ProjectSort): void {
  try {
    localStorage.setItem(SORT_KEY, sort);
  } catch {
    // ignore private mode / quota failures
  }
}

function projectTime(p: ProjectRecord): number {
  return new Date(p.updatedAt ?? p.createdAt).getTime() || 0;
}

export function Sidebar(props: {
  projects: Record<string, ProjectRecord>;
  selected?: string;
  onSelect: (projectId: string) => void;
  onClose: () => void;
}) {
  const [sort, setSortState] = useState<ProjectSort>(() => loadSort());
  const setSort = (next: ProjectSort) => {
    setSortState(next);
    saveSort(next);
  };

  const entries = Object.entries(props.projects).sort((a, b) => {
    if (sort === "updated") {
      const byTime = projectTime(b[1]) - projectTime(a[1]);
      if (byTime !== 0) return byTime;
    }
    return a[1].name.localeCompare(b[1].name);
  });

  return (
    <div className="pane">
      <div className="pane-head">
        <div className="pane-title-row">
          <h2>Projects</h2>
          <button
            className="pane-close-btn"
            onClick={props.onClose}
            type="button"
            aria-label="hide panes"
            title="hide panes"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>
        <div className="sort-toggle" aria-label="sort projects">
          <button
            className={sort === "name" ? "active" : ""}
            onClick={() => setSort("name")}
            type="button"
          >
            Name
          </button>
          <button
            className={sort === "updated" ? "active" : ""}
            onClick={() => setSort("updated")}
            type="button"
          >
            Updated
          </button>
        </div>
      </div>
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
