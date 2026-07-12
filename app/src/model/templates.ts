import type { Connector, Shape } from './types';

/** Custom drag-and-drop MIME type the sidebar (drag source) and Canvas (drop target) agree on
 * to identify "a template id is being dragged" — see TemplateSidebar.tsx / Canvas.tsx. */
export const TEMPLATE_DRAG_MIME = 'application/x-pochi-template';

/** A themed group of stamps sharing one icon in the insert picker (e.g. "自然" for tree, cloud,
 * sun, ...). Data lives at `../templates/<categoryId>/category.json`. */
export interface Category {
  id: string;
  name: string;
  icon: string;
}

/** A reusable stamp: shapes and line-connectors laid out in local coordinates around a small
 * origin. Insertion (see INSERT_TEMPLATE in reducer.ts) clones every shape/connector with fresh
 * ids, remaps their shared `groupId` to a fresh one so the stamp lands as a single group, and
 * offsets local coordinates to center on the insertion point — the same remap machinery
 * pasteClipboard uses for a copy/paste. `id` and `groupId` in the source data only need to be
 * unique *within* a template (they exist solely to link shapes to each other before that
 * remap), not across templates or across repeated insertions of the same one.
 *
 * The actual shape/connector data lives in `../templates/<categoryId>/<n>.json`, not here —
 * adding a stamp to an existing category is just dropping in a new numbered data file (no icon
 * needed there, the category owns it; no TypeScript required). A brand new category needs a
 * sibling `category.json` (id/name/icon) alongside its first numbered file. Array order within
 * a data file is draw (z-)order, earlier = further back (see town/1.json, where the wall is
 * listed before the roof so the roof's sloped edges paint over — not under — the wall's
 * overlapping top corners). Deliberately line-heavy rather than box-heavy: a plain
 * (arrowDirection: 'none') connector reads as a hand-drawn stroke, so most structure (limbs, a
 * trunk) is a line instead of a boxy rect. */
export interface Template {
  id: string;
  categoryId: string;
  name: string;
  shapes: Shape[];
  connectors: Connector[];
}

interface RawTemplate {
  name: string;
  shapes: Shape[];
  connectors: Connector[];
}

/** Explicit category order for the insert picker. Loading is glob-based (see below) so file
 * discovery order isn't meaningful (just folder-name-alphabetical) — this is the actual order. */
const ORDER = [
  'people',
  'nature',
  'town',
  'device',
  'dev',
  'office',
  'symbol',
  'award',
  'life',
];

function isCategory(v: unknown): v is Category {
  const c = v as Partial<Category> | null;
  return !!c && typeof c.id === 'string' && typeof c.name === 'string' && typeof c.icon === 'string';
}

function isRawTemplate(v: unknown): v is RawTemplate {
  const t = v as Partial<RawTemplate> | null;
  return !!t && typeof t.name === 'string' && Array.isArray(t.shapes) && Array.isArray(t.connectors);
}

/** The `<categoryId>` segment of a `../templates/<categoryId>/<file>` glob path (Vite always
 * keys globs with forward slashes, regardless of OS). */
function categoryIdOf(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 2];
}

const categoryModules = import.meta.glob<unknown>('../templates/*/category.json', { eager: true, import: 'default' });
const categoryById = new Map<string, Category>();
for (const [path, data] of Object.entries(categoryModules)) {
  if (!isCategory(data)) throw new Error(`malformed category data: ${path}`);
  categoryById.set(data.id, data);
}

export const CATEGORIES: Category[] = ORDER.map((id) => {
  const cat = categoryById.get(id);
  if (!cat) throw new Error(`missing category data file for "${id}"`);
  return cat;
});

const templateModules = import.meta.glob<unknown>('../templates/*/*.json', { eager: true, import: 'default' });
const templates: Template[] = [];
for (const [path, data] of Object.entries(templateModules)) {
  if (path.endsWith('/category.json')) continue;
  if (!isRawTemplate(data)) throw new Error(`malformed template data: ${path}`);
  const categoryId = categoryIdOf(path);
  const n = path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/, '');
  templates.push({ id: `${categoryId}-${n}`, categoryId, name: data.name, shapes: data.shapes, connectors: data.connectors });
}
// Grouped by category in ORDER (not categoryId-alphabetical — that's just glob-discovery
// order and unrelated to display order), numeric-aware within a category so e.g. "house-2"
// sorts before a hypothetical "house-10".
templates.sort(
  (a, b) =>
    ORDER.indexOf(a.categoryId) - ORDER.indexOf(b.categoryId) ||
    a.id.localeCompare(b.id, undefined, { numeric: true }),
);

export const TEMPLATES: Template[] = templates;

export function findTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export function templatesByCategory(categoryId: string): Template[] {
  return TEMPLATES.filter((t) => t.categoryId === categoryId);
}
