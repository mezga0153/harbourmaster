import { afterEach, describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { TICKS_PER_DAY } from '../src/sim/types';
import { tip } from '../src/sim/systems/output';
import { setDown } from '../src/sim/systems/cargo/places';
import { takeFromSource } from '../src/sim/systems/cargo/stores';
import { shipOut } from '../src/sim/systems/cargo/exports';
import { withCargo } from '../src/sim/cargo';
import { checkStep, GUIDES } from '../src/ui/guides';
import { availableAction, chooseTool, guidePause, runHelpAction } from '../src/ui/learning';
import {
  guide,
  openCategory,
  openGuide,
  panel,
  selection,
  snapshot,
  tool,
  trayTabs,
} from '../src/ui/store';
import { offerFilter } from '../src/ui/contractList';
import type { Actions } from '../src/ui/actions';
import { fresh, trackLearning } from '../src/log/days';
import { tipPriority } from '../src/ui/Advisor';

const actions = { focus: () => {}, focusTile: () => {}, send: () => {} } as unknown as Actions;
afterEach(() => {
  guide.value = null;
  snapshot.value = null;
  selection.value = null;
  panel.value = null;
  tool.value = 'select';
});

describe('Saved learning progress', () => {
  it('keeps issued advice unread across a save, and acknowledged advice in history', () => {
    const w = World.create(7, 96);
    tip(w, 'hut');
    w.command({ type: 'learnt', tip: 'screens' });
    let back = World.fromSave(w.toSave());
    expect(back.snapshot().learning.seenTips).toEqual(['welcome', 'hut']);
    expect(back.snapshot().learning.readTips).toEqual([]);
    back.command({ type: 'readTip', id: 'hut' });
    back.command({ type: 'help', id: 'exports', action: 'step', step: 3 });
    back.command({ type: 'inspect', kind: 'boat' });
    back = World.fromSave(back.toSave());
    expect(back.snapshot().learning.readTips).toEqual(['hut']);
    expect(back.learning.guideSteps.exports).toBe(3);
    expect(back.learning.marks).toContain('inspectBoat');
    snapshot.value = back.snapshot();
    openGuide('exports');
    expect(guide.value?.step).toBe(3);
    openGuide('exports', 0);
    expect(guide.value?.step).toBe(0);
  });

  it('loads older saves without replaying every historical tip', () => {
    const w = World.create(7, 96);
    tip(w, 'hut');
    const save = w.toSave();
    delete save.learning;
    const back = World.fromSave(save);
    expect(back.learning.readTips).toEqual(save.tips);
    expect(back.learning.marks).toEqual([]);
    expect(World.isValidSave(back.toSave())).toBe(true);
  });

  it('tracks coaster crates through storage and real truck delivery without crediting fishing crates', () => {
    const w = World.create(7, 96);
    for (let k = 0; k < TICKS_PER_DAY * 4 && !w.learning.marks.includes('crateDelivery'); k++)
      w.step();
    expect(w.learning.marks).toContain('crateDelivery');
    expect(w.learning.marks).not.toContain('coasterDelivery');
    const boat = w.boats[0];
    // Use a real worker pickup to attach provenance, then the usual storage and truck systems.
    expect(boat).toBeDefined();
    boat.vessel = 'coaster';
    boat.crates = 8;
    const p = w.people.find((p) => p.kind === 'dockhand')!;
    Object.assign(p, { boatId: boat.id, stockIdx: -1, craneIdx: -1, planned: 1 });
    const crate = takeFromSource(w, p)[0];
    expect(crate.coaster).toBe(true);
    w.boats.length = 0;
    for (const c of w.contracts) c.nextBoatTick = Infinity;
    const bay = [...w.bays.values()][0];
    setDown(
      w,
      bay,
      Array.from({ length: 8 }, () => ({ ...crate })),
      false,
    );
    const back = World.fromSave(w.toSave());
    expect([...back.bays.values()].flatMap((b) => b.cells).some((c) => c?.coaster)).toBe(true);
    for (let k = 0; k < TICKS_PER_DAY * 6 && !back.learning.marks.includes('coasterDelivery'); k++)
      back.step();
    expect(back.learning.marks).toContain('coasterDelivery');
  });

  it('counts canned fish only when it goes aboard, separately from other exports', () => {
    const w = World.create(7, 96);
    const b = w.boats[0];
    shipOut(w, b, [{ fee: withCargo(20, 'goods'), at: 0, out: true }]);
    expect(w.learning.marks).not.toContain('cannedExport');
    shipOut(w, b, [{ fee: withCargo(20, 'canned'), at: 0, out: true }]);
    expect(World.fromSave(w.toSave()).learning.marks).toContain('cannedExport');
  });
});

describe('Practicing a lesson', () => {
  it('opens the correct menu tab and refuses tools that have not unlocked', () => {
    const w = World.create(7, 96);
    snapshot.value = w.snapshot();
    expect(chooseTool('crateStore')).toBe(false);
    expect(tool.value).toBe('select');
    w.tier = 1;
    snapshot.value = w.snapshot();
    trayTabs.value = { cargo: 'Cranes' };
    expect(chooseTool('crateStore')).toBe(true);
    expect(tool.value).toBe('crateStore');
    expect(openCategory.value).toBe('cargo');
    expect(trayTabs.value.cargo).toBe('Storage');
    runHelpAction({ label: 'Offers', offers: 'coaster' }, actions);
    expect(offerFilter.value.kind).toBe('line');
    expect(panel.value).toBe('contracts');
  });

  it('waits for an inspectable target and puts the handbook away when practice starts', () => {
    snapshot.value = World.create(7, 96).snapshot();
    expect(availableAction({ label: 'Show a truck', inspect: 'truck' })).toBe(false);
    expect(availableAction({ label: 'Show a boat', inspect: 'boat' })).toBe(true);
    panel.value = 'handbook';
    openGuide('start', 0);
    runHelpAction({ label: 'Show a boat', inspect: 'boat' }, actions);
    expect(guide.value?.practice).toBe(true);
    expect(panel.value).toBeNull();
  });

  it('restores the previous speed once, including an already paused game', () => {
    for (const speed of [0, 1, 4, 8]) {
      const sent: number[] = [];
      const pause = guidePause((s) => sent.push(s));
      pause.update(true, speed);
      pause.update(true, 0); // another step while the game is paused
      pause.update(false, 0); // practice or close
      pause.update(false, speed);
      expect(sent).toEqual([0, speed]);
      pause.update(true, speed);
      pause.reset(); // loading another port never restores the old port's speed
      pause.update(false, 0);
      expect(sent).toEqual([0, speed, 0]);
    }
  });

  it('keeps the previous speed when toggling faster than worker snapshots arrive', () => {
    const sent: number[] = [];
    const pause = guidePause((speed) => {
      sent.push(speed);
      pause.requested(speed);
    });
    pause.update(true, 4);
    pause.observed(0);
    pause.update(false, 0);
    pause.update(true, 0); // the snapshot still says paused, but 4x was requested
    pause.update(false, 0);
    expect(sent).toEqual([0, 4, 0, 4]);
    pause.requested(0); // the player explicitly pauses while practicing
    pause.update(true, 4);
    pause.update(false, 0);
    expect(sent.slice(-2)).toEqual([0, 0]);
  });

  it('does not credit another crane for fixing the selected one', () => {
    const s = World.create(7, 96).snapshot();
    const base = {
      kind: 'jib',
      stores: 2,
      storeRoom: 20,
      site: { water: true, wide: true, room: true, depth: true },
    };
    s.cranes = [
      { ...base, idx: 1 },
      { ...base, idx: 2, stores: 0 },
    ] as typeof s.cranes;
    expect(checkStep(GUIDES.jib.steps[2], s, 1)?.done).toBe(true);
    expect(checkStep(GUIDES.jib.steps[2], s, 2)?.done).toBe(false);
    expect(checkStep(GUIDES.harbour.steps[0], s, undefined, 'harbour')?.done).toBe(false);
    expect(checkStep(GUIDES.wharf.steps[5], s)?.done).toBe(false);
  });

  it('puts a current blocker ahead of background advice', () => {
    const s = World.create(7, 96).snapshot();
    expect(tipPriority('hut', s)).toBeGreaterThan(tipPriority('screens', s));
    s.learning.hut = true;
    expect(tipPriority('hut', s)).toBe(tipPriority('screens', s));
  });
});

describe('Learning outcome measurements', () => {
  it('records a real outcome once, including when no tutorial is open', () => {
    const t = fresh('game', 1);
    const seen = new Set<string>();
    trackLearning(t, ['coasterDelivery', 'cannedExport'], seen);
    trackLearning(t, ['coasterDelivery', 'cannedExport', 'containerDelivery'], seen);
    expect(t.actions).toEqual({
      'milestone:coasterDelivery': 1,
      'milestone:cannedExport': 1,
      'milestone:containerDelivery': 1,
    });
  });
});
