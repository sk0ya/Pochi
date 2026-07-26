import { describe, expect, it } from 'vitest';
import { attributionForIcon, decodeIconDrag, encodeIconDrag, ICON_DRAG_MIME, iconAttributionTooltip, iconSvgUrl } from './icons';

describe('Iconify API icons', () => {
  it('uses an independent drag payload', () => {
    expect(ICON_DRAG_MIME).toBe('application/x-pochi-icon');
  });

  it('builds a safe SVG endpoint for a valid Iconify name', () => {
    expect(iconSvgUrl('devicon:docker')).toBe(
      'https://api.iconify.design/devicon/docker.svg?color=%2364748b',
    );
    expect(iconSvgUrl('simple-icons:github')).toBe(
      'https://api.iconify.design/simple-icons/github.svg?color=%2364748b',
    );
  });

  it('rejects malformed icon names instead of putting them in a URL', () => {
    expect(iconSvgUrl('')).toBe('');
    expect(iconSvgUrl('devicon:../../bad')).toBe('');
    expect(iconSvgUrl('https://evil.example/icon')).toBe('');
  });

  it('retains collection license metadata in a drag payload', () => {
    const attribution = attributionForIcon('simple-icons:github', {
      'simple-icons': {
        name: 'Simple Icons',
        author: { name: 'Simple Icons Contributors', url: 'https://simpleicons.org/' },
        license: { title: 'CC0 1.0', spdx: 'CC0-1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
      },
    });
    expect(attribution).toMatchObject({
      iconName: 'simple-icons:github',
      collectionName: 'Simple Icons',
      license: 'CC0-1.0',
      brand: true,
    });
    expect(decodeIconDrag(encodeIconDrag({ iconName: attribution.iconName, attribution }))).toEqual({
      iconName: attribution.iconName,
      attribution,
    });
    expect(iconAttributionTooltip(attribution)).toBe(
      [
        'アイコン: simple-icons:github',
        'セット: Simple Icons',
        '作者: Simple Icons Contributors',
        'ライセンス: CC0-1.0',
        '取得元: Iconify',
        '※ 商標・ブランド利用規約も適用されます',
      ].join('\n'),
    );
  });
});
