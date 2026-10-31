import * as B from '../sim/balance';
import { TICKS_PER_DAY } from '../sim/types';
import { advice, openHandbook } from './store';
import { Icon } from './icons';

interface Tip {
  title: string;
  text: string;
  /** The handbook page with more. */
  topic: string;
}

const hours = (ticks: number) => Math.round((ticks * 24) / TICKS_PER_DAY);

/**
 * What the advisor says the first time each thing comes up in a game. The
 * sim decides when (see World.tip); this is what is said.
 */
const TIPS: Record<string, Tip> = {
  welcome: {
    title: 'Welcome, harbourmaster',
    text: 'Boats bring crates to your jetty. Dockhands lift them off and carry them to the truck bay, and hauliers’ trucks take them away: you are paid as each truck leaves. Select anything to see what it is doing.',
    topic: 'start',
  },
  hut: {
    title: 'Somewhere to rest',
    text: 'A dockhand is tired. With nowhere to rest they sit down where they are, which is slow and bad for morale. Build a break hut near the jetty: Facilities, then Break hut (K).',
    topic: 'dockhands',
  },
  speed: {
    title: 'Speeding things up',
    text: 'The first boat has gone. Waiting for the next? Speed the game up with 2×, 4× and 8× at the top (keys 1 to 4), and pause it with Space.',
    topic: 'start',
  },
  jetty: {
    title: 'Another jetty',
    text: 'One jetty takes one boat at a time, and the rest wait at anchor, which the companies charge for. Build another out into water deep enough: Docks, then Jetty (J), with a port path to it from the truck bay.',
    topic: 'boats',
  },
  contract: {
    title: 'More business',
    text: 'More fisheries and shipping lines would send boats here. Open Contracts (C) to see the offers: each costs a signing fee, so mind there are dockhands and berths enough for the boats it sends.',
    topic: 'money',
  },
  screens: {
    title: 'Keeping the books',
    text: 'Click your cash at the top, or Finance (M), for what the port earns and spends each day and the bank’s loans. Statistics, beside it, shows where the crates are held up between the boats and the trucks.',
    topic: 'money',
  },
  pallets: {
    title: 'Crates on pallets',
    text: 'Coasters bring their crates on pallets. Dockhands lift them off onto the quay, where only forklifts take them on; a jib crane swings them straight into crate storage instead.',
    topic: 'boats',
  },
  cranes: {
    title: 'Machines only round a crane',
    text: `The ground round a crane, shown in red, is for port machines only: dockhands and the hauliers’ trucks keep off. A jib crane swings crates only into crate storage for cargo coming in right next to it, in that red ground: mark some out there, or it unloads nothing. What a container crane lands, reach stackers take on.`,
    topic: 'cranes',
  },
  forklifts: {
    title: 'Forklifts',
    text: `Forklifts carry ${B.FORKLIFT_CAPACITY} crates a trip but cannot unload boats. Dockhands set crates down on the quay for them, and the forklifts take them on to the bays and storage, and empty storage by a jib crane that the trucks cannot reach.`,
    topic: 'machines',
  },
  stackers: {
    title: 'Reach stackers',
    text: 'Reach stackers take containers from the harbour and gantry cranes to a container yard. They drive only on port roads and quays.',
    topic: 'machines',
  },
  tractors: {
    title: 'Terminal tractors',
    text: 'Terminal tractors carry containers between the harbour and gantry cranes and the container yards with a yard gantry, which lifts them off and on. They cannot lift a container themselves, so yards without a gantry still need reach stackers.',
    topic: 'machines',
  },
  landed: {
    title: 'Cargo landed on the quay',
    text: 'With forklifts about, dockhands set what they lift off a boat down on the quay beside it, and the forklifts take it on four at a time.',
    topic: 'dockhands',
  },
  storage: {
    title: 'Crate storage',
    text: `Trucks load from inside the port, on a port road or quay beside storage, shown in yellow, one at a time for every ${B.STORE_TILES_PER_TRUCK} tiles. A jib crane right next to it fills it straight from the boats; where no truck can get to it, forklifts take its crates on. Storage is for cargo coming in or going out, never both.`,
    topic: 'storage',
  },
  yardGantry: {
    title: 'Yard gantry',
    text: 'A yard gantry spans the container yard beside it and lifts containers on and off the trucks there, so the reach stackers only have to bring them from the cranes.',
    topic: 'containers',
  },
  yards: {
    title: 'Container yards',
    text: 'Reach stackers bring containers here from the cranes, and container trucks load from inside the port, beside the yard, shown in yellow, once customs have cleared them. Without a yard gantry, the stackers lift them onto the trucks too.',
    topic: 'storage',
  },
  customs: {
    title: 'Customs',
    text: `Customs start on a ship's containers once the whole ship is unloaded, and clear them about ${hours(B.CUSTOMS_TICKS)} hours later. Until then they wait in the yard. Build yards to hold that much: when they fill, the cranes stop.`,
    topic: 'containers',
  },
  crateCustoms: {
    title: 'Customs on timber and goods',
    text: `Crates of timber and goods off the coasters go into crate storage, and wait there about ${hours(B.CRATE_CUSTOMS_TICKS)} hours for customs before a truck may take them; they never go straight onto a truck. Fish and lobster are fresh and go at once. Mark out enough crate storage for cargo coming in to hold a day of them: when it is full, the coasters cannot be unloaded.`,
    topic: 'storage',
  },
  papers: {
    title: 'Export papers',
    text: `The cannery's canned fish waits in the outgoing crate storage about ${hours(B.EXPORT_PAPERS_TICKS)} hours for its export papers before it may go on board, so a coaster takes only what is ready. Give the outgoing storage room for half a day of it, or the cannery's trucks wait outside with their loads.`,
    topic: 'exports',
  },
  noHands: {
    title: 'Nobody to unload by hand',
    text: 'With no dockhands, boats only take berths under a jib crane with room in crate storage in its reach, and wait at anchor for one. Hire dockhands, mark out more storage by the cranes, or build more jib cranes.',
    topic: 'boats',
  },
  roundTrip: {
    title: 'Trucks on their rounds',
    text: `A truck that leaves is away about ${hours(B.TRUCK_ROUND_TRIP)} hours before its haulier can send it again, so cargo waits in the bays and storage meanwhile. More trucks, or bigger ones, take more away.`,
    topic: 'trucks',
  },
  parking: {
    title: 'Parking for the shippers',
    text: `A shipper's trucks park outside the port for about ${hours(B.PAPERWORK_TICKS)} hours of paperwork before they come in. Mark truck parking out on a public road: a strip of it one or two tiles wide, with road left along both sides for trucks to drive across it, or they do not come.`,
    topic: 'exports',
  },
  exports: {
    title: 'Exports',
    text: 'The shippers’ goods wait in storage for a ship. Coasters and feeders that have unloaded take them on board before they leave, and the shipper pays as each goes on.',
    topic: 'exports',
  },
  machinesOnly: {
    title: 'Machines only',
    text: 'People on foot and the hauliers’ trucks keep off ground marked for machines, outlined in red, so forklifts do not queue behind dockhands. Mind that dockhands can still get to the boats.',
    topic: 'machinesOnly',
  },
  exits: {
    title: 'A new highway exit',
    text: 'Trucks come in off whichever end of the highway is nearer and take the exit nearest where they are going, so an exit beside a busy yard takes them off the port’s own roads. Out on the highway they drive fast and pass through each other: it never jams.',
    topic: 'trucks',
  },
  oneWay: {
    title: 'One-way roads',
    text: 'Trucks never drive against the arrows, nor turn round on a one-way road, but may turn into and out of it. Going on along a one-way road they have the right of way over trucks joining it, so a loop of one-way road keeps traffic moving.',
    topic: 'trucks',
  },
  lights: {
    title: 'Traffic lights',
    text: 'Trucks going north and south, then east and west, take turns on green, with all red in between to clear the junction. Lights help where a junction is busy every way; where one road is far busier, a roundabout or one-way roads may do better.',
    topic: 'trucks',
  },
  roundabout: {
    title: 'Roundabouts',
    text: 'Trucks go round anticlockwise, keeping right, and those coming onto it give way to those already on it. A truck that has to turn about can go round it, rather than finding somewhere wide enough to turn.',
    topic: 'trucks',
  },
  restaurant: {
    title: 'The seafood restaurant',
    text: 'Visitors come for the seafood, and the town may grow to 400. Once it has 300 people, upgrade the port to a Coastal Wharf in the Port panel (P): the town’s next landmark, a cannery, wants more fish than fishing boats bring, 30 crates a day for 2 days running, and only coasters at a quay bring that much.',
    topic: 'growth',
  },
  cannery: {
    title: 'The cannery',
    text: 'The town has its cannery, and may grow to 500. The cannery’s offer is on the contracts board: its trucks bring canned fish to the port, to go out on the coasters. Next it wants a builders’ yard: put 25 crates of canned fish on board ships. The trucks need parking outside the port and crate storage for exports.',
    topic: 'growth',
  },
  buildersYard: {
    title: 'The builders’ yard',
    text: 'The builders’ yard is open: the town may grow to 600, and now builds flats. Valley Timber Co. offers its coasters of timber for the yard. Next the town wants a school: truck out 25 crates of timber.',
    topic: 'growth',
  },
  school: {
    title: 'The school',
    text: 'Families settle round the new school, the town may grow to 700, and a department store opens. A shipping line offers coasters of goods for it. Next the town wants a town hall: truck out 60 crates of goods.',
    topic: 'growth',
  },
  townHall: {
    title: 'The town hall',
    text: 'The town has its charter, and may grow on past 800 people: then the harbour authority lets the port become a Container Port. See the Port panel (P).',
    topic: 'growth',
  },
  land: {
    title: 'The port’s land',
    text: `The port builds only on land it owns. Pick up Land in the bar at the bottom: plots beside yours are outlined with their price, and a click buys one. Each plot costs ${Math.round((B.PLOT_PRICE_RISE - 1) * 100)}% more than the last; a plot all of sea, less.`,
    topic: 'land',
  },
  tier1: {
    title: 'Coastal Wharf',
    text: 'Quays reach deeper water for coasters, forklifts and jib cranes speed up the work, and storage can be marked out on port roads and quays.',
    topic: 'machines',
  },
  tier2: {
    title: 'Container Port',
    text: 'Feeder ships bring containers. Cranes lift them, reach stackers take them to container yards, and after customs, container trucks take them away.',
    topic: 'containers',
  },
};

/** The advisor's card, one tip at a time, until each is read. */
export function Advisor() {
  const id = advice.value.find((t) => t in TIPS);
  if (!id) return null;
  const tip = TIPS[id];
  const done = () => (advice.value = advice.value.filter((t) => t !== id));
  return (
    <div class="advisor panel" role="status">
      <div class="advisor-head">
        <Icon name="book" />
        <span class="kicker">Advisor</span>
        {advice.value.length > 1 && <span class="muted">{advice.value.length - 1} more</span>}
      </div>
      <strong>{tip.title}</strong>
      <p>{tip.text}</p>
      <div class="actions">
        <button
          class="btn"
          onClick={() => {
            openHandbook(tip.topic);
            done();
          }}
        >
          Read more
        </button>
        <button class="btn primary" onClick={done}>
          Got it
        </button>
      </div>
    </div>
  );
}
