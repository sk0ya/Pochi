import { useEffect, useRef } from 'react';
import type { Dispatch } from 'react';
import { GRID } from '../model/types';
import type { Action, EditorState } from '../state/reducer';

export function StatusBar({
  state,
  dispatch,
  runCommand,
}: {
  state: EditorState;
  dispatch: Dispatch<Action>;
  runCommand: (cmd: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state.mode === 'command' || state.mode === 'search') inputRef.current?.focus();
  }, [state.mode]);

  if (state.mode === 'command') {
    return (
      <div className="statusbar">
        <span className="cmd-colon">:</span>
        <input
          ref={inputRef}
          className="cmd-input"
          value={state.cmd}
          onChange={(e) => dispatch({ type: 'CMD_SET', text: e.target.value })}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              runCommand(state.cmd);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              dispatch({ type: 'CMD_CLOSE' });
            }
            e.stopPropagation();
          }}
          spellCheck={false}
        />
      </div>
    );
  }

  if (state.mode === 'search') {
    return (
      <div className="statusbar">
        <span className="cmd-colon">/</span>
        <input
          ref={inputRef}
          className="cmd-input"
          value={state.search}
          onChange={(e) => dispatch({ type: 'SEARCH_SET', text: e.target.value })}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              dispatch({ type: 'SEARCH_CONFIRM' });
            } else if (e.key === 'Escape') {
              e.preventDefault();
              dispatch({ type: 'SEARCH_CLOSE' });
            }
            e.stopPropagation();
          }}
          spellCheck={false}
        />
      </div>
    );
  }

  // Selection lives above modes: a non-empty selection in normal mode reads as VISUAL.
  const visual = state.mode === 'normal' && state.selectedIds.length > 0;
  const modeKey = !state.vim ? 'plain' : visual ? 'visual' : state.mode;
  const modeLabel = state.vim
    ? visual
      ? `VISUAL${state.selectedIds.length > 1 ? ` (${state.selectedIds.length})` : ''}`
      : state.mode.toUpperCase()
    : 'MOUSE';
  return (
    <div className="statusbar">
      <span className={`mode mode-${modeKey}`}>{modeLabel}</span>
      {state.count && <span className="count">{state.count}</span>}
      <span className="msg">{state.msg}</span>
      <span className="spacer" />
      <span className="meta">{state.fileName ?? '[No Name]'}</span>
      <span className="meta">
        {Math.round(state.cursor.x / GRID)},{Math.round(state.cursor.y / GRID)}
      </span>
      <button
        className="zoom-btn"
        onClick={() =>
          dispatch({
            type: 'RESET_ZOOM',
            center: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
          })
        }
        title="クリックで100%にリセット"
      >
        {Math.round(state.view.scale * 100)}%
      </button>
    </div>
  );
}
