-- Durable log storage for warn and above.
--
-- WHY A TABLE AND NOT LOKI
-- ---------------------------------------------------------------------------
-- `GET /observability/logs` has always read a 1000-line in-memory ring buffer
-- that is lost on restart, holds one replica's view, and evicts silently. It
-- was honest about that, but "the line you need is the one that was evicted" is
-- still the commonest way an incident goes cold.
--
-- Loki is the better general answer and the compose profile for it exists. It
-- was not chosen here because it adds two containers to run, back up and keep
-- healthy on a host that is already shared with another platform, to solve a
-- problem that a table on a database we already operate solves for warn-and-
-- above. Info and debug stay in the ring buffer, where their volume belongs.
--
-- WHAT IS DELIBERATELY NOT HERE
-- ---------------------------------------------------------------------------
-- No tenant_id foreign key and no row-level security. A log line is written by
-- the platform ABOUT a request, including requests that failed authentication
-- and therefore have no tenant. Making it a tenant-scoped entity would drop
-- exactly the lines an incident needs — the unauthenticated ones. Reads are
-- gated by the `system.view` permission at the controller instead, which is how
-- the ring buffer has always been gated.
BEGIN;

CREATE TABLE IF NOT EXISTS log_entries (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at     TIMESTAMPTZ  NOT NULL,
  level           TEXT         NOT NULL,
  message         TEXT         NOT NULL,
  context         TEXT,
  correlation_id  TEXT,
  request_id      TEXT,
  tenant_id       TEXT,
  user_id         TEXT,
  username        TEXT,
  method          TEXT,
  route           TEXT,
  status          INTEGER,
  duration_ms     INTEGER,
  client_ip       TEXT,
  trace           TEXT,
  -- Everything the line carried that is not a column above. Keeps `warnWith`
  -- fields (keyId, reason, customerId, …) queryable without a migration per
  -- field.
  fields          JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Newest-first by time is the only ordering the explorer defaults to, so the
-- index is DESC to match and the planner can walk it directly.
CREATE INDEX IF NOT EXISTS log_entries_occurred_idx ON log_entries (occurred_at DESC);
-- "Trace this incident" is the question this store exists to answer.
CREATE INDEX IF NOT EXISTS log_entries_correlation_idx
  ON log_entries (correlation_id, occurred_at DESC)
  WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS log_entries_level_idx ON log_entries (level, occurred_at DESC);
CREATE INDEX IF NOT EXISTS log_entries_tenant_idx
  ON log_entries (tenant_id, occurred_at DESC)
  WHERE tenant_id IS NOT NULL;

COMMIT;
