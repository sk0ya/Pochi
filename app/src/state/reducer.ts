import {
  addConnector,
  addShape,
  alignShapes,
  bboxOf,
  canReorderStep,
  clearConnectorWaypoints,
  connectorAt,
  connectorLabelPos,
  deleteItem,
  distributeShapes,
  docBounds,
  findConnector,
  findShape,
  frameContainedIds,
  groupIdOf,
  groupMembers,
  insertConnectorWaypoint,
  itemsInRect,
  labelCenter,
  measureLabel,
  type ReorderDir,
  reorderItems,
  scaleShapes,
  setConnectorEndpoint,
  setConnectorWaypoint,
  setConnectorElbowRatio,
  resizeAnchor,
  shapeAt,
  translateItems,
  updateShape,
} from '../model/doc';
import { applyOps } from '../collab/sync';
import type { AppliedOps } from '../collab/sync';
import { classifyStroke, strokeToFreedraw } from '../model/sketch';
import type { AlignEdge, DistributeAxis } from '../model/doc';
import { findTemplate } from '../model/templates';
import type { Template } from '../model/templates';
import type { ArrowDirection, Connector, Doc, Endpoint, FontSize, Pt, Shape, ShapeKind, StrokeWidthLevel, TriangleDirection } from '../model/types';
import { GRID, emptyDoc, newId, snap, snapPt } from '../model/types';

export type Mode = 'normal' | 'insert' | 'command' | 'draw' | 'move' | 'resize' | 'arrow' | 'hint' | 'search';

/** A shape's assigned EasyMotion-style jump label, and where its badge/cursor should land. */
export interface HintEntry {
  id: string;
  label: string;
  center: Pt;
}

/** Shape kinds reachable via the hjkl-resize draw flow (excludes text/image, which use other flows). */
export type DrawKind = 'rect' | 'ellipse' | 'diamond' | 'triangle' | 'frame';

/** Active mouse tool: what a drag on empty canvas creates. */
export type MouseTool =
  | 'select'
  | 'sketch'
  | 'pen'
  | 'rect'
  | 'ellipse'
  | 'diamond'
  | 'triangle'
  | 'frame'
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

/**
 * Describes the last dot-repeatable (`.`) edit committed in vim NORMAL mode, so `.` can
 * replay it against the current cursor/doc. Only a deliberately small set of edits are
 * repeatable — resize, move, arrow-drawing, and label edits are NOT recorded here, same as
 * plain vim doesn't dot-repeat every command. Survives UNDO/REDO untouched (vim semantics:
 * `.` after `u` still repeats the edit that was undone).
 */
export type LastEdit =
  | { kind: 'draw'; shapeKind: DrawKind; w: number; h: number; direction?: TriangleDirection }
  | { kind: 'text'; text: string }
  | { kind: 'paste' }
  | { kind: 'delete' };

export interface EditorState {
  doc: Doc;
  /** Doc as of the last load/save/new, for detecting unsaved changes (see `isDirty`). */
  savedDoc: Doc;
  undo: Doc[];
  redo: Doc[];
  /** Snapshot taken when a transient op (move/resize/drag/insert) starts. */
  base: Doc | null;
  cursor: Pt;
  /** Selection lives above vim modes: normal-mode keys act on it when non-empty. */
  selectedIds: string[];
  /** The specific item last clicked/dragged, even when it's a member of a group and `selectedIds` was expanded to the whole group. Lets per-item UI (properties sidebar) target one group member instead of bailing out on multi-selection. */
  activeId: string | null;
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
  /** Active `f` hint-jump: every shape's assigned label plus the prefix typed so far. */
  hint: { entries: HintEntry[]; typed: string } | null;
  /**
   * Vim-style marks: `m{a-z}` records the cursor position under a letter, `'{a-z}` jumps back
   * to it. Positions, not shape references — deleting the shape that was under the cursor
   * doesn't invalidate the mark. Session-scoped only: unlike `doc`/`vim`, this field is never
   * read out to localStorage (see AUTOSAVE_KEY/VIM_KEY in App.tsx, which persist only those two
   * fields individually), so marks reset on reload same as undo history does.
   */
  marks: Record<string, Pt>;
  /**
   * Awaiting the second key of an `m` (mark-set) or `'` (mark-jump) sequence, vim's
   * operator-pending style. Esc cancels; any key outside a-z cancels silently (vim marks are
   * single lowercase letters, so there's nothing sensible to do with anything else).
   */
  pending: 'mark-set' | 'mark-jump' | null;
  clipboard: Clipboard | null;
  /** The last dot-repeatable edit; `.` replays it. Null until one is committed. */
  lastEdit: LastEdit | null;
  tool: MouseTool;
  /** Freehand stroke being drawn (sketch tool). */
  sketch: Pt[] | null;
  count: string;
  cmd: string;
  /** `/` search prompt: text typed so far. */
  search: string;
  /** Last confirmed `/` query, used by n/N; persists until replaced by a new search. */
  lastSearch: string | null;
  /** Id of the match the last search jump landed on. n/N step relative to this — the selection
   * can't serve that role, since a group jump also selects sibling matches. */
  lastSearchHit: string | null;
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
  | { type: 'DRAG_RESIZE'; w: number; h: number; anchor: Pt }
  | { type: 'DRAG_END' }
  | { type: 'ENDPOINT_DRAG_START'; id: string; end: 'from' | 'to' }
  | { type: 'ENDPOINT_DRAG_MOVE'; id: string; end: 'from' | 'to'; p: Pt }
  | { type: 'WAYPOINT_DRAG_START'; id: string; index: number }
  | { type: 'WAYPOINT_DRAG_MOVE'; id: string; index: number; p: Pt }
  | { type: 'ELBOW_DRAG_START'; id: string }
  | { type: 'ELBOW_DRAG_MOVE'; id: string; p: Pt }
  | { type: 'ADD_WAYPOINT'; id: string; p: Pt }
  | { type: 'CLEAR_WAYPOINTS'; id: string }
  | { type: 'SET_CONNECTOR_ROUTING'; id: string; routing: 'straight' | 'orthogonal' }
  | { type: 'SET_CONNECTOR_DASHED'; id: string; dashed: boolean }
  | { type: 'SET_CONNECTOR_ARROW_DIRECTION'; id: string; arrowDirection: ArrowDirection }
  | { type: 'START_INSERT'; id: string }
  | { type: 'INSERT_COMMIT'; label: string }
  | { type: 'SET_LABEL'; id: string; label: string }
  | { type: 'COMMIT_LABEL'; id: string }
  | { type: 'EDIT_COMMIT' }
  | { type: 'CMD_OPEN' }
  | { type: 'CMD_SET'; text: string }
  | { type: 'CMD_CLOSE' }
  | { type: 'SEARCH_OPEN' }
  | { type: 'SEARCH_SET'; text: string }
  | { type: 'SEARCH_CONFIRM' }
  | { type: 'SEARCH_CLOSE' }
  | { type: 'SET_TOOL'; tool: MouseTool }
  | { type: 'START_DRAW_AT'; kind: DrawKind; p: Pt }
  | { type: 'START_ARROW_AT'; p: Pt; shapeId?: string }
  | { type: 'TEXT_AT'; p: Pt }
  | { type: 'ADD_IMAGE'; src: string; w: number; h: number }
  | { type: 'ADD_TEXT'; text: string }
  | { type: 'PASTE_CLIP'; clip: Clipboard }
  | { type: 'INSERT_TEMPLATE'; templateId: string; at?: Pt }
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
  | { type: 'COLLAB_OPS'; ops: AppliedOps }
  | { type: 'COLLAB_DOC'; doc: Doc; msg: string }
  | { type: 'MSG'; msg: string }
  | { type: 'SAVED'; fileName: string }
  | { type: 'SET_VIM'; on: boolean }
  | { type: 'TOGGLE_HELP' }
  | { type: 'SET_COLOR'; ids: string[]; color: string | null }
  | { type: 'SET_FONT_SIZE'; ids: string[]; fontSize: FontSize }
  | { type: 'SET_TRIANGLE_DIRECTION'; ids: string[]; direction: TriangleDirection }
  | { type: 'SET_FILLED'; ids: string[]; filled: boolean }
  | { type: 'SET_SHAPE_KIND'; ids: string[]; kind: ShapeKind }
  | { type: 'SET_POSITION'; id: string; x: number; y: number }
  | { type: 'SET_SIZE'; id: string; w: number; h: number }
  | { type: 'SET_STROKE_WIDTH'; ids: string[]; strokeWidth: StrokeWidthLevel }
  | { type: 'SET_SHAPE_DASHED'; ids: string[]; dashed: boolean }
  | { type: 'REORDER'; ids: string[]; dir: ReorderDir }
  | { type: 'ALIGN'; ids: string[]; edge: AlignEdge }
  | { type: 'DISTRIBUTE'; ids: string[]; axis: DistributeAxis }
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

/** True if the doc has changed since the last load/save/new (see `savedDoc`). */
export function isDirty(state: EditorState): boolean {
  return state.doc !== state.savedDoc;
}

export function initialState(doc: Doc | null, vim: boolean): EditorState {
  const initialDoc = doc ?? emptyDoc();
  return {
    doc: initialDoc,
    savedDoc: initialDoc,
    undo: [],
    redo: [],
    base: null,
    cursor: { x: GRID * 10, y: GRID * 10 },
    selectedIds: [],
    activeId: null,
    selectionHistory: [],
    mode: 'normal',
    draw: null,
    arrowFrom: null,
    marquee: null,
    editingId: null,
    editingIsNew: false,
    resizeBox: null,
    hint: null,
    marks: {},
    pending: null,
    clipboard: null,
    lastEdit: null,
    tool: 'sketch',
    sketch: null,
    count: '',
    cmd: '',
    search: '',
    lastSearch: null,
    lastSearchHit: null,
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

/** Ends a live-preview session started by snapshotting `state.base` (drag, or a sidebar field
 * that dispatches on every keystroke — see SET_LABEL/SET_POSITION/SET_SIZE): pushes the
 * pre-session snapshot to undo as a single step (not one per intermediate update) and clears
 * `base`. A no-op if nothing actually changed during the session. */
function commitBase(state: EditorState, extra?: Partial<EditorState>): EditorState {
  const changed = state.base !== null && state.base !== state.doc;
  return {
    ...state,
    undo: changed ? [...state.undo, state.base as Doc].slice(-UNDO_LIMIT) : state.undo,
    redo: changed ? [] : state.redo,
    base: null,
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
    lastEdit: {
      kind: 'draw',
      shapeKind: state.draw.kind,
      w: r.w,
      h: r.h,
      ...(state.draw.kind === 'triangle' ? { direction: 'up' as const } : {}),
    },
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

/** Home-row-first key order for hint labels: easiest keys assigned first. */
const HINT_LETTERS = [
  'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'w', 'e', 'r', 'u', 'i', 'o', 'p', 'q', 't', 'y',
  'z', 'x', 'c', 'v', 'b', 'n', 'm',
];

/** Most targets labelable with 1–2 letter prefix-free labels (every letter used as a prefix). */
const HINT_CAPACITY = HINT_LETTERS.length * HINT_LETTERS.length;

/**
 * EasyMotion-style label assignment: up to `HINT_LETTERS.length` targets each get a single
 * letter (in order, so the first entries — the nearest shapes — get the easiest keys). Beyond
 * that, the last-assigned single letters are "demoted" to two-letter prefixes instead (combined
 * with every letter as a second key), so no label is ever a prefix of another label.
 * `n` must not exceed HINT_CAPACITY (callers clamp).
 */
function assignHintLabels(n: number): string[] {
  const k = HINT_LETTERS.length;
  if (n <= k) return HINT_LETTERS.slice(0, n);
  let prefixCount = 1;
  while (prefixCount < k && k - prefixCount + prefixCount * k < n) prefixCount++;
  const singles = HINT_LETTERS.slice(0, k - prefixCount);
  const prefixes = HINT_LETTERS.slice(k - prefixCount);
  const labels = [...singles];
  for (const prefix of prefixes) {
    for (const second of HINT_LETTERS) {
      if (labels.length >= n) return labels;
      labels.push(prefix + second);
    }
  }
  return labels;
}

/** Enters HINT mode: shapes get jump labels, nearest-to-cursor sorted first so it gets the
 * easiest label. Connectors aren't hinted; past HINT_CAPACITY the farthest shapes get none. */
function startHint(state: EditorState): EditorState {
  const shapes = state.doc.shapes;
  if (!shapes.length) return { ...state, msg: 'no shapes', count: '' };
  const dist = (s: Shape) => {
    const c = labelCenter(s);
    return Math.hypot(c.x - state.cursor.x, c.y - state.cursor.y);
  };
  const sorted = [...shapes].sort((a, b) => dist(a) - dist(b)).slice(0, HINT_CAPACITY);
  const labels = assignHintLabels(sorted.length);
  const entries: HintEntry[] = sorted.map((s, i) => ({ id: s.id, label: labels[i], center: labelCenter(s) }));
  return {
    ...state,
    mode: 'hint',
    hint: { entries, typed: '' },
    count: '',
    msg: 'HINT: type a label, Esc to cancel',
  };
}

/** Handles a keystroke while in HINT mode: Esc cancels, a matching letter narrows or (once a
 * full label is typed) jumps the cursor to that shape's center and selects it — expanding to
 * the whole group like a click would. Keys that match no remaining label are ignored. */
function handleHintKey(state: EditorState, key: string): EditorState {
  if (key === 'Escape') return { ...state, mode: 'normal', hint: null, msg: '' };
  if (!state.hint) return state;
  if (key.length !== 1 || !/[a-z]/i.test(key)) return state;
  const typed = state.hint.typed + key.toLowerCase();
  const hit = state.hint.entries.find((e) => e.label === typed);
  if (hit) {
    const gid = groupIdOf(state.doc, hit.id);
    return {
      ...state,
      mode: 'normal',
      hint: null,
      cursor: snapPt(hit.center),
      selectedIds: gid ? groupMembers(state.doc, gid) : [hit.id],
      msg: '',
    };
  }
  const stillPossible = state.hint.entries.some((e) => e.label.startsWith(typed));
  if (!stillPossible) return state;
  return { ...state, hint: { entries: state.hint.entries, typed } };
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

/** Clones a Template's shapes/connectors with fresh ids and a fresh shared groupId (so the
 * stamp lands as one group, and repeated insertions never collide with each other), centered
 * on `at` (a sidebar drag-and-drop's drop point) or, absent that, the cursor (the toolbar/vim
 * insert path). Mirrors pasteClipboard's id-remap, but also remaps groupId — a template's
 * shapes all deliberately share one groupId in their local definition (see templates.ts). */
function insertTemplate(state: EditorState, tpl: Template, at?: Pt): EditorState {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const sh of tpl.shapes) {
    minX = Math.min(minX, sh.x);
    minY = Math.min(minY, sh.y);
    maxX = Math.max(maxX, sh.x + sh.w);
    maxY = Math.max(maxY, sh.y + sh.h);
  }
  // Line-heavy templates (see templates.ts) put most of their extent in free connector
  // endpoints rather than shape bboxes, so those need to count toward the bbox too — mirrors
  // pasteClipboard's own xs/ys collection.
  for (const c of tpl.connectors) {
    for (const e of [c.from, c.to]) {
      if (e.shapeId) continue;
      minX = Math.min(minX, e.x);
      minY = Math.min(minY, e.y);
      maxX = Math.max(maxX, e.x);
      maxY = Math.max(maxY, e.y);
    }
  }
  if (minX === Infinity) return state;
  const anchor = snapPt(at ?? state.cursor);
  const dx = anchor.x - (minX + maxX) / 2;
  const dy = anchor.y - (minY + maxY) / 2;
  const idMap = new Map<string, string>();
  const groupIdMap = new Map<string, string>();
  const remapGroup = (gid?: string): string | undefined => {
    if (!gid) return undefined;
    let mapped = groupIdMap.get(gid);
    if (!mapped) {
      mapped = newId();
      groupIdMap.set(gid, mapped);
    }
    return mapped;
  };
  const shapes = tpl.shapes.map((sh) => {
    const id = newId();
    idMap.set(sh.id, id);
    return { ...sh, id, x: sh.x + dx, y: sh.y + dy, groupId: remapGroup(sh.groupId) };
  });
  const remap = (e: Endpoint): Endpoint =>
    e.shapeId
      ? { shapeId: idMap.get(e.shapeId), x: e.x + dx, y: e.y + dy }
      : { x: e.x + dx, y: e.y + dy };
  const connectors = tpl.connectors.map((c) => ({
    ...c,
    id: newId(),
    from: remap(c.from),
    to: remap(c.to),
    groupId: remapGroup(c.groupId),
  }));
  const doc: Doc = {
    shapes: [...state.doc.shapes, ...shapes],
    connectors: [...state.doc.connectors, ...connectors],
  };
  return commit(state, doc, {
    selectedIds: [...shapes.map((sh) => sh.id), ...connectors.map((c) => c.id)],
    msg: `inserted ${tpl.name}`,
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

interface SearchMatch {
  id: string;
  pos: Pt;
}

/** Case-insensitive substring match against shape and connector labels, in document order
 * (shapes then connectors, array order) — this fixed order is what n/N cycle through. */
function searchMatches(doc: Doc, query: string): SearchMatch[] {
  const q = query.toLowerCase();
  const matches: SearchMatch[] = [];
  for (const s of doc.shapes) {
    if (s.label.toLowerCase().includes(q)) matches.push({ id: s.id, pos: labelCenter(s) });
  }
  for (const c of doc.connectors) {
    if (c.label.toLowerCase().includes(q)) matches.push({ id: c.id, pos: connectorLabelPos(doc, c) });
  }
  return matches;
}

/** Jumps the cursor to `hit` and selects it (whole group, if grouped) — same semantics as a
 * hint-jump landing or a click. Records the hit as the position n/N step from. */
function jumpToMatch(state: EditorState, hit: SearchMatch): EditorState {
  const gid = groupIdOf(state.doc, hit.id);
  return {
    ...state,
    cursor: snapPt(hit.pos),
    selectedIds: gid ? groupMembers(state.doc, gid) : [hit.id],
    lastSearchHit: hit.id,
    count: '',
    msg: '',
  };
}

/** Confirms the `/` search prompt: empty query closes with no effect; otherwise jumps to
 * whichever match is nearest the current cursor and records the query for n/N. */
function confirmSearch(state: EditorState): EditorState {
  const query = state.search.trim();
  if (!query) return { ...state, mode: 'normal', search: '' };
  const matches = searchMatches(state.doc, query);
  if (!matches.length) {
    return {
      ...state,
      mode: 'normal',
      search: '',
      lastSearch: query,
      lastSearchHit: null,
      msg: `no match: ${query}`,
      count: '',
    };
  }
  const dist = (m: SearchMatch) => Math.hypot(m.pos.x - state.cursor.x, m.pos.y - state.cursor.y);
  const nearest = matches.reduce((best, m) => (dist(m) < dist(best) ? m : best));
  return { ...jumpToMatch(state, nearest), mode: 'normal', search: '', lastSearch: query };
}

/** n/N: re-evaluates the last search against the current doc (so a deleted shape can't crash
 * it) and steps to the next/previous match in document order, wrapping around. Steps relative
 * to the match the last jump landed on (`lastSearchHit`, not the selection — a group jump also
 * selects sibling matches); if that hit no longer matches (deleted, relabeled, or a fresh
 * no-match search), n starts at the first match and N at the last. */
function stepSearch(state: EditorState, dir: 1 | -1): EditorState {
  const query = state.lastSearch;
  if (!query) return { ...state, msg: 'no previous search', count: '' };
  const matches = searchMatches(state.doc, query);
  if (!matches.length) return { ...state, msg: `no match: ${query}`, count: '' };
  const curIdx = matches.findIndex((m) => m.id === state.lastSearchHit);
  const n = matches.length;
  const nextIdx = curIdx === -1 ? (dir === 1 ? 0 : n - 1) : (curIdx + dir + n) % n;
  return jumpToMatch(state, matches[nextIdx]);
}

/**
 * Deletes the current selection, or failing that whatever is under the cursor. Shared by the
 * d/x/Delete/Backspace handler and by `.` replaying a delete, so their semantics (selection
 * fallback, selection-history restore, one undo step, lastEdit recording) can't diverge.
 */
function deleteAtCursor(state: EditorState, msgSuffix = ''): EditorState {
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
    msg: (ids.length > 1 ? `deleted ${ids.length} items` : 'deleted') + msgSuffix,
    lastEdit: { kind: 'delete' },
  });
}

/**
 * `.`: vim-style dot-repeat, NORMAL mode only. Replays `state.lastEdit` at/relative to the
 * current cursor — a fresh shape/text/paste at the cursor, or a delete of whatever is under
 * the cursor *now* (the operation is repeated, not the original target). No-op with a status
 * message if nothing has been recorded yet.
 *
 * A count prefix (`3.`) is intentionally ignored: for the creation edits (draw/text/paste),
 * repeating N times at the same cursor position would just stack N fully-overlapping copies —
 * indistinguishable from one and not useful. For delete, only the first repetition ever finds
 * something under the cursor, since the delete itself doesn't move the cursor. So a count on
 * `.` has no clean, useful interpretation here and is dropped rather than special-cased.
 */
function repeatLastEdit(state: EditorState): EditorState {
  const edit = state.lastEdit;
  if (!edit) return { ...state, count: '', msg: 'nothing to repeat' };
  switch (edit.kind) {
    case 'draw': {
      const anchor = snapPt(state.cursor);
      const shape: Shape = {
        id: newId(),
        kind: edit.shapeKind,
        x: anchor.x,
        y: anchor.y,
        w: edit.w,
        h: edit.h,
        label: '',
        ...(edit.direction ? { direction: edit.direction } : {}),
      };
      return commit(state, addShape(state.doc, shape), {
        selectedIds: [shape.id],
        count: '',
        msg: 'placed (repeat)',
      });
    }
    case 'text': {
      const at = snapPt(state.cursor);
      const m = measureLabel(edit.text);
      const shape: Shape = {
        id: newId(),
        kind: 'text',
        x: at.x,
        y: at.y,
        w: Math.max(GRID * 2, snap(m.w + GRID)),
        h: Math.max(GRID * 2, snap(m.h + GRID / 2)),
        label: edit.text,
      };
      return commit(state, addShape(state.doc, shape), {
        selectedIds: [shape.id],
        count: '',
        msg: 'text added (repeat)',
      });
    }
    case 'paste': {
      if (!state.clipboard) return { ...state, count: '', msg: 'clipboard empty' };
      return pasteClipboard(state, state.clipboard);
    }
    case 'delete':
      return deleteAtCursor(state, ' (repeat)');
  }
}

/**
 * Resolves the second key of a pending `m`/`'` sequence (started by the `m`/`'` cases in
 * `handleNormalKey` below). Esc cancels with no message (matches HINT's Esc); any key that
 * isn't a bare lowercase letter — digits, punctuation, Ctrl-combos, Shift+letter — cancels
 * silently, same as vim ignoring a bogus mark key. `m` records the current cursor under that
 * letter; `'` jumps the cursor to it, or reports "mark not set" if the letter was never used.
 */
function handlePendingKey(state: EditorState, key: string, ctrl: boolean): EditorState {
  const pending = state.pending;
  if (key === 'Escape') return { ...state, pending: null, msg: '' };
  if (ctrl || !/^[a-z]$/.test(key)) return { ...state, pending: null };
  if (pending === 'mark-set') {
    return { ...state, pending: null, marks: { ...state.marks, [key]: state.cursor }, msg: `mark set: ${key}` };
  }
  const pos = state.marks[key];
  if (!pos) return { ...state, pending: null, msg: `mark not set: ${key}` };
  return { ...state, pending: null, cursor: pos, msg: '' };
}

function handleNormalKey(state: EditorState, key: string, ctrl: boolean, shift: boolean): EditorState {
  if (state.pending) return handlePendingKey(state, key, ctrl);
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
    case 'g':
      return startDraw(state, 'triangle');
    case 'o':
      return startDraw(state, 'frame');
    case 'a':
      return startArrow(state);
    case 'f':
      return startHint(state);
    case 'm':
      return { ...state, pending: 'mark-set', count: '', msg: '' };
    case "'":
      return { ...state, pending: 'mark-jump', count: '', msg: '' };
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
    case 'Backspace':
      return deleteAtCursor(state);
    case 'y': {
      const clip = yankSelection(state);
      if (!clip) return { ...state, msg: 'no shape under cursor', count: '' };
      const n = clip.shapes.length + clip.connectors.length;
      return { ...state, clipboard: clip, count: '', msg: n > 1 ? `yanked ${n} items` : 'yanked' };
    }
    case 'p': {
      if (!state.clipboard) return { ...state, msg: 'clipboard empty', count: '' };
      const pasted = pasteClipboard(state, state.clipboard);
      // pasteClipboard can no-op (nothing positionable in the clipboard); only a paste
      // that actually committed becomes the dot-repeatable edit.
      if (pasted.doc === state.doc) return pasted;
      return { ...pasted, lastEdit: { kind: 'paste' } };
    }
    case 'u':
      return reduceCore(state, { type: 'UNDO' });
    case 'n':
      return stepSearch(state, 1);
    case 'N':
      return stepSearch(state, -1);
    case '.':
      return repeatLastEdit(state);
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
      // `state.base` is the doc snapshot frozen when MOVE started (see the 'v' case in
      // handleNormalKey) and stays fixed for the whole transient, so re-deriving frame
      // membership from it on every keystroke always yields the same set — i.e. containment
      // is decided once, at move start, not re-evaluated as things slide around.
      const ids = frameContainedIds(state.base ?? state.doc, state.selectedIds);
      return {
        ...state,
        doc: translateItems(state.doc, ids, delta.x, delta.y),
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
    // Each arrow-key nudge here is its own atomic move (no transient/base to freeze), so
    // containment is decided fresh against the current doc every press — which for a single
    // press *is* "at move start".
    const ids = frameContainedIds(state.doc, state.selectedIds);
    return commit(state, translateItems(state.doc, ids, delta.x, delta.y));
  }
  return state;
}

function commitInsert(state: EditorState, label: string): EditorState {
  const id = state.editingId;
  if (!id) return { ...state, mode: 'normal' };
  const trimmed = label.replace(/\s+$/, '');
  const conn = state.doc.connectors.find((c) => c.id === id);
  let doc: Doc;
  // Text creation (t + typed text) is dot-repeatable; editing an existing shape's or
  // connector's label is a distinct, deliberately non-repeatable edit (matches vim: a
  // label edit isn't the "change" `.` reproduces here).
  let textCreate: LastEdit | undefined;
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
        const m = measureLabel(trimmed, s.fontSize);
        patch = {
          ...patch,
          w: Math.max(GRID * 2, snap(m.w + GRID)),
          h: Math.max(GRID * 2, snap(m.h + GRID / 2)),
        };
      }
      patch.label = trimmed;
      doc = updateShape(state.doc, id, patch);
      if (state.vim && state.editingIsNew && s.kind === 'text' && trimmed !== '') {
        textCreate = { kind: 'text', text: trimmed };
      }
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
    ...(textCreate ? { lastEdit: textCreate } : {}),
  };
}

/**
 * Whether `action` performs a delete: these manage `selectionHistory` themselves
 * (popping the previous selection back in), so the `reduce` wrapper below must not
 * also record a history entry for them. `.` counts too when it's about to replay a
 * recorded delete (checked against `state`, since the action itself can't tell).
 */
function isDeleteAction(state: EditorState, action: Action): boolean {
  if (action.type === 'DELETE_IDS') return true;
  if (action.type !== 'KEY') return false;
  if (['Delete', 'Backspace', 'd', 'x'].includes(action.key)) return true;
  return action.key === '.' && state.lastEdit?.kind === 'delete';
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
  if (result === state || isDeleteAction(state, action) || sameIds(result.selectedIds, state.selectedIds)) {
    return result;
  }
  return { ...result, selectionHistory: pushSelectionHistory(state.selectionHistory, state.selectedIds) };
}

/** Mouse-initiated actions that implicitly cancel HINT mode (like other transient modes),
 * so a click/drag never operates while stale hint badges are shown. The same set also
 * cancels a pending `m`/`'` mark sequence: after `m` → click-elsewhere, the user has moved
 * on, and the next keypress must act normally instead of being swallowed as a mark letter. */
const MOUSE_CANCEL_ACTIONS = new Set<Action['type']>([
  'CLICK', 'DBL_CLICK', 'DRAG_START', 'SKETCH_START', 'MARQUEE_START',
  'ENDPOINT_DRAG_START', 'WAYPOINT_DRAG_START', 'ELBOW_DRAG_START',
  'START_DRAW_AT', 'START_ARROW_AT', 'TEXT_AT', 'CONTEXT_MENU_OPEN',
]);

function reduceCore(state: EditorState, action: Action): EditorState {
  if (state.mode === 'hint' && MOUSE_CANCEL_ACTIONS.has(action.type)) {
    state = { ...state, mode: 'normal', hint: null, msg: '' };
  }
  if (state.pending && MOUSE_CANCEL_ACTIONS.has(action.type)) {
    state = { ...state, pending: null };
  }
  switch (action.type) {
    case 'KEY': {
      if (state.mode === 'insert' || state.mode === 'command' || state.mode === 'search') return state;
      const shift = !!action.shift;
      if (!state.vim) return handlePlainKey(state, action.key, action.ctrl, shift);
      if (state.mode === 'normal') return handleNormalKey(state, action.key, action.ctrl, shift);
      if (state.mode === 'hint') return handleHintKey(state, action.key);
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
          activeId: has ? state.activeId : hit,
          count: '',
          msg: '',
        };
      }
      const gid = hit ? groupIdOf(state.doc, hit) : undefined;
      return {
        ...state,
        cursor: p,
        selectedIds: hit ? (gid ? groupMembers(state.doc, gid) : [hit]) : [],
        activeId: hit,
        count: '',
        msg: '',
      };
    }

    case 'DBL_CLICK': {
      if (action.id) return startEdit(state, action.id);
      return startTextInsert(state, action.p);
    }

    case 'MOUSE_CURSOR': {
      if (state.mode !== 'draw' && state.mode !== 'arrow') return state;
      return { ...state, cursor: snapPt(action.p) };
    }

    case 'DRAG_START': {
      if (state.selectedIds.includes(action.id)) return { ...state, base: state.doc, activeId: action.id };
      // Dragging an unselected item reselects it (or its whole group, if grouped).
      const gid = groupIdOf(state.doc, action.id);
      return {
        ...state,
        base: state.doc,
        selectedIds: gid ? groupMembers(state.doc, gid) : [action.id],
        activeId: action.id,
      };
    }

    case 'DRAG_MOVE': {
      const src = state.base ?? state.doc;
      const orig = findShape(src, action.id);
      if (!orig) return state;
      const baseIds = state.selectedIds.includes(action.id) ? state.selectedIds : [action.id];
      // `src` is the doc snapshot frozen at DRAG_START and stays fixed for the whole drag, so
      // re-deriving frame membership from it on every move event always yields the same set —
      // containment is decided once, at drag start.
      const ids = frameContainedIds(src, baseIds);
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
      return {
        ...state,
        doc: scaleShapes(base, ids, newW, newH, action.anchor, box.w, box.h),
      };
    }

    case 'DRAG_END':
      return commitBase(state);

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

    // Live preview while the PropertiesSidebar text field is being typed into — dispatched on
    // every keystroke, so this must NOT push undo per-keystroke (that's COMMIT_LABEL's job) and
    // must NOT trim/delete-on-empty (that would yank the shape out from under a still-focused
    // field mid-edit). It snapshots `base` on the first keystroke of a session, same as DRAG_MOVE.
    case 'SET_LABEL': {
      const base = state.base ?? state.doc;
      const conn = findConnector(state.doc, action.id);
      let doc: Doc;
      if (conn) {
        doc = {
          ...state.doc,
          connectors: state.doc.connectors.map((c) => (c.id === action.id ? { ...c, label: action.label } : c)),
        };
      } else {
        const s = findShape(state.doc, action.id);
        if (!s) return state;
        let patch: Partial<Shape> = { label: action.label };
        if (s.kind === 'text') {
          const m = measureLabel(action.label, s.fontSize);
          patch = {
            ...patch,
            w: Math.max(GRID * 2, snap(m.w + GRID)),
            h: Math.max(GRID * 2, snap(m.h + GRID / 2)),
          };
        }
        doc = updateShape(state.doc, action.id, patch);
      }
      return { ...state, doc, base };
    }

    // Ends a SET_LABEL live session (sidebar field losing focus, or the field unmounting because
    // the selection changed): trims trailing whitespace, deletes a text shape left empty, and
    // folds the whole typing session into one undo step via commitBase.
    case 'COMMIT_LABEL': {
      const conn = findConnector(state.doc, action.id);
      let doc = state.doc;
      if (conn) {
        const trimmed = conn.label.replace(/\s+$/, '');
        if (trimmed !== conn.label) {
          doc = { ...doc, connectors: doc.connectors.map((c) => (c.id === action.id ? { ...c, label: trimmed } : c)) };
        }
      } else {
        const s = findShape(state.doc, action.id);
        if (s) {
          const trimmed = s.label.replace(/\s+$/, '');
          if (s.kind === 'text' && trimmed === '') {
            doc = deleteItem(doc, action.id);
          } else if (trimmed !== s.label) {
            let patch: Partial<Shape> = { label: trimmed };
            if (s.kind === 'text') {
              const m = measureLabel(trimmed, s.fontSize);
              patch = {
                ...patch,
                w: Math.max(GRID * 2, snap(m.w + GRID)),
                h: Math.max(GRID * 2, snap(m.h + GRID / 2)),
              };
            }
            doc = updateShape(doc, action.id, patch);
          }
        }
      }
      return commitBase(
        { ...state, doc },
        {
          selectedIds: state.selectedIds.filter(
            (sid) => doc.shapes.some((s) => s.id === sid) || doc.connectors.some((c) => c.id === sid),
          ),
        },
      );
    }

    // Ends any other live-preview session (SET_POSITION/SET_SIZE) the same way COMMIT_LABEL
    // ends a label edit, minus the label-specific trim/delete step.
    case 'EDIT_COMMIT':
      return commitBase(state);

    case 'CMD_OPEN':
      return { ...state, mode: 'command', cmd: '', count: '' };

    case 'CMD_SET':
      return { ...state, cmd: action.text };

    case 'CMD_CLOSE':
      return { ...state, mode: 'normal', cmd: '' };

    case 'SEARCH_OPEN':
      return { ...state, mode: 'search', search: '', count: '' };

    case 'SEARCH_SET':
      return { ...state, search: action.text };

    case 'SEARCH_CONFIRM':
      return confirmSearch(state);

    case 'SEARCH_CLOSE':
      return { ...state, mode: 'normal', search: '' };

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
      // Pen tool: keep the stroke as-is (simplified + quantized) instead of
      // classifying it into a shape. No text edit — a squiggle rarely wants a
      // label right away, and the label can still be added by double-click.
      if (state.tool === 'pen') {
        const res = strokeToFreedraw(pts);
        if (!res) return { ...state, sketch: null, msg: '' };
        const shape: Shape = { id: newId(), kind: 'freedraw', ...res, label: '' };
        return commit(state, addShape(state.doc, shape), {
          sketch: null,
          selectedIds: [shape.id],
          msg: 'pen',
        });
      }
      const res = classifyStroke(pts);
      if (!res) return { ...state, sketch: null, msg: '' };
      if (res.kind === 'line') {
        return { ...state, sketch: null, msg: '' };
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

    case 'NEW': {
      const doc = emptyDoc();
      return commit(state, doc, { savedDoc: doc, selectedIds: [], fileName: null, msg: 'new document' });
    }

    case 'LOAD':
      return commit(state, action.doc, {
        savedDoc: action.doc,
        selectedIds: [],
        fileName: action.fileName,
        msg: action.fileName ? `opened ${action.fileName}` : 'opened',
      });

    /* Remote peers' edits, already arbitrated by the collab SyncEngine. Merged into the
     * *current* doc (never a snapshot from when the message arrived) and deliberately not
     * pushed onto the undo stack: `u` should revert your own edits, not a teammate's. */
    case 'COLLAB_OPS': {
      const doc = applyOps(state.doc, action.ops);
      const removed = new Set(action.ops.deletes);
      return {
        ...state,
        doc,
        selectedIds: state.selectedIds.filter((id) => !removed.has(id)),
        selectionHistory: state.selectionHistory
          .map((sel) => sel.filter((id) => !removed.has(id)))
          .filter((sel) => sel.length > 0),
      };
    }

    /* The room's document adopted on join. Undo/redo are wiped rather than pushed onto
     * (App.tsx already confirms before joining if there are unsaved changes): every doc
     * reachable via undo while in a room must itself be a room-derived state, or an undo
     * back to pre-join content would get diffed and broadcast like a real edit — silently
     * replacing every other peer's work with clock values that win LWW. Doesn't touch
     * savedDoc — the adopted doc counts as unsaved changes. */
    case 'COLLAB_DOC':
      return { ...state, doc: action.doc, undo: [], redo: [], selectedIds: [], msg: action.msg };

    case 'MSG':
      return { ...state, msg: action.msg };

    case 'SAVED':
      return { ...state, savedDoc: state.doc, fileName: action.fileName, msg: `saved ${action.fileName}` };

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

    case 'SET_FONT_SIZE': {
      const idSet = new Set(action.ids);
      if (!idSet.size) return state;
      const fontSize = action.fontSize === 'm' ? undefined : action.fontSize;
      const doc: Doc = {
        shapes: state.doc.shapes.map((s) => {
          if (!idSet.has(s.id)) return s;
          // Text shapes auto-size their box from the label (like commitInsert does on
          // every label edit); a font-size change must re-fit the box the same way, or
          // the label would visually overflow/underflow it. Other kinds keep a
          // user-controlled box, so only fontSize changes for them.
          if (s.kind === 'text' && s.label) {
            const m = measureLabel(s.label, fontSize);
            return {
              ...s,
              fontSize,
              w: Math.max(GRID * 2, snap(m.w + GRID)),
              h: Math.max(GRID * 2, snap(m.h + GRID / 2)),
            };
          }
          return { ...s, fontSize };
        }),
        connectors: state.doc.connectors.map((c) => (idSet.has(c.id) ? { ...c, fontSize } : c)),
      };
      return commit(state, doc, { msg: `font size: ${action.fontSize}` });
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

    case 'SET_FILLED': {
      const idSet = new Set(action.ids);
      if (!idSet.size) return state;
      const doc: Doc = {
        ...state.doc,
        shapes: state.doc.shapes.map((s) =>
          idSet.has(s.id) && s.kind !== 'text' && s.kind !== 'image'
            ? { ...s, filled: action.filled }
            : s,
        ),
      };
      return commit(state, doc, { msg: action.filled ? '塗り: ベタ塗り' : '塗り: アウトライン' });
    }

    case 'SET_SHAPE_KIND': {
      const idSet = new Set(action.ids);
      if (!idSet.size) return state;
      const doc: Doc = {
        ...state.doc,
        shapes: state.doc.shapes.map((s) => {
          if (!idSet.has(s.id) || s.kind === 'image') return s;
          // `filled` carries straight through a kind change, including into/out of 'frame':
          // a frame's interior tint is rendered pointer-events:none (see Canvas.tsx), so it
          // stays purely visual and never affects the frame's click-through hit-testing.
          return { ...s, kind: action.kind };
        }),
      };
      return commit(state, doc, { msg: '図形の種類を変更' });
    }

    // Live preview while the PropertiesSidebar X/Y fields are being typed into (same
    // dispatch-per-keystroke, snapshot-`base`-once, coalesce-on-EDIT_COMMIT pattern as
    // SET_LABEL/COMMIT_LABEL above and DRAG_MOVE/DRAG_END elsewhere in this file).
    case 'SET_POSITION': {
      const orig = findShape(state.doc, action.id);
      if (!orig) return state;
      const base = state.base ?? state.doc;
      const ids = frameContainedIds(state.doc, [action.id]);
      const doc = translateItems(state.doc, ids, action.x - orig.x, action.y - orig.y);
      return { ...state, doc, base };
    }

    // Live preview while the PropertiesSidebar width/height fields are being typed into; see
    // SET_POSITION above.
    case 'SET_SIZE': {
      const orig = findShape(state.doc, action.id);
      if (!orig) return state;
      const base = state.base ?? state.doc;
      const newW = Math.max(GRID, snap(action.w));
      const newH = Math.max(GRID, snap(action.h));
      const doc = scaleShapes(state.doc, [action.id], newW, newH, { x: orig.x, y: orig.y }, orig.w, orig.h);
      return { ...state, doc, base };
    }

    case 'SET_STROKE_WIDTH': {
      const idSet = new Set(action.ids);
      if (!idSet.size) return state;
      const strokeWidth = action.strokeWidth === 'm' ? undefined : action.strokeWidth;
      const doc: Doc = {
        shapes: state.doc.shapes.map((s) => (idSet.has(s.id) ? { ...s, strokeWidth } : s)),
        connectors: state.doc.connectors.map((c) => (idSet.has(c.id) ? { ...c, strokeWidth } : c)),
      };
      return commit(state, doc, { msg: `線の太さ: ${action.strokeWidth}` });
    }

    case 'SET_SHAPE_DASHED': {
      const idSet = new Set(action.ids);
      if (!idSet.size) return state;
      const doc: Doc = {
        ...state.doc,
        shapes: state.doc.shapes.map((s) =>
          idSet.has(s.id) && s.kind !== 'text' && s.kind !== 'image' ? { ...s, dashed: action.dashed } : s,
        ),
      };
      return commit(state, doc, { msg: action.dashed ? '線種: 破線' : '線種: 実線' });
    }

    case 'REORDER': {
      if (!action.ids.length) return state;
      if (
        (action.dir === 'forward' || action.dir === 'backward') &&
        !canReorderStep(state.doc, action.ids, action.dir)
      ) {
        return state;
      }
      const msg = {
        front: 'brought to front',
        back: 'sent to back',
        forward: 'moved forward',
        backward: 'moved backward',
      }[action.dir];
      return commit(state, reorderItems(state.doc, action.ids, action.dir), { msg });
    }

    case 'ALIGN': {
      if (action.ids.length < 2) return state;
      const msg = {
        left: '左揃え',
        'center-h': '左右中央揃え',
        right: '右揃え',
        top: '上揃え',
        'center-v': '上下中央揃え',
        bottom: '下揃え',
      }[action.edge];
      return commit(state, alignShapes(state.doc, action.ids, action.edge), { msg });
    }

    case 'DISTRIBUTE': {
      // Distributing needs a first/middle/last shape to space out; mirrors GROUP's
      // "select 2+ items to group" style of feedback when the selection is too small.
      if (action.ids.length < 3) return { ...state, msg: 'select 3+ items to distribute' };
      const msg = action.axis === 'h' ? '横に等間隔' : '縦に等間隔';
      return commit(state, distributeShapes(state.doc, action.ids, action.axis), { msg });
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

    case 'ELBOW_DRAG_START':
      return { ...state, base: state.doc, selectedIds: [action.id] };

    case 'ELBOW_DRAG_MOVE':
      return { ...state, doc: setConnectorElbowRatio(state.doc, action.id, action.p) };

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

    case 'SET_CONNECTOR_DASHED': {
      const doc: Doc = {
        ...state.doc,
        connectors: state.doc.connectors.map((c) => (c.id === action.id ? { ...c, dashed: action.dashed } : c)),
      };
      return commit(state, doc, { msg: action.dashed ? 'line: dashed' : 'line: solid' });
    }

    case 'SET_CONNECTOR_ARROW_DIRECTION': {
      const doc: Doc = {
        ...state.doc,
        connectors: state.doc.connectors.map((c) =>
          c.id === action.id ? { ...c, arrowDirection: action.arrowDirection } : c,
        ),
      };
      return commit(state, doc, { msg: `arrow: ${action.arrowDirection}` });
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

    case 'INSERT_TEMPLATE': {
      const tpl = findTemplate(action.templateId);
      return tpl ? insertTemplate(state, tpl, action.at) : state;
    }

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
