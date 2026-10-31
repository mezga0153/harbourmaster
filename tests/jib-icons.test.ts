import { describe, expect, it } from 'vitest';
import { Group } from 'three';
import { CRANE_LIFT_SET, CRANE_LIFT_TAKEN } from '../src/sim/balance';
import { GameMap } from '../src/sim/map';
import { crate, CRATE, setCrateIcon } from '../src/render/models';
import { makeJibCrane, runJib, setJib } from '../src/render/structures/cranes/jib';
import type { CraneParts, CraneSite } from '../src/render/structures/cranes/parts';

describe('Jib crane crates', () => {
  it('shows a crate it sets down holding what the one it lifted held, from the moment it lets go', () => {
    const m = new GameMap(24, 24);
    const i = m.idx(10, 10);
    const g = new Group();
    g.position.set(10, 0, 10);
    const scene = new Group();
    scene.add(g);
    const parts: { crane?: CraneParts } = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    makeJibCrane({ m, i, g, parts, code: 0, top: 0, map: m, lotAt: () => null } as any);
    const c = parts.crane!;
    const j = c.jib!;
    // A crate of goods on a pile on the quay, and the slot on the boat's
    // deck it goes into, which last held fish.
    const pile = crate(CRATE, 11.5, 0, 10.5);
    setCrateIcon(pile, 'goods');
    const deck = crate(CRATE, 8.5, -0.2, 10.5);
    deck.visible = false;
    scene.add(pile, deck);
    scene.updateMatrixWorld(true);
    const site: CraneSite = {
      speed: () => 1,
      follow: () => 1,
      truckSlot: () => null,
      slotShown: () => true,
      slotObject: () => deck,
      slotTurn: () => 0,
      kept: () => 0,
      order: () => [],
      placed: () => false,
      crateIn: () => pile,
      shownOn: () => 0,
    };
    setJib(c, j, {
      idx: i,
      kind: 'jib',
      stack: 0,
      out: 0,
      max: 10,
      angle: 0,
      busy: true,
      stores: 0,
      why: '',
      working: 'load',
      workBoat: 1,
      workSlot: 0,
      workPile: m.idx(11, 10),
      workPlace: 0,
      workPhase: 0,
    });
    let shownAt = -1;
    for (let k = 0; k < 400 && j.phase < 0.99; k++) {
      runJib(site, c, j, 1 / 30);
      scene.updateMatrixWorld(true);
      if (j.phase >= CRANE_LIFT_TAKEN && j.phase < CRANE_LIFT_SET) {
        expect(pile.visible).toBe(false);
        expect(j.load.visible).toBe(true);
        expect(j.load.userData.icon).toBe('goods');
      }
      if (deck.visible && shownAt < 0) {
        shownAt = j.phase;
        // Goods from the first frame it shows, not fish until the game says.
        expect(deck.userData.icon).toBe('goods');
      }
    }
    expect(shownAt).toBeGreaterThanOrEqual(CRANE_LIFT_SET);
  });
});
