import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch } from 'react';
import {
  bboxOf,
  connectorAt,
  connectorLabelPos,
  connectorPath,
  findConnector,
  findShape,
  FRAME_BORDER_BAND,
  FRAME_LABEL_PAD_X,
  FRAME_LABEL_PAD_Y,
  FRAME_LABEL_ZONE_H,
  FRAME_LABEL_ZONE_W,
  frameHitZone,
  labelCenter,
  resizeAnchor,
  resizeHandlePoint,
  resolveEndpoint,
  shapeAt,
  triangleVertices,
} from '../model/doc';
import { fillTint, FLAT_FILL_DEFAULT, readableTextColor } from '../model/palette';
import type { Connector, FontSize, Pt, Shape } from '../model/types';
import { FONT_LINE_H, FONT_SIZE_PX, GRID, snap } from '../model/types';
import type { Action, EditorState } from '../state/reducer';

/** Turn a hex color into a safe DOM id fragment for a per-color arrow marker. */
const markerKey = (hex: string): string => hex.replace('#', '');

function Label({
  label,
  cx,
  cy,
  color,
  fontSize,
}: {
  label: string;
  cx: number;
  cy: number;
  color?: string;
  fontSize?: FontSize;
}) {
  if (!label) return null;
  const lineH = FONT_LINE_H[fontSize ?? 'm'];
  const lines = label.split('\n');
  const startY = cy - ((lines.length - 1) * lineH) / 2;
  return (
    <text
      fill={color ?? 'var(--shape-text)'}
      fontSize={FONT_SIZE_PX[fontSize ?? 'm']}
      textAnchor="middle"
      dominantBaseline="middle"
      style={{ userSelect: 'none', pointerEvents: 'none' }}
    >
      {lines.map((line, i) => (
        <tspan key={i} x={cx} y={startY + i * lineH}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

/** A frame's label, left-aligned and anchored to its top-left corner (unlike every other
 * shape's centered label) — the visual cue that distinguishes a frame's label placement from
 * the container itself, per the feature's design (see FRAME_LABEL_PAD_X/Y in model/doc.ts). */
function FrameLabel({
  label,
  x,
  y,
  color,
  fontSize,
}: {
  label: string;
  x: number;
  y: number;
  color?: string;
  fontSize?: FontSize;
}) {
  if (!label) return null;
  const lineH = FONT_LINE_H[fontSize ?? 'm'];
  const lines = label.split('\n');
  return (
    <text
      fill={color ?? 'var(--muted)'}
      fontSize={FONT_SIZE_PX[fontSize ?? 'm']}
      textAnchor="start"
      dominantBaseline="hanging"
      style={{ userSelect: 'none', pointerEvents: 'none' }}
    >
      {lines.map((line, i) => (
        <tspan key={i} x={x} y={y + i * lineH}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

/** Diamond polygon points for a bounding box, optionally expanded by `pad` (for the halo). */
function diamondPoints(s: Shape, pad = 0): string {
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  const x = s.x - pad;
  const y = s.y - pad;
  const w = s.w + pad * 2;
  const h = s.h + pad * 2;
  return `${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}`;
}

/** Pushes each edge of a convex polygon outward along its own normal by `pad`,
 * then re-intersects consecutive edges — a true parallel offset, unlike
 * padding the bounding box (which skews slanted edges since it only ever
 * moves them along x/y, not along their own normal). */
function offsetPolygon(vertices: Pt[], pad: number): Pt[] {
  if (!pad) return vertices;
  const n = vertices.length;
  const cx = vertices.reduce((s, p) => s + p.x, 0) / n;
  const cy = vertices.reduce((s, p) => s + p.y, 0) / n;
  const lines = vertices.map((a, i) => {
    const b = vertices[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    let nx = uy;
    let ny = -ux;
    const midx = (a.x + b.x) / 2;
    const midy = (a.y + b.y) / 2;
    if (nx * (cx - midx) + ny * (cy - midy) > 0) {
      nx = -nx;
      ny = -ny;
    }
    return { p: { x: a.x + nx * pad, y: a.y + ny * pad }, d: { x: ux, y: uy } };
  });
  return vertices.map((_, i) => {
    const prev = lines[(i - 1 + n) % n];
    const curr = lines[i];
    const denom = prev.d.x * curr.d.y - prev.d.y * curr.d.x;
    if (Math.abs(denom) < 1e-9) return curr.p;
    const dx = curr.p.x - prev.p.x;
    const dy = curr.p.y - prev.p.y;
    const t = (dx * curr.d.y - dy * curr.d.x) / denom;
    return { x: prev.p.x + t * prev.d.x, y: prev.p.y + t * prev.d.y };
  });
}

/** Triangle polygon points for a bounding box + apex direction, optionally expanded by `pad` (for the halo). */
function trianglePoints(box: { x: number; y: number; w: number; h: number; direction?: Shape['direction'] }, pad = 0): string {
  return offsetPolygon(triangleVertices(box), pad)
    .map((p) => `${p.x},${p.y}`)
    .join(' ');
}

function ShapeView({ s, selected, hot, tool }: { s: Shape; selected: boolean; hot: boolean; tool: string }) {
  // The shape's own color always stays visible; selection/hot is shown as a
  // halo around it instead of overriding the stroke (otherwise you can't see
  // the color you just picked while the item is still selected).
  // A frame defaults to a subdued stroke (not the brighter shape-stroke every other
  // kind uses) so it reads as a quiet container rather than another shape.
  const trueStroke = s.color ?? (s.kind === 'frame' ? 'var(--muted)' : 'var(--shape-stroke)');
  // Flat-fill ("ベタ塗り") style trades the tinted fill + stroke for a solid
  // background and no stroke, like a sticky note.
  const common = s.filled
    ? { fill: s.color ?? FLAT_FILL_DEFAULT, stroke: 'none', strokeWidth: 0 }
    : {
        fill: s.color ? fillTint(s.color) : 'var(--shape-fill)',
        stroke: trueStroke,
        strokeWidth: selected ? 2 : 1.5,
      };
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  const labelPos = labelCenter(s);
  const haloColor = selected ? 'var(--accent)' : hot ? 'var(--accent-dim)' : undefined;
  const halo = { fill: 'none', stroke: haloColor, strokeWidth: selected ? 3 : 2, opacity: 0.6 };
  // With the arrow tool active, dragging the shape body starts a new arrow
  // from it instead of moving it (see onMouseDown), so the dot-matching
  // "alias" cursor is the honest affordance here, not "move".
  const bodyCursor = tool === 'arrow' ? 'alias' : 'move';
  return (
    <g data-id={s.id} style={{ cursor: bodyCursor }}>
      {haloColor && (s.kind === 'rect' || s.kind === 'image') && (
        <rect x={s.x - 3} y={s.y - 3} width={s.w + 6} height={s.h + 6} rx={6} {...halo} />
      )}
      {haloColor && s.kind === 'ellipse' && (
        <ellipse cx={cx} cy={cy} rx={s.w / 2 + 3} ry={s.h / 2 + 3} {...halo} />
      )}
      {haloColor && s.kind === 'diamond' && <polygon points={diamondPoints(s, 3)} {...halo} />}
      {haloColor && s.kind === 'triangle' && <polygon points={trianglePoints(s, 3)} {...halo} />}
      {haloColor && s.kind === 'frame' && (
        <rect x={s.x - 3} y={s.y - 3} width={s.w + 6} height={s.h + 6} rx={10} {...halo} />
      )}
      {s.kind === 'rect' && <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={4} {...common} />}
      {s.kind === 'ellipse' && <ellipse cx={cx} cy={cy} rx={s.w / 2} ry={s.h / 2} {...common} />}
      {s.kind === 'diamond' && <polygon points={diamondPoints(s)} {...common} />}
      {s.kind === 'triangle' && <polygon points={trianglePoints(s)} {...common} />}
      {s.kind === 'frame' && (
        <>
          {/* Visible border only — no fill, so the open interior never paints (and so never
              hit-tests) over whatever the frame contains. Slightly rounded to read as
              distinct from a plain rect at a glance. */}
          <rect
            x={s.x}
            y={s.y}
            width={s.w}
            height={s.h}
            rx={8}
            fill="none"
            stroke={trueStroke}
            strokeWidth={selected ? 2 : 1.5}
            style={{ pointerEvents: 'none' }}
          />
          {/* Wide invisible stroke so the (thin) visible border is still an easy
              click/drag target — this is the frame's whole "hit zone" for its edges,
              matching frameHitZone in model/doc.ts. */}
          <rect
            x={s.x}
            y={s.y}
            width={s.w}
            height={s.h}
            fill="none"
            stroke="transparent"
            strokeWidth={FRAME_BORDER_BAND * 2}
          />
          {/* Label area is also clickable/draggable (part of "the frame", not its interior). */}
          <rect
            x={s.x}
            y={s.y}
            width={Math.min(FRAME_LABEL_ZONE_W, s.w)}
            height={Math.min(FRAME_LABEL_ZONE_H, s.h)}
            fill="transparent"
          />
        </>
      )}
      {s.kind === 'image' && s.src && (
        <image
          href={s.src}
          x={s.x}
          y={s.y}
          width={s.w}
          height={s.h}
          preserveAspectRatio="xMidYMid slice"
        />
      )}
      {s.kind === 'text' && (
        <rect
          x={s.x}
          y={s.y}
          width={s.w}
          height={s.h}
          fill="transparent"
          stroke={haloColor ?? (s.label ? 'transparent' : trueStroke)}
          strokeDasharray="4 3"
          strokeWidth={haloColor ? 1.5 : 1}
        />
      )}
      {s.kind === 'frame' ? (
        <FrameLabel
          label={s.label}
          x={s.x + FRAME_LABEL_PAD_X}
          y={s.y + FRAME_LABEL_PAD_Y}
          color={s.color}
          fontSize={s.fontSize}
        />
      ) : (
        <Label
          label={s.label}
          cx={labelPos.x}
          cy={labelPos.y}
          color={
            s.filled
              ? readableTextColor(s.color ?? FLAT_FILL_DEFAULT)
              : s.kind === 'text'
                ? s.color
                : undefined
          }
          fontSize={s.fontSize}
        />
      )}
    </g>
  );
}

/** How far outside the shape's edge each connect dot floats, so it doesn't
 * overlap the shape's own move-drag hit area. */
const CONNECT_DOT_OFFSET = 10;
/** Margin around a shape (beyond its bounds) that still counts as "hovering"
 * it, so the pointer can travel from the shape out to the connect dots
 * without the hover state dropping in between. Must exceed CONNECT_DOT_OFFSET. */
const HOVER_MARGIN = 20;

/** Topmost shape whose bounds, expanded by `margin`, contain `p`. A frame's open interior
 * doesn't count (same reasoning as frameHitZone) — hovering a shape a frame contains must
 * not have the frame steal the hover state (and its connect dots) instead. */
function shapeNear(doc: { shapes: Shape[] }, p: Pt, margin: number): Shape | undefined {
  for (let i = doc.shapes.length - 1; i >= 0; i--) {
    const s = doc.shapes[i];
    if (p.x >= s.x - margin && p.x <= s.x + s.w + margin && p.y >= s.y - margin && p.y <= s.y + s.h + margin) {
      if (s.kind === 'frame' && !frameHitZone(s, p)) continue;
      return s;
    }
  }
  return undefined;
}

/** Tooltip shown while hovering a connect dot. */
const CONNECT_DOT_TITLE = 'ドラッグして矢印を作成';

/** Points (already pushed outward by `offset`) where connect dots sit for a
 * hovered shape: the four edge midpoints for box-ish shapes — which are also
 * exactly the diamond's four vertices, since a diamond's points already sit
 * on those same axes — or the triangle's three vertices, pushed out from its
 * centroid instead since they aren't axis-aligned. */
function connectPoints(s: Shape, offset: number): Pt[] {
  if (s.kind === 'triangle') {
    const verts = triangleVertices(s);
    const cx = (verts[0].x + verts[1].x + verts[2].x) / 3;
    const cy = (verts[0].y + verts[1].y + verts[2].y) / 3;
    return verts.map((v) => {
      const dx = v.x - cx;
      const dy = v.y - cy;
      const len = Math.hypot(dx, dy) || 1;
      return { x: v.x + (dx / len) * offset, y: v.y + (dy / len) * offset };
    });
  }
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  return [
    { x: cx, y: s.y - offset },
    { x: s.x + s.w + offset, y: cy },
    { x: cx, y: s.y + s.h + offset },
    { x: s.x - offset, y: cy },
  ];
}

/** Small round handles shown at a hovered shape's cardinal connect points;
 * dragging one draws a new connector from that shape. Each dot is a bigger
 * invisible hit circle (the actual drag target) under a small visible one,
 * so it stays easy to grab without looking oversized. */
function connectDots(s: Shape) {
  return (
    <>
      {connectPoints(s, CONNECT_DOT_OFFSET).map((p, i) => (
        <g key={i}>
          <circle
            data-handle="connect"
            data-shape={s.id}
            cx={p.x}
            cy={p.y}
            r={10}
            fill="transparent"
            style={{ cursor: 'alias' }}
          >
            <title>{CONNECT_DOT_TITLE}</title>
          </circle>
          <circle
            cx={p.x}
            cy={p.y}
            r={5}
            fill="var(--accent-dim)"
            stroke="var(--bg)"
            strokeWidth={1.5}
            style={{ pointerEvents: 'none' }}
          />
        </g>
      ))}
    </>
  );
}

/** `f` hint-jump badge background/text: reuses the vim-cursor amber so a hint label reads as
 * "a keyboard-reachable cursor target," with a contrasting text color computed the same way
 * flat-filled shape labels are. */
const HINT_BADGE_BG = 'var(--cursor)';
const HINT_BADGE_TEXT = readableTextColor('#ffb454');

/** Renders each still-possible hint label as a small badge over its shape's center. Badges are
 * wrapped in an inverse-scale transform so they stay a constant on-screen size regardless of
 * zoom, the same way the world-space `<g scale(view.scale)>` wrapper would otherwise shrink/grow
 * them with the diagram. */
function hintBadges(hint: { entries: { id: string; label: string; center: Pt }[]; typed: string }, scale: number) {
  const inv = 1 / scale;
  return hint.entries
    .filter((e) => e.label.startsWith(hint.typed))
    .map((e) => {
      const w = e.label.length > 1 ? 24 : 16;
      return (
        <g
          key={e.id}
          transform={`translate(${e.center.x} ${e.center.y}) scale(${inv})`}
          style={{ pointerEvents: 'none' }}
        >
          <rect x={-w / 2} y={-10} width={w} height={20} rx={4} fill={HINT_BADGE_BG} stroke="var(--bg)" strokeWidth={1.5} />
          <text
            x={0}
            y={1}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={12}
            fontWeight={700}
            fontFamily="ui-monospace, Consolas, monospace"
            fill={HINT_BADGE_TEXT}
            style={{ userSelect: 'none' }}
          >
            {e.label.toUpperCase()}
          </text>
        </g>
      );
    });
}

/** Nearest edge/center match (within `threshold`) between the moving rect's left/center/right
 * (or top/center/bottom) and any candidate value; returns the adjusted anchor coordinate. */
function bestAlign(moving: [number, number, number], candidates: number[], threshold: number):
  { value: number; guide: number } | null {
  let best: { value: number; guide: number } | null = null;
  let bestDist = threshold;
  for (const m of moving) {
    for (const c of candidates) {
      const dist = Math.abs(m - c);
      if (dist < bestDist) {
        bestDist = dist;
        best = { value: c - (m - moving[0]), guide: c };
      }
    }
  }
  return best;
}

interface DragState {
  id: string;
  kind: 'move' | 'moveconn' | 'resize' | 'pan' | 'draw' | 'arrowdrag' | 'text' | 'sketch' | 'marquee' | 'endpoint' | 'waypoint';
  /** which end of the connector is being dragged (kind === 'endpoint') */
  end?: 'from' | 'to';
  /** which waypoint index is being dragged (kind === 'waypoint') */
  index?: number;
  /** client px; used for pan deltas and click-vs-drag thresholds */
  startScreen: Pt;
  /** world coords at drag start (move/resize) */
  startWorld: Pt;
  orig: { x: number; y: number; w: number; h: number };
  /** kind === 'resize': +1/-1 per axis, depending on which side of the anchor
   * the handle sits on, so dragging it always grows the shape away from the anchor. */
  resizeSign?: { x: number; y: number };
  moved: boolean;
}

export function Canvas({ state, dispatch }: { state: EditorState; dispatch: Dispatch<Action> }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<DragState | null>(null);
  const space = useRef(false);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [guides, setGuides] = useState<{ vx?: number; hy?: number }>({});
  // Mirrors `space`/pan-drag state into React state purely so the canvas
  // cursor (grab/grabbing) re-renders; the refs stay authoritative for the
  // drag logic itself since that runs per-mousemove and can't afford renders.
  const [spaceDown, setSpaceDown] = useState(false);
  const [isPanning, setIsPanning] = useState(false);

  const { doc, view, cursor, mode, vim } = state;

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === ' ') {
        space.current = true;
        setSpaceDown(true);
        e.preventDefault();
      }
      if (e.key === 'Escape' && drag.current) {
        drag.current = null;
        setIsPanning(false);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        space.current = false;
        setSpaceDown(false);
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const toWorld = (e: { clientX: number; clientY: number }): Pt => {
    const r = svgRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - r.left - view.x) / view.scale,
      y: (e.clientY - r.top - view.y) / view.scale,
    };
  };

  const hitId = (target: EventTarget | null): string | undefined =>
    (target as Element | null)?.closest?.('[data-id]')?.getAttribute('data-id') ?? undefined;

  const hotShape =
    vim && mode === 'normal' ? shapeAt(doc, cursor) : undefined;
  const hotConn =
    vim && mode === 'normal' && !hotShape ? connectorAt(doc, cursor) : undefined;

  const selectedShapeIds = state.selectedIds.filter((id) => findShape(doc, id));
  const selectedBox = selectedShapeIds.length ? bboxOf(doc, selectedShapeIds) : null;
  const hoverShape = hoverId ? findShape(doc, hoverId) : undefined;
  const selectedConnector =
    state.selectedIds.length === 1 ? findConnector(doc, state.selectedIds[0]) : undefined;

  const newDrag = (
    kind: DragState['kind'],
    e: React.MouseEvent,
    id = '',
    orig = { x: 0, y: 0, w: 0, h: 0 },
  ): DragState => ({
    id,
    kind,
    startScreen: { x: e.clientX, y: e.clientY },
    startWorld: toWorld(e),
    orig,
    moved: false,
  });

  const onMouseDown = (e: React.MouseEvent) => {
    if (mode === 'insert') return;
    setHoverId(null);
    // Middle button / space+drag = pan (left drag draws instead).
    if (e.button === 1 || (e.button === 0 && space.current)) {
      e.preventDefault();
      drag.current = newDrag('pan', e);
      setIsPanning(true);
      return;
    }
    if (e.button !== 0) return;
    // Keyboard-initiated draw/arrow pending: mouseup confirms, no drag here.
    if (mode === 'draw' || mode === 'arrow') return;
    // Shift/Ctrl+drag = rubber-band multi-select (shift/ctrl+click toggles on mouseup).
    if (e.shiftKey || e.ctrlKey) {
      drag.current = newDrag('marquee', e);
      dispatch({ type: 'MARQUEE_START', p: toWorld(e) });
      return;
    }

    const id = hitId(e.target);
    const handle = (e.target as Element).getAttribute?.('data-handle');
    const resize = handle === 'resize';
    const endpointEnd: 'from' | 'to' | null =
      handle === 'endpoint-from' ? 'from' : handle === 'endpoint-to' ? 'to' : null;
    const waypointIndex =
      handle === 'waypoint' ? Number((e.target as Element).getAttribute('data-index')) : null;
    const connectShapeId =
      handle === 'connect' ? ((e.target as Element).getAttribute('data-shape') ?? undefined) : undefined;
    const targetId = resize || endpointEnd ? state.selectedIds[0] : id;

    if (connectShapeId && state.tool !== 'select') {
      // Drag started on a hover connection dot: draw a new arrow from this shape.
      drag.current = newDrag('arrowdrag', e);
      dispatch({ type: 'START_ARROW_AT', p: toWorld(e), shapeId: connectShapeId });
      return;
    }
    if (resize && selectedBox && targetId) {
      const shapes = selectedShapeIds.map((sid) => findShape(doc, sid)).filter((s): s is Shape => !!s);
      const anchor = resizeAnchor(shapes, selectedBox);
      const handle = resizeHandlePoint(selectedBox, anchor);
      drag.current = {
        ...newDrag('resize', e, targetId, selectedBox),
        resizeSign: {
          x: handle.x === selectedBox.x + selectedBox.w ? 1 : -1,
          y: handle.y === selectedBox.y + selectedBox.h ? 1 : -1,
        },
      };
      dispatch({ type: 'DRAG_START', id: targetId });
      return;
    }
    if (endpointEnd && targetId) {
      drag.current = { ...newDrag('endpoint', e, targetId), end: endpointEnd };
      dispatch({ type: 'ENDPOINT_DRAG_START', id: targetId, end: endpointEnd });
      return;
    }
    if (waypointIndex !== null && id) {
      drag.current = { ...newDrag('waypoint', e, id), end: undefined, index: waypointIndex };
      dispatch({ type: 'WAYPOINT_DRAG_START', id, index: waypointIndex });
      return;
    }
    if (state.tool === 'arrow') {
      drag.current = newDrag('arrowdrag', e);
      dispatch({ type: 'START_ARROW_AT', p: toWorld(e), shapeId: id });
      return;
    }
    if (state.tool === 'sketch' && !id) {
      // Freehand stroke on empty canvas; auto-detected on mouseup as a shape
      // or line. Dragging an existing shape always moves it instead.
      drag.current = newDrag('sketch', e);
      dispatch({ type: 'SKETCH_START', p: toWorld(e) });
      return;
    }
    if (targetId) {
      const s = findShape(doc, targetId);
      if (s) {
        drag.current = newDrag('move', e, targetId, { x: s.x, y: s.y, w: s.w, h: s.h });
        dispatch({ type: 'DRAG_START', id: targetId });
        return;
      }
      const c = findConnector(doc, targetId);
      if (c) {
        drag.current = newDrag('moveconn', e, targetId);
        dispatch({ type: 'DRAG_START', id: targetId });
        return;
      }
      return;
    }
    if (state.tool === 'text') {
      drag.current = newDrag('text', e);
      return;
    }
    // Empty canvas: rubber-band draw with the active tool.
    if (
      state.tool === 'rect' ||
      state.tool === 'ellipse' ||
      state.tool === 'diamond' ||
      state.tool === 'triangle' ||
      state.tool === 'frame'
    ) {
      drag.current = newDrag('draw', e);
      dispatch({ type: 'START_DRAW_AT', kind: state.tool, p: toWorld(e) });
    }
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const d = drag.current;
    if (!d && mode === 'normal') {
      const near = shapeNear(doc, toWorld(e), HOVER_MARGIN);
      setHoverId(near?.id ?? null);
    }
    if (mode === 'draw' || mode === 'arrow') {
      if (d && !d.moved) {
        const dist = Math.hypot(e.clientX - d.startScreen.x, e.clientY - d.startScreen.y);
        if (dist >= 5) d.moved = true;
      }
      dispatch({ type: 'MOUSE_CURSOR', p: toWorld(e) });
      return;
    }
    if (!d) return;
    if (d.kind === 'pan') {
      const dx = e.clientX - d.startScreen.x;
      const dy = e.clientY - d.startScreen.y;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      d.startScreen = { x: e.clientX, y: e.clientY };
      dispatch({ type: 'PAN', dx, dy });
      return;
    }
    if (d.kind === 'text') {
      if (Math.hypot(e.clientX - d.startScreen.x, e.clientY - d.startScreen.y) >= 5) d.moved = true;
      return;
    }
    if (d.kind === 'sketch') {
      if (Math.hypot(e.clientX - d.startScreen.x, e.clientY - d.startScreen.y) >= 5) d.moved = true;
      dispatch({ type: 'SKETCH_POINT', p: toWorld(e) });
      return;
    }
    if (d.kind === 'marquee') {
      if (Math.hypot(e.clientX - d.startScreen.x, e.clientY - d.startScreen.y) >= 4) d.moved = true;
      dispatch({ type: 'MARQUEE_MOVE', p: toWorld(e) });
      return;
    }
    if (d.kind === 'endpoint') {
      d.moved = true;
      dispatch({ type: 'ENDPOINT_DRAG_MOVE', id: d.id, end: d.end as 'from' | 'to', p: toWorld(e) });
      return;
    }
    if (d.kind === 'waypoint') {
      d.moved = true;
      dispatch({ type: 'WAYPOINT_DRAG_MOVE', id: d.id, index: d.index as number, p: toWorld(e) });
      return;
    }
    const world = toWorld(e);
    const dx = world.x - d.startWorld.x;
    const dy = world.y - d.startWorld.y;
    if (!d.moved && Math.hypot(dx * view.scale, dy * view.scale) < 4) return;
    d.moved = true;
    if (d.kind === 'move') {
      const rect = { x: d.orig.x + dx, y: d.orig.y + dy, w: d.orig.w, h: d.orig.h };
      const excludeIds = new Set(state.selectedIds.length ? state.selectedIds : [d.id]);
      const others = doc.shapes.filter((s) => !excludeIds.has(s.id));
      const threshold = 6 / view.scale;
      const alignX = bestAlign(
        [rect.x, rect.x + rect.w / 2, rect.x + rect.w],
        others.flatMap((s) => [s.x, s.x + s.w / 2, s.x + s.w]),
        threshold,
      );
      const alignY = bestAlign(
        [rect.y, rect.y + rect.h / 2, rect.y + rect.h],
        others.flatMap((s) => [s.y, s.y + s.h / 2, s.y + s.h]),
        threshold,
      );
      setGuides({ vx: alignX?.guide, hy: alignY?.guide });
      dispatch({
        type: 'DRAG_MOVE',
        id: d.id,
        to: { x: alignX ? alignX.value : snap(rect.x), y: alignY ? alignY.value : snap(rect.y) },
      });
    } else if (d.kind === 'resize') {
      const sign = d.resizeSign ?? { x: 1, y: 1 };
      dispatch({ type: 'DRAG_RESIZE', w: d.orig.w + sign.x * dx, h: d.orig.h + sign.y * dy });
    } else if (d.kind === 'moveconn') {
      dispatch({ type: 'CONNECTOR_DRAG_MOVE', id: d.id, dx, dy });
    }
  };

  const onMouseUp = (e: React.MouseEvent) => {
    const d = drag.current;
    drag.current = null;
    setGuides({});
    if (isPanning) setIsPanning(false);
    // Right/middle-button releases with no active drag (e.g. a context-menu right-click)
    // must not fall through to the plain-click handling below, or they'd collapse
    // the current multi-selection to just the clicked item before the menu opens.
    if (!d && e.button !== 0) return;
    if (d) {
      switch (d.kind) {
        case 'draw':
        case 'arrowdrag':
          if (d.moved) {
            dispatch({ type: 'CLICK', p: toWorld(e), id: hitId(e.target) });
          } else {
            // Simple click: cancel the pending draw, treat as select/deselect.
            dispatch({ type: 'CANCEL' });
            dispatch({ type: 'CLICK', p: toWorld(e), id: hitId(e.target) });
          }
          return;
        case 'text':
          if (!d.moved) dispatch({ type: 'TEXT_AT', p: toWorld(e) });
          return;
        case 'sketch':
          if (d.moved) {
            dispatch({ type: 'SKETCH_END' });
          } else {
            dispatch({ type: 'SKETCH_CANCEL' });
            dispatch({ type: 'CLICK', p: toWorld(e), id: hitId(e.target) });
          }
          return;
        case 'marquee':
          if (d.moved) {
            dispatch({ type: 'MARQUEE_END' });
          } else {
            // Shift/Ctrl+click without drag: toggle the item in the selection.
            dispatch({ type: 'MARQUEE_CANCEL' });
            dispatch({ type: 'CLICK', p: toWorld(e), id: hitId(e.target), shift: true });
          }
          return;
        case 'move':
        case 'resize':
        case 'moveconn':
          dispatch({ type: 'DRAG_END' });
          if (!d.moved) dispatch({ type: 'CLICK', p: toWorld(e), id: d.id });
          return;
        case 'endpoint':
        case 'waypoint':
          dispatch({ type: 'DRAG_END' });
          return;
        case 'pan':
          if (!d.moved) dispatch({ type: 'CLICK', p: toWorld(e), id: hitId(e.target) });
          return;
      }
    }
    // Keyboard-initiated draw/arrow: click confirms.
    if (mode === 'draw' || mode === 'arrow') {
      dispatch({ type: 'CLICK', p: toWorld(e), id: hitId(e.target) });
      return;
    }
    dispatch({ type: 'CLICK', p: toWorld(e), id: hitId(e.target) });
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (mode !== 'normal') return;
    dispatch({ type: 'DBL_CLICK', p: toWorld(e), id: hitId(e.target) });
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (mode !== 'normal') return;
    dispatch({
      type: 'CONTEXT_MENU_OPEN',
      screen: { x: e.clientX, y: e.clientY },
      world: toWorld(e),
      id: hitId(e.target),
    });
  };

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey) {
      const r = svgRef.current!.getBoundingClientRect();
      dispatch({
        type: 'ZOOM',
        factor: e.deltaY < 0 ? 1.1 : 1 / 1.1,
        center: { x: e.clientX - r.left, y: e.clientY - r.top },
      });
    } else if (e.shiftKey) {
      dispatch({ type: 'PAN', dx: -e.deltaY, dy: 0 });
    } else {
      dispatch({ type: 'PAN', dx: -e.deltaX, dy: -e.deltaY });
    }
  };

  const drawPreview = () => {
    if (mode === 'draw' && state.draw) {
      const a = state.draw.anchor;
      const x = Math.min(a.x, cursor.x);
      const y = Math.min(a.y, cursor.y);
      const w = Math.max(Math.abs(cursor.x - a.x), GRID);
      const h = Math.max(Math.abs(cursor.y - a.y), GRID);
      const common = {
        fill: 'none',
        stroke: 'var(--accent)',
        strokeDasharray: '6 4',
        strokeWidth: 1.5,
      };
      if (state.draw.kind === 'rect') {
        return <rect x={x} y={y} width={w} height={h} rx={4} {...common} />;
      }
      if (state.draw.kind === 'diamond') {
        const cx = x + w / 2;
        const cy = y + h / 2;
        return <polygon points={`${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}`} {...common} />;
      }
      if (state.draw.kind === 'triangle') {
        return <polygon points={trianglePoints({ x, y, w, h, direction: 'up' })} {...common} />;
      }
      if (state.draw.kind === 'frame') {
        return <rect x={x} y={y} width={w} height={h} rx={8} {...common} />;
      }
      return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />;
    }
    if (mode === 'arrow' && state.arrowFrom) {
      const from = resolveEndpoint(doc, state.arrowFrom);
      const a = from.shape ? from.p : { x: state.arrowFrom.x, y: state.arrowFrom.y };
      return (
        <line
          x1={a.x}
          y1={a.y}
          x2={cursor.x}
          y2={cursor.y}
          stroke="var(--accent)"
          strokeDasharray="6 4"
          strokeWidth={1.5}
          markerEnd="url(#arrow-accent)"
        />
      );
    }
    return null;
  };

  const connView = (c: Connector) => {
    const path = connectorPath(doc, c);
    const points = path.map((p) => `${p.x},${p.y}`).join(' ');
    const labelPos = connectorLabelPos(doc, c);
    const selected = state.selectedIds.includes(c.id);
    const hot = hotConn?.id === c.id;
    // The connector's own color always stays visible; selection/hot is a
    // translucent halo drawn underneath instead of overriding the color
    // (otherwise the color you just picked is hidden while still selected).
    const trueStroke = c.color ?? 'var(--shape-stroke)';
    const marker = c.color ? `url(#arrow-${markerKey(c.color)})` : 'url(#arrow)';
    const arrowDir = c.arrowDirection ?? 'end';
    const showEndArrow = arrowDir === 'end' || arrowDir === 'both';
    const showStartArrow = arrowDir === 'start' || arrowDir === 'both';
    const haloColor = selected ? 'var(--accent)' : hot ? 'var(--accent-dim)' : undefined;
    // Same reasoning as the shape body: with the arrow tool active, dragging
    // the connector's body starts a fresh arrow from that point rather than
    // moving the connector, so it gets the same "creating" cursor.
    const bodyCursor = state.tool === 'arrow' ? 'crosshair' : 'move';
    return (
      <g key={c.id} data-id={c.id}>
        <polyline
          points={points}
          fill="none"
          stroke="transparent"
          strokeWidth={12}
          style={{ cursor: bodyCursor }}
        />
        {haloColor && (
          <polyline
            points={points}
            fill="none"
            stroke={haloColor}
            strokeWidth={selected ? 6 : 5}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.5}
          />
        )}
        <polyline
          points={points}
          fill="none"
          stroke={trueStroke}
          strokeWidth={selected ? 2 : 1.5}
          strokeLinejoin="round"
          strokeDasharray={c.dashed ? '6 4' : undefined}
          markerStart={showStartArrow ? marker : undefined}
          markerEnd={showEndArrow ? marker : undefined}
        />
        {selected &&
          c.waypoints?.map((wp, i) => (
            <circle
              key={i}
              data-handle="waypoint"
              data-index={i}
              cx={wp.x}
              cy={wp.y}
              r={5}
              fill="var(--bg)"
              stroke="var(--accent)"
              strokeWidth={1.5}
              style={{ cursor: 'move' }}
            />
          ))}
        <Label
          label={c.label}
          cx={labelPos.x}
          cy={labelPos.y - 12}
          color={c.color ?? 'var(--muted)'}
          fontSize={c.fontSize}
        />
      </g>
    );
  };

  const connectorColors = useMemo(
    () => Array.from(new Set(doc.connectors.map((c) => c.color).filter((v): v is string => !!v))),
    [doc.connectors],
  );

  const isEmpty = doc.shapes.length === 0 && doc.connectors.length === 0;

  // Fallback cursor for the canvas background (empty grid area); shapes,
  // connectors, and handles set their own more specific cursor that wins
  // wherever they're actually hovered.
  const creationTool =
    state.tool === 'rect' ||
    state.tool === 'ellipse' ||
    state.tool === 'diamond' ||
    state.tool === 'triangle' ||
    state.tool === 'frame' ||
    state.tool === 'arrow' ||
    state.tool === 'sketch';
  const bgCursor = isPanning
    ? 'grabbing'
    : drag.current?.kind === 'marquee'
      ? 'crosshair'
      : spaceDown
        ? 'grab'
        : mode === 'draw' || mode === 'arrow' || creationTool
          ? 'crosshair'
          : state.tool === 'text'
            ? 'text'
            : 'default';

  return (
    <>
    {isEmpty && mode === 'normal' && (
      <div className="canvas-hint">
        ドラッグで手描き → 図形を自動認識(✏ Auto)
        <br />
        ダブルクリックで四角を作成、または r / e / t キー
      </div>
    )}
    <svg
      ref={svgRef}
      className="canvas"
      style={{ cursor: bgCursor }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onDoubleClick={onDoubleClick}
      onWheel={onWheel}
      onContextMenu={onContextMenu}
      onMouseLeave={() => setHoverId(null)}
    >
      <defs>
        <pattern id="grid" width={GRID} height={GRID} patternUnits="userSpaceOnUse">
          <circle cx={1} cy={1} r={1} fill="var(--grid-dot)" />
        </pattern>
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="8"
          markerHeight="8"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--shape-stroke)" />
        </marker>
        <marker
          id="arrow-accent"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="8"
          markerHeight="8"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
        </marker>
        {connectorColors.map((hex) => (
          <marker
            key={hex}
            id={`arrow-${markerKey(hex)}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={hex} />
          </marker>
        ))}
      </defs>
      <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
        <rect x={-50000} y={-50000} width={100000} height={100000} fill="url(#grid)" />
        {doc.connectors.map(connView)}
        {doc.shapes.map((s) => (
          <ShapeView
            key={s.id}
            s={s}
            selected={state.selectedIds.includes(s.id)}
            hot={hotShape?.id === s.id}
            tool={state.tool}
          />
        ))}
        {hoverShape &&
          mode === 'normal' &&
          !drag.current &&
          state.tool !== 'select' &&
          connectDots(hoverShape)}
        {mode === 'hint' && state.hint && hintBadges(state.hint, view.scale)}
        {selectedBox && mode === 'normal' && (() => {
          const shapes = selectedShapeIds.map((sid) => findShape(doc, sid)).filter((s): s is Shape => !!s);
          const anchor = resizeAnchor(shapes, selectedBox);
          const handle = resizeHandlePoint(selectedBox, anchor);
          const onRight = handle.x === selectedBox.x + selectedBox.w;
          const onBottom = handle.y === selectedBox.y + selectedBox.h;
          const cursor = onRight === onBottom ? 'nwse-resize' : 'nesw-resize';
          return (
            <rect
              data-handle="resize"
              x={handle.x - 5}
              y={handle.y - 5}
              width={10}
              height={10}
              fill="var(--accent)"
              style={{ cursor }}
            />
          );
        })()}
        {guides.vx !== undefined && (
          <line x1={guides.vx} y1={-50000} x2={guides.vx} y2={50000} stroke="var(--accent)" strokeWidth={1} strokeDasharray="3 3" style={{ pointerEvents: 'none' }} />
        )}
        {guides.hy !== undefined && (
          <line x1={-50000} y1={guides.hy} x2={50000} y2={guides.hy} stroke="var(--accent)" strokeWidth={1} strokeDasharray="3 3" style={{ pointerEvents: 'none' }} />
        )}
        {selectedConnector && mode === 'normal' && (() => {
          const path = connectorPath(doc, selectedConnector);
          const a = path[0];
          const b = path[path.length - 1];
          return (
            <>
              <circle
                data-handle="endpoint-from"
                cx={a.x}
                cy={a.y}
                r={6}
                fill="var(--accent)"
                stroke="var(--bg)"
                strokeWidth={1.5}
                style={{ cursor: 'crosshair' }}
              />
              <circle
                data-handle="endpoint-to"
                cx={b.x}
                cy={b.y}
                r={6}
                fill="var(--accent)"
                stroke="var(--bg)"
                strokeWidth={1.5}
                style={{ cursor: 'crosshair' }}
              />
            </>
          );
        })()}
        {drawPreview()}
        {state.marquee && (
          <rect
            x={Math.min(state.marquee.a.x, state.marquee.b.x)}
            y={Math.min(state.marquee.a.y, state.marquee.b.y)}
            width={Math.abs(state.marquee.b.x - state.marquee.a.x)}
            height={Math.abs(state.marquee.b.y - state.marquee.a.y)}
            fill="var(--accent)"
            fillOpacity={0.08}
            stroke="var(--accent)"
            strokeDasharray="4 3"
            strokeWidth={1}
            style={{ pointerEvents: 'none' }}
          />
        )}
        {state.sketch && state.sketch.length > 1 && (
          <polyline
            points={state.sketch.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ pointerEvents: 'none' }}
          />
        )}
        {vim && mode !== 'insert' && (
          <g style={{ pointerEvents: 'none' }}>
            <line
              x1={cursor.x - 7}
              y1={cursor.y}
              x2={cursor.x + 7}
              y2={cursor.y}
              stroke="var(--cursor)"
              strokeWidth={2}
            />
            <line
              x1={cursor.x}
              y1={cursor.y - 7}
              x2={cursor.x}
              y2={cursor.y + 7}
              stroke="var(--cursor)"
              strokeWidth={2}
            />
          </g>
        )}
      </g>
    </svg>
    </>
  );
}
