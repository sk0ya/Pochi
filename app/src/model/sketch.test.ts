import { describe, expect, it } from 'vitest';
import { classifyStroke } from './sketch';
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
});
