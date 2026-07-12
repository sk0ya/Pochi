/**
 * Import/export codec for the Excalidraw (.excalidraw) JSON file format.
 *
 * Pochi's Shape/Connector model (model/types.ts) is deliberately simpler than
 * Excalidraw's element model: one `color` instead of separate stroke/background, no
 * rotation/roughness/hand-drawn styling, inline shape labels instead of separate bound
 * text elements, a single `groupId` instead of a nested `groupIds` stack, and geometric
 * (not stored) frame membership. `docToExcalidraw`/`excalidrawToDoc` bridge that gap:
 *
 * - rect/ellipse/diamond map to their Excalidraw counterparts. A non-empty `label`
 *   becomes a separate Excalidraw bound text element (Excalidraw's own mechanism for a
 *   caption inside a shape) — Pochi always centers labels, so the bound text is
 *   exported centered/middle-aligned to match.
 * - `image` maps to an Excalidraw image element; the data URL is lifted into the
 *   file's top-level `files` map, as Excalidraw requires.
 * - `triangle` has no Excalidraw equivalent, so it exports as a closed 3-point `line`
 *   element (visually identical) tagged with `customData.pochiDirection` so a Pochi ->
 *   Excalidraw -> Pochi round trip reconstructs the exact apex direction instead of
 *   guessing one back from the (now baked-in) geometry.
 * - `frame` maps to Excalidraw's native `frame` element, using its `name` field for the
 *   label. Frame membership is never stored on either side — Pochi computes it
 *   geometrically (see `frameContainedIds` in model/doc.ts) and Excalidraw elements
 *   carry their own absolute x/y, so containment just falls out of the transferred
 *   geometry; `frameId` on export is only a best-effort courtesy so Excalidraw's own
 *   frame-drag behavior works immediately after import.
 * - `freedraw` maps to Excalidraw's native `freedraw` element (rescaled out of Pochi's
 *   quantized bbox-relative encoding into absolute points on export, and re-simplified/
 *   re-quantized via the same `strokeToFreedraw` the pen tool uses, on import).
 * - A connector maps to an Excalidraw `arrow`, baking its *rendered* path (straight,
 *   orthogonal-routed, or manually waypointed — see `connectorPath` in model/doc.ts)
 *   into the arrow's `points`, so the visual shape survives even though Excalidraw has
 *   no concept of Pochi's orthogonal auto-routing. `customData` on the arrow preserves
 *   `routing`/`elbowRatio`/whether `waypoints` were manual, so re-importing a
 *   Pochi-authored file reconstructs the original routing instead of a frozen polyline;
 *   a genuinely foreign multi-point arrow (no such customData) is read back as manual
 *   waypoints instead, which is the closest available approximation.
 *
 * Shape/connector ids pass through unchanged in both directions (Pochi ids are opaque
 * strings and so are Excalidraw's, so there's no need for share.ts's short-id
 * remapping here) — this also means bindings (`startBinding`/`endBinding`,
 * `containerId`, `frameId`) can reference them directly with no id table.
 *
 * `excalidrawToDoc` never throws: a file that isn't shaped like an Excalidraw scene at
 * all resolves to `null`; an individual malformed element is just skipped rather than
 * failing the whole import (mirrors decodeShareDoc in share.ts).
 */
import { connectorLabelPos, connectorPath, freedrawPoints, labelCenter, triangleVertices } from './model/doc';
import { strokeToFreedraw } from './model/sketch';
import { FLAT_FILL_DEFAULT, fillTint, readableTextColor } from './model/palette';
import { FONT_SIZE_PX } from './model/types';
import type {
  ArrowDirection,
  Connector,
  Doc,
  Endpoint,
  FontSize,
  Pt,
  Shape,
  StrokeWidthLevel,
  TriangleDirection,
} from './model/types';

/** Pochi's thin/m/thick maps to Excalidraw's conventional 1/2/4 strokeWidth scale;
 * 'm' -> 2 matches the fixed value this codec always wrote before the option existed. */
const EXCALIDRAW_STROKE_WIDTH: Record<StrokeWidthLevel, number> = { thin: 1, m: 2, thick: 4 };

const FONT_FAMILY_HELVETICA = 2;
/** Default stroke color for an uncolored shape — Excalidraw's own default palette
 * stroke, so an exported file looks native and an imported shape using that exact
 * value round-trips back to "no explicit color" (theme default) rather than a literal. */
const DEFAULT_STROKE = '#1e1e1e';
const SOURCE_URL = 'https://github.com/sk0ya/Pochi';

const ALL_TRIANGLE_DIRECTIONS: TriangleDirection[] = [
  'up', 'down', 'left', 'right', 'up-left', 'up-right', 'down-left', 'down-right',
];

/** Minimal Excalidraw element shape covering every field this codec reads or writes,
 * across all element types it produces/consumes. Deliberately not a discriminated
 * union — Excalidraw's own real schema has dozens of rarely-used fields we don't touch,
 * and this codec is the only writer/reader, so a single loose interface is far less
 * code than modeling the full spec for no added safety. */
export interface ExcalidrawElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: 'solid' | 'hachure' | 'cross-hatch';
  strokeWidth: number;
  strokeStyle: 'solid' | 'dashed' | 'dotted';
  roughness: number;
  opacity: number;
  groupIds: string[];
  frameId: string | null;
  roundness: { type: number } | null;
  seed: number;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  boundElements: Array<{ id: string; type: string }> | null;
  updated: number;
  link: string | null;
  locked: boolean;
  customData?: Record<string, unknown>;
  // text
  text?: string;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: 'left' | 'center' | 'right';
  verticalAlign?: 'top' | 'middle' | 'bottom';
  lineHeight?: number;
  containerId?: string | null;
  // image
  fileId?: string | null;
  status?: 'saved' | 'pending' | 'error';
  scale?: [number, number];
  // linear (line / arrow) + freedraw
  points?: Array<[number, number]>;
  lastCommittedPoint?: [number, number] | null;
  // arrow
  startBinding?: { elementId: string; focus: number; gap: number } | null;
  endBinding?: { elementId: string; focus: number; gap: number } | null;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
  elbowed?: boolean;
  // freedraw
  pressures?: number[];
  simulatePressure?: boolean;
  // frame
  name?: string | null;
}

export interface ExcalidrawFile {
  type: 'excalidraw';
  version: number;
  source: string;
  elements: ExcalidrawElement[];
  appState: { viewBackgroundColor: string; gridSize: number | null };
  files: Record<string, { mimeType: string; id: string; dataURL: string; created: number }>;
}

function baseFields(id: string, type: string, x: number, y: number, w: number, h: number): ExcalidrawElement {
  return {
    id,
    type,
    x,
    y,
    width: w,
    height: h,
    angle: 0,
    strokeColor: DEFAULT_STROKE,
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: Math.floor(Math.random() * 2 ** 31),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
  };
}

/** strokeColor/backgroundColor/fillStyle for a shape. A flat-filled shape (see
 * `filled` in model/types.ts) paints its color into the background and hides the
 * stroke entirely (mirrors svg.ts's `s.filled` branch, `stroke="none"`); an outlined
 * shape keeps a visible stroke and uses a low-opacity tint (or none) as background. */
function shapeColors(s: {
  color?: string;
  filled?: boolean;
}): { strokeColor: string; backgroundColor: string; fillStyle: ExcalidrawElement['fillStyle'] } {
  if (s.filled) {
    return { strokeColor: 'transparent', backgroundColor: s.color ?? FLAT_FILL_DEFAULT, fillStyle: 'solid' };
  }
  return {
    strokeColor: s.color ?? DEFAULT_STROKE,
    backgroundColor: s.color ? fillTint(s.color) : 'transparent',
    fillStyle: 'solid',
  };
}

/** Text color for a shape's caption / a standalone text shape, mirroring svg.ts's
 * `labelColor` computation (its theme-dependent defaults collapse to the one
 * theme-agnostic default this file uses everywhere, `DEFAULT_STROKE`). */
function labelColorFor(s: Shape): string {
  if (s.filled) return readableTextColor(s.color ?? FLAT_FILL_DEFAULT);
  return s.color ?? DEFAULT_STROKE;
}

function dataUrlMime(dataUrl: string): string {
  const m = /^data:([^;,]+)/.exec(dataUrl);
  return m ? m[1] : 'image/png';
}

/** For each shape, the innermost frame shape (by area) whose rect contains its
 * center — same containment test as `frameContainedIds` in model/doc.ts, just
 * queried per-shape instead of expanded outward from a starting set. This is a
 * courtesy for Excalidraw's own frame-drag UX; Pochi itself never stores it (see
 * file header). */
function computeFrameIds(doc: Doc): Map<string, string> {
  const frames = doc.shapes.filter((s) => s.kind === 'frame');
  const map = new Map<string, string>();
  for (const s of doc.shapes) {
    const cx = s.x + s.w / 2;
    const cy = s.y + s.h / 2;
    let best: Shape | undefined;
    for (const f of frames) {
      if (f.id === s.id) continue;
      if (cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h) {
        if (!best || f.w * f.h < best.w * best.h) best = f;
      }
    }
    if (best) map.set(s.id, best.id);
  }
  return map;
}

function labelTextElement(
  id: string,
  containerId: string | null,
  center: Pt,
  label: string,
  fontSize: FontSize | undefined,
  color: string,
): ExcalidrawElement {
  const px = FONT_SIZE_PX[fontSize ?? 'm'];
  // Excalidraw recomputes a bound text element's exact box from its container on
  // load; this is just a reasonable initial guess so the file is sane even if opened
  // by something that doesn't recompute it.
  const w = Math.max(20, label.length * px * 0.6);
  const h = px * 1.25;
  return {
    ...baseFields(id, 'text', center.x - w / 2, center.y - h / 2, w, h),
    text: label,
    fontSize: px,
    fontFamily: FONT_FAMILY_HELVETICA,
    textAlign: 'center',
    verticalAlign: 'middle',
    lineHeight: 1.25,
    containerId,
    strokeColor: color,
    // Only kinds Excalidraw itself recognizes as text containers (rectangle/ellipse/
    // diamond) get a real `containerId` binding; for everything else this free text
    // element is tagged so `excalidrawToDoc` can still merge it back into the right
    // shape's `label` on import.
    customData: containerId ? undefined : { pochiLabelFor: id.slice(0, id.lastIndexOf('#')) },
  };
}

function shapeToElements(
  s: Shape,
  frameId: string | null,
  boundArrows: Array<{ id: string; type: string }> | undefined,
): { elements: ExcalidrawElement[]; file?: ExcalidrawFile['files'][string] } {
  const labelId = `${s.id}#text`;
  const hasLabel = !!s.label && s.kind !== 'text' && s.kind !== 'frame';
  const isOfficialContainer = s.kind === 'rect' || s.kind === 'ellipse' || s.kind === 'diamond';
  const boundElements = [
    ...(boundArrows ?? []),
    ...(hasLabel && isOfficialContainer ? [{ id: labelId, type: 'text' }] : []),
  ];
  const base = {
    ...baseFields(s.id, 'rectangle', s.x, s.y, s.w, s.h),
    ...shapeColors(s),
    strokeWidth: EXCALIDRAW_STROKE_WIDTH[s.strokeWidth ?? 'm'],
    strokeStyle: (s.dashed ? 'dashed' : 'solid') as ExcalidrawElement['strokeStyle'],
    groupIds: s.groupId ? [s.groupId] : [],
    frameId,
    boundElements: boundElements.length ? boundElements : null,
  };

  let el: ExcalidrawElement;
  let file: ExcalidrawFile['files'][string] | undefined;

  switch (s.kind) {
    case 'rect':
      el = { ...base, type: 'rectangle', roundness: { type: 3 } };
      break;
    case 'ellipse':
      el = { ...base, type: 'ellipse' };
      break;
    case 'diamond':
      el = { ...base, type: 'diamond' };
      break;
    case 'frame':
      el = { ...base, type: 'frame', name: s.label || null, boundElements: null };
      break;
    case 'image': {
      const fileId = `${s.id}#img`;
      el = { ...base, type: 'image', fileId: s.src ? fileId : null, status: 'saved', scale: [1, 1] };
      if (s.src) file = { id: fileId, mimeType: dataUrlMime(s.src), dataURL: s.src, created: Date.now() };
      break;
    }
    case 'freedraw': {
      const rel: Array<[number, number]> = freedrawPoints(s).map((p) => [p.x - s.x, p.y - s.y]);
      el = {
        ...base,
        type: 'freedraw',
        backgroundColor: 'transparent',
        points: rel,
        pressures: [],
        simulatePressure: true,
        lastCommittedPoint: rel.length ? rel[rel.length - 1] : null,
      };
      break;
    }
    case 'triangle': {
      const verts = triangleVertices(s);
      const rel: Array<[number, number]> = [...verts, verts[0]].map((p) => [p.x - s.x, p.y - s.y]);
      el = {
        ...base,
        type: 'line',
        points: rel,
        lastCommittedPoint: rel[rel.length - 1],
        customData: { pochiDirection: s.direction ?? 'up' },
      };
      break;
    }
    default: {
      // 'text'
      const px = FONT_SIZE_PX[s.fontSize ?? 'm'];
      el = {
        ...base,
        type: 'text',
        text: s.label,
        fontSize: px,
        fontFamily: FONT_FAMILY_HELVETICA,
        textAlign: 'center',
        verticalAlign: 'middle',
        lineHeight: 1.25,
        containerId: null,
        strokeColor: labelColorFor(s),
        backgroundColor: 'transparent',
      };
    }
  }

  const elements = [el];
  if (hasLabel) {
    elements.push(
      labelTextElement(
        labelId,
        isOfficialContainer ? s.id : null,
        labelCenter(s),
        s.label,
        s.fontSize,
        labelColorFor(s),
      ),
    );
  }
  return { elements, file };
}

function connectorToElements(doc: Doc, c: Connector): ExcalidrawElement[] {
  const path = connectorPath(doc, c);
  const x = path[0].x;
  const y = path[0].y;
  const rel: Array<[number, number]> = path.map((p) => [p.x - x, p.y - y]);
  const xs = rel.map((p) => p[0]);
  const ys = rel.map((p) => p[1]);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  const labelId = `${c.id}#text`;
  const hasLabel = !!c.label;

  const customData: Record<string, unknown> = {};
  if (c.routing) customData.pochiRouting = c.routing;
  if (c.elbowRatio !== undefined) customData.pochiElbowRatio = c.elbowRatio;
  if (c.waypoints && c.waypoints.length) customData.pochiWaypoints = true;

  const dir = c.arrowDirection;
  const startArrowhead = dir === 'start' || dir === 'both' ? 'arrow' : null;
  const endArrowhead = dir === 'none' ? null : 'arrow'; // undefined/'end'/'both' all show the default end arrowhead

  const arrow: ExcalidrawElement = {
    ...baseFields(c.id, 'arrow', x, y, width, height),
    strokeColor: c.color ?? DEFAULT_STROKE,
    strokeWidth: EXCALIDRAW_STROKE_WIDTH[c.strokeWidth ?? 'm'],
    strokeStyle: c.dashed ? 'dashed' : 'solid',
    groupIds: c.groupId ? [c.groupId] : [],
    boundElements: hasLabel ? [{ id: labelId, type: 'text' }] : null,
    points: rel,
    lastCommittedPoint: rel.length ? rel[rel.length - 1] : null,
    startBinding: c.from.shapeId ? { elementId: c.from.shapeId, focus: 0, gap: 4 } : null,
    endBinding: c.to.shapeId ? { elementId: c.to.shapeId, focus: 0, gap: 4 } : null,
    startArrowhead,
    endArrowhead,
    elbowed: false,
    customData: Object.keys(customData).length ? customData : undefined,
  };

  const elements = [arrow];
  if (hasLabel) {
    elements.push(
      labelTextElement(labelId, c.id, connectorLabelPos(doc, c), c.label, c.fontSize, c.color ?? DEFAULT_STROKE),
    );
  }
  return elements;
}

/** Serializes `doc` as a complete `.excalidraw` scene: every shape and connector
 * becomes one or more Excalidraw elements (see file header for the per-kind mapping),
 * image data URLs are lifted into the top-level `files` map Excalidraw expects, and
 * pass-through ids mean bindings need no remapping. Pure/sync, never fails. */
export function docToExcalidraw(doc: Doc): ExcalidrawFile {
  const frameIdOf = computeFrameIds(doc);
  const boundOf = new Map<string, Array<{ id: string; type: string }>>();
  for (const c of doc.connectors) {
    for (const shapeId of [c.from.shapeId, c.to.shapeId]) {
      if (!shapeId) continue;
      const list = boundOf.get(shapeId);
      if (list) list.push({ id: c.id, type: 'arrow' });
      else boundOf.set(shapeId, [{ id: c.id, type: 'arrow' }]);
    }
  }

  const elements: ExcalidrawElement[] = [];
  const files: ExcalidrawFile['files'] = {};
  for (const s of doc.shapes) {
    const built = shapeToElements(s, frameIdOf.get(s.id) ?? null, boundOf.get(s.id));
    elements.push(...built.elements);
    if (built.file) files[built.file.id] = built.file;
  }
  for (const c of doc.connectors) elements.push(...connectorToElements(doc, c));

  return {
    type: 'excalidraw',
    version: 2,
    source: SOURCE_URL,
    elements,
    appState: { viewBackgroundColor: '#ffffff', gridSize: null },
    files,
  };
}

function isElement(e: unknown): e is ExcalidrawElement {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.type === 'string' &&
    typeof o.x === 'number' &&
    typeof o.y === 'number' &&
    typeof o.width === 'number' &&
    typeof o.height === 'number'
  );
}

function strokeColorToPochi(hex: unknown): string | undefined {
  if (typeof hex !== 'string') return undefined;
  const v = hex.toLowerCase();
  if (v === 'transparent' || v === DEFAULT_STROKE) return undefined;
  return /^#[0-9a-f]{6}$/.test(v) ? v : undefined;
}

function backgroundColorToPochi(hex: unknown): string | undefined {
  if (typeof hex !== 'string') return undefined;
  const v = hex.toLowerCase();
  if (v === 'transparent' || v === FLAT_FILL_DEFAULT.toLowerCase()) return undefined;
  return /^#[0-9a-f]{6}$/.test(v) ? v : undefined;
}

/** Inverse of `shapeColors`: `strokeColor: 'transparent'` is how this codec (and
 * Excalidraw's own "solid fill, no outline" style) marks a flat-filled shape, so the
 * real color lives in `backgroundColor` in that case, `strokeColor` otherwise. */
function colorAndFillOf(el: ExcalidrawElement): { color: string | undefined; filled: boolean | undefined } {
  if (el.strokeColor === 'transparent') return { color: backgroundColorToPochi(el.backgroundColor), filled: true };
  return { color: strokeColorToPochi(el.strokeColor), filled: undefined };
}

/** Nearest FontSize bucket ('s'/'m'/'l') for a raw Excalidraw fontSize in px;
 * undefined (Shape's implicit 'm' default) when it's already closest to 'm'. */
function bucketFontSize(px: unknown): FontSize | undefined {
  if (typeof px !== 'number') return undefined;
  let best: FontSize = 'm';
  let bestErr = Infinity;
  for (const size of ['s', 'm', 'l'] as FontSize[]) {
    const err = Math.abs(FONT_SIZE_PX[size] - px);
    if (err < bestErr) {
      bestErr = err;
      best = size;
    }
  }
  return best === 'm' ? undefined : best;
}

function firstGroupId(groupIds: unknown): string | undefined {
  if (!Array.isArray(groupIds) || !groupIds.length) return undefined;
  // Excalidraw appends newly-created (outer) groups to the end of the array; the
  // last entry is the most recently grouped-together set, the closest match to
  // Pochi's single flat groupId for a simple (non-nested) selection.
  const last = groupIds[groupIds.length - 1];
  return typeof last === 'string' ? last : undefined;
}

function pointsToAbsolute(el: ExcalidrawElement): Pt[] {
  const pts = Array.isArray(el.points) && el.points.length ? el.points : [[0, 0] as [number, number], [el.width, el.height] as [number, number]];
  return pts.map((p) => ({ x: el.x + p[0], y: el.y + p[1] }));
}

/** Reconstructs a triangle's apex direction: exactly from `customData.pochiDirection`
 * for a Pochi-authored file, or a best-fit guess against the 8 candidate directions
 * (mirrors classifyStroke's approach in model/sketch.ts) for a foreign closed 3-point
 * `line` element. Returns null for anything that isn't a closed 3-point polygon. */
function triangleDirectionOf(el: ExcalidrawElement): TriangleDirection | null {
  const custom = el.customData?.pochiDirection;
  if (typeof custom === 'string' && (ALL_TRIANGLE_DIRECTIONS as string[]).includes(custom)) {
    return custom as TriangleDirection;
  }
  const pts = el.points;
  if (!Array.isArray(pts) || pts.length !== 4) return null;
  const [p0, , , p3] = pts;
  if (Math.abs(p0[0] - p3[0]) > 0.5 || Math.abs(p0[1] - p3[1]) > 0.5) return null;
  const verts = pts.slice(0, 3).map(([px, py]) => ({ x: el.x + px, y: el.y + py }));
  let best: TriangleDirection = 'up';
  let bestErr = Infinity;
  for (const direction of ALL_TRIANGLE_DIRECTIONS) {
    const cand = triangleVertices({ x: el.x, y: el.y, w: el.width, h: el.height, direction });
    let err = 0;
    for (const p of verts) err += Math.min(...cand.map((q) => Math.hypot(p.x - q.x, p.y - q.y)));
    if (err < bestErr) {
      bestErr = err;
      best = direction;
    }
  }
  return best;
}

function elementToShape(
  el: ExcalidrawElement,
  boundText: ExcalidrawElement | undefined,
  files: Record<string, { dataURL?: unknown }>,
): Shape | null {
  const id = el.id;
  const x = el.x;
  const y = el.y;
  const w = Math.max(1, Math.round(el.width));
  const h = Math.max(1, Math.round(el.height));
  const label = typeof boundText?.text === 'string' ? boundText.text : '';
  const fontSize = boundText ? bucketFontSize(boundText.fontSize) : undefined;
  const groupId = firstGroupId(el.groupIds);
  const { color, filled } = colorAndFillOf(el);

  switch (el.type) {
    case 'rectangle':
      return { id, kind: 'rect', x, y, w, h, label, color, filled, fontSize, groupId };
    case 'ellipse':
      return { id, kind: 'ellipse', x, y, w, h, label, color, filled, fontSize, groupId };
    case 'diamond':
      return { id, kind: 'diamond', x, y, w, h, label, color, filled, fontSize, groupId };
    case 'frame':
      return {
        id,
        kind: 'frame',
        x,
        y,
        w,
        h,
        label: typeof el.name === 'string' ? el.name : '',
        color,
        filled,
        groupId,
      };
    case 'image': {
      const fileId = typeof el.fileId === 'string' ? el.fileId : undefined;
      const dataUrl = fileId ? files[fileId]?.dataURL : undefined;
      if (typeof dataUrl !== 'string') return null; // no embedded pixels to import - drop rather than make a blank image
      return { id, kind: 'image', x, y, w, h, label, color, src: dataUrl, groupId };
    }
    case 'freedraw': {
      const stroke = strokeToFreedraw(pointsToAbsolute(el));
      if (!stroke) return null;
      return { id, kind: 'freedraw', ...stroke, label, color, groupId };
    }
    case 'line': {
      const direction = triangleDirectionOf(el);
      if (!direction) return null; // not a closed 3-point polygon we can read as a triangle
      return { id, kind: 'triangle', x, y, w, h, label, color, filled, fontSize, groupId, direction };
    }
    default:
      return null; // unsupported Excalidraw element kind (embeddable, iframe, magicframe, selection...)
  }
}

function elementToConnector(el: ExcalidrawElement, boundText: ExcalidrawElement | undefined): Connector {
  const pts = pointsToAbsolute(el);
  const first = pts[0] ?? { x: el.x, y: el.y };
  const last = pts[pts.length - 1] ?? first;
  const from: Endpoint = { x: first.x, y: first.y, shapeId: el.startBinding?.elementId };
  const to: Endpoint = { x: last.x, y: last.y, shapeId: el.endBinding?.elementId };

  const custom = el.customData ?? {};
  const isOwn = 'pochiRouting' in custom || 'pochiElbowRatio' in custom || 'pochiWaypoints' in custom;
  const routing =
    isOwn && (custom.pochiRouting === 'straight' || custom.pochiRouting === 'orthogonal')
      ? (custom.pochiRouting as 'straight' | 'orthogonal')
      : undefined;
  const elbowRatio = isOwn && typeof custom.pochiElbowRatio === 'number' ? custom.pochiElbowRatio : undefined;
  // A Pochi-authored arrow only carries manual waypoints when explicitly flagged;
  // a genuinely foreign multi-point arrow has no such flag, so its extra points are
  // read back as manual waypoints instead — the closest available approximation.
  const wantsWaypoints = isOwn ? custom.pochiWaypoints === true : true;
  const waypoints = pts.length > 2 && wantsWaypoints ? pts.slice(1, -1) : undefined;

  const startHead = el.startArrowhead ?? null;
  const endHead = el.endArrowhead ?? null;
  const arrowDirection: ArrowDirection | undefined = startHead && endHead ? 'both' : startHead ? 'start' : !endHead ? 'none' : undefined;

  return {
    id: el.id,
    from,
    to,
    label: typeof boundText?.text === 'string' ? boundText.text : '',
    color: strokeColorToPochi(el.strokeColor),
    routing,
    elbowRatio,
    waypoints,
    dashed: el.strokeStyle !== 'solid' ? true : undefined,
    arrowDirection,
    fontSize: boundText ? bucketFontSize(boundText.fontSize) : undefined,
    groupId: firstGroupId(el.groupIds),
  };
}

/** Inverse of `docToExcalidraw`. Accepts an already-`JSON.parse`d value (callers own
 * the file read). Returns `null` if `raw` isn't shaped like an Excalidraw scene at all
 * (wrong `type`, missing/non-array `elements`); an individual element that doesn't
 * parse into a Shape/Connector (e.g. an image with no matching `files` entry, or a
 * `line` that isn't a closed triangle) is silently dropped rather than failing the
 * whole import. Never throws. */
export function excalidrawToDoc(raw: unknown): Doc | null {
  try {
    if (!raw || typeof raw !== 'object') return null;
    const file = raw as { type?: unknown; elements?: unknown; files?: unknown };
    if (file.type !== 'excalidraw' || !Array.isArray(file.elements)) return null;
    const filesMap = (file.files && typeof file.files === 'object' ? file.files : {}) as Record<
      string,
      { dataURL?: unknown }
    >;

    const elements = (file.elements as unknown[]).filter(isElement).filter((e) => e.isDeleted !== true);
    const byId = new Map(elements.map((e) => [e.id, e]));

    // owner id (containerId, or the free-floating-label tag - see labelTextElement) for
    // each text element that's actually *someone else's* label, so the main pass below
    // can tell those apart from a real standalone 'text' shape.
    const ownerIdOf = (e: ExcalidrawElement): string | undefined =>
      (typeof e.containerId === 'string' && e.containerId) ||
      (typeof e.customData?.pochiLabelFor === 'string' && (e.customData.pochiLabelFor as string)) ||
      undefined;
    const boundTextByOwner = new Map<string, ExcalidrawElement>();
    for (const e of elements) {
      if (e.type !== 'text') continue;
      const ownerId = ownerIdOf(e);
      if (ownerId && byId.has(ownerId) && !boundTextByOwner.has(ownerId)) boundTextByOwner.set(ownerId, e);
    }

    // Single pass, in `elements` order, so a standalone 'text' shape lands at the same
    // relative position among `shapes` as it held in the source file (matters for a
    // byte-exact round trip of a Pochi-authored export, where element order mirrors
    // `doc.shapes` order).
    const shapes: Shape[] = [];
    const connectors: Connector[] = [];
    for (const e of elements) {
      if (e.type === 'text') {
        const ownerId = ownerIdOf(e);
        if (ownerId && byId.has(ownerId)) continue; // it's someone else's label, not its own shape
        const { color } = colorAndFillOf(e);
        shapes.push({
          id: e.id,
          kind: 'text',
          x: e.x,
          y: e.y,
          w: Math.max(1, Math.round(e.width)),
          h: Math.max(1, Math.round(e.height)),
          label: typeof e.text === 'string' ? e.text : '',
          color: e.strokeColor === 'transparent' ? color : strokeColorToPochi(e.strokeColor),
          fontSize: bucketFontSize(e.fontSize),
          groupId: firstGroupId(e.groupIds),
        });
        continue;
      }
      if (e.type === 'arrow') {
        connectors.push(elementToConnector(e, boundTextByOwner.get(e.id)));
        continue;
      }
      const shape = elementToShape(e, boundTextByOwner.get(e.id), filesMap);
      if (shape) shapes.push(shape);
    }
    return { shapes, connectors };
  } catch {
    return null;
  }
}
