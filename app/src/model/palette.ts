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

/** Default flat fill for sticky-note shapes when no explicit color is set. */
export const STICKY_DEFAULT = '#f6e58d';
