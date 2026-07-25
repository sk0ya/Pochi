import { afterEach, describe, expect, it, vi } from 'vitest';

/** A message the frontend posts to the host. */
interface HostMessage {
  id: number;
  op: string;
}

/** Reply for a message, or `undefined` to stay silent (the host has no handler for it). */
type Responder = (msg: HostMessage) => unknown;

/** Stands in for `window.chrome.webview`. `respond` lets a test play a host that answers the
 * handshake, one that answers everything but doesn't know `hello`, or one that never replies
 * at all - which is what happens when another app embeds Pochi in its own WebView2 pane. */
function installHost(respond: Responder | null): void {
  const listeners: ((e: { data: unknown }) => void)[] = [];
  const webview = {
    postMessage(msg: HostMessage) {
      if (!respond) return;
      const result = respond(msg);
      if (result === undefined) return;
      queueMicrotask(() => {
        for (const l of listeners) l({ data: { id: msg.id, result } });
      });
    },
    addEventListener(_type: 'message', cb: (e: { data: unknown }) => void) {
      listeners.push(cb);
    },
  };
  (globalThis as { window?: unknown }).window = { chrome: { webview } };
}

/** bridge.ts captures `chrome.webview` at import time, so each case needs a fresh module. */
async function loadBridge() {
  vi.resetModules();
  return import('./bridge');
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.useRealTimers();
});

describe('initBridge handshake', () => {
  it('adopts the ops a host advertises', async () => {
    installHost((msg) =>
      msg.op === 'hello' ? { app: 'pochi', version: 1, ops: ['pickFolder', 'listFiles'] } : undefined,
    );
    const bridge = await loadBridge();
    await bridge.initBridge();

    expect(bridge.isDesktop).toBe(true);
    expect(bridge.hasOp('pickFolder')).toBe(true);
    expect(bridge.hasOp('listFiles')).toBe(true);
    // Not advertised, so the UI behind it must stay hidden even though a host is present.
    expect(bridge.hasOp('saveFileDialog')).toBe(false);
  });

  it('falls back to the web build when nothing answers', async () => {
    // A foreign WebView2 pane: `chrome.webview` exists, but no handler ever replies. Detecting
    // on the object alone used to show the file-manager panel here, where it did nothing.
    installHost(null);
    const bridge = await loadBridge();

    vi.useFakeTimers();
    const done = bridge.initBridge();
    await vi.advanceTimersByTimeAsync(1000);
    await done;

    expect(bridge.isDesktop).toBe(false);
    expect(bridge.hasOp('pickFolder')).toBe(false);
  });

  it('assumes the full op set for a host that replies but has no `hello`', async () => {
    // The shell as shipped before the handshake existed: it answers every message, returning
    // null for ops it doesn't know, and implements all the file ops.
    installHost(() => null);
    const bridge = await loadBridge();
    await bridge.initBridge();

    expect(bridge.isDesktop).toBe(true);
    expect(bridge.hasOp('pickFolder')).toBe(true);
    expect(bridge.hasOp('saveFileDialog')).toBe(true);
  });

  it('stays on the web build with no webview object at all', async () => {
    (globalThis as { window?: unknown }).window = {};
    const bridge = await loadBridge();
    await bridge.initBridge();

    expect(bridge.isDesktop).toBe(false);
    expect(bridge.hasOp('pickFolder')).toBe(false);
  });
});
