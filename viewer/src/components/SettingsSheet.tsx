import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Plus, RotateCcw, Trash2, X } from "lucide-react";
import {
  addProject,
  fetchSettings,
  removeProject,
  updateSettings,
} from "../api";
import type { Manifest } from "../types";

export function SettingsSheet(props: {
  open: boolean;
  manifest: Manifest;
  flashedProjectId?: string | null;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
  onNotify: (type: "success" | "error", text: string) => void;
  onProjectAdded: (projectId: string) => void;
}) {
  const [defaultPatterns, setDefaultPatterns] = useState<string[]>([]);
  const [ignoreText, setIgnoreText] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    let alive = true;
    fetchSettings()
      .then((res) => {
        if (!alive) return;
        setDefaultPatterns(res.defaultIgnorePatterns);
        setIgnoreText(res.settings.ignorePatterns.join("\n"));
      })
      .catch((e) => {
        if (alive) props.onNotify("error", String(e));
      });
    return () => {
      alive = false;
    };
  }, [props.open, props.onNotify]);

  const projects = useMemo(
    () => Object.entries(props.manifest.projects)
      .sort((a, b) => a[1].name.localeCompare(b[1].name)),
    [props.manifest.projects],
  );

  const artifactCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const rec of Object.values(props.manifest.artifacts)) {
      counts.set(rec.projectId, (counts.get(rec.projectId) ?? 0) + 1);
    }
    return counts;
  }, [props.manifest.artifacts]);

  if (!props.open) return null;

  const run = async (label: string, task: () => Promise<void>, success: string) => {
    setBusy(label);
    try {
      await task();
      await props.onChanged();
      props.onNotify("success", success);
    } catch (e) {
      props.onNotify("error", String(e));
    } finally {
      setBusy(null);
    }
  };

  const savePatterns = () =>
    run(
      "patterns",
      async () => {
        await updateSettings(ignoreText.split(/\r?\n/));
      },
      "Ignore patterns saved.",
    );

  const addCurrentProject = () => {
    const path = projectPath.trim();
    if (!path) return;
    setBusy("add-project");
    addProject(path)
      .then(async (out) => {
        await props.onChanged();
        props.onProjectAdded(out.project.projectId);
        setProjectPath("");
        props.onNotify("success", "Project added.");
      })
      .catch((e) => {
        props.onNotify("error", String(e));
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const submitProjectFromKeyboard = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    addCurrentProject();
  };

  const forgetProject = (projectId: string, name: string) => {
    if (!window.confirm(`Remove ${name} from the viewer registry? Files stay on disk.`)) return;
    void run(
      `remove-${projectId}`,
      async () => {
        await removeProject(projectId);
      },
      "Project removed.",
    );
  };

  return (
    <div className="settings-layer" role="dialog" aria-modal="true" aria-label="settings">
      <button className="settings-backdrop" onClick={props.onClose} aria-label="close settings" />
      <section className="settings-sheet">
        <header className="settings-head">
          <div>
            <h2>Settings</h2>
            <p>Manage scanned projects and files hidden from the artifact canvas.</p>
          </div>
          <button className="icon-btn" onClick={props.onClose} aria-label="close settings" title="close">
            <X size={16} strokeWidth={2} />
          </button>
        </header>

        <section className="settings-section">
          <div className="settings-section-head">
            <div>
              <h3>File Scanning</h3>
              <p>Gitignore-style patterns. Hidden dot paths are skipped except `.agentuse/artifacts`.</p>
            </div>
            <button
              className="settings-small-btn"
              type="button"
              onClick={() => setIgnoreText(defaultPatterns.join("\n"))}
            >
              <RotateCcw size={14} strokeWidth={2} />
              Reset
            </button>
          </div>
          <textarea
            className="settings-textarea"
            value={ignoreText}
            onChange={(e) => setIgnoreText(e.target.value)}
            spellCheck={false}
            rows={9}
          />
          <div className="settings-actions">
            <button onClick={savePatterns} disabled={busy === "patterns"}>
              Save
            </button>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section-head">
            <div>
              <h3>Projects</h3>
              <p>Add or remove project roots. Removing a project never deletes files.</p>
            </div>
          </div>

          <div className="settings-add-project">
            <input
              value={projectPath}
              onChange={(e) => setProjectPath(e.target.value)}
              onKeyDown={submitProjectFromKeyboard}
              placeholder="~/workspace/project"
              aria-label="project path"
            />
            <button
              type="button"
              onClick={addCurrentProject}
              disabled={busy === "add-project" || !projectPath.trim()}
            >
              <Plus size={15} strokeWidth={2} />
              Add
            </button>
          </div>

          <div className="settings-project-list">
            {projects.map(([projectId, project]) => (
              <div
                className={
                  "settings-project-row" +
                  (projectId === props.flashedProjectId ? " project-flash" : "")
                }
                key={projectId}
              >
                <div>
                  <div className="settings-project-name">{project.name}</div>
                  <div className="settings-project-path">{project.path}</div>
                  <div className="settings-project-meta">
                    {artifactCounts.get(projectId) ?? 0} artifacts
                  </div>
                </div>
                <button
                  className="settings-icon-danger"
                  onClick={() => forgetProject(projectId, project.name)}
                  disabled={busy === `remove-${projectId}`}
                  aria-label={`remove ${project.name}`}
                  title="remove project"
                >
                  <Trash2 size={15} strokeWidth={2} />
                </button>
              </div>
            ))}
          </div>
        </section>
      </section>
    </div>
  );
}
