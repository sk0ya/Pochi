import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch } from 'react';
import {
  bboxOf,
  connectorAt,
  connectorElbowHandle,
  connectorLabelPos,
  connectorPath,
  edgeResizeHandles,
  findConnector,
  findShape,
  FRAME_BORDER_BAND,
  FRAME_LABEL_PAD_X,
  FRAME_LABEL_PAD_Y,
  FRAME_LABEL_ZONE_H,
  FRAME_LABEL_ZONE_W,
  frameBorderOrLabel,
  freedrawPathD,
  isSelfLoop,
  labelCenter,
  resizeAnchor,
  resizeHandlePoint,
  resolveEndpoint,
  shapeAt,
  triangleVertices,
} from '../model/doc';
import { fillTint, FLAT_FILL_DEFAULT, readableTextColor } from '../model/palette';
import { decodeIconDrag, fetchIconDataUrl, ICON_DRAG_MIME, iconAttributionTooltip } from '../model/icons';
import { TEMPLATE_DRAG_MIME } from '../model/templates';
import type { Connector, FontSize, Pt, Shape } from '../model/types';
import { FONT_LINE_H, FONT_SIZE_PX, GRID, snap, STROKE_WIDTH_BASE } from '../model/types';
import type { Action, EditorState } from '../state/reducer';

/** Turn a hex color into a safe DOM id fragment for a per-color arrow marker. */
const markerKey = (hex: string): string => hex.replace('#', '');

/** Opacity for a filled frame's interior tint in the (dark) app canvas. Low enough to read as
 * a subtle zone wash rather than a solid fill — a filled frame must still look unmistakably
 * different from a filled rect/ellipse/etc, which uses a fully opaque background. Kept
 * separate from the SVG export's opacity (model/svg.ts FRAME_TINT_OPACITY_SVG) since a
 * white light-theme background reads the same alpha as noticeably lighter than a dark one. */
export const FRAME_TINT_OPACITY_APP = 0.16;

function Label({
  label,
  cx,
  cy,
  color,
  fontSize,
  anchor = 'middle',
}: {
  label: string;
  cx: number;
  cy: number;
  color?: string;
  fontSize?: FontSize;
  anchor?: 'middle' | 'start';
}) {
  if (!label) return null;
  const lineH = FONT_LINE_H[fontSize ?? 'm'];
  const lines = label.split('\n');
  const startY = cy - ((lines.length - 1) * lineH) / 2;
  return (
    <text
      fill={color ?? 'var(--shape-text)'}
      fontSize={FONT_SIZE_PX[fontSize ?? 'm']}
      textAnchor={anchor}
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

/** An outline tracing a shape's silhouette, standing `pad` off it. Shared by the selection/hot
 * halo and the green "this is what the arrow will connect to" ring, so the two can never drift
 * apart on how a diamond or triangle is outlined. `strokeBase` is only consulted for freedraw,
 * which has no silhouette to offset: its own stroke is traced, thickened by `pad` per side. */
function ShapeOutline({
  s,
  pad,
  color,
  width,
  opacity = 0.6,
  strokeBase,
}: {
  s: Shape;
  pad: number;
  color: string;
  width: number;
  opacity?: number;
  strokeBase: number;
}) {
  if (s.kind === 'freedraw') {
    return (
      <path
        d={freedrawPathD(s)}
        fill="none"
        stroke={color}
        strokeWidth={strokeBase + pad * 2}
        opacity={opacity}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  }
  const common = { fill: 'none', stroke: color, strokeWidth: width, opacity };
  if (s.kind === 'ellipse') {
    return (
      <ellipse
        cx={s.x + s.w / 2}
        cy={s.y + s.h / 2}
        rx={s.w / 2 + pad}
        ry={s.h / 2 + pad}
        {...common}
      />
    );
  }
  if (s.kind === 'diamond') return <polygon points={diamondPoints(s, pad)} {...common} />;
  if (s.kind === 'triangle') return <polygon points={trianglePoints(s, pad)} {...common} />;
  return (
    <rect
      x={s.x - pad}
      y={s.y - pad}
      width={s.w + pad * 2}
      height={s.h + pad * 2}
      rx={s.kind === 'frame' ? 10 : 6}
      {...common}
    />
  );
}

function ShapeView({
  s,
  selected,
  hot,
  tool,
  inv,
}: {
  s: Shape;
  selected: boolean;
  hot: boolean;
  tool: string;
  inv: number;
}) {
  // The shape's own color always stays visible; selection/hot is shown as a
  // halo around it instead of overriding the stroke (otherwise you can't see
  // the color you just picked while the item is still selected).
  // A frame defaults to a subdued stroke (not the brighter shape-stroke every other
  // kind uses) so it reads as a quiet container rather than another shape.
  const trueStroke = s.color ?? (s.kind === 'frame' ? 'var(--muted)' : 'var(--shape-stroke)');
  const strokeBase = STROKE_WIDTH_BASE[s.strokeWidth ?? 'm'];
  // Flat-fill ("ベタ塗り") style trades the tinted fill + stroke for a solid
  // background and no stroke, like a sticky note.
  const common = s.filled
    ? { fill: s.color ?? FLAT_FILL_DEFAULT, stroke: 'none', strokeWidth: 0 }
    : {
        fill: s.color ? fillTint(s.color) : 'var(--shape-fill)',
        stroke: trueStroke,
        strokeWidth: selected ? strokeBase + 0.5 : strokeBase,
        strokeDasharray: s.dashed ? '6 4' : undefined,
      };
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  const labelPos = labelCenter(s);
  const haloColor = selected ? 'var(--accent)' : hot ? 'var(--accent-dim)' : undefined;
  // The halo is selection *feedback*, not part of the drawing, so its ring keeps a constant
  // on-screen thickness and stand-off (see the screen-pixel note above `CONNECT_DOT_OFFSET`) —
  // otherwise it thins to nothing when zoomed out and swells into a blob when zoomed in.
  const haloPad = 3 * inv;
  // With the arrow tool active, dragging the shape body starts a new arrow
  // from it instead of moving it (see onMouseDown), so the dot-matching
  // "alias" cursor is the honest affordance here, not "move".
  const bodyCursor = tool === 'arrow' ? 'alias' : 'move';
  return (
    <g data-id={s.id} style={{ cursor: bodyCursor }}>
      {s.iconAttribution && <title>{iconAttributionTooltip(s.iconAttribution)}</title>}
      {/* A text shape is excluded: its own dashed outline below already switches to the halo
          colour, so a second ring around it would just read as a double border. */}
      {haloColor && s.kind !== 'text' && (
        <ShapeOutline
          s={s}
          pad={haloPad}
          color={haloColor}
          width={(selected ? 3 : 2) * inv}
          strokeBase={strokeBase}
        />
      )}
      {s.kind === 'rect' && <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={4} {...common} />}
      {s.kind === 'ellipse' && <ellipse cx={cx} cy={cy} rx={s.w / 2} ry={s.h / 2} {...common} />}
      {/* A freedraw stroke is an open line: never filled, so the `filled` flag and the
          tinted fill are ignored — only the stroke color applies. */}
      {s.kind === 'freedraw' && (
        <>
          {/* Wide invisible stroke so the (thin) visible line is a realistic click target —
              without it, selecting a pen stroke means hitting its ~2px path exactly, since
              a `fill="none"` open path hit-tests on its stroke alone. Same trick, and the
              same screen-constant width, as a connector's hit band. A `transparent` stroke
              still takes pointer events; only `none` would opt out. */}
          <path
            d={freedrawPathD(s)}
            fill="none"
            stroke="transparent"
            strokeWidth={strokeBase + 12 * inv}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d={freedrawPathD(s)}
            fill="none"
            stroke={trueStroke}
            strokeWidth={selected ? strokeBase + 0.5 : strokeBase}
            strokeDasharray={s.dashed ? '6 4' : undefined}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ pointerEvents: 'none' }}
          />
        </>
      )}
      {s.kind === 'diamond' && <polygon points={diamondPoints(s)} {...common} />}
      {s.kind === 'triangle' && <polygon points={trianglePoints(s)} {...common} />}
      {s.kind === 'frame' && (
        <>
          {/* Optional interior tint (the "filled" flag) — a flat, low-opacity fill so the
              frame reads as a zone at a glance. pointer-events: none keeps it purely visual;
              the frame's click-through interior (frameHitZone in model/doc.ts) is unaffected
              by paint, so this never steals a click meant for what's inside. */}
          {s.filled && (
            <rect
              x={s.x + 1.5}
              y={s.y + 1.5}
              width={Math.max(s.w - 3, 0)}
              height={Math.max(s.h - 3, 0)}
              rx={7}
              fill={trueStroke}
              fillOpacity={FRAME_TINT_OPACITY_APP}
              stroke="none"
              style={{ pointerEvents: 'none' }}
            />
          )}
          {/* Visible border, no fill of its own — the interior tint above (if any) is a
              separate pointer-events:none layer, so this rect staying unfilled keeps the
              border itself from ever hit-testing over whatever the frame contains. Slightly
              rounded to read as distinct from a plain rect at a glance. */}
          <rect
            x={s.x}
            y={s.y}
            width={s.w}
            height={s.h}
            rx={8}
            fill="none"
            stroke={trueStroke}
            strokeWidth={selected ? strokeBase + 0.5 : strokeBase}
            strokeDasharray={s.dashed ? '6 4' : undefined}
            style={{ pointerEvents: 'none' }}
          />
          {/* Wide invisible stroke so the (thin) visible border is still an easy
              click/drag target — this is the frame's whole "hit zone" for its edges,
              matching frameHitZone in model/doc.ts, which the hover path calls with this
              same screen-constant band. */}
          <rect
            x={s.x}
            y={s.y}
            width={s.w}
            height={s.h}
            fill="none"
            stroke="transparent"
            strokeWidth={FRAME_BORDER_BAND * inv * 2}
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
      {/* A text shape has no body of its own: this dashed outline is purely the "empty text
          box" / selection affordance, so it stays screen-constant like the halo above. */}
      {s.kind === 'text' && (
        <rect
          x={s.x}
          y={s.y}
          width={s.w}
          height={s.h}
          fill="transparent"
          stroke={haloColor ?? (s.label ? 'transparent' : trueStroke)}
          strokeDasharray={dash(4, 3, inv)}
          strokeWidth={(haloColor ? 1.5 : 1) * inv}
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

/* Every measurement below is in *screen* pixels, not world units: handles and hit areas are
 * things the pointer aims at, so they have to stay the same physical size whatever the zoom.
 * Since they're drawn inside the world-space `<g scale(view.scale)>`, each one is multiplied
 * by `inv` (= 1 / view.scale) at use — the same inverse-scale trick hintBadges uses. Left in
 * world units they'd shrink to a couple of pixels at 20% zoom (unclickable) and bloat to
 * several times their intended size at 400% (stealing clicks from the shape underneath). */

/** How far outside the shape's edge each connect dot floats — past both the
 * shape's own move-drag hit area and the edge resize handles, which sit
 * right on the border, so the two don't compete for the same click. */
const CONNECT_DOT_OFFSET = 18;
/** Margin around a shape (beyond its bounds) that still counts as "hovering"
 * it, so the pointer can travel from the shape out to the connect dots
 * without the hover state dropping in between. Must exceed CONNECT_DOT_OFFSET. */
const HOVER_MARGIN = 26;
/** Half-length of the vim cursor's crosshair arms. */
const CURSOR_ARM = 7;

/* Double-click is recognised from our own two consecutive clicks, not from the DOM's
 * `dblclick` event alone — that event doesn't reliably arrive. The canvas re-renders on the
 * first click (selection outline, resize handles, connect dots appear right under the
 * cursor), and when the second press lands on one of those freshly-mounted elements the
 * browser no longer sees two clicks on the same node, so it dispatches no `dblclick` at all
 * and label editing is simply unreachable by mouse. Windows' own double-click defaults:
 * 500ms, and a slop box a few pixels wide so a hand that drifts still counts. */
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_PX = 6;

/** A dash pattern for transient UI chrome (marquee, snap guides, draw preview), converted to
 * world units so the dashes read the same at any zoom instead of merging into a solid line
 * when zoomed out. Shape/connector dash patterns are deliberately *not* run through this:
 * those belong to the drawing and scale with it, and the SVG export reproduces them verbatim. */
const dash = (on: number, off: number, inv: number): string => `${on * inv} ${off * inv}`;

/** Topmost shape whose bounds, expanded by `margin`, contain `p`. A frame's open interior
 * doesn't count (same reasoning as frameHitZone) — hovering a shape a frame contains must
 * not have the frame steal the hover state (and its connect dots) instead. Unlike frameHitZone,
 * which caps the outside reach at the border band, a frame stays hovered anywhere within `margin`
 * of its border (frameBorderOrLabel has no outer cap) so the pointer can reach the frame's own
 * connect dots, which float CONNECT_DOT_OFFSET (> band) outside the edge. */
function shapeNear(doc: { shapes: Shape[] }, p: Pt, margin: number, band: number): Shape | undefined {
  for (let i = doc.shapes.length - 1; i >= 0; i--) {
    const s = doc.shapes[i];
    if (p.x >= s.x - margin && p.x <= s.x + s.w + margin && p.y >= s.y - margin && p.y <= s.y + s.h + margin) {
      if (s.kind === 'frame' && !frameBorderOrLabel(s, p, band)) continue;
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
  // `offset` arrives already converted to world units (see connectDots).
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
 * so it stays easy to grab without looking oversized.
 *
 * They deliberately look nothing like the resize handles they sit next to:
 * green (--connect, not the blue --accent) and drawn as a ring rather than a
 * filled square, so "drag to connect" and "drag to resize" stay tellable apart
 * by both color and shape. */
function connectDots(s: Shape, inv: number) {
  return (
    <>
      {connectPoints(s, CONNECT_DOT_OFFSET * inv).map((p, i) => (
        <g key={i}>
          <circle
            data-handle="connect"
            data-shape={s.id}
            cx={p.x}
            cy={p.y}
            r={10 * inv}
            fill="transparent"
            style={{ cursor: 'alias' }}
          >
            <title>{CONNECT_DOT_TITLE}</title>
          </circle>
          <circle
            cx={p.x}
            cy={p.y}
            r={5.5 * inv}
            fill="var(--connect)"
            stroke="var(--bg)"
            strokeWidth={1.5 * inv}
            style={{ pointerEvents: 'none' }}
          />
          <circle cx={p.x} cy={p.y} r={2 * inv} fill="var(--bg)" style={{ pointerEvents: 'none' }} />
        </g>
      ))}
    </>
  );
}

const ENDPOINT_FIXED_TITLE = '辺に固定 — 図形の内側までドラッグすると自動に戻る';
const ENDPOINT_FLOATING_TITLE = '自動接続 — 辺までドラッグするとその位置に固定';

/** Handle for re-attaching one end of the selected connector. Green like the connect dots:
 * these belong to the "connect" family, not the blue resize one.
 *
 * A *fixed* end (pinned to a point on the shape's border) is a solid disc; a *floating* one —
 * which only aims at the shape and slides around its border — is a ring, the same hollow
 * shape the connect dots use, since both mean "not committed to a spot yet". */
function endpointHandle(handle: string, p: Pt, fixed: boolean, inv: number) {
  return (
    <g>
      <circle
        data-handle={handle}
        cx={p.x}
        cy={p.y}
        r={6 * inv}
        fill="var(--connect)"
        stroke="var(--bg)"
        strokeWidth={1.5 * inv}
        style={{ cursor: 'crosshair' }}
      >
        <title>{fixed ? ENDPOINT_FIXED_TITLE : ENDPOINT_FLOATING_TITLE}</title>
      </circle>
      {!fixed && (
        <circle cx={p.x} cy={p.y} r={2 * inv} fill="var(--bg)" style={{ pointerEvents: 'none' }} />
      )}
    </g>
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
  kind: 'move' | 'moveconn' | 'resize' | 'pan' | 'draw' | 'arrowdrag' | 'text' | 'sketch' | 'marquee' | 'endpoint' | 'waypoint' | 'elbow';
  /** which end of the connector is being dragged (kind === 'endpoint') */
  end?: 'from' | 'to';
  /** which waypoint index is being dragged (kind === 'waypoint') */
  index?: number;
  /** client px; used for pan deltas and click-vs-drag thresholds */
  startScreen: Pt;
  /** world coords at drag start (move/resize) */
  startWorld: Pt;
  orig: { x: number; y: number; w: number; h: number };
  /** kind === 'resize': +1/-1/0 per axis, depending on which side of the anchor
   * the handle sits on (0 for an edge handle's untouched axis), so dragging it
   * always grows the shape away from the anchor. */
  resizeSign?: { x: number; y: number };
  /** kind === 'resize': the world-space point that stays fixed while resizing —
   * the corner handle's shape-aware anchor, or an edge handle's opposite edge. */
  resizeAnchorPt?: Pt;
  moved: boolean;
  /** kind === 'marquee': whether it started as a shift/ctrl+drag, so a click-without-move
   * on mouseup should toggle the hit item (per shift-click semantics) rather than clear
   * the selection like a plain click. */
  marqueeShift?: boolean;
}

/** Minimal shape of a mousedown event that {@link Canvas}'s pointer-down handler
 * needs — lets a swallowed mousedown be replayed from saved primitives once the
 * text editor's blur actually lands (see `pendingInsertMouseDown` below). */
type PointerDownInfo = Pick<
  React.MouseEvent,
  'clientX' | 'clientY' | 'button' | 'shiftKey' | 'ctrlKey' | 'target' | 'preventDefault'
>;

/* The move/up halves of a gesture are handled on `window`, not the svg (see the effect in
 * {@link Canvas}), so they see a native MouseEvent as often as a React one. Both satisfy
 * these structural types — only the few fields actually read are required. */
interface DragMoveInfo {
  clientX: number;
  clientY: number;
}
interface DragUpInfo extends DragMoveInfo {
  button: number;
  target: EventTarget | null;
}

export function Canvas({
  state,
  dispatch,
  svgRef,
}: {
  state: EditorState;
  dispatch: Dispatch<Action>;
  /** Owned by App so the zoom/centre commands outside the canvas (Fit, the zoom-reset button,
   * `z`, `+`/`-`) can measure the canvas's real on-screen box rather than the window's. */
  svgRef: React.RefObject<SVGSVGElement | null>;
}) {
  const drag = useRef<DragState | null>(null);
  const space = useRef(false);
  // A mousedown that arrived while a text editor's textarea was still focused: the
  // textarea's onBlur (which commits the edit and flips mode back to 'normal') only
  // fires *after* this handler already returned, so `mode` here is one render stale
  // and the gesture would otherwise be silently dropped. Stashed here and replayed
  // once mode actually leaves 'insert' (see the effect below), so the same
  // mousedown-drag that dismisses the editor can also start drawing/selecting.
  const pendingInsertMouseDown = useRef<PointerDownInfo | null>(null);
  // Where and when the last plain click landed, for the double-click detection in
  // `clickAt` below (see DOUBLE_CLICK_MS).
  const lastClick = useRef<{ t: number; x: number; y: number } | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [guides, setGuides] = useState<{ vx?: number; hy?: number }>({});
  // Mirrors `space`/pan-drag state into React state purely so the canvas
  // cursor (grab/grabbing) re-renders; the refs stay authoritative for the
  // drag logic itself since that runs per-mousemove and can't afford renders.
  const [spaceDown, setSpaceDown] = useState(false);
  const [isPanning, setIsPanning] = useState(false);

  const { doc, view, cursor, mode, vim } = state;
  /** World units per screen pixel — the factor that keeps handles and hit areas a constant
   * on-screen size inside the world-space `<g scale(view.scale)>`. */
  const inv = 1 / view.scale;

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

  /* Drop target for the two independent insert panels. Unknown/OS drags are deliberately
   * ignored, so they keep the browser's "no drop" cursor rather than being swallowed. */
  const onDragOver = (e: React.DragEvent<SVGSVGElement>) => {
    if (
      !e.dataTransfer.types.includes(TEMPLATE_DRAG_MIME) &&
      !e.dataTransfer.types.includes(ICON_DRAG_MIME)
    ) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (e: React.DragEvent<SVGSVGElement>) => {
    const templateId = e.dataTransfer.getData(TEMPLATE_DRAG_MIME);
    if (templateId) {
      e.preventDefault();
      dispatch({ type: 'INSERT_TEMPLATE', templateId, at: toWorld(e) });
      return;
    }
    const icon = decodeIconDrag(e.dataTransfer.getData(ICON_DRAG_MIME));
    if (icon) {
      e.preventDefault();
      const at = toWorld(e);
      void fetchIconDataUrl(icon.iconName).then((src) => {
        dispatch({ type: 'ADD_IMAGE', src, w: 96, h: 96, at, iconAttribution: icon.attribution });
      }).catch(() => {
        // The sidebar remains usable after a transient API/network failure.
      });
    }
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
  /** Shape the in-flight arrow/endpoint would attach to — resolved by the reducer so the ring
   * always agrees with what gets committed (see `connectTarget` in reducer.ts). */
  const connectTargetShape = state.connectTarget ? findShape(doc, state.connectTarget) : undefined;

  const newDrag = (
    kind: DragState['kind'],
    e: Pick<React.MouseEvent, 'clientX' | 'clientY'>,
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

  const onMouseDown = (e: PointerDownInfo) => {
    if (mode === 'insert') {
      pendingInsertMouseDown.current = {
        clientX: e.clientX,
        clientY: e.clientY,
        button: e.button,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        target: e.target,
        preventDefault: () => e.preventDefault(),
      };
      return;
    }
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
      drag.current = { ...newDrag('marquee', e), marqueeShift: true };
      dispatch({ type: 'MARQUEE_START', p: toWorld(e) });
      return;
    }

    const id = hitId(e.target);
    const handle = (e.target as Element).getAttribute?.('data-handle');
    const resize = handle === 'resize';
    const edgeDir =
      handle === 'resize-n' || handle === 'resize-s' || handle === 'resize-e' || handle === 'resize-w'
        ? (handle.slice(7) as 'n' | 's' | 'e' | 'w')
        : null;
    const endpointEnd: 'from' | 'to' | null =
      handle === 'endpoint-from' ? 'from' : handle === 'endpoint-to' ? 'to' : null;
    const waypointIndex =
      handle === 'waypoint' ? Number((e.target as Element).getAttribute('data-index')) : null;
    const isElbow = handle === 'elbow';
    const connectShapeId =
      handle === 'connect' ? ((e.target as Element).getAttribute('data-shape') ?? undefined) : undefined;
    const targetId = resize || edgeDir || endpointEnd ? state.selectedIds[0] : id;

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
        resizeAnchorPt: anchor,
      };
      dispatch({ type: 'DRAG_START', id: targetId });
      return;
    }
    if (edgeDir && selectedBox && targetId) {
      const eh = edgeResizeHandles(selectedBox).find((h) => h.dir === edgeDir);
      if (eh) {
        drag.current = {
          ...newDrag('resize', e, targetId, selectedBox),
          resizeSign: eh.sign,
          resizeAnchorPt: eh.anchor,
        };
        dispatch({ type: 'DRAG_START', id: targetId });
      }
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
    if (isElbow && id) {
      drag.current = newDrag('elbow', e, id);
      dispatch({ type: 'ELBOW_DRAG_START', id });
      return;
    }
    if (state.tool === 'arrow') {
      drag.current = newDrag('arrowdrag', e);
      dispatch({ type: 'START_ARROW_AT', p: toWorld(e), shapeId: id });
      return;
    }
    if ((state.tool === 'sketch' || state.tool === 'pen') && !id) {
      // Freehand stroke on empty canvas; on mouseup, sketch auto-detects a shape
      // or line, pen keeps the stroke as a freedraw shape. Dragging an existing
      // shape always moves it instead.
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
    // Select tool on empty canvas: plain drag is a marquee, not just shift/ctrl+drag.
    if (state.tool === 'select') {
      drag.current = newDrag('marquee', e);
      dispatch({ type: 'MARQUEE_START', p: toWorld(e) });
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

  // Replays a mousedown that landed while still in 'insert' mode, once the text
  // editor's blur has actually committed and mode has moved on — see
  // `pendingInsertMouseDown` above for why this can't just run inline.
  useEffect(() => {
    if (mode === 'insert') return;
    const pending = pendingInsertMouseDown.current;
    if (!pending) return;
    pendingInsertMouseDown.current = null;
    onMouseDown(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const onMouseMove = (e: DragMoveInfo) => {
    const d = drag.current;
    // Also track hover while editing text (mode 'insert') so a shape's connect
    // dots stay available — dragging one starts an arrow — without first having
    // to click away to leave the text editor.
    if (!d && (mode === 'normal' || mode === 'insert')) {
      const near = shapeNear(doc, toWorld(e), HOVER_MARGIN * inv, FRAME_BORDER_BAND * inv);
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
    const world = toWorld(e);
    const dx = world.x - d.startWorld.x;
    const dy = world.y - d.startWorld.y;
    // The same 4px dead zone guards every handle drag, not just move/resize: a connector's
    // endpoint handle sits exactly on its shape's border, so without it a single pixel of
    // jitter while clicking the handle would detach the connector and push that onto the
    // undo stack.
    if (!d.moved && Math.hypot(dx * view.scale, dy * view.scale) < 4) return;
    d.moved = true;
    if (d.kind === 'endpoint') {
      dispatch({ type: 'ENDPOINT_DRAG_MOVE', id: d.id, end: d.end as 'from' | 'to', p: world });
      return;
    }
    if (d.kind === 'waypoint') {
      dispatch({ type: 'WAYPOINT_DRAG_MOVE', id: d.id, index: d.index as number, p: world });
      return;
    }
    if (d.kind === 'elbow') {
      dispatch({ type: 'ELBOW_DRAG_MOVE', id: d.id, p: world });
      return;
    }
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
      const anchor = d.resizeAnchorPt ?? { x: d.orig.x, y: d.orig.y };
      dispatch({ type: 'DRAG_RESIZE', w: d.orig.w + sign.x * dx, h: d.orig.h + sign.y * dy, anchor });
    } else if (d.kind === 'moveconn') {
      dispatch({ type: 'CONNECTOR_DRAG_MOVE', id: d.id, dx, dy });
    }
  };

  /** A plain (non-drag) click: selects what's under it, and — when it's the second such click
   * in the same spot — opens the text editor, which is what the DOM's `dblclick` used to be
   * relied on for (see DOUBLE_CLICK_MS for why it can't be). The `dblclick` handler is still
   * wired up as well: it covers a slower pair than our own window when the OS is configured
   * that way, and its own `mode !== 'normal'` guard makes it a no-op once this has already
   * opened the editor. Shift/Ctrl-clicks only extend a selection, so they never pair up. */
  const clickAt = (e: DragUpInfo, id: string | undefined, shift = false) => {
    dispatch({ type: 'CLICK', p: toWorld(e), id, shift });
    const prev = lastClick.current;
    lastClick.current = null;
    if (shift || e.button !== 0) return;
    const now = performance.now();
    if (
      prev &&
      now - prev.t <= DOUBLE_CLICK_MS &&
      Math.hypot(e.clientX - prev.x, e.clientY - prev.y) <= DOUBLE_CLICK_PX
    ) {
      if (mode === 'normal') dispatch({ type: 'DBL_CLICK', p: toWorld(e), id });
      return;
    }
    lastClick.current = { t: now, x: e.clientX, y: e.clientY };
  };

  const onMouseUp = (e: DragUpInfo) => {
    const d = drag.current;
    drag.current = null;
    setGuides({});
    if (isPanning) setIsPanning(false);
    // A gesture that actually moved something isn't a click: it must not pair up with the
    // click before it into a double-click.
    if (d?.moved) lastClick.current = null;
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
            clickAt(e, hitId(e.target));
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
            clickAt(e, hitId(e.target));
          }
          return;
        case 'marquee':
          if (d.moved) {
            dispatch({ type: 'MARQUEE_END' });
          } else if (d.marqueeShift) {
            // Shift/Ctrl+click without drag: toggle the item in the selection.
            dispatch({ type: 'MARQUEE_CANCEL' });
            clickAt(e, hitId(e.target), true);
          } else {
            // Select tool plain click without drag: normal click (selects hit, clears otherwise).
            dispatch({ type: 'MARQUEE_CANCEL' });
            clickAt(e, hitId(e.target));
          }
          return;
        case 'move':
        case 'resize':
        case 'moveconn':
          dispatch({ type: 'DRAG_END' });
          // `d.id`, not the release target: by now the first click has drawn the selection
          // outline and its handles over the shape, and the second press often lands on one
          // of those instead — they carry no data-id, so hit-testing the target here would
          // lose the shape and open a stray text box on top of it.
          if (!d.moved) clickAt(e, d.id);
          return;
        case 'endpoint':
        case 'waypoint':
        case 'elbow':
          dispatch({ type: 'DRAG_END' });
          return;
        case 'pan':
          if (!d.moved) clickAt(e, hitId(e.target));
          return;
      }
    }
    // Keyboard-initiated draw/arrow: click confirms.
    if (mode === 'draw' || mode === 'arrow') {
      dispatch({ type: 'CLICK', p: toWorld(e), id: hitId(e.target) });
      return;
    }
    clickAt(e, hitId(e.target));
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

  const onWheel = (e: { ctrlKey: boolean; shiftKey: boolean; deltaX: number; deltaY: number; clientX: number; clientY: number }) => {
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

  /* Every gesture handler that can't live on the svg as a React prop, kept fresh through a ref
   * so each one registers once instead of re-binding on every render. */
  const handlers = useRef({ onMouseMove, onMouseUp, onWheel });
  handlers.current = { onMouseMove, onMouseUp, onWheel };

  /* A gesture's move/up halves live on `window`, not the svg: a drag routinely leaves the
   * canvas — dropping a shape against the toolbar, marquee-ing past the window edge — and it
   * must keep tracking and, above all, still *end* out there. Bound to the svg, the mouseup
   * never arrives, so the drag stays live and the shape goes on following a button-up cursor
   * once it comes back. Only mousedown stays on the svg (that half must be inside it).
   *
   * Events that land *outside* the canvas with no drag in flight are dropped: hover tracking
   * has nothing to say about the sidebar, and a click on a toolbar button must not read as a
   * canvas click that clears the selection. */
  useEffect(() => {
    const overCanvas = (t: EventTarget | null) =>
      t instanceof Node && !!svgRef.current?.contains(t);
    const move = (e: MouseEvent) => {
      // Released outside the window (over another app, past the screen edge): no mouseup ever
      // arrives, so the first move back in with no button still held ends the gesture rather
      // than letting it run on.
      if (drag.current && e.buttons === 0) {
        handlers.current.onMouseUp(e);
        return;
      }
      if (!drag.current && !overCanvas(e.target)) return;
      handlers.current.onMouseMove(e);
    };
    const up = (e: MouseEvent) => {
      if (!drag.current && !overCanvas(e.target)) return;
      handlers.current.onMouseUp(e);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, []);

  /* Wheel is bound natively instead of through React's `onWheel`, because React registers
   * wheel listeners as passive — `preventDefault()` inside one is a no-op. Without it the
   * browser (or the WebView2 shell) acts on the same gesture the canvas just handled:
   * Ctrl+wheel zooms the page *and* the diagram, and a plain wheel pan also rubber-band
   * scrolls whatever is behind. */
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      handlers.current.onWheel(e);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

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
        strokeDasharray: dash(6, 4, inv),
        strokeWidth: 1.5 * inv,
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
          stroke="var(--connect)"
          strokeDasharray={dash(6, 4, inv)}
          strokeWidth={1.5 * inv}
          markerEnd="url(#arrow-connect)"
        />
      );
    }
    return null;
  };

  const connView = (c: Connector) => {
    const path = connectorPath(doc, c);
    const points = path.map((p) => `${p.x},${p.y}`).join(' ');
    const labelPos = connectorLabelPos(doc, c);
    const elbowHandle = connectorElbowHandle(doc, c);
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
          strokeWidth={12 * inv}
          style={{ cursor: bodyCursor }}
        />
        {haloColor && (
          <polyline
            points={points}
            fill="none"
            stroke={haloColor}
            strokeWidth={STROKE_WIDTH_BASE[c.strokeWidth ?? 'm'] + (selected ? 4 : 3) * inv}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.5}
          />
        )}
        <polyline
          points={points}
          fill="none"
          stroke={trueStroke}
          strokeWidth={selected ? STROKE_WIDTH_BASE[c.strokeWidth ?? 'm'] + 0.5 : STROKE_WIDTH_BASE[c.strokeWidth ?? 'm']}
          strokeLinejoin="round"
          strokeDasharray={c.dashed ? '6 4' : undefined}
          markerStart={showStartArrow ? marker : undefined}
          markerEnd={showEndArrow ? marker : undefined}
        />
        {selected &&
          // Self-loops route from their feet alone and ignore waypoints (see connectorPath),
          // so a connector that kept some from before it became a loop shows no handles —
          // dragging one would move nothing.
          !isSelfLoop(c) &&
          c.waypoints?.map((wp, i) => (
            <circle
              key={i}
              data-handle="waypoint"
              data-index={i}
              cx={wp.x}
              cy={wp.y}
              r={5 * inv}
              fill="var(--bg)"
              stroke="var(--accent)"
              strokeWidth={1.5 * inv}
              style={{ cursor: 'move' }}
            />
          ))}
        {selected && elbowHandle && (
          <circle
            data-handle="elbow"
            cx={elbowHandle.pos.x}
            cy={elbowHandle.pos.y}
            r={5 * inv}
            fill="var(--bg)"
            stroke="var(--accent)"
            strokeWidth={1.5 * inv}
            style={{ cursor: elbowHandle.axis === 'x' ? 'ew-resize' : 'ns-resize' }}
          />
        )}
        <Label
          label={c.label}
          cx={labelPos.x}
          cy={labelPos.y}
          anchor={labelPos.anchor}
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
    state.tool === 'sketch' ||
    state.tool === 'pen';
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
    {/* Both lines have to describe what actually happens: a double-click on empty canvas
        creates a *text box* (DBL_CLICK → startTextInsert), not a rect, and the r/e/t keys only
        exist while vim mode is on — so they're only offered when they'll work. */}
    {isEmpty && mode === 'normal' && (
      <div className="canvas-hint">
        ドラッグで手描き → 図形を自動認識(✏ Auto)
        <br />
        {vim
          ? 'ダブルクリックでテキスト、r 四角 / e 楕円 / t テキスト'
          : 'ダブルクリックでテキスト、ツールバーの ▭ ◯ でドラッグして図形'}
      </div>
    )}
    <svg
      ref={svgRef}
      className="canvas"
      style={{ cursor: bgCursor }}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onMouseLeave={() => setHoverId(null)}
      onDragOver={onDragOver}
      onDrop={onDrop}
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
          id="arrow-connect"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="8"
          markerHeight="8"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--connect)" />
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
            inv={inv}
          />
        ))}
        {hoverShape &&
          (mode === 'normal' || mode === 'insert') &&
          !drag.current &&
          state.tool !== 'select' &&
          connectDots(hoverShape, inv)}
        {/* Drawn over the shapes so it reads as an answer to the gesture in flight: releasing
            here attaches to this shape (and if it's the arrow's own source, closes a self-loop).
            Green, matching the connect dots and the drag preview, so "connection" stays one
            visual family distinct from the blue selection accent. Absent = lands loose. */}
        {connectTargetShape && (
          <g style={{ pointerEvents: 'none' }}>
            <ShapeOutline
              s={connectTargetShape}
              pad={4 * inv}
              color="var(--connect)"
              width={2.5 * inv}
              opacity={0.95}
              strokeBase={STROKE_WIDTH_BASE[connectTargetShape.strokeWidth ?? 'm']}
            />
          </g>
        )}
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
              x={handle.x - 5 * inv}
              y={handle.y - 5 * inv}
              width={10 * inv}
              height={10 * inv}
              fill="var(--accent)"
              style={{ cursor }}
            />
          );
        })()}
        {/* The edge handles are hidden on a selection too small to fit them without swamping
            it — a screen-space threshold, since that's the size the handles now keep. */}
        {selectedBox && mode === 'normal' && selectedBox.w * view.scale > 16 && selectedBox.h * view.scale > 16 &&
          edgeResizeHandles(selectedBox).map((eh) => {
            const long = 10 * inv;
            const short = 8 * inv;
            const horizontal = eh.dir === 'n' || eh.dir === 's';
            return (
              <rect
                key={eh.dir}
                data-handle={`resize-${eh.dir}`}
                x={eh.pos.x - (horizontal ? long : short) / 2}
                y={eh.pos.y - (horizontal ? short : long) / 2}
                width={horizontal ? long : short}
                height={horizontal ? short : long}
                fill="var(--accent)"
                style={{ cursor: horizontal ? 'ns-resize' : 'ew-resize' }}
              />
            );
          })}
        {guides.vx !== undefined && (
          <line x1={guides.vx} y1={-50000} x2={guides.vx} y2={50000} stroke="var(--accent)" strokeWidth={inv} strokeDasharray={dash(3, 3, inv)} style={{ pointerEvents: 'none' }} />
        )}
        {guides.hy !== undefined && (
          <line x1={-50000} y1={guides.hy} x2={50000} y2={guides.hy} stroke="var(--accent)" strokeWidth={inv} strokeDasharray={dash(3, 3, inv)} style={{ pointerEvents: 'none' }} />
        )}
        {selectedConnector && mode === 'normal' && (() => {
          const path = connectorPath(doc, selectedConnector);
          const a = path[0];
          const b = path[path.length - 1];
          // A self-loop's feet are stored as anchors of their own (see Endpoint), so they
          // read as fixed even though they carry no explicit `anchor`.
          const loop = isSelfLoop(selectedConnector);
          return (
            <>
              {endpointHandle('endpoint-from', a, loop || !!selectedConnector.from.anchor, inv)}
              {endpointHandle('endpoint-to', b, loop || !!selectedConnector.to.anchor, inv)}
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
            strokeDasharray={dash(4, 3, inv)}
            strokeWidth={inv}
            style={{ pointerEvents: 'none' }}
          />
        )}
        {state.sketch && state.sketch.length > 1 && (
          <polyline
            points={state.sketch.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={1.5 * inv}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ pointerEvents: 'none' }}
          />
        )}
        {vim && mode !== 'insert' && (
          <g style={{ pointerEvents: 'none' }}>
            <line
              x1={cursor.x - CURSOR_ARM * inv}
              y1={cursor.y}
              x2={cursor.x + CURSOR_ARM * inv}
              y2={cursor.y}
              stroke="var(--cursor)"
              strokeWidth={2 * inv}
            />
            <line
              x1={cursor.x}
              y1={cursor.y - CURSOR_ARM * inv}
              x2={cursor.x}
              y2={cursor.y + CURSOR_ARM * inv}
              stroke="var(--cursor)"
              strokeWidth={2 * inv}
            />
          </g>
        )}
      </g>
    </svg>
    </>
  );
}
