// For every column the UI kit specifies and we do not yet render, says whether
// the data exists — by searching the migrations and the SQLBox projection for a
// column that could back it.
//
// This exists because I twice estimated work from memory and was wrong in both
// directions: I said per-bind throughput needed a new collector when
// `smsc_bind_snapshots` had been recording it for months. The answer to "can we
// measure this" belongs in the schema, not in anyone's recollection.
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = 'd:/JKANNEL/database/migrations';
const SQLBOX = 'd:/JKANNEL/backend/src/engine/kamex-sqlbox.repository.ts';
const ADAPTER = 'd:/JKANNEL/backend/src/engine/kamex.adapter.ts';

const schema = fs
  .readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.up.sql'))
  .map((f) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'))
  .join('\n');
const sqlbox = fs.readFileSync(SQLBOX, 'utf8');
const adapter = fs.readFileSync(ADAPTER, 'utf8');
const haystack = `${schema}\n${sqlbox}\n${adapter}`.toLowerCase();

/**
 * Each entry is a column the kit specifies that we do not render, with the
 * identifiers that would have to exist for it to be real. `verdict` is my
 * reading; `evidence` is what the script actually finds, so a wrong reading is
 * visible rather than authoritative.
 */
const CANDIDATES = [
  // --- DLR Performance -----------------------------------------------------
  ['DlrScreen', 'P50 / P95 / P99 DLR latency', ['dlr_time', 'foreign_id'], 'BUILDABLE'],
  ['DlrScreen', 'No-DLR %', ['delivery_status', 'pending'], 'BUILDABLE'],
  ['DlrScreen', 'Read as', ['dlr_mask'], 'BUILDABLE'],
  ['DlrScreen', 'Throttle %', ['command_status', 'throttl'], 'NOT MEASURED'],
  // --- SMPP Sessions -------------------------------------------------------
  ['SessionsScreen', 'Reconnects', ['smsc_bind_transitions'], 'BUILDABLE'],
  ['SessionsScreen', 'Enquire RTT', ['enquire'], 'NOT MEASURED'],
  ['SessionsScreen', 'Timeouts', ['timeout_count', 'timeouts'], 'NOT MEASURED'],
  ['SessionsScreen', 'P95 latency', ['submit_latency', 'latency_p95'], 'NOT MEASURED'],
  ['SessionsScreen', 'Top error', ['command_status'], 'NOT MEASURED'],
  // --- Queues --------------------------------------------------------------
  ['QueuesScreen', 'Depth', ['smsc_bind_snapshots', 'queued'], 'BUILDABLE'],
  ['QueuesScreen', 'Ingress / Egress', ['inbound_rate', 'outbound_rate'], 'BUILDABLE'],
  ['QueuesScreen', 'Growth', ['smsc_bind_snapshots', 'observed_at'], 'BUILDABLE'],
  ['QueuesScreen', 'Retries', ['retry_count', 'num_retries'], 'NOT MEASURED'],
  ['QueuesScreen', 'Expired', ['validity', 'expired'], 'PARTIAL'],
  // --- Message Trace -------------------------------------------------------
  ['TraceScreen', 'Destination / Sender / SMSC', ['receiver', 'sender', 'smsc_id'], 'BUILDABLE'],
  ['TraceScreen', 'Final', ['delivery_status'], 'BUILDABLE'],
  // --- Failover / Routes ---------------------------------------------------
  ['FailoverScreen', 'Active target', ['failover', 'route'], 'BUILDABLE'],
  ['FailoverScreen', 'Used / capacity, Headroom', ['tps', 'outbound_rate'], 'BUILDABLE'],
  ['FailoverScreen', 'Last transition', ['smsc_bind_transitions'], 'BUILDABLE'],
  // --- Services / Nodes ----------------------------------------------------
  ['ServicesScreen', 'Uptime', ['uptime_seconds'], 'BUILDABLE'],
  ['ServicesScreen', 'CPU / Memory', ['cpu_percent', 'memory_bytes'], 'NOT MEASURED'],
  // --- Audit / Events / Logs ----------------------------------------------
  ['AuditScreen', 'Previous state', ['old_value'], 'BUILDABLE'],
  ['EventsScreen', 'Evidence', ['detail', 'evidence'], 'BUILDABLE'],
  ['LogsScreen', 'Component / Object', ['component', 'source'], 'BUILDABLE'],
];

const found = (needle) => haystack.includes(needle.toLowerCase());

let buildable = 0;
let notMeasured = 0;
console.log('COLUMN                                    VERDICT        EVIDENCE IN SCHEMA');
console.log('-'.repeat(96));
for (const [screen, column, needles, verdict] of CANDIDATES) {
  const hits = needles.filter(found);
  const label = `${screen.replace('Screen', '')} · ${column}`;
  const evidence = hits.length ? hits.join(', ') : 'none of: ' + needles.join(', ');
  // A verdict that disagrees with the evidence is the interesting case, so mark it.
  const disagrees =
    (verdict === 'BUILDABLE' && !hits.length) ||
    (verdict === 'NOT MEASURED' && hits.length === needles.length);
  console.log(
    `${label.padEnd(42)}${verdict.padEnd(15)}${evidence}${disagrees ? '   <-- CHECK ME' : ''}`,
  );
  if (verdict === 'BUILDABLE') buildable += 1;
  if (verdict === 'NOT MEASURED') notMeasured += 1;
}
console.log(
  `\n${buildable} buildable from data we already store | ${notMeasured} not measured anywhere`,
);
