import { Group } from 'three';
import { VESSELS } from '../sim/balance';
import { CAR_LENGTH, type CarKind } from '../sim/railway';
import { LIGHTS } from '../sim/orient';
import { Build } from '../sim/types';
import { forklift, reachTo, stacker, FORKS_EMPTY } from '../render/machines';
import { boat, person, truck, type Model } from '../render/model';
import { showLoad } from '../render/models';
import { fidget, pose, sit, type Fidget } from '../render/people';
import { Structures } from '../render/structures';
import { stage } from '../render/thumbs';
import { trainCar } from '../render/trains';
import { GameMap } from '../sim/map';
import { Terrain } from '../sim/types';
import { TICKS_PER_SECOND } from '../sim/types';
import type { Param, Params } from './controls';
import type { Item } from './gallery';
import type { Staged } from './stage';

// The rigs, for the Animations tab: each thing that moves in place, run by
// the same code that moves it in the game, with its inputs on sliders.
// Everything moving about the port (driving, sailing, carrying, lifting)
// is on the Scenes tab, where the game runs it.

const FIDGETS: Fidget[] = [
  'look',
  'scratch',
  'watch',
  'tap',
  'chat',
  'still',
  'jog',
  'sit',
  'peer',
  'dance',
  'flex',
  'wave',
  'hop',
  'spin',
  'windmill',
];

function model(m: Model, water = false): Staged {
  return { object: m.root, water, dispose: () => m.owned?.forEach((g) => g.dispose()) };
}

const dockhand: Item = {
  group: 'People',
  name: 'Dockhand',
  note: 'pose(), fidget() and sit() in render/people.ts',
  params: [
    { key: 'seed', label: 'Seed', kind: 'range', min: 0, max: 60, value: 1 },
    { key: 'moving', label: 'Walking', kind: 'toggle', value: true, live: true },
    { key: 'carrying', label: 'Carrying a crate', kind: 'toggle', value: false, live: true },
    {
      key: 'stoop',
      label: 'Stooping (0 to 1)',
      kind: 'range',
      min: 0,
      max: 1,
      value: 0,
      live: true,
    },
    {
      key: 'over',
      label: 'Leaning out (tiles)',
      kind: 'range',
      min: 0,
      max: 1,
      value: 0,
      live: true,
    },
    {
      key: 'drop',
      label: 'Crate height (tiles)',
      kind: 'range',
      min: -0.3,
      max: 0.45,
      value: 0,
      live: true,
    },
    {
      key: 'fidget',
      label: 'Standing about',
      kind: 'select',
      options: [['', 'Nothing'], ...FIDGETS.map((f): [string, string] => [f, f])],
      value: '',
      live: true,
    },
    { key: 'sitting', label: 'Sat on the bench', kind: 'toggle', value: false, live: true },
  ],
  make(p) {
    const m = person(p.seed as number);
    let q = p;
    return {
      ...model(m),
      live: (v) => (q = v),
      update(t) {
        const phase = t * 12;
        showLoad(m, q.carrying ? 1 : 0);
        if (q.sitting) return sit(m, phase);
        const standing = !!q.fidget;
        pose(
          m,
          (q.moving as boolean) && !standing,
          q.carrying as boolean,
          phase,
          q.stoop as number,
          q.over as number,
          q.drop as number,
        );
        if (standing) fidget(m, q.fidget as Fidget, t, 1);
      },
    };
  },
};

const lift: Item = {
  group: 'Machines',
  name: 'Forklift',
  note: 'The carriage runs up the mast with the forks and the load',
  params: [
    {
      key: 'forks',
      label: 'Forks height',
      kind: 'range',
      min: 0,
      max: 0.6,
      value: FORKS_EMPTY,
      live: true,
    },
    { key: 'load', label: 'Crates', kind: 'range', min: 0, max: 4, value: 0, live: true },
  ],
  make(p) {
    const m = forklift();
    const live = (q: Params) => {
      m.forks!.position.y = q.forks as number;
      showLoad(m, q.load as number);
    };
    live(p);
    return { ...model(m), live };
  },
};

const reach: Item = {
  group: 'Machines',
  name: 'Reach stacker',
  note: 'reachTo() luffs the boom and runs the jib out to hold the spreader ahead',
  params: [
    {
      key: 'h',
      label: 'Container height',
      kind: 'range',
      min: 0,
      max: 1.2,
      value: 0.05,
      live: true,
    },
    { key: 'load', label: 'Carrying a container', kind: 'toggle', value: true, live: true },
  ],
  make(p) {
    const m = stacker();
    const live = (q: Params) => {
      reachTo(m.reach!, q.h as number);
      showLoad(m, q.load ? 1 : 0);
    };
    live(p);
    return { ...model(m), live };
  },
};

const rig: Item = {
  group: 'Trucks',
  name: 'Articulated truck',
  note: 'The trailer turns about its kingpin on the fifth wheel',
  params: [
    { key: 'seed', label: 'Seed', kind: 'range', min: 0, max: 40, value: 1 },
    { key: 'boxes', label: 'Container rig', kind: 'toggle', value: false },
    { key: 'capacity', label: 'Capacity', kind: 'range', min: 1, max: 12, value: 8 },
    {
      key: 'fold',
      label: 'Trailer fold (°)',
      kind: 'range',
      min: -80,
      max: 80,
      value: 0,
      live: true,
    },
    {
      key: 'fold2',
      label: 'Second trailer (°)',
      kind: 'range',
      min: -80,
      max: 80,
      value: 0,
      live: true,
    },
  ],
  make(p) {
    const m = truck(0, p.capacity as number, p.boxes as boolean, p.seed as number);
    showLoad(m, m.crates.length);
    const live = (q: Params) => {
      const t = m.trailer;
      if (!t) return;
      t.root.rotation.y = ((q.fold as number) * Math.PI) / 180;
      if (t.next) t.next.root.rotation.y = ((q.fold2 as number) * Math.PI) / 180;
    };
    live(p);
    return { ...model(m), live };
  },
};

const afloat: Item = {
  group: 'Boats and ships',
  name: 'Under way',
  note: 'As Entities draws a boat: bobbing, lifting its bow with way on and heeling out of a turn',
  params: [
    {
      key: 'vessel',
      label: 'Vessel',
      kind: 'select',
      options: [
        ['smack', 'Fishing boat'],
        ['coaster', 'Coaster'],
        ['feeder', 'Feeder ship'],
        ['tug', 'Tug'],
      ],
      value: 'smack',
    },
    { key: 'way', label: 'Way on (0 to 1)', kind: 'range', min: 0, max: 1, value: 0.5, live: true },
    {
      key: 'turn',
      label: 'Turning (−1 to 1)',
      kind: 'range',
      min: -1,
      max: 1,
      value: 0,
      live: true,
    },
  ],
  make(p) {
    const m = boat(0, p.vessel as string, 3);
    showLoad(m, Math.floor(m.crates.length / 2));
    m.root.rotation.order = 'YXZ';
    let q = p;
    const hull = VESSELS[p.vessel as keyof typeof VESSELS];
    return {
      ...model(m, true),
      live: (v) => (q = v),
      update(t) {
        const way = q.way as number;
        const turn = (q.turn as number) * hull.turn;
        const heel = Math.max(-0.12, Math.min(0.12, -turn * 3 * way));
        m.root.position.y = Math.sin(t * 1.6) * 0.025;
        m.root.rotation.x = heel + Math.sin(t * 0.9) * 0.02;
        m.root.rotation.z = Math.sin(t * 1.1) * 0.02 + way * 0.025;
      },
    };
  },
};

/** A tool on its patch of shore, run as the game runs it: the gate's barrier, the lights, the buoy, a crane. */
function staged(
  name: string,
  tool: string,
  note: string,
  params: Param[],
  live: (s: ReturnType<typeof stage> & object, q: Params) => void,
): Item {
  return {
    group: 'Port',
    name,
    note,
    params,
    make(p) {
      const s = stage(tool);
      if (!s) return { object: new Group() };
      live(s, p);
      return {
        object: s.content,
        box: s.box,
        bare: true,
        live: (q) => live(s, q),
        update: (time, dt) => s.structures.update(dt, time),
      };
    },
  };
}

const gate = staged(
  'Port gate',
  'portGate',
  'The barrier lifts for a truck at the gate',
  [{ key: 'truck', label: 'A truck at the gate', kind: 'toggle', value: false, live: true }],
  (s, q) => s.structures.setGates(q.truck ? [{ x: 2.5, y: 3.5 }] : []),
);

const buoy = staged('Channel buoy', 'buoyIn', 'Bobs on the water', [], () => {});

const lights: Item = {
  group: 'Port',
  name: 'Traffic lights',
  note: 'The lights change on the game’s tick, see greenAt in structures/furniture.ts',
  params: [
    {
      key: 'rate',
      label: 'Ticks a second',
      kind: 'range',
      min: 0,
      max: 40,
      value: TICKS_PER_SECOND,
      live: true,
    },
  ],
  make(p) {
    const m = new GameMap(7, 7);
    for (let i = 0; i < 49; i++) {
      m.terrain[i] = Terrain.Sand;
      m.build[i] = m.xOf(i) === 3 || m.yOf(i) === 3 ? Build.Road : 0;
    }
    m.entry = -1;
    m.orient[m.idx(3, 3)] |= LIGHTS;
    const s = new Structures(m, true);
    let q = p;
    let tick = 0;
    return {
      object: s.group,
      live: (v) => (q = v),
      update(time, dt) {
        tick += dt * (q.rate as number);
        s.setTick(Math.floor(tick));
        s.update(dt, time);
      },
    };
  },
};

function crane(name: string, tool: string, kind: 'jib' | 'harbour' | 'gantry'): Item {
  return staged(
    name,
    tool,
    'Slews to where the game says, at the pace the game’s speed sets',
    [
      {
        key: 'angle',
        label: 'Slew to (°)',
        kind: 'range',
        min: -180,
        max: 180,
        value: 45,
        live: true,
      },
      { key: 'stack', label: 'On the stack', kind: 'range', min: 0, max: 16, value: 4, live: true },
      { key: 'speed', label: 'Game speed', kind: 'range', min: 1, max: 8, value: 1, live: true },
    ],
    (s, q) => {
      const m = s.map;
      const idx = m.build.findIndex(
        (b, i) =>
          (b === Build.JibCrane || b === Build.HarbourCrane || b === Build.Gantry) &&
          anchorIs(m, i),
      );
      s.structures.setSpeed(q.speed as number);
      s.structures.setCranes([
        {
          idx,
          kind,
          stack: q.stack as number,
          out: 0,
          looks:
            kind === 'jib'
              ? undefined
              : Array.from({ length: q.stack as number }, (_, k) => k * 3 + 1),
          max: 16,
          angle: ((q.angle as number) * Math.PI) / 180,
          busy: true,
          stores: 0,
          why: '',
        },
      ]);
    },
  );
}

import { anchorOf } from '../sim/rules';
function anchorIs(m: GameMap, i: number): boolean {
  return anchorOf(m, i) === i;
}

const train: Item = {
  group: 'Train',
  name: 'A train going by',
  note: 'The cars as Trains draws them, at the speed the game runs the train',
  params: [
    { key: 'cars', label: 'Wagons', kind: 'range', min: 0, max: 12, value: 6 },
    { key: 'variant', label: 'Livery', kind: 'range', min: 0, max: 3, value: 0 },
    {
      key: 'speed',
      label: 'Tiles a second',
      kind: 'range',
      min: 0,
      max: 6,
      value: 1.5,
      live: true,
    },
  ],
  make(p) {
    const g = new Group();
    const kinds: CarKind[] = ['box', 'tank', 'hopper', 'flat', 'coach'];
    const n = p.cars as number;
    const cars: CarKind[] = [
      'loco',
      ...Array.from({ length: n }, (_, k) => kinds[k % kinds.length]),
    ];
    cars.forEach((kind, k) => {
      const c = trainCar(kind, p.variant as number, k);
      c.position.z = -(k + 0.5) * CAR_LENGTH;
      g.add(c);
    });
    let q = p;
    const span = (n + 1) * CAR_LENGTH + 8;
    return {
      object: g,
      live: (v) => (q = v),
      update(_t, dt) {
        g.position.z += dt * (q.speed as number);
        if (g.position.z > span / 2) g.position.z -= span;
      },
    };
  },
};

export function rigItems(): Item[] {
  return [
    dockhand,
    lift,
    reach,
    rig,
    afloat,
    crane('Jib crane', 'jibCrane', 'jib'),
    crane('Harbour crane', 'harbourCrane', 'harbour'),
    crane('Gantry crane', 'gantryCrane', 'gantry'),
    gate,
    lights,
    buoy,
    train,
  ];
}
