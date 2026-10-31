import { World } from '../src/sim/world';

// Most tests build ports all over the map, as before land was bought: their
// new games own all of it. Tests of buying land, and the playthrough, which
// buys it as a player would, pass ownAll false to World.create.
World.ownAllLand = true;
