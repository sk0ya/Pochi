import { describe, expect, it } from 'vitest';
import {
  dataUrlMediaType,
  heavyImageShapes,
  IMAGE_HEAVY_BYTES,
  IMAGE_STORE_MAX_DIM,
  isWorthReencoding,
  shouldReencodeImage,
  storedImageScale,
} from './image';

/* encodeImageForStorage itself needs Image/canvas, which the node test environment doesn't
 * provide; the decisions it makes are all in these pure helpers. */

describe('storedImageScale', () => {
  it('scales a large image down so its longest edge hits the cap', () => {
    expect(storedImageScale(4000, 3000)).toBeCloseTo(IMAGE_STORE_MAX_DIM / 4000);
    expect(storedImageScale(3000, 4000)).toBeCloseTo(IMAGE_STORE_MAX_DIM / 4000);
  });

  it('never upscales an image already within the cap', () => {
    expect(storedImageScale(800, 600)).toBe(1);
    expect(storedImageScale(IMAGE_STORE_MAX_DIM, 10)).toBe(1);
    expect(storedImageScale(1, 1)).toBe(1);
  });

  it('does not divide by zero on a degenerate size', () => {
    expect(storedImageScale(0, 0)).toBe(1);
  });

  it('preserves aspect ratio', () => {
    const scale = storedImageScale(4000, 2000);
    expect(Math.round(4000 * scale)).toBe(IMAGE_STORE_MAX_DIM);
    expect(Math.round(2000 * scale)).toBe(IMAGE_STORE_MAX_DIM / 2);
  });
});

describe('dataUrlMediaType', () => {
  it('reads the media type, lowercased', () => {
    expect(dataUrlMediaType('data:image/PNG;base64,AAA')).toBe('image/png');
    expect(dataUrlMediaType('data:image/svg+xml,<svg/>')).toBe('image/svg+xml');
  });

  it('is empty for anything that is not a data URL', () => {
    expect(dataUrlMediaType('https://example.com/a.png')).toBe('');
    expect(dataUrlMediaType('')).toBe('');
  });
});

describe('shouldReencodeImage', () => {
  it('re-encodes ordinary bitmaps', () => {
    expect(shouldReencodeImage('data:image/png;base64,AAA')).toBe(true);
    expect(shouldReencodeImage('data:image/jpeg;base64,AAA')).toBe(true);
    expect(shouldReencodeImage('data:image/webp;base64,AAA')).toBe(true);
  });

  it('leaves SVG alone, so an icon is never rasterized', () => {
    expect(shouldReencodeImage('data:image/svg+xml,<svg/>')).toBe(false);
    expect(shouldReencodeImage('data:image/svg+xml;base64,AAA')).toBe(false);
  });

  it('leaves GIF alone, so an animation is not flattened to one frame', () => {
    expect(shouldReencodeImage('data:image/gif;base64,AAA')).toBe(false);
  });

  it('leaves anything that is not a data: image alone', () => {
    expect(shouldReencodeImage('https://example.com/a.png')).toBe(false);
    expect(shouldReencodeImage('data:text/plain,hi')).toBe(false);
    expect(shouldReencodeImage('')).toBe(false);
  });
});

describe('isWorthReencoding', () => {
  it('adopts a re-encode that saves a lot, as a full-resolution original does', () => {
    expect(isWorthReencoding(1_000_000, 80_000)).toBe(true);
  });

  it('declines a marginal saving, so repeat :optimize runs converge instead of degrading', () => {
    // The bug this guards: re-compressing an already-optimized image shaves a few percent
    // while spending another generation of quality, so "smaller at all" would re-encode the
    // same images on every run and never report itself finished.
    expect(isWorthReencoding(100_000, 98_000)).toBe(false);
    expect(isWorthReencoding(100_000, 91_000)).toBe(false);
    expect(isWorthReencoding(100_000, 89_000)).toBe(true);
  });

  it('declines a re-encode that is no smaller, or bigger', () => {
    expect(isWorthReencoding(1000, 1000)).toBe(false);
    expect(isWorthReencoding(1000, 4000)).toBe(false);
  });
});

describe('heavyImageShapes', () => {
  const bitmap = (bytes: number) => 'data:image/png;base64,' + 'A'.repeat(bytes);
  const shape = (id: string, src?: string, kind = 'image') => ({ id, kind, src });

  it('reports the shapes over the threshold and what they cost', () => {
    const doc = {
      shapes: [
        shape('big1', bitmap(IMAGE_HEAVY_BYTES)),
        shape('big2', bitmap(IMAGE_HEAVY_BYTES * 2)),
        shape('small', bitmap(1000)),
      ],
    };
    const { ids, bytes } = heavyImageShapes(doc);
    expect(ids).toEqual(['big1', 'big2']);
    expect(bytes).toBe(doc.shapes[0].src!.length + doc.shapes[1].src!.length);
  });

  it('ignores an image that is already small enough to be worth leaving alone', () => {
    expect(heavyImageShapes({ shapes: [shape('a', bitmap(IMAGE_HEAVY_BYTES - 100))] }).ids).toEqual([]);
  });

  it('never flags a large SVG or GIF, which :optimize would not touch either', () => {
    const svg = 'data:image/svg+xml,' + '<g/>'.repeat(IMAGE_HEAVY_BYTES);
    const gif = 'data:image/gif;base64,' + 'A'.repeat(IMAGE_HEAVY_BYTES * 2);
    expect(heavyImageShapes({ shapes: [shape('s', svg), shape('g', gif)] }).ids).toEqual([]);
  });

  it('ignores non-image shapes and images without a src', () => {
    const doc = {
      shapes: [shape('r', bitmap(IMAGE_HEAVY_BYTES * 2), 'rect'), shape('i', undefined)],
    };
    expect(heavyImageShapes(doc)).toEqual({ ids: [], bytes: 0 });
  });

  it('reports nothing for an empty document', () => {
    expect(heavyImageShapes({ shapes: [] })).toEqual({ ids: [], bytes: 0 });
  });
});
