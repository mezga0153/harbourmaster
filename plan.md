# Port Game — Plan

Working title: **Harbourmaster**

An isometric port-management game that runs entirely in the browser. You start with a wooden jetty and one dockhand carrying crates from small boats to a truck, and grow it into a mega-port with gantry cranes, bulk conveyors, tank farms and automated container yards.

- **Feel:** Theme Hospital. You hire people with personalities, they get tired and grumpy, things break, inspectors arrive, and the game is funny.
- **Building:** Factorio. You lay out roads, belts, pipes and rails on a grid, throughput is what counts, and bottlenecks are something you can see.
- **Look:** `example.png`. Clean, bright, low-poly isometric 3D with saturated containers, blue and yellow cranes, deep blue water and light concrete.

---

## 1. Design pillars

1. **Start tiny, end huge.** The first five minutes are one man, one boat and one truck. Each new tier adds a new kind of logistics problem, not just bigger numbers.
2. **The port is readable at a glance.** You can see every crate, container, tonne of coal and litre of oil moving. When something is stuck, you can see where.
3. **People matter.** Staff have names, skills, wages, morale and needs. A great crane operator is worth keeping happy.
4. **Machines are the reward.** Unlocking and placing a new machine (straddle carrier, STS crane, stacker-reclaimer) should feel like getting a new toy.
5. **Gentle chaos.** Storms, strikes, customs raids, rats in the grain silo and VIP visits break up the routine.

---

## 2. Core gameplay loop

```
Contracts / ship schedule
        │
        ▼
Ship arrives ──► berths at quay ──► cargo unloaded (people / machines)
                                          │
                                          ▼
                              moved & stored (carts, belts, yard, tanks)
                                          │
                                          ▼
                    loaded onto land transport (truck, later rail / pipeline)
                                          │
                                          ▼
                               💰 Paid per unit + on-time bonus
                                          │
                                          ▼
         Spend on: staff, machines, buildings, research, dredging, land
```

Exports run the same loop in reverse: trucks or rail deliver cargo, you store it, and ships take it away.

**Pressure sources:**

- Ships pay **demurrage penalties** if they wait too long at anchor or berth.
- Truck drivers get impatient, honk, and hurt reputation.
- Contracts have deadlines and minimum volumes.
- Wages, maintenance and loan interest are charged every day.

---

## 3. Cargo types and progression tiers

Each tier unlocks through **milestones** (cash, reputation, volume handled) plus **research** at the Harbour Office.

| Tier | Name            | New cargo                                   | Ships                   | Key unlocks                                                                               |
| ---- | --------------- | ------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| 0    | Fishing Jetty   | Crates, sacks (break-bulk, carried by hand) | Rowboat / small coaster | Wooden pier, dockhand, truck bay, hand cart                                               |
| 1    | Coastal Wharf   | Pallets                                     | Small general cargo     | Concrete quay, forklift, warehouse, jib crane, break room, harbour office                 |
| 2    | Container Start | 20ft / 40ft containers                      | Feeder ship (~300 TEU)  | Mobile harbour crane, reach stacker, container yard, truck gate, customs shed             |
| 3    | Bulk Terminal   | Coal, grain, ore (tonnes)                   | Handysize bulk carrier  | Grab crane, hopper, **conveyor belts**, stockpiles, silos, stacker-reclaimer, rail siding |
| 4    | Liquid Terminal | Oil, chemicals, later LNG (m³)              | Product tanker          | **Pipes**, pumps, loading arms, tank farm, fire station, spill response                   |
| 5    | Container Hub   | High-volume containers, reefers             | Panamax / Post-Panamax  | STS gantry crane, straddle carrier, RTG crane, reefer stacks, rail terminal               |
| 6    | Mega Port       | Everything at scale                         | ULCS (20k+ TEU), VLCC   | Automated stacking cranes, AGVs, remote-operated STS, dredger, port control tower         |

Possible later tiers: RoRo (cars), cruise terminal (passengers, Theme Hospital-style queues), shipyard.

### Water depth

Every berth has a **draft**. Bigger ships need deeper water, so **dredging** is a major investment and acts as a natural gate on growth.

---

## 4. Building system (the Factorio side)

The map is a **tile grid** with layers:

- **Terrain:** water (with depth), sand, land, rock.
- **Ground:** concrete, asphalt road, rail, footpath.
- **Network:** conveyor belts (directional), pipes, power lines (later tiers).
- **Structures:** multi-tile buildings and machines, each with a footprint, rotation, and input/output ports.

**Build tools:**

- Drag to place roads, belts, pipes and rails.
- Place buildings with a ghost preview: rotate with `R`, red when invalid.
- Bulldoze returns part of the cost.
- Use **zones** for open areas such as container yards, stockpiles and parking. You paint the zone and machines work inside it, similar to Theme Hospital rooms.
- Use **rooms** for staff buildings such as the break room, canteen, toilets, training centre and control room. You paint a room footprint and place furniture inside it.

**Logistics primitives:**

| Primitive       | Carries                  | Moved by                                     |
| --------------- | ------------------------ | -------------------------------------------- |
| Footpath / quay | Crates, sacks, pallets   | Dockhands, hand carts, forklifts             |
| Road            | Containers, pallets      | Trucks, terminal tractors, straddle carriers |
| Conveyor        | Bulk (tonnes/s)          | Belts, with throughput limits                |
| Pipe            | Liquids (m³/s)           | Pumps, with throughput limits                |
| Rail            | Containers, bulk, liquid | Trains (tier 3+)                             |

---

## 5. Staff (the Theme Hospital side)

You hire from a rotating **candidate list**. Each candidate has:

- **Name, portrait** (procedurally generated), **wage** and **traits**, such as _Fast_, _Lazy_, _Careful_, _Union rep_, _Ex-navy_ or _Coffee addict_.
- **Skills (1–5)** per role. Higher skill means faster work and fewer accidents.
- **Needs:** energy, morale, bladder and hunger. These are satisfied by break rooms, toilets and canteens.

| Role                    | Does                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Dockhand                | Carries cargo by hand, lashes and unlashes containers                                                               |
| Machine operator        | Required to run forklifts, cranes and straddle carriers (licence per machine class, learned at the training centre) |
| Mechanic                | Repairs and maintains machines, similar to the Handyman                                                             |
| Clerk / Customs officer | Processes paperwork; bottleneck for truck gates and inspections                                                     |
| Pilot / Tug crew        | Brings big ships in (tier 2+)                                                                                       |
| Security                | Prevents theft and smuggling events                                                                                 |
| Firefighter             | Liquid terminal safety (tier 4+)                                                                                    |

**Theme Hospital-style touches:**

- Staff ask for raises. If you refuse, morale drops and they may quit or strike.
- Clicking a person shows their thoughts, for example "I need a coffee" or "This crane is making a weird noise."
- Advisor messages appear as a small ticker or popup with a character, the Harbourmaster's assistant.
- Year-end awards, inspections and VIP visits.

---

## 6. Machines

Every machine has a **purchase cost**, **upkeep**, **speed**, **capacity**, **reliability** (it breaks down over time and needs a mechanic), **operator requirement**, and an **upgrade path**.

**Example progression for moving a container off a ship:**
dockhand + rope → jib crane → mobile harbour crane → STS gantry crane → twin-lift STS → remote-operated STS

**Example progression for moving a container across the yard:**
forklift → reach stacker → terminal tractor + chassis → straddle carrier → AGV

Machines are animated agents: cranes swing, spreaders lower, straddle carriers drive. This is the core visual payoff.

---

## 7. Economy

- **Income:** per-unit handling fees, storage fees (cargo left in the yard), contract bonuses, and later port dues per ship call.
- **Costs:** wages (daily), machine upkeep, energy (tier 3+), loan interest, land expansion, dredging, research.
- **Contracts board:** shipping lines offer contracts such as "2 feeder calls/week, 150 TEU each, 6-month term." Accepting one locks in a schedule, and failing it costs reputation.
- **Reputation** per shipping line and overall. It unlocks bigger customers.
- **Loans** from the bank, as in Theme Hospital.
- **Calendar:** days, months and years. One in-game day is about 60 seconds at 1x speed. Speeds are pause, 1x, 2x, 4x and 8x.

---

## 8. Events

| Event                 | Effect                                                             |
| --------------------- | ------------------------------------------------------------------ |
| Storm                 | Ships wait at anchor; cranes must stop above a wind threshold      |
| Fog                   | Pilots are required; arrivals slow down                            |
| Strike                | Staff with low morale walk out until demands are met               |
| Customs inspection    | Random containers are held; clerks are needed                      |
| Smuggling             | Security catches it for a bonus, or you get fined                  |
| Rats in grain silo    | Bulk cargo spoils unless pest control is called                    |
| Oil spill             | Big fine plus a cleanup minigame; firefighters and booms reduce it |
| VIP visit / inspector | Graded on cleanliness, queues and staff happiness                  |
| Breakdown             | Machine stops until a mechanic arrives                             |

---

## 9. Visual style (from `example.png`)

- **Projection:** true 3D scene rendered with an **orthographic camera** at an isometric angle (≈35° pitch, 45° yaw). There are 4 rotation steps (Q/E), scroll zoom, and drag pan.
- **Models:** low-poly and flat-shaded, built **procedurally from boxes and cylinders in code**. This means no art pipeline is needed, and every machine can be parameterised (crane height, boom length). We review how this looks after M4 (see §15).
- **Palette:**
  - Water `#1f6fb2` → `#2a8fd6` (deeper water is darker)
  - Concrete `#d9dde0`, asphalt `#7b8188`, road markings white/yellow
  - Containers: red `#d6453d`, blue `#2f6fd0`, yellow `#f2c230`, green `#3fa34d`, orange, white, teal
  - Cranes: STS blue `#2f7de0`, harbour cranes yellow `#f5c02a`
  - Ships: dark navy/red hulls with white superstructure
- **Lighting:** one warm directional sun with soft shadows plus a cool ambient/hemisphere light. Light ambient occlusion can come later.
- **Water:** a flat plane with a subtle vertex-wave shader, foam trails behind moving ships, and gentle bob on moored ships.
- **Life:** seagulls, truck exhaust puffs, blinking crane lights, and a day/night cycle with harbour lights at night (later).
- **UI:** a chunky, friendly flat UI with rounded panels, big icons and a bottom build bar, similar to Theme Hospital's bottom panel but modern.

---

## 10. Tech stack

| Concern     | Choice                                                                     | Why                                                                      |
| ----------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Language    | **TypeScript**                                                             | Large simulation codebase; types pay off                                 |
| Build       | **Vite**                                                                   | Fast dev server, simple static build, deploys anywhere                   |
| Rendering   | **Three.js** (WebGL2)                                                      | Orthographic iso camera, instancing for thousands of containers, shadows |
| UI          | **Preact** + signals, DOM overlay on the canvas                            | Panels, lists and dialogs are easier in DOM than in canvas               |
| Pathfinding | Own A* on the tile grid plus flow fields for many trucks                   | Small, tailored, no dependency needed                                    |
| Threading   | Sim in a **Web Worker** (Vite's native worker support)                     | Keeps rendering and UI smooth as the port grows                          |
| Persistence | **IndexedDB** (autosave plus slots), JSON save format with a version field | localStorage is too small for large ports                                |
| Audio       | Web Audio API                                                              | Ambient waves, gulls, horns, crane hum                                   |
| Tests       | **Vitest** for the simulation (deterministic, headless)                    | Economy and logistics bugs are subtle                                    |
| Formatting  | Prettier                                                                   | —                                                                        |

Dependencies are kept minimal: three, preact, @preact/signals, plus dev tools. npm v11.10+ with a project `.npmrc` containing `save-exact=true` and `min-release-age=7`.

No backend. The game is a static site that can be hosted on Cloudflare Pages, GitHub Pages or similar.

---

## 11. Architecture

The **simulation** and **rendering** are strictly separated. The sim is plain TypeScript with no Three.js imports and no DOM access. It runs at a fixed tick and is deterministic given a seed, so it can be tested headlessly.

### Threads

```
 Main thread                                   Sim worker
 ───────────                                   ──────────
 three.js render (60 fps) ◄── snapshot ─────── fixed-step sim (10 ticks/s × speed)
 Preact UI                    (per tick)       owns all game state
 input / picking   ──────── commands ────────► validates + applies commands
                              (build, hire,    autosave → IndexedDB
                               speed, …)
```

- The **worker** owns the authoritative game state. Nothing else mutates it.
- The **main thread** sends **commands** (`build`, `bulldoze`, `hire`, `setSpeed`, …) as plain serialisable objects. The worker validates them, so an invalid build is rejected by the sim rather than trusted from the UI.
- After each tick the worker posts a **snapshot**: positions and states of moving entities, plus economy and calendar values. Static data such as the tile map is sent once, then only as **diffs** when it changes. Large per-entity arrays go in transferable `Float32Array`s to avoid copying cost.
- The renderer **interpolates** between the last two snapshots, so movement is smooth at 60 fps even though the sim ticks at 10 Hz.
- The worker writes saves to IndexedDB directly, so saving never stutters the render loop.
- The same sim code runs in Vitest without a worker.

```
src/
  main.ts                 bootstrap: start worker, renderer, UI
  protocol.ts             command + snapshot message types (shared)
  worker/
    sim.worker.ts         worker entry: loop, command queue, snapshot posting
  sim/                    pure game logic (no DOM, no three)
    mapgen.ts             seeded coastline generation
    world.ts              grid, layers, entity registry
    tick.ts               fixed-step loop (10 ticks/s × speed)
    entities/             ships, trucks, people, machines, cargo
    systems/              jobs, pathfinding, movement, logistics,
                          economy, staff-needs, events, contracts
    data/                 content definitions (see below)
    save.ts               serialise / migrate
  render/                 three.js scene
    camera.ts             iso ortho camera, rotate/zoom/pan
    terrain.ts            tiles, water shader
    models/               procedural meshes per entity type
    instancing.ts         containers, crates, people
    picking.ts            mouse → tile / entity
  ui/                     preact components
    hud/ build/ panels/ dialogs/ advisor/
  audio/
tests/                    vitest, sim-only
```

### Map generation

- The map is a seeded grid, starting at 96 × 96 tiles, with land along one or two edges and open sea on the far side. Ships always arrive from the open-sea edge.
- The coastline is shaped with seeded value noise: a wobbly shoreline, a few bays and headlands, beaches, and the occasional rocky outcrop that is expensive to clear.
- Water depth increases with distance from the shore, plus noise. Natural deep pockets close to shore are valuable berth spots. Shallow areas need dredging.
- A road enters from the inland edge so trucks have somewhere to come from and go to.
- The start area is checked so a small jetty can always fit near the road: a stretch of shoreline within reach of the road with shallow water in front.

### Simulation core concepts

- **Job system:** this is the heart of the game. Ships, buildings and zones post jobs such as `move cargo X from A to B` or `repair machine M`. Idle workers and machines that can do the job claim it, ranked by distance, skill and priority. This is the same model as Theme Hospital's staff and RimWorld's job queue.
- **Cargo as entities:** each crate, pallet and container is a tracked entity with an owner contract, destination and dwell time. Bulk and liquid cargo are **quantities** in buffers (ship hold → hopper → belt segment → stockpile → train wagon), not individual entities.
- **Belts and pipes:** these are simulated as a graph of segments with throughput caps, using Factorio-style lane items for belts only where they are visible on screen.
- **Ships:** arrive from the map edge along water lanes, wait at an anchorage if no suitable berth is free, need a pilot and tug at tier 2+, berth, then expose their holds and bays as job sources.
- **Content as data:** all machines, buildings, cargo types, ships, staff roles, research and events are defined in `sim/data/*.ts` as typed objects. Balancing is done by editing data, not code.

### Performance targets

- 60 fps with about 5,000 containers, 300 vehicles and 200 people on a mid-range laptop.
- Instanced meshes for containers, crates and people; one draw call per type and colour.
- Chunked terrain meshes that are rebuilt only when edited.
- Sim cost is budgeted per tick. Pathfinding results are cached and invalidated per changed chunk.

---

## 12. Controls

| Input                           | Action                                                            |
| ------------------------------- | ----------------------------------------------------------------- |
| Left-drag / WASD / screen edges | Pan                                                               |
| Wheel                           | Zoom                                                              |
| Q / E                           | Rotate view 90°                                                   |
| Left-click                      | Select / place                                                    |
| Right-click / Esc               | Cancel                                                            |
| R                               | Rotate building                                                   |
| Space                           | Pause                                                             |
| 1 2 3 4                         | Game speed                                                        |
| B                               | Build menu                                                        |
| H                               | Hire menu                                                         |
| Delete                          | Bulldoze                                                          |
| F1                              | Overlay toggles (water depth, congestion, staff needs, belt flow) |

---

## 13. Roadmap

Each milestone ends with something playable.

**Status (27 Oct 2026):** M0 and M1 are done. M2 is mostly done: contracts with failure modes,
capacity planning, staff skills/traits/energy/morale, break huts, candidates and thoughts.
Still open in M2: toilets, raise requests and bank loans. A playthrough bot in
`tests/playthrough.test.ts` checks the balance on every test run.

### M0 — Skeleton ✅

- Vite + TS + Three.js + Preact set up, Prettier and Vitest configured.
- Sim worker, the command/snapshot protocol, and snapshot interpolation in the renderer.
- Seeded random coastline with water depth.
- Iso ortho camera with pan, zoom and rotate.
- Tile grid with water and land, a simple water shader, hover highlight on tiles.
- Fixed-step sim loop with a speed control, and a HUD showing date and cash.

### M1 — The first boat (MVP loop) ✅

- A wooden jetty, one truck bay and one dockhand, placed at the start site picked by map generation.
- A small boat arrives on a timer carrying 10 crates.
- The dockhand walks, picks up a crate, carries it to the truck bay and drops it.
- A truck arrives, waits until full, drives off, and **money is earned**.
- Build: footpath, extra jetty segment, extra truck bay. Hire a second dockhand.
- Save/load to IndexedDB.
- ✅ **Goal:** it is already a tiny satisfying game.

### M2 — Theme Hospital layer (mostly done)

- Staff needs (energy, morale), break room, toilet, wages, raise requests, quitting.
- Candidate list, traits and skills.
- Calendar, daily costs, bank loans.
- Advisor messages; click a person to see their thoughts.
- Contracts board v1.

### M3 — Tier 1: Coastal Wharf

- Concrete quay, pallets, forklift (machine plus operator), warehouse storage.
- Jib crane, mechanic and breakdowns.
- Research at the harbour office; the milestone and unlock framework.

### M4 — Tier 2: Containers

- Containers as instanced entities, container yard zone with stacking rules.
- Mobile harbour crane, reach stacker, truck gate with clerk, customs shed.
- Feeder ships with bay plans (simplified), demurrage.
- Water depth per berth; ships need a pilot.

### M5 — Tier 3: Bulk

- Conveyor belts, hoppers, stockpiles, silos, grab crane, stacker-reclaimer.
- Rail siding and trains.
- Flow overlay and bottleneck visualisation.

### M6 — Tier 4: Liquids

- Pipes, pumps, tank farm, loading arms, tankers.
- Fire station, spill event, safety inspections.

### M7 — Tier 5–6: Hub and Mega Port

- STS gantry, straddle carriers, RTG, reefers, AGVs, automation, control room.
- Dredger, ULCS ships, port expansion (buy adjacent land and water).

### M8 — Polish

- Day/night cycle, weather, audio, particles.
- Tutorial driven by the advisor.
- New-game screen with seed entry and map preview.
- Balancing pass, achievements.

---

## 14. Balancing seeds for M1

These are starting values to tune during play.

| Thing               | Value                                   |
| ------------------- | --------------------------------------- |
| Starting cash       | $5,000                                  |
| Dockhand wage       | $40 / day                               |
| Crate handling fee  | $15                                     |
| Boat interval       | every ~0.5 days, 8–12 crates            |
| Truck capacity      | 6 crates                                |
| Dockhand carry time | ~4 s per crate over 10 tiles (1x speed) |
| Extra jetty segment | $500                                    |
| Tier 1 unlock       | $15,000 cash + 500 crates handled       |

---

## 15. Decisions

- **Sandbox first.** One persistent port that grows through milestones. Scenario levels with goals may come after M8.
- **Random coastline.** Each new game generates the map from a seed (see §11, Map generation). The seed is shown in the UI and stored in the save, so a map can be replayed.
- **Simulation in a Web Worker from day one.** See §11. The UI never touches sim state directly; it only sends commands and reads snapshots.
- **In-code art.** All models are procedural. We revisit this after M4. If the hero machines (STS crane, ships) look weak, they become glTF models, and the rest stays procedural.

## 16. Open questions

- **Mobile/touch support:** nice to have, not targeted for the MVP.
