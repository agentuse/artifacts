import { useEffect, useRef, useState } from "react";
import {
  TransformWrapper,
  TransformComponent,
  type ReactZoomPanPinchRef,
} from "react-zoom-pan-pinch";
import type { ArtifactRecord, Manifest } from "../types";
import { Tile } from "./Tile";

const TILE_W = 720;
const TILE_H = 720;
const GAP = 32;
const COLS = 2;

export function Canvas(props: {
  manifest: Manifest;
  artifacts: Array<[string, ArtifactRecord]>;
  expandedId: string | null;
  onExpandedChange: (id: string | null) => void;
}) {
  const { artifacts, expandedId, onExpandedChange } = props;
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

  // iPad Safari fires gesturestart/change/end for trackpad pinch. We cancel
  // them so Safari doesn't try to page-zoom the SPA. NOTE: iPadOS captures
  // multi-finger trackpad pinch at the system level (Stage Manager / tab
  // overview) BEFORE the page sees the event — we cannot suppress that. Use
  // Cmd+= / Cmd+- / Cmd+0 (wired below) or the on-canvas toolbar instead.
  const wrapRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef<ReactZoomPanPinchRef>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const stop = (e: Event) => e.preventDefault();
    const opts: AddEventListenerOptions = { passive: false };
    el.addEventListener("gesturestart", stop, opts);
    el.addEventListener("gesturechange", stop, opts);
    el.addEventListener("gestureend", stop, opts);
    return () => {
      el.removeEventListener("gesturestart", stop, opts);
      el.removeEventListener("gesturechange", stop, opts);
      el.removeEventListener("gestureend", stop, opts);
    };
  }, []);

  // Cmd/Ctrl + (= or +) / - / 0 → zoom in / out / reset. Provides a reliable
  // zoom path on iPad where trackpad pinch is eaten by the OS.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && expandedId) {
        onExpandedChange(null);
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      const r = transformRef.current;
      if (!r) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        r.zoomIn();
      } else if (e.key === "-") {
        e.preventDefault();
        r.zoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        r.resetTransform();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expandedId, onExpandedChange]);

  // Resolve the expanded record from the manifest so the overlay survives a
  // revision switch made from inside the canvas tile.
  const expandedRec = expandedId ? props.manifest.artifacts[expandedId] : undefined;

  // Hybrid grid: dots drawn on the un-transformed canvas-wrap, but their
  // size/offset is driven by the current pan+scale so they appear to glide
  // with the canvas (Figma feel) without re-rendering DOM during pan.
  const updateGrid = (state: { scale: number; positionX: number; positionY: number }) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const gs = 24 * state.scale;
    // Modulo into [0, gs) so background-position values stay small and
    // the pattern wraps continuously instead of drifting forever.
    const ox = ((state.positionX % gs) + gs) % gs;
    const oy = ((state.positionY % gs) + gs) % gs;
    wrap.style.setProperty("--grid-size", `${gs}px`);
    wrap.style.setProperty("--grid-bg-x", `${ox}px`);
    wrap.style.setProperty("--grid-bg-y", `${oy}px`);
  };

  if (artifacts.length === 0) {
    return (
      <div className="canvas-wrap" ref={wrapRef}>
        <div className="empty">no artifacts in this run</div>
      </div>
    );
  }

  return (
    <div className="canvas-wrap" ref={wrapRef}>
      <TransformWrapper
        ref={transformRef}
        initialScale={1}
        minScale={0.2}
        maxScale={4}
        // wheelDisabled blocks plain-wheel zoom but still allows ctrlKey wheel
        // (trackpad pinch). wheelPanning then turns plain scroll into a pan.
        wheel={{ step: 0.15, wheelDisabled: true }}
        doubleClick={{ disabled: true }}
        panning={{ velocityDisabled: true, wheelPanning: true }}
        limitToBounds={false}
        onInit={(r) => updateGrid(r.state)}
        onTransformed={(_r, state) => updateGrid(state)}
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
              <div
                style={{ position: "relative", width: canvasW, height: canvasH }}
              >
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
                    onExpand={() => onExpandedChange(id)}
                  />
                ))}
              </div>
            </TransformComponent>
          </>
        )}
      </TransformWrapper>
      {expandedId && expandedRec && (
        <TileWrapper
          key={"expanded-" + expandedId}
          artifactId={expandedId}
          record={expandedRec}
          manifest={props.manifest}
          expanded
          onClose={() => onExpandedChange(null)}
        />
      )}
    </div>
  );
}

type TileWrapperProps = {
  artifactId: string;
  record: ArtifactRecord;
  manifest: Manifest;
} & (
  | { expanded?: false; x: number; y: number; w: number; h: number; onExpand: () => void; onClose?: never }
  | { expanded: true; onClose: () => void; onExpand?: never; x?: never; y?: never; w?: never; h?: never }
);

function TileWrapper(props: TileWrapperProps) {
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

  const tileStyle = props.expanded
    ? undefined
    : { left: props.x, top: props.y, width: props.w, height: props.h };

  return (
    <div
      className={"tile" + (props.expanded ? " tile-expanded" : "")}
      style={tileStyle}
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
        {props.expanded ? (
          <button
            className="icon-btn"
            onClick={props.onClose}
            aria-label="exit fullscreen"
            title="exit fullscreen (esc)"
          >
            ✕
          </button>
        ) : (
          <button
            className="icon-btn"
            onClick={props.onExpand}
            aria-label="fullscreen"
            title="fullscreen"
          >
            ⤢
          </button>
        )}
      </div>
      <Tile artifactId={showId} type={showRec.type} />
    </div>
  );
}
