# Progression: the town leads, the port follows

The port grows as the town up the coast grows (`src/sim/tiers.ts`: each port
tier needs a town of a certain size). The town does not grow on its own: it
grows only as far as what it has lets it. Each step up is a **landmark** the
town opens in its streets once the port has kept it supplied with something,
and each landmark both lifts how big the town may grow and opens up
something new for the port. The player should always know the one next
thing to aim for.

## How a step works

- The town has a **population cap**. It grows towards the cap as it does
  now (jobs at the port, goods delivered), and no further.
- **Each landmark doubles the cap** (100, 200, 400 … 51,200, then no
  limit after the railway station), and the town counts that many more
  people for the same jobs and trade: `townScale` in `src/sim/town.ts`,
  its cap against the cap it had when the steps climbed by a hundred or so,
  so a town fills towards its cap as fast as it did then (32 times from the
  college on). The streets and homes on the map grow at the old pace: each
  home holds `townScale` times the people (`townRoom`). Saves from before
  (no `census` on the town or the region) have their people counted again
  as they load.
- The next **landmark** has a goal the port must meet: a delivery kept up
  for a while (e.g. 12 crates of fish a day for 3 days), or a contract kept
  going. Progress is measured, not ticked off by hand.
- When the goal is met, the town **builds the landmark**: it shows as
  scaffolding for a day, then opens. Opening it raises the cap, may add a
  business that wants goods, and **unlocks** contracts, cargo or buildings
  for the port.
- One step at a time: the next goal only shows once the last landmark has
  opened.

## The port's land

Beside the steps, the port grows in space by buying land (`src/sim/land.ts`):
plots of 12 by 12 tiles over the port's rows, each bought beside one it
owns, for $1,200 rising by 15% with every plot bought (about $2,400 for
the sixth, $4,900 for the eleventh, $19,600 for the twenty-first), 60% of
that for a plot all of sea. Saves made with plots of 16 keep the land they
owned, in plots of 12 whose middles lay on it, and what they built on.
A new game's first jetty stands on a point of land running out into the
sea, and the game owns only the one to four plots under it, the path to it
and the road's end, so a truck bay or a second jetty soon needs land
bought; everything built, dredged, filled in,
marked out or cleared needs its plot owned. Saves from before land was
bought own every plot they built on, free.

## Fishing Jetty: village to town (cap 100 → 800)

The hauliers send **pickups** (`pickup` in `HaulierTerms`, `src/sim/contracts.ts`):
an open bed of one layer of six crates that backs into a truck bay as the
small trucks do, loaded there by hand or by forklift; only at the heap at
the road's end does it pull up on the road beside it (`roadside` in
`src/sim/systems/roads/bays.ts`), to be loaded by hand.

A new game has **no truck bay**: the road from the highway ends two tiles
wide (for the pickups to turn about) by a path to the jetty, and on the
path's first tile the dockhands heap the crates off the boats, up to eight
(`kerb` on a `Bay`, `addKerb` and `baysOpen` in `src/sim/systems/roads/bays.ts`),
for the pickups to load from the road beside it. That is slower than a bay,
so boats start to queue. Truck bays open once `BAY_UNLOCK_CRATES` (30)
crates have come ashore (about the fourth day), or with the Coastal Wharf;
until then the build menu shows the truck bay locked, with how many more.
The heap stays in use while pickups come; built over or cleared, it is gone.

**In the game** (`LANDMARKS` in `src/sim/town.ts`): these three steps, with
the goals measured as crates of a kind trucked out (fish: 12 a day for 3 days
running; lobster: 15 in all, as lobster boats call only every day or two) or
put on board fishing boats in all (ice: 20). The landmark goes up as soon as its
goal is met (no scaffolding yet). The restaurant lets the town grow to 800,
past the 600 the Coastal Wharf needs.

| #   | Landmark               | Goal                                             | Opens                                                                                                                                                | Cap after |
| --- | ---------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 0   | Fishing village        |                                                  | fishery (fish) contracts                                                                                                                             | 100       |
| 1   | **Fish market**        | fish trucked out, 12 crates/day for 3 days       | the market wants **ice** to keep its fish: **ice contracts** (an ice supplier's trucks bring ice to the port, which goes on board the fishing boats) | 200       |
| 2   | **Ice house**          | ice put on board fishing boats, 20 crates in all | boats with ice stay out longer and go further: **lobster boats** (a lobsterman's offer stays on the board till one is signed)                        | 400       |
| 3   | **Seafood restaurant** | lobster trucked out, 15 crates in all            | visitors come for the seafood: the town grows past 600, which lets the harbour authority make the port a **Coastal Wharf**                           | 800       |

## Coastal Wharf: town to large town (cap 800 → 12,800)

With forklifts come **small trucks**: the hauliers that sent pickups send
small trucks instead (`smallTrucks` in `src/sim/systems/economy.ts`), and
haulier offers are for small trucks, or big ones for large truck bays. They
back into the bays, and forklifts load them as well as dockhands: by hand a
truck takes one layer of crates, forklifts set a second on top, so with
forklifts in the port a truck carries twice as much (`src/sim/systems/cargo/beds.ts`).

Goods come in now, not only the catch. Each step's goal uses what the step
before opened, and none counts till the port is a Coastal Wharf (the town
panel says to upgrade till then).

**In the game**: the goals are crates trucked out (or, for canned fish, put
on board ships), and the offer each landmark brings stays on the contracts
board till one is signed (`townTradeOffers` in `src/sim/world.ts`, the makers
in `src/sim/contracts.ts`). The Next step card says what is missing when the
goal cannot move (no coasters, no berth for them, the offer not signed, no
haulier). Saves from before count the steps a town is past by its size: 500+
has its cannery, 600+ its builders' yard, 700+ its school (as they counted
their people then).

| #   | Landmark           | Goal                                                                                                                   | Opens                                                                                                   | Cap after |
| --- | ------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------- |
| 4   | **Cannery**        | fish trucked out, 30 crates/day for 2 days running (more than fishing boats bring: it takes coasters at a 2-wide quay) | the cannery's offer: a shipper whose trucks bring **canned fish** to the port to go out on the coasters | 1,600     |
| 5   | **Builders' yard** | canned fish put on board ships, 25 crates in all (the cannery's line needs a customs office)                           | **Valley Timber Co.**, a coaster line landing **timber** for the yard; the town builds **flats**        | 3,200     |
| 6   | **School**         | timber trucked out, 25 crates in all                                                                                   | families settle; the **department store** opens, and a coaster line offers **goods** for it             | 6,400     |
| 7   | **Town hall**      | goods trucked out, 60 crates in all (the coasters bring a load every day or so, not every day)                         | the town charter: grows past 10,000, which lets the port become a **Container Port**                    | 12,800    |

**Storage holds it back** (`startHolds` and `holds` in `src/sim/world.ts`):
crates of timber and goods off the coasters go into crate storage for cargo
coming in (never a truck bay, nor straight onto a truck) and wait there a
day for customs (`CRATE_CUSTOMS_TICKS`) before a truck may take them; the
crates of goods and the cannery's canned fish going out wait half a day in
the outgoing storage to be inspected (`EXPORT_PAPERS_TICKS`) before they may
go on board (their trucks do no paperwork outside, as container shippers'
do), and their lines need a customs office too. Fish,
lobster and ice are fresh and go at once. So the Coastal Wharf's later
steps need storage for about a day of the coasters' timber and goods: with
both lines signed, about 35 crates a day, two tiles (32 crates) is full
half the time and the coasters wait at anchor, four tiles (64) is hardly
ever full (`tests/coastal-storage.test.ts`). The Next step card says when
storage full of crates in customs, or no storage at all, holds the town up.

**The customs office** (`customs` in `src/sim/rules/buildables.ts`, $1,000,
from the Coastal Wharf, under Buildings with the harbour office and
hut): a line whose cargo customs clears cannot be signed till the port has
one (`needsCustomsOffice` in `src/sim/contracts.ts`): the timber and goods
coasters, feeder lines' containers, and the cannery, for its export papers.
So the builders' yard step, which needs the cannery signed, needs one
first. The offer's card says so and its Sign button is greyed
(`blocked` on the offer, `offerBlocked` in `src/sim/systems/economy.ts`),
the Next step card asks for one, and the advisor tips it the first time
such an offer is on the board. One office does for the whole port: it
does not speed customs up. Lines signed with no office (saves from before
it, or the office pulled down since) go on as they are, with a note on
their contract card that no other like them can be signed.

## Container Port: large town to city (cap 12,800 → no limit)

The town hall now lets the town grow to 12,800, past the 10,000 the Container
Port needs; the Container Port's own steps take it on. Their goals count
containers (`cargo: 'container'` on the goal): trucked out by container
hauliers, or put on board feeders. Totals rather than days running, as a
feeder brings its load every day or two. None counts till the port is a
Container Port. The town's factory (one from 10,000 people, two from 64,000,
`WANTED` in `src/sim/town.ts`) takes some of the containers trucked out.

| #   | Landmark              | Goal                                | Opens                                                                                                                                          | Cap after |
| --- | --------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 8   | **Hospital**          | containers trucked out, 40 in all   | the factory's offer (`factory` on its `ShipperTerms`, `makeFactoryOffer`): its trucks bring **containers going out**, on the board till signed | 25,600    |
| 9   | **Technical college** | containers put on board feeders, 40 | the railway company plans a station                                                                                                            | 51,200    |
| 10  | **Railway station**   | containers trucked out, 100 in all  | trains stop in town, which grows on without limit towards a city (64,000, which the Bulk Terminal will need)                                   | no limit  |

The station goes up on open land beside the main line, facing it, near the
square (`stationSite` in `src/sim/town.ts`). Opening it lets the port lay
**rail sidings** (`src/sim/rules/rails.ts`, `sidingsOpen` in
`src/sim/systems/trains.ts`) and puts a **rail line's** offer on the board
till one is signed (`RailTerms`, `makeRailOffer`; it cannot be signed
without a siding). Its container trains call every day or two at a siding
with a container yard a row or two off it (`yardsBeside`), bring containers
to go out on the feeders (paid as they go on board) and take containers
off the feeders away inland (paid as the train leaves), for the railway's
daily fee; reach stackers work the wagons (`src/sim/systems/cargo/wagons.ts`).
Passenger trains stop at the station (`stationRow`), which the town puts up
beside the line however far it runs from town. The Next step card asks for a
feeder line and container hauliers, or for the factory's offer to be
signed. Saves from before count the steps a town is past by its size, as
for the Coastal Wharf's.

## The region (from the Container Port)

From the railway station on the port serves a **region** as well
(`src/sim/region.ts`, laid out from the map's seed): places along the main
line past the map's ends, shown in the Region tab of the Town panel
(`src/ui/Region.tsx`). Two **cities**, one past each end, send container
trains (`RailTerms.place`; `railOffers` in `src/sim/systems/economy.ts`):
the nearer offers its line as soon as the port may lay sidings, the other
once the first has its distribution park. A city's trains come in from its
end of the line. Each city takes steps as the port carries containers for
it (`served` in `src/sim/systems/region.ts`), counted as its trains leave
with them (`inland`) and as the containers they brought go on board
(`out`, by `Crate.place`):

| Step                  | Goal                                                | Opens                            | Cap after |
| --------------------- | --------------------------------------------------- | -------------------------------- | --------- |
| (start)               |                                                     |                                  | 64,000    |
| **Freight terminal**  | its trains take 40 containers inland                | its trains take 4 more a train   | 83,200    |
| **Distribution park** | 40 containers its trains brought put on board ships | the other city offers its trains | 115,200   |
| **Business district** | 200 containers moved for it, in and out             | it grows on                      | 160,000   |

A city grows each day it has been served lately, 12% of the way to its cap
(`regionDay`). The **works** (a colliery, farms with a grain co-op, an ore
mine, a power station, a steelworks) keep their size and wait for the Bulk
Terminal, which their bulk chains will need (M5 in `plan.md`).

The **Bulk Terminal** needs 352,000 people in the region (`Tier.region`):
the town's with the places' (`World.regionSize`), about 220,000 when the
station opens.

## Bulk Terminal (coal, first version)

Bulk lines (`vessel: 'bulker'`, `bulk: 'coal'` on their `FisheryTerms`,
from the Bulk Terminal on in `makeOffer`) send bulk carriers of 300 to 600
tonnes (`Boat.crates` counts tonnes) that berth only at a **grab crane**
and pay by the tonne as it lands it (`src/sim/systems/bulk.ts`). Belts,
stockpiles and a rail loadout carry it to the **power station's coal
trains** (`makeCoalTrainOffer`, offered by `railOffers` from the Bulk
Terminal on), hopper wagons that pay by the tonne as they leave and count
towards the power station in the region. Grain and ore, ship loaders and
wagon unloaders, and the works' own steps come next (M5 in `plan.md`).

## What the player sees

- **Town panel** (Town button in the top bar and phone menu): a **Next
  step** card on top: the landmark's name and picture, its goal with a
  progress bar ("Fish to the market: 9 of 12 crates a day, day 2 of 3"),
  what it will open, and the cap ("The town can grow to 150 people").
- **Advisor tip** as each landmark opens, saying what it opened and what
  the next goal is.
- **The mayor** (Mayor Bramblewick, bottom right, `src/ui/TownMayor.tsx`,
  the 3D model in `src/render/mayor.ts`, what is said when in
  `src/ui/mayorTalk.ts`): an animated portrait that opens into a
  speech bubble asking, in the town's words, for the next landmark, cheering
  each opening with what it brings, and now and then saying how it goes: a
  day kept up or the run broken, half way and nearly there, about once a
  day the count and what holds it up (the Next step card's hint), the town
  full at its cap, and the wait for the port's next tier. Worked out on the
  page from the snapshot, not saved. Each line about the goal ends with a
  link to the lesson that shows how (or, for ice and lobster, the offer to
  sign); Options > Gameplay can keep it quiet
  (a dot on the portrait instead of popping up).
- **In the town**: scaffolding where the landmark goes up, then the
  building itself, with a red ! when the goal slips (deliveries dropped).
- **Port panel**: the upgrade meter says which landmark the town needs
  before it can reach the next port tier, not just a number of people.
- Contracts, cargo and buildings a landmark opens appear only once it has
  (nothing locked is shown; see the build menus).

## Notes for building it

- Landmarks are town buildings (like the fish market and cannery now in
  `BUSINESSES` in `src/sim/town.ts`), placed by the town, not the player.
- Keep the goals data-driven: a list of steps with `goal` (what is
  measured, how much, how long), `opens` (contract kinds, cargo kinds,
  buildables) and `cap`.
- Cargo kinds per crate already exist (`src/sim/cargo.ts`): goals count
  deliveries of a kind to the town, or on board boats.
- Saves: a save from before this counts the steps its town already has as
  done (a town past 300 has its restaurant, past 500 its cannery, and so on,
  counted as they were before each landmark doubled the town).
