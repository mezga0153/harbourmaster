import type { ComponentChildren } from 'preact';
import * as B from '../sim/balance';
import { TIERS } from '../sim/tiers';
import { TICKS_PER_DAY } from '../sim/types';
import { money } from './format';
import { handbookTopic, panel } from './store';
import { InfoHeader } from './widgets';

/** Game hours, from ticks. */
function hours(ticks: number): number {
  return Math.round((ticks * 24) / TICKS_PER_DAY);
}

export type TopicId =
  | 'start'
  | 'boats'
  | 'dockhands'
  | 'cranes'
  | 'machines'
  | 'machinesOnly'
  | 'storage'
  | 'trucks'
  | 'containers'
  | 'exports'
  | 'money'
  | 'growth';

interface Topic {
  title: string;
  body: () => ComponentChildren;
}

/**
 * The harbour handbook: how the port works, a page per topic. Numbers come
 * from the balance settings, so the pages stay true as the game is tuned.
 */
export const TOPICS: Record<TopicId, Topic> = {
  start: {
    title: 'How the port works',
    body: () => (
      <>
        <p>Every crate and container goes the same way, from boat to truck:</p>
        <ol>
          <li>
            <b>Lifted off the boat</b> by dockhands or a crane.
          </li>
          <li>
            <b>Moved on</b> to a truck bay or storage: carried by dockhands, or landed on the quay
            for forklifts to take.
          </li>
          <li>
            <b>Waits</b> in the bay or storage. Containers also wait for customs.
          </li>
          <li>
            <b>Trucked away</b> by the hauliers you sign. You are paid when a truck leaves with it.
          </li>
        </ol>
        <p>
          The Contracts panel shows how much each step can handle a day and which one holds things
          up. Select anything on the map to see what it is doing, and why when it is stuck.
        </p>
      </>
    ),
  },
  boats: {
    title: 'Boats and berths',
    body: () => (
      <>
        <p>
          Boats moor alongside jetties and quays. Wooden jetties go out to {B.MAX_JETTY_DEPTH} m of
          water; quays to {B.MAX_QUAY_DEPTH} m, and dredging digs deeper still.
        </p>
        <ul>
          <li>Fishing boats fit any berth.</li>
          <li>
            Coasters need a quay two tiles wide in {B.COASTER_DRAFT} m of water. Their crates come
            on pallets, which only forklifts take on from the quay.
          </li>
          <li>
            Feeder ships need a harbour or gantry crane on a quay two tiles wide in {B.FEEDER_DRAFT}{' '}
            m of water.
          </li>
        </ul>
        <p>
          Up to {B.FREE_DOCKS} jetties work on their own. Any more, and every quay, need a harbour
          office: each one coordinates {B.DOCKS_PER_OFFICE} docks.
        </p>
        <p>
          The harbour master sends boats to a berth under a jib crane first. With no dockhands at
          all, boats wait at anchor for one. A boat kept waiting costs demurrage, and one kept too
          long leaves with its cargo. Buoys mark the ways in and out, so boats keep out of each
          other's way.
        </p>
      </>
    ),
  },
  dockhands: {
    title: 'Dockhands',
    body: () => (
      <>
        <p>
          Dockhands lift cargo off the boats, the only staff who can. With forklifts about they set
          it down on the quay beside the boat for the forklifts, which is quick. Without, they carry
          it all the way to a truck bay or storage.
        </p>
        <ul>
          <li>They walk on port paths, port roads, jetties and quays, never grass or roads.</li>
          <li>
            They keep off machines-only ground, including the ground round every crane, so a boat
            under a crane is the crane's to unload.
          </li>
          <li>
            They tire and need breaks: a break hut seats {B.HUT_SLOTS}. Unhappy dockhands ask for
            raises, and quit if they stay miserable.
          </li>
          <li>Narrow walkways get crowded: wider jetties and more berths help.</li>
        </ul>
      </>
    ),
  },
  cranes: {
    title: 'Cranes',
    body: () => (
      <>
        <p>
          <b>Jib cranes</b> stand on a quay edge and lift crates off a boat lying under them. If
          crate storage is marked out within {B.JIB_REACH} tiles they swing the crates straight into
          it; otherwise onto a landing stack of {B.CRANE_STACK} for forklifts.
        </p>
        <p>
          <b>Harbour cranes</b> lift containers off feeder ships onto a small stack beside them, for
          reach stackers. They are slow, but several can work one ship.
        </p>
        <p>
          <b>Gantry cranes</b> stand on 2×2 of quay and lift containers quickly into the bay between
          their legs, {B.GANTRY_STACK} at most. Only reach stackers collect from there.
        </p>
        <p>
          <b>Yard gantries</b> span a container yard from beside it and lift containers on and off
          the trucks there, so the reach stackers do not have to.
        </p>
        <p>
          The ground round every crane is for port machines only: no dockhands, no hauliers' trucks.
          Placing or selecting a crane shows it in red, and a jib crane's reach in blue.
        </p>
      </>
    ),
  },
  machines: {
    title: 'Forklifts and reach stackers',
    body: () => (
      <>
        <p>
          Machines live at a depot, {B.DEPOT_SLOTS} to a depot, where they refuel, are repaired and
          park. They drive only on port roads and quays: never on wooden jetties, port paths or
          public roads.
        </p>
        <p>
          <b>Forklifts</b> carry {B.FORKLIFT_CAPACITY} crates a trip, but cannot unload boats. They
          take what dockhands land on the quay and what jib cranes stack, and empty crate storage
          the trucks cannot reach, to a truck bay or storage they can.
        </p>
        <p>
          <b>Reach stackers</b> take containers from the harbour and gantry cranes to the container
          yards.
        </p>
        <p>Select a machine or a depot to see everywhere it can drive.</p>
      </>
    ),
  },
  machinesOnly: {
    title: 'Machines-only ground',
    body: () => (
      <>
        <p>
          Port roads and quays can be marked for port machines only ({money(B.FORKLIFT_ONLY_COST)} a
          tile), outlined in red. People on foot and the hauliers' trucks keep off, so forklifts do
          not queue behind dockhands.
        </p>
        <p>
          The ground round every crane is machines-only too, without marking. Boats are only sent to
          berths someone can unload: by hand from ground dockhands may stand on, or by a crane.
        </p>
      </>
    ),
  },
  storage: {
    title: 'Storage areas',
    body: () => (
      <>
        <p>
          Drag out an area on port roads or quays to store cargo. Touching tiles of one kind make
          one area.
        </p>
        <ul>
          <li>
            <b>Crate storage</b> holds {B.CRATES_PER_STORE_TILE} crates a tile (
            {money(B.CRATE_STORE_COST)} a tile).
          </li>
          <li>
            <b>Container yards</b> hold {B.BOXES_PER_STORE_TILE} containers a tile (
            {money(B.BOX_STORE_COST)} a tile).
          </li>
        </ul>
        <p>
          Trucks load from beside an area, never inside it: from a public road, or from a port road
          or quay behind a port gate. One truck loads at a time for every {B.STORE_TILES_PER_TRUCK}{' '}
          tiles. Marking out or selecting storage shows where, in yellow.
        </p>
        <p>
          Cargo coming in and cargo going out are kept apart: storage is marked out for one or the
          other, <b>in</b> or <b>out</b>, and the out kind is outlined in blue. The exception is
          storage by a crane, on its machines-only ground, which loads and unloads: it takes cargo
          either way, but one way at a time, and must be emptied before it switches.
        </p>
        <p>
          Storage beside a jib crane fills straight from the boats. Where trucks cannot reach it,
          forklifts take its crates on.
        </p>
      </>
    ),
  },
  trucks: {
    title: 'Trucks and hauliers',
    body: () => (
      <>
        <p>
          Hauliers' trucks come in from the highway along public roads, and onto port roads only
          through a port gate. They load at truck bays and beside storage, and you are paid as each
          one leaves.
        </p>
        <ul>
          <li>
            A truck that leaves is away on its round for about {hours(B.TRUCK_ROUND_TRIP)} h before
            its haulier can send it again, so the size of the fleet matters.
          </li>
          <li>
            Big trucks ({B.BIG_TRUCK_CAPACITY} crates) only fit a large truck bay or crate storage.
          </li>
          <li>Container trucks only take containers, from container yards.</li>
          <li>
            Trucks bound for the town's shops and works drop part of their load there, for a bonus.
          </li>
        </ul>
        <p>
          <b>Truck parking</b> is a strip one or two tiles wide with a road all along both its long
          sides. Trucks drive in off one road, park at an angle across the strip, and drive out onto
          the other road: always forwards, never backing out. There is a space for each tile along
          the strip, and the big trucks need a strip two tiles wide. Between public roads it is
          outside the port: shippers' trucks wait there for their paperwork. Between port roads,
          behind a gate, it is inside: trucks queue there for a free loading spot instead of going
          away. Select parking to see whether it works, and why not.
        </p>
      </>
    ),
  },
  containers: {
    title: 'Containers and customs',
    body: () => (
      <>
        <p>
          Feeder ships bring containers. Cranes lift them off, reach stackers take them to a
          container yard, and container trucks collect them.
        </p>
        <p>
          Customs start on a ship's containers once the whole ship has been unloaded, and clear them
          about {hours(B.CUSTOMS_TICKS)} hours later. Until then they wait in the yard, and no truck
          may take them. Yards hold a ship's load and a day of traffic: when they fill, the stackers
          stop, then the cranes, and ships wait. Select a yard to see what is in customs and when
          the next one clears.
        </p>
        <p>
          Every container is moved by machine. Reach stackers bring them from the cranes to the
          yard, and, unless a <b>yard gantry</b> stands beside the yard, lift them onto the trucks
          too, and off the shippers' trucks: twice the work for the stackers. A yard gantry spans
          the yard from a port road or quay tile beside it and does the trucks itself.
        </p>
      </>
    ),
  },
  exports: {
    title: 'Exports',
    body: () => (
      <>
        <p>
          Shippers send goods in by truck to go out on the ships: crates on the coasters, containers
          on the feeders. They pay for each crate or container as it goes on board.
        </p>
        <ol>
          <li>
            A shipper's truck parks outside the port, on parking joined to a public road, for about{' '}
            {hours(B.PAPERWORK_TICKS)} hours of paperwork. With nowhere to park, it does not come.
          </li>
          <li>Then it drives in and unloads into crate storage or a container yard.</li>
          <li>
            A coaster or feeder that has unloaded stays to take exports on board, until it is full
            or nothing more comes for a while.
          </li>
        </ol>
        <p>
          Dockhands carry crates on board; forklifts bring them from storage to the quay beside the
          ship for the dockhands, and jib cranes lift them on from storage within reach. Reach
          stackers take containers to the crane over the feeder, which lifts them on board.
        </p>
      </>
    ),
  },
  money: {
    title: 'Contracts and money',
    body: () => (
      <>
        <p>
          Fisheries and shipping lines send boats; hauliers take the cargo away for a daily fee.
          Each contract costs a signing fee.
        </p>
        <ul>
          <li>
            Boats served promptly keep a company happy. Kept waiting, it charges demurrage (
            {money(B.DEMURRAGE_PER_DAY)} a day a boat), and an unhappy company walks out and claims
            a breach penalty.
          </li>
          <li>
            The bank lends up to {money(B.LOAN_MAX)}. After {B.BANKRUPT_DAYS} days in the red it
            closes the port.
          </li>
        </ul>
      </>
    ),
  },
  growth: {
    title: 'Growing the port',
    body: () => (
      <>
        <p>
          Upgrade the port in the Port panel once it has handled enough crates and holds enough
          contracts. Each step unlocks more:
        </p>
        {TIERS.map((t) => (
          <p key={t.name}>
            <b>{t.name}</b>
            {t.comingSoon ? ' (coming later)' : ''}: {t.unlocks.join('; ')}.
          </p>
        ))}
      </>
    ),
  },
};

export function HandbookPanel() {
  const topic = handbookTopic.value as TopicId;
  const page = TOPICS[topic] ?? TOPICS.start;
  return (
    <aside class="side panel wide handbook" aria-label="Handbook">
      <InfoHeader kicker="Handbook" title={page.title} onClose={() => (panel.value = null)} />
      <nav class="handbook-topics">
        {(Object.keys(TOPICS) as TopicId[]).map((id) => (
          <button
            key={id}
            class={`chip ${id === topic ? 'on' : ''}`}
            onClick={() => (handbookTopic.value = id)}
          >
            {TOPICS[id].title}
          </button>
        ))}
      </nav>
      <div class="handbook-page">{page.body()}</div>
    </aside>
  );
}
