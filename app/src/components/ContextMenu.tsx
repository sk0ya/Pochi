import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch, ReactNode } from 'react';
import { ShapeIcon } from './ShapeIcons';
import { canReorderStep, findConnector, findShape, groupIdOf, groupMembers, isSelfLoop } from '../model/doc';
import type { AlignEdge, DistributeAxis } from '../model/doc';
import { PALETTE } from '../model/palette';
import type { ArrowDirection, FontSize, LoopSide, Pt, TriangleDirection } from '../model/types';
import type { Action, DrawKind, EditorState } from '../state/reducer';

export const TRIANGLE_DIRECTIONS: Array<[TriangleDirection, string, string]> = [
  ['up', '▲', '上向き'],
  ['down', '▼', '下向き'],
  ['left', '◀', '左向き'],
  ['right', '▶', '右向き'],
  ['up-left', '◤', '左上向き(斜め)'],
  ['up-right', '◥', '右上向き(斜め)'],
  ['down-left', '◣', '左下向き(斜め)'],
  ['down-right', '◢', '右下向き(斜め)'],
];

export const CONNECTOR_ROUTINGS: Array<['straight' | 'orthogonal', string, string]> = [
  ['straight', '／', '直線'],
  ['orthogonal', '↳', '直角'],
];

export const ARROW_DIRECTIONS: Array<[ArrowDirection, string, string]> = [
  ['none', '─', '矢印なし'],
  ['end', '─▶', '終点のみ'],
  ['start', '◀─', '始点のみ'],
  ['both', '◀▶', '両方向'],
];

export const LOOP_SIDES: Array<[LoopSide, string, string]> = [
  ['top', '↑', '上'],
  ['right', '→', '右'],
  ['bottom', '↓', '下'],
  ['left', '←', '左'],
];

export const LINE_STYLES: Array<[boolean, string, string]> = [
  [false, '───', '実線'],
  [true, '╌╌╌', '点線'],
];

export const FILL_STYLES: Array<[boolean, string, string]> = [
  [false, '▢', 'アウトライン'],
  [true, '▩', 'ベタ塗り'],
];

/** A frame's fill is a translucent interior tint (see Canvas.tsx), not the solid flat fill
 * other shapes get — same `filled` flag, so the toggle labels say what it actually does. */
export const FRAME_FILL_STYLES: Array<[boolean, string, string]> = [
  [false, '▢', '枠線のみ'],
  [true, '▨', '薄塗り'],
];

export const FONT_SIZES: Array<[FontSize, string, string]> = [
  ['s', 'S', '小'],
  ['m', 'M', '標準'],
  ['l', 'L', '大'],
];

export const FILLABLE_KINDS = new Set(['rect', 'ellipse', 'diamond', 'triangle', 'frame']);

/** The kinds an existing shape can be converted into, and — from a right-click on empty
 * canvas — inserted as. Deliberately typed as the reducer's DrawKind: that's the set of kinds
 * that can be created without a text/image flow of their own, which is exactly this list.
 * Drawn icons rather than text glyphs, for the reason ShapeIcons.tsx gives. */
export const SHAPE_KINDS: Array<[DrawKind, ReactNode, string]> = [
  ['rect', <ShapeIcon kind="rect" />, '四角形'],
  ['ellipse', <ShapeIcon kind="ellipse" />, '楕円'],
  ['diamond', <ShapeIcon kind="diamond" />, 'ひし形'],
  ['triangle', <ShapeIcon kind="triangle" />, '三角形'],
  ['frame', <ShapeIcon kind="frame" />, 'フレーム(コンテナ)'],
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
  onInsertImage,
}: {
  state: EditorState;
  dispatch: Dispatch<Action>;
  /** Opens the image picker and drops the chosen file at `at` — the file dialog is async and
   * lives in App, so this can't be a plain action the way the other insert entries are. */
  onInsertImage: (at: Pt) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const menu = state.contextMenu;

  /* Keep the menu on screen by measuring it, not by guessing. This used to clamp against a
   * hardcoded height estimate (420–570px plus per-section increments), which meant a right-click
   * anywhere in the lower part of the window pinned the menu to a fixed y far from the cursor —
   * and the guess couldn't account for the CSS max-height/scroll cap either. Measured in a
   * layout effect so the corrected position is what actually paints; `null` until then means
   * "render at the raw click point", which is already right for the common case. */
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!menu || !el) {
      setPos(null);
      return;
    }
    const { width, height } = el.getBoundingClientRect();
    const M = 8; // breathing room, so the menu never sits flush against a window edge
    setPos({
      left: Math.max(M, Math.min(menu.screen.x, window.innerWidth - width - M)),
      top: Math.max(M, Math.min(menu.screen.y, window.innerHeight - height - M)),
    });
  }, [menu]);

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
  // A self-loop's path is decided by its two feet alone (connectorPath returns before it
  // consults either), so routing and bend points are offered only for the connectors that
  // actually honour them. The feet themselves are set from the sidebar's side buttons.
  const canRoute = !!singleConnector && !isSelfLoop(singleConnector);
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

  const style: React.CSSProperties = {
    left: pos?.left ?? menu.screen.x,
    top: pos?.top ?? menu.screen.y,
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
              {canRoute && (
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
                </>
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
          {/* Right-clicking bare canvas used to offer paste and nothing else, so putting a
            * shape down meant a trip to the toolbar. Everything here lands at the clicked
            * point rather than at the vim cursor. */}
          <div className="context-label">挿入</div>
          <div className="direction-row">
            {SHAPE_KINDS.map(([kind, icon, title]) => (
              <button
                key={kind}
                className="direction-swatch"
                title={title}
                onClick={() => run({ type: 'INSERT_SHAPE_AT', kind, p: menu.world })}
              >
                {icon}
              </button>
            ))}
          </div>
          <button onClick={() => run({ type: 'TEXT_AT', p: menu.world })}>テキスト</button>
          <button
            onClick={() => {
              dispatch({ type: 'CONTEXT_MENU_CLOSE' });
              onInsertImage(menu.world);
            }}
          >
            画像…
          </button>
          <div className="context-sep" />
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
