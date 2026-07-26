import { useEffect, useMemo, useState } from 'react';
import type { Dispatch } from 'react';
import {
  attributionForIcon,
  encodeIconDrag,
  fetchIconDataUrl,
  ICON_DRAG_MIME,
  iconAttributionTooltip,
  iconSvgUrl,
  searchIcons,
} from '../model/icons';
import type { IconSetFilter } from '../model/icons';
import type { IconAttribution } from '../model/types';
import type { Action } from '../state/reducer';

const FILTERS: Array<{ id: IconSetFilter; label: string }> = [
  { id: 'all', label: 'Iconify' },
  { id: 'devicon', label: 'Devicon' },
  { id: 'simple-icons', label: 'Simple Icons' },
];
const ALL_LICENSES = '__all__';
const UNKNOWN_LICENSE = '__unknown__';

export function IconSidebar({ dispatch }: { dispatch: Dispatch<Action> }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<IconSetFilter>('all');
  const [icons, setIcons] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [collections, setCollections] = useState<Awaited<ReturnType<typeof searchIcons>>['collections']>({});
  const [licenseFilter, setLicenseFilter] = useState(ALL_LICENSES);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setIcons([]);
      setTotal(0);
      setLoading(false);
      setError('');
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError('');
      void searchIcons(q, filter, controller.signal)
        .then((result) => {
          setIcons(result.icons);
          setTotal(result.total);
          setCollections(result.collections);
        })
        .catch((reason: unknown) => {
          if ((reason as { name?: string }).name !== 'AbortError') {
            setError('アイコンを検索できませんでした');
            setIcons([]);
          }
        })
        .finally(() => setLoading(false));
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, filter]);

  const attributions = useMemo(
    () => new Map(icons.map((iconName) => [iconName, attributionForIcon(iconName, collections)])),
    [icons, collections],
  );
  const licenseOptions = useMemo(
    () => [...new Set(
      [...attributions.values()]
        .map((attribution) => attribution.license)
        .filter((license): license is string => !!license),
    )].sort((a, b) => a.localeCompare(b)),
    [attributions],
  );
  const hasUnknownLicense = [...attributions.values()].some((attribution) => !attribution.license);
  const visibleIcons = icons.filter((iconName) => {
    const license = attributions.get(iconName)?.license;
    return licenseFilter === ALL_LICENSES ||
      (licenseFilter === UNKNOWN_LICENSE ? !license : license === licenseFilter);
  });

  useEffect(() => {
    const unavailableKnown = licenseFilter !== ALL_LICENSES &&
      licenseFilter !== UNKNOWN_LICENSE &&
      !licenseOptions.includes(licenseFilter);
    if (unavailableKnown || (licenseFilter === UNKNOWN_LICENSE && !hasUnknownLicense)) {
      setLicenseFilter(ALL_LICENSES);
    }
  }, [hasUnknownLicense, licenseFilter, licenseOptions]);

  const insert = async (iconName: string, iconAttribution: IconAttribution) => {
    if (
      !iconAttribution.license &&
      !window.confirm('このアイコンセットのライセンス情報を確認できません。取得して挿入しますか？')
    ) return;
    try {
      setError('');
      const src = await fetchIconDataUrl(iconName);
      dispatch({ type: 'ADD_IMAGE', src, w: 96, h: 96, iconAttribution });
    } catch {
      setError('アイコンを取得できませんでした');
    }
  };

  return (
    <aside className="icon-sidebar">
      <div className="sidebar-title">アイコン</div>
      <div className="icon-set-filter">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            className={filter === item.id ? 'active' : ''}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <input
        className="icon-search"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="例: docker, github, home"
        aria-label="Iconifyのアイコンを検索"
      />
      <label className="icon-license-filter">
        <span>ライセンス</span>
        <select value={licenseFilter} onChange={(e) => setLicenseFilter(e.target.value)}>
          <option value={ALL_LICENSES}>すべて</option>
          {licenseOptions.map((license) => <option key={license} value={license}>{license}</option>)}
          {hasUnknownLicense && <option value={UNKNOWN_LICENSE}>不明</option>}
        </select>
      </label>
      {total > icons.length && <div className="icon-result-count">{total}件中、先頭{icons.length}件</div>}
      {icons.length > 0 && licenseFilter !== ALL_LICENSES && (
        <div className="icon-result-count">検索結果内: {visibleIcons.length}件</div>
      )}
      <div className="icon-grid">
        {visibleIcons.map((iconName) => {
          const label = iconName.slice(iconName.indexOf(':') + 1);
          const attribution = attributions.get(iconName)!;
          const license = attribution.license || 'ライセンス不明';
          return (
            <button
              key={iconName}
              className="icon-card"
              draggable={!!attribution.license}
              onDragStart={(e) => {
                if (!attribution.license) {
                  e.preventDefault();
                  return;
                }
                e.dataTransfer.setData(ICON_DRAG_MIME, encodeIconDrag({ iconName, attribution }));
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => void insert(iconName, attribution)}
              title={iconAttributionTooltip(attribution)}
            >
              <img className="icon-preview" src={iconSvgUrl(iconName)} alt="" />
              <span>{label}</span>
              <span className={`icon-license${attribution.license ? '' : ' unknown'}`}>{license}</span>
            </button>
          );
        })}
        {!query.trim() && <div className="context-hint">キーワードを入力して検索</div>}
        {loading && <div className="context-hint">検索中…</div>}
        {!loading && query.trim() && icons.length === 0 && !error && <div className="context-hint">一致するアイコンがありません</div>}
        {!loading && icons.length > 0 && visibleIcons.length === 0 && <div className="context-hint">このライセンスのアイコンはありません</div>}
        {error && <div className="context-hint">{error}</div>}
      </div>
      <div className="icon-legal-note">
        セットごとにライセンスが異なります。ブランドロゴには各社の商標・ブランド利用規約も適用されます。
      </div>
    </aside>
  );
}
