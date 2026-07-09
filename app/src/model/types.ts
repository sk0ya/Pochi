export interface Pt {
  x: number;
  y: number;
}

export type ShapeKind = 'rect' | 'ellipse' | 'text' | 'diamond' | 'sticky' | 'image';

export interface Shape {
  id: string;
  kind: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  /** Accent color (hex); undefined = theme default. */
  color?: string;
  /** Data URL for kind: 'image'. */
  src?: string;
  /** Shared id linking items that move/select/delete/color together. */
  groupId?: string;
}

/** Arrow endpoint: bound to a shape (follows it) or a fixed point. */
export interface Endpoint {
  shapeId?: string;
  x: number;
  y: number;
}

export interface Connector {
  id: string;
  from: Endpoint;
  to: Endpoint;
  label: string;
  /** Accent color (hex); undefined = theme default. */
  color?: string;
  /** Auto-routing style; undefined = straight. Ignored when `waypoints` is set. */
  routing?: 'straight' | 'orthogonal';
  /** Manual bend points, in order from `from` to `to`. */
  waypoints?: Pt[];
  /** Shared id linking items that move/select/delete/color together. */
  groupId?: string;
}

export interface Doc {
  shapes: Shape[];
  connectors: Connector[];
}

export const GRID = 16;

export const emptyDoc = (): Doc => ({ shapes: [], connectors: [] });

export const newId = (): string => Math.random().toString(36).slice(2, 10);

export const snap = (v: number): number => Math.round(v / GRID) * GRID;

export const snapPt = (p: Pt): Pt => ({ x: snap(p.x), y: snap(p.y) });
