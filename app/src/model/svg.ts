import { connectorPath, docBounds, triangleVertices } from './doc';
import { fillTint, STICKY_DEFAULT } from './palette';
import type { Doc, Shape } from './types';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const markerKey = (hex: string): string => hex.replace('#', '');

const LINE_H = 20;

function labelSvg(label: string, cx: number, cy: number, color: string): string {
  if (!label) return '';
  const lines = label.split('\n');
  const startY = cy - ((lines.length - 1) * LINE_H) / 2;
  const tspans = lines
    .map((line, i) => `<tspan x="${cx}" y="${startY + i * LINE_H}">${esc(line)}</tspan>`)
    .join('');
  return `<text fill="${color}" font-family="system-ui, sans-serif" font-size="14" text-anchor="middle" dominant-baseline="middle">${tspans}</text>`;
}

function shapeSvg(s: Shape): string {
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  const stroke = s.color ?? '#333a45';
  const fill = s.color ? fillTint(s.color) : '#ffffff';
  const style = `fill="${fill}" stroke="${stroke}" stroke-width="1.5"`;
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
  } else if (s.kind === 'sticky') {
    body = `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="${s.color ?? STICKY_DEFAULT}"/>`;
  } else if (s.kind === 'image' && s.src) {
    body = `<image href="${esc(s.src)}" x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" preserveAspectRatio="xMidYMid slice"/>`;
  }
  const labelColor = s.kind === 'text' || s.kind === 'sticky' ? s.color ?? '#222933' : '#222933';
  return body + labelSvg(s.label, cx, cy, labelColor);
}

function markerDef(id: string, hex: string): string {
  return `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${hex}"/></marker>`;
}

export function exportSvg(doc: Doc): string {
  const PAD = 24;
  const b = docBounds(doc) ?? { x: 0, y: 0, w: 200, h: 100 };
  const x = b.x - PAD;
  const y = b.y - PAD;
  const w = b.w + PAD * 2;
  const h = b.h + PAD * 2;

  const connectorColors = Array.from(new Set(doc.connectors.map((c) => c.color).filter((v): v is string => !!v)));

  const parts: string[] = [];
  for (const s of doc.shapes) parts.push(shapeSvg(s));
  for (const c of doc.connectors) {
    const path = connectorPath(doc, c);
    const stroke = c.color ?? '#333a45';
    const markerId = c.color ? `arrow-${markerKey(c.color)}` : 'arrow';
    const points = path.map((p) => `${p.x},${p.y}`).join(' ');
    parts.push(
      `<polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" marker-end="url(#${markerId})"/>`,
    );
    if (c.label) {
      const mid = path[Math.floor((path.length - 1) / 2)];
      const midNext = path[Math.floor((path.length - 1) / 2) + 1] ?? mid;
      const mx = (mid.x + midNext.x) / 2;
      const my = (mid.y + midNext.y) / 2 - 10;
      parts.push(labelSvg(c.label, mx, my, c.color ?? '#4a5568'));
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
