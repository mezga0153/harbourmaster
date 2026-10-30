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

| # | Landmark | Goal | Opens | Cap after |
|---|---|---|---|---|
| 0 | Fishing village | | fishery (fish) contracts | 100 |
| 1 | **Fish market** | fish delivered to town, 12 crates/day for 3 days | the market wants **ice** to keep its fish: **ice contracts** (an ice supplier's trucks bring ice to the port, which goes on board the fishing boats) | 150 |
| 2 | **Ice house** | ice put on board fishing boats, 20 crates over 5 days | boats with ice stay out longer and go further: **shellfish and lobster boats** | 200 |
| 3 | **Seafood restaurant** | lobster and shellfish delivered to town, 6 crates/day for 3 days | visitors come for the seafood: the town grows past 300, which lets the harbour authority make the port a **Coastal Wharf** | 400 |

## Coastal Wharf: town to large town (cap 400 → 800+)

Goods come in now, not only the catch. More steps, each a clear landmark:

| # | Landmark | Goal | Opens | Cap after |
|---|---|---|---|---|
| 4 | **Cannery** | fish for canning, 24 crates/day for 3 days | **canned fish** as an export (the first goods made in town that leave by sea) | 500 |
| 5 | **Builders' yard** | timber delivered (Valley Timber Co. by coaster) | the town builds faster and bigger homes: **flats** | 600 |
| 6 | **School** | the town has 500 people and the builders' yard is supplied | families settle: growth speeds up; **goods** contracts (department store) | 700 |
| 7 | **Town hall** | goods to the department store, 20 crates/day for 5 days, and canned fish exported | the town charter: grows past 800, which lets the port become a **Container Port** | 900 |

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
  done (a town past 300 has its restaurant).
