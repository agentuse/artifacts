import { useEffect, useRef, useState } from "react";
import {
  TransformWrapper,
  TransformComponent,
  type ReactZoomPanPinchRef,
} from "react-zoom-pan-pinch";
import {
  Check,
  Copy,
  Download,
  FileText,
  Maximize2,
  Minus,
  MoreHorizontal,
  Plus,
  X,
} from "lucide-react";
import type { ArtifactRecord } from "../types";
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

function formatRelativeTime(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = Math.max(0, Math.floor((now - t) / 1000));
  if (diff < 60) return `${diff}s ago`;
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function RelativeTime(props: { iso: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const label = formatRelativeTime(props.iso, now);
  if (!label) return null;
  return (
    <span className="mtime" title={new Date(props.iso).toLocaleString()}>
      {label}
    </span>
  );
}

type SizeMap = Record<string, { w: number; h: number }>;

/** sizeOverrides is keyed by `${projectId}/${name}` (NOT artifactId) so a
 *  user-set size persists as the artifact file changes. */
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

/** Fit the image's natural dimensions into a TILE_W bounding box, then scale
 *  the whole tile up if needed to preserve aspect ratio while satisfying the
 *  minimum interactive size. Applying MIN_TILE_W/H independently would make
 *  extreme portrait/landscape images sit inside a mismatched frame; scaling
 *  the pair keeps the preview canvas shaped like the image. Returns undefined
 *  when the record isn't an image or natural dims weren't probed. */
function naturalDefault(
  rec: { type: string; naturalWidth?: number; naturalHeight?: number },
): { w: number; h: number } | undefined {
  if (rec.type !== "png" && rec.type !== "jpg" && rec.type !== "webp") {
    return undefined;
  }
  const nw = rec.naturalWidth;
  const nh = rec.naturalHeight;
  if (nw == null || nh == null || nw <= 0 || nh <= 0) return undefined;
  const aspect = nw / nh;
  let w = aspect >= 1 ? TILE_W : TILE_W * aspect;
  let h = aspect >= 1 ? TILE_W / aspect : TILE_W;
  const minScale = Math.max(1, MIN_TILE_W / w, MIN_TILE_H / h);
  w *= minScale;
  h *= minScale;
  return {
    w: Math.round(w),
    h: Math.round(h),
  };
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
// reuse the value here for vertical positioning. Sized to host 44×44
// touch targets per Apple HIG (and Material's 48dp) plus padding.
const FLOATING_HEAD_H = 56;
const FLOATING_HEAD_GAP = 8;
const FLOATING_HEAD_MIN_W = 520;
const FLOATING_HEAD_MIN_TOP = 8;
const FLOATING_HEAD_MARGIN = 8;

export function Canvas(props: {
  artifacts: Array<[string, ArtifactRecord]>;
  expandedId: string | null;
  panesHidden?: boolean;
  onExpandedChange: (id: string | null) => void;
}) {
  const { artifacts, expandedId, onExpandedChange } = props;
  // Figma-style focus: an unfocused tile is a non-interactive preview. A
  // focused tile drops the body's pointer-events: none guard and surfaces a
  // floating head (positioned in screen space, see below) so the controls
  // stay readable at any zoom. Click outside or Esc to exit.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // Per-tile size overrides set by the focused-tile resize handle. Keyed by
  // `${projectId}/${name}` so the size sticks as the artifact file changes.
  // Hydrated from localStorage on mount; we persist once per
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
    // Size precedence:
    //   user override > image natural (aspect-fit) > agent-suggested > default
    // Natural pixels are intrinsic to the file — when we have them they are
    // a better source of truth than an agent's dimension hint, which is
    // a guess and can be aspect-wrong (e.g. an agent passing 720×1100 for
    // a landscape PNG, which letterboxes inside a portrait tile). Suggested
    // remains the fallback for old artifacts that predate the natural-dim
    // probe. MIN_TILE_W/H floors keep
    // a tiny image from collapsing to an unusable size.
    const ov = sizeOverrides[sizeKey(rec)];
    const natural = naturalDefault(rec);
    const w =
      ov?.w ??
      natural?.w ??
      (rec.suggestedWidth != null
        ? Math.max(MIN_TILE_W, rec.suggestedWidth)
        : TILE_W);
    const h =
      ov?.h ??
      natural?.h ??
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

  const paneInsetForViewport = (viewportW: number): number => {
    if (props.panesHidden || viewportW <= 900) return 0;
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--pane-total-w");
    const cssPaneW = parseFloat(raw);
    return Math.min(viewportW, Number.isFinite(cssPaneW) ? cssPaneW : 520);
  };

  const measuredPaneInset = (wrap: HTMLElement): number => {
    if (props.panesHidden) return 0;
    const drawer = document.querySelector<HTMLElement>(".drawer");
    const drawerRect = drawer?.getBoundingClientRect();
    if (drawerRect && drawerRect.right > 0) {
      return Math.max(0, Math.min(wrap.clientWidth, drawerRect.right));
    }
    return paneInsetForViewport(wrap.clientWidth);
  };

  const computeFitTransform = (
    viewportW: number,
    viewportH: number,
    paneInset: number,
  ): { x: number; y: number; scale: number } => {
    const openW = Math.max(1, viewportW - paneInset);
    const openH = Math.max(1, viewportH);

    const contentLeft = tiles.length ? Math.min(...tiles.map((t) => t.x)) : 0;
    const contentTop = tiles.length ? Math.min(...tiles.map((t) => t.y)) : 0;
    const contentRight = tiles.length
      ? Math.max(...tiles.map((t) => t.x + t.w))
      : canvasW;
    const contentBottom = tiles.length
      ? Math.max(...tiles.map((t) => t.y + t.h))
      : canvasH;
    const contentW = Math.max(1, contentRight - contentLeft);
    const contentH = Math.max(1, contentBottom - contentTop);

    const usableW = Math.max(1, openW - FIT_PADDING * 2);
    const usableH = Math.max(1, openH - FIT_PADDING * 2);
    const widthFit = usableW / contentW;
    const heightFit = usableH / contentH;
    let scale = Math.min(1, widthFit, heightFit);
    if (scale < MIN_SCALE) {
      // Very long folders, especially on phones, cannot meaningfully fit on
      // both axes. Prefer a readable width-fit view and let the user pan down
      // the column instead of shrinking/centering the whole folder into a tiny
      // strip.
      scale = widthFit >= MIN_SCALE ? Math.min(1, widthFit) : MIN_SCALE;
    }
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    const scaledW = contentW * scale;
    const scaledH = contentH * scale;
    return {
      x:
        paneInset +
        FIT_PADDING +
        (scaledW <= usableW ? (usableW - scaledW) / 2 : 0) -
        contentLeft * scale,
      y:
        FIT_PADDING +
        (scaledH <= usableH ? (usableH - scaledH) / 2 : 0) -
        contentTop * scale,
      scale,
    };
  };

  const initialFit = computeFitTransform(
    typeof window !== "undefined" ? window.innerWidth : wrapWidth,
    typeof window !== "undefined" ? window.innerHeight : 900,
    paneInsetForViewport(typeof window !== "undefined" ? window.innerWidth : wrapWidth),
  );

  // Compute the transform that fits the visible artifacts into the currently
  // open viewport. Panes are overlays, so fitting reserves their overlap but
  // normal pane hide/show does not participate in canvas layout.
  const fitToContent = (duration = 200) => {
    const r = transformRef.current;
    const wrap = wrapRef.current;
    if (!r || !wrap) return;
    const next = computeFitTransform(
      wrap.clientWidth,
      wrap.clientHeight,
      measuredPaneInset(wrap),
    );
    r.setTransform(next.x, next.y, next.scale, duration);
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

  const expandedRec = expandedId
    ? artifacts.find(([id]) => id === expandedId)?.[1]
    : undefined;

  // ── Floating head positioning ──────────────────────────────────────────
  // The head sits in screen space (anchored to .canvas-wrap, NOT inside
  // TransformComponent), so it doesn't scale with the canvas. We update its
  // left/top/width imperatively from the rzpp transform callback to avoid a
  // React re-render every frame during pan.
  const positionFloatingHead = () => {
    const head = floatingHeadRef.current;
    const rect = focusedRectRef.current;
    const wrap = wrapRef.current;
    if (!head || !rect || !wrap) return;
    const { positionX, positionY, scale } = transformStateRef.current;
    const screenX = positionX + rect.x * scale;
    const screenY = positionY + rect.y * scale;
    const screenW = rect.w * scale;
    const maxW = Math.max(1, wrap.clientWidth - FLOATING_HEAD_MARGIN * 2);
    const width = Math.min(maxW, Math.max(FLOATING_HEAD_MIN_W, screenW));
    const left = Math.min(
      Math.max(FLOATING_HEAD_MARGIN, screenX),
      Math.max(FLOATING_HEAD_MARGIN, wrap.clientWidth - width - FLOATING_HEAD_MARGIN),
    );
    const top = Math.max(
      FLOATING_HEAD_MIN_TOP,
      screenY - FLOATING_HEAD_H - FLOATING_HEAD_GAP,
    );
    head.style.left = `${left}px`;
    head.style.top = `${top}px`;
    head.style.width = `${width}px`;
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

  const focusedRec = focusedId
    ? artifacts.find(([id]) => id === focusedId)?.[1]
    : undefined;

  if (artifacts.length === 0) {
    return (
      <div className="canvas-wrap" ref={wrapRef}>
        <div className="empty">no artifacts in this project</div>
      </div>
    );
  }

  return (
    <div className="canvas-wrap" ref={wrapRef}>
      <TransformWrapper
        ref={transformRef}
        initialScale={initialFit.scale}
        initialPositionX={initialFit.x}
        initialPositionY={initialFit.y}
        minScale={MIN_SCALE}
        maxScale={MAX_SCALE}
        // wheelDisabled blocks plain-wheel zoom but still allows ctrlKey wheel
        // (trackpad pinch). wheelPanning then turns plain scroll into a pan.
        wheel={{ step: 0.15, wheelDisabled: true }}
        doubleClick={{ disabled: true }}
        panning={{ velocityDisabled: true, wheelPanning: true }}
        limitToBounds={false}
        onInit={(r) => {
          updateGrid(r.state);
          requestAnimationFrame(() => fitToContent(0));
        }}
        onTransformed={(_r, state) => updateGrid(state)}
      >
        {({ zoomIn, zoomOut }) => (
          <>
            <div className="toolbar">
              <button onClick={() => zoomOut()} aria-label="zoom out">
                <Minus size={16} strokeWidth={2} />
              </button>
              <button onClick={() => fitToContent()}>fit</button>
              <button onClick={() => zoomIn()} aria-label="zoom in">
                <Plus size={16} strokeWidth={2} />
              </button>
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
                  />
                ))}
              </div>
            </TransformComponent>
          </>
        )}
      </TransformWrapper>
      {focusedId && focusedRec && (
        <div
          ref={floatingHeadRef}
          data-floating-head-for={focusedId}
          className="tile-head tile-head-floating"
        >
          <span className="name">{focusedRec.name}</span>
          <RelativeTime iso={focusedRec.createdAt} />
          <TileActions artifactId={focusedId} record={focusedRec} />
          <button
            className="icon-btn"
            onClick={() => onExpandedChange(focusedId)}
            aria-label="fullscreen"
            title="fullscreen"
          >
            <Maximize2 size={16} strokeWidth={2} />
          </button>
          <button
            className="icon-btn"
            onClick={() => setFocusedId(null)}
            aria-label="exit focus"
            title="exit focus (esc)"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>
      )}
      {expandedId && expandedRec && (
        <TileWrapper
          key={"expanded-" + expandedId}
          artifactId={expandedId}
          record={expandedRec}
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
          <span className="name">
            {props.record.localEntry ?? props.record.projectRelPath ?? props.record.name}
          </span>
          <RelativeTime iso={props.record.createdAt} />
          <TileActions artifactId={props.artifactId} record={props.record} />
          {props.expanded ? (
            <button
              className="icon-btn"
              onClick={props.onClose}
              aria-label="exit fullscreen"
              title="exit fullscreen (esc)"
            >
              <X size={16} strokeWidth={2} />
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
        <Tile artifactId={props.artifactId} record={props.record} />
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

// "..." menu collapsing the per-tile actions (download, copy raw content,
// copy on-disk path). Download and "copy content" go through /api/raw/:id so
// they return the exact file the agent wrote — notably the original
// (unsanitized) HTML rather than what the viewer iframe sees.
// /api/render/:id stays the rendering path; /api/raw/:id is for "give me
// the file." "Copy path" copies record.absolutePath as plain text.
type CopyState = null | "path" | "content";

function TileActions(props: { artifactId: string; record: ArtifactRecord }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<CopyState>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const rawUrl = `/api/raw/${props.artifactId}`;
  const filename =
    props.record.name.split("/").pop() || props.record.name;
  const isText =
    props.record.type === "markdown" || props.record.type === "html";
  const absolutePath = props.record.absolutePath;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t && rootRef.current && rootRef.current.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const flashCopied = (which: Exclude<CopyState, null>) => {
    setCopied(which);
    setTimeout(() => setCopied((v) => (v === which ? null : v)), 1200);
  };

  const onCopyPath = async () => {
    if (!absolutePath) return;
    try {
      await navigator.clipboard.writeText(absolutePath);
      flashCopied("path");
      setOpen(false);
    } catch {
      // Clipboard blocked (insecure context, permission denied) — leave UI alone.
    }
  };

  const onCopyContent = async () => {
    try {
      const res = await fetch(rawUrl, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      flashCopied("content");
      setOpen(false);
    } catch {
      // ignore — no toast system in this viewer
    }
  };

  return (
    <div className="action-menu" ref={rootRef}>
      <button
        className="icon-btn"
        onClick={() => setOpen((v) => !v)}
        aria-label="more actions"
        aria-haspopup="menu"
        aria-expanded={open}
        title="more actions"
      >
        {copied ? (
          <Check size={16} strokeWidth={2} />
        ) : (
          <MoreHorizontal size={16} strokeWidth={2} />
        )}
      </button>
      {open && (
        <div className="action-menu-panel" role="menu">
          {absolutePath && (
            <button
              role="menuitem"
              className="action-menu-item"
              onClick={onCopyPath}
              title={absolutePath}
            >
              {copied === "path" ? (
                <Check size={14} strokeWidth={2} />
              ) : (
                <FileText size={14} strokeWidth={2} />
              )}
              <span>Copy path</span>
            </button>
          )}
          {isText && (
            <button
              role="menuitem"
              className="action-menu-item"
              onClick={onCopyContent}
            >
              {copied === "content" ? (
                <Check size={14} strokeWidth={2} />
              ) : (
                <Copy size={14} strokeWidth={2} />
              )}
              <span>Copy content</span>
            </button>
          )}
          <a
            role="menuitem"
            className="action-menu-item"
            href={rawUrl}
            download={filename}
            onClick={() => setOpen(false)}
          >
            <Download size={14} strokeWidth={2} />
            <span>Download</span>
          </a>
        </div>
      )}
    </div>
  );
}
