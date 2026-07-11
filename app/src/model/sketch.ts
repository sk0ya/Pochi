import { distToSegment, triangleVertices } from './doc';
import { FREEDRAW_RES } from './types';
import type { Pt, TriangleDirection } from './types';

export type SketchResult =
  | { kind: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number }
  | { kind: 'triangle'; x: number; y: number; w: number; h: number; direction: TriangleDirection }
  | { kind: 'line'; a: Pt; b: Pt }
  | null;

const TRIANGLE_DIRECTIONS: TriangleDirection[] = [
  'up',
  'down',
  'left',
  'right',
  'up-left',
  'up-right',
  'down-left',
  'down-right',
];

/** Douglas-Peucker polyline simplification: keeps only points that deviate from
 * the straight line between their kept neighbors by more than `tolerance` px.
 * This is where most of a freedraw stroke's data-size reduction happens — a raw
 * mousemove stroke is hundreds of points, a simplified one typically dozens. */
export function simplifyStroke(pts: Pt[], tolerance: number): Pt[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(pts[i], pts[a], pts[b]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxD > tolerance) {
      keep[idx] = true;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Simplification tolerance (px) for pen strokes. 2px is invisible at normal zoom
 * and matches the quantization error of FREEDRAW_RES at typical shape sizes. */
const FREEDRAW_TOLERANCE = 2;

/** Convert a raw pen stroke into the persisted freedraw fields: integer bbox +
 * simplified, bbox-relative, quantized flat point list (see Shape.points).
 * Returns null for strokes too small to mean anything (an accidental dot). */
export function strokeToFreedraw(
  pts: Pt[],
): { x: number; y: number; w: number; h: number; points: number[] } | null {
  if (pts.length < 2) return null;
  const simplified = simplifyStroke(pts, FREEDRAW_TOLERANCE);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of simplified) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (Math.hypot(w, h) < 8) return null;
  const points: number[] = [];
  for (const p of simplified) {
    const qx = Math.round(((p.x - minX) / (w || 1)) * FREEDRAW_RES);
    const qy = Math.round(((p.y - minY) / (h || 1)) * FREEDRAW_RES);
    const n = points.length;
    // Quantization can collapse near-identical neighbors; storing dupes is pure waste.
    if (n >= 2 && points[n - 2] === qx && points[n - 1] === qy) continue;
    points.push(qx, qy);
  }
  if (points.length < 4) return null;
  return {
    x: Math.round(minX),
    y: Math.round(minY),
    w: Math.max(1, Math.round(w)),
    h: Math.max(1, Math.round(h)),
    points,
  };
}

/**
 * Classify a freehand stroke as rect / ellipse / triangle / line(arrow).
 *
 * - closed stroke (ends near each other, path much longer than the bbox
 *   diagonal) -> rect, ellipse, or triangle, whichever border the points hug
 *   closer (triangle direction is whichever of the 8 candidates fits best)
 * - open stroke -> line from first to last point
 */
export function classifyStroke(pts: Pt[]): SketchResult {
  if (pts.length < 2) return null;

  let len = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i > 0) len += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const a = pts[0];
  const b = pts[pts.length - 1];
  const endDist = Math.hypot(b.x - a.x, b.y - a.y);
  const w = maxX - minX;
  const h = maxY - minY;
  const diag = Math.hypot(w, h);
  if (len < 20 || diag < 8) return null;

  const closed =
    endDist < Math.max(0.3 * len, 24) && len > 1.6 * diag && Math.min(w, h) > 16;

  if (!closed) {
    if (endDist < 16) return null; // scribble with no direction
    return { kind: 'line', a, b };
  }

  // Rect vs ellipse: mean distance of stroke points to the bbox border
  // vs to the inscribed ellipse.
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = w / 2;
  const ry = h / 2;
  const minR = Math.min(rx, ry);
  let errRect = 0;
  let errEll = 0;
  for (const p of pts) {
    errRect += Math.min(p.x - minX, maxX - p.x, p.y - minY, maxY - p.y);
    const v = Math.sqrt(((p.x - cx) / rx) ** 2 + ((p.y - cy) / ry) ** 2);
    errEll += Math.abs(v - 1) * minR;
  }

  // Triangle: try all 8 apex directions and keep whichever hugs the stroke closest.
  let errTri = Infinity;
  let bestDir: TriangleDirection = 'up';
  for (const direction of TRIANGLE_DIRECTIONS) {
    const verts = triangleVertices({ x: minX, y: minY, w, h, direction });
    let err = 0;
    for (const p of pts) {
      err += Math.min(
        distToSegment(p, verts[0], verts[1]),
        distToSegment(p, verts[1], verts[2]),
        distToSegment(p, verts[2], verts[0]),
      );
    }
    if (err < errTri) {
      errTri = err;
      bestDir = direction;
    }
  }

  if (errTri <= errRect && errTri <= errEll) {
    return { kind: 'triangle', x: minX, y: minY, w, h, direction: bestDir };
  }
  return { kind: errRect <= errEll ? 'rect' : 'ellipse', x: minX, y: minY, w, h };
}
