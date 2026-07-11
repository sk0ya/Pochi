import { useEffect, useRef, useState } from 'react';
import type { Dispatch } from 'react';
import type { RecentFile } from '../App';
import type { ExportTheme } from '../model/svg';
import type { Action, EditorState, MouseTool } from '../state/reducer';

const TOOLS: Array<[MouseTool, string, string, string]> = [
  ['select', '⬚', 'Select', '図形を作成しない (選択・移動・パンのみ)'],
  ['sketch', '✏', 'Auto', '手描きで図形を自動判定(丸→楕円、角→四角、線→矢印)'],
  ['pen', '〰', 'Pen', '手描き線をそのまま残す(図形に変換しない)'],
  ['rect', '▭', 'Rect', 'ドラッグで四角を描く (r)'],
  ['ellipse', '◯', 'Ellipse', 'ドラッグで楕円を描く (e)'],
  ['diamond', '◇', 'Diamond', 'ドラッグでひし形を描く (q)'],
  ['triangle', '△', 'Triangle', 'ドラッグで三角形を描く (g)。向きは右クリックメニューで変更'],
  ['frame', '▢', 'Frame', 'ドラッグでフレーム(コンテナ)を描く (o)。移動すると内側の図形も一緒に動く'],
  ['arrow', '→', 'Arrow', '図形から図形へドラッグで矢印 (a)'],
  ['text', 'T', 'Text', 'クリックでテキスト (t)'],
];

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
  /** Active collab room, if any; `peers` counts the *other* participants. */
  collab: { roomId: string; peers: number } | null;
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
          title={`${name} — ${desc}`}
        >
          {icon}
        </button>
      ))}
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
        onClick={() =>
          dispatch({ type: 'FIT', screenW: window.innerWidth, screenH: window.innerHeight })
        }
        title="Fit — 全体を画面に収める"
      >
        ⤢
      </button>
      <span className="sep" />
      <button onClick={onImportImage} title="Image — 画像ファイルを取り込む">
        Image
      </button>
      <span className="sep" />
      <button onClick={onCopyPng} title="Copy PNG — 画像としてコピー (:png / Ctrl+Alt+C)">
        PNG
      </button>
      <span className="spacer" />
      <button
        className={collab ? 'collab-on' : ''}
        onClick={onToggleCollab}
        title={
          collab
            ? `共同編集中 (room: ${collab.roomId}, 他${collab.peers}人) — クリックで終了 (:collab off)`
            : '共同編集を開始 — P2PルームのURLをコピーし、URLを知っている人が参加できる (:collab)'
        }
      >
        {collab ? `👥 ${collab.peers + 1}` : '👥'}
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
