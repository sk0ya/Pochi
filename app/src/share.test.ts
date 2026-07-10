import { describe, expect, it } from 'vitest';
import { base64UrlToBytes, bytesToBase64Url, decodeShareDoc, encodeShareDoc } from './share';
import type { Doc } from './model/types';

describe('bytesToBase64Url / base64UrlToBytes', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 255, 254, 128, 127, 10, 13]);
    expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
  });

  it('strips padding and uses -/_ instead of +//', () => {
    // 0xfb 0xff 0xbf -> plain base64 '+/+/', which would fail this assertion without the
    // url-safety substitution; two input bytes (not a multiple of 3) also leaves '=' padding.
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf]);
    const encoded = bytesToBase64Url(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it('round-trips a single byte (padding-heavy case)', () => {
    const bytes = new Uint8Array([42]);
    const encoded = bytesToBase64Url(bytes);
    expect(encoded).not.toMatch(/=/);
    expect(base64UrlToBytes(encoded)).toEqual(bytes);
  });

  it('round-trips an empty payload', () => {
    const bytes = new Uint8Array([]);
    expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
  });
});

describe('encodeShareDoc / decodeShareDoc', () => {
  const doc: Doc = {
    shapes: [
      { id: 's1', kind: 'rect', x: 0, y: 0, w: 160, h: 96, label: 'hello' },
      { id: 's2', kind: 'ellipse', x: 200, y: 0, w: 160, h: 96, label: '世界', color: '#ff0000' },
    ],
    connectors: [
      { id: 'c1', from: { shapeId: 's1', x: 0, y: 0 }, to: { shapeId: 's2', x: 0, y: 0 }, label: '' },
    ],
  };

  it('round-trips a doc through encode -> decode', async () => {
    const payload = await encodeShareDoc(doc);
    expect(typeof payload).toBe('string');
    const decoded = await decodeShareDoc(payload);
    expect(decoded).toEqual(doc);
  });

  it('round-trips an empty doc', async () => {
    const empty: Doc = { shapes: [], connectors: [] };
    const payload = await encodeShareDoc(empty);
    expect(await decodeShareDoc(payload)).toEqual(empty);
  });

  it('rejects a corrupted payload without throwing', async () => {
    const payload = await encodeShareDoc(doc);
    const corrupted = payload.slice(0, Math.floor(payload.length / 2));
    await expect(decodeShareDoc(corrupted)).resolves.toBeNull();
  });

  it('rejects payloads containing invalid base64url characters without throwing', async () => {
    await expect(decodeShareDoc('not!!!valid***base64url///')).resolves.toBeNull();
  });

  it('rejects a payload that decodes to well-formed JSON missing shapes/connectors arrays', async () => {
    // Valid compressed base64url, but the wrong shape once parsed - exercises the
    // post-JSON.parse validation, not just the base64/deflate error paths above.
    const payload = await encodeShareDoc({ foo: 'bar' } as unknown as Doc);
    await expect(decodeShareDoc(payload)).resolves.toBeNull();
  });

  it('rejects empty string payload without throwing', async () => {
    await expect(decodeShareDoc('')).resolves.toBeNull();
  });
});
