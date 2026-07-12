---
name: add-template
description: Add a new stamp/template to Pochi's insert sidebar (the drag-and-drop panel opened via the 🧩 activity-bar icon) — usually a new stamp inside one of the themed category groups (人・気持ち / 自然 / 街・乗り物 / IT機器 / 開発・セキュリティ / 仕事・文具 / 記号・マーク / 達成・お金 / 生活), rarely a brand-new group. Use whenever the user asks to add, create, or design a template, stamp, icon-drawing, or sidebar item for Pochi.
---

# Add a Pochi template

Templates are pure JSON data under `app/src/templates/<categoryId>/`, loaded by
`app/src/model/templates.ts` via `import.meta.glob` — no TypeScript editing needed for the
shape data itself (see that file's module doc for the full loading mechanics).

```
app/src/templates/<categoryId>/
  category.json   { "id": "<categoryId>", "name": "<表示名>", "icon": "<emoji>" }
  1.json           first stamp: { "name": "...", "shapes": [...], "connectors": [...] }
  2.json           second stamp, etc.
```

Categories are **themed groups**, each holding many stamps (e.g. `nature` = 木/雲/太陽/月/山/花/傘,
`device` = ノートPC/スマホ/…). A new stamp almost always belongs in one of the 9 existing groups —
pick the closest one rather than creating a new category per motif.

A template's id is derived from its path (`<categoryId>-<filename>`, e.g. `town-2`) — never
put an `id` field in a numbered file. `category.json` is the only file that owns an icon; the
numbered stamp files don't need one.

## Steps

1. **New stamp in an existing group** (e.g. add `nature/8.json`): just add the next
   sequential `<n>.json` — no other file needs to change. The file's `name` is the label shown
   under the card, so give each stamp in a group a distinct name.

2. **Brand-new category group** (rare): create `<categoryId>/category.json` **and** add `<categoryId>` to
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
(`town/1.json`, the 家1 stamp) — the wall is listed before the roof so the roof's sloped edges paint over,
not under, the wall's overlapping top corners; getting this backwards leaves a visible flat
line/corner cutting across the roof.

## Style: lines over boxes

Prefer plain (`arrowDirection: "none"`) connector lines over `rect` wherever a stroke can read
as the same structure — this is a deliberate, user-requested style choice (hand-drawn, not
boxy/CAD-like). Look at `people/1.json` (limbs are lines, only the head is a shape) and
`nature/1.json` (trunk is a line) for the pattern. Reserve closed shapes (`rect`/`ellipse`/
`diamond`/`triangle`) for parts that are genuinely a filled/outlined area — a head, a wall, a
cloud lobe — not for anything that's really just an edge.

**Exception — detail *inside* a closed shape must be a `freedraw` shape, not a connector.** The
canvas draws all connectors under all shapes, and closed shapes have an opaque background, so a
connector line inside a shape's bbox is invisible once inserted. The sidebar thumbnail renders
in a different order and shows it fine — deceptive; always check on the actual canvas. Follow
`office/8.json` (メール): the envelope flap is a freedraw listed *after* its container rect.
A straight inner line as freedraw is just `"points": [0, 0, 1000, 0]` with the line's bbox
(`h: 1` works for horizontals). This occlusion is also why connector lines *ending at* a filled
shape (wheels, graph nodes) are fine — the shape simply paints over the tip.

**Don't use `waypoints` on template connectors.** INSERT_TEMPLATE (and translateItems) offset
only `from`/`to`, so bends get left behind at the template's local coordinates — the stamp
looks right in the thumbnail and shatters on insert. For a curved or bent stroke use a
freedraw shape instead.
