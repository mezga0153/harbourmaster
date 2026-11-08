// The rules of the map, by subject (see rules/): what may be built where,
// how it stands, the marks on the tiles, and how trucks and boats find their
// way. Everything is exported from here as it always was.

export { EXTENSION, FORKLIFT_ONLY, ON_PORT_ROAD, ON_QUAY, PARK_FLIP, PARK_MIRROR } from './orient';
export * from './rules/buildables';
export * from './rules/marking';
export * from './rules/footprint';
export * from './rules/placement';
export * from './rules/harbour';
export * from './rules/truckNav';
export * from './rules/parking';
export * from './rules/rails';
