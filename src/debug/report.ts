import type { Snapshot } from '../protocol';
import { TOWN_STAGES } from '../sim/town';
import { TICKS_PER_DAY } from '../sim/types';

// A plain-text picture of a running game, for reading outside the browser:
// the dev bridge writes it to .debug/report.txt every few seconds.

export interface ReportExtras {
  /** Map width, to turn tile indices into x,y. */
  width: number;
  /** Recent messages and errors, oldest first. */
  log?: string[];
  /** What the player has selected, the tool in hand, where the camera is. */
  view?: string;
}

export function report(s: Snapshot, x: ReportExtras): string {
  const at = (i: number) => `(${i % x.width},${Math.floor(i / x.width)})`;
  const pos = (e: { x: number; y: number }) => `(${e.x.toFixed(1)},${e.y.toFixed(1)})`;
  const day = Math.floor(s.tick / TICKS_PER_DAY) + 1;
  const c = s.capacity;
  const lines: string[] = [];
  const section = (title: string, rows: string[]) => {
    lines.push('', `## ${title}`, ...(rows.length ? rows : ['(none)']));
  };

  lines.push(
    `Day ${day}, tick ${s.tick} · speed ${s.speed} · seed ${s.seed} · tier ${s.progress.tier}`,
    `Cash $${s.cash} · loan $${s.loan} · days in red ${s.daysInRed}${s.bankrupt ? ' · BANKRUPT' : ''}`,
    `Crates/day: demand ${c.demand}, unloading ${c.unloading}, trucking ${c.trucking}` +
      ` · pallets ${c.pallets.demand}/${c.pallets.unloading} · congestion ${c.congestion.toFixed(2)}`,
    `Containers/day: demand ${c.boxes.demand}, lifting ${c.boxes.lifting}, moving ${c.boxes.moving}, trucking ${c.boxes.trucking}`,
    `Stats: ${JSON.stringify(s.stats)}`,
  );
  if (x.view) lines.push(`Player: ${x.view}`);
  if (s.town) {
    const t = s.town;
    lines.push(
      `Town: ${t.name} (${TOWN_STAGES[t.stage].name}) at (${t.x},${t.y}) · ${t.population} people, ` +
        `${t.homes} homes · supports ${t.target} (jobs ${t.jobs}, goods ${t.goods}/day, ` +
        `delivered in town ${t.supplied}/day; still wants ${t.wants.crates} crates, ${t.wants.boxes} containers)`,
    );
  }
  if (s.train) {
    const t = s.train;
    lines.push(
      `Train: ${t.cars.join(' ')} heading ${t.dir > 0 ? '+y' : '-y'}, front at y=${t.head.toFixed(1)}`,
    );
  }

  section(
    'Contracts',
    s.contracts.map((k) => {
      const t = k.terms;
      const what =
        t.kind === 'haulier'
          ? `haulier ${t.fleet}×${t.capacity}${t.cargo ? ' containers' : ''}`
          : `fishery ${t.vessel}`;
      return `- ${t.name}: ${what}, satisfaction ${Math.round(k.satisfaction)}, active ${k.active}, waiting ${k.waiting}`;
    }),
  );

  const kinds = ['boat', 'truck', 'dockhand', 'forklift', 'stacker'] as const;
  for (const kind of kinds) {
    const es = s.entities.filter((e) => e.kind === kind);
    section(
      `${kind[0].toUpperCase()}${kind.slice(1)}s (${es.length})`,
      es.map(
        (e) =>
          `- #${e.id} ${e.name}${e.vessel ? ` [${e.vessel}]` : ''} at ${pos(e)}: ${e.activity}` +
          `${e.load ? `, load ${e.load}/${e.capacity}` : ''}${e.alert ? ' ⚠' : ''}` +
          `${e.why ? ` (why: ${e.why})` : ''}`,
      ),
    );
  }

  section(
    'Staff',
    s.people.map(
      (p) =>
        `- #${p.id} ${p.name} (${p.kind}) energy ${p.energy}, morale ${p.morale}` +
        `${p.kind === 'forklift' ? `, fuel ${Math.round(p.fuel)}` : ''}${p.broken ? ', BROKEN' : ''}: ${p.thought}`,
    ),
  );
  section(
    'Truck bays and crate storage',
    s.bays.map(
      (b) =>
        `- ${b.tiles ? `crate storage (${b.tiles.length} tiles)` : b.large ? 'large bay' : 'bay'} ${at(b.idx)}: ${b.stock}/${b.capacity} crates` +
        `${b.boxes ? `, ${b.boxes} containers` : ''}${b.noAccess ? ', NO TRUCK ACCESS' : ''}`,
    ),
  );
  section(
    'Container yards',
    s.yards.map(
      (y) =>
        `- ${at(y.idx)} (${y.tiles.length} tiles): ${y.boxes}/${y.capacity} containers, ${y.cleared} cleared${y.noAccess ? ', NO TRUCK ACCESS' : ''}`,
    ),
  );
  section(
    'Landed on the quay',
    s.piles.map((p) => `- ${at(p.idx)}: ${p.crates} ${p.pallets ? 'crates on pallets' : 'crates'}`),
  );
  section(
    'Cranes',
    s.cranes.map((k) => `- ${k.kind} ${at(k.idx)}: stack ${k.stack}/${k.max}: ${k.why}`),
  );
  section(
    'Depots',
    s.depots.map((d) => `- ${at(d.idx)}: ${d.forklifts} machines`),
  );
  section('Recent messages and errors', x.log ?? []);
  return lines.join('\n') + '\n';
}
