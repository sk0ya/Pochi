/**
 * Rasterizes an SVG export to a PNG and copies it to the OS clipboard, falling
 * back to a file download when the Clipboard API is unavailable or the write
 * throws (no permission, unsupported browser/host, ...).
 *
 * DOM/canvas/clipboard-dependent, so this is intentionally thin and untested
 * (no DOM in the vitest environment) — the pure pieces (selection subsetting,
 * SVG serialization) live in model/doc.ts and model/svg.ts and are tested there.
 */

const EXPORT_SCALE = 2;

/** SVG string -> PNG blob, rendered at `scale`x onto a `background`-colored canvas backing
 * for crispness and to avoid transparency (the SVG already paints its own background rect in
 * the same theme color, but the canvas fill guards against any gaps at the rasterized edges,
 * so it must match the SVG's background or those edges fringe). `size` is the SVG's own
 * pixel size (exportViewport), passed explicitly rather than re-parsed out of the markup. */
async function rasterizePng(
  svg: string,
  size: { w: number; h: number },
  scale: number,
  background: string,
): Promise<Blob> {
  const { w, h } = size;
  // Object URLs are same-origin to the document that created them (unlike a
  // fetched cross-origin image), so drawing this into a canvas never taints
  // it — even though shape.src image fills are embedded as data: URLs inside
  // the SVG markup, those are inlined content, not a cross-origin fetch.
  const svgUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('svg decode failed'));
      img.src = svgUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('canvas.toBlob failed');
    return blob;
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Renders `svg` (whose pixel size is `size`) to a PNG (2x scale) and copies it to the OS
 * clipboard; downloads `downloadName` instead if the Clipboard API is unavailable or the
 * write throws. `background` must match the SVG's own background color (exportBackground
 * in model/svg.ts) — see rasterizePng. */
export async function copySvgAsPng(
  svg: string,
  size: { w: number; h: number },
  background = '#ffffff',
  downloadName = 'diagram.png',
): Promise<'clipboard' | 'download'> {
  const blob = await rasterizePng(svg, size, EXPORT_SCALE, background);
  try {
    if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return 'clipboard';
    }
  } catch {
    /* permission denied or unsupported; fall back to download below */
  }
  downloadBlob(blob, downloadName);
  return 'download';
}
