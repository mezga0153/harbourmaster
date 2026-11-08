import { Box3, Group } from 'three';
import type { CraneView } from '../protocol';
import { CARGO } from '../sim/cargo';
import type { CarKind } from '../sim/railway';
import { anchorOf } from '../sim/rules';
import { Build } from '../sim/types';
import { CONTAINERS, ROCKS, template, TREES } from '../render/assets';
import { forklift, stacker, tractor } from '../render/machines';
import {
  berthingMaster,
  binoculars,
  checkPapers,
  customsOfficer,
  harbourmaster,
  pointOut,
  pose,
  waveIn,
} from '../render/people';
import { boat, person, truck, type Model } from '../render/model';
import {
  alertMarker,
  container,
  crate,
  PALLET_CRATE,
  paintContainer,
  setCrateIcon,
  setCrateSeal,
  showDeck,
  showLoad,
} from '../render/models';
import { PICTURED, stage } from '../render/thumbs';
import { townBuilding } from '../render/town';
import { trainCar } from '../render/trains';
import { CATEGORIES } from '../ui/tools';
import type { Param, Params, RangeParam } from './controls';
import type { Item } from './gallery';
import type { Staged } from './stage';
import { solidBounds } from '../render/util/mesh';

// Every model in the game, for the Models tab: boats and ships, trucks,
// people and machines, what the build menu offers on its patch of shore,
// the town's buildings, the train's cars, the scenery and the cargo.

const SEED: RangeParam = { key: 'seed', label: 'Seed', kind: 'range', min: 0, max: 40, value: 1 };
const COMPANY: RangeParam = {
  key: 'company',
  label: 'Company colour',
  kind: 'range',
  min: 0,
  max: 4,
  value: 0,
};
const LOAD: RangeParam = {
  key: 'load',
  label: 'Load',
  kind: 'range',
  min: 0,
  max: 30,
  value: 6,
  live: true,
};

function model(m: Model, water = false, box?: Box3): Staged & { model: Model } {
  return {
    object: m.root,
    water,
    box,
    model: m,
    dispose: () => m.owned?.forEach((g) => g.dispose()),
  };
}

/** A boat with as much of its load aboard as the slider says, every slot of a feeder's deck filled in order. */
function vessel(name: string, kind: string, lobster = false, extra: Param[] = []): Item {
  return {
    group: 'Boats and ships',
    name,
    params: [SEED, COMPANY, { ...LOAD, max: kind === 'feeder' ? 72 : 30 }, ...extra],
    make(p) {
      const m = boat(p.company as number, kind, p.seed as number, lobster);
      const s = model(m, true);
      const live = (q: Params) => {
        const n = Math.min(m.crates.length, q.load as number);
        if (kind === 'feeder') {
          const deck = Array.from({ length: n }, (_, k) => ({ look: k * 7 + (p.seed as number) }));
          showDeck(m, deck);
        } else showLoad(m, n);
      };
      live(p);
      return { ...s, live, note: `${m.crates.length} slots` } as Staged & { live(p: Params): void };
    },
  };
}

function haulage(name: string, capacity: number, boxes: boolean): Item {
  return {
    group: 'Trucks',
    name,
    params: [
      SEED,
      COMPANY,
      { key: 'capacity', label: 'Capacity', kind: 'range', min: 1, max: 12, value: capacity },
      { ...LOAD, max: 12, value: Math.min(capacity, 12) },
    ],
    make(p) {
      const m = truck(p.company as number, p.capacity as number, boxes, p.seed as number);
      const s = model(m);
      const live = (q: Params) => showLoad(m, Math.min(m.crates.length, q.load as number));
      live(p);
      return { ...s, live };
    },
  };
}

function machine(name: string, make: () => Model, most: number): Item {
  return {
    group: 'Machines',
    name,
    params: [{ ...LOAD, max: most, value: 0 }],
    make(p) {
      const m = make();
      const s = model(m);
      const live = (q: Params) => showLoad(m, q.load as number);
      live(p);
      return { ...s, live };
    },
  };
}

/** A tool as its build menu card pictures it, live: cranes slewed and stacked as the sliders say. */
function pictured(tool: string, label: string): Item {
  const crane = ['jibCrane', 'harbourCrane', 'gantryCrane'].includes(tool);
  return {
    group: 'Buildings and cranes',
    name: label,
    params: crane
      ? [
          {
            key: 'angle',
            label: 'Slew (°)',
            kind: 'range',
            min: -180,
            max: 180,
            value: 0,
            live: true,
          },
          {
            key: 'stack',
            label: 'On the stack',
            kind: 'range',
            min: 0,
            max: 16,
            value: 0,
            live: true,
          },
          {
            key: 'out',
            label: 'Exports waiting',
            kind: 'range',
            min: 0,
            max: 8,
            value: 0,
            live: true,
          },
          { key: 'pallets', label: 'On pallets', kind: 'toggle', value: false, live: true },
        ]
      : [],
    make(p) {
      const s = stage(tool);
      if (!s) return { object: new Group() };
      const m = s.map;
      const kind: CraneView['kind'] | null =
        tool === 'jibCrane'
          ? 'jib'
          : tool === 'harbourCrane'
            ? 'harbour'
            : tool === 'gantryCrane'
              ? 'gantry'
              : null;
      const cranes: number[] = [];
      for (let i = 0; i < m.build.length; i++) {
        const b = m.build[i];
        if (
          (b === Build.JibCrane || b === Build.HarbourCrane || b === Build.Gantry) &&
          anchorOf(m, i) === i
        ) {
          cranes.push(i);
        }
      }
      const live = (q: Params) => {
        if (!kind) return;
        const n = (q.stack as number) + (q.out as number);
        s.structures.setCranes(
          cranes.map((idx) => ({
            idx,
            kind,
            stack: q.stack as number,
            out: q.out as number,
            looks: kind === 'jib' ? undefined : Array.from({ length: n }, (_, k) => k * 3 + 1),
            max: 16,
            angle: ((q.angle as number) * Math.PI) / 180,
            busy: true,
            stores: 0,
            why: '',
            pallets: q.pallets as boolean,
          })),
        );
      };
      live(p);
      return {
        object: s.content,
        box: s.box,
        bare: true,
        live,
        update: (time, dt) => s.structures.update(dt, time),
      };
    },
  };
}

const TOWN: [string, number][] = [
  ['Cottage', Build.Cottage],
  ['House', Build.House],
  ['Shop', Build.Shop],
  ['Flats', Build.Flats],
  ['Tower', Build.Tower],
  ['Chapel', Build.Chapel],
  ['Fish shed', Build.FishShed],
  ['Park', Build.Park],
  ['Fish market', Build.FishMarket],
  ['Cannery', Build.Cannery],
  ['Ice house', Build.IceHouse],
  ['Restaurant', Build.Restaurant],
  ['Builders’ yard', Build.BuildersYard],
  ['School', Build.School],
  ['Town hall', Build.TownHall],
  ['Hospital', Build.Hospital],
  ['Technical college', Build.College],
  ['Railway station', Build.Station],
  ['Store', Build.Store],
  ['Factory', Build.Factory],
];

function town(name: string, code: number): Item {
  return {
    group: 'Town',
    name,
    params: [{ key: 'variant', label: 'Variant', kind: 'range', min: 0, max: 7, value: 0 }],
    make(p) {
      const owned: Parameters<typeof townBuilding>[3] = [];
      const g = townBuilding(code, 0, p.variant as number, owned) ?? new Group();
      // Lots are a tile across, the building in the middle of it.
      const box = solidBounds(g);
      box.min.x = Math.min(box.min.x, -0.5);
      box.max.x = Math.max(box.max.x, 0.5);
      box.min.z = Math.min(box.min.z, -0.5);
      box.max.z = Math.max(box.max.z, 0.5);
      return { object: g, box, dispose: () => owned.forEach((o) => o.dispose()) };
    },
  };
}

const CARS: [CarKind, string][] = [
  ['loco', 'Locomotive'],
  ['coach', 'Coach'],
  ['box', 'Box wagon'],
  ['tank', 'Tank wagon'],
  ['hopper', 'Hopper'],
  ['flat', 'Flat wagon with a container'],
];

function car(kind: CarKind, name: string): Item {
  return {
    group: 'Train',
    name,
    params: [
      { key: 'variant', label: 'Livery', kind: 'range', min: 0, max: 3, value: 0 },
      { key: 'k', label: 'Place in the train', kind: 'range', min: 0, max: 9, value: 1 },
    ],
    make: (p) => ({ object: trainCar(kind, p.variant as number, p.k as number) }),
  };
}

function asset(group: string, name: string, label = name): Item {
  return {
    group,
    name: label,
    make: () => ({
      object: template(name as Parameters<typeof template>[0])?.clone() ?? new Group(),
    }),
  };
}

function cargo(): Item[] {
  return [
    {
      group: 'Cargo',
      name: 'Crate',
      params: [
        {
          key: 'kind',
          label: 'Holds',
          kind: 'select',
          options: CARGO.map((c) => [c, c]),
          value: 'fish',
          live: true,
        },
        { key: 'sealed', label: 'Waiting on customs', kind: 'toggle', value: false, live: true },
        {
          key: 'size',
          label: 'Size',
          kind: 'range',
          min: 0.08,
          max: 0.3,
          step: 0.01,
          value: PALLET_CRATE,
        },
      ],
      make(p) {
        const c = crate(p.size as number);
        const live = (q: Params) => {
          setCrateIcon(c, q.kind as (typeof CARGO)[number]);
          setCrateSeal(c, q.sealed as boolean);
        };
        live(p);
        return { object: c, live };
      },
    },
    {
      group: 'Cargo',
      name: 'Container',
      params: [
        { key: 'look', label: 'Look', kind: 'range', min: 0, max: 40, value: 0, live: true },
      ],
      make(p) {
        const c = container(p.look as number);
        const live = (q: Params) => paintContainer(c, q.look as number);
        live(p);
        return { object: c, live };
      },
    },
    {
      group: 'Cargo',
      name: 'A stack of containers',
      params: [{ key: 'n', label: 'Containers', kind: 'range', min: 1, max: 12, value: 6 }],
      make(p) {
        const g = new Group();
        const n = p.n as number;
        for (let k = 0; k < n; k++) {
          const c = container(k * 5 + 2, (k % 2) * 0.62 - 0.31, Math.floor(k / 2) * 0.24, 0);
          g.add(c);
        }
        return { object: g };
      },
    },
    {
      group: 'Cargo',
      name: 'Red mark',
      note: 'Bobs over what cannot work',
      make: () => {
        const o = alertMarker();
        o.scale.setScalar(3.4);
        o.position.y = 1;
        return { object: o, update: (t) => (o.position.y = 1 + Math.sin(t * 4) * 0.08) };
      },
    },
  ];
}

const dockhand: Item = {
  group: 'People',
  name: 'Dockhand',
  params: [
    { ...SEED, max: 60 },
    { key: 'carrying', label: 'Carrying a crate', kind: 'toggle', value: false, live: true },
  ],
  make(p) {
    const m = person(p.seed as number);
    const s = model(m);
    const live = (q: Params) => showLoad(m, q.carrying ? 1 : 0);
    live(p);
    return { ...s, live };
  },
};

const harbourmasterItem: Item = {
  group: 'People',
  name: 'Harbourmaster',
  note: 'Comes with a harbourmaster’s hut',
  params: [
    { ...SEED, max: 60 },
    { key: 'pointing', label: 'Pointing out a boat', kind: 'toggle', value: true, live: true },
  ],
  make(p) {
    const m = harbourmaster(p.seed as number);
    const s = model(m);
    let pointing = p.pointing as boolean;
    const live = (q: Params) => (pointing = q.pointing as boolean);
    const update = (t: number) => {
      pose(m, !pointing, false, t * 9);
      if (pointing) pointOut(m, 0, t);
    };
    return { ...s, live, update };
  },
};

const customsItem: Item = {
  group: 'People',
  name: 'Customs officer',
  note: 'Comes with a customs office',
  params: [
    { ...SEED, max: 60 },
    { key: 'checking', label: 'Checking a ship’s papers', kind: 'toggle', value: true, live: true },
  ],
  make(p) {
    const m = customsOfficer(p.seed as number);
    const s = model(m);
    let checking = p.checking as boolean;
    const live = (q: Params) => (checking = q.checking as boolean);
    const update = (t: number) => {
      pose(m, !checking, false, t * 9);
      if (checking) checkPapers(m, 0, t);
    };
    return { ...s, live, update };
  },
};

const berthingItem: Item = {
  group: 'People',
  name: 'Berthing master',
  note: 'Comes with a harbour office',
  params: [
    { ...SEED, max: 60 },
    {
      key: 'doing',
      label: 'Doing',
      kind: 'select',
      options: [
        ['wave', 'Waving a ship in'],
        ['look', 'Watching through binoculars'],
        ['walk', 'Walking'],
      ],
      value: 'wave',
      live: true,
    },
  ],
  make(p) {
    const m = berthingMaster(p.seed as number);
    const s = model(m);
    let doing = p.doing as string;
    const live = (q: Params) => (doing = q.doing as string);
    const update = (t: number) => {
      pose(m, doing === 'walk', false, t * 9);
      if (doing === 'wave') waveIn(m, t);
      else if (doing === 'look') binoculars(m, t);
    };
    return { ...s, live, update };
  },
};

const crowd: Item = {
  group: 'People',
  name: 'A crowd of dockhands',
  note: 'Each built from their id',
  params: [{ key: 'n', label: 'People', kind: 'range', min: 1, max: 40, value: 20 }],
  make(p) {
    const g = new Group();
    const n = p.n as number;
    for (let k = 0; k < n; k++) {
      const m = person(k + 1);
      m.root.position.set((k % 8) * 0.3, 0, Math.floor(k / 8) * 0.35);
      g.add(m.root);
    }
    return { object: g };
  },
};

export function modelItems(): Item[] {
  const tools = CATEGORIES.flatMap((c) => c.tools).filter((t) => PICTURED.includes(t.tool));
  const seen = new Set<string>();
  const built = tools
    .filter((t) => !['forklift', 'stacker', 'tractor', 'tug'].includes(t.tool))
    .filter((t) => !seen.has(t.tool) && seen.add(t.tool))
    .map((t) => pictured(t.tool, t.label));
  return [
    vessel('Fishing boat', 'smack'),
    vessel('Lobster boat', 'smack', true),
    vessel('Coaster', 'coaster'),
    vessel('Feeder ship', 'feeder'),
    { ...vessel('Tug', 'tug'), params: [SEED] },
    haulage('Rigid flatbed', 6, false),
    haulage('Articulated flatbed', 8, false),
    haulage('Container truck', 2, true),
    dockhand,
    harbourmasterItem,
    customsItem,
    berthingItem,
    crowd,
    machine('Forklift', forklift, 4),
    machine('Reach stacker', stacker, 1),
    machine('Terminal tractor', tractor, 1),
    ...built,
    ...TOWN.map(([name, code]) => town(name, code)),
    ...CARS.map(([k, name]) => car(k, name)),
    ...TREES.map((n) => asset('Scenery', n)),
    ...ROCKS.map((n) => asset('Scenery', n)),
    ...CONTAINERS.map((n) => asset('Scenery', n, `${n} (Kenney)`)),
    ...cargo(),
  ];
}
