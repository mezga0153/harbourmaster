import type { JSX } from 'preact';

const PATHS: Record<string, JSX.Element> = {
  select: <path d="M6 3l12 9-5.5 1L15 20l-3 1.3-2.6-6.6L6 18z" />,
  road: (
    <>
      <path d="M8 3L5 21M16 3l3 18" />
      <path d="M12 4v3M12 10.5v3M12 17v3" />
    </>
  ),
  footpath: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1" />
      <rect x="13" y="4" width="7" height="7" rx="1" />
      <rect x="4" y="13" width="7" height="7" rx="1" />
      <rect x="13" y="13" width="7" height="7" rx="1" />
    </>
  ),
  jetty: (
    <>
      <path d="M3 9h18M3 13h18" />
      <path d="M6 9v4M10 9v4M14 9v4M18 9v4" />
      <path d="M5 13v6M19 13v6" />
      <path d="M2 20c2-1.2 3-1.2 5 0s3 1.2 5 0 3-1.2 5 0 3 1.2 5 0" />
    </>
  ),
  truckBay: (
    <>
      <path d="M2 7h11v9H2zM13 10h4l3 3v3h-7" />
      <circle cx="6" cy="17.5" r="1.8" />
      <circle cx="16.5" cy="17.5" r="1.8" />
    </>
  ),
  bulldoze: (
    <>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
      <path d="M10 11v5M14 11v5" />
    </>
  ),
  hire: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.8-4 3.4-6 6.5-6s5.7 2 6.5 6" />
      <path d="M19 8v6M16 11h6" />
    </>
  ),
  pause: <path d="M8 5v14M16 5v14" />,
  save: (
    <>
      <path d="M5 4h11l3 3v13H5z" />
      <path d="M8 4v5h7V4M8 20v-6h8v6" />
    </>
  ),
  map: (
    <>
      <path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z" />
      <path d="M9 4v14M15 6v14" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  anchor: (
    <>
      <circle cx="12" cy="5" r="2" />
      <path d="M12 7v14M8 11h8" />
      <path d="M4.5 14a7.5 7.5 0 0015 0" />
    </>
  ),
  coins: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.8-4 3.4-6 6.5-6s5.7 2 6.5 6" />
      <path d="M16 4.5a3.5 3.5 0 010 7M18 14c2 .8 3.2 2.8 3.5 6" />
    </>
  ),
  box: (
    <>
      <path d="M3 7.5L12 3l9 4.5v9L12 21l-9-4.5z" />
      <path d="M3 7.5L12 12l9-4.5M12 12v9" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3l9.5 17h-19z" />
      <path d="M12 10v4.5M12 17.5v.5" />
    </>
  ),
  contract: (
    <>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M9 9h6M9 13h7M9 17h4" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      class="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
