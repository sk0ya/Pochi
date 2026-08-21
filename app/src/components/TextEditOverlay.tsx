import { useEffect, useRef, useState } from 'react';
import type { Dispatch } from 'react';
import {
  connectorLabelPos,
  findShape,
  inscribedBox,
  labelBox,
  LABEL_PAD_Y,
  labelMaxWidth,
  wrapLabel,
} from '../model/doc';
import { FONT_LINE_H, FONT_SIZE_PX } from '../model/types';
import type { Action, EditorState } from '../state/reducer';

/** Border + padding of `.text-edit` in styles.css, in screen px. Under the global
 * `box-sizing: border-box` this chrome eats into the textarea's *text* area, so the element is
 * drawn inflated by this much on every side: what's left for the text then matches the world
 * box exactly, instead of being ~11px narrower and wrapping text the box was grown to fit.
 * Screen px rather than world px on purpose — the chrome doesn't scale with the zoom. */
const CHROME_PX = 5.5;

/** Default edit box for a connector label, which has no shape to take a size from. */
const CONNECTOR_BOX_W = 160;
const CONNECTOR_BOX_H = 40;

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
  // What's in the textarea right now, mirrored here only to size the box below. The textarea
  // itself stays uncontrolled (defaultValue): feeding the value back in on every keystroke
  // would put React between an IME and its own composition buffer.
  const [text, setText] = useState('');

  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    setText(ta.value);
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
  const fontSize = shape?.fontSize ?? conn?.fontSize;
  // Room the text typed so far needs, unwrapped — what a text shape and a connector label, the
  // two things here with no box around them to wrap to, size their edit box by. Every other kind
  // wraps instead (below), so it sizes off the wrapped lines rather than this.
  const need = labelBox(text, fontSize);
  let rect: { x: number; y: number; w: number; h: number };
  let textAlign: React.CSSProperties['textAlign'];
  if (shape) {
    const inner = inscribedBox(shape);
    let w: number;
    let h: number;
    if (shape.kind === 'text') {
      // A text shape *is* its label and has no outline to stay inside: it just keeps getting
      // wider under the caret (see fitToLabel), so the box being typed into does too.
      w = Math.max(inner.w, need.w);
      h = Math.max(inner.h, need.h);
    } else {
      // Every other kind keeps its box and draws its label wrapped to the room that box gives
      // it (fitToLabel), so type at exactly that width — the same one shapeLabelLines draws at,
      // so the lines break here where they'll break once committed. Only the height grows, and
      // only so what's being typed stays visible: the shape underneath doesn't move.
      w = labelMaxWidth(shape);
      const lines = wrapLabel(text, w, fontSize);
      h = Math.max(inner.h, lines.length * FONT_LINE_H[fontSize ?? 'm'] + LABEL_PAD_Y * 2);
    }
    rect =
      shape.kind === 'frame'
        ? // A frame's label hangs off its top-left corner, so its box grows right/down from
          // there — growing around the centre would walk it off the corner it's anchored to.
          { ...inner, w, h }
        : // Everything else centres its label: grow around the centre, matching both how the
          // label renders and how the shape itself grows underneath.
          { x: inner.x + (inner.w - w) / 2, y: inner.y - (h - inner.h) / 2, w, h };
    textAlign = shape.kind === 'frame' ? (shape.textAlign ?? 'left') : (shape.textAlign ?? 'center');
  } else {
    // connector label: small box on where the label renders, growing away from the
    // line on whichever side the label itself is anchored to (see connectorLabelPos)
    const pos = connectorLabelPos(state.doc, conn!);
    const w = Math.max(CONNECTOR_BOX_W, need.w);
    const h = Math.max(CONNECTOR_BOX_H, need.h);
    if (pos.anchor === 'start') {
      rect = { x: pos.x, y: pos.y - h / 2, w, h };
      textAlign = 'left';
    } else {
      rect = { x: pos.x - w / 2, y: pos.y - h / 2, w, h };
    }
  }
  const style: React.CSSProperties = {
    position: 'absolute',
    left: rect.x * view.scale + view.x - CHROME_PX,
    top: rect.y * view.scale + view.y - CHROME_PX,
    width: rect.w * view.scale + CHROME_PX * 2,
    height: rect.h * view.scale + CHROME_PX * 2,
    fontSize: FONT_SIZE_PX[fontSize ?? 'm'] * view.scale,
    // Same per-line height the canvas renders the label at, so the box measured from the text
    // (`labelBox`, which counts in FONT_LINE_H) is the box the text actually occupies here.
    lineHeight: `${FONT_LINE_H[fontSize ?? 'm'] * view.scale}px`,
    ...(textAlign ? { textAlign } : {}),
  };

  const commit = () => {
    dispatch({ type: 'INSERT_COMMIT', label: ref.current?.value ?? '' });
  };

  return (
    <textarea
      // Remount per edited item: the value is uncontrolled, so without this a second edit
      // opened without leaving insert mode would keep the previous item's text.
      key={id}
      ref={ref}
      className="text-edit"
      style={style}
      defaultValue={shape?.label ?? conn?.label ?? ''}
      onInput={(e) => {
        const label = e.currentTarget.value;
        setText(label);
        dispatch({ type: 'INSERT_AUTOSIZE', label });
      }}
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
