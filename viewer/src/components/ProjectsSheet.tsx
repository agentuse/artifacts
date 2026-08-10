import { useEffect, useState, type KeyboardEvent } from "react";
import { Plus, RotateCcw, Trash2, X } from "lucide-react";
import { addProject, fetchProjects, pruneProjects, removeProject } from "../api";
import type { ProjectRecord } from "../types";

/**
 * Registering a project only matters for grouping: `artifacts submit` registers
 * the project it finds on its own. Forgetting one drops its feed entries and
 * stored bundles, which is why the button says so.
 */
export function ProjectsSheet(props: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
  onNotify: (type: "success" | "error", text: string) => void;
}) {
  const [projects, setProjects] = useState<Record<string, ProjectRecord>>({});
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const reload = () => {
    fetchProjects()
      .then((index) => setProjects(index.projects))
      .catch((e) => props.onNotify("error", String(e)));
  };

  useEffect(() => {
    if (props.open) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  if (!props.open) return null;

  const run = async (label: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(label);
    try {
      await fn();
      props.onNotify("success", done);
      reload();
      props.onChanged();
    } catch (e) {
      props.onNotify("error", String(e));
    } finally {
      setBusy(null);
    }
  };

  const onAdd = () => {
    const trimmed = path.trim();
    if (!trimmed) return;
    void run("add", () => addProject(trimmed), `added ${trimmed}`).then(() => setPath(""));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") onAdd();
  };

  const entries = Object.entries(projects).sort((a, b) => a[1].name.localeCompare(b[1].name));

  return (
    <div className="sheet-backdrop" onClick={props.onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="projects">
        <header className="sheet-head">
          <h2>Projects</h2>
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="close">
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>

        <div className="sheet-row">
          <input
            type="text"
            value={path}
            placeholder="/path/to/project"
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="project path"
          />
          <button type="button" className="btn" onClick={onAdd} disabled={busy === "add" || !path.trim()}>
            <Plus size={14} strokeWidth={2} />
            Add
          </button>
        </div>

        <div className="sheet-list">
          {entries.length === 0 && <p className="secondary">No projects registered yet.</p>}
          {entries.map(([projectId, project]) => (
            <div className="sheet-item" key={projectId}>
              <div className="sheet-item-text">
                <div>{project.name}</div>
                <div className="secondary mono">{project.path}</div>
              </div>
              <button
                type="button"
                className="icon-btn danger"
                disabled={busy === projectId}
                title="forget this project and delete its artifacts"
                aria-label={`forget ${project.name}`}
                onClick={() =>
                  void run(projectId, () => removeProject(projectId), `forgot ${project.name}`)
                }
              >
                <Trash2 size={16} strokeWidth={1.75} />
              </button>
            </div>
          ))}
        </div>

        <footer className="sheet-foot">
          <button
            type="button"
            className="btn ghost"
            disabled={busy === "prune"}
            onClick={() => void run("prune", pruneProjects, "pruned missing projects")}
          >
            <RotateCcw size={14} strokeWidth={2} />
            Prune missing
          </button>
        </footer>
      </div>
    </div>
  );
}
