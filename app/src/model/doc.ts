import type { Connector, Doc, Endpoint, Pt, Shape } from './types';

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
    const [a, b] = connectorEnds(doc, c);
    if (distToSegment(p, a, b) < 8) return c;
  }
  return undefined;
}

export function findShape(doc: Doc, id: string): Shape | undefined {
  return doc.shapes.find((s) => s.id === id);
}

export function resolveEndpoint(doc: Doc, e: Endpoint): { p: Pt; shape?: Shape } {
  const s = e.shapeId ? findShape(doc, e.shapeId) : undefined;
  if (s) return { p: { x: s.x + s.w / 2, y: s.y + s.h / 2 }, shape: s };
  return { p: { x: e.x, y: e.y } };
}

/** Visible segment of a connector, trimmed at shape borders. */
export function connectorEnds(doc: Doc, c: Connector): [Pt, Pt] {
  const from = resolveEndpoint(doc, c.from);
  const to = resolveEndpoint(doc, c.to);
  let a = from.p;
  let b = to.p;
  if (from.shape) a = borderPoint(from.shape, to.p);
  if (to.shape) b = borderPoint(to.shape, from.p);
  return [a, b];
}

/** Point on the border of a shape along the ray from its center toward `toward`. */
export function borderPoint(s: Shape, toward: Pt): Pt {
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
    const [a, b] = connectorEnds(doc, c);
    if (segIntersectsRect(a, b, r)) ids.push(c.id);
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
