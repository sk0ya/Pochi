import { describe, expect, it } from 'vitest';
import { freedrawPoints } from './doc';
import { classifyStroke, simplifyStroke, strokeToFreedraw } from './sketch';
import { FREEDRAW_RES } from './types';
import type { Pt } from './types';

/** Appends `n+1` evenly spaced points from (x1,y1) to (x2,y2) (inclusive) to `arr`. */
function pushLine(arr: Pt[], x1: number, y1: number, x2: number, y2: number, n: number): void {
  for (let i = 0; i <= n; i++) {
    arr.push({ x: x1 + (x2 - x1) * (i / n), y: y1 + (y2 - y1) * (i / n) });
  }
}

describe('classifyStroke', () => {
  it('returns null for a stroke shorter than the minimum length', () => {
    expect(classifyStroke([{ x: 0, y: 0 }, { x: 5, y: 5 }])).toBeNull();
  });

  it('returns null for a single point (fewer than 2 points)', () => {
    expect(classifyStroke([{ x: 0, y: 0 }])).toBeNull();
  });

  it('classifies an open, purposeful stroke as a line from first to last point', () => {
    const pts: Pt[] = [];
    pushLine(pts, 0, 0, 100, 50, 20);
    expect(classifyStroke(pts)).toEqual({ kind: 'line', a: { x: 0, y: 0 }, b: { x: 100, y: 50 } });
  });

  it('returns null for a scribble that neither closes nor travels far enough to imply a line direction', () => {
    // Wanders back and forth near the origin: long enough path (len ~65.8, which
    // even satisfies len > 1.6x the bbox diagonal ~48.2), but the bbox is too thin
    // to count as closed — min(w, h) = 3 fails the `min(w, h) > 16` gate — and the
    // start/end points end up too close together (<16) to imply a line.
    const pts: Pt[] = [];
    pushLine(pts, 0, 0, 30, 0, 3);
    pushLine(pts, 30, 0, 0, 0, 3);
    pushLine(pts, 0, 0, 5, 3, 2);
    expect(classifyStroke(pts)).toBeNull();
  });

  it('classifies a circular closed stroke as an ellipse', () => {
    const pts: Pt[] = [];
    const cx = 50, cy = 50, r = 40;
    for (let i = 0; i <= 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    expect(classifyStroke(pts)).toEqual({ kind: 'ellipse', x: 10, y: 10, w: 80, h: 80 });
  });

  it('classifies a traced rectangle outline as a rect with the traced bbox', () => {
    const pts: Pt[] = [];
    pushLine(pts, 0, 0, 100, 0, 10);
    pushLine(pts, 100, 0, 100, 60, 6);
    pushLine(pts, 100, 60, 0, 60, 10);
    pushLine(pts, 0, 60, 0, 0, 6);
    expect(classifyStroke(pts)).toEqual({ kind: 'rect', x: 0, y: 0, w: 100, h: 60 });
  });

  it('classifies a traced apex-up triangle outline as a triangle with the matching direction', () => {
    const pts: Pt[] = [];
    // Traces the exact 'up' triangle vertices for bbox (0,0,100,60): apex (50,0), (100,60), (0,60).
    pushLine(pts, 50, 0, 100, 60, 10);
    pushLine(pts, 100, 60, 0, 60, 10);
    pushLine(pts, 0, 60, 50, 0, 10);
    expect(classifyStroke(pts)).toEqual({ kind: 'triangle', x: 0, y: 0, w: 100, h: 60, direction: 'up' });
  });

  it('snaps a triangle traced as 3 sides even when the last corner is left open', () => {
    // Apex-up triangle for bbox (0,0,100,60), but the base is only traced back to
    // (60,60) — the stroke never returns to its (0,60) start, so endDist ~60. That
    // exceeds the old closure tolerance (~0.3*len) yet stays under the looser 0.5*len,
    // so loose Auto still recognizes the three drawn sides as a triangle.
    const pts: Pt[] = [];
    pushLine(pts, 0, 60, 50, 0, 10);
    pushLine(pts, 50, 0, 100, 60, 10);
    pushLine(pts, 100, 60, 60, 60, 4);
    expect(classifyStroke(pts)).toEqual({ kind: 'triangle', x: 0, y: 0, w: 100, h: 60, direction: 'up' });
  });

  it('keeps a circle a circle despite a straight lead-in at the start of the stroke', () => {
    // The pen "gets going" with a short straight run along the top before curving.
    // That flat lead-in sits on the bbox top edge and used to read as a rectangle
    // side, flipping the circle to a rect; the lead-in trim ignores it.
    const pts: Pt[] = [];
    pushLine(pts, 18, 0, 50, 0, 8); // straight lead-in along the top edge
    const cx = 50, cy = 50, r = 50;
    for (let i = 0; i <= 40; i++) {
      const a = -Math.PI / 2 + (i / 40) * Math.PI * 2;
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    expect(classifyStroke(pts)?.kind).toBe('ellipse');
  });

  it('keeps a rounded-corner rectangle a rect rather than snapping it to an ellipse', () => {
    // bbox (0,0,120,80) with ~16px corner cuts, like a hand-drawn box. The corners
    // are gone, which shrinks the ellipse-fit error, but the four straight edges must
    // still win as a rect.
    const pts: Pt[] = [];
    pushLine(pts, 16, 0, 104, 0, 12);
    pushLine(pts, 104, 0, 120, 16, 3);
    pushLine(pts, 120, 16, 120, 64, 8);
    pushLine(pts, 120, 64, 104, 80, 3);
    pushLine(pts, 104, 80, 16, 80, 12);
    pushLine(pts, 16, 80, 0, 64, 3);
    pushLine(pts, 0, 64, 0, 16, 8);
    pushLine(pts, 0, 16, 16, 0, 3);
    expect(classifyStroke(pts)).toEqual({ kind: 'rect', x: 0, y: 0, w: 120, h: 80 });
  });

  it('classifies a traced diamond outline as a diamond with the traced bbox', () => {
    const pts: Pt[] = [];
    // Traces the four edge-midpoint vertices of bbox (0,0,100,60): top (50,0),
    // right (100,30), bottom (50,60), left (0,30).
    pushLine(pts, 50, 0, 100, 30, 10);
    pushLine(pts, 100, 30, 50, 60, 10);
    pushLine(pts, 50, 60, 0, 30, 10);
    pushLine(pts, 0, 30, 50, 0, 10);
    expect(classifyStroke(pts)).toEqual({ kind: 'diamond', x: 0, y: 0, w: 100, h: 60 });
  });
});

describe('simplifyStroke', () => {
  it('collapses collinear points down to the two endpoints', () => {
    const pts: Pt[] = [];
    pushLine(pts, 0, 0, 100, 0, 50);
    expect(simplifyStroke(pts, 2)).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  });

  it('keeps a corner point that deviates beyond the tolerance', () => {
    const pts: Pt[] = [];
    pushLine(pts, 0, 0, 50, 50, 25);
    pushLine(pts, 50, 50, 100, 0, 25);
    const out = simplifyStroke(pts, 2);
    expect(out).toContainEqual({ x: 50, y: 50 });
    expect(out.length).toBeLessThan(pts.length / 4);
  });

  it('drops wobble smaller than the tolerance', () => {
    // A nearly straight line with ±1px noise: everything within tolerance 2 goes away.
    const pts: Pt[] = [];
    for (let i = 0; i <= 100; i++) pts.push({ x: i, y: i % 2 });
    expect(simplifyStroke(pts, 2).length).toBe(2);
  });
});

describe('strokeToFreedraw', () => {
  it('returns null for strokes too small to keep', () => {
    expect(strokeToFreedraw([{ x: 0, y: 0 }])).toBeNull();
    expect(strokeToFreedraw([{ x: 0, y: 0 }, { x: 3, y: 3 }])).toBeNull();
  });

  it('produces an integer bbox and quantized in-range points', () => {
    const pts: Pt[] = [];
    pushLine(pts, 10.4, 20.6, 110.4, 20.6, 20);
    pushLine(pts, 110.4, 20.6, 110.4, 80.6, 20);
    const res = strokeToFreedraw(pts)!;
    expect(res).not.toBeNull();
    for (const v of [res.x, res.y, res.w, res.h, ...res.points]) {
      expect(Number.isInteger(v)).toBe(true);
    }
    expect(res.points.length % 2).toBe(0);
    for (const q of res.points) {
      expect(q).toBeGreaterThanOrEqual(0);
      expect(q).toBeLessThanOrEqual(FREEDRAW_RES);
    }
    // Simplification: the two straight runs collapse to 3 corners.
    expect(res.points.length).toBe(6);
  });

  it('round-trips through freedrawPoints within quantization error', () => {
    const pts: Pt[] = [];
    pushLine(pts, 0, 0, 200, 0, 10);
    pushLine(pts, 200, 0, 200, 100, 10);
    pushLine(pts, 200, 100, 0, 100, 10);
    const res = strokeToFreedraw(pts)!;
    const decoded = freedrawPoints(res);
    // Corners of the original stroke survive simplification; decoded positions
    // must land within the quantization step (bbox/RES) plus bbox rounding.
    const tolX = res.w / FREEDRAW_RES + 1;
    const tolY = res.h / FREEDRAW_RES + 1;
    const corners: Pt[] = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }];
    for (const c of corners) {
      const hit = decoded.some((p) => Math.abs(p.x - c.x) <= tolX && Math.abs(p.y - c.y) <= tolY);
      expect(hit).toBe(true);
    }
  });

  it('survives a perfectly horizontal stroke (zero-height bbox)', () => {
    const pts: Pt[] = [];
    pushLine(pts, 0, 50, 100, 50, 10);
    const res = strokeToFreedraw(pts)!;
    expect(res).not.toBeNull();
    expect(res.h).toBe(1); // clamped so the bbox stays usable
    const decoded = freedrawPoints(res);
    expect(decoded[0].y).toBeCloseTo(50, 0);
  });
});
