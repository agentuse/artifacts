import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { tempProjectDir, tempStorageRoot, rmStorageRoot } from "./helpers";
import type { Manifest, ProjectRecord } from "../src/manifest";
import { writeManifestAtomic, SCHEMA_VERSION } from "../src/manifest";
import {
  isAllowedProjectRelPath,
  listLocalArtifactsForProject,
  resolveProjectFile,
} from "../src/localArtifacts";
import { writeSettings } from "../src/settings";

function writeFile(file: string, body = ""): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function localId(projectId: string, entry: string): string {
  return "local_" + createHash("sha256").update(`${projectId}\0${entry}`).digest("hex").slice(0, 16);
}

describe("project-wide local artifact discovery", () => {
  let storageRoot: string;
  let projectPath: string;
  const projectId = "proj_test";

  beforeEach(() => {
    storageRoot = tempStorageRoot();
    projectPath = tempProjectDir();
  });

  afterEach(() => {
    rmStorageRoot(storageRoot);
    fs.rmSync(projectPath, { recursive: true, force: true });
  });

  function projectRecord(): ProjectRecord {
    return {
      name: path.basename(projectPath),
      path: projectPath,
      createdAt: new Date().toISOString(),
    };
  }

  it("loads supported files across the project while preserving artifact-root names", () => {
    writeFile(path.join(projectPath, "README.md"), "# Read me");
    writeFile(path.join(projectPath, "agents", "daily.agentuse"), "---\nmodel: test\n---\nRun daily report");
    writeFile(path.join(projectPath, "docs", "report.html"), "<h1>Report</h1>");
    writeFile(path.join(projectPath, "dashboard", "details.html"), "<h1>Project dashboard</h1>");
    writeFile(path.join(projectPath, ".agentuse", "artifacts", "dashboard", "index.html"), "<h1>Artifact</h1>");
    writeFile(path.join(projectPath, ".agentuse", "artifacts", "dashboard", "details.html"), "<h1>Details</h1>");
    writeFile(path.join(projectPath, ".agentuse", "artifacts", "dashboard", "style.css"), "body{}");
    writeFile(path.join(projectPath, "node_modules", "pkg", "README.md"), "# Dependency");
    writeFile(path.join(projectPath, "dist", "report.html"), "<h1>Built</h1>");
    writeFile(path.join(projectPath, "viewer-dist", "index.html"), "<h1>Built viewer</h1>");
    writeFile(path.join(projectPath, ".github", "workflows", "note.md"), "# Hidden");
    writeFile(path.join(projectPath, ".agentuse", "skills", "SKILL.md"), "# Skill");

    const artifacts = listLocalArtifactsForProject(projectId, projectRecord());
    const byName = new Map(artifacts.map((a) => [a.record.name, a]));

    expect([...byName.keys()]).toEqual([
      "./dashboard/details.html",
      "agents/daily.agentuse",
      "dashboard",
      "dashboard/details.html",
      "docs/report.html",
      "README.md",
    ]);

    const legacyIndex = byName.get("dashboard");
    expect(legacyIndex?.entry).toBe("dashboard/index.html");
    expect(legacyIndex?.record.localEntry).toBe("dashboard/index.html");
    expect(legacyIndex?.record.projectRelPath).toBe(".agentuse/artifacts/dashboard/index.html");
    expect(legacyIndex?.artifactId).toBe(localId(projectId, "dashboard/index.html"));

    const readme = byName.get("README.md");
    expect(readme?.entry).toBe("README.md");
    expect(readme?.record.localEntry).toBeUndefined();
    expect(readme?.record.projectRelPath).toBe("README.md");
    expect(readme?.artifactId).toBe(localId(projectId, "project:README.md"));

    const projectCollision = byName.get("./dashboard/details.html");
    expect(projectCollision?.record.projectRelPath).toBe("dashboard/details.html");

    const agent = byName.get("agents/daily.agentuse");
    expect(agent?.record.type).toBe("agentuse");
    expect(agent?.record.projectRelPath).toBe("agents/daily.agentuse");
  });

  it("allows artifact-root paths but rejects ignored project paths", () => {
    expect(isAllowedProjectRelPath("docs/report.md")).toBe(true);
    expect(isAllowedProjectRelPath("agents/daily.agentuse")).toBe(true);
    expect(isAllowedProjectRelPath(".agentuse/artifacts/report/index.md")).toBe(true);
    expect(isAllowedProjectRelPath(".agentuse")).toBe(false);
    expect(isAllowedProjectRelPath(".agentuse/skills/SKILL.md")).toBe(false);
    expect(isAllowedProjectRelPath("node_modules/pkg/README.md")).toBe(false);
    expect(isAllowedProjectRelPath("dist/report.html")).toBe(false);
    expect(isAllowedProjectRelPath("viewer-dist/index.html")).toBe(false);
    expect(isAllowedProjectRelPath(".github/workflows/note.md")).toBe(false);
  });

  it("uses configured ignore patterns for project-wide discovery", () => {
    writeSettings({ ignorePatterns: ["reports/private/**", "*.draft.md"] });
    writeFile(path.join(projectPath, "reports", "public", "summary.md"), "# Public");
    writeFile(path.join(projectPath, "reports", "private", "summary.md"), "# Private");
    writeFile(path.join(projectPath, "notes.draft.md"), "# Draft");
    writeFile(path.join(projectPath, ".agentuse", "artifacts", "private", "index.md"), "# Artifact");

    const artifacts = listLocalArtifactsForProject(projectId, projectRecord());
    expect(artifacts.map((a) => a.record.name)).toEqual([
      "private",
      "reports/public/summary.md",
    ]);
    expect(isAllowedProjectRelPath("reports/private/summary.md")).toBe(false);
    expect(isAllowedProjectRelPath("notes.draft.md")).toBe(false);
    expect(isAllowedProjectRelPath(".agentuse/artifacts/private/index.md")).toBe(true);
  });

  it("resolves project files inside the project root only", () => {
    writeFile(path.join(projectPath, "docs", "report.html"), "<h1>Report</h1>");
    const manifest: Manifest = {
      schemaVersion: SCHEMA_VERSION,
      projects: { [projectId]: projectRecord() },
      artifacts: {},
      latest: {},
    };
    writeManifestAtomic(manifest);

    const file = resolveProjectFile(projectId, "docs/report.html");
    expect(file.absPath).toBe(path.join(projectPath, "docs", "report.html"));
    expect(file.relPath).toBe("docs/report.html");

    expect(() => resolveProjectFile(projectId, "../README.md")).toThrow(/must not contain/);
    expect(() => resolveProjectFile(projectId, "node_modules/pkg/README.md")).toThrow(/ignored/);
    expect(() => resolveProjectFile(projectId, ".agentuse/skills/SKILL.md")).toThrow(/ignored/);
  });
});
