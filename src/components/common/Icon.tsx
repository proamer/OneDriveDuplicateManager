const PATHS: Record<IconName, string> = {
  dashboard: 'M3 3h7v7H3V3Zm11 0h7v5h-7V3ZM3 14h7v7H3v-7Zm11-2h7v9h-7v-9Z',
  scan: 'M11 4a7 7 0 1 0 4.9 12L21 21l-1.4 1.4-5.1-5.1A7 7 0 0 0 11 4Zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z',
  copies: 'M8 4h12v12h-2V6H8V4ZM4 8h12v12H4V8Zm2 2v8h8v-8H6Z',
  trash: 'M9 3h6v2h5v2H4V5h5V3ZM6 8h12l-1 13H7L6 8Zm4 3v7h1.5v-7H10Zm3 0v7h1.5v-7H13Z',
  history: 'M12 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7v3l4.5-4L12 0v3Zm-1 5v5l4 2.4.8-1.4-3.3-2V8H11Z',
  settings: 'M4 7h10v2H4V7Zm12 0h4v2h-4V7Zm-8 8h12v2H8v-2Zm-4 0h2v2H4v-2Zm8-4.5a2.5 2.5 0 1 1 5 0 2.5 2.5 0 0 1-5 0ZM6 13.5a2.5 2.5 0 1 1 5 0 2.5 2.5 0 0 1-5 0Z',
  external: 'M14 4h6v6h-2V7.4l-7.3 7.3-1.4-1.4L16.6 6H14V4ZM5 6h6v2H7v9h9v-4h2v6H5V6Z',
  image: 'M4 5h16v14H4V5Zm2 2v10h12V7H6Zm2 7 2.5-3 2 2.4L15 10l3 4H8Zm1-5.5A1.5 1.5 0 1 1 9 11a1.5 1.5 0 0 1 0-2.5Z',
};

export type IconName =
  | 'dashboard'
  | 'scan'
  | 'copies'
  | 'trash'
  | 'history'
  | 'settings'
  | 'external'
  | 'image';

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={PATHS[name]} fillRule="evenodd" />
    </svg>
  );
}

/** Microsoft four-square mark for the sign-in button. */
export function MicrosoftLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}
