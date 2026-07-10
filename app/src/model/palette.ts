/** Fixed accent palette for shapes/connectors. `undefined` color = theme default. */
export interface PaletteColor {
  key: string;
  hex: string;
  label: string;
}

export const PALETTE: PaletteColor[] = [
  { key: 'red', hex: '#e5484d', label: '赤' },
  { key: 'orange', hex: '#f4a83b', label: '橙' },
  { key: 'yellow', hex: '#e0c33e', label: '黄' },
  { key: 'green', hex: '#3dbd6b', label: '緑' },
  { key: 'blue', hex: '#4da3ff', label: '青' },
  { key: 'purple', hex: '#a374e0', label: '紫' },
  { key: 'pink', hex: '#e56ba8', label: 'ピンク' },
];

/** Light fill tint for a stroke color (low-opacity hex suffix). */
export const fillTint = (hex: string): string => `${hex}22`;

/** Default background for flat-filled shapes (the "filled" style option) when no explicit color is set. */
export const FLAT_FILL_DEFAULT = '#f6e58d';

/** Dark/light label colors chosen for readability against a flat-filled background. */
const READABLE_DARK = '#222933';
const READABLE_LIGHT = '#f5f6f8';

/** Picks a dark or light label color with enough contrast against a flat hex background
 * (relative luminance threshold), so labels stay readable regardless of fill color. */
export function readableTextColor(bgHex: string): string {
  const hex = bgHex.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.6 ? READABLE_DARK : READABLE_LIGHT;
}
