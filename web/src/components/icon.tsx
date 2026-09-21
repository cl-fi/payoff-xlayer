import type { CSSProperties } from 'react';
export type IconName =
  | 'arrow'
  | 'down'
  | 'up'
  | 'wallet'
  | 'check'
  | 'close'
  | 'clock'
  | 'external'
  | 'refresh'
  | 'info'
  | 'layers'
  | 'chart'
  | 'chevron'
  | 'settings'
  | 'shield'
  | 'copy';
const paths: Record<IconName, string> = {
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  down: 'M6 6l12 12M6 18h12V6',
  up: 'M6 18 18 6M6 6h12v12',
  wallet: 'M20 8V5H5a2 2 0 0 0 0 4h16v11H5a2 2 0 0 1-2-2V7m18 5h-5v5h5m-3-2.5h.01',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12M6 18 18 6',
  clock: 'M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  external: 'M14 3h7v7m0-7L10 14M10 3H4v17h17v-6',
  refresh: 'M20 7V3m0 4h-4m4 0a8 8 0 1 0 1 8',
  info: 'M12 11v6m0-10v.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  layers: 'm3 8 9-5 9 5-9 5-9-5m0 5 9 5 9-5m-18 5 9 5 9-5',
  chart: 'M4 4v16h16M8 15l4-5 4 2 5-8',
  chevron: 'm9 5 7 7-7 7',
  settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3m-4 9 3 3 5-6',
  copy: 'M8 8h12v13H8zM16 8V3H3v13h5',
};
export function Icon({
  name,
  size = 18,
  className,
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
export function Mark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M1 15.25 L6.275 15.25 L16.275 5.25 L23 5.25 L23 8.75 L17.725 8.75 L7.725 18.75 L1 18.75 Z"
        fill="currentColor"
      />
    </svg>
  );
}
