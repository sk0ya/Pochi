import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  downloadFile,
  isDesktop,
  openFileDialog,
  openImageDialog,
  pickFile,
  pickImageFile,
  readFile,
  saveFileDialog,
  writeFile,
} from './bridge';
import { CollabSession } from './collab/session';
import { fetchIceServers } from './collab/ice';
import { ActivityBar } from './components/ActivityBar';
import type { PanelId } from './components/ActivityBar';
import { Canvas } from './components/Canvas';
import { ContextMenu } from './components/ContextMenu';
import { HelpOverlay } from './components/HelpOverlay';
import { PropertiesSidebar } from './components/PropertiesSidebar';
import { RemoteCursors } from './components/RemoteCursors';
import { StatusBar } from './components/StatusBar';
import { TemplateSidebar } from './components/TemplateSidebar';
import { TextEditOverlay } from './components/TextEditOverlay';
import { Toolbar } from './components/Toolbar';
import { docToExcalidraw, excalidrawToDoc } from './excalidraw';
import { subsetDoc } from './model/doc';
import { exportBackground, exportSvg, exportViewport } from './model/svg';
import type { ExportTheme } from './model/svg';
import type { Doc, Pt } from './model/types';
import { GRID } from './model/types';
import { copySvgAsPng } from './pngClipboard';
import { decodeShareDoc, encodeShareDoc, SHARE_URL_WARN_CHARS } from './share';
import { IMAGE_MAX_DIM, initialState, isDirty, parseClipboard, reduce, serializeClipboard } from './state/reducer';
import type { EditorState } from './state/reducer';

const AUTOSAVE_KEY = 'pochi.autosave';
const VIM_KEY = 'pochi.vim';
const THEME_KEY = 'pochi.theme';
const RECENT_KEY = 'pochi.recentFiles';
const RECENT_MAX = 8;
const SHARE_HASH_PREFIX = '#d=';
const ROOM_HASH_PREFIX = '#room=';
/** Room ids we mint are 10 base36 chars; accept a superset so hand-shared ids stay lenient. */
const ROOM_ID_RE = /^[a-zA-Z0-9-]{4,64}$/;

function newRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}
// The desktop shell hosts app/dist at a local virtual origin (see bridge.ts's `isDesktop`
// detection) - a `https://app.pochi/...` URL is meaningless outside that WebView2 instance,
// so shared links from the desktop build point at the public GitHub Pages deployment instead.
const PUBLIC_BASE_URL = 'https://sk0ya.github.io/Pochi/';

function readAutosave(): Doc | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Doc;
    if (Array.isArray(parsed.shapes) && Array.isArray(parsed.connectors)) return parsed;
  } catch {
    /* first run / corrupt storage */
  }
  return null;
}

/** "Recent files" is desktop-only: `openFileDialog`/`saveFileDialog` return a real
 * filesystem path there (so it can be reopened later via `readFile`), whereas on the
 * web build the same field is just a suggested download name with nothing behind it. */
export interface RecentFile {
  path: string;
  name: string;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function readRecentFiles(): RecentFile[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((f) => typeof f?.path === 'string');
  } catch {
    /* first run / corrupt storage */
  }
  return [];
}

/** Moves `path` to the front (adding it if new), capped at RECENT_MAX. */
function addRecent(list: RecentFile[], path: string): RecentFile[] {
  const rest = list.filter((f) => f.path !== path);
  return [{ path, name: basename(path) }, ...rest].slice(0, RECENT_MAX);
}

function removeRecent(list: RecentFile[], path: string): RecentFile[] {
  return list.filter((f) => f.path !== path);
}

/** Parses picked file content into a Doc, accepting either Pochi's own `{app,version,doc}`
 * envelope or a raw Excalidraw scene (`{type:'excalidraw',...}`) - so "Open" works as a
 * single unified action regardless of which app produced the file, rather than needing a
 * separate import command. Returns null (never throws) if `content` is neither. */
function parseOpenedFile(content: string): { doc: Doc; source: 'pochi' | 'excalidraw'; version?: unknown } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const p = parsed as { app?: string; version?: unknown; doc?: Doc; shapes?: unknown; connectors?: unknown };
  const doc = p.doc ?? (parsed as Doc);
  if (Array.isArray(doc?.shapes) && Array.isArray(doc?.connectors)) {
    return { doc, source: 'pochi', version: p.version };
  }
  const excalidrawDoc = excalidrawToDoc(parsed);
  if (excalidrawDoc) return { doc: excalidrawDoc, source: 'excalidraw' };
  return null;
}

/** Files are saved with an envelope `{ app, version, doc }`; `version` is bumped when the
 * on-disk format changes. All changes so far are additive, so a newer version still loads
 * fine here - this just warns the user their file may not render correctly, in case a future
 * version drops/renames something this build doesn't know about. */
function newerVersionWarning(parsed: { version?: unknown }): string | null {
  return typeof parsed.version === 'number' && parsed.version > 1
    ? '新しいバージョンの Pochi で保存されたファイルです。正しく表示されない可能性があります'
    : null;
}

function init(): EditorState {
  let doc: Doc | null = null;
  let vim = false;
  try {
    // A `#d=` share link takes priority over the localStorage autosave, but decoding it is
    // async (CompressionStream), so it can't be resolved here in the synchronous reducer
    // init - the startup effect below loads it and dispatches LOAD once decoded. Skip the
    // autosave read in that case so it can't win a race by rendering first; if the share
    // payload turns out corrupt, that same effect falls back to loading the autosave itself.
    if (!location.hash.startsWith(SHARE_HASH_PREFIX)) doc = readAutosave();
    vim = localStorage.getItem(VIM_KEY) === 'on';
  } catch {
    /* first run */
  }
  return initialState(doc, vim);
}

/** Optional export-theme argument of :svg / :png / :export — absent (undefined) means
 * "follow the app theme" (WYSIWYG); anything other than light/dark is a usage error (null). */
function parseExportTheme(arg: string | undefined): ExportTheme | undefined | null {
  if (arg === undefined) return undefined;
  return arg === 'light' || arg === 'dark' ? arg : null;
}

/** Keys the vim layer owns in normal/transient modes (prevent browser defaults). */
const HANDLED = new Set([
  'h', 'j', 'k', 'l', 'r', 'e', 'q', 'g', 'w', 'a', 'f', 't', 'i', 'v', 's', 'd', 'x', 'y', 'p', 'u', 'o',
  'n', 'N', '.', 'm', "'",
  'Enter', 'Escape', '?',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Delete', 'Backspace',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
]);

export default function App() {
  const [state, dispatch] = useReducer(reduce, undefined, init);
  const stateRef = useRef(state);
  stateRef.current = state;
  // True from mount until the share-hash startup effect below resolves (success or failure).
  // `init()` already skipped the localStorage autosave read in this case (see its comment);
  // this flag keeps the autosave *write* effect from firing on the still-empty initial doc
  // in the meantime, so a slow decode can never clobber a real autosave with an empty one.
  const hashPendingRef = useRef(location.hash.startsWith(SHARE_HASH_PREFIX));
  // One-shot latch for that effect, separate from hashPendingRef (which must stay true until
  // the decode *resolves*, so it can't double as the latch): StrictMode double-invokes
  // effects, and run #1 clears the hash synchronously, so an unlatched run #2 would decode
  // the now-empty hash to null and race a stale autosave-fallback LOAD against the real one.
  const hashLoadStartedRef = useRef(false);

  /* App-wide theme (editor UI + canvas), persisted like the vim toggle. Defaults to dark
   * (the historical look). Exports follow it for WYSIWYG — what you see on the canvas is
   * what :svg / :png produce — unless an explicit `:svg dark` / `:png light` argument
   * overrides it for that one export. The CSS lives in styles.css: the light values are
   * selected by the data-theme attribute stamped on <html> below. */
  const [theme, setTheme] = useState<ExportTheme>(() => {
    try {
      return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });
  const themeRef = useRef(theme);
  themeRef.current = theme;
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);

  /* Which ActivityBar panel is open (see ActivityBar/TemplateSidebar/PropertiesSidebar), if any.
   * Session-only UI state, not persisted. */
  const [activePanel, setActivePanel] = useState<PanelId | null>(null);

  /* "Recent files" (desktop only - see RecentFile above). Persisted like theme/vim; updated
   * from `save`/`open`/`openRecent` below whenever a real path is involved. */
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>(() =>
    isDesktop ? readRecentFiles() : [],
  );
  useEffect(() => {
    if (!isDesktop) return;
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recentFiles));
    } catch {
      /* storage unavailable */
    }
  }, [recentFiles]);

  /** New/Open/joining a collab room all replace the current doc wholesale - confirm first if
   * there are changes since the last load/save, so a stray click/`:new`/`:o`/room link doesn't
   * silently blow away work in progress. New/Open leave it undo-recoverable; joining a room
   * deliberately does not (see the COLLAB_DOC reducer case), so this confirm is the only
   * safety net there. */
  const confirmDiscard = useCallback((message: string) => {
    return !isDirty(stateRef.current) || window.confirm(message);
  }, []);

  /* P2P collaboration (see collab/session.ts). The session lives in a ref — it's an
   * imperative connection, not render state; React state only mirrors what the UI
   * shows (room id, peer list, remote cursors). */
  const collabRef = useRef<CollabSession | null>(null);
  // Guards the async gap in joinCollab (fetching TURN credentials) so a second join
  // can't slip in before collabRef is set — collabRef alone only becomes truthy after.
  const joiningRef = useRef(false);
  const [collabRoom, setCollabRoom] = useState<string | null>(null);
  const [collabPeers, setCollabPeers] = useState<string[]>([]);
  const [peerCursors, setPeerCursors] = useState<Record<string, Pt>>({});

  const joinCollab = useCallback(async (roomId: string, viaUrl: boolean) => {
    if (collabRef.current || joiningRef.current) return;
    joiningRef.current = true;
    try {
      // TURN credentials come from a Worker; fetch before joining so peers behind a VPN
      // can relay. Best-effort (STUN-only fallback) — this never blocks joining a room.
      const iceServers = await fetchIceServers();
      if (collabRef.current) return; // left/rejoined during the fetch — abandon this join
      collabRef.current = new CollabSession(
        roomId,
        stateRef.current.doc,
        viaUrl,
        {
          applyOps: (ops) => dispatch({ type: 'COLLAB_OPS', ops }),
          applySnapshot: (doc) => dispatch({ type: 'COLLAB_DOC', doc, msg: 'loaded diagram from room' }),
          onPeersChange: (peers) => setCollabPeers(peers),
          onCursor: (peerId, p) =>
            setPeerCursors((prev) => {
              if (!p) {
                const { [peerId]: _gone, ...rest } = prev;
                return rest;
              }
              return { ...prev, [peerId]: p };
            }),
        },
        { iceServers },
      );
      setCollabRoom(roomId);
      setCollabPeers([]);
      history.replaceState(null, '', location.pathname + location.search + ROOM_HASH_PREFIX + roomId);
    } finally {
      joiningRef.current = false;
    }
  }, []);

  const leaveCollab = useCallback(() => {
    if (!collabRef.current) return;
    collabRef.current.leave();
    collabRef.current = null;
    setCollabRoom(null);
    setCollabPeers([]);
    setPeerCursors({});
    history.replaceState(null, '', location.pathname + location.search);
    dispatch({ type: 'MSG', msg: 'left collab room' });
  }, []);

  /** Starts a room (or re-shares the current one) and puts its URL on the clipboard.
   * Anyone opening that URL joins the room — the room id in the hash is the only key. */
  const startCollab = useCallback(async () => {
    const roomId = collabRef.current?.roomId ?? newRoomId();
    if (!collabRef.current) void joinCollab(roomId, false);
    const base = isDesktop ? PUBLIC_BASE_URL : location.origin + location.pathname;
    const url = `${base}${ROOM_HASH_PREFIX}${roomId}`;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard API unavailable');
      await navigator.clipboard.writeText(url);
      dispatch({ type: 'MSG', msg: 'collab room URL copied — anyone with the URL can join' });
    } catch {
      window.prompt('collab room URL (copy manually):', url);
      dispatch({ type: 'MSG', msg: 'collab room ready — clipboard unavailable, copy from the dialog' });
    }
  }, [joinCollab]);

  /* Join a `#room=<id>` URL at startup, or when one is pasted into the address bar of an
   * already-open tab (that's a same-document navigation — only a hashchange fires, the app
   * doesn't remount). The hash is kept (unlike `#d=` share links) so a reload rejoins the
   * same room and the URL stays shareable from the address bar. */
  useEffect(() => {
    const tryJoinFromHash = () => {
      if (!location.hash.startsWith(ROOM_HASH_PREFIX) || collabRef.current) return;
      const roomId = location.hash.slice(ROOM_HASH_PREFIX.length);
      if (!ROOM_ID_RE.test(roomId)) {
        dispatch({ type: 'MSG', msg: 'invalid collab room URL' });
        return;
      }
      if (!confirmDiscard('保存されていない変更があります。共同編集ルームに参加しますか?')) return;
      void joinCollab(roomId, true);
      dispatch({ type: 'MSG', msg: `joining collab room ${roomId}…` });
    };
    tryJoinFromHash();
    window.addEventListener('hashchange', tryJoinFromHash);
    return () => window.removeEventListener('hashchange', tryJoinFromHash);
  }, [joinCollab, confirmDiscard]);

  /* Feed every doc change into the collab session (batched/diffed inside). */
  useEffect(() => {
    collabRef.current?.docChanged(state.doc);
  }, [state.doc]);

  /* Share the local cursor with peers (throttled inside). */
  useEffect(() => {
    collabRef.current?.cursorMoved(state.cursor);
  }, [state.cursor]);

  /* Best-effort flush + goodbye when the tab closes, so peers see the departure
   * immediately instead of waiting for the WebRTC connection to time out. */
  useEffect(() => {
    const onUnload = () => collabRef.current?.leave();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

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

  /* Load a `#d=<payload>` share link at startup, in place of the localStorage autosave
   * (see init()/hashPendingRef above for why the autosave read was skipped). Clears the
   * hash immediately so a later reload doesn't re-import the same snapshot over newer
   * edits. Runs once on mount; intentionally ignores subsequent hash changes. */
  useEffect(() => {
    if (!hashPendingRef.current || hashLoadStartedRef.current) return;
    hashLoadStartedRef.current = true;
    const payload = location.hash.slice(SHARE_HASH_PREFIX.length);
    history.replaceState(null, '', location.pathname + location.search);
    // If the user manages to edit before the (async) decode resolves, their edit wins:
    // a doc identity change from this initial reference means "don't clobber it below".
    const docAtStart = stateRef.current.doc;
    void (async () => {
      const doc = await decodeShareDoc(payload);
      const loaded = doc ?? readAutosave();
      hashPendingRef.current = false;
      if (stateRef.current.doc !== docAtStart) {
        dispatch({ type: 'MSG', msg: 'share link ignored: document was edited while it loaded' });
        return;
      }
      if (loaded) dispatch({ type: 'LOAD', doc: loaded, fileName: null });
      dispatch({
        type: 'MSG',
        msg: doc ? 'loaded diagram from share link' : 'share link is invalid or corrupted',
      });
    })();
  }, []);

  /* autosave */
  useEffect(() => {
    const t = setTimeout(() => {
      if (hashPendingRef.current) return; // let the share-link load above resolve first
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
        setRecentFiles((r) => addRecent(r, s.fileName!));
        return;
      }
      const path = await saveFileDialog(nameArg ?? 'diagram.pochi.json', 'json', json);
      if (path) {
        dispatch({ type: 'SAVED', fileName: path });
        setRecentFiles((r) => addRecent(r, path));
      }
    } else {
      const name = nameArg ?? s.fileName ?? 'diagram.pochi.json';
      downloadFile(name, json, 'application/json');
      dispatch({ type: 'SAVED', fileName: name });
    }
  }, []);

  const open = useCallback(async () => {
    if (!confirmDiscard('保存されていない変更があります。開きますか?')) return;
    const picked = isDesktop
      ? await openFileDialog('json')
      : await pickFile('.json,.pochi.json,.excalidraw,application/json');
    if (!picked) return;
    const result = parseOpenedFile(picked.content);
    if (!result) {
      dispatch({ type: 'MSG', msg: `not a pochi or excalidraw file: ${picked.name}` });
      return;
    }
    dispatch({ type: 'LOAD', doc: result.doc, fileName: picked.name });
    if (result.source === 'excalidraw') dispatch({ type: 'MSG', msg: `imported Excalidraw file: ${picked.name}` });
    else {
      const warning = newerVersionWarning({ version: result.version });
      if (warning) dispatch({ type: 'MSG', msg: warning });
    }
    if (isDesktop) setRecentFiles((r) => addRecent(r, picked.name));
  }, [confirmDiscard]);

  const requestNew = useCallback(() => {
    if (!confirmDiscard('保存されていない変更があります。新規作成しますか?')) return;
    dispatch({ type: 'NEW' });
  }, [confirmDiscard]);

  /** Reopens a path from the "recent files" list directly, without a dialog. Desktop only -
   * see RecentFile above. Self-heals a stale entry (file moved/deleted) by dropping it. */
  const openRecent = useCallback(async (path: string) => {
    if (!confirmDiscard('保存されていない変更があります。開きますか?')) return;
    const picked = await readFile(path);
    if (!picked) {
      dispatch({ type: 'MSG', msg: `file not found: ${path}` });
      setRecentFiles((r) => removeRecent(r, path));
      return;
    }
    const result = parseOpenedFile(picked.content);
    if (!result) {
      dispatch({ type: 'MSG', msg: `not a pochi or excalidraw file: ${picked.name}` });
      setRecentFiles((r) => removeRecent(r, path));
      return;
    }
    dispatch({ type: 'LOAD', doc: result.doc, fileName: picked.name });
    if (result.source === 'excalidraw') dispatch({ type: 'MSG', msg: `imported Excalidraw file: ${picked.name}` });
    else {
      const warning = newerVersionWarning({ version: result.version });
      if (warning) dispatch({ type: 'MSG', msg: warning });
    }
    setRecentFiles((r) => addRecent(r, picked.name));
  }, [confirmDiscard]);

  const removeRecentFile = useCallback((path: string) => {
    setRecentFiles((r) => removeRecent(r, path));
  }, []);

  const doExportSvg = useCallback(async (themeArg?: ExportTheme) => {
    const svg = exportSvg(stateRef.current.doc, themeArg ?? themeRef.current);
    if (isDesktop) {
      const path = await saveFileDialog('diagram.svg', 'svg', svg);
      if (path) dispatch({ type: 'MSG', msg: `exported ${path}` });
    } else {
      downloadFile('diagram.svg', svg, 'image/svg+xml');
      dispatch({ type: 'MSG', msg: 'exported diagram.svg' });
    }
  }, []);

  /** Exports the current doc as a standalone `.excalidraw` scene (see excalidraw.ts for
   * the shape/connector mapping) - a lossy but visually-faithful alternate format,
   * unlike Save which always round-trips Pochi's own model exactly. */
  const doExportExcalidraw = useCallback(async () => {
    const json = JSON.stringify(docToExcalidraw(stateRef.current.doc), null, 2);
    if (isDesktop) {
      const path = await saveFileDialog('diagram.excalidraw', 'excalidraw', json);
      if (path) dispatch({ type: 'MSG', msg: `exported ${path}` });
    } else {
      downloadFile('diagram.excalidraw', json, 'application/json');
      dispatch({ type: 'MSG', msg: 'exported diagram.excalidraw' });
    }
  }, []);

  /** Copies the current selection (or, absent one, the whole doc) as a PNG to the OS
   * clipboard, falling back to a download; reuses the :svg serializer for pixel parity. */
  const doCopyPng = useCallback(async (themeArg?: ExportTheme) => {
    const theme = themeArg ?? themeRef.current;
    const s = stateRef.current;
    const target = s.selectedIds.length ? subsetDoc(s.doc, s.selectedIds) : s.doc;
    const svg = exportSvg(target, theme);
    const { w, h } = exportViewport(target);
    try {
      const result = await copySvgAsPng(svg, { w, h }, exportBackground(theme));
      dispatch({
        type: 'MSG',
        msg: result === 'clipboard' ? 'copied PNG to clipboard' : 'clipboard unavailable, downloaded diagram.png',
      });
    } catch {
      dispatch({ type: 'MSG', msg: 'PNG export failed' });
    }
  }, []);

  /** Builds a `#d=<payload>` share URL for the current doc and copies it to the OS clipboard,
   * falling back to a `prompt()` dialog (so the user can still copy it manually) when the
   * Clipboard API is unavailable or denied. The base URL is the public GitHub Pages
   * deployment when running in the desktop shell, since a `https://app.pochi/...` URL only
   * resolves inside that WebView2 instance - see PUBLIC_BASE_URL above. */
  const doShare = useCallback(async () => {
    const s = stateRef.current;
    let payload: string;
    try {
      payload = await encodeShareDoc(s.doc);
    } catch {
      dispatch({ type: 'MSG', msg: 'share failed: could not encode diagram' });
      return;
    }
    const base = isDesktop ? PUBLIC_BASE_URL : location.origin + location.pathname;
    const url = `${base}${SHARE_HASH_PREFIX}${payload}`;
    const kb = (payload.length / 1024).toFixed(1);
    const warn = payload.length > SHARE_URL_WARN_CHARS ? ' — may be too long for some apps' : '';
    let copied = false;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard API unavailable');
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch {
      /* no permission / API unavailable; fall back to a prompt below */
    }
    if (copied) {
      dispatch({ type: 'MSG', msg: `share URL copied (${kb} KB${warn})` });
    } else {
      window.prompt('share URL (copy manually):', url);
      dispatch({ type: 'MSG', msg: `share URL ready, ${kb} KB${warn} — clipboard unavailable, copy from the dialog` });
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
        case 'png': {
          const theme = parseExportTheme(rest[0]);
          if (theme === null) dispatch({ type: 'MSG', msg: `usage: :${cmd} [light|dark]` });
          else if (cmd === 'svg') await doExportSvg(theme);
          else await doCopyPng(theme);
          break;
        }
        case 'share':
          await doShare();
          break;
        case 'collab':
          if (rest[0] === 'off') leaveCollab();
          else if (rest[0] === undefined) await startCollab();
          else dispatch({ type: 'MSG', msg: 'usage: :collab [off]' });
          break;
        case 'export': {
          if (rest[0] === 'excalidraw') {
            await doExportExcalidraw();
            break;
          }
          const theme = parseExportTheme(rest[1]);
          if ((rest[0] !== 'svg' && rest[0] !== 'png') || theme === null) {
            dispatch({ type: 'MSG', msg: 'usage: :export svg|png [light|dark] | :export excalidraw' });
          } else if (rest[0] === 'svg') await doExportSvg(theme);
          else await doCopyPng(theme);
          break;
        }
        case 'new':
        case 'clear':
          requestNew();
          break;
        case 'vim':
          dispatch({
            type: 'SET_VIM',
            on: rest[0] ? rest[0] === 'on' : !stateRef.current.vim,
          });
          break;
        case 'theme':
          if (rest[0] === undefined) setTheme((t) => (t === 'light' ? 'dark' : 'light'));
          else if (rest[0] === 'light' || rest[0] === 'dark') setTheme(rest[0]);
          else dispatch({ type: 'MSG', msg: 'usage: :theme [light|dark]' });
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
    [save, open, requestNew, doExportSvg, doExportExcalidraw, doCopyPng, doShare, startCollab, leaveCollab],
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
        onNew={requestNew}
        onSave={() => void save()}
        onOpen={() => void open()}
        onExportSvg={() => void doExportSvg()}
        onExportExcalidraw={() => void doExportExcalidraw()}
        onCopyPng={() => void doCopyPng()}
        onImportImage={() => void importImage()}
        onShare={() => void doShare()}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
        recentFiles={isDesktop ? recentFiles : []}
        onOpenRecent={(path) => void openRecent(path)}
        onRemoveRecent={removeRecentFile}
        collab={collabRoom ? { roomId: collabRoom, peers: collabPeers.length } : null}
        onToggleCollab={() => {
          if (!collabRoom) void startCollab();
          else if (window.confirm('共同編集を終了しますか?')) leaveCollab();
        }}
      />
      <div className="app-body">
        <ActivityBar
          active={activePanel}
          onSelect={(panel) => setActivePanel((p) => (p === panel ? null : panel))}
        />
        {activePanel === 'templates' && <TemplateSidebar theme={theme} dispatch={dispatch} />}
        {activePanel === 'properties' && <PropertiesSidebar state={state} dispatch={dispatch} />}
        <div className="canvas-wrap">
          <Canvas state={state} dispatch={dispatch} />
          <RemoteCursors cursors={peerCursors} view={state.view} />
          <TextEditOverlay state={state} dispatch={dispatch} />
          <ContextMenu state={state} dispatch={dispatch} />
        </div>
      </div>
      <StatusBar state={state} dispatch={dispatch} runCommand={runCommand} />
      {state.showHelp && <HelpOverlay dispatch={dispatch} />}
    </div>
  );
}
