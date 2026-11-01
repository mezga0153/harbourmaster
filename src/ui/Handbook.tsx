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
  | 'land'
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
            <b>Moved on</b> to a truck bay or storage: carried there by dockhands, or swung into
            storage by a jib crane. Forklifts move crates on from storage the trucks cannot reach. A
            new port has no truck bay yet: the dockhands heap up to {B.PILE_CRATES} crates at the
            road&apos;s end for the pickups, and truck bays open once {B.BAY_UNLOCK_CRATES} have
            come ashore.
          </li>
          <li>
            <b>Waits</b> in the bay or storage. Containers, and crates of timber and goods, also
            wait for customs.
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
            Coasters need a quay two tiles wide in {B.COASTER_DRAFT} m of water. They bring a lot:
            mark out crate storage near their berths, for cargo coming in and going out, or the
            dockhands carry every crate a long way.
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
          The harbour master sends boats to a berth under a jib crane first, if it has room in crate
          storage in its reach. With no dockhands at all, boats wait at anchor for one. A boat kept
          waiting costs demurrage, and one kept too long leaves with its cargo. Buoys mark the ways
          in and out, so boats keep out of each other's way.
        </p>
      </>
    ),
  },
  dockhands: {
    title: 'Dockhands',
    body: () => (
      <>
        <p>
          Dockhands lift cargo off the boats, the only staff who can, and carry each crate straight
          into crate storage or a truck bay: never down on the quay. With nowhere in reach with
          room, the boat waits, and says why. Crate storage marked out near the berths keeps their
          walk short.
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
          <b>Jib cranes</b> stand on a quay edge and lift crates off a boat lying under them,
          swinging them straight into crate storage for cargo coming in marked out right next to
          them, in the machines-only ground round them. Storage marked out further than that is in
          reach only on the tiles right beside the crane: it swings crates onto those alone, and
          waits once they are full, however much room the rest has. They never set crates down at
          their feet: one with no such storage next to it, or all of it full, unloads nothing, and
          has a red mark over it until it has some.
        </p>
        <p>
          <b>Harbour cranes</b> lift containers off feeder ships onto a small stack beside them, for
          reach stackers. They are slow, but several can work one ship.
        </p>
        <p>
          <b>Gantry cranes</b> stand on 2×2 of quay and run on rails along it, lifting containers
          quickly onto the quay at the shipside along their rails, {B.GANTRY_STACK} at most. Reach
          stackers collect from there, from the quay behind, and they lift them straight onto
          terminal tractors waiting under them.
        </p>
        <p>
          <b>Yard gantries</b> span a container yard from beside it and lift containers on and off
          the trucks there, so the reach stackers do not have to.
        </p>
        <p>
          The ground round every crane is for port machines only: no dockhands, no hauliers' trucks.
          Placing or selecting a crane shows it in red; a jib crane's storage goes there too.
        </p>
      </>
    ),
  },
  machines: {
    title: 'Forklifts and reach stackers',
    body: () => (
      <>
        <p>
          Machines live at a depot, {B.DEPOT_SLOTS} to a depot (a reach stacker takes two of the
          places), where they refuel, are repaired and park, side by side inside. They drive only on
          port roads and quays: never on wooden jetties, port paths or public roads.
        </p>
        <p>
          <b>Forklifts</b> carry {B.FORKLIFT_CAPACITY} crates a trip, but cannot unload boats. They
          empty crate storage the trucks cannot reach, like that by a jib crane, to a truck bay or
          storage they can, bring exports to storage by a jib crane, and load crate trucks: by hand
          a truck takes one layer of crates, the far side first, while forklifts set a second on
          top, two crates along a side at a time, only on a whole layer.
        </p>
        <p>
          <b>Reach stackers</b> take containers from the harbour and gantry cranes to the container
          yards.
        </p>
        <p>
          <b>Terminal tractors</b> carry containers between the cranes and yards with a gantry. With
          a trailer behind, they cannot turn about on a road: only at a depot, under a crane, or in
          the lane under a gantry. Elsewhere they go on round, so give them a way round. Once a
          crane or gantry has a tractor's container up, the tractor goes on its way.
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
          Storage is inside the port, so trucks load from beside it, never in it, on a port road or
          quay they reach through a port gate: never from a public road outside, even one right
          beside it. Nor beside storage on machines-only ground, round a crane or marked so: only
          the port's own machines work that. One truck loads at a time for every{' '}
          {B.STORE_TILES_PER_TRUCK} tiles. Marking out or selecting storage shows where, in yellow.
        </p>
        <p>
          Cargo coming in and cargo going out are kept apart: storage is marked out for one or the
          other, <b>in</b> or <b>out</b>, and the out kind is outlined in blue. Storage by a crane
          is no different: mark it out for the way you want it to work. When every outgoing area is
          full, shippers' trucks wait in parking until there is room.
        </p>
        <p>
          Select storage and press <b>Stop taking</b> to let it empty out: nothing new is brought to
          it, while the trucks, or the ships for an outgoing area, go on taking what is in it. Use
          it before moving or rebuilding an area, so nothing is lost with it.
        </p>
        <p>
          Mark out crate storage for cargo coming in, and for cargo going out, on the quay right by
          the berths: dockhands carry every crate off a boat themselves, a few steps there rather
          than across the port, and boats unload about twice as fast. Trucks load beside it, or
          forklifts move the crates on to the truck bays.
        </p>
        <p>
          Storage beside a jib crane fills straight from the boats, on the tiles right beside the
          crane. Where trucks cannot reach it, forklifts take its crates on; and once those tiles
          are full, forklifts move crates off them first, to make the crane room.
        </p>
        <p>
          <b>Customs and export papers.</b> Lines landing timber, goods or containers, and shippers
          sending crates of goods and the cannery, cannot be signed till the port has a customs
          office (Port buildings): one does for the whole port. Crates of timber and goods off the
          coasters go into crate storage for cargo coming in, never a truck bay nor straight onto a
          truck, and wait there about {hours(B.CRATE_CUSTOMS_TICKS)} hours for customs before a
          truck may take them. Crates of goods and canned fish going out wait in the outgoing
          storage about {hours(B.EXPORT_PAPERS_TICKS)} hours to be inspected before they may go on
          board. Fish, lobster and ice are fresh and go at once. Crates still waiting have a slip of
          paper under a red seal on the lid; select storage to see how many wait and when the next
          clear. A busy Coastal Wharf needs room for a day of the coasters' timber and goods: when
          the storage is full of crates in customs, the coasters cannot be unloaded.
        </p>
      </>
    ),
  },
  trucks: {
    title: 'Trucks and hauliers',
    body: () => (
      <>
        <p>
          Hauliers' trucks come in off the highway down the west edge of the map, at its nearer end,
          and turn off at the exit nearest where they are going. They drive on along public roads,
          and onto port roads only through a port gate. They load at truck bays and beside storage,
          and you are paid as each one leaves.
        </p>
        <ul>
          <li>
            Out on the highway trucks drive fast and pass through each other, so it never jams. From
            the {TIERS[B.EXIT_TIER].name} you can open more exits off it, to bring trucks in nearer
            where they load: build a public road up to it, or use the exit tool.
          </li>
          <li>
            A truck that leaves the map is away on its round for about {hours(B.TRUCK_ROUND_TRIP)} h
            before its haulier can send it again, so the size of the fleet matters.
          </li>
          <li>
            At the {TIERS[0].name} hauliers send pickups ({B.PICKUP_CAPACITY} crates): they never
            back into a truck bay, but pull up on the road beside it, or beside storage, and
            dockhands load them by hand over the side. From the {TIERS[1].name} they send small
            trucks ({B.TRUCK_CAPACITY} crates a layer) instead, which back into the bays and
            forklifts load too, two layers high.
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
          <b>Truck parking</b> is marked out on a road you have built: a strip of it one or two
          tiles wide, with road left all along both its long sides. Trucks drive in off one side,
          park at an angle across the strip, and drive out the other side: always forwards, never
          backing out. There is a space for each tile along the strip, and the big trucks need a
          strip two tiles wide. On public road it is outside the port: shippers' trucks wait there
          for their paperwork. On port road, behind a gate, it is inside: trucks queue there for a
          free loading spot instead of going away. Select parking to see whether it works, and why
          not; unmark it to have the road back.
        </p>
        <p>
          <b>Junctions.</b> Where roads meet, trucks give way to those on the bigger road, and on
          roads alike to those coming from their right. From the {TIERS[B.ONE_WAY_TIER].name}:{' '}
          <b>one-way roads</b>, which trucks never drive against nor turn round on, and traffic
          going on along one has the right of way over traffic joining it; and <b>one-way gates</b>,
          so trucks come in by one gate and leave by another. From the {TIERS[B.LIGHTS_TIER].name}:{' '}
          <b>traffic lights</b>, which let each way through in turn, and <b>roundabouts</b>, a ring
          of one-way road round an island, where trucks coming on give way to those already going
          round. Port machines keep to none of these: they go where they need to inside the port.
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
          A feeder line needs a customs office in the port before it may be signed. Customs start on
          a ship's containers once the whole ship has been unloaded, and clear them about{' '}
          {hours(B.CUSTOMS_TICKS)} hours later. Until then they wait in the yard, and no truck may
          take them. Yards hold a ship's load and a day of traffic: when they fill, the stackers
          stop, then the cranes, and ships wait. Select a yard to see what is in customs and when
          the next one clears.
        </p>
        <p>
          Every container is moved by machine. Reach stackers bring them from the cranes to the
          yard, and, unless a <b>yard gantry</b> stands beside the yard, lift them onto the trucks
          too, and off the shippers' trucks: twice the work for the stackers. A yard gantry spans
          the yard from a port road or quay tile beside it and does the trucks itself. A reach
          stacker with nothing else to do restacks a yard where containers still in customs lie on
          cleared ones, moving them onto other stacks so the trucks can get at those. Trucks and
          tractors load all along the lane its rails run beside, which is one way for trucks: in at
          the end nearer the highway, out at the other, queueing along it behind each other. A
          longer yard along the lane gives more spots.
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
        <p>Before signing one, the port needs, step by step:</p>
        <ol>
          <li>
            Truck parking outside the port, where its trucks wait: marked out on a public road, a
            strip one or two tiles wide with road along both its long sides for them to drive across
            it. Without it no truck comes.
          </li>
          <li>
            A port gate where a port road meets the public road, and port roads or quays inside it
            on to the storage, for the trucks to drive in on. Machines-only ground is no use to
            them.
          </li>
          <li>
            Storage marked out for cargo going out, beside those port roads: crate storage for
            crates, a container yard for containers. Its trucks unload into it.
          </li>
          <li>
            A shipping line whose ships call to take it out: coasters for crates, feeders for
            containers. Until one does, the cargo waits in storage.
          </li>
        </ol>
        <p>
          Whatever is missing shows as a red mark on the map, where the trucks come off the highway
          or over the storage they cannot get to, and in red on the shipper's contract. Then:
        </p>
        <ol>
          <li>
            A shipper's truck of containers parks outside the port, on parking joined to a public
            road, for about {hours(B.PAPERWORK_TICKS)} hours of paperwork. With nowhere to park, it
            does not come. Trucks of crates, goods or the cannery's canned fish, park only to wait
            their turn: their crates are inspected in the outgoing storage instead, about{' '}
            {hours(B.EXPORT_PAPERS_TICKS)} hours, before they may go on board.
          </li>
          <li>
            Then it drives in and is unloaded into crate storage or a container yard: crates by
            dockhands or forklifts, containers by the yard's gantry or a reach stacker. While every
            spot there is taken, it moves to parking nearer the storage, inside the port where there
            is some, to be there the moment one comes free.
          </li>
          <li>
            A coaster or feeder that has unloaded stays to take on the exports waiting for it.
            Loading counts against its time alongside like unloading does: slow loading costs
            demurrage and goodwill, and kept too long it sails with what it has.
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
            Boats served promptly keep a company happy. Each is allowed time for what it unloads and
            the exports it takes on; kept waiting at anchor, or longer than that alongside, the
            company charges demurrage ({money(B.DEMURRAGE_PER_DAY)} a day a boat), and an unhappy
            company walks out and claims a breach penalty.
          </li>
          <li>
            The bank lends up to {money(B.LOAN_MAX)}. After {B.BANKRUPT_DAYS} days in the red it
            closes the port.
          </li>
        </ul>
      </>
    ),
  },
  land: {
    title: 'The port’s land',
    body: () => (
      <>
        <p>
          The port builds only on land and water it owns, in plots of {B.PLOT_SIZE} by {B.PLOT_SIZE}{' '}
          tiles. A new port owns only the plots under its first jetty and the end of the road in.
          Anything built, dredged, filled in, marked out or cleared needs its plot owned; boats and
          trucks pass through the rest, and the public roads, the highway and the railway already
          there are free to use.
        </p>
        <ul>
          <li>
            Pick up Land in the bar at the bottom: plots for sale are outlined in yellow with their
            price, the land beyond them shaded. Click one to buy it. With any other tool in hand,
            the land the port does not own is faintly shaded.
          </li>
          <li>
            Only a plot beside one the port owns can be bought, so the port grows outwards. The
            first costs {money(B.PLOT_PRICE)}, and each after it{' '}
            {Math.round((B.PLOT_PRICE_RISE - 1) * 100)}% more than the one before:{' '}
            {money(Math.round((B.PLOT_PRICE * B.PLOT_PRICE_RISE ** 4) / 100) * 100)} for the fifth,{' '}
            {money(Math.round((B.PLOT_PRICE * B.PLOT_PRICE_RISE ** 9) / 100) * 100)} for the tenth.
          </li>
          <li>
            A plot all of sea is a seabed lease from the harbour authority, for{' '}
            {Math.round(B.SEA_PLOT_SHARE * 100)}% of the price of land: room for jetties, quays,
            buoys and dredging.
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
          The port grows with the town up the coast. Once enough people live there, the harbour
          authority lets you upgrade the port in the Port panel, for a fee. Jobs at the port, and
          goods trucked out and delivered to the town's businesses, make the town grow; see the Town
          panel. Each step unlocks more:
        </p>
        {TIERS.map((t) => (
          <p key={t.name}>
            <b>{t.name}</b>
            {t.town > 0 ? ` (a town of ${t.town.toLocaleString('en-US')})` : ''}
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
