import { describe, expect, it } from 'vitest';
import { initialState, reduce } from './reducer';
import type { EditorState } from './reducer';
import type { Doc, Shape } from '../model/types';
import { GRID } from '../model/types';

const rect = (id: string, x: number, y: number, w = GRID * 4, h = GRID * 4): Shape => ({
  id,
  kind: 'rect',
  x,
  y,
  w,
  h,
  label: '',
});

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
