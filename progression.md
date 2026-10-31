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
- The next **landmark** has a goal the port must meet: a delivery kept up
  for a while (e.g. 12 crates of fish a day for 3 days), or a contract kept
  going. Progress is measured, not ticked off by hand.
- When the goal is met, the town **builds the landmark**: it shows as
  scaffolding for a day, then opens. Opening it raises the cap, may add a
  business that wants goods, and **unlocks** contracts, cargo or buildings
  for the port.
- One step at a time: the next goal only shows once the last landmark has
  opened.

## Fishing Jetty: village to town (cap 100 → 300+)

**In the game** (`LANDMARKS` in `src/sim/town.ts`): these three steps, with
the goals measured as crates of a kind trucked out (fish: 12 a day for 3 days
running; lobster: 15 in all, as lobster boats call only every day or two) or
put on board fishing boats in all (ice: 20). The landmark goes up as soon as its
goal is met (no scaffolding yet). The restaurant lets the town grow to 400,
past the 300 the Coastal Wharf needs.

| # | Landmark | Goal | Opens | Cap after |
|---|---|---|---|---|
| 0 | Fishing village | | fishery (fish) contracts | 100 |
| 1 | **Fish market** | fish trucked out, 12 crates/day for 3 days | the market wants **ice** to keep its fish: **ice contracts** (an ice supplier's trucks bring ice to the port, which goes on board the fishing boats) | 150 |
| 2 | **Ice house** | ice put on board fishing boats, 20 crates in all | boats with ice stay out longer and go further: **lobster boats** (a lobsterman's offer stays on the board till one is signed) | 200 |
| 3 | **Seafood restaurant** | lobster trucked out, 15 crates in all | visitors come for the seafood: the town grows past 300, which lets the harbour authority make the port a **Coastal Wharf** | 400 |

## Coastal Wharf: town to large town (cap 400 → 800+)

Goods come in now, not only the catch. Each step's goal uses what the step
before opened, and none counts till the port is a Coastal Wharf (the town
panel says to upgrade till then).

**In the game**: the goals are crates trucked out (or, for canned fish, put
on board ships), and the offer each landmark brings stays on the contracts
board till one is signed (`townTradeOffers` in `src/sim/world.ts`, the makers
in `src/sim/contracts.ts`). The Next step card says what is missing when the
goal cannot move (no coasters, no berth for them, the offer not signed, no
haulier). Saves from before count the steps a town is past by its size: 500+
has its cannery, 600+ its builders' yard, 700+ its school.

| # | Landmark | Goal | Opens | Cap after |
|---|---|---|---|---|
| 4 | **Cannery** | fish trucked out, 30 crates/day for 3 days (more than fishing boats bring: it takes coasters at a 2-wide quay) | the cannery's offer: a shipper whose trucks bring **canned fish** to the port to go out on the coasters | 500 |
| 5 | **Builders' yard** | canned fish put on board ships, 40 crates in all | **Valley Timber Co.**, a coaster line landing **timber** for the yard; the town builds **flats** | 600 |
| 6 | **School** | timber trucked out, 40 crates in all | families settle; the **department store** opens, and a coaster line offers **goods** for it | 700 |
| 7 | **Town hall** | goods trucked out, 20 crates/day for 5 days | the town charter: grows past 800, which lets the port become a **Container Port** | no limit |

## Container Port and on (sketch)

The same shape: a factory that wants containers, a railway station, a
hospital, a stadium... each with a goal the port meets. To be worked out
when the container port's own goods chain is.

## What the player sees

- **Town panel** (Town button in the top bar and phone menu): a **Next
  step** card on top: the landmark's name and picture, its goal with a
  progress bar ("Fish to the market: 9 of 12 crates a day, day 2 of 3"),
  what it will open, and the cap ("The town can grow to 150 people").
- **Advisor tip** as each landmark opens, saying what it opened and what
  the next goal is.
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
  done (a town past 300 has its restaurant, past 500 its cannery, and so on).
