import { useEffect, useRef, useState } from 'react';
import type { Dispatch, ReactNode } from 'react';
import type { RecentFile } from '../App';
import type { ExportTheme } from '../model/svg';
import { ShapeIcon } from './ShapeIcons';
import { TOOL_KEYS } from '../state/reducer';
import type { Action, EditorState, MouseTool } from '../state/reducer';

// The shape tools use the drawn icons (see ShapeIcons.tsx); the rest stay text glyphs, none of
// which is confusable with another.
const TOOLS: Array<[MouseTool, ReactNode, string, string]> = [
  ['select', '⬚', 'Select', '図形を作成しない (選択・移動・パンのみ)'],
  ['sketch', '✏', 'Auto', '手描きで図形を自動判定(丸→楕円、角→四角、線→矢印)'],
  ['pen', '〰', 'Pen', '手描き線をそのまま残す(図形に変換しない)'],
  ['rect', <ShapeIcon kind="rect" />, 'Rect', 'ドラッグで四角を描く (r)'],
  ['ellipse', <ShapeIcon kind="ellipse" />, 'Ellipse', 'ドラッグで楕円を描く (e)'],
  ['diamond', <ShapeIcon kind="diamond" />, 'Diamond', 'ドラッグでひし形を描く (q)'],
  ['triangle', <ShapeIcon kind="triangle" />, 'Triangle', 'ドラッグで三角形を描く (g)。向きは右クリックメニューで変更'],
  ['frame', <ShapeIcon kind="frame" />, 'Frame', 'ドラッグでフレーム(コンテナ)を描く (o)。移動すると内側の図形も一緒に動く'],
  ['arrow', '→', 'Arrow', '図形から図形へドラッグで矢印 (a)'],
  ['text', 'T', 'Text', 'クリックでテキスト (t)'],
];

function ImageAddIcon() {
  return (
    <svg className="toolbar-action-icon image-add-icon" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="2.25" y="3.25" width="15.5" height="13.5" rx="2" />
      <circle cx="6.5" cy="7.5" r="1.5" />
      <path d="m3.5 14 4.25-4 3 2.75 2.25-2 3.5 3.25" />
    </svg>
  );
}

function PngCopyIcon() {
  return (
    <svg className="toolbar-action-icon" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="6.5" y="6.5" width="10.5" height="10.5" rx="1.5" />
      <path d="M13.5 4.5V4A1.5 1.5 0 0 0 12 2.5H4A1.5 1.5 0 0 0 2.5 4v8A1.5 1.5 0 0 0 4 13.5h.5" />
    </svg>
  );
}

/** Closes `menu` on outside click or Escape. Shared by every toolbar dropdown. */
function useCloseOnOutside(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [ref, onClose]);
}

/** "File ▾" dropdown: new/open/save/export actions plus recent-files history.
 * Recent files only ever has entries when `isDesktop` (see RecentFile in App.tsx) - a
 * path-backed history makes no sense against a browser's file-input picker, which can't
 * be reopened without a fresh user gesture. */
function FileMenu({
  onNew,
  onOpen,
  onSave,
  onExportSvg,
  onExportExcalidraw,
  onShare,
  recentFiles,
  onOpenRecent,
  onRemoveRecent,
  onClose,
}: {
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onExportSvg: () => void;
  onExportExcalidraw: () => void;
  onShare: () => void;
  recentFiles: RecentFile[];
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useCloseOnOutside(ref, onClose);

  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };

  return (
    <div ref={ref} className="context-menu file-menu">
      <button onClick={run(onNew)} title=":new — 新規作成">New</button>
      <button onClick={run(onOpen)} title=":o — Pochi (.pochi.json) / Excalidraw (.excalidraw) を開く">
        Open...
      </button>
      {recentFiles.length > 0 && (
        <>
          <div className="context-sep" />
          <div className="context-label">最近使ったファイル</div>
          {recentFiles.map((f) => (
            <div key={f.path} className="recent-item">
              <button title={f.path} onClick={run(() => onOpenRecent(f.path))}>
                {f.name}
              </button>
              <button className="recent-remove" title="一覧から削除" onClick={() => onRemoveRecent(f.path)}>
                ✕
              </button>
            </div>
          ))}
        </>
      )}
      <div className="context-sep" />
      <button onClick={run(onSave)} title=":w / Ctrl+S">Save</button>
      <button onClick={run(onExportSvg)} title=":svg">Export SVG</button>
      <button onClick={run(onExportExcalidraw)} title=":export excalidraw — .excalidraw として書き出す">
        Export Excalidraw
      </button>
      <div className="context-sep" />
      <button onClick={run(onShare)} title=":share — 共有URLをクリップボードにコピー">
        Share
      </button>
    </div>
  );
}

export function Toolbar({
  state,
  dispatch,
  viewport,
  onNew,
  onSave,
  onOpen,
  onExportSvg,
  onExportExcalidraw,
  onCopyPng,
  onImportImage,
  onShare,
  theme,
  onToggleTheme,
  recentFiles,
  onOpenRecent,
  onRemoveRecent,
  collab,
  onToggleCollab,
}: {
  state: EditorState;
  dispatch: Dispatch<Action>;
  /** The canvas's live on-screen size — Fit has to frame the content in *that* box, not the
   * window's (see the comment on `viewport` in App.tsx). */
  viewport: () => { screenW: number; screenH: number };
  onNew: () => void;
  onSave: () => void;
  onOpen: () => void;
  onExportSvg: () => void;
  onExportExcalidraw: () => void;
  onCopyPng: () => void;
  onImportImage: () => void;
  onShare: () => void;
  theme: ExportTheme;
  onToggleTheme: () => void;
  recentFiles: RecentFile[];
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  /** Active collab room, if any; `peers` counts the *other* participants, and `locked`
   * says the room was started with a password. */
  collab: { roomId: string; locked: boolean; peers: number } | null;
  onToggleCollab: () => void;
}) {
  const setVim = (on: boolean) => dispatch({ type: 'SET_VIM', on });
  const [showFileMenu, setShowFileMenu] = useState(false);
  return (
    <div className="toolbar">
      <span className="brand">Pochi</span>
      <span className="menu-anchor">
        <button onClick={() => setShowFileMenu((v) => !v)} title="File — 新規作成・開く・保存・書き出し・共有">
          File ▾
        </button>
        {showFileMenu && (
          <FileMenu
            onNew={onNew}
            onOpen={onOpen}
            onSave={onSave}
            onExportSvg={onExportSvg}
            onExportExcalidraw={onExportExcalidraw}
            onShare={onShare}
            recentFiles={recentFiles}
            onOpenRecent={onOpenRecent}
            onRemoveRecent={onRemoveRecent}
            onClose={() => setShowFileMenu(false)}
          />
        )}
      </span>
      <span className="sep" />
      {TOOLS.map(([tool, icon, name, desc]) => (
        <button
          key={tool}
          className={`icon-btn${state.tool === tool ? ' active' : ''}`}
          onClick={() => dispatch({ type: 'SET_TOOL', tool })}
          // The key hints are shown only with vim off, which is where TOOL_KEYS applies — in
          // vim mode those same letters are the modal draw commands, not tool switches.
          title={
            state.vim
              ? `${name} — ${desc}`
              : `${name} (${TOOL_KEYS[tool].join(' / ')}) — ${desc}`
          }
        >
          {icon}
        </button>
      ))}
      <button
        className="icon-btn"
        onClick={onImportImage}
        title="画像を追加 — ファイルを選んで配置"
        aria-label="画像を追加"
      >
        <ImageAddIcon />
      </button>
      <span className="sep" />
      <button className="icon-btn" onClick={() => dispatch({ type: 'UNDO' })} title="Undo (u / Ctrl+Z)">
        ↶
      </button>
      <button className="icon-btn" onClick={() => dispatch({ type: 'REDO' })} title="Redo (Ctrl+R / Ctrl+Y)">
        ↷
      </button>
      <span className="sep" />
      <button
        className="icon-btn"
        onClick={() => dispatch({ type: 'FIT', ...viewport() })}
        title="Fit — 全体を画面に収める"
      >
        ⤢
      </button>
      <span className="sep" />
      <button
        className="png-copy-btn"
        onClick={onCopyPng}
        title="PNGコピー — 選択範囲を画像としてコピー。未選択時は全体 (:png / Ctrl+Alt+C)"
        aria-label="PNGとしてコピー"
      >
        <PngCopyIcon />
        <span>PNG</span>
      </button>
      <span className="spacer" />
      <button
        className={collab ? 'collab-on' : ''}
        onClick={onToggleCollab}
        title={
          collab
            ? `共同編集中 (room: ${collab.roomId}, 他${collab.peers}人, ${
                collab.locked ? 'パスワードあり' : 'パスワードなし'
              }) — クリックで終了 (:collab off)`
            : '共同編集を開始 — パスワードあり/なしを選んでP2Pルームを作り、URLをコピーする (:collab)'
        }
      >
        {collab ? `👥${collab.locked ? '🔒' : ''} ${collab.peers + 1}` : '👥'}
      </button>
      <button className="icon-btn" onClick={onToggleTheme} title="画面と書き出しのテーマを切替 (:theme)。書き出しのみ変えるなら :svg dark / :png light">
        {theme === 'dark' ? '🌙' : '☀'}
      </button>
      <button
        className={state.vim ? 'vim-on' : ''}
        onClick={() => setVim(!state.vim)}
        title={`Vim キーバインド: ${state.vim ? 'ON' : 'OFF'} (:vim on / :vim off)`}
      >
        Vim
      </button>
      <button className="icon-btn" onClick={() => dispatch({ type: 'TOGGLE_HELP' })} title="Help (?)">
        ?
      </button>
    </div>
  );
}
