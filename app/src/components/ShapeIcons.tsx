import type { DrawKind } from '../state/reducer';

/**
 * Glyphs for the shape kinds, drawn rather than typed. ▭ (四角) and ▢ (フレーム) are all but
 * indistinguishable at the 13–15px the toolbar and the swatch rows render text at, which made
 * the two easy to hit by mistake. Stroke-only in `currentColor`, so `.active`'s accent colour
 * and the muted disabled colour apply without the icons knowing anything about either.
 */
const PATHS: Record<DrawKind, React.ReactNode> = {
  // Proportioned like the shape a drag actually produces (DEFAULT_W:DEFAULT_H, 10:6).
  rect: <rect x="1.6" y="4.2" width="12.8" height="7.6" rx="1.6" />,
  ellipse: <ellipse cx="8" cy="8" rx="6.2" ry="4.8" />,
  diamond: <path d="M8 1.8 14.2 8 8 14.2 1.8 8Z" />,
  triangle: <path d="M8 2.4 14.4 13.4 1.6 13.4Z" />,
  // Corners only. A closed box — even a taller one, even with the frame's top-left label tab
  // drawn in — still reads as "四角" at 16px; an open corner mark reads as a region that holds
  // things and can't be mistaken for any of the four solid shapes at any size. The corner
  // radius is the frame's own (rx=10 on canvas, see Canvas.tsx), scaled down.
  frame: (
    <path
      d="M2 5.6V3.4A1.4 1.4 0 0 1 3.4 2h2.2M10.4 2h2.2A1.4 1.4 0 0 1 14 3.4v2.2M14 10.4v2.2a1.4 1.4 0 0 1-1.4 1.4h-2.2M5.6 14H3.4A1.4 1.4 0 0 1 2 12.6v-2.2"
    />
  ),
};

export function ShapeIcon({ kind }: { kind: DrawKind }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {PATHS[kind]}
    </svg>
  );
}
