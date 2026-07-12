export interface Pt {
  x: number;
  y: number;
}

export type ShapeKind = 'rect' | 'ellipse' | 'text' | 'diamond' | 'image' | 'triangle' | 'frame' | 'freedraw';

/** Quantization resolution for kind: 'freedraw' — `points` entries are integers in
 * 0..FREEDRAW_RES, relative to the shape's own bbox. Chosen so each coordinate is at
 * most 4 characters in JSON while staying finer than the stroke simplification
 * tolerance at typical shape sizes. */
export const FREEDRAW_RES = 1000;

/** Label font size: 's' / 'm' / 'l'; undefined = 'm' (the original, pre-feature default). */
export type FontSize = 's' | 'm' | 'l';

/** Label font-size in px per level. 'm' (14) matches the size Pochi always rendered
 * labels at before this option existed, so undefined/'m' looks identical to before. */
export const FONT_SIZE_PX: Record<FontSize, number> = { s: 11, m: 14, l: 21 };

/** Per-line height in px per level, scaled proportionally to FONT_SIZE_PX so multi-line
 * labels keep the same visual line spacing ratio at every size. */
export const FONT_LINE_H: Record<FontSize, number> = { s: 16, m: 20, l: 30 };

/** Stroke thickness level: 'thin' / 'm' / 'thick'; undefined = 'm'. */
export type StrokeWidthLevel = 'thin' | 'm' | 'thick';

/** Base stroke width in px per level (before the +0.5 selection bump used everywhere
 * strokes are drawn). 'm' (1.5) matches the width Pochi always rendered strokes at
 * before this option existed, so undefined/'m' looks identical to before. */
export const STROKE_WIDTH_BASE: Record<StrokeWidthLevel, number> = { thin: 1, m: 1.5, thick: 3 };

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
  /** Stroke for kind: 'freedraw', as a flat [x0, y0, x1, y1, ...] of integers in
   * 0..FREEDRAW_RES relative to the bbox — bbox-relative so plain x/y/w/h moves and
   * resizes apply untouched, quantized+flat to keep saved files and share URLs small. */
  points?: number[];
  /** Flat-fill style (solid background, no stroke) for rect/ellipse/diamond/triangle; undefined = outlined. */
  filled?: boolean;
  /** Label font size; undefined = 'm'. */
  fontSize?: FontSize;
  /** Stroke thickness; undefined = 'm'. Ignored when `filled` (no stroke is drawn). */
  strokeWidth?: StrokeWidthLevel;
  /** Dashed vs solid stroke; undefined = solid. Ignored when `filled`. */
  dashed?: boolean;
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
  /** Orthogonal-routing bend position, 0..1 from `from` to `to` along the
   * axis the bend runs on; undefined = 0.5 (midpoint, the original default). */
  elbowRatio?: number;
  /** Manual bend points, in order from `from` to `to`. */
  waypoints?: Pt[];
  /** Dashed vs solid stroke; undefined = solid. */
  dashed?: boolean;
  /** Arrowhead placement; undefined = 'end'. */
  arrowDirection?: ArrowDirection;
  /** Label font size; undefined = 'm'. */
  fontSize?: FontSize;
  /** Stroke thickness; undefined = 'm'. */
  strokeWidth?: StrokeWidthLevel;
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
