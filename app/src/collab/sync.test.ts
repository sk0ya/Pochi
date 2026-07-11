import { describe, expect, it } from 'vitest';
import { addShape, deleteItem, updateShape } from '../model/doc';
import { emptyDoc } from '../model/types';
import type { Doc, Shape } from '../model/types';
import { applyOps, newerThan, SyncEngine } from './sync';
import type { SyncOps } from './sync';

const shape = (id: string, x = 0): Shape => ({
  id,
  kind: 'rect',
  x,
  y: 0,
  w: 64,
  h: 32,
  label: id,
});

const docWith = (...shapes: Shape[]): Doc => ({ shapes, connectors: [] });

/** Wire round-trip: what the receiving side actually gets (drops undefined fields). */
const overWire = (ops: SyncOps): SyncOps => JSON.parse(JSON.stringify(ops)) as SyncOps;

describe('newerThan', () => {
  it('treats missing versions as oldest', () => {
    expect(newerThan({ clock: 1, peer: 'a' }, undefined)).toBe(true);
  });
  it('compares clocks first, then peer id', () => {
    expect(newerThan({ clock: 2, peer: 'a' }, { clock: 1, peer: 'z' })).toBe(true);
    expect(newerThan({ clock: 1, peer: 'a' }, { clock: 2, peer: 'a' })).toBe(false);
    expect(newerThan({ clock: 1, peer: 'b' }, { clock: 1, peer: 'a' })).toBe(true);
    expect(newerThan({ clock: 1, peer: 'a' }, { clock: 1, peer: 'a' })).toBe(false);
  });
});

describe('applyOps', () => {
  it('upserts, deletes, and reorders in one batch', () => {
    const doc = docWith(shape('a'), shape('b'), shape('c'));
    const next = applyOps(doc, {
      shapes: [shape('b', 100), shape('d')],
      connectors: [],
      deletes: ['a'],
      shapeOrder: ['c', 'b'],
    });
    // a deleted; b updated in place; d appended (unknown to the order list = on top); c/b reordered.
    expect(next.shapes.map((s) => s.id)).toEqual(['c', 'b', 'd']);
    expect(next.shapes.find((s) => s.id === 'b')?.x).toBe(100);
  });

  it('deleting a shape id also drops connectors listed for deletion only', () => {
    const doc: Doc = {
      shapes: [shape('a'), shape('b')],
      connectors: [{ id: 'k', from: { shapeId: 'a', x: 0, y: 0 }, to: { shapeId: 'b', x: 0, y: 0 }, label: '' }],
    };
    const next = applyOps(doc, { shapes: [], connectors: [], deletes: ['a', 'k'] });
    expect(next.shapes.map((s) => s.id)).toEqual(['b']);
    expect(next.connectors).toEqual([]);
  });
});

describe('SyncEngine.diffLocal', () => {
  it('returns null when nothing changed', () => {
    const doc = docWith(shape('a'));
    const eng = new SyncEngine('p1', doc);
    expect(eng.diffLocal(doc)).toBeNull();
    // New identity, same content: still no broadcast.
    expect(eng.diffLocal(docWith({ ...doc.shapes[0] }))).toBeNull();
  });

  it('reports adds, updates, and deletes against the shadow', () => {
    const doc = docWith(shape('a'), shape('b'));
    const eng = new SyncEngine('p1', doc);
    const next = addShape(deleteItem(updateShape(doc, 'a', { x: 50 }), 'b'), shape('c'));
    const ops = eng.diffLocal(next);
    expect(ops?.shapes.map((s) => s.id).sort()).toEqual(['a', 'c']);
    expect(ops?.deletes).toEqual(['b']);
    expect(ops?.shapeOrder).toBeUndefined();
    // Shadow advanced: same doc again diffs to nothing.
    expect(eng.diffLocal(next)).toBeNull();
  });

  it('sends the full id order only when relative order changes', () => {
    const doc = docWith(shape('a'), shape('b'));
    const eng = new SyncEngine('p1', doc);
    const reordered = docWith(doc.shapes[1], doc.shapes[0]);
    expect(eng.diffLocal(reordered)?.shapeOrder).toEqual(['b', 'a']);
    // An append alone doesn't count as a reorder.
    expect(eng.diffLocal(docWith(doc.shapes[1], doc.shapes[0], shape('c')))?.shapeOrder).toBeUndefined();
  });

  it('bumps the clock per batch', () => {
    const eng = new SyncEngine('p1', emptyDoc());
    const c1 = eng.diffLocal(docWith(shape('a')))?.clock;
    const c2 = eng.diffLocal(docWith(shape('a', 10)))?.clock;
    expect(c1).toBe(1);
    expect(c2).toBe(2);
  });
});

describe('SyncEngine.filterRemote', () => {
  it('applies remote edits and does not echo them back as local', () => {
    const doc = emptyDoc();
    const a = new SyncEngine('a', doc);
    const b = new SyncEngine('b', doc);
    const ops = a.diffLocal(docWith(shape('s1')))!;
    const applied = b.filterRemote(overWire(ops))!;
    const bDoc = applyOps(doc, applied);
    expect(bDoc.shapes.map((s) => s.id)).toEqual(['s1']);
    expect(b.diffLocal(bDoc)).toBeNull();
  });

  it('newer local edit survives an older concurrent remote edit', () => {
    const base = docWith(shape('s1'));
    const a = new SyncEngine('a', base);
    const b = new SyncEngine('b', base);
    const fromA = a.diffLocal(docWith(shape('s1', 10)))!; // clock 1, peer a
    // b edits the same shape twice (clock 2 locally), then receives a's older op.
    b.diffLocal(docWith(shape('s1', 20)));
    const bDoc = docWith(shape('s1', 30));
    b.diffLocal(bDoc);
    expect(b.filterRemote(overWire(fromA))).toBeNull();
  });

  it('same-clock conflicts resolve identically on both sides (peer tiebreak)', () => {
    const base = docWith(shape('s1'));
    const a = new SyncEngine('a', base);
    const b = new SyncEngine('b', base);
    const fromA = a.diffLocal(docWith(shape('s1', 10)))!;
    const fromB = b.diffLocal(docWith(shape('s1', 20)))!;
    // Both clock 1; peer 'b' > 'a', so b's edit wins everywhere.
    const aApplied = a.filterRemote(overWire(fromB));
    const bApplied = b.filterRemote(overWire(fromA));
    expect(aApplied?.shapes[0].x).toBe(20);
    expect(bApplied).toBeNull();
  });

  it('an equal-clock upsert from a higher peer id wins over a tombstone (tiebreak)', () => {
    const base = docWith(shape('s1'));
    const a = new SyncEngine('a', base);
    const b = new SyncEngine('b', base);
    const upsert = b.diffLocal(docWith(shape('s1', 99)))!; // clock 1, peer 'b'
    a.diffLocal(emptyDoc()); // a deletes s1: tombstone clock 1, peer 'a'
    // Tie on clock; peer 'b' > 'a', so the upsert resurrects the shape on a's side.
    expect(a.filterRemote(overWire(upsert))?.shapes[0].x).toBe(99);
  });

  it('a newer tombstone blocks an older upsert', () => {
    const base = docWith(shape('s1'));
    const a = new SyncEngine('a', base);
    const b = new SyncEngine('b', base);
    const upsert = a.diffLocal(docWith(shape('s1', 10)))!; // clock 1
    b.diffLocal(docWith(shape('s1', 5))); // clock 1
    const del = b.diffLocal(emptyDoc())!; // clock 2: delete s1
    expect(del.deletes).toEqual(['s1']);
    // b then receives a's older upsert: tombstone (clock 2) wins.
    expect(b.filterRemote(overWire(upsert))).toBeNull();
  });

  it('remote delete beats an older local version and is applied', () => {
    const base = docWith(shape('s1'));
    const a = new SyncEngine('a', base);
    const b = new SyncEngine('b', base);
    b.diffLocal(docWith(shape('s1', 5))); // clock 1
    a.diffLocal(docWith(shape('s1', 10))); // clock 1
    const del = a.diffLocal(emptyDoc())!; // clock 2
    const applied = b.filterRemote(overWire(del))!;
    expect(applied.deletes).toEqual(['s1']);
    expect(applyOps(docWith(shape('s1', 5)), applied).shapes).toEqual([]);
  });

  it('order updates are LWW too', () => {
    const base = docWith(shape('a'), shape('b'));
    const p = new SyncEngine('p', base);
    const q = new SyncEngine('q', base);
    const fromP = p.diffLocal(docWith(base.shapes[1], base.shapes[0]))!; // clock 1, order b,a
    const fromQ = q.diffLocal(docWith(shape('a', 1), base.shapes[1]))!; // clock 1, content only
    expect(fromQ.shapeOrder).toBeUndefined();
    const applied = q.filterRemote(overWire(fromP))!;
    expect(applied.shapeOrder).toEqual(['b', 'a']);
    // A second, older-or-equal order op from a lower peer id is rejected.
    const stale: SyncOps = { clock: 1, peer: 'o', shapes: [], connectors: [], deletes: [], shapeOrder: ['a', 'b'] };
    expect(q.filterRemote(overWire(stale))).toBeNull();
  });
});

describe('snapshot round-trip', () => {
  it('a joiner adopts the snapshot and stays consistent with later ops', () => {
    const host = new SyncEngine('h', emptyDoc());
    const doc1 = docWith(shape('a'), shape('b'));
    host.diffLocal(doc1);
    const joiner = new SyncEngine('j', docWith(shape('junk')));
    const joined = joiner.loadSnapshot(JSON.parse(JSON.stringify(host.snapshot())));
    expect(joined.shapes.map((s) => s.id)).toEqual(['a', 'b']);
    // Joiner sees no local diff after adopting (its own junk doc is gone).
    expect(joiner.diffLocal(joined)).toBeNull();
    // Later host edit flows through normally.
    const ops = host.diffLocal(applyOps(doc1, { shapes: [shape('a', 42)], connectors: [], deletes: [] }))!;
    const applied = joiner.filterRemote(overWire(ops))!;
    expect(applied.shapes[0].x).toBe(42);
    // And the snapshot's versions protect against pre-join stale ops: an op with
    // an old clock for shape 'a' is rejected.
    const stale: SyncOps = { clock: 1, peer: 'A', shapes: [shape('a', -1)], connectors: [], deletes: [] };
    expect(joiner.filterRemote(overWire(stale))).toBeNull();
  });
});
