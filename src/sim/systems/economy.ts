// Money, staff and the port's tier: the ledger and the loan, hiring and firing
// and the dockhands' wages and raises, contracts and the offers on the board,
// how a ship's visit is judged, what the port can handle a day, and the day's
// accounts at its end.

import type { World } from '../world';
import { jobs, openLandmark } from './townBusiness';
import type { Boat, LedgerCategory } from '../state';
import * as B from '../balance';
import { message, moneyAt, nag, tip, tipUnless } from './output';
import { LANDMARKS, landmarkDue, townCap, townDay } from '../town';
import { TIERS } from '../tiers';
import { makeCandidate, paceFactor, traitDef } from '../staff';
import {
  breachPenalty,
  cancelFee,
  craneTicks,
  emptyLedger,
  FINANCE_DAYS,
  isMachine,
  loadTicks,
  outAboard,
  outCap,
} from '../helpers';
import { MACHINES } from '../machines';
import { Build, TICKS_PER_DAY } from '../types';
import type { MachineKind } from '../types';
import {
  fisheryDailyCrates,
  isIce,
  makeCannedOffer,
  makeIceOffer,
  makeLobsterOffer,
  makeOffer,
  makeTownLineOffer,
  needsCustomsOffice,
  townTrade,
} from '../contracts';
import type { Contract, FisheryTerms, HaulierTerms, ShipperTerms, Terms } from '../contracts';
import { Rng } from '../rng';
import type { BoatVisit, Capacity } from '../../protocol/views';
import { berthCount, dockInUse, pickTile } from './boats/berthing';
import { changeMorale } from './workforce/crowding';
import { muster, spawnDockhand } from './workforce/dockhands';
import { jibStows } from './cargo/stores';
import { cancelJob } from './cargo/customs';
import { baysOpen, roadTo } from './roads/bays';

/** Every change to cash goes through here, so the ledger adds up. */
export function book(w: World, category: LedgerCategory, amount: number): void {
  w.cash += amount;
  w.today[category] += amount;
}

export function interestDue(w: World): number {
  return Math.round(w.loan * B.LOAN_DAILY_RATE);
}

/** Positive amounts borrow, negative amounts repay. */
export function takeLoan(w: World, amount: number): void {
  if (amount > 0) {
    const room = B.LOAN_MAX - w.loan;
    const borrow = Math.min(amount, room);
    if (borrow <= 0) return message(w, 'The bank will not lend you any more.', 'bad');
    w.loan += borrow;
    w.cash += borrow;
    message(w, `Borrowed $${borrow.toLocaleString('en-US')} from the bank.`, 'info');
  } else {
    const repay = Math.min(-amount, w.loan);
    if (repay <= 0) return;
    if (w.cash < repay) return message(w, 'Not enough cash to repay that much.', 'bad');
    w.loan -= repay;
    w.cash -= repay;
    message(w, `Repaid $${repay.toLocaleString('en-US')} of the loan.`, 'good');
  }
}

/** People in the town: the port may grow a step once there are enough of them. */
/** Tell the player, once, when the town has grown enough for the next step up. */
export function townGrownEnough(w: World): void {
  const next = TIERS[w.tier + 1];
  if (!next || next.comingSoon || w.townSize() < next.town) return;
  if (w.tierReadyTold >= w.tier + 1) return;
  w.tierReadyTold = w.tier + 1;
  const name = w.town?.name ?? 'The town';
  message(
    w,
    `${name} has grown to ${w.townSize().toLocaleString('en-US')} people: the harbour authority will let the port become a ${next.name}. See the Port panel (P).`,
    'good',
  );
}

/**
 * The landmark the town must open before it can grow big enough for the
 * port's next tier, if its cap holds it short of that.
 */
export function tierWaitsOn(w: World): string | undefined {
  const next = TIERS[w.tier + 1];
  const t = w.town;
  if (!next || next.comingSoon || !t || townCap(t) >= next.town) return undefined;
  return LANDMARKS.slice(t.landmarks).find((l) => l.cap >= next.town)?.name;
}

export function canUpgrade(w: World): boolean {
  const next = TIERS[w.tier + 1];
  if (!next || next.comingSoon) return false;
  return w.townSize() >= next.town && w.cash >= next.cost;
}

export function upgrade(w: World): void {
  const next = TIERS[w.tier + 1];
  if (!next || next.comingSoon) return message(w, 'No further upgrades yet.', 'info');
  if (w.townSize() < next.town) {
    return message(
      w,
      `The harbour authority waits for the town to grow: ${next.name} needs ${next.town.toLocaleString('en-US')} people in town, it has ${w.townSize().toLocaleString('en-US')}.`,
      'bad',
    );
  }
  if (w.cash < next.cost) {
    return message(
      w,
      `Not enough cash for the harbour authority's fee of $${next.cost.toLocaleString('en-US')}.`,
      'bad',
    );
  }
  book(w, 'construction', -next.cost);
  w.tier++;
  w.capacityCache = null;
  message(w, `The port is now a ${next.name}! New buildings and machines are unlocked.`, 'good');
  tip(w, `tier${w.tier}`);
  addOffer(w, 'fishery');
  smallTrucks(w);
}

/**
 * From the Coastal Wharf on, hauliers that sent pickups send small trucks,
 * which forklifts load as well as dockhands; those on their way keep on.
 */
export function smallTrucks(w: World): void {
  if (w.tier < 1) return;
  // Those still on offer too.
  for (const o of w.offers) {
    if (o.terms.kind !== 'haulier' || !o.terms.pickup) continue;
    o.terms.pickup = undefined;
    o.terms.capacity = Math.max(o.terms.capacity, B.TRUCK_CAPACITY);
  }
  for (const c of w.contracts) {
    const t = c.terms;
    if (t.kind !== 'haulier' || !t.pickup) continue;
    t.pickup = undefined;
    t.capacity = Math.max(t.capacity, B.TRUCK_CAPACITY);
    message(
      w,
      `${t.name} sends small trucks now, of ${B.TRUCK_CAPACITY} crates, which forklifts load as well as dockhands.`,
      'good',
    );
  }
}

export function hire(w: World, candidateId: number): void {
  const c = w.candidates.find((x) => x.id === candidateId);
  if (!c) return message(w, 'That candidate has taken another job.', 'bad');
  if (w.cash < B.HIRE_FEE) return message(w, 'Not enough money to hire', 'bad');
  book(w, 'hiring', -B.HIRE_FEE);
  w.candidates = w.candidates.filter((x) => x !== c);
  const p = spawnDockhand(w, muster(w), c);
  message(w, `${p.name} has been hired and reports at the truck bay.`, 'good');
}

/** Replace one candidate each day and top the list up. */
export function refreshCandidates(w: World): void {
  if (w.candidates.length >= B.CANDIDATES) w.candidates.shift();
  while (w.candidates.length < B.CANDIDATES) {
    w.candidates.push(makeCandidate(w.rng, w.nextId++));
  }
}

export function fire(w: World, id: number): void {
  const p = w.people.find((q) => q.id === id);
  if (!p) return;
  if (isMachine(p)) {
    const refund = Math.round(MACHINES[p.kind as MachineKind].price * B.SELL_SHARE);
    cancelJob(w, p);
    w.people = w.people.filter((q) => q !== p);
    book(w, 'construction', refund);
    message(w, `Sold ${p.name} for $${refund}.`, 'info');
    return;
  }
  if (p.carrying) message(w, `${p.name} dropped their crate on the way out.`, 'bad');
  cancelJob(w, p);
  w.people = w.people.filter((q) => q !== p);
  message(w, `${p.name} has left the port.`, 'info');
}

export function addContract(
  w: World,
  terms: Terms,
  firstBoatTick: number,
  signingFee: number,
): Contract {
  const c: Contract = {
    id: w.nextId++,
    // A copy: the starter terms are shared by every new game.
    terms: { ...terms },
    signingFee,
    satisfaction: B.START_SATISFACTION,
    nextBoatTick: firstBoatTick,
    warned: false,
  };
  w.contracts.push(c);
  return c;
}

export function addOffer(w: World, kind: Terms['kind']): void {
  const taken = new Set([...w.contracts, ...w.offers].map((c) => c.terms.name));
  const offer = makeOffer(
    w.rng,
    w.nextId++,
    w.tick,
    kind,
    taken,
    w.tier,
    w.stats.containers,
    // Lobster boats once the town has its ice house.
    (w.town?.landmarks ?? LANDMARKS.length) >= 2,
  );
  if (offer) w.offers.push(offer);
}

export function refreshOffers(w: World): void {
  const expired = w.offers.filter((o) => o.expires <= w.tick);
  w.offers = w.offers.filter((o) => o.expires > w.tick);
  if (expired.length > 0 && w.offers.length === 0) {
    message(w, 'Some contract offers have expired.', 'info');
  }
  // An ice works offering its ice for the fishing boats, while none has a
  // contract: besides the other offers, drawn apart so they come as ever.
  const others = w.offers.filter((o) => !isIce(o.terms) && !townTrade(o.terms));
  // Once the town has its fish market, which wants ice for its fish.
  const market = (w.town?.landmarks ?? 0) >= 1;
  // Once it has its ice house, a lobsterman too, while none has a contract.
  const lobster = (t: Terms) => t.kind === 'fishery' && t.catch === 'lobster';
  if (
    (w.town?.landmarks ?? 0) >= 2 &&
    !w.offers.some((o) => lobster(o.terms)) &&
    !w.contracts.some((c) => lobster(c.terms))
  ) {
    const taken = new Set([...w.contracts, ...w.offers].map((c) => c.terms.name));
    const offer = makeLobsterOffer(new Rng(w.tick * 6151 + 29), -2 - w.tick, w.tick, taken);
    if (offer) w.offers.push(offer);
  }
  if (
    market &&
    baysOpen(w) &&
    !w.offers.some((o) => isIce(o.terms)) &&
    !w.contracts.some((c) => isIce(c.terms))
  ) {
    const taken = new Set([...w.contracts, ...w.offers].map((c) => c.terms.name));
    const offer = makeIceOffer(new Rng(w.tick * 7919 + 17), -1 - w.tick, w.tick, taken);
    if (offer) w.offers.push(offer);
  }
  townTradeOffers(w);
  if (others.length < B.MAX_OFFERS && w.rng.next() < 0.7) {
    // Keep at least one offer of each kind on the board.
    const has = (k: Terms['kind']) => others.some((o) => o.terms.kind === k);
    // Shippers come with the Coastal Wharf: before it, the same draws as ever.
    const pick = (): Terms['kind'] => {
      const roll = w.rng.next();
      if (w.tier < 1) return roll < 0.6 ? 'fishery' : 'haulier';
      return roll < 0.5 ? 'fishery' : roll < 0.8 ? 'haulier' : 'shipper';
    };
    const kind: Terms['kind'] = !has('haulier')
      ? 'haulier'
      : !has('fishery')
        ? 'fishery'
        : w.tier >= 1 && !has('shipper')
          ? 'shipper'
          : pick();
    const before = w.offers.length;
    addOffer(w, kind);
    // Nobody of that kind wants to deal: maybe the other kind does.
    if (w.offers.length === before) addOffer(w, kind === 'haulier' ? 'fishery' : 'haulier');
    // The Contracts button counts the offers: only an empty board is news.
    if (before === 0 && w.offers.length > 0) {
      message(w, `New contract offer from ${w.offers.at(-1)!.terms.name}.`, 'info');
    }
  }
  customsTip(w);
}

/**
 * What the Coastal Wharf's landmarks bring, each on the board from the
 * day it opens till one is signed: the cannery's canned fish, then the
 * timber coasters for the builders' yard, then coasters of goods for the
 * department store that comes with the school.
 */
export function townTradeOffers(w: World): void {
  const opened = w.town?.landmarks ?? 0;
  const trades: ['canned' | 'timber' | 'goods', number][] = [
    ['canned', Build.Cannery],
    ['timber', Build.BuildersYard],
    ['goods', Build.School],
  ];
  trades.forEach(([trade, code], k) => {
    const at = LANDMARKS.findIndex((l) => l.code === code);
    if (at < 0 || opened <= at) return;
    const has = (t: Terms) => townTrade(t) === trade;
    if (w.offers.some((o) => has(o.terms)) || w.contracts.some((c) => has(c.terms))) return;
    const taken = new Set([...w.contracts, ...w.offers].map((c) => c.terms.name));
    const rng = new Rng(w.tick * 4099 + 31 * k + 7);
    // Apart from the ice works' and lobstermen's ids, below them.
    const id = -1e9 - w.tick * 4 - k;
    const offer =
      trade === 'canned'
        ? makeCannedOffer(rng, id, w.tick, taken, w.town?.name)
        : makeTownLineOffer(rng, id, w.tick, taken, trade);
    if (offer) w.offers.push(offer);
  });
}

/** Whether the port has a customs office, which lines whose cargo customs clears need. */
export function hasCustomsOffice(w: World): boolean {
  return w.map.build.includes(Build.Customs);
}

/**
 * Why an offer cannot be signed yet, in the player's words, as the sim
 * sees it; null when nothing stops it.
 */
export function offerBlocked(w: World, terms: Terms, customs = hasCustomsOffice(w)): string | null {
  if (needsCustomsOffice(terms) && !customs) return `Needs a customs office: ${customsWhat(terms)}`;
  return null;
}

/** What customs does for a line's cargo, for the reason it cannot be signed. */
function customsWhat(t: Terms): string {
  if (t.kind === 'shipper')
    return 'its canned fish goes out on export papers. Build one (Port buildings)';
  if (t.kind === 'fishery' && t.vessel === 'feeder')
    return 'customs clears its containers. Build one (Port buildings)';
  const what = t.kind === 'fishery' ? t.catch : 'cargo';
  return `customs clears its ${what}. Build one (Port buildings)`;
}

/**
 * The advisor tells of the customs office the first time a line on the
 * board needs one and the port has none.
 */
export function customsTip(w: World): void {
  if (w.tipsSeen.has('customsOffice')) return;
  if (!w.offers.some((o) => needsCustomsOffice(o.terms))) return;
  tipUnless(w, 'customsOffice', hasCustomsOffice(w));
}

export function signContract(w: World, offerId: number): void {
  const offer = w.offers.find((o) => o.id === offerId);
  if (!offer) return message(w, 'That offer is no longer available.', 'bad');
  const blocked = offerBlocked(w, offer.terms);
  if (blocked) return message(w, `Cannot sign with ${offer.terms.name}. ${blocked}.`, 'bad');
  if (w.cash < offer.signingFee) return message(w, 'Not enough money to sign', 'bad');
  book(w, 'contracts', -offer.signingFee);
  w.offers = w.offers.filter((o) => o !== offer);
  // A new fishery sends its first boat soon after signing.
  addContract(w, offer.terms, w.tick + w.rng.int(60, 240), offer.signingFee);
  message(w, `Signed with ${offer.terms.name}.`, 'good');
  w.firstBoat.add(offer.terms.name);
  w.tipsSeen.add('contract');
}

export function cancelContract(w: World, id: number): void {
  const c = w.contracts.find((x) => x.id === id);
  if (!c) return;
  const fee = cancelFee(c);
  book(w, 'contracts', -fee);
  w.stats.penalties += fee;
  w.contracts = w.contracts.filter((x) => x !== c);
  message(
    w,
    fee > 0
      ? `Contract with ${c.terms.name} ended. Buyout: $${fee}.`
      : `Contract with ${c.terms.name} ended.`,
    'info',
  );
  if (!w.contracts.some((x) => x.terms.kind === 'haulier')) {
    message(w, 'No haulier is under contract. No trucks will come for crates!', 'bad');
  }
}

export function fisheries(w: World): (Contract & { terms: FisheryTerms })[] {
  return w.contracts.filter((c) => c.terms.kind === 'fishery') as (Contract & {
    terms: FisheryTerms;
  })[];
}

export function shippers(w: World): (Contract & { terms: ShipperTerms })[] {
  return w.contracts.filter((c) => c.terms.kind === 'shipper') as (Contract & {
    terms: ShipperTerms;
  })[];
}

export function hauliers(w: World): (Contract & { terms: HaulierTerms })[] {
  return w.contracts.filter((c) => c.terms.kind === 'haulier') as (Contract & {
    terms: HaulierTerms;
  })[];
}

/**
 * Settle a fishery boat's visit as it leaves. Waiting costs demurrage and
 * goodwill; a fishery with no goodwill left walks out and claims a penalty.
 */
export function penalty(w: World, amount: number, at: number): void {
  if (amount <= 0) return;
  book(w, 'penalties', -amount);
  w.stats.penalties += amount;
  moneyAt(w, -amount, at);
}

/**
 * How a boat's visit moves its line's goodwill, were it to sail now: up
 * for coming and going, down for each while it waited at anchor or took
 * longer alongside than the line allows.
 */
export function visitMood(_w: World, b: Boat): number {
  const slowTicks = Math.max(0, b.mooredTicks - b.grace);
  return (
    B.SATISFACTION_PER_BOAT -
    b.anchorTicks / B.ANCHOR_PENALTY_TICKS -
    slowTicks / B.MOORED_PENALTY_TICKS
  );
}

/** A ship taking exports on board, unloaded, sent off now with those it has. */
export function canSail(_w: World, b: Boat): boolean {
  return (
    b.state === 'moored' &&
    b.crates === 0 &&
    b.reserved === 0 &&
    outCap(b) > 0 &&
    b.loadedAt === undefined
  );
}

/**
 * Send a ship taking exports on board off with those it has: what the
 * cranes are lifting on board goes on, the rest waits for the next ship.
 */
export function sailNow(w: World, id: number): void {
  const b = w.boats.find((q) => q.id === id);
  if (!b || !canSail(w, b)) return;
  b.loadQuota = outAboard(b);
}

/** How a ship's visit is going, for its panel. */
export function visitView(w: World, b: Boat): BoatVisit {
  const t = w.tick;
  const c = w.contracts.find((x) => x.id === b.contractId);
  return {
    inPort: b.came !== undefined ? t - b.came : -1,
    anchored: b.anchorTicks,
    unloading: b.mooredAt !== undefined ? (b.unloadedAt ?? t) - b.mooredAt : -1,
    unloaded: b.unloadedAt !== undefined,
    loading: b.unloadedAt !== undefined ? (b.loadedAt ?? t) - b.unloadedAt : -1,
    loaded: b.loadedAt !== undefined,
    loads: outCap(b) > 0,
    out: outAboard(b),
    quota: b.loadQuota,
    allowed: Math.round(b.grace),
    worked: b.mooredTicks,
    mood: c && Math.round(c.satisfaction),
    moodChange: Math.round(visitMood(w, b) * 10) / 10,
    canSail: canSail(w, b),
    ...heldView(w, b),
  };
}

/** A ship coming in held up a while by one moored in its way: which, and how long so far. */
export function heldView(w: World, b: Boat): { heldBy?: string; heldFor?: number } {
  const o = b.waitingOn !== undefined && w.boats.find((q) => q.id === b.waitingOn);
  if (!o || b.state !== 'arriving' || (b.waitedFor ?? 0) <= B.BERTH_BLOCKED_TICKS) return {};
  const what = o.vessel === 'feeder' ? 'feeder ship' : o.vessel === 'coaster' ? 'coaster' : 'boat';
  return { heldBy: `the ${o.company} ${what}`, heldFor: b.waitedFor };
}

export function judgeVisit(w: World, b: Boat, gaveUp: boolean): void {
  const slowTicks = Math.max(0, b.mooredTicks - b.grace);
  const demurrage = Math.round(((b.anchorTicks + slowTicks) / TICKS_PER_DAY) * B.DEMURRAGE_PER_DAY);
  if (demurrage > 0) {
    penalty(w, demurrage, w.tileOf(b));
    w.demurrageToday.amount += demurrage;
    w.demurrageToday.ships++;
  }
  if (gaveUp && b.crates > 0) {
    const claim = Math.round(b.crates * b.fee * B.LOST_CARGO_SHARE);
    penalty(w, claim, w.tileOf(b));
    message(
      w,
      `A ${b.company} boat gave up and left with ${b.crates} ${b.vessel === 'feeder' ? 'containers' : 'crates'}. They claim $${claim}.`,
      'bad',
    );
  }

  const c = w.contracts.find((x) => x.id === b.contractId);
  if (!c) return;
  const delta = visitMood(w, b) - (gaveUp ? B.GAVE_UP_PENALTY : 0);
  // Good visits lift it to 100 at most; above that (set so by hand) it
  // only comes down.
  c.satisfaction = Math.max(0, Math.min(Math.max(100, c.satisfaction), c.satisfaction + delta));
  if (c.satisfaction === 0) {
    w.contracts = w.contracts.filter((x) => x !== c);
    const breach = breachPenalty(c);
    penalty(w, breach, w.tileOf(b));
    message(
      w,
      `${c.terms.name} has walked out and claims $${breach} for breach of contract.`,
      'bad',
    );
  } else if (c.satisfaction < 25 && !c.warned) {
    c.warned = true;
    message(w, `${c.terms.name} is unhappy. Their boats are waiting too long.`, 'bad');
  } else if (c.satisfaction >= 40) {
    c.warned = false;
  }
}

export function adviseOnBays(w: World): void {
  const fullForLong = w.bayFullTicks > TICKS_PER_DAY / 3;
  w.bayFullTicks = 0;
  if (!fullForLong) return;
  const trucks = hauliers(w).reduce((n, c) => n + c.terms.fleet, 0);
  nag(
    w,
    'bays',
    trucks < w.bays.size
      ? 'Crates are piling up in the truck bays. Sign another haulier for more trucks.'
      : 'Truck bays keep filling up. Each bay loads one truck at a time, so build another truck bay.',
    'info',
  );
}

/**
 * Rough crates-per-day estimates for planning, from walking and driving
 * distances. Shown in the Contracts panel.
 */
export function capacity(w: World): Capacity {
  if (w.capacityCache) return w.capacityCache;
  const m = w.map;
  const demand = fisheries(w)
    .filter((c) => c.terms.vessel !== 'feeder')
    .reduce((n, c) => n + fisheryDailyCrates(c.terms), 0);

  // One trip: dock to the nearest bay and back, plus handling.
  const jetties: number[] = [];
  for (let i = 0; i < m.build.length; i++) if (dockInUse(w, i)) jetties.push(i);
  const bays = [...w.bays.values()];
  let walk = 0;
  for (const j of jetties) {
    const d = Math.min(...bays.map((b) => w.distTo(j, b)));
    walk += Number.isFinite(d) ? d : 0;
  }
  const avgWalk = jetties.length && bays.length ? walk / jetties.length : 0;
  let hasHut = false;
  for (let i = 0; i < m.build.length && !hasHut; i++) hasHut = m.build[i] === Build.BreakHut;
  // Share of the day spent working rather than resting.
  const uptime = hasHut ? 0.88 : 0.72;
  // Dockhands carrying crates all the way to a bay or crate storage: they
  // set none down on the quay. Forklifts move them on from storage the
  // trucks cannot reach, as by a jib crane.
  let carrying = 0;
  let forklifting = 0;
  if (bays.length && jetties.length) {
    for (const p of w.people) {
      if (p.kind === 'stacker') continue;
      if (p.kind === 'forklift') {
        // Forklifts carry several crates, need no breaks but do break down.
        // They cannot drive onto wooden jetties, so they need a quay.
        if (!jetties.some((j) => m.build[j] !== Build.Jetty)) continue;
        const ticks = (2 * avgWalk * 1.2) / B.FORKLIFT_SPEED + (B.PICK_TICKS + B.DROP_TICKS) * 1.5;
        forklifting += ((TICKS_PER_DAY * 0.9) / ticks) * p.capacity;
        continue;
      }
      const handling = (B.PICK_TICKS + B.DROP_TICKS) * traitDef(p.trait).handling;
      const pace = paceFactor(p.skill, p.morale, 100);
      const tripTicks = (2 * avgWalk * 1.2) / (B.WALK_SPEED * pace) + handling;
      carrying += (TICKS_PER_DAY * uptime) / tripTicks;
    }
  }
  // Jib cranes lift while a boat lies alongside, a good part of the day
  // going on boats coming and going, and those with crate storage in
  // reach stow it there and then.
  let lifting = 0;
  let stowing = 0;
  for (const c of w.cranes.values()) {
    if (c.kind !== 'jib' || !dockInUse(w, c.idx)) continue;
    const rate = (TICKS_PER_DAY / B.CRANE_TICKS) * 0.3;
    lifting += rate;
    if (jibStows(w, c)) stowing += rate;
  }
  // Off the boats and on to the bays: dockhands carry it all the way, and
  // jib cranes swing it into storage beside them, which the forklifts
  // empty where the trucks cannot reach it.
  const off = carrying + lifting;
  const on = carrying + Math.min(stowing, forklifting);

  // One truck trip: highway to bay and back, plus loading. A bay loads one
  // truck at a time, so trucks beyond the number of bays add nothing.
  w.roadLen = Math.min(Infinity, ...[...w.bays.values()].map((b) => roadTo(w, b)));
  // Time lost in queues on narrow walkways comes straight off the top.
  const unloading = Math.min(off, on) * (1 - w.congestion);
  const palletDemand = fisheries(w)
    .filter((c) => c.terms.vessel === 'coaster')
    .reduce((n, c) => n + fisheryDailyCrates(c.terms), 0);
  w.capacityCache = {
    congestion: w.congestion,
    demand: Math.round(demand),
    unloading: Math.round(unloading),
    trucking: truckingWith(w, null),
    off: Math.round(off * (1 - w.congestion)),
    moved: Math.round(on * (1 - w.congestion)),
    deepBerths: berthCount(w, B.COASTER_DRAFT, true),
    pallets: {
      demand: Math.round(palletDemand),
      unloading: Math.round(Math.min(off, on) * (1 - w.congestion)),
    },
    boxes: containerCapacity(w),
  };
  return w.capacityCache;
}

/** Rough containers-per-day estimates, like the crate ones above. */
export function containerCapacity(w: World): Capacity['boxes'] {
  const demand = fisheries(w)
    .filter((c) => c.terms.vessel === 'feeder')
    .reduce((n, c) => n + fisheryDailyCrates(c.terms), 0);
  const cranes = [...w.cranes.values()].filter((c) => c.kind !== 'jib');
  // A crane only works while a feeder is alongside; allow for gaps.
  const lifting = cranes.reduce((n, c) => n + (TICKS_PER_DAY / craneTicks(c)) * 0.6, 0);
  const yards = [...w.yards.values()];
  let walk = 0;
  for (const c of cranes) {
    const at = pickTile(w, c);
    walk += yards.length ? Math.min(...yards.map((y) => w.distTo(at, y))) : 0;
  }
  const avg = cranes.length && yards.length ? walk / cranes.length : 0;
  const stackers = w.people.filter((p) => p.kind === 'stacker').length;
  const trip = (2 * avg * 1.2) / B.STACKER_SPEED + (B.PICK_TICKS + B.DROP_TICKS) * 2.5;
  // Without a yard gantry the stackers also lift each container onto its
  // truck: a short trip from the stack to the road beside it, and handling.
  const bare = yards.length ? yards.filter((y) => !w.yardGantry(y)).length / yards.length : 0;
  const loading = (2 * 1.5 * 1.2) / B.STACKER_SPEED + (B.PICK_TICKS + B.DROP_TICKS) * 2.5;
  // Terminal tractors only work yards with a gantry, which lifts for them.
  const tractors = yards.some((y) => w.yardGantry(y))
    ? w.people.filter((p) => p.kind === 'tractor').length
    : 0;
  const haul = (2 * avg * 1.2) / B.TRACTOR_SPEED + B.PICK_TICKS + B.YARD_GANTRY_TICKS;
  const moving =
    avg > 0
      ? stackers * ((TICKS_PER_DAY * 0.85) / (trip + bare * loading)) +
        tractors * ((TICKS_PER_DAY * 0.85) / haul)
      : 0;
  let trucking = 0;
  // Trucks load beside the yards, one at a time at each spot, while the
  // others are away on their rounds.
  const road = Math.min(Infinity, ...yards.map((y) => roadTo(w, y)));
  if (Number.isFinite(road)) {
    const carried = hauliers(w)
      .filter((h) => h.terms.cargo === 'container')
      .reduce(
        (n, h) => n + h.terms.fleet * truckRate(w, h.terms.capacity, road, B.YARD_LOAD_TICKS),
        0,
      );
    const docks = yards.reduce((n, y) => n + w.loadingDocks(y).length, 0);
    const loaded = (docks * TICKS_PER_DAY) / (B.YARD_LOAD_TICKS + 15);
    trucking = Math.min(carried, loaded);
  }
  return {
    demand: Math.round(demand),
    lifting: Math.round(lifting),
    moving: Math.round(moving),
    trucking: Math.round(trucking),
    berths: berthCount(w, B.FEEDER_DRAFT, true, true),
  };
}

/**
 * Crates per day the hauliers can take away, optionally with one more
 * haulier signed. Uses the road length found by capacity().
 */
export function truckingWith(w: World, extra: HaulierTerms | null): number {
  if (!Number.isFinite(w.roadLen)) return 0;
  const terms = hauliers(w)
    .map((c) => c.terms)
    .filter((t) => !t.cargo);
  if (extra && !extra.cargo) terms.push(extra);
  // Each dock loads one truck at a time, while the others are away on
  // their rounds; big trucks only fit large bays and storage. So the most
  // the trucks can carry, or the docks load, whichever is less.
  const docks = [...w.bays.values()].flatMap((b) =>
    w.loadingDocks(b).map(() => ({ large: b.large, load: loadTicks(b) })),
  );
  if (docks.length === 0) return 0;
  const large = docks.some((d) => d.large);
  const load = docks.reduce((n, d) => n + d.load, 0) / docks.length;
  let carried = 0;
  for (const t of terms) {
    if (t.capacity > B.TRUCK_CAPACITY && !large) continue;
    carried += t.fleet * truckRate(w, t.capacity, w.roadLen, load);
  }
  const loaded = docks.reduce((n, d) => n + dockRate(w, d.load), 0);
  return Math.round(Math.min(carried, loaded));
}

/** What one truck carries a day: in from the highway, loading, back out, then its round. */
export function truckRate(_w: World, capacity: number, road: number, load: number): number {
  const ticks = (2 * road) / B.TRUCK_SPEED + capacity * load + 30 + B.TRUCK_ROUND_TRIP;
  return (capacity * TICKS_PER_DAY) / ticks;
}

/** What one loading dock puts on trucks a day, kept busy, with time to pull in and out. */
export function dockRate(_w: World, load: number): number {
  return (B.TRUCK_CAPACITY * TICKS_PER_DAY) / (B.TRUCK_CAPACITY * load + 30);
}

export function dailyFees(w: World): number {
  return hauliers(w).reduce((sum, c) => sum + c.terms.dailyFee, 0);
}

export function wageBill(w: World): number {
  return w.people.reduce((n, p) => n + p.wage, 0);
}

export function answerRaise(w: World, id: number, accept: boolean): void {
  const p = w.people.find((q) => q.id === id);
  if (!p || p.raiseAsk === 0) return;
  if (accept) {
    p.wage = p.raiseAsk;
    changeMorale(w, p, B.RAISE_ACCEPT_MORALE);
    message(w, `${p.name} is delighted with the raise.`, 'good');
  } else {
    changeMorale(w, p, B.RAISE_REFUSE_MORALE);
    message(w, `${p.name} is not happy about being turned down.`, 'bad');
  }
  p.raiseAsk = 0;
}

/** Unanswered requests count as a no; then some staff ask for more. */
export function raiseRequests(w: World): void {
  for (const p of w.people) {
    if (p.raiseAsk > 0) answerRaise(w, p.id, false);
    else if (p.morale < B.RAISE_MORALE_BELOW && w.rng.next() < B.RAISE_CHANCE) {
      p.raiseAsk = p.wage + B.RAISE_STEP;
      message(
        w,
        `${p.name} asks for a raise to $${p.raiseAsk}/day. Answer in the Staff panel by tomorrow.`,
        'info',
      );
    }
  }
}

/** Staff whose morale stays rock bottom hand in their notice. */
export function checkMorale(w: World): void {
  for (const p of [...w.people]) {
    p.lowMoraleDays = p.morale < B.QUIT_MORALE ? p.lowMoraleDays + 1 : 0;
    if (p.lowMoraleDays === 1) {
      message(w, `${p.name} is miserable and thinking about quitting.`, 'bad');
    } else if (p.lowMoraleDays >= B.QUIT_DAYS) {
      cancelJob(w, p);
      w.people = w.people.filter((q) => q !== p);
      message(w, `${p.name} has quit. Morale was too low.`, 'bad');
    }
  }
}

export function newDay(w: World): void {
  // Containers in transit from a ship are stacked within the day.
  for (const [id, at] of w.unloadedAt) {
    if (w.tick - at > TICKS_PER_DAY * 3) w.unloadedAt.delete(id);
  }
  if (w.town) {
    openLandmark(w, landmarkDue(w.town, true, w.tier));
    townDay(w.town, jobs(w), w.map);
  }
  townGrownEnough(w);
  const late = w.demurrageToday;
  w.demurrageToday = { amount: 0, ships: 0 };
  if (late.amount >= B.DEMURRAGE_NOTICE) {
    nag(
      w,
      'demurrage',
      `Ships kept waiting cost $${late.amount.toLocaleString('en-US')} in demurrage today, from ${late.ships} ship${late.ships === 1 ? '' : 's'}.`,
      'bad',
    );
  }
  checkMorale(w);
  raiseRequests(w);
  refreshCandidates(w);
  const travel = w.jam.moving + w.jam.waiting;
  w.congestion = travel > 0 ? w.jam.waiting / travel : 0;
  w.jam = { moving: 0, waiting: 0 };
  w.capacityCache = null;
  book(w, 'wages', -wageBill(w));
  book(w, 'hauliers', -dailyFees(w));
  for (const c of w.cranes.values()) {
    const cost =
      c.kind === 'gantry'
        ? B.GANTRY_RUNNING_COST
        : c.kind === 'harbour'
          ? B.HARBOUR_CRANE_RUNNING_COST
          : B.CRANE_RUNNING_COST;
    book(w, 'maintenance', -cost);
  }
  book(w, 'maintenance', -B.TUG_RUNNING_COST * w.tugs.length);
  const yardGantries = w.map.build.filter((c) => c === Build.YardGantry).length;
  book(w, 'maintenance', -B.YARD_GANTRY_RUNNING_COST * yardGantries);
  for (const p of w.people) {
    if (isMachine(p) && w.rng.next() < B.FORKLIFT_BREAKDOWN) p.needsRepair = true;
  }
  book(w, 'interest', -interestDue(w));
  // The day done, kept for the finance charts: two months of them.
  w.history.push({ tick: w.tick, cash: w.cash, ledger: w.today });
  if (w.history.length > FINANCE_DAYS) w.history.shift();
  w.yesterday = w.today;
  w.today = emptyLedger();
  refreshOffers(w);
  adviseOnBays(w);
  w.capacityCache = null;

  if (w.cash >= 0) {
    if (w.daysInRed > 0) message(w, 'The port is back in the black.', 'good');
    w.daysInRed = 0;
    return;
  }
  w.daysInRed++;
  const left = B.BANKRUPT_DAYS - w.daysInRed;
  if (left <= 0) {
    w.bankrupt = true;
    w.speed = 0;
    message(w, 'The bank has closed the port. You are bankrupt.', 'bad');
  } else if (w.daysInRed === 1) {
    message(
      w,
      `The port is in the red! Get back above $0 within ${left} days or the bank will close it.`,
      'bad',
    );
  } else if (left <= 3) {
    message(w, `${left} day${left === 1 ? '' : 's'} until the bank closes the port.`, 'bad');
  }
}
