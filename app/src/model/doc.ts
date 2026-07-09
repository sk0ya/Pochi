import { GRID } from './types';
import type { Connector, Doc, Endpoint, Pt, Shape, TriangleDirection } from './types';

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

export function shapeAt(doc: Doc, p: Pt): Shape | undefined {
  for (let i = doc.shapes.length - 1; i >= 0; i--) {
    const s = doc.shapes[i];
    if (p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h) return s;
  }
  return undefined;
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

export function resolveEndpoint(doc: Doc, e: Endpoint): { p: Pt; shape?: Shape } {
  const s = e.shapeId ? findShape(doc, e.shapeId) : undefined;
  if (s) return { p: { x: s.x + s.w / 2, y: s.y + s.h / 2 }, shape: s };
  return { p: { x: e.x, y: e.y } };
}

/** Visible segment of a connector, trimmed at shape borders (endpoints only; ignores routing/waypoints). */
export function connectorEnds(doc: Doc, c: Connector): [Pt, Pt] {
  const from = resolveEndpoint(doc, c.from);
  const to = resolveEndpoint(doc, c.to);
  let a = from.p;
  let b = to.p;
  if (from.shape) a = borderPoint(from.shape, to.p);
  if (to.shape) b = borderPoint(to.shape, from.p);
  return [a, b];
}

/** Full ordered point list for drawing/hit-testing: straight, orthogonal-routed, or manual waypoints. */
export function connectorPath(doc: Doc, c: Connector): Pt[] {
  const from = resolveEndpoint(doc, c.from);
  const to = resolveEndpoint(doc, c.to);
  if (c.waypoints && c.waypoints.length) {
    const first = c.waypoints[0];
    const last = c.waypoints[c.waypoints.length - 1];
    const a = from.shape ? borderPoint(from.shape, first) : from.p;
    const b = to.shape ? borderPoint(to.shape, last) : to.p;
    return [a, ...c.waypoints, b];
  }
  if (c.routing === 'orthogonal') {
    const dx = to.p.x - from.p.x;
    const dy = to.p.y - from.p.y;
    let bend: [Pt, Pt];
    if (Math.abs(dx) >= Math.abs(dy)) {
      const midX = from.p.x + dx / 2;
      bend = [{ x: midX, y: from.p.y }, { x: midX, y: to.p.y }];
    } else {
      const midY = from.p.y + dy / 2;
      bend = [{ x: from.p.x, y: midY }, { x: to.p.x, y: midY }];
    }
    const a = from.shape ? borderPoint(from.shape, bend[0]) : from.p;
    const b = to.shape ? borderPoint(to.shape, bend[1]) : to.p;
    return [a, ...bend, b];
  }
  let a = from.p;
  let b = to.p;
  if (from.shape) a = borderPoint(from.shape, to.p);
  if (to.shape) b = borderPoint(to.shape, from.p);
  return [a, b];
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

/** Move shapes/connectors within their own draw-order array: to the front/back,
 * or one slot toward the front/back (skipping past other selected items already adjacent). */
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
  const stepOnce = <T extends { id: string }>(arr: T[]): T[] => {
    const a = [...arr];
    if (dir === 'forward') {
      for (let i = a.length - 2; i >= 0; i--) {
        if (idSet.has(a[i].id) && !idSet.has(a[i + 1].id)) {
          [a[i], a[i + 1]] = [a[i + 1], a[i]];
        }
      }
    } else {
      for (let i = 1; i < a.length; i++) {
        if (idSet.has(a[i].id) && !idSet.has(a[i - 1].id)) {
          [a[i], a[i - 1]] = [a[i - 1], a[i]];
        }
      }
    }
    return a;
  };
  return { shapes: stepOnce(doc.shapes), connectors: stepOnce(doc.connectors) };
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

let measureCtx: CanvasRenderingContext2D | null = null;

/** Approximate pixel size of a (possibly multi-line) label at 14px. */
export function measureLabel(label: string): { w: number; h: number } {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d');
  }
  const lines = label.split('\n');
  let w = 0;
  if (measureCtx) {
    measureCtx.font = '14px system-ui, sans-serif';
    for (const line of lines) w = Math.max(w, measureCtx.measureText(line).width);
  } else {
    for (const line of lines) w = Math.max(w, line.length * 14);
  }
  return { w: Math.ceil(w), h: lines.length * 20 };
}
