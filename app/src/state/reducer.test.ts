import { describe, expect, it } from 'vitest';
import { initialState, reduce, TOOL_KEYS } from './reducer';
import type { EditorState } from './reducer';
import { connectorPath, inscribedBox, labelBox, labelCenter, labelMaxWidth, shapeAt, wrapLabel } from '../model/doc';
import type { Connector, Doc, Pt, Shape } from '../model/types';
import { GRID, snapPt } from '../model/types';

// This suite runs under vitest's `node` environment (no DOM). `measureLabel` — used when
// committing/repeating a text shape — falls back to a character-count width estimate when
// it can't get a canvas 2D context, so a minimal `document` stub is enough to exercise that
// path deterministically without pulling in jsdom.
if (typeof document === 'undefined') {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({ getContext: () => null }),
  };
}

const rect = (id: string, x: number, y: number, w = GRID * 4, h = GRID * 4): Shape => ({
  id,
  kind: 'rect',
  x,
  y,
  w,
  h,
  label: '',
});

const frame = (id: string, x: number, y: number, w = GRID * 8, h = GRID * 8): Shape => ({
  id,
  kind: 'frame',
  x,
  y,
  w,
  h,
  label: '',
});

const labelCenterOf = labelCenter;

/** Fresh vim-mode state (HINT is a vim-only feature) with `doc` loaded and the
 * cursor at the default `initialState` position. */
function vimState(doc: Doc): EditorState {
  return initialState(doc, true);
}

const key = (state: EditorState, k: string): EditorState => reduce(state, { type: 'KEY', key: k, ctrl: false });
const type = (state: EditorState, s: string): EditorState => [...s].reduce(key, state);

describe('HINT mode: entering', () => {
  it('f enters HINT mode and assigns a label to every shape, nearest to cursor first', () => {
    const cursor = initialState(null, true).cursor;
    const near = rect('near', cursor.x, cursor.y);
    const far = rect('far', cursor.x + GRID * 100, cursor.y + GRID * 100);
    const state = key(vimState({ shapes: [far, near], connectors: [] }), 'f');
    expect(state.mode).toBe('hint');
    expect(state.hint).not.toBeNull();
    expect(state.hint!.typed).toBe('');
    const byId = Object.fromEntries(state.hint!.entries.map((e) => [e.id, e.label]));
    // Nearest shape gets the first (easiest) letter in the home-row-first order.
    expect(byId.near).toBe('a');
    expect(byId.far).toBe('s');
  });

  it('does nothing (no shapes) when the doc is empty', () => {
    const state = key(vimState({ shapes: [], connectors: [] }), 'f');
    expect(state.mode).toBe('normal');
    expect(state.hint).toBeNull();
  });

  it('only hints shapes, not connectors', () => {
    const s = rect('s1', 0, 0);
    const doc: Doc = {
      shapes: [s],
      connectors: [{ id: 'c1', from: { x: 0, y: 0 }, to: { x: 100, y: 100 }, label: '' }],
    };
    const state = key(vimState(doc), 'f');
    expect(state.hint!.entries).toHaveLength(1);
    expect(state.hint!.entries[0].id).toBe('s1');
  });
});

describe('HINT mode: label assignment', () => {
  it('assigns single-letter labels for up to 26 shapes', () => {
    const shapes = Array.from({ length: 26 }, (_, i) => rect(`s${i}`, i * GRID * 10, 0));
    const state = key(vimState({ shapes, connectors: [] }), 'f');
    const labels = state.hint!.entries.map((e) => e.label);
    expect(labels).toHaveLength(26);
    expect(labels.every((l) => l.length === 1)).toBe(true);
    expect(new Set(labels).size).toBe(26); // all unique
  });

  it('clamps to 676 labeled shapes beyond capacity, with every label defined', () => {
    const shapes = Array.from({ length: 700 }, (_, i) => rect(`s${i}`, (i % 50) * GRID * 10, Math.floor(i / 50) * GRID * 10));
    const state = key(vimState({ shapes, connectors: [] }), 'f');
    const entries = state.hint!.entries;
    expect(entries).toHaveLength(676); // 26 * 26; the farthest shapes get no hint
    expect(entries.every((e) => typeof e.label === 'string' && e.label.length >= 1)).toBe(true);
    expect(new Set(entries.map((e) => e.label)).size).toBe(676); // all unique
  });

  it('falls back to two-letter labels beyond 26 shapes, with no label a prefix of another', () => {
    const shapes = Array.from({ length: 30 }, (_, i) => rect(`s${i}`, i * GRID * 10, 0));
    const state = key(vimState({ shapes, connectors: [] }), 'f');
    const labels = state.hint!.entries.map((e) => e.label);
    expect(labels).toHaveLength(30);
    expect(new Set(labels).size).toBe(30); // all unique
    // Prefix-free: no label is a strict prefix of another label.
    for (const a of labels) {
      for (const b of labels) {
        if (a === b) continue;
        expect(b.startsWith(a)).toBe(false);
      }
    }
    // At least one two-letter label must exist since 30 > 26.
    expect(labels.some((l) => l.length === 2)).toBe(true);
  });
});

describe('HINT mode: narrowing and jump', () => {
  it('narrows to labels starting with the first typed key of a two-letter hint', () => {
    const shapes = Array.from({ length: 30 }, (_, i) => rect(`s${i}`, i * GRID * 10, 0));
    const state = key(vimState({ shapes, connectors: [] }), 'f');
    const twoLetter = state.hint!.entries.find((e) => e.label.length === 2)!;
    const prefixKey = twoLetter.label[0];
    const narrowed = key(state, prefixKey);
    expect(narrowed.mode).toBe('hint');
    expect(narrowed.hint!.typed).toBe(prefixKey);
    // Every entry either was consumed as an exact single-letter jump (impossible here since
    // we picked a two-letter prefix) or still starts with the typed prefix conceptually —
    // the caller (Canvas) filters by `label.startsWith(typed)`, so just confirm the target
    // hint's own label still matches.
    expect(twoLetter.label.startsWith(narrowed.hint!.typed)).toBe(true);
  });

  it('typing a full single-letter label jumps the cursor to the shape center and selects it (same as Enter)', () => {
    const s = rect('s1', GRID * 20, GRID * 20);
    const state = key(vimState({ shapes: [s], connectors: [] }), 'f');
    const label = state.hint!.entries[0].label;
    const jumped = type(state, label);
    expect(jumped.mode).toBe('normal');
    expect(jumped.hint).toBeNull();
    expect(jumped.selectedIds).toEqual(['s1']);
    expect(jumped.cursor).toEqual({ x: GRID * 20 + s.w / 2, y: GRID * 20 + s.h / 2 });
  });

  it('typing a full two-letter label jumps to that shape', () => {
    const shapes = Array.from({ length: 30 }, (_, i) => rect(`s${i}`, i * GRID * 10, 0));
    const state = key(vimState({ shapes, connectors: [] }), 'f');
    const target = state.hint!.entries.find((e) => e.label.length === 2)!;
    const jumped = type(state, target.label);
    expect(jumped.mode).toBe('normal');
    expect(jumped.hint).toBeNull();
    expect(jumped.selectedIds).toEqual([target.id]);
    expect(jumped.cursor).toEqual(target.center);
  });

  it('snaps the jump cursor to the grid for an odd-width shape', () => {
    // w = GRID*3 puts the center at x + 1.5*GRID, off the grid; the jump must snap it.
    const s = rect('s1', GRID * 20, GRID * 20, GRID * 3, GRID * 3);
    const state = key(vimState({ shapes: [s], connectors: [] }), 'f');
    const jumped = type(state, state.hint!.entries[0].label);
    expect(jumped.cursor.x % GRID).toBe(0);
    expect(jumped.cursor.y % GRID).toBe(0);
    expect(jumped.cursor).toEqual({ x: GRID * 22, y: GRID * 22 });
  });

  it('expands the selection to the whole group, like a click would', () => {
    const a = { ...rect('a', 0, 0), groupId: 'g1' };
    const b = { ...rect('b', GRID * 10, 0), groupId: 'g1' };
    const state = key(vimState({ shapes: [a, b], connectors: [] }), 'f');
    const target = state.hint!.entries.find((e) => e.id === 'b')!;
    const jumped = type(state, target.label);
    expect(jumped.selectedIds).toEqual(['a', 'b']);
    // Cursor still lands on the hit shape's own center, not the group's.
    expect(jumped.cursor).toEqual({ x: GRID * 12, y: GRID * 2 });
  });
});

describe('w / b: jump between shapes in reading order', () => {
  // Three shapes below/right of the default cursor ({GRID*10, GRID*10}): s1 and s2 share a
  // row (top→bottom, left→right reading order gives s1, s2, s3).
  const s1 = rect('s1', GRID * 20, GRID * 20);
  const s2 = rect('s2', GRID * 40, GRID * 20);
  const s3 = rect('s3', GRID * 20, GRID * 40);
  const doc: Doc = { shapes: [s3, s1, s2], connectors: [] }; // unsorted on purpose

  it('w from an empty spot jumps to the first shape in reading order and selects it', () => {
    const state = key(vimState(doc), 'w');
    expect(state.selectedIds).toEqual(['s1']);
    expect(state.cursor).toEqual(labelCenterOf(s1));
  });

  it('w walks s1 → s2 → s3, then stops at the last shape', () => {
    let state = key(vimState(doc), 'w');
    expect(state.selectedIds).toEqual(['s1']);
    state = key(state, 'w');
    expect(state.selectedIds).toEqual(['s2']);
    state = key(state, 'w');
    expect(state.selectedIds).toEqual(['s3']);
    const atEnd = key(state, 'w');
    expect(atEnd.selectedIds).toEqual(['s3']); // unchanged
    expect(atEnd.cursor).toEqual(state.cursor);
    expect(atEnd.msg).toBe('no next shape');
  });

  it('b walks back s3 → s2 → s1, then stops at the first shape', () => {
    let state = type(vimState(doc), 'www'); // on s3
    expect(state.selectedIds).toEqual(['s3']);
    state = key(state, 'b');
    expect(state.selectedIds).toEqual(['s2']);
    state = key(state, 'b');
    expect(state.selectedIds).toEqual(['s1']);
    const atStart = key(state, 'b');
    expect(atStart.selectedIds).toEqual(['s1']); // unchanged
    expect(atStart.msg).toBe('no previous shape');
  });

  it('honors a count: 3w lands three shapes forward', () => {
    const state = type(vimState(doc), '3w');
    expect(state.selectedIds).toEqual(['s3']);
    expect(state.cursor).toEqual(labelCenterOf(s3));
  });

  it('does nothing when there are no shapes', () => {
    const state = key(vimState({ shapes: [], connectors: [] }), 'w');
    expect(state.selectedIds).toEqual([]);
    expect(state.msg).toBe('no shapes');
  });

  it('b reverses w even on a diagonal/staircase layout (reading order is a total order)', () => {
    // Three shapes marching down-and-left, each on its own row band (GRID*3 tall). A naive
    // "same row within tolerance" comparator would form an A<B<C<A cycle here and break `b`.
    const top = rect('top', GRID * 60, GRID * 10); // highest, rightmost
    const mid = rect('mid', GRID * 30, GRID * 30);
    const bot = rect('bot', GRID * 0, GRID * 50); // lowest, leftmost
    const d: Doc = { shapes: [mid, bot, top], connectors: [] };
    // Forward: top → mid → bot (top-to-bottom).
    let s = key(vimState(d), 'w');
    expect(s.selectedIds).toEqual(['top']);
    s = key(s, 'w');
    expect(s.selectedIds).toEqual(['mid']);
    s = key(s, 'w');
    expect(s.selectedIds).toEqual(['bot']);
    // Backward must retrace exactly: bot → mid → top.
    s = key(s, 'b');
    expect(s.selectedIds).toEqual(['mid']);
    s = key(s, 'b');
    expect(s.selectedIds).toEqual(['top']);
  });

  it('expands the selection to the whole group, like a hint jump would', () => {
    const a = { ...rect('a', GRID * 20, GRID * 20), groupId: 'g1' };
    const b = { ...rect('b', GRID * 30, GRID * 20), groupId: 'g1' };
    const state = key(vimState({ shapes: [a, b], connectors: [] }), 'w');
    expect(state.selectedIds).toEqual(['a', 'b']);
    expect(state.cursor).toEqual(labelCenterOf(a));
  });

  it('keeps walking when the shape it landed on is covered by one above it in z-order', () => {
    // `over` sits on top of `big` and contains its center, so "what is under the cursor?" answers
    // `over`, not the shape `w` just jumped to — stepping from that answer walked straight back
    // into `big` and stalled there.
    const big = rect('big', GRID * 20, GRID * 20, GRID * 8, GRID * 8); // center (24, 24)
    const over = rect('over', GRID * 20, GRID * 23, GRID * 6, GRID * 2); // center (23, 24), on top
    const last = rect('last', GRID * 20, GRID * 40);
    const d: Doc = { shapes: [big, over, last], connectors: [] };
    let s = key(vimState(d), 'w');
    expect(s.selectedIds).toEqual(['over']);
    s = key(s, 'w');
    expect(s.selectedIds).toEqual(['big']);
    s = key(s, 'w');
    expect(s.selectedIds).toEqual(['last']);
  });

  it('steps off a frame in both directions (a frame has no hit-testable interior)', () => {
    const a = rect('a', GRID * 20, GRID * 20);
    const f = frame('f1', GRID * 20, GRID * 40);
    const c = rect('c', GRID * 20, GRID * 60);
    let s = type(vimState({ shapes: [a, f, c], connectors: [] }), 'ww');
    expect(s.selectedIds).toEqual(['f1']);
    // `shapeAt` returns nothing inside a frame, so `b` used to step back onto the frame itself.
    const back = key(s, 'b');
    expect(back.selectedIds).toEqual(['a']);
    expect(back.cursor).toEqual(labelCenterOf(a));
    s = key(s, 'w');
    expect(s.selectedIds).toEqual(['c']);
  });

  it('clamps an overshooting count to the last/first shape instead of refusing to move', () => {
    const fwd = type(vimState(doc), '9w');
    expect(fwd.selectedIds).toEqual(['s3']);
    expect(fwd.msg).toBe('');
    const back = type(fwd, '9b');
    expect(back.selectedIds).toEqual(['s1']);
    expect(back.msg).toBe('');
  });

  it('keeps two side-by-side shapes in one row wherever they sit on the canvas', () => {
    // Rows are derived from the shapes, not from fixed `round(y / SHAPE_ROW_H)` bands: these two
    // centers are 2px apart but straddle a band boundary, which used to visit `right` first.
    const left = rect('left', GRID * 20, GRID * 20 + 23);
    const right = rect('right', GRID * 40, GRID * 20 + 21);
    let s = key(vimState({ shapes: [right, left], connectors: [] }), 'w');
    expect(s.selectedIds).toEqual(['left']);
    s = key(s, 'w');
    expect(s.selectedIds).toEqual(['right']);
  });
});

describe('HINT mode: mouse input cancels', () => {
  it('a CLICK during HINT cancels hint mode and applies normal click semantics', () => {
    const s = rect('s1', GRID * 20, GRID * 20);
    const state = key(vimState({ shapes: [s], connectors: [] }), 'f');
    const clicked = reduce(state, { type: 'CLICK', p: { x: GRID * 22, y: GRID * 22 }, id: 's1' });
    expect(clicked.mode).toBe('normal');
    expect(clicked.hint).toBeNull();
    expect(clicked.selectedIds).toEqual(['s1']);
    expect(clicked.cursor).toEqual({ x: GRID * 22, y: GRID * 22 });
  });

  it('a DRAG_START during HINT cancels hint mode before the drag begins', () => {
    const s = rect('s1', GRID * 20, GRID * 20);
    const state = key(vimState({ shapes: [s], connectors: [] }), 'f');
    const dragged = reduce(state, { type: 'DRAG_START', id: 's1' });
    expect(dragged.mode).toBe('normal');
    expect(dragged.hint).toBeNull();
    expect(dragged.selectedIds).toEqual(['s1']);
    expect(dragged.base).not.toBeNull();
  });
});

describe('HINT mode: Esc and invalid keys', () => {
  it('Esc cancels HINT mode without changing selection or cursor', () => {
    const s = rect('s1', GRID * 20, GRID * 20);
    const before = vimState({ shapes: [s], connectors: [] });
    const state = key(before, 'f');
    const cancelled = key(state, 'Escape');
    expect(cancelled.mode).toBe('normal');
    expect(cancelled.hint).toBeNull();
    expect(cancelled.selectedIds).toEqual([]);
    expect(cancelled.cursor).toEqual(before.cursor);
  });

  it('a key matching no remaining hint prefix is ignored, staying in HINT mode', () => {
    const shapes = Array.from({ length: 26 }, (_, i) => rect(`s${i}`, i * GRID * 10, 0));
    const state = key(vimState({ shapes, connectors: [] }), 'f');
    // With 26 shapes every letter is a used single-letter label; a digit can never
    // match any label and must be ignored rather than crash or exit HINT mode.
    const afterDigit = key(state, '1');
    expect(afterDigit.mode).toBe('hint');
    expect(afterDigit.hint!.typed).toBe('');
    expect(afterDigit.hint!.entries).toEqual(state.hint!.entries);
  });

  it('a second key that no longer matches the narrowed prefix is ignored (stays narrowed)', () => {
    const shapes = Array.from({ length: 30 }, (_, i) => rect(`s${i}`, i * GRID * 10, 0));
    const state = key(vimState({ shapes, connectors: [] }), 'f');
    const twoLetter = state.hint!.entries.find((e) => e.label.length === 2)!;
    const prefixKey = twoLetter.label[0];
    const narrowed = key(state, prefixKey);
    // A digit still can't match any label extension.
    const ignored = key(narrowed, '2');
    expect(ignored.mode).toBe('hint');
    expect(ignored.hint!.typed).toBe(prefixKey);
  });
});

const withLabel = (id: string, x: number, y: number, label: string): Shape => ({ ...rect(id, x, y), label });
const arrow = (id: string, from: { x: number; y: number }, to: { x: number; y: number }, label = '') => ({
  id,
  from,
  to,
  label,
});

const open = (state: EditorState): EditorState => reduce(state, { type: 'SEARCH_OPEN' });
const setQuery = (state: EditorState, text: string): EditorState => reduce(state, { type: 'SEARCH_SET', text });
const confirm = (state: EditorState): EditorState => reduce(state, { type: 'SEARCH_CONFIRM' });
/** Types a query into a freshly opened search prompt and confirms it in one go. */
const search = (state: EditorState, query: string): EditorState => confirm(setQuery(open(state), query));

describe('search (/) mode: opening and typing', () => {
  it('SEARCH_OPEN enters search mode with an empty query', () => {
    const state = open(vimState({ shapes: [], connectors: [] }));
    expect(state.mode).toBe('search');
    expect(state.search).toBe('');
  });

  it('SEARCH_SET updates the typed query without touching the doc or matching yet', () => {
    const state = setQuery(open(vimState({ shapes: [], connectors: [] })), 'hello');
    expect(state.mode).toBe('search');
    expect(state.search).toBe('hello');
  });

  it('Esc (SEARCH_CLOSE) cancels the prompt, leaving cursor and selection untouched', () => {
    const s = withLabel('s1', GRID * 5, GRID * 5, 'target');
    const before = vimState({ shapes: [s], connectors: [] });
    const opened = setQuery(open(before), 'target');
    const cancelled = reduce(opened, { type: 'SEARCH_CLOSE' });
    expect(cancelled.mode).toBe('normal');
    expect(cancelled.search).toBe('');
    expect(cancelled.cursor).toEqual(before.cursor);
    expect(cancelled.selectedIds).toEqual([]);
    // Esc doesn't count as a confirmed search, so n/N still has nothing to repeat.
    expect(cancelled.lastSearch).toBeNull();
  });

  it('empty query + Enter is a no-op that just closes the prompt', () => {
    const s = withLabel('s1', GRID * 5, GRID * 5, 'target');
    const before = vimState({ shapes: [s], connectors: [] });
    const result = search(before, '');
    expect(result.mode).toBe('normal');
    expect(result.selectedIds).toEqual([]);
    expect(result.cursor).toEqual(before.cursor);
    expect(result.lastSearch).toBeNull();
  });
});

describe('search (/) mode: confirming a match', () => {
  it('jumps to and selects a shape whose label case-insensitively contains the query', () => {
    const s = withLabel('s1', GRID * 5, GRID * 5, 'Hello World');
    const state = search(vimState({ shapes: [s], connectors: [] }), 'hello');
    expect(state.mode).toBe('normal');
    expect(state.selectedIds).toEqual(['s1']);
    expect(state.cursor).toEqual(labelCenterOf(s));
    expect(state.lastSearch).toBe('hello');
  });

  it('matches a connector label and jumps to its label position', () => {
    const c = arrow('c1', { x: 0, y: 0 }, { x: GRID * 20, y: 0 }, 'connects here');
    const state = search(vimState({ shapes: [], connectors: [c] }), 'connects');
    expect(state.mode).toBe('normal');
    expect(state.selectedIds).toEqual(['c1']);
    // Straight connector with no shape endpoints: label position is the segment midpoint,
    // nudged above the line (connectorLabelPos's LABEL_GAP) and snapped to the grid.
    expect(state.cursor).toEqual({ x: GRID * 10, y: -GRID });
  });

  it('jumps to the nearest match by distance from the current cursor, not document order', () => {
    const cursor = initialState(null, true).cursor;
    const far = withLabel('far', cursor.x + GRID * 100, cursor.y, 'match');
    const near = withLabel('near', cursor.x + GRID * 2, cursor.y, 'match');
    const state = search(vimState({ shapes: [far, near], connectors: [] }), 'match');
    expect(state.selectedIds).toEqual(['near']);
  });

  it('expands the selection to the whole group, like a click or hint jump would', () => {
    const a = { ...withLabel('a', 0, 0, 'target'), groupId: 'g1' };
    const b = { ...rect('b', GRID * 10, 0), groupId: 'g1' };
    const state = search(vimState({ shapes: [a, b], connectors: [] }), 'target');
    expect(state.selectedIds).toEqual(['a', 'b']);
    expect(state.cursor).toEqual(labelCenterOf(a));
  });

  it('shows "no match: <query>" and stays put when nothing matches', () => {
    const s = withLabel('s1', GRID * 5, GRID * 5, 'apple');
    const before = vimState({ shapes: [s], connectors: [] });
    const state = search(before, 'banana');
    expect(state.mode).toBe('normal');
    expect(state.msg).toBe('no match: banana');
    expect(state.selectedIds).toEqual([]);
    expect(state.cursor).toEqual(before.cursor);
    // The failed query still becomes the "last search" for n/N.
    expect(state.lastSearch).toBe('banana');
  });
});

describe('n / N: repeat search', () => {
  it('n cycles forward through matches in document order (shapes then connectors), wrapping around', () => {
    // Cursor starts at the default (GRID*10, GRID*10); s1 sits right on top of it while
    // s2 and c1 are placed further away, in increasing distance order.
    const cursor = initialState(null, true).cursor;
    const s1 = withLabel('s1', cursor.x, cursor.y, 'foo-1');
    const s2 = withLabel('s2', cursor.x + GRID * 30, cursor.y, 'foo-2');
    const c1 = arrow(
      'c1',
      { x: cursor.x, y: cursor.y + GRID * 60 },
      { x: cursor.x + GRID * 10, y: cursor.y + GRID * 60 },
      'foo-3',
    );
    const state = search(vimState({ shapes: [s1, s2], connectors: [c1] }), 'foo');
    expect(state.selectedIds).toEqual(['s1']); // nearest to the default cursor

    const n1 = key(state, 'n');
    expect(n1.selectedIds).toEqual(['s2']);
    const n2 = key(n1, 'n');
    expect(n2.selectedIds).toEqual(['c1']);
    const n3 = key(n2, 'n'); // wraps back to the first match
    expect(n3.selectedIds).toEqual(['s1']);
  });

  it('n keeps cycling past grouped sibling matches instead of re-locking onto the group', () => {
    // a and b are grouped and both match, so every jump inside the group selects [a, b].
    // n must still advance a → b → c → a rather than re-finding the first selected match.
    const cursor = initialState(null, true).cursor;
    const a = { ...withLabel('a', cursor.x, cursor.y, 'foo-a'), groupId: 'g1' };
    const b = { ...withLabel('b', cursor.x + GRID * 30, cursor.y, 'foo-b'), groupId: 'g1' };
    const c = withLabel('c', cursor.x + GRID * 60, cursor.y, 'foo-c');
    const state = search(vimState({ shapes: [a, b, c], connectors: [] }), 'foo');
    expect(state.selectedIds).toEqual(['a', 'b']); // landed on a, group-expanded

    const n1 = key(state, 'n');
    expect(n1.selectedIds).toEqual(['a', 'b']); // landed on b, same group
    expect(n1.cursor).toEqual(labelCenterOf(b));
    const n2 = key(n1, 'n');
    expect(n2.selectedIds).toEqual(['c']);
    const n3 = key(n2, 'n'); // wraps back to a
    expect(n3.selectedIds).toEqual(['a', 'b']);
    expect(n3.cursor).toEqual(labelCenterOf(a));
  });

  it('N cycles backward, wrapping around to the last match', () => {
    const s1 = withLabel('s1', 0, 0, 'foo-1');
    const s2 = withLabel('s2', GRID * 30, 0, 'foo-2');
    const state = search(vimState({ shapes: [s1, s2], connectors: [] }), 'foo');
    expect(state.selectedIds).toEqual(['s1']);
    const p1 = key(state, 'N'); // wraps backward past the first match
    expect(p1.selectedIds).toEqual(['s2']);
    const p2 = key(p1, 'N');
    expect(p2.selectedIds).toEqual(['s1']);
  });

  it('re-evaluates against the current doc on every press, so a deleted match does not crash', () => {
    const s1 = withLabel('s1', 0, 0, 'foo-1');
    const s2 = withLabel('s2', GRID * 30, 0, 'foo-2');
    const state = search(vimState({ shapes: [s1, s2], connectors: [] }), 'foo');
    expect(state.selectedIds).toEqual(['s1']);
    // Delete the currently-selected match out from under the search.
    const doc = { shapes: [s2], connectors: [] };
    const afterDelete: EditorState = { ...state, doc, selectedIds: [] };
    const n1 = key(afterDelete, 'n');
    expect(n1.mode).toBe('normal');
    expect(n1.selectedIds).toEqual(['s2']);
  });

  it('shows a message and does nothing when there is no previous search', () => {
    const s = withLabel('s1', 0, 0, 'foo');
    const before = vimState({ shapes: [s], connectors: [] });
    const state = key(before, 'n');
    expect(state.selectedIds).toEqual([]);
    expect(state.msg).toBe('no previous search');
  });

  it('shows "no match" and leaves selection alone if the last search now matches nothing', () => {
    const s = withLabel('s1', 0, 0, 'foo');
    const state = search(vimState({ shapes: [s], connectors: [] }), 'foo');
    expect(state.selectedIds).toEqual(['s1']);
    const doc = { shapes: [{ ...s, label: 'bar' }], connectors: [] };
    const noMatch = key({ ...state, doc }, 'n');
    expect(noMatch.msg).toBe('no match: foo');
    expect(noMatch.selectedIds).toEqual(['s1']); // untouched
  });
});

describe('. (dot repeat)', () => {
  it('is a no-op with a message when there is no prior edit', () => {
    const before = vimState({ shapes: [], connectors: [] });
    const state = key(before, '.');
    expect(state.doc).toBe(before.doc);
    expect(state.msg).toBe('nothing to repeat');
  });

  it('repeats a draw commit: same kind/size, anchored at the new cursor', () => {
    let state = vimState({ shapes: [], connectors: [] });
    state = key(state, 'r'); // DRAW rect, default size
    state = key(state, 'Enter'); // commit
    expect(state.doc.shapes).toHaveLength(1);
    const first = state.doc.shapes[0];
    expect(first.kind).toBe('rect');

    state = key(state, 'l');
    state = key(state, 'l');
    state = key(state, 'j');
    const cursorAtRepeat = state.cursor;
    state = key(state, '.');

    expect(state.doc.shapes).toHaveLength(2);
    const second = state.doc.shapes.find((s) => s.id !== first.id)!;
    expect(second.kind).toBe('rect');
    expect(second.w).toBe(first.w);
    expect(second.h).toBe(first.h);
    expect(second.x).toBe(cursorAtRepeat.x);
    expect(second.y).toBe(cursorAtRepeat.y);
    expect(state.selectedIds).toEqual([second.id]);
  });

  it('repeats a resized draw commit with the adjusted size, not the default', () => {
    let state = vimState({ shapes: [], connectors: [] });
    state = key(state, 'e'); // DRAW ellipse
    state = key(state, 'l'); // widen
    state = key(state, 'j'); // taller
    state = key(state, 'Enter');
    const first = state.doc.shapes[0];
    state = key(state, '.');
    const second = state.doc.shapes.find((s) => s.id !== first.id)!;
    expect(second.kind).toBe('ellipse');
    expect(second.w).toBe(first.w);
    expect(second.h).toBe(first.h);
  });

  it('repeats a text creation: same text, at the new cursor', () => {
    let state = vimState({ shapes: [], connectors: [] });
    state = key(state, 't'); // start text insert
    state = reduce(state, { type: 'INSERT_COMMIT', label: 'hello' });
    expect(state.doc.shapes).toHaveLength(1);
    const first = state.doc.shapes[0];
    expect(first.label).toBe('hello');

    state = key(state, 'l');
    const cursorAtRepeat = state.cursor;
    state = key(state, '.');

    expect(state.doc.shapes).toHaveLength(2);
    const second = state.doc.shapes.find((s) => s.id !== first.id)!;
    expect(second.label).toBe('hello');
    expect(second.w).toBe(first.w);
    expect(second.h).toBe(first.h);
    expect(second.x).toBe(cursorAtRepeat.x);
    expect(second.y).toBe(cursorAtRepeat.y);
  });

  it('does not record editing an existing shape label as a repeatable text creation', () => {
    const s = rect('s1', GRID * 10, GRID * 10);
    let state = vimState({ shapes: [s], connectors: [] });
    state = key(state, 'i'); // edit existing shape's label
    state = reduce(state, { type: 'INSERT_COMMIT', label: 'renamed' });
    expect(state.lastEdit).toBeNull();
    const before = state;
    state = key(state, '.');
    expect(state.doc).toBe(before.doc);
    expect(state.msg).toBe('nothing to repeat');
  });

  it('repeats a delete: removes whatever is under the cursor now, not the original target', () => {
    const cursor = initialState(null, true).cursor;
    const s1 = rect('s1', cursor.x, cursor.y);
    const s2 = rect('s2', cursor.x, cursor.y); // stacked on the same spot
    let state = vimState({ shapes: [s1, s2], connectors: [] });
    state = key(state, 'd');
    expect(state.doc.shapes).toHaveLength(1);
    state = key(state, '.');
    expect(state.doc.shapes).toHaveLength(0);
  });

  it('delete-repeat is a no-op with a message once nothing remains under the cursor', () => {
    const cursor = initialState(null, true).cursor;
    const s1 = rect('s1', cursor.x, cursor.y);
    let state = vimState({ shapes: [s1], connectors: [] });
    state = key(state, 'd');
    expect(state.doc.shapes).toHaveLength(0);
    state = key(state, '.');
    expect(state.doc.shapes).toHaveLength(0);
    expect(state.msg).toBe('nothing under cursor');
  });

  it('repeats a paste: pastes the yanked clipboard again at the new cursor', () => {
    const cursor = initialState(null, true).cursor;
    const s1 = rect('s1', cursor.x, cursor.y);
    let state = vimState({ shapes: [s1], connectors: [] });
    state = key(state, 'y'); // yank the shape under the cursor
    state = key(state, 'l');
    state = key(state, 'l');
    state = key(state, 'p'); // paste once
    expect(state.doc.shapes).toHaveLength(2);

    state = key(state, 'j');
    const cursorAtRepeat = state.cursor;
    state = key(state, '.');

    expect(state.doc.shapes).toHaveLength(3);
    const pastedAgain = state.doc.shapes.find(
      (s) => s.x === cursorAtRepeat.x && s.y === cursorAtRepeat.y,
    );
    expect(pastedAgain).toBeDefined();
  });

  it('each . is its own undo step', () => {
    let state = vimState({ shapes: [], connectors: [] });
    state = key(state, 'r');
    state = key(state, 'Enter');
    state = key(state, '.');
    state = key(state, '.');
    expect(state.doc.shapes).toHaveLength(3);

    state = key(state, 'u');
    expect(state.doc.shapes).toHaveLength(2);
    state = key(state, 'u');
    expect(state.doc.shapes).toHaveLength(1);
    state = key(state, 'u');
    expect(state.doc.shapes).toHaveLength(0);
  });

  it('still repeats after an undo: lastEdit survives UNDO', () => {
    let state = vimState({ shapes: [], connectors: [] });
    state = key(state, 'r');
    state = key(state, 'Enter');
    expect(state.doc.shapes).toHaveLength(1);
    state = key(state, 'u');
    expect(state.doc.shapes).toHaveLength(0);
    expect(state.lastEdit).not.toBeNull();

    state = key(state, '.');
    expect(state.doc.shapes).toHaveLength(1);
  });

  it('ignores a count prefix and repeats exactly once', () => {
    let state = vimState({ shapes: [], connectors: [] });
    state = key(state, 'r');
    state = key(state, 'Enter');
    state = type(state, '3.');
    expect(state.doc.shapes).toHaveLength(2);
  });
});

describe('marks: m (set) and \' (jump)', () => {
  it('m enters a pending mark-set state without touching the doc/cursor', () => {
    const before = vimState({ shapes: [], connectors: [] });
    const state = key(before, 'm');
    expect(state.pending).toBe('mark-set');
    expect(state.mode).toBe('normal');
    expect(state.cursor).toEqual(before.cursor);
    expect(state.marks).toEqual({});
  });

  it('m then a letter records the current cursor under that letter and clears pending', () => {
    let state = vimState({ shapes: [], connectors: [] });
    const here = state.cursor;
    state = type(state, 'ma');
    expect(state.pending).toBeNull();
    expect(state.marks.a).toEqual(here);
    expect(state.msg).toBe('mark set: a');
  });

  it("' then a letter jumps the cursor back to the recorded mark", () => {
    let state = vimState({ shapes: [], connectors: [] });
    const markedAt = state.cursor;
    state = type(state, 'ma'); // mark a at the starting cursor
    state = key(state, 'l');
    state = key(state, 'l');
    state = key(state, 'j');
    expect(state.cursor).not.toEqual(markedAt); // moved away first

    state = type(state, "'a");
    expect(state.pending).toBeNull();
    expect(state.cursor).toEqual(markedAt);
    expect(state.msg).toBe('');
  });

  it("' to an unset mark reports 'mark not set' and leaves the cursor alone", () => {
    let state = vimState({ shapes: [], connectors: [] });
    const cursor = state.cursor;
    state = type(state, "'z");
    expect(state.pending).toBeNull();
    expect(state.cursor).toEqual(cursor);
    expect(state.msg).toBe('mark not set: z');
  });

  it('Esc cancels a pending mark-set without recording anything', () => {
    let state = vimState({ shapes: [], connectors: [] });
    state = key(state, 'm');
    expect(state.pending).toBe('mark-set');
    state = key(state, 'Escape');
    expect(state.pending).toBeNull();
    expect(state.marks).toEqual({});
  });

  it('Esc cancels a pending mark-jump the same way', () => {
    let state = vimState({ shapes: [], connectors: [] });
    state = type(state, 'ma'); // so a jump *could* succeed if not cancelled
    const cursor = state.cursor;
    state = key(state, "'");
    expect(state.pending).toBe('mark-jump');
    state = key(state, 'Escape');
    expect(state.pending).toBeNull();
    expect(state.cursor).toEqual(cursor);
  });

  it('a non-letter key silently cancels a pending mark-set (no message, nothing recorded)', () => {
    let state = vimState({ shapes: [], connectors: [] });
    state = key(state, 'm');
    state = key(state, '5'); // digit: not a-z
    expect(state.pending).toBeNull();
    expect(state.marks).toEqual({});
    expect(state.msg).toBe(''); // silent: no "cancelled"-style message
  });

  it('a non-letter key silently cancels a pending mark-jump', () => {
    let state = vimState({ shapes: [], connectors: [] });
    state = type(state, 'ma'); // mark a at the starting cursor
    state = key(state, 'l');
    state = key(state, 'j'); // move away from the mark
    const movedTo = state.cursor;
    state = key(state, "'");
    state = key(state, '.'); // punctuation-ish key, not a-z
    expect(state.pending).toBeNull();
    expect(state.cursor).toEqual(movedTo); // no jump happened; cursor stayed put
    expect(state.cursor).not.toEqual(state.marks.a);
  });

  it('an uppercase letter (Shift+letter) also cancels silently, not treated as a-z', () => {
    let state = vimState({ shapes: [], connectors: [] });
    state = key(state, 'm');
    state = reduce(state, { type: 'KEY', key: 'A', ctrl: false, shift: true });
    expect(state.pending).toBeNull();
    expect(state.marks).toEqual({});
  });

  it('marks survive deleting the shape that was under the cursor when set', () => {
    const s = rect('s1', GRID * 10, GRID * 10);
    let state = vimState({ shapes: [s], connectors: [] });
    state = { ...state, cursor: { x: GRID * 10, y: GRID * 10 } };
    state = type(state, 'ma'); // mark recorded at the shape's position
    const markedPos = state.marks.a;
    state = key(state, 'd'); // delete the shape under the cursor
    expect(state.doc.shapes).toHaveLength(0);
    state = key(state, 'l'); // move away
    state = type(state, "'a");
    expect(state.cursor).toEqual(markedPos); // jump still works, unaffected by the deletion
  });

  it('multiple marks are independent of each other', () => {
    let state = vimState({ shapes: [], connectors: [] });
    const posA = state.cursor;
    state = type(state, 'ma');
    state = key(state, 'l');
    state = key(state, 'l');
    const posB = state.cursor;
    state = type(state, 'mb');
    state = key(state, 'j');

    state = type(state, "'a");
    expect(state.cursor).toEqual(posA);
    state = type(state, "'b");
    expect(state.cursor).toEqual(posB);
  });

  it('m/\' sequences leave count/other pending state uncorrupted afterward', () => {
    let state = vimState({ shapes: [], connectors: [] });
    state = type(state, '3'); // count prefix in progress
    expect(state.count).toBe('3');
    state = key(state, 'm'); // m cancels/consumes the count, starts pending
    expect(state.count).toBe('');
    state = key(state, 'a'); // resolves mark-set
    expect(state.pending).toBeNull();
    expect(state.count).toBe('');

    // A plain, uncounted movement afterward should move by exactly one grid step,
    // proving the earlier '3' didn't leak into a later move.
    const before = state.cursor;
    state = key(state, 'l');
    expect(state.cursor.x - before.x).toBe(GRID);

    // Same check for the jump side: a stray count before ' must not survive into
    // the mark-jump resolution or beyond.
    state = type(state, '2');
    state = key(state, "'");
    expect(state.count).toBe('');
    state = key(state, 'a');
    expect(state.pending).toBeNull();
    expect(state.count).toBe('');
  });

  it('m then d sets mark "d" — the letter is consumed by the pending state, nothing is deleted', () => {
    const cursor = initialState(null, true).cursor;
    const s = rect('s1', cursor.x, cursor.y); // a shape under the cursor that d would normally delete
    let state = vimState({ shapes: [s], connectors: [] });
    const here = state.cursor;
    state = type(state, 'md');
    expect(state.pending).toBeNull();
    expect(state.marks.d).toEqual(here);
    expect(state.doc.shapes).toHaveLength(1); // NOT deleted
    expect(state.msg).toBe('mark set: d');
  });

  it("' then f jumps to mark f — the letter is consumed by the pending state, no HINT mode", () => {
    const cursor = initialState(null, true).cursor;
    const s = rect('s1', cursor.x, cursor.y); // a shape exists, so f *could* enter HINT mode
    let state = vimState({ shapes: [s], connectors: [] });
    const markedAt = state.cursor;
    state = type(state, 'mf'); // record mark f
    state = key(state, 'l');
    state = key(state, 'j');
    state = type(state, "'f");
    expect(state.mode).toBe('normal'); // NOT hint
    expect(state.hint).toBeNull();
    expect(state.pending).toBeNull();
    expect(state.cursor).toEqual(markedAt);
  });

  it('a mouse click cancels a pending mark-set, so a following d deletes instead of marking', () => {
    const cursor = initialState(null, true).cursor;
    const s = rect('s1', cursor.x, cursor.y);
    let state = vimState({ shapes: [s], connectors: [] });
    state = key(state, 'm');
    expect(state.pending).toBe('mark-set');
    state = reduce(state, { type: 'CLICK', p: state.cursor }); // click cancels the pending sequence
    expect(state.pending).toBeNull();
    state = key(state, 'd'); // ...so d acts normally again
    expect(state.doc.shapes).toHaveLength(0); // deleted, not recorded as mark "d"
    expect(state.marks.d).toBeUndefined();
  });

  it('other mouse-initiated actions also cancel a pending mark sequence', () => {
    let state = vimState({ shapes: [rect('s1', 0, 0)], connectors: [] });
    state = key(state, "'");
    expect(state.pending).toBe('mark-jump');
    state = reduce(state, { type: 'DRAG_START', id: 's1' });
    expect(state.pending).toBeNull();

    state = key(state, 'm');
    expect(state.pending).toBe('mark-set');
    state = reduce(state, { type: 'CONTEXT_MENU_OPEN', screen: { x: 0, y: 0 }, world: { x: 0, y: 0 } });
    expect(state.pending).toBeNull();
    expect(state.marks).toEqual({});
  });
});

describe('SET_FONT_SIZE', () => {
  const conn = (id: string): Connector => ({
    id,
    from: { x: 0, y: 0 },
    to: { x: 100, y: 100 },
    label: '',
  });

  it('sets fontSize on a single selected shape, storing "m" as undefined (the default)', () => {
    const s1 = rect('s1', 0, 0);
    let state = vimState({ shapes: [s1], connectors: [] });
    state = reduce(state, { type: 'SET_FONT_SIZE', ids: ['s1'], fontSize: 'l' });
    expect(state.doc.shapes[0].fontSize).toBe('l');
    state = reduce(state, { type: 'SET_FONT_SIZE', ids: ['s1'], fontSize: 'm' });
    expect(state.doc.shapes[0].fontSize).toBeUndefined();
  });

  it('applies to every id across shapes and connectors when multiple are targeted', () => {
    const s1 = rect('s1', 0, 0);
    const s2 = rect('s2', 100, 100);
    const c1 = conn('c1');
    let state = vimState({ shapes: [s1, s2], connectors: [c1] });
    state = reduce(state, { type: 'SET_FONT_SIZE', ids: ['s1', 's2', 'c1'], fontSize: 's' });
    expect(state.doc.shapes[0].fontSize).toBe('s');
    expect(state.doc.shapes[1].fontSize).toBe('s');
    expect(state.doc.connectors[0].fontSize).toBe('s');
  });

  it('is a no-op for an empty id list', () => {
    const state = vimState({ shapes: [rect('s1', 0, 0)], connectors: [] });
    const next = reduce(state, { type: 'SET_FONT_SIZE', ids: [], fontSize: 'l' });
    expect(next).toBe(state);
  });

  it('re-fits a text shape\'s box to the new size, mirroring how label edits resize it', () => {
    const text: Shape = { id: 't1', kind: 'text', x: 0, y: 0, w: 32, h: 32, label: 'hello world' };
    let state = vimState({ shapes: [text], connectors: [] });
    const mSize = state.doc.shapes[0];
    state = reduce(state, { type: 'SET_FONT_SIZE', ids: ['t1'], fontSize: 'l' });
    const lSize = state.doc.shapes[0];
    // 'l' renders bigger than 'm', so the re-fitted box must grow, not just tag fontSize.
    expect(lSize.w).toBeGreaterThan(mSize.w);
    expect(lSize.h).toBeGreaterThanOrEqual(mSize.h);
  });

  it('leaves a non-text shape\'s box untouched (user-controlled size)', () => {
    const s1 = rect('s1', 0, 0, 64, 64);
    let state = vimState({ shapes: [s1], connectors: [] });
    state = reduce(state, { type: 'SET_FONT_SIZE', ids: ['s1'], fontSize: 'l' });
    expect(state.doc.shapes[0]).toMatchObject({ w: 64, h: 64 });
  });

  it('undoes back to the prior fontSize as one step', () => {
    const s1 = rect('s1', 0, 0);
    let state = vimState({ shapes: [s1], connectors: [] });
    state = reduce(state, { type: 'SET_FONT_SIZE', ids: ['s1'], fontSize: 'l' });
    expect(state.doc.shapes[0].fontSize).toBe('l');
    state = reduce(state, { type: 'UNDO' });
    expect(state.doc.shapes[0].fontSize).toBeUndefined();
    state = reduce(state, { type: 'REDO' });
    expect(state.doc.shapes[0].fontSize).toBe('l');
  });
});

describe('INSERT_AUTOSIZE: a text shape keeps up with the text being typed into it', () => {
  /** Whether `label` stays inside `s` horizontally once wrapped to the room the shape gives it
   * — the containment a shape that never resizes gets from wrapping alone. */
  const holdsLabelWidth = (s: Shape, label: string): boolean => {
    const need = labelBox(wrapLabel(label, labelMaxWidth(s), s.fontSize).join('\n'), s.fontSize);
    return inscribedBox(s).w >= need.w;
  };

  /** Opens the text-edit overlay on `shapes[0]`. */
  const startEditing = (shapes: Shape[]): EditorState =>
    reduce(vimState({ shapes, connectors: [] }), { type: 'START_INSERT', id: shapes[0].id });

  /** Starts editing `shapes[0]`'s label and types `label` into the overlay. */
  const typeInto = (shapes: Shape[], label: string): EditorState =>
    reduce(startEditing(shapes), { type: 'INSERT_AUTOSIZE', label });

  it('never resizes a container: a long label wraps inside the box it already has', () => {
    const label = 'wrap this label instead of stretching the box';
    for (const kind of ['rect', 'ellipse', 'diamond', 'triangle'] as const) {
      const s: Shape = { id: 's1', kind, x: GRID * 10, y: GRID * 10, w: GRID * 16, h: GRID * 4, label: '' };
      const typed = typeInto([s], label).doc.shapes[0];
      expect(typed).toMatchObject({ x: s.x, y: s.y, w: s.w, h: s.h });
      expect(holdsLabelWidth(typed, label)).toBe(true);
    }
  });

  it('leaves a container alone however small it is, and whatever is typed into it', () => {
    const s = rect('s1', 0, 0, GRID * 2, GRID * 2);
    const state = startEditing([s]);
    for (const label of ['x', 'hello world', 'hello world, and a good deal more text after it', 'a\nb\nc\nd']) {
      expect(reduce(state, { type: 'INSERT_AUTOSIZE', label })).toBe(state);
    }
  });

  it('leaves kinds whose box is not a text container alone (frame, image)', () => {
    const f = frame('f1', 0, 0, GRID * 4, GRID * 4);
    const img: Shape = { id: 'i1', kind: 'image', x: 0, y: 0, w: GRID * 4, h: GRID * 4, label: '' };
    expect(typeInto([f], 'a very long frame title').doc.shapes[0]).toMatchObject({ w: f.w, h: f.h });
    expect(typeInto([img], 'a very long caption').doc.shapes[0]).toMatchObject({ w: img.w, h: img.h });
  });

  it('gives growth back when the text shrinks again, down to the size the edit started at', () => {
    const t: Shape = { id: 't1', kind: 'text', x: 0, y: 0, w: GRID * 8, h: GRID * 2, label: '' };
    let state = startEditing([t]);
    state = reduce(state, { type: 'INSERT_AUTOSIZE', label: 'hello world hello world' });
    const long = state.doc.shapes[0].w;
    expect(long).toBeGreaterThan(t.w);
    // Deleting back down gives the extra width back...
    state = reduce(state, { type: 'INSERT_AUTOSIZE', label: 'hello world' });
    const shorter = state.doc.shapes[0].w;
    expect(shorter).toBeLessThan(long);
    expect(shorter).toBeGreaterThan(t.w);
    // ...but never past where the box started, on the last keystroke or on the commit.
    state = reduce(state, { type: 'INSERT_AUTOSIZE', label: 'a' });
    expect(state.doc.shapes[0].w).toBe(t.w);
    state = reduce(state, { type: 'INSERT_COMMIT', label: 'a' });
    expect(state.doc.shapes[0].w).toBe(t.w);
  });

  it('never shrinks a fresh text shape below the box it was created with', () => {
    // `t` on empty canvas makes a roomy box to start typing into; the first character used to
    // snap it down to one character wide the moment it was typed.
    let state = key(vimState({ shapes: [], connectors: [] }), 't');
    const created = state.doc.shapes[0];
    state = reduce(state, { type: 'INSERT_AUTOSIZE', label: 'a' });
    expect(state.doc.shapes[0]).toMatchObject({ w: created.w, h: created.h });
    state = reduce(state, { type: 'INSERT_COMMIT', label: 'a' });
    expect(state.doc.shapes[0]).toMatchObject({ w: created.w, h: created.h });
  });

  it('does the same for the sidebar label field, floored at the size the session started at', () => {
    const t: Shape = { id: 't1', kind: 'text', x: 0, y: 0, w: GRID * 4, h: GRID * 2, label: '' };
    let state = vimState({ shapes: [t], connectors: [] });
    state = reduce(state, { type: 'SET_LABEL', id: 't1', label: 'hello world' });
    expect(state.doc.shapes[0].w).toBeGreaterThan(t.w);
    state = reduce(state, { type: 'SET_LABEL', id: 't1', label: 'hi' });
    expect(state.doc.shapes[0].w).toBe(t.w);
    state = reduce(state, { type: 'COMMIT_LABEL', id: 't1' });
    expect(state.doc.shapes[0].w).toBe(t.w);
  });

  it('is ignored outside insert mode', () => {
    const state = vimState({ shapes: [rect('s1', 0, 0)], connectors: [] });
    expect(reduce(state, { type: 'INSERT_AUTOSIZE', label: 'hello world' })).toBe(state);
  });

  it('folds the growth and the label into one undo step', () => {
    const t: Shape = { id: 't1', kind: 'text', x: 0, y: 0, w: GRID * 4, h: GRID * 2, label: '' };
    let state = startEditing([t]);
    state = reduce(state, { type: 'INSERT_AUTOSIZE', label: 'hello world' });
    state = reduce(state, { type: 'INSERT_COMMIT', label: 'hello world' });
    expect(state.doc.shapes[0].w).toBeGreaterThan(t.w);
    state = reduce(state, { type: 'UNDO' });
    expect(state.doc.shapes[0]).toMatchObject({ x: t.x, y: t.y, w: t.w, h: t.h, label: '' });
  });

  it('fits the box on commit too, for a label that never went through the overlay', () => {
    const t: Shape = { id: 't1', kind: 'text', x: 0, y: 0, w: GRID * 4, h: GRID * 2, label: '' };
    let state = startEditing([t]);
    state = reduce(state, { type: 'INSERT_COMMIT', label: 'hello world' });
    expect(state.doc.shapes[0].w).toBeGreaterThan(t.w);
  });
});

describe('Frame: creation via o', () => {
  it('o enters DRAW mode with kind "frame"; Enter places a frame shape', () => {
    let state = vimState({ shapes: [], connectors: [] });
    state = key(state, 'o');
    expect(state.mode).toBe('draw');
    expect(state.draw?.kind).toBe('frame');
    state = key(state, 'Enter');
    expect(state.mode).toBe('normal');
    expect(state.doc.shapes).toHaveLength(1);
    expect(state.doc.shapes[0].kind).toBe('frame');
  });
});

describe('Triangle: creation via g', () => {
  it('g enters DRAW mode with kind "triangle"; Enter places a triangle shape', () => {
    let state = vimState({ shapes: [], connectors: [] });
    state = key(state, 'g');
    expect(state.mode).toBe('draw');
    expect(state.draw?.kind).toBe('triangle');
    state = key(state, 'Enter');
    expect(state.mode).toBe('normal');
    expect(state.doc.shapes).toHaveLength(1);
    expect(state.doc.shapes[0].kind).toBe('triangle');
  });
});

describe('Frame: containment on move', () => {
  const frame = (id: string, x: number, y: number, w: number, h: number): Shape => ({
    id,
    kind: 'frame',
    x,
    y,
    w,
    h,
    label: '',
  });

  it('DRAG_MOVE (mouse path) carries along a shape whose center was inside the frame at drag start', () => {
    const f = frame('f1', 0, 0, GRID * 10, GRID * 10);
    const inner = rect('in', GRID * 2, GRID * 2, GRID * 2, GRID * 2); // center well inside f1
    let state = vimState({ shapes: [f, inner], connectors: [] });
    state = reduce(state, { type: 'DRAG_START', id: 'f1' });
    state = reduce(state, { type: 'DRAG_MOVE', id: 'f1', to: { x: GRID * 5, y: GRID * 5 } });
    const movedFrame = state.doc.shapes.find((s) => s.id === 'f1')!;
    const movedInner = state.doc.shapes.find((s) => s.id === 'in')!;
    expect(movedFrame).toMatchObject({ x: GRID * 5, y: GRID * 5 });
    // moved by the same delta (GRID*5) as the frame
    expect(movedInner).toMatchObject({ x: GRID * 2 + GRID * 5, y: GRID * 2 + GRID * 5 });
    state = reduce(state, { type: 'DRAG_END' });
    expect(state.undo).toHaveLength(1); // the whole drag gesture is a single undo step
  });

  it('DRAG_MOVE does not move a shape whose center is outside the frame', () => {
    const f = frame('f1', 0, 0, GRID * 4, GRID * 4);
    const outside = rect('out', GRID * 20, GRID * 20, GRID * 2, GRID * 2);
    let state = vimState({ shapes: [f, outside], connectors: [] });
    state = reduce(state, { type: 'DRAG_START', id: 'f1' });
    state = reduce(state, { type: 'DRAG_MOVE', id: 'f1', to: { x: GRID * 5, y: GRID * 5 } });
    const untouched = state.doc.shapes.find((s) => s.id === 'out')!;
    expect(untouched).toMatchObject({ x: GRID * 20, y: GRID * 20 });
  });

  it('keyboard MOVE mode (v + hjkl) carries along contained shapes on every step', () => {
    const f = frame('f1', 0, 0, GRID * 10, GRID * 10);
    const inner = rect('in', GRID * 2, GRID * 2, GRID * 2, GRID * 2);
    let state = vimState({ shapes: [f, inner], connectors: [] });
    state = { ...state, selectedIds: ['f1'] };
    state = key(state, 'v');
    expect(state.mode).toBe('move');
    state = key(state, 'l');
    let movedFrame = state.doc.shapes.find((s) => s.id === 'f1')!;
    let movedInner = state.doc.shapes.find((s) => s.id === 'in')!;
    expect(movedFrame.x).toBe(GRID);
    expect(movedInner.x).toBe(GRID * 2 + GRID);
    // a second step keeps carrying the same contents (membership stays fixed for the gesture)
    state = key(state, 'l');
    movedFrame = state.doc.shapes.find((s) => s.id === 'f1')!;
    movedInner = state.doc.shapes.find((s) => s.id === 'in')!;
    expect(movedFrame.x).toBe(GRID * 2);
    expect(movedInner.x).toBe(GRID * 2 + GRID * 2);
    state = key(state, 'Enter');
    expect(state.mode).toBe('normal');
  });

  it('plain (vim-off) arrow-key nudge carries along contained shapes', () => {
    const f = frame('f1', 0, 0, GRID * 10, GRID * 10);
    const inner = rect('in', GRID * 2, GRID * 2, GRID * 2, GRID * 2);
    let state = initialState({ shapes: [f, inner], connectors: [] }, false);
    state = { ...state, selectedIds: ['f1'] };
    state = reduce(state, { type: 'KEY', key: 'ArrowRight', ctrl: false });
    const movedFrame = state.doc.shapes.find((s) => s.id === 'f1')!;
    const movedInner = state.doc.shapes.find((s) => s.id === 'in')!;
    expect(movedFrame.x).toBe(GRID);
    expect(movedInner.x).toBe(GRID * 2 + GRID);
  });

  it('nested frames compose: moving the outer frame carries the inner frame and the inner frame\'s own contents', () => {
    const outer = frame('outer', 0, 0, GRID * 20, GRID * 20);
    const inner = frame('inner', GRID * 2, GRID * 2, GRID * 6, GRID * 6); // center inside outer
    const leaf = rect('leaf', GRID * 3, GRID * 3, GRID * 2, GRID * 2); // center inside inner (and outer)
    let state = vimState({ shapes: [outer, inner, leaf], connectors: [] });
    state = reduce(state, { type: 'DRAG_START', id: 'outer' });
    state = reduce(state, { type: 'DRAG_MOVE', id: 'outer', to: { x: GRID * 10, y: GRID * 10 } });
    const dx = GRID * 10;
    const at = (id: string) => state.doc.shapes.find((s) => s.id === id)!;
    expect(at('outer')).toMatchObject({ x: dx, y: dx });
    expect(at('inner')).toMatchObject({ x: GRID * 2 + dx, y: GRID * 2 + dx });
    expect(at('leaf')).toMatchObject({ x: GRID * 3 + dx, y: GRID * 3 + dx });
  });

  it('a frame with nothing inside moves by itself without error', () => {
    const f = frame('f1', 0, 0, GRID * 4, GRID * 4);
    let state = vimState({ shapes: [f], connectors: [] });
    state = reduce(state, { type: 'DRAG_START', id: 'f1' });
    state = reduce(state, { type: 'DRAG_MOVE', id: 'f1', to: { x: GRID * 3, y: GRID * 3 } });
    expect(state.doc.shapes[0]).toMatchObject({ x: GRID * 3, y: GRID * 3 });
  });
});

describe('Frame: delete leaves contents', () => {
  it('deleting a frame removes only the frame, never the shapes inside it', () => {
    const f: Shape = { id: 'f1', kind: 'frame', x: 0, y: 0, w: GRID * 10, h: GRID * 10, label: '' };
    const inner = rect('in', GRID * 2, GRID * 2, GRID * 2, GRID * 2);
    let state = vimState({ shapes: [f, inner], connectors: [] });
    state = reduce(state, { type: 'DELETE_IDS', ids: ['f1'] });
    expect(state.doc.shapes.map((s) => s.id)).toEqual(['in']);
  });
});

describe('Frame: SET_SHAPE_KIND conversion', () => {
  it('converting a flat-filled shape to frame keeps `filled` (frame interiors may now show a tint)', () => {
    const s: Shape = { ...rect('s1', 0, 0), filled: true };
    let state = vimState({ shapes: [s], connectors: [] });
    state = reduce(state, { type: 'SET_SHAPE_KIND', ids: ['s1'], kind: 'frame' });
    expect(state.doc.shapes[0].kind).toBe('frame');
    expect(state.doc.shapes[0].filled).toBe(true);
  });

  it('converting to a non-frame kind keeps `filled` as-is', () => {
    const s: Shape = { ...rect('s1', 0, 0), filled: true };
    let state = vimState({ shapes: [s], connectors: [] });
    state = reduce(state, { type: 'SET_SHAPE_KIND', ids: ['s1'], kind: 'ellipse' });
    expect(state.doc.shapes[0].kind).toBe('ellipse');
    expect(state.doc.shapes[0].filled).toBe(true);
  });
});

describe('Frame: SET_FILLED', () => {
  it('sets `filled` on a frame (tint is purely visual, never affects hit-testing)', () => {
    const f: Shape = { id: 'f1', kind: 'frame', x: 0, y: 0, w: GRID * 10, h: GRID * 10, label: '' };
    let state = vimState({ shapes: [f], connectors: [] });
    state = reduce(state, { type: 'SET_FILLED', ids: ['f1'], filled: true });
    expect(state.doc.shapes[0].filled).toBe(true);
  });
});

describe('DISTRIBUTE', () => {
  it('distributes 3+ selected shapes along the axis as one undo step', () => {
    const a = rect('a', 0, 0, 10, 10);
    const b = rect('b', 30, 0, 10, 10);
    const c = rect('c', 100, 0, 10, 10);
    let state = vimState({ shapes: [a, b, c], connectors: [] });
    state = reduce(state, { type: 'DISTRIBUTE', ids: ['a', 'b', 'c'], axis: 'h' });
    expect(state.doc.shapes.find((s) => s.id === 'a')).toMatchObject({ x: 0 });
    expect(state.doc.shapes.find((s) => s.id === 'b')).toMatchObject({ x: 50 });
    expect(state.doc.shapes.find((s) => s.id === 'c')).toMatchObject({ x: 100 });

    state = reduce(state, { type: 'UNDO' });
    expect(state.doc.shapes.find((s) => s.id === 'b')).toMatchObject({ x: 30 });

    state = reduce(state, { type: 'REDO' });
    expect(state.doc.shapes.find((s) => s.id === 'b')).toMatchObject({ x: 50 });
  });

  it('shows a status message and no-ops when fewer than 3 shapes are selected', () => {
    const a = rect('a', 0, 0, 10, 10);
    const b = rect('b', 30, 0, 10, 10);
    const state = vimState({ shapes: [a, b], connectors: [] });
    const next = reduce(state, { type: 'DISTRIBUTE', ids: ['a', 'b'], axis: 'h' });
    expect(next.msg).toBe('select 3+ items to distribute');
    expect(next.doc).toEqual(state.doc);
  });
});

describe('pen tool: SKETCH_END keeps the stroke as a freedraw shape', () => {
  /** Fresh state with the pen tool active and a stroke fed through SKETCH_START/POINT. */
  function penStroke(pts: Array<{ x: number; y: number }>): EditorState {
    let state = reduce(initialState(null, false), { type: 'SET_TOOL', tool: 'pen' });
    state = reduce(state, { type: 'SKETCH_START', p: pts[0] });
    for (const p of pts.slice(1)) state = reduce(state, { type: 'SKETCH_POINT', p });
    return reduce(state, { type: 'SKETCH_END' });
  }

  it('creates a selected freedraw shape with quantized points and no text edit', () => {
    const state = penStroke([
      { x: 0, y: 0 },
      { x: 50, y: 40 },
      { x: 100, y: 0 },
    ]);
    expect(state.doc.shapes).toHaveLength(1);
    const s = state.doc.shapes[0];
    expect(s.kind).toBe('freedraw');
    expect(s).toMatchObject({ x: 0, y: 0, w: 100, h: 40 });
    expect(s.points!.length).toBeGreaterThanOrEqual(6);
    expect(state.selectedIds).toEqual([s.id]);
    expect(state.mode).not.toBe('insert'); // unlike the sketch tool, no label edit
    expect(state.sketch).toBeNull();
  });

  it('is undoable as a single edit', () => {
    let state = penStroke([
      { x: 0, y: 0 },
      { x: 50, y: 40 },
      { x: 100, y: 0 },
    ]);
    expect(state.doc.shapes).toHaveLength(1);
    state = reduce(state, { type: 'UNDO' });
    expect(state.doc.shapes).toHaveLength(0);
    state = reduce(state, { type: 'REDO' });
    expect(state.doc.shapes).toHaveLength(1);
  });

  it('discards a stroke too small to keep', () => {
    const state = penStroke([
      { x: 0, y: 0 },
      { x: 3, y: 2 },
    ]);
    expect(state.doc.shapes).toHaveLength(0);
    expect(state.sketch).toBeNull();
  });

  it('leaves the sketch tool behavior unchanged (still classifies)', () => {
    let state = initialState(null, false); // default tool: sketch
    state = reduce(state, { type: 'SKETCH_START', p: { x: 0, y: 0 } });
    const pts = [];
    for (let i = 0; i <= 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      pts.push({ x: 50 + 40 * Math.cos(a), y: 50 + 40 * Math.sin(a) });
    }
    for (const p of pts) state = reduce(state, { type: 'SKETCH_POINT', p });
    state = reduce(state, { type: 'SKETCH_END' });
    expect(state.doc.shapes).toHaveLength(1);
    expect(state.doc.shapes[0].kind).toBe('ellipse');
  });
});

describe('INSERT_TEMPLATE', () => {
  it('stamps a line-and-shape template as one new group, selected, centered on the cursor', () => {
    const state = initialState(null, false);
    const next = reduce(state, { type: 'INSERT_TEMPLATE', templateId: 'people-1' });
    expect(next.doc.shapes.length).toBeGreaterThan(0);
    expect(next.doc.connectors.length).toBeGreaterThan(0); // limbs are plain (line-art) connectors
    for (const c of next.doc.connectors) expect(c.arrowDirection).toBe('none'); // strokes, not arrows
    // every inserted shape/connector shares one fresh groupId, distinct from the template's own placeholder
    const gids = new Set([...next.doc.shapes.map((s) => s.groupId), ...next.doc.connectors.map((c) => c.groupId)]);
    expect(gids.size).toBe(1);
    expect([...gids][0]).not.toBe('g');
    // selection is exactly the inserted shapes + connectors
    const insertedIds = [...next.doc.shapes.map((s) => s.id), ...next.doc.connectors.map((c) => c.id)];
    expect(new Set(next.selectedIds)).toEqual(new Set(insertedIds));
    // roughly centered on the cursor (bbox center within a shape or two of it)
    const xs = [
      ...next.doc.shapes.flatMap((s) => [s.x, s.x + s.w]),
      ...next.doc.connectors.flatMap((c) => [c.from.x, c.to.x]),
    ];
    const ys = [
      ...next.doc.shapes.flatMap((s) => [s.y, s.y + s.h]),
      ...next.doc.connectors.flatMap((c) => [c.from.y, c.to.y]),
    ];
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    expect(Math.abs(cx - state.cursor.x)).toBeLessThan(1);
    expect(Math.abs(cy - state.cursor.y)).toBeLessThan(1);
  });

  it('is undoable as a single edit', () => {
    let state = initialState(null, false);
    state = reduce(state, { type: 'INSERT_TEMPLATE', templateId: 'people-1' });
    expect(state.doc.shapes.length).toBeGreaterThan(0);
    state = reduce(state, { type: 'UNDO' });
    expect(state.doc.shapes).toHaveLength(0);
    state = reduce(state, { type: 'REDO' });
    expect(state.doc.shapes.length).toBeGreaterThan(0);
  });

  it('inserting the same template twice produces two independently-grouped copies', () => {
    let state = initialState(null, false);
    state = reduce(state, { type: 'INSERT_TEMPLATE', templateId: 'nature-2' });
    const firstIds = new Set(state.doc.shapes.map((s) => s.id));
    state = reduce(state, { type: 'INSERT_TEMPLATE', templateId: 'nature-2' });
    const gids = new Set(state.doc.shapes.map((s) => s.groupId));
    expect(gids.size).toBe(2);
    // no id collisions between the two insertions
    const secondIds = state.doc.shapes.filter((s) => !firstIds.has(s.id));
    expect(secondIds.length).toBe(state.doc.shapes.length - firstIds.size);
  });

  it('centers on an explicit `at` point (drag-and-drop drop location) instead of the cursor', () => {
    const state = initialState(null, false);
    const dropPoint = { x: state.cursor.x + GRID * 25, y: state.cursor.y - GRID * 20 };
    const next = reduce(state, { type: 'INSERT_TEMPLATE', templateId: 'nature-2', at: dropPoint });
    const xs = next.doc.shapes.flatMap((s) => [s.x, s.x + s.w]);
    const ys = next.doc.shapes.flatMap((s) => [s.y, s.y + s.h]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    expect(Math.abs(cx - dropPoint.x)).toBeLessThan(1);
    expect(Math.abs(cy - dropPoint.y)).toBeLessThan(1);
  });

  it('is a no-op for an unknown template id', () => {
    const state = initialState(null, false);
    const next = reduce(state, { type: 'INSERT_TEMPLATE', templateId: 'does-not-exist' });
    expect(next).toBe(state);
  });
});

describe('tool shortcuts (vim off)', () => {
  const press = (state: ReturnType<typeof initialState>, key: string) =>
    reduce(state, { type: 'KEY', key, ctrl: false });

  it('picks a tool by its letter and by its digit', () => {
    let st = initialState(null, false);
    expect(st.tool).toBe('sketch');
    expect(press(st, 'r').tool).toBe('rect');
    expect(press(st, '4').tool).toBe('rect');
    expect(press(st, 'v').tool).toBe('select');
    expect(press(st, '0').tool).toBe('text');
    st = press(st, 'o');
    expect(st.tool).toBe('frame');
  });

  it('covers every tool, so no toolbar button is unreachable by key', () => {
    const st = initialState(null, false);
    for (const [tool, keys] of Object.entries(TOOL_KEYS)) {
      for (const key of keys) expect(press(st, key).tool).toBe(tool);
    }
  });

  it('leaves the arrow-key nudge alone', () => {
    const doc: Doc = {
      shapes: [{ id: 's1', kind: 'rect', x: 100, y: 100, w: 40, h: 40, label: '' }],
      connectors: [],
    };
    let st = { ...initialState(doc, false), selectedIds: ['s1'] };
    st = press(st, 'l');
    expect(st.tool).toBe('sketch'); // 'l' is a nudge, not a tool key
    expect(st.doc.shapes[0].x).toBeGreaterThan(100);
  });

  it('does not hijack the keys in vim mode, where they are the modal commands', () => {
    const st = initialState(null, true);
    const drawing = press(st, 'r');
    expect(drawing.tool).toBe('sketch'); // unchanged
    expect(drawing.mode).toBe('draw'); // vim's draw command still runs
  });
});

describe('connectTarget: the shape a gesture in flight would attach to', () => {
  const twoShapes: Doc = {
    shapes: [
      { id: 's1', kind: 'rect', x: 100, y: 100, w: 120, h: 80, label: '' },
      { id: 's2', kind: 'rect', x: 400, y: 100, w: 120, h: 80, label: '' },
    ],
    connectors: [],
  };

  it('tracks the shape under the cursor while an arrow is dragged, and matches what gets connected', () => {
    let st = initialState(twoShapes, false);
    st = reduce(st, { type: 'START_ARROW_AT', p: { x: 160, y: 140 }, shapeId: 's1' });
    st = reduce(st, { type: 'MOUSE_CURSOR', p: { x: 300, y: 140 } }); // empty canvas between them
    expect(st.connectTarget).toBe(null);
    st = reduce(st, { type: 'MOUSE_CURSOR', p: { x: 460, y: 140 } }); // over s2
    expect(st.connectTarget).toBe('s2');
    // The ring promised s2; the commit must deliver s2.
    st = reduce(st, { type: 'CLICK', p: { x: 460, y: 140 }, id: 's2' });
    expect(st.doc.connectors[0].to.shapeId).toBe('s2');
    expect(st.connectTarget).toBe(null);
  });

  it('points back at the arrow\'s own source when the cursor returns to it (a self-loop)', () => {
    let st = initialState(twoShapes, false);
    st = reduce(st, { type: 'START_ARROW_AT', p: { x: 160, y: 140 }, shapeId: 's1' });
    st = reduce(st, { type: 'MOUSE_CURSOR', p: { x: 300, y: 140 } });
    st = reduce(st, { type: 'MOUSE_CURSOR', p: { x: 210, y: 170 } });
    expect(st.connectTarget).toBe('s1');
  });

  it('follows a dragged endpoint on and off a shape, and clears when the drag ends', () => {
    const doc: Doc = {
      ...twoShapes,
      connectors: [{ id: 'c1', from: { shapeId: 's1', x: 160, y: 140 }, to: { x: 300, y: 300 }, label: '' }],
    };
    let st = initialState(doc, false);
    st = reduce(st, { type: 'ENDPOINT_DRAG_START', id: 'c1', end: 'to' });
    expect(st.connectTarget).toBe(null);
    st = reduce(st, { type: 'ENDPOINT_DRAG_MOVE', id: 'c1', end: 'to', p: { x: 460, y: 140 } });
    expect(st.connectTarget).toBe('s2');
    st = reduce(st, { type: 'ENDPOINT_DRAG_MOVE', id: 'c1', end: 'to', p: { x: 300, y: 300 } });
    expect(st.connectTarget).toBe(null);
    st = reduce(st, { type: 'ENDPOINT_DRAG_MOVE', id: 'c1', end: 'to', p: { x: 460, y: 140 } });
    st = reduce(st, { type: 'DRAG_END' });
    expect(st.connectTarget).toBe(null);
  });

  it('connects to the shape the ring promised when the cursor sits just off its edge', () => {
    // s2's left edge is deliberately off-grid: a cursor one pixel outside it snaps to a grid
    // point *inside* the shape. The ring is drawn from the snapped cursor, so committing from
    // the raw click point used to hand back a free endpoint while the ring said 's2'.
    const offGrid: Doc = {
      shapes: [
        { id: 's1', kind: 'rect', x: 100, y: 100, w: 120, h: 80, label: '' },
        { id: 's2', kind: 'rect', x: 410, y: 100, w: 120, h: 80, label: '' },
      ],
      connectors: [],
    };
    const p = { x: 409, y: 140 };
    expect(shapeAt(offGrid, p)).toBeUndefined();
    expect(shapeAt(offGrid, snapPt(p))?.id).toBe('s2');
    let st = initialState(offGrid, false);
    st = reduce(st, { type: 'START_ARROW_AT', p: { x: 160, y: 140 }, shapeId: 's1' });
    st = reduce(st, { type: 'MOUSE_CURSOR', p });
    expect(st.connectTarget).toBe('s2');
    st = reduce(st, { type: 'CLICK', p });
    expect(st.doc.connectors[0].to.shapeId).toBe('s2');
  });

  it('is cleared when the gesture is cancelled', () => {
    let st = initialState(twoShapes, true);
    st = reduce(st, { type: 'START_ARROW_AT', p: { x: 160, y: 140 }, shapeId: 's1' });
    st = reduce(st, { type: 'MOUSE_CURSOR', p: { x: 460, y: 140 } });
    expect(st.connectTarget).toBe('s2');
    st = reduce(st, { type: 'CANCEL' });
    expect(st.connectTarget).toBe(null);
  });
});

describe('self-loop arrows', () => {
  const twoShapes: Doc = {
    shapes: [
      { id: 's1', kind: 'rect', x: 100, y: 100, w: 120, h: 80, label: '' },
      { id: 's2', kind: 'rect', x: 400, y: 100, w: 120, h: 80, label: '' },
    ],
    connectors: [],
  };
  const norm = (v: number | undefined) => v !== undefined && v >= 0 && v <= 1;

  it('creates a self-loop when an arrow starts and ends on the same shape, with normalized anchors', () => {
    let st = initialState(twoShapes, true);
    st = reduce(st, { type: 'START_ARROW_AT', p: { x: 160, y: 90 }, shapeId: 's1' }); // start near top
    st = reduce(st, { type: 'CLICK', p: { x: 215, y: 140 }, id: 's1' }); // release near right edge
    const c = st.doc.connectors[0];
    expect(c.from.shapeId).toBe('s1');
    expect(c.to.shapeId).toBe('s1');
    // Both feet are stored as bbox-normalized anchors (0..1), not absolute centres.
    expect(norm(c.from.x) && norm(c.from.y) && norm(c.to.x) && norm(c.to.y)).toBe(true);
  });

  it('slides a self-loop foot along the border when its endpoint handle is dragged, staying a self-loop', () => {
    const doc: Doc = {
      ...twoShapes,
      connectors: [{ id: 'c1', from: { shapeId: 's1', x: 0.5, y: 0 }, to: { shapeId: 's1', x: 1, y: 0.5 }, label: '' }],
    };
    let st = initialState(doc, true);
    st = reduce(st, { type: 'ENDPOINT_DRAG_START', id: 'c1', end: 'to' });
    st = reduce(st, { type: 'ENDPOINT_DRAG_MOVE', id: 'c1', end: 'to', p: { x: 160, y: 175 } }); // toward bottom
    const c = st.doc.connectors[0];
    expect(c.from.shapeId).toBe('s1');
    expect(c.to.shapeId).toBe('s1');
    expect(c.to.y).toBeCloseTo(1, 5); // snapped to the bottom edge
    expect(norm(c.to.x) && norm(c.to.y)).toBe(true);
  });

  it('turns a normal arrow into a self-loop when an end is dragged onto the other end\'s shape', () => {
    const doc: Doc = {
      ...twoShapes,
      connectors: [{ id: 'c1', from: { shapeId: 's1', x: 160, y: 140 }, to: { shapeId: 's2', x: 460, y: 140 }, label: '' }],
    };
    let st = initialState(doc, true);
    st = reduce(st, { type: 'ENDPOINT_DRAG_START', id: 'c1', end: 'to' });
    st = reduce(st, { type: 'ENDPOINT_DRAG_MOVE', id: 'c1', end: 'to', p: { x: 210, y: 140 } }); // onto s1
    const c = st.doc.connectors[0];
    expect(c.from.shapeId).toBe('s1');
    expect(c.to.shapeId).toBe('s1');
    // The previously centre-bound `from` end is re-normalized so both ends agree.
    expect(norm(c.from.x) && norm(c.from.y) && norm(c.to.x) && norm(c.to.y)).toBe(true);
  });

  it('keeps sliding a self-loop foot when it is dragged outside the shape', () => {
    const doc: Doc = {
      ...twoShapes,
      connectors: [{ id: 'c1', from: { shapeId: 's1', x: 0.5, y: 0 }, to: { shapeId: 's1', x: 1, y: 0.5 }, label: '' }],
    };
    let st = initialState(doc, true);
    st = reduce(st, { type: 'ENDPOINT_DRAG_START', id: 'c1', end: 'to' });
    // 30px clear of s1's right edge — pulling a foot outward is how a loop is reshaped.
    st = reduce(st, { type: 'ENDPOINT_DRAG_MOVE', id: 'c1', end: 'to', p: { x: 250, y: 110 } });
    const c = st.doc.connectors[0];
    expect(c.to.shapeId).toBe('s1');
    expect(norm(c.to.x) && norm(c.to.y)).toBe(true);
  });

  it('breaks a self-loop once a foot is dragged well clear of the shape', () => {
    const doc: Doc = {
      ...twoShapes,
      connectors: [{ id: 'c1', from: { shapeId: 's1', x: 0.5, y: 0 }, to: { shapeId: 's1', x: 1, y: 0.5 }, label: '' }],
    };
    let st = initialState(doc, true);
    st = reduce(st, { type: 'ENDPOINT_DRAG_START', id: 'c1', end: 'to' });
    st = reduce(st, { type: 'ENDPOINT_DRAG_MOVE', id: 'c1', end: 'to', p: { x: 320, y: 140 } });
    const c = st.doc.connectors[0];
    expect(c.to.shapeId).toBeUndefined();
    expect(c.to).toEqual({ x: 320, y: 140 });
  });
});

describe('connector endpoint drag', () => {
  const doc = (): Doc => ({
    shapes: [
      { id: 's1', kind: 'rect', x: 100, y: 100, w: 120, h: 80, label: '' },
      { id: 's2', kind: 'rect', x: 400, y: 100, w: 120, h: 80, label: '' },
      { id: 's3', kind: 'rect', x: 250, y: 300, w: 120, h: 80, label: '' },
    ],
    connectors: [
      { id: 'c1', from: { shapeId: 's1', x: 160, y: 140 }, to: { shapeId: 's2', x: 460, y: 140 }, label: '' },
    ],
  });

  const drag = (points: Pt[], end: 'from' | 'to' = 'to') => {
    let st = initialState(doc(), true);
    st = reduce(st, { type: 'ENDPOINT_DRAG_START', id: 'c1', end });
    for (const p of points) st = reduce(st, { type: 'ENDPOINT_DRAG_MOVE', id: 'c1', end, p });
    return st.doc.connectors[0];
  };

  it('drops a detached endpoint exactly on the cursor, not on the grid', () => {
    // Grid-snapping a handle the user is dragging directly would leave it visibly
    // lagging the pointer by up to half a grid step.
    expect(drag([{ x: 331, y: 247 }]).to).toEqual({ x: 331, y: 247 });
  });

  it('attaches to a shape whose outline the cursor only came close to', () => {
    // 5px left of s3's left edge: the endpoint handle is aimed at the outline, so a
    // strict inside-the-bbox test would leave the arrow floating unattached.
    expect(drag([{ x: 245, y: 340 }]).to.shapeId).toBe('s3');
  });

  it('does not detach from its shape on a hair of movement across the border', () => {
    expect(drag([{ x: 398, y: 140 }]).to.shapeId).toBe('s2');
  });

  it('restores the other end after the cursor sweeps over its shape and off again', () => {
    // Passing over s1 makes the connector a momentary self-loop, which re-anchors `from`;
    // carrying on past s1 has to put `from` back exactly as it was.
    const c = drag([{ x: 300, y: 140 }, { x: 160, y: 140 }, { x: 40, y: 140 }]);
    expect(c.from).toEqual({ shapeId: 's1', x: 160, y: 140 });
    expect(c.to).toEqual({ x: 40, y: 140 });
  });

  it('pins to the edge when dropped on it, and stays floating when dropped inside', () => {
    // s2 spans x 400..520, y 100..180. Dropping on its left edge a third of the way down
    // fixes the attachment exactly there; dropping into the middle leaves it floating.
    const pinned = drag([{ x: 402, y: 115 }]);
    expect(pinned.to.anchor).toEqual({ x: 0, y: 0.1875 });
    expect(drag([{ x: 460, y: 140 }]).to.anchor).toBeUndefined();
  });

  it('touches a pinned edge point exactly, and aims the other end at it', () => {
    const st = initialState(doc(), true);
    let s = reduce(st, { type: 'ENDPOINT_DRAG_START', id: 'c1', end: 'to' });
    s = reduce(s, { type: 'ENDPOINT_DRAG_MOVE', id: 'c1', end: 'to', p: { x: 402, y: 115 } });
    const path = connectorPath(s.doc, s.doc.connectors[0]);
    expect(path[path.length - 1]).toEqual({ x: 400, y: 115 });
    // The still-floating `from` end slides up its border to face the pin rather than
    // staying on the old centre-to-centre line (which left it at y = 140).
    expect(path[0].y).toBeLessThan(140);
  });

  it('carries a pinned edge point through moves and resizes of its shape', () => {
    let s = reduce(initialState(doc(), true), { type: 'ENDPOINT_DRAG_START', id: 'c1', end: 'to' });
    s = reduce(s, { type: 'ENDPOINT_DRAG_MOVE', id: 'c1', end: 'to', p: { x: 402, y: 115 } });
    s = reduce(s, { type: 'DRAG_END' });
    s = reduce(s, { type: 'DRAG_START', id: 's2' });
    s = reduce(s, { type: 'DRAG_MOVE', id: 's2', to: { x: 400, y: 300 } });
    s = reduce(s, { type: 'DRAG_END' });
    const moved = connectorPath(s.doc, s.doc.connectors[0]);
    expect(moved[moved.length - 1]).toEqual({ x: 400, y: 315 }); // 300 + 0.1875 * 80
    s = reduce(s, { type: 'DRAG_START', id: 's2' });
    s = reduce(s, { type: 'DRAG_RESIZE', w: 240, h: 160, anchor: { x: 400, y: 300 } });
    s = reduce(s, { type: 'DRAG_END' });
    const resized = connectorPath(s.doc, s.doc.connectors[0]);
    expect(resized[resized.length - 1]).toEqual({ x: 400, y: 330 }); // 300 + 0.1875 * 160
  });

  it('keeps a broken self-loop attached where its foot was', () => {
    const looped: Doc = {
      ...doc(),
      connectors: [{ id: 'c1', from: { shapeId: 's1', x: 0.5, y: 1 }, to: { shapeId: 's1', x: 1, y: 0.5 }, label: '' }],
    };
    let s = reduce(initialState(looped, true), { type: 'ENDPOINT_DRAG_START', id: 'c1', end: 'to' });
    s = reduce(s, { type: 'ENDPOINT_DRAG_MOVE', id: 'c1', end: 'to', p: { x: 460, y: 140 } }); // onto s2
    const c = s.doc.connectors[0];
    expect(c.to.shapeId).toBe('s2');
    // `from` was the loop's bottom foot; it stays pinned to the bottom edge rather than
    // reverting to a centre-aimed attachment.
    expect(c.from.anchor).toEqual({ x: 0.5, y: 1 });
    expect(connectorPath(s.doc, c)[0]).toEqual({ x: 160, y: 180 });
  });

  it('drags a bend point to the cursor, but still snaps one added by click', () => {
    const doc: Doc = {
      shapes: [{ id: 's1', kind: 'rect', x: 100, y: 100, w: 120, h: 80, label: '' }],
      connectors: [{ id: 'c1', from: { x: 100, y: 100 }, to: { x: 400, y: 400 }, label: '' }],
    };
    let st = initialState(doc, true);
    st = reduce(st, { type: 'ADD_WAYPOINT', id: 'c1', p: { x: 251, y: 249 } });
    expect(st.doc.connectors[0].waypoints).toEqual([{ x: 256, y: 256 }]); // snapped to GRID
    st = reduce(st, { type: 'WAYPOINT_DRAG_START', id: 'c1', index: 0 });
    st = reduce(st, { type: 'WAYPOINT_DRAG_MOVE', id: 'c1', index: 0, p: { x: 331, y: 247 } });
    expect(st.doc.connectors[0].waypoints).toEqual([{ x: 331, y: 247 }]);
  });
});

describe('INSERT_SHAPE_AT: context-menu insert on empty canvas', () => {
  const empty: Doc = { shapes: [], connectors: [] };

  it('places a default-sized shape centered on the clicked point, snapped to the grid', () => {
    const st = reduce(initialState(empty, false), {
      type: 'INSERT_SHAPE_AT',
      kind: 'rect',
      p: { x: 405, y: 301 },
    });
    const s = st.doc.shapes[0];
    // 405/301 snap to 400/304, then the shape is centered on that point.
    expect({ x: s.x, y: s.y, w: s.w, h: s.h }).toEqual({
      x: 400 - GRID * 5,
      y: 304 - GRID * 3,
      w: GRID * 10,
      h: GRID * 6,
    });
    expect(s.kind).toBe('rect');
    expect(st.selectedIds).toEqual([s.id]);
  });

  it('gives a triangle a default direction, like the draw flow does', () => {
    const st = reduce(initialState(empty, false), {
      type: 'INSERT_SHAPE_AT',
      kind: 'triangle',
      p: { x: 200, y: 200 },
    });
    expect(st.doc.shapes[0].direction).toBe('up');
  });

  it('drops into text entry in plain mode, but stays in normal mode under vim', () => {
    const plain = reduce(initialState(empty, false), {
      type: 'INSERT_SHAPE_AT',
      kind: 'ellipse',
      p: { x: 200, y: 200 },
    });
    expect(plain.mode).toBe('insert');
    expect(plain.editingId).toBe(plain.doc.shapes[0].id);
    expect(plain.editingIsNew).toBe(true);

    const vim = reduce(initialState(empty, true), {
      type: 'INSERT_SHAPE_AT',
      kind: 'ellipse',
      p: { x: 200, y: 200 },
    });
    expect(vim.mode).toBe('normal');
    expect(vim.editingId).toBeNull();
    // Recorded as a repeatable edit, so `.` stamps another one at the cursor.
    expect(vim.lastEdit).toEqual({ kind: 'draw', shapeKind: 'ellipse', w: GRID * 10, h: GRID * 6 });
  });

  it('ignores the vim cursor: two inserts at different points land where each was clicked', () => {
    let st = reduce(initialState(empty, true), { type: 'INSERT_SHAPE_AT', kind: 'rect', p: { x: 0, y: 0 } });
    st = reduce(st, { type: 'INSERT_SHAPE_AT', kind: 'rect', p: { x: GRID * 40, y: GRID * 40 } });
    expect(st.doc.shapes.map((s) => s.x)).toEqual([-GRID * 5, GRID * 35]);
  });
});

describe('OPTIMIZE_IMAGES', () => {
  const image = (id: string, src: string): Shape => ({
    id,
    kind: 'image',
    x: 0,
    y: 0,
    w: GRID * 4,
    h: GRID * 4,
    label: '',
    src,
  });

  const doc = (): Doc => ({
    shapes: [image('a', 'data:image/png;base64,AAA'), image('b', 'data:image/png;base64,BBB'), rect('r', 0, 0)],
    connectors: [],
  });

  it('swaps in the re-encoded sources it was given, leaving everything else alone', () => {
    const before = doc();
    const st = reduce(initialState(before, true), {
      type: 'OPTIMIZE_IMAGES',
      srcById: { a: 'data:image/webp;base64,SMALL' },
      msg: 'done',
    });
    expect(st.doc.shapes[0].src).toBe('data:image/webp;base64,SMALL');
    expect(st.doc.shapes[1].src).toBe(before.shapes[1].src);
    expect(st.doc.shapes[2]).toEqual(before.shapes[2]);
    expect(st.msg).toBe('done');
  });

  it('lands as one undo step, so a lossy re-encode can be reverted', () => {
    const before = doc();
    const st = reduce(initialState(before, true), {
      type: 'OPTIMIZE_IMAGES',
      srcById: { a: 'x', b: 'y' },
      msg: 'done',
    });
    const undone = reduce(st, { type: 'KEY', key: 'u', ctrl: false, shift: false });
    expect(undone.doc.shapes.map((s) => s.src)).toEqual(before.shapes.map((s) => s.src));
  });

  it('ignores ids that are no longer in the doc (deleted while re-encoding)', () => {
    const before = doc();
    const st = reduce(initialState(before, true), {
      type: 'OPTIMIZE_IMAGES',
      srcById: { gone: 'x' },
      msg: 'done',
    });
    expect(st.doc.shapes).toEqual(before.shapes);
  });
});
