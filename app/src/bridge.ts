/**
 * Bridge to the WPF/WebView2 host via postMessage. Falls back to browser
 * download / file-input when running on the web.
 */

interface WebView2 {
  postMessage(msg: unknown): void;
  addEventListener(type: 'message', cb: (e: { data: unknown }) => void): void;
}

const wv: WebView2 | undefined = (window as unknown as {
  chrome?: { webview?: WebView2 };
}).chrome?.webview;

export const isDesktop = !!wv;

const pending = new Map<number, (v: unknown) => void>();
let seq = 1;

if (wv) {
  wv.addEventListener('message', (e) => {
    const data = e.data as { id?: number; result?: unknown } | null;
    if (!data || typeof data.id !== 'number') return;
    const resolve = pending.get(data.id);
    if (resolve) {
      pending.delete(data.id);
      resolve(data.result ?? null);
    }
  });
}

function call<T>(op: string, args: Record<string, unknown>): Promise<T> {
  return new Promise((resolve) => {
    const id = seq++;
    pending.set(id, (v) => resolve(v as T));
    wv!.postMessage({ id, op, ...args });
  });
}

export type FileKind = 'json' | 'svg' | 'excalidraw';

/** Show a save dialog and write content. Returns the chosen path, or null. */
export function saveFileDialog(
  suggestedName: string,
  kind: FileKind,
  content: string,
): Promise<string | null> {
  return call('saveFileDialog', { suggestedName, kind, content });
}

/** Overwrite an already-known path without a dialog. */
export function writeFile(path: string, content: string): Promise<boolean> {
  return call('writeFile', { path, content });
}

/** Show an open dialog. Returns {name, content} or null. */
export function openFileDialog(
  kind: FileKind,
): Promise<{ name: string; content: string } | null> {
  return call('openFileDialog', { kind });
}

/** Read a previously-known path directly, without a dialog (for "recent files").
 * Returns null if the file no longer exists at that path. */
export function readFile(path: string): Promise<{ name: string; content: string } | null> {
  return call('readFile', { path });
}

/** Show a native image-open dialog; returns the file as a data URL, or null. */
export function openImageDialog(): Promise<{ name: string; dataUrl: string } | null> {
  return call('openImageDialog', {});
}

/* ---- file manager (desktop only) ---- */

/** One diagram file in a managed folder. */
export interface FolderFile {
  name: string;
  path: string;
}

/** Show a native folder picker (optionally seeded with `dir`). Returns the chosen folder, or null. */
export function pickFolder(dir?: string): Promise<string | null> {
  return call('pickFolder', { dir });
}

/** List the diagram files in `dir`, newest first. Returns null if the folder no longer exists. */
export function listFiles(dir: string): Promise<{ dir: string; files: FolderFile[] } | null> {
  return call('listFiles', { dir });
}

/** Create a new file in `dir`; the host uniquifies `name` on collision and returns the
 * actual path written (whose basename may differ from `name`), or null on failure. */
export function newFile(dir: string, name: string, content: string): Promise<string | null> {
  return call('newFile', { dir, name, content });
}

/** Rename `path` to `name` within its folder. Returns the new path, `{error:'exists'}` if
 * the target name is taken, or null on failure. */
export function renameFile(
  path: string,
  name: string,
): Promise<string | { error: string } | null> {
  return call('renameFile', { path, name });
}

/** Copy `path` to a "… copy" sibling. Returns the new path, or null on failure. */
export function duplicateFile(path: string): Promise<string | null> {
  return call('duplicateFile', { path });
}

/** Delete `path` from disk (callers confirm first). Returns true on success. */
export function deleteFile(path: string): Promise<boolean> {
  return call('deleteFile', { path });
}

/* ---- web fallbacks ---- */

export function downloadFile(name: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function pickFile(accept: string): Promise<{ name: string; content: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      resolve({ name: f.name, content: await f.text() });
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Web fallback for image import: opens a file picker and reads the image as a data URL. */
export function pickImageFile(): Promise<{ name: string; dataUrl: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve({ name: f.name, dataUrl: reader.result as string });
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(f);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
