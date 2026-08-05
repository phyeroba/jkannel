-- 042_scheduled_messages
-- Real "send later": a JKANNEL-side hold for messages the operator explicitly
-- deferred, released into the existing send path at the scheduled instant.
--
-- WHY THIS TABLE EXISTS
-- --------------------------------------------------------------------------
-- Until now `scheduledAt` was written straight onto the engine row as
-- `send_sms.deferred`, which becomes SMPP `schedule_delivery_time` -- a REQUEST
-- to the carrier that most carriers refuse, and that the `smsc = fake` bind
-- this deployment runs ignores entirely (gw/smsc/smsc_fake.c contains no
-- reference to it). A scheduled message was therefore recorded faithfully and
-- then delivered immediately. This table makes the hold real.
--
-- THIS IS NOT THE OUTBOUND QUEUE ADR-0008 REJECTED
-- --------------------------------------------------------------------------
-- ADR-0008 rejected a JKANNEL-owned queue that would intercept EVERY message
-- and duplicate the engine's retry, throttling, windowing and store-and-forward
-- -- putting the control plane on the critical path of all traffic. This table
-- holds ONLY messages an operator explicitly deferred, BEFORE they enter the
-- data plane, and releases them into the unchanged send path. "When should this
-- be submitted?" is a control-plane question; "how is it delivered once
-- submitted?" remains the engine's. See the amendment in
-- docs/adr/ADR-0008-control-plane-boundary.md.
--
-- MECHANISM
-- --------------------------------------------------------------------------
-- A scheduled send is a row here PLUS an `api_jobs` row of type
-- `message.scheduled.release` whose `next_attempt_at` IS the scheduled instant.
-- The Wave-F job queue then does all the hard parts already: due-time claiming
-- with `FOR UPDATE SKIP LOCKED` (so two replicas can never both release the
-- same message), exponential backoff, bounded attempts, dead-lettering, and
-- stale-claim reaping via heartbeat. No second scheduler is introduced.
--
-- STATUS VOCABULARY -- each value means exactly one thing
--   pending    held, not yet due (or due and not yet claimed). Cancellable and
--              reschedulable.
--   releasing  a worker has claimed it and is running the send. This state
--              unambiguously means NOT YET SENT: the transition to `released`
--              is written inside the SAME transaction as the entitlement
--              consumption, the routing decision and the engine submission, so
--              a rolled-back send leaves the row `releasing` and a retry may
--              safely re-attempt it. (The one residual seam is SQLBox being a
--              separate database -- see MessageSendService's class comment.)
--   released   the send transaction committed. `message_ref` holds the
--              `send_sms.sql_id`. Terminal.
--   cancelled  cancelled by an operator before release. Terminal.
--   failed     refused AT RELEASE (quota, credit, sender ID, blocklist,
--              routing) or interrupted past recovery. `failure_reason` says
--              which. Terminal.
--   expired    still un-released after the staleness ceiling elapsed, so it was
--              deliberately NOT delivered. An SMS three days late can be worse
--              than none. Terminal.
--
-- Additive and re-runnable throughout: CREATE TABLE IF NOT EXISTS, ADD COLUMN
-- IF NOT EXISTS for every column, guarded DO-blocks for constraints, policies
-- and grants -- matching migrations 034/040/041.
BEGIN;

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id)
);

ALTER TABLE scheduled_messages
  -- 'message' = one held single send whose payload lives in `payload`.
  -- 'bulk'    = a held campaign; `bulk_job_id` points at the bulk_send_jobs row
  --             and release simply moves that job to 'queued' so the existing
  --             runner dispatches every recipient through the normal path.
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'message',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending',
  -- Always UTC (timestamptz). The API accepts ISO 8601 with an offset and
  -- normalises; comparison is always against now() in the database.
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz NOT NULL DEFAULT now(),
  -- Carried through to `send_sms.validity` on the eventual submit. Unlike
  -- `deferred`, validity IS honoured by real SMPP carriers, so it stays an
  -- engine concern and is deliberately NOT reimplemented here.
  ADD COLUMN IF NOT EXISTS validity_minutes integer,
  -- The single-send request, exactly as the send path will replay it: sender,
  -- receiver, text, smscId, customerId, dlrMask, dlrUrl, foreignId, operator,
  -- channel. NOTE this stores message content at rest in the control plane for
  -- the duration of the hold; it is deleted with the row.
  ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS bulk_job_id uuid REFERENCES bulk_send_jobs(id) ON DELETE CASCADE,
  -- The api_jobs row whose next_attempt_at is the scheduled instant. Not a
  -- foreign key: api_jobs rows are pruned on their own retention schedule and a
  -- released message must survive that.
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS release_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS claimed_by text,
  ADD COLUMN IF NOT EXISTS released_at timestamptz,
  -- TRUE when the platform was down (or the queue backed up) across the
  -- scheduled instant and the message was released late but inside the ceiling.
  -- Recorded so "it arrived at 11:04 for a 09:00 schedule" is explainable.
  ADD COLUMN IF NOT EXISTS released_late boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS lateness_ms bigint,
  -- send_sms.sql_id once the send transaction committed.
  ADD COLUMN IF NOT EXISTS message_ref text,
  ADD COLUMN IF NOT EXISTS decision_id uuid,
  ADD COLUMN IF NOT EXISTS failure_reason text,
  ADD COLUMN IF NOT EXISTS created_by text NOT NULL DEFAULT 'system',
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Constraints through a guard: PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS.
DO $$
DECLARE
  spec record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('scheduled_messages_kind_check',
       $c$CHECK (kind IN ('message','bulk'))$c$),
      ('scheduled_messages_status_check',
       $c$CHECK (status IN ('pending','releasing','released','cancelled','failed','expired'))$c$),
      -- A bulk hold must name its campaign; a single hold must not.
      ('scheduled_messages_kind_target_check',
       $c$CHECK ((kind = 'bulk') = (bulk_job_id IS NOT NULL))$c$),
      ('scheduled_messages_release_attempts_check',
       $c$CHECK (release_attempts >= 0)$c$),
      -- Same ceiling parseMessageSchedule enforces (1..365 days).
      ('scheduled_messages_validity_minutes_check',
       $c$CHECK (validity_minutes IS NULL OR validity_minutes BETWEEN 1 AND 525600)$c$),
      -- A row claiming to be released must say what it released, so a
      -- "released" status can never be a fabrication.
      ('scheduled_messages_released_evidence_check',
       $c$CHECK (status <> 'released'
                 OR (released_at IS NOT NULL
                     AND (kind = 'bulk' OR message_ref IS NOT NULL)))$c$)
    ) AS s(name, definition)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname::text = spec.name
         AND conrelid = 'scheduled_messages'::regclass
    ) THEN
      EXECUTE format('ALTER TABLE scheduled_messages ADD CONSTRAINT %I %s',
                     spec.name, spec.definition);
    END IF;
  END LOOP;
END $$;

-- One release job per held message. Makes re-submitting the same hold a no-op
-- at the database rather than a second job that would double-release.
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_messages_job_idx
  ON scheduled_messages (job_id)
  WHERE job_id IS NOT NULL;

-- The operator's list: "what is still held, soonest first".
CREATE INDEX IF NOT EXISTS scheduled_messages_pending_idx
  ON scheduled_messages (tenant_id, scheduled_at)
  WHERE status IN ('pending','releasing');

-- The grid's default sort + keyset cursor (created_at DESC, id).
CREATE INDEX IF NOT EXISTS scheduled_messages_tenant_created_idx
  ON scheduled_messages (tenant_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS scheduled_messages_bulk_job_idx
  ON scheduled_messages (bulk_job_id)
  WHERE bulk_job_id IS NOT NULL;

COMMENT ON TABLE scheduled_messages IS
  'JKANNEL-side hold for explicitly deferred sends. Released into the normal send path (blocklist -> routing -> entitlements -> decision -> submit) at the scheduled instant by the api_jobs worker; entitlements are evaluated AT RELEASE, never at schedule time. Not the outbound queue ADR-0008 rejected: it holds only deferred traffic, before the data plane.';
COMMENT ON COLUMN scheduled_messages.status IS
  'pending = held; releasing = claimed by a worker and provably NOT yet sent; released = the send transaction committed; cancelled = operator cancelled before release; failed = refused at release or unrecoverable; expired = the staleness ceiling elapsed and the message was deliberately not delivered.';
COMMENT ON COLUMN scheduled_messages.released_late IS
  'The release happened after the scheduled instant (platform downtime or queue backlog) but inside the configured staleness ceiling. lateness_ms records by how much.';
COMMENT ON COLUMN scheduled_messages.payload IS
  'The single-send request replayed verbatim through MessageSendService at release. Message content at rest for the duration of the hold only.';

-- Existing campaigns parked in 'scheduled' were dispatched IMMEDIATELY under the
-- old behaviour (the wait lived on the engine row, which ignored it). They have
-- no scheduled_messages row and no release job, and 'scheduled' is no longer a
-- dispatchable status, so leaving them would strand them forever. Move them to
-- 'queued': the runner then treats them exactly as the old code did.
--
-- The loop is not decoration. `bulk_send_jobs` has FORCE ROW LEVEL SECURITY
-- (migration 023), so if the migration role does not bypass RLS a bare UPDATE
-- would match ZERO rows with `app.tenant_id` unset -- and strand exactly the
-- campaigns this statement exists to rescue, silently. Setting the tenant
-- context per tenant is correct whether or not the role bypasses RLS (a
-- bypassing role simply completes the work on the first iteration). `tenants`
-- itself carries no RLS, so it is always readable here.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    UPDATE bulk_send_jobs SET status = 'queued' WHERE status = 'scheduled';
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

ALTER TABLE scheduled_messages ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'scheduled_messages' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON scheduled_messages
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::bigint)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::bigint);
  END IF;
END $$;
ALTER TABLE scheduled_messages FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jkannel_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON scheduled_messages TO jkannel_app;
  END IF;
END $$;

COMMIT;
