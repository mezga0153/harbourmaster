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
  quay: (
    <>
      <path d="M3 9h18v5H3z" />
      <path d="M6 14v6M18 14v6M3 20c2-1.2 3-1.2 5 0s3 1.2 5 0 3-1.2 5 0 3 1.2 5 0" />
      <path d="M7 9V7M17 9V7" />
    </>
  ),
  crane: (
    <>
      <path d="M7 21V5M4 21h6M7 5l13 3M7 8l13 0" />
      <path d="M18 8v6M16.5 14h3" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 018 0v3" />
    </>
  ),
  stairs: <path d="M3 20h5v-5h5v-5h5V5h3" />,
  office: (
    <>
      <path d="M5 21V9h14v12M3 21h18M8 12h2M14 12h2M8 16h2M14 16h2" />
      <path d="M9 9V5h6v4M12 5V2" />
    </>
  ),
  bigTruck: (
    <>
      <path d="M1 6h14v10H1zM15 9h4l3 3v4h-7" />
      <circle cx="5" cy="17.5" r="1.8" />
      <circle cx="10" cy="17.5" r="1.8" />
      <circle cx="18" cy="17.5" r="1.8" />
    </>
  ),
  bigCrane: (
    <>
      <path d="M6 21V6M10 21V6M4 21h8M6 10h4M6 14h4" />
      <path d="M4 6h18M16 6v5M14.5 11h3v3h-3z" />
    </>
  ),
  stacker: (
    <>
      <path d="M2 17V11h8l2 3v3M12 14l9-8" />
      <rect x="16" y="2" width="7" height="5" />
      <circle cx="5" cy="18" r="2" />
      <circle cx="10" cy="18" r="2" />
    </>
  ),
  lane: (
    <>
      <path d="M5 3v18M19 3v18" />
      <path d="M9 14h4l1.5 3V19H9zM14.5 14V9" />
    </>
  ),
  garage: (
    <>
      <path d="M3 10l9-6 9 6v10H3z" />
      <path d="M7 20v-7h10v7M7 15.5h10M7 18h10" />
    </>
  ),
  fuel: (
    <>
      <path d="M5 21V5a2 2 0 012-2h6a2 2 0 012 2v16M3 21h14M7 8h6" />
      <path d="M15 10h2a2 2 0 012 2v5a1.5 1.5 0 003 0V9l-3-3" />
    </>
  ),
  forklift: (
    <>
      <path d="M3 17V9h7l2 4v4M14 5v14M14 17h7" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="11" cy="18" r="2" />
    </>
  ),
  hut: (
    <>
      <path d="M3 11l9-7 9 7" />
      <path d="M5 10v10h14V10" />
      <path d="M10 20v-5h4v5" />
    </>
  ),
  bolt: <path d="M13 2L4 14h7l-1 8 9-12h-7z" />,
  smile: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14.5c1 1.2 2.1 1.8 3.5 1.8s2.5-.6 3.5-1.8M9 9.5v.5M15 9.5v.5" />
    </>
  ),
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
