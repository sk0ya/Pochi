import { joinRoom, selfId } from 'trystero/nostr';
import type { Doc, Pt } from '../model/types';
import { SyncEngine } from './sync';
import type { AppliedOps, CollabSnapshot, SyncOps } from './sync';

/** All Pochi rooms share one trystero app namespace; the room id scopes the mesh. */
const APP_ID = 'pochi-collab';
/** Local edits are batched and broadcast at most this often (drag gestures emit a doc per frame). */
const FLUSH_MS = 80;
/** Minimum interval between cursor broadcasts. */
const CURSOR_MS = 60;
/**
 * How long a URL-joiner holds outgoing edits while waiting for the room's snapshot.
 * Holding prevents a joiner's own autosave doc from leaking into the room before the
 * snapshot replaces it. A snapshot arriving *after* this window is still applied
 * (WebRTC handshakes can easily outlast it) — the deadline only releases the hold so
 * someone rejoining an empty room isn't muted forever.
 */
const SNAPSHOT_HOLD_MS = 5000;

/** trystero's action generics want an index-signature'd payload; our interfaces are
 * plain, so actions are typed through this narrow view instead of casts at call sites. */
interface Action<T> {
  send: (data: T, options?: { target?: string }) => Promise<void>;
  onMessage: ((data: T, ctx: { peerId: string }) => void) | null;
}

export interface CollabHandlers {
  /** Remote edits that won arbitration; dispatch to the reducer to merge into the current doc. */
  applyOps(ops: AppliedOps): void;
  /** The room's snapshot on join; replaces the local doc (undo can recover the old one). */
  applySnapshot(doc: Doc): void;
  onPeersChange(peerIds: string[]): void;
  /** A peer's cursor moved (world coords); null = the peer left. */
  onCursor(peerId: string, p: Pt | null): void;
}

/**
 * One live collaboration room: trystero (WebRTC mesh, Nostr-relay signaling — no
 * server of our own) plus a SyncEngine for item-level LWW merging. The owner feeds
 * every doc change into `docChanged` and applies whatever the handlers deliver.
 */
export class CollabSession {
  readonly selfId = selfId;
  private readonly engine: SyncEngine;
  private readonly room: ReturnType<typeof joinRoom>;
  private readonly ops: Action<SyncOps>;
  private readonly snap: Action<CollabSnapshot>;
  private readonly cursor: Action<Pt>;
  private latestDoc: Doc;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCursor: Pt | null = null;
  private lastCursorAt = 0;
  private holding: boolean;
  private snapshotApplied = false;
  private left = false;

  constructor(
    readonly roomId: string,
    initialDoc: Doc,
    joinedViaUrl: boolean,
    private readonly handlers: CollabHandlers,
    // STUN+TURN servers for the WebRTC mesh (see collab/ice.ts). Undefined = trystero's
    // built-in STUN defaults, which can't traverse a commercial VPN's symmetric NAT; a
    // config carrying a TURN relay is what makes VPN-to-non-VPN collaboration connect.
    rtcConfig?: RTCConfiguration,
  ) {
    this.engine = new SyncEngine(selfId, initialDoc);
    this.latestDoc = initialDoc;
    this.holding = joinedViaUrl;
    // The room id doubles as the shared secret (that's the "know the URL, get in"
    // model); using it as the password also encrypts signaling over the public relays.
    this.room = joinRoom({ appId: APP_ID, password: `pochi-${roomId}`, rtcConfig }, roomId);
    this.ops = this.room.makeAction('ops') as unknown as Action<SyncOps>;
    this.snap = this.room.makeAction('snapshot') as unknown as Action<CollabSnapshot>;
    this.cursor = this.room.makeAction('cursor') as unknown as Action<Pt>;

    this.ops.onMessage = (data) => {
      if (this.left) return;
      const applied = this.engine.filterRemote(data);
      if (applied) this.handlers.applyOps(applied);
    };
    this.snap.onMessage = (data) => {
      // Only the first snapshot counts, and only for a URL-joiner: a settled peer
      // receiving a stray snapshot must not have its doc yanked out from under it.
      if (this.left || !joinedViaUrl || this.snapshotApplied) return;
      this.snapshotApplied = true;
      const doc = this.engine.loadSnapshot(data);
      this.latestDoc = doc;
      this.holding = false;
      this.handlers.applySnapshot(doc);
    };
    this.cursor.onMessage = (data, { peerId }) => {
      if (!this.left) this.handlers.onCursor(peerId, data);
    };
    this.room.onPeerJoin = (peerId) => {
      if (this.left) return;
      // A joiner still waiting for its own snapshot doesn't hand out state — its doc
      // isn't the room's yet. (Two peers joining an empty room simultaneously thus
      // exchange nothing and just merge via ops, instead of swapping docs.)
      if (!this.holding) {
        this.flush();
        void this.snap.send(this.engine.snapshot(), { target: peerId });
      }
      this.emitPeers();
    };
    this.room.onPeerLeave = (peerId) => {
      if (this.left) return;
      this.handlers.onCursor(peerId, null);
      this.emitPeers();
    };
    setTimeout(() => {
      if (this.left || !this.holding) return;
      this.holding = false;
      this.flush();
    }, SNAPSHOT_HOLD_MS);
  }

  /** Call on every doc change; diffs are batched and broadcast every FLUSH_MS. */
  docChanged(doc: Doc): void {
    this.latestDoc = doc;
    if (this.left || this.holding || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_MS);
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.left || this.holding) return;
    const ops = this.engine.diffLocal(this.latestDoc);
    if (ops) void this.ops.send(ops);
  }

  /** Call on every local cursor move; throttled to one broadcast per CURSOR_MS. */
  cursorMoved(p: Pt): void {
    if (this.left) return;
    this.pendingCursor = p;
    if (this.cursorTimer) return;
    const wait = Math.max(0, CURSOR_MS - (Date.now() - this.lastCursorAt));
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = null;
      this.lastCursorAt = Date.now();
      if (!this.left && this.pendingCursor) void this.cursor.send(this.pendingCursor);
    }, wait);
  }

  private emitPeers(): void {
    this.handlers.onPeersChange(Object.keys(this.room.getPeers()));
  }

  leave(): void {
    if (this.left) return;
    this.flush();
    this.left = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.cursorTimer) clearTimeout(this.cursorTimer);
    this.flushTimer = null;
    this.cursorTimer = null;
    void this.room.leave();
  }
}
