import { useEffect, useRef } from 'react';
import type { Dispatch } from 'react';
import { canReorderStep, findConnector, findShape, groupIdOf, groupMembers } from '../model/doc';
import type { AlignEdge, DistributeAxis } from '../model/doc';
import { PALETTE } from '../model/palette';
import type { ArrowDirection, FontSize, ShapeKind, TriangleDirection } from '../model/types';
import type { Action, EditorState } from '../state/reducer';

const TRIANGLE_DIRECTIONS: Array<[TriangleDirection, string, string]> = [
  ['up', '▲', '上向き'],
  ['down', '▼', '下向き'],
  ['left', '◀', '左向き'],
  ['right', '▶', '右向き'],
  ['up-left', '◤', '左上向き(斜め)'],
  ['up-right', '◥', '右上向き(斜め)'],
  ['down-left', '◣', '左下向き(斜め)'],
  ['down-right', '◢', '右下向き(斜め)'],
];

const CONNECTOR_ROUTINGS: Array<['straight' | 'orthogonal', string, string]> = [
  ['straight', '／', '直線'],
  ['orthogonal', '↳', '直角'],
];

const ARROW_DIRECTIONS: Array<[ArrowDirection, string, string]> = [
  ['none', '─', '矢印なし'],
  ['end', '─▶', '終点のみ'],
  ['start', '◀─', '始点のみ'],
  ['both', '◀▶', '両方向'],
];

const LINE_STYLES: Array<[boolean, string, string]> = [
  [false, '───', '実線'],
  [true, '╌╌╌', '点線'],
];

const FILL_STYLES: Array<[boolean, string, string]> = [
  [false, '▢', 'アウトライン'],
  [true, '▩', 'ベタ塗り'],
];

/** A frame's fill is a translucent interior tint (see Canvas.tsx), not the solid flat fill
 * other shapes get — same `filled` flag, so the toggle labels say what it actually does. */
const FRAME_FILL_STYLES: Array<[boolean, string, string]> = [
  [false, '▢', '枠線のみ'],
  [true, '▨', '薄塗り'],
];

const FONT_SIZES: Array<[FontSize, string, string]> = [
  ['s', 'S', '小'],
  ['m', 'M', '標準'],
  ['l', 'L', '大'],
];

const FILLABLE_KINDS = new Set(['rect', 'ellipse', 'diamond', 'triangle', 'frame']);

const SHAPE_KINDS: Array<[ShapeKind, string, string]> = [
  ['rect', '▭', '四角形'],
  ['ellipse', '◯', '楕円'],
  ['diamond', '◇', 'ひし形'],
  ['triangle', '△', '三角形'],
  ['frame', '▢', 'フレーム(コンテナ)'],
];

const ALIGN_EDGES: Array<[AlignEdge, string, string]> = [
  ['left', '⇤', '左揃え'],
  ['center-h', '↔', '左右中央揃え'],
  ['right', '⇥', '右揃え'],
  ['top', '⤒', '上揃え'],
  ['center-v', '↕', '上下中央揃え'],
  ['bottom', '⤓', '下揃え'],
];

const DISTRIBUTE_AXES: Array<[DistributeAxis, string, string]> = [
  ['h', '⇹', '横に等間隔'],
  ['v', '⇳', '縦に等間隔'],
];

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
  // Used for whole-selection actions (align, distribute, delete, reorder, group/ungroup, batch
  // color/font-size) — right-clicking a grouped item selects the whole group, so this is often
  // more than one id.
  const ids = menu.id && state.selectedIds.includes(menu.id) ? state.selectedIds : menu.id ? [menu.id] : [];
  const hasTarget = ids.length > 0;
  // Per-item edits (text, fill, shape kind, direction, connector settings) always target the
  // specific item that was right-clicked, not the group-expanded `ids` — otherwise none of these
  // controls could ever appear for a shape that belongs to a multi-member group.
  const singleShape = menu.id ? findShape(state.doc, menu.id) : undefined;
  const singleConnector = menu.id ? findConnector(state.doc, menu.id) : undefined;
  const canEditText = !!menu.id && (!!singleShape || !!singleConnector);

  const targetGroupId = ids.length ? groupIdOf(state.doc, ids[0]) : undefined;
  const isFullGroup =
    !!targetGroupId && (() => {
      const members = groupMembers(state.doc, targetGroupId);
      return members.length === ids.length && members.every((m) => ids.includes(m));
    })();

  const run = (action: Action) => {
    dispatch(action);
    dispatch({ type: 'CONTEXT_MENU_CLOSE' });
  };

  const isFillable = !!singleShape && FILLABLE_KINDS.has(singleShape.kind);
  const canChangeShape = !!singleShape && singleShape.kind !== 'image';
  const alignableCount = ids.filter((id) => findShape(state.doc, id)).length;
  const canAlign = alignableCount >= 2;
  const canDistribute = alignableCount >= 3;
  const canMoveForward = hasTarget && canReorderStep(state.doc, ids, 'forward');
  const canMoveBackward = hasTarget && canReorderStep(state.doc, ids, 'backward');
  // Only a single right-clicked item has one unambiguous "current" size to highlight;
  // a multi-selection may mix sizes, so none of the buttons is shown active then.
  const currentFontSize = canEditText ? (singleShape?.fontSize ?? singleConnector?.fontSize ?? 'm') : undefined;

  // Clamp so the menu doesn't run off the viewport edge.
  const menuHeight =
    (hasTarget
      ? singleShape?.kind === 'triangle'
        ? 470
        : singleConnector
          ? 570
          : 420
      : 90) +
    (isFillable ? 60 : 0) +
    (canChangeShape ? 60 : 0) +
    (canAlign ? 90 : 0) +
    (canDistribute ? 90 : 0) +
    (hasTarget ? 60 : 0);
  const style: React.CSSProperties = {
    left: Math.min(menu.screen.x, window.innerWidth - 190),
    top: Math.min(menu.screen.y, window.innerHeight - menuHeight),
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
          {canAlign && (
            <>
              <div className="context-label">整列</div>
              <div className="direction-row">
                {ALIGN_EDGES.map(([edge, icon, title]) => (
                  <button
                    key={edge}
                    className="direction-swatch"
                    title={title}
                    onClick={() => run({ type: 'ALIGN', ids, edge })}
                  >
                    {icon}
                  </button>
                ))}
              </div>
              <div className="context-sep" />
            </>
          )}
          {canDistribute && (
            <>
              <div className="context-label">等間隔配置</div>
              <div className="direction-row">
                {DISTRIBUTE_AXES.map(([axis, icon, title]) => (
                  <button
                    key={axis}
                    className="direction-swatch"
                    title={title}
                    onClick={() => run({ type: 'DISTRIBUTE', ids, axis })}
                  >
                    {icon}
                  </button>
                ))}
              </div>
              <div className="context-sep" />
            </>
          )}
          {canEditText && (
            <button
              onClick={() => run({ type: 'START_INSERT', id: menu.id! })}
            >
              テキスト編集
            </button>
          )}
          {canChangeShape && (
            <>
              <div className="context-label">図形の種類</div>
              <div className="direction-row">
                {SHAPE_KINDS.map(([kind, icon, title]) => (
                  <button
                    key={kind}
                    className={`direction-swatch${singleShape?.kind === kind ? ' active' : ''}`}
                    title={title}
                    onClick={() => run({ type: 'SET_SHAPE_KIND', ids: [menu.id!], kind })}
                  >
                    {icon}
                  </button>
                ))}
              </div>
              <div className="context-sep" />
            </>
          )}
          <button onClick={() => run({ type: 'COPY' })}>コピー (Ctrl+C)</button>
          <button onClick={() => run({ type: 'DUPLICATE' })}>複製 (Ctrl+D)</button>
          <button className="danger" onClick={() => run({ type: 'DELETE_IDS', ids })}>
            削除
          </button>
          <div className="context-sep" />
          <button onClick={() => run({ type: 'REORDER', ids, dir: 'front' })}>最前面へ</button>
          <button onClick={() => run({ type: 'REORDER', ids, dir: 'back' })}>最背面へ</button>
          {canMoveForward && (
            <button onClick={() => run({ type: 'REORDER', ids, dir: 'forward' })}>ひとつ前面へ (Ctrl+])</button>
          )}
          {canMoveBackward && (
            <button onClick={() => run({ type: 'REORDER', ids, dir: 'backward' })}>ひとつ背面へ (Ctrl+[)</button>
          )}
          <div className="context-sep" />
          {ids.length >= 2 && !isFullGroup && (
            <button onClick={() => run({ type: 'GROUP' })}>グループ化 (Ctrl+G)</button>
          )}
          {targetGroupId && (
            <button onClick={() => run({ type: 'UNGROUP' })}>グループ解除 (Ctrl+G)</button>
          )}
          {singleConnector && (
            <>
              <div className="context-label">経路</div>
              <div className="direction-row">
                {CONNECTOR_ROUTINGS.map(([routing, icon, title]) => (
                  <button
                    key={routing}
                    className={`direction-swatch${(singleConnector.routing === 'orthogonal' ? 'orthogonal' : 'straight') === routing ? ' active' : ''}`}
                    style={{ fontSize: 18 }}
                    title={title}
                    onClick={() => run({ type: 'SET_CONNECTOR_ROUTING', id: menu.id!, routing })}
                  >
                    {icon}
                  </button>
                ))}
              </div>
              <button onClick={() => run({ type: 'ADD_WAYPOINT', id: menu.id!, p: menu.world })}>
                ベンドポイント追加
              </button>
              {singleConnector.waypoints && singleConnector.waypoints.length > 0 && (
                <button onClick={() => run({ type: 'CLEAR_WAYPOINTS', id: menu.id! })}>
                  ベンドポイントを全て削除
                </button>
              )}
              <div className="context-label">線種</div>
              <div className="direction-row">
                {LINE_STYLES.map(([dashed, icon, title]) => (
                  <button
                    key={title}
                    className={`direction-swatch${(singleConnector.dashed ?? false) === dashed ? ' active' : ''}`}
                    title={title}
                    onClick={() => run({ type: 'SET_CONNECTOR_DASHED', id: menu.id!, dashed })}
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
                    onClick={() => run({ type: 'SET_CONNECTOR_ARROW_DIRECTION', id: menu.id!, arrowDirection: dir })}
                  >
                    {icon}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="context-sep" />
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
                    onClick={() => run({ type: 'SET_FILLED', ids: [menu.id!], filled })}
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
                    onClick={() => run({ type: 'SET_TRIANGLE_DIRECTION', ids: [menu.id!], direction: dir })}
                  >
                    {icon}
                  </button>
                ))}
              </div>
            </>
          )}
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
