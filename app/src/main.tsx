import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const container = document.getElementById('root')!;

/** In the desktop shell, the WPF host injects `window.__pochiDesktop` before any page
 * script runs (AddScriptToExecuteOnDocumentCreated); any other app embedding Pochi in its
 * own WebView2 pane injects `window.__pochiHost` the same way. The WebView2 bridge object
 * (`window.chrome.webview`) can attach a beat later than the remote page's module scripts
 * on first load, though — so bridge.ts, which captures it once at import time (the message
 * listener), would see it missing and permanently think it's the web build. Wait for the
 * bridge to appear before importing it. On the web the flag is absent, so we skip the wait.
 *
 * Then handshake with whatever host is there (initBridge) before importing App, so the
 * host's capabilities are known by first render and App can gate its desktop-only UI
 * synchronously. `chrome.webview` also exists when another app embeds Pochi in its own
 * WebView2 pane, and the handshake is what tells the two apart — see bridge.ts. */
async function boot() {
  const w = window as unknown as {
    __pochiDesktop?: boolean;
    __pochiHost?: boolean;
    chrome?: { webview?: unknown };
  };
  if ((w.__pochiDesktop || w.__pochiHost) && !w.chrome?.webview) {
    await new Promise<void>((resolve) => {
      let tries = 0;
      const timer = setInterval(() => {
        if (w.chrome?.webview || ++tries > 100) {
          clearInterval(timer);
          resolve();
        }
      }, 20);
    });
  }
  const { initBridge } = await import('./bridge');
  await initBridge();
  const { default: App } = await import('./App');
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
