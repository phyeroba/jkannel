-- Reverses 048_carriers.
--
-- The column is dropped before the table, because the foreign key would
-- otherwise hold it. Dropping `carrier_id` discards which network each SMSC
-- belonged to — an organisational fact that has to be re-entered, but no
-- traffic-carrying configuration: engine ids, credentials, routing targets and
-- bind state are all on smsc_definitions and untouched.
BEGIN;

ALTER TABLE smsc_definitions DROP COLUMN IF EXISTS carrier_id;
DROP TABLE IF EXISTS carriers;

COMMIT;
