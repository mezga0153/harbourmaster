import { describe, expect, it } from 'vitest';
import {
  attenuate,
  bed,
  CueTracker,
  farness,
  nearness,
  panOf,
  type Listener,
} from '../src/audio/mix';
import type { CraneView, EntityView, Snapshot } from '../src/protocol';

const L: Listener = { x: 50, y: 50, rightX: 1, rightY: 0, viewSize: 16 };

function ent(e: Partial<EntityView> & Pick<EntityView, 'id' | 'kind'>): EntityView {
  return {
    x: 50,
    y: 50,
    dir: 0,
    load: 0,
    moving: false,
    name: '',
    activity: '',
    variant: 0,
    capacity: 0,
    alert: false,
    ...e,
  };
}

function snap(entities: EntityView[], cranes: Partial<CraneView>[] = [], train = false): Snapshot {
  return {
    entities,
    cranes,
    train: train ? { head: 50, dir: 1, speed: 0.3, cars: ['loco'], variant: 0 } : null,
    speed: 1,
  } as unknown as Snapshot;
}

describe('Listening from the camera', () => {
  it('hears the work close up and the hum from afar', () => {
    expect(nearness({ ...L, viewSize: 8 })).toBe(1);
    expect(nearness({ ...L, viewSize: 70 })).toBe(0);
    expect(farness({ ...L, viewSize: 8 })).toBe(0);
    expect(farness({ ...L, viewSize: 70 })).toBe(1);
  });

  it('is loudest at the middle of the view and silent well outside it', () => {
    expect(attenuate(L, 50, 50)).toBe(1);
    expect(attenuate(L, 55, 50)).toBeGreaterThan(attenuate(L, 60, 50));
    expect(attenuate(L, 120, 50)).toBe(0);
  });

  it('pans what is to the right of the view to the right', () => {
    expect(panOf(L, 60, 50)).toBeGreaterThan(0);
    expect(panOf(L, 40, 50)).toBeLessThan(0);
    expect(panOf({ ...L, rightX: 0, rightY: -1 }, 50, 40)).toBeGreaterThan(0);
  });
});

describe('The beds', () => {
  it('runs the diesels for trucks driving in view, not out of it', () => {
    const near = bed(snap([ent({ id: 1, kind: 'truck', moving: true })]), L, 100, -1);
    const far = bed(snap([ent({ id: 1, kind: 'truck', moving: true, x: 200 })]), L, 100, -1);
    expect(near.diesel.gain).toBeGreaterThan(0.3);
    expect(far.diesel.gain).toBe(0);
  });

  it('hums quietly for an empty port and loudly for a busy one', () => {
    expect(bed(snap([]), L, 100, -1).activity).toBeCloseTo(0.08);
    const cranes = Array.from({ length: 20 }, (_, k) => ({ idx: k, kind: 'gantry', busy: true }));
    expect(bed(snap([], cranes as CraneView[]), L, 100, -1).activity).toBe(1);
  });
});

describe('Cues', () => {
  it('says nothing about the first snapshot it sees', () => {
    const t = new CueTracker(() => 0);
    expect(
      t.update(snap([ent({ id: 1, kind: 'stacker', handStage: 'drop', handPhase: 0.9 })]), 100, -1),
    ).toEqual([]);
  });

  it('clanks as a reach stacker sets a container down', () => {
    const t = new CueTracker(() => 1);
    t.update(snap([ent({ id: 1, kind: 'stacker', handStage: 'drop', handPhase: 0.9 })]), 100, -1);
    const cues = t.update(snap([ent({ id: 1, kind: 'stacker' })]), 100, -1);
    expect(cues.map((c) => c.kind)).toEqual(['clank']);
  });

  it('thunks as a forklift puts its pallet down', () => {
    const t = new CueTracker(() => 1);
    t.update(snap([ent({ id: 1, kind: 'forklift', handling: 0.8 })]), 100, -1);
    expect(t.update(snap([ent({ id: 1, kind: 'forklift' })]), 100, -1).map((c) => c.kind)).toEqual([
      'thunk',
    ]);
  });

  it('sounds a horn as a feeder sails, and a tug toots setting off', () => {
    const t = new CueTracker(() => 1);
    t.update(
      snap([
        ent({ id: 1, kind: 'boat', vessel: 'feeder', activity: 'Taking exports on board' }),
        ent({ id: 2, kind: 'boat', vessel: 'tug', activity: 'Lying at its berth' }),
      ]),
      100,
      -1,
    );
    const cues = t.update(
      snap([
        ent({ id: 1, kind: 'boat', vessel: 'feeder', activity: 'Heading back out to sea' }),
        ent({ id: 2, kind: 'boat', vessel: 'tug', activity: 'Heading out to a ship' }),
      ]),
      100,
      -1,
    );
    expect(cues.map((c) => [c.kind, c.vessel])).toEqual([
      ['horn', 'feeder'],
      ['toot', 'tug'],
    ]);
  });

  it('clanks as a crane lands a container, thunks for a jib crane, and the train sounds its horn', () => {
    const t = new CueTracker(() => 1);
    const working = [
      { idx: 105, kind: 'gantry', working: 'unload', workPhase: 0.95 },
      { idx: 205, kind: 'jib', working: 'unload', workPhase: 0.95 },
    ] as CraneView[];
    t.update(snap([], working), 100, 30.5);
    const cues = t.update(
      snap(
        [],
        [
          { idx: 105, kind: 'gantry' },
          { idx: 205, kind: 'jib' },
        ] as CraneView[],
        true,
      ),
      100,
      30.5,
    );
    expect(cues.map((c) => [c.kind, c.x, c.y])).toEqual([
      ['clank', 5.5, 1.5],
      ['thunk', 5.5, 2.5],
      ['trainHorn', 30.5, 50],
    ]);
  });

  it('beeps for some machines backing off and hisses for some trucks pulling up', () => {
    const t = new CueTracker(() => 0);
    t.update(
      snap([ent({ id: 1, kind: 'forklift' }), ent({ id: 2, kind: 'truck', moving: true })]),
      100,
      -1,
    );
    const cues = t.update(
      snap([ent({ id: 1, kind: 'forklift', moving: true }), ent({ id: 2, kind: 'truck' })]),
      100,
      -1,
    );
    expect(cues.map((c) => c.kind)).toEqual(['beep', 'hiss']);
  });
});
