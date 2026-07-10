import { useEffect, useRef } from 'react';
import type { Dispatch } from 'react';
import { findShape, inscribedBox } from '../model/doc';
import { FONT_SIZE_PX } from '../model/types';
import type { Action, EditorState } from '../state/reducer';

/** Textarea floated over the shape being edited (insert mode). */
export function TextEditOverlay({
  state,
  dispatch,
}: {
  state: EditorState;
  dispatch: Dispatch<Action>;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = state.editingId;
  const shape = id ? findShape(state.doc, id) : undefined;
  const conn = id ? state.doc.connectors.find((c) => c.id === id) : undefined;

  useEffect(() => {
    const ta = ref.current;
    if (ta) {
      ta.focus();
      ta.select();
    }
  }, [id]);

  if (state.mode !== 'insert' || (!shape && !conn)) return null;

  const { view } = state;
  let rect: { x: number; y: number; w: number; h: number };
  if (shape) {
    rect = inscribedBox(shape);
  } else {
    // connector label: small box at the midpoint
    rect = { x: state.cursor.x - 80, y: state.cursor.y - 20, w: 160, h: 40 };
  }
  const fontSize = shape?.fontSize ?? conn?.fontSize;
  const style: React.CSSProperties = {
    position: 'absolute',
    left: rect.x * view.scale + view.x,
    top: rect.y * view.scale + view.y,
    width: rect.w * view.scale,
    height: rect.h * view.scale,
    fontSize: FONT_SIZE_PX[fontSize ?? 'm'] * view.scale,
  };

  const commit = () => {
    dispatch({ type: 'INSERT_COMMIT', label: ref.current?.value ?? '' });
  };

  return (
    <textarea
      ref={ref}
      className="text-edit"
      style={style}
      defaultValue={shape?.label ?? conn?.label ?? ''}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Enter' && e.altKey) {
          // Chromium has no default "insert newline" action for Alt+Enter
          // (unlike Shift+Enter), so it must be inserted manually.
          e.preventDefault();
          document.execCommand('insertText', false, '\n');
        } else if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          commit();
        }
        e.stopPropagation();
      }}
      onBlur={commit}
      spellCheck={false}
    />
  );
}
