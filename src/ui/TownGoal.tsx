import type { Snapshot } from '../protocol';
import { panel, selection, snapshot } from './store';
import { Meter } from './widgets';

// The town's next landmark where the player looks while running the port:
// in the Contracts overview and as a chip in the top bar, so how far today's
// deliveries are from what the town asks is never only in the Town panel.

export type NextLandmark = NonNullable<NonNullable<Snapshot['town']>['next']>;

const count = (n: number) => Math.round(n).toLocaleString('en-US');

/** The next landmark the port is working towards now, or null (none left, or it waits on a port upgrade). */
export function workingTowards(s: Snapshot | null): NextLandmark | null {
  const n = s?.town?.next;
  return n && !n.waiting ? n : null;
}

/** Whether the town would grow bigger than it may till its next landmark opens (as the sim's landmarkShort). */
export function heldBack(s: Snapshot | null): boolean {
  const t = s?.town;
  return !!t && t.cap !== null && t.target > t.cap;
}

/** How far today's (or so far's) deliveries are: "10/12". */
export function goalCount(n: NextLandmark): string {
  return `${count(Math.min(n.have, n.need))}/${count(n.need)}`;
}

/** The town's next landmark as a card: what it asks, how far today's deliveries are, and what is missing. */
export function TownGoalCard() {
  const s = snapshot.value;
  const n = workingTowards(s);
  if (!s?.town || !n) return null;
  const held = heldBack(s);
  return (
    <div class={`card town-goal ${held ? 'held' : ''}`}>
      <div class="card-head">
        <strong>Town goal: {n.name.toLowerCase()}</strong>
        {held && <span class="badge bad">{s.town.name} waits on it</span>}
      </div>
      <p>
        {n.aim}.
        {held &&
          ` ${s.town.name} can grow no bigger till it opens, and the port grows with the town.`}
      </p>
      <div class="req">
        <span>{n.days ? 'Today' : 'So far'}</span>
        <Meter value={n.need > 0 ? n.have / n.need : 1} tone={n.have >= n.need ? 'good' : 'ok'} />
        <span class="req-value">
          {count(Math.min(n.have, n.need))} / {count(n.need)}
        </span>
      </div>
      {n.days && (
        <div class="req">
          <span>Days running</span>
          <Meter value={n.days.done / n.days.need} tone="ok" />
          <span class="req-value">
            {n.days.done} / {n.days.need}
          </span>
        </div>
      )}
      {n.hint && <p class="note bad">{n.hint}.</p>}
      <button
        class="link"
        onClick={() => {
          panel.value = null;
          selection.value = { type: 'town' };
        }}
      >
        See the town ›
      </button>
    </div>
  );
}
