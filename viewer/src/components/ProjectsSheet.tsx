import { useEffect, useState } from "react";
import { Trash2, X } from "lucide-react";
import { removeProject } from "../api";
import type { FeedPage } from "../types";

/**
 * Projects are not registered anywhere: this lists whatever the feed reports,
 * with the artifact count per project. The only action is destructive, so it
 * asks first — deleting drops the feed entries and the stored bundles.
 */
export function ProjectsSheet(props: {
  open: boolean;
  projects: FeedPage["projects"];
  onClose: () => void;
  onChanged: (deletedProjectId: string) => void;
  onNotify: (type: "success" | "error", text: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const onClose = props.onClose;

  useEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.open, onClose]);

  if (!props.open) return null;

  const onDelete = async (projectId: string, projectName: string, count: number) => {
    const ok = window.confirm(
      `Delete all ${count} artifact(s) from ${projectName}?\n\nThis removes them from the feed and deletes the stored copies.`,
    );
    if (!ok) return;
    setBusy(projectId);
    try {
      await removeProject(projectId);
      props.onNotify("success", `deleted ${count} artifact(s) from ${projectName}`);
      props.onChanged(projectId);
    } catch (e) {
      props.onNotify("error", String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={props.onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="projects">
        <header className="sheet-head">
          <h2>Projects</h2>
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="close">
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>

        <div className="sheet-list">
          {props.projects.length === 0 && <p className="secondary">No artifacts submitted yet.</p>}
          {props.projects.map((project) => (
            <div className="sheet-item" key={project.projectId}>
              <div className="sheet-item-text">
                <div>{project.projectName}</div>
                <div className="secondary mono">
                  {project.count} artifact{project.count === 1 ? "" : "s"}
                </div>
              </div>
              <button
                type="button"
                className="icon-btn danger"
                disabled={busy === project.projectId}
                title="delete this project's artifacts"
                aria-label={`delete artifacts from ${project.projectName}`}
                onClick={() => void onDelete(project.projectId, project.projectName, project.count)}
              >
                <Trash2 size={16} strokeWidth={1.75} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
