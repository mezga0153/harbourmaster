import type { Rng } from './rng';

const FIRST = [
  'Alex',
  'Sam',
  'Robin',
  'Jo',
  'Kit',
  'Charlie',
  'Morgan',
  'Frankie',
  'Jamie',
  'Toni',
  'Ali',
  'Remy',
  'Nico',
  'Sasha',
  'Pat',
  'Billie',
  'Dana',
  'Lou',
  'Kai',
  'Ash',
  'Mika',
  'Rui',
  'Eli',
  'Noor',
  'Jules',
  'Bo',
  'Ira',
  'Max',
  'Tine',
  'Luka',
];

const LAST = [
  'Barnacle',
  'Hawser',
  'Keel',
  'Mariner',
  'Gale',
  'Bollard',
  'Quay',
  'Anchor',
  'Saltmarsh',
  'Rope',
  'Tide',
  'Haddock',
  'Driftwood',
  'Capstan',
  'Gangway',
  'Pierce',
  'Harbour',
  'Brine',
  'Crane',
  'Fender',
  'Winch',
  'Pilot',
  'Shoal',
  'Kelp',
];

export function randomName(rng: Rng): string {
  return `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
}

const TOWN_START = [
  'Salt',
  'Gull',
  'Kelp',
  'Herring',
  'Brine',
  'Cod',
  'Shell',
  'Tern',
  'Wrack',
  'Mackerel',
  'Pebble',
  'Driftwood',
];
const TOWN_END = [
  'by',
  'haven',
  'mouth',
  'combe',
  'wick',
  'sea',
  'ness',
  'port',
  ' Bay',
  'stead',
  ' Cove',
  'holm',
];

export function townName(rng: Rng): string {
  return `${rng.pick(TOWN_START)}${rng.pick(TOWN_END)}`;
}
