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
  eraser: (
    <>
      <path d="M8 20l-4-4a2 2 0 010-2.8l9.2-9.2a2 2 0 012.8 0l4 4a2 2 0 010 2.8L13 18" />
      <path d="M8 20h12M10 8l6 6" />
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
  tractor: (
    <>
      <path d="M1 15h14M15 15V9h4l3 4v2h-7" />
      <rect x="2" y="9" width="11" height="5" />
      <circle cx="5" cy="18" r="2" />
      <circle cx="18" cy="18" r="2" />
    </>
  ),
  portRoad: (
    <>
      <path d="M4 3v18M20 3v18" />
      <path d="M12 4v3M12 11v3M12 18v2" />
    </>
  ),
  warehouse: (
    <>
      <path d="M2 10l10-6 10 6v10H2z" />
      <path d="M5 20v-7h6v7M13 20v-7h6v7" />
    </>
  ),
  buoyIn: (
    <>
      <path d="M2 20c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0" />
      <path d="M8 17h8l-1-6H9zM12 4l-3 7h6z" />
    </>
  ),
  buoyOut: (
    <>
      <path d="M2 20c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0" />
      <path d="M8 17h8l-1-6H9zM9.5 5h5v6h-5z" />
    </>
  ),
  dredge: (
    <>
      <path d="M2 18c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0" />
      <path d="M12 3v10M8 9l4 4 4-4" />
    </>
  ),
  reclaim: (
    <>
      <path d="M2 18c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0" />
      <path d="M12 14V4M8 8l4-4 4 4" />
    </>
  ),
  gate: (
    <>
      <rect x="3" y="8" width="5" height="12" />
      <path d="M8 12h13M12 12v8M3 20h18" />
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
  dollar: (
    <path d="M12 3v18M16.5 7.6C15.8 6.3 14.2 5.5 12 5.5c-2.6 0-4.4 1.3-4.4 3.2 0 4.6 9.3 2.4 9.3 7 0 2-1.9 3.3-4.9 3.3-2.3 0-4-.9-4.9-2.4" />
  ),
  folder: (
    <path d="M3 6.5A1.5 1.5 0 014.5 5H9l2 2.5h8.5A1.5 1.5 0 0121 9v9.5a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 18.5z" />
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
  town: (
    <>
      <path d="M2 21h20M4 21V11l4-3 4 3v10M12 21V5h8v16" />
      <path d="M15 9h2M15 13h2M15 17h2M7 15h2" />
    </>
  ),
  train: (
    <>
      <rect x="5" y="3" width="14" height="14" rx="3" />
      <path d="M5 10h14M9 17l-2.5 4M15 17l2.5 4M8.5 13.5v.5M15.5 13.5v.5" />
    </>
  ),
  contract: (
    <>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M9 9h6M9 13h7M9 17h4" />
    </>
  ),
  parking: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M10 16V8h3a2.5 2.5 0 0 1 0 5h-3" />
    </>
  ),
  book: (
    <>
      <path d="M4 5c3-1.5 5.5-1.5 8 0v15c-2.5-1.5-5-1.5-8 0z" />
      <path d="M20 5c-3-1.5-5.5-1.5-8 0v15c2.5-1.5 5-1.5 8 0z" />
    </>
  ),
  oneWay: (
    <>
      <path d="M4 12h14" />
      <path d="M13 7l5 5-5 5" />
      <path d="M4 5h16M4 19h16" />
    </>
  ),
  lights: (
    <>
      <rect x="8" y="2.5" width="8" height="15" rx="2" />
      <circle cx="12" cy="6.5" r="1.6" />
      <circle cx="12" cy="13" r="1.6" />
      <path d="M12 17.5v4" />
    </>
  ),
  roundabout: (
    <>
      <circle cx="12" cy="12" r="5" />
      <path d="M12 2v5M12 17v5M2 12h5M17 12h5" />
      <path d="M15.5 7.8l1.2 1.7-2 .3" />
    </>
  ),
  exit: (
    <>
      <path d="M7 21V3M11 21V3" />
      <path d="M11 13c4 0 6-2 8-5" />
      <path d="M16 7.5l3 .5-.3 3" />
    </>
  ),
  sound: (
    <>
      <path d="M4 9h3l5-4v14l-5-4H4z" />
      <path d="M15.5 9.5a3.5 3.5 0 010 5M18 7a7 7 0 010 10" />
    </>
  ),
  mute: (
    <>
      <path d="M4 9h3l5-4v14l-5-4H4z" />
      <path d="M16 9.5l5 5M21 9.5l-5 5" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  rotateLeft: (
    <>
      <path d="M4 12a8 8 0 108-8 8.5 8.5 0 00-5.7 2.3L4 8.5" />
      <path d="M4 4v4.5h4.5" />
    </>
  ),
  rotateRight: (
    <>
      <path d="M20 12a8 8 0 11-8-8 8.5 8.5 0 015.7 2.3L20 8.5" />
      <path d="M20 4v4.5h-4.5" />
    </>
  ),
  turn: (
    <>
      <rect x="5" y="9" width="10" height="10" rx="1.5" />
      <path d="M11 5h3a5 5 0 015 5v1" />
      <path d="M17 9l2 2 2-2" />
    </>
  ),
  chat: (
    <>
      <path d="M4 5.5A1.5 1.5 0 015.5 4h13A1.5 1.5 0 0120 5.5v9a1.5 1.5 0 01-1.5 1.5H10l-4.5 4v-4h0A1.5 1.5 0 014 14.5z" />
      <path d="M8 8.5h8M8 12h5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
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
