import { useEffect, useRef, useState } from 'react';
import type { Dispatch } from 'react';
import type { RecentFile } from '../App';
import type { ExportTheme } from '../model/svg';
import type { Action, EditorState, MouseTool } from '../state/reducer';

const TOOLS: Array<[MouseTool, string, string]> = [
  ['select', '⬚ Select', '図形を作成しない (選択・移動・パンのみ)'],
  ['sketch', '✏ Auto', '手描きで図形を自動判定(丸→楕円、角→四角、線→矢印)'],
  ['pen', '〰 Pen', '手描き線をそのまま残す(図形に変換しない)'],
  ['rect', '▭ Rect', 'ドラッグで四角を描く (r)'],
  ['ellipse', '◯ Ellipse', 'ドラッグで楕円を描く (e)'],
  ['diamond', '◇ Diamond', 'ドラッグでひし形を描く (q)'],
  ['triangle', '△ Triangle', 'ドラッグで三角形を描く (g)。向きは右クリックメニューで変更'],
  ['frame', '▢ Frame', 'ドラッグでフレーム(コンテナ)を描く (o)。移動すると内側の図形も一緒に動く'],
  ['arrow', '→ Arrow', '図形から図形へドラッグで矢印 (a)'],
  ['text', 'T Text', 'クリックでテキスト (t)'],
];

/** "Open ▾" recent-files popover. Only ever rendered with entries when `isDesktop` (see
 * RecentFile in App.tsx) - a path-backed history makes no sense against a browser's
 * file-input picker, which can't be reopened without a fresh user gesture. */
function RecentFilesMenu({
  files,
  onOpen,
  onRemove,
  onClose,
}: {
  files: RecentFile[];
  onOpen: (path: string) => void;
  onRemove: (path: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
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
  }, [onClose]);

  return (
    <div ref={ref} className="context-menu recent-menu">
      {files.length === 0 ? (
        <div className="context-hint">最近使ったファイルはありません</div>
      ) : (
        files.map((f) => (
          <div key={f.path} className="recent-item">
            <button title={f.path} onClick={() => onOpen(f.path)}>
              {f.name}
            </button>
            <button
              className="recent-remove"
              title="一覧から削除"
              onClick={() => onRemove(f.path)}
            >
              ✕
            </button>
          </div>
        ))
      )}
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
  theme,
  onToggleTheme,
  recentFiles,
  onOpenRecent,
  onRemoveRecent,
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
  theme: ExportTheme;
  onToggleTheme: () => void;
  recentFiles: RecentFile[];
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
}) {
  const setVim = (on: boolean) => dispatch({ type: 'SET_VIM', on });
  const [showRecent, setShowRecent] = useState(false);
  return (
    <div className="toolbar">
      <span className="brand">Pochi</span>
      {TOOLS.map(([tool, label, title]) => (
        <button
          key={tool}
          className={state.tool === tool ? 'active' : ''}
          onClick={() => dispatch({ type: 'SET_TOOL', tool })}
          title={title}
        >
          {label}
        </button>
      ))}
      <span className="sep" />
      <button onClick={() => dispatch({ type: 'UNDO' })} title="Undo (u / Ctrl+Z)">↶</button>
      <button onClick={() => dispatch({ type: 'REDO' })} title="Redo (Ctrl+R / Ctrl+Y)">↷</button>
      <span className="sep" />
      <button
        onClick={() =>
          dispatch({ type: 'FIT', screenW: window.innerWidth, screenH: window.innerHeight })
        }
        title="全体を画面に収める"
      >
        ⤢ Fit
      </button>
      <span className="sep" />
      <button onClick={onImportImage} title="画像ファイルを取り込む">🖼 Image</button>
      <span className="sep" />
      <button onClick={onNew} title=":new — 新規作成">New</button>
      <span className="menu-anchor">
        <button onClick={onOpen} title=":o — Pochi (.pochi.json) / Excalidraw (.excalidraw) を開く">Open</button>
        {recentFiles.length > 0 && (
          <button
            className="caret"
            onClick={() => setShowRecent((v) => !v)}
            title="最近使ったファイル"
          >
            ▾
          </button>
        )}
        {showRecent && (
          <RecentFilesMenu
            files={recentFiles}
            onOpen={(path) => {
              setShowRecent(false);
              onOpenRecent(path);
            }}
            onRemove={onRemoveRecent}
            onClose={() => setShowRecent(false)}
          />
        )}
      </span>
      <button onClick={onSave} title=":w / Ctrl+S">Save</button>
      <button onClick={onExportSvg} title=":svg">SVG</button>
      <button onClick={onExportExcalidraw} title=":export excalidraw — .excalidraw として書き出す">Excalidraw</button>
      <button onClick={onCopyPng} title=":png / Ctrl+Alt+C">📋 PNG</button>
      <span className="spacer" />
      <button
        onClick={onToggleTheme}
        title="画面と書き出しのテーマを切替 (:theme)。書き出しのみ変えるなら :svg dark / :png light"
      >
        {theme === 'dark' ? '🌙 Dark' : '☀ Light'}
      </button>
      <button
        className={state.vim ? 'vim-on' : ''}
        onClick={() => setVim(!state.vim)}
        title=":vim on / :vim off"
      >
        vim: {state.vim ? 'ON' : 'OFF'}
      </button>
      <button onClick={() => dispatch({ type: 'TOGGLE_HELP' })} title="Help (?)">?</button>
    </div>
  );
}
