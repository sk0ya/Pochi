import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  downloadFile,
  isDesktop,
  openFileDialog,
  openImageDialog,
  pickFile,
  pickImageFile,
  saveFileDialog,
  writeFile,
} from './bridge';
import { Canvas } from './components/Canvas';
import { ContextMenu } from './components/ContextMenu';
import { HelpOverlay } from './components/HelpOverlay';
import { StatusBar } from './components/StatusBar';
import { TextEditOverlay } from './components/TextEditOverlay';
import { Toolbar } from './components/Toolbar';
import { subsetDoc } from './model/doc';
import { exportSvg, exportViewport } from './model/svg';
import type { Doc } from './model/types';
import { GRID } from './model/types';
import { copySvgAsPng } from './pngClipboard';
import { IMAGE_MAX_DIM, initialState, parseClipboard, reduce, serializeClipboard } from './state/reducer';
import type { EditorState } from './state/reducer';

const AUTOSAVE_KEY = 'pochi.autosave';
const VIM_KEY = 'pochi.vim';

function init(): EditorState {
  let doc: Doc | null = null;
  let vim = false;
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Doc;
      if (Array.isArray(parsed.shapes) && Array.isArray(parsed.connectors)) doc = parsed;
    }
    vim = localStorage.getItem(VIM_KEY) === 'on';
  } catch {
    /* first run */
  }
  return initialState(doc, vim);
}

/** Keys the vim layer owns in normal/transient modes (prevent browser defaults). */
const HANDLED = new Set([
  'h', 'j', 'k', 'l', 'r', 'e', 'q', 'w', 'a', 'f', 't', 'i', 'v', 's', 'd', 'x', 'y', 'p', 'u', 'o',
  'n', 'N', '.', 'm', "'",
  'Enter', 'Escape', '?',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Delete', 'Backspace',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
]);

export default function App() {
  const [state, dispatch] = useReducer(reduce, undefined, init);
  const stateRef = useRef(state);
  stateRef.current = state;

  /* Mirror the internal shape clipboard onto the real OS clipboard (tagged so
   * we can recognize our own echo on paste) whenever it changes. This makes
   * the OS clipboard the single source of truth for "what was copied last" -
   * internal shape copy and external text copy can then alternate freely. */
  useEffect(() => {
    if (!state.clipboard) return;
    navigator.clipboard?.writeText?.(serializeClipboard(state.clipboard)).catch(() => {
      /* no permission; internal paste (vim p / Ctrl+V) still works via state.clipboard */
    });
  }, [state.clipboard]);

  /* autosave */
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(state.doc));
      } catch {
        /* storage full/unavailable */
      }
    }, 300);
    return () => clearTimeout(t);
  }, [state.doc]);

  useEffect(() => {
    try {
      localStorage.setItem(VIM_KEY, state.vim ? 'on' : 'off');
    } catch {
      /* ignore */
    }
  }, [state.vim]);

  const save = useCallback(async (nameArg?: string) => {
    const s = stateRef.current;
    const json = JSON.stringify({ app: 'pochi', version: 1, doc: s.doc }, null, 2);
    if (isDesktop) {
      if (!nameArg && s.fileName) {
        await writeFile(s.fileName, json);
        dispatch({ type: 'SAVED', fileName: s.fileName });
        return;
      }
      const path = await saveFileDialog(nameArg ?? 'diagram.pochi.json', 'json', json);
      if (path) dispatch({ type: 'SAVED', fileName: path });
    } else {
      const name = nameArg ?? s.fileName ?? 'diagram.pochi.json';
      downloadFile(name, json, 'application/json');
      dispatch({ type: 'SAVED', fileName: name });
    }
  }, []);

  const open = useCallback(async () => {
    const picked = isDesktop
      ? await openFileDialog('json')
      : await pickFile('.json,.pochi.json,application/json');
    if (!picked) return;
    try {
      const parsed = JSON.parse(picked.content) as { app?: string; doc?: Doc };
      const doc = parsed.doc ?? (parsed as unknown as Doc);
      if (!Array.isArray(doc.shapes) || !Array.isArray(doc.connectors)) throw new Error('bad');
      dispatch({ type: 'LOAD', doc, fileName: picked.name });
    } catch {
      dispatch({ type: 'MSG', msg: `not a pochi file: ${picked.name}` });
    }
  }, []);

  const doExportSvg = useCallback(async () => {
    const svg = exportSvg(stateRef.current.doc);
    if (isDesktop) {
      const path = await saveFileDialog('diagram.svg', 'svg', svg);
      if (path) dispatch({ type: 'MSG', msg: `exported ${path}` });
    } else {
      downloadFile('diagram.svg', svg, 'image/svg+xml');
      dispatch({ type: 'MSG', msg: 'exported diagram.svg' });
    }
  }, []);

  /** Copies the current selection (or, absent one, the whole doc) as a PNG to the OS
   * clipboard, falling back to a download; reuses the :svg serializer for pixel parity. */
  const doCopyPng = useCallback(async () => {
    const s = stateRef.current;
    const target = s.selectedIds.length ? subsetDoc(s.doc, s.selectedIds) : s.doc;
    const svg = exportSvg(target);
    const { w, h } = exportViewport(target);
    try {
      const result = await copySvgAsPng(svg, { w, h });
      dispatch({
        type: 'MSG',
        msg: result === 'clipboard' ? 'copied PNG to clipboard' : 'clipboard unavailable, downloaded diagram.png',
      });
    } catch {
      dispatch({ type: 'MSG', msg: 'PNG export failed' });
    }
  }, []);

  const addImageFromDataUrl = useCallback(async (dataUrl: string) => {
    const dims = await new Promise<{ w: number; h: number }>((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth || IMAGE_MAX_DIM, h: img.naturalHeight || IMAGE_MAX_DIM });
      img.onerror = () => resolve({ w: IMAGE_MAX_DIM, h: IMAGE_MAX_DIM });
      img.src = dataUrl;
    });
    const scale = Math.min(1, IMAGE_MAX_DIM / Math.max(dims.w, dims.h, 1));
    const w = Math.max(GRID, Math.round((dims.w * scale) / GRID) * GRID);
    const h = Math.max(GRID, Math.round((dims.h * scale) / GRID) * GRID);
    dispatch({ type: 'ADD_IMAGE', src: dataUrl, w, h });
  }, []);

  const importImage = useCallback(async () => {
    const picked = isDesktop ? await openImageDialog() : await pickImageFile();
    if (!picked) return;
    await addImageFromDataUrl(picked.dataUrl);
  }, [addImageFromDataUrl]);

  const runCommand = useCallback(
    async (raw: string) => {
      dispatch({ type: 'CMD_CLOSE' });
      const text = raw.trim();
      if (!text) return;
      const [cmd, ...rest] = text.split(/\s+/);
      switch (cmd) {
        case 'w':
        case 'write':
          await save(rest[0]);
          break;
        case 'wq':
          await save(rest[0]);
          window.close();
          break;
        case 'o':
        case 'e':
        case 'open':
          await open();
          break;
        case 'svg':
          await doExportSvg();
          break;
        case 'png':
          await doCopyPng();
          break;
        case 'export':
          if (rest[0] === 'svg') await doExportSvg();
          else if (rest[0] === 'png') await doCopyPng();
          else dispatch({ type: 'MSG', msg: 'usage: :export svg|png' });
          break;
        case 'new':
        case 'clear':
          dispatch({ type: 'NEW' });
          break;
        case 'vim':
          dispatch({
            type: 'SET_VIM',
            on: rest[0] ? rest[0] === 'on' : !stateRef.current.vim,
          });
          break;
        case 'q':
        case 'quit':
          window.close();
          break;
        case 'h':
        case 'help':
          dispatch({ type: 'TOGGLE_HELP' });
          break;
        default:
          dispatch({ type: 'MSG', msg: `unknown command: ${cmd}` });
      }
    },
    [save, open, doExportSvg, doCopyPng],
  );

  /* global keyboard */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const s = stateRef.current;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (s.mode === 'insert' || s.mode === 'command' || s.mode === 'search') return;
      if (s.contextMenu) {
        dispatch({ type: 'CONTEXT_MENU_CLOSE' });
        if (e.key === 'Escape') return;
      }
      // HINT mode needs the full alphabet for two-letter labels, not just the
      // fixed HANDLED set below.
      if (s.mode === 'hint') {
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (e.key === 'Escape' || /^[a-zA-Z]$/.test(e.key)) {
          e.preventDefault();
          dispatch({ type: 'KEY', key: e.key, ctrl: false, shift: e.shiftKey });
        }
        return;
      }
      // A pending `m`/`'` sequence (awaiting the mark letter) needs to see any key, not just
      // the fixed HANDLED set, so a stray non-letter key can reach the reducer and silently
      // cancel it (mirrors the HINT-mode bypass above). A successful `'{letter}` jump has no
      // view-follow of its own (plain cursor movement doesn't pan/center the view either — see
      // the `z` handler below), so it would leave the cursor off-screen on a large canvas; we
      // re-center on it explicitly, the same way `z` does, right after the jump lands.
      if (s.mode === 'normal' && s.pending) {
        if (e.ctrlKey || e.altKey || e.metaKey) {
          // A modifier combo means the user abandoned the mark sequence: cancel the
          // pending state (silent Esc-equivalent in the reducer) and fall through so
          // the combo still takes its normal path below (Ctrl+S must still save, etc.)
          // rather than leaving `pending` dangling for the next plain keypress.
          dispatch({ type: 'KEY', key: 'Escape', ctrl: false });
        } else {
          e.preventDefault();
          const willJump = s.pending === 'mark-jump' && /^[a-z]$/.test(e.key) && !!s.marks[e.key];
          dispatch({ type: 'KEY', key: e.key, ctrl: false, shift: e.shiftKey });
          if (willJump) {
            dispatch({ type: 'CENTER', screenW: window.innerWidth, screenH: window.innerHeight });
          }
          return;
        }
      }

      // Ctrl+Alt+C, not Ctrl+Shift+C: the latter is Chromium's "inspect element"
      // shortcut, which pages can't preventDefault (applies to WebView2 too).
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        void doCopyPng();
        return;
      }
      if (e.ctrlKey && e.key === 'c') {
        e.preventDefault();
        dispatch({ type: 'COPY' });
        return;
      }
      // Ctrl+V is handled entirely by the native 'paste' listener below (it
      // has direct access to what's actually on the OS clipboard right now,
      // so it can pick correctly between an image, our own shape copy, or
      // fresh external text without guessing).
      if (e.ctrlKey && e.key === 'd') {
        e.preventDefault();
        dispatch({ type: 'DUPLICATE' });
        return;
      }
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        void save();
        return;
      }
      if (e.ctrlKey && e.key === 'o') {
        e.preventDefault();
        void open();
        return;
      }
      if (e.ctrlKey && e.key === 'a') {
        e.preventDefault();
        dispatch({ type: 'SELECT_ALL' });
        return;
      }
      if (e.ctrlKey && e.key === 'g') {
        e.preventDefault();
        dispatch({ type: 'TOGGLE_GROUP' });
        return;
      }
      if (e.ctrlKey && (e.key === ']' || e.key === '[')) {
        e.preventDefault();
        if (s.selectedIds.length) {
          dispatch({ type: 'REORDER', ids: s.selectedIds, dir: e.key === ']' ? 'forward' : 'backward' });
        }
        return;
      }
      if (s.showHelp && (e.key === 'Escape' || e.key === '?')) {
        e.preventDefault();
        dispatch({ type: 'TOGGLE_HELP' });
        return;
      }
      if (s.vim && e.key === ':' && s.mode === 'normal') {
        e.preventDefault();
        dispatch({ type: 'CMD_OPEN' });
        return;
      }
      if (s.vim && e.key === '/' && s.mode === 'normal') {
        e.preventDefault();
        dispatch({ type: 'SEARCH_OPEN' });
        return;
      }
      if (e.key === '+' || e.key === '=' || e.key === '-') {
        e.preventDefault();
        dispatch({
          type: 'ZOOM',
          factor: e.key === '-' ? 1 / 1.2 : 1.2,
          center: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
        });
        return;
      }
      if (s.vim && e.key === 'z' && s.mode === 'normal' && !e.ctrlKey) {
        e.preventDefault();
        dispatch({ type: 'CENTER', screenW: window.innerWidth, screenH: window.innerHeight });
        return;
      }
      if (e.ctrlKey && (e.key === 'r' || e.key === 'z' || e.key === 'y')) {
        e.preventDefault();
        dispatch({ type: 'KEY', key: e.key, ctrl: true });
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (HANDLED.has(e.key)) {
        e.preventDefault();
        dispatch({ type: 'KEY', key: e.key, ctrl: false, shift: e.shiftKey });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [save, open, doCopyPng]);

  /* paste an image or plain text from the OS clipboard */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageItem = Array.from(items).find((it) => it.type.startsWith('image/'));
      if (imageItem) {
        const file = imageItem.getAsFile();
        if (!file) return;
        e.preventDefault();
        const reader = new FileReader();
        reader.onload = () => void addImageFromDataUrl(reader.result as string);
        reader.readAsDataURL(file);
        return;
      }
      const text = e.clipboardData?.getData('text/plain');
      if (!text?.trim()) return;
      // Our own shape copy, echoed back through the OS clipboard: paste it as
      // shapes instead of literal text.
      const clip = parseClipboard(text);
      if (clip) {
        e.preventDefault();
        dispatch({ type: 'PASTE_CLIP', clip });
        return;
      }
      e.preventDefault();
      dispatch({ type: 'ADD_TEXT', text });
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addImageFromDataUrl]);

  return (
    <div className="app">
      <Toolbar
        state={state}
        dispatch={dispatch}
        onSave={() => void save()}
        onOpen={() => void open()}
        onExportSvg={() => void doExportSvg()}
        onCopyPng={() => void doCopyPng()}
        onImportImage={() => void importImage()}
      />
      <div className="canvas-wrap">
        <Canvas state={state} dispatch={dispatch} />
        <TextEditOverlay state={state} dispatch={dispatch} />
        <ContextMenu state={state} dispatch={dispatch} />
      </div>
      <StatusBar state={state} dispatch={dispatch} runCommand={runCommand} />
      {state.showHelp && <HelpOverlay dispatch={dispatch} />}
    </div>
  );
}
