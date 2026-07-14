import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const container = document.getElementById('root')!;

/** In the desktop shell, the WPF host injects `window.__pochiDesktop` before any page
 * script runs (AddScriptToExecuteOnDocumentCreated). The WebView2 bridge object
 * (`window.chrome.webview`) can attach a beat later than the remote page's module scripts
 * on first load, though — so bridge.ts, which captures it once at import time (isDesktop,
 * the message listener), would see it missing and permanently think it's the web build.
 * Wait for the bridge to appear before importing App (and transitively bridge.ts) so that
 * capture is correct. On the web the flag is absent, so we mount immediately. */
async function boot() {
  const w = window as unknown as { __pochiDesktop?: boolean; chrome?: { webview?: unknown } };
  if (w.__pochiDesktop && !w.chrome?.webview) {
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
  const { default: App } = await import('./App');
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
