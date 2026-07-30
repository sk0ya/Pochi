import type { IconAttribution } from './types';

const textEncoder = new TextEncoder();

/** Drag payload used only by the independent icon sidebar and the canvas drop target. */
export const ICON_DRAG_MIME = 'application/x-pochi-icon';
export const ICONIFY_API = 'https://api.iconify.design';

export type IconSetFilter = 'all' | 'devicon' | 'simple-icons';

interface IconifyInfo {
  name?: string;
  author?: { name?: string; url?: string };
  license?: { title?: string; spdx?: string; url?: string };
}

export interface IconSearchResult {
  icons: string[];
  total: number;
  collections: Record<string, IconifyInfo>;
}

function searchPrefix(filter: IconSetFilter): string {
  return filter === 'all' ? '' : `&prefix=${encodeURIComponent(filter)}`;
}

/** Search is intentionally remote: no icon collection is bundled into Pochi. */
export async function searchIcons(
  query: string,
  filter: IconSetFilter,
  signal?: AbortSignal,
): Promise<IconSearchResult> {
  const q = query.trim();
  if (!q) return { icons: [], total: 0, collections: {} };
  const response = await fetch(
    `${ICONIFY_API}/search?query=${encodeURIComponent(q)}&limit=64${searchPrefix(filter)}`,
    { signal },
  );
  if (!response.ok) throw new Error(`Iconify search failed (${response.status})`);
  const data = await response.json() as Partial<IconSearchResult>;
  return {
    icons: Array.isArray(data.icons) ? data.icons.filter((name): name is string => typeof name === 'string') : [],
    total: typeof data.total === 'number' ? data.total : 0,
    collections: data.collections && typeof data.collections === 'object' ? data.collections : {},
  };
}

export function attributionForIcon(
  iconName: string,
  collections: Record<string, IconifyInfo>,
): IconAttribution {
  const prefix = iconName.split(':')[0];
  const info = collections[prefix] ?? {};
  const safeUrl = (value?: string): string | undefined => {
    if (!value) return undefined;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    iconName,
    collection: prefix,
    collectionName: info.name || prefix,
    author: info.author?.name,
    authorUrl: safeUrl(info.author?.url),
    license: info.license?.spdx || info.license?.title,
    licenseUrl: safeUrl(info.license?.url),
    brand: prefix === 'devicon' || prefix === 'simple-icons',
  };
}

export interface IconDragPayload {
  iconName: string;
  attribution: IconAttribution;
}

export function encodeIconDrag(payload: IconDragPayload): string {
  return JSON.stringify(payload);
}

export function decodeIconDrag(value: string): IconDragPayload | null {
  try {
    const payload = JSON.parse(value) as Partial<IconDragPayload>;
    return typeof payload.iconName === 'string' && payload.attribution?.iconName === payload.iconName
      ? payload as IconDragPayload
      : null;
  } catch {
    return null;
  }
}

export function iconAttributionTooltip(attribution: IconAttribution): string {
  return [
    `アイコン: ${attribution.iconName}`,
    `セット: ${attribution.collectionName}`,
    attribution.author ? `作者: ${attribution.author}` : undefined,
    `ライセンス: ${attribution.license ?? '不明（要確認）'}`,
    '取得元: Iconify',
    attribution.brand ? '※ 商標・ブランド利用規約も適用されます' : undefined,
  ].filter((line): line is string => !!line).join('\n');
}

export function iconSvgUrl(iconName: string): string {
  const [prefix, ...nameParts] = iconName.split(':');
  const name = nameParts.join(':');
  if (!prefix || !name || !/^[a-z0-9-]+$/.test(prefix) || !/^[a-z0-9-]+$/.test(name)) return '';
  return `${ICONIFY_API}/${prefix}/${name}.svg?color=%2364748b`;
}

function sanitizeSvg(raw: string): string {
  const doc = new DOMParser().parseFromString(raw, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) {
    throw new Error('Invalid SVG returned by Iconify');
  }
  doc.querySelectorAll('script, foreignObject').forEach((node) => node.remove());
  for (const element of Array.from(root.querySelectorAll('*'))) {
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith('on') || value.startsWith('javascript:')) element.removeAttribute(attr.name);
      if ((name === 'href' || name === 'xlink:href') && /^(https?:|\/\/)/.test(value)) {
        element.removeAttribute(attr.name);
      }
    }
  }
  root.removeAttribute('width');
  root.removeAttribute('height');
  return new XMLSerializer().serializeToString(root);
}

/** Percent-escapes only what a `data:image/svg+xml,` body actually requires: `%` (the escape
 * introducer itself, hence first), `#` (would otherwise start a URL fragment and truncate the
 * icon), and any non-ASCII character (so the body survives as plain ASCII regardless of how
 * the URL is later transported).
 *
 * Deliberately leaves `<`, `>`, `"`, `&` and spaces raw — all legal in a data URL body, and an
 * SVG is mostly made of them. `encodeURIComponent` escapes those plus `/`, `=`, `:`, `;` and
 * `,`, tripling each to three characters and inflating a stored icon to ~1.7x its source SVG;
 * this brings that down to ~1.05x. The one place a `src` is re-embedded into markup (the SVG
 * export in model/svg.ts) XML-escapes it there, and everywhere else it is assigned to a DOM
 * `href`/`src` property, which does no markup parsing. */
export function escapeSvgDataUrl(svg: string): string {
  return svg.replace(/[%#]|[^\x20-\x7E]/g, (c) => {
    let out = '';
    for (const byte of textEncoder.encode(c)) out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    return out;
  });
}

/** Fetch and embed the actual SVG. Saved documents never depend on this URL afterwards. */
export async function fetchIconDataUrl(iconName: string, signal?: AbortSignal): Promise<string> {
  const url = iconSvgUrl(iconName);
  if (!url) throw new Error('Invalid Iconify icon name');
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Iconify icon fetch failed (${response.status})`);
  const svg = sanitizeSvg(await response.text());
  return `data:image/svg+xml,${escapeSvgDataUrl(svg)}`;
}
