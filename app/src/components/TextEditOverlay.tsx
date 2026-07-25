import { useEffect, useRef } from 'react';
import type { Dispatch } from 'react';
import { connectorLabelPos, findShape, inscribedBox } from '../model/doc';
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
    if (!ta) return;
    ta.focus();
    // Caret at the end, not the whole label selected. This editor opens over an *existing*
    // label as often as a fresh shape (double-click, `i`, F2, the context menu), and with
    // everything selected the first keystroke silently replaced a label the user only meant to
    // extend. Ctrl+A is still there for a deliberate replace.
    const end = ta.value.length;
    ta.setSelectionRange(end, end);
  }, [id]);

  if (state.mode !== 'insert' || (!shape && !conn)) return null;

  const { view } = state;
  let rect: { x: number; y: number; w: number; h: number };
  let textAlign: React.CSSProperties['textAlign'];
  if (shape) {
    rect = inscribedBox(shape);
  } else {
    // connector label: small box on where the label renders, growing away from the
    // line on whichever side the label itself is anchored to (see connectorLabelPos)
    const pos = connectorLabelPos(state.doc, conn!);
    if (pos.anchor === 'start') {
      rect = { x: pos.x, y: pos.y - 20, w: 160, h: 40 };
      textAlign = 'left';
    } else {
      rect = { x: pos.x - 80, y: pos.y - 20, w: 160, h: 40 };
    }
  }
  const fontSize = shape?.fontSize ?? conn?.fontSize;
  const style: React.CSSProperties = {
    position: 'absolute',
    left: rect.x * view.scale + view.x,
    top: rect.y * view.scale + view.y,
    width: rect.w * view.scale,
    height: rect.h * view.scale,
    fontSize: FONT_SIZE_PX[fontSize ?? 'm'] * view.scale,
    ...(textAlign ? { textAlign } : {}),
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
        // Esc *commits* here, unlike the draw/move/resize modes where it cancels — this
        // deliberately follows vim, whose insert mode also keeps what you typed on the way out.
        // The whole point of the auto-recognise and double-click flows is "shape appears, type,
        // leave", so having Esc discard the text would break the app's main path.
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
