import * as B from '../sim/balance';
import type { Tool } from './tools';

interface ToolHelp {
  what: string;
  where: string;
  needs: string;
}
/** Short placement instructions; the complete rules remain available under More details. */
export const TOOL_HELP: Partial<Record<Tool, ToolHelp>> = {
  road: {
    what: 'A road for hauliers’ and shippers’ trucks.',
    where: 'Connect to the highway or an existing public road.',
    needs:
      'A port gate to connect to port roads. Dockhands and machines use the port’s own paths and roads.',
  },
  footpath: {
    what: 'A walking route for dockhands.',
    where: 'Join jetties, truck bays and crew buildings.',
    needs:
      'An unbroken route. Grass and public roads block workers; machines need port roads or quay.',
  },
  portRoad: {
    what: 'A shared route for dockhands and port machines.',
    where: 'Build inside the port, or over a port path to upgrade it.',
    needs: 'A port gate wherever hauliers enter from public roads.',
  },
  jetty: {
    what: 'A wooden pier for fishing boats.',
    where: `Drag from the shore into water up to ${B.MAX_JETTY_DEPTH} m deep.`,
    needs: 'A port path to the crew and somewhere to store crates. Machines cannot drive on wood.',
  },
  quay: {
    what: 'A concrete dock for boats and port machines.',
    where: `Build along the shore or in water up to ${B.MAX_QUAY_DEPTH} m deep.`,
    needs: `A harbour office. Coasters need two tiles of width and ${B.COASTER_DRAFT} m water; feeders need a container crane and ${B.FEEDER_DRAFT} m water.`,
  },
  portGate: {
    what: 'Lets hauliers and shippers drive into the port.',
    where: 'Where a public road meets a port road.',
    needs: 'Connected roads on both sides, with a route onward to a loading lane.',
  },
  parking: {
    what: 'Gives trucks somewhere to wait.',
    where: 'Mark a strip one or two tiles wide, with road along both long sides.',
    needs:
      'Public-road parking for shippers outside the port; port-road parking for queues inside. Big trucks need two tiles of width.',
  },
  office: {
    what: `Coordinates ${B.DOCKS_PER_OFFICE} docks across the port.`,
    where: 'On owned ground, with its door facing a port path or road.',
    needs:
      'Every quay requires office coverage. Select the office to see coordinated docks in green.',
  },
  harbourHut: {
    what: `Coordinates ${B.JETTIES_PER_HUT} additional wooden docks.`,
    where: 'On owned ground, with its door facing a port path or road.',
    needs: 'Concrete quays require a harbour office instead.',
  },
  customs: {
    what: 'Clears imports and export papers for the whole port.',
    where: 'On owned ground, with its door facing a port path or road.',
    needs:
      'Build before signing timber, goods or container lines, or goods and canned-fish exporters.',
  },
  breakHut: {
    what: `Gives ${B.HUT_SLOTS} tired dockhands somewhere to rest.`,
    where: 'Near the jetty, connected to a port path, port road or quay.',
    needs: 'A walking route the crew can use.',
  },
  depot: {
    what: `Houses ${B.DEPOT_SLOTS} machine slots. Reach stackers use two slots.`,
    where: 'Face the garage door onto a port road or quay.',
    needs:
      'Connected paving to the places machines work. Choose a machine, then click this depot to buy it.',
  },
  jibCrane: {
    what: 'Lifts crates between a boat and adjacent crate storage.',
    where: 'On a quay edge facing open water.',
    needs:
      'An office, incoming storage on its blue reach tiles, and a forklift route to empty that storage. Red ground is for machines only.',
  },
  harbourCrane: {
    what: 'Lifts containers between feeder ships and the quay.',
    where: 'On the edge of a quay at least two tiles wide, facing open water.',
    needs: `An office, ${B.FEEDER_DRAFT} m water, room for the hull, and reach stackers to clear its landing stack.`,
  },
  gantryCrane: {
    what: 'Unloads container ships quickly and can share a berth with another gantry.',
    where: `On 2×2 quay tiles facing water, with ${B.GANTRY_RAILS} clear edge tiles for its rails.`,
    needs:
      'An office, deep water, and machines to clear containers from the shipside. Keep its rails and surrounding machine lanes clear.',
  },
  yardGantry: {
    what: 'Loads and unloads trucks beside a container yard.',
    where: 'On port road or quay beside a yard, with a clear lane under its rails.',
    needs:
      'Truck access through a gate. Reach stackers or terminal tractors bring containers from the quay cranes.',
  },
  crateStore: {
    what: `Stores incoming cargo, ${B.CRATES_PER_STORE_TILE} crates per tile.`,
    where: 'Drag over port road or quay near the berth.',
    needs:
      'An unmarked loading lane beside it, connected through a port gate. Beside a crane, forklifts move crates onward.',
  },
  crateOutStore: {
    what: `Stores exports, ${B.CRATES_PER_STORE_TILE} crates per tile.`,
    where: 'Drag over port road or quay near a coaster berth.',
    needs:
      'A loading lane for shippers’ trucks and dockhands or a jib crane to load ships. Goods and canned fish wait here for inspection.',
  },
  boxStore: {
    what: `Stores incoming containers, ${B.BOXES_PER_STORE_TILE} per tile.`,
    where: 'Drag over port road or quay, connected to the cranes.',
    needs:
      'A reach stacker and a truck loading lane. Leave room for customs: containers clear about a day after their ship finishes unloading.',
  },
  boxOutStore: {
    what: `Stores outgoing containers, ${B.BOXES_PER_STORE_TILE} per tile.`,
    where: 'Drag over port road or quay near the container cranes.',
    needs:
      'A loading lane for shippers, a reach stacker, and a feeder line to take exports aboard.',
  },
  forklift: {
    what: `Carries ${B.FORKLIFT_CAPACITY} crates per trip and loads crate trucks.`,
    where: 'Choose this machine, then click a depot to buy it.',
    needs:
      'Port roads or quay between storage and loading areas. Dockhands or cranes unload the boats.',
  },
  stacker: {
    what: 'Carries containers between quay cranes, yards and trucks.',
    where: 'Choose this machine, then click a depot to buy it.',
    needs: 'Two depot slots and connected port roads or quay.',
  },
  tractor: {
    what: 'Shuttles containers between quay cranes and yards with gantries.',
    where: 'Choose this machine, then click a depot to buy it.',
    needs:
      'A yard gantry to lift containers on and off. Give its trailer a route around; it cannot turn about on an ordinary road.',
  },
};
