import {
  connectorLabelPos,
  connectorPath,
  docBounds,
  FRAME_LABEL_PAD_X,
  freedrawPathD,
  FRAME_LABEL_PAD_Y,
  labelCenter,
  triangleVertices,
} from './doc';
import { fillTint, FLAT_FILL_DEFAULT, readableTextColor } from './palette';
import { FONT_LINE_H, FONT_SIZE_PX, STROKE_WIDTH_BASE } from './types';
import type { Doc, FontSize, Shape } from './types';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const markerKey = (hex: string): string => hex.replace('#', '');

export type ExportTheme = 'light' | 'dark';

/** Resolved colors for one export theme. The app canvas renders with CSS variables
 * (styles.css :root), but an exported SVG must be self-contained, so each theme
 * carries concrete hex values: `light` is the historical export look (white paper
 * for pasting into documents); `dark` mirrors the app canvas's variables so the
 * export matches what the user sees while editing. */
interface ThemeColors {
  bg: string;
  /** Default stroke + arrow marker for shapes/connectors with no explicit color. */
  stroke: string;
  /** Background of an unfilled, uncolored shape (canvas: --shape-fill). */
  shapeFill: string;
  /** Default label color (canvas: --shape-text). */
  text: string;
  /** Default connector-label color (canvas: --muted). */
  connectorLabel: string;
  /** Default frame stroke/label — matches --muted in both themes, so frames keep
   * reading as quiet containers next to the brighter default shape stroke. */
  frameStroke: string;
  /** Opacity of a filled frame's interior tint. The same alpha reads lighter against
   * white than against a dark background, so light uses a slightly stronger value
   * while dark matches the app canvas (Canvas.tsx FRAME_TINT_OPACITY_APP). */
  frameTintOpacity: number;
}

const THEMES: Record<ExportTheme, ThemeColors> = {
  light: {
    bg: '#ffffff',
    stroke: '#333a45',
    shapeFill: '#ffffff',
    text: '#222933',
    connectorLabel: '#4a5568',
    frameStroke: '#8794a8',
    frameTintOpacity: 0.1,
  },
  dark: {
    bg: '#12151a',
    stroke: '#a9b7d0',
    shapeFill: '#202839',
    text: '#dbe2ee',
    connectorLabel: '#8794a8',
    frameStroke: '#8794a8',
    frameTintOpacity: 0.16,
  },
};

function labelSvg(
  label: string,
  x: number,
  y: number,
  color: string,
  fontSize?: FontSize,
  anchor: 'middle' | 'start' | 'end' = 'middle',
  baseline: 'middle' | 'hanging' = 'middle',
): string {
  if (!label) return '';
  const lineH = FONT_LINE_H[fontSize ?? 'm'];
  const lines = label.split('\n');
  const startY = baseline === 'hanging' ? y : y - ((lines.length - 1) * lineH) / 2;
  const tspans = lines
    .map((line, i) => `<tspan x="${x}" y="${startY + i * lineH}">${esc(line)}</tspan>`)
    .join('');
  return `<text fill="${color}" font-family="system-ui, sans-serif" font-size="${FONT_SIZE_PX[fontSize ?? 'm']}" text-anchor="${anchor}" dominant-baseline="${baseline}">${tspans}</text>`;
}

function shapeSvg(s: Shape, t: ThemeColors): string {
  if (s.kind === 'frame') {
    // Border only, no fill (mirrors the canvas: an open interior, subtly rounded) — plus an
    // optional low-opacity interior tint when `filled` is set (purely visual; SVG export has
    // no hit-testing to preserve, but this still matches the canvas's click-through look).
    const stroke = s.color ?? t.frameStroke;
    const tint = s.filled
      ? `<rect x="${s.x + 1.5}" y="${s.y + 1.5}" width="${Math.max(s.w - 3, 0)}" height="${Math.max(s.h - 3, 0)}" rx="7" fill="${stroke}" fill-opacity="${t.frameTintOpacity}" stroke="none"/>`
      : '';
    const dashAttr = s.dashed ? ' stroke-dasharray="6 4"' : '';
    const body = `${tint}<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="8" fill="none" stroke="${stroke}" stroke-width="${STROKE_WIDTH_BASE[s.strokeWidth ?? 'm']}"${dashAttr}/>`;
    const labelColor = s.color ?? t.frameStroke;
    return (
      body +
      labelSvg(s.label, s.x + FRAME_LABEL_PAD_X, s.y + FRAME_LABEL_PAD_Y, labelColor, s.fontSize, 'start', 'hanging')
    );
  }
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  const stroke = s.color ?? t.stroke;
  const strokeWidth = STROKE_WIDTH_BASE[s.strokeWidth ?? 'm'];
  const style = s.filled
    ? `fill="${s.color ?? FLAT_FILL_DEFAULT}" stroke="none"`
    : `fill="${s.color ? fillTint(s.color) : t.shapeFill}" stroke="${stroke}" stroke-width="${strokeWidth}"${s.dashed ? ' stroke-dasharray="6 4"' : ''}`;
  let body = '';
  if (s.kind === 'rect') {
    body = `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="4" ${style}/>`;
  } else if (s.kind === 'ellipse') {
    body = `<ellipse cx="${cx}" cy="${cy}" rx="${s.w / 2}" ry="${s.h / 2}" ${style}/>`;
  } else if (s.kind === 'diamond') {
    const points = `${cx},${s.y} ${s.x + s.w},${cy} ${cx},${s.y + s.h} ${s.x},${cy}`;
    body = `<polygon points="${points}" ${style}/>`;
  } else if (s.kind === 'triangle') {
    const points = triangleVertices(s).map((p) => `${p.x},${p.y}`).join(' ');
    body = `<polygon points="${points}" ${style}/>`;
  } else if (s.kind === 'freedraw') {
    // Open stroke: never filled, `filled`/fill tint don't apply (mirrors the canvas).
    body = `<path d="${freedrawPathD(s)}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}"${s.dashed ? ' stroke-dasharray="6 4"' : ''} stroke-linecap="round" stroke-linejoin="round"/>`;
  } else if (s.kind === 'image' && s.src) {
    body = `<image href="${esc(s.src)}" x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" preserveAspectRatio="xMidYMid slice"/>`;
  }
  const labelColor = s.filled
    ? readableTextColor(s.color ?? FLAT_FILL_DEFAULT)
    : s.kind === 'text'
      ? s.color ?? t.text
      : t.text;
  const labelPos = labelCenter(s);
  return body + labelSvg(s.label, labelPos.x, labelPos.y, labelColor, s.fontSize);
}

function markerDef(id: string, hex: string): string {
  return `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${hex}"/></marker>`;
}

/** Background color exportSvg paints for `theme` — the PNG rasterizer's canvas backing
 * must be filled with the same color (see pngClipboard.ts). */
export const exportBackground = (theme: ExportTheme): string => THEMES[theme].bg;

const PAD = 24;

/** Padded viewport of the SVG that exportSvg produces for `doc` (viewBox origin + pixel size). */
export function exportViewport(doc: Doc): { x: number; y: number; w: number; h: number } {
  const b = docBounds(doc) ?? { x: 0, y: 0, w: 200, h: 100 };
  return { x: b.x - PAD, y: b.y - PAD, w: b.w + PAD * 2, h: b.h + PAD * 2 };
}

export function exportSvg(doc: Doc, theme: ExportTheme = 'light'): string {
  const t = THEMES[theme];
  const { x, y, w, h } = exportViewport(doc);

  const connectorColors = Array.from(new Set(doc.connectors.map((c) => c.color).filter((v): v is string => !!v)));

  const parts: string[] = [];
  for (const s of doc.shapes) parts.push(shapeSvg(s, t));
  for (const c of doc.connectors) {
    const path = connectorPath(doc, c);
    const stroke = c.color ?? t.stroke;
    const markerId = c.color ? `arrow-${markerKey(c.color)}` : 'arrow';
    const points = path.map((p) => `${p.x},${p.y}`).join(' ');
    const arrowDir = c.arrowDirection ?? 'end';
    const dashAttr = c.dashed ? ' stroke-dasharray="6 4"' : '';
    const markerStartAttr = arrowDir === 'start' || arrowDir === 'both' ? ` marker-start="url(#${markerId})"` : '';
    const markerEndAttr = arrowDir === 'end' || arrowDir === 'both' ? ` marker-end="url(#${markerId})"` : '';
    parts.push(
      `<polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="${STROKE_WIDTH_BASE[c.strokeWidth ?? 'm']}" stroke-linejoin="round"${dashAttr}${markerStartAttr}${markerEndAttr}/>`,
    );
    if (c.label) {
      const { x: mx, y: my, anchor } = connectorLabelPos(doc, c);
      parts.push(labelSvg(c.label, mx, my, c.color ?? t.connectorLabel, c.fontSize, anchor));
    }
  }

  const markers = [
    markerDef('arrow', t.stroke),
    ...connectorColors.map((hex) => markerDef(`arrow-${markerKey(hex)}`, hex)),
  ].join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}" font-family="system-ui, sans-serif">`,
    `<defs>${markers}</defs>`,
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${t.bg}"/>`,
    ...parts,
    `</svg>`,
  ].join('\n');
}
