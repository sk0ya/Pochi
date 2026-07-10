export interface Pt {
  x: number;
  y: number;
}

export type ShapeKind = 'rect' | 'ellipse' | 'text' | 'diamond' | 'image' | 'triangle';

/** Label font size: 's' / 'm' / 'l'; undefined = 'm' (the original, pre-feature default). */
export type FontSize = 's' | 'm' | 'l';

/** Label font-size in px per level. 'm' (14) matches the size Pochi always rendered
 * labels at before this option existed, so undefined/'m' looks identical to before. */
export const FONT_SIZE_PX: Record<FontSize, number> = { s: 11, m: 14, l: 21 };

/** Per-line height in px per level, scaled proportionally to FONT_SIZE_PX so multi-line
 * labels keep the same visual line spacing ratio at every size. */
export const FONT_LINE_H: Record<FontSize, number> = { s: 16, m: 20, l: 30 };

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
  /** Label font size; undefined = 'm'. */
  fontSize?: FontSize;
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
  /** Label font size; undefined = 'm'. */
  fontSize?: FontSize;
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
