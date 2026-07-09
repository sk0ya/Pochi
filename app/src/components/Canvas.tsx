import { useEffect, useMemo, useRef } from 'react';
import type { Dispatch } from 'react';
import { connectorAt, connectorEnds, findShape, resolveEndpoint, shapeAt } from '../model/doc';
import { fillTint } from '../model/palette';
import type { Connector, Pt, Shape } from '../model/types';
import { GRID, snap } from '../model/types';
import type { Action, EditorState } from '../state/reducer';

/** Turn a hex color into a safe DOM id fragment for a per-color arrow marker. */
const markerKey = (hex: string): string => hex.replace('#', '');

const LINE_H = 20;

function Label({ label, cx, cy, color }: { label: string; cx: number; cy: number; color?: string }) {
  if (!label) return null;
  const lines = label.split('\n');
  const startY = cy - ((lines.length - 1) * LINE_H) / 2;
  return (
    <text
      fill={color ?? 'var(--shape-text)'}
      fontSize={14}
      textAnchor="middle"
      dominantBaseline="middle"
      style={{ userSelect: 'none', pointerEvents: 'none' }}
    >
      {lines.map((line, i) => (
        <tspan key={i} x={cx} y={startY + i * LINE_H}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

function ShapeView({ s, selected, hot }: { s: Shape; selected: boolean; hot: boolean }) {
  // The shape's own color always stays visible; selection/hot is shown as a
  // halo around it instead of overriding the stroke (otherwise you can't see
  // the color you just picked while the item is still selected).
  const trueStroke = s.color ?? 'var(--shape-stroke)';
  const common = {
    fill: s.color ? fillTint(s.color) : 'var(--shape-fill)',
    stroke: trueStroke,
    strokeWidth: selected ? 2 : 1.5,
  };
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  const haloColor = selected ? 'var(--accent)' : hot ? 'var(--accent-dim)' : undefined;
  const halo = { fill: 'none', stroke: haloColor, strokeWidth: selected ? 3 : 2, opacity: 0.6 };
  return (
    <g data-id={s.id} style={{ cursor: 'move' }}>
      {haloColor && s.kind === 'rect' && (
        <rect x={s.x - 3} y={s.y - 3} width={s.w + 6} height={s.h + 6} rx={6} {...halo} />
      )}
      {haloColor && s.kind === 'ellipse' && (
        <ellipse cx={cx} cy={cy} rx={s.w / 2 + 3} ry={s.h / 2 + 3} {...halo} />
      )}
      {s.kind === 'rect' && <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={4} {...common} />}
      {s.kind === 'ellipse' && <ellipse cx={cx} cy={cy} rx={s.w / 2} ry={s.h / 2} {...common} />}
      {s.kind === 'text' && (
        <rect
          x={s.x}
          y={s.y}
          width={s.w}
          height={s.h}
          fill="transparent"
          stroke={haloColor ?? (s.label ? 'transparent' : trueStroke)}
          strokeDasharray="4 3"
          strokeWidth={haloColor ? 1.5 : 1}
        />
      )}
      <Label label={s.label} cx={cx} cy={cy} color={s.kind === 'text' ? s.color : undefined} />
    </g>
  );
}

interface DragState {
  id: string;
  kind: 'move' | 'resize' | 'pan' | 'draw' | 'arrowdrag' | 'text' | 'sketch' | 'marquee';
  /** client px; used for pan deltas and click-vs-drag thresholds */
  startScreen: Pt;
  /** world coords at drag start (move/resize) */
  startWorld: Pt;
  orig: { x: number; y: number; w: number; h: number };
  moved: boolean;
}

export function Canvas({ state, dispatch }: { state: EditorState; dispatch: Dispatch<Action> }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<DragState | null>(null);
  const space = useRef(false);

  const { doc, view, cursor, mode, vim } = state;

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === ' ') {
        space.current = true;
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ') space.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const toWorld = (e: { clientX: number; clientY: number }): Pt => {
    const r = svgRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - r.left - view.x) / view.scale,
      y: (e.clientY - r.top - view.y) / view.scale,
    };
  };

  const hitId = (target: EventTarget | null): string | undefined =>
    (target as Element | null)?.closest?.('[data-id]')?.getAttribute('data-id') ?? undefined;

  const hotShape =
    vim && mode === 'normal' ? shapeAt(doc, cursor) : undefined;
  const hotConn =
    vim && mode === 'normal' && !hotShape ? connectorAt(doc, cursor) : undefined;

  const selectedShape =
    state.selectedIds.length === 1 ? findShape(doc, state.selectedIds[0]) : undefined;

  const newDrag = (
    kind: DragState['kind'],
    e: React.MouseEvent,
    id = '',
    orig = { x: 0, y: 0, w: 0, h: 0 },
  ): DragState => ({
    id,
    kind,
    startScreen: { x: e.clientX, y: e.clientY },
    startWorld: toWorld(e),
    orig,
    moved: false,
  });

  const onMouseDown = (e: React.MouseEvent) => {
    if (mode === 'insert') return;
    // Middle button / space+drag = pan (left drag draws instead).
    if (e.button === 1 || (e.button === 0 && space.current)) {
      e.preventDefault();
      drag.current = newDrag('pan', e);
      return;
    }
    if (e.button !== 0) return;
    // Keyboard-initiated draw/arrow pending: mouseup confirms, no drag here.
    if (mode === 'draw' || mode === 'arrow') return;
    // Shift+drag = rubber-band multi-select (shift+click toggles on mouseup).
    if (e.shiftKey) {
      drag.current = newDrag('marquee', e);
      dispatch({ type: 'MARQUEE_START', p: toWorld(e) });
      return;
    }

    const id = hitId(e.target);
    const resize = (e.target as Element).getAttribute?.('data-handle') === 'resize';
    const targetId = resize ? state.selectedIds[0] : id;

    if (resize && targetId) {
      const s = findShape(doc, targetId);
      if (s) {
        drag.current = newDrag('resize', e, targetId, { x: s.x, y: s.y, w: s.w, h: s.h });
        dispatch({ type: 'DRAG_START', id: targetId });
        return;
      }
    }
    if (state.tool === 'arrow') {
      drag.current = newDrag('arrowdrag', e);
      dispatch({ type: 'START_ARROW_AT', p: toWorld(e), shapeId: id });
      return;
    }
    if (state.tool === 'sketch' && !(id && state.selectedIds.includes(id))) {
      // Freehand stroke; auto-detected on mouseup. Starting on an unselected
      // shape sketches too, so arrows can be drawn shape-to-shape. Moving a
      // shape = click to select, then drag.
      drag.current = newDrag('sketch', e);
      dispatch({ type: 'SKETCH_START', p: toWorld(e) });
      return;
    }
    if (targetId) {
      const s = findShape(doc, targetId);
      if (s) {
        drag.current = newDrag('move', e, targetId, { x: s.x, y: s.y, w: s.w, h: s.h });
        dispatch({ type: 'DRAG_START', id: targetId });
        return;
      }
      return; // connector clicked: selection happens on mouseup via CLICK
    }
    if (state.tool === 'text') {
      drag.current = newDrag('text', e);
      return;
    }
    // Empty canvas: rubber-band draw with the active tool.
    if (state.tool === 'rect' || state.tool === 'ellipse') {
      drag.current = newDrag('draw', e);
      dispatch({ type: 'START_DRAW_AT', kind: state.tool, p: toWorld(e) });
    }
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const d = drag.current;
    if (mode === 'draw' || mode === 'arrow') {
      if (d && !d.moved) {
        const dist = Math.hypot(e.clientX - d.startScreen.x, e.clientY - d.startScreen.y);
        if (dist >= 5) d.moved = true;
      }
      dispatch({ type: 'MOUSE_CURSOR', p: toWorld(e) });
      return;
    }
    if (!d) return;
    if (d.kind === 'pan') {
      const dx = e.clientX - d.startScreen.x;
      const dy = e.clientY - d.startScreen.y;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      d.startScreen = { x: e.clientX, y: e.clientY };
      dispatch({ type: 'PAN', dx, dy });
      return;
    }
    if (d.kind === 'text') {
      if (Math.hypot(e.clientX - d.startScreen.x, e.clientY - d.startScreen.y) >= 5) d.moved = true;
      return;
    }
    if (d.kind === 'sketch') {
      if (Math.hypot(e.clientX - d.startScreen.x, e.clientY - d.startScreen.y) >= 5) d.moved = true;
      dispatch({ type: 'SKETCH_POINT', p: toWorld(e) });
      return;
    }
    if (d.kind === 'marquee') {
      if (Math.hypot(e.clientX - d.startScreen.x, e.clientY - d.startScreen.y) >= 4) d.moved = true;
      dispatch({ type: 'MARQUEE_MOVE', p: toWorld(e) });
      return;
    }
    const world = toWorld(e);
    const dx = world.x - d.startWorld.x;
    const dy = world.y - d.startWorld.y;
    if (!d.moved && Math.hypot(dx * view.scale, dy * view.scale) < 4) return;
    d.moved = true;
    if (d.kind === 'move') {
      dispatch({
        type: 'DRAG_MOVE',
        id: d.id,
        to: { x: snap(d.orig.x + dx), y: snap(d.orig.y + dy) },
      });
    } else if (d.kind === 'resize') {
      dispatch({ type: 'DRAG_RESIZE', id: d.id, w: d.orig.w + dx, h: d.orig.h + dy });
    }
  };

  const onMouseUp = (e: React.MouseEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d) {
      switch (d.kind) {
        case 'draw':
        case 'arrowdrag':
          if (d.moved) {
            dispatch({ type: 'CLICK', p: toWorld(e), id: hitId(e.target) });
          } else {
            // Simple click: cancel the pending draw, treat as select/deselect.
            dispatch({ type: 'CANCEL' });
            dispatch({ type: 'CLICK', p: toWorld(e), id: hitId(e.target) });
          }
          return;
        case 'text':
          if (!d.moved) dispatch({ type: 'TEXT_AT', p: toWorld(e) });
          return;
        case 'sketch':
          if (d.moved) {
            dispatch({ type: 'SKETCH_END' });
          } else {
            dispatch({ type: 'SKETCH_CANCEL' });
            dispatch({ type: 'CLICK', p: toWorld(e), id: hitId(e.target) });
          }
          return;
        case 'marquee':
          if (d.moved) {
            dispatch({ type: 'MARQUEE_END' });
          } else {
            // Shift+click without drag: toggle the item in the selection.
            dispatch({ type: 'MARQUEE_CANCEL' });
            dispatch({ type: 'CLICK', p: toWorld(e), id: hitId(e.target), shift: true });
          }
          return;
        case 'move':
        case 'resize':
          dispatch({ type: 'DRAG_END' });
          if (!d.moved) dispatch({ type: 'CLICK', p: toWorld(e), id: d.id });
          return;
        case 'pan':
          if (!d.moved) dispatch({ type: 'CLICK', p: toWorld(e), id: hitId(e.target) });
          return;
      }
    }
    // Keyboard-initiated draw/arrow: click confirms.
    if (mode === 'draw' || mode === 'arrow') {
      dispatch({ type: 'CLICK', p: toWorld(e), id: hitId(e.target) });
      return;
    }
    dispatch({ type: 'CLICK', p: toWorld(e), id: hitId(e.target) });
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (mode !== 'normal') return;
    dispatch({ type: 'DBL_CLICK', p: toWorld(e), id: hitId(e.target) });
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (mode !== 'normal') return;
    dispatch({
      type: 'CONTEXT_MENU_OPEN',
      screen: { x: e.clientX, y: e.clientY },
      world: toWorld(e),
      id: hitId(e.target),
    });
  };

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey) {
      const r = svgRef.current!.getBoundingClientRect();
      dispatch({
        type: 'ZOOM',
        factor: e.deltaY < 0 ? 1.1 : 1 / 1.1,
        center: { x: e.clientX - r.left, y: e.clientY - r.top },
      });
    } else if (e.shiftKey) {
      dispatch({ type: 'PAN', dx: -e.deltaY, dy: 0 });
    } else {
      dispatch({ type: 'PAN', dx: -e.deltaX, dy: -e.deltaY });
    }
  };

  const drawPreview = () => {
    if (mode === 'draw' && state.draw) {
      const a = state.draw.anchor;
      const x = Math.min(a.x, cursor.x);
      const y = Math.min(a.y, cursor.y);
      const w = Math.max(Math.abs(cursor.x - a.x), GRID);
      const h = Math.max(Math.abs(cursor.y - a.y), GRID);
      const common = {
        fill: 'none',
        stroke: 'var(--accent)',
        strokeDasharray: '6 4',
        strokeWidth: 1.5,
      };
      return state.draw.kind === 'rect' ? (
        <rect x={x} y={y} width={w} height={h} rx={4} {...common} />
      ) : (
        <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />
      );
    }
    if (mode === 'arrow' && state.arrowFrom) {
      const from = resolveEndpoint(doc, state.arrowFrom);
      const a = from.shape ? from.p : { x: state.arrowFrom.x, y: state.arrowFrom.y };
      return (
        <line
          x1={a.x}
          y1={a.y}
          x2={cursor.x}
          y2={cursor.y}
          stroke="var(--accent)"
          strokeDasharray="6 4"
          strokeWidth={1.5}
          markerEnd="url(#arrow-accent)"
        />
      );
    }
    return null;
  };

  const connView = (c: Connector) => {
    const [a, b] = connectorEnds(doc, c);
    const selected = state.selectedIds.includes(c.id);
    const hot = hotConn?.id === c.id;
    // The connector's own color always stays visible; selection/hot is a
    // translucent halo drawn underneath instead of overriding the color
    // (otherwise the color you just picked is hidden while still selected).
    const trueStroke = c.color ?? 'var(--shape-stroke)';
    const marker = c.color ? `url(#arrow-${markerKey(c.color)})` : 'url(#arrow)';
    const haloColor = selected ? 'var(--accent)' : hot ? 'var(--accent-dim)' : undefined;
    return (
      <g key={c.id} data-id={c.id}>
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={12} />
        {haloColor && (
          <line
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={haloColor}
            strokeWidth={selected ? 6 : 5}
            strokeLinecap="round"
            opacity={0.5}
          />
        )}
        <line
          x1={a.x}
          y1={a.y}
          x2={b.x}
          y2={b.y}
          stroke={trueStroke}
          strokeWidth={selected ? 2 : 1.5}
          markerEnd={marker}
        />
        <Label label={c.label} cx={(a.x + b.x) / 2} cy={(a.y + b.y) / 2 - 12} color={c.color ?? 'var(--muted)'} />
      </g>
    );
  };

  const connectorColors = useMemo(
    () => Array.from(new Set(doc.connectors.map((c) => c.color).filter((v): v is string => !!v))),
    [doc.connectors],
  );

  const isEmpty = doc.shapes.length === 0 && doc.connectors.length === 0;

  return (
    <>
    {isEmpty && mode === 'normal' && (
      <div className="canvas-hint">
        ドラッグで手描き → 図形を自動認識(✏ Auto)
        <br />
        ダブルクリックで四角を作成、または r / e / t キー
      </div>
    )}
    <svg
      ref={svgRef}
      className="canvas"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onDoubleClick={onDoubleClick}
      onWheel={onWheel}
      onContextMenu={onContextMenu}
    >
      <defs>
        <pattern id="grid" width={GRID} height={GRID} patternUnits="userSpaceOnUse">
          <circle cx={1} cy={1} r={1} fill="var(--grid-dot)" />
        </pattern>
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="8"
          markerHeight="8"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--shape-stroke)" />
        </marker>
        <marker
          id="arrow-accent"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="8"
          markerHeight="8"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
        </marker>
        {connectorColors.map((hex) => (
          <marker
            key={hex}
            id={`arrow-${markerKey(hex)}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={hex} />
          </marker>
        ))}
      </defs>
      <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
        <rect x={-50000} y={-50000} width={100000} height={100000} fill="url(#grid)" />
        {doc.connectors.map(connView)}
        {doc.shapes.map((s) => (
          <ShapeView
            key={s.id}
            s={s}
            selected={state.selectedIds.includes(s.id)}
            hot={hotShape?.id === s.id}
          />
        ))}
        {selectedShape && mode === 'normal' && (
          <rect
            data-handle="resize"
            x={selectedShape.x + selectedShape.w - 5}
            y={selectedShape.y + selectedShape.h - 5}
            width={10}
            height={10}
            fill="var(--accent)"
            style={{ cursor: 'nwse-resize' }}
          />
        )}
        {drawPreview()}
        {state.marquee && (
          <rect
            x={Math.min(state.marquee.a.x, state.marquee.b.x)}
            y={Math.min(state.marquee.a.y, state.marquee.b.y)}
            width={Math.abs(state.marquee.b.x - state.marquee.a.x)}
            height={Math.abs(state.marquee.b.y - state.marquee.a.y)}
            fill="var(--accent)"
            fillOpacity={0.08}
            stroke="var(--accent)"
            strokeDasharray="4 3"
            strokeWidth={1}
            style={{ pointerEvents: 'none' }}
          />
        )}
        {state.sketch && state.sketch.length > 1 && (
          <polyline
            points={state.sketch.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ pointerEvents: 'none' }}
          />
        )}
        {vim && mode !== 'insert' && (
          <g style={{ pointerEvents: 'none' }}>
            <line
              x1={cursor.x - 7}
              y1={cursor.y}
              x2={cursor.x + 7}
              y2={cursor.y}
              stroke="var(--cursor)"
              strokeWidth={2}
            />
            <line
              x1={cursor.x}
              y1={cursor.y - 7}
              x2={cursor.x}
              y2={cursor.y + 7}
              stroke="var(--cursor)"
              strokeWidth={2}
            />
          </g>
        )}
      </g>
    </svg>
    </>
  );
}
