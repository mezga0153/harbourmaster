/**
 * The playthrough bot, shared by the balance check and tests that need a
 * port built up the way a player would.
 */
import * as B from '../src/sim/balance';
import { fisheryDailyCrates, type FisheryTerms } from '../src/sim/contracts';
import { buyable, landError, plotPrice } from '../src/sim/land';
import { placementError, walkable } from '../src/sim/rules';
import { Build, TICKS_PER_DAY } from '../src/sim/types';
import { TIERS } from '../src/sim/tiers';
import { World } from '../src/sim/world';
import { canUpgrade, capacity } from '../src/sim/systems/economy';
import { docks as docksOf } from '../src/sim/systems/boats/berthing';

/**
 * A simple bot that plays like a sensible beginner, once per in-game day.
 * Used as a balance check: a reasonable strategy should grow the port.
 * Run with BALANCE=1 to print a day-by-day log.
 */
export function playDay(w: World): string[] {
  const did: string[] = [];
  // Upgrade the port when it is affordable with a cushion to spare.
  if (canUpgrade(w) && w.cash > TIERS[w.tier + 1].cost + 3000) {
    w.command({ type: 'upgrade' });
    did.push(`upgrade to ${TIERS[w.tier].name}`);
  }
  // The ice works, once the town's fish market wants ice: cheap, and the
  // town's next step. It needs a truck bay, which the port has.
  const ice = w.offers.find(
    (o) => o.terms.kind === 'shipper' && o.terms.goods === 'ice' && o.signingFee < w.cash - 1500,
  );
  if (ice && w.bays.size > 0) {
    w.command({ type: 'signContract', id: ice.id });
    did.push('ice works');
  }
  // Good staff are worth keeping: grant raises while the books are healthy.
  for (const p of w.people) {
    if (p.raiseAsk > 0) w.command({ type: 'raise', id: p.id, accept: w.cash > 1500 });
  }
  const waiting = w.boats.filter((b) => b.state === 'anchored').length;
  const cap = capacity(w);
  const fleet = w.contracts.reduce(
    (n, c) => n + (c.terms.kind === 'haulier' ? c.terms.fleet : 0),
    0,
  );

  // Queues on the jetty, two days running: more people will not help, more
  // berths will. One busy day is not a pattern.
  const busyDays = cap.congestion > 0.15 ? (jamDays.get(w) ?? 0) + 1 : 0;
  jamDays.set(w, busyDays);
  const jammed = busyDays >= 2;
  if ((jammed || waiting > 1) && w.cash > 2500 && newJetty(w)) {
    did.push('new jetty');
    // Give the new jetty a few days to take the pressure off.
    jamDays.set(w, -3);
  }

  // Not enough hands to unload what arrives.
  if (!jammed && cap.demand > cap.unloading * 0.85 && w.cash > 600) {
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
    .filter(
      (o) =>
        o.terms.kind === 'fishery' &&
        o.signingFee < w.cash - 1000 - B.HIRE_FEE * 2 &&
        (o.terms.vessel !== 'coaster' || cap.deepBerths > 0),
    )
    .sort((a, b) => b.signingFee - a.signingFee)[0];

  // Far more hands than work and nothing to grow into: let the priciest go.
  if (!nextOffer && cap.unloading > cap.demand * 2.2 && w.people.length > 3) {
    const priciest = [...w.people].sort((a, b) => b.wage / b.skill - a.wage / a.skill)[0];
    w.command({ type: 'fire', id: priciest.id });
    did.push('dismiss');
  }

  // Somewhere to rest once there is a crew. One hut seats three.
  const huts = w.map.build.filter((b) => b === Build.BreakHut).length;
  if (w.people.length > huts * 4 + 2 && w.cash > 700 && buildHut(w)) did.push('hut');

  // Boats queueing for a berth.
  if (waiting > 1 && w.cash > 800 && extendJetty(w)) did.push('jetty');

  // Spare capacity and money, and no demurrage lately: take on another
  // fishery, making room first.
  const fined = w.stats.penalties > (lastPenalties.get(w) ?? 0);
  lastPenalties.set(w, w.stats.penalties);
  if (waiting === 0 && w.cash > 1800 && !fined) {
    const offer = nextOffer;
    if (offer) {
      const need = cap.demand + fisheryDailyCrates(offer.terms as FisheryTerms);
      if (need > cap.unloading * 0.85) {
        if (jammed) {
          // One new jetty a day is plenty.
          if (!did.includes('new jetty') && newJetty(w)) did.push('jetty ahead');
        } else {
          hireBest(w);
          did.push('hire ahead');
        }
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

/** Penalties paid up to yesterday, to notice new ones. */
const lastPenalties = new WeakMap<World, number>();

/** Days in a row each port has had queues on its walkways. */
const jamDays = new WeakMap<World, number>();

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

/**
 * Lay a port path from `from` to the nearest existing port surface, as a
 * player would when putting down a new bay, hut or jetty.
 */
function connect(w: World, from: number[]): boolean {
  const m = w.map;
  const own = new Set(from);
  const prev = new Map<number, number>();
  const queue = [...from];
  for (const f of from) prev.set(f, -1);
  while (queue.length > 0) {
    const i = queue.shift()!;
    for (const n of m.neighbors4(i)) {
      if (prev.has(n)) continue;
      if (walkable(m.build[n]) && !own.has(n) && m.build[n] !== Build.Jetty) {
        // Reached the network: build the path back to the start.
        const tiles: number[] = [];
        for (let t = i; !own.has(t); t = prev.get(t)!) tiles.push(t);
        if (tiles.length > 0) w.command({ type: 'build', kind: 'footpath', tiles });
        return tiles.every((t) => m.build[t] === Build.Footpath);
      }
      if (placementError(m, 'footpath', n)) continue;
      prev.set(n, i);
      queue.push(n);
    }
  }
  return false;
}

function buildOffice(w: World): boolean {
  const m = w.map;
  // On a fishing jetty, a harbourmaster's hut: the office comes with the wharf.
  const kind = w.tier >= 1 ? 'office' : 'harbourHut';
  const spot = m.build.findIndex((_, i) => !placementError(m, kind, i));
  if (spot < 0) return false;
  w.command({ type: 'build', kind, tiles: [spot] });
  return m.build[spot] === (kind === 'office' ? Build.Office : Build.HarbourHut);
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
  return m.build[tile] === Build.TruckBay && connect(w, [tile]);
}

/**
 * Build a fresh three-tile jetty a few rows along the coast from the others,
 * giving another walkway and more berths.
 */
function newJetty(w: World): boolean {
  const m = w.map;
  // Beyond the free docks, a harbour office has to coordinate the berths.
  const docks = docksOf(w);
  if (docks.length >= B.FREE_DOCKS && !m.build.some((b) => b === Build.Office)) {
    if (w.cash < 3500 || !buildOffice(w)) return false;
  }
  const row0 = m.yOf(m.entry);
  for (const off of [4, -4, 8, -8, 12, -12, 16, -16]) {
    const row = row0 + off;
    if (row < 2 || row >= m.h - 2) continue;
    let rowHasJetty = false;
    for (let x = 0; x < m.w; x++) rowHasJetty ||= m.build[m.idx(x, row)] === Build.Jetty;
    if (rowHasJetty) continue;
    let x = 0;
    while (x < m.w - 1 && m.ocean[m.idx(x, row)] !== 1) x++;
    const tiles = [0, 1, 2].map((k) => m.idx(x + k, row));
    // Past the port's land, buy the plot the jetty would go on, as a player would.
    if (!tiles.every((t) => buyLand(w, t, 2500))) continue;
    const pending = new Set<number>();
    const ok = tiles.every((t) => {
      const fine = !placementError(m, 'jetty', t, pending);
      pending.add(t);
      return fine;
    });
    if (!ok) continue;
    w.command({ type: 'build', kind: 'jetty', tiles });
    return tiles.every((t) => m.build[t] === Build.Jetty) && connect(w, tiles);
  }
  return false;
}

/**
 * Make sure the port owns tile `t`: buy its plot if it is for sale and
 * there is `spare` cash left over after. False if the port cannot build there.
 */
function buyLand(w: World, t: number, spare: number): boolean {
  const m = w.map;
  if (!landError(m, t)) return true;
  const p = m.plotOf(t);
  if (!buyable(m, p) || w.cash < plotPrice(m, p) + spare) return false;
  w.command({ type: 'buyPlot', plot: p });
  return m.owns(t);
}

/** Add one jetty tile beyond the current tip of the starting pier. */
function extendJetty(w: World): boolean {
  const m = w.map;
  const row = m.yOf(m.entry);
  let x = 0;
  while (x < m.w - 1 && m.build[m.idx(x + 1, row)] !== Build.None) x++;
  const next = m.idx(x + 1, row);
  if (m.build[m.idx(x, row)] !== Build.Jetty || !buyLand(w, next, 800)) return false;
  if (placementError(m, 'jetty', next)) return false;
  w.command({ type: 'build', kind: 'jetty', tiles: [next] });
  return m.build[next] === Build.Jetty;
}

export function playthrough(seed: number, days: number) {
  const w = World.create(seed, undefined, false);
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
        `cap ${capacity(w).demand}/${capacity(w).unloading}/${capacity(w).trucking} ` +
        `pen ${w.stats.penalties} cong ${capacity(w).congestion.toFixed(2)} moods ${moods || '-'} ${did.join(', ')}`,
    );
  }
  return { w, log };
}
