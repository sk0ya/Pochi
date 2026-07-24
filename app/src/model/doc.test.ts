import { describe, expect, it } from 'vitest';
import {
  borderPoint,
  canReorderStep,
  connectorElbowHandle,
  connectorPath,
  deleteItem,
  distributeShapes,
  distToSegment,
  FRAME_BORDER_BAND,
  frameBorderOrLabel,
  frameContainedIds,
  frameHitZone,
  inscribedBox,
  isSelfLoop,
  labelCenter,
  nearestSide,
  measureLabel,
  reorderItems,
  resizeAnchor,
  resolveEndpoint,
  scaleShapes,
  setConnectorElbowRatio,
  shapeAt,
  subsetDoc,
  translateItems,
  triangleVertices,
} from './doc';
import type { Connector, Doc, LoopSide, Shape } from './types';

// This suite runs under vitest's `node` environment (no DOM). `measureLabel` falls back to a
// character-count width estimate when it can't get a canvas 2D context, so a minimal `document`
// stub is enough to exercise it deterministically without pulling in jsdom (mirrors the same
// stub in state/reducer.test.ts).
if (typeof document === 'undefined') {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({ getContext: () => null }),
  };
}

const rect = (id: string, x: number, y: number, w: number, h: number, extra: Partial<Shape> = {}): Shape => ({
  id,
  kind: 'rect',
  x,
  y,
  w,
  h,
  label: '',
  ...extra,
});

const conn = (id: string, x1: number, y1: number, x2: number, y2: number): Connector => ({
  id,
  from: { x: x1, y: y1 },
  to: { x: x2, y: y2 },
  label: '',
});

const frame = (id: string, x: number, y: number, w: number, h: number): Shape => ({
  id,
  kind: 'frame',
  x,
  y,
  w,
  h,
  label: '',
});

describe('triangleVertices', () => {
  it('defaults to an isosceles triangle apex-up when direction is unset', () => {
    expect(triangleVertices({ x: 0, y: 0, w: 100, h: 50 })).toEqual([
      { x: 50, y: 0 },
      { x: 100, y: 50 },
      { x: 0, y: 50 },
    ]);
  });

  it('puts the right angle at the bbox corner for a diagonal direction', () => {
    expect(triangleVertices({ x: 0, y: 0, w: 100, h: 50, direction: 'down-right' })).toEqual([
      { x: 100, y: 50 },
      { x: 100, y: 0 },
      { x: 0, y: 50 },
    ]);
  });
});

describe('labelCenter', () => {
  it('uses the vertex centroid for triangles instead of the bbox center', () => {
    // apex-up triangle over a wide/short bbox: bbox center sits below the apex,
    // but the centroid averages all three vertices instead.
    const centroid = labelCenter({ x: 0, y: 0, w: 100, h: 50, kind: 'triangle', direction: 'up' });
    expect(centroid).toEqual({ x: 50, y: 100 / 3 });
    expect(centroid).not.toEqual({ x: 50, y: 25 }); // the bbox center, for contrast
  });
});

describe('inscribedBox', () => {
  it('inscribes a scaled-down rect for an ellipse (1/sqrt(2) of each axis, centered)', () => {
    const box = inscribedBox({ x: 0, y: 0, w: 100, h: 50, kind: 'ellipse' });
    expect(box.w).toBeCloseTo(70.71068, 4);
    expect(box.h).toBeCloseTo(35.35534, 4);
    expect(box.x).toBeCloseTo(14.64466, 4);
  });

  it('inscribes the middle quadrant for a diamond', () => {
    expect(inscribedBox({ x: 0, y: 0, w: 100, h: 80, kind: 'diamond' })).toEqual({ x: 25, y: 20, w: 50, h: 40 });
  });

  it('inscribes a half-size box against the base for a cardinal-direction triangle', () => {
    expect(inscribedBox({ x: 0, y: 0, w: 100, h: 80, kind: 'triangle', direction: 'right' })).toEqual({
      x: 0,
      y: 20,
      w: 50,
      h: 40,
    });
  });
});

describe('resizeAnchor', () => {
  it("anchors on the triangle's own apex vertex for a lone triangle", () => {
    const tri = rect('t1', 10, 20, 40, 30, { kind: 'triangle' });
    // default 'up' apex is the top-mid point of the bbox.
    expect(resizeAnchor([tri], { x: 10, y: 20, w: 40, h: 30 })).toEqual({ x: 30, y: 20 });
  });

  it('anchors on the bbox top-left for a multi-shape selection even if one is a triangle', () => {
    const tri = rect('t1', 10, 20, 40, 30, { kind: 'triangle' });
    const box = rect('r1', 0, 0, 5, 5);
    expect(resizeAnchor([tri, box], { x: 0, y: 0, w: 50, h: 50 })).toEqual({ x: 0, y: 0 });
  });
});

describe('borderPoint', () => {
  // All three shapes below share the same bbox and the same outward direction,
  // so the differing results demonstrate each shape's distinct border geometry.
  const toward = { x: 200, y: 200 };

  it('rect: exits through the edge crossed first by the ray from center', () => {
    const p = borderPoint(rect('r1', 0, 0, 100, 50), toward);
    expect(p.x).toBeCloseTo(71.42857, 4);
    expect(p.y).toBe(50);
  });

  it('ellipse: exits through the ellipse boundary (not the same point as the rect)', () => {
    const p = borderPoint(rect('e1', 0, 0, 100, 50, { kind: 'ellipse' }), toward);
    expect(p.x).toBeCloseTo(69.69596, 4);
    expect(p.y).toBeCloseTo(47.97863, 4);
  });

  it('diamond: exits through the diamond boundary (L1-normalized, not the same point as rect/ellipse)', () => {
    expect(borderPoint(rect('d1', 0, 0, 100, 50, { kind: 'diamond' }), toward)).toEqual({ x: 65, y: 42.5 });
  });
});

describe('distToSegment', () => {
  it('is 0 for a point on the segment', () => {
    expect(distToSegment({ x: 5, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(0);
  });

  it('clamps to the nearest endpoint for a degenerate zero-length segment', () => {
    expect(distToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });
});

describe('connectorPath', () => {
  const emptyDoc: Doc = { shapes: [], connectors: [] };

  it('routes orthogonally with a mid-x bend when the connector is wider than it is tall', () => {
    const c: Connector = { id: 'c1', from: { x: 0, y: 0 }, to: { x: 100, y: 40 }, label: '', routing: 'orthogonal' };
    expect(connectorPath(emptyDoc, c)).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 40 },
      { x: 100, y: 40 },
    ]);
  });

  it('threads through manual waypoints in order', () => {
    const c: Connector = {
      id: 'c2',
      from: { x: 0, y: 0 },
      to: { x: 100, y: 100 },
      label: '',
      waypoints: [{ x: 10, y: 10 }],
    };
    expect(connectorPath(emptyDoc, c)).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 100, y: 100 },
    ]);
  });

  it('moves the orthogonal bend per elbowRatio instead of the fixed midpoint', () => {
    const c: Connector = {
      id: 'c3',
      from: { x: 0, y: 0 },
      to: { x: 100, y: 40 },
      label: '',
      routing: 'orthogonal',
      elbowRatio: 0.25,
    };
    expect(connectorPath(emptyDoc, c)).toEqual([
      { x: 0, y: 0 },
      { x: 25, y: 0 },
      { x: 25, y: 40 },
      { x: 100, y: 40 },
    ]);
  });
});

describe('self-loop connectors', () => {
  const shape: Shape = { id: 's1', kind: 'rect', x: 0, y: 0, w: 100, h: 60, label: '' };
  const doc: Doc = { shapes: [shape], connectors: [] };

  it('isSelfLoop is true only when both ends bind the same shape', () => {
    expect(isSelfLoop({ id: 'c', from: { shapeId: 's1', x: 0, y: 0 }, to: { shapeId: 's1', x: 0, y: 0 }, label: '' })).toBe(true);
    expect(isSelfLoop({ id: 'c', from: { shapeId: 's1', x: 0, y: 0 }, to: { shapeId: 's2', x: 0, y: 0 }, label: '' })).toBe(false);
    expect(isSelfLoop({ id: 'c', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, label: '' })).toBe(false);
  });

  it('draws a same-anchor self-loop as a ring around that point, not a degenerate line', () => {
    // Both feet at the top-edge midpoint (normalized 0.5, 0).
    const c: Connector = {
      id: 'c1',
      from: { shapeId: 's1', x: 0.5, y: 0 },
      to: { shapeId: 's1', x: 0.5, y: 0 },
      label: '',
    };
    const path = connectorPath(doc, c);
    expect(path.length).toBeGreaterThan(2);
    // The loop bulges above the shape's top edge and stays centered over it.
    const minY = Math.min(...path.map((p) => p.y));
    expect(minY).toBeLessThan(shape.y);
    const cx = shape.x + shape.w / 2;
    for (const p of path) expect(Math.abs(p.x - cx)).toBeLessThan(shape.w);
    // Both feet land back near the top edge, so the loop opens at the shape.
    expect(path[0].y).toBeLessThanOrEqual(shape.y + 8);
    expect(path[path.length - 1].y).toBeLessThanOrEqual(shape.y + 8);
  });

  it('draws a two-anchor self-loop that leaves one side and enters the other without cutting through the shape', () => {
    // Tail at top-mid (0.5, 0), head at right-mid (1, 0.5).
    const c: Connector = {
      id: 'c2',
      from: { shapeId: 's1', x: 0.5, y: 0 },
      to: { shapeId: 's1', x: 1, y: 0.5 },
      label: '',
    };
    const path = connectorPath(doc, c);
    expect(path.length).toBeGreaterThan(2);
    // Tail starts on the top edge, head arrives on the right edge.
    expect(path[0].y).toBeCloseTo(shape.y, 5);
    expect(path[path.length - 1].x).toBeCloseTo(shape.x + shape.w, 5);
    // No interior point falls strictly inside the shape (the loop stays outside).
    for (const p of path) {
      const inside = p.x > shape.x + 1 && p.x < shape.x + shape.w - 1 && p.y > shape.y + 1 && p.y < shape.y + shape.h - 1;
      expect(inside).toBe(false);
    }
  });

  it('follows the shape on resize because anchors are bbox-normalized', () => {
    const c: Connector = {
      id: 'c3',
      from: { shapeId: 's1', x: 0.5, y: 0 },
      to: { shapeId: 's1', x: 1, y: 0.5 },
      label: '',
    };
    const grown: Doc = { shapes: [{ ...shape, w: shape.w * 2, h: shape.h * 2 }], connectors: [] };
    const path = connectorPath(grown, c);
    // Head still lands exactly on the (now wider) right edge, and tail on the top edge.
    expect(path[0].y).toBeCloseTo(shape.y, 5);
    expect(path[path.length - 1].x).toBeCloseTo(shape.x + shape.w * 2, 5);
  });

  it('draws two feet on the same edge as a clean circle (constant radius)', () => {
    const c: Connector = {
      id: 'c',
      from: { shapeId: 's1', x: 0.35, y: 0 },
      to: { shapeId: 's1', x: 0.65, y: 0 },
      label: '',
    };
    const path = connectorPath(doc, c);
    // Recover the circle centre from three well-separated samples and check every point
    // sits at (nearly) the same radius — i.e. the loop really is a circular arc.
    const p0 = path[0];
    const p1 = path[Math.floor(path.length / 2)];
    const p2 = path[path.length - 1];
    const ax = p1.x - p0.x, ay = p1.y - p0.y, bx = p2.x - p0.x, by = p2.y - p0.y;
    const d = 2 * (ax * by - ay * bx);
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by;
    const cx = p0.x + (by * a2 - ay * b2) / d;
    const cy = p0.y + (ax * b2 - bx * a2) / d;
    const radii = path.map((p) => Math.hypot(p.x - cx, p.y - cy));
    const r0 = radii[0];
    for (const r of radii) expect(Math.abs(r - r0)).toBeLessThan(0.5);
    // ...and it bulges above the (top) edge while both feet stay on it.
    expect(Math.min(...path.map((p) => p.y))).toBeLessThan(shape.y);
    expect(path[0].y).toBeCloseTo(shape.y, 5);
    expect(path[path.length - 1].y).toBeCloseTo(shape.y, 5);
  });

  it('never cuts through the shape for any pair of feet on any aspect ratio', () => {
    // Opposite/crossed feet on wide, tall, square and small shapes used to send the loop
    // straight through the body. A circular loop is only kept when it grazes the border by
    // at most ~2.5px (sub-stroke) at its feet; anything deeper falls back to the routed loop,
    // so no sample point should sit more than that far inside the shape in any configuration.
    const shapes: Shape[] = [
      { id: 'a', kind: 'rect', x: 0, y: 0, w: 100, h: 100, label: '' },
      { id: 'a', kind: 'rect', x: 0, y: 0, w: 220, h: 60, label: '' },
      { id: 'a', kind: 'rect', x: 0, y: 0, w: 60, h: 220, label: '' },
      { id: 'a', kind: 'rect', x: 0, y: 0, w: 40, h: 40, label: '' },
    ];
    const footOn = (side: LoopSide, t: number) =>
      side === 'top'
        ? { x: t, y: 0 }
        : side === 'bottom'
          ? { x: t, y: 1 }
          : side === 'left'
            ? { x: 0, y: t }
            : { x: 1, y: t };
    const insideDepth = (shp: Shape, p: { x: number; y: number }) =>
      p.x <= shp.x || p.x >= shp.x + shp.w || p.y <= shp.y || p.y >= shp.y + shp.h
        ? 0
        : Math.min(p.x - shp.x, shp.x + shp.w - p.x, p.y - shp.y, shp.y + shp.h - p.y);
    const sides: LoopSide[] = ['top', 'right', 'bottom', 'left'];
    for (const shp of shapes) {
      const d: Doc = { shapes: [shp], connectors: [] };
      for (const sa of sides)
        for (const sb of sides)
          for (const ta of [0, 0.25, 0.5, 0.75, 1])
            for (const tb of [0, 0.25, 0.5, 0.75, 1]) {
              const c: Connector = { id: 'c', from: { shapeId: 'a', ...footOn(sa, ta) }, to: { shapeId: 'a', ...footOn(sb, tb) }, label: '' };
              for (const p of connectorPath(d, c)) expect(insideDepth(shp, p)).toBeLessThanOrEqual(1);
            }
    }
  });

  it('nearestSide picks the side a point sits toward from the shape center', () => {
    expect(nearestSide(shape, { x: 50, y: -20 })).toBe('top');
    expect(nearestSide(shape, { x: 50, y: 80 })).toBe('bottom');
    expect(nearestSide(shape, { x: 120, y: 30 })).toBe('right');
    expect(nearestSide(shape, { x: -20, y: 30 })).toBe('left');
    expect(nearestSide(shape, { x: 50, y: 30 })).toBe('top');
  });
});

describe('connectorElbowHandle', () => {
  const emptyDoc: Doc = { shapes: [], connectors: [] };

  it('returns the bend-segment midpoint and free axis for an orthogonal connector', () => {
    const c: Connector = { id: 'c1', from: { x: 0, y: 0 }, to: { x: 100, y: 40 }, label: '', routing: 'orthogonal' };
    expect(connectorElbowHandle(emptyDoc, c)).toEqual({ pos: { x: 50, y: 20 }, axis: 'x' });
  });

  it('is undefined for straight connectors', () => {
    const c: Connector = { id: 'c1', from: { x: 0, y: 0 }, to: { x: 100, y: 40 }, label: '' };
    expect(connectorElbowHandle(emptyDoc, c)).toBeUndefined();
  });

  it('is undefined when waypoints override orthogonal routing', () => {
    const c: Connector = {
      id: 'c1',
      from: { x: 0, y: 0 },
      to: { x: 100, y: 40 },
      label: '',
      routing: 'orthogonal',
      waypoints: [{ x: 10, y: 10 }],
    };
    expect(connectorElbowHandle(emptyDoc, c)).toBeUndefined();
  });
});

describe('setConnectorElbowRatio', () => {
  it('derives the ratio from the dragged point along the bend axis and clamps to 0..1', () => {
    const doc: Doc = {
      shapes: [],
      connectors: [{ id: 'c1', from: { x: 0, y: 0 }, to: { x: 100, y: 40 }, label: '', routing: 'orthogonal' }],
    };
    const moved = setConnectorElbowRatio(doc, 'c1', { x: 20, y: 0 });
    expect(moved.connectors[0].elbowRatio).toBe(0.2);

    const clamped = setConnectorElbowRatio(doc, 'c1', { x: 500, y: 0 });
    expect(clamped.connectors[0].elbowRatio).toBe(1);
  });
});

describe('translateItems', () => {
  it('moves selected shapes and only the free (unbound) endpoints of selected connectors', () => {
    const doc: Doc = {
      shapes: [rect('s1', 0, 0, 10, 10)],
      connectors: [{ id: 'c1', from: { shapeId: 's1', x: 0, y: 0 }, to: { x: 50, y: 50 }, label: '' }],
    };
    const moved = translateItems(doc, ['s1', 'c1'], 5, 5);
    expect(moved.shapes[0]).toMatchObject({ x: 5, y: 5 });
    // bound endpoint is untouched (it tracks the shape instead of storing a live position)
    expect(moved.connectors[0].from).toEqual({ shapeId: 's1', x: 0, y: 0 });
    // free endpoint moves with the drag
    expect(moved.connectors[0].to).toEqual({ x: 55, y: 55 });
  });
});

describe('frameContainedIds', () => {
  it('includes a shape whose center lies inside the frame', () => {
    const f = frame('f1', 0, 0, 200, 200);
    const inside = rect('in', 50, 50, 20, 20); // center (60,60) inside f1
    const doc: Doc = { shapes: [f, inside], connectors: [] };
    expect(frameContainedIds(doc, ['f1']).sort()).toEqual(['f1', 'in']);
  });

  it('excludes a shape whose center lies outside the frame', () => {
    const f = frame('f1', 0, 0, 100, 100);
    const outside = rect('out', 200, 200, 20, 20); // center (210,210), well outside
    const doc: Doc = { shapes: [f, outside], connectors: [] };
    expect(frameContainedIds(doc, ['f1'])).toEqual(['f1']);
  });

  it('treats a center exactly on the frame edge as inside (inclusive bounds)', () => {
    const f = frame('f1', 0, 0, 100, 100);
    // center exactly at x=100, the frame's right edge
    const onEdge = rect('edge', 90, 40, 20, 20);
    const doc: Doc = { shapes: [f, onEdge], connectors: [] };
    expect(frameContainedIds(doc, ['f1'])).toEqual(['f1', 'edge']);
  });

  it('composes across nested frames: outer pulls in the inner frame and the inner frame\'s own contents', () => {
    const outer = frame('outer', 0, 0, 400, 400);
    const inner = frame('inner', 50, 50, 100, 100); // center (100,100) inside outer
    const leaf = rect('leaf', 70, 70, 20, 20); // center (80,80) inside inner (and outer)
    const doc: Doc = { shapes: [outer, inner, leaf], connectors: [] };
    expect(frameContainedIds(doc, ['outer']).sort()).toEqual(['inner', 'leaf', 'outer']);
  });

  it('does NOT pull in a nested frame that only partially overlaps (not fully inside)', () => {
    const outer = frame('outer', 0, 0, 200, 200);
    // center (170,170) is inside outer, but it pokes out past the right/bottom edge
    const overlapping = frame('over', 120, 120, 100, 100);
    const doc: Doc = { shapes: [outer, overlapping], connectors: [] };
    expect(frameContainedIds(doc, ['outer'])).toEqual(['outer']);
  });

  it('pulls in a nested frame that sits entirely inside, and its contents', () => {
    const outer = frame('outer', 0, 0, 200, 200);
    const inner = frame('inner', 20, 20, 80, 80); // fully within outer
    const leaf = rect('leaf', 40, 40, 10, 10);
    const doc: Doc = { shapes: [outer, inner, leaf], connectors: [] };
    expect(frameContainedIds(doc, ['outer']).sort()).toEqual(['inner', 'leaf', 'outer']);
  });

  it('a frame with nothing inside it resolves to just itself', () => {
    const f = frame('f1', 0, 0, 50, 50);
    const doc: Doc = { shapes: [f], connectors: [] };
    expect(frameContainedIds(doc, ['f1'])).toEqual(['f1']);
  });

  it('a plain (non-frame) shape in ids never pulls in anything else', () => {
    const doc: Doc = { shapes: [rect('a', 0, 0, 200, 200), rect('b', 50, 50, 10, 10)], connectors: [] };
    expect(frameContainedIds(doc, ['a'])).toEqual(['a']);
  });
});

describe('shapeAt: frame click-through hit-testing', () => {
  it('an interior click over a contained shape resolves to that shape, not the frame on top of it', () => {
    const f = frame('f1', 0, 0, 200, 200);
    const inner = rect('inner', 50, 50, 40, 40);
    // frame added after (topmost in z-order/array order), as if drawn around an existing shape
    const doc: Doc = { shapes: [inner, f], connectors: [] };
    expect(shapeAt(doc, { x: 70, y: 70 })?.id).toBe('inner');
  });

  it('a click on the frame border resolves to the frame', () => {
    const f = frame('f1', 0, 0, 200, 200);
    const doc: Doc = { shapes: [f], connectors: [] };
    expect(shapeAt(doc, { x: 0, y: 100 })?.id).toBe('f1'); // left border
  });

  it('a click in the frame\'s open interior (no contained shape there) hits nothing', () => {
    const f = frame('f1', 0, 0, 200, 200);
    const doc: Doc = { shapes: [f], connectors: [] };
    expect(shapeAt(doc, { x: 100, y: 150 })).toBeUndefined();
  });

  it('a click on the frame\'s top-left label zone resolves to the frame', () => {
    const f = frame('f1', 0, 0, 200, 200);
    const doc: Doc = { shapes: [f], connectors: [] };
    expect(shapeAt(doc, { x: 30, y: 15 })?.id).toBe('f1');
  });

  it('a click slightly OUTSIDE the frame edge (within the border band) still resolves to the frame, matching the DOM hit-stroke', () => {
    const f = frame('f1', 0, 0, 200, 200);
    const doc: Doc = { shapes: [f], connectors: [] };
    // The Canvas's invisible hit-stroke is 2×band wide, centered on the edge, so up to
    // FRAME_BORDER_BAND outside the rect must count as the frame here too.
    expect(shapeAt(doc, { x: -FRAME_BORDER_BAND / 2, y: 100 })?.id).toBe('f1'); // just left of the left edge
    expect(shapeAt(doc, { x: 100, y: 200 + FRAME_BORDER_BAND })?.id).toBe('f1'); // band's outer limit below the bottom edge
    // ...but past the band's outer edge it's a miss.
    expect(shapeAt(doc, { x: -FRAME_BORDER_BAND - 1, y: 100 })).toBeUndefined();
  });
});

describe('frameHitZone', () => {
  const f = { x: 0, y: 0, w: 200, h: 200 };

  it('hits the band on both sides of the edge and misses past its outer limit', () => {
    expect(frameHitZone(f, { x: -FRAME_BORDER_BAND / 2, y: 100 })).toBe(true); // outside half
    expect(frameHitZone(f, { x: FRAME_BORDER_BAND / 2, y: 100 })).toBe(true); // inside half
    expect(frameHitZone(f, { x: -FRAME_BORDER_BAND, y: 100 })).toBe(true); // outer limit, inclusive
    expect(frameHitZone(f, { x: -FRAME_BORDER_BAND - 1, y: 100 })).toBe(false); // past it
  });

  it('misses the open interior beyond the band and the label zone', () => {
    expect(frameHitZone(f, { x: 100, y: 150 })).toBe(false);
  });

  it('hits the top-left label zone', () => {
    expect(frameHitZone(f, { x: 50, y: 20 })).toBe(true);
  });
});

describe('frameBorderOrLabel: uncapped outer reach for hover', () => {
  const f = { x: 0, y: 0, w: 200, h: 200 };

  it('stays true well outside the border band, where frameHitZone caps out', () => {
    // A connect dot floats CONNECT_DOT_OFFSET (18) outside the edge — past the 10px band, so
    // frameHitZone gives up there, but hover must still reach it.
    const dotX = -18;
    expect(frameHitZone(f, { x: dotX, y: 100 })).toBe(false);
    expect(frameBorderOrLabel(f, { x: dotX, y: 100 })).toBe(true);
  });

  it('still excludes the deep interior, so a contained shape keeps the hover', () => {
    expect(frameBorderOrLabel(f, { x: 100, y: 150 })).toBe(false);
  });

  it('hits the inside half of the border band and the label zone', () => {
    expect(frameBorderOrLabel(f, { x: FRAME_BORDER_BAND / 2, y: 100 })).toBe(true);
    expect(frameBorderOrLabel(f, { x: 50, y: 20 })).toBe(true);
  });
});

describe('reorderItems', () => {
  const doc: Doc = { shapes: [rect('a', 0, 0, 1, 1), rect('b', 0, 0, 1, 1), rect('c', 0, 0, 1, 1)], connectors: [] };

  it('forward swaps past only the single next non-selected item, not to the very front', () => {
    expect(reorderItems(doc, ['a'], 'forward').shapes.map((s) => s.id)).toEqual(['b', 'a', 'c']);
  });

  it('backward swaps past only the single previous non-selected item', () => {
    expect(reorderItems(doc, ['c'], 'backward').shapes.map((s) => s.id)).toEqual(['a', 'c', 'b']);
  });

  it('forward jumps past non-overlapping neighbors to the nearest one it actually overlaps', () => {
    // b sits far away from a/c, which overlap each other.
    const doc: Doc = {
      shapes: [rect('a', 0, 0, 10, 10), rect('b', 1000, 1000, 10, 10), rect('c', 0, 0, 10, 10)],
      connectors: [],
    };
    expect(reorderItems(doc, ['a'], 'forward').shapes.map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('forward is a no-op when nothing overlaps the moved item', () => {
    const doc: Doc = {
      shapes: [rect('a', 0, 0, 10, 10), rect('b', 1000, 1000, 10, 10)],
      connectors: [],
    };
    expect(reorderItems(doc, ['a'], 'forward').shapes.map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('canReorderStep', () => {
  it('is false when the moved item overlaps nothing to swap with', () => {
    const doc: Doc = {
      shapes: [rect('a', 0, 0, 10, 10), rect('b', 1000, 1000, 10, 10)],
      connectors: [],
    };
    expect(canReorderStep(doc, ['a'], 'forward')).toBe(false);
    expect(canReorderStep(doc, ['b'], 'backward')).toBe(false);
  });

  it('is true when there is an overlapping neighbor to swap with', () => {
    const doc: Doc = { shapes: [rect('a', 0, 0, 10, 10), rect('b', 0, 0, 10, 10)], connectors: [] };
    expect(canReorderStep(doc, ['a'], 'forward')).toBe(true);
    expect(canReorderStep(doc, ['b'], 'backward')).toBe(true);
  });

  it('for connectors, checks whether the paths actually cross, not just their bounding boxes', () => {
    // Parallel diagonal lines: their bounding boxes overlap in y (4..6) but the
    // segments themselves never touch.
    const parallelDoc: Doc = {
      shapes: [],
      connectors: [conn('a', 0, 0, 10, 6), conn('b', 0, 4, 10, 10)],
    };
    expect(canReorderStep(parallelDoc, ['a'], 'forward')).toBe(false);

    // An actual X crossing at (5,5).
    const crossingDoc: Doc = {
      shapes: [],
      connectors: [conn('a', 0, 0, 10, 10), conn('b', 0, 10, 10, 0)],
    };
    expect(canReorderStep(crossingDoc, ['a'], 'forward')).toBe(true);
  });
});

describe('scaleShapes', () => {
  it('clamps shrinking below one grid cell to GRID (16)', () => {
    const doc: Doc = { shapes: [rect('s1', 0, 0, 20, 20)], connectors: [] };
    const scaled = scaleShapes(doc, ['s1'], 1, 1, { x: 0, y: 0 }, 20, 20);
    expect(scaled.shapes[0]).toMatchObject({ w: 16, h: 16 });
  });

  it('scales width/height and offsets from the anchor proportionally', () => {
    const doc: Doc = { shapes: [rect('s1', 10, 10, 20, 20)], connectors: [] };
    const scaled = scaleShapes(doc, ['s1'], 40, 40, { x: 0, y: 0 }, 20, 20);
    expect(scaled.shapes[0]).toMatchObject({ x: 20, y: 20, w: 40, h: 40 });
  });
});

describe('distributeShapes', () => {
  it('distributes 3 equal-size shapes horizontally so gaps between bboxes are equal, anchoring first/last', () => {
    // a: [0,10], b: [30,40] (arbitrary starting point), c: [100,110]
    const doc: Doc = {
      shapes: [rect('a', 0, 0, 10, 10), rect('b', 30, 0, 10, 10), rect('c', 100, 0, 10, 10)],
      connectors: [],
    };
    const out = distributeShapes(doc, ['a', 'b', 'c'], 'h');
    // total span 0..110, minus 3*10 width = 80 of gap, split into 2 gaps of 40.
    expect(out.shapes.find((s) => s.id === 'a')).toMatchObject({ x: 0 }); // first: unchanged
    expect(out.shapes.find((s) => s.id === 'b')).toMatchObject({ x: 50 }); // 0+10+40
    expect(out.shapes.find((s) => s.id === 'c')).toMatchObject({ x: 100 }); // last: unchanged
  });

  it('distributes vertically along y the same way', () => {
    const doc: Doc = {
      shapes: [rect('a', 0, 0, 10, 10), rect('b', 0, 30, 10, 10), rect('c', 0, 100, 10, 10)],
      connectors: [],
    };
    const out = distributeShapes(doc, ['a', 'b', 'c'], 'v');
    expect(out.shapes.find((s) => s.id === 'a')).toMatchObject({ y: 0 });
    expect(out.shapes.find((s) => s.id === 'b')).toMatchObject({ y: 50 });
    expect(out.shapes.find((s) => s.id === 'c')).toMatchObject({ y: 100 });
  });

  it('accounts for unequal sizes so the empty gap (not the center spacing) is equal', () => {
    // a: [0,20] w=20, b: [50,90] w=40 (moves), c: [200,210] w=10
    const doc: Doc = {
      shapes: [rect('a', 0, 0, 20, 10), rect('b', 50, 0, 40, 10), rect('c', 200, 0, 10, 10)],
      connectors: [],
    };
    const out = distributeShapes(doc, ['a', 'b', 'c'], 'h');
    // span = 210 - 0 = 210, sumSizes = 20+40+10 = 70, gap = (210-70)/2 = 70.
    expect(out.shapes.find((s) => s.id === 'a')).toMatchObject({ x: 0, w: 20 });
    expect(out.shapes.find((s) => s.id === 'b')).toMatchObject({ x: 90, w: 40 }); // 0+20+70
    expect(out.shapes.find((s) => s.id === 'c')).toMatchObject({ x: 200, w: 10 });
  });

  it('falls back to equal center spacing when bboxes overlap enough that the gap budget goes negative', () => {
    // a: [0,50] center 25, b: [5,55] center 30, c: [20,70] center 45 — heavily overlapping,
    // so span (70) - sumSizes (150) = -80 would make the gap-based layout negative.
    const doc: Doc = {
      shapes: [rect('a', 0, 0, 50, 10), rect('b', 5, 0, 50, 10), rect('c', 20, 0, 50, 10)],
      connectors: [],
    };
    const out = distributeShapes(doc, ['a', 'b', 'c'], 'h');
    // firstCenter=25, lastCenter=45, step=10 -> b's center becomes 35 -> x = 35 - 25 = 10.
    expect(out.shapes.find((s) => s.id === 'a')).toMatchObject({ x: 0 }); // first: unchanged
    expect(out.shapes.find((s) => s.id === 'b')).toMatchObject({ x: 10 });
    expect(out.shapes.find((s) => s.id === 'c')).toMatchObject({ x: 20 }); // last: unchanged
  });

  it('is a no-op with fewer than 3 shapes among ids', () => {
    const doc: Doc = { shapes: [rect('a', 0, 0, 10, 10), rect('b', 100, 0, 10, 10)], connectors: [] };
    expect(distributeShapes(doc, ['a', 'b'], 'h')).toBe(doc);
  });

  it('ignores connector ids in the selection, same as alignShapes', () => {
    const doc: Doc = {
      shapes: [rect('a', 0, 0, 10, 10), rect('b', 30, 0, 10, 10), rect('c', 100, 0, 10, 10)],
      connectors: [{ id: 'c1', from: { x: 0, y: 0 }, to: { x: 5, y: 5 }, label: '' }],
    };
    const out = distributeShapes(doc, ['a', 'b', 'c', 'c1'], 'h');
    expect(out.connectors).toEqual(doc.connectors);
    expect(out.shapes.find((s) => s.id === 'b')).toMatchObject({ x: 50 });
  });

  it("a bound connector's endpoint follows its shape after distribution (resolves live)", () => {
    const doc: Doc = {
      shapes: [rect('a', 0, 0, 10, 10), rect('b', 30, 0, 10, 10), rect('c', 100, 0, 10, 10)],
      connectors: [{ id: 'c1', from: { shapeId: 'b', x: 0, y: 0 }, to: { x: 200, y: 200 }, label: '' }],
    };
    const out = distributeShapes(doc, ['a', 'b', 'c'], 'h');
    // b moved to x=50; the connector's bound endpoint resolves to b's live center, x=55.
    expect(resolveEndpoint(out, out.connectors[0].from).p.x).toBe(55);
  });
});

describe('subsetDoc', () => {
  const doc: Doc = {
    shapes: [rect('a', 0, 0, 10, 10), rect('b', 20, 20, 10, 10)],
    connectors: [{ id: 'c1', from: { shapeId: 'a', x: 5, y: 5 }, to: { shapeId: 'b', x: 25, y: 25 }, label: '' }],
  };

  it('keeps only the selected shapes/connectors', () => {
    expect(subsetDoc(doc, ['a'])).toEqual({ shapes: [doc.shapes[0]], connectors: [] });
  });

  it("pulls in a selected connector's bound shapes even when they weren't selected themselves", () => {
    const out = subsetDoc(doc, ['c1']);
    expect(out.shapes.map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(out.connectors).toEqual([doc.connectors[0]]);
  });

  it('auto-includes an unselected connector when both its bound shapes are selected', () => {
    const out = subsetDoc(doc, ['a', 'b']);
    expect(out.shapes.map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(out.connectors).toEqual([doc.connectors[0]]);
  });

  it('excludes an unselected connector when only one of its bound shapes is selected', () => {
    expect(subsetDoc(doc, ['a']).connectors).toEqual([]);
  });

  it('excludes an unselected connector with a free endpoint even if its bound shape is selected', () => {
    const free: Doc = {
      shapes: [rect('a', 0, 0, 10, 10)],
      connectors: [{ id: 'c1', from: { shapeId: 'a', x: 5, y: 5 }, to: { x: 50, y: 50 }, label: '' }],
    };
    expect(subsetDoc(free, ['a']).connectors).toEqual([]);
  });
});

describe('measureLabel', () => {
  it('defaults to "m" sizing when fontSize is omitted', () => {
    expect(measureLabel('hello')).toEqual(measureLabel('hello', 'm'));
  });

  it('produces a narrower/shorter box for "s" than "m", and a wider/taller one for "l"', () => {
    const s = measureLabel('hello world', 's');
    const m = measureLabel('hello world', 'm');
    const l = measureLabel('hello world', 'l');
    expect(s.w).toBeLessThan(m.w);
    expect(m.w).toBeLessThan(l.w);
    expect(s.h).toBeLessThan(m.h);
    expect(m.h).toBeLessThan(l.h);
  });

  it('scales height with the number of lines at each font size', () => {
    const oneLine = measureLabel('a', 'l');
    const twoLines = measureLabel('a\nb', 'l');
    expect(twoLines.h).toBe(oneLine.h * 2);
  });
});

describe('deleteItem', () => {
  it('deleting a shape also removes connectors bound to it', () => {
    const doc: Doc = {
      shapes: [rect('s1', 0, 0, 10, 10)],
      connectors: [{ id: 'c1', from: { shapeId: 's1', x: 0, y: 0 }, to: { x: 50, y: 50 }, label: '' }],
    };
    expect(deleteItem(doc, 's1')).toEqual({ shapes: [], connectors: [] });
  });
});
