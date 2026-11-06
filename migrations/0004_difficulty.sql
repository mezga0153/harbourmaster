-- How kind the game is, picked for a new port (src/sim/balance.ts
-- DIFFICULTIES): easy, medium or hard. Days sent before there was a choice,
-- all played on what is now hard, have none.
ALTER TABLE days ADD COLUMN difficulty TEXT;
