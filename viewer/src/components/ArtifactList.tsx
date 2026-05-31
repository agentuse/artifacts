import { useMemo, useState } from "react";
import type { ArtifactRecord, Manifest } from "../types";
import type { SortMode } from "../sort";

const ROOT_GROUP = "";
const PROJECT_GROUP_PREFIX = "project:";

interface FolderNode {
  name: string;
  path: string;
  children: Map<string, FolderNode>;
  files: ArtifactRecord[];
  count: number;
  updated: number;
}

function artifactTime(rec: ArtifactRecord): number {
  return new Date(rec.createdAt).getTime() || 0;
}

export function groupKeyOf(rec: ArtifactRecord): string {
  const ref = rec.localEntry ?? rec.projectRelPath ?? rec.name;
  const slash = ref.lastIndexOf("/");
  return slash === -1 ? ROOT_GROUP : ref.slice(0, slash);
}

function projectGroupKey(path: string): string {
  return PROJECT_GROUP_PREFIX + path;
}

function selectedProjectPath(selectedGroup: string | undefined): string | undefined {
  return selectedGroup?.startsWith(PROJECT_GROUP_PREFIX)
    ? selectedGroup.slice(PROJECT_GROUP_PREFIX.length)
    : undefined;
}

export function artifactMatchesGroup(rec: ArtifactRecord, selectedGroup: string): boolean {
  const group = groupKeyOf(rec);
  const projectPath = selectedProjectPath(selectedGroup);
  if (projectPath != null) {
    return !rec.localEntry && (group === projectPath || group.startsWith(projectPath + "/"));
  }
  if (rec.localEntry) return group === selectedGroup;
  // Backwards-compatible handling for project-wide group URLs produced before
  // project folders were namespaced in the route.
  return group === selectedGroup || group.startsWith(selectedGroup + "/");
}

/** Group with the most recent artifact in a project. Used to auto-select a
 *  folder when the user switches projects. Prefers curated artifact packages
 *  over incidental project folders so generated deliverables stay front and
 *  center after whole-project discovery is enabled. */
export function latestGroupFor(manifest: Manifest, projectId: string): string | undefined {
  const latestMap = manifest.latest[projectId];
  if (!latestMap) return undefined;
  let bestPackage: { group: string; t: number } | undefined;
  let bestProject: { group: string; t: number } | undefined;
  for (const id of Object.values(latestMap)) {
    const rec = manifest.artifacts[id];
    if (!rec) continue;
    const group = groupKeyOf(rec);
    if (group === ROOT_GROUP) continue;
    const t = artifactTime(rec);
    if (rec.localEntry) {
      if (!bestPackage || t > bestPackage.t) bestPackage = { group, t };
    } else if (!bestProject || t > bestProject.t) {
      bestProject = { group: projectGroupKey(group), t };
    }
  }
  return bestPackage?.group ?? bestProject?.group;
}

function leafLabel(rec: ArtifactRecord): string {
  const group = groupKeyOf(rec);
  if (group === ROOT_GROUP) return rec.name;
  if (rec.name === group) {
    const entry = rec.localEntry ?? rec.projectRelPath ?? "";
    const slash = entry.lastIndexOf("/");
    return slash === -1 ? rec.name : entry.slice(slash + 1);
  }
  const slash = rec.name.lastIndexOf("/");
  return slash === -1 ? rec.name : rec.name.slice(slash + 1);
}

function displayPath(rec: ArtifactRecord): string {
  return rec.localEntry ?? rec.projectRelPath ?? rec.name;
}

function compareRecords(sort: SortMode) {
  return (x: ArtifactRecord, y: ArtifactRecord) => {
    if (sort === "updated") {
      const byTime = artifactTime(y) - artifactTime(x);
      if (byTime !== 0) return byTime;
    }
    return displayPath(x).localeCompare(displayPath(y));
  };
}

function compareFolders(sort: SortMode) {
  return (x: FolderNode, y: FolderNode) => {
    if (sort === "updated") {
      const byTime = y.updated - x.updated;
      if (byTime !== 0) return byTime;
    }
    return x.name.localeCompare(y.name);
  };
}

function makeFolder(name: string, path: string): FolderNode {
  return {
    name,
    path,
    children: new Map(),
    files: [],
    count: 0,
    updated: 0,
  };
}

function sortFolder(node: FolderNode, sort: SortMode): void {
  node.files.sort(compareRecords(sort));
  const children = [...node.children.values()].sort(compareFolders(sort));
  node.children = new Map(children.map((child) => {
    sortFolder(child, sort);
    return [child.name, child];
  }));
}

function buildProjectTree(records: ArtifactRecord[], sort: SortMode): FolderNode {
  const root = makeFolder("", "");
  for (const rec of records) {
    const rel = rec.projectRelPath ?? rec.name;
    const parts = rel.split("/").filter(Boolean);
    if (parts.length <= 1) {
      root.files.push(rec);
      root.count += 1;
      root.updated = Math.max(root.updated, artifactTime(rec));
      continue;
    }

    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const name = parts[i]!;
      const nextPath = parts.slice(0, i + 1).join("/");
      let child = node.children.get(name);
      if (!child) {
        child = makeFolder(name, nextPath);
        node.children.set(name, child);
      }
      child.count += 1;
      child.updated = Math.max(child.updated, artifactTime(rec));
      node = child;
    }
    node.files.push(rec);
  }
  sortFolder(root, sort);
  return root;
}

function isAncestorPath(ancestor: string, child: string | undefined): boolean {
  return !!child && child.startsWith(ancestor + "/");
}

export function ArtifactList(props: {
  manifest: Manifest;
  projectId?: string;
  selected?: string;
  selectedGroup?: string;
  sort: SortMode;
  mobileBackLabel?: string;
  onMobileBack?: () => void;
  onSelect: (name: string | undefined) => void;
  onSelectGroup: (group: string | undefined) => void;
}) {
  const {
    manifest,
    projectId,
    selected,
    selectedGroup,
    sort,
    mobileBackLabel,
    onMobileBack,
    onSelect,
    onSelectGroup,
  } = props;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const latestMap = projectId ? manifest.latest[projectId] ?? {} : {};
  const artifacts = useMemo(
    () =>
      Object.values(latestMap)
        .map((id) => manifest.artifacts[id])
        .filter((rec): rec is ArtifactRecord => !!rec),
    [latestMap, manifest.artifacts],
  );
  const packageArtifacts = useMemo(
    () => artifacts.filter((rec) => !!rec.localEntry),
    [artifacts],
  );
  const projectArtifacts = useMemo(
    () => artifacts.filter((rec) => !rec.localEntry),
    [artifacts],
  );

  const packageGroups = useMemo(() => {
    const groups = new Map<string, ArtifactRecord[]>();
    for (const rec of packageArtifacts) {
      const key = groupKeyOf(rec);
      const list = groups.get(key) ?? [];
      list.push(rec);
      groups.set(key, list);
    }
    const entries = [...groups.entries()];
    entries.sort(([a, listA], [b, listB]) => {
      if (sort === "updated") {
        const maxA = Math.max(...listA.map(artifactTime));
        const maxB = Math.max(...listB.map(artifactTime));
        if (maxA !== maxB) return maxB - maxA;
      } else {
        if (a === ROOT_GROUP) return -1;
        if (b === ROOT_GROUP) return 1;
      }
      return a.localeCompare(b);
    });
    for (const [, list] of entries) list.sort(compareRecords(sort));
    return entries;
  }, [packageArtifacts, sort]);

  const projectTree = useMemo(
    () => buildProjectTree(projectArtifacts, sort),
    [projectArtifacts, sort],
  );
  const projectSelection = selectedProjectPath(selectedGroup);
  const allSelected = selected == null && selectedGroup == null;

  if (!projectId) {
    return (
      <div className="pane artifacts-pane">
        <MobileArtifactNavHead label={mobileBackLabel} onBack={onMobileBack} />
        <h2>Artifacts</h2>
        <div className="list-item secondary">pick a project</div>
      </div>
    );
  }

  const toggleFolder = (path: string) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    onSelect(undefined);
    onSelectGroup(projectGroupKey(path));
  };

  const renderProjectFile = (rec: ArtifactRecord, depth: number) => (
    <div
      key={rec.name}
      className={`list-item tree-file${rec.name === selected ? " selected" : ""}`}
      style={{ paddingLeft: `${16 + depth * 14}px` }}
      onClick={() => onSelect(rec.name)}
      title={displayPath(rec)}
    >
      <div className="tree-primary">{leafLabel(rec)}</div>
      <div className="secondary">{displayPath(rec)}</div>
    </div>
  );

  const renderFolder = (node: FolderNode, depth: number): JSX.Element => {
    const children = [...node.children.values()];
    const files = node.files;
    const isSelected = selectedGroup === projectGroupKey(node.path);
    const isOpen = expanded.has(node.path) || isAncestorPath(node.path, projectSelection);

    return (
      <div className="tree-node" key={node.path}>
        <div
          className={`tree-folder${isSelected ? " selected" : ""}`}
          style={{ paddingLeft: `${16 + depth * 14}px` }}
          onClick={() => toggleFolder(node.path)}
          title={`open all artifacts under ${node.path}/`}
        >
          <span className="tree-twist">{isOpen ? "-" : "+"}</span>
          <span className="tree-label">{node.name}/</span>
          <span className="group-count">{node.count}</span>
        </div>
        {isOpen && (
          <>
            {files.map((rec) => renderProjectFile(rec, depth + 1))}
            {children.map((child) => renderFolder(child, depth + 1))}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="pane artifacts-pane">
      <MobileArtifactNavHead label={mobileBackLabel} onBack={onMobileBack} />
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

      {packageArtifacts.length > 0 && (
        <>
          <div className="list-section">Artifact packages</div>
          {packageGroups.map(([key, list]) => {
            if (key === ROOT_GROUP) {
              return (
                <div className="artifact-group" key="__package_root__">
                  {list.map((rec) => (
                    <div
                      key={rec.name}
                      className={`list-item${rec.name === selected ? " selected" : ""}`}
                      onClick={() => onSelect(rec.name)}
                      title={displayPath(rec)}
                    >
                      <div>{leafLabel(rec)}</div>
                      <div className="secondary">{displayPath(rec)}</div>
                    </div>
                  ))}
                </div>
              );
            }
            const groupSelected = key === selectedGroup;
            return (
              <div
                className={`group-head package-head${groupSelected ? " selected" : ""}`}
                key={key}
                onClick={() => {
                  onSelect(undefined);
                  onSelectGroup(key);
                }}
                title={`open artifact package ${key}/`}
              >
                <span className="tree-label">{key}/</span>
                <span className="group-count">{list.length}</span>
              </div>
            );
          })}
        </>
      )}

      {projectArtifacts.length > 0 && (
        <>
          <div className="list-section">Project files</div>
          {projectTree.files.map((rec) => renderProjectFile(rec, 0))}
          {[...projectTree.children.values()].sort(compareFolders(sort)).map((node) =>
            renderFolder(node, 0),
          )}
        </>
      )}
    </div>
  );
}

function MobileArtifactNavHead(props: {
  label?: string;
  onBack?: () => void;
}) {
  return (
    <button
      className="mobile-artifact-back"
      type="button"
      onClick={props.onBack}
      aria-label="show projects"
    >
      <span aria-hidden="true">‹</span>
      <span>{props.label ?? "Projects"}</span>
    </button>
  );
}
