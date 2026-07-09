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
    if (state.mode === 'command') inputRef.current?.focus();
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

  const modeLabel = state.vim ? state.mode.toUpperCase() : 'MOUSE';
  return (
    <div className="statusbar">
      <span className={`mode mode-${state.vim ? state.mode : 'plain'}`}>{modeLabel}</span>
      {state.count && <span className="count">{state.count}</span>}
      <span className="msg">{state.msg}</span>
      <span className="spacer" />
      <span className="meta">{state.fileName ?? '[No Name]'}</span>
      <span className="meta">
        {Math.round(state.cursor.x / GRID)},{Math.round(state.cursor.y / GRID)}
      </span>
      <span className="meta">{Math.round(state.view.scale * 100)}%</span>
    </div>
  );
}
