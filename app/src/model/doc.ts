import { FONT_LINE_H, FONT_SIZE_PX, FREEDRAW_RES, GRID } from './types';
import type { Connector, Doc, Endpoint, FontSize, LoopSide, Pt, Shape, TriangleDirection } from './types';

/** The 3 vertices of a triangle for a given bbox + apex direction. Cardinal
 * directions put the apex at an edge midpoint (isosceles); diagonal directions
 * put the right angle at that bbox corner. */
export function triangleVertices(box: {
  x: number;
  y: number;
  w: number;
  h: number;
  direction?: TriangleDirection;
}): [Pt, Pt, Pt] {
  const { x, y, w, h } = box;
  const cx = x + w / 2;
  const cy = y + h / 2;
  switch (box.direction) {
    case 'down':
      return [{ x: cx, y: y + h }, { x, y }, { x: x + w, y }];
    case 'left':
      return [{ x, y: cy }, { x: x + w, y }, { x: x + w, y: y + h }];
    case 'right':
      return [{ x: x + w, y: cy }, { x, y }, { x, y: y + h }];
    case 'up-left':
      return [{ x, y }, { x: x + w, y }, { x, y: y + h }];
    case 'up-right':
      return [{ x: x + w, y }, { x, y }, { x: x + w, y: y + h }];
    case 'down-left':
      return [{ x, y: y + h }, { x, y }, { x: x + w, y: y + h }];
    case 'down-right':
      return [{ x: x + w, y: y + h }, { x: x + w, y }, { x, y: y + h }];
    case 'up':
    default:
      return [{ x: cx, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  }
}

/** Point to center a shape's label on. For most shapes this is the bbox
 * center, but a triangle's bbox center can sit right on (or outside) its
 * slanted edges depending on apex direction — e.g. for a diagonal direction
 * it's exactly on the hypotenuse — so triangles use their vertex centroid,
 * which always lies inside the shape, instead. */
export function labelCenter(s: { x: number; y: number; w: number; h: number; kind: string; direction?: TriangleDirection }): Pt {
  if (s.kind === 'triangle') {
    const [a, b, c] = triangleVertices(s);
    return { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 };
  }
  return { x: s.x + s.w / 2, y: s.y + s.h / 2 };
}

/** Largest axis-aligned rectangle that fits inside the shape's own outline,
 * used to size the text-edit box so it doesn't spill past a rounded/pointed
 * shape the way the raw bbox would. Rect/image/text fill their bbox exactly. */
export function inscribedBox(s: {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: string;
  direction?: TriangleDirection;
}): { x: number; y: number; w: number; h: number } {
  const { x, y, w, h } = s;
  if (s.kind === 'ellipse') {
    const iw = w / Math.SQRT2;
    const ih = h / Math.SQRT2;
    return { x: x + (w - iw) / 2, y: y + (h - ih) / 2, w: iw, h: ih };
  }
  if (s.kind === 'diamond') {
    return { x: x + w / 4, y: y + h / 4, w: w / 2, h: h / 2 };
  }
  if (s.kind === 'triangle') {
    // Every direction's max inscribed axis-aligned rectangle is exactly
    // half-width by half-height, sitting against the triangle's base (cardinal
    // directions) or its right-angle corner (diagonal directions).
    const halfW = w / 2;
    const halfH = h / 2;
    switch (s.direction) {
      case 'down':
        return { x: x + w / 4, y, w: halfW, h: halfH };
      case 'left':
        return { x: x + halfW, y: y + h / 4, w: halfW, h: halfH };
      case 'right':
        return { x, y: y + h / 4, w: halfW, h: halfH };
      case 'up-left':
        return { x, y, w: halfW, h: halfH };
      case 'up-right':
        return { x: x + halfW, y, w: halfW, h: halfH };
      case 'down-left':
        return { x, y: y + halfH, w: halfW, h: halfH };
      case 'down-right':
        return { x: x + halfW, y: y + halfH, w: halfW, h: halfH };
      case 'up':
      default:
        return { x: x + w / 4, y: y + halfH, w: halfW, h: halfH };
    }
  }
  if (s.kind === 'frame') {
    return {
      x: x + FRAME_LABEL_PAD_X,
      y: y + FRAME_LABEL_PAD_Y,
      w: Math.max(40, Math.min(FRAME_LABEL_ZONE_W, w - FRAME_LABEL_PAD_X * 2)),
      h: Math.max(24, Math.min(FRAME_LABEL_ZONE_H + 16, h - FRAME_LABEL_PAD_Y * 2)),
    };
  }
  return { x, y, w, h };
}

/** How far in from a frame's own top-left corner its label starts. */
export const FRAME_LABEL_PAD_X = 10;
export const FRAME_LABEL_PAD_Y = 8;
/** Size of the top-left zone (clipped to the frame's own bounds) that counts as "on the
 * label" for hit-testing, generous enough to cover the label text at any font size without
 * having to measure it. */
export const FRAME_LABEL_ZONE_W = 160;
export const FRAME_LABEL_ZONE_H = 28;
/** Width of the clickable/draggable band around a frame's border. */
export const FRAME_BORDER_BAND = 10;

/**
 * Whether `p` lands on a frame's hit zone: a band straddling its border — extending
 * FRAME_BORDER_BAND both inside AND outside the rect edge, matching the Canvas's invisible
 * border hit-stroke, whose 2×band width is centered on the edge — plus its top-left label
 * area. A frame's open interior is deliberately excluded (see `shapeAt`) so a frame can sit on
 * top of — or be created around — other shapes without swallowing clicks meant for them; only
 * the border and the label are "the frame" as far as hit-testing is concerned.
 */
export function frameHitZone(f: { x: number; y: number; w: number; h: number }, p: Pt): boolean {
  const band = FRAME_BORDER_BAND;
  // Past the band's outer edge: no hit.
  if (p.x < f.x - band || p.x > f.x + f.w + band || p.y < f.y - band || p.y > f.y + f.h + band) {
    return false;
  }
  return frameBorderOrLabel(f, p);
}

/**
 * Like `frameHitZone` but WITHOUT the outer-band cap: true for the border ring's inside half and
 * the label, and for everything OUTSIDE the rect — leaving the caller's own outer bound to decide
 * how far outside still counts. Only the deep interior (inset by FRAME_BORDER_BAND, minus the
 * label zone) is excluded, so a shape a frame contains keeps the hover instead of the frame
 * stealing it. Used for hover, where a frame's connect dots float CONNECT_DOT_OFFSET outside the
 * edge — farther than the border band — so hover must reach them (see shapeNear in Canvas.tsx).
 */
export function frameBorderOrLabel(f: { x: number; y: number; w: number; h: number }, p: Pt): boolean {
  const band = FRAME_BORDER_BAND;
  const inInner =
    p.x >= f.x + band && p.x <= f.x + f.w - band && p.y >= f.y + band && p.y <= f.y + f.h - band;
  if (!inInner) return true;
  const lw = Math.min(FRAME_LABEL_ZONE_W, f.w);
  const lh = Math.min(FRAME_LABEL_ZONE_H, f.h);
  return p.x <= f.x + lw && p.y <= f.y + lh;
}

/** Absolute (world-space) points of a freedraw stroke, decoded from the shape's
 * quantized bbox-relative `points` (see Shape.points in types.ts). */
export function freedrawPoints(s: { x: number; y: number; w: number; h: number; points?: number[] }): Pt[] {
  const q = s.points ?? [];
  const out: Pt[] = [];
  for (let i = 0; i + 1 < q.length; i += 2) {
    out.push({
      x: s.x + (q[i] / FREEDRAW_RES) * s.w,
      y: s.y + (q[i + 1] / FREEDRAW_RES) * s.h,
    });
  }
  return out;
}

/** SVG path `d` for a freedraw stroke, shared by the canvas and the SVG export.
 * Interior points become quadratic control points toward segment midpoints, so the
 * simplified polyline renders as a smooth curve instead of visible corners.
 * Coordinates are rounded to 0.1px to keep exported SVG strings short. */
export function freedrawPathD(s: { x: number; y: number; w: number; h: number; points?: number[] }): string {
  const pts = freedrawPoints(s);
  if (pts.length < 2) return '';
  const f = (v: number): number => Math.round(v * 10) / 10;
  let d = `M ${f(pts[0].x)} ${f(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    d += ` Q ${f(pts[i].x)} ${f(pts[i].y)} ${f(mx)} ${f(my)}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${f(last.x)} ${f(last.y)}`;
  return d;
}

/** Point that stays fixed while resizing: a lone triangle's own vertex (its
 * apex, or the right-angle corner for a diagonal direction), so the pointy
 * end doesn't drift; the bbox top-left for everything else (incl. multi-select). */
export function resizeAnchor(shapes: Shape[], box: { x: number; y: number; w: number; h: number }): Pt {
  if (shapes.length === 1 && shapes[0].kind === 'triangle') {
    return triangleVertices(shapes[0])[0];
  }
  return { x: box.x, y: box.y };
}

/** Resize-handle position: the bbox corner farthest from `anchor`, so the
 * handle sits away from the fixed vertex instead of possibly right next to it. */
export function resizeHandlePoint(box: { x: number; y: number; w: number; h: number }, anchor: Pt): Pt {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return {
    x: anchor.x <= cx ? box.x + box.w : box.x,
    y: anchor.y <= cy ? box.y + box.h : box.y,
  };
}

/** The four edge-midpoint resize handles: dragging one grows/shrinks a
 * single axis, keeping the opposite edge fixed. Unlike the corner handle,
 * these are always plain-bbox anchored (never a triangle's own vertex): the
 * axis that doesn't change is scaled by 1, so its anchor coordinate is never
 * actually used, and the changing axis's anchor is simply the opposite edge. */
export function edgeResizeHandles(
  box: { x: number; y: number; w: number; h: number },
): Array<{ dir: 'n' | 's' | 'e' | 'w'; pos: Pt; sign: Pt; anchor: Pt }> {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return [
    { dir: 'n', pos: { x: cx, y: box.y }, sign: { x: 0, y: -1 }, anchor: { x: box.x, y: box.y + box.h } },
    { dir: 's', pos: { x: cx, y: box.y + box.h }, sign: { x: 0, y: 1 }, anchor: { x: box.x, y: box.y } },
    { dir: 'w', pos: { x: box.x, y: cy }, sign: { x: -1, y: 0 }, anchor: { x: box.x + box.w, y: box.y } },
    { dir: 'e', pos: { x: box.x + box.w, y: cy }, sign: { x: 1, y: 0 }, anchor: { x: box.x, y: box.y } },
  ];
}

/** Nearest point where the ray from `o` in direction `d` (t >= 0) crosses the
 * polygon's boundary; null if it never does (shouldn't happen for `o` inside). */
function rayPolygonBorder(o: Pt, d: Pt, verts: Pt[]): Pt | null {
  let best: { t: number; p: Pt } | null = null;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const v1x = o.x - a.x;
    const v1y = o.y - a.y;
    const v2x = b.x - a.x;
    const v2y = b.y - a.y;
    const v3x = -d.y;
    const v3y = d.x;
    const denom = v2x * v3x + v2y * v3y;
    if (Math.abs(denom) < 1e-9) continue;
    const t = (v2x * v1y - v2y * v1x) / denom;
    const u = (v1x * v3x + v1y * v3y) / denom;
    if (t >= 0 && u >= 0 && u <= 1 && (!best || t < best.t)) {
      best = { t, p: { x: o.x + d.x * t, y: o.y + d.y * t } };
    }
  }
  return best?.p ?? null;
}

/** Whether `p` lies inside a shape's bounding box, grown by `margin` on every side. */
export function withinBBox(s: { x: number; y: number; w: number; h: number }, p: Pt, margin = 0): boolean {
  return p.x >= s.x - margin && p.x <= s.x + s.w + margin && p.y >= s.y - margin && p.y <= s.y + s.h + margin;
}

function topmostShape(doc: Doc, p: Pt, margin: number): Shape | undefined {
  for (let i = doc.shapes.length - 1; i >= 0; i--) {
    const s = doc.shapes[i];
    // A frame hit-tests purely by frameHitZone: its interior is transparent (so it never
    // captures a click/cursor meant for a shape it contains or is layered over), while its
    // border band also extends slightly OUTSIDE the bbox — so a frame must not go through
    // the generic bbox check below, which would reject that outside half of the band.
    if (s.kind === 'frame') {
      if (frameHitZone(s, p)) return s;
      continue;
    }
    if (withinBBox(s, p, margin)) return s;
  }
  return undefined;
}

/** Topmost shape at `p`. With a `margin`, a shape whose border `p` merely came close to also
 * counts — for grabbing/dropping gestures that aim at an outline rather than an interior.
 * Exact hits are resolved first, so a shape `p` is genuinely inside never loses to a
 * neighbour that happens to sit higher in z-order and pass within `margin`. */
export function shapeAt(doc: Doc, p: Pt, margin = 0): Shape | undefined {
  const exact = topmostShape(doc, p, 0);
  if (exact || margin <= 0) return exact;
  return topmostShape(doc, p, margin);
}

export function connectorAt(doc: Doc, p: Pt): Connector | undefined {
  for (let i = doc.connectors.length - 1; i >= 0; i--) {
    const c = doc.connectors[i];
    const path = connectorPath(doc, c);
    for (let j = 0; j < path.length - 1; j++) {
      if (distToSegment(p, path[j], path[j + 1]) < 8) return c;
    }
  }
  return undefined;
}

export function findShape(doc: Doc, id: string): Shape | undefined {
  return doc.shapes.find((s) => s.id === id);
}

export function findConnector(doc: Doc, id: string): Connector | undefined {
  return doc.connectors.find((c) => c.id === id);
}

/** World point of a bbox-normalized anchor (see Endpoint). */
export function anchorPoint(s: { x: number; y: number; w: number; h: number }, a: Pt): Pt {
  return { x: s.x + a.x * s.w, y: s.y + a.y * s.h };
}

/** `p` expressed as a bbox-normalized anchor on `s` (see Endpoint). */
export function toAnchor(s: { x: number; y: number; w: number; h: number }, p: Pt): Pt {
  return { x: (p.x - s.x) / (s.w || 1), y: (p.y - s.y) / (s.h || 1) };
}

/** The point on a shape's outline closest to `p` — where an endpoint dropped at `p` should
 * pin. Box-ish kinds project onto the nearest edge, so aiming at a rectangle's right edge
 * pins at the cursor's own height rather than wherever a ray from the centre happens to
 * leave. The curved/pointed kinds have no such straightforward projection and use the
 * centre ray (`borderPoint`), which for a point at or just outside the outline — the case
 * that matters here — lands within a hair of the true nearest point anyway. */
export function nearestBorderPoint(s: Shape, p: Pt): Pt {
  if (s.kind === 'ellipse' || s.kind === 'diamond' || s.kind === 'triangle') return borderPoint(s, p);
  const cx = Math.min(Math.max(p.x, s.x), s.x + s.w);
  const cy = Math.min(Math.max(p.y, s.y), s.y + s.h);
  const dl = cx - s.x;
  const dr = s.x + s.w - cx;
  const dt = cy - s.y;
  const db = s.y + s.h - cy;
  const m = Math.min(dl, dr, dt, db);
  if (m === dt) return { x: cx, y: s.y };
  if (m === db) return { x: cx, y: s.y + s.h };
  if (m === dl) return { x: s.x, y: cy };
  return { x: s.x + s.w, y: cy };
}

export function resolveEndpoint(doc: Doc, e: Endpoint): { p: Pt; shape?: Shape } {
  const s = e.shapeId ? findShape(doc, e.shapeId) : undefined;
  // A fixed attachment resolves to its anchor; a floating one to the shape's centre, which
  // is only ever an aiming point — the visible end is trimmed to the border by endpointFoot.
  if (s) return { p: e.anchor ? anchorPoint(s, e.anchor) : { x: s.x + s.w / 2, y: s.y + s.h / 2 }, shape: s };
  return { p: { x: e.x, y: e.y } };
}

/** Where a connector actually meets an endpoint, given the point it heads toward next: a
 * fixed attachment stays on its anchor, a floating one slides around the border to face
 * `toward`, and a free endpoint is simply itself. */
function endpointFoot(e: Endpoint, resolved: { p: Pt; shape?: Shape }, toward: Pt): Pt {
  if (!resolved.shape || e.anchor) return resolved.p;
  return borderPoint(resolved.shape, toward);
}

/** Visible segment of a connector, trimmed at shape borders (endpoints only; ignores routing/waypoints). */
export function connectorEnds(doc: Doc, c: Connector): [Pt, Pt] {
  const from = resolveEndpoint(doc, c.from);
  const to = resolveEndpoint(doc, c.to);
  return [endpointFoot(c.from, from, to.p), endpointFoot(c.to, to, from.p)];
}

/** A connector is a self-loop when both ends bind the same shape. */
export function isSelfLoop(c: Connector): boolean {
  return !!c.from.shapeId && c.from.shapeId === c.to.shapeId;
}

/** Which side of a shape `p` sits toward, seen from the shape center. Offsets are
 * normalized by the half-extents so a wide/tall shape doesn't bias the choice —
 * used to place a self-loop on the side the user dragged toward. */
export function nearestSide(s: { x: number; y: number; w: number; h: number }, p: Pt): LoopSide {
  const dx = (p.x - (s.x + s.w / 2)) / (s.w / 2 || 1);
  const dy = (p.y - (s.y + s.h / 2)) / (s.h / 2 || 1);
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return 'top';
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

/** Samples along a self-loop curve — enough that the polyline reads as a smooth
 * loop and hit-testing/label placement behave like any other connector path. */
const SELF_LOOP_SAMPLES = 30;

/** Bbox-normalized anchor (0..1) for each side's edge midpoint — how the self-loop
 * UI maps a chosen side to an endpoint's stored `x`/`y` (see Endpoint). */
export const SIDE_NORM: Record<LoopSide, Pt> = {
  top: { x: 0.5, y: 0 },
  right: { x: 1, y: 0.5 },
  bottom: { x: 0.5, y: 1 },
  left: { x: 0, y: 0.5 },
};

/** An endpoint's normalized anchor: the explicit fixed-attachment `anchor` when it has one,
 * else its `x`/`y`, which for a self-loop foot are themselves normalized (see Endpoint). */
function normAnchorOf(e: Endpoint): Pt {
  return e.anchor ?? { x: e.x, y: e.y };
}

/** The side an endpoint's normalized anchor sits toward, for showing the active
 * side in the self-loop UI. Ties/centre fall to 'top'. */
export function loopSideOf(e: Endpoint): LoopSide {
  const a = normAnchorOf(e);
  const dx = a.x - 0.5;
  const dy = a.y - 0.5;
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return 'top';
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

/** World point of a self-loop endpoint's bbox-normalized anchor (see Endpoint). */
function selfLoopAnchor(s: Shape, e: Endpoint): Pt {
  return anchorPoint(s, normAnchorOf(e));
}

/** Outward axis-aligned normal for a foot: a self-loop foot's normalized anchor sits on
 * a border (one coord at ~0 or ~1), so pick the edge it's nearest to. Used to leave/re-enter
 * the shape perpendicular to its border and to project the foot out onto the padded box. */
function footNormal(e: Endpoint): Pt {
  const a = normAnchorOf(e);
  const dl = a.x;
  const dr = 1 - a.x;
  const dt = a.y;
  const db = 1 - a.y;
  const m = Math.min(dl, dr, dt, db);
  if (m === dt) return { x: 0, y: -1 };
  if (m === db) return { x: 0, y: 1 };
  if (m === dl) return { x: -1, y: 0 };
  return { x: 1, y: 0 };
}

/** One Catmull-Rom span (p1→p2), with p0/p3 the neighbours that set the tangents. */
function catmullRom(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

/** How far a point may sit inside the shape before a candidate loop is rejected. A clean
 * circle only ever grazes the body by a hair at its feet (sub-stroke); anything deeper
 * means the circle would visibly cut through, so we fall back to the safe routed loop. */
const SELF_LOOP_INSIDE_TOL = 2.5;

/** Deepest a point pokes inside the shape (0 if on/outside the border). */
export function insideDepth(s: Shape, p: Pt): number {
  if (p.x <= s.x || p.x >= s.x + s.w || p.y <= s.y || p.y >= s.y + s.h) return 0;
  return Math.min(p.x - s.x, s.x + s.w - p.x, p.y - s.y, s.y + s.h - p.y);
}

/** A clean circular loop through the two feet, bulging outward along their averaged border
 * normal — the *outward* (major) arc from a to b, a near-full circle whose ends land back on
 * the shape and whose gap (holding the arrowhead) faces the body. Returns null when the feet
 * are on opposite edges (their normals cancel), where no through-feet circle can stay outside. */
function selfLoopCircle(s: Shape, a: Pt, b: Pt, na: Pt, nb: Pt): Pt[] | null {
  const dim = Math.min(s.w, s.h);
  const chord = Math.hypot(a.x - b.x, a.y - b.y);
  const avg = { x: na.x + nb.x, y: na.y + nb.y };
  const avgLen = Math.hypot(avg.x, avg.y);
  if (avgLen < 1e-6) return null; // opposite edges → no clean circle
  const half = chord / 2;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  // Radius scales with the shape but stays a readable ring, and always clears the feet.
  const r = Math.max(half + 12, Math.min(Math.max(dim * 0.42, 18), 46));
  const h = Math.sqrt(Math.max(0, r * r - half * half));
  // Bulge along the chord's perpendicular bisector so the circle passes through *both* feet
  // exactly (centre stays equidistant from a and b); orient it outward via the averaged normal.
  // For identical feet there's no chord, so bulge straight out along that averaged normal.
  let u: Pt;
  if (chord < 1e-6) {
    u = { x: avg.x / avgLen, y: avg.y / avgLen };
  } else {
    const perp = { x: -(b.y - a.y), y: b.x - a.x };
    const pl = Math.hypot(perp.x, perp.y);
    const sign = (perp.x * avg.x + perp.y * avg.y) >= 0 ? 1 : -1;
    u = { x: (perp.x / pl) * sign, y: (perp.y / pl) * sign };
  }
  const c = { x: mid.x + u.x * h, y: mid.y + u.y * h };
  const pts: Pt[] = [];

  if (chord < 1e-6) {
    // Identical feet → a full ring with a small gap (holding the arrowhead) facing the shape.
    const base = Math.atan2(a.y - c.y, a.x - c.x);
    const gap = 0.42;
    for (let i = 0; i <= SELF_LOOP_SAMPLES; i++) {
      const ang = base + gap + ((Math.PI * 2 - 2 * gap) * i) / SELF_LOOP_SAMPLES;
      pts.push({ x: c.x + Math.cos(ang) * r, y: c.y + Math.sin(ang) * r });
    }
    return pts;
  }

  // Major arc from a to b, sweeping the direction that passes the outward apex (mid + u*(h+r)).
  const angA = Math.atan2(a.y - c.y, a.x - c.x);
  const angB = Math.atan2(b.y - c.y, b.x - c.x);
  const apex = Math.atan2(mid.y + u.y * (h + r) - c.y, mid.x + u.x * (h + r) - c.x);
  const norm = (x: number): number => {
    let v = x;
    while (v <= -Math.PI) v += Math.PI * 2;
    while (v > Math.PI) v -= Math.PI * 2;
    return v;
  };
  let ccw = norm(angB - angA);
  if (ccw < 0) ccw += Math.PI * 2;
  let apexRel = norm(apex - angA);
  if (apexRel < 0) apexRel += Math.PI * 2;
  const sweep = apexRel <= ccw ? ccw : -(Math.PI * 2 - ccw);
  for (let i = 0; i <= SELF_LOOP_SAMPLES; i++) {
    const ang = angA + (sweep * i) / SELF_LOOP_SAMPLES;
    pts.push({ x: c.x + Math.cos(ang) * r, y: c.y + Math.sin(ang) * r });
  }
  return pts;
}

/** A loop that routes strictly *outside* a padded bounding box, so it never cuts the body for
 * any pair of feet on any aspect ratio. Each foot is pushed out along its border normal, the
 * two points are joined by walking the shorter way around the box (through 0/1/2 outer corners),
 * and that polyline is smoothed with a Catmull-Rom spline whose endpoint tangents leave the tail
 * outward and drive the head inward (arrowhead re-enters). Used when a clean circle would overlap. */
function selfLoopRoute(s: Shape, a: Pt, b: Pt, na: Pt, nb: Pt): Pt[] {
  const dim = Math.min(s.w, s.h);
  const pad = Math.max(22, Math.min(dim * 0.6, 52));
  const L = s.x - pad;
  const T = s.y - pad;
  const R = s.x + s.w + pad;
  const B = s.y + s.h + pad;
  const W = R - L;
  const H = B - T;
  const P = 2 * (W + H);
  const wa = { x: a.x + na.x * pad, y: a.y + na.y * pad };
  const wb = { x: b.x + nb.x * pad, y: b.y + nb.y * pad };
  // Perimeter coordinate of a point on the padded box, measured clockwise from top-left.
  const param = (p: Pt): number => {
    if (Math.abs(p.y - T) < 1e-6) return p.x - L; // top edge
    if (Math.abs(p.x - R) < 1e-6) return W + (p.y - T); // right edge
    if (Math.abs(p.y - B) < 1e-6) return W + H + (R - p.x); // bottom edge
    return 2 * W + H + (B - p.y); // left edge
  };
  const corners: { t: number; p: Pt }[] = [
    { t: 0, p: { x: L, y: T } },
    { t: W, p: { x: R, y: T } },
    { t: W + H, p: { x: R, y: B } },
    { t: 2 * W + H, p: { x: L, y: B } },
  ];
  const ta = param(wa);
  const tb = param(wb);
  const cwDist = (((tb - ta) % P) + P) % P;
  const cw = cwDist <= P - cwDist; // walk the shorter way around
  const dist = cw ? cwDist : P - cwDist;
  const between: { d: number; p: Pt }[] = [];
  for (const cn of corners) {
    const relCw = (((cn.t - ta) % P) + P) % P;
    const d = cw ? relCw : P - relCw;
    if (d > 1e-6 && d < dist - 1e-6) between.push({ d, p: cn.p });
  }
  between.sort((x, y) => x.d - y.d);

  const main: Pt[] = [a, wa, ...between.map((c) => c.p), wb, b];
  const pa = { x: a.x - na.x * pad, y: a.y - na.y * pad };
  const pb = { x: b.x - nb.x * pad, y: b.y - nb.y * pad };
  const ctrl = [pa, ...main, pb];
  const segs = main.length - 1;
  const steps = Math.max(2, Math.round(SELF_LOOP_SAMPLES / segs));
  const pts: Pt[] = [];
  for (let sgi = 0; sgi < segs; sgi++) {
    const p0 = ctrl[sgi];
    const p1 = ctrl[sgi + 1];
    const p2 = ctrl[sgi + 2];
    const p3 = ctrl[sgi + 3];
    for (let i = sgi === 0 ? 0 : 1; i <= steps; i++) pts.push(catmullRom(p0, p1, p2, p3, i / steps));
  }
  return pts;
}

/** Point list for a self-loop, sampled into a polyline so it shares the connector
 * rendering/hit-test/label/export path. The loop leaves the shape at `from`'s anchor
 * (tail) and re-enters at `to`'s anchor (arrow head), each anchor resolved from its
 * bbox-normalized coords so the whole loop follows the shape on move and resize.
 *
 * Prefers a clean circle (selfLoopCircle) and keeps it whenever it stays outside the body
 * within a sub-stroke tolerance — true for same-edge, adjacent-edge, and most feet. When a
 * circle would cut through (opposite edges, or awkward corner feet on a lopsided shape) it
 * falls back to the guaranteed-outside routed loop (selfLoopRoute). */
export function selfLoopPath(s: Shape, from: Endpoint, to: Endpoint): Pt[] {
  const a = selfLoopAnchor(s, from);
  const b = selfLoopAnchor(s, to);
  const na = footNormal(from);
  const nb = footNormal(to);
  const circle = selfLoopCircle(s, a, b, na, nb);
  if (circle && circle.every((p) => insideDepth(s, p) <= SELF_LOOP_INSIDE_TOL)) return circle;
  return selfLoopRoute(s, a, b, na, nb);
}

/** Full ordered point list for drawing/hit-testing: self-loop, straight, orthogonal-routed, or manual waypoints. */
export function connectorPath(doc: Doc, c: Connector): Pt[] {
  if (isSelfLoop(c)) {
    const s = c.from.shapeId ? findShape(doc, c.from.shapeId) : undefined;
    if (s) return selfLoopPath(s, c.from, c.to);
  }
  const from = resolveEndpoint(doc, c.from);
  const to = resolveEndpoint(doc, c.to);
  if (c.waypoints && c.waypoints.length) {
    const first = c.waypoints[0];
    const last = c.waypoints[c.waypoints.length - 1];
    return [endpointFoot(c.from, from, first), ...c.waypoints, endpointFoot(c.to, to, last)];
  }
  if (c.routing === 'orthogonal') {
    const dx = to.p.x - from.p.x;
    const dy = to.p.y - from.p.y;
    const ratio = c.elbowRatio ?? 0.5;
    let bend: [Pt, Pt];
    if (Math.abs(dx) >= Math.abs(dy)) {
      const midX = from.p.x + dx * ratio;
      bend = [{ x: midX, y: from.p.y }, { x: midX, y: to.p.y }];
    } else {
      const midY = from.p.y + dy * ratio;
      bend = [{ x: from.p.x, y: midY }, { x: to.p.x, y: midY }];
    }
    return [endpointFoot(c.from, from, bend[0]), ...bend, endpointFoot(c.to, to, bend[1])];
  }
  return [endpointFoot(c.from, from, to.p), endpointFoot(c.to, to, from.p)];
}

/** Point to anchor a connector's label at, and which side of it the text should grow
 * from: the midpoint of the path's middle segment, nudged off the line so the text
 * doesn't sit on top of the stroke (mirrors how the label is rendered, and where
 * `n`/`N` search-jump lands). For a horizontal segment the label centers above it, same
 * as always. For a vertical segment — just as common as horizontal in an orthogonal
 * elbow — centering horizontally on the line would still cross it once the label is
 * more than a couple characters wide, so the label instead starts to the right of the
 * line and grows away from it. */
export function connectorLabelPos(doc: Doc, c: Connector): Pt & { anchor: 'middle' | 'start' } {
  const LABEL_GAP = 10;
  const path = connectorPath(doc, c);
  const mid = path[Math.floor((path.length - 1) / 2)];
  const midNext = path[Math.floor((path.length - 1) / 2) + 1] ?? mid;
  const cx = (mid.x + midNext.x) / 2;
  const cy = (mid.y + midNext.y) / 2;
  if (Math.abs(midNext.x - mid.x) < Math.abs(midNext.y - mid.y)) {
    return { x: cx + LABEL_GAP, y: cy, anchor: 'start' };
  }
  return { x: cx, y: cy - 12, anchor: 'middle' };
}

/** Point on the border of a shape along the ray from its center toward `toward`. */
export function borderPoint(s: Shape, toward: Pt): Pt {
  if (s.kind === 'triangle') {
    const verts = triangleVertices(s);
    const ox = (verts[0].x + verts[1].x + verts[2].x) / 3;
    const oy = (verts[0].y + verts[1].y + verts[2].y) / 3;
    const dx = toward.x - ox;
    const dy = toward.y - oy;
    if (dx === 0 && dy === 0) return { x: ox, y: oy };
    return rayPolygonBorder({ x: ox, y: oy }, { x: dx, y: dy }, verts) ?? { x: ox, y: oy };
  }
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  if (s.kind === 'ellipse') {
    const rx = s.w / 2;
    const ry = s.h / 2;
    const t = 1 / Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
    return { x: cx + dx * t, y: cy + dy * t };
  }
  if (s.kind === 'diamond') {
    const rx = s.w / 2;
    const ry = s.h / 2;
    const denom = Math.abs(dx) / rx + Math.abs(dy) / ry;
    const t = denom === 0 ? 0 : 1 / denom;
    return { x: cx + dx * t, y: cy + dy * t };
  }
  const sx = dx !== 0 ? s.w / 2 / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? s.h / 2 / Math.abs(dy) : Infinity;
  const t = Math.min(sx, sy);
  return { x: cx + dx * t, y: cy + dy * t };
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = a.x + vx * t;
  const qy = a.y + vy * t;
  return Math.hypot(p.x - qx, p.y - qy);
}

/** Translate selected shapes; selected connectors move their free endpoints. */
export function translateItems(doc: Doc, ids: string[], dx: number, dy: number): Doc {
  const sel = new Set(ids);
  return {
    shapes: doc.shapes.map((s) => (sel.has(s.id) ? { ...s, x: s.x + dx, y: s.y + dy } : s)),
    connectors: doc.connectors.map((c) => {
      if (!sel.has(c.id)) return c;
      const move = (e: Endpoint): Endpoint => (e.shapeId ? e : { x: e.x + dx, y: e.y + dy });
      return { ...c, from: move(c.from), to: move(c.to) };
    }),
  };
}

/**
 * Ids of `ids` plus every shape "contained" by a frame among them. A plain shape counts as
 * contained when its center lies inside the frame's rect; a nested *frame* must sit ENTIRELY
 * inside (all four corners within), so a frame that merely overlaps the edge of the one being
 * moved is left behind instead of dragged along. Composes for nested frames — a frame found
 * this way is itself queued, so its own contents (and any frame nested inside *that*) get
 * pulled in too.
 *
 * There's no persistent parent/child bookkeeping: membership is recomputed fresh from `doc`
 * every time this is called. Callers pass the doc snapshot from the
 * *start* of a move gesture (mouse drag's frozen `base`, or the current doc for an atomic
 * keyboard nudge) so a single continuous move only decides membership once, instead of shapes
 * potentially entering/leaving the (moving) frame's rect mid-gesture.
 */
export function frameContainedIds(doc: Doc, ids: string[]): string[] {
  const result = new Set(ids);
  const queue = ids.filter((id) => findShape(doc, id)?.kind === 'frame');
  while (queue.length) {
    const frame = findShape(doc, queue.shift() as string);
    if (!frame) continue;
    for (const s of doc.shapes) {
      if (result.has(s.id)) continue;
      const contained =
        s.kind === 'frame'
          ? // A nested frame is pulled along only when it sits entirely inside.
            s.x >= frame.x &&
            s.y >= frame.y &&
            s.x + s.w <= frame.x + frame.w &&
            s.y + s.h <= frame.y + frame.h
          : // A plain shape counts as inside when its center is within the rect.
            (() => {
              const cx = s.x + s.w / 2;
              const cy = s.y + s.h / 2;
              return (
                cx >= frame.x && cx <= frame.x + frame.w && cy >= frame.y && cy <= frame.y + frame.h
              );
            })();
      if (contained) {
        result.add(s.id);
        if (s.kind === 'frame') queue.push(s.id);
      }
    }
  }
  return [...result];
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function segsIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const cross = (o: Pt, p: Pt, q: Pt) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

function segIntersectsRect(a: Pt, b: Pt, r: Rect): boolean {
  const inside = (p: Pt) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  if (inside(a) || inside(b)) return true;
  const corners = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
  for (let i = 0; i < 4; i++) {
    if (segsIntersect(a, b, corners[i], corners[(i + 1) % 4])) return true;
  }
  return false;
}

/** Ids of shapes and connectors touching the rectangle (marquee selection). */
export function itemsInRect(doc: Doc, r: Rect): string[] {
  const ids: string[] = [];
  for (const s of doc.shapes) {
    if (s.x < r.x + r.w && s.x + s.w > r.x && s.y < r.y + r.h && s.y + s.h > r.y) ids.push(s.id);
  }
  for (const c of doc.connectors) {
    const path = connectorPath(doc, c);
    for (let j = 0; j < path.length - 1; j++) {
      if (segIntersectsRect(path[j], path[j + 1], r)) {
        ids.push(c.id);
        break;
      }
    }
  }
  return ids;
}

export function addShape(doc: Doc, s: Shape): Doc {
  return { ...doc, shapes: [...doc.shapes, s] };
}

export function addConnector(doc: Doc, c: Connector): Doc {
  return { ...doc, connectors: [...doc.connectors, c] };
}

export function updateShape(doc: Doc, id: string, patch: Partial<Shape>): Doc {
  return { ...doc, shapes: doc.shapes.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
}

/** Re-point one end of a connector, binding it to a shape or a fixed point. */
export function setConnectorEndpoint(doc: Doc, id: string, end: 'from' | 'to', endpoint: Endpoint): Doc {
  return {
    ...doc,
    connectors: doc.connectors.map((c) => (c.id === id ? { ...c, [end]: endpoint } : c)),
  };
}

export type ReorderDir = 'front' | 'back' | 'forward' | 'backward';
export type ReorderStepDir = 'forward' | 'backward';

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Whether two connectors' paths actually cross — unlike a bounding-box check, two arrows
 * that pass near each other without crossing (e.g. a shallow "V") won't false-positive. */
function connectorsIntersect(doc: Doc, a: Connector, b: Connector): boolean {
  const pathA = connectorPath(doc, a);
  const pathB = connectorPath(doc, b);
  for (let i = 0; i < pathA.length - 1; i++) {
    for (let j = 0; j < pathB.length - 1; j++) {
      if (segsIntersect(pathA[i], pathA[i + 1], pathB[j], pathB[j + 1])) return true;
    }
  }
  return false;
}

/** Move one slot toward the front/back, jumping past unselected neighbors that don't
 * visually overlap the moved item (a swap with a non-overlapping neighbor would be
 * invisible) and stopping at another selected item (keeps a selected block together). */
function stepReorder<T extends { id: string }>(
  arr: T[],
  idSet: Set<string>,
  dir: ReorderStepDir,
  overlaps: (a: T, b: T) => boolean,
): { result: T[]; changed: boolean } {
  const a = [...arr];
  let changed = false;
  if (dir === 'forward') {
    for (let i = a.length - 2; i >= 0; i--) {
      if (!idSet.has(a[i].id)) continue;
      let j = i + 1;
      while (j < a.length && !idSet.has(a[j].id) && !overlaps(a[i], a[j])) j++;
      if (j < a.length && !idSet.has(a[j].id)) {
        const item = a[i];
        for (let k = i; k < j; k++) a[k] = a[k + 1];
        a[j] = item;
        changed = true;
      }
    }
  } else {
    for (let i = 1; i < a.length; i++) {
      if (!idSet.has(a[i].id)) continue;
      let j = i - 1;
      while (j >= 0 && !idSet.has(a[j].id) && !overlaps(a[i], a[j])) j--;
      if (j >= 0 && !idSet.has(a[j].id)) {
        const item = a[i];
        for (let k = i; k > j; k--) a[k] = a[k - 1];
        a[j] = item;
        changed = true;
      }
    }
  }
  return { result: a, changed };
}

/** Move shapes/connectors within their own draw-order array: to the front/back,
 * or one slot toward the front/back. The step directions only swap past a neighbor
 * that actually overlaps the moved item, since stepping past a non-overlapping one
 * would change the stored order without changing anything on screen. */
export function reorderItems(doc: Doc, ids: string[], dir: ReorderDir): Doc {
  const idSet = new Set(ids);
  if (dir === 'front' || dir === 'back') {
    const reorder = <T extends { id: string }>(arr: T[]): T[] => {
      const sel = arr.filter((x) => idSet.has(x.id));
      if (!sel.length) return arr;
      const rest = arr.filter((x) => !idSet.has(x.id));
      return dir === 'front' ? [...rest, ...sel] : [...sel, ...rest];
    };
    return { shapes: reorder(doc.shapes), connectors: reorder(doc.connectors) };
  }
  const shapesOverlap = (a: Shape, b: Shape) => rectsOverlap(a, b);
  const connectorsOverlap = (a: Connector, b: Connector) => connectorsIntersect(doc, a, b);
  return {
    shapes: stepReorder(doc.shapes, idSet, dir, shapesOverlap).result,
    connectors: stepReorder(doc.connectors, idSet, dir, connectorsOverlap).result,
  };
}

/** Whether a 'forward'/'backward' REORDER would actually move anything, i.e. whether
 * any item in `ids` overlaps a neighbor it could swap with. Used to hide the menu
 * action when there's nothing for it to visibly do. */
export function canReorderStep(doc: Doc, ids: string[], dir: ReorderStepDir): boolean {
  const idSet = new Set(ids);
  if (!idSet.size) return false;
  const shapesOverlap = (a: Shape, b: Shape) => rectsOverlap(a, b);
  const connectorsOverlap = (a: Connector, b: Connector) => connectorsIntersect(doc, a, b);
  return (
    stepReorder(doc.shapes, idSet, dir, shapesOverlap).changed ||
    stepReorder(doc.connectors, idSet, dir, connectorsOverlap).changed
  );
}

/** Bounding box of a subset of shapes (used for group resize). */
export function bboxOf(doc: Doc, ids: string[]): { x: number; y: number; w: number; h: number } | null {
  const idSet = new Set(ids);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of doc.shapes) {
    if (!idSet.has(s.id)) continue;
    minX = Math.min(minX, s.x);
    minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x + s.w);
    maxY = Math.max(maxY, s.y + s.h);
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Scale shapes in `ids` proportionally around `anchor` (top-left), from `origW`x`origH` to `newW`x`newH`.
 * For a single shape with anchor = its own x/y this reduces to a direct w/h resize. */
export function scaleShapes(
  doc: Doc,
  ids: string[],
  newW: number,
  newH: number,
  anchor: Pt,
  origW: number,
  origH: number,
): Doc {
  const idSet = new Set(ids);
  const sx = origW > 0 ? newW / origW : 1;
  const sy = origH > 0 ? newH / origH : 1;
  return {
    ...doc,
    shapes: doc.shapes.map((s) => {
      if (!idSet.has(s.id)) return s;
      return {
        ...s,
        x: anchor.x + (s.x - anchor.x) * sx,
        y: anchor.y + (s.y - anchor.y) * sy,
        w: Math.max(GRID, s.w * sx),
        h: Math.max(GRID, s.h * sy),
      };
    }),
  };
}

export type AlignEdge = 'left' | 'center-h' | 'right' | 'top' | 'center-v' | 'bottom';

/** Align shapes among `ids` to a common edge/center of their combined bounding box.
 * Connectors in `ids` are ignored (they have no independent x/y/w/h); any connector
 * bound to a moved shape follows it automatically since endpoints resolve live. */
export function alignShapes(doc: Doc, ids: string[], edge: AlignEdge): Doc {
  const idSet = new Set(ids);
  const box = bboxOf(doc, ids);
  if (!box) return doc;
  return {
    ...doc,
    shapes: doc.shapes.map((s) => {
      if (!idSet.has(s.id)) return s;
      switch (edge) {
        case 'left':
          return { ...s, x: box.x };
        case 'center-h':
          return { ...s, x: box.x + box.w / 2 - s.w / 2 };
        case 'right':
          return { ...s, x: box.x + box.w - s.w };
        case 'top':
          return { ...s, y: box.y };
        case 'center-v':
          return { ...s, y: box.y + box.h / 2 - s.h / 2 };
        case 'bottom':
          return { ...s, y: box.y + box.h - s.h };
      }
    }),
  };
}

export type DistributeAxis = 'h' | 'v';

/** Distribute shapes among `ids` evenly along `axis` ('h' = horizontal, 'v' = vertical).
 * Sorts by bbox center along the axis, leaves the first and last shape (in that sorted order)
 * exactly where they are, and spaces the shapes in between so the GAPS between adjacent
 * bounding boxes are equal — the "distribute horizontally/vertically" semantics used by
 * Figma/PowerPoint, which reads as evenly spaced even when the shapes have different sizes
 * (unlike spacing centers evenly, which visually bunches up larger shapes). If the shapes
 * overlap enough that the total gap budget would be negative, that gap-based layout has no
 * well-defined solution, so this falls back to equal center-to-center spacing instead (still
 * anchored on the first/last shape's original center). No-op with fewer than 3 shapes among
 * `ids` (need at least one to actually move for "distribute" to mean anything). Mirrors
 * alignShapes: connectors in `ids` are ignored (bound connectors follow their shape
 * automatically since endpoints resolve live; free-floating ones are left as-is), and a
 * shape's group membership doesn't change how it's handled — each shape moves independently. */
export function distributeShapes(doc: Doc, ids: string[], axis: DistributeAxis): Doc {
  const idSet = new Set(ids);
  const targets = doc.shapes.filter((s) => idSet.has(s.id));
  if (targets.length < 3) return doc;

  const pos = (s: Shape) => (axis === 'h' ? s.x : s.y);
  const size = (s: Shape) => (axis === 'h' ? s.w : s.h);
  const center = (s: Shape) => pos(s) + size(s) / 2;

  const sorted = [...targets].sort((a, b) => center(a) - center(b));
  const n = sorted.length;
  const first = sorted[0];
  const last = sorted[n - 1];

  const span = pos(last) + size(last) - pos(first);
  const sumSizes = sorted.reduce((sum, s) => sum + size(s), 0);
  const gap = (span - sumSizes) / (n - 1);

  const newPos = new Map<string, number>();
  if (gap >= 0) {
    // Gap-based: equal empty space between adjacent bounding boxes.
    let cursor = pos(first) + size(first) + gap;
    for (let i = 1; i < n - 1; i++) {
      newPos.set(sorted[i].id, cursor);
      cursor += size(sorted[i]) + gap;
    }
  } else {
    // Negative gap budget (overlapping shapes): fall back to equal center spacing.
    const firstCenter = center(first);
    const lastCenter = center(last);
    const step = (lastCenter - firstCenter) / (n - 1);
    for (let i = 1; i < n - 1; i++) {
      newPos.set(sorted[i].id, firstCenter + step * i - size(sorted[i]) / 2);
    }
  }

  return {
    ...doc,
    shapes: doc.shapes.map((s) => {
      const p = newPos.get(s.id);
      if (p === undefined) return s;
      return axis === 'h' ? { ...s, x: p } : { ...s, y: p };
    }),
  };
}

/** All shape/connector ids sharing a groupId. */
export function groupMembers(doc: Doc, groupId: string): string[] {
  const ids: string[] = [];
  for (const s of doc.shapes) if (s.groupId === groupId) ids.push(s.id);
  for (const c of doc.connectors) if (c.groupId === groupId) ids.push(c.id);
  return ids;
}

/** The groupId of a shape or connector, if any. */
export function groupIdOf(doc: Doc, id: string): string | undefined {
  return findShape(doc, id)?.groupId ?? findConnector(doc, id)?.groupId;
}

/** World-space position and free axis of an orthogonal connector's bend
 * handle (the midpoint of its bend segment); undefined if the connector
 * isn't using elbowed auto-routing (straight, or overridden by `waypoints`). */
export function connectorElbowHandle(doc: Doc, c: Connector): { pos: Pt; axis: 'x' | 'y' } | undefined {
  if (c.routing !== 'orthogonal' || (c.waypoints && c.waypoints.length)) return undefined;
  const from = resolveEndpoint(doc, c.from);
  const to = resolveEndpoint(doc, c.to);
  const dx = to.p.x - from.p.x;
  const dy = to.p.y - from.p.y;
  const ratio = c.elbowRatio ?? 0.5;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return { pos: { x: from.p.x + dx * ratio, y: (from.p.y + to.p.y) / 2 }, axis: 'x' };
  }
  return { pos: { x: (from.p.x + to.p.x) / 2, y: from.p.y + dy * ratio }, axis: 'y' };
}

/** Update an orthogonal connector's bend ratio from a dragged world point,
 * re-deriving it along whichever axis the bend currently runs on. */
export function setConnectorElbowRatio(doc: Doc, id: string, p: Pt): Doc {
  const c = findConnector(doc, id);
  if (!c) return doc;
  const from = resolveEndpoint(doc, c.from);
  const to = resolveEndpoint(doc, c.to);
  const dx = to.p.x - from.p.x;
  const dy = to.p.y - from.p.y;
  const useX = Math.abs(dx) >= Math.abs(dy);
  const raw = useX ? (dx === 0 ? 0.5 : (p.x - from.p.x) / dx) : dy === 0 ? 0.5 : (p.y - from.p.y) / dy;
  const ratio = Math.max(0, Math.min(1, raw));
  return {
    ...doc,
    connectors: doc.connectors.map((x) => (x.id === id ? { ...x, elbowRatio: ratio } : x)),
  };
}

/** Move (or add) one bend point of a connector. */
export function setConnectorWaypoint(doc: Doc, id: string, index: number, p: Pt): Doc {
  return {
    ...doc,
    connectors: doc.connectors.map((c) => {
      if (c.id !== id || !c.waypoints) return c;
      const waypoints = c.waypoints.slice();
      waypoints[index] = p;
      return { ...c, waypoints };
    }),
  };
}

/** Insert a new bend point into the segment of `connectorPath` nearest to `p`. */
export function insertConnectorWaypoint(doc: Doc, id: string, p: Pt): Doc {
  const c = findConnector(doc, id);
  if (!c) return doc;
  const path = connectorPath(doc, c);
  let bestSeg = 0;
  let bestDist = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const d = distToSegment(p, path[i], path[i + 1]);
    if (d < bestDist) {
      bestDist = d;
      bestSeg = i;
    }
  }
  // bestSeg indexes into `path` (border points + existing waypoints); the new
  // waypoint's index within c.waypoints is bestSeg (path[0] is the border, not a waypoint).
  const waypoints = (c.waypoints ?? []).slice();
  waypoints.splice(bestSeg, 0, p);
  return {
    ...doc,
    connectors: doc.connectors.map((x) => (x.id === id ? { ...x, waypoints } : x)),
  };
}

/** Remove all manual bend points from a connector. */
export function clearConnectorWaypoints(doc: Doc, id: string): Doc {
  return {
    ...doc,
    connectors: doc.connectors.map((c) => (c.id === id ? { ...c, waypoints: undefined } : c)),
  };
}

/** Delete a shape (and connectors bound to it) or a connector. */
export function deleteItem(doc: Doc, id: string): Doc {
  if (doc.shapes.some((s) => s.id === id)) {
    return {
      shapes: doc.shapes.filter((s) => s.id !== id),
      connectors: doc.connectors.filter((c) => c.from.shapeId !== id && c.to.shapeId !== id),
    };
  }
  return { ...doc, connectors: doc.connectors.filter((c) => c.id !== id) };
}

export function docBounds(doc: Doc): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of doc.shapes) {
    minX = Math.min(minX, s.x);
    minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x + s.w);
    maxY = Math.max(maxY, s.y + s.h);
  }
  for (const c of doc.connectors) {
    for (const e of [c.from, c.to]) {
      if (!e.shapeId) {
        minX = Math.min(minX, e.x);
        minY = Math.min(minY, e.y);
        maxX = Math.max(maxX, e.x);
        maxY = Math.max(maxY, e.y);
      }
    }
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Doc containing only the shapes/connectors in `ids` (e.g. for exporting just the current
 * selection). Mirrors yankSelection's rule: a connector bound to selected shapes at both
 * ends comes along even if it wasn't selected itself. A selected connector pulls in its
 * bound shapes even if they weren't selected themselves, so it still resolves to their live
 * position instead of its stale fallback x/y, and so those shapes count toward the exported
 * bounds. */
export function subsetDoc(doc: Doc, ids: string[]): Doc {
  const idSet = new Set(ids);
  const connectors = doc.connectors.filter(
    (c) =>
      idSet.has(c.id) ||
      (!!c.from.shapeId && !!c.to.shapeId && idSet.has(c.from.shapeId) && idSet.has(c.to.shapeId)),
  );
  const shapeIds = new Set(ids);
  for (const c of connectors) {
    if (c.from.shapeId) shapeIds.add(c.from.shapeId);
    if (c.to.shapeId) shapeIds.add(c.to.shapeId);
  }
  return {
    shapes: doc.shapes.filter((s) => shapeIds.has(s.id)),
    connectors,
  };
}

let measureCtx: CanvasRenderingContext2D | null = null;

/** Approximate pixel size of a (possibly multi-line) label at the given font size (default 'm' = 14px). */
export function measureLabel(label: string, fontSize?: FontSize): { w: number; h: number } {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d');
  }
  const px = FONT_SIZE_PX[fontSize ?? 'm'];
  const lines = label.split('\n');
  let w = 0;
  if (measureCtx) {
    measureCtx.font = `${px}px system-ui, sans-serif`;
    for (const line of lines) w = Math.max(w, measureCtx.measureText(line).width);
  } else {
    for (const line of lines) w = Math.max(w, line.length * px);
  }
  return { w: Math.ceil(w), h: lines.length * FONT_LINE_H[fontSize ?? 'm'] };
}
