import { describe, expect, it } from 'vitest';
import type { ContractView, OfferView } from '../src/protocol';
import { STARTER_FISHERY, STARTER_HAULIER, type Terms } from '../src/sim/contracts';
import { TICKS_PER_DAY } from '../src/sim/types';
import {
  cargoOf,
  health,
  kindGroup,
  OFFER_DEFAULT,
  offerRows,
  readFilter,
  SIGNED_DEFAULT,
  signedRows,
} from '../src/ui/contractList';

// The Contracts panel's lists: what each contract is, how it is getting on,
// and the filters and order the player picks.

const lobster: Terms = { ...STARTER_FISHERY, name: 'Redclaw Lobsters', catch: 'lobster' };
const coaster: Terms = {
  ...STARTER_FISHERY,
  name: 'Baltic Coasters',
  vessel: 'coaster',
  catch: 'timber',
};
const feeder: Terms = { ...STARTER_FISHERY, name: 'Gull Feeders', vessel: 'feeder', fee: 200 };
const ice: Terms = {
  kind: 'shipper',
  name: 'Polar Ice Co.',
  color: 1,
  perDay: 6,
  capacity: 6,
  fee: 10,
  goods: 'ice',
};
const boxes: Terms = { ...STARTER_HAULIER, name: 'Box Haulage', cargo: 'container', pickup: false };

let id = 0;
function contract(terms: Terms, over: Partial<ContractView> = {}): ContractView {
  return {
    id: ++id,
    terms,
    satisfaction: 80,
    cancelFee: 100,
    breach: 500,
    waiting: 0,
    nextIn: 0,
    backIn: -1,
    active: 0,
    away: 0,
    ...over,
  };
}

function offer(terms: Terms, over: Partial<OfferView> = {}): OfferView {
  return {
    id: ++id,
    terms,
    signingFee: 1000,
    expiresIn: 5 * TICKS_PER_DAY,
    breach: 500,
    truckingAfter: 0,
    ...over,
  };
}

describe('contract list', () => {
  it('groups kinds and cargo as the filters show them', () => {
    expect(kindGroup(STARTER_FISHERY)).toBe('fishery');
    expect(kindGroup(lobster)).toBe('fishery');
    expect(kindGroup(coaster)).toBe('line');
    expect(kindGroup(feeder)).toBe('feeder');
    expect(kindGroup(ice)).toBe('shipper');
    expect(kindGroup(boxes)).toBe('haulier');
    expect(cargoOf(STARTER_FISHERY)).toBe('fish');
    expect(cargoOf(lobster)).toBe('lobster');
    expect(cargoOf(coaster)).toBe('timber');
    expect(cargoOf(feeder)).toBe('containers');
    expect(cargoOf(ice)).toBe('ice');
    expect(cargoOf(STARTER_HAULIER)).toBe('crates');
    expect(cargoOf(boxes)).toBe('containers');
  });

  it('says why a contract is held up or in trouble', () => {
    expect(health(contract(STARTER_FISHERY)).health).toBe('working');
    const waiting = health(contract(STARTER_FISHERY, { waiting: 2 }));
    expect(waiting).toEqual({ health: 'held', why: '2 boats waiting at anchor.' });
    expect(health(contract(STARTER_FISHERY, { satisfaction: 30 })).health).toBe('held');
    expect(health(contract(STARTER_FISHERY, { satisfaction: 10 })).health).toBe('trouble');
    const stuck = contract(ice, { trouble: { text: 'No truck bay.', bad: true } });
    expect(health(stuck)).toEqual({ health: 'trouble', why: 'No truck bay.' });
    const slow = contract(ice, { trouble: { text: 'Slow.', bad: false } });
    expect(health(slow).health).toBe('held');
  });

  it('filters signed contracts and puts the troubled first', () => {
    const list = [
      contract(STARTER_HAULIER),
      contract(STARTER_FISHERY, { waiting: 1 }),
      contract(lobster),
      contract(ice, { trouble: { text: 'No truck bay.', bad: true } }),
    ];
    const all = signedRows(list, SIGNED_DEFAULT).map((r) => r.c.terms.name);
    expect(all.slice(0, 2)).toEqual([ice.name, STARTER_FISHERY.name]);
    const fish = signedRows(list, { ...SIGNED_DEFAULT, kind: 'fishery' });
    expect(fish).toHaveLength(2);
    const lob = signedRows(list, { ...SIGNED_DEFAULT, cargo: 'lobster' });
    expect(lob.map((r) => r.c.terms.name)).toEqual([lobster.name]);
    const working = signedRows(list, { ...SIGNED_DEFAULT, status: 'working' });
    expect(working).toHaveLength(2);
    const byValue = signedRows(list, { ...SIGNED_DEFAULT, sort: 'value' });
    expect(byValue.at(-1)!.c.terms.kind).toBe('haulier');
  });

  it('filters offers by what blocks them and when they go', () => {
    const soon = offer(lobster, { expiresIn: TICKS_PER_DAY });
    const locked = offer(coaster, { blocked: 'Needs a customs office' });
    const list = [offer(STARTER_HAULIER, { signingFee: 200 }), soon, locked];
    const blocked = (o: OfferView) => o.blocked ?? null;
    expect(offerRows(list, { ...OFFER_DEFAULT, status: 'expiring' }, blocked)).toEqual([soon]);
    expect(offerRows(list, { ...OFFER_DEFAULT, status: 'blocked' }, blocked)).toEqual([locked]);
    expect(offerRows(list, { ...OFFER_DEFAULT, status: 'ready' }, blocked)).toHaveLength(2);
    expect(offerRows(list, { ...OFFER_DEFAULT, sort: 'expiry' }, blocked)[0]).toBe(soon);
    expect(offerRows(list, { ...OFFER_DEFAULT, sort: 'fee' }, blocked)[0].terms.kind).toBe(
      'haulier',
    );
  });

  it('reads back a stored filter, putting anything unknown back to the default', () => {
    const f = readFilter(
      { kind: 'line', cargo: 'gold', status: 'held', sort: 'bogus' },
      ['working', 'held', 'trouble'],
      ['status', 'value', 'name'],
      SIGNED_DEFAULT,
    );
    expect(f).toEqual({ kind: 'line', cargo: 'all', status: 'held', sort: 'status' });
    expect(readFilter(null, [], ['value'], OFFER_DEFAULT)).toEqual(OFFER_DEFAULT);
  });
});
