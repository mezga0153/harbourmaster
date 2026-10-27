import type {
  BayView,
  Capacity,
  Command,
  ContractView,
  EntityView,
  Ledger,
  LedgerCategory,
  SimEvent,
  Snapshot,
  StaffView,
  Stats,
  TileChange,
} from '../protocol';
import * as B from './balance';
import {
  fisheryDailyCrates,
  makeOffer,
  STARTER_FISHERY,
  STARTER_HAULIER,
  type Contract,
  type FisheryTerms,
  type HaulierTerms,
  type Offer,
  type Terms,
} from './contracts';
import { GameMap, type MapData } from './map';
import { generateMap } from './mapgen';
import { randomName } from './names';
import { makeCandidate, paceFactor, thought, traitDef, type Candidate, type Trait } from './staff';
import { findPath, type CostFn } from './path';
import { Rng } from './rng';
import { BUILDABLES, bulldozeError, bulldozeValue, placementCost, placementError } from './rules';
import { BUILD_TIER, MACHINE_TIER, TIERS } from './tiers';
import {
  Build,
  Deco,
  isDock,
  Terrain,
  TICKS_PER_DAY,
  type BuildKind,
  type MachineKind,
} from './types';

export const SAVE_VERSION = 7;
export const SPEEDS = [0, 1, 2, 4, 8];

interface Agent {
  id: number;
  x: number;
  y: number;
  dir: number;
  /** Tiles still to walk through, next first. */
  path: number[];
  goal: number;
}

type DockhandState =
  | 'idle'
  | 'wander'
  | 'toPickup'
  | 'picking'
  | 'toDrop'
  | 'dropping'
  | 'toBreak'
  | 'resting'
  | 'broken';

const WORKING: ReadonlySet<DockhandState> = new Set(['toPickup', 'picking', 'toDrop', 'dropping']);

/** A worker that moves crates: a dockhand on foot or a forklift. */
interface Dockhand extends Agent {
  kind: 'dockhand' | 'forklift';
  name: string;
  /** Crates per trip. */
  capacity: number;
  /** Forklifts: breaks down at the next idle moment. */
  needsRepair: boolean;
  skill: number;
  trait: Trait | null;
  wage: number;
  energy: number;
  morale: number;
  /** Break hut tile while heading to or resting in one, else -1. */
  hutIdx: number;
  lowMoraleDays: number;
  /** Wage asked for in a pending raise request, or 0. Answer by the next day. */
  raiseAsk: number;
  state: DockhandState;
  timer: number;
  carrying: number;
  /** What each carried crate pays when it leaves on a truck. */
  cargoFees: number[];
  /** Crates reserved at the source and the bay for the current trip. */
  planned: number;
  boatId: number;
  /** Crane landing stack being collected from, or -1. */
  craneIdx: number;
  bayIdx: number;
}

interface Crane {
  idx: number;
  /** Fees of the crates on the landing stack. */
  stack: number[];
  reserved: number;
  timer: number;
  angle: number;
  busy: boolean;
}

interface Boat extends Agent {
  /** Sails in to the anchorage, waits there if needed, then moors at a jetty. */
  state: 'approaching' | 'anchored' | 'arriving' | 'moored' | 'leaving';
  vessel: 'smack' | 'coaster';
  /** Water depth needed, in metres. */
  draft: number;
  contractId: number;
  company: string;
  fee: number;
  anchorTicks: number;
  mooredTicks: number;
  /** Unloading time the fishery considers fair for this load. */
  grace: number;
  crates: number;
  /** Crates promised to dockhands who are on their way. */
  reserved: number;
  berth: number;
  jetty: number;
  timer: number;
  variant: number;
}

interface Truck extends Agent {
  state: 'toBay' | 'loading' | 'leaving';
  contractId: number;
  company: string;
  capacity: number;
  bayIdx: number;
  cargo: number;
  /** Total fees of the crates on board, paid when the truck leaves. */
  value: number;
  idle: number;
  timer: number;
  variant: number;
}

interface Bay {
  idx: number;
  /** Fee of each crate waiting here. */
  crates: number[];
  /** Crates being carried here right now. */
  incoming: number;
  truckId: number;
  nextTruckTick: number;
  noAccess: boolean;
}

export interface SaveData {
  version: number;
  seed: number;
  tick: number;
  cash: number;
  speed: number;
  nextId: number;
  rng: number;
  stats: Stats;
  contracts: Contract[];
  offers: Offer[];
  candidates: Candidate[];
  cranes: Crane[];
  tier: number;
  loan: number;
  today: Ledger;
  yesterday: Ledger | null;
  daysInRed: number;
  bankrupt: boolean;
  map: MapData;
  people: Dockhand[];
  boats: Boat[];
  trucks: Truck[];
  bays: Bay[];
}

function emptyLedger(): Ledger {
  return {
    cargo: 0,
    construction: 0,
    hiring: 0,
    wages: 0,
    hauliers: 0,
    contracts: 0,
    penalties: 0,
    maintenance: 0,
    interest: 0,
  };
}

export function breachPenalty(c: { signingFee: number }): number {
  return Math.max(B.BREACH_MIN, c.signingFee * B.BREACH_MULTIPLIER);
}

function cancelFee(c: Contract): number {
  return Math.round(c.signingFee * B.CANCEL_FEE_SHARE);
}

const ACTIVITY: Record<DockhandState, string> = {
  idle: 'Waiting for work',
  wander: 'Stretching their legs',
  toPickup: 'Heading to the boat',
  picking: 'Lifting a crate',
  toDrop: 'Carrying a crate to the truck bay',
  dropping: 'Stacking a crate',
  toBreak: 'Off for a break',
  resting: 'On a break',
  broken: 'Broken down, waiting for the mechanic',
};

/** Authoritative game state. Runs inside the sim worker and in tests. */
export class World {
  tick = 0;
  cash = B.START_CASH;
  speed = 1;
  nextId = 1;
  contracts: Contract[] = [];
  offers: Offer[] = [];
  candidates: Candidate[] = [];
  cranes = new Map<number, Crane>();
  /** Index into TIERS. */
  tier = 0;
  loan = 0;
  today: Ledger = emptyLedger();
  yesterday: Ledger | null = null;
  /** Consecutive days that ended with negative cash. */
  daysInRed = 0;
  bankrupt = false;
  stats: Stats = { cratesHandled: 0, boats: 0, trucks: 0, earned: 0, penalties: 0 };
  people: Dockhand[] = [];
  boats: Boat[] = [];
  trucks: Truck[] = [];
  bays = new Map<number, Bay>();

  private anchorageTile = -1;
  /** Ticks today with a full truck bay, for the advisor. Not saved. */
  private bayFullTicks = 0;
  /** Cached planning estimate; cleared when the port changes. Not saved. */
  private capacityCache: Capacity | null = null;
  /** Shortest road from the highway to a truck bay; set by capacity(). */
  private roadLen = Infinity;
  private events: SimEvent[] = [];
  private dirty = new Set<number>();

  private constructor(
    readonly seed: number,
    readonly map: GameMap,
    readonly rng: Rng,
  ) {}

  static create(seed: number): World {
    const { map, spawn } = generateMap(seed);
    const world = new World(seed, map, new Rng(seed));
    for (let i = 0; i < map.build.length; i++) {
      if (map.build[i] === Build.TruckBay) world.addBay(i);
    }
    for (let k = 0; k < B.START_DOCKHANDS; k++) {
      world.spawnDockhand(spawn, {
        id: 0,
        name: randomName(world.rng),
        skill: 2,
        trait: null,
        wage: B.WAGE_DOCKHAND,
      });
    }
    world.refreshCandidates();
    world.addContract(STARTER_FISHERY, 50, B.STARTER_SIGNING_FEE);
    world.addContract(STARTER_HAULIER, 0, 0);
    world.addOffer('fishery');
    world.addOffer('fishery');
    world.addOffer('haulier');
    world.events = [];
    world.message('Welcome to your new port! Boats will bring crates to the jetty.', 'info');
    return world;
  }

  /** A save is only usable if it has every field this version writes. */
  static isValidSave(s: unknown): s is SaveData {
    const d = s as SaveData;
    return (
      !!d &&
      d.version === SAVE_VERSION &&
      Number.isFinite(d.cash) &&
      Array.isArray(d.contracts) &&
      d.boats.every((b) => Number.isFinite(b.grace) && Number.isFinite(b.fee)) &&
      d.trucks.every((t) => Number.isFinite(t.value) && Number.isFinite(t.capacity)) &&
      Array.isArray(d.candidates) &&
      Number.isFinite(d.loan) &&
      Number.isFinite(d.tier) &&
      Array.isArray(d.cranes) &&
      d.boats.every((b) => Number.isFinite(b.draft)) &&
      !!d.today &&
      d.people.every(
        (p) =>
          Array.isArray(p.cargoFees) &&
          Number.isFinite(p.energy) &&
          Number.isFinite(p.wage) &&
          Number.isFinite(p.raiseAsk),
      ) &&
      d.bays.every((b) => Array.isArray(b.crates)) &&
      d.contracts.every((c) => Number.isFinite(c.signingFee))
    );
  }

  static fromSave(s: SaveData): World {
    const world = new World(s.seed, GameMap.fromData(s.map), new Rng(s.rng));
    world.tick = s.tick;
    world.cash = s.cash;
    world.speed = s.speed;
    world.nextId = s.nextId;
    world.stats = { ...s.stats };
    world.contracts = s.contracts.map((c) => ({ ...c, terms: { ...c.terms } }));
    world.offers = s.offers.map((o) => ({ ...o, terms: { ...o.terms } }));
    world.candidates = s.candidates.map((c) => ({ ...c }));
    world.loan = s.loan;
    world.tier = s.tier;
    for (const c of s.cranes) world.cranes.set(c.idx, { ...c, stack: [...c.stack] });
    world.today = { ...s.today };
    world.yesterday = s.yesterday ? { ...s.yesterday } : null;
    world.daysInRed = s.daysInRed;
    world.bankrupt = s.bankrupt;
    world.people = s.people.map((p) => ({ ...p, path: [...p.path], cargoFees: [...p.cargoFees] }));
    world.boats = s.boats.map((b) => ({ ...b, path: [...b.path] }));
    world.trucks = s.trucks.map((t) => ({ ...t, path: [...t.path] }));
    for (const bay of s.bays) world.bays.set(bay.idx, { ...bay, crates: [...bay.crates] });
    return world;
  }

  toSave(): SaveData {
    return structuredClone({
      version: SAVE_VERSION,
      seed: this.seed,
      tick: this.tick,
      cash: this.cash,
      speed: this.speed,
      nextId: this.nextId,
      rng: this.rng.state,
      stats: this.stats,
      contracts: this.contracts,
      offers: this.offers,
      candidates: this.candidates,
      cranes: [...this.cranes.values()],
      tier: this.tier,
      loan: this.loan,
      today: this.today,
      yesterday: this.yesterday,
      daysInRed: this.daysInRed,
      bankrupt: this.bankrupt,
      map: this.map.toData(),
      people: this.people,
      boats: this.boats,
      trucks: this.trucks,
      bays: [...this.bays.values()],
    });
  }

  // ── Commands ──────────────────────────────────────────────

  command(cmd: Command): void {
    if (this.bankrupt) return;
    this.capacityCache = null;
    switch (cmd.type) {
      case 'build':
        return this.build(cmd.kind, cmd.tiles);
      case 'bulldoze':
        return this.bulldoze(cmd.tiles);
      case 'hire':
        return this.hire(cmd.candidateId);
      case 'fire':
        return this.fire(cmd.id);
      case 'loan':
        return this.takeLoan(cmd.amount);
      case 'upgrade':
        return this.upgrade();
      case 'buyMachine':
        return this.buyMachine(cmd.kind);
      case 'raise':
        return this.answerRaise(cmd.id, cmd.accept);
      case 'signContract':
        return this.signContract(cmd.id);
      case 'cancelContract':
        return this.cancelContract(cmd.id);
      case 'setSpeed':
        if (SPEEDS.includes(cmd.speed)) this.speed = cmd.speed;
        return;
      case 'newGame':
      case 'save':
      case 'debug':
        return; // handled by the worker
    }
  }

  private build(kind: BuildKind, tiles: number[]): void {
    const def = BUILDABLES[kind];
    if (BUILD_TIER[kind] > this.tier) {
      return this.message(`${def.label} unlocks at the ${TIERS[BUILD_TIER[kind]].name}.`, 'bad');
    }
    let spent = 0;
    let firstError: string | null = null;
    for (const i of tiles) {
      if (i < 0 || i >= this.map.build.length) continue;
      const err = placementError(this.map, kind, i) ?? this.boatInTheWay(kind, i);
      if (err) {
        firstError ??= err;
        continue;
      }
      const cost = placementCost(this.map, kind, i);
      if (cost > this.cash) {
        firstError ??= 'Not enough money';
        break;
      }
      this.book('construction', -cost);
      spent += cost;
      this.map.build[i] = def.code;
      this.map.deco[i] = Deco.None;
      this.dirty.add(i);
      if (kind === 'truckBay') this.addBay(i);
      if (kind === 'jibCrane') this.addCrane(i);
    }
    if (spent > 0) this.moneyAt(-spent, tiles[tiles.length - 1]);
    else if (firstError) this.message(firstError, 'bad');
  }

  private boatInTheWay(kind: BuildKind, i: number): string | null {
    if (kind !== 'jetty') return null;
    const blocked = this.boats.some((b) => b.berth === i || this.tileOf(b) === i);
    return blocked ? 'A boat is in the way' : null;
  }

  private bulldoze(tiles: number[]): void {
    let net = 0;
    let lastError: string | null = null;
    for (const i of tiles) {
      if (i < 0 || i >= this.map.build.length) continue;
      let err = bulldozeError(this.map, i);
      if (!err && isDock(this.map.build[i]) && this.boats.some((b) => b.jetty === i)) {
        err = 'A boat is moored here';
      }
      if (err) {
        lastError = err;
        continue;
      }
      const value = bulldozeValue(this.map, i);
      if (value < 0 && this.cash < -value) {
        lastError = 'Not enough money';
        break;
      }
      this.book('construction', value);
      net += value;
      if (this.map.build[i] === Build.JibCrane) {
        // Taking down a crane leaves the quay it stood on.
        this.cranes.delete(i);
        this.map.build[i] = Build.Quay;
      } else if (this.map.build[i] !== Build.None) {
        if (this.map.build[i] === Build.TruckBay) this.removeBay(i);
        this.map.build[i] = Build.None;
      } else if (this.map.deco[i] !== Deco.None) {
        this.map.deco[i] = Deco.None;
      } else {
        this.map.terrain[i] = Terrain.Grass;
      }
      this.dirty.add(i);
    }
    if (net !== 0) this.moneyAt(net, tiles[tiles.length - 1]);
    else if (lastError && tiles.length === 1) this.message(lastError, 'bad');
  }

  /** Testing shortcuts. The worker only forwards these on the dev server. */
  debug(cmd: Extract<Command, { type: 'debug' }>): void {
    if (cmd.cash) this.cash += cmd.cash;
    if (cmd.tier !== undefined) this.tier = cmd.tier;
    if (cmd.coaster) {
      const taken = new Set([...this.contracts, ...this.offers].map((c) => c.terms.name));
      for (let k = 0; k < 20; k++) {
        const o = makeOffer(this.rng, this.nextId++, this.tick, 'fishery', taken, 1);
        if (o && o.terms.kind === 'fishery' && o.terms.vessel === 'coaster') {
          this.addContract(o.terms, this.tick + 30, o.signingFee);
          return;
        }
      }
    }
  }

  /** Every change to cash goes through here, so the ledger adds up. */
  private book(category: LedgerCategory, amount: number): void {
    this.cash += amount;
    this.today[category] += amount;
  }

  private interestDue(): number {
    return Math.round(this.loan * B.LOAN_DAILY_RATE);
  }

  /** Positive amounts borrow, negative amounts repay. */
  private takeLoan(amount: number): void {
    if (amount > 0) {
      const room = B.LOAN_MAX - this.loan;
      const borrow = Math.min(amount, room);
      if (borrow <= 0) return this.message('The bank will not lend you any more.', 'bad');
      this.loan += borrow;
      this.cash += borrow;
      this.message(`Borrowed $${borrow.toLocaleString('en-US')} from the bank.`, 'info');
    } else {
      const repay = Math.min(-amount, this.loan);
      if (repay <= 0) return;
      if (this.cash < repay) return this.message('Not enough cash to repay that much.', 'bad');
      this.loan -= repay;
      this.cash -= repay;
      this.message(`Repaid $${repay.toLocaleString('en-US')} of the loan.`, 'good');
    }
  }

  private tierProgress(): { crates: number; contracts: number } {
    return { crates: this.stats.cratesHandled, contracts: this.fisheries().length };
  }

  canUpgrade(): boolean {
    const next = TIERS[this.tier + 1];
    if (!next || next.comingSoon) return false;
    const p = this.tierProgress();
    return p.crates >= next.crates && p.contracts >= next.contracts && this.cash >= next.cost;
  }

  private upgrade(): void {
    const next = TIERS[this.tier + 1];
    if (!next || next.comingSoon) return this.message('No further upgrades yet.', 'info');
    if (!this.canUpgrade())
      return this.message('The port does not meet the requirements yet.', 'bad');
    this.book('construction', -next.cost);
    this.tier++;
    this.capacityCache = null;
    this.message(
      `The port is now a ${next.name}! New buildings and machines are unlocked.`,
      'good',
    );
    this.addOffer('fishery');
  }

  private hire(candidateId: number): void {
    const c = this.candidates.find((x) => x.id === candidateId);
    if (!c) return this.message('That candidate has taken another job.', 'bad');
    if (this.cash < B.HIRE_FEE) return this.message('Not enough money to hire', 'bad');
    this.book('hiring', -B.HIRE_FEE);
    this.candidates = this.candidates.filter((x) => x !== c);
    const p = this.spawnDockhand(this.map.entry, c);
    this.message(`${p.name} has been hired and is on their way.`, 'good');
  }

  /** Replace one candidate each day and top the list up. */
  private refreshCandidates(): void {
    if (this.candidates.length >= B.CANDIDATES) this.candidates.shift();
    while (this.candidates.length < B.CANDIDATES) {
      this.candidates.push(makeCandidate(this.rng, this.nextId++));
    }
  }

  private fire(id: number): void {
    const p = this.people.find((q) => q.id === id);
    if (!p) return;
    if (p.kind === 'forklift') {
      const refund = Math.round(B.FORKLIFT_PRICE * B.SELL_SHARE);
      this.cancelJob(p);
      this.people = this.people.filter((q) => q !== p);
      this.book('construction', refund);
      this.message(`Sold ${p.name} for $${refund}.`, 'info');
      return;
    }
    if (p.carrying) this.message(`${p.name} dropped their crate on the way out.`, 'bad');
    this.cancelJob(p);
    this.people = this.people.filter((q) => q !== p);
    this.message(`${p.name} has left the port.`, 'info');
  }

  // ── Contracts ─────────────────────────────────────────────

  private addContract(terms: Terms, firstBoatTick: number, signingFee: number): Contract {
    const c: Contract = {
      id: this.nextId++,
      terms,
      signingFee,
      satisfaction: B.START_SATISFACTION,
      nextBoatTick: firstBoatTick,
      warned: false,
    };
    this.contracts.push(c);
    return c;
  }

  private addOffer(kind: Terms['kind']): void {
    const taken = new Set([...this.contracts, ...this.offers].map((c) => c.terms.name));
    const offer = makeOffer(this.rng, this.nextId++, this.tick, kind, taken, this.tier);
    if (offer) this.offers.push(offer);
  }

  private refreshOffers(): void {
    const expired = this.offers.filter((o) => o.expires <= this.tick);
    this.offers = this.offers.filter((o) => o.expires > this.tick);
    if (expired.length > 0 && this.offers.length === 0) {
      this.message('Some contract offers have expired.', 'info');
    }
    if (this.offers.length < B.MAX_OFFERS && this.rng.next() < 0.7) {
      // Keep at least one offer of each kind on the board.
      const has = (k: Terms['kind']) => this.offers.some((o) => o.terms.kind === k);
      const kind = !has('haulier')
        ? 'haulier'
        : !has('fishery')
          ? 'fishery'
          : this.rng.next() < 0.6
            ? 'fishery'
            : 'haulier';
      const before = this.offers.length;
      this.addOffer(kind);
      if (this.offers.length > before) {
        this.message(`New contract offer from ${this.offers.at(-1)!.terms.name}.`, 'info');
      }
    }
  }

  private signContract(offerId: number): void {
    const offer = this.offers.find((o) => o.id === offerId);
    if (!offer) return this.message('That offer is no longer available.', 'bad');
    if (this.cash < offer.signingFee) return this.message('Not enough money to sign', 'bad');
    this.book('contracts', -offer.signingFee);
    this.offers = this.offers.filter((o) => o !== offer);
    // A new fishery sends its first boat soon after signing.
    this.addContract(offer.terms, this.tick + this.rng.int(60, 240), offer.signingFee);
    this.message(`Signed with ${offer.terms.name}.`, 'good');
  }

  private cancelContract(id: number): void {
    const c = this.contracts.find((x) => x.id === id);
    if (!c) return;
    const fee = cancelFee(c);
    this.book('contracts', -fee);
    this.stats.penalties += fee;
    this.contracts = this.contracts.filter((x) => x !== c);
    this.message(
      fee > 0
        ? `Contract with ${c.terms.name} ended. Buyout: $${fee}.`
        : `Contract with ${c.terms.name} ended.`,
      'info',
    );
    if (!this.contracts.some((x) => x.terms.kind === 'haulier')) {
      this.message('No haulier is under contract. No trucks will come for crates!', 'bad');
    }
  }

  private fisheries(): (Contract & { terms: FisheryTerms })[] {
    return this.contracts.filter((c) => c.terms.kind === 'fishery') as (Contract & {
      terms: FisheryTerms;
    })[];
  }

  private hauliers(): (Contract & { terms: HaulierTerms })[] {
    return this.contracts.filter((c) => c.terms.kind === 'haulier') as (Contract & {
      terms: HaulierTerms;
    })[];
  }

  /**
   * Settle a fishery boat's visit as it leaves. Waiting costs demurrage and
   * goodwill; a fishery with no goodwill left walks out and claims a penalty.
   */
  private penalty(amount: number, at: number): void {
    if (amount <= 0) return;
    this.book('penalties', -amount);
    this.stats.penalties += amount;
    this.moneyAt(-amount, at);
  }

  private judgeVisit(b: Boat, gaveUp: boolean): void {
    const slowTicks = Math.max(0, b.mooredTicks - b.grace);
    const demurrage = Math.round(
      ((b.anchorTicks + slowTicks) / TICKS_PER_DAY) * B.DEMURRAGE_PER_DAY,
    );
    if (demurrage > 0) {
      this.penalty(demurrage, this.tileOf(b));
      if (demurrage >= 30) {
        this.message(`${b.company} charged $${demurrage} demurrage for waiting.`, 'bad');
      }
    }
    if (gaveUp && b.crates > 0) {
      const claim = Math.round(b.crates * b.fee * B.LOST_CARGO_SHARE);
      this.penalty(claim, this.tileOf(b));
      this.message(
        `A ${b.company} boat gave up and left with ${b.crates} crates. They claim $${claim}.`,
        'bad',
      );
    }

    const c = this.contracts.find((x) => x.id === b.contractId);
    if (!c) return;
    const anchored = b.anchorTicks / B.ANCHOR_PENALTY_TICKS;
    const slow = slowTicks / B.MOORED_PENALTY_TICKS;
    const delta = B.SATISFACTION_PER_BOAT - anchored - slow - (gaveUp ? B.GAVE_UP_PENALTY : 0);
    c.satisfaction = Math.max(0, Math.min(100, c.satisfaction + delta));
    if (c.satisfaction === 0) {
      this.contracts = this.contracts.filter((x) => x !== c);
      const breach = breachPenalty(c);
      this.penalty(breach, this.tileOf(b));
      this.message(
        `${c.terms.name} has walked out and claims $${breach} for breach of contract.`,
        'bad',
      );
    } else if (c.satisfaction < 25 && !c.warned) {
      c.warned = true;
      this.message(`${c.terms.name} is unhappy. Their boats are waiting too long.`, 'bad');
    } else if (c.satisfaction >= 40) {
      c.warned = false;
    }
  }

  private adviseOnBays(): void {
    const fullForLong = this.bayFullTicks > TICKS_PER_DAY / 3;
    this.bayFullTicks = 0;
    if (!fullForLong) return;
    const trucks = this.hauliers().reduce((n, c) => n + c.terms.fleet, 0);
    this.message(
      trucks < this.bays.size
        ? 'Crates are piling up in the truck bays. Sign another haulier for more trucks.'
        : 'Truck bays keep filling up. Each bay loads one truck at a time, so build another truck bay.',
      'info',
    );
  }

  /**
   * Rough crates-per-day estimates for planning, from walking and driving
   * distances. Shown in the Contracts panel.
   */
  capacity(): Capacity {
    if (this.capacityCache) return this.capacityCache;
    const m = this.map;
    const demand = this.fisheries().reduce((n, c) => n + fisheryDailyCrates(c.terms), 0);

    // One trip: dock to the nearest bay and back, plus handling.
    const jetties: number[] = [];
    for (let i = 0; i < m.build.length; i++) if (isDock(m.build[i])) jetties.push(i);
    const bays = [...this.bays.keys()];
    let walk = 0;
    for (const j of jetties) {
      const d = Math.min(...bays.map((b) => this.dist(j, b)));
      walk += Number.isFinite(d) ? d : 0;
    }
    const avgWalk = jetties.length && bays.length ? walk / jetties.length : 0;
    let hasHut = false;
    for (let i = 0; i < m.build.length && !hasHut; i++) hasHut = m.build[i] === Build.BreakHut;
    // Share of the day spent working rather than resting.
    const uptime = hasHut ? 0.88 : 0.72;
    let unloading = 0;
    if (bays.length && jetties.length) {
      for (const p of this.people) {
        if (p.kind === 'forklift') {
          // Forklifts carry several crates, need no breaks but do break down.
          // They cannot drive onto wooden jetties, so they need a quay.
          if (!jetties.some((j) => m.build[j] !== Build.Jetty)) continue;
          const ticks =
            (2 * avgWalk * 1.2) / B.FORKLIFT_SPEED + (B.PICK_TICKS + B.DROP_TICKS) * 1.5;
          unloading += ((TICKS_PER_DAY * 0.9) / ticks) * p.capacity;
          continue;
        }
        const handling = (B.PICK_TICKS + B.DROP_TICKS) * traitDef(p.trait).handling;
        const pace = paceFactor(p.skill, p.morale, 100);
        const tripTicks = (2 * avgWalk * 1.2) / (B.WALK_SPEED * pace) + handling;
        unloading += (TICKS_PER_DAY * uptime) / tripTicks;
      }
    }

    // One truck trip: highway to bay and back, plus loading. A bay loads one
    // truck at a time, so trucks beyond the number of bays add nothing.
    this.roadLen = bays.length
      ? Math.min(
          ...bays.map(
            (b) => findPath(m.w, m.h, m.entry, b, this.truckCost(b), false)?.length ?? Infinity,
          ),
        )
      : Infinity;
    this.capacityCache = {
      demand: Math.round(demand),
      unloading: Math.round(unloading),
      trucking: this.truckingWith(null),
      deepBerths: this.berthCount(B.COASTER_DRAFT),
    };
    return this.capacityCache;
  }

  /**
   * Crates per day the hauliers can take away, optionally with one more
   * haulier signed. Uses the road length found by capacity().
   */
  private truckingWith(extra: HaulierTerms | null): number {
    if (!Number.isFinite(this.roadLen)) return 0;
    const terms = this.hauliers().map((c) => c.terms);
    if (extra) terms.push(extra);
    // A bay loads one truck at a time, so trucks beyond the bays add nothing.
    const fleets = terms
      .flatMap((t) => Array.from({ length: t.fleet }, () => t.capacity))
      .sort((a, b) => b - a)
      .slice(0, this.bays.size);
    let total = 0;
    for (const cap of fleets) {
      const ticks = (2 * this.roadLen) / B.TRUCK_SPEED + cap * 5 + 30;
      total += (cap * TICKS_PER_DAY) / ticks;
    }
    return Math.round(total);
  }

  private dailyFees(): number {
    return this.hauliers().reduce((sum, c) => sum + c.terms.dailyFee, 0);
  }

  // ── Tick ──────────────────────────────────────────────────

  step(): void {
    if (this.bankrupt) return;
    if (!Number.isFinite(this.cash)) {
      // Never let a bad value spread through the economy; fail loudly instead.
      throw new Error(`Cash became ${this.cash} at tick ${this.tick}`);
    }
    this.tick++;
    if (this.tick % TICKS_PER_DAY === 0) this.newDay();
    this.spawnBoats();
    for (const b of [...this.boats]) this.updateBoat(b);
    for (const c of this.cranes.values()) this.updateCrane(c);
    for (const p of this.people) this.updateDockhand(p);
    if (this.tick % 10 === 0) this.spawnTrucks();
    for (const t of [...this.trucks]) this.updateTruck(t);
  }

  private wageBill(): number {
    return this.people.reduce((n, p) => n + p.wage, 0);
  }

  private answerRaise(id: number, accept: boolean): void {
    const p = this.people.find((q) => q.id === id);
    if (!p || p.raiseAsk === 0) return;
    if (accept) {
      p.wage = p.raiseAsk;
      this.changeMorale(p, B.RAISE_ACCEPT_MORALE);
      this.message(`${p.name} is delighted with the raise.`, 'good');
    } else {
      this.changeMorale(p, B.RAISE_REFUSE_MORALE);
      this.message(`${p.name} is not happy about being turned down.`, 'bad');
    }
    p.raiseAsk = 0;
  }

  /** Unanswered requests count as a no; then some staff ask for more. */
  private raiseRequests(): void {
    for (const p of this.people) {
      if (p.raiseAsk > 0) this.answerRaise(p.id, false);
      else if (p.morale < B.RAISE_MORALE_BELOW && this.rng.next() < B.RAISE_CHANCE) {
        p.raiseAsk = p.wage + B.RAISE_STEP;
        this.message(
          `${p.name} asks for a raise to $${p.raiseAsk}/day. Answer in the Staff panel by tomorrow.`,
          'info',
        );
      }
    }
  }

  /** Staff whose morale stays rock bottom hand in their notice. */
  private checkMorale(): void {
    for (const p of [...this.people]) {
      p.lowMoraleDays = p.morale < B.QUIT_MORALE ? p.lowMoraleDays + 1 : 0;
      if (p.lowMoraleDays === 1) {
        this.message(`${p.name} is miserable and thinking about quitting.`, 'bad');
      } else if (p.lowMoraleDays >= B.QUIT_DAYS) {
        this.cancelJob(p);
        this.people = this.people.filter((q) => q !== p);
        this.message(`${p.name} has quit. Morale was too low.`, 'bad');
      }
    }
  }

  private newDay(): void {
    this.checkMorale();
    this.raiseRequests();
    this.refreshCandidates();
    this.book('wages', -this.wageBill());
    this.book('hauliers', -this.dailyFees());
    this.book('maintenance', -this.cranes.size * B.CRANE_RUNNING_COST);
    for (const p of this.people) {
      if (p.kind === 'forklift' && this.rng.next() < B.FORKLIFT_BREAKDOWN) p.needsRepair = true;
    }
    this.book('interest', -this.interestDue());
    this.yesterday = this.today;
    this.today = emptyLedger();
    this.refreshOffers();
    this.adviseOnBays();
    this.capacityCache = null;

    if (this.cash >= 0) {
      if (this.daysInRed > 0) this.message('The port is back in the black.', 'good');
      this.daysInRed = 0;
      return;
    }
    this.daysInRed++;
    const left = B.BANKRUPT_DAYS - this.daysInRed;
    if (left <= 0) {
      this.bankrupt = true;
      this.speed = 0;
      this.message('The bank has closed the port. You are bankrupt.', 'bad');
    } else if (this.daysInRed === 1) {
      this.message(
        `The port is in the red! Get back above $0 within ${left} days or the bank will close it.`,
        'bad',
      );
    } else if (left <= 3) {
      this.message(`${left} day${left === 1 ? '' : 's'} until the bank closes the port.`, 'bad');
    }
  }

  // ── Boats ─────────────────────────────────────────────────

  private spawnBoats(): void {
    for (const c of this.fisheries()) {
      if (this.tick < c.nextBoatTick) continue;
      const days = c.terms.boatEvery * this.rng.range(0.7, 1.3);
      c.nextBoatTick = this.tick + Math.round(TICKS_PER_DAY * days);
      if (this.boats.length < B.MAX_BOATS) {
        this.spawnBoat(c.id, c.terms);
      } else {
        // The harbour is jammed; the fishery notices.
        c.satisfaction = Math.max(0, c.satisfaction - B.NO_ROOM_PENALTY);
      }
    }
  }

  private spawnBoat(contractId: number, terms: FisheryTerms): void {
    const edge = this.seaEdgeTiles();
    if (edge.length === 0) return;
    const start = this.rng.pick(edge);
    const boat: Boat = {
      id: this.nextId++,
      contractId,
      company: terms.name,
      vessel: terms.vessel,
      draft: terms.vessel === 'coaster' ? B.COASTER_DRAFT : B.BOAT_DRAFT,
      fee: terms.fee,
      anchorTicks: 0,
      mooredTicks: 0,
      grace: 0,
      x: this.map.xOf(start) + 0.5,
      y: this.map.yOf(start) + 0.5,
      dir: Math.PI,
      path: [],
      goal: start,
      state: 'approaching',
      crates: this.rng.int(terms.cratesMin, terms.cratesMax),
      reserved: 0,
      berth: -1,
      jetty: -1,
      timer: 0,
      variant: terms.color,
    };
    boat.grace = B.MOORED_GRACE_TICKS + boat.crates * B.MOORED_TICKS_PER_CRATE;
    this.boats.push(boat);
    this.stats.boats++;
    // Head for a spot at the anchorage; the berth is decided on arrival.
    const spot = this.anchorSpot(boat);
    const path = findPath(this.map.w, this.map.h, start, spot, this.boatCostFor(boat.draft), true);
    if (path) {
      boat.path = path;
      boat.goal = spot;
    } else {
      boat.state = 'anchored';
    }
  }

  /**
   * Open water a little offshore from the first jetty, where boats wait for a
   * berth. Derived from the map, so it is not saved.
   */
  private anchorage(): number {
    if (this.anchorageTile >= 0) return this.anchorageTile;
    const m = this.map;
    const row = m.yOf(m.entry);
    let x = 0;
    while (x < m.w - 1 && this.boatCost(m.idx(x, row)) !== 1) x++;
    // Out past the shallows, but well short of the map edge.
    let depthSteps = 0;
    while (x < m.w - 6 && (m.depth[m.idx(x, row)] < 4 || depthSteps < 6)) {
      x++;
      depthSteps++;
    }
    this.anchorageTile = m.idx(Math.min(x, m.w - 6), row);
    return this.anchorageTile;
  }

  /** A free tile near the anchorage, clear of other waiting boats. */
  private anchorSpot(boat: Boat): number {
    const m = this.map;
    const centre = this.anchorage();
    const cx = m.xOf(centre);
    const cy = m.yOf(centre);
    const taken = this.boats
      .filter((b) => b !== boat && (b.state === 'approaching' || b.state === 'anchored'))
      .map((b) => b.goal);
    for (let r = 0; r < 12; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx;
          const y = cy + dy * 2; // spread along the coast rather than out to sea
          if (!m.inBounds(x, y)) continue;
          const i = m.idx(x, y);
          if (this.boatCost(i) !== 1) continue;
          const clear = taken.every(
            (t) => Math.max(Math.abs(m.xOf(t) - x), Math.abs(m.yOf(t) - y)) > 2,
          );
          if (clear) return i;
        }
      }
    }
    return centre;
  }

  /** Anchored boats get berths in the order they arrived. */
  private nextInQueue(): Boat | undefined {
    let first: Boat | undefined;
    for (const b of this.boats) {
      if (b.state === 'anchored' && (!first || b.anchorTicks > first.anchorTicks)) first = b;
    }
    return first;
  }

  private seaEdgeTiles(): number[] {
    const out: number[] = [];
    const x = this.map.w - 1;
    for (let y = 1; y < this.map.h - 1; y++) {
      const i = this.map.idx(x, y);
      if (this.boatCost(i) === 1) out.push(i);
    }
    return out;
  }

  private boatCosts = new Map<number, CostFn>();

  /** Open sea at least `draft` metres deep. */
  private boatCostFor(draft: number): CostFn {
    let fn = this.boatCosts.get(draft);
    if (!fn) {
      fn = (i) =>
        this.map.ocean[i] && this.map.build[i] === Build.None && this.map.depth[i] >= draft
          ? 1
          : Infinity;
      this.boatCosts.set(draft, fn);
    }
    return fn;
  }

  private boatCost: CostFn = (i) => this.boatCostFor(B.BOAT_DRAFT)(i);

  /**
   * Tiles a moored boat covers: its berth plus one tile either way along the
   * jetty, since boats are about two tiles long. Null if it would hit land.
   */
  private footprint(berth: number, jetty: number): number[] | null {
    const m = this.map;
    const x = m.xOf(berth);
    const y = m.yOf(berth);
    const alongX = m.yOf(jetty) !== y;
    const ends = alongX
      ? [
          [x - 1, y],
          [x + 1, y],
        ]
      : [
          [x, y - 1],
          [x, y + 1],
        ];
    const out = [berth];
    for (const [ex, ey] of ends) {
      if (!m.inBounds(ex, ey)) return null;
      const i = m.idx(ex, ey);
      if (m.isLand(i) || m.build[i] !== Build.None) return null;
      out.push(i);
    }
    return out;
  }

  /** Two moored boats clash if they share water, unless they lie end to end in one lane. */
  private berthsClash(a: number[], b: number[]): boolean {
    const m = this.map;
    const sameLane =
      (m.yOf(a[1]) === m.yOf(a[2]) && m.yOf(b[1]) === m.yOf(b[2]) && m.yOf(a[0]) === m.yOf(b[0])) ||
      (m.xOf(a[1]) === m.xOf(a[2]) && m.xOf(b[1]) === m.xOf(b[2]) && m.xOf(a[0]) === m.xOf(b[0]));
    if (sameLane) return b.includes(a[0]) || a.includes(b[0]);
    return a.some((t) => b.includes(t));
  }

  /** How many boats of this draft could moor at once, ignoring current traffic. */
  private berthCount(draft: number): number {
    const m = this.map;
    const water = this.boatCostFor(draft);
    const chosen: number[][] = [];
    for (let j = 0; j < m.build.length; j++) {
      if (!isDock(m.build[j])) continue;
      for (const n of m.neighbors4(j)) {
        if (water(n) !== 1) continue;
        const fp = this.footprint(n, j);
        if (fp && !chosen.some((c) => this.berthsClash(fp, c))) chosen.push(fp);
      }
    }
    return chosen.length;
  }

  /** Water tiles beside a jetty where a boat can moor, nearest first. */
  private freeBerths(from: number, draft: number): { berth: number; jetty: number }[] {
    const water = this.boatCostFor(draft);
    const m = this.map;
    const taken = this.boats
      .filter((b) => b.berth >= 0)
      .map((b) => this.footprint(b.berth, b.jetty) ?? [b.berth]);
    const out: { berth: number; jetty: number; d: number }[] = [];
    for (let j = 0; j < m.build.length; j++) {
      if (!isDock(m.build[j])) continue;
      for (const n of m.neighbors4(j)) {
        if (water(n) !== 1) continue;
        const fp = this.footprint(n, j);
        if (!fp || taken.some((t) => this.berthsClash(fp, t))) continue;
        // The harbour master sends boats to the best-equipped free berth:
        // under a crane first, then a quay forklifts can reach.
        const nx = m.xOf(n);
        const ny = m.yOf(n);
        const craned = [...this.cranes.keys()].some(
          (c) => Math.max(Math.abs(m.xOf(c) - nx), Math.abs(m.yOf(c) - ny)) <= 1,
        );
        const bonus = craned ? 200 : m.build[j] === Build.Jetty ? 0 : 100;
        const d = Math.abs(nx - m.xOf(from)) + Math.abs(ny - m.yOf(from)) - bonus;
        out.push({ berth: n, jetty: j, d });
      }
    }
    return out.sort((a, b) => a.d - b.d || a.berth - b.berth);
  }

  private tryBerth(boat: Boat): boolean {
    const from = this.tileOf(boat);
    for (const c of this.freeBerths(from, boat.draft).slice(0, 6)) {
      const path = findPath(
        this.map.w,
        this.map.h,
        from,
        c.berth,
        this.boatCostFor(boat.draft),
        true,
      );
      if (!path) continue;
      boat.berth = c.berth;
      boat.jetty = c.jetty;
      boat.path = path;
      boat.goal = c.berth;
      boat.state = 'arriving';
      return true;
    }
    boat.state = 'anchored';
    return false;
  }

  private updateBoat(b: Boat): void {
    if (b.state === 'anchored' || b.state === 'moored') {
      if (b.anchorTicks + b.mooredTicks > B.BOAT_GIVE_UP_TICKS && b.crates > 0) {
        // The claim message in judgeVisit explains what happened.
        return this.depart(b, true);
      }
    }
    switch (b.state) {
      case 'approaching':
        if (this.move(b, this.boatCostFor(b.draft), true, () => B.BOAT_SPEED) !== 'moving') {
          b.state = 'anchored';
          b.dir = Math.PI; // swing to face the shore like the others
          const queue = this.boats.filter((q) => q.state === 'anchored').length;
          if (!this.tryBerth(b) && queue === 1) {
            this.message('Boats are queueing at the anchorage. Every berth is taken.', 'info');
          }
        }
        return;
      case 'anchored':
        b.anchorTicks++;
        if (this.tick % 10 === 0 && this.nextInQueue() === b) this.tryBerth(b);
        return;
      case 'arriving': {
        const r = this.move(b, this.boatCostFor(b.draft), true, () => B.BOAT_SPEED);
        if (r === 'blocked') {
          b.berth = b.jetty = -1;
          b.state = 'anchored';
        } else if (r === 'arrived') {
          b.state = 'moored';
          // Lie alongside the jetty.
          const alongX = this.map.yOf(b.jetty) !== this.map.yOf(b.berth);
          b.dir = alongX ? 0 : Math.PI / 2;
          this.message(`A ${b.company} boat has moored with ${b.crates} crates.`, 'info');
        }
        return;
      }
      case 'moored':
        b.mooredTicks++;
        if (b.crates === 0 && b.reserved === 0 && ++b.timer > 30) this.depart(b, false);
        return;
      case 'leaving':
        if (this.move(b, this.boatCostFor(b.draft), true, () => B.BOAT_SPEED) !== 'moving') {
          this.boats = this.boats.filter((q) => q !== b);
        }
        return;
    }
  }

  private depart(b: Boat, gaveUp: boolean): void {
    this.judgeVisit(b, gaveUp);
    b.state = 'leaving';
    b.berth = b.jetty = -1;
    const edge = this.seaEdgeTiles();
    const from = this.tileOf(b);
    const exit = edge.reduce(
      (best, i) =>
        Math.abs(this.map.yOf(i) - this.map.yOf(from)) <
        Math.abs(this.map.yOf(best) - this.map.yOf(from))
          ? i
          : best,
      edge[0],
    );
    b.goal = exit;
    b.path = findPath(this.map.w, this.map.h, from, exit, this.boatCostFor(b.draft), true) ?? [];
  }

  // ── Dockhands and forklifts ───────────────────────────────

  private spawnDockhand(at: number, c: Candidate): Dockhand {
    const p: Dockhand = {
      id: this.nextId++,
      kind: 'dockhand',
      name: c.name,
      skill: c.skill,
      trait: c.trait,
      wage: c.wage,
      energy: 100,
      morale: B.START_MORALE,
      hutIdx: -1,
      lowMoraleDays: 0,
      raiseAsk: 0,
      capacity: 1,
      needsRepair: false,
      x: this.map.xOf(at) + 0.5,
      y: this.map.yOf(at) + 0.5,
      dir: 0,
      path: [],
      goal: at,
      state: 'idle',
      timer: 0,
      carrying: 0,
      cargoFees: [],
      planned: 0,
      boatId: -1,
      craneIdx: -1,
      bayIdx: -1,
    };
    this.people.push(p);
    return p;
  }

  private buyMachine(kind: MachineKind): void {
    if (this.tier < MACHINE_TIER[kind]) {
      return this.message(`Forklifts unlock at the ${TIERS[MACHINE_TIER[kind]].name}.`, 'bad');
    }
    if (this.cash < B.FORKLIFT_PRICE) return this.message('Not enough money', 'bad');
    this.book('construction', -B.FORKLIFT_PRICE);
    const at = [...this.bays.keys()][0] ?? this.map.entry;
    const p = this.spawnDockhand(at, {
      id: 0,
      name: `Forklift ${this.people.filter((q) => q.kind === 'forklift').length + 1}`,
      skill: 3,
      trait: null,
      wage: B.FORKLIFT_WAGE,
    });
    p.kind = 'forklift';
    p.capacity = B.FORKLIFT_CAPACITY;
    this.moneyAt(-B.FORKLIFT_PRICE, at);
    this.message('A forklift has arrived. It drives on quays, paths and roads only.', 'good');
  }

  private walkCost: CostFn = (i) => {
    const b = this.map.build[i];
    if (
      b === Build.Footpath ||
      b === Build.Jetty ||
      b === Build.TruckBay ||
      b === Build.BreakHut ||
      b === Build.Quay ||
      b === Build.JibCrane
    ) {
      return 1;
    }
    if (b === Build.Road) return 1.25;
    if (this.map.deco[i] === Deco.Tree) return Infinity;
    const t = this.map.terrain[i];
    if (t === Terrain.Grass) return 1.4;
    if (t === Terrain.Sand) return 1.6;
    return Infinity;
  };

  /** Forklifts need a hard surface; wooden jetties cannot take the weight. */
  private driveCost: CostFn = (i) => {
    const b = this.map.build[i];
    return b === Build.Footpath ||
      b === Build.Quay ||
      b === Build.JibCrane ||
      b === Build.Road ||
      b === Build.TruckBay
      ? 1
      : Infinity;
  };

  private costFor(p: Dockhand): CostFn {
    return p.kind === 'forklift' ? this.driveCost : this.walkCost;
  }

  private walkSpeed = (i: number) => {
    const c = this.walkCost(i);
    return Number.isFinite(c) ? B.WALK_SPEED / c : B.WALK_SPEED;
  };

  private walk(p: Dockhand) {
    if (p.kind === 'forklift') return this.move(p, this.driveCost, true, () => B.FORKLIFT_SPEED);
    const pace = paceFactor(p.skill, p.morale, p.energy);
    return this.move(p, this.walkCost, true, (i) => this.walkSpeed(i) * pace);
  }

  private handlingTicks(p: Dockhand, base: number): number {
    if (p.kind === 'forklift') return Math.round(base * 1.5);
    return Math.max(1, Math.round(base * traitDef(p.trait).handling));
  }

  private changeMorale(p: Dockhand, delta: number): void {
    if (p.kind === 'forklift') return;
    const scaled = delta < 0 ? delta * traitDef(p.trait).moraleLoss : delta;
    p.morale = Math.max(0, Math.min(100, p.morale + scaled));
  }

  /** Energy use; returns true if the dockhand should head off for a break now. */
  private tire(p: Dockhand): boolean {
    if (p.kind === 'forklift') return false;
    if (p.state === 'resting' || p.state === 'toBreak') return false;
    const drain = WORKING.has(p.state) ? B.WORK_DRAIN * traitDef(p.trait).drain : B.IDLE_DRAIN;
    const before = p.energy;
    p.energy = Math.max(0, p.energy - drain);
    if (before > 0 && p.energy === 0) this.changeMorale(p, B.MORALE_EXHAUSTED);
    // Only stop between jobs, never with a crate in hand.
    return p.energy < B.TIRED_ENERGY && (p.state === 'idle' || p.state === 'wander');
  }

  private hutOccupancy(hut: number): number {
    return this.people.filter((q) => q.hutIdx === hut).length;
  }

  private goOnBreak(p: Dockhand): void {
    p.path = [];
    const here = this.tileOf(p);
    const huts: number[] = [];
    for (let i = 0; i < this.map.build.length; i++) {
      if (this.map.build[i] === Build.BreakHut && this.hutOccupancy(i) < B.HUT_SLOTS) huts.push(i);
    }
    huts.sort((a, b) => this.dist(here, a) - this.dist(here, b));
    for (const hut of huts) {
      if (this.headTo(p, hut)) {
        p.hutIdx = hut;
        p.state = 'toBreak';
        return;
      }
    }
    // Nowhere to go: sit down on the spot. Slow, and bad for morale.
    p.hutIdx = -1;
    p.state = 'resting';
    this.changeMorale(p, B.MORALE_FLOOR_BREAK);
  }

  /** Spread people resting at a hut along its front. */
  private seatAtHut(p: Dockhand): void {
    const seat = this.people.filter((q) => q.hutIdx === p.hutIdx && q !== p).length;
    p.x = this.map.xOf(p.hutIdx) + 0.25 + (seat % B.HUT_SLOTS) * 0.25;
    p.y = this.map.yOf(p.hutIdx) + 0.82;
    p.dir = Math.PI / 2;
  }

  private pathFor(p: Dockhand, from: number, goal: number): number[] | null {
    return findPath(this.map.w, this.map.h, from, goal, this.costFor(p), true);
  }

  private updateDockhand(p: Dockhand): void {
    if (this.tire(p)) return this.goOnBreak(p);
    switch (p.state) {
      case 'broken':
        if (--p.timer <= 0) {
          p.state = 'idle';
          this.message(`${p.name} is repaired and back at work.`, 'info');
        }
        return;
      case 'toBreak': {
        if (this.map.build[p.hutIdx] !== Build.BreakHut) return this.goOnBreak(p);
        const r = this.walk(p);
        if (r === 'blocked') return this.goOnBreak(p);
        if (r === 'arrived') {
          this.seatAtHut(p);
          p.state = 'resting';
        }
        return;
      }
      case 'resting': {
        const inHut = p.hutIdx >= 0 && this.map.build[p.hutIdx] === Build.BreakHut;
        p.energy = Math.min(100, p.energy + (inHut ? B.HUT_REST : B.FLOOR_REST));
        if (p.energy >= 100) {
          if (inHut) this.changeMorale(p, B.MORALE_HUT_BREAK);
          p.hutIdx = -1;
          p.state = 'idle';
        }
        return;
      }
      case 'idle':
      case 'wander': {
        if (p.needsRepair) {
          p.needsRepair = false;
          p.path = [];
          p.state = 'broken';
          p.timer = B.REPAIR_TICKS;
          this.book('maintenance', -B.REPAIR_COST);
          this.moneyAt(-B.REPAIR_COST, this.tileOf(p));
          this.message(`${p.name} has broken down. A mechanic is on the way.`, 'bad');
          return;
        }
        if ((this.tick + p.id) % 5 === 0 && this.assignJob(p)) return;
        if (p.state === 'wander') {
          if (this.walk(p) !== 'moving') p.state = 'idle';
        } else if (p.kind === 'dockhand' && this.rng.next() < 0.008) {
          this.wander(p);
        }
        return;
      }
      case 'toPickup': {
        if (!this.sourceValid(p)) return this.cancelJob(p);
        const r = this.walk(p);
        if (r === 'blocked') return this.cancelJob(p);
        if (r === 'arrived') {
          p.state = 'picking';
          p.timer = this.handlingTicks(p, B.PICK_TICKS);
        }
        return;
      }
      case 'picking': {
        if (--p.timer > 0) return;
        const fees = this.takeFromSource(p);
        if (fees.length === 0) return this.cancelJob(p);
        // Fewer crates than planned: hand back the spare room in the bay.
        const bay = this.bays.get(p.bayIdx);
        if (bay) bay.incoming -= p.planned - fees.length;
        p.planned = fees.length;
        p.carrying = fees.length;
        p.cargoFees = fees;
        if (!bay || !this.headTo(p, p.bayIdx)) this.retargetCrate(p);
        else p.state = 'toDrop';
        return;
      }
      case 'toDrop': {
        if (!this.bays.has(p.bayIdx)) return this.retargetCrate(p);
        const r = this.walk(p);
        if (r === 'blocked') return this.retargetCrate(p);
        if (r === 'arrived') {
          p.state = 'dropping';
          p.timer = this.handlingTicks(p, B.DROP_TICKS);
        }
        return;
      }
      case 'dropping': {
        if (--p.timer > 0) return;
        const bay = this.bays.get(p.bayIdx);
        if (!bay) return this.retargetCrate(p);
        bay.crates.push(...p.cargoFees);
        bay.incoming -= p.planned;
        this.stats.cratesHandled += p.carrying;
        p.carrying = 0;
        p.cargoFees = [];
        p.planned = 0;
        p.bayIdx = -1;
        p.state = 'idle';
        return;
      }
    }
  }

  private headTo(p: Dockhand, goal: number): boolean {
    const path = this.pathFor(p, this.tileOf(p), goal);
    if (!path) return false;
    p.path = path;
    p.goal = goal;
    return true;
  }

  private wander(p: Dockhand): void {
    const x = Math.floor(p.x) + this.rng.int(-3, 3);
    const y = Math.floor(p.y) + this.rng.int(-3, 3);
    if (!this.map.inBounds(x, y)) return;
    const i = this.map.idx(x, y);
    if (!Number.isFinite(this.walkCost(i))) return;
    const path = this.pathFor(p, this.tileOf(p), i);
    if (path && path.length <= 8) {
      p.path = path;
      p.goal = i;
      p.state = 'wander';
    }
  }

  /** Crane landing stacks first (they free the crane), then moored boats. */
  private assignJob(p: Dockhand): boolean {
    const here = this.tileOf(p);
    const cost = this.costFor(p);
    const sources: { tile: number; avail: number; boat?: Boat; crane?: Crane }[] = [];
    for (const crane of this.cranes.values()) {
      const avail = crane.stack.length - crane.reserved;
      if (avail > 0) sources.push({ tile: crane.idx, avail, crane });
    }
    const craneCount = sources.length;
    for (const boat of this.boats) {
      const avail = boat.crates - boat.reserved;
      if (boat.state === 'moored' && avail > 0) sources.push({ tile: boat.jetty, avail, boat });
    }
    const byDist = (a: { tile: number }, b: { tile: number }) =>
      this.dist(here, a.tile) - this.dist(here, b.tile);
    const ordered = [
      ...sources.slice(0, craneCount).sort(byDist),
      ...sources.slice(craneCount).sort(byDist),
    ];

    for (const src of ordered) {
      if (!Number.isFinite(cost(src.tile))) continue;
      const bay = this.bayWithRoom(p, src.tile);
      if (!bay) continue;
      if (!this.headTo(p, src.tile)) continue;
      const room = B.BAY_CAPACITY - bay.crates.length - bay.incoming;
      const planned = Math.min(p.capacity, src.avail, room);
      if (src.crane) src.crane.reserved += planned;
      if (src.boat) src.boat.reserved += planned;
      bay.incoming += planned;
      p.planned = planned;
      p.boatId = src.boat ? src.boat.id : -1;
      p.craneIdx = src.crane ? src.crane.idx : -1;
      p.bayIdx = bay.idx;
      p.state = 'toPickup';
      return true;
    }
    return false;
  }

  private sourceValid(p: Dockhand): boolean {
    if (p.craneIdx >= 0) return this.cranes.has(p.craneIdx);
    const boat = this.boats.find((b) => b.id === p.boatId);
    return !!boat && boat.state === 'moored';
  }

  /** Lift up to the planned number of crates; returns their fees. */
  private takeFromSource(p: Dockhand): number[] {
    if (p.craneIdx >= 0) {
      const crane = this.cranes.get(p.craneIdx);
      p.craneIdx = -1;
      if (!crane) return [];
      crane.reserved = Math.max(0, crane.reserved - p.planned);
      return crane.stack.splice(0, Math.min(p.planned, crane.stack.length));
    }
    const boat = this.boats.find((b) => b.id === p.boatId);
    p.boatId = -1;
    if (!boat) return [];
    boat.reserved = Math.max(0, boat.reserved - p.planned);
    const n = Math.min(p.planned, boat.crates);
    boat.crates -= n;
    return Array.from({ length: n }, () => boat.fee);
  }

  /** Nearest truck bay with room that this worker can reach from `from`. */
  private bayWithRoom(p: Dockhand, from: number): Bay | null {
    const bays = [...this.bays.values()]
      .filter((b) => b.crates.length + b.incoming < B.BAY_CAPACITY)
      .sort((a, b) => this.dist(from, a.idx) - this.dist(from, b.idx));
    for (const bay of bays) {
      if (this.pathFor(p, from, bay.idx)) return bay;
    }
    return null;
  }

  /** The worker holds crates but their bay is gone or unreachable. */
  private retargetCrate(p: Dockhand): void {
    const old = this.bays.get(p.bayIdx);
    if (old) old.incoming = Math.max(0, old.incoming - p.planned);
    const bay = this.bayWithRoom(p, this.tileOf(p));
    if (bay && this.headTo(p, bay.idx)) {
      bay.incoming += p.planned;
      p.bayIdx = bay.idx;
      p.state = 'toDrop';
      return;
    }
    this.message(`${p.name} had nowhere to take their load and put it down.`, 'bad');
    p.carrying = 0;
    p.cargoFees = [];
    p.planned = 0;
    p.bayIdx = -1;
    p.path = [];
    p.state = 'idle';
  }

  private cancelJob(p: Dockhand): void {
    if (!p.carrying) {
      const boat = this.boats.find((b) => b.id === p.boatId);
      if (boat) boat.reserved = Math.max(0, boat.reserved - p.planned);
      const crane = this.cranes.get(p.craneIdx);
      if (crane) crane.reserved = Math.max(0, crane.reserved - p.planned);
    }
    const bay = this.bays.get(p.bayIdx);
    if (bay) bay.incoming = Math.max(0, bay.incoming - p.planned);
    p.boatId = -1;
    p.craneIdx = -1;
    p.bayIdx = -1;
    p.hutIdx = -1;
    p.carrying = 0;
    p.cargoFees = [];
    p.planned = 0;
    p.path = [];
    p.state = 'idle';
  }

  // ── Jib cranes ────────────────────────────────────────────

  private addCrane(i: number): void {
    this.cranes.set(i, { idx: i, stack: [], reserved: 0, timer: 0, angle: 0, busy: false });
  }

  /** Swing crates from a boat moored beside the crane onto its landing stack. */
  private updateCrane(c: Crane): void {
    c.busy = false;
    if (c.stack.length >= B.CRANE_STACK) return;
    const m = this.map;
    const boat = this.boats.find(
      (b) =>
        b.state === 'moored' &&
        b.crates - b.reserved > 0 &&
        Math.max(
          Math.abs(m.xOf(b.berth) - m.xOf(c.idx)),
          Math.abs(m.yOf(b.berth) - m.yOf(c.idx)),
        ) <= 1,
    );
    if (!boat) return;
    c.busy = true;
    c.angle = Math.atan2(boat.y - (m.yOf(c.idx) + 0.5), boat.x - (m.xOf(c.idx) + 0.5));
    if (++c.timer < B.CRANE_TICKS) return;
    c.timer = 0;
    boat.crates--;
    c.stack.push(boat.fee);
  }

  // ── Trucks and bays ───────────────────────────────────────

  private addBay(i: number): void {
    this.bays.set(i, {
      idx: i,
      crates: [],
      incoming: 0,
      truckId: -1,
      nextTruckTick: 0,
      noAccess: false,
    });
  }

  private removeBay(i: number): void {
    const bay = this.bays.get(i);
    if (bay && bay.crates.length > 0) {
      this.message(`${bay.crates.length} crates were lost with the truck bay.`, 'bad');
    }
    this.bays.delete(i);
  }

  /** Trucks drive on roads; a truck bay is only enterable as the destination. */
  private truckCost(target: number): CostFn {
    return (i) => (this.map.build[i] === Build.Road || i === target ? 1 : Infinity);
  }

  private spawnTrucks(): void {
    const m = this.map;
    const hauliers = this.hauliers();
    const out = new Map<number, number>();
    for (const t of this.trucks) out.set(t.contractId, (out.get(t.contractId) ?? 0) + 1);
    // Fullest bays get trucks first.
    const bays = [...this.bays.values()]
      .filter((b) => b.truckId < 0 && b.crates.length > 0 && this.tick >= b.nextTruckTick)
      .sort((a, b) => b.crates.length - a.crates.length || a.idx - b.idx);

    for (const bay of this.bays.values()) {
      if (bay.crates.length >= B.BAY_CAPACITY) this.bayFullTicks += 10;
    }
    for (const bay of bays) {
      const haulier = hauliers.find((h) => (out.get(h.id) ?? 0) < h.terms.fleet);
      if (!haulier) return;
      const path = findPath(m.w, m.h, m.entry, bay.idx, this.truckCost(bay.idx), false);
      if (!path) {
        if (!bay.noAccess) {
          this.message('A truck bay has no road connection to the highway.', 'bad');
        }
        bay.noAccess = true;
        bay.nextTruckTick = this.tick + 100;
        continue;
      }
      bay.noAccess = false;
      out.set(haulier.id, (out.get(haulier.id) ?? 0) + 1);
      const truck: Truck = {
        id: this.nextId++,
        contractId: haulier.id,
        company: haulier.terms.name,
        capacity: haulier.terms.capacity,
        x: m.xOf(m.entry) + 0.5,
        y: m.yOf(m.entry) + 0.5,
        dir: 0,
        path,
        goal: bay.idx,
        state: 'toBay',
        bayIdx: bay.idx,
        cargo: 0,
        value: 0,
        idle: 0,
        timer: 0,
        variant: haulier.terms.color,
      };
      bay.truckId = truck.id;
      this.trucks.push(truck);
    }
  }

  private updateTruck(t: Truck): void {
    const bay = this.bays.get(t.bayIdx);
    switch (t.state) {
      case 'toBay': {
        if (!bay) return this.truckLeave(t);
        const r = this.move(t, this.truckCost(t.bayIdx), false, () => B.TRUCK_SPEED);
        if (r === 'blocked') {
          bay.truckId = -1;
          return this.removeTruck(t);
        }
        if (r === 'arrived') t.state = 'loading';
        return;
      }
      case 'loading': {
        if (!bay) return this.truckLeave(t);
        if (++t.timer % 5 !== 0) return;
        if (bay.crates.length > 0 && t.cargo < t.capacity) {
          t.value += bay.crates.shift()!;
          t.cargo++;
          t.idle = 0;
        } else {
          t.idle += 5;
        }
        const full = t.cargo >= t.capacity;
        const bored = t.cargo > 0 ? t.idle >= B.TRUCK_PATIENCE : t.idle >= B.TRUCK_GIVE_UP;
        if (full || bored) this.truckLeave(t);
        return;
      }
      case 'leaving':
        if (this.move(t, this.truckCost(this.map.entry), false, () => B.TRUCK_SPEED) !== 'moving') {
          this.removeTruck(t);
        }
        return;
    }
  }

  private truckLeave(t: Truck): void {
    const bay = this.bays.get(t.bayIdx);
    if (bay) {
      bay.truckId = -1;
      bay.nextTruckTick = this.tick + 30;
    }
    if (t.cargo > 0) {
      const income = t.value;
      this.book('cargo', income);
      this.stats.earned += income;
      this.stats.trucks++;
      this.moneyAt(income, this.tileOf(t));
    }
    t.state = 'leaving';
    t.goal = this.map.entry;
    const path = findPath(
      this.map.w,
      this.map.h,
      this.tileOf(t),
      this.map.entry,
      this.truckCost(this.map.entry),
      false,
    );
    if (path) t.path = path;
    else this.removeTruck(t);
  }

  private removeTruck(t: Truck): void {
    this.trucks = this.trucks.filter((q) => q !== t);
  }

  // ── Movement ──────────────────────────────────────────────

  /** Advance an agent along its path, repathing if the next tile became blocked. */
  private move(
    a: Agent,
    cost: CostFn,
    diagonal: boolean,
    speedAt: (i: number) => number,
  ): 'moving' | 'arrived' | 'blocked' {
    const w = this.map.w;
    let budget = speedAt(this.tileOf(a));
    let repaths = 0;
    while (budget > 1e-6 && a.path.length > 0) {
      const next = a.path[0];
      if (!Number.isFinite(cost(next))) {
        const p =
          repaths++ < 1 ? findPath(w, this.map.h, this.tileOf(a), a.goal, cost, diagonal) : null;
        if (!p) {
          a.path = [];
          return 'blocked';
        }
        a.path = p;
        continue;
      }
      const tx = (next % w) + 0.5;
      const ty = Math.floor(next / w) + 0.5;
      const dx = tx - a.x;
      const dy = ty - a.y;
      const d = Math.hypot(dx, dy);
      if (d > 1e-6) a.dir = Math.atan2(dy, dx);
      if (d <= budget) {
        a.x = tx;
        a.y = ty;
        a.path.shift();
        budget -= d;
      } else {
        a.x += (dx / d) * budget;
        a.y += (dy / d) * budget;
        budget = 0;
      }
    }
    return a.path.length === 0 ? 'arrived' : 'moving';
  }

  private tileOf(a: Agent): number {
    return this.map.idx(Math.floor(a.x), Math.floor(a.y));
  }

  private dist(a: number, b: number): number {
    const m = this.map;
    return Math.abs(m.xOf(a) - m.xOf(b)) + Math.abs(m.yOf(a) - m.yOf(b));
  }

  // ── Output ────────────────────────────────────────────────

  private message(text: string, tone: 'info' | 'good' | 'bad'): void {
    this.events.push({ kind: 'message', text, tone });
  }

  private moneyAt(amount: number, i: number): void {
    this.events.push({ kind: 'money', amount, x: this.map.xOf(i) + 0.5, y: this.map.yOf(i) + 0.5 });
  }

  drainEvents(): SimEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  drainTileChanges(): TileChange[] {
    const out = [...this.dirty].map((i) => ({
      i,
      terrain: this.map.terrain[i],
      build: this.map.build[i],
      deco: this.map.deco[i],
    }));
    this.dirty.clear();
    return out;
  }

  snapshot(): Snapshot {
    const entities: EntityView[] = [];
    const staff: StaffView[] = [];
    for (const p of this.people) {
      entities.push({
        id: p.id,
        kind: p.kind,
        x: p.x,
        y: p.y,
        dir: p.dir,
        load: p.carrying,
        moving: p.path.length > 0,
        name: p.name,
        activity: ACTIVITY[p.state],
        variant: 0,
        capacity: p.capacity,
        alert: p.state === 'broken',
      });
      staff.push({
        id: p.id,
        kind: p.kind,
        broken: p.state === 'broken',
        name: p.name,
        skill: p.skill,
        trait: p.trait,
        wage: p.wage,
        energy: Math.round(p.energy),
        morale: Math.round(p.morale),
        activity: ACTIVITY[p.state],
        thought: thought({
          energy: p.energy,
          morale: p.morale,
          resting: p.state === 'resting',
          hasHut: p.hutIdx >= 0,
          carrying: p.carrying > 0,
          idle: p.state === 'idle' || p.state === 'wander',
        }),
        raiseAsk: p.raiseAsk,
      });
    }
    for (const b of this.boats) {
      entities.push({
        id: b.id,
        kind: 'boat',
        x: b.x,
        y: b.y,
        dir: b.dir,
        load: b.crates,
        moving: b.path.length > 0,
        name: b.company,
        activity:
          b.state === 'approaching'
            ? 'Sailing in from sea'
            : b.state === 'anchored'
              ? 'Waiting at anchor for a berth'
              : b.state === 'arriving'
                ? 'Sailing to the jetty'
                : b.state === 'moored'
                  ? `Unloading, ${b.crates} crates left`
                  : 'Heading back out to sea',
        variant: b.variant,
        capacity: b.vessel === 'coaster' ? B.COASTER_MAX_LOAD : B.BOAT_MAX_LOAD,
        alert: b.state === 'anchored',
        vessel: b.vessel,
      });
    }
    for (const t of this.trucks) {
      entities.push({
        id: t.id,
        kind: 'truck',
        x: t.x,
        y: t.y,
        dir: t.dir,
        load: t.cargo,
        moving: t.path.length > 0,
        name: t.company,
        activity:
          t.state === 'toBay'
            ? 'Driving to the truck bay'
            : t.state === 'loading'
              ? `Loading, ${t.cargo}/${t.capacity} crates`
              : 'Delivering to town',
        variant: t.variant,
        capacity: t.capacity,
        alert: false,
      });
    }
    const bays: BayView[] = [...this.bays.values()].map((b) => ({
      idx: b.idx,
      stock: b.crates.length,
      noAccess: b.noAccess,
    }));
    const contracts: ContractView[] = this.contracts.map((c) => ({
      id: c.id,
      terms: c.terms,
      satisfaction: c.satisfaction,
      cancelFee: cancelFee(c),
      breach: breachPenalty(c),
      active:
        c.terms.kind === 'fishery'
          ? this.boats.filter((b) => b.contractId === c.id).length
          : this.trucks.filter((t) => t.contractId === c.id).length,
      waiting: this.boats.filter((b) => b.contractId === c.id && b.state === 'anchored').length,
      nextIn: c.terms.kind === 'fishery' ? Math.max(0, c.nextBoatTick - this.tick) : -1,
    }));
    const cap = this.capacity();
    return {
      tick: this.tick,
      cash: this.cash,
      speed: this.speed,
      seed: this.seed,
      staff: this.people.length,
      wages: this.wageBill(),
      people: staff,
      candidates: this.candidates.map((c) => ({ ...c })),
      contractFees: this.dailyFees(),
      loan: this.loan,
      interest: this.interestDue(),
      today: { ...this.today },
      yesterday: this.yesterday ? { ...this.yesterday } : null,
      daysInRed: this.daysInRed,
      bankrupt: this.bankrupt,
      stats: { ...this.stats },
      entities,
      bays,
      contracts,
      capacity: this.capacity(),
      progress: { tier: this.tier, ...this.tierProgress(), canUpgrade: this.canUpgrade() },
      cranes: [...this.cranes.values()].map((c) => ({
        idx: c.idx,
        stack: c.stack.length,
        angle: c.angle,
        busy: c.busy,
      })),
      offers: this.offers.map((o) => ({
        id: o.id,
        terms: o.terms,
        signingFee: o.signingFee,
        expiresIn: o.expires - this.tick,
        breach: breachPenalty(o),
        truckingAfter: o.terms.kind === 'haulier' ? this.truckingWith(o.terms) : cap.trucking,
      })),
    };
  }
}
