import { useState } from "react";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";
import type { ArtifactRecord, Manifest } from "../types";
import { Tile } from "./Tile";

const TILE_W = 720;
const TILE_H = 720;
const GAP = 32;
const COLS = 2;

export function Canvas(props: {
  manifest: Manifest;
  artifacts: Array<[string, ArtifactRecord]>;
}) {
  const { artifacts } = props;
  const tiles = artifacts.map(([id, rec], i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = GAP + col * (TILE_W + GAP);
    const y = GAP + row * (TILE_H + GAP);
    return { id, rec, x, y };
  });

  const rows = Math.ceil(artifacts.length / COLS) || 1;
  const canvasW = COLS * (TILE_W + GAP) + GAP;
  const canvasH = rows * (TILE_H + GAP) + GAP;

  if (artifacts.length === 0) {
    return (
      <div className="canvas-wrap">
        <div className="empty">no artifacts in this run</div>
      </div>
    );
  }

  return (
    <div className="canvas-wrap">
      <TransformWrapper
        initialScale={1}
        minScale={0.2}
        maxScale={4}
        wheel={{ step: 0.15 }}
        doubleClick={{ disabled: true }}
        panning={{ velocityDisabled: true }}
        limitToBounds={false}
      >
        {({ resetTransform, zoomIn, zoomOut }) => (
          <>
            <div className="toolbar">
              <button onClick={() => zoomOut()}>−</button>
              <button onClick={() => resetTransform()}>fit</button>
              <button onClick={() => zoomIn()}>+</button>
            </div>
            <TransformComponent
              wrapperStyle={{ width: "100%", height: "100%" }}
              contentStyle={{ width: canvasW, height: canvasH }}
            >
              <div style={{ position: "relative", width: canvasW, height: canvasH }}>
                {tiles.map(({ id, rec, x, y }) => (
                  <TileWrapper
                    key={id}
                    artifactId={id}
                    record={rec}
                    manifest={props.manifest}
                    x={x}
                    y={y}
                    w={TILE_W}
                    h={TILE_H}
                  />
                ))}
              </div>
            </TransformComponent>
          </>
        )}
      </TransformWrapper>
    </div>
  );
}

function TileWrapper(props: {
  artifactId: string;
  record: ArtifactRecord;
  manifest: Manifest;
  x: number;
  y: number;
  w: number;
  h: number;
}) {
  const [overrideId, setOverrideId] = useState<string | null>(null);
  const showId = overrideId ?? props.artifactId;
  const showRec = props.manifest.artifacts[showId] ?? props.record;

  // Discover all revisions of this name in this project for the dropdown.
  const revisions = Object.entries(props.manifest.artifacts)
    .filter(
      ([, a]) =>
        a.projectId === props.record.projectId && a.name === props.record.name,
    )
    .sort((a, b) => b[1].revision - a[1].revision);

  return (
    <div
      className="tile"
      style={{ left: props.x, top: props.y, width: props.w, height: props.h }}
    >
      <div className="tile-head">
        <span className="name">{showRec.name}</span>
        <span className="rev">
          <select
            value={showId}
            onChange={(e) => setOverrideId(e.target.value)}
          >
            {revisions.map(([id, r]) => (
              <option key={id} value={id}>
                v{r.revision}
              </option>
            ))}
          </select>
        </span>
      </div>
      <Tile artifactId={showId} type={showRec.type} />
    </div>
  );
}
