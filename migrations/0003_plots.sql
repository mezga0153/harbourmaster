-- How much land the port owns as each day ends: plots of 16 by 16 tiles,
-- bought one at a time beside the port's own (src/sim/land.ts), counting the
-- few a new game starts with. Days sent before land was bought have none.
ALTER TABLE days ADD COLUMN plots INTEGER;
