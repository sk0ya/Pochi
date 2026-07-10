import {
  connectorPath,
  docBounds,
  FRAME_LABEL_PAD_X,
  FRAME_LABEL_PAD_Y,
  labelCenter,
  triangleVertices,
} from './doc';
import { fillTint, FLAT_FILL_DEFAULT, readableTextColor } from './palette';
import { FONT_LINE_H, FONT_SIZE_PX } from './types';
import type { Doc, FontSize, Shape } from './types';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const markerKey = (hex: string): string => hex.replace('#', '');

function labelSvg(
  label: string,
  x: number,
  y: number,
  color: string,
  fontSize?: FontSize,
  align: 'center' | 'start' = 'center',
): string {
  if (!label) return '';
  const lineH = FONT_LINE_H[fontSize ?? 'm'];
  const lines = label.split('\n');
  const startY = align === 'start' ? y : y - ((lines.length - 1) * lineH) / 2;
  const tspans = lines
    .map((line, i) => `<tspan x="${x}" y="${startY + i * lineH}">${esc(line)}</tspan>`)
    .join('');
  const anchor = align === 'start' ? 'start' : 'middle';
  const baseline = align === 'start' ? 'hanging' : 'middle';
  return `<text fill="${color}" font-family="system-ui, sans-serif" font-size="${FONT_SIZE_PX[fontSize ?? 'm']}" text-anchor="${anchor}" dominant-baseline="${baseline}">${tspans}</text>`;
}

/** Subdued default stroke for a frame (no explicit color) — matches the app's --muted
 * theme color, distinguishing it from the brighter #333a45 used by every other shape kind. */
const FRAME_STROKE_DEFAULT = '#8794a8';

/** Opacity for a filled frame's interior tint in the exported SVG (white light-theme
 * background). Chosen higher than the app canvas's FRAME_TINT_OPACITY_APP (Canvas.tsx) —
 * the same alpha reads lighter against white than against the app's dark background, so a
 * slightly stronger value keeps the tint visible without looking like a solid fill. */
const FRAME_TINT_OPACITY_SVG = 0.1;

function shapeSvg(s: Shape): string {
  if (s.kind === 'frame') {
    // Border only, no fill (mirrors the canvas: an open interior, subtly rounded) — plus an
    // optional low-opacity interior tint when `filled` is set (purely visual; SVG export has
    // no hit-testing to preserve, but this still matches the canvas's click-through look).
    const stroke = s.color ?? FRAME_STROKE_DEFAULT;
    const tint = s.filled
      ? `<rect x="${s.x + 1.5}" y="${s.y + 1.5}" width="${Math.max(s.w - 3, 0)}" height="${Math.max(s.h - 3, 0)}" rx="7" fill="${stroke}" fill-opacity="${FRAME_TINT_OPACITY_SVG}" stroke="none"/>`
      : '';
    const body = `${tint}<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="8" fill="none" stroke="${stroke}" stroke-width="1.5"/>`;
    const labelColor = s.color ?? FRAME_STROKE_DEFAULT;
    return (
      body +
      labelSvg(s.label, s.x + FRAME_LABEL_PAD_X, s.y + FRAME_LABEL_PAD_Y, labelColor, s.fontSize, 'start')
    );
  }
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  const stroke = s.color ?? '#333a45';
  const style = s.filled
    ? `fill="${s.color ?? FLAT_FILL_DEFAULT}" stroke="none"`
    : `fill="${s.color ? fillTint(s.color) : '#ffffff'}" stroke="${stroke}" stroke-width="1.5"`;
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
  } else if (s.kind === 'image' && s.src) {
    body = `<image href="${esc(s.src)}" x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" preserveAspectRatio="xMidYMid slice"/>`;
  }
  const labelColor = s.filled
    ? readableTextColor(s.color ?? FLAT_FILL_DEFAULT)
    : s.kind === 'text'
      ? s.color ?? '#222933'
      : '#222933';
  const labelPos = labelCenter(s);
  return body + labelSvg(s.label, labelPos.x, labelPos.y, labelColor, s.fontSize);
}

function markerDef(id: string, hex: string): string {
  return `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${hex}"/></marker>`;
}

const PAD = 24;

/** Padded viewport of the SVG that exportSvg produces for `doc` (viewBox origin + pixel size). */
export function exportViewport(doc: Doc): { x: number; y: number; w: number; h: number } {
  const b = docBounds(doc) ?? { x: 0, y: 0, w: 200, h: 100 };
  return { x: b.x - PAD, y: b.y - PAD, w: b.w + PAD * 2, h: b.h + PAD * 2 };
}

export function exportSvg(doc: Doc): string {
  const { x, y, w, h } = exportViewport(doc);

  const connectorColors = Array.from(new Set(doc.connectors.map((c) => c.color).filter((v): v is string => !!v)));

  const parts: string[] = [];
  for (const s of doc.shapes) parts.push(shapeSvg(s));
  for (const c of doc.connectors) {
    const path = connectorPath(doc, c);
    const stroke = c.color ?? '#333a45';
    const markerId = c.color ? `arrow-${markerKey(c.color)}` : 'arrow';
    const points = path.map((p) => `${p.x},${p.y}`).join(' ');
    const arrowDir = c.arrowDirection ?? 'end';
    const dashAttr = c.dashed ? ' stroke-dasharray="6 4"' : '';
    const markerStartAttr = arrowDir === 'start' || arrowDir === 'both' ? ` marker-start="url(#${markerId})"` : '';
    const markerEndAttr = arrowDir === 'end' || arrowDir === 'both' ? ` marker-end="url(#${markerId})"` : '';
    parts.push(
      `<polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"${dashAttr}${markerStartAttr}${markerEndAttr}/>`,
    );
    if (c.label) {
      const mid = path[Math.floor((path.length - 1) / 2)];
      const midNext = path[Math.floor((path.length - 1) / 2) + 1] ?? mid;
      const mx = (mid.x + midNext.x) / 2;
      const my = (mid.y + midNext.y) / 2 - 10;
      parts.push(labelSvg(c.label, mx, my, c.color ?? '#4a5568', c.fontSize));
    }
  }

  const markers = [
    markerDef('arrow', '#333a45'),
    ...connectorColors.map((hex) => markerDef(`arrow-${markerKey(hex)}`, hex)),
  ].join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}" font-family="system-ui, sans-serif">`,
    `<defs>${markers}</defs>`,
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#ffffff"/>`,
    ...parts,
    `</svg>`,
  ].join('\n');
}
