export type PanelId = 'templates' | 'properties';

/** VSCode-style narrow icon strip. Each icon toggles its panel — clicking the already-active
 * one closes it, clicking another switches to it (see App.tsx's `activePanel`). */
export function ActivityBar({ active, onSelect }: { active: PanelId | null; onSelect: (panel: PanelId) => void }) {
  return (
    <div className="activity-bar">
      <button
        className={`activity-icon${active === 'templates' ? ' active' : ''}`}
        onClick={() => onSelect('templates')}
        title="テンプレート挿入"
      >
        🧩
      </button>
      <button
        className={`activity-icon${active === 'properties' ? ' active' : ''}`}
        onClick={() => onSelect('properties')}
        title="プロパティ"
      >
        ✎
      </button>
    </div>
  );
}
