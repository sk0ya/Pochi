import { distToSegment, triangleVertices } from './doc';
import { FREEDRAW_RES } from './types';
import type { Pt, TriangleDirection } from './types';

export type SketchResult =
  | { kind: 'rect' | 'ellipse' | 'diamond'; x: number; y: number; w: number; h: number }
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
 * - closed stroke (path a bit longer than the bbox diagonal — a corner or two is
 *   enough, and the ends need not come anywhere near the start) -> rect, ellipse,
 *   triangle, or diamond, whichever border the points hug closer (triangle
 *   direction is whichever of the 8 candidates fits best)
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

  // Loose closure: a stroke counts as a closed shape once its path runs a bit
  // past the bbox diagonal (a corner or two — no need to trace all sides) and its
  // ends come back within most of the path length, so you don't have to return
  // anywhere near the start. The len > 1.25*diag guard is only there to reject a
  // straight-ish line (path ~= diagonal, ratio ~1.0), which would otherwise snap
  // to a degenerate shape; anything with a real bend gets recognized.
  const closed =
    endDist < Math.max(0.7 * len, 40) && len > 1.25 * diag && Math.min(w, h) > 12;

  if (!closed) {
    if (endDist < 16) return null; // scribble with no direction
    return { kind: 'line', a, b };
  }

  // Fit the shape kind to the stroke's interior, not its whole length. The lead-in
  // (and the seam where the stroke closes back onto its start) is the least reliable
  // part of a freehand loop: the pen starts with a short straight run, usually
  // tangent to what becomes a bbox edge, which reads as a flat rectangle side — and,
  // if it pokes past the shape, drags the bbox out of true. Dropping the leading ~14%
  // and trailing ~3% of points keeps that lead-in from voting a circle into a box.
  // Only the classification uses this trimmed span; the returned geometry still uses
  // the full-stroke bbox so the created shape matches what was drawn.
  const t0 = Math.floor(pts.length * 0.14);
  const t1 = Math.floor(pts.length * 0.03);
  const fit = pts.length - t0 - t1 >= 8 ? pts.slice(t0, pts.length - t1) : pts;
  let fMinX = Infinity, fMinY = Infinity, fMaxX = -Infinity, fMaxY = -Infinity;
  for (const p of fit) {
    fMinX = Math.min(fMinX, p.x);
    fMinY = Math.min(fMinY, p.y);
    fMaxX = Math.max(fMaxX, p.x);
    fMaxY = Math.max(fMaxY, p.y);
  }
  const fw = fMaxX - fMinX;
  const fh = fMaxY - fMinY;

  // Rect vs ellipse: mean distance of stroke points to the bbox border
  // vs to the inscribed ellipse.
  const cx = (fMinX + fMaxX) / 2;
  const cy = (fMinY + fMaxY) / 2;
  const rx = fw / 2 || 1;
  const ry = fh / 2 || 1;
  const minR = Math.min(rx, ry);
  let errRect = 0;
  let errEll = 0;
  for (const p of fit) {
    errRect += Math.min(p.x - fMinX, fMaxX - p.x, p.y - fMinY, fMaxY - p.y);
    const v = Math.sqrt(((p.x - cx) / rx) ** 2 + ((p.y - cy) / ry) ** 2);
    errEll += Math.abs(v - 1) * minR;
  }

  // Triangle: try all 8 apex directions and keep whichever hugs the stroke closest.
  let errTri = Infinity;
  let bestDir: TriangleDirection = 'up';
  for (const direction of TRIANGLE_DIRECTIONS) {
    const verts = triangleVertices({ x: fMinX, y: fMinY, w: fw, h: fh, direction });
    let err = 0;
    for (const p of fit) {
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

  // Diamond: distance to the four edges joining the bbox edge-midpoints
  // (top-right-bottom-left). A real diamond hugs these closely while a rect trace
  // sits ~min(w,h)/4 off them, so the two stay distinguishable.
  const dTop = { x: cx, y: fMinY };
  const dRight = { x: fMaxX, y: cy };
  const dBottom = { x: cx, y: fMaxY };
  const dLeft = { x: fMinX, y: cy };
  let errDia = 0;
  for (const p of fit) {
    errDia += Math.min(
      distToSegment(p, dTop, dRight),
      distToSegment(p, dRight, dBottom),
      distToSegment(p, dBottom, dLeft),
      distToSegment(p, dLeft, dTop),
    );
  }

  // Hand-drawn rectangles round their corners, and the corners are exactly where a
  // rect diverges most from its inscribed ellipse — so a clearly-cornered box's
  // ellipse error shrinks until it reads as a circle. Handicap the ellipse a little
  // so it only wins when it fits distinctly better: a true circle still has ~zero
  // error and wins easily, but a rounded rectangle keeps its corners. 1.2 is mild
  // enough to leave wobbly freehand circles as circles (the lead-in trim above does
  // most of that work) while still reclaiming clearly-cornered boxes.
  const ELLIPSE_HANDICAP = 1.2;
  const errEllAdj = errEll * ELLIPSE_HANDICAP;

  // Pick the closest-hugging candidate. Ties fall to the earlier (simpler) branch,
  // so triangle beats diamond and diamond beats rect/ellipse only when strictly better.
  const best = Math.min(errRect, errEllAdj, errTri, errDia);
  if (best === errTri) {
    return { kind: 'triangle', x: minX, y: minY, w, h, direction: bestDir };
  }
  if (best === errDia) {
    return { kind: 'diamond', x: minX, y: minY, w, h };
  }
  return { kind: best === errRect ? 'rect' : 'ellipse', x: minX, y: minY, w, h };
}
