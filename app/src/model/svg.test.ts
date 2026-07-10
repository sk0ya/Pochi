import { describe, expect, it } from 'vitest';
import { subsetDoc } from './doc';
import { exportBackground, exportSvg, exportViewport } from './svg';
import type { Doc } from './types';

describe('exportSvg', () => {
  const doc: Doc = {
    shapes: [
      { id: 'a', kind: 'rect', x: 0, y: 0, w: 100, h: 50, label: '' },
      { id: 'b', kind: 'rect', x: 500, y: 500, w: 100, h: 50, label: '' },
    ],
    connectors: [],
  };

  it('sizes the viewBox to the full doc bounds plus a fixed margin', () => {
    const svg = exportSvg(doc);
    // full bounds: x 0..600, y 0..550 -> w=600 h=550, padded by 24px on each side
    expect(svg).toContain('viewBox="-24 -24 648 598"');
  });

  it('sizes the viewBox to just a selection subset plus the same margin', () => {
    const svg = exportSvg(subsetDoc(doc, ['a']));
    expect(svg).toContain('viewBox="-24 -24 148 98"');
  });

  it('omits shapes outside the selection subset', () => {
    const svg = exportSvg(subsetDoc(doc, ['a']));
    expect(svg).not.toContain('x="500"');
  });

  it('always renders a white background rect so the PNG rasterization has no transparency', () => {
    expect(exportSvg(doc)).toContain('fill="#ffffff"');
  });
});

describe('exportSvg: dark theme', () => {
  const doc: Doc = {
    shapes: [
      { id: 'a', kind: 'rect', x: 0, y: 0, w: 100, h: 50, label: 'hi' },
      { id: 'c', kind: 'rect', x: 200, y: 0, w: 100, h: 50, label: '', color: '#e5484d' },
    ],
    connectors: [{ id: 'k', from: { shapeId: 'a', x: 100, y: 25 }, to: { shapeId: 'c', x: 200, y: 25 }, label: '' }],
  };

  it('paints the canvas background color instead of white', () => {
    const svg = exportSvg(doc, 'dark');
    expect(svg).toContain('fill="#12151a"');
    expect(svg).not.toContain('#ffffff');
  });

  it('uses the canvas default stroke/fill/text colors for uncolored elements', () => {
    const svg = exportSvg(doc, 'dark');
    expect(svg).toContain('stroke="#a9b7d0"'); // shape + connector default stroke
    expect(svg).toContain('fill="#202839"'); // unfilled shape background
    expect(svg).toContain('fill="#dbe2ee"'); // label text
  });

  it('keeps explicit accent colors as-is in both themes', () => {
    expect(exportSvg(doc, 'dark')).toContain('stroke="#e5484d"');
    expect(exportSvg(doc)).toContain('stroke="#e5484d"');
  });

  it('exportBackground matches the background rect each theme paints', () => {
    expect(exportSvg(doc, 'dark')).toContain(`fill="${exportBackground('dark')}"`);
    expect(exportSvg(doc)).toContain(`fill="${exportBackground('light')}"`);
  });
});

describe('exportSvg: frame fill tint', () => {
  it('emits a fill-opacity tint rect for a filled frame', () => {
    const doc: Doc = {
      shapes: [{ id: 'f', kind: 'frame', x: 0, y: 0, w: 100, h: 50, label: '', filled: true }],
      connectors: [],
    };
    expect(exportSvg(doc)).toContain('fill-opacity');
  });

  it('emits fill="none" (no tint) for an unfilled frame', () => {
    const doc: Doc = {
      shapes: [{ id: 'f', kind: 'frame', x: 0, y: 0, w: 100, h: 50, label: '' }],
      connectors: [],
    };
    const svg = exportSvg(doc);
    expect(svg).toContain('fill="none"');
    expect(svg).not.toContain('fill-opacity');
  });
});

describe('exportViewport', () => {
  it('matches the viewBox exportSvg emits (single source of truth for the PNG canvas size)', () => {
    const doc: Doc = {
      shapes: [{ id: 'a', kind: 'rect', x: 0, y: 0, w: 100, h: 50, label: '' }],
      connectors: [],
    };
    const v = exportViewport(doc);
    expect(v).toEqual({ x: -24, y: -24, w: 148, h: 98 });
    expect(exportSvg(doc)).toContain(`viewBox="${v.x} ${v.y} ${v.w} ${v.h}"`);
  });

  it('falls back to a default 200x100 box for an empty doc', () => {
    expect(exportViewport({ shapes: [], connectors: [] })).toEqual({ x: -24, y: -24, w: 248, h: 148 });
  });
});
