import { PochiIcon } from './PochiIcons';

export type PanelId = 'files' | 'templates' | 'icons' | 'properties';

/** Labelled navigation rail. Each item toggles its panel — clicking the already-active
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
          <PochiIcon name="files" />
          <span className="activity-label">ファイル</span>
        </button>
      )}
      <button
        className={`activity-icon${active === 'icons' ? ' active' : ''}`}
        onClick={() => onSelect('icons')}
        title="アイコン挿入"
      >
        <PochiIcon name="icons" />
        <span className="activity-label">アイコン</span>
      </button>
      <button
        className={`activity-icon${active === 'templates' ? ' active' : ''}`}
        onClick={() => onSelect('templates')}
        title="テンプレート挿入"
      >
        <PochiIcon name="templates" />
        <span className="activity-label">テンプレート</span>
      </button>
      <button
        className={`activity-icon${active === 'properties' ? ' active' : ''}`}
        onClick={() => onSelect('properties')}
        title="プロパティ"
      >
        <PochiIcon name="properties" />
        <span className="activity-label">プロパティ</span>
      </button>
    </div>
  );
}
