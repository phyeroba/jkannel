#!/usr/bin/env node
/**
 * WHICH TABLES ARE MISSING THE CONVENTIONS THE SPEC CALLS MANDATORY.
 *
 * THE TWO CONVENTIONS
 * ---------------------------------------------------------------------------
 *   deleted_at   soft delete. A row an operator removes stays readable, so an
 *                audit entry, a message or a report that references it still
 *                resolves instead of dangling.
 *   version      optimistic locking. Two operators editing the same record do
 *                not silently overwrite each other; the second save is refused
 *                and told why.
 *
 * The helpers exist — `data-model/soft-delete.ts` and
 * `data-model/optimistic-lock.ts` — and the conventions are documented. What is
 * missing is coverage: 6 of 99 tables carry `deleted_at` and 9 carry `version`.
 *
 * WHY "ALL 99" IS THE WRONG TARGET
 * ---------------------------------------------------------------------------
 * A gap report that says "93 tables missing" would be loud and wrong, and the
 * effort spent closing it would make the schema worse. Soft-deleting a metric
 * sample is meaningless: nobody deletes one, and it is an immutable observation
 * rather than a record somebody owns. Optimistic locking an append-only event
 * log is meaningless for the same reason — there is no second writer to lose to.
 *
 * So the target is the tables an OPERATOR EDITS: configuration and reference
 * records with a lifecycle, where a delete can orphan a reference and two
 * people can hold the same row open. Everything else is classified with the
 * reason it is excluded, and the exclusions are as reviewable as the target —
 * a table classified wrongly is a real gap hidden behind a rule.
 *
 *   node scripts/schema-conventions.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:/JKANNEL';
const DB = process.env.DB_CONTAINER ?? 'jkannel-postgres-1';

/**
 * Tables excluded from the conventions, by pattern, each with the reason.
 *
 * Ordered: the first matching rule wins, so a specific exemption can precede a
 * general one.
 */
const EXCLUSIONS = [
  [/^schema_migrations$/, 'the migration ledger — owned by the runner, never by an operator'],
  [/_archive$/, 'cold storage of rows already retired from a live table'],
  [/^audit_log/, 'append-only tamper-evident chain; deleting an entry is the thing it exists to prevent'],
  [/_snapshots?$/, 'a point-in-time observation, not a record anybody owns'],
  [/_transitions$/, 'append-only history of state changes'],
  [/_history$/, 'append-only history'],
  [/_log$/, 'append-only log'],
  [/^metric_samples$/, 'time series; rows are facts, not records'],
  [/^operational_events$/, 'append-only event stream'],
  [/^login_history$/, 'append-only security record'],
  [/^(sent_sms|send_sms|mo_messages|mo_deliveries)$/, 'engine-owned message rows; JKANNEL is not their custodian'],
  [/^message_route_decisions$/, 'append-only per-message audit'],
  [/_runs?$/, 'an execution record — immutable once written'],
  [/_attempts$/, 'append-only attempt log'],
  [/^test_sends$/, 'diagnostic records, immutable once sent'],
  [/^alert_(instances|acknowledgements|comments|escalations)$/, 'incident facts; resolved rather than deleted'],
  [/^(auth_sessions|password_reset_tokens|mfa_recovery_codes)$/, 'credentials with a real expiry — genuinely deleted, never soft'],
  [/^(mt_dedupe_keys|api_idempotency_records)$/, 'short-lived deduplication keys, swept by retention'],
  [/_state$/, 'current-value state rows the system owns and rewrites'],
  [/_cursors$/, 'ingest position, owned by the poller'],
  [/^password_history$/, 'append-only, and required to stay for reuse checks'],
  [/^(role_permissions|user_roles)$/, 'join tables; the row IS the relationship, and removing it is the operation'],
  [/^permissions$/, 'the seeded permission catalogue — code owns it, not an operator'],
  [/^(engine_capability_entries|engine_instances|adapter_instances)$/, 'discovered from the engine, rewritten on each poll'],
  [/^(bulk_send_recipients|scheduled_messages|delivery_retry_state|message_delivery_retries)$/, 'work items with a terminal state; completion is not deletion'],
  [/^(restore_operations|route_deployments|smsc_deployments|config_drift_checks|engine_lifecycle_(actions|results))$/, 'operation records — immutable once run'],
  [/^(customer_balances|credit_transactions)$/, 'ledger; a correction is another row, never an edit'],
  [/^user_notifications$/, 'per-user notices, dismissed rather than edited'],
  [/^pii_reveal_grants$/, 'a time-boxed grant — expiry is the lifecycle, and the record must survive it for audit'],
  [/^(notification_deliveries|smsc_health|engine_poll|report_snapshots)/, 'observations and delivery attempts, not owned records'],
  [/^user_invitations$/, 'single-use, with a terminal accepted/expired state'],
  [/^route_(versions|failovers|targets)$/, 'versions are immutable by definition; targets belong to their route'],
  [/^configuration_versions$/, 'immutable by design — a change is a new version, never an edit'],
  [/^ai_assistance_requests$/, 'a request log; each row is what was asked, once'],
  [/^api_jobs$/, 'queue work with a terminal state; finishing is not deleting'],
  [/^bulk_send_jobs$/, 'a campaign run — it completes, it is not edited afterwards'],
  [/^mfa_devices$/, 'a credential; removing one must really remove it'],
  [/^backup_records$/, 'an artifact record whose artifact is deleted with it — a soft-deleted backup would claim to exist'],
  [/^data_model_records$/, 'the reference implementation of the conventions; already carries both'],
];

const sql = (query) =>
  execFileSync('docker', ['exec', DB, 'psql', '-U', 'jkannel', '-d', 'jkannel', '-t', '-A', '-F', '|', '-c', query], {
    maxBuffer: 32 * 1024 * 1024,
  })
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('|'));

const rows = sql(`
  select c.relname,
         bool_or(a.attname = 'deleted_at')::text,
         bool_or(a.attname = 'version')::text
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
   where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0
   group by c.relname
   order by c.relname`);

const target = [];
const excluded = [];
for (const [name, del, ver] of rows) {
  const rule = EXCLUSIONS.find(([pattern]) => pattern.test(name));
  // `bool_or(...)::text` yields 'true'/'false'. psql's own display of a boolean
  // is 't'/'f', and comparing against those made every table read as missing
  // both conventions — including the six that have them.
  const entry = { table: name, deletedAt: del === 'true', version: ver === 'true' };
  if (rule) excluded.push({ ...entry, reason: rule[1] });
  else target.push(entry);
}

const missingDelete = target.filter((t) => !t.deletedAt);
const missingVersion = target.filter((t) => !t.version);

console.log('='.repeat(96));
console.log('SCHEMA CONVENTIONS — soft delete and optimistic locking, where they belong');
console.log('='.repeat(96));
console.log(
  `${rows.length} tables · ${target.length} operator-editable · ${excluded.length} excluded with a stated reason\n`,
);

const width = Math.max(...target.map((t) => t.table.length)) + 2;
console.log(`${'table'.padEnd(width)}deleted_at   version`);
console.log('-'.repeat(96));
for (const t of target)
  console.log(`${t.table.padEnd(width)}${(t.deletedAt ? 'yes' : 'NO').padEnd(13)}${t.version ? 'yes' : 'NO'}`);

console.log(`\n${'='.repeat(96)}`);
console.log(
  missingDelete.length || missingVersion.length
    ? `${missingDelete.length} table(s) need deleted_at · ${missingVersion.length} need version.`
    : 'Every operator-editable table carries both conventions.',
);
console.log(
  `\nExclusions are in the script with a reason each — review them, because a table` +
    `\nclassified wrongly is a real gap hidden behind a rule.`,
);

fs.writeFileSync(
  path.join(ROOT, 'docs/schema-conventions.json'),
  JSON.stringify({ target, excluded, missingDelete, missingVersion }, null, 2),
);
process.exitCode = missingDelete.length || missingVersion.length ? 1 : 0;
