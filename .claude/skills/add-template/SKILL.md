---
name: add-template
description: Add a new stamp/template to Pochi's insert sidebar (the drag-and-drop panel opened via the 🧩 activity-bar icon) — either a new variant in an existing category (e.g. a second "car" design) or a brand-new category. Use whenever the user asks to add, create, or design a template, stamp, icon-drawing, or sidebar item for Pochi.
---

# Add a Pochi template

Templates are pure JSON data under `app/src/templates/<categoryId>/`, loaded by
`app/src/model/templates.ts` via `import.meta.glob` — no TypeScript editing needed for the
shape data itself (see that file's module doc for the full loading mechanics).

```
app/src/templates/<categoryId>/
  category.json   { "id": "<categoryId>", "name": "<表示名>", "icon": "<emoji>" }
  1.json           first variant: { "name": "...", "shapes": [...], "connectors": [...] }
  2.json           second variant, etc.
```

A template's id is derived from its path (`<categoryId>-<filename>`, e.g. `house-2`) — never
put an `id` field in a numbered file. `category.json` is the only file that owns an icon; the
numbered variant files don't need one.

## Steps

1. **New variant in an existing category** (e.g. add `house/3.json`): just add the next
   sequential `<n>.json` — no other file needs to change.

2. **Brand-new category**: create `<categoryId>/category.json` **and** add `<categoryId>` to
   the `ORDER` array in `app/src/model/templates.ts`. Skipping `ORDER` either throws
   (`missing category data file for "..."`, if you reference it) or — more subtly — leaves the
   category icon missing from the filter row while its templates still show up under "All",
   sorted first (its `ORDER.indexOf` is `-1`). Keep `ORDER` and the folders in sync.

3. **Design the shapes/connectors** (see schema and style rules below).

4. **Verify**: `cd app && npx tsc --noEmit && npx vitest run` — a malformed JSON file throws at
   import time, so a broken template fails these immediately, not just at runtime. Then start
   the dev server and actually look at the shape (open the 🧩 sidebar, drag or click the new
   card onto the canvas) — coordinates are hand-picked numbers with no visual preview while
   editing, so this is the only way to catch a lopsided or overlapping design.

## Shape/connector schema

Every shape/connector in one template file must share **the same `groupId` string** (any
placeholder like `"g"` — it gets remapped to a fresh id on every insert, so it only needs to be
consistent *within* the file, not unique across files). This is what makes the whole stamp
insert, select, and move as one group.

Coordinates are local, relative to the template's own bbox — no need to start at `(0,0)` or
align to any grid. A `w`/`h` bbox of roughly 60–150 units reads at a normal size next to the
app's default-sized shapes.

**Shape** (rect / ellipse / diamond / triangle):
```json
{ "id": "wall", "kind": "rect", "x": 15, "y": 55, "w": 110, "h": 85, "label": "", "groupId": "g" }
```
`kind` is one of `rect | ellipse | diamond | triangle | text | image | frame | freedraw`.
`triangle` additionally takes `"direction"`: `up | down | left | right | up-left | up-right |
down-left | down-right` (default `up`). Optional: `color` (hex), `filled` (bool, flat fill vs.
outline), `fontSize` (`s | m | l`).

**Line** (a connector with no arrowhead — the preferred way to draw structure; see style below):
```json
{ "id": "trunk", "from": { "x": 50, "y": 85 }, "to": { "x": 50, "y": 140 }, "label": "", "arrowDirection": "none", "groupId": "g" }
```
Endpoints are free points here (`{x,y}`, no `shapeId`) — templates never bind a connector to a
shape by id.

**Array order is draw (z-)order**, earlier = further back. Watch for this whenever two shapes'
bboxes overlap even slightly: list the one that should appear "under" first. Example
(`house/1.json`) — the wall is listed before the roof so the roof's sloped edges paint over,
not under, the wall's overlapping top corners; getting this backwards leaves a visible flat
line/corner cutting across the roof.

## Style: lines over boxes

Prefer plain (`arrowDirection: "none"`) connector lines over `rect` wherever a stroke can read
as the same structure — this is a deliberate, user-requested style choice (hand-drawn, not
boxy/CAD-like). Look at `person/1.json` (limbs are lines, only the head is a shape) and
`tree/1.json` (trunk is a line) for the pattern. Reserve closed shapes (`rect`/`ellipse`/
`diamond`/`triangle`) for parts that are genuinely a filled/outlined area — a head, a wall, a
cloud lobe — not for anything that's really just an edge.
