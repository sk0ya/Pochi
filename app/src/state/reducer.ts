import {
  addConnector,
  addShape,
  connectorAt,
  deleteItem,
  findShape,
  measureLabel,
  shapeAt,
  updateShape,
} from '../model/doc';
import { classifyStroke } from '../model/sketch';
import type { Connector, Doc, Endpoint, Pt, Shape } from '../model/types';
import { GRID, emptyDoc, newId, snap, snapPt } from '../model/types';

export type Mode = 'normal' | 'insert' | 'command' | 'draw' | 'move' | 'resize' | 'arrow';

/** Active mouse tool: what a drag on empty canvas creates. */
export type MouseTool = 'sketch' | 'rect' | 'ellipse' | 'arrow' | 'text';

export interface View {
  x: number;
  y: number;
  scale: number;
}

export interface EditorState {
  doc: Doc;
  undo: Doc[];
  redo: Doc[];
  /** Snapshot taken when a transient op (move/resize/drag/insert) starts. */
  base: Doc | null;
  cursor: Pt;
  selectedId: string | null;
  mode: Mode;
  draw: { kind: 'rect' | 'ellipse'; anchor: Pt } | null;
  arrowFrom: Endpoint | null;
  editingId: string | null;
  editingIsNew: boolean;
  clipboard: Shape | null;
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
}

export type Action =
  | { type: 'KEY'; key: string; ctrl: boolean }
  | { type: 'CLICK'; p: Pt; id?: string }
  | { type: 'DBL_CLICK'; p: Pt; id?: string }
  | { type: 'MOUSE_CURSOR'; p: Pt }
  | { type: 'DRAG_START'; id: string }
  | { type: 'DRAG_MOVE'; id: string; to: Pt }
  | { type: 'DRAG_RESIZE'; id: string; w: number; h: number }
  | { type: 'DRAG_END' }
  | { type: 'START_INSERT'; id: string }
  | { type: 'INSERT_COMMIT'; label: string }
  | { type: 'CMD_OPEN' }
  | { type: 'CMD_SET'; text: string }
  | { type: 'CMD_CLOSE' }
  | { type: 'SET_TOOL'; tool: MouseTool }
  | { type: 'START_DRAW_AT'; kind: 'rect' | 'ellipse'; p: Pt }
  | { type: 'START_ARROW_AT'; p: Pt; shapeId?: string }
  | { type: 'TEXT_AT'; p: Pt }
  | { type: 'CANCEL' }
  | { type: 'SKETCH_START'; p: Pt }
  | { type: 'SKETCH_POINT'; p: Pt }
  | { type: 'SKETCH_END' }
  | { type: 'SKETCH_CANCEL' }
  | { type: 'PAN'; dx: number; dy: number }
  | { type: 'ZOOM'; factor: number; center: Pt }
  | { type: 'CENTER'; screenW: number; screenH: number }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | { type: 'NEW' }
  | { type: 'LOAD'; doc: Doc; fileName: string | null }
  | { type: 'MSG'; msg: string }
  | { type: 'SAVED'; fileName: string }
  | { type: 'SET_VIM'; on: boolean }
  | { type: 'TOGGLE_HELP' };

const DEFAULT_W = GRID * 10;
const DEFAULT_H = GRID * 6;
const UNDO_LIMIT = 200;

export function initialState(doc: Doc | null, vim: boolean): EditorState {
  return {
    doc: doc ?? emptyDoc(),
    undo: [],
    redo: [],
    base: null,
    cursor: { x: GRID * 10, y: GRID * 10 },
    selectedId: null,
    mode: 'normal',
    draw: null,
    arrowFrom: null,
    editingId: null,
    editingIsNew: false,
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
    editingId: null,
    editingIsNew: false,
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

function startDraw(state: EditorState, kind: 'rect' | 'ellipse'): EditorState {
  const anchor = snapPt(state.cursor);
  return {
    ...state,
    mode: 'draw',
    draw: { kind, anchor },
    cursor: { x: anchor.x + DEFAULT_W, y: anchor.y + DEFAULT_H },
    selectedId: null,
    count: '',
    msg: 'DRAW: hjkl to size, Enter/click to place, Esc to cancel',
  };
}

function confirmDraw(state: EditorState): EditorState {
  if (!state.draw) return state;
  const r = normRect(state.draw.anchor, state.cursor);
  const shape: Shape = { id: newId(), kind: state.draw.kind, ...r, label: '' };
  return commit(state, addShape(state.doc, shape), {
    mode: 'normal',
    draw: null,
    selectedId: shape.id,
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
    selectedId: null,
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
    selectedId: c.id,
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
    selectedId: shape.id,
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
    selectedId: id,
    count: '',
  };
}

function handleNormalKey(state: EditorState, key: string, ctrl: boolean): EditorState {
  if (ctrl) {
    if (key === 'r') return reduce(state, { type: 'REDO' });
    return state;
  }

  if (/^[0-9]$/.test(key) && !(key === '0' && state.count === '')) {
    return { ...state, count: state.count + key };
  }

  const delta = moveDelta(key, GRID * getCount(state));
  if (delta) {
    return {
      ...state,
      cursor: { x: state.cursor.x + delta.x, y: state.cursor.y + delta.y },
      count: '',
    };
  }

  switch (key) {
    case 'Escape':
      return { ...state, selectedId: null, count: '', msg: '', showHelp: false };
    case 'r':
      return startDraw(state, 'rect');
    case 'e':
      return startDraw(state, 'ellipse');
    case 'a':
      return startArrow(state);
    case 't':
      return startTextInsert(state, state.cursor);
    case 'i': {
      const { shape, connector } = hotItem(state);
      if (shape) return startEdit(state, shape.id);
      if (connector) return startEdit(state, connector.id);
      return startTextInsert(state, state.cursor);
    }
    case 'Enter': {
      const { shape, connector } = hotItem(state);
      return { ...state, selectedId: shape?.id ?? connector?.id ?? null, count: '' };
    }
    case 'v': {
      const { shape } = hotItem(state);
      if (!shape) return { ...state, msg: 'no shape under cursor', count: '' };
      return {
        ...state,
        mode: 'move',
        base: state.doc,
        selectedId: shape.id,
        count: '',
        msg: 'MOVE: hjkl to move, Enter to drop, Esc to cancel',
      };
    }
    case 's': {
      const { shape } = hotItem(state);
      if (!shape) return { ...state, msg: 'no shape under cursor', count: '' };
      return {
        ...state,
        mode: 'resize',
        base: state.doc,
        selectedId: shape.id,
        count: '',
        msg: 'RESIZE: l/h wider/narrower, j/k taller/shorter, Enter to done',
      };
    }
    case 'd':
    case 'x': {
      const { shape, connector } = hotItem(state);
      const id = shape?.id ?? connector?.id;
      if (!id) return { ...state, msg: 'nothing under cursor', count: '' };
      return commit(state, deleteItem(state.doc, id), {
        selectedId: null,
        count: '',
        msg: 'deleted',
      });
    }
    case 'y': {
      const { shape } = hotItem(state);
      if (!shape) return { ...state, msg: 'no shape under cursor', count: '' };
      return { ...state, clipboard: { ...shape }, count: '', msg: 'yanked' };
    }
    case 'p': {
      if (!state.clipboard) return { ...state, msg: 'clipboard empty', count: '' };
      const at = snapPt(state.cursor);
      const shape: Shape = { ...state.clipboard, id: newId(), x: at.x, y: at.y };
      return commit(state, addShape(state.doc, shape), {
        selectedId: shape.id,
        count: '',
        msg: 'pasted',
      });
    }
    case 'u':
      return reduce(state, { type: 'UNDO' });
    case '?':
      return { ...state, showHelp: !state.showHelp, count: '' };
    default:
      return { ...state, count: '' };
  }
}

function handleTransientKey(state: EditorState, key: string): EditorState {
  if (/^[0-9]$/.test(key) && !(key === '0' && state.count === '')) {
    return { ...state, count: state.count + key };
  }
  const step = GRID * getCount(state);

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
    const id = state.selectedId;
    if (delta && id) {
      const s = findShape(state.doc, id);
      if (!s) return cancelTransient(state);
      return {
        ...state,
        doc: updateShape(state.doc, id, { x: s.x + delta.x, y: s.y + delta.y }),
        cursor: { x: state.cursor.x + delta.x, y: state.cursor.y + delta.y },
        count: '',
      };
    }
    if (key === 'Enter' || key === 'v') return endTransient(state, { msg: 'moved' });
    if (key === 'Escape') return cancelTransient(state, { msg: 'cancelled' });
    return { ...state, count: '' };
  }

  if (state.mode === 'resize') {
    const id = state.selectedId;
    const s = id ? findShape(state.doc, id) : undefined;
    if (!s || !id) return cancelTransient(state);
    let dw = 0;
    let dh = 0;
    if (key === 'l' || key === 'ArrowRight') dw = step;
    if (key === 'h' || key === 'ArrowLeft') dw = -step;
    if (key === 'j' || key === 'ArrowDown') dh = step;
    if (key === 'k' || key === 'ArrowUp') dh = -step;
    if (dw !== 0 || dh !== 0) {
      return {
        ...state,
        doc: updateShape(state.doc, id, {
          w: Math.max(GRID, s.w + dw),
          h: Math.max(GRID, s.h + dh),
        }),
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
function handlePlainKey(state: EditorState, key: string, ctrl: boolean): EditorState {
  if (ctrl) {
    if (key === 'z') return reduce(state, { type: 'UNDO' });
    if (key === 'y') return reduce(state, { type: 'REDO' });
    return state;
  }
  if (state.mode === 'draw' || state.mode === 'arrow') return handleTransientKey(state, key);
  if (key === 'Escape') return { ...state, selectedId: null, msg: '', showHelp: false };
  if (key === 'Delete' || key === 'Backspace') {
    if (!state.selectedId) return state;
    return commit(state, deleteItem(state.doc, state.selectedId), {
      selectedId: null,
      msg: 'deleted',
    });
  }
  if (key === 'F2' && state.selectedId) return startEdit(state, state.selectedId);
  const delta = moveDelta(key, GRID);
  if (delta && state.selectedId) {
    const s = findShape(state.doc, state.selectedId);
    if (s) {
      return commit(state, updateShape(state.doc, state.selectedId, {
        x: s.x + delta.x,
        y: s.y + delta.y,
      }));
    }
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
    selectedId: state.doc.shapes.some((s) => s.id === id) || conn ? state.selectedId : null,
  };
}

export function reduce(state: EditorState, action: Action): EditorState {
  switch (action.type) {
    case 'KEY': {
      if (state.mode === 'insert' || state.mode === 'command') return state;
      if (!state.vim) return handlePlainKey(state, action.key, action.ctrl);
      if (state.mode === 'normal') return handleNormalKey(state, action.key, action.ctrl);
      return handleTransientKey(state, action.key);
    }

    case 'CLICK': {
      const p = snapPt(action.p);
      if (state.mode === 'draw') return confirmDraw({ ...state, cursor: p });
      if (state.mode === 'arrow') return confirmArrow({ ...state, cursor: action.p });
      const conn = action.id ? undefined : connectorAt(state.doc, action.p);
      return {
        ...state,
        cursor: p,
        selectedId: action.id ?? conn?.id ?? null,
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
        selectedId: shape.id,
      };
    }

    case 'MOUSE_CURSOR': {
      if (state.mode !== 'draw' && state.mode !== 'arrow') return state;
      return { ...state, cursor: snapPt(action.p) };
    }

    case 'DRAG_START':
      return { ...state, base: state.doc, selectedId: action.id };

    case 'DRAG_MOVE':
      return { ...state, doc: updateShape(state.doc, action.id, { x: action.to.x, y: action.to.y }) };

    case 'DRAG_RESIZE':
      return {
        ...state,
        doc: updateShape(state.doc, action.id, {
          w: Math.max(GRID, snap(action.w)),
          h: Math.max(GRID, snap(action.h)),
        }),
      };

    case 'DRAG_END': {
      const changed = state.base !== null && state.base !== state.doc;
      return {
        ...state,
        undo: changed ? [...state.undo, state.base as Doc].slice(-UNDO_LIMIT) : state.undo,
        redo: changed ? [] : state.redo,
        base: null,
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
        selectedId: null,
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
        selectedId: null,
        count: '',
        msg: 'drag to target',
      };
    }

    case 'TEXT_AT':
      return startTextInsert(state, action.p);

    case 'CANCEL':
      return cancelTransient(state, { msg: '' });

    case 'SKETCH_START':
      return { ...state, sketch: [action.p], selectedId: null };

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
          selectedId: c.id,
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
      };
      return commit(state, addShape(state.doc, shape), {
        sketch: null,
        selectedId: shape.id,
        msg: `auto: ${res.kind}`,
      });
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
        selectedId: null,
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
        selectedId: null,
        count: '',
        msg: 'redo',
      };
    }

    case 'NEW':
      return commit(state, emptyDoc(), { selectedId: null, fileName: null, msg: 'new document' });

    case 'LOAD':
      return commit(state, action.doc, {
        selectedId: null,
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

    default:
      return state;
  }
}
