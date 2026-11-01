import { World } from '../src/sim/world';

// Most tests build ports all over the map, as before land was bought: their
// new games own all of it. Tests of buying land, and the playthrough, which
// buys it as a player would, pass ownAll false to World.create.
World.ownAllLand = true;
// Most were built round the truck bay a new game used to start with, at the
// road's end; tests of the heap there in its place set this false.
World.startBay = true;
