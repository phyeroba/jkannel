-- Reverses 051_pii_reveal.
--
-- Dropping the table removes the record of who was permitted to see unmasked
-- subscriber data and when. That history is the evidence a privacy question is
-- answered with, so export it before reverting if any grant has been used:
--
--   SELECT user_id, reason, granted_at, expires_at, reveal_count
--     FROM pii_reveal_grants WHERE reveal_count > 0;
--
-- The individual reveal events remain in audit_log regardless; this drops only
-- the grants that authorised them.
BEGIN;

DROP TABLE IF EXISTS pii_reveal_grants;

-- Removing the permission removes the grants that reference it (FK cascade in
-- role_permissions), which is correct: with no table to hold a reveal window,
-- the permission would authorise nothing.
DELETE FROM role_permissions
 WHERE permission_id IN (SELECT id FROM permissions WHERE code = 'messages.reveal');
DELETE FROM permissions WHERE code = 'messages.reveal';

COMMIT;
