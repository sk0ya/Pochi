import type { Connector, Doc, Shape } from '../model/types';

/**
 * Item-level last-writer-wins sync for P2P collaboration.
 *
 * Every batch of local edits gets a Lamport clock tick; each touched item
 * (shape/connector, by id) is stamped with that {clock, peer} version. A remote
 * change to an item is applied only if its version is newer than the one we
 * already hold for that id — clock first, peer id as a deterministic tiebreak —
 * so all peers converge on the same winner without coordination. Deletes keep a
 * tombstone version so a stale remote upsert can't resurrect a deleted item
 * (a *newer* upsert can: that's an intentional undo-of-delete). Z-order is
 * synced as a whole id sequence per array, itself LWW-versioned, since merging
 * reorders structurally is far more complexity than this tool needs.
 */
export interface ItemVersion {
  clock: number;
  peer: string;
  /** Tombstone: the item was deleted at this version. */
  deleted?: boolean;
}

/** One batch of local edits, broadcast to every peer in the room. */
export interface SyncOps {
  clock: number;
  peer: string;
  /** Added or modified items, sent whole (upserts). */
  shapes: Shape[];
  connectors: Connector[];
  /** Ids of deleted shapes/connectors. */
  deletes: string[];
  /** Full id sequence, present only when z-order changed (LWW as a whole). */
  shapeOrder?: string[];
  connectorOrder?: string[];
}

/** The subset of a remote SyncOps that won version arbitration; applied to the doc verbatim. */
export interface AppliedOps {
  shapes: Shape[];
  connectors: Connector[];
  deletes: string[];
  shapeOrder?: string[];
  connectorOrder?: string[];
}

/** Full engine state, sent to a peer that just joined the room. */
export interface CollabSnapshot {
  doc: Doc;
  clock: number;
  versions: Record<string, ItemVersion>;
}

/** LWW comparison: is `a` strictly newer than `b`? (absent `b` = never written = always older). */
export function newerThan(a: { clock: number; peer: string }, b?: ItemVersion): boolean {
  if (!b) return true;
  return a.clock > b.clock || (a.clock === b.clock && a.peer > b.peer);
}

function upsert<T extends { id: string }>(arr: T[], items: T[]): T[] {
  if (!items.length) return arr;
  const byId = new Map(items.map((x) => [x.id, x]));
  const existing = new Set(arr.map((x) => x.id));
  const out = arr.map((x) => byId.get(x.id) ?? x);
  for (const x of items) if (!existing.has(x.id)) out.push(x);
  return out;
}

/** Reorder `arr` to match `order`; ids not in `order` (concurrent local adds the
 * sender hadn't seen) keep their relative order at the end (= drawn on top). */
function reorderTo<T extends { id: string }>(arr: T[], order: string[]): T[] {
  const idx = new Map(order.map((id, i) => [id, i]));
  const listed = arr.filter((x) => idx.has(x.id)).sort((a, b) => idx.get(a.id)! - idx.get(b.id)!);
  const unlisted = arr.filter((x) => !idx.has(x.id));
  return [...listed, ...unlisted];
}

/** Apply an arbitrated batch of remote changes to a doc. Pure — the reducer uses
 * this so remote edits always land on the *current* doc, never a stale snapshot. */
export function applyOps(doc: Doc, ops: AppliedOps): Doc {
  const del = new Set(ops.deletes);
  let shapes = del.size ? doc.shapes.filter((s) => !del.has(s.id)) : doc.shapes;
  let connectors = del.size ? doc.connectors.filter((c) => !del.has(c.id)) : doc.connectors;
  shapes = upsert(shapes, ops.shapes);
  connectors = upsert(connectors, ops.connectors);
  if (ops.shapeOrder) shapes = reorderTo(shapes, ops.shapeOrder);
  if (ops.connectorOrder) connectors = reorderTo(connectors, ops.connectorOrder);
  return { shapes, connectors };
}

/** Items in `next` that are new or content-changed vs `prev`. Reference equality is
 * the fast path (the reducer is immutable: untouched items keep their identity);
 * JSON comparison catches identity-changed-but-equal items (e.g. undo round-trips). */
function changedItems<T extends { id: string }>(prev: T[], next: T[]): T[] {
  const before = new Map(prev.map((x) => [x.id, x]));
  return next.filter((x) => {
    const old = before.get(x.id);
    if (old === x) return false;
    return !old || JSON.stringify(old) !== JSON.stringify(x);
  });
}

function deletedIds(prev: { id: string }[], next: { id: string }[]): string[] {
  const kept = new Set(next.map((x) => x.id));
  return prev.filter((x) => !kept.has(x.id)).map((x) => x.id);
}

/** True if the ids common to both arrays appear in a different sequence. */
function orderChanged(prev: { id: string }[], next: { id: string }[]): boolean {
  const prevIds = new Set(prev.map((x) => x.id));
  const nextIds = new Set(next.map((x) => x.id));
  const a = prev.filter((x) => nextIds.has(x.id));
  const b = next.filter((x) => prevIds.has(x.id));
  return a.some((x, i) => x.id !== b[i].id);
}

/**
 * Per-session sync state: the Lamport clock, item versions, and a `shadow` doc —
 * the last state known to be in sync with the room. `diffLocal` compares the
 * current doc against the shadow to find what to broadcast; `filterRemote`
 * arbitrates an incoming batch against the version map. Both advance the shadow,
 * so a remote batch applied to the doc is never echoed back as a local edit.
 */
export class SyncEngine {
  private clock = 0;
  private versions = new Map<string, ItemVersion>();
  private shapeOrderV: ItemVersion | null = null;
  private connectorOrderV: ItemVersion | null = null;
  private shadow: Doc;

  constructor(
    readonly peer: string,
    initialDoc: Doc,
  ) {
    this.shadow = initialDoc;
  }

  /** Diff the current doc against the shadow → batch to broadcast (null if nothing changed). */
  diffLocal(doc: Doc): SyncOps | null {
    const prev = this.shadow;
    if (doc === prev) return null;
    this.shadow = doc;
    const shapes = changedItems(prev.shapes, doc.shapes);
    const connectors = changedItems(prev.connectors, doc.connectors);
    const deletes = [...deletedIds(prev.shapes, doc.shapes), ...deletedIds(prev.connectors, doc.connectors)];
    const shapeOrder = orderChanged(prev.shapes, doc.shapes) ? doc.shapes.map((s) => s.id) : undefined;
    const connectorOrder = orderChanged(prev.connectors, doc.connectors)
      ? doc.connectors.map((c) => c.id)
      : undefined;
    if (!shapes.length && !connectors.length && !deletes.length && !shapeOrder && !connectorOrder) {
      return null;
    }
    const v: ItemVersion = { clock: ++this.clock, peer: this.peer };
    for (const s of shapes) this.versions.set(s.id, v);
    for (const c of connectors) this.versions.set(c.id, v);
    for (const id of deletes) this.versions.set(id, { ...v, deleted: true });
    if (shapeOrder) this.shapeOrderV = v;
    if (connectorOrder) this.connectorOrderV = v;
    return { clock: v.clock, peer: this.peer, shapes, connectors, deletes, shapeOrder, connectorOrder };
  }

  /** Arbitrate a remote batch: keep what's newer than our versions, drop the rest.
   * Returns what the caller should apply to the doc (null if nothing survived). */
  filterRemote(ops: SyncOps): AppliedOps | null {
    this.clock = Math.max(this.clock, ops.clock);
    const v: ItemVersion = { clock: ops.clock, peer: ops.peer };
    const shapes = ops.shapes.filter((s) => newerThan(v, this.versions.get(s.id)));
    const connectors = ops.connectors.filter((c) => newerThan(v, this.versions.get(c.id)));
    const deletes = ops.deletes.filter((id) => newerThan(v, this.versions.get(id)));
    for (const s of shapes) this.versions.set(s.id, v);
    for (const c of connectors) this.versions.set(c.id, v);
    for (const id of deletes) this.versions.set(id, { ...v, deleted: true });
    let shapeOrder: string[] | undefined;
    if (ops.shapeOrder && newerThan(v, this.shapeOrderV ?? undefined)) {
      shapeOrder = ops.shapeOrder;
      this.shapeOrderV = v;
    }
    let connectorOrder: string[] | undefined;
    if (ops.connectorOrder && newerThan(v, this.connectorOrderV ?? undefined)) {
      connectorOrder = ops.connectorOrder;
      this.connectorOrderV = v;
    }
    if (!shapes.length && !connectors.length && !deletes.length && !shapeOrder && !connectorOrder) {
      return null;
    }
    const applied: AppliedOps = { shapes, connectors, deletes, shapeOrder, connectorOrder };
    this.shadow = applyOps(this.shadow, applied);
    return applied;
  }

  /** Full state for a peer that just joined. Callers must flush pending local
   * diffs first so the snapshot and the op stream tell one consistent story. */
  snapshot(): CollabSnapshot {
    return { doc: this.shadow, clock: this.clock, versions: Object.fromEntries(this.versions) };
  }

  /** Adopt a snapshot wholesale (URL-joiner receiving the room's state). Returns
   * the doc the caller should replace its own with. */
  loadSnapshot(snap: CollabSnapshot): Doc {
    this.clock = Math.max(this.clock, snap.clock);
    this.versions = new Map(Object.entries(snap.versions));
    this.shapeOrderV = null;
    this.connectorOrderV = null;
    this.shadow = snap.doc;
    return snap.doc;
  }
}
