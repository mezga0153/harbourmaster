import type { CraneFix, Snapshot } from '../protocol';
import type { PictureId } from '../render/guides';
import * as B from '../sim/balance';
import { TICKS_PER_DAY } from '../sim/types';
import type { Tool } from './tools';
import type { PanelName } from './store';

export type GuideCheck =
  | 'inspectBoat'
  | 'inspectWorker'
  | 'crateDelivery'
  | 'coasterDelivery'
  | 'containerDelivery'
  | 'cannedExport'
  | 'hut'
  | 'coasterBerth'
  | 'office'
  | 'storage'
  | 'access'
  | 'coasterLine'
  | 'craneEdge'
  | 'craneRoom'
  | 'craneDepth'
  | 'jibStorage'
  | 'forklift'
  | 'stacker'
  | 'depot'
  | 'customs'
  | 'yard'
  | 'yardAccess'
  | 'feederLine'
  | 'boxHaulier'
  | 'parking'
  | 'outStorage'
  | 'outAccess'
  | 'shipper'
  | 'siding'
  | 'sidingYards'
  | 'sidingWorked'
  | 'railLine'
  | 'trainDelivery';
export interface GuideAction {
  label: string;
  tool?: Tool;
  panel?: PanelName;
  inspect?: 'boat' | 'dockhand' | 'truck' | 'storage' | 'crane';
  offers?: 'fishery' | 'coaster' | 'feeder' | 'haulier' | 'shipper' | 'rail';
}
export interface GuideStep {
  title: string;
  text: string;
  how?: string;
  picture: PictureId;
  fixes?: CraneFix[];
  check?: GuideCheck;
  actions?: GuideAction[];
}
export interface Guide {
  kicker: string;
  title: string;
  tier: number;
  steps: GuideStep[];
}
const office: GuideStep = {
  title: 'Coordinate the quay',
  how: 'Buildings › Offices › Harbour office (O)',
  text: `Build a harbour office with its door facing a port path or road. Each office coordinates ${B.DOCKS_PER_OFFICE} docks across the port; it has no coverage radius. Connected jetty and quay tiles count as one dock. Select the office to see which docks are in use.`,
  picture: 'office',
  fixes: ['office'],
  check: 'office',
  actions: [{ label: 'Choose harbour office', tool: 'office' }],
};
const storage: GuideStep = {
  title: 'Store crates beside the berth',
  how: 'Cargo › Storage › Crate storage: in',
  text: `Mark incoming storage on the quay near the boat. Dockhands carry crates straight into it. Leave an unmarked lane beside it for trucks; each ${B.STORE_TILES_PER_TRUCK} storage tiles allow one truck to load. Select the area to see the loading spots in yellow.`,
  picture: 'storage',
  check: 'storage',
  actions: [
    { label: 'Choose incoming storage', tool: 'crateStore' },
    { label: 'Show storage', inspect: 'storage' },
  ],
};
const access: GuideStep = {
  title: 'Connect the loading lane',
  how: 'Roads › Roads › Port gate, then Port road',
  text: 'Join a public road to a port road through a port gate. Continue the port road to the unmarked lane beside storage. Trucks need a way in and out, and cannot drive on storage or machines-only ground.',
  picture: 'gate',
  check: 'access',
  actions: [
    { label: 'Choose port gate', tool: 'portGate' },
    { label: 'Choose port road', tool: 'portRoad' },
  ],
};
const depot: GuideStep = {
  title: 'Give machines a way out',
  how: 'Machines › Machines › Depot (U)',
  text: 'Build a depot with its garage door facing a port road or quay. Connect that road to the crane and storage. Right-click to turn the building before placing it; on a phone, use Turn.',
  picture: 'depot',
  check: 'depot',
  actions: [
    { label: 'Choose depot', tool: 'depot' },
    { label: 'Choose port road', tool: 'portRoad' },
  ],
};
const room: GuideStep = {
  title: 'Leave room for the whole ship',
  how: 'Bulldoze (B)',
  text: 'Keep open water along the quay on both sides of the crane, for the whole hull. Select the crane to read how many clear tiles it needs. Remove jetties or other obstacles only where they block the berth.',
  picture: 'room',
  fixes: ['room'],
  check: 'craneRoom',
  actions: [
    { label: 'Inspect crane', inspect: 'crane' },
    { label: 'Choose bulldozer', tool: 'bulldoze' },
  ],
};
const depth: GuideStep = {
  title: 'Check the water depth',
  how: 'Docks › Terraform › Dredge',
  text: `Feeders, the small container ships, need ${B.FEEDER_DRAFT} m of water along their berth and a deep enough route in from sea. Hover over water to see its depth. Dredge shallow tiles where needed.`,
  picture: 'depth',
  fixes: ['depth'],
  check: 'craneDepth',
  actions: [{ label: 'Choose dredge', tool: 'dredge' }],
};
const customs: GuideStep = {
  title: 'Build a customs office',
  how: 'Buildings › Offices › Customs office',
  text: 'One customs office serves the whole port. It is required before signing container lines, timber or goods imports, and canned-fish or goods exporters. Put its door against a port path or road.',
  picture: 'customs',
  check: 'customs',
  actions: [{ label: 'Choose customs office', tool: 'customs' }],
};
const containerSteps: GuideStep[] = [
  depot,
  {
    title: 'Buy a reach stacker',
    how: 'Machines › Machines › Reach stacker (Z)',
    text: 'Choose Reach stacker, then click your depot to buy one there. It carries containers from the quay crane to the yard, and loads trucks there too. Keep port roads or quay between these places.',
    picture: 'containerDepot',
    check: 'stacker',
    actions: [{ label: 'Choose reach stacker', tool: 'stacker' }],
  },
  {
    title: 'Mark an incoming container yard',
    how: 'Cargo › Storage › Container yard: in',
    text: `Mark a yard on port roads or quay. Leave an unmarked loading lane beside it. Allow room for a ship’s load plus a day of arrivals: customs start only when the whole ship has been unloaded, then take about ${Math.round((B.CUSTOMS_TICKS * 24) / TICKS_PER_DAY)} game hours.`,
    picture: 'containerYard',
    check: 'yard',
    actions: [{ label: 'Choose container yard', tool: 'boxStore' }],
  },
  { ...access, title: 'Connect the yard to the highway', check: 'yardAccess' },
  customs,
  {
    title: 'Sign a feeder line',
    text: 'Open shipping offers and sign a feeder line once the berth, crane, stacker and yard are ready. Each contract has a signing fee. Keep cash for wages and running costs.',
    picture: 'wide',
    check: 'feederLine',
    actions: [{ label: 'Open feeder offers', offers: 'feeder' }],
  },
  {
    title: 'Sign a container haulier',
    text: 'A haulier supplies trucks that collect your imports. Sign one that carries containers; ordinary crate trucks cannot take them.',
    picture: 'containerYard',
    check: 'boxHaulier',
    actions: [{ label: 'Open haulier offers', offers: 'haulier' }],
  },
  {
    title: 'Follow your first container out',
    text: 'Let a feeder unload. Select the yard to see the customs countdown. After clearance, a reach stacker loads a container truck. This lesson finishes when a loaded container truck leaves for delivery. Add a yard gantry later to free stackers from truck loading.',
    picture: 'containerYard',
    check: 'containerDelivery',
    actions: [{ label: 'Open statistics', panel: 'stats' }],
  },
];
const harbourStart: GuideStep = {
  title: 'Build a container berth',
  how: 'Cargo › Cranes › Harbour crane (I)',
  text: `Build a quay at least two tiles wide beside ${B.FEEDER_DRAFT} m water. Put a harbour crane on its edge, facing open water. A red warning opens the guide at the part that needs fixing.`,
  picture: 'wide',
  fixes: ['water', 'wide'],
  check: 'craneEdge',
  actions: [
    { label: 'Choose quay', tool: 'quay' },
    { label: 'Choose harbour crane', tool: 'harbourCrane' },
  ],
};

export type GuideId = 'start' | 'wharf' | 'jib' | 'harbour' | 'gantry' | 'exports' | 'railway';

export const GUIDES: Record<GuideId, Guide> = {
  start: {
    kicker: 'First steps',
    title: 'Your first delivery',
    tier: 0,
    steps: [
      {
        title: 'Look at a boat',
        text: 'Press Space to pause whenever you need time. Drag the map to move, scroll to zoom, and use Q or E to turn the view. Select a boat to see its cargo, activity and any reason it is waiting. You can skip these lessons and reopen them from the Handbook.',
        picture: 'firstBoat',
        check: 'inspectBoat',
        actions: [{ label: 'Show a boat', inspect: 'boat' }],
      },
      {
        title: 'Meet a dockhand',
        text: 'Dockhands carry crates from boats to the road’s end, where pickups collect them. Select a dockhand to see their job, energy and morale. They walk on port paths, port roads, jetties and quays; grass and public roads block their route.',
        picture: 'firstDelivery',
        check: 'inspectWorker',
        actions: [{ label: 'Show a dockhand', inspect: 'dockhand' }],
      },
      {
        title: 'Follow the first pickup',
        text: 'Resume with Space or the play button. A pickup collects crates at the road’s end. You earn money when it leaves for delivery. Select a truck to follow its progress. Keys 1, 2, 3 and 4 set 1×, 2×, 4× and 8× speed.',
        picture: 'firstDelivery',
        check: 'crateDelivery',
        actions: [{ label: 'Show a truck', inspect: 'truck' }],
      },
      {
        title: 'Give the crew a break',
        how: 'Buildings › Crew › Break hut (K)',
        text: `When dockhands tire, they need somewhere to rest. Build a break hut near the jetty, connected by a port path. It seats ${B.HUT_SLOTS} people. Use Esc to put a tool away.`,
        picture: 'breakHut',
        check: 'hut',
        actions: [
          { label: 'Choose break hut', tool: 'breakHut' },
          { label: 'Choose port path', tool: 'footpath' },
        ],
      },
    ],
  },
  wharf: {
    kicker: 'Coastal Wharf',
    title: 'Your first coaster delivery',
    tier: 1,
    steps: [
      {
        title: 'Prepare a coaster berth',
        how: 'Docks › Docks › Quay (G)',
        text: `Coasters are coastal cargo ships. Build a quay two tiles wide beside water at least ${B.COASTER_DRAFT} m deep, with clear water for the whole hull and a route from sea. Hover over water to check its depth. The berth check also needs the harbour office in the next step. Dockhands can unload your first coaster.`,
        picture: 'quay',
        check: 'coasterBerth',
        actions: [
          { label: 'Choose quay', tool: 'quay' },
          { label: 'Choose dredge', tool: 'dredge' },
        ],
      },
      office,
      storage,
      access,
      {
        title: 'Invite a coaster',
        text: 'Sign a shipping line with coasters from the offers. Start with fish if available: timber and goods also need a customs office, and wait in incoming storage for clearance. Keep a crate haulier active to take the cargo away, and dockhands to unload it.',
        picture: 'quay',
        check: 'coasterLine',
        actions: [
          { label: 'Open coaster offers', offers: 'coaster' },
          { label: 'Open staff', panel: 'staff' },
        ],
      },
      {
        title: 'Make the first delivery',
        text: 'Resume the game. Dockhands unload the coaster into nearby storage, and hauliers collect it. The check turns green when a truck leaves with a crate from a coaster. Select anything waiting to see why. Once this works, try the jib-crane lesson to move more cargo.',
        picture: 'storage',
        check: 'coasterDelivery',
        actions: [
          { label: 'Show storage', inspect: 'storage' },
          { label: 'Open haulier offers', offers: 'haulier' },
        ],
      },
    ],
  },
  jib: {
    kicker: 'Optional improvement',
    title: 'Move crates with a jib crane',
    tier: 1,
    steps: [
      {
        title: 'Place the crane at the quay edge',
        how: 'Cargo › Cranes › Jib crane (N)',
        text: 'Build a jib crane on the quay edge facing open water. It lifts crates from boats into nearby storage. Its red ground is reserved for port machines, so dockhands and hauliers cannot enter it.',
        picture: 'jibEdge',
        fixes: ['water'],
        check: 'craneEdge',
        actions: [{ label: 'Choose jib crane', tool: 'jibCrane' }],
      },
      office,
      {
        title: 'Give the crane somewhere to put crates',
        how: 'Cargo › Storage › Crate storage: in',
        text: 'Mark incoming crate storage on the blue highlighted tiles beside the crane. The crane unloads only into these tiles. Select it: “Crate storage in reach” should show at least one tile with free space.',
        picture: 'jib',
        fixes: ['storage'],
        check: 'jibStorage',
        actions: [{ label: 'Choose incoming storage', tool: 'crateStore' }],
      },
      depot,
      {
        title: 'Keep the crane’s storage clear',
        how: 'Machines › Machines › Forklift (L)',
        text: `Choose Forklift, then click a depot to buy it for $${B.FORKLIFT_PRICE.toLocaleString('en-US')}. It carries ${B.FORKLIFT_CAPACITY} crates per trip from crane-side storage to storage or bays trucks can reach. Connect both ends with port roads or quay. A forklift cannot unload a boat itself.`,
        picture: 'depot',
        check: 'forklift',
        actions: [{ label: 'Choose forklift', tool: 'forklift' }],
      },
    ],
  },
  harbour: {
    kicker: 'Container Port',
    title: 'Your first container delivery',
    tier: 2,
    steps: [harbourStart, office, room, depth, ...containerSteps],
  },
  gantry: {
    kicker: 'Container Port',
    title: 'A working gantry terminal',
    tier: 2,
    steps: [
      {
        title: 'Leave room for the gantry rails',
        how: 'Cargo › Cranes › Gantry crane',
        text: `Place the 2×2 crane on a quay at least two tiles wide, with its front facing open water. Keep ${B.GANTRY_RAILS} tiles of quay edge clear for its rails, plus the machines-only ground around them.`,
        picture: 'gantry',
        fixes: ['water', 'wide'],
        check: 'craneEdge',
        actions: [{ label: 'Choose gantry crane', tool: 'gantryCrane' }],
      },
      office,
      room,
      depth,
      ...containerSteps,
    ],
  },
  exports: {
    kicker: 'Coastal Wharf',
    title: 'Export canned fish',
    tier: 1,
    steps: [
      customs,
      {
        title: 'Make room for waiting trucks',
        how: 'Roads › Areas › Truck parking',
        text: 'Mark parking on a public road outside the port. Leave road along both long sides so trucks drive in from one side and out the other. Use a two-tile-wide strip for big trucks. Select parking to check that it works.',
        picture: 'parking',
        check: 'parking',
        actions: [{ label: 'Choose truck parking', tool: 'parking' }],
      },
      {
        title: 'Mark outgoing crate storage',
        how: 'Cargo › Storage › Crate storage: out',
        text: `Mark outgoing storage near a coaster berth. Canned fish and goods wait here for about ${Math.round((B.EXPORT_PAPERS_TICKS * 24) / TICKS_PER_DAY)} game hours of export inspection. Keep it separate from incoming storage, and leave an unmarked lane beside it for delivery trucks.`,
        picture: 'outStorage',
        check: 'outStorage',
        actions: [{ label: 'Choose outgoing storage', tool: 'crateOutStore' }],
      },
      { ...access, title: 'Let shippers reach the outgoing storage', check: 'outAccess' },
      {
        title: 'Arrange trucks and a ship',
        text: 'Sign the cannery’s shipper offer once the town has opened it, and keep a coaster line active. The cannery sends canned fish by truck; your dockhands or jib crane load cleared crates onto a coaster. Check the contract for anything still missing.',
        picture: 'outStorage',
        check: 'shipper',
        actions: [
          { label: 'Open shipper offers', offers: 'shipper' },
          { label: 'Open coaster offers', offers: 'coaster' },
        ],
      },
      {
        title: 'Put the first canned fish aboard',
        text: 'Resume the game and select outgoing storage to see when its export papers clear. A coaster unloads its imports, then takes cleared exports aboard. You are paid as each crate is loaded. This lesson finishes when canned fish goes on board.',
        picture: 'outStorage',
        check: 'cannedExport',
        actions: [{ label: 'Open contracts', panel: 'contracts' }],
      },
    ],
  },
  railway: {
    kicker: 'Container Port',
    title: 'Your first container train',
    tier: 2,
    steps: [
      {
        title: 'Lay a siding off the main line',
        how: 'Roads › Railway › Rail siding',
        text: `Once the town has its railway station, drag a siding straight out from beside the main line along a row, on land the port owns, as long as the trains: a tile and a third a wagon, ${B.WAGON_BOXES} containers each. Its switch needs ${B.SWITCH_GAP} rows of plain line from another switch or a level crossing. Port roads may cross it.`,
        picture: 'siding',
        check: 'siding',
        actions: [{ label: 'Choose rail siding', tool: 'siding' }],
      },
      {
        title: 'Mark container yards beside it',
        how: 'Cargo › Storage › Container yard: in, then out',
        text: `Mark a yard for containers coming in a row or two off the track, where the trains load the cleared containers off the feeders, and one for containers going out, where they unload what they bring. Run them along the siding where the wagons stand.`,
        picture: 'sidingYards',
        check: 'sidingYards',
        actions: [
          { label: 'Choose incoming yard', tool: 'boxStore' },
          { label: 'Choose outgoing yard', tool: 'boxOutStore' },
        ],
      },
      {
        title: 'Give the wagons a crane or a stacker',
        how: 'Machines › Reach stacker (Z), or Cargo › Cranes › Yard gantry',
        text: 'Reach stackers lift the containers between the yards and the wagons, a container a trip, from beside the stacks. Or build a yard gantry on the siding beside a yard: its rails run along the track, and it works every wagon along the yard itself. Select the siding to see what it still needs.',
        picture: 'sidingGantry',
        check: 'sidingWorked',
        actions: [
          { label: 'Choose reach stacker', tool: 'stacker' },
          { label: 'Choose yard gantry', tool: 'yardGantry' },
        ],
      },
      {
        title: 'Sign the rail line',
        text: 'The railway’s offer stays on the contracts board till it is signed. Its trains bring containers to go out on the feeders, paid for as they go on board, and take containers off the feeders inland, paid for as each train leaves. The railway charges a daily fee.',
        picture: 'sidingTrain',
        check: 'railLine',
        actions: [{ label: 'Open rail offers', offers: 'rail' }],
      },
      {
        title: 'See the first train worked',
        text: 'A train waits off the map for the main line to clear, pulls into the siding and stands while its wagons are unloaded and loaded. It leaves once that is done, or after a day at most. This lesson finishes when a train leaves with containers on board.',
        picture: 'sidingTrain',
        check: 'trainDelivery',
        actions: [{ label: 'Open contracts', panel: 'contracts' }],
      },
    ],
  },
};
export function craneGuide(kind: 'jib' | 'harbour' | 'gantry'): GuideId {
  return kind;
}
export function stepFor(id: GuideId, fix: CraneFix | undefined): number {
  return Math.max(
    0,
    GUIDES[id].steps.findIndex((s) => fix && s.fixes?.includes(fix)),
  );
}

/** Checks use the same berth and access results as the simulation. Targets keep crane repairs local. */
export function checkStep(
  step: GuideStep,
  s: Snapshot,
  target?: number,
  kind?: 'jib' | 'harbour' | 'gantry',
): { done: boolean; label: string } | null {
  const key = step.check;
  if (!key) return null;
  const marks = s.learning.marks;
  const cranes = s.cranes.filter(
    (c) => (target === undefined || c.idx === target) && (!kind || c.kind === kind),
  );
  const incoming = s.bays.filter((b) => b.tiles && !b.outgoing && !b.shut);
  const reached = (idx: number) => s.learning.reached.includes(idx);
  const line = (v: string) =>
    s.contracts.some((c) => c.terms.kind === 'fishery' && c.terms.vessel === v);
  const checks: Record<GuideCheck, [boolean, string]> = {
    inspectBoat: [marks.includes('inspectBoat'), 'Boat inspected'],
    inspectWorker: [marks.includes('inspectWorker'), 'Dockhand inspected'],
    crateDelivery: [marks.includes('crateDelivery'), 'First crate delivery paid'],
    coasterDelivery: [marks.includes('coasterDelivery'), 'Coaster cargo delivered by truck'],
    containerDelivery: [marks.includes('containerDelivery'), 'Container delivered by truck'],
    cannedExport: [marks.includes('cannedExport'), 'Canned fish loaded onto a ship'],
    hut: [s.learning.hut, 'Break hut built'],
    coasterBerth: [s.capacity.deepBerths > 0, 'Coaster berth ready: width, depth and office'],
    office: [
      target === undefined
        ? s.docks.offices > 0 && s.docks.coordinated > 0
        : s.docks.inUse.includes(target),
      'Harbour office coordinates the dock',
    ],
    storage: [incoming.length > 0, 'Incoming crate storage marked'],
    access: [incoming.some((b) => reached(b.idx)), 'Trucks can reach incoming storage'],
    coasterLine: [
      line('coaster') &&
        s.people.some((p) => p.kind === 'dockhand') &&
        s.contracts.some((c) => c.terms.kind === 'haulier' && !c.terms.cargo),
      'Coaster line, dockhands and crate haulier ready',
    ],
    craneEdge: [
      cranes.some((c) => c.site?.water && c.site?.wide),
      'Crane faces water on a wide enough quay',
    ],
    craneRoom: [cranes.some((c) => c.site?.room), 'Ship has room alongside'],
    craneDepth: [cranes.some((c) => c.site?.depth), 'Crane berth has deep enough water'],
    jibStorage: [
      cranes.some((c) => c.kind === 'jib' && c.stores > 0 && (c.storeRoom ?? 0) > 0),
      'Crane has incoming storage with free space',
    ],
    depot: [s.learning.usableDepots.length > 0, 'Depot door faces a port road or quay'],
    forklift: [
      s.people.some((p) => p.kind === 'forklift' && s.learning.usableDepots.includes(p.home)),
      'Forklift bought at a usable depot',
    ],
    stacker: [
      s.people.some((p) => p.kind === 'stacker' && s.learning.usableDepots.includes(p.home)),
      'Reach stacker bought at a usable depot',
    ],
    customs: [s.learning.customs, 'Customs office built'],
    yard: [s.yards.some((y) => !y.outgoing && !y.shut), 'Incoming container yard marked'],
    yardAccess: [
      s.yards.some((y) => !y.outgoing && !y.shut && reached(y.idx)),
      'Trucks can reach the incoming yard',
    ],
    feederLine: [line('feeder'), 'Feeder line signed'],
    boxHaulier: [
      s.contracts.some((c) => c.terms.kind === 'haulier' && c.terms.cargo === 'container'),
      'Container haulier signed',
    ],
    parking: [
      s.parking.some((p) => p.outside && p.wide && !p.why),
      'Working outside parking fits big trucks',
    ],
    outStorage: [
      s.bays.some((b) => b.tiles && b.outgoing && !b.shut),
      'Outgoing crate storage marked',
    ],
    outAccess: [
      s.bays.some((b) => b.tiles && b.outgoing && !b.shut && reached(b.idx)),
      'Trucks can reach outgoing storage',
    ],
    shipper: [
      line('coaster') &&
        s.contracts.some((c) => c.terms.kind === 'shipper' && c.terms.goods === 'canned'),
      'Cannery shipper and coaster line signed',
    ],
    siding: [s.sidings.some((x) => x.cars >= 2), 'A siding long enough for a train'],
    sidingYards: [
      s.sidings.some((x) => x.yardsIn > 0 && x.yardsOut > 0),
      'Yards in and out beside a siding',
    ],
    sidingWorked: [s.sidings.some((x) => x.yards > 0 && !x.why), 'Something to work the wagons'],
    railLine: [s.contracts.some((c) => c.terms.kind === 'rail'), 'Rail line signed'],
    trainDelivery: [marks.includes('trainDelivery'), 'A train left with containers'],
  };
  const [done, label] = checks[key];
  return { done, label };
}
