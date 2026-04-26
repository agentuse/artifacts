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
const GAP = 64;
const MIN_COLS = 1;
const MAX_COLS = 6;
const MIN_SCALE = 0.2;
const MAX_SCALE = 4;
const FIT_PADDING = 24;
// Hard floor for resize so the user can't shrink a tile to nothing and lose
// the resize handle. Maximum is implicit (canvas can grow). The same floor
// is applied when reading agent-supplied suggestedWidth/suggestedHeight so
// a misbehaving agent can't ship an unusably tiny tile.
const MIN_TILE_W = 280;
const MIN_TILE_H = 200;
const STORAGE_KEY = "agentuse-artifacts.tile-sizes.v1";

type SizeMap = Record<string, { w: number; h: number }>;

/** sizeOverrides is keyed by `${projectId}/${name}` (NOT artifactId) so a
 *  user-set size persists across new revisions of the same artifact. */
const sizeKey = (rec: { projectId: string; name: string }): string =>
  `${rec.projectId}/${rec.name}`;

function loadStoredSizes(): SizeMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: SizeMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        v &&
        typeof v === "object" &&
        typeof (v as { w?: unknown }).w === "number" &&
        typeof (v as { h?: unknown }).h === "number"
      ) {
        out[k] = {
          w: (v as { w: number }).w,
          h: (v as { h: number }).h,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function persistSizes(map: SizeMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Quota / private mode — silently ignore. Sizes still work in-session.
  }
}
// Floating head (Figma frame-label) sits above the focused tile in screen
// space, so it stays readable at every zoom. Height is fixed in CSS — we
// reuse the value here for vertical positioning.
const FLOATING_HEAD_H = 32;
const FLOATING_HEAD_GAP = 6;
const FLOATING_HEAD_MIN_W = 240;
const FLOATING_HEAD_MIN_TOP = 8;

export function Canvas(props: {
  manifest: Manifest;
  artifacts: Array<[string, ArtifactRecord]>;
  expandedId: string | null;
  onExpandedChange: (id: string | null) => void;
}) {
  const { artifacts, expandedId, onExpandedChange } = props;
  // Figma-style focus: an unfocused tile is a non-interactive preview. A
  // focused tile drops the body's pointer-events: none guard and surfaces a
  // floating head (positioned in screen space, see below) so the controls
  // stay readable at any zoom. Click outside or Esc to exit.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // Per-tile revision selection. Lifted from TileWrapper so the floating
  // head and the in-tile head (used in fullscreen) read/write the same map.
  const [revisionOverrides, setRevisionOverrides] = useState<
    Record<string, string>
  >({});
  // Per-tile size overrides set by the focused-tile resize handle. Keyed by
  // `${projectId}/${name}` so the size sticks across new revisions of the
  // same artifact. Hydrated from localStorage on mount; we persist once per
  // resize gesture (in the pointerup callback inside handleResizeStart),
  // not on every pointermove, to avoid 60-writes-per-second.
  const [sizeOverrides, setSizeOverrides] = useState<SizeMap>(() =>
    loadStoredSizes(),
  );
  // Track the canvas wrapper's clientWidth so the column count can flex
  // with the visible viewport. Without this the layout was hardcoded to
  // 2 columns and left big empty gutters on wide screens. Initialize from
  // window.innerWidth as a usable pre-mount guess; the ResizeObserver
  // below corrects it once the wrapper is laid out.
  const [wrapWidth, setWrapWidth] = useState<number>(() =>
    typeof window !== "undefined" ? window.innerWidth : 1600,
  );
  // Default to the latest revision of the same (project, name) so the
  // fullscreen overlay and floating head hot-reload when a new revision
  // arrives. Without this, expandedId is frozen at the moment the user hit
  // expand — canvas tiles update because the latest map remounts them with
  // a new id, but the overlay never sees that swap. An explicit dropdown
  // pick wins, so manually pinning to v2 still sticks.
  const showIdFor = (id: string) => {
    const override = revisionOverrides[id];
    if (override) return override;
    const rec = props.manifest.artifacts[id];
    if (!rec) return id;
    return props.manifest.latest[rec.projectId]?.[rec.name] ?? id;
  };
  const setShowIdFor = (id: string, next: string) =>
    setRevisionOverrides((prev) => ({ ...prev, [id]: next }));

  // Row-flow layout. Column count flexes with the wrapper width so wide
  // viewports actually use the available horizontal space (instead of a
  // fixed 2-col grid that left a big right-side gap). Tiles get placed
  // left-to-right and wrap when the next tile won't fit. Row height =
  // max height of tiles in that row, so a taller (resized) tile pushes
  // the next row down without overlapping. A tile wider than the
  // baseline takes the row to itself and stretches the canvas.
  const fittingCols = Math.floor((wrapWidth - GAP) / (TILE_W + GAP));
  const COLS = Math.max(MIN_COLS, Math.min(MAX_COLS, fittingCols));
  const baselineRowWidth = COLS * TILE_W + (COLS + 1) * GAP;
  type LaidOut = {
    id: string;
    rec: ArtifactRecord;
    x: number;
    y: number;
    w: number;
    h: number;
  };
  const tiles: LaidOut[] = [];
  let cursorX = GAP;
  let cursorY = GAP;
  let rowMaxH = 0;
  let layoutMaxRight = 0;
  for (const [id, rec] of artifacts) {
    // Size precedence: user override > agent-suggested > default. Suggested
    // values come from the artifact record (set at `add` time via
    // --width/--height). The viewer floors them at MIN_TILE_W/H so a
    // misbehaving agent can't ship an unusably tiny tile.
    const ov = sizeOverrides[sizeKey(rec)];
    const w =
      ov?.w ??
      (rec.suggestedWidth != null
        ? Math.max(MIN_TILE_W, rec.suggestedWidth)
        : TILE_W);
    const h =
      ov?.h ??
      (rec.suggestedHeight != null
        ? Math.max(MIN_TILE_H, rec.suggestedHeight)
        : TILE_H);
    // Wrap when this tile doesn't fit in the remaining row width. The
    // `cursorX > GAP` guard prevents an empty wrap when the tile alone is
    // wider than baselineRowWidth — it just takes the row.
    if (cursorX > GAP && cursorX + w + GAP > baselineRowWidth) {
      cursorX = GAP;
      cursorY += rowMaxH + GAP;
      rowMaxH = 0;
    }
    tiles.push({ id, rec, x: cursorX, y: cursorY, w, h });
    cursorX += w + GAP;
    rowMaxH = Math.max(rowMaxH, h);
    layoutMaxRight = Math.max(layoutMaxRight, cursorX);
  }
  const layoutMaxBottom = cursorY + rowMaxH + GAP;
  const canvasW = Math.max(baselineRowWidth, layoutMaxRight);
  const canvasH = artifacts.length === 0 ? GAP * 2 + TILE_H : layoutMaxBottom;

  // iPad Safari fires gesturestart/change/end for trackpad pinch. We cancel
  // them so Safari doesn't try to page-zoom the SPA. NOTE: iPadOS captures
  // multi-finger trackpad pinch at the system level (Stage Manager / tab
  // overview) BEFORE the page sees the event — we cannot suppress that. Use
  // Cmd+= / Cmd+- / Cmd+0 (wired below) or the on-canvas toolbar instead.
  const wrapRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef<ReactZoomPanPinchRef>(null);
  const floatingHeadRef = useRef<HTMLDivElement>(null);
  // Latest pan+scale, mirrored as a ref so the rzpp callback can position
  // the floating head without triggering a React re-render every frame.
  const transformStateRef = useRef<{
    positionX: number;
    positionY: number;
    scale: number;
  }>({ positionX: 0, positionY: 0, scale: 1 });
  // Focused tile's canvas-space rect, kept in a ref for the same reason.
  const focusedRectRef = useRef<{ x: number; y: number; w: number } | null>(
    null,
  );
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

  // Track wrapper width for responsive column count. Sync once on mount
  // (replaces the window.innerWidth seed with the real laid-out width)
  // and again whenever the wrapper resizes — opening/closing the sidebar
  // drawer, splitting the window, etc.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWrapWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        if (w > 0) setWrapWidth(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Compute the transform that fits the entire content rect into the viewport
  // (with padding) and centers it. resetTransform is "scale 1, origin (0,0)"
  // and overflows on most viewports, which isn't what "fit" means.
  const fitToContent = () => {
    const r = transformRef.current;
    const wrap = wrapRef.current;
    if (!r || !wrap) return;
    const vw = wrap.clientWidth;
    const vh = wrap.clientHeight;
    if (vw <= 0 || vh <= 0) return;
    const usableW = Math.max(1, vw - FIT_PADDING * 2);
    const usableH = Math.max(1, vh - FIT_PADDING * 2);
    const ideal = Math.min(usableW / canvasW, usableH / canvasH);
    // Don't zoom past 1x for small content (prevents huge upscaling on a
    // single tile); clamp to the wrapper's own scale bounds otherwise.
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(1, ideal)));
    const px = (vw - canvasW * scale) / 2;
    const py = (vh - canvasH * scale) / 2;
    r.setTransform(px, py, scale, 200);
  };

  // Auto-fit on mount and whenever the content rect changes (artifact count
  // change, or the artifact set itself swapped because of a route change).
  useEffect(() => {
    // Defer one frame so TransformWrapper's onInit has wired up the ref and
    // the wrapper has its real layout size.
    const id = requestAnimationFrame(() => fitToContent());
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasW, canvasH, artifacts.length]);

  // Cmd/Ctrl + (= or +) / - / 0 → zoom in / out / fit. Provides a reliable
  // zoom path on iPad where trackpad pinch is eaten by the OS.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Esc walks the modal stack outside-in: fullscreen first, then focus.
        if (expandedId) {
          onExpandedChange(null);
          return;
        }
        if (focusedId) {
          setFocusedId(null);
          return;
        }
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
        fitToContent();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedId, onExpandedChange, focusedId]);

  // Outside-click defocus. Capture phase so we hear the pointerdown before
  // it bubbles up (and before react-zoom-pan-pinch's window mousedown). The
  // floating head lives outside the tile's DOM subtree, so we accept clicks
  // on either the focused tile OR its floating head as "still focused".
  useEffect(() => {
    if (!focusedId) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const inTile = t.closest(`[data-tile-id="${CSS.escape(focusedId)}"]`);
      const inHead = t.closest(
        `[data-floating-head-for="${CSS.escape(focusedId)}"]`,
      );
      if (!inTile && !inHead) setFocusedId(null);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [focusedId]);

  // Expanding a tile supersedes preview-focus: drop it so we don't return
  // from fullscreen into a half-state.
  useEffect(() => {
    if (expandedId && focusedId) setFocusedId(null);
  }, [expandedId, focusedId]);

  // Resolve the expanded record from the manifest so the overlay survives a
  // revision switch made from inside the canvas tile.
  const expandedShowId = expandedId ? showIdFor(expandedId) : null;
  const expandedRec = expandedShowId
    ? props.manifest.artifacts[expandedShowId]
    : undefined;
  const expandedOriginalRec = expandedId
    ? props.manifest.artifacts[expandedId]
    : undefined;

  // ── Floating head positioning ──────────────────────────────────────────
  // The head sits in screen space (anchored to .canvas-wrap, NOT inside
  // TransformComponent), so it doesn't scale with the canvas. We update its
  // left/top/width imperatively from the rzpp transform callback to avoid a
  // React re-render every frame during pan.
  const positionFloatingHead = () => {
    const head = floatingHeadRef.current;
    const rect = focusedRectRef.current;
    if (!head || !rect) return;
    const { positionX, positionY, scale } = transformStateRef.current;
    const screenX = positionX + rect.x * scale;
    const screenY = positionY + rect.y * scale;
    const screenW = rect.w * scale;
    const top = Math.max(
      FLOATING_HEAD_MIN_TOP,
      screenY - FLOATING_HEAD_H - FLOATING_HEAD_GAP,
    );
    head.style.left = `${screenX}px`;
    head.style.top = `${top}px`;
    head.style.width = `${Math.max(FLOATING_HEAD_MIN_W, screenW)}px`;
  };

  // Hybrid grid: dots drawn on the un-transformed canvas-wrap, but their
  // size/offset is driven by the current pan+scale so they appear to glide
  // with the canvas (Figma feel) without re-rendering DOM during pan.
  const updateGrid = (state: {
    scale: number;
    positionX: number;
    positionY: number;
  }) => {
    transformStateRef.current = {
      positionX: state.positionX,
      positionY: state.positionY,
      scale: state.scale,
    };
    const wrap = wrapRef.current;
    if (wrap) {
      const gs = 24 * state.scale;
      // Modulo into [0, gs) so background-position values stay small and
      // the pattern wraps continuously instead of drifting forever.
      const ox = ((state.positionX % gs) + gs) % gs;
      const oy = ((state.positionY % gs) + gs) % gs;
      wrap.style.setProperty("--grid-size", `${gs}px`);
      wrap.style.setProperty("--grid-bg-x", `${ox}px`);
      wrap.style.setProperty("--grid-bg-y", `${oy}px`);
    }
    positionFloatingHead();
  };

  // Re-anchor the floating head whenever the focused tile changes (or the
  // layout that drives its rect changes). The transform itself is already
  // current in the ref — just apply it to the new rect.
  const focusedTile = focusedId ? tiles.find((t) => t.id === focusedId) : null;
  useEffect(() => {
    focusedRectRef.current = focusedTile
      ? { x: focusedTile.x, y: focusedTile.y, w: focusedTile.w }
      : null;
    // Defer to next frame so the head element exists in the DOM when we
    // size it (it's conditionally rendered).
    const id = requestAnimationFrame(() => positionFloatingHead());
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedId, focusedTile?.x, focusedTile?.y, focusedTile?.w]);

  // Drag-to-resize for the focused tile. Start size is captured at
  // pointerdown so each frame sets an absolute size — avoids drift from
  // accumulated deltas if React batches updates. Pointer deltas are in
  // screen pixels; divide by current canvas scale to translate into the
  // tile's own coordinate space. Persistence happens once on pointerup
  // (not on every move) — the move callback only mutates React state.
  const handleResizeStart = (
    key: string,
    startW: number,
    startH: number,
    e: React.PointerEvent,
  ) => {
    e.stopPropagation();
    e.preventDefault();
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    let lastSize = { w: startW, h: startH };
    const onMove = (ev: PointerEvent) => {
      const scale = transformStateRef.current.scale || 1;
      const dx = (ev.clientX - startClientX) / scale;
      const dy = (ev.clientY - startClientY) / scale;
      const next = {
        w: Math.max(MIN_TILE_W, startW + dx),
        h: Math.max(MIN_TILE_H, startH + dy),
      };
      lastSize = next;
      setSizeOverrides((prev) => ({ ...prev, [key]: next }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      // Read the current map and merge our final size, then persist. Using
      // setSizeOverrides here would re-render unnecessarily; we already set
      // the same value during the last move.
      setSizeOverrides((prev) => {
        const merged = { ...prev, [key]: lastSize };
        persistSizes(merged);
        return merged;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  // Resolve focused-tile state for the floating head's controls.
  const focusedShowId = focusedId ? showIdFor(focusedId) : null;
  const focusedShowRec = focusedShowId
    ? props.manifest.artifacts[focusedShowId]
    : undefined;
  const focusedOriginalRec = focusedId
    ? props.manifest.artifacts[focusedId]
    : undefined;
  const focusedRevisions = focusedOriginalRec
    ? Object.entries(props.manifest.artifacts)
        .filter(
          ([, a]) =>
            a.projectId === focusedOriginalRec.projectId &&
            a.name === focusedOriginalRec.name,
        )
        .sort((a, b) => b[1].revision - a[1].revision)
    : [];

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
        minScale={MIN_SCALE}
        maxScale={MAX_SCALE}
        // wheelDisabled blocks plain-wheel zoom but still allows ctrlKey wheel
        // (trackpad pinch). wheelPanning then turns plain scroll into a pan.
        wheel={{ step: 0.15, wheelDisabled: true }}
        doubleClick={{ disabled: true }}
        panning={{ velocityDisabled: true, wheelPanning: true }}
        limitToBounds={false}
        onInit={(r) => updateGrid(r.state)}
        onTransformed={(_r, state) => updateGrid(state)}
      >
        {({ zoomIn, zoomOut }) => (
          <>
            <div className="toolbar">
              <button onClick={() => zoomOut()}>−</button>
              <button onClick={fitToContent}>fit</button>
              <button onClick={() => zoomIn()}>+</button>
            </div>
            <TransformComponent
              wrapperStyle={{ width: "100%", height: "100%" }}
              contentStyle={{ width: canvasW, height: canvasH }}
            >
              <div
                style={{
                  position: "relative",
                  width: canvasW,
                  height: canvasH,
                }}
              >
                {tiles.map(({ id, rec, x, y, w, h }) => (
                  <TileWrapper
                    key={id}
                    artifactId={id}
                    record={rec}
                    manifest={props.manifest}
                    x={x}
                    y={y}
                    w={w}
                    h={h}
                    focused={focusedId === id}
                    onFocus={() => setFocusedId(id)}
                    onExpand={() => onExpandedChange(id)}
                    onResizeStart={(e) =>
                      handleResizeStart(sizeKey(rec), w, h, e)
                    }
                    showId={showIdFor(id)}
                    onShowIdChange={(next) => setShowIdFor(id, next)}
                  />
                ))}
              </div>
            </TransformComponent>
          </>
        )}
      </TransformWrapper>
      {focusedId && focusedShowRec && (
        <div
          ref={floatingHeadRef}
          data-floating-head-for={focusedId}
          className="tile-head tile-head-floating"
        >
          <span className="name">{focusedShowRec.name}</span>
          <span className="rev">
            <select
              value={focusedShowId ?? focusedId}
              onChange={(e) => setShowIdFor(focusedId, e.target.value)}
            >
              {focusedRevisions.map(([id, r]) => (
                <option key={id} value={id}>
                  v{r.revision}
                </option>
              ))}
            </select>
          </span>
          <button
            className="icon-btn"
            onClick={() => onExpandedChange(focusedId)}
            aria-label="fullscreen"
            title="fullscreen"
          >
            ⤢
          </button>
          <button
            className="icon-btn"
            onClick={() => setFocusedId(null)}
            aria-label="exit focus"
            title="exit focus (esc)"
          >
            ✕
          </button>
        </div>
      )}
      {expandedId && expandedRec && expandedOriginalRec && (
        <TileWrapper
          key={"expanded-" + expandedId}
          artifactId={expandedId}
          record={expandedOriginalRec}
          manifest={props.manifest}
          expanded
          onClose={() => onExpandedChange(null)}
          showId={expandedShowId ?? expandedId}
          onShowIdChange={(next) => setShowIdFor(expandedId, next)}
        />
      )}
    </div>
  );
}

type TileWrapperProps = {
  artifactId: string;
  record: ArtifactRecord;
  manifest: Manifest;
  showId: string;
  onShowIdChange: (next: string) => void;
} & (
  | {
      expanded?: false;
      x: number;
      y: number;
      w: number;
      h: number;
      onExpand: () => void;
      focused?: boolean;
      onFocus?: () => void;
      onResizeStart?: (e: React.PointerEvent) => void;
      onClose?: never;
    }
  | {
      expanded: true;
      onClose: () => void;
      onExpand?: never;
      focused?: never;
      onFocus?: never;
      onResizeStart?: never;
      x?: never;
      y?: never;
      w?: never;
      h?: never;
    }
);

function TileWrapper(props: TileWrapperProps) {
  const showRec = props.manifest.artifacts[props.showId] ?? props.record;

  // Discover all revisions of this name in this project for the dropdown.
  const revisions = Object.entries(props.manifest.artifacts)
    .filter(
      ([, a]) =>
        a.projectId === props.record.projectId && a.name === props.record.name,
    )
    .sort((a, b) => b[1].revision - a[1].revision);

  // Position via transform: translate(...) instead of left/top so that
  // layout reflows can be animated cheaply via a CSS transition on
  // `transform` (see styles.css). left/top transitions trigger layout on
  // each frame; transforms stay on the compositor. Width and height are
  // intentionally NOT transitioned — during a resize drag we want the
  // focused tile to track the cursor 1:1, not lag behind a tween.
  const tileStyle = props.expanded
    ? undefined
    : {
        transform: `translate(${props.x}px, ${props.y}px)`,
        width: props.w,
        height: props.h,
      };

  // Preview = canvas tile that isn't focused. We hide the chrome and make the
  // body non-interactive (see CSS — pointer-events: none on .tile-body causes
  // hit-testing to skip the iframe entirely, which is the only reliable way
  // to keep iOS Safari from routing touches into the artifact). Focused tiles
  // get their head bar via the floating head in Canvas — at that point the
  // in-tile head is intentionally suppressed so we don't double-render and
  // so the head stays readable when zoomed out.
  const isPreview = !props.expanded && !props.focused;
  const showInTileHead = !!props.expanded;

  return (
    <div
      data-tile-id={props.artifactId}
      className={
        "tile" +
        (props.expanded ? " tile-expanded" : "") +
        (props.focused ? " tile-focused" : "") +
        (isPreview ? " tile-preview" : "")
      }
      style={tileStyle}
    >
      {showInTileHead && (
        <div className="tile-head">
          <span className="name">{showRec.name}</span>
          <span className="rev">
            <select
              value={props.showId}
              onChange={(e) => props.onShowIdChange(e.target.value)}
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
          ) : null}
        </div>
      )}
      <div
        className="tile-body-wrap"
        // In preview mode .tile-body has pointer-events: none, so the iframe
        // (or markdown scroller) doesn't see touches. Hit-testing falls to
        // this wrapper, where a clean tap promotes the tile to focused. We
        // do NOT stopPropagation: pointerdown still bubbles to the canvas
        // pan handler, so a real drag pans instead of focusing.
        onClick={
          isPreview
            ? (e) => {
                e.stopPropagation();
                props.onFocus?.();
              }
            : undefined
        }
      >
        <Tile artifactId={props.showId} type={showRec.type} />
      </div>
      {/* Resize handle is only meaningful for a focused, non-expanded tile;
          fullscreen has no concept of size, and previews swallow pointer
          events. The handler stops propagation so the canvas pan/focus
          logic doesn't fire during a resize drag. */}
      {props.focused && !props.expanded && props.onResizeStart && (
        <div
          className="tile-resize-handle"
          onPointerDown={props.onResizeStart}
          aria-label="resize tile"
          title="drag to resize"
        />
      )}
    </div>
  );
}
