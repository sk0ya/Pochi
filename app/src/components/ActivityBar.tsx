export type PanelId = 'files' | 'templates' | 'properties';

/** VSCode-style narrow icon strip. Each icon toggles its panel — clicking the already-active
 * one closes it, clicking another switches to it (see App.tsx's `activePanel`).
 *
 * The Files panel (📁) manages real folders on disk, so App passes `showFiles` only when the
 * native host implements those ops — see `canManageFiles` there. */
export function ActivityBar({
  active,
  onSelect,
  showFiles,
}: {
  active: PanelId | null;
  onSelect: (panel: PanelId) => void;
  showFiles: boolean;
}) {
  return (
    <div className="activity-bar">
      {showFiles && (
        <button
          className={`activity-icon${active === 'files' ? ' active' : ''}`}
          onClick={() => onSelect('files')}
          title="ファイル管理"
        >
          📁
        </button>
      )}
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
