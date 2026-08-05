-- 041_smsc_resilience
-- Carrier-grade connection resilience for smsc_definitions: parallel binds,
-- idle-link detection, bind-failure recovery and declarative carrier
-- preference/fallback.
--
-- Every directive these columns feed was verified against the engine this
-- deployment actually runs -- Kamex 1.8.3 (ghcr.io/vaska94/kamex:1.8.3, the
-- image the kamex-validator container is built FROM). Kamex's configuration
-- parser is strict: gwlib/cfg.c `cfg_read` -> `is_allowed_in_group` returns -1
-- for any variable that is not declared for the group and the whole
-- configuration load FAILS. So a directive that is not in gwlib/cfg.def is not
-- "ignored", it breaks the gateway. Each name below was checked against the
-- MULTI_GROUP(smsc, ...) block of gwlib/cfg.def and against the driver source
-- that reads it; the mapping is recorded in the COMMENTs at the end.
--
-- Additive only: ADD COLUMN IF NOT EXISTS throughout, and every default is
-- chosen so ConfigurationGeneratorService renders byte-identical output to
-- today until an operator explicitly opts in. Nothing here recreates the
-- tenant_isolation policy or FORCE ROW LEVEL SECURITY on smsc_definitions --
-- migrations 004/011 own those and new columns inherit them, exactly as in
-- migration 029. The GRANT is restated (idempotent) to match the pattern in
-- 026_customers_depth.
BEGIN;

ALTER TABLE smsc_definitions
  -- Parallel binds. Kamex renders this as the `instances` directive, which
  -- gw/bb_smscconn.c reads via smscconn_instances() and turns into N separate
  -- SMSCConn objects created from the ONE smsc group -- all sharing this row's
  -- smsc-id. bearerbox's router (smsc2_rout) then spreads traffic across them
  -- from a random start offset, picking the least-loaded usable connection.
  -- This is what lets a carrier that permits N simultaneous binds be used at
  -- full capacity instead of 1/N.
  --
  -- Default 1 reproduces today's single-bind output exactly (the renderer
  -- omits `instances` entirely when the count is 1).
  ADD COLUMN IF NOT EXISTS connection_count integer NOT NULL DEFAULT 1,

  -- Dead-but-open socket detection. gw/smsc/smsc_smpp.c breaks the session and
  -- reconnects when no PDU response has been seen for connection-timeout
  -- seconds ("connection seems to be broken ... reconnecting"). The engine's
  -- own default is SMPP_DEFAULT_CONNECTION_TIMEOUT = 10 * the enquire-link
  -- interval = 300s, and 0 disables the check. NULL here means "do not emit the
  -- directive, let the engine apply its 300s default", which is why this column
  -- is nullable rather than defaulted: emitting `connection-timeout = 300`
  -- unconditionally would change every existing deployment's config checksum
  -- and register as drift for no behavioural gain.
  ADD COLUMN IF NOT EXISTS connection_timeout_seconds integer,

  -- What the SMPP driver does when a submit_sm_resp never arrives within
  -- wait_ack_seconds. gw/smsc/smsc_smpp.c: 0 = SMPP_WAITACK_RECONNECT (drop and
  -- rebuild the bind), 1 = SMPP_WAITACK_REQUEUE (put the message back on the
  -- global queue so another bind can carry it), 2 = SMPP_WAITACK_NEVER_EXPIRE.
  -- Kamex defaults to 1 (REQUEUE) when the directive is absent -- note this
  -- differs from the upstream Kannel 1.4.5 userguide, which documents 0 as the
  -- default. NULL = do not emit, keep the engine default.
  ADD COLUMN IF NOT EXISTS wait_ack_expire_action smallint,

  -- Bind-rejection recovery. Without `retry`, gw/smsc/smsc_smpp.c sets
  -- smpp->quitting = 1 when the SMSC answers a bind with RINVSYSID, RINVPASWD
  -- or RINVSYSTYP, and the connection thread exits permanently -- a transient
  -- carrier-side authentication fault takes the bind down until an operator
  -- intervenes. With `retry = true` the driver keeps reconnecting on
  -- reconnect_delay_seconds. Default false preserves today's fail-fast
  -- behaviour, which is the right default for a genuinely wrong password.
  ADD COLUMN IF NOT EXISTS retry_on_auth_failure boolean NOT NULL DEFAULT false,

  -- Declarative carrier preference and fallback, evaluated by
  -- gw/smscconn.c smscconn_usable() for every outbound message:
  --   allowed_smsc_ids   -> allowed-smsc-id    hard gate (whitelist)
  --   denied_smsc_ids    -> denied-smsc-id     hard gate (blacklist; the engine
  --                                            ignores it when allowed is set)
  --   preferred_smsc_ids -> preferred-smsc-id  soft ranking: a preferred bind
  --                                            wins over a non-preferred one,
  --                                            but a non-preferred bind is still
  --                                            used when no preferred bind is
  --                                            usable -- i.e. real fallback
  --   allowed/denied/preferred_prefixes -> the matching *-prefix directives,
  --                                        matched against the recipient MSISDN
  -- Empty arrays are the default and emit nothing.
  ADD COLUMN IF NOT EXISTS allowed_smsc_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS denied_smsc_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS preferred_smsc_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS allowed_prefixes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS denied_prefixes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS preferred_prefixes text[] NOT NULL DEFAULT '{}';

-- Constraints are added through a guard because PostgreSQL has no
-- ADD CONSTRAINT IF NOT EXISTS; this keeps the migration re-runnable.
DO $$
DECLARE
  spec record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      -- 64 is a deliberately generous ceiling: no carrier grants more, and it
      -- keeps a typo (connection_count = 1000) from forking a thousand binds.
      ('smsc_connection_count_range',
       $c$CHECK (connection_count BETWEEN 1 AND 64)$c$),
      ('smsc_connection_timeout_range',
       $c$CHECK (connection_timeout_seconds IS NULL
                 OR connection_timeout_seconds BETWEEN 0 AND 86400)$c$),
      ('smsc_wait_ack_expire_action_valid',
       $c$CHECK (wait_ack_expire_action IS NULL OR wait_ack_expire_action IN (0,1,2))$c$),
      -- Kannel/Kamex list values are semicolon separated, so a ';' inside an
      -- element would silently split it into two rules in the rendered file.
      -- Reject it at the database rather than emit a config that means
      -- something other than what the operator stored.
      ('smsc_routing_lists_separator_free',
       $c$CHECK (array_to_string(allowed_smsc_ids || denied_smsc_ids || preferred_smsc_ids
                                 || allowed_prefixes || denied_prefixes || preferred_prefixes,
                                 ',') NOT LIKE '%;%')$c$)
    ) AS s(name, definition)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname::text = spec.name
         AND conrelid = 'smsc_definitions'::regclass
    ) THEN
      EXECUTE format('ALTER TABLE smsc_definitions ADD CONSTRAINT %I %s', spec.name, spec.definition);
    END IF;
  END LOOP;
END $$;

COMMENT ON COLUMN smsc_definitions.connection_count IS
  'Parallel binds to this carrier. Rendered as the Kamex `instances` directive; bearerbox creates this many SMSCConn objects from the one smsc group, all sharing smsc-id, and load-shares across them. SMPP only. 1 = today''s single bind.';
COMMENT ON COLUMN smsc_definitions.connection_timeout_seconds IS
  'Rendered as `connection-timeout`: seconds without any PDU response after which the SMPP driver treats a still-open socket as dead and reconnects. NULL keeps the engine default of 300s (10x enquire-link-interval); 0 disables the check.';
COMMENT ON COLUMN smsc_definitions.wait_ack_expire_action IS
  'Rendered as `wait-ack-expire`: 0 reconnect, 1 requeue for another bind, 2 never expire. NULL keeps the Kamex default (1, requeue).';
COMMENT ON COLUMN smsc_definitions.retry_on_auth_failure IS
  'Rendered as `retry`: keep reconnecting even when the SMSC rejects the bind with an invalid system-id/password/system-type. Without it the connection thread exits permanently on such a rejection.';
COMMENT ON COLUMN smsc_definitions.allowed_smsc_ids IS
  'Rendered as `allowed-smsc-id` (semicolon separated). Hard whitelist: only messages carrying one of these smsc-id values may use this link.';
COMMENT ON COLUMN smsc_definitions.denied_smsc_ids IS
  'Rendered as `denied-smsc-id`. Hard blacklist. The engine ignores it when allowed_smsc_ids is also set.';
COMMENT ON COLUMN smsc_definitions.preferred_smsc_ids IS
  'Rendered as `preferred-smsc-id`. Soft preference, not a filter: this link is chosen ahead of non-preferred links, and non-preferred links still carry the traffic when no preferred link is usable. This is how "prefer carrier A, fall back to carrier B" is expressed declaratively.';
COMMENT ON COLUMN smsc_definitions.allowed_prefixes IS
  'Rendered as `allowed-prefix`: recipient MSISDN prefixes this link accepts.';
COMMENT ON COLUMN smsc_definitions.denied_prefixes IS
  'Rendered as `denied-prefix`: recipient MSISDN prefixes this link refuses.';
COMMENT ON COLUMN smsc_definitions.preferred_prefixes IS
  'Rendered as `preferred-prefix`: recipient MSISDN prefixes this link is preferred for.';

GRANT SELECT, INSERT, UPDATE, DELETE ON smsc_definitions TO jkannel_app;

COMMIT;
