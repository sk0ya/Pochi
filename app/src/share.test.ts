import { describe, expect, it } from 'vitest';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  decodeShareDoc,
  encodeShareDoc,
  fromCompactDoc,
  toCompactDoc,
} from './share';
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
      { id: 's3', kind: 'freedraw', x: 0, y: 200, w: 120, h: 40, label: '', points: [0, 0, 500, 1000, 1000, 0] },
      {
        id: 's4',
        kind: 'image',
        x: 200,
        y: 200,
        w: 96,
        h: 96,
        label: '',
        src: 'data:image/svg+xml,%3Csvg/%3E',
        iconAttribution: {
          iconName: 'devicon:docker',
          collection: 'devicon',
          collectionName: 'Devicon',
          license: 'MIT',
          licenseUrl: 'https://opensource.org/license/mit',
          brand: true,
        },
      },
    ],
    connectors: [
      { id: 'c1', from: { shapeId: 's1', x: 0, y: 0 }, to: { shapeId: 's2', x: 0, y: 0 }, label: '' },
    ],
  };

  it('round-trips a doc through encode -> decode, up to id renaming', async () => {
    // encodeShareDoc remaps ids to short sequential tokens (see share.ts), so the
    // decoded doc's ids won't match the original strings — only the shape/label/position
    // data and the shapeId *references* (still internally consistent) should match.
    const payload = await encodeShareDoc(doc);
    expect(typeof payload).toBe('string');
    const decoded = await decodeShareDoc(payload);
    expect(decoded).not.toBeNull();
    const d = decoded!;
    expect(d.shapes.map((s) => ({ ...s, id: undefined }))).toEqual(
      doc.shapes.map((s) => ({ ...s, id: undefined })),
    );
    expect(d.connectors.map((c) => c.label)).toEqual(doc.connectors.map((c) => c.label));
    // the rewritten connector endpoints still point at the rewritten shape ids
    expect(d.connectors[0].from.shapeId).toBe(d.shapes[0].id);
    expect(d.connectors[0].to.shapeId).toBe(d.shapes[1].id);
  });

  it('round-trips fixed endpoint anchors, and reads links written before they existed', async () => {
    const pinned: Doc = {
      ...doc,
      connectors: [
        {
          id: 'c1',
          from: { shapeId: 's1', x: 80, y: 48, anchor: { x: 1, y: 0.25 } },
          to: { shapeId: 's2', x: 280, y: 48 },
          label: '',
        },
      ],
    };
    const d = (await decodeShareDoc(await encodeShareDoc(pinned)))!;
    expect(d.connectors[0].from.anchor).toEqual({ x: 1, y: 0.25 });
    // An end left floating stays floating rather than picking up a stray anchor — which is
    // also what a link shared before fixed attachments existed decodes to.
    expect(d.connectors[0].to.anchor).toBeUndefined();
    expect((await decodeShareDoc(await encodeShareDoc(doc)))!.connectors[0].from.anchor).toBeUndefined();
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

  it('rejects a payload that decodes to well-formed JSON missing the s/c tuple arrays', async () => {
    // Valid compressed base64url, but the wrong shape once parsed - exercises the
    // post-JSON.parse validation, not just the base64/deflate error paths above. Built by
    // hand (not via encodeShareDoc, which now assumes a real Doc) using the same
    // compress-then-base64url steps encodeShareDoc uses internally.
    const bytes = new TextEncoder().encode(JSON.stringify({ foo: 'bar' }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }).pipeThrough(new CompressionStream('deflate-raw'));
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const compressed = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const c of chunks) {
      compressed.set(c, offset);
      offset += c.length;
    }
    const payload = bytesToBase64Url(compressed);
    await expect(decodeShareDoc(payload)).resolves.toBeNull();
  });

  it('rejects empty string payload without throwing', async () => {
    await expect(decodeShareDoc('')).resolves.toBeNull();
  });

  /* The compact form is also what the localStorage autosave stores (see readAutosave in
   * App.tsx), which needs it synchronously — so it is exercised directly here, not only
   * through the deflate/base64 round-trip above. */
  describe('toCompactDoc / fromCompactDoc', () => {
    it('round-trips a doc synchronously, up to id renaming', () => {
      const d = fromCompactDoc(toCompactDoc(doc));
      expect(d.shapes.map((s) => ({ ...s, id: undefined }))).toEqual(
        doc.shapes.map((s) => ({ ...s, id: undefined })),
      );
      expect(d.connectors[0].from.shapeId).toBe(d.shapes[0].id);
      expect(d.connectors[0].to.shapeId).toBe(d.shapes[1].id);
    });

    it('round-trips a non-default shape text alignment', () => {
      const d = fromCompactDoc(
        toCompactDoc({
          shapes: [{ id: 's1', kind: 'rect', x: 0, y: 0, w: 100, h: 60, label: 'left', textAlign: 'left' }],
          connectors: [],
        }),
      );
      expect(d.shapes[0].textAlign).toBe('left');
    });

    it('serializes to substantially fewer characters than the doc itself', () => {
      // The point of storing the autosave this way: it has to fit in localStorage's ~5MB
      // origin cap. Asserted loosely (>30%) so ordinary format tweaks don't fail the test.
      const compact = JSON.stringify(toCompactDoc(doc)).length;
      const plain = JSON.stringify(doc).length;
      expect(compact).toBeLessThan(plain * 0.7);
    });

    it('round-trips an empty doc', () => {
      expect(fromCompactDoc(toCompactDoc({ shapes: [], connectors: [] }))).toEqual({
        shapes: [],
        connectors: [],
      });
    });
  });
});
