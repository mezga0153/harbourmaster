import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { placementError } from '../src/sim/rules';
import { Build } from '../src/sim/types';
import { World } from '../src/sim/world';
import { docks } from '../src/sim/systems/boats/berthing';

/** Standalone jetties further along the coast, as many as asked for where there is room. */
function jetties(world: World, n: number): void {
  const m = world.map;
  let built = 0;
  for (const off of [4, -4, 8, -8, 12, -12, 16, -16, 20, -20]) {
    const row = m.yOf(m.entry) + off;
    let x = 0;
    while (x < m.w - 1 && m.ocean[m.idx(x, row)] !== 1) x++;
    const tile = m.idx(x, row);
    if (!placementError(m, 'jetty', tile)) {
      world.command({ type: 'build', kind: 'jetty', tiles: [tile] });
      built++;
    }
    if (built === n) break;
  }
  expect(built).toBe(n);
}

function build(world: World, kind: 'harbourHut' | 'office'): number {
  const m = world.map;
  const spot = m.build.findIndex((_, i) => !placementError(m, kind, i));
  world.command({ type: 'build', kind, tiles: [spot] });
  expect(m.build[spot]).toBe(kind === 'office' ? Build.Office : Build.HarbourHut);
  return spot;
}

describe("Harbourmaster's hut", () => {
  it('looks after a few more jetties at the fishing jetty, cheaply', () => {
    const world = World.create(7, 96);
    world.cash = 50_000;
    jetties(world, 4);
    const used = () => docks(world).filter((d) => d.coordinated).length;
    expect(docks(world)).toHaveLength(5);
    expect(used()).toBe(B.FREE_DOCKS);
    const cash = world.cash;
    build(world, 'harbourHut');
    expect(cash - world.cash).toBeLessThan(500);
    expect(used()).toBe(Math.min(5, B.FREE_DOCKS + B.JETTIES_PER_HUT));
  });

  it('never looks after a quay, which needs a harbour office', () => {
    const world = World.create(7, 96);
    world.tier = 1;
    world.cash = 50_000;
    const m = world.map;
    const r = m.yOf(m.entry);
    const jetty = m.build.findIndex((b, i) => b === Build.Jetty && m.yOf(i) === r);
    world.command({ type: 'build', kind: 'quay', tiles: [jetty] });
    build(world, 'harbourHut');
    expect(docks(world).every((d) => !d.coordinated)).toBe(true);
    build(world, 'office');
    expect(docks(world).every((d) => d.coordinated)).toBe(true);
  });

  it('shows in the snapshot beside the offices', () => {
    const world = World.create(7, 96);
    world.cash = 50_000;
    build(world, 'harbourHut');
    expect(world.snapshot().docks.huts).toBe(1);
  });
});

/** A hut, harbour office or customs office as near the fishing jetty as one will go. */
function byJetty(world: World, kind: 'harbourHut' | 'customs' | 'office'): number {
  const m = world.map;
  const jetty = m.build.findIndex((b) => b === Build.Jetty);
  const near = (i: number) => Math.abs(m.xOf(i) - m.xOf(jetty)) + Math.abs(m.yOf(i) - m.yOf(jetty));
  const spot = Array.from(m.build, (_, i) => i)
    .filter((i) => !placementError(m, kind, i))
    .sort((a, b) => near(a) - near(b))[0];
  world.command({ type: 'build', kind, tiles: [spot] });
  expect(m.build[spot]).toBe(
    { customs: Build.Customs, office: Build.Office, harbourHut: Build.HarbourHut }[kind],
  );
  return spot;
}

describe('The harbourmaster', () => {
  it('comes with the hut, walks the jetties and points out the boats', () => {
    const world = World.create(7, 96);
    world.cash = 50_000;
    const hut = byJetty(world, 'harbourHut');
    let onJetty = false;
    let pointed = false;
    for (let t = 0; t < 3000; t++) {
      world.step();
      const [h] = world.officials;
      if (!h) continue;
      if (world.map.build[world.tileOf(h)] === Build.Jetty) onJetty = true;
      if (h.boat >= 0) pointed = true;
    }
    expect(world.officials).toHaveLength(1);
    expect(world.officials[0].home).toBe(hut);
    expect(onJetty).toBe(true);
    expect(pointed).toBe(true);
    // Not one of the staff, so no one waits on them and they wait on no one.
    expect(world.people.some((p) => p.id === world.officials[0].id)).toBe(false);
    const view = world.snapshot().entities.find((e) => e.kind === 'harbourmaster');
    expect(view?.name).toMatch(/^Harbourmaster /);
  });

  it('is kept in the save, and goes with the hut', () => {
    const world = World.create(7, 96);
    world.cash = 50_000;
    const hut = byJetty(world, 'harbourHut');
    for (let t = 0; t < 200; t++) world.step();
    const again = World.fromSave(JSON.parse(JSON.stringify(world.toSave())));
    expect(again.officials).toEqual(world.officials);
    again.command({ type: 'bulldoze', tiles: [hut] });
    again.step();
    expect(again.officials).toHaveLength(0);
  });

  it('is kept in saves from before there were customs officers', () => {
    const world = World.create(7, 96);
    world.cash = 50_000;
    byJetty(world, 'harbourHut');
    for (let t = 0; t < 200; t++) world.step();
    const { officials, ...old } = world.toSave();
    const harbourmasters = officials!.map(({ role: _, ...h }) => h);
    const again = World.fromSave(JSON.parse(JSON.stringify({ ...old, harbourmasters })));
    expect(again.officials).toEqual(world.officials);
  });
});

describe('The customs officer', () => {
  it('comes with the office and goes down to check the papers of the ships alongside', () => {
    const world = World.create(7, 96);
    world.tier = 1;
    world.cash = 50_000;
    const office = byJetty(world, 'customs');
    let checked = false;
    let walked = false;
    for (let t = 0; t < 3000; t++) {
      world.step();
      const [h] = world.officials;
      if (!h) continue;
      if (h.state === 'walk') walked = true;
      const b = world.boats.find((q) => q.id === h.boat);
      if (b) {
        expect(b.state).toBe('moored');
        expect(Math.hypot(b.x - h.x, b.y - h.y)).toBeLessThan(B.CUSTOMS_REACH);
        checked = true;
      }
    }
    expect(world.officials).toHaveLength(1);
    expect(world.officials[0].role).toBe('customs');
    expect(world.officials[0].home).toBe(office);
    expect(walked).toBe(true);
    expect(checked).toBe(true);
    const view = world.snapshot().entities.find((e) => e.kind === 'customsOfficer');
    expect(view?.name).toMatch(/^Customs officer /);
    world.command({ type: 'bulldoze', tiles: [office] });
    world.step();
    expect(world.officials).toHaveLength(0);
  });
});

describe('The berthing master', () => {
  it('comes with the harbour office and waves the boats in alongside', () => {
    const world = World.create(7, 96);
    world.tier = 1;
    world.cash = 50_000;
    const office = byJetty(world, 'office');
    let waved = false;
    for (let t = 0; t < 2400; t++) {
      world.step();
      const [h] = world.officials;
      if (!h) continue;
      const view = world.snapshot().entities.find((e) => e.id === h.id)!;
      if (!view.guiding) continue;
      expect(world.boats.find((b) => b.id === h.boat)?.state).toBe('arriving');
      waved = true;
    }
    expect(world.officials).toHaveLength(1);
    expect(world.officials[0].role).toBe('berthing');
    expect(world.officials[0].home).toBe(office);
    expect(waved).toBe(true);
    const view = world.snapshot().entities.find((e) => e.kind === 'berthingMaster');
    expect(view?.name).toMatch(/^Berthing master /);
  });
});
