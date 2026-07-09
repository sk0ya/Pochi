import type { Dispatch } from 'react';
import type { Action, EditorState, MouseTool } from '../state/reducer';

const TOOLS: Array<[MouseTool, string, string]> = [
  ['sketch', '✏ Auto', '手描きで図形を自動判定(丸→楕円、角→四角、線→矢印)'],
  ['rect', '▭ Rect', 'ドラッグで四角を描く (r)'],
  ['ellipse', '◯ Ellipse', 'ドラッグで楕円を描く (e)'],
  ['diamond', '◇ Diamond', 'ドラッグでひし形を描く (q)'],
  ['sticky', '▨ Sticky', 'ドラッグで付箋を描く (w)'],
  ['arrow', '→ Arrow', '図形から図形へドラッグで矢印 (a)'],
  ['text', 'T Text', 'クリックでテキスト (t)'],
];

export function Toolbar({
  state,
  dispatch,
  onSave,
  onOpen,
  onExportSvg,
  onImportImage,
}: {
  state: EditorState;
  dispatch: Dispatch<Action>;
  onSave: () => void;
  onOpen: () => void;
  onExportSvg: () => void;
  onImportImage: () => void;
}) {
  const setVim = (on: boolean) => dispatch({ type: 'SET_VIM', on });
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
      <button onClick={onOpen} title=":o">Open</button>
      <button onClick={onSave} title=":w / Ctrl+S">Save</button>
      <button onClick={onExportSvg} title=":svg">SVG</button>
      <span className="spacer" />
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
