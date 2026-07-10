export interface Pt {
  x: number;
  y: number;
}

export type ShapeKind = 'rect' | 'ellipse' | 'text' | 'diamond' | 'image' | 'triangle';

/** Apex direction for kind: 'triangle'. Cardinal directions produce an isosceles
 * triangle (apex at the midpoint of one bbox edge); diagonal directions produce
 * a right triangle occupying that corner of the bbox. */
export type TriangleDirection =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'up-left'
  | 'up-right'
  | 'down-left'
  | 'down-right';

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
  /** Apex direction for kind: 'triangle'; undefined = 'up'. */
  direction?: TriangleDirection;
  /** Flat-fill style (solid background, no stroke) for rect/ellipse/diamond/triangle; undefined = outlined. */
  filled?: boolean;
  /** Shared id linking items that move/select/delete/color together. */
  groupId?: string;
}

/** Arrow endpoint: bound to a shape (follows it) or a fixed point. */
export interface Endpoint {
  shapeId?: string;
  x: number;
  y: number;
}

/** Arrowhead placement along a connector; undefined = 'end' (the original default). */
export type ArrowDirection = 'none' | 'start' | 'end' | 'both';

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
  /** Dashed vs solid stroke; undefined = solid. */
  dashed?: boolean;
  /** Arrowhead placement; undefined = 'end'. */
  arrowDirection?: ArrowDirection;
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
