export type ActivityIconName = 'files' | 'icons' | 'templates' | 'properties';
export type TemplateCategoryIconName =
  | 'all'
  | 'people'
  | 'nature'
  | 'town'
  | 'device'
  | 'dev'
  | 'office'
  | 'symbol'
  | 'award'
  | 'life';

type PochiIconName = ActivityIconName | TemplateCategoryIconName;

function IconDrawing({ name }: { name: PochiIconName }) {
  switch (name) {
    case 'files':
      return <path d="M2.5 5.5V4.2c0-.9.7-1.7 1.7-1.7h3l1.7 2h6.9c.9 0 1.7.8 1.7 1.7v9.1c0 1.2-1 2.2-2.2 2.2H4.7c-1.2 0-2.2-1-2.2-2.2V5.5Zm0 2h15" />;
    case 'icons':
      return (
        <>
          <path d="m10 2.5 2.1 4.3 4.7.7-3.4 3.3.8 4.7-4.2-2.2-4.2 2.2.8-4.7-3.4-3.3 4.7-.7L10 2.5Z" />
          <path d="M16.5 2.5v2M15.5 3.5h2M3.5 15.5v2M2.5 16.5h2" />
        </>
      );
    case 'templates':
      return (
        <>
          <path d="M7 7V5.2a3 3 0 0 1 6 0V7" />
          <path d="M6.2 7h7.6l.7 5.5H5.5L6.2 7Z" />
          <path d="M4 12.5h12a1.5 1.5 0 0 1 1.5 1.5v1H2.5v-1A1.5 1.5 0 0 1 4 12.5ZM3.5 17.5h13" />
        </>
      );
    case 'properties':
      return (
        <>
          <path d="M3 5h3M10 5h7M3 10h8M15 10h2M3 15h5M12 15h5" />
          <circle cx="8" cy="5" r="1.8" />
          <circle cx="13" cy="10" r="1.8" />
          <circle cx="10" cy="15" r="1.8" />
        </>
      );
    case 'all':
      return (
        <>
          <rect x="2.5" y="2.5" width="6" height="6" rx="1.5" />
          <rect x="11.5" y="2.5" width="6" height="6" rx="1.5" />
          <rect x="2.5" y="11.5" width="6" height="6" rx="1.5" />
          <rect x="11.5" y="11.5" width="6" height="6" rx="1.5" />
        </>
      );
    case 'people':
      return (
        <>
          <circle cx="10" cy="6" r="3.5" />
          <path d="M3.5 17c.6-3.4 3-5.2 6.5-5.2s5.9 1.8 6.5 5.2" />
        </>
      );
    case 'nature':
      return <path d="M4 16c5.7-.3 10.4-4.2 12-12-7.8 1.6-11.7 6.3-12 12Zm0 0c2.7-3.3 5.7-5.7 9.2-7.5" />;
    case 'town':
      return <path d="m2.5 9 7.5-6 7.5 6M4.5 7.5v9.8h11V7.5M8 17.3v-6h4v6" />;
    case 'device':
      return <path d="M4 3.5h12v10H4zM2.5 16.5h15M7 13.5l-.7 3M13 13.5l.7 3" />;
    case 'dev':
      return <path d="m7.5 6-3.5 4 3.5 4M12.5 6l3.5 4-3.5 4M11.5 3.5l-3 13" />;
    case 'office':
      return (
        <>
          <path d="M5 2.5h7l3 3v12H5zM12 2.5v3h3M8 9h4M8 12h4" />
          <path d="m3 15.5 1.5 1.5" />
        </>
      );
    case 'symbol':
      return (
        <>
          <circle cx="5.5" cy="5.5" r="3" />
          <path d="m14.5 2.5 3 5h-6l3-5ZM3 12h6v5.5H3zM12 12h5.5v5.5H12z" />
        </>
      );
    case 'award':
      return (
        <>
          <circle cx="10" cy="8" r="5" />
          <path d="m6.5 11.5-1 6 4.5-2.3 4.5 2.3-1-6M10 5.2l.8 1.7 1.9.2-1.4 1.3.4 1.9-1.7-.9-1.7.9.4-1.9-1.4-1.3 1.9-.2.8-1.7Z" />
        </>
      );
    case 'life':
      return <path d="M3.5 6h10v6.5a4 4 0 0 1-4 4h-2a4 4 0 0 1-4-4V6ZM13.5 8h1.3a2.7 2.7 0 0 1 0 5.4h-1.6M6 2.5v1M9 2.5v1M12 2.5v1" />;
  }
}

export function PochiIcon({ name, size = 20 }: { name: PochiIconName; size?: number }) {
  return (
    <svg
      className="pochi-icon"
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <IconDrawing name={name} />
    </svg>
  );
}
