import { useEffect, useRef } from 'react';
import type { Dispatch } from 'react';
import { findShape } from '../model/doc';
import { PALETTE } from '../model/palette';
import type { Action, EditorState } from '../state/reducer';

export function ContextMenu({
  state,
  dispatch,
}: {
  state: EditorState;
  dispatch: Dispatch<Action>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const menu = state.contextMenu;

  useEffect(() => {
    if (!menu) return;
    const close = () => dispatch({ type: 'CONTEXT_MENU_CLOSE' });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('wheel', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('wheel', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu, dispatch]);

  if (!menu) return null;

  // Target set: explicit multi-selection if the right-clicked item is part of it, else just that item.
  const ids = menu.id && state.selectedIds.includes(menu.id) ? state.selectedIds : menu.id ? [menu.id] : [];
  const hasTarget = ids.length > 0;
  const singleShape = ids.length === 1 ? findShape(state.doc, ids[0]) : undefined;
  const canEditText = ids.length === 1;

  const run = (action: Action) => {
    dispatch(action);
    dispatch({ type: 'CONTEXT_MENU_CLOSE' });
  };

  // Clamp so the menu doesn't run off the viewport edge.
  const style: React.CSSProperties = {
    left: Math.min(menu.screen.x, window.innerWidth - 190),
    top: Math.min(menu.screen.y, window.innerHeight - (hasTarget ? 300 : 90)),
  };

  return (
    <div
      ref={ref}
      className="context-menu"
      style={style}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {hasTarget ? (
        <>
          {canEditText && (
            <button
              onClick={() => run({ type: 'START_INSERT', id: ids[0] })}
            >
              テキスト編集
            </button>
          )}
          <button onClick={() => run({ type: 'COPY' })}>コピー (Ctrl+C)</button>
          <button onClick={() => run({ type: 'DUPLICATE' })}>複製 (Ctrl+D)</button>
          <button className="danger" onClick={() => run({ type: 'DELETE_IDS', ids })}>
            削除
          </button>
          <div className="context-sep" />
          <button onClick={() => run({ type: 'REORDER', ids, dir: 'front' })}>最前面へ</button>
          <button onClick={() => run({ type: 'REORDER', ids, dir: 'back' })}>最背面へ</button>
          <div className="context-sep" />
          <div className="context-label">色</div>
          <div className="color-row">
            <button
              className="color-swatch color-default"
              title="デフォルト"
              onClick={() => run({ type: 'SET_COLOR', ids, color: null })}
            />
            {PALETTE.map((p) => (
              <button
                key={p.key}
                className="color-swatch"
                style={{ background: p.hex }}
                title={p.label}
                onClick={() => run({ type: 'SET_COLOR', ids, color: p.hex })}
              />
            ))}
          </div>
          {singleShape && <div className="context-hint">{singleShape.kind}</div>}
        </>
      ) : (
        <>
          <button
            disabled={!state.clipboard}
            onClick={() => run({ type: 'PASTE_AT', p: menu.world })}
          >
            貼り付け (Ctrl+V)
          </button>
        </>
      )}
    </div>
  );
}
