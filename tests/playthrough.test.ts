import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { fisheryDailyCrates, type FisheryTerms } from '../src/sim/contracts';
import { placementError } from '../src/sim/rules';
import { Build, TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';

declare const process: { env: Record<string, string | undefined> };

/**
 * A simple bot that plays like a sensible beginner, once per in-game day.
 * Used as a balance check: a reasonable strategy should grow the port.
 * Run with BALANCE=1 to print a day-by-day log.
 */
function playDay(w: World): string[] {
  const did: string[] = [];
  // Good staff are worth keeping: grant raises while the books are healthy.
  for (const p of w.people) {
    if (p.raiseAsk > 0) w.command({ type: 'raise', id: p.id, accept: w.cash > 1500 });
  }
  const waiting = w.boats.filter((b) => b.state === 'anchored').length;
  const cap = w.capacity();
  const fleet = w.contracts.reduce(
    (n, c) => n + (c.terms.kind === 'haulier' ? c.terms.fleet : 0),
    0,
  );

  // Not enough hands to unload what arrives.
  if (cap.demand > cap.unloading * 0.85 && w.cash > 600) {
    hireBest(w);
    did.push('hire');
  }
  // Not enough trucking: bays first if trucks are spare, else more trucks.
  if (cap.demand > cap.trucking * 0.85 && w.cash > 900) {
    if (fleet > w.bays.size) {
      if (buildBay(w)) did.push('bay');
    } else if (signHaulier(w)) {
      did.push('haulier');
    }
  }
  // The fishery we would like to sign next, if we can afford it after
  // hiring for it.
  const nextOffer = w.offers
    .filter((o) => o.terms.kind === 'fishery' && o.signingFee < w.cash - 1500 - B.HIRE_FEE * 2)
    .sort((a, b) => b.signingFee - a.signingFee)[0];

  // Far more hands than work and nothing to grow into: let the priciest go.
  if (!nextOffer && cap.unloading > cap.demand * 1.6 && w.people.length > 3) {
    const priciest = [...w.people].sort((a, b) => b.wage / b.skill - a.wage / a.skill)[0];
    w.command({ type: 'fire', id: priciest.id });
    did.push('dismiss');
  }

  // Somewhere to rest once there is a crew. One hut seats three.
  const huts = w.map.build.filter((b) => b === Build.BreakHut).length;
  if (w.people.length > huts * 4 + 2 && w.cash > 700 && buildHut(w)) did.push('hut');

  // Boats queueing for a berth.
  if (waiting > 1 && w.cash > 800 && extendJetty(w)) did.push('jetty');

  // Spare capacity and money: take on another fishery, making room first.
  if (waiting === 0 && w.cash > 2500) {
    const offer = nextOffer;
    if (offer) {
      const need = cap.demand + fisheryDailyCrates(offer.terms as FisheryTerms);
      if (need > cap.unloading * 0.85) {
        hireBest(w);
        did.push('hire ahead');
      } else if (need > cap.trucking * 0.85) {
        if (fleet > w.bays.size ? buildBay(w) : signHaulier(w)) did.push('trucks ahead');
      } else {
        w.command({ type: 'signContract', id: offer.id });
        did.push(`fishery ${offer.terms.name}`);
      }
    }
  }
  return did;
}

/** Hire the candidate with the most skill for the money. */
function hireBest(w: World): void {
  const best = [...w.candidates].sort((a, b) => b.skill / b.wage - a.skill / a.wage)[0];
  if (best) w.command({ type: 'hire', candidateId: best.id });
}

/** A break hut beside the first truck bay, once the crew is big enough. */
function buildHut(w: World): boolean {
  const m = w.map;
  const bay = [...w.bays.keys()][0];
  if (bay === undefined) return false;
  const near = [] as number[];
  for (let r = 1; r < 6 && near.length === 0; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = m.xOf(bay) + dx;
        const y = m.yOf(bay) + dy;
        if (!m.inBounds(x, y)) continue;
        const i = m.idx(x, y);
        if (!placementError(m, 'breakHut', i)) near.push(i);
      }
    }
  }
  if (near.length === 0) return false;
  w.command({ type: 'build', kind: 'breakHut', tiles: [near[0]] });
  return m.build[near[0]] === Build.BreakHut;
}

function signHaulier(w: World): boolean {
  const offer = w.offers
    .filter((o) => o.terms.kind === 'haulier' && o.signingFee < w.cash - 500)
    .sort((a, b) => a.signingFee - b.signingFee)[0];
  if (!offer) return false;
  w.command({ type: 'signContract', id: offer.id });
  return true;
}

/** Put a truck bay beside the road, as close to the jetty as possible. */
function buildBay(w: World): boolean {
  const m = w.map;
  const row = m.yOf(m.entry);
  const candidates: number[] = [];
  for (let i = 0; i < m.build.length; i++) {
    if (!placementError(m, 'truckBay', i)) candidates.push(i);
  }
  const shore = [...w.bays.keys()][0] ?? m.entry;
  candidates.sort(
    (a, b) =>
      Math.abs(m.xOf(a) - m.xOf(shore)) +
      Math.abs(m.yOf(a) - row) -
      (Math.abs(m.xOf(b) - m.xOf(shore)) + Math.abs(m.yOf(b) - row)),
  );
  const tile = candidates[0];
  if (tile === undefined) return false;
  w.command({ type: 'build', kind: 'truckBay', tiles: [tile] });
  return m.build[tile] === Build.TruckBay;
}

/** Add one jetty tile beyond the current tip of the starting pier. */
function extendJetty(w: World): boolean {
  const m = w.map;
  const row = m.yOf(m.entry);
  let x = 0;
  while (x < m.w - 1 && m.build[m.idx(x + 1, row)] !== Build.None) x++;
  const next = m.idx(x + 1, row);
  if (m.build[m.idx(x, row)] !== Build.Jetty || placementError(m, 'jetty', next)) return false;
  w.command({ type: 'build', kind: 'jetty', tiles: [next] });
  return m.build[next] === Build.Jetty;
}

function playthrough(seed: number, days: number) {
  const w = World.create(seed);
  const log: string[] = [];
  for (let d = 1; d <= days && !w.bankrupt; d++) {
    for (let t = 0; t < TICKS_PER_DAY; t++) w.step();
    const did = playDay(w);
    const moods = w.contracts
      .filter((c) => c.terms.kind === 'fishery')
      .map((c) => Math.round(c.satisfaction))
      .join('/');
    const anchored = w.boats.filter((b) => b.state === 'anchored').length;
    const bays = [...w.bays.values()].map((b) => b.crates.length).join('/');
    log.push(
      `d${String(d).padStart(2)} $${String(w.cash).padStart(6)} staff ${w.people.length} ` +
        `boats ${w.boats.length} (anch ${anchored}) bays ${bays} trucks ${w.trucks.length} ` +
        `cap ${w.capacity().demand}/${w.capacity().unloading}/${w.capacity().trucking} ` +
        `pen ${w.stats.penalties} moods ${moods || '-'} ${did.join(', ')}`,
    );
  }
  return { w, log };
}

describe('Playthrough', () => {
  it.each([7, 99, 1234])('a sensible strategy grows the port (seed %i)', (seed) => {
    const { w, log } = playthrough(seed, 30);
    if (process.env.BALANCE) console.log(`seed ${seed}\n${log.join('\n')}`);
    // Growth shows up as a bigger port, not necessarily more cash: the bot
    // reinvests. It must stay solvent and handle several times the start.
    expect(w.bankrupt).toBe(false);
    expect(w.cash).toBeGreaterThan(1000);
    expect(w.capacity().demand).toBeGreaterThanOrEqual(40);
    expect(w.contracts.every((c) => c.satisfaction >= 50)).toBe(true);
  });
});
