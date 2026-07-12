import { useEffect, useRef, useState } from 'react';
import type { Dispatch } from 'react';
import { findConnector, findShape, groupIdOf } from '../model/doc';
import { PALETTE } from '../model/palette';
import type { Connector, Shape, StrokeWidthLevel } from '../model/types';
import type { Action, EditorState } from '../state/reducer';
import {
  ARROW_DIRECTIONS,
  CONNECTOR_ROUTINGS,
  FILL_STYLES,
  FILLABLE_KINDS,
  FONT_SIZES,
  FRAME_FILL_STYLES,
  LINE_STYLES,
  SHAPE_KINDS,
  TRIANGLE_DIRECTIONS,
} from './ContextMenu';

/** Kinds with a visible stroke that thickness/dashed can apply to — fillable kinds plus
 * freedraw (which is always an open stroke, never fillable). Text/image have no stroke. */
const STROKEABLE_KINDS = new Set([...FILLABLE_KINDS, 'freedraw']);

const STROKE_WIDTHS: Array<[StrokeWidthLevel, string, string]> = [
  ['thin', '─', '細い'],
  ['m', '━', '標準'],
  ['thick', '▬', '太い'],
];

/** A single labeled x/y/w/h numeric field. Every valid keystroke dispatches `onLiveChange`
 * straight to the canvas (reducer's SET_POSITION/SET_SIZE snapshot `state.base` once and
 * just update `state.doc` live, same as a drag) — `onFinalize` (blur, Enter, or this field
 * unmounting because the selection changed) folds that whole typing session into a single
 * undo step via EDIT_COMMIT. Keeps its own text while typing so an incomplete value like
 * "-" or "" isn't clobbered by a re-render before it becomes a valid number. The parent keys
 * each instance by shape id: switching the selected shape remounts this with a fresh value,
 * and the unmount itself runs the effect cleanup below, which is what actually guarantees a
 * pending edit is finalized even if the unmount beats the native blur event to the punch. */
function NumberField({
  label,
  value,
  onLiveChange,
  onFinalize,
}: {
  label: string;
  value: number;
  onLiveChange: (v: number) => void;
  onFinalize: () => void;
}) {
  const [text, setText] = useState(String(Math.round(value)));
  const finalizeRef = useRef(onFinalize);
  finalizeRef.current = onFinalize;

  useEffect(() => {
    return () => finalizeRef.current();
  }, []);

  const handleChange = (v: string) => {
    setText(v);
    const n = Number(v);
    if (v.trim() !== '' && Number.isFinite(n)) onLiveChange(n);
  };

  const commit = () => {
    const n = Number(text);
    if (!Number.isFinite(n) || text.trim() === '') setText(String(Math.round(value)));
    finalizeRef.current();
  };

  return (
    <label className="properties-input-row">
      <span>{label}</span>
      <input
        className="properties-number-input"
        type="number"
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

/** The label textarea — every keystroke dispatches `onLiveChange` straight to the canvas
 * (reducer's SET_LABEL live-updates `state.doc` without touching undo, same pattern as
 * NumberField above); `onFinalize` (blur, Enter, or unmounting because the selection
 * changed) trims trailing whitespace, deletes the shape if it's a now-empty text box, and
 * folds the session into one undo step (COMMIT_LABEL). See NumberField's comment for why
 * the unmount cleanup — not onBlur — is the actual guarantee that a pending edit survives a
 * selection change. */
function LabelField({
  label,
  onLiveChange,
  onFinalize,
}: {
  label: string;
  onLiveChange: (v: string) => void;
  onFinalize: () => void;
}) {
  const [text, setText] = useState(label);
  const finalizeRef = useRef(onFinalize);
  finalizeRef.current = onFinalize;

  useEffect(() => {
    return () => finalizeRef.current();
  }, []);

  return (
    <textarea
      className="properties-label-textarea"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onLiveChange(e.target.value);
      }}
      onBlur={() => finalizeRef.current()}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
      placeholder="テキストなし"
      rows={2}
    />
  );
}

/** Properties panel (opened from ActivityBar.tsx). Mirrors ContextMenu.tsx's per-item edit
 * sections but as a persistent panel that follows the current selection instead of a popup —
 * see ContextMenu.tsx for the `ids` (whole selection) vs `single` (one unambiguous item)
 * split this reuses. ContextMenu itself is untouched; this is an additional editing surface. */
export function PropertiesSidebar({ state, dispatch }: { state: EditorState; dispatch: Dispatch<Action> }) {
  const ids = state.selectedIds;

  if (ids.length === 0) {
    return (
      <div className="properties-sidebar">
        <div className="context-hint">図形または線を選択してください</div>
      </div>
    );
  }

  const shapes = ids.map((id) => findShape(state.doc, id)).filter((s): s is Shape => !!s);
  const connectors = ids.map((id) => findConnector(state.doc, id)).filter((c): c is Connector => !!c);
  // Within a multi-item (group) selection, fall back to the last-clicked/dragged member
  // (`activeId`) so one item of a group can still be edited individually, mirroring how
  // ContextMenu.tsx targets `menu.id` instead of requiring a single-item selection.
  const singleId = ids.length === 1 ? ids[0] : state.activeId && ids.includes(state.activeId) ? state.activeId : undefined;
  const singleShape = singleId ? findShape(state.doc, singleId) : undefined;
  const singleConnector = singleShape ? undefined : singleId ? findConnector(state.doc, singleId) : undefined;
  const single = singleShape ?? singleConnector;
  const isGroupMember = ids.length > 1 && !!singleId && !!groupIdOf(state.doc, singleId);

  const isFillable = !!singleShape && FILLABLE_KINDS.has(singleShape.kind);
  const isStrokeable = !!singleShape && STROKEABLE_KINDS.has(singleShape.kind);
  const canChangeShape = !!singleShape && singleShape.kind !== 'image';
  const canEditText = !!single;
  const currentFontSize = singleShape?.fontSize ?? singleConnector?.fontSize ?? 'm';
  const currentStrokeWidth = singleShape?.strokeWidth ?? singleConnector?.strokeWidth ?? 'm';
  const hasStrokeableTarget = shapes.some((s) => STROKEABLE_KINDS.has(s.kind)) || connectors.length > 0;

  const run = (action: Action) => dispatch(action);

  return (
    <div className="properties-sidebar">
      <div className="context-label">
        {single
          ? ids.length > 1
            ? `${singleShape?.kind ?? 'connector'}(${isGroupMember ? 'グループ内・' : ''}全${ids.length}個選択中)`
            : (singleShape?.kind ?? 'connector')
          : `${ids.length}個選択中`}
      </div>

      {canChangeShape && (
        <>
          <div className="context-sep" />
          <div className="context-label">図形の種類</div>
          <div className="direction-row">
            {SHAPE_KINDS.map(([kind, icon, title]) => (
              <button
                key={kind}
                className={`direction-swatch${singleShape?.kind === kind ? ' active' : ''}`}
                title={title}
                onClick={() => run({ type: 'SET_SHAPE_KIND', ids: [singleShape!.id], kind })}
              >
                {icon}
              </button>
            ))}
          </div>
        </>
      )}

      {singleShape && (
        <>
          <div className="context-sep" />
          <div className="context-label">位置・サイズ</div>
          <NumberField
            key={`${singleShape.id}-x`}
            label="X"
            value={singleShape.x}
            onLiveChange={(x) => run({ type: 'SET_POSITION', id: singleShape.id, x, y: singleShape.y })}
            onFinalize={() => run({ type: 'EDIT_COMMIT' })}
          />
          <NumberField
            key={`${singleShape.id}-y`}
            label="Y"
            value={singleShape.y}
            onLiveChange={(y) => run({ type: 'SET_POSITION', id: singleShape.id, x: singleShape.x, y })}
            onFinalize={() => run({ type: 'EDIT_COMMIT' })}
          />
          <NumberField
            key={`${singleShape.id}-w`}
            label="幅"
            value={singleShape.w}
            onLiveChange={(w) => run({ type: 'SET_SIZE', id: singleShape.id, w, h: singleShape.h })}
            onFinalize={() => run({ type: 'EDIT_COMMIT' })}
          />
          <NumberField
            key={`${singleShape.id}-h`}
            label="高さ"
            value={singleShape.h}
            onLiveChange={(h) => run({ type: 'SET_SIZE', id: singleShape.id, w: singleShape.w, h })}
            onFinalize={() => run({ type: 'EDIT_COMMIT' })}
          />
        </>
      )}

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

      {isFillable && (
        <>
          <div className="context-label">塗り</div>
          <div className="direction-row">
            {(singleShape?.kind === 'frame' ? FRAME_FILL_STYLES : FILL_STYLES).map(([filled, icon, title]) => (
              <button
                key={title}
                className={`direction-swatch${(singleShape?.filled ?? false) === filled ? ' active' : ''}`}
                title={title}
                onClick={() => run({ type: 'SET_FILLED', ids: [singleShape!.id], filled })}
              >
                {icon}
              </button>
            ))}
          </div>
        </>
      )}

      {hasStrokeableTarget && (
        <>
          <div className="context-sep" />
          <div className="context-label">線の太さ</div>
          <div className="direction-row">
            {STROKE_WIDTHS.map(([sw, icon, title]) => (
              <button
                key={sw}
                className={`direction-swatch${currentStrokeWidth === sw ? ' active' : ''}`}
                title={title}
                onClick={() => run({ type: 'SET_STROKE_WIDTH', ids, strokeWidth: sw })}
              >
                {icon}
              </button>
            ))}
          </div>
        </>
      )}

      {isStrokeable && (
        <>
          <div className="context-label">線種</div>
          <div className="direction-row">
            {LINE_STYLES.map(([dashed, icon, title]) => (
              <button
                key={title}
                className={`direction-swatch${(singleShape!.dashed ?? false) === dashed ? ' active' : ''}`}
                title={title}
                onClick={() => run({ type: 'SET_SHAPE_DASHED', ids: [singleShape!.id], dashed })}
              >
                {icon}
              </button>
            ))}
          </div>
        </>
      )}

      {singleShape?.kind === 'triangle' && (
        <>
          <div className="context-sep" />
          <div className="context-label">向き</div>
          <div className="direction-row">
            {TRIANGLE_DIRECTIONS.map(([dir, icon, title]) => (
              <button
                key={dir}
                className={`direction-swatch${(singleShape.direction ?? 'up') === dir ? ' active' : ''}`}
                title={title}
                onClick={() => run({ type: 'SET_TRIANGLE_DIRECTION', ids: [singleShape.id], direction: dir })}
              >
                {icon}
              </button>
            ))}
          </div>
        </>
      )}

      {singleConnector && (
        <>
          <div className="context-sep" />
          <div className="context-label">経路</div>
          <div className="direction-row">
            {CONNECTOR_ROUTINGS.map(([routing, icon, title]) => (
              <button
                key={routing}
                className={`direction-swatch${(singleConnector.routing === 'orthogonal' ? 'orthogonal' : 'straight') === routing ? ' active' : ''}`}
                style={{ fontSize: 18 }}
                title={title}
                onClick={() => run({ type: 'SET_CONNECTOR_ROUTING', id: singleConnector.id, routing })}
              >
                {icon}
              </button>
            ))}
          </div>
          <div className="context-label">線種</div>
          <div className="direction-row">
            {LINE_STYLES.map(([dashed, icon, title]) => (
              <button
                key={title}
                className={`direction-swatch${(singleConnector.dashed ?? false) === dashed ? ' active' : ''}`}
                title={title}
                onClick={() => run({ type: 'SET_CONNECTOR_DASHED', id: singleConnector.id, dashed })}
              >
                {icon}
              </button>
            ))}
          </div>
          <div className="context-label">矢印</div>
          <div className="direction-row">
            {ARROW_DIRECTIONS.map(([dir, icon, title]) => (
              <button
                key={dir}
                className={`direction-swatch${(singleConnector.arrowDirection ?? 'end') === dir ? ' active' : ''}`}
                title={title}
                onClick={() => run({ type: 'SET_CONNECTOR_ARROW_DIRECTION', id: singleConnector.id, arrowDirection: dir })}
              >
                {icon}
              </button>
            ))}
          </div>
        </>
      )}

      {canEditText && (
        <>
          <div className="context-sep" />
          <div className="context-label">テキスト</div>
          <LabelField
            key={single!.id}
            label={single!.label}
            onLiveChange={(label) => run({ type: 'SET_LABEL', id: single!.id, label })}
            onFinalize={() => run({ type: 'COMMIT_LABEL', id: single!.id })}
          />
        </>
      )}

      <div className="context-label">文字サイズ</div>
      <div className="direction-row">
        {FONT_SIZES.map(([size, icon, title]) => (
          <button
            key={size}
            className={`direction-swatch${currentFontSize === size ? ' active' : ''}`}
            title={title}
            onClick={() => run({ type: 'SET_FONT_SIZE', ids, fontSize: size })}
          >
            {icon}
          </button>
        ))}
      </div>
    </div>
  );
}
