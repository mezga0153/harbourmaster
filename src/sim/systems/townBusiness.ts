// The town as the port serves it: its builders keeping up with the people
// moving in, its businesses and what they take, the jobs the port gives, and
// the landmarks it opens as the port supplies it.

import type { World } from '../world';

/** The advisor's tip as the town opens each of these landmarks; see Advisor.tsx. */
const LANDMARK_TIPS: Partial<Record<number, string>> = {
  [Build.FishMarket]: 'fishMarket',
  [Build.IceHouse]: 'iceHouse',
  [Build.Restaurant]: 'restaurant',
  [Build.Cannery]: 'cannery',
  [Build.BuildersYard]: 'buildersYard',
  [Build.School]: 'school',
  [Build.TownHall]: 'townHall',
  [Build.Hospital]: 'hospital',
  [Build.College]: 'college',
  [Build.Station]: 'station',
};
import { BUSINESSES, LANDMARKS, growTown, sentTo, townCap, townHomes, townStageUp } from '../town';
import type { Landmark, Town } from '../town';
import { message, tip } from './output';
import type { TownView } from '../../protocol/views';
import { cargoName } from '../cargo';
import { customsTip, fisheries, hasCustomsOffice, hauliers, townTradeOffers } from './economy';
import { TIERS } from '../tiers';
import * as B from '../balance';
import { needsCustomsOffice, townTrade, type TownTrade } from '../contracts';
import { Build } from '../types';
import { bayRoom } from '../helpers';
import { berthCount } from './boats/berthing';
import { takesExports, takesImports } from './cargo/stores';
import { holds } from './cargo/customs';

/** The town's builders keep up with the people moving in. */
export function buildTown(w: World, t: Town): void {
  if (townHomes(w.map) < t.demand) {
    const built = growTown(t, w.map, (i) => w.dirty.add(i));
    // A new street can join up roads.
    if (built) w.gateCache = null;
  }
  const stage = townStageUp(t, w.map);
  if (stage) {
    const a = /^[aeiou]/i.test(stage) ? 'an' : 'a';
    message(w, `${t.name} has grown into ${a} ${stage.toLowerCase()}.`, 'good');
  }
}

export function businessViews(w: World): TownView['businesses'] {
  const out = new Map<number, TownView['businesses'][number]>();
  const wants = w.town?.wants ?? {};
  const sent = w.town ? sentTo(w.town, w.map) : {};
  for (const code of w.map.build) {
    const def = BUSINESSES[code];
    if (!def) continue;
    const v = out.get(code) ?? {
      label: def.label,
      count: 0,
      boxes: def.boxes,
      perDay: 0,
      takes: def.boxes ? 'containers' : def.takes.map(cargoName).join(' and '),
      left: Math.max(0, Math.floor(wants[code] ?? 0)),
      sent: sent[code] ?? 0,
    };
    v.count++;
    v.perDay += def.perDay;
    out.set(code, v);
  }
  return [...out.values()];
}

/** What the town's businesses will still take today, all crates and all containers together. */
export function wantsView(w: World): TownView['wants'] {
  const out = { crates: 0, boxes: 0 };
  for (const [code, n] of Object.entries(w.town?.wants ?? {})) {
    const def = BUSINESSES[Number(code)];
    if (def) out[def.boxes ? 'boxes' : 'crates'] += Math.max(0, Math.floor(n ?? 0));
  }
  return out;
}

/** People working at the port and driving for its hauliers. */
export function jobs(w: World): number {
  return w.people.length + hauliers(w).reduce((n, h) => n + h.terms.fleet, 0);
}

/** The town's landmarks, for its panel: what it has, and how far towards the next. */
export function landmarkView(w: World, t: Town): Pick<TownView, 'cap' | 'opened' | 'next'> {
  const finite = (n: number) => (Number.isFinite(n) ? n : null);
  const l = LANDMARKS[t.landmarks];
  return {
    cap: finite(townCap(t)),
    opened: LANDMARKS.slice(0, t.landmarks).map((o) => o.name),
    next: l && {
      name: l.name,
      aim: l.aim,
      opens: l.opens,
      have: Math.round(t.goal),
      need: l.goal.total ?? l.goal.perDay ?? 0,
      days: l.goal.days === undefined ? undefined : { done: t.streak, need: l.goal.days },
      cap: finite(l.cap),
      waiting: w.tier < (l.tier ?? 0) ? TIERS[l.tier ?? 0].name : undefined,
      hint: landmarkHint(w, l),
    },
  };
}

/**
 * Why the port is getting nowhere towards the town's next landmark, if
 * something it needs is missing: coasters, a berth for them, or the
 * contract the landmark before brought.
 */
export function landmarkHint(w: World, l: Landmark): string | undefined {
  if (w.tier < (l.tier ?? 0)) {
    return `Upgrade the port to a ${TIERS[l.tier ?? 0].name} in the Port panel (P): nothing counts towards it till then`;
  }
  const coasters = fisheries(w).some((c) => c.terms.vessel === 'coaster');
  const berth = berthCount(w, B.COASTER_DRAFT, true) > 0;
  const signed = (trade: TownTrade) => w.contracts.some((c) => townTrade(c.terms) === trade);
  const offer = (trade: TownTrade) =>
    w.offers.find((o) => townTrade(o.terms) === trade)?.terms.name;
  // A line customs clears needs a customs office before it may be signed.
  const sign = (trade: TownTrade, what: string) => {
    const o = w.offers.find((x) => townTrade(x.terms) === trade);
    if (o && needsCustomsOffice(o.terms) && !hasCustomsOffice(w)) {
      return `Build a customs office (Buildings) so you can sign ${o.terms.name}'s offer: ${trade === 'canned' ? 'the canned fish needs export papers' : `customs clears the ${trade}`}`;
    }
    return `Sign ${offer(trade) ?? what}'s offer on the contracts board (C)`;
  };
  const noBerth = `Coasters need a berth: build a quay 2 wide, in ${B.COASTER_DRAFT} m of water`;
  const feeders = fisheries(w).some((c) => c.terms.vessel === 'feeder');
  const noFeeders = 'Needs feeder ships: sign a container line on the contracts board (C)';
  const boxHauliers = hauliers(w).some((c) => c.terms.cargo === 'container');
  const noBoxHauliers =
    'Needs container hauliers to truck the containers out: sign one on the contracts board (C)';
  let held: string | undefined;
  switch (l.code) {
    case Build.Cannery:
      if (!coasters) return 'Needs coasters: build a quay 2 wide and sign a shipping line';
      if (!berth) return noBerth;
      break;
    case Build.BuildersYard:
      if (!signed('canned')) return sign('canned', 'the cannery');
      if (!coasters) return 'The canned fish goes out on coasters: sign a shipping line';
      if (!berth) return noBerth;
      held = storeHint(w, true);
      break;
    case Build.School:
      if (!signed('timber')) return sign('timber', 'the timber line');
      if (!berth) return noBerth;
      held = storeHint(w, false);
      break;
    case Build.TownHall:
      if (!signed('goods')) return sign('goods', 'the goods line');
      if (!berth) return noBerth;
      held = storeHint(w, false);
      break;
    case Build.Hospital:
    case Build.Station:
      if (!feeders) return noFeeders;
      if (!boxHauliers) return noBoxHauliers;
      return undefined;
    case Build.College:
      if (!w.contracts.some((c) => c.terms.kind === 'shipper' && c.terms.cargo === 'container')) {
        return sign('factory', 'the factory');
      }
      if (!feeders) return 'The containers go out on feeder ships: sign a container line (C)';
      return undefined;
  }
  // Storage full of crates still in customs, or none at all.
  if (held) return held;
  // Crates trucked out need hauliers to take them.
  if (!l.goal.aboard && !w.contracts.some((c) => c.terms.kind === 'haulier')) {
    return 'Needs a haulier to truck the crates out: sign one on the contracts board (C)';
  }
  return undefined;
}

/**
 * What holds up the Coastal Wharf's trade in crate storage, if anything:
 * timber and goods wait for customs in storage for cargo coming in, and
 * canned fish for its export papers in storage for cargo going out.
 */
export function storeHint(w: World, out: boolean): string | undefined {
  const stores = [...w.bays.values()].filter(
    (b) => b.tiles && (out ? takesExports(w, b) : takesImports(w, b)),
  );
  const what = out ? 'cargo going out' : 'cargo coming in';
  const waits = out
    ? 'The canned fish waits in crate storage for its export papers'
    : 'Timber and goods wait in crate storage for customs';
  if (stores.length === 0) return `${waits}: mark out crate storage for ${what}`;
  // Full, with crates still waiting in it.
  const full = stores.every((b) => bayRoom(b, false) <= 0);
  if (full && stores.some((b) => holds(w, b, out).length > 0)) {
    return `${waits}, and the crate storage for ${what} is full: mark out more`;
  }
  return undefined;
}

/** The town opens a landmark: it goes up in town, and says what it brings. */
export function openLandmark(w: World, l: Landmark | null): void {
  if (!l || !w.town) return;
  const next = LANDMARKS[w.town.landmarks];
  const later =
    next && w.tier < (next.tier ?? 0) ? `, once the port is a ${TIERS[next.tier ?? 0].name}` : '';
  const then = next
    ? ` Next it wants a ${next.name.toLowerCase()}: ${next.aim.toLowerCase()}${later}.`
    : '';
  message(w, `${w.town.name} opens its ${l.name.toLowerCase()}. ${l.opens}.${then}`, 'good');
  // The advisor says what it brings and what comes next.
  const tipId = LANDMARK_TIPS[l.code];
  if (tipId) tip(w, tipId);
  // Its builders put it up straight away, and the school's department store.
  for (let k = l.code === Build.School ? 2 : 1; k > 0; k--) {
    growTown(w.town, w.map, (i) => w.dirty.add(i));
  }
  // The offer it brings goes up on the board at once.
  townTradeOffers(w);
  customsTip(w);
}
