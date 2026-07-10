/**
 * Codec for the `:share` command: Doc -> deflate-compressed, base64url-encoded payload
 * embeddable in a URL fragment (`#d=<payload>`), and back.
 *
 * The byte<->base64url helpers are pure/sync so they're trivially unit-testable; the
 * compress/decompress helpers wrap the native CompressionStream/DecompressionStream
 * (no new dependency) and are therefore async, same as the rest of Pochi's Web-API-backed
 * IO (see pngClipboard.ts). `encodeShareDoc`/`decodeShareDoc` never throw on bad input —
 * a corrupted or truncated payload resolves `decodeShareDoc` to `null` so callers (startup
 * hash parsing in App.tsx) can fall back to the normal autosave restore instead of crashing.
 */
import type { Doc } from './model/types';

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

/** Serializes `doc`, deflates it, and base64url-encodes the result for embedding as
 * `#d=<payload>` in a share URL. */
export async function encodeShareDoc(doc: Doc): Promise<string> {
  const json = JSON.stringify(doc);
  const compressed = await compress(textEncoder.encode(json));
  return bytesToBase64Url(compressed);
}

/** Inverse of `encodeShareDoc`. Never throws: a malformed/truncated payload (bad base64,
 * a corrupt deflate stream, invalid JSON, or JSON that isn't doc-shaped) resolves to `null`. */
export async function decodeShareDoc(payload: string): Promise<Doc | null> {
  try {
    const bytes = base64UrlToBytes(payload);
    const decompressed = await decompress(bytes);
    const json = textDecoder.decode(decompressed);
    const parsed = JSON.parse(json) as Doc;
    if (!Array.isArray(parsed.shapes) || !Array.isArray(parsed.connectors)) return null;
    return parsed;
  } catch {
    return null;
  }
}
