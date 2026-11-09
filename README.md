# Harbourmaster ⚓

> _"The tide waits for no one, but the fishing boats will wait at anchor,
> and they will send you the bill."_

A cosy, slightly salty port-building game. You start with a wobbly jetty,
a handful of dockhands, and a village called something like Pebbleness
that would quite like some fish, please. Everything else is up to you.

**Play it:** <https://harbourmaster.tinetov.net>

## What happens here

Boats come in. Crates come off. Trucks take them away. Money happens.
Then the town gets ideas.

The town up the coast doesn't grow on its own. It grows when the port keeps
it supplied, and every time you hit a goal it builds a **landmark** and
starts wanting something new:

| The town builds…        | …and suddenly wants                              |
| ----------------------- | ------------------------------------------------ |
| 🐟 a fish market        | ice, to keep the fish from getting opinions      |
| 🧊 an ice house         | lobster, because the boats can now go further    |
| 🦞 a seafood restaurant | tourists, and a proper Coastal Wharf             |
| 🥫 a cannery            | coasters, and a customs office for the paperwork |
| 🪵 a builders' yard     | timber, for flats                                |
| 🏫 a school             | a department store full of goods                 |
| 🏛️ a town hall          | a Container Port, because it has a charter now   |
| 🏥 … 🚂                 | containers, cranes, and eventually trains        |

Your port climbs alongside it: **Fishing Jetty → Coastal Wharf → Container
Port → Bulk Terminal**. Each step brings forklifts, jib cranes, gantries,
reach stackers, rail sidings, grab cranes and conveyor belts that rattle
coal into stockpiles. The full staircase is in
[progression.md](progression.md).

Along the way you will learn that:

- dockhands are people, and people need tea breaks
- one jetty is never enough
- a truck with nowhere to park simply won't come, out of principle
- two coasters can block each other off a pier's end _forever_ if you let them
- a roundabout fixes more than you'd expect

Everything is simulated: every crate is a real crate in a real stack, every
dockhand walks to it, picks it up and carries it, and every ship works out
for itself how to get round the pier without scraping the paint.

## Getting it running

```sh
npm install
npm run dev        # http://localhost:5199
```

| Command             | What it does                                  |
| ------------------- | --------------------------------------------- |
| `npm run dev`       | the game, plus the dev lab at `/dev.html`     |
| `npm test`          | the sim's tests (vitest, no browser needed)   |
| `npm run typecheck` | TypeScript's opinion                          |
| `npm run build`     | a build for the web                           |
| `./deploy.sh`       | ships what's committed to the live site       |
| `./stats.sh gui`    | how real players are getting on (anonymously) |

### Peeking under the hull

- **The dev lab** (`/dev.html`): every model on a turntable, animations on
  sliders, whole scenes you can pause, poke and step a tick at a time, and
  small replayable scenarios for when the boats misbehave.
- **Debug overlays** (the `` ` `` key, dev server only): paths, passability,
  crane reach, the trucks' road graph, and what every worker thinks it's
  doing.
- **The debug bridge**: while the dev game is open, it writes a readable
  report of the whole port into `.debug/` every few seconds, so you (or a
  helpful robot) can see what's going on without squinting at the screen.

[CLAUDE.md](CLAUDE.md) has the detailed map of the code.

## What it's made of

TypeScript, [three.js](https://threejs.org) for the 3D view,
[Preact](https://preactjs.com) for the panels, a simulation that runs in a
Web Worker, and a small Cloudflare Worker that serves the game and keeps a
play log. Boats, ships, trucks and people are drawn in code; the rest is
borrowed with thanks:

- containers, trees and rocks from [Kenney](https://kenney.nl) (CC0)
- instrument samples from the
  [Versilian Community Sample Library](https://github.com/sgossner/VCSL) (CC0)
- the water's ripples from the three.js examples (MIT)

---

_No seagulls were harmed in the making of this game. Several were annoyed._
