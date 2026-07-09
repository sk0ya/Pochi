import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  downloadFile,
  isDesktop,
  openFileDialog,
  pickFile,
  saveFileDialog,
  writeFile,
} from './bridge';
import { Canvas } from './components/Canvas';
import { ContextMenu } from './components/ContextMenu';
import { HelpOverlay } from './components/HelpOverlay';
import { StatusBar } from './components/StatusBar';
import { TextEditOverlay } from './components/TextEditOverlay';
import { Toolbar } from './components/Toolbar';
import { exportSvg } from './model/svg';
import type { Doc } from './model/types';
import { initialState, reduce } from './state/reducer';
import type { EditorState } from './state/reducer';

const AUTOSAVE_KEY = 'pochi.autosave';
const VIM_KEY = 'pochi.vim';

function init(): EditorState {
  let doc: Doc | null = null;
  let vim = true;
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Doc;
      if (Array.isArray(parsed.shapes) && Array.isArray(parsed.connectors)) doc = parsed;
    }
    vim = localStorage.getItem(VIM_KEY) !== 'off';
  } catch {
    /* first run */
  }
  return initialState(doc, vim);
}

/** Keys the vim layer owns in normal/transient modes (prevent browser defaults). */
const HANDLED = new Set([
  'h', 'j', 'k', 'l', 'r', 'e', 'a', 't', 'i', 'v', 's', 'd', 'x', 'y', 'p', 'u',
  'Enter', 'Escape', '?',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Delete', 'Backspace',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
]);

export default function App() {
  const [state, dispatch] = useReducer(reduce, undefined, init);
  const stateRef = useRef(state);
  stateRef.current = state;

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
        case 'export':
          if (rest[0] === 'svg') await doExportSvg();
          else dispatch({ type: 'MSG', msg: 'usage: :export svg' });
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
    [save, open, doExportSvg],
  );

  /* global keyboard */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const s = stateRef.current;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (s.mode === 'insert' || s.mode === 'command') return;
      if (s.contextMenu) {
        dispatch({ type: 'CONTEXT_MENU_CLOSE' });
        if (e.key === 'Escape') return;
      }

      if (e.ctrlKey && e.key === 'c') {
        e.preventDefault();
        dispatch({ type: 'COPY' });
        return;
      }
      if (e.ctrlKey && e.key === 'v') {
        e.preventDefault();
        if (s.vim && s.mode === 'normal') dispatch({ type: 'KEY', key: 'p', ctrl: false });
        else dispatch({ type: 'PASTE_OFFSET' });
        return;
      }
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
        dispatch({ type: 'KEY', key: e.key, ctrl: false });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [save, open]);

  return (
    <div className="app">
      <Toolbar
        state={state}
        dispatch={dispatch}
        onSave={() => void save()}
        onOpen={() => void open()}
        onExportSvg={() => void doExportSvg()}
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
