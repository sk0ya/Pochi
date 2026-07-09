import {
  addConnector,
  addShape,
  bboxOf,
  clearConnectorWaypoints,
  connectorAt,
  deleteItem,
  docBounds,
  findConnector,
  findShape,
  groupIdOf,
  groupMembers,
  insertConnectorWaypoint,
  itemsInRect,
  measureLabel,
  type ReorderDir,
  reorderItems,
  scaleShapes,
  setConnectorEndpoint,
  setConnectorWaypoint,
  resizeAnchor,
  shapeAt,
  translateItems,
  updateShape,
} from '../model/doc';
import { classifyStroke } from '../model/sketch';
import type { Connector, Doc, Endpoint, Pt, Shape, TriangleDirection } from '../model/types';
import { GRID, emptyDoc, newId, snap, snapPt } from '../model/types';

export type Mode = 'normal' | 'insert' | 'command' | 'draw' | 'move' | 'resize' | 'arrow';

/** Shape kinds reachable via the hjkl-resize draw flow (excludes text/image, which use other flows). */
export type DrawKind = 'rect' | 'ellipse' | 'diamond' | 'sticky' | 'triangle';

/** Active mouse tool: what a drag on empty canvas creates. */
export type MouseTool =
  | 'select'
  | 'sketch'
  | 'rect'
  | 'ellipse'
  | 'diamond'
  | 'sticky'
  | 'triangle'
  | 'arrow'
  | 'text';

export interface View {
  x: number;
  y: number;
  scale: number;
}

export interface Clipboard {
  shapes: Shape[];
  connectors: Connector[];
}

/** Marks text we ourselves wrote to the OS clipboard, so a later paste can
 * tell "our own shape copy echoed back" apart from real external text. */
const CLIPBOARD_MARKER = 'pochi-clipboard-v1';

export function serializeClipboard(clip: Clipboard): string {
  return JSON.stringify({ app: CLIPBOARD_MARKER, clip });
}

/** Parses `text` back into a Clipboard if (and only if) it's our own
 * serialized clipboard echoed back through the OS clipboard; null for any
 * other text (i.e. real external content). */
export function parseClipboard(text: string): Clipboard | null {
  if (!text.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(text) as { app?: string; clip?: Clipboard };
    if (parsed.app !== CLIPBOARD_MARKER || !parsed.clip) return null;
    if (!Array.isArray(parsed.clip.shapes) || !Array.isArray(parsed.clip.connectors)) return null;
    return parsed.clip;
  } catch {
    return null;
  }
}

export interface EditorState {
  doc: Doc;
  undo: Doc[];
  redo: Doc[];
  /** Snapshot taken when a transient op (move/resize/drag/insert) starts. */
  base: Doc | null;
  cursor: Pt;
  /** Selection lives above vim modes: normal-mode keys act on it when non-empty. */
  selectedIds: string[];
  /** Stack of previous selections, most recent last. Lets Delete/Backspace fall back to whatever was selected before, so repeated presses delete a chain of items. */
  selectionHistory: string[][];
  mode: Mode;
  draw: { kind: DrawKind; anchor: Pt } | null;
  arrowFrom: Endpoint | null;
  /** Target size of the selection's bounding box while in transient `resize` mode. */
  resizeBox: { w: number; h: number } | null;
  /** Rubber-band selection rectangle being dragged (Shift+drag). */
  marquee: { a: Pt; b: Pt } | null;
  editingId: string | null;
  editingIsNew: boolean;
  clipboard: Clipboard | null;
  tool: MouseTool;
  /** Freehand stroke being drawn (sketch tool). */
  sketch: Pt[] | null;
  count: string;
  cmd: string;
  msg: string;
  vim: boolean;
  showHelp: boolean;
  view: View;
  fileName: string | null;
  /** Right-click context menu: screen position to render at, world point for context, target under cursor. */
  contextMenu: { screen: Pt; world: Pt; id?: string } | null;
}

export type Action =
  | { type: 'KEY'; key: string; ctrl: boolean; shift?: boolean }
  | { type: 'CLICK'; p: Pt; id?: string; shift?: boolean }
  | { type: 'DBL_CLICK'; p: Pt; id?: string }
  | { type: 'MOUSE_CURSOR'; p: Pt }
  | { type: 'DRAG_START'; id: string }
  | { type: 'DRAG_MOVE'; id: string; to: Pt }
  | { type: 'CONNECTOR_DRAG_MOVE'; id: string; dx: number; dy: number }
  | { type: 'DRAG_RESIZE'; w: number; h: number }
  | { type: 'DRAG_END' }
  | { type: 'ENDPOINT_DRAG_START'; id: string; end: 'from' | 'to' }
  | { type: 'ENDPOINT_DRAG_MOVE'; id: string; end: 'from' | 'to'; p: Pt }
  | { type: 'WAYPOINT_DRAG_START'; id: string; index: number }
  | { type: 'WAYPOINT_DRAG_MOVE'; id: string; index: number; p: Pt }
  | { type: 'ADD_WAYPOINT'; id: string; p: Pt }
  | { type: 'CLEAR_WAYPOINTS'; id: string }
  | { type: 'SET_CONNECTOR_ROUTING'; id: string; routing: 'straight' | 'orthogonal' }
  | { type: 'START_INSERT'; id: string }
  | { type: 'INSERT_COMMIT'; label: string }
  | { type: 'CMD_OPEN' }
  | { type: 'CMD_SET'; text: string }
  | { type: 'CMD_CLOSE' }
  | { type: 'SET_TOOL'; tool: MouseTool }
  | { type: 'START_DRAW_AT'; kind: DrawKind; p: Pt }
  | { type: 'START_ARROW_AT'; p: Pt; shapeId?: string }
  | { type: 'TEXT_AT'; p: Pt }
  | { type: 'ADD_IMAGE'; src: string; w: number; h: number }
  | { type: 'ADD_TEXT'; text: string }
  | { type: 'PASTE_CLIP'; clip: Clipboard }
  | { type: 'CANCEL' }
  | { type: 'SKETCH_START'; p: Pt }
  | { type: 'SKETCH_POINT'; p: Pt }
  | { type: 'SKETCH_END' }
  | { type: 'SKETCH_CANCEL' }
  | { type: 'MARQUEE_START'; p: Pt }
  | { type: 'MARQUEE_MOVE'; p: Pt }
  | { type: 'MARQUEE_END' }
  | { type: 'MARQUEE_CANCEL' }
  | { type: 'PAN'; dx: number; dy: number }
  | { type: 'ZOOM'; factor: number; center: Pt }
  | { type: 'RESET_ZOOM'; center: Pt }
  | { type: 'FIT'; screenW: number; screenH: number }
  | { type: 'CENTER'; screenW: number; screenH: number }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | { type: 'NEW' }
  | { type: 'LOAD'; doc: Doc; fileName: string | null }
  | { type: 'MSG'; msg: string }
  | { type: 'SAVED'; fileName: string }
  | { type: 'SET_VIM'; on: boolean }
  | { type: 'TOGGLE_HELP' }
  | { type: 'SET_COLOR'; ids: string[]; color: string | null }
  | { type: 'SET_TRIANGLE_DIRECTION'; ids: string[]; direction: TriangleDirection }
  | { type: 'REORDER'; ids: string[]; dir: ReorderDir }
  | { type: 'DUPLICATE' }
  | { type: 'DELETE_IDS'; ids: string[] }
  | { type: 'COPY' }
  | { type: 'PASTE_AT'; p: Pt }
  | { type: 'SELECT_ALL' }
  | { type: 'GROUP' }
  | { type: 'UNGROUP' }
  | { type: 'TOGGLE_GROUP' }
  | { type: 'CONTEXT_MENU_OPEN'; screen: Pt; world: Pt; id?: string }
  | { type: 'CONTEXT_MENU_CLOSE' };

const DEFAULT_W = GRID * 10;
const DEFAULT_H = GRID * 6;
const UNDO_LIMIT = 200;
/** Shift+move multiplies the grid step by this factor (coordinates stay grid-aligned). */
const BIG_STEP = 4;
/** Max long edge (world px) a newly-imported image is scaled to fit within. */
export const IMAGE_MAX_DIM = GRID * 20;

export function initialState(doc: Doc | null, vim: boolean): EditorState {
  return {
    doc: doc ?? emptyDoc(),
    undo: [],
    redo: [],
    base: null,
    cursor: { x: GRID * 10, y: GRID * 10 },
    selectedIds: [],
    selectionHistory: [],
    mode: 'normal',
    draw: null,
    arrowFrom: null,
    marquee: null,
    editingId: null,
    editingIsNew: false,
    resizeBox: null,
    clipboard: null,
    tool: 'sketch',
    sketch: null,
    count: '',
    cmd: '',
    msg: 'Press ? for help',
    vim,
    showHelp: false,
    view: { x: 0, y: 0, scale: 1 },
    fileName: null,
    contextMenu: null,
  };
}

/** Push current doc to undo history and swap in a new one. */
function commit(state: EditorState, doc: Doc, extra?: Partial<EditorState>): EditorState {
  return {
    ...state,
    doc,
    undo: [...state.undo, state.doc].slice(-UNDO_LIMIT),
    redo: [],
    ...extra,
  };
}

const SELECTION_HISTORY_LIMIT = 50;

/** Record `ids` as a selection the user is navigating away from, so it can be restored later. */
function pushSelectionHistory(history: string[][], ids: string[]): string[][] {
  if (!ids.length) return history;
  return [...history, ids].slice(-SELECTION_HISTORY_LIMIT);
}

/**
 * After a delete, fall back to whatever was selected just before the deleted selection —
 * skipping any history entries that no longer exist in `doc` — so repeated Delete/Backspace
 * presses walk back through prior selections instead of just clearing the selection.
 */
function restorePreviousSelection(history: string[][], doc: Doc): { selectedIds: string[]; selectionHistory: string[][] } {
  let remaining = history;
  while (remaining.length) {
    const candidate = remaining[remaining.length - 1];
    remaining = remaining.slice(0, -1);
    const filtered = candidate.filter(
      (id) => doc.shapes.some((s) => s.id === id) || doc.connectors.some((c) => c.id === id),
    );
    if (filtered.length) return { selectedIds: filtered, selectionHistory: remaining };
  }
  return { selectedIds: [], selectionHistory: remaining };
}

/** End a transient op: commit `base` to history if the doc actually changed. */
function endTransient(state: EditorState, extra?: Partial<EditorState>): EditorState {
  const changed = state.base !== null && state.base !== state.doc;
  return {
    ...state,
    undo: changed ? [...state.undo, state.base as Doc].slice(-UNDO_LIMIT) : state.undo,
    redo: changed ? [] : state.redo,
    base: null,
    mode: 'normal',
    draw: null,
    arrowFrom: null,
    resizeBox: null,
    count: '',
    ...extra,
  };
}

/** Cancel a transient op: restore the doc snapshot. */
function cancelTransient(state: EditorState, extra?: Partial<EditorState>): EditorState {
  return {
    ...state,
    doc: state.base ?? state.doc,
    base: null,
    mode: 'normal',
    draw: null,
    arrowFrom: null,
    resizeBox: null,
    editingId: null,
    editingIsNew: false,
    marquee: null,
    sketch: null,
    count: '',
    ...extra,
  };
}

function hotItem(state: EditorState): { shape?: Shape; connector?: Connector } {
  const shape = shapeAt(state.doc, state.cursor);
  if (shape) return { shape };
  const connector = connectorAt(state.doc, state.cursor);
  return { connector };
}

function getCount(state: EditorState): number {
  const n = parseInt(state.count, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function moveDelta(key: string, step: number): Pt | null {
  switch (key) {
    case 'h': case 'ArrowLeft': return { x: -step, y: 0 };
    case 'l': case 'ArrowRight': return { x: step, y: 0 };
    case 'k': case 'ArrowUp': return { x: 0, y: -step };
    case 'j': case 'ArrowDown': return { x: 0, y: step };
    default: return null;
  }
}

function normRect(a: Pt, b: Pt): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.max(Math.abs(b.x - a.x), GRID),
    h: Math.max(Math.abs(b.y - a.y), GRID),
  };
}

function startDraw(state: EditorState, kind: DrawKind): EditorState {
  const anchor = snapPt(state.cursor);
  return {
    ...state,
    mode: 'draw',
    draw: { kind, anchor },
    cursor: { x: anchor.x + DEFAULT_W, y: anchor.y + DEFAULT_H },
    selectedIds: [],
    count: '',
    msg: 'DRAW: hjkl to size, Enter/click to place, Esc to cancel',
  };
}

function confirmDraw(state: EditorState): EditorState {
  if (!state.draw) return state;
  const r = normRect(state.draw.anchor, state.cursor);
  const shape: Shape = {
    id: newId(),
    kind: state.draw.kind,
    ...r,
    label: '',
    ...(state.draw.kind === 'triangle' ? { direction: 'up' as const } : {}),
  };
  // Mouse/plain-mode users have no 'i' muscle memory: drop straight into text
  // edit. Vim users get the deliberate two-step create-then-insert flow.
  if (!state.vim) {
    return {
      ...state,
      base: state.doc,
      doc: addShape(state.doc, shape),
      mode: 'insert',
      draw: null,
      editingId: shape.id,
      editingIsNew: true,
      selectedIds: [shape.id],
      count: '',
      msg: '',
    };
  }
  return commit(state, addShape(state.doc, shape), {
    mode: 'normal',
    draw: null,
    selectedIds: [shape.id],
    count: '',
    msg: 'placed (i: add text)',
  });
}

function startArrow(state: EditorState): EditorState {
  const { shape } = hotItem(state);
  const from: Endpoint = shape
    ? { shapeId: shape.id, x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 }
    : { ...snapPt(state.cursor) };
  return {
    ...state,
    mode: 'arrow',
    arrowFrom: from,
    selectedIds: [],
    count: '',
    msg: 'ARROW: move to target, Enter/click to connect, Esc to cancel',
  };
}

function confirmArrow(state: EditorState): EditorState {
  if (!state.arrowFrom) return state;
  const target = shapeAt(state.doc, state.cursor);
  const to: Endpoint =
    target && target.id !== state.arrowFrom.shapeId
      ? { shapeId: target.id, x: target.x + target.w / 2, y: target.y + target.h / 2 }
      : { ...snapPt(state.cursor) };
  const c: Connector = { id: newId(), from: state.arrowFrom, to, label: '' };
  return commit(state, addConnector(state.doc, c), {
    mode: 'normal',
    arrowFrom: null,
    selectedIds: [c.id],
    count: '',
    msg: 'connected',
  });
}

function startTextInsert(state: EditorState, p: Pt): EditorState {
  const at = snapPt(p);
  const shape: Shape = {
    id: newId(),
    kind: 'text',
    x: at.x,
    y: at.y,
    w: GRID * 8,
    h: GRID * 2,
    label: '',
  };
  return {
    ...state,
    base: state.doc,
    doc: addShape(state.doc, shape),
    mode: 'insert',
    editingId: shape.id,
    editingIsNew: true,
    selectedIds: [shape.id],
    count: '',
  };
}

function startEdit(state: EditorState, id: string): EditorState {
  return {
    ...state,
    base: state.doc,
    mode: 'insert',
    editingId: id,
    editingIsNew: false,
    selectedIds: [id],
    count: '',
  };
}

/** Shapes among the current selection (connectors filtered out). */
function selectedShapes(state: EditorState): Shape[] {
  return state.selectedIds
    .map((id) => findShape(state.doc, id))
    .filter((s): s is Shape => !!s);
}

/** Clipboard from the selection (or the hot shape): shapes plus connectors that stay valid. */
function yankSelection(state: EditorState): Clipboard | null {
  const shapes = selectedShapes(state);
  if (!shapes.length) {
    const { shape } = hotItem(state);
    return shape ? { shapes: [{ ...shape }], connectors: [] } : null;
  }
  const shapeIds = new Set(shapes.map((s) => s.id));
  const selected = new Set(state.selectedIds);
  const connectors = state.doc.connectors.filter((c) => {
    const bound = [c.from, c.to].filter((e) => e.shapeId);
    if (bound.some((e) => !shapeIds.has(e.shapeId as string))) return false;
    return selected.has(c.id) || bound.length === 2;
  });
  return {
    shapes: shapes.map((s) => ({ ...s })),
    connectors: connectors.map((c) => ({ ...c, from: { ...c.from }, to: { ...c.to } })),
  };
}

function pasteClipboard(state: EditorState, clip: Clipboard, atPoint?: Pt): EditorState {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of clip.shapes) {
    xs.push(s.x);
    ys.push(s.y);
  }
  for (const c of clip.connectors) {
    for (const e of [c.from, c.to]) {
      if (!e.shapeId) {
        xs.push(e.x);
        ys.push(e.y);
      }
    }
  }
  if (!xs.length) return { ...state, count: '', msg: 'clipboard empty' };
  const at = snapPt(atPoint ?? state.cursor);
  const dx = at.x - Math.min(...xs);
  const dy = at.y - Math.min(...ys);
  const idMap = new Map<string, string>();
  const shapes = clip.shapes.map((s) => {
    const id = newId();
    idMap.set(s.id, id);
    return { ...s, id, x: s.x + dx, y: s.y + dy };
  });
  const remap = (e: Endpoint): Endpoint =>
    e.shapeId
      ? { shapeId: idMap.get(e.shapeId), x: e.x + dx, y: e.y + dy }
      : { x: e.x + dx, y: e.y + dy };
  const connectors = clip.connectors.map((c) => ({
    ...c,
    id: newId(),
    from: remap(c.from),
    to: remap(c.to),
  }));
  const doc: Doc = {
    shapes: [...state.doc.shapes, ...shapes],
    connectors: [...state.doc.connectors, ...connectors],
  };
  return commit(state, doc, {
    selectedIds: [...shapes.map((s) => s.id), ...connectors.map((c) => c.id)],
    count: '',
    msg: 'pasted',
  });
}

/** Copy+offset clipboard items in place (Ctrl+D duplicate, or Ctrl+V without a vim cursor). */
function pasteWithOffset(state: EditorState, clip: Clipboard, offset: number): EditorState {
  const idMap = new Map<string, string>();
  const shapes = clip.shapes.map((s) => {
    const id = newId();
    idMap.set(s.id, id);
    return { ...s, id, x: s.x + offset, y: s.y + offset };
  });
  const remap = (e: Endpoint): Endpoint =>
    e.shapeId
      ? { shapeId: idMap.get(e.shapeId), x: e.x + offset, y: e.y + offset }
      : { x: e.x + offset, y: e.y + offset };
  const connectors = clip.connectors.map((c) => ({
    ...c,
    id: newId(),
    from: remap(c.from),
    to: remap(c.to),
  }));
  const doc: Doc = {
    shapes: [...state.doc.shapes, ...shapes],
    connectors: [...state.doc.connectors, ...connectors],
  };
  return commit(state, doc, {
    selectedIds: [...shapes.map((s) => s.id), ...connectors.map((c) => c.id)],
    msg: 'duplicated',
  });
}

function copySelection(state: EditorState): EditorState {
  if (!state.selectedIds.length) return { ...state, msg: 'select something first' };
  const clip = yankSelection(state);
  if (!clip) return { ...state, msg: 'nothing to copy' };
  return { ...state, clipboard: clip, msg: 'copied' };
}

function duplicateSelection(state: EditorState): EditorState {
  const clip = state.selectedIds.length ? yankSelection(state) : null;
  if (!clip) return { ...state, msg: 'select something first' };
  return pasteWithOffset(state, clip, GRID * 2);
}

function handleNormalKey(state: EditorState, key: string, ctrl: boolean, shift: boolean): EditorState {
  if (ctrl) {
    if (key === 'r') return reduceCore(state, { type: 'REDO' });
    return state;
  }

  if (/^[0-9]$/.test(key) && !(key === '0' && state.count === '')) {
    return { ...state, count: state.count + key };
  }

  const delta = moveDelta(key, GRID * getCount(state) * (shift ? BIG_STEP : 1));
  if (delta) {
    return {
      ...state,
      cursor: { x: state.cursor.x + delta.x, y: state.cursor.y + delta.y },
      count: '',
    };
  }

  switch (key) {
    case 'Escape':
      if (state.base !== null || state.marquee !== null || state.sketch !== null) {
        return cancelTransient(state, { selectedIds: [], msg: '', showHelp: false });
      }
      return { ...state, selectedIds: [], count: '', msg: '', showHelp: false };
    case 'r':
      return startDraw(state, 'rect');
    case 'e':
      return startDraw(state, 'ellipse');
    case 'q':
      return startDraw(state, 'diamond');
    case 'w':
      return startDraw(state, 'sticky');
    case 'g':
      return startDraw(state, 'triangle');
    case 'a':
      return startArrow(state);
    case 't':
      return startTextInsert(state, state.cursor);
    case 'i': {
      if (state.selectedIds.length === 1) return startEdit(state, state.selectedIds[0]);
      const { shape, connector } = hotItem(state);
      if (shape) return startEdit(state, shape.id);
      if (connector) return startEdit(state, connector.id);
      return startTextInsert(state, state.cursor);
    }
    case 'Enter': {
      const { shape, connector } = hotItem(state);
      const id = shape?.id ?? connector?.id;
      return { ...state, selectedIds: id ? [id] : [], count: '' };
    }
    case 'v': {
      let ids = state.selectedIds;
      if (!ids.length) {
        const { shape, connector } = hotItem(state);
        const id = shape?.id ?? connector?.id;
        if (!id) return { ...state, msg: 'nothing under cursor', count: '' };
        ids = [id];
      }
      return {
        ...state,
        mode: 'move',
        base: state.doc,
        selectedIds: ids,
        count: '',
        msg: 'MOVE: hjkl to move, Enter to drop, Esc to cancel',
      };
    }
    case 's': {
      const sel = selectedShapes(state);
      const ids = sel.length ? sel.map((s) => s.id) : (() => {
        const hot = hotItem(state).shape;
        return hot ? [hot.id] : [];
      })();
      if (!ids.length) return { ...state, msg: 'no shape under cursor', count: '' };
      const box = bboxOf(state.doc, ids);
      if (!box) return { ...state, msg: 'no shape under cursor', count: '' };
      return {
        ...state,
        mode: 'resize',
        base: state.doc,
        selectedIds: ids,
        resizeBox: { w: box.w, h: box.h },
        count: '',
        msg:
          ids.length > 1
            ? 'RESIZE (group): l/h wider/narrower, j/k taller/shorter, Enter to done'
            : 'RESIZE: l/h wider/narrower, j/k taller/shorter, Enter to done',
      };
    }
    case 'd':
    case 'x':
    case 'Delete':
    case 'Backspace': {
      let ids = state.selectedIds;
      if (!ids.length) {
        const { shape, connector } = hotItem(state);
        const id = shape?.id ?? connector?.id;
        if (!id) return { ...state, msg: 'nothing under cursor', count: '' };
        ids = [id];
      }
      const doc = ids.reduce((d, id) => deleteItem(d, id), state.doc);
      const restore = restorePreviousSelection(state.selectionHistory, doc);
      return commit(state, doc, {
        selectedIds: restore.selectedIds,
        selectionHistory: restore.selectionHistory,
        count: '',
        msg: ids.length > 1 ? `deleted ${ids.length} items` : 'deleted',
      });
    }
    case 'y': {
      const clip = yankSelection(state);
      if (!clip) return { ...state, msg: 'no shape under cursor', count: '' };
      const n = clip.shapes.length + clip.connectors.length;
      return { ...state, clipboard: clip, count: '', msg: n > 1 ? `yanked ${n} items` : 'yanked' };
    }
    case 'p': {
      if (!state.clipboard) return { ...state, msg: 'clipboard empty', count: '' };
      return pasteClipboard(state, state.clipboard);
    }
    case 'u':
      return reduceCore(state, { type: 'UNDO' });
    case '?':
      return { ...state, showHelp: !state.showHelp, count: '' };
    default:
      return { ...state, count: '' };
  }
}

function handleTransientKey(state: EditorState, key: string, shift: boolean): EditorState {
  if (/^[0-9]$/.test(key) && !(key === '0' && state.count === '')) {
    return { ...state, count: state.count + key };
  }
  const step = GRID * getCount(state) * (shift ? BIG_STEP : 1);

  if (state.mode === 'draw' || state.mode === 'arrow') {
    const delta = moveDelta(key, step);
    if (delta) {
      return {
        ...state,
        cursor: { x: state.cursor.x + delta.x, y: state.cursor.y + delta.y },
        count: '',
      };
    }
    if (key === 'Enter') return state.mode === 'draw' ? confirmDraw(state) : confirmArrow(state);
    if (key === 'Escape') return cancelTransient(state, { msg: 'cancelled' });
    return { ...state, count: '' };
  }

  if (state.mode === 'move') {
    const delta = moveDelta(key, step);
    if (delta && state.selectedIds.length) {
      return {
        ...state,
        doc: translateItems(state.doc, state.selectedIds, delta.x, delta.y),
        cursor: { x: state.cursor.x + delta.x, y: state.cursor.y + delta.y },
        count: '',
      };
    }
    if (key === 'Enter' || key === 'v') return endTransient(state, { msg: 'moved' });
    if (key === 'Escape') return cancelTransient(state, { msg: 'cancelled' });
    return { ...state, count: '' };
  }

  if (state.mode === 'resize') {
    const ids = state.selectedIds;
    const box = state.resizeBox;
    const base = state.base;
    if (!ids.length || !box || !base) return cancelTransient(state);
    let dw = 0;
    let dh = 0;
    if (key === 'l' || key === 'ArrowRight') dw = step;
    if (key === 'h' || key === 'ArrowLeft') dw = -step;
    if (key === 'j' || key === 'ArrowDown') dh = step;
    if (key === 'k' || key === 'ArrowUp') dh = -step;
    if (dw !== 0 || dh !== 0) {
      const newBox = { w: Math.max(GRID, box.w + dw), h: Math.max(GRID, box.h + dh) };
      const origBox = bboxOf(base, ids);
      if (!origBox) return cancelTransient(state);
      const shapes = ids.map((id) => findShape(base, id)).filter((s): s is Shape => !!s);
      const anchor = resizeAnchor(shapes, origBox);
      return {
        ...state,
        doc: scaleShapes(base, ids, newBox.w, newBox.h, anchor, origBox.w, origBox.h),
        resizeBox: newBox,
        count: '',
      };
    }
    if (key === 'Enter' || key === 's') return endTransient(state, { msg: 'resized' });
    if (key === 'Escape') return cancelTransient(state, { msg: 'cancelled' });
    return { ...state, count: '' };
  }

  return state;
}

/** Simplified bindings when vim mode is off: arrows + Delete on the selection. */
function handlePlainKey(state: EditorState, key: string, ctrl: boolean, shift: boolean): EditorState {
  if (ctrl) {
    if (key === 'z') return reduceCore(state, { type: 'UNDO' });
    if (key === 'y') return reduceCore(state, { type: 'REDO' });
    return state;
  }
  if (state.mode === 'draw' || state.mode === 'arrow') return handleTransientKey(state, key, shift);
  if (key === 'Escape') {
    if (state.base !== null || state.marquee !== null || state.sketch !== null) {
      return cancelTransient(state, { selectedIds: [], msg: 'cancelled', showHelp: false });
    }
    return { ...state, selectedIds: [], msg: '', showHelp: false };
  }
  if (key === 'Delete' || key === 'Backspace') {
    if (!state.selectedIds.length) return state;
    const doc = state.selectedIds.reduce((d, id) => deleteItem(d, id), state.doc);
    const restore = restorePreviousSelection(state.selectionHistory, doc);
    return commit(state, doc, {
      selectedIds: restore.selectedIds,
      selectionHistory: restore.selectionHistory,
      msg: 'deleted',
    });
  }
  if (key === 'F2' && state.selectedIds.length === 1) return startEdit(state, state.selectedIds[0]);
  const delta = moveDelta(key, GRID * (shift ? BIG_STEP : 1));
  if (delta && state.selectedIds.length) {
    return commit(state, translateItems(state.doc, state.selectedIds, delta.x, delta.y));
  }
  return state;
}

function commitInsert(state: EditorState, label: string): EditorState {
  const id = state.editingId;
  if (!id) return { ...state, mode: 'normal' };
  const trimmed = label.replace(/\s+$/, '');
  const conn = state.doc.connectors.find((c) => c.id === id);
  let doc: Doc;
  if (conn) {
    doc = {
      ...state.doc,
      connectors: state.doc.connectors.map((c) => (c.id === id ? { ...c, label: trimmed } : c)),
    };
  } else {
    const s = findShape(state.doc, id);
    if (!s) return cancelTransient(state);
    if (s.kind === 'text' && trimmed === '') {
      doc = deleteItem(state.doc, id);
    } else {
      let patch: Partial<Shape> = { label: trimmed };
      if (s.kind === 'text' && trimmed !== '') {
        const m = measureLabel(trimmed);
        patch = {
          ...patch,
          w: Math.max(GRID * 2, snap(m.w + GRID)),
          h: Math.max(GRID * 2, snap(m.h + GRID / 2)),
        };
      }
      patch.label = trimmed;
      doc = updateShape(state.doc, id, patch);
    }
  }
  const changed = state.base !== null && doc !== state.base;
  return {
    ...state,
    doc,
    undo: changed ? [...state.undo, state.base as Doc].slice(-UNDO_LIMIT) : state.undo,
    redo: changed ? [] : state.redo,
    base: null,
    mode: 'normal',
    editingId: null,
    editingIsNew: false,
    selectedIds: state.selectedIds.filter(
      (sid) => doc.shapes.some((s) => s.id === sid) || doc.connectors.some((c) => c.id === sid),
    ),
  };
}

/**
 * Whether `action` performs a delete: these manage `selectionHistory` themselves
 * (popping the previous selection back in), so the `reduce` wrapper below must not
 * also record a history entry for them.
 */
function isDeleteAction(action: Action): boolean {
  if (action.type === 'DELETE_IDS') return true;
  return action.type === 'KEY' && ['Delete', 'Backspace', 'd', 'x'].includes(action.key);
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Every selection change (clicking a shape, creating one, marquee-select, ...) records
 * the selection it replaced, so Delete/Backspace can fall back to it — letting repeated
 * presses walk back through a chain of selections (e.g. create A, create B, then
 * Delete, Delete removes both and reselects along the way).
 */
export function reduce(state: EditorState, action: Action): EditorState {
  const result = reduceCore(state, action);
  if (result === state || isDeleteAction(action) || sameIds(result.selectedIds, state.selectedIds)) {
    return result;
  }
  return { ...result, selectionHistory: pushSelectionHistory(state.selectionHistory, state.selectedIds) };
}

function reduceCore(state: EditorState, action: Action): EditorState {
  switch (action.type) {
    case 'KEY': {
      if (state.mode === 'insert' || state.mode === 'command') return state;
      const shift = !!action.shift;
      if (!state.vim) return handlePlainKey(state, action.key, action.ctrl, shift);
      if (state.mode === 'normal') return handleNormalKey(state, action.key, action.ctrl, shift);
      return handleTransientKey(state, action.key, shift);
    }

    case 'CLICK': {
      const p = snapPt(action.p);
      if (state.mode === 'draw') return confirmDraw({ ...state, cursor: p });
      if (state.mode === 'arrow') return confirmArrow({ ...state, cursor: action.p });
      const conn = action.id ? undefined : connectorAt(state.doc, action.p);
      const hit = action.id ?? conn?.id ?? null;
      if (action.shift) {
        if (!hit) return { ...state, cursor: p, count: '' };
        const has = state.selectedIds.includes(hit);
        return {
          ...state,
          cursor: p,
          selectedIds: has
            ? state.selectedIds.filter((i) => i !== hit)
            : [...state.selectedIds, hit],
          count: '',
        };
      }
      const gid = hit ? groupIdOf(state.doc, hit) : undefined;
      return {
        ...state,
        cursor: p,
        selectedIds: hit ? (gid ? groupMembers(state.doc, gid) : [hit]) : [],
        count: '',
      };
    }

    case 'DBL_CLICK': {
      if (action.id) return startEdit(state, action.id);
      const p = snapPt(action.p);
      const shape: Shape = {
        id: newId(),
        kind: 'rect',
        x: p.x,
        y: p.y,
        w: DEFAULT_W,
        h: DEFAULT_H,
        label: '',
      };
      const withShape = { ...state, base: state.doc, doc: addShape(state.doc, shape) };
      return {
        ...withShape,
        mode: 'insert',
        editingId: shape.id,
        editingIsNew: true,
        selectedIds: [shape.id],
      };
    }

    case 'MOUSE_CURSOR': {
      if (state.mode !== 'draw' && state.mode !== 'arrow') return state;
      return { ...state, cursor: snapPt(action.p) };
    }

    case 'DRAG_START': {
      if (state.selectedIds.includes(action.id)) return { ...state, base: state.doc };
      // Dragging an unselected item reselects it (or its whole group, if grouped).
      const gid = groupIdOf(state.doc, action.id);
      return {
        ...state,
        base: state.doc,
        selectedIds: gid ? groupMembers(state.doc, gid) : [action.id],
      };
    }

    case 'DRAG_MOVE': {
      const src = state.base ?? state.doc;
      const orig = findShape(src, action.id);
      if (!orig) return state;
      const ids = state.selectedIds.includes(action.id) ? state.selectedIds : [action.id];
      return {
        ...state,
        doc: translateItems(src, ids, action.to.x - orig.x, action.to.y - orig.y),
      };
    }

    case 'CONNECTOR_DRAG_MOVE': {
      const src = state.base ?? state.doc;
      const ids = state.selectedIds.includes(action.id) ? state.selectedIds : [action.id];
      return { ...state, doc: translateItems(src, ids, action.dx, action.dy) };
    }

    case 'DRAG_RESIZE': {
      const ids = state.selectedIds;
      const base = state.base ?? state.doc;
      const box = bboxOf(base, ids);
      if (!box) return state;
      const newW = Math.max(GRID, snap(action.w));
      const newH = Math.max(GRID, snap(action.h));
      const shapes = ids.map((id) => findShape(base, id)).filter((s): s is Shape => !!s);
      const anchor = resizeAnchor(shapes, box);
      return {
        ...state,
        doc: scaleShapes(base, ids, newW, newH, anchor, box.w, box.h),
      };
    }

    case 'DRAG_END': {
      const changed = state.base !== null && state.base !== state.doc;
      return {
        ...state,
        undo: changed ? [...state.undo, state.base as Doc].slice(-UNDO_LIMIT) : state.undo,
        redo: changed ? [] : state.redo,
        base: null,
      };
    }

    case 'ENDPOINT_DRAG_START':
      return {
        ...state,
        base: state.doc,
        selectedIds: [action.id],
      };

    case 'ENDPOINT_DRAG_MOVE': {
      const conn = findConnector(state.doc, action.id);
      if (!conn) return state;
      const other = action.end === 'from' ? conn.to : conn.from;
      const target = shapeAt(state.doc, action.p);
      const endpoint: Endpoint =
        target && target.id !== other.shapeId
          ? { shapeId: target.id, x: target.x + target.w / 2, y: target.y + target.h / 2 }
          : snapPt(action.p);
      return {
        ...state,
        doc: setConnectorEndpoint(state.doc, action.id, action.end, endpoint),
      };
    }

    case 'START_INSERT':
      return startEdit(state, action.id);

    case 'INSERT_COMMIT':
      return commitInsert(state, action.label);

    case 'CMD_OPEN':
      return { ...state, mode: 'command', cmd: '', count: '' };

    case 'CMD_SET':
      return { ...state, cmd: action.text };

    case 'CMD_CLOSE':
      return { ...state, mode: 'normal', cmd: '' };

    case 'SET_TOOL':
      return { ...state, tool: action.tool };

    case 'START_DRAW_AT': {
      const p = snapPt(action.p);
      return {
        ...state,
        mode: 'draw',
        draw: { kind: action.kind, anchor: p },
        cursor: p,
        selectedIds: [],
        count: '',
        msg: 'drag to size',
      };
    }

    case 'START_ARROW_AT': {
      const s = action.shapeId ? findShape(state.doc, action.shapeId) : undefined;
      const from: Endpoint = s
        ? { shapeId: s.id, x: s.x + s.w / 2, y: s.y + s.h / 2 }
        : { ...snapPt(action.p) };
      return {
        ...state,
        mode: 'arrow',
        arrowFrom: from,
        cursor: snapPt(action.p),
        selectedIds: [],
        count: '',
        msg: 'drag to target',
      };
    }

    case 'TEXT_AT':
      return startTextInsert(state, action.p);

    case 'CANCEL':
      return cancelTransient(state, { msg: '' });

    case 'SKETCH_START':
      return { ...state, sketch: [action.p], selectedIds: [] };

    case 'SKETCH_POINT':
      return state.sketch ? { ...state, sketch: [...state.sketch, action.p] } : state;

    case 'SKETCH_CANCEL':
      return { ...state, sketch: null };

    case 'SKETCH_END': {
      const pts = state.sketch;
      if (!pts) return state;
      const res = classifyStroke(pts);
      if (!res) return { ...state, sketch: null, msg: '' };
      if (res.kind === 'line') {
        const fromShape = shapeAt(state.doc, res.a);
        const toShape = shapeAt(state.doc, res.b);
        const from: Endpoint = fromShape
          ? { shapeId: fromShape.id, x: fromShape.x + fromShape.w / 2, y: fromShape.y + fromShape.h / 2 }
          : { ...snapPt(res.a) };
        const to: Endpoint =
          toShape && toShape.id !== fromShape?.id
            ? { shapeId: toShape.id, x: toShape.x + toShape.w / 2, y: toShape.y + toShape.h / 2 }
            : { ...snapPt(res.b) };
        const c: Connector = { id: newId(), from, to, label: '' };
        return commit(state, addConnector(state.doc, c), {
          sketch: null,
          selectedIds: [c.id],
          msg: 'auto: arrow',
        });
      }
      const shape: Shape = {
        id: newId(),
        kind: res.kind,
        x: snap(res.x),
        y: snap(res.y),
        w: Math.max(GRID * 2, snap(res.w)),
        h: Math.max(GRID * 2, snap(res.h)),
        label: '',
        ...(res.kind === 'triangle' ? { direction: res.direction } : {}),
      };
      // Freehand sketching has no vim keyboard equivalent, so always drop
      // straight into text edit — same as double-click-to-create.
      return {
        ...state,
        base: state.doc,
        doc: addShape(state.doc, shape),
        sketch: null,
        mode: 'insert',
        editingId: shape.id,
        editingIsNew: true,
        selectedIds: [shape.id],
        msg: `auto: ${res.kind}`,
      };
    }

    case 'MARQUEE_START':
      return { ...state, marquee: { a: action.p, b: action.p }, count: '' };

    case 'MARQUEE_MOVE':
      return state.marquee ? { ...state, marquee: { ...state.marquee, b: action.p } } : state;

    case 'MARQUEE_CANCEL':
      return { ...state, marquee: null };

    case 'MARQUEE_END': {
      if (!state.marquee) return state;
      const { a, b } = state.marquee;
      const r = {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        w: Math.abs(b.x - a.x),
        h: Math.abs(b.y - a.y),
      };
      const ids = itemsInRect(state.doc, r);
      return {
        ...state,
        marquee: null,
        selectedIds: ids,
        count: '',
        msg: ids.length ? `${ids.length} selected` : '',
      };
    }

    case 'PAN':
      return { ...state, view: { ...state.view, x: state.view.x + action.dx, y: state.view.y + action.dy } };

    case 'ZOOM': {
      const scale = Math.min(4, Math.max(0.2, state.view.scale * action.factor));
      const wx = (action.center.x - state.view.x) / state.view.scale;
      const wy = (action.center.y - state.view.y) / state.view.scale;
      return {
        ...state,
        view: { scale, x: action.center.x - wx * scale, y: action.center.y - wy * scale },
      };
    }

    case 'RESET_ZOOM': {
      const wx = (action.center.x - state.view.x) / state.view.scale;
      const wy = (action.center.y - state.view.y) / state.view.scale;
      return {
        ...state,
        view: { scale: 1, x: action.center.x - wx, y: action.center.y - wy },
        msg: '100%',
      };
    }

    case 'FIT': {
      const b = docBounds(state.doc);
      if (!b) return { ...state, view: { x: 0, y: 0, scale: 1 }, msg: 'nothing to fit' };
      const PAD = 60;
      const scale = Math.min(
        4,
        Math.max(0.2, Math.min((action.screenW - PAD * 2) / Math.max(b.w, 1), (action.screenH - PAD * 2) / Math.max(b.h, 1))),
      );
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      return {
        ...state,
        view: { scale, x: action.screenW / 2 - cx * scale, y: action.screenH / 2 - cy * scale },
        msg: 'fit to content',
      };
    }

    case 'CENTER':
      return {
        ...state,
        view: {
          ...state.view,
          x: action.screenW / 2 - state.cursor.x * state.view.scale,
          y: action.screenH / 2 - state.cursor.y * state.view.scale,
        },
      };

    case 'UNDO': {
      const prev = state.undo[state.undo.length - 1];
      if (!prev) return { ...state, msg: 'already at oldest change', count: '' };
      return {
        ...state,
        doc: prev,
        undo: state.undo.slice(0, -1),
        redo: [...state.redo, state.doc],
        selectedIds: [],
        count: '',
        msg: 'undo',
      };
    }

    case 'REDO': {
      const next = state.redo[state.redo.length - 1];
      if (!next) return { ...state, msg: 'already at newest change', count: '' };
      return {
        ...state,
        doc: next,
        redo: state.redo.slice(0, -1),
        undo: [...state.undo, state.doc],
        selectedIds: [],
        count: '',
        msg: 'redo',
      };
    }

    case 'NEW':
      return commit(state, emptyDoc(), { selectedIds: [], fileName: null, msg: 'new document' });

    case 'LOAD':
      return commit(state, action.doc, {
        selectedIds: [],
        fileName: action.fileName,
        msg: action.fileName ? `opened ${action.fileName}` : 'opened',
      });

    case 'MSG':
      return { ...state, msg: action.msg };

    case 'SAVED':
      return { ...state, fileName: action.fileName, msg: `saved ${action.fileName}` };

    case 'SET_VIM':
      return { ...state, vim: action.on, msg: `vim mode ${action.on ? 'on' : 'off'}` };

    case 'TOGGLE_HELP':
      return { ...state, showHelp: !state.showHelp };

    case 'SET_COLOR': {
      const idSet = new Set(action.ids);
      if (!idSet.size) return state;
      const color = action.color ?? undefined;
      const doc: Doc = {
        shapes: state.doc.shapes.map((s) => (idSet.has(s.id) ? { ...s, color } : s)),
        connectors: state.doc.connectors.map((c) => (idSet.has(c.id) ? { ...c, color } : c)),
      };
      return commit(state, doc, { msg: color ? 'color set' : 'color reset' });
    }

    case 'SET_TRIANGLE_DIRECTION': {
      const idSet = new Set(action.ids);
      if (!idSet.size) return state;
      const doc: Doc = {
        ...state.doc,
        shapes: state.doc.shapes.map((s) =>
          idSet.has(s.id) && s.kind === 'triangle' ? { ...s, direction: action.direction } : s,
        ),
      };
      return commit(state, doc, { msg: 'direction set' });
    }

    case 'REORDER': {
      if (!action.ids.length) return state;
      const msg = {
        front: 'brought to front',
        back: 'sent to back',
        forward: 'moved forward',
        backward: 'moved backward',
      }[action.dir];
      return commit(state, reorderItems(state.doc, action.ids, action.dir), { msg });
    }

    case 'DUPLICATE':
      return duplicateSelection(state);

    case 'DELETE_IDS': {
      if (!action.ids.length) return state;
      const doc = action.ids.reduce((d, id) => deleteItem(d, id), state.doc);
      const stillSelected = state.selectedIds.filter((id) => !action.ids.includes(id));
      const restore = stillSelected.length
        ? { selectedIds: stillSelected, selectionHistory: state.selectionHistory }
        : restorePreviousSelection(state.selectionHistory, doc);
      return commit(state, doc, {
        selectedIds: restore.selectedIds,
        selectionHistory: restore.selectionHistory,
        msg: action.ids.length > 1 ? `deleted ${action.ids.length} items` : 'deleted',
      });
    }

    case 'COPY':
      return copySelection(state);

    case 'PASTE_AT': {
      if (!state.clipboard) return { ...state, msg: 'clipboard empty' };
      return pasteClipboard(state, state.clipboard, action.p);
    }

    case 'SELECT_ALL': {
      const ids = [...state.doc.shapes.map((s) => s.id), ...state.doc.connectors.map((c) => c.id)];
      if (!ids.length) return state;
      return { ...state, selectedIds: ids, msg: `${ids.length} selected` };
    }

    case 'GROUP': {
      if (state.selectedIds.length < 2) return { ...state, msg: 'select 2+ items to group' };
      const gid = newId();
      const idSet = new Set(state.selectedIds);
      const doc: Doc = {
        shapes: state.doc.shapes.map((s) => (idSet.has(s.id) ? { ...s, groupId: gid } : s)),
        connectors: state.doc.connectors.map((c) => (idSet.has(c.id) ? { ...c, groupId: gid } : c)),
      };
      return commit(state, doc, { msg: 'grouped' });
    }

    case 'UNGROUP': {
      if (!state.selectedIds.length) return state;
      const idSet = new Set(state.selectedIds);
      const doc: Doc = {
        shapes: state.doc.shapes.map((s) => (idSet.has(s.id) ? { ...s, groupId: undefined } : s)),
        connectors: state.doc.connectors.map((c) => (idSet.has(c.id) ? { ...c, groupId: undefined } : c)),
      };
      return commit(state, doc, { msg: 'ungrouped' });
    }

    case 'TOGGLE_GROUP': {
      const ids = state.selectedIds;
      if (ids.length < 2) return { ...state, msg: 'select 2+ items to group' };
      const gids = new Set(ids.map((id) => groupIdOf(state.doc, id)).filter((g): g is string => !!g));
      if (gids.size === 1) {
        const [gid] = gids;
        const members = groupMembers(state.doc, gid);
        if (members.length === ids.length && members.every((m) => ids.includes(m))) {
          return reduceCore(state, { type: 'UNGROUP' });
        }
      }
      return reduceCore(state, { type: 'GROUP' });
    }

    case 'WAYPOINT_DRAG_START':
      return { ...state, base: state.doc, selectedIds: [action.id] };

    case 'WAYPOINT_DRAG_MOVE':
      return { ...state, doc: setConnectorWaypoint(state.doc, action.id, action.index, snapPt(action.p)) };

    case 'ADD_WAYPOINT':
      return commit(state, insertConnectorWaypoint(state.doc, action.id, snapPt(action.p)), {
        msg: 'bend point added',
      });

    case 'CLEAR_WAYPOINTS':
      return commit(state, clearConnectorWaypoints(state.doc, action.id), { msg: 'bend points cleared' });

    case 'SET_CONNECTOR_ROUTING': {
      const doc: Doc = {
        ...state.doc,
        connectors: state.doc.connectors.map((c) => (c.id === action.id ? { ...c, routing: action.routing } : c)),
      };
      return commit(state, doc, { msg: action.routing === 'orthogonal' ? 'routing: orthogonal' : 'routing: straight' });
    }

    case 'ADD_IMAGE': {
      const at = snapPt(state.cursor);
      const shape: Shape = {
        id: newId(),
        kind: 'image',
        x: at.x,
        y: at.y,
        w: Math.max(GRID, snap(action.w)),
        h: Math.max(GRID, snap(action.h)),
        label: '',
        src: action.src,
      };
      return commit(state, addShape(state.doc, shape), { selectedIds: [shape.id], msg: 'image added' });
    }

    case 'ADD_TEXT': {
      const trimmed = action.text.replace(/\s+$/, '');
      if (!trimmed) return state;
      const at = snapPt(state.cursor);
      const m = measureLabel(trimmed);
      const shape: Shape = {
        id: newId(),
        kind: 'text',
        x: at.x,
        y: at.y,
        w: Math.max(GRID * 2, snap(m.w + GRID)),
        h: Math.max(GRID * 2, snap(m.h + GRID / 2)),
        label: trimmed,
      };
      return commit(state, addShape(state.doc, shape), { selectedIds: [shape.id], msg: 'text added' });
    }

    case 'PASTE_CLIP':
      // Mirrors the vim 'p' vs. Ctrl+D/plain-Ctrl+V split: paste at the
      // recorded cursor in vim-normal mode, offset-duplicate otherwise.
      return state.vim && state.mode === 'normal'
        ? pasteClipboard(state, action.clip)
        : pasteWithOffset(state, action.clip, GRID * 2);

    case 'CONTEXT_MENU_OPEN': {
      let selectedIds = state.selectedIds;
      if (action.id && !state.selectedIds.includes(action.id)) {
        const gid = groupIdOf(state.doc, action.id);
        selectedIds = gid ? groupMembers(state.doc, gid) : [action.id];
      }
      return {
        ...state,
        contextMenu: { screen: action.screen, world: action.world, id: action.id },
        selectedIds,
      };
    }

    case 'CONTEXT_MENU_CLOSE':
      return state.contextMenu ? { ...state, contextMenu: null } : state;

    default:
      return state;
  }
}
