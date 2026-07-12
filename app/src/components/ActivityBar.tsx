/** VSCode-style narrow icon strip. Currently a single entry — the template-insert panel (see
 * TemplateSidebar.tsx), which does its own category filtering internally — but kept as its own
 * bar/component since that's where a future second panel would go. */
export function ActivityBar({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div className="activity-bar">
      <button
        className={`activity-icon${open ? ' active' : ''}`}
        onClick={onToggle}
        title="テンプレート挿入"
      >
        🧩
      </button>
    </div>
  );
}
