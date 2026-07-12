import { useState } from 'react';
import type { Dispatch } from 'react';
import { exportSvg } from '../model/svg';
import type { ExportTheme } from '../model/svg';
import { CATEGORIES, TEMPLATE_DRAG_MIME, TEMPLATES, templatesByCategory } from '../model/templates';
import type { Action } from '../state/reducer';

/** Template-insert panel (opened from ActivityBar.tsx). A top row of category icons filters the
 * grid below — "全" (default) shows every template across every category, one icon per
 * category narrows to just that one. Cards show a small live SVG preview (reusing the same
 * exportSvg the app uses for :svg/:png, so the thumbnail is never out of sync with what
 * actually gets inserted) and are draggable onto the canvas; clicking one is a fallback that
 * inserts at the cursor instead. */
export function TemplateSidebar({ theme, dispatch }: { theme: ExportTheme; dispatch: Dispatch<Action> }) {
  const [filterId, setFilterId] = useState<string | null>(null);
  const tpls = filterId ? templatesByCategory(filterId) : TEMPLATES;

  return (
    <div className="template-sidebar">
      <div className="template-filter">
        <button
          className={`template-filter-icon${filterId === null ? ' active' : ''}`}
          onClick={() => setFilterId(null)}
          title="すべて表示"
        >
          All
        </button>
        {CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            className={`template-filter-icon${filterId === cat.id ? ' active' : ''}`}
            onClick={() => setFilterId(cat.id)}
            title={cat.name}
          >
            {cat.icon}
          </button>
        ))}
      </div>
      <div className="template-grid">
        {tpls.map((tpl) => {
          const svg = exportSvg({ shapes: tpl.shapes, connectors: tpl.connectors }, theme);
          return (
            <div
              key={tpl.id}
              className="template-card"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(TEMPLATE_DRAG_MIME, tpl.id);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => dispatch({ type: 'INSERT_TEMPLATE', templateId: tpl.id })}
              title={`${tpl.name} — ドラッグしてキャンバスに配置、またはクリックでカーソル位置に挿入`}
            >
              <div className="template-thumb" dangerouslySetInnerHTML={{ __html: svg }} />
              <div className="template-card-name">{tpl.name}</div>
            </div>
          );
        })}
        {tpls.length === 0 && <div className="context-hint">テンプレートがありません</div>}
      </div>
    </div>
  );
}
