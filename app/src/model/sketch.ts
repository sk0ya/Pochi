import type { Pt } from './types';

export type SketchResult =
  | { kind: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number }
  | { kind: 'line'; a: Pt; b: Pt }
  | null;

/**
 * Classify a freehand stroke as rect / ellipse / line(arrow).
 *
 * - closed stroke (ends near each other, path much longer than the bbox
 *   diagonal) -> rect or ellipse, whichever border the points hug closer
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
  return { kind: errRect <= errEll ? 'rect' : 'ellipse', x: minX, y: minY, w, h };
}
