import type { Pt } from '../model/types';
import type { View } from '../state/reducer';

/** Stable per-peer hue from the peer id, so a peer keeps its color across sessions. */
function peerHue(peerId: string): number {
  let h = 0;
  for (let i = 0; i < peerId.length; i++) h = (h * 31 + peerId.charCodeAt(i)) % 360;
  return h;
}

/** Other collaborators' cursors, drawn over the canvas in screen space.
 * Purely decorative: pointer-events pass through to the canvas below. */
export function RemoteCursors({ cursors, view }: { cursors: Record<string, Pt>; view: View }) {
  const entries = Object.entries(cursors);
  if (!entries.length) return null;
  return (
    <div className="remote-cursors">
      {entries.map(([peerId, p]) => {
        const hue = peerHue(peerId);
        return (
          <div
            key={peerId}
            className="remote-cursor"
            style={{
              left: p.x * view.scale + view.x,
              top: p.y * view.scale + view.y,
              // Fixed lightness/saturation keep every peer readable on both themes.
              ['--peer-color' as string]: `hsl(${hue} 75% 55%)`,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16">
              <path d="M2 1 L14 8 L8 9.5 L5.5 15 Z" fill="var(--peer-color)" stroke="white" strokeWidth="1" />
            </svg>
            <span className="remote-cursor-name">{peerId.slice(0, 4)}</span>
          </div>
        );
      })}
    </div>
  );
}
