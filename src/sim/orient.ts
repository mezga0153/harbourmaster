// The bits of `GameMap.orient` beyond the facing in its lowest two bits
// (0 +x, 1 +y south, 2 -x, 3 -y north). What a bit means depends on what
// stands on the tile, so some bits mean several things: 16 is an exit on a
// highway tile, one way on a road, in only on a port gate, and marks
// parking on port road; 32 is lights on a junction, out only on a gate, and
// a parking lot turned round.

/** Facings, as in `GameMap.orient`: 0 +x, 1 +y (south), 2 -x, 3 -y (north). */
export const SOUTH = 1;
export const NORTH = 3;

/** Marks the other tiles of a multi-tile building. */
export const EXTENSION = 4;
/** Which part of a multi-tile building a tile is, in bits 4–5. */
export const PART_SHIFT = 4;
/**
 * Marks a port road or quay tile for port machines only: people on foot and
 * the hauliers' trucks keep off.
 */
export const FORKLIFT_ONLY = 8;
/** Marks a building tile standing on a quay, which it leaves behind. */
export const ON_QUAY = 64;

/** On a highway tile: an exit, where the barrier down the middle is open to the road beside it. */
export const EXIT = 16;
/** On a public or port road: one way only, the way its `orient & 3` faces. */
export const ONE_WAY = 16;
/** On a road junction: traffic lights. */
export const LIGHTS = 32;
/** On a port gate: trucks only drive in through it. */
export const GATE_IN = 16;
/** On a port gate: trucks only drive out through it. */
export const GATE_OUT = 32;

/**
 * On a port road tile: the port's siding track runs across it, a level
 * crossing; the road goes on as road, and the track as track.
 */
export const RAILS = 128;

/** On a parking tile: it is marked out on port road, not public road. */
export const ON_PORT_ROAD = 16;
/** On a parking tile: its lot runs the other way round from the usual. */
export const PARK_FLIP = 32;
/**
 * On a parking tile: its spaces lean the other way, so trucks turn in off
 * the road with the lot on their left, across the traffic coming the other
 * way, rather than on their right.
 */
export const PARK_MIRROR = 1;
