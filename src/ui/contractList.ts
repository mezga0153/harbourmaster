import { signal } from '@preact/signals';
import type { ContractView, OfferView } from '../protocol';
import {
  fisheryDailyCrates,
  fisheryDailyValue,
  railDailyValue,
  shipperDailyValue,
  type Terms,
} from '../sim/contracts';
import { TICKS_PER_DAY } from '../sim/types';
import { paid } from './difficulty';

// The Contracts panel's lists, signed and offered: what kind of company each
// is, what it carries, what it is worth a day, how it is getting on, and the
// filters and order the player chose for them, kept in this browser.

/** The kinds of company, as the panel's filter groups them. */
export type KindGroup = 'fishery' | 'line' | 'feeder' | 'shipper' | 'haulier' | 'rail';
export const KINDS: KindGroup[] = ['fishery', 'line', 'feeder', 'shipper', 'haulier', 'rail'];
export const KIND_LABEL: Record<KindGroup, string> = {
  fishery: 'Fisheries',
  line: 'Coaster lines',
  feeder: 'Container lines',
  shipper: 'Shippers',
  haulier: 'Hauliers',
  rail: 'Rail lines',
};

export function kindGroup(t: Terms): KindGroup {
  if (t.kind === 'fishery') {
    return t.vessel === 'feeder' ? 'feeder' : t.vessel === 'coaster' ? 'line' : 'fishery';
  }
  return t.kind;
}

/** What a contract carries: hauliers' trucks take any crates, or containers. */
export type Cargo =
  'fish' | 'lobster' | 'timber' | 'goods' | 'canned' | 'ice' | 'crates' | 'containers';
export const CARGOS: Cargo[] = [
  'fish',
  'lobster',
  'timber',
  'goods',
  'canned',
  'ice',
  'crates',
  'containers',
];
export const CARGO_LABEL: Record<Cargo, string> = {
  fish: 'Fish',
  lobster: 'Lobster',
  timber: 'Timber',
  goods: 'Goods',
  canned: 'Canned fish',
  ice: 'Ice',
  crates: 'Any crates',
  containers: 'Containers',
};

export function cargoOf(t: Terms): Cargo {
  if (t.kind === 'fishery') return t.vessel === 'feeder' ? 'containers' : (t.catch ?? 'fish');
  if (t.kind === 'rail' || t.cargo === 'container') return 'containers';
  if (t.kind === 'shipper') return t.goods ?? 'goods';
  return 'crates';
}

/** Rough money a day: what a line or shipper brings in, less what a haulier charges. */
export function dailyValue(t: Terms): number {
  if (t.kind === 'fishery') return paid(fisheryDailyValue(t));
  if (t.kind === 'shipper') return paid(shipperDailyValue(t));
  if (t.kind === 'rail') return paid(railDailyValue(t));
  return -t.dailyFee;
}

/** Crates or containers a day, in or out, or a haulier's trucks: "≈12/day". */
export function volume(t: Terms): string {
  if (t.kind === 'fishery') return `≈${Math.round(fisheryDailyCrates(t))}/day in`;
  if (t.kind === 'shipper') return `≈${t.perDay}/day out`;
  if (t.kind === 'rail') return `${t.bring} out, ${t.take} in, every ${t.trainEvery} days`;
  return `${t.fleet} × ${t.capacity}`;
}

// ── How a signed contract is getting on ──────────────────

export type Health = 'working' | 'held' | 'trouble';
export const HEALTH_LABEL: Record<Health, string> = {
  working: 'Working',
  held: 'Held up',
  trouble: 'In trouble',
};

/**
 * Whether a signed contract works, and if not why, from what the sim sends:
 * in trouble when its trucks cannot come or unload at all, or a line is
 * close to walking out; held up when boats wait at anchor, a line is
 * annoyed, or something slows a shipper's trucks.
 */
export function health(c: ContractView): { health: Health; why?: string } {
  const t = c.terms;
  const lines = t.kind === 'fishery';
  if (c.trouble?.bad) return { health: 'trouble', why: c.trouble.text };
  if (lines && c.satisfaction < 25) {
    return {
      health: 'trouble',
      why: `Furious: close to walking out, claiming the walk-out penalty.${
        c.waiting > 0 ? ` ${waitingText(c.waiting)}.` : ''
      }`,
    };
  }
  if (c.waiting > 0) return { health: 'held', why: `${waitingText(c.waiting)}.` };
  if (c.trouble) return { health: 'held', why: c.trouble.text };
  if (lines && c.satisfaction < 45) {
    return { health: 'held', why: 'Annoyed: serve their boats promptly, or they walk out.' };
  }
  return { health: 'working' };
}

function waitingText(n: number): string {
  return `${n} boat${n === 1 ? '' : 's'} waiting at anchor`;
}

// ── Offers ───────────────────────────────────────────────

/** An offer due to go within this long counts as expiring. */
export const EXPIRING_TICKS = 2 * TICKS_PER_DAY;

export type OfferStatus = 'ready' | 'blocked' | 'expiring';
export const OFFER_STATUS_LABEL: Record<OfferStatus, string> = {
  ready: 'Can sign',
  blocked: 'Blocked',
  expiring: 'Expiring',
};

// ── Filters and order ────────────────────────────────────

export type SignedSort = 'status' | 'value' | 'name';
export type OfferSort = 'value' | 'expiry' | 'fee';
export const SIGNED_SORT_LABEL: Record<SignedSort, string> = {
  status: 'Needing attention first',
  value: 'Most value a day',
  name: 'By name',
};
export const OFFER_SORT_LABEL: Record<OfferSort, string> = {
  value: 'Most value a day',
  expiry: 'Expiring soonest',
  fee: 'Cheapest to sign',
};

export interface ListFilter<Status extends string, Sort extends string> {
  kind: KindGroup | 'all';
  cargo: Cargo | 'all';
  status: Status | 'all';
  sort: Sort;
}
export type SignedFilter = ListFilter<Health, SignedSort>;
export type OfferFilter = ListFilter<OfferStatus, OfferSort>;

export const SIGNED_DEFAULT: SignedFilter = {
  kind: 'all',
  cargo: 'all',
  status: 'all',
  sort: 'status',
};
export const OFFER_DEFAULT: OfferFilter = {
  kind: 'all',
  cargo: 'all',
  status: 'all',
  sort: 'value',
};

function pick<T extends string>(v: unknown, from: readonly T[], or: T): T {
  return from.includes(v as T) ? (v as T) : or;
}

/** A filter read back from storage, anything unknown put back to its default. */
export function readFilter<S extends string, O extends string>(
  raw: unknown,
  statuses: readonly S[],
  sorts: readonly O[],
  or: ListFilter<S, O>,
): ListFilter<S, O> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    kind: pick<KindGroup | 'all'>(r.kind, [...KINDS, 'all'], or.kind),
    cargo: pick<Cargo | 'all'>(r.cargo, [...CARGOS, 'all'], or.cargo),
    status: pick<S | 'all'>(r.status, [...statuses, 'all'], or.status),
    sort: pick<O>(r.sort, sorts, or.sort),
  };
}

const FILTER_KEY = 'harbourmaster.contractFilters';

function loadFilters(): { signed: SignedFilter; offers: OfferFilter } {
  let raw: { signed?: unknown; offers?: unknown } = {};
  try {
    raw = JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}') ?? {};
  } catch {
    // No storage here, or nothing sensible in it: start with everything shown.
  }
  return {
    signed: readFilter(
      raw.signed,
      ['working', 'held', 'trouble'],
      ['status', 'value', 'name'],
      SIGNED_DEFAULT,
    ),
    offers: readFilter(
      raw.offers,
      ['ready', 'blocked', 'expiring'],
      ['value', 'expiry', 'fee'],
      OFFER_DEFAULT,
    ),
  };
}

const saved = loadFilters();
/** How the signed contracts are filtered and ordered, kept in this browser. */
export const signedFilter = signal<SignedFilter>(saved.signed);
/** How the offers are filtered and ordered, kept in this browser. */
export const offerFilter = signal<OfferFilter>(saved.offers);

function save(): void {
  try {
    localStorage.setItem(
      FILTER_KEY,
      JSON.stringify({ signed: signedFilter.value, offers: offerFilter.value }),
    );
  } catch {
    // Remembered for this visit only.
  }
}
signedFilter.subscribe(save);
offerFilter.subscribe(save);

const RANK: Record<Health, number> = { trouble: 0, held: 1, working: 2 };

/** The signed contracts the filter lets through, in its order, each with how it is getting on. */
export function signedRows(
  contracts: ContractView[],
  f: SignedFilter,
): { c: ContractView; health: Health; why?: string }[] {
  const rows = contracts
    .map((c) => ({ c, ...health(c) }))
    .filter(
      (r) =>
        (f.kind === 'all' || kindGroup(r.c.terms) === f.kind) &&
        (f.cargo === 'all' || cargoOf(r.c.terms) === f.cargo) &&
        (f.status === 'all' || r.health === f.status),
    );
  const name = (a: (typeof rows)[0], b: (typeof rows)[0]) =>
    a.c.terms.name.localeCompare(b.c.terms.name);
  return rows.sort((a, b) =>
    f.sort === 'value'
      ? dailyValue(b.c.terms) - dailyValue(a.c.terms) || name(a, b)
      : f.sort === 'name'
        ? name(a, b)
        : RANK[a.health] - RANK[b.health] ||
          a.c.satisfaction - b.c.satisfaction ||
          b.c.waiting - a.c.waiting ||
          name(a, b),
  );
}

/** Whether an offer matches a status: expiring cuts across the other two. */
export function offerIs(
  o: OfferView,
  status: OfferStatus,
  blocked: (o: OfferView) => string | null,
): boolean {
  if (status === 'expiring') return o.expiresIn <= EXPIRING_TICKS;
  return status === 'blocked' ? blocked(o) !== null : blocked(o) === null;
}

/** The offers the filter lets through, in its order; `blocked` says why one cannot be signed now. */
export function offerRows(
  offers: OfferView[],
  f: OfferFilter,
  blocked: (o: OfferView) => string | null,
): OfferView[] {
  return offers
    .filter(
      (o) =>
        (f.kind === 'all' || kindGroup(o.terms) === f.kind) &&
        (f.cargo === 'all' || cargoOf(o.terms) === f.cargo) &&
        (f.status === 'all' || offerIs(o, f.status, blocked)),
    )
    .sort(
      (a, b) =>
        (f.sort === 'expiry'
          ? a.expiresIn - b.expiresIn
          : f.sort === 'fee'
            ? a.signingFee - b.signingFee
            : dailyValue(b.terms) - dailyValue(a.terms)) ||
        a.terms.name.localeCompare(b.terms.name),
    );
}
