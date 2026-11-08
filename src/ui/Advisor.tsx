import * as B from '../sim/balance';
import { TICKS_PER_DAY } from '../sim/types';
import type { PictureId } from '../render/guides';
import { FlipBook } from './Guide';
import type { GuideId, GuideAction } from './guides';
import type { Snapshot } from '../protocol';
import type { Actions } from './actions';
import { availableAction, runHelpAction } from './learning';
import { advice, openGuide, openHandbook, snapshot } from './store';
import { Icon } from './icons';

interface Tip {
  title: string;
  text: string;
  /** The handbook page with more. */
  topic: string;
  /** A picture of it in use, playing as a flip book (render/guides.ts). */
  picture?: PictureId;
  /** The guide that shows how, step by step, and on which step. */
  guide?: [GuideId, number];
}

const hours = (ticks: number) => Math.round((ticks * 24) / TICKS_PER_DAY);

/**
 * What the advisor says the first time each thing comes up in a game. The
 * sim decides when (see World.tip); this is what is said.
 */
export const TIPS: Record<string, Tip> = {
  welcome: {
    title: 'Welcome, harbourmaster',
    text: 'Your jetty is ready. Dockhands carry crates off the boats, and hauliers—trucking companies—collect them in pickups. You earn money when a loaded truck leaves. Press Space to pause, or try the first-delivery lesson.',
    topic: 'start',
    guide: ['start', 0],
  },
  truckBays: {
    title: 'Truck bays',
    text: `The heap at the road's end holds only ${B.PILE_CRATES} crates, so boats wait while the pickups come and go. You may now build truck bays (Cargo, then Truck bay): each holds ${B.BAY_CAPACITY} crates, beside a road, and the pickups load beside it. The heap is used as long as it stands.`,
    topic: 'start',
  },
  hut: {
    title: 'Somewhere to rest',
    text: 'A dockhand is tired. Build a break hut connected to the jetty by a port path so the crew can rest and recover morale.',
    topic: 'dockhands',
  },
  speed: {
    title: 'Speeding things up',
    text: 'Waiting for the next boat? Keys 1, 2, 3 and 4 set 1×, 2×, 4× and 8× speed. Space pauses and resumes the game.',
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
    text: 'Coasters bring their crates on pallets, and a lot of them. Dockhands carry each straight into crate storage or a truck bay, never setting one down on the quay, so mark out crate storage near the berth; a jib crane swings them straight into storage beside it instead.',
    topic: 'boats',
    picture: 'storage',
  },
  quayStorage: {
    title: 'Storage on the quay',
    text: 'Dockhands spend too long carrying crates away from the boats. Mark incoming crate storage near the berths to shorten their walk. Leave an unmarked lane beside it for trucks.',
    topic: 'storage',
    picture: 'storage',
    guide: ['wharf', 2],
  },
  cranes: {
    title: 'Machines only round a crane',
    text: 'A crane’s red ground is reserved for port machines. For a jib crane, mark incoming crate storage on its blue highlighted tiles, then connect a forklift to move the crates onward.',
    topic: 'cranes',
    picture: 'jib',
    guide: ['jib', 2],
  },
  forklifts: {
    title: 'Forklifts',
    text: 'Forklifts move crates from storage the trucks cannot reach to bays or accessible storage, and load trucks. Connect their depot and both storage areas with port roads or quay. Dockhands or a jib crane unload the boats.',
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
    title: 'Cargo left on the quay',
    text: 'Some crates are waiting on the quay. Connect dockhands or forklifts to move them into storage. Incoming storage near the berth keeps the journey short.',
    topic: 'dockhands',
  },
  storage: {
    title: 'Crate storage',
    text: 'Trucks load beside incoming storage from inside the port. Join the loading lane to a public road through a port gate. Select storage to see its loading spots in yellow.',
    topic: 'storage',
    picture: 'storage',
    guide: ['wharf', 2],
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
  customsOffice: {
    title: 'A customs office',
    text: 'A contract needs a customs office before you can sign it. Build one with its door facing a port path or road. One office handles customs and export inspection for the whole port.',
    topic: 'storage',
  },
  papers: {
    title: 'Export papers',
    text: `Canned fish and goods wait about ${hours(B.EXPORT_PAPERS_TICKS)} game hours in outgoing storage for export inspection. Select the storage to see the countdown. Leave enough room for half a day of arrivals.`,
    topic: 'exports',
  },
  noHands: {
    title: 'Nobody to unload by hand',
    text: 'Boats are waiting because no dockhands can unload them. Hire a dockhand, or provide a jib crane with free incoming storage in reach.',
    topic: 'boats',
  },
  roundTrip: {
    title: 'Trucks on their rounds',
    text: 'The haulier’s trucks are away making deliveries. Cargo waits until they return. Sign another haulier if the fleet cannot keep up with arrivals.',
    topic: 'trucks',
  },
  parking: {
    title: 'Parking for the shippers',
    text: 'Shippers need working parking outside the port. Mark a strip on a public road with road along both long sides. Container trucks wait here for paperwork; canned fish and goods are inspected later in outgoing storage.',
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
    text: 'A new highway exit can bring trucks closer to a busy loading area. Build a public road up to the highway or choose Highway exit, then connect it to your port gate.',
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
    text: 'The restaurant is open and the town can grow to 400 people. At 300 people, upgrade to a Coastal Wharf in the Port panel. Then supply 30 fish crates a day for 2 days to open the cannery.',
    topic: 'growth',
  },
  cannery: {
    title: 'The cannery',
    text: 'The cannery is open. To export its canned fish, prepare a customs office, outside truck parking and outgoing crate storage connected through a port gate. Keep a coaster line active. The export lesson walks through each step.',
    topic: 'exports',
    guide: ['exports', 0],
  },
  buildersYard: {
    title: 'The builders’ yard',
    text: 'The builders’ yard is open: the town may grow to 600, and now builds flats. Valley Timber Co. offers its coasters of timber for the yard; customs clears it at the customs office. Next the town wants a school: truck out 25 crates of timber.',
    topic: 'growth',
  },
  school: {
    title: 'The school',
    text: 'Families settle round the new school, the town may grow to 700, and a department store opens. A shipping line offers coasters of goods for it. Next the town wants a town hall: truck out 60 crates of goods.',
    topic: 'growth',
  },
  townHall: {
    title: 'The town hall',
    text: 'The town has its charter, and may grow to 1,000 people: past 800 the harbour authority lets the port become a Container Port. See the Port panel (P). Then the town wants a hospital: truck out 40 containers.',
    topic: 'growth',
  },
  hospital: {
    title: 'The hospital',
    text: 'The hospital is open and the town may grow to 1,300. The factory sends its goods out in containers now: sign its offer, and its trucks wait in the parking outside for their paperwork, then the containers go on board the feeders. Next the town wants a technical college: put 40 containers on board ships.',
    topic: 'growth',
  },
  college: {
    title: 'The technical college',
    text: 'The technical college is open and the town may grow to 1,600. The railway company plans a station for the town: truck out 100 containers and it opens.',
    topic: 'growth',
  },
  station: {
    title: 'The railway station',
    text: 'Trains stop at the town’s new station, and the town may grow on without limit, towards a city.',
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
    guide: ['wharf', 0],
  },
  tier2: {
    title: 'Container Port',
    text: 'Feeder ships bring containers. Cranes lift them, reach stackers take them to container yards, and after customs, container trucks take them away.',
    topic: 'containers',
    guide: ['harbour', 0],
  },
};

const TIP_ACTIONS: Record<string, GuideAction> = {
  hut: { label: 'Choose break hut', tool: 'breakHut' },
  truckBays: { label: 'Choose truck bay', tool: 'truckBay' },
  jetty: { label: 'Choose jetty', tool: 'jetty' },
  contract: { label: 'Open fishery offers', offers: 'fishery' },
  screens: { label: 'Open finance', panel: 'finance' },
  forklifts: { label: 'Choose forklift', tool: 'forklift' },
  stackers: { label: 'Choose reach stacker', tool: 'stacker' },
  tractors: { label: 'Choose terminal tractor', tool: 'tractor' },
  customsOffice: { label: 'Choose customs office', tool: 'customs' },
  crateCustoms: { label: 'Show storage', inspect: 'storage' },
  papers: { label: 'Open contracts', panel: 'contracts' },
  noHands: { label: 'Open staff', panel: 'staff' },
  roundTrip: { label: 'Open haulier offers', offers: 'haulier' },
  parking: { label: 'Choose truck parking', tool: 'parking' },
  yardGantry: { label: 'Choose yard gantry', tool: 'yardGantry' },
  yards: { label: 'Choose incoming yard', tool: 'boxStore' },
  land: { label: 'Choose land', tool: 'land' },
};

/** Blockers come before background lessons; preserve arrival order within a priority. */
export function tipPriority(id: string, s: Snapshot | null): number {
  if (!s) return 0;
  if (id === 'noHands' && !s.people.some((p) => p.kind === 'dockhand')) return 100;
  if (id === 'parking' && s.contracts.some((c) => c.trouble?.bad)) return 90;
  if (id === 'cranes' && s.cranes.some((c) => c.trouble)) return 90;
  if (id === 'customsOffice' && !s.learning.customs) return 80;
  if (id === 'hut' && !s.learning.hut) return 80;
  if (id === 'quayStorage') return 70;
  return 0;
}

function readTip(id: string, actions: Actions): void {
  actions.send({ type: 'readTip', id });
  advice.value = advice.value.filter((t) => t !== id);
}

function TipActions({ id, actions }: { id: string; actions: Actions }) {
  const tip = TIPS[id];
  const action = TIP_ACTIONS[id];
  const read = () => readTip(id, actions);
  return (
    <div class="advisor-actions">
      {tip.guide ? (
        <button
          class="btn primary"
          onClick={() => {
            read();
            openGuide(...tip.guide!);
          }}
        >
          Show me how
        </button>
      ) : action && availableAction(action) ? (
        <button
          class="btn primary"
          onClick={() => {
            read();
            runHelpAction(action, actions);
          }}
        >
          {action.label}
        </button>
      ) : (
        <button class="btn primary" onClick={read}>
          Got it
        </button>
      )}
      <button
        class="btn ghost"
        onClick={() => {
          read();
          openHandbook(tip.topic);
        }}
      >
        Read more
      </button>
    </div>
  );
}

export function Advisor({ actions }: { actions: Actions }) {
  const id = advice.value
    .filter((t) => Object.hasOwn(TIPS, t))
    .sort((a, b) => tipPriority(b, snapshot.value) - tipPriority(a, snapshot.value))[0];
  if (!id) return null;
  const tip = TIPS[id];
  return (
    <div class="advisor panel" role="status">
      <div class="advisor-head">
        <span class="kicker">Advisor</span>
        <div class="advisor-head-actions">
          {advice.value.length > 1 && <span class="muted">{advice.value.length - 1} more</span>}
          <button
            class="btn icon ghost"
            title="Advice history"
            aria-label="Open advice history"
            onClick={() => openHandbook('tips')}
          >
            <Icon name="book" />
          </button>
          <button
            class="btn icon ghost"
            title="Dismiss advice"
            aria-label="Dismiss advice"
            onClick={() => readTip(id, actions)}
          >
            <Icon name="close" />
          </button>
        </div>
      </div>
      <strong>{tip.title}</strong>
      <p>{tip.text}</p>
      {tip.picture && <FlipBook id={tip.picture} small />}
      <TipActions id={id} actions={actions} />
    </div>
  );
}

export function TipHistory({ actions }: { actions: Actions }) {
  const s = snapshot.value;
  const seen = s?.learning.seenTips.filter((id) => Object.hasOwn(TIPS, id)) ?? [];
  return (
    <>
      <p>
        Advice for this port stays here, including cards you have dismissed. Unread cards are saved
        with your game.
      </p>
      {seen.length === 0 && <p>Your advisor’s messages will appear here as you play.</p>}
      {seen.map((id) => (
        <details key={id} class="help-history">
          <summary>
            {TIPS[id].title}
            {!s?.learning.readTips.includes(id) ? ' · Unread' : ''}
          </summary>
          <p>{TIPS[id].text}</p>
          <TipActions id={id} actions={actions} />
        </details>
      ))}
    </>
  );
}
