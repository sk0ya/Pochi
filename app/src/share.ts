/**
 * Codec for the `:share` command: Doc -> deflate-compressed, base64url-encoded payload
 * embeddable in a URL fragment (`#d=<payload>`), and back.
 *
 * Before compression, the Doc is transformed into a compact wire format (see
 * `toCompactDoc`/`fromCompactDoc` below): shapes/connectors become positional tuples
 * instead of keyed objects (trimmed of trailing absent fields), and every id (shape,
 * connector, group) is remapped to a short sequential token. The receiver only needs
 * ids that are internally consistent, not the sender's original random strings, so this
 * is lossless for anything that matters and roughly halves the compressed payload size
 * versus encoding the Doc as-is.
 *
 * The byte<->base64url helpers are pure/sync so they're trivially unit-testable; the
 * compress/decompress helpers wrap the native CompressionStream/DecompressionStream
 * (no new dependency) and are therefore async, same as the rest of Pochi's Web-API-backed
 * IO (see pngClipboard.ts). `encodeShareDoc`/`decodeShareDoc` never throw on bad input —
 * a corrupted or truncated payload resolves `decodeShareDoc` to `null` so callers (startup
 * hash parsing in App.tsx) can fall back to the normal autosave restore instead of crashing.
 */
import type { ArrowDirection, Connector, Doc, FontSize, Pt, Shape, ShapeKind, TriangleDirection } from './model/types';

/** Bytes -> base64url (RFC 4648 §5): '+'/'/' become '-'/'_', and padding is stripped
 * (both are illegal/unnecessary in a URL fragment). Pure/sync. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Inverse of `bytesToBase64Url`. Throws on malformed input (odd characters, impossible
 * length) — callers that need a non-throwing decode should go through `decodeShareDoc`,
 * which wraps this in a try/catch. Pure/sync. */
export function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function compress(bytes: Uint8Array): Promise<Uint8Array> {
  return readAll(toReadableStream(bytes).pipeThrough(new CompressionStream('deflate-raw')));
}

function decompress(bytes: Uint8Array): Promise<Uint8Array> {
  return readAll(toReadableStream(bytes).pipeThrough(new DecompressionStream('deflate-raw')));
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** URLs beyond roughly this many payload chars are fragile in some contexts (chat apps,
 * older browsers, some proxies); `:share` still copies but warns past this point. */
export const SHARE_URL_WARN_CHARS = 8000;

/** Assigns each distinct id (shape id, connector id, or groupId) a short sequential
 * base36 token the first time it's seen, in shapes-then-connectors order. All three id
 * kinds share one counter/map since a `groupId` can equal a shape's own id. */
function shortIds(doc: Doc): { shapes: Shape[]; connectors: Connector[] } {
  const map = new Map<string, string>();
  let n = 0;
  const get = (id: string): string => {
    let v = map.get(id);
    if (v === undefined) {
      v = n.toString(36);
      n += 1;
      map.set(id, v);
    }
    return v;
  };
  const shapes = doc.shapes.map((s) => ({
    ...s,
    id: get(s.id),
    groupId: s.groupId ? get(s.groupId) : undefined,
  }));
  const connectors = doc.connectors.map((c) => ({
    ...c,
    id: get(c.id),
    from: { ...c.from, shapeId: c.from.shapeId ? get(c.from.shapeId) : undefined },
    to: { ...c.to, shapeId: c.to.shapeId ? get(c.to.shapeId) : undefined },
    groupId: c.groupId ? get(c.groupId) : undefined,
  }));
  return { shapes, connectors };
}

/** Drops trailing `undefined`/`null` entries so an all-default tail of optional fields
 * doesn't serialize as a run of `null`s. Mutates and returns `arr`. */
function trimTrailing<T extends unknown[]>(arr: T): T {
  while (arr.length && (arr[arr.length - 1] === undefined || arr[arr.length - 1] === null)) arr.pop();
  return arr;
}

type PtTuple = [number, number];
const ptToTuple = (p: Pt): PtTuple => [p.x, p.y];
const tupleToPt = (t: PtTuple): Pt => ({ x: t[0], y: t[1] });

/** Positional tuple for a Shape. Required fields come first (always present, never
 * trimmed); optional fields are ordered roughly least- to most-common so the common case
 * (no color/direction/filled/fontSize/groupId/src) trims down to just the required ones. */
type ShapeTuple = [
  ShapeKind,
  number,
  number,
  number,
  number,
  string,
  string,
  string?,
  TriangleDirection?,
  boolean?,
  FontSize?,
  string?,
  string?,
  number[]?,
];

function shapeToTuple(s: Shape): ShapeTuple {
  return trimTrailing([
    s.kind,
    s.x,
    s.y,
    s.w,
    s.h,
    s.label,
    s.id,
    s.color,
    s.direction,
    s.filled,
    s.fontSize,
    s.groupId,
    s.src,
    s.points,
  ]) as ShapeTuple;
}

function tupleToShape(t: unknown[]): Shape {
  // `?? undefined` throughout: an absent optional that sits BEFORE a present one
  // serializes as null inside the tuple (only the trailing run gets trimmed), and
  // null must not leak into the Doc, whose optionals are `T | undefined`.
  const [kind, x, y, w, h, label, id, color, direction, filled, fontSize, groupId, src, points] = t as ShapeTuple;
  return {
    kind,
    x,
    y,
    w,
    h,
    label,
    id,
    color: color ?? undefined,
    direction: direction ?? undefined,
    filled: filled ?? undefined,
    fontSize: fontSize ?? undefined,
    groupId: groupId ?? undefined,
    src: src ?? undefined,
    points: points ?? undefined,
  };
}

/** Positional tuple for a Connector, with `from`/`to` flattened to their shapeId/x/y and
 * `waypoints` (if any) as `[x, y]` tuples rather than `{x, y}` objects. */
type ConnectorTuple = [
  string,
  string | undefined,
  number,
  number,
  string | undefined,
  number,
  number,
  string,
  string?,
  boolean?,
  ArrowDirection?,
  FontSize?,
  Connector['routing']?,
  number?,
  PtTuple[]?,
  string?,
];

function connectorToTuple(c: Connector): ConnectorTuple {
  return trimTrailing([
    c.id,
    c.from.shapeId,
    c.from.x,
    c.from.y,
    c.to.shapeId,
    c.to.x,
    c.to.y,
    c.label,
    c.color,
    c.dashed,
    c.arrowDirection,
    c.fontSize,
    c.routing,
    c.elbowRatio,
    c.waypoints?.map(ptToTuple),
    c.groupId,
  ]) as ConnectorTuple;
}

function tupleToConnector(t: unknown[]): Connector {
  const [
    id,
    fromShapeId,
    fromX,
    fromY,
    toShapeId,
    toX,
    toY,
    label,
    color,
    dashed,
    arrowDirection,
    fontSize,
    routing,
    elbowRatio,
    waypoints,
    groupId,
  ] = t as ConnectorTuple;
  // Same null normalization as tupleToShape (see there).
  return {
    id,
    from: { shapeId: fromShapeId ?? undefined, x: fromX, y: fromY },
    to: { shapeId: toShapeId ?? undefined, x: toX, y: toY },
    label,
    color: color ?? undefined,
    dashed: dashed ?? undefined,
    arrowDirection: arrowDirection ?? undefined,
    fontSize: fontSize ?? undefined,
    routing: routing ?? undefined,
    elbowRatio: elbowRatio ?? undefined,
    waypoints: waypoints?.map(tupleToPt) ?? undefined,
    groupId: groupId ?? undefined,
  };
}

interface CompactDoc {
  s: ShapeTuple[];
  c: ConnectorTuple[];
}

function toCompactDoc(doc: Doc): CompactDoc {
  const { shapes, connectors } = shortIds(doc);
  return { s: shapes.map(shapeToTuple), c: connectors.map(connectorToTuple) };
}

function fromCompactDoc(compact: CompactDoc): Doc {
  return { shapes: compact.s.map(tupleToShape), connectors: compact.c.map(tupleToConnector) };
}

/** Serializes `doc` into the compact wire format, deflates it, and base64url-encodes the
 * result for embedding as `#d=<payload>` in a share URL. */
export async function encodeShareDoc(doc: Doc): Promise<string> {
  const json = JSON.stringify(toCompactDoc(doc));
  const compressed = await compress(textEncoder.encode(json));
  return bytesToBase64Url(compressed);
}

/** Inverse of `encodeShareDoc`. Never throws: a malformed/truncated payload (bad base64,
 * a corrupt deflate stream, invalid JSON, JSON that isn't compact-doc-shaped, or a tuple
 * too short/malformed to destructure) resolves to `null`. */
export async function decodeShareDoc(payload: string): Promise<Doc | null> {
  try {
    const bytes = base64UrlToBytes(payload);
    const decompressed = await decompress(bytes);
    const json = textDecoder.decode(decompressed);
    const parsed = JSON.parse(json) as CompactDoc;
    if (!Array.isArray(parsed.s) || !Array.isArray(parsed.c)) return null;
    return fromCompactDoc(parsed);
  } catch {
    return null;
  }
}
