import { describe, expect, it } from 'vitest';
import {
  borderPoint,
  connectorPath,
  deleteItem,
  distToSegment,
  FRAME_BORDER_BAND,
  frameContainedIds,
  frameHitZone,
  inscribedBox,
  labelCenter,
  measureLabel,
  reorderItems,
  resizeAnchor,
  scaleShapes,
  shapeAt,
  subsetDoc,
  translateItems,
  triangleVertices,
} from './doc';
import type { Connector, Doc, Shape } from './types';

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

describe('reorderItems', () => {
  const doc: Doc = { shapes: [rect('a', 0, 0, 1, 1), rect('b', 0, 0, 1, 1), rect('c', 0, 0, 1, 1)], connectors: [] };

  it('forward swaps past only the single next non-selected item, not to the very front', () => {
    expect(reorderItems(doc, ['a'], 'forward').shapes.map((s) => s.id)).toEqual(['b', 'a', 'c']);
  });

  it('backward swaps past only the single previous non-selected item', () => {
    expect(reorderItems(doc, ['c'], 'backward').shapes.map((s) => s.id)).toEqual(['a', 'c', 'b']);
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
