/**
 * Storage encoding for inserted bitmaps.
 *
 * A pasted or imported image used to be stored exactly as it arrived — a phone screenshot
 * or camera photo at 2000-4000px on its longest edge, base64'd into the document — while
 * only ever being *drawn* at IMAGE_MAX_DIM (320px). That was by a wide margin the largest
 * contributor to a saved diagram's size, and the one part of a document that compression
 * cannot help with: PNG and JPEG payloads are already deflated, so deflating them again
 * gives back nothing and base64 has already added a third on top. Fewer pixels is the only
 * lever, which makes this step lossy — hence the guards below, which leave the source
 * untouched in every case where re-encoding would cost quality or bytes rather than save
 * them.
 *
 * Only the two bitmap entry points go through here (the file dialog and clipboard paste, both
 * via addImageFromDataUrl in App.tsx). Iconify icons dispatch ADD_IMAGE directly with the SVG
 * they fetched and never reach this module.
 */

/** Longest edge a stored bitmap is resampled down to.
 *
 * Deliberately several times the 320px insert size rather than equal to it: a placed image
 * can be resized larger, and the canvas zooms, so storing at exactly the display size would
 * show. 1280 still looks sharp through either, while cutting a typical screenshot or photo
 * by an order of magnitude. */
export const IMAGE_STORE_MAX_DIM = 1280;

/** Quality for the WebP re-encode. High enough that screenshot text stays crisp at the sizes
 * Pochi draws images at, low enough that a photo compresses well. */
export const IMAGE_STORE_QUALITY = 0.9;

/** Factor to scale a source bitmap by for storage. Never above 1: an image already smaller
 * than the cap keeps its own resolution instead of being upscaled, which would add bytes
 * without adding detail. */
export function storedImageScale(w: number, h: number): number {
  return Math.min(1, IMAGE_STORE_MAX_DIM / Math.max(w, h, 1));
}

/** Reads the media type out of a `data:` URL, lowercased (`''` for anything else). */
export function dataUrlMediaType(src: string): string {
  const m = /^data:([^;,]*)/i.exec(src);
  return m ? m[1].toLowerCase() : '';
}

/** Whether a bitmap re-encode is appropriate for `src` at all.
 *
 * Two media types are stored verbatim however large they are:
 *
 * - `image/svg+xml` is vector. Rasterizing it would throw away its resolution independence
 *   *and* grow it, since an SVG is already far smaller than any bitmap encoding of itself.
 *   (Pochi's own icons are SVG, and `accept="image/*"` on the file dialog lets a user pick
 *   one directly.)
 * - `image/gif` may be animated, and a canvas re-encode would silently flatten it to the
 *   first frame. Detecting animation properly means parsing the GIF blocks; skipping the
 *   format is the cheaper trade, and pasted GIFs are rare next to screenshots.
 *
 * Anything that isn't a `data:` URL is also left alone — there is nothing decoded to resample.
 */
export function shouldReencodeImage(src: string): boolean {
  const type = dataUrlMediaType(src);
  return type.startsWith('image/') && type !== 'image/svg+xml' && type !== 'image/gif';
}

export interface StoredImage {
  /** What to persist in the document: the re-encoded bitmap, or the source unchanged. */
  src: string;
  /** Natural size of the *source* image. The caller lays the shape out from this, so the
   * placed size and aspect ratio come out identical whether or not `src` was re-encoded. */
  w: number;
  h: number;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Decodes `dataUrl`, resamples it to at most IMAGE_STORE_MAX_DIM on its longest edge, and
 * re-encodes it as WebP — chosen over PNG because it keeps alpha while compressing the
 * photos and screenshots this targets far better.
 *
 * Falls back to the source string, still reporting the dimensions it decoded, whenever
 * re-encoding isn't a clear win: a vector or animated source (see `shouldReencodeImage`), no
 * 2D context, an encoder that throws, or — the case that catches both an already-small image
 * and a source whose format simply beats WebP on this content — output no smaller than the
 * input. `toDataURL` also falls back to PNG on its own if WebP is unavailable, which that
 * same size comparison then accepts or discards on its merits.
 *
 * Resolves null only if the image cannot be decoded at all, leaving the fallback the caller
 * already had for that case.
 */
export async function encodeImageForStorage(dataUrl: string): Promise<StoredImage | null> {
  const img = await loadImage(dataUrl);
  if (!img) return null;
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  // A loaded SVG without intrinsic dimensions reports 0 here; treat it as undecodable so the
  // caller applies its default box rather than dividing by zero building the shape.
  if (!w || !h) return null;
  if (!shouldReencodeImage(dataUrl)) return { src: dataUrl, w, h };

  const scale = storedImageScale(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return { src: dataUrl, w, h };
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  let encoded: string;
  try {
    encoded = canvas.toDataURL('image/webp', IMAGE_STORE_QUALITY);
  } catch {
    return { src: dataUrl, w, h };
  }
  return { src: encoded.length < dataUrl.length ? encoded : dataUrl, w, h };
}
