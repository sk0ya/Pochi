import { describe, expect, it } from 'vitest';
import { docToExcalidraw, excalidrawToDoc } from './excalidraw';
import type { Connector, Doc } from './model/types';

/** Endpoint x/y for a shape-bound end are functionally irrelevant (resolveEndpoint in
 * model/doc.ts ignores them whenever shapeId is set) and legitimately change across an
 * export/import round trip (the exported arrow bakes in the border-trimmed point, not
 * the original raw value) - so round-trip assertions on bound connectors zero them out
 * before comparing, and a free-endpoint connector is used separately to check that a
 * connector with no shape bindings at all round-trips its coordinates byte-exact. */
function stripUnresolvedCoords(c: Connector): Connector {
  return {
    ...c,
    from: c.from.shapeId ? { shapeId: c.from.shapeId, x: 0, y: 0 } : c.from,
    to: c.to.shapeId ? { shapeId: c.to.shapeId, x: 0, y: 0 } : c.to,
  };
}

describe('docToExcalidraw / excalidrawToDoc', () => {
  const doc: Doc = {
    shapes: [
      { id: 's1', kind: 'rect', x: 0, y: 0, w: 160, h: 96, label: 'hello', color: '#4da3ff', groupId: 'g1' },
      { id: 's2', kind: 'ellipse', x: 200, y: 0, w: 160, h: 96, label: '世界', filled: true, color: '#e5484d' },
      { id: 's3', kind: 'diamond', x: 0, y: 150, w: 120, h: 80, label: '', filled: true },
      {
        id: 's4', kind: 'triangle', x: 200, y: 150, w: 100, h: 100, label: 'tri',
        direction: 'down-left', color: '#3dbd6b', fontSize: 'l',
      },
      { id: 's5', kind: 'text', x: 400, y: 150, w: 120, h: 30, label: 'standalone', color: '#a374e0', fontSize: 's' },
      {
        id: 's6', kind: 'freedraw', x: 0, y: 300, w: 100, h: 100, label: '',
        points: [0, 0, 1000, 0, 1000, 1000],
      },
      { id: 's7', kind: 'frame', x: 400, y: 300, w: 200, h: 150, label: 'container' },
      {
        id: 's8', kind: 'image', x: 620, y: 300, w: 100, h: 100, label: '',
        src: 'data:image/png;base64,AAAA',
      },
    ],
    connectors: [
      // free endpoints only: no border-trimming applies, so from/to should be byte-exact.
      {
        id: 'c1', from: { x: 10, y: 10 }, to: { x: 90, y: 40 }, label: 'edge',
        color: '#0000ff', dashed: true, arrowDirection: 'both', fontSize: 's', groupId: 'g1',
      },
      // shape-bound + orthogonal routing/elbowRatio.
      { id: 'c2', from: { shapeId: 's1', x: 0, y: 0 }, to: { shapeId: 's2', x: 0, y: 0 }, label: '', routing: 'orthogonal', elbowRatio: 0.3 },
      // shape-bound + manual waypoints.
      {
        id: 'c3', from: { shapeId: 's3', x: 0, y: 0 }, to: { shapeId: 's4', x: 0, y: 0 }, label: '',
        waypoints: [{ x: 150, y: 260 }, { x: 250, y: 260 }],
      },
      // arrowDirection: 'none', no shapeId either end.
      { id: 'c4', from: { x: 500, y: 500 }, to: { x: 600, y: 500 }, label: '', arrowDirection: 'none' },
    ],
  };

  it('round-trips every shape kind unchanged (ids, geometry, style all pass through)', () => {
    const file = docToExcalidraw(doc);
    const back = excalidrawToDoc(file);
    expect(back).not.toBeNull();
    expect(back!.shapes).toEqual(doc.shapes);
  });

  it('round-trips connectors (up to unresolved bound-endpoint coordinates - see stripUnresolvedCoords)', () => {
    const file = docToExcalidraw(doc);
    const back = excalidrawToDoc(file);
    expect(back).not.toBeNull();
    expect(back!.connectors.map(stripUnresolvedCoords)).toEqual(doc.connectors.map(stripUnresolvedCoords));
  });

  it('round-trips a free-endpoint connector byte-exact, including coordinates', () => {
    const file = docToExcalidraw(doc);
    const back = excalidrawToDoc(file);
    expect(back!.connectors[0]).toEqual(doc.connectors[0]);
  });

  it('emits a well-formed Excalidraw scene envelope', () => {
    const file = docToExcalidraw(doc);
    expect(file.type).toBe('excalidraw');
    expect(Array.isArray(file.elements)).toBe(true);
    expect(file.files['s8#img'].dataURL).toBe('data:image/png;base64,AAAA');
  });

  it('round-trips an empty doc', () => {
    const empty: Doc = { shapes: [], connectors: [] };
    expect(excalidrawToDoc(docToExcalidraw(empty))).toEqual(empty);
  });
});

describe('excalidrawToDoc: malformed / foreign input', () => {
  it('rejects non-object input without throwing', () => {
    expect(excalidrawToDoc(null)).toBeNull();
    expect(excalidrawToDoc(undefined)).toBeNull();
    expect(excalidrawToDoc('not a scene')).toBeNull();
    expect(excalidrawToDoc(42)).toBeNull();
  });

  it('rejects an object missing the excalidraw envelope', () => {
    expect(excalidrawToDoc({})).toBeNull();
    expect(excalidrawToDoc({ type: 'excalidraw' })).toBeNull(); // no elements array
    expect(excalidrawToDoc({ type: 'not-excalidraw', elements: [] })).toBeNull();
    expect(excalidrawToDoc({ type: 'excalidraw', elements: 'nope' })).toBeNull();
  });

  it('accepts a valid empty scene', () => {
    expect(excalidrawToDoc({ type: 'excalidraw', elements: [] })).toEqual({ shapes: [], connectors: [] });
  });

  it('drops individually malformed elements instead of failing the whole import', () => {
    const scene = {
      type: 'excalidraw',
      elements: [
        null,
        'garbage',
        { id: 'ok', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, strokeColor: '#111111', backgroundColor: 'transparent', groupIds: [] },
        { id: 'no-dims', type: 'rectangle' }, // missing x/y/width/height
      ],
    };
    const back = excalidrawToDoc(scene);
    expect(back).not.toBeNull();
    expect(back!.shapes.map((s) => s.id)).toEqual(['ok']);
  });

  it('drops an image element whose fileId has no matching files entry', () => {
    const scene = {
      type: 'excalidraw',
      elements: [
        { id: 'img1', type: 'image', x: 0, y: 0, width: 50, height: 50, fileId: 'missing', strokeColor: 'transparent', backgroundColor: 'transparent', groupIds: [] },
      ],
      files: {},
    };
    expect(excalidrawToDoc(scene)!.shapes).toEqual([]);
  });

  it('skips isDeleted elements', () => {
    const scene = {
      type: 'excalidraw',
      elements: [
        { id: 'gone', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, strokeColor: '#111111', backgroundColor: 'transparent', groupIds: [], isDeleted: true },
      ],
    };
    expect(excalidrawToDoc(scene)!.shapes).toEqual([]);
  });

  it('reads a genuinely foreign multi-point arrow (no Pochi customData) as manual waypoints', () => {
    const scene = {
      type: 'excalidraw',
      elements: [
        {
          id: 'a1', type: 'arrow', x: 0, y: 0, width: 100, height: 100,
          points: [[0, 0], [50, 0], [50, 100], [100, 100]],
          strokeColor: '#1e1e1e', backgroundColor: 'transparent', groupIds: [],
          startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: 'arrow',
        },
      ],
    };
    const back = excalidrawToDoc(scene)!;
    expect(back.connectors).toHaveLength(1);
    expect(back.connectors[0].waypoints).toEqual([{ x: 50, y: 0 }, { x: 50, y: 100 }]);
    expect(back.connectors[0].from).toEqual({ x: 0, y: 0, shapeId: undefined });
    expect(back.connectors[0].to).toEqual({ x: 100, y: 100, shapeId: undefined });
  });

  it('reconstructs a foreign closed 3-point line as a triangle by best-fit direction', () => {
    // An upward-pointing triangle: apex at top-mid, base along the bottom - same shape
    // triangleVertices({direction:'up'}) produces, but with no customData at all.
    const scene = {
      type: 'excalidraw',
      elements: [
        {
          id: 'tri1', type: 'line', x: 0, y: 0, width: 100, height: 100,
          points: [[50, 0], [100, 100], [0, 100], [50, 0]],
          strokeColor: '#1e1e1e', backgroundColor: 'transparent', groupIds: [],
        },
      ],
    };
    const back = excalidrawToDoc(scene)!;
    expect(back.shapes).toEqual([
      { id: 'tri1', kind: 'triangle', x: 0, y: 0, w: 100, h: 100, label: '', color: undefined, filled: undefined, fontSize: undefined, groupId: undefined, direction: 'up' },
    ]);
  });
});
