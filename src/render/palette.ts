// Colours from plan.md §9, tuned against example.png.

export const C = {
  grass: 0x8fc45c,
  grassSide: 0x7a5d3f,
  sand: 0xead39c,
  sandSide: 0xcfb27a,
  rock: 0x9ea5ac,
  rockGround: 0xa9b07f,

  waterShallow: 0x5fcfe9,
  waterMid: 0x2b92d8,
  waterDeep: 0x1c64ae,
  foam: 0xf4fbff,

  asphalt: 0x737a82,
  marking: 0xf5f5f0,
  path: 0xdcd6c8,
  pathEdge: 0xb9b2a2,
  concrete: 0xd9dde0,
  stripe: 0xf2c230,
  sign: 0x2f6fd0,
  wood: 0xb07a43,
  woodDark: 0x7a5230,

  crate: 0xc58d50,
  crateLid: 0xa8733c,

  vest: 0xff8a1f,
  skin: 0xf1c59b,
  trousers: 0x2d4a7a,
  hat: 0xf5c02a,

  hulls: [0x24324a, 0xb33a32, 0x2f6fd0, 0x2e7d4f],
  cabin: 0xf4f4f0,
  window: 0x2b3a4f,
  funnel: 0xd6453d,

  trucks: [0xd6453d, 0x2f6fd0, 0xf2c230, 0x3fa34d, 0xf4f4f0],
  tyre: 0x22262b,
  chassis: 0x41464d,

  leaves: [0x3f8f4a, 0x4fa65a, 0x5bb365],
  trunk: 0x7a5230,
} as const;
