import { describe, expect, it } from 'vitest';
import {
  dataUrlMediaType,
  IMAGE_STORE_MAX_DIM,
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
