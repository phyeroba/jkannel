<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError, apiDownloadFile, apiRequest, saveDownloadedFile } from '../api';
import { useLiveResource } from '../composables/useLiveResource';
import { canAccess, session } from '../stores/session';
import ConfirmAction from '../components/ConfirmAction.vue';
import MessagePriority from '../components/MessagePriority.vue';
import QueueRatesPanel from '../components/QueueRatesPanel.vue';
import SegmentCounter from '../components/SegmentCounter.vue';
import SendSchedule from '../components/SendSchedule.vue';
import PrivacyReveal from '../components/PrivacyReveal.vue';
import ScopePicker from '../components/ScopePicker.vue';

/**
 * Which operational object owns each engine directive.
 *
 * The generated Kannel config is read-only on purpose — it is rendered from the
 * SMSC and service records — so "edit the object, not the file" is the rule.
 * That rule is only actionable if an operator can see WHICH object, which is
 * what this table is for.
 *
 * Transcribed from `backend/src/configuration/configuration-model.builder.ts`,
 * which is the thing that actually decides. Credentials are listed deliberately
 * so their row can say "never edited here": they resolve from the engine
 * container's environment and are never rendered into a file or sent to a
 * browser.
 */
const DIRECTIVE_OWNERS: Array<{
  directive: string;
  owner: string;
  where: string;
  to?: string;
}> = [
  {
    directive: 'smsc-id, host, port, transceiver-mode',
    owner: 'The SMSC record',
    where: 'Connectivity → SMSC Connections',
    to: '/smsc',
  },
  {
    directive: 'throughput, max-pending-submits',
    owner: 'The capacity ceiling on the SMSC',
    where: 'Connectivity → SMSC Connections',
    to: '/smsc',
  },
  {
    directive: 'smsc-username, smsc-password',
    owner: 'A secret reference resolved inside the engine container',
    where: 'never edited here — the value never reaches a browser',
  },
  {
    directive: 'group = smsbox, sendsms-port',
    owner: 'Service topology',
    where: 'System → Services',
    to: '/services',
  },
  {
    directive: 'dlr-storage',
    owner: 'DLR datastore selection',
    where: 'System → Services',
    to: '/services',
  },
];
import DetailDrawer from '../components/DetailDrawer.vue';
import ModalDialog from '../components/ModalDialog.vue';
import SmscConfigForm, { type SmscDraft } from '../components/SmscConfigForm.vue';
import { privacyOf, type PrivacyState } from '../utils/privacy';
import { describeComposerText } from '../utils/message-segments';
import { controlEndpoint, operationVerb, type ControlOperation } from '../utils/safe-control';
import {
  PRIORITY_UNSET,
  priorityCellLabel,
  priorityFields,
  type PriorityChoice,
} from '../utils/message-priority';
import {
  SCHEDULING_SUPPORTED,
  emptySchedule,
  scheduleError as sendScheduleValidationError,
  scheduledSendFields,
  type ScheduleDraft,
} from '../utils/send-scheduling';
import './workspace-extras.css';

type RecordValue = Record<string, unknown>;

interface Row {
  id: string;
  name: string;
  detail: string;
  status: string;
  updated: string;
  raw: RecordValue;
}

interface GridFilterField {
  field: string;
  label: string;
  options?: string[];
  /**
   * Names a ref of `{ value, label }` choices loaded at runtime. Needed where
   * the API filters on an opaque id but the grid displays a human name: a plain
   * text box then silently returns nothing for the very value on screen.
   */
  choices?: 'routeSmsc';
}

interface GridConfig {
  sortFields: string[];
  defaultSort?: string;
  filters: GridFilterField[];
  exportBase?: string;
  maxExportLimit?: number;
}

interface ColumnDefinition {
  header: string;
  value: (raw: RecordValue) => string;
  mono?: boolean;
  /** Render the value as a status badge; the string is also used as the tone class. */
  badge?: (raw: RecordValue) => string;
  /** Leading state dot, e.g. the SMSC reachability indicator. */
  dot?: (raw: RecordValue) => string;
  /** Small muted line under the value (health samples, secondary identifiers). */
  hint?: (raw: RecordValue) => string;
}

interface Workspace {
  noun: string;
  search: string;
  endpoint: string;
  action: string;
  actionEndpoint?: string;
  actionMethod?: 'POST' | 'PATCH';
  creatable?: boolean;
  createKind?: 'smsc' | 'route' | 'configuration' | 'invitation';
  grid?: GridConfig;
  columns?: ColumnDefinition[];
}

const BOOLEAN_OPTIONS = ['true', 'false'];

function text(value: unknown, fallback = '—') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

/**
 * An audit row's before/after value, as one readable cell.
 *
 * `old_value` is JSONB and is null for two entirely different reasons: the
 * action created something and there WAS no previous state, or it changed
 * something and nobody captured the before. The first is normal and the second
 * is a gap in the trail, so they must not both print an em dash — "none (this
 * created the record)" says which one happened.
 *
 * The value is summarised rather than dumped: a whole SMSC definition in a grid
 * cell pushes every other column off the screen, and the detail drawer already
 * carries the full object for anyone who needs it.
 */
function summariseState(value: unknown): string {
  if (value === null || value === undefined) return 'none — nothing preceded this';
  if (typeof value !== 'object') return String(value);
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return 'recorded as empty';
  const rendered = entries
    .slice(0, 3)
    .map(([key, item]) => `${key}=${item === null ? 'null' : String(item)}`)
    .join(', ');
  return entries.length > 3 ? `${rendered}, +${entries.length - 3} more` : rendered;
}

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function list(value: unknown, fallback = '—') {
  if (Array.isArray(value))
    return value.length ? value.map((entry) => String(entry)).join(', ') : fallback;
  return text(value, fallback);
}

function formatBytes(value: unknown, fallback = '—') {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return fallback;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

/** Status string → the badge tone classes the stylesheet already defines. */
function badgeTone(value: unknown) {
  const status = String(value ?? '').toLowerCase();
  if (
    [
      'delivered',
      'active',
      'enabled',
      'resolved',
      'complete',
      'completed',
      'ok',
      'verified',
    ].includes(status)
  )
    return 'good';
  if (['pending', 'buffered', 'accepted', 'acknowledged', 'warning', 'degraded'].includes(status))
    return 'warn';
  if (['failed', 'rejected', 'critical', 'open', 'disabled', 'archived', 'error'].includes(status))
    return 'bad';
  return '';
}

/**
 * `notification_state` is the difference between "an alert fired" and "somebody
 * was told about it". `undeliverable` and `pending` both mean nobody has heard.
 */
function notificationTone(value: unknown) {
  const state = String(value ?? '').toLowerCase();
  if (state === 'delivered' || state === 'sent') return 'good';
  if (state === 'undeliverable' || state === 'failed') return 'bad';
  if (state === 'pending') return 'warn';
  return '';
}

/** Kannel DLR event mask → the outcome it reports (see DLR_EVENT_STATUS). */
const DLR_EVENTS: Record<string, string> = {
  '1': 'delivered',
  '2': 'failed',
  '4': 'buffered',
  '8': 'accepted by SMSC',
  '16': 'rejected by SMSC',
};
function dlrEventLabel(raw: RecordValue) {
  const event = raw.dlrEvent ?? raw.dlr_event;
  if (event === null || event === undefined || event === '') return 'no report yet';
  return DLR_EVENTS[String(event)] ?? `mask ${event}`;
}

/** "host:port", collapsing to a single dash when neither is configured. */
function hostPort(raw: RecordValue) {
  const host = text(raw.host, '');
  const port = text(raw.port, '');
  if (!host && !port) return '—';
  return port ? `${host || '—'}:${port}` : host;
}

/**
 * A throughput reading, or `unknown` when there is no reading.
 *
 * The distinction is the whole point. A bind the poller has never sampled has
 * no rate at all; printing `0.0` for it reports a measured silence and is
 * indistinguishable from a carrier that is bound and simply idle. The design
 * system shows `unknown` in exactly this case, so this follows it.
 */
function rateText(value: unknown) {
  if (value === null || value === undefined || value === '') return 'unknown';
  const rate = Number(value);
  if (!Number.isFinite(rate)) return 'unknown';
  // One decimal: the engine reports a moving average, and more digits imply a
  // precision a 30-second poll does not have.
  return rate.toFixed(1);
}

/**
 * Observed throughput against the agreed ceiling, e.g. "53% of 100".
 *
 * Falls back to the bare ceiling when there is no observation, because the
 * ceiling is a configured fact and is worth showing even when the numerator is
 * unknown — an operator checking whether a carrier's TPS is provisioned
 * correctly needs it whether or not traffic is flowing.
 */
function utilisationText(raw: RecordValue) {
  const capacity = Number(raw.tps);
  if (!Number.isFinite(capacity) || capacity <= 0) return 'not set';
  const observed = Number(raw.outbound_rate ?? raw.outboundRate);
  if (!Number.isFinite(observed)) return `— of ${capacity}`;
  return `${Math.round((observed / capacity) * 100)}% of ${capacity}`;
}

/** Trims long message bodies so one row stays one row. */
function truncate(value: unknown, limit = 80) {
  const body = text(value, '');
  if (!body) return '—';
  return body.length > limit ? `${body.slice(0, limit)}…` : body;
}

/**
 * Kannel DCS coding, as the SQLBox read model publishes it: 0 = GSM-7,
 * 1 = 8-bit binary, 2 = UCS-2. The number alone means nothing to an operator
 * working out why a 70-character message billed as three segments.
 */
const CODING_LABELS: Record<string, string> = {
  '0': 'GSM-7',
  '1': '8-bit',
  '2': 'UCS-2',
};
function codingLabel(raw: RecordValue): string {
  const coding = raw.coding;
  const charset = text(raw.charset, '');
  if (coding === null || coding === undefined || coding === '')
    return charset && charset !== '—' ? charset : '—';
  const label = CODING_LABELS[String(coding)] ?? `coding ${coding}`;
  return charset && charset !== '—' ? `${label} · ${charset}` : label;
}
/**
 * Segment count. `segments` is derived by the read model from the body, the
 * coding and any UDH; a row that predates it shows a dash rather than "1",
 * because a wrong billing count is worse than an absent one.
 */
function segmentCount(raw: RecordValue): string {
  const value = raw.segments;
  if (value === null || value === undefined || value === '') return '—';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : '—';
}

const definitions: Record<string, Workspace> = {
  messages: {
    noun: 'message',
    search: 'Message ID, sender, recipient, or status',
    endpoint: '/messages',
    action: 'Refresh',
    columns: [
      { header: 'When', value: (raw) => text(raw.timestamp ?? raw.time) },
      { header: 'Dir', value: (raw) => text(raw.direction ?? raw.momt) },
      {
        header: 'Delivery',
        value: (raw) => text(raw.deliveryStatus ?? raw.delivery_status ?? raw.status),
        badge: (raw) => badgeTone(raw.deliveryStatus ?? raw.delivery_status ?? raw.status),
        hint: (raw) => text(raw.status, ''),
      },
      { header: 'Sender', value: (raw) => text(raw.sender), mono: true },
      { header: 'Receiver', value: (raw) => text(raw.receiver), mono: true },
      { header: 'Message', value: (raw) => truncate(raw.text ?? raw.msgdata) },
      {
        header: 'Segments',
        value: (raw) => segmentCount(raw),
        hint: (raw) => (raw.udhData ? 'concatenated (UDH present)' : ''),
      },
      { header: 'Encoding', value: (raw) => codingLabel(raw) },
      /*
        Display only, deliberately. The engine row carries `priority`, but
        SQLBOX_SORT_COLUMNS has no entry for it (a `?sort=priority` here is a
        400) and parseMessageFilters drops an unknown query key, so there is no
        sort or filter control the API would honour. `unset` is printed rather
        than `—` because an absent priority is a real state, not missing data.
      */
      { header: 'Priority', value: (raw) => priorityCellLabel(raw.priority), mono: true },
      { header: 'SMSC', value: (raw) => text(raw.smscId ?? raw.smsc_id), mono: true },
      {
        header: 'DLR',
        value: (raw) => dlrEventLabel(raw),
        hint: (raw) => text(raw.dlrAt ?? raw.dlr_at, ''),
      },
      { header: 'Service', value: (raw) => text(raw.service) },
      { header: 'Account', value: (raw) => text(raw.account) },
      {
        header: 'Reference',
        value: (raw) => text(raw.externalRef ?? raw.foreign_id),
        mono: true,
        hint: (raw) => text(raw.id, ''),
      },
    ],
  },
  queues: {
    noun: 'queue',
    search: 'Queue, state, or message count',
    endpoint: '/queues',
    action: 'Refresh',
  },
  'delivery-reports': {
    noun: 'delivery report',
    search: 'Message ID, recipient, or delivery status',
    endpoint: '/reports/delivery',
    action: 'Refresh',
  },
  smsc: {
    noun: 'SMSC',
    search: 'Name, protocol, host, or connection state',
    endpoint: '/smscs',
    action: 'Add SMSC',
    actionEndpoint: '/smscs',
    actionMethod: 'POST',
    creatable: true,
    createKind: 'smsc',
    grid: {
      sortFields: [
        'name',
        'priority',
        'type',
        'enabled',
        'lifecycleState',
        'createdAt',
        'updatedAt',
      ],
      filters: [
        { field: 'type', label: 'Type', options: ['fake', 'smpp', 'http', 'at'] },
        { field: 'enabled', label: 'Enabled', options: BOOLEAN_OPTIONS },
        {
          field: 'lifecycleState',
          label: 'Lifecycle',
          options: [
            'draft',
            'validated',
            'approved',
            'deployed',
            'active',
            'degraded',
            'disabled',
            'archived',
          ],
        },
        { field: 'engineId', label: 'Engine ID' },
      ],
      exportBase: '/smscs/export',
    },
    /**
     * The column set from the design system's SmscsScreen, adapted to what this
     * deployment can actually observe.
     *
     * Designed:  SMSC · Country · Carrier · Protocol · State · Sessions ·
     *            TPS out · TPS in · Capacity · Queue · Oldest · DLR · Last event
     *
     * Kept, because the data exists: everything except Sessions, Oldest and
     * DLR. Throughput, capacity headroom and the last connectivity event all
     * come from `smsc_bind_snapshots` and `smsc_bind_transitions`, which the
     * poller has been writing since it was built and nothing was reading.
     *
     * Dropped rather than faked:
     *   Sessions — Kamex collapses `instances = N` behind one smsc-id, so the
     *              engine reports one bind however many connections exist.
     *   Oldest   — queue age is per-message in SQLBox, not per-bind; it belongs
     *              to the Queues screen, which already has it.
     *   DLR      — delivery rate per SMSC needs the sqlbox correlation, which
     *              is the DLR Performance screen's job.
     * Adding those headers with a dash under them would imply we look and find
     * nothing, when the truth is we do not look here.
     *
     * Kept from the old set because they are operationally load-bearing and the
     * kit has no equivalent: Lifecycle (draft/approved/deployed is JKANNEL's own
     * config workflow) and Last error.
     */
    columns: [
      {
        header: 'SMSC',
        value: (raw) => text(raw.name),
        dot: (raw) => smscDotClass(raw),
        hint: (raw) => text(raw.engine_id ?? raw.engineId, ''),
      },
      {
        header: 'Carrier',
        value: (raw) => text(raw.carrier_name ?? raw.carrierName, 'unassigned'),
        hint: (raw) =>
          [raw.carrier_country ?? raw.carrierCountry, raw.carrier_network ?? raw.carrierNetwork]
            .filter(Boolean)
            .join(' · '),
      },
      { header: 'Protocol', value: (raw) => text(raw.type) },
      { header: 'Host:port', value: (raw) => hostPort(raw), mono: true },
      {
        header: 'State',
        value: (raw) => text(raw.bind_state ?? raw.bindState, 'never observed'),
        badge: (raw) => badgeTone(raw.bind_state ?? raw.bindState),
      },
      // `unknown`, not 0 — a bind the poller has never sampled has no rate, and
      // printing 0.0 would report an idle carrier as a measured silence.
      { header: 'TPS out', value: (raw) => rateText(raw.outbound_rate ?? raw.outboundRate) },
      { header: 'TPS in', value: (raw) => rateText(raw.inbound_rate ?? raw.inboundRate) },
      { header: 'Capacity', value: (raw) => utilisationText(raw) },
      { header: 'Queue', value: (raw) => text(raw.queued_count ?? raw.queuedCount, '0') },
      {
        header: 'Lifecycle',
        value: (raw) => text(raw.lifecycle_state ?? raw.lifecycleState),
        badge: (raw) => badgeTone(raw.lifecycle_state ?? raw.lifecycleState),
      },
      {
        header: 'Last event',
        value: (raw) => text(raw.last_event ?? raw.lastEvent, 'no transitions recorded'),
        mono: true,
      },
      { header: 'Last error', value: (raw) => truncate(raw.last_error ?? raw.lastError, 48) },
    ],
  },
  routing: {
    noun: 'route',
    search: 'Route, prefix, sender, or target SMSC',
    endpoint: '/routes',
    action: 'Create route',
    actionEndpoint: '/routes',
    actionMethod: 'POST',
    creatable: true,
    createKind: 'route',
    grid: {
      sortFields: ['name', 'priority', 'enabled', 'deploymentState', 'createdAt', 'updatedAt'],
      filters: [
        { field: 'enabled', label: 'Enabled', options: BOOLEAN_OPTIONS },
        {
          field: 'deploymentState',
          label: 'Deployment',
          options: ['draft', 'validated', 'deployed', 'rolled_back', 'disabled', 'archived'],
        },
        // The API compares `target_smsc_id::text` exactly, and the grid column
        // renders `target_smsc_name` — so a free-text box invited the operator
        // to type the name they could see and get zero rows back, with no
        // error. Pick from the same connections list the route editor uses.
        { field: 'targetSmscId', label: 'Target SMSC', choices: 'routeSmsc' },
      ],
      exportBase: '/routes/export',
    },
    columns: [
      { header: 'Priority', value: (raw) => text(raw.priority), mono: true },
      {
        header: 'Route',
        value: (raw) => text(raw.name),
        hint: (raw) => text(raw.route_type ?? raw.routeType, ''),
      },
      { header: 'Strategy', value: (raw) => text(raw.strategy) },
      {
        header: 'Matches',
        value: (raw) =>
          [
            (raw.match_prefix ?? raw.matchPrefix)
              ? `prefix ${text(raw.match_prefix ?? raw.matchPrefix)}`
              : '',
            (raw.country_code ?? raw.countryCode)
              ? `country +${text(raw.country_code ?? raw.countryCode)}`
              : '',
            raw.operator ? `operator ${text(raw.operator)}` : '',
            (raw.destination_prefix ?? raw.destinationPrefix)
              ? `destination ${text(raw.destination_prefix ?? raw.destinationPrefix)}`
              : '',
            raw.sender ? `sender ${text(raw.sender)}` : '',
          ]
            .filter(Boolean)
            .join(' · ') || 'any destination',
      },
      {
        header: 'Target SMSC',
        value: (raw) => text(raw.target_smsc_name ?? raw.targetSmscName ?? raw.target_smsc_id),
      },
      {
        header: 'Fallback',
        value: (raw) =>
          text(raw.fallback_smsc_name ?? raw.fallbackSmscName ?? raw.fallback_smsc_id),
      },
      {
        /*
         * The design system's "Alternatives" column: can this route go anywhere
         * else if its target fails?
         *
         * Counted from the route's own record — a configured fallback plus any
         * weighted targets. "none configured" is the answer that matters: a
         * route with no alternative does not fail over, it queues, and that is
         * worth seeing in the register rather than discovering during an
         * incident.
         *
         * The kit also has an "Active target" column here. This grid
         * deliberately does NOT rename its target to that: a manual override
         * can be redirecting traffic somewhere else entirely, and this endpoint
         * knows nothing about overrides. Failover is the screen that resolves
         * the real active path, and calling a configured target "active" here
         * would state something we cannot see.
         */
        header: 'Alternatives',
        value: (raw) => {
          const fallback = raw.fallback_smsc_name ?? raw.fallbackSmscName ?? raw.fallback_smsc_id;
          const weighted = Array.isArray(raw.weighted_targets ?? raw.weightedTargets)
            ? ((raw.weighted_targets ?? raw.weightedTargets) as unknown[]).length
            : 0;
          const count = (fallback ? 1 : 0) + weighted;
          return count ? `${count} configured` : 'none configured';
        },
      },
      /*
       * How much of the target's ceiling this route's traffic is already
       * using. Kannel enforces throughput per bind, so the denominator is
       * tps × connections — the un-multiplied figure would show three times
       * the utilisation on a connection running `instances = 3`.
       *
       * "unknown" where either half is missing. A percentage of an
       * unmeasured ceiling is not 0%, and 0% here reads as spare capacity.
       */
      {
        header: 'Used / capacity',
        value: (raw) => {
          const tps = Number(raw.target_tps ?? raw.targetTps);
          const connections = Math.max(1, Number(raw.target_connections ?? 1) || 1);
          const rateRaw = raw.target_outbound_rate ?? raw.targetOutboundRate;
          const rate = rateRaw === null || rateRaw === undefined ? null : Number(rateRaw);
          if (!Number.isFinite(tps) || tps <= 0 || rate === null || !Number.isFinite(rate))
            return 'unknown';
          const ceiling = tps * connections;
          return `${Math.round(rate * 10) / 10} / ${ceiling}/s`;
        },
        mono: true,
      },
      /*
       * When traffic on this route last moved. Ended failovers count — a
       * reverted move is still a move, and "nothing has moved this route" is
       * a different and useful answer from "we do not know".
       */
      {
        header: 'Last transition',
        value: (raw) => text(raw.last_transition ?? raw.lastTransition, 'never moved'),
        mono: true,
      },
      { header: 'Cost', value: (raw) => text(raw.cost), mono: true },
      {
        header: 'Window',
        value: (raw) =>
          raw.window_start && raw.window_end
            ? `${text(raw.window_start)}–${text(raw.window_end)}`
            : 'always',
      },
      {
        header: 'Deployment',
        value: (raw) => text(raw.deployment_state ?? raw.deploymentState),
        badge: (raw) => badgeTone(raw.deployment_state ?? raw.deploymentState),
      },
      {
        header: 'Enabled',
        value: (raw) => (raw.enabled === false || raw.enabled === 'false' ? 'no' : 'yes'),
      },
      { header: 'Updated', value: (raw) => text(raw.updated_at ?? raw.updatedAt) },
    ],
  },
  configuration: {
    noun: 'configuration',
    search: 'Version, checksum, author, or status',
    endpoint: '/configurations',
    action: 'Create configuration',
    actionEndpoint: '/configurations',
    actionMethod: 'POST',
    creatable: true,
    createKind: 'configuration',
    grid: {
      sortFields: ['scope', 'versionNumber', 'status', 'createdAt'],
      filters: [
        { field: 'scope', label: 'Scope' },
        {
          field: 'status',
          label: 'Status',
          options: [
            'draft',
            'validated',
            'approved',
            'deployed',
            'superseded',
            'rolled_back',
            'failed',
          ],
        },
      ],
      exportBase: '/configurations/export',
    },
  },
  monitoring: {
    noun: 'metric',
    search: 'Metric, service, label, or state',
    endpoint: '/monitoring',
    action: 'Refresh',
    columns: [
      {
        header: 'Component',
        value: (raw) => text(raw.name),
        hint: (raw) => text(raw.id, ''),
      },
      {
        header: 'State',
        value: (raw) => text(raw.status ?? raw.state),
        badge: (raw) => badgeTone(raw.status ?? raw.state),
      },
      { header: 'Detail', value: (raw) => text(raw.detail) },
      { header: 'Observed', value: (raw) => text(raw.updatedAt ?? raw.updated_at) },
    ],
  },
  alerts: {
    noun: 'alert',
    search: 'Condition, severity, resource, or state',
    endpoint: '/alerts',
    action: 'Refresh',
    grid: {
      sortFields: ['openedAt', 'status', 'severity'],
      defaultSort: '-openedAt',
      filters: [
        // Every status alert_instances may hold (migration 037), not just the
        // three that existed before the lifecycle landed — otherwise a
        // suppressed or closed alert cannot be filtered for at all.
        {
          field: 'status',
          label: 'Status',
          options: ['open', 'acknowledged', 'suppressed', 'resolved', 'closed'],
        },
        { field: 'severity', label: 'Severity', options: ['info', 'warning', 'critical'] },
        { field: 'ruleId', label: 'Rule ID' },
      ],
      exportBase: '/alerts/export',
    },
    columns: [
      {
        header: 'Severity',
        value: (raw) => text(raw.severity ?? raw.rule_severity),
        badge: (raw) => badgeTone(raw.severity ?? raw.rule_severity),
      },
      {
        header: 'Condition',
        value: (raw) => text(raw.summary ?? raw.rule_name),
        hint: (raw) => text(raw.id, ''),
      },
      {
        header: 'Status',
        value: (raw) => text(raw.status),
        badge: (raw) => badgeTone(raw.status),
      },
      // The alerts index selects a.*, so the lifecycle columns arrive in their
      // snake_case database form. camelCase is read too because
      // GET /alerts/:id/lifecycle publishes the same fields that way.
      {
        header: 'Assigned to',
        value: (raw) =>
          text(raw.assigned_to_username ?? raw.assignedToUsername ?? raw.assigned_to, 'unassigned'),
        mono: true,
        hint: (raw) => text(raw.assigned_at ?? raw.assignedAt, ''),
      },
      {
        header: 'Suppressed until',
        value: (raw) => text(raw.suppressed_until ?? raw.suppressedUntil),
        hint: (raw) => text(raw.suppressed_reason ?? raw.suppressedReason, ''),
      },
      {
        header: 'Notification',
        value: (raw) => text(raw.notification_state ?? raw.notificationState, 'unknown'),
        badge: (raw) => notificationTone(raw.notification_state ?? raw.notificationState),
      },
      { header: 'Source', value: (raw) => text(raw.source) },
      { header: 'Rule', value: (raw) => text(raw.rule_name ?? raw.ruleName) },
      { header: 'Occurrences', value: (raw) => text(raw.dedup_count ?? raw.dedupCount, '1') },
      {
        header: 'Correlation',
        value: (raw) => text(raw.correlation_group ?? raw.correlationGroup),
        mono: true,
      },
      { header: 'Opened', value: (raw) => text(raw.opened_at ?? raw.openedAt) },
      {
        header: 'Acknowledged',
        value: (raw) => text(raw.acknowledged_by ?? raw.acknowledgedBy),
        hint: (raw) => text(raw.acknowledged_at ?? raw.acknowledgedAt, ''),
      },
      { header: 'Resolved', value: (raw) => text(raw.resolved_at ?? raw.resolvedAt) },
    ],
  },
  reports: {
    noun: 'volume report',
    search: 'Scope, label, or period',
    endpoint: '/reports/volume',
    action: 'Refresh',
    grid: {
      sortFields: ['periodStart', 'messageCount', 'scope'],
      defaultSort: '-periodStart',
      filters: [
        { field: 'periodType', label: 'Period', options: ['daily', 'weekly'] },
        { field: 'scope', label: 'Scope', options: ['total', 'smsc', 'route'] },
      ],
      exportBase: '/reports/volume/export',
      maxExportLimit: 1000,
    },
    columns: [
      { header: 'Period', value: (raw) => text(raw.period_type) },
      { header: 'From', value: (raw) => text(raw.period_start) },
      { header: 'To', value: (raw) => text(raw.period_end) },
      {
        header: 'Scope',
        value: (raw) =>
          raw.scope === 'total'
            ? 'total'
            : `${text(raw.scope)} · ${text(raw.scope_label ?? raw.scope_key)}`,
      },
      { header: 'Messages', value: (raw) => text(raw.message_count, '0') },
      { header: 'DLRs', value: (raw) => text(raw.dlr_count, '0') },
      { header: 'Generated', value: (raw) => text(raw.generated_at) },
    ],
  },
  notifications: {
    noun: 'notification',
    search: 'Title, body, or category',
    endpoint: '/notifications',
    action: 'Mark all read',
    actionEndpoint: '/notifications/read-all',
    actionMethod: 'POST',
    grid: {
      sortFields: ['createdAt', 'category'],
      defaultSort: '-createdAt',
      filters: [
        { field: 'category', label: 'Category' },
        { field: 'unread', label: 'Unread', options: BOOLEAN_OPTIONS },
      ],
    },
    columns: [
      { header: 'Received', value: (raw) => text(raw.created_at) },
      { header: 'Category', value: (raw) => text(raw.category) },
      { header: 'Title', value: (raw) => text(raw.title) },
      { header: 'Body', value: (raw) => text(raw.body) },
      { header: 'Status', value: (raw) => (raw.read_at ? 'read' : 'unread') },
    ],
  },
  customers: {
    noun: 'customer',
    search: 'Customer, account, status, or limit',
    endpoint: '/customers',
    action: 'Add customer',
    actionEndpoint: '/customers',
    actionMethod: 'POST',
    // Mirrors CUSTOMER_GRIDS.customers. Without a grid this workspace loaded
    // the API's default first 50 rows, rendered no pager, and searched only
    // those 50 in the browser — so row 51 onward was unreachable and a search
    // that "found nothing" had never looked past the first page.
    grid: {
      sortFields: ['name', 'status', 'createdAt'],
      filters: [{ field: 'status', label: 'Status' }],
    },
    columns: [
      { header: 'Customer', value: (raw) => text(raw.name) },
      { header: 'Code', value: (raw) => text(raw.code), mono: true },
      { header: 'Contact', value: (raw) => text(raw.contact_email ?? raw.contactEmail) },
      { header: 'Daily quota', value: (raw) => text(raw.quota_daily ?? raw.quotaDaily) },
      { header: 'Rate/min', value: (raw) => text(raw.rate_limit_per_min ?? raw.rateLimitPerMin) },
      { header: 'Status', value: (raw) => text(raw.status) },
    ],
  },
  'api-gateway': {
    noun: 'API client',
    search: 'Client, credential, route, or state',
    endpoint: '/api-gateway/clients',
    action: 'Create API client',
    actionEndpoint: '/api-gateway/clients',
    actionMethod: 'POST',
    creatable: true,
    // Mirrors PLATFORM_GRIDS.apiGatewayClients. No exportBase: this workspace
    // already renders its own CSV/PDF buttons for the same endpoints.
    grid: {
      sortFields: ['name', 'status', 'createdAt', 'lastUsedAt', 'rateLimit'],
      defaultSort: '-createdAt',
      filters: [{ field: 'status', label: 'Status' }],
    },
    columns: [
      { header: 'Name', value: (raw) => text(raw.name) },
      { header: 'Client key', value: (raw) => text(raw.client_key ?? raw.clientKey), mono: true },
      { header: 'Scopes', value: (raw) => list(raw.scopes) },
      { header: 'Status', value: (raw) => text(raw.status) },
      {
        header: 'Rate limit/min',
        value: (raw) => text(raw.rate_limit_per_min ?? raw.rateLimitPerMin),
      },
      { header: 'Last used', value: (raw) => text(raw.last_used_at ?? raw.lastUsedAt) },
    ],
  },
  docker: {
    noun: 'container',
    search: 'Container, image, service, or state',
    endpoint: '/docker/containers',
    action: 'Refresh',
  },
  'logs-audit': {
    noun: 'audit event',
    search: 'Actor, action, resource, or correlation ID',
    endpoint: '/audit-events',
    action: 'Refresh',
    grid: {
      sortFields: ['createdAt', 'action', 'entityType'],
      defaultSort: '-createdAt',
      filters: [
        { field: 'action', label: 'Action' },
        { field: 'entityType', label: 'Entity type' },
        { field: 'actorId', label: 'Actor' },
        { field: 'entityId', label: 'Entity ID' },
      ],
      exportBase: '/audit-events/export',
      maxExportLimit: 1000,
    },
    columns: [
      { header: 'When', value: (raw) => text(raw.created_at ?? raw.createdAt) },
      { header: 'Actor', value: (raw) => text(raw.actor_id ?? raw.actorId), mono: true },
      { header: 'Action', value: (raw) => text(raw.action) },
      {
        header: 'Entity',
        value: (raw) =>
          `${text(raw.entity_type ?? raw.entityType)} ${text(raw.entity_id ?? raw.entityId, '')}`.trim(),
        mono: true,
      },
      /*
       * §12 asks an audit row to answer "what did it look like before". A
       * creation genuinely has no previous state, and that is a different
       * fact from a change whose before-value nobody captured — so the two
       * read differently rather than both collapsing to an em dash.
       */
      {
        header: 'Previous state',
        value: (raw) => summariseState(raw.old_value ?? raw.oldValue),
        mono: true,
      },
      { header: 'Reason', value: (raw) => text(raw.reason) },
      {
        header: 'Correlation',
        value: (raw) => text(raw.correlation_id ?? raw.correlationId),
        mono: true,
      },
      { header: 'Source IP', value: (raw) => text(raw.source_ip ?? raw.sourceIp), mono: true },
    ],
  },
  plugins: {
    noun: 'plugin',
    search: 'Plugin, capability, publisher, or state',
    endpoint: '/plugins',
    action: 'Refresh',
    /* Mirrors PLATFORM_GRIDS.plugins. */
    grid: {
      sortFields: ['name', 'status', 'installedAt', 'version'],
      filters: [
        { field: 'status', label: 'Status' },
        { field: 'publisher', label: 'Publisher' },
      ],
    },
    columns: [
      { header: 'Plugin', value: (raw) => text(raw.name ?? raw.plugin_id) },
      { header: 'Version', value: (raw) => text(raw.version) },
      { header: 'Publisher', value: (raw) => text(raw.publisher) },
      { header: 'Status', value: (raw) => text(raw.status) },
      { header: 'Permissions', value: (raw) => list(raw.permissions) },
      { header: 'Events', value: (raw) => list(raw.events) },
    ],
  },
  backup: {
    noun: 'backup',
    search: 'Backup name, date, type, or status',
    endpoint: '/backup-dr',
    action: 'Create backup',
    actionEndpoint: '/backup-dr',
    actionMethod: 'POST',
    // Mirrors BACKUP_DR_GRIDS.backups. No exportBase: this workspace renders
    // its own CSV button (and states that there is no PDF route).
    grid: {
      sortFields: [
        'startedAt',
        'completedAt',
        'status',
        'kind',
        'retentionClass',
        'verifiedAt',
        'sizeBytes',
      ],
      defaultSort: '-startedAt',
      filters: [
        { field: 'status', label: 'Status' },
        { field: 'kind', label: 'Kind' },
        { field: 'retentionClass', label: 'Retention' },
      ],
    },
    columns: [
      { header: 'Label', value: (raw) => text(raw.label) },
      { header: 'Scope', value: (raw) => text(raw.scope) },
      { header: 'Kind', value: (raw) => text(raw.kind) },
      {
        header: 'Status',
        value: (raw) => text(raw.status),
        badge: (raw) => badgeTone(raw.status),
      },
      { header: 'Retention', value: (raw) => text(raw.retention_class ?? raw.retentionClass) },
      { header: 'Verified', value: (raw) => text(raw.verified_at ?? raw.verifiedAt, 'never') },
      { header: 'Size', value: (raw) => formatBytes(raw.size_bytes ?? raw.sizeBytes) },
      {
        header: 'Offsite',
        value: (raw) => text(raw.offsite_synced_at ?? raw.offsiteSyncedAt, 'not synced offsite'),
        hint: (raw) => text(raw.offsite_location ?? raw.offsiteLocation, ''),
      },
      { header: 'Checksum', value: (raw) => text(raw.checksum), mono: true },
      { header: 'Started', value: (raw) => text(raw.started_at ?? raw.startedAt) },
      { header: 'Completed', value: (raw) => text(raw.completed_at ?? raw.completedAt) },
      { header: 'Warning', value: (raw) => truncate(raw.warning, 48) },
    ],
  },
  users: {
    noun: 'user',
    search: 'Name, role, permission, or status',
    endpoint: '/users',
    action: 'Invite user',
    actionEndpoint: '/users/invitations',
    actionMethod: 'POST',
    creatable: true,
    createKind: 'invitation',
    grid: {
      sortFields: ['username', 'status', 'createdAt'],
      filters: [
        {
          field: 'status',
          label: 'Status',
          options: ['pending', 'active', 'disabled', 'locked', 'expired', 'archived', 'deleted'],
        },
      ],
      exportBase: '/users/export',
    },
    columns: [
      {
        header: 'User',
        value: (raw) => text(raw.username),
        hint: (raw) => text(raw.id, ''),
      },
      {
        header: 'Status',
        value: (raw) => text(raw.status),
        badge: (raw) => badgeTone(raw.status),
      },
      { header: 'Roles', value: (raw) => list(raw.roles) },
      /*
       * What the account can actually do, from the roles it holds. A user with
       * no role reads "no privileges" rather than blank: that account can sign
       * in and see nothing, which is a real and confusing state worth naming in
       * the register instead of leaving as an empty cell.
       */
      {
        header: 'Privileges',
        value: (raw) => {
          const roles = Array.isArray(raw.roles) ? (raw.roles as unknown[]) : [];
          if (!roles.length) return 'no privileges — signs in and sees nothing';
          return `via ${roles.map((role) => String(role)).join(', ')}`;
        },
      },
      /*
       * Derived from the audit trail's last `login.succeeded`, not from a
       * column on `users`. "never seen" is a distinct answer from a date and
       * from a blank — an account that has never been used is exactly the one
       * worth noticing in an access review.
       */
      {
        header: 'Last seen',
        value: (raw) => text(raw.last_seen_at ?? raw.lastSeenAt, 'never seen'),
        mono: true,
      },
      { header: 'Created', value: (raw) => text(raw.created_at ?? raw.createdAt) },
      { header: 'Updated', value: (raw) => text(raw.updated_at ?? raw.updatedAt) },
    ],
  },
  system: {
    noun: 'setting',
    search: 'Setting name or value',
    endpoint: '/system/settings',
    action: 'Refresh',
  },
};

const route = useRoute();
const query = ref('');
const state = ref('All');
const rows = ref<Row[]>([]);
const loading = ref(false);
const error = ref('');
const unavailable = ref(false);
const notice = ref('');
const showComposer = ref(false);
const draftName = ref('');
const draftTarget = ref('');
const routeDestinationPrefix = ref('');
const routeSender = ref('');
const routeFallback = ref('');
const simulationDestination = ref('+256700000000');
const simulationSender = ref('');
const simulationResult = ref<RecordValue | null>(null);
const retentionDays = ref(90);
const retentionStatus = ref<RecordValue | null>(null);
const configAdminPort = ref(13000);
const configSmsboxPort = ref(13001);
const configSqlbox = ref(true);
const configDiffFrom = ref('');
const configDiffTo = ref('');
const configDiffResult = ref<RecordValue | null>(null);
/**
 * The whole SMSC draft, as one record rather than a ref per field.
 *
 * There are thirty-eight settable fields. A ref each is how the form came to
 * expose four of them: adding one meant adding a ref, a reset, a payload line
 * and a control, so nobody did. `SmscConfigForm` reads and writes this object,
 * and a field it sets is a field that saves.
 */
// SMPP by default: a carrier bind is what this console is for, and `fake`
// — a local test sink that reaches no network — is a strange thing to
// offer somebody first.
const smscDraft = ref<SmscDraft>({ type: 'smpp', port: 2775, tps: 10, enabled: true });

/* Server-side grid state (search is shared with the legacy client filter). */
/* Message search (G13): every filter below — query, status, direction, SMSC and
   the from/to range — is parsed server-side by one shared parser
   (messaging-depth/message-filters.ts) that `GET /messages`, `export.csv` and
   `export.pdf` all call, so the export cannot answer a different question from
   the screen. Nothing is re-filtered in the console. */
const msgStatus = ref('');
const msgDirection = ref('');
const msgSmscId = ref('');
const msgFrom = ref('');
const msgTo = ref('');
const msgLimit = ref(100);
const MESSAGE_STATUS_CHOICES = [
  { value: '', label: 'Any delivery status' },
  { value: 'resendable', label: 'Resendable failures (failed + rejected)' },
  { value: 'in-flight', label: 'In flight (pending + buffered)' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'failed', label: 'Failed' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'accepted', label: 'Accepted by SMSC' },
  { value: 'buffered', label: 'Buffered at SMSC' },
  { value: 'pending', label: 'Pending (no report yet)' },
  { value: 'unknown', label: 'Unknown' },
  { value: 'delivery_report', label: 'Delivery receipts only' },
];

const sortField = ref('');
const sortDirection = ref<'asc' | 'desc'>('asc');
const gridFilters = ref<Record<string, string>>({});
const limit = ref(50);
const offset = ref(0);
const total = ref(0);
let appliedSearch = '';
let searchTimer: ReturnType<typeof setTimeout> | undefined;

/* Message submission (POST /messages requires a tenant SMSC engine id). */
const showSendForm = ref(false);
const sendSender = ref('');
const sendReceiver = ref('');
const sendText = ref('');
const sendSmscId = ref('');
const sendLater = ref(false);
const sendSchedule = ref<ScheduleDraft>(emptySchedule());
/** '' = the key is omitted from the request; see utils/message-priority.ts. */
const sendPriority = ref<PriorityChoice>(PRIORITY_UNSET);
const smscOptions = ref<Array<{ value: string; label: string }>>([]);
const smscOptionsError = ref('');

/* Reports extras: delivery summary + on-demand generation. */
const deliverySummary = ref<RecordValue | null>(null);
const deliveryUnavailable = ref(false);

/*
  Honest handling of a backend `source: { status: 'unavailable' }` marker. In
  practice every one the console reaches is the SQLBox message store reporting
  itself unreachable, so the code is kept and branched on — see
  detectUnavailableSource().
*/
const sourceUnavailable = ref(false);
const sourceMessage = ref('');
const sourceCode = ref('');
const sourceIsOutage = computed(() => sourceCode.value === 'SQLBOX_NOT_AVAILABLE');

/* Shared detail drawer (users, smsc, logs-audit). */
const detailOpen = ref(false);
const detailLoading = ref(false);
const detailError = ref('');
const detail = ref<RecordValue | null>(null);
const editing = ref(false);

/* Users & roles. */
const roleOptions = ref<RecordValue[]>([]);
const showCreateUser = ref(false);
const newUsername = ref('');
const newPassword = ref('');
const newRoleIds = ref<string[]>([]);
const editUserStatus = ref('');
const editUserRoleIds = ref<string[]>([]);
const editUserPassword = ref('');

/* SMSC edit. */
const editSmscDraft = ref<SmscDraft>({});

/* Cursor-paginated modules (queues, delivery reports). */
const cursorItems = ref<RecordValue[]>([]);
const cursorNext = ref<string | null>(null);
const cursorSummary = ref<RecordValue | null>(null);
const cursorSource = ref<RecordValue | string | null>(null);
const cursorCurrent = ref<string | null>(null);
const cursorHistory = ref<Array<string | null>>([]);
const dlrSmscId = ref('');

/*
 * Delivery report filters.
 *
 * `GET /reports/delivery` is parsed by `parseMessageFilters`
 * (backend/src/messaging-depth/message-filters.ts). Accepted parameters:
 * limit (1–500, default 100), cursor, offset, query, status, deliveryStatus,
 * smscId, direction, from, to, sort. `direction` is force-set to 'DLR' by the
 * controller (the report IS the receipt rows) so it is not offered here.
 *
 * TWO PAGING MODES, chosen by the query rather than by a flag — see
 * `KamexSqlboxRepository.list`:
 *   default sort  -> keyset on `sql_id DESC`; `nextCursor`, no row count.
 *   any other sort (or an explicit `offset`) -> OFFSET paging with a `total`,
 *   because a `sql_id` cursor cannot express a page boundary in someone else's
 *   ordering. The pager below follows the mode the query put it in.
 *
 * The outcome vocabulary and the group aliases come from `DELIVERY_STATUSES` /
 * `DELIVERY_STATUS_GROUPS` in backend/src/engine/kamex-sqlbox.repository.ts. On
 * this route the rows are classified in `receipts` mode, so `deliveryStatus`
 * carries the receipt's OWN decoded outcome (delivered / failed / …) rather
 * than the literal `delivery_report`, which is what makes filtering meaningful.
 */
const DELIVERY_STATUSES = [
  'delivered',
  'failed',
  'rejected',
  'buffered',
  'accepted',
  'pending',
  'unknown',
] as const;
/** Server-side aliases: `resendable` = failed+rejected, `in-flight` = pending+buffered. */
const DELIVERY_STATUS_GROUPS = [
  { token: 'resendable', label: 'Resendable', members: ['failed', 'rejected'] },
  { token: 'in-flight', label: 'In flight', members: ['pending', 'buffered'] },
] as const;

const dlrStatuses = ref<string[]>([]);
const dlrGroup = ref('');
const dlrFrom = ref('');
const dlrTo = ref('');
const dlrLimit = ref(50);
/** '' = the API's own default order (newest first), which is the keyset path. */
const dlrSortField = ref('');
const dlrSortDir = ref<'asc' | 'desc'>('desc');
const dlrOffset = ref(0);
const dlrTotal = ref(0);
const dlrFilterError = ref('');

/* Runtime containers. */
const containers = ref<RecordValue[]>([]);
const containersObservedAt = ref('');

/* System settings. */
const settingItems = ref<RecordValue[]>([]);
const settingDrafts = ref<Record<string, string>>({});

/* API gateway one-time secret + client composer. */
const showApiClientForm = ref(false);
const apiClientName = ref('');
// A chosen set, not typed text. The old comma-separated field let an operator
// invent scope names the gateway does not enforce; see ScopePicker.vue.
const apiClientScopes = ref<string[]>([]);
const revealedSecret = ref('');
const revealedSecretLabel = ref('');

/* Backup restore composer. */
const restoreRow = ref<Row | null>(null);
const restoreReason = ref('');

/* Backup create modal (label + scope). */
const showBackupModal = ref(false);
const backupLabel = ref('');
const backupScope = ref<'full' | 'database' | 'configurations'>('full');
/** Mirrors backup-dr.controller.ts: kind full|schema|incremental, six retention classes. */
const BACKUP_KINDS = ['full', 'schema', 'incremental'];
const RETENTION_CLASSES = ['hourly', 'daily', 'weekly', 'monthly', 'yearly', 'manual'];
const backupKind = ref('full');
const backupRetention = ref('manual');
const backupSchedules = ref<RecordValue[]>([]);
const backupSchedulesError = ref('');
const backupSchedulesMissing = ref(false);
const showScheduleForm = ref(false);
const scheduleName = ref('');
const scheduleMode = ref<'interval' | 'cron'>('interval');
const scheduleCron = ref('0 2 * * *');
const scheduleIntervalMinutes = ref(1440);
const scheduleKind = ref('full');
const scheduleRetention = ref('daily');
const scheduleEnabled = ref(true);
const scheduleError = ref('');
const retentionSweep = ref<Array<RecordValue> | null>(null);

/* Message trace drawer. */
const messageOpen = ref(false);
const messageLoading = ref(false);
const messageError = ref('');
const messageRow = ref<RecordValue | null>(null);
const messageTrace = ref<RecordValue | null>(null);

/**
 * Delivery report detail drawer (delivery-reports workspace).
 *
 * `GET /reports/delivery` returns the SQLBox read model's full normalised row
 * per receipt — there is no per-receipt endpoint, and none is needed: the list
 * row already carries every field the drawer shows. The five columns in the
 * grid are a summary of it, not the whole record.
 */
const dlrOpen = ref(false);
const dlrRecord = ref<RecordValue | null>(null);
function openDlrDetail(record: RecordValue) {
  dlrRecord.value = record;
  dlrOpen.value = true;
}
function closeDlrDetail() {
  dlrOpen.value = false;
  dlrRecord.value = null;
}

/* Message operations (replay / clone / requeue) on the traced message. */
const traceId = ref('');
const opBusy = ref(false);
const opResult = ref<RecordValue | null>(null);
const opError = ref('');
const showCloneForm = ref(false);
const cloneReceiver = ref('');
const cloneSender = ref('');
const cloneText = ref('');

/* Configuration templates + drift (configuration workspace). */
const configTemplates = ref<RecordValue[]>([]);
const configTemplatesError = ref('');
const templateView = ref<RecordValue | null>(null);
const templateViewLoading = ref(false);
const instantiateResult = ref<RecordValue | null>(null);
const driftResult = ref<RecordValue | null>(null);
const driftError = ref('');
const driftLoading = ref(false);

/* Route target/fallback SMSC dropdown options (value = SMSC id). */
const routeSmscOptions = ref<Array<{ value: string; label: string }>>([]);
const routeSmscError = ref('');

/* Configuration baseline + edit-as-new-version prefill. */
const configBaseline = ref<RecordValue | null>(null);
const configPrefillContent = ref<RecordValue | null>(null);

/* Volume report snapshot detail (reports module). */
const snapshotOpen = ref(false);
const snapshotLoading = ref(false);
const snapshotError = ref('');
const snapshotDetail = ref<RecordValue | null>(null);

/* Customers create + detail. */
const showCreateCustomer = ref(false);
const custName = ref('');
const custCode = ref('');
const custEmail = ref('');
const custQuotaDaily = ref<number | null>(null);
const custRateLimit = ref<number | null>(null);
const custSenderIds = ref('');
const custNotes = ref('');
const custStatus = ref('active');
const editCustName = ref('');
const editCustEmail = ref('');
const editCustQuotaDaily = ref<number | null>(null);
const editCustRateLimit = ref<number | null>(null);
const editCustSenderIds = ref('');
const editCustNotes = ref('');
const editCustStatus = ref('active');

const apiBaseUrl = '/api/v1';
const openApiUrl = '/api/v1/openapi.json';

const key = computed(() => String(route.name));
const workspace = computed(() => definitions[key.value]);
const grid = computed(() => workspace.value?.grid);
const columns = computed(() => workspace.value?.columns);
const states = computed(() => [
  'All',
  ...new Set(rows.value.map((row) => row.status).filter(Boolean)),
]);
/**
 * Workspaces whose search term is sent to the API rather than applied here.
 *
 * `/messages` belongs in this set and was missing from it, with two
 * consequences: the debounced search watcher bailed out (so typing did nothing
 * until "Apply filters" was clicked), and `visibleRows` then re-filtered the
 * server's own matches against `id name detail status` — fields a SQLBox
 * message row does not have. Searching a recipient number or message body,
 * exactly what the placeholder invites, matched on the server and was then
 * filtered to zero rows in the browser, showing "No records match these
 * filters."
 */
const serverSideSearch = computed(
  () => Boolean(grid.value) || isCursor.value || key.value === 'messages',
);
/**
 * Country scope for the SMSC register — the chips above it.
 *
 * Counted from the rows already loaded rather than fetched as a separate
 * summary: a second query could disagree with the table underneath it, and a
 * header that contradicts the list below is worse than no header.
 */
const countryFilter = ref('');
const countryChips = computed(() => {
  if (key.value !== 'smsc') return [];
  const tally = new Map<
    string,
    { country: string; code: string; label: string; total: number; down: number }
  >();
  for (const row of rows.value) {
    const raw = row.raw;
    const country = text(raw.carrier_country ?? raw.carrierCountry, '');
    if (!country || country === '—') continue;
    const entry = tally.get(country) ?? {
      country,
      // The engine has no country code of its own; the carrier's two-letter
      // country IS the code, so the chip shows it rather than inventing one.
      code: country.slice(0, 2).toUpperCase(),
      // Blank when the country IS its own two-letter code, which is how the
      // carrier register stores it — otherwise the chip read "UG UG".
      label: country.length > 2 ? country : '',
      total: 0,
      down: 0,
    };
    entry.total += 1;
    // "Not connected" is the observed bind state, not the enabled flag: a bind
    // an operator has enabled and the carrier has not accepted is exactly the
    // case this count exists to surface.
    if (smscDotClass(raw) !== 'good') entry.down += 1;
    tally.set(country, entry);
  }
  return [...tally.values()].sort((a, b) => b.down - a.down || a.country.localeCompare(b.country));
});

const visibleRows = computed(() => {
  const scoped = countryFilter.value
    ? rows.value.filter(
        (row) =>
          text(row.raw.carrier_country ?? row.raw.carrierCountry, '') === countryFilter.value,
      )
    : rows.value;
  if (serverSideSearch.value) return scoped;
  return scoped
    .filter((row) => state.value === 'All' || row.status === state.value)
    .filter((row) =>
      `${row.id} ${row.name} ${row.detail} ${row.status}`
        .toLowerCase()
        .includes(query.value.toLowerCase()),
    );
});
const hasRowActions = computed(
  () =>
    key.value === 'smsc' ||
    key.value === 'configuration' ||
    key.value === 'routing' ||
    key.value === 'notifications' ||
    key.value === 'plugins' ||
    key.value === 'backup' ||
    key.value === 'alerts' ||
    key.value === 'api-gateway',
);
const columnCount = computed(
  () => (columns.value ? columns.value.length : 4) + (hasRowActions.value ? 1 : 0),
);
const rangeLabel = computed(() => {
  if (!total.value || !rows.value.length) return 'Showing 0 of 0';
  const first = offset.value + 1;
  const last = offset.value + rows.value.length;
  return `Showing ${first}–${last} of ${total.value}`;
});
const canGenerateReports = computed(() => canAccess(session.value, 'system.manage'));
const canManageUsers = computed(() => canAccess(session.value, 'users.manage'));
const canManageSystem = computed(() => canAccess(session.value, 'system.manage'));
const canManageConfig = computed(() => canAccess(session.value, 'configuration.manage'));

/* --- GENERATED CONFIGURATION --------------------------------------------------
 *
 * The file the engine would be handed right now, from `POST
 * /configurations/generate?source=database` — the same generator the deploy
 * path runs, reading the same live objects. Not a preview of a draft: what is
 * rendered here is what a deploy would write.
 *
 * On demand, not on load. Rendering resolves secret references, which makes it
 * the one read on this screen with a real cost, and an operator who came to
 * look at the version list should not pay it.
 */
const generatedConfig = ref<{ content?: string; checksum?: string; engine?: string } | null>(null);
const generatedBusy = ref(false);
const generatedError = ref('');

async function loadGeneratedConfig() {
  generatedBusy.value = true;
  generatedError.value = '';
  try {
    generatedConfig.value = await apiRequest('/configurations/generate?source=database', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  } catch (reason) {
    generatedConfig.value = null;
    // The generator's own message names the offending value or the missing
    // secret reference, so it is surfaced verbatim rather than replaced with
    // "generation failed" — the detail is the whole point of the error.
    generatedError.value =
      reason instanceof Error ? reason.message : 'The configuration could not be rendered.';
  } finally {
    generatedBusy.value = false;
  }
}
const canAcknowledgeAlerts = computed(() => canAccess(session.value, 'alerts.acknowledge'));
const canReveal = computed(() => canAccess(session.value, 'messages.reveal'));

/**
 * The `privacy` block the API attached to the last payload, or null.
 *
 * Null is meaningful: it means this workspace's data carries no subscriber
 * information, so no masking notice belongs on it. Treating null as "unmasked"
 * would put the notice on screens that have nothing to mask.
 */
const privacy = ref<PrivacyState | null>(null);
/** Whether a reveal window is currently open, per the reveal control. */
const revealing = ref(false);

/**
 * The reveal control changed state, so what is on screen no longer matches what
 * the operator is authorised to see. Re-fetch rather than transform the rows we
 * already have: the unmasked values were never sent, and un-masking client-side
 * is not something a masked payload makes possible.
 */
function onRevealChanged(value: boolean) {
  if (revealing.value === value) return;
  revealing.value = value;
  void load(true);
}

const isQueue = computed(() => key.value === 'queues');
const isDlr = computed(() => key.value === 'delivery-reports');
const isCursor = computed(() => isQueue.value || isDlr.value);
const isDocker = computed(() => key.value === 'docker');
const isSystem = computed(() => key.value === 'system');

/* --- PLATFORM MAINTENANCE -----------------------------------------------------
 *
 * `GET /engine/capabilities` and `POST /messages/indexes`: two operations that
 * belong to the platform rather than to any workspace, and neither had a
 * surface.
 *
 * Capabilities are how the console decides what to offer, so they are rendered
 * verbatim rather than summarised — a paraphrase here could disagree with the
 * screens that act on them.
 */
const capabilities = ref<Record<string, unknown> | null>(null);
const maintenanceBusy = ref('');
const maintenanceNotice = ref('');
const maintenanceError = ref('');

async function loadCapabilities() {
  maintenanceBusy.value = 'capabilities';
  maintenanceError.value = '';
  maintenanceNotice.value = '';
  try {
    capabilities.value = await apiRequest<Record<string, unknown>>('/engine/capabilities');
  } catch (reason) {
    capabilities.value = null;
    maintenanceError.value =
      reason instanceof Error ? reason.message : 'Engine capabilities could not be read.';
  } finally {
    maintenanceBusy.value = '';
  }
}

async function ensureIndexes() {
  maintenanceBusy.value = 'indexes';
  maintenanceError.value = '';
  maintenanceNotice.value = '';
  try {
    const result = await apiRequest<Record<string, unknown>>('/messages/indexes', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    // The route answers with a `source.status` of unavailable rather than
    // throwing when SQLBox is not reachable, so a bare "done" would be wrong.
    const source = (result?.source as Record<string, unknown> | undefined)?.status;
    maintenanceNotice.value =
      source === 'unavailable'
        ? 'The engine message store could not be reached, so no index was created or checked.'
        : `Indexes ensured. ${Array.isArray(result?.indexes) ? (result.indexes as unknown[]).length : 0} index(es) reported.`;
  } catch (reason) {
    maintenanceError.value =
      reason instanceof Error ? reason.message : 'The indexes could not be ensured.';
  } finally {
    maintenanceBusy.value = '';
  }
}
const customRender = computed(() => isCursor.value || isDocker.value || isSystem.value);

/**
 * Whether the search box actually filters anything on this workspace.
 *
 * Three cases:
 *   - `grid` → the term is sent as `?search=` and applied by the API. Real.
 *   - the generic table → `visibleRows` filters the loaded rows client-side.
 *     Narrower than it looks, but real.
 *   - `/docker` and `/system` → rendered by their own templates, which iterate
 *     `containers` / `settingGroups` and never consult `visibleRows`; neither
 *     endpoint reads a query parameter either. `/monitoring` returns a single
 *     engine-identity row, so filtering it is meaningless.
 * The last group used to render a search box (and a Status dropdown) that
 * silently did nothing, so those controls are no longer offered there.
 */
const searchIsLive = computed(
  () => !isDocker.value && !isSystem.value && key.value !== 'monitoring',
);
/**
 * Modules whose rows open the record in a sheet.
 *
 * The test is whether the API has a per-record read. `plugins` and
 * `notifications` are here because `GET /plugins/{id}` and
 * `GET /notifications/{id}` exist and nothing in the console was calling
 * them — the register showed a name and a status button and there was no way
 * to see the rest of the record.
 *
 * Deliberately NOT here, and each for the same reason — the API has no
 * per-record read, so a sheet would have nothing to put in it beyond the row
 * the operator is already looking at:
 *   api-gateway  /api-gateway/clients/{id} is PATCH and DELETE only
 *   backup       /backups/{id} has restore and verify, no GET
 *   sessions     /sessions/{id} has revoke, no GET
 * Their rows carry the actions instead, which is what the register is for.
 */
const detailModule = computed(
  () =>
    key.value === 'users' ||
    key.value === 'smsc' ||
    key.value === 'logs-audit' ||
    key.value === 'customers' ||
    key.value === 'plugins' ||
    key.value === 'notifications' ||
    key.value === 'routing' ||
    // Added once the API grew a per-record read for each. Every one of these
    // was listed in `interaction-audit.mjs` as a register whose rows opened
    // nothing, with the reason "there is no GET" — which was true, and is the
    // difference between a deliberate omission and an unfinished one.
    key.value === 'api-gateway' ||
    key.value === 'backup',
);
const settingGroups = computed(() => {
  const groups: Record<string, RecordValue[]> = {};
  for (const item of settingItems.value) {
    const name = text(item.group, 'general');
    (groups[name] ??= []).push(item);
  }
  return Object.entries(groups).map(([name, items]) => ({ name, items }));
});

function normalize(payload: unknown): { items: Row[]; total: number } {
  let source: unknown[] = [];
  let count: number | null = null;

  if (Array.isArray(payload)) {
    source = payload;
  } else if (payload && typeof payload === 'object') {
    const record = payload as RecordValue;
    source = Array.isArray(record.items)
      ? record.items
      : ((Object.values(record).find(Array.isArray) as unknown[] | undefined) ?? []);
    if (typeof record.total === 'number') count = record.total;
  }

  const items = source
    .filter((item): item is RecordValue => Boolean(item) && typeof item === 'object')
    .map((item, index) => {
      const id = text(item.id ?? item.uuid ?? item.messageId, String(index + 1));
      return {
        id,
        name: text(
          item.name ??
            item.title ??
            item.username ??
            item.recipient ??
            item.containerName ??
            (item.scope && item.version_number
              ? `${item.scope} v${item.version_number}`
              : undefined) ??
            item.id,
        ),
        detail: text(
          item.description ?? item.detail ?? item.type ?? item.host ?? item.action ?? item.checksum,
        ),
        status: text(item.status ?? item.state ?? item.lifecycle_state),
        updated: text(
          item.updatedAt ?? item.updated_at ?? item.createdAt ?? item.created_at ?? item.timestamp,
        ),
        raw: item,
      };
    });
  return { items, total: count ?? items.length };
}

function buildGridQuery(overrides: { limit?: number; offset?: number } = {}) {
  const params = new URLSearchParams();
  if (query.value.trim()) params.set('search', query.value.trim());
  if (sortField.value)
    params.set('sort', `${sortDirection.value === 'desc' ? '-' : ''}${sortField.value}`);
  for (const [field, value] of Object.entries(gridFilters.value)) {
    if (value.trim()) params.set(`filter.${field}`, value.trim());
  }
  params.set('limit', String(overrides.limit ?? limit.value));
  params.set('offset', String(overrides.offset ?? offset.value));
  return params;
}

/**
 * THE message query string. `query`, `status`, `direction`, `smscId`, `from`,
 * `to` and `limit` are all honoured server-side by the shared filter parser, and
 * this same function builds the query for the grid AND for both exports — so an
 * export is structurally the same question as the screen, not a promise that it
 * is. An invalid or inverted range is a 400 naming the problem, surfaced inline
 * by `messageFilterError` rather than as a generic workspace failure.
 */
function messageParams(limitOverride?: number) {
  const params = new URLSearchParams();
  if (query.value.trim()) params.set('query', query.value.trim());
  if (msgStatus.value) params.set('status', msgStatus.value);
  if (msgDirection.value) params.set('direction', msgDirection.value);
  if (msgSmscId.value.trim()) params.set('smscId', msgSmscId.value.trim());
  const from = msgFrom.value ? Date.parse(msgFrom.value) : NaN;
  const to = msgTo.value ? Date.parse(msgTo.value) : NaN;
  if (Number.isFinite(from)) params.set('from', new Date(from).toISOString());
  if (Number.isFinite(to)) params.set('to', new Date(to).toISOString());
  params.set('limit', String(limitOverride ?? msgLimit.value));
  /*
   * `offset`, so the Messages grid can be paged.
   *
   * It had a Rows selector and no pager, which is not a smaller version of
   * pagination — it is a different thing. The only way to reach a message that
   * was not in the most recent N was to raise N, and with 17,689 rows in the
   * spool on the local stack alone, "raise the limit until your row appears" is
   * not a way to find anything.
   *
   * ALWAYS SENT, including `offset=0`, and that is not a detail. The repository
   * runs two different paging modes: with no `offset` it uses a keyset cursor
   * and returns `total: null`, and only an explicit `offset` switches it to
   * offset paging with a `count(*) OVER()`. So the tidy-looking version of this
   * line — omit the parameter when it is zero — left page one with no total,
   * which left Next permanently disabled, which meant the pager could never be
   * used at all. Measured: "Showing 1–100 of 100" against 17,689 rows.
   *
   * Not sent on an export: `limitOverride` is how the export asks for its own
   * (larger) page, and an export that started from page 4 would silently omit
   * the first three pages of what the operator was looking at.
   */
  if (limitOverride === undefined) params.set('offset', String(offset.value));
  applyReveal(params);
  return params;
}

/**
 * Adds `reveal=true` only while a window is actually open.
 *
 * Sent on the export too, deliberately: an export raised from a revealed screen
 * that came back masked — or the reverse — would mean the file did not contain
 * what the operator was looking at when they clicked.
 */
function applyReveal(params: URLSearchParams) {
  if (revealing.value) params.set('reveal', 'true');
  return params;
}
const messageDateFiltered = computed(() => Boolean(msgFrom.value || msgTo.value));
/** Inverted range, caught here so the operator is not made to wait for a 400. */
const messageRangeInverted = computed(() => {
  const from = msgFrom.value ? Date.parse(msgFrom.value) : NaN;
  const to = msgTo.value ? Date.parse(msgTo.value) : NaN;
  return Number.isFinite(from) && Number.isFinite(to) && from > to;
});
/** The API's own 400 text ("from must not be after to", "status contains …"). */
const messageFilterError = ref('');
/** Human summary of the filter set the API echoed back, proving what it applied. */
const messageAppliedFilters = ref('');
function applyMessageFilters() {
  // Back to the first page. Changing a filter while on page 4 would ask the
  // server for rows 300–400 of a result set that may have fewer than 300 rows,
  // and the operator would be shown an empty grid for a filter that matches
  // plenty. Every other register already does this on a filter change; the
  // messages path did not, because until now it had no pages to be on.
  offset.value = 0;
  void load();
}
/**
 * `GET /messages` echoes the filter set it actually parsed, including a
 * `description`. Showing it is how the operator can prove the screen and the
 * export were asked the same question rather than being told they were.
 */
function captureMessageFilterEcho(payload: unknown) {
  if (!payload || typeof payload !== 'object') return;
  const filters = (payload as RecordValue).filters;
  if (!filters || typeof filters !== 'object') return;
  messageAppliedFilters.value = text((filters as RecordValue).description, '');
  if (messageAppliedFilters.value === '—') messageAppliedFilters.value = '';
}

/**
 * A `source: { status: 'unavailable' }` marker is not one thing.
 *
 * Every emitter the console actually reaches is `SQLBOX_NOT_AVAILABLE` — the
 * message store is down or unreachable — which is an OUTAGE, not a roadmap
 * item. Rendering it as "Planned — not yet available" told an operator that
 * Messages, Queues and Delivery Reports had never been built, at the exact
 * moment they most needed to know SQLBox was unreachable. The code is now read
 * so the outage case says so, in an alert, with the probe evidence.
 */
function detectUnavailableSource(payload: unknown) {
  if (!payload || typeof payload !== 'object') return;
  const source = (payload as RecordValue).source;
  if (source && typeof source === 'object' && (source as RecordValue).status === 'unavailable') {
    const record = source as RecordValue;
    sourceUnavailable.value = true;
    sourceCode.value = text(record.code, '');
    sourceMessage.value = text(
      record.message ?? record.detail,
      'The data source for this workspace reported itself unavailable.',
    );
  }
}

async function load(preserveNotice = false) {
  if (!workspace.value) return;
  loading.value = true;
  error.value = '';
  unavailable.value = false;
  sourceUnavailable.value = false;
  sourceMessage.value = '';
  sourceCode.value = '';
  if (!preserveNotice) notice.value = '';
  if (key.value === 'messages') {
    messageFilterError.value = '';
    messageAppliedFilters.value = '';
  }
  appliedSearch = query.value;

  try {
    if (isCursor.value) {
      await loadCursorPage();
    } else if (isDocker.value) {
      await loadContainers();
    } else if (isSystem.value) {
      await loadSettings();
    } else {
      const path =
        key.value === 'messages'
          ? `/messages?${messageParams().toString()}`
          : grid.value
            ? `${workspace.value.endpoint}?${buildGridQuery().toString()}`
            : workspace.value.endpoint;
      const payload = await apiRequest<unknown>(path);
      const page = normalize(payload);
      rows.value = page.items;
      total.value = page.total;
      detectUnavailableSource(payload);
      // Read from the payload rather than inferred: the API is the only thing
      // that knows whether what it sent was masked, and a screen that guessed
      // could tell the operator something false about a privacy control.
      privacy.value = privacyOf(payload);
      if (key.value === 'messages') captureMessageFilterEcho(payload);
    }
  } catch (reason) {
    rows.value = [];
    total.value = 0;
    cursorItems.value = [];
    containers.value = [];
    settingItems.value = [];
    unavailable.value =
      reason instanceof ApiError && (reason.status === 404 || reason.status === 501);
    const detail = reason instanceof Error ? reason.message : 'The service could not be reached.';
    // A 400 on /messages is a rejected filter, and the API names which one. Put
    // it beside the controls that caused it instead of in the generic
    // "workspace could not load" panel, which would read as an outage.
    if (key.value === 'messages' && reason instanceof ApiError && reason.status === 400) {
      messageFilterError.value = detail;
      error.value = '';
    } else if (isDlr.value && reason instanceof ApiError && reason.status === 400) {
      // A rejected filter, not an outage. The API's 400 names the offending
      // value (e.g. "deliveryStatus contains unsupported value(s): …"), so it
      // is shown verbatim beside the controls that caused it.
      dlrFilterError.value = detail;
      error.value = '';
    } else {
      error.value = detail;
    }
  } finally {
    loading.value = false;
  }
  if (key.value === 'reports') void loadDeliverySummary();
  if (key.value === 'configuration') void loadConfigDepth();
  if (key.value === 'backup') void loadBackupSchedules();
}

/** The active delivery-status tokens, as the API's comma list. */
const dlrStatusTokens = computed(() =>
  dlrGroup.value ? [dlrGroup.value] : [...dlrStatuses.value].sort(),
);
const dlrFiltered = computed(
  () =>
    Boolean(dlrStatusTokens.value.length) ||
    Boolean(dlrSmscId.value.trim()) ||
    Boolean(dlrFrom.value) ||
    Boolean(dlrTo.value) ||
    Boolean(query.value.trim()),
);
/** Caught here so an inverted range is not a round trip that returns a 400. */
const dlrRangeInverted = computed(() => {
  const from = dlrFrom.value ? Date.parse(dlrFrom.value) : NaN;
  const to = dlrTo.value ? Date.parse(dlrTo.value) : NaN;
  return Number.isFinite(from) && Number.isFinite(to) && from > to;
});

/**
 * True while the report is in OFFSET mode. A non-default sort has no `sql_id`
 * keyset, so the API pages it by offset and returns a `total` instead of a
 * cursor; the pager has to follow, not guess.
 */
const dlrOffsetMode = computed(() => Boolean(dlrSortField.value));

/**
 * ONE query builder for the grid and for the export, so an export is
 * structurally the same question as the screen rather than a promise that it
 * is. Only the paging keys and the row cap differ.
 */
function dlrParams(options: { limit?: number; withPaging?: boolean } = {}) {
  const params = new URLSearchParams();
  if (query.value.trim()) params.set('query', query.value.trim());
  if (dlrSmscId.value.trim()) params.set('smscId', dlrSmscId.value.trim());
  if (dlrStatusTokens.value.length) params.set('deliveryStatus', dlrStatusTokens.value.join(','));
  const from = dlrFrom.value ? Date.parse(dlrFrom.value) : NaN;
  const to = dlrTo.value ? Date.parse(dlrTo.value) : NaN;
  if (Number.isFinite(from)) params.set('from', new Date(from).toISOString());
  if (Number.isFinite(to)) params.set('to', new Date(to).toISOString());
  if (dlrSortField.value)
    params.set('sort', `${dlrSortDir.value === 'desc' ? '-' : ''}${dlrSortField.value}`);
  if (options.withPaging !== false) {
    if (dlrOffsetMode.value) params.set('offset', String(dlrOffset.value));
    else if (cursorCurrent.value) params.set('cursor', cursorCurrent.value);
  }
  params.set('limit', String(options.limit ?? dlrLimit.value));
  applyReveal(params);
  return params;
}

async function loadCursorPage() {
  if (isDlr.value) {
    dlrFilterError.value = '';
    if (dlrRangeInverted.value) {
      dlrFilterError.value = '“From” must not be after “To”.';
      cursorItems.value = [];
      cursorNext.value = null;
      dlrTotal.value = 0;
      return;
    }
    const payload = await apiRequest<RecordValue>(`/reports/delivery?${dlrParams().toString()}`);
    const items = Array.isArray(payload.items) ? (payload.items as RecordValue[]) : [];
    cursorItems.value = items;
    cursorNext.value = (payload.nextCursor as string | null) ?? null;
    cursorSummary.value = (payload.summary as RecordValue) ?? null;
    cursorSource.value = (payload.source as RecordValue | string) ?? null;
    // `total` is only paid for in offset mode; a keyset page deliberately has none.
    dlrTotal.value = num(payload.total ?? (payload.summary as RecordValue | null)?.total);
    detectUnavailableSource(payload);
    privacy.value = privacyOf(payload);
    return;
  }
  const params = new URLSearchParams();
  if (query.value.trim()) params.set('query', query.value.trim());
  if (cursorCurrent.value) params.set('cursor', cursorCurrent.value);
  params.set('limit', '50');
  applyReveal(params);
  const payload = await apiRequest<RecordValue>(`/queues?${params.toString()}`);
  cursorItems.value = Array.isArray(payload.items) ? (payload.items as RecordValue[]) : [];
  cursorNext.value = (payload.nextCursor as string | null) ?? null;
  cursorSummary.value = (payload.summary as RecordValue) ?? null;
  cursorSource.value = (payload.source as RecordValue | string) ?? null;
  detectUnavailableSource(payload);
  privacy.value = privacyOf(payload);
}

async function loadContainers() {
  const payload = await apiRequest<RecordValue>('/docker/containers');
  containers.value = Array.isArray(payload.items) ? (payload.items as RecordValue[]) : [];
  containersObservedAt.value = text(payload.observedAt ?? payload.observed_at, '');
  detectUnavailableSource(payload);
}

async function loadSettings() {
  const payload = await apiRequest<RecordValue>('/system/settings');
  const items = Array.isArray(payload.items) ? (payload.items as RecordValue[]) : [];
  settingItems.value = items;
  const drafts: Record<string, string> = {};
  for (const item of items) {
    const settingKey = String(item.key);
    drafts[settingKey] =
      item.is_secret || item.isSecret
        ? ''
        : text(item.value, '') === '—'
          ? ''
          : String(item.value ?? '');
  }
  settingDrafts.value = drafts;
  detectUnavailableSource(payload);
}

function resetCursor() {
  cursorCurrent.value = null;
  cursorHistory.value = [];
  cursorNext.value = null;
}

function turnCursor(direction: number) {
  if (direction > 0) {
    if (!cursorNext.value) return;
    cursorHistory.value = [...cursorHistory.value, cursorCurrent.value];
    cursorCurrent.value = cursorNext.value;
  } else {
    if (!cursorHistory.value.length) return;
    const history = [...cursorHistory.value];
    cursorCurrent.value = history.pop() ?? null;
    cursorHistory.value = history;
  }
  void load();
}

function applyGrid() {
  offset.value = 0;
  void load();
}

function toggleSortDirection() {
  sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc';
  if (sortField.value) applyGrid();
}

/**
 * The page size actually in force.
 *
 * Messages has its own Rows selector (`msgLimit`) and every other register uses
 * the shared `limit`. The pager has to step by whichever one the request used,
 * or Next would skip or repeat rows — a pager that lies about where it is.
 */
const pageSize = computed(() => (key.value === 'messages' ? msgLimit.value : limit.value));

function turnPage(direction: number) {
  const next = Math.max(0, offset.value + direction * pageSize.value);
  if (direction > 0 && offset.value + pageSize.value >= total.value) return;
  if (next === offset.value) return;
  offset.value = next;
  void load();
}

async function exportGrid(format: 'csv' | 'pdf') {
  const base = grid.value?.exportBase;
  if (!base) return;
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    const params = buildGridQuery({ limit: grid.value?.maxExportLimit ?? 500, offset: 0 });
    const exported = await apiDownloadFile(`${base}.${format}?${params.toString()}`);
    saveDownloadedFile(exported.blob, exported.filename);
    notice.value = `Exported ${exported.headers.get('x-jkannel-export-row-count') ?? 'filtered'} rows as ${format.toUpperCase()}.`;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The export failed.';
  } finally {
    loading.value = false;
  }
}

const queueColumns = [
  { label: 'ID', value: (raw: RecordValue) => text(raw.id ?? raw.message_id, '') },
  { label: 'Sender', value: (raw: RecordValue) => text(raw.sender ?? raw.from, '') },
  {
    label: 'Receiver',
    value: (raw: RecordValue) => text(raw.receiver ?? raw.recipient ?? raw.to, ''),
  },
  { label: 'SMSC', value: (raw: RecordValue) => text(raw.smsc ?? raw.smsc_id ?? raw.smscId, '') },
  { label: 'Text', value: (raw: RecordValue) => text(raw.text ?? raw.body ?? raw.msgdata, '') },
  {
    label: 'Timestamp',
    value: (raw: RecordValue) => text(raw.timestamp ?? raw.created_at ?? raw.time, ''),
  },
];

/**
 * Delivery report columns. The outcome pill is driven by `deliveryStatus` and
 * `badgeTone()` — the same treatment the message log uses — so the vocabulary
 * reads identically across the console. `dlrEvent` is shown beside it because
 * on a receipt row it carries the actual Kannel event mask.
 */
const dlrColumns: Array<{
  key: string;
  label: string;
  value: (raw: RecordValue) => string;
  /** API sort field (`SQLBOX_SORT_COLUMNS`); omitted where the API cannot sort. */
  sort?: string;
  mono?: boolean;
  badge?: boolean;
  hint?: (raw: RecordValue) => string;
}> = [
  {
    key: 'id',
    label: 'Message ID',
    sort: 'id',
    value: (raw) => text(raw.id ?? raw.message_id ?? raw.messageId, ''),
    mono: true,
    hint: (raw) => text(raw.externalRef ?? raw.foreign_id, ''),
  },
  {
    key: 'receiver',
    label: 'Recipient',
    sort: 'receiver',
    value: (raw) => text(raw.recipient ?? raw.receiver ?? raw.to, ''),
    mono: true,
  },
  {
    key: 'deliveryStatus',
    label: 'Delivery',
    sort: 'deliveryStatus',
    value: (raw) => text(raw.deliveryStatus ?? raw.delivery_status ?? raw.status ?? raw.state, ''),
    badge: true,
    hint: (raw) => dlrEventLabel(raw),
  },
  {
    key: 'smscId',
    label: 'SMSC',
    sort: 'smscId',
    value: (raw) => text(raw.smsc ?? raw.smsc_id ?? raw.smscId, ''),
    mono: true,
  },
  {
    key: 'sender',
    label: 'Sender',
    sort: 'sender',
    value: (raw) => text(raw.sender, ''),
    mono: true,
  },
  // `segments` is derived in the read model, not a sortable SQL column.
  {
    key: 'segments',
    label: 'Segments',
    value: (raw) => segmentCount(raw),
    hint: (raw) => codingLabel(raw),
  },
  {
    key: 'timestamp',
    label: 'Timestamp',
    sort: 'timestamp',
    value: (raw) => text(raw.timestamp ?? raw.created_at ?? raw.updated_at, ''),
    hint: (raw) => text(raw.dlrAt ?? raw.dlr_at, ''),
  },
];

function dlrAriaSort(field: string | undefined) {
  if (!field || dlrSortField.value !== field) return 'none';
  return dlrSortDir.value === 'asc' ? 'ascending' : 'descending';
}

const cursorSourceUnavailable = computed(() => {
  const source = cursorSource.value;
  return Boolean(
    source && typeof source === 'object' && (source as RecordValue).status === 'unavailable',
  );
});
const cursorSourceLabel = computed(() => {
  const source = cursorSource.value;
  if (!source) return 'unknown';
  if (typeof source === 'string') return source;
  return text((source as RecordValue).type ?? (source as RecordValue).status, 'unknown');
});

function detailArray(field: string): RecordValue[] {
  const value = detail.value?.[field];
  return Array.isArray(value) ? (value as RecordValue[]) : [];
}
function stringArray(field: string): string[] {
  const value = detail.value?.[field];
  return Array.isArray(value) ? (value as unknown[]).map((entry) => String(entry)) : [];
}
function prettyJson(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
function smscDotClass(raw: RecordValue) {
  const enabled = raw.enabled === true || raw.enabled === 'true';
  const life = String(raw.lifecycle_state ?? raw.lifecycleState ?? '').toLowerCase();
  if (enabled && ['active', 'reachable', 'deployed', 'validated'].includes(life)) return 'good';
  if (!enabled || ['degraded', 'archived'].includes(life)) return 'bad';
  return 'warn';
}
/**
 * Whether an SMSC row is currently enabled.
 *
 * The row-action toggle used to key off `row.status`, but `normalize()` derives
 * `status` from `status ?? state ?? lifecycle_state` and the SMSC list SELECT
 * returns neither `status` nor `state` — so `row.status` was always the
 * lifecycle state. A connection with `enabled = false` and
 * `lifecycle_state = 'active'` therefore showed "Disable" (disabling an already
 * disabled bind) and could never be re-enabled from the grid, while the
 * "Enabled" column one cell to the left correctly said "no".
 */
function smscEnabled(raw: RecordValue) {
  return !(raw.enabled === false || raw.enabled === 'false');
}
function smscHealthText(raw: RecordValue) {
  const health = raw.health;
  if (health && typeof health === 'object' && !Array.isArray(health)) {
    const record = health as RecordValue;
    const stateText = text(record.state ?? record.status, '');
    const latency = record.latency_ms ?? record.latencyMs;
    if (stateText === '—' && (latency === undefined || latency === null)) return '';
    return `${stateText}${latency !== undefined && latency !== null ? ` · ${latency} ms` : ''}`;
  }
  return '';
}
function healthDotClass(state: unknown) {
  const value = String(state ?? '').toLowerCase();
  if (['reachable', 'active', 'healthy', 'ok'].includes(value)) return 'good';
  if (['degraded', 'warning'].includes(value)) return 'warn';
  if (value === '') return 'unknown';
  return 'bad';
}
function containerDotClass(raw: RecordValue) {
  const health = String(raw.health ?? '').toLowerCase();
  if (health === 'healthy') return 'good';
  if (health === 'unreachable') return 'bad';
  if (health === 'degraded') return 'warn';
  return 'unknown';
}

async function loadRoles() {
  try {
    const payload = await apiRequest<unknown>('/users/roles');
    roleOptions.value = Array.isArray(payload)
      ? (payload as RecordValue[])
      : Array.isArray((payload as RecordValue)?.items)
        ? ((payload as RecordValue).items as RecordValue[])
        : [];
  } catch {
    roleOptions.value = [];
  }
}

async function openDetail(row: Row) {
  if (!detailModule.value) return;
  detailOpen.value = true;
  editing.value = false;
  detailLoading.value = true;
  detailError.value = '';
  detail.value = null;
  try {
    const endpoint =
      key.value === 'users'
        ? `/users/${row.id}`
        : key.value === 'smsc'
          ? `/smscs/${row.id}`
          : key.value === 'customers'
            ? `/customers/${row.id}`
            : key.value === 'plugins'
              ? `/plugins/${row.id}`
              : key.value === 'notifications'
                ? `/notifications/${row.id}`
                : key.value === 'routing'
                  ? `/routes/${row.id}`
                  : key.value === 'api-gateway'
                    ? `/api-gateway/clients/${row.id}`
                    : key.value === 'backup'
                      ? `/backup-dr/${row.id}`
                      : `/audit-events/${row.id}`;
    const record = await apiRequest<RecordValue>(endpoint);
    detail.value = record;
    // Reading a notification WRITES: `GET /notifications/:id` sets read_at.
    // The register behind the sheet would otherwise keep showing it unread
    // until something else reloaded, which is a screen disagreeing with the
    // database it just changed.
    if (key.value === 'notifications') void load(true);
    if (key.value === 'customers') {
      editCustName.value = text(record.name, '') === '—' ? '' : String(record.name ?? '');
      editCustEmail.value =
        text(record.contact_email ?? record.contactEmail, '') === '—'
          ? ''
          : String(record.contact_email ?? record.contactEmail ?? '');
      const quota = record.quota_daily ?? record.quotaDaily;
      editCustQuotaDaily.value = quota === null || quota === undefined ? null : Number(quota);
      const rate = record.rate_limit_per_min ?? record.rateLimitPerMin;
      editCustRateLimit.value = rate === null || rate === undefined ? null : Number(rate);
      const senders = record.allowed_sender_ids ?? record.allowedSenderIds;
      editCustSenderIds.value = Array.isArray(senders) ? senders.map(String).join(', ') : '';
      editCustNotes.value = text(record.notes, '') === '—' ? '' : String(record.notes ?? '');
      editCustStatus.value = text(record.status, 'active');
    }
    if (key.value === 'users') {
      editUserStatus.value = text(record.status, 'active');
      editUserRoleIds.value = Array.isArray(record.roles)
        ? (record.roles as RecordValue[]).map((role) => String(role.id))
        : [];
      editUserPassword.value = '';
      if (!roleOptions.value.length) void loadRoles();
    }
    if (key.value === 'smsc') {
      // The record as the API returned it, camelCased where the row is snake.
      // Loading the whole thing is what lets the form round-trip a field it
      // does not itself name — an unedited attribute must survive a save.
      editSmscDraft.value = {
        ...record,
        engineId: record.engine_id ?? record.engineId,
        name: text(record.name, '') === '—' ? '' : (record.name ?? ''),
        enabled: record.enabled === true || record.enabled === 'true',
        systemId: record.system_id ?? record.systemId,
        usernameSecretRef: record.username_secret_ref ?? record.usernameSecretRef,
        credentialSecretRef: record.credential_secret_ref ?? record.credentialSecretRef,
        systemType: record.system_type ?? record.systemType,
        bindMode: record.bind_mode ?? record.bindMode,
        receivePort: record.receive_port ?? record.receivePort,
        interfaceVersion: record.interface_version ?? record.interfaceVersion,
        addressRange: record.address_range ?? record.addressRange,
        sourceAddrTon: record.source_addr_ton ?? record.sourceAddrTon,
        sourceAddrNpi: record.source_addr_npi ?? record.sourceAddrNpi,
        destAddrTon: record.dest_addr_ton ?? record.destAddrTon,
        destAddrNpi: record.dest_addr_npi ?? record.destAddrNpi,
        windowSize: record.window_size ?? record.windowSize,
        keepaliveSeconds: record.keepalive_seconds ?? record.keepaliveSeconds,
        reconnectDelaySeconds: record.reconnect_delay_seconds ?? record.reconnectDelaySeconds,
        waitAckSeconds: record.wait_ack_seconds ?? record.waitAckSeconds,
        maxErrorCount: record.max_error_count ?? record.maxErrorCount,
        useTls: record.use_tls ?? record.useTls,
        altCharset: record.alt_charset ?? record.altCharset,
        sendUrl: record.send_url ?? record.sendUrl,
        connectionCount: record.connection_count ?? record.connectionCount,
        connectionTimeoutSeconds:
          record.connection_timeout_seconds ?? record.connectionTimeoutSeconds,
        waitAckExpireAction: record.wait_ack_expire_action ?? record.waitAckExpireAction,
        retryOnAuthFailure: record.retry_on_auth_failure ?? record.retryOnAuthFailure,
        allowedSmscIds: record.allowed_smsc_ids ?? record.allowedSmscIds,
        deniedSmscIds: record.denied_smsc_ids ?? record.deniedSmscIds,
        preferredSmscIds: record.preferred_smsc_ids ?? record.preferredSmscIds,
        allowedPrefixes: record.allowed_prefixes ?? record.allowedPrefixes,
        deniedPrefixes: record.denied_prefixes ?? record.deniedPrefixes,
        preferredPrefixes: record.preferred_prefixes ?? record.preferredPrefixes,
      };
    }
  } catch (reason) {
    detailError.value =
      reason instanceof Error ? reason.message : 'The record could not be loaded.';
  } finally {
    detailLoading.value = false;
  }
}
/**
 * The sheet's own heading. Previously an inline nested ternary in the template;
 * pulled out because the drawer needs three separate strings and a reader
 * should be able to see at a glance which registers open a detail sheet.
 */
const DETAIL_HEADINGS: Record<string, { eyebrow: string; title: string; subtitle: string }> = {
  users: { eyebrow: 'User', title: 'User detail', subtitle: 'Account, roles and session history' },
  smsc: {
    eyebrow: 'SMSC',
    title: 'SMSC detail',
    subtitle: 'Connection, bind state and recent transitions',
  },
  customers: {
    eyebrow: 'Customer',
    title: 'Customer detail',
    subtitle: 'Entitlements, quota and credit',
  },
  'logs-audit': {
    eyebrow: 'Audit',
    title: 'Audit event',
    subtitle: 'Who did what, and the value before and after',
  },
  plugins: {
    eyebrow: 'Plugin',
    title: 'Plugin detail',
    subtitle: 'Manifest, declared permissions and subscribed events',
  },
  notifications: {
    eyebrow: 'Notification',
    title: 'Notification',
    subtitle: 'The full notice and the payload behind it',
  },
  routing: {
    eyebrow: 'Route',
    title: 'Route detail',
    subtitle: 'Match, targets and the deployed version',
  },
  'api-gateway': {
    eyebrow: 'API client',
    title: 'API client',
    subtitle: 'Scopes, allowed routes and rate limit',
  },
  backup: {
    eyebrow: 'Backup',
    title: 'Backup',
    subtitle: 'Scope, size, checksum and where the artifact lives',
  },
};
const detailHeading = computed(
  () =>
    DETAIL_HEADINGS[key.value] ?? {
      eyebrow: 'Record',
      title: 'Detail',
      subtitle: '',
    },
);
const detailEyebrow = computed(() => detailHeading.value.eyebrow);
const detailTitle = computed(() => detailHeading.value.title);
const detailSubtitle = computed(() => detailHeading.value.subtitle);

/**
 * Whether the shell's page-action slot exists to teleport into.
 *
 * Resolved on mount rather than assumed: `Teleport` throws if its target is
 * missing, and this workspace is mounted directly (without AppShell) by every
 * unit test. Checking keeps the action rendering in both cases instead of
 * making the tests depend on the shell.
 */
const pageActionsSlot = ref(false);
onMounted(() => {
  pageActionsSlot.value = Boolean(document.getElementById('page-actions'));
});

function closeDetail() {
  detailOpen.value = false;
  detail.value = null;
  editing.value = false;
}

/**
 * Which registers open something when a row is clicked.
 *
 * `alerts` is here because the row already carries a Lifecycle link to that
 * alert's own page — the record existed and only the row-sized target for it
 * was missing. The rest of the modules on this component are action registers:
 * their rows carry Enable/Revoke/Restore controls and there is no per-record
 * endpoint behind them, so a row click has nothing honest to open and does
 * nothing rather than pretending.
 */
const clickableRow = computed(
  () =>
    detailModule.value ||
    key.value === 'messages' ||
    key.value === 'reports' ||
    key.value === 'alerts' ||
    key.value === 'configuration',
);
const messageTraceEvents = computed<RecordValue[]>(() => {
  const events = messageTrace.value?.events;
  return Array.isArray(events) ? (events as RecordValue[]) : [];
});
const snapshotRelated = computed<RecordValue[]>(() => {
  const related = snapshotDetail.value?.related;
  return Array.isArray(related) ? (related as RecordValue[]) : [];
});
const router = useRouter();
function onRowClick(row: Row) {
  if (key.value === 'messages') void openMessageTrace(row);
  else if (key.value === 'reports') void openSnapshot(row);
  else if (key.value === 'alerts') void router.push(`/alert-lifecycle?alert=${row.id}`);
  // A configuration version is immutable, so opening one loads it into the
  // composer as the starting point for the next version — which is what the
  // row's own Edit button does. `editConfiguration` reads
  // `GET /configurations/:id`, so this is the record, not a copy of the row.
  else if (key.value === 'configuration') void editConfiguration(row);
  else if (detailModule.value) void openDetail(row);
}

async function openMessageTrace(row: Row) {
  if (key.value !== 'messages') return;
  messageOpen.value = true;
  messageLoading.value = true;
  messageError.value = '';
  messageRow.value = row.raw;
  messageTrace.value = null;
  traceId.value = row.id;
  opResult.value = null;
  opError.value = '';
  showCloneForm.value = false;
  try {
    messageTrace.value = await apiRequest<RecordValue>(`/messages/${row.id}/trace`);
  } catch (reason) {
    messageError.value =
      reason instanceof Error ? reason.message : 'The message trace could not be loaded.';
  } finally {
    messageLoading.value = false;
  }
}
function closeMessageTrace() {
  messageOpen.value = false;
  messageRow.value = null;
  messageTrace.value = null;
  traceId.value = '';
  opResult.value = null;
  opError.value = '';
  showCloneForm.value = false;
}

/**
 * What a replay, clone or requeue would resubmit — read before acting.
 *
 * The trace above says what happened TO the original. This says what would go
 * out if one of the buttons below is pressed, which is a different thing: the
 * body and addressing are resolved from the stored message, and clone can
 * override them. Somebody about to re-send should see it first.
 */
const messageSource = ref<RecordValue | null>(null);
const messageSourceError = ref('');

async function loadMessageSource() {
  if (!traceId.value) return;
  messageSourceError.value = '';
  try {
    messageSource.value = await apiRequest<RecordValue>(
      `/message-ops/${encodeURIComponent(traceId.value)}`,
    );
  } catch (reason) {
    messageSource.value = null;
    messageSourceError.value =
      reason instanceof Error ? reason.message : 'The message source could not be read.';
  }
}

/** Replay / requeue the traced message via the message-ops endpoints. */
async function messageOp(operation: 'replay' | 'requeue') {
  if (!traceId.value) return;
  opBusy.value = true;
  opError.value = '';
  opResult.value = null;
  try {
    opResult.value = await apiRequest<RecordValue>(
      `/message-ops/${encodeURIComponent(traceId.value)}/${operation}`,
      { method: 'POST', body: '{}' },
    );
  } catch (reason) {
    opError.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    opBusy.value = false;
  }
}

function openCloneForm() {
  showCloneForm.value = true;
  cloneReceiver.value = '';
  cloneSender.value = '';
  cloneText.value = '';
  opResult.value = null;
  opError.value = '';
}

/** Clone the traced message, applying any provided sender/receiver/text overrides. */
async function submitClone() {
  if (!traceId.value) return;
  opBusy.value = true;
  opError.value = '';
  opResult.value = null;
  try {
    const overrides: RecordValue = {};
    if (cloneReceiver.value.trim()) overrides.receiver = cloneReceiver.value.trim();
    if (cloneSender.value.trim()) overrides.sender = cloneSender.value.trim();
    if (cloneText.value.trim()) overrides.text = cloneText.value;
    opResult.value = await apiRequest<RecordValue>(
      `/message-ops/${encodeURIComponent(traceId.value)}/clone`,
      { method: 'POST', body: JSON.stringify(overrides) },
    );
    showCloneForm.value = false;
  } catch (reason) {
    opError.value = reason instanceof Error ? reason.message : 'The clone failed.';
  } finally {
    opBusy.value = false;
  }
}

/** Loads configuration templates + drift status for the configuration workspace. */
async function loadConfigDepth() {
  configTemplatesError.value = '';
  driftError.value = '';
  try {
    const page = await apiRequest<RecordValue>('/configurations/templates?limit=100&offset=0');
    configTemplates.value = Array.isArray(page.items)
      ? (page.items as RecordValue[])
      : Array.isArray(page)
        ? (page as unknown as RecordValue[])
        : [];
  } catch (reason) {
    configTemplates.value = [];
    configTemplatesError.value =
      reason instanceof Error ? reason.message : 'Templates could not be loaded.';
  }
  try {
    driftResult.value = await apiRequest<RecordValue>('/configurations/drift');
  } catch (reason) {
    driftResult.value = null;
    driftError.value = reason instanceof Error ? reason.message : 'Drift status is unavailable.';
  }
}

async function checkDrift() {
  driftLoading.value = true;
  driftError.value = '';
  try {
    driftResult.value = await apiRequest<RecordValue>('/configurations/drift/check', {
      method: 'POST',
      body: '{}',
    });
    notice.value = 'Configuration drift check completed.';
  } catch (reason) {
    driftError.value = reason instanceof Error ? reason.message : 'The drift check failed.';
  } finally {
    driftLoading.value = false;
  }
}

async function viewTemplate(row: RecordValue) {
  templateView.value = null;
  templateViewLoading.value = true;
  instantiateResult.value = null;
  try {
    templateView.value = await apiRequest<RecordValue>(
      `/configurations/templates/${String(row.id)}`,
    );
  } catch (reason) {
    templateView.value = { ...row, __error: reason instanceof Error ? reason.message : 'error' };
  } finally {
    templateViewLoading.value = false;
  }
}
function closeTemplateView() {
  templateView.value = null;
}

async function instantiateTemplate(row: RecordValue) {
  loading.value = true;
  error.value = '';
  notice.value = '';
  instantiateResult.value = null;
  try {
    instantiateResult.value = await apiRequest<RecordValue>(
      `/configurations/templates/${String(row.id)}/instantiate`,
      { method: 'POST', body: '{}' },
    );
    notice.value = `Template “${text(row.name)}” instantiated.`;
  } catch (reason) {
    error.value =
      reason instanceof Error ? reason.message : 'The template could not be instantiated.';
  } finally {
    loading.value = false;
  }
}
function closeInstantiate() {
  instantiateResult.value = null;
}

/** Feed an instantiated template's content into the configuration create form. */
function useInstantiatedInComposer() {
  const result = instantiateResult.value;
  if (!result) return;
  configPrefillContent.value = (result.content as RecordValue) ?? null;
  configBaseline.value = {
    scope: result.name,
    description: `Instantiated from template “${text(result.name)}”. Saving creates a new immutable version.`,
    notes: text(result.note, '') === '—' ? [] : [String(result.note)],
  };
  draftName.value = text(result.name, '') === '—' ? '' : String(result.name ?? '');
  instantiateResult.value = null;
  showComposer.value = true;
  notice.value = 'Template content loaded into the create form. Review, then save it as a version.';
}

function copyText(value: string) {
  if (value && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(value);
    notice.value = 'Copied to clipboard.';
  }
}

async function openCreateCustomer() {
  showCreateCustomer.value = true;
  custName.value = '';
  custCode.value = '';
  custEmail.value = '';
  custQuotaDaily.value = null;
  custRateLimit.value = null;
  custSenderIds.value = '';
  custNotes.value = '';
  custStatus.value = 'active';
}
function senderIdList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
async function createCustomer() {
  if (!custName.value.trim()) return;
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    const senders = senderIdList(custSenderIds.value);
    await apiRequest('/customers', {
      method: 'POST',
      body: JSON.stringify({
        name: custName.value.trim(),
        ...(custCode.value.trim() ? { code: custCode.value.trim() } : {}),
        ...(custEmail.value.trim() ? { contactEmail: custEmail.value.trim() } : {}),
        ...(custQuotaDaily.value !== null ? { quotaDaily: custQuotaDaily.value } : {}),
        ...(custRateLimit.value !== null ? { rateLimitPerMin: custRateLimit.value } : {}),
        ...(senders.length ? { allowedSenderIds: senders } : {}),
        ...(custNotes.value.trim() ? { notes: custNotes.value.trim() } : {}),
        status: custStatus.value,
      }),
    });
    showCreateCustomer.value = false;
    notice.value = 'Customer created.';
    await load(true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    loading.value = false;
  }
}
async function saveCustomer() {
  if (!detail.value) return;
  const id = String(detail.value.id);
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    await apiRequest(`/customers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: editCustName.value.trim(),
        contactEmail: editCustEmail.value.trim(),
        quotaDaily: editCustQuotaDaily.value,
        rateLimitPerMin: editCustRateLimit.value,
        allowedSenderIds: senderIdList(editCustSenderIds.value),
        notes: editCustNotes.value.trim(),
        status: editCustStatus.value,
      }),
    });
    notice.value = 'Customer updated.';
    await openDetail({ id } as Row);
    await load(true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    loading.value = false;
  }
}
async function archiveCustomer() {
  if (!detail.value) return;
  const id = String(detail.value.id);
  if (!confirm(`Archive customer ${text(detail.value.name, id)}? This suspends their traffic.`))
    return;
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    await apiRequest(`/customers/${id}`, { method: 'DELETE' });
    notice.value = 'Customer archived.';
    closeDetail();
    await load(true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    loading.value = false;
  }
}

async function openCreateUser() {
  showCreateUser.value = true;
  if (!roleOptions.value.length) await loadRoles();
}
async function createUser() {
  if (!newUsername.value.trim() || newPassword.value.length < 12) return;
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    await apiRequest('/users', {
      method: 'POST',
      body: JSON.stringify({
        username: newUsername.value.trim(),
        password: newPassword.value,
        roleIds: newRoleIds.value,
      }),
    });
    showCreateUser.value = false;
    newUsername.value = '';
    newPassword.value = '';
    newRoleIds.value = [];
    notice.value = 'User created.';
    await load(true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    loading.value = false;
  }
}
async function saveUser() {
  if (!detail.value) return;
  const id = String(detail.value.id);
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    await apiRequest(`/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: editUserStatus.value,
        roleIds: editUserRoleIds.value,
        ...(editUserPassword.value ? { password: editUserPassword.value } : {}),
      }),
    });
    notice.value = 'User updated.';
    await openDetail({ id } as Row);
    await load(true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    loading.value = false;
  }
}
async function archiveUser() {
  if (!detail.value) return;
  const id = String(detail.value.id);
  if (!confirm(`Archive user ${text(detail.value.username, id)}? This revokes their access.`))
    return;
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    await apiRequest(`/users/${id}`, { method: 'DELETE' });
    notice.value = 'User archived.';
    closeDetail();
    await load(true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    loading.value = false;
  }
}

async function saveSmsc() {
  if (!detail.value) return;
  const id = String(detail.value.id);
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    await apiRequest(`/smscs/${id}`, {
      method: 'PATCH',
      // PATCH is partial, so only what the form holds is sent. `engineId` is
      // excluded deliberately: routes and reports reference it, and the update
      // handler does not accept a change to it.
      body: JSON.stringify(
        Object.fromEntries(
          Object.entries(editSmscDraft.value).filter(
            ([key, v]) =>
              !['id', 'engineId', 'engine_id', 'created_at', 'updated_at'].includes(key) &&
              !key.includes('_') &&
              v !== undefined,
          ),
        ),
      ),
    });
    notice.value = 'SMSC updated.';
    await openDetail({ id } as Row);
    await load(true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    loading.value = false;
  }
}
async function archiveSmsc() {
  if (!detail.value) return;
  const id = String(detail.value.id);
  if (
    !confirm(
      `Archive SMSC ${text(detail.value.name, id)}? Routes referencing it must be repointed first.`,
    )
  )
    return;
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    await apiRequest(`/smscs/${id}`, { method: 'DELETE' });
    notice.value = 'SMSC archived.';
    closeDetail();
    await load(true);
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 409) {
      error.value =
        reason.message ||
        'This SMSC is still referenced by one or more routes and cannot be archived.';
    } else {
      error.value = reason instanceof Error ? reason.message : 'The operation failed.';
    }
  } finally {
    loading.value = false;
  }
}

async function testSmsc(row: Row) {
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    const result = await apiRequest<RecordValue>(`/smscs/${row.id}/actions/test`, {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: '{}',
    });
    const latency = result.latency_ms ?? result.latencyMs;
    notice.value = `Test for ${row.name}: ${text(result.detail ?? result.state ?? result.status, 'completed')}${
      latency !== undefined && latency !== null ? ` (${latency} ms)` : ''
    }.`;
    await load(true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    loading.value = false;
  }
}

async function pluginAction(row: Row, operation: 'enable' | 'disable') {
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    await apiRequest(`/plugins/${row.id}/${operation}`, { method: 'POST', body: '{}' });
    notice.value = `Plugin ${row.name} ${operation}d.`;
    await load(true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    loading.value = false;
  }
}

function openBackupModal() {
  showBackupModal.value = true;
  backupLabel.value = '';
  backupScope.value = 'full';
  backupKind.value = 'full';
  backupRetention.value = 'manual';
}
async function submitBackup() {
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    await apiRequest('/backup-dr', {
      method: 'POST',
      body: JSON.stringify({
        kind: backupKind.value,
        retentionClass: backupRetention.value,
        scope: backupScope.value,
        ...(backupLabel.value.trim() ? { label: backupLabel.value.trim() } : {}),
      }),
    });
    showBackupModal.value = false;
    notice.value = 'Backup requested.';
    await load(true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    loading.value = false;
  }
}
async function verifyBackup(row: Row) {
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    // POST, not GET: the route is `@Post(':id/verify')` and re-checks the
    // artifact's checksum. Sent as a bare GET this 404'd on every click, so the
    // button reported "Request failed (404)" and never verified anything.
    const result = await apiRequest<RecordValue>(`/backup-dr/${row.id}/verify`, {
      method: 'POST',
      body: '{}',
    });
    notice.value = `Verification for ${row.name}: ${text(
      result.status ?? result.detail ?? result.state,
      'completed',
    )}.`;
    await load(true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    loading.value = false;
  }
}
function openRestore(row: Row) {
  restoreRow.value = row;
  restoreReason.value = '';
}
async function confirmRestore() {
  if (!restoreRow.value || !restoreReason.value.trim()) return;
  const target = restoreRow.value;
  if (
    !confirm(
      `Authorize restore from ${target.name}? The backup is restored into an isolated verify database, not the live system.`,
    )
  )
    return;
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    await apiRequest(`/backup-dr/${target.id}/restore`, {
      method: 'POST',
      body: JSON.stringify({ confirm: true, reason: restoreReason.value.trim() }),
    });
    notice.value = 'Restore into the isolated verify database was requested.';
    restoreRow.value = null;
    restoreReason.value = '';
    await load(true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    loading.value = false;
  }
}

async function downloadSamplePlugin() {
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    const manifest = await apiRequest<RecordValue>('/plugins/sample-manifest');
    saveDownloadedFile(
      new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
      'plugin.json',
    );
    notice.value = 'Sample plugin manifest downloaded as plugin.json.';
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The sample could not be downloaded.';
  } finally {
    loading.value = false;
  }
}

async function loadRouteSmscOptions() {
  routeSmscError.value = '';
  try {
    const page = normalize(await apiRequest<unknown>('/smscs?limit=500&offset=0'));
    routeSmscOptions.value = page.items.map((row) => ({
      value: row.id,
      label: `${row.name} (${text(row.raw.engine_id ?? row.raw.engineId)})`,
    }));
    if (!routeSmscOptions.value.length)
      routeSmscError.value = 'No SMSC connections are available to target.';
  } catch (reason) {
    routeSmscOptions.value = [];
    routeSmscError.value =
      reason instanceof Error ? reason.message : 'SMSC connections could not be loaded.';
  }
}

async function loadBaseline() {
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    const baseline = await apiRequest<RecordValue>('/configurations/baseline');
    configBaseline.value = baseline;
    configPrefillContent.value = (baseline.content as RecordValue) ?? null;
    draftName.value = text(baseline.scope, 'gateway') === '—' ? 'gateway' : String(baseline.scope);
    showComposer.value = true;
    notice.value = 'Baseline loaded into the create form. Review, then save it as a new version.';
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The baseline could not be loaded.';
  } finally {
    loading.value = false;
  }
}
async function editConfiguration(row: Row) {
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    const record = await apiRequest<RecordValue>(`/configurations/${row.id}`);
    configBaseline.value = {
      scope: record.scope,
      description: `Editing scope "${text(record.scope)}" — saving creates a new immutable version.`,
      notes: ['Configurations are immutable; saving creates a new version.'],
    };
    configPrefillContent.value = (record.content as RecordValue) ?? null;
    draftName.value = text(record.scope, '') === '—' ? '' : String(record.scope ?? '');
    showComposer.value = true;
    notice.value = 'Loaded this version into the form. Modify and save to create a new version.';
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The configuration could not load.';
  } finally {
    loading.value = false;
  }
}

async function openSnapshot(row: Row) {
  if (key.value !== 'reports') return;
  snapshotOpen.value = true;
  snapshotLoading.value = true;
  snapshotError.value = '';
  snapshotDetail.value = null;
  try {
    snapshotDetail.value = await apiRequest<RecordValue>(`/reports/volume/${row.id}`);
  } catch (reason) {
    snapshotError.value =
      reason instanceof Error ? reason.message : 'The snapshot could not be loaded.';
  } finally {
    snapshotLoading.value = false;
  }
}
function closeSnapshot() {
  snapshotOpen.value = false;
  snapshotDetail.value = null;
}

function openApiClientForm() {
  showApiClientForm.value = true;
  apiClientName.value = '';
  apiClientScopes.value = [];
}
async function createApiClient() {
  if (!apiClientName.value.trim()) return;
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    const scopes = apiClientScopes.value;
    const result = await apiRequest<RecordValue>('/api-gateway/clients', {
      method: 'POST',
      body: JSON.stringify({ name: apiClientName.value.trim(), scopes }),
    });
    revealedSecret.value = text(result.clientSecret ?? result.client_secret, '');
    revealedSecretLabel.value = apiClientName.value.trim();
    showApiClientForm.value = false;
    notice.value = 'API client created.';
    await load(true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    loading.value = false;
  }
}
async function rotateSecret(row: Row) {
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    const result = await apiRequest<RecordValue>(`/api-gateway/clients/${row.id}/rotate-secret`, {
      method: 'POST',
      body: '{}',
    });
    revealedSecret.value = text(result.clientSecret ?? result.client_secret, '');
    revealedSecretLabel.value = row.name;
    notice.value = 'API client secret rotated.';
    await load(true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    loading.value = false;
  }
}
async function revokeClient(row: Row) {
  if (!confirm(`Revoke API client ${row.name}? Applications using it will lose access.`)) return;
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    await apiRequest(`/api-gateway/clients/${row.id}`, { method: 'DELETE' });
    notice.value = 'API client revoked.';
    await load(true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    loading.value = false;
  }
}
function copySecret() {
  if (revealedSecret.value && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(revealedSecret.value);
    notice.value = 'Secret copied to clipboard.';
  }
}

async function saveSetting(item: RecordValue) {
  const settingKey = String(item.key);
  const type = String(item.type ?? 'string');
  const raw = settingDrafts.value[settingKey] ?? '';
  let value: unknown = raw;
  if (type === 'number') value = Number(raw);
  else if (type === 'boolean') value = raw === 'true' || raw === '1';
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    await apiRequest(`/system/settings/${encodeURIComponent(settingKey)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    });
    notice.value = `Setting ${settingKey} updated.`;
    await load(true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    loading.value = false;
  }
}

function downloadClientCsv(
  filename: string,
  headers: Array<{ label: string; value: (raw: RecordValue) => string }>,
  records: RecordValue[],
) {
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const lines = [headers.map((column) => escape(column.label)).join(',')];
  for (const record of records)
    lines.push(headers.map((column) => escape(column.value(record))).join(','));
  saveDownloadedFile(new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), filename);
}
function exportQueueCsv() {
  downloadClientCsv('jkannel-queues.csv', queueColumns, cursorItems.value);
  notice.value = `Exported ${cursorItems.value.length} loaded queued rows as CSV.`;
}
/** Human summary of the filter set, so the export notice can name what it carried. */
const dlrAppliedFilters = computed(() => {
  const parts: string[] = [];
  if (query.value.trim()) parts.push(`search “${query.value.trim()}”`);
  if (dlrStatusTokens.value.length) parts.push(`status ${dlrStatusTokens.value.join(', ')}`);
  if (dlrSmscId.value.trim()) parts.push(`SMSC ${dlrSmscId.value.trim()}`);
  if (dlrFrom.value) parts.push(`from ${dlrFrom.value}`);
  if (dlrTo.value) parts.push(`to ${dlrTo.value}`);
  return parts.join(' · ');
});

/**
 * The export is built from `dlrParams()` — the SAME builder the grid uses,
 * minus the cursor — so it carries every active filter rather than only the
 * two it used to. The server caps it at `SQLBOX_EXPORT_MAX_ROWS` (5000).
 */
async function exportDlrCsv() {
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    const params = dlrParams({ limit: 5000, withPaging: false });
    const exported = await apiDownloadFile(`/reports/delivery/export.csv?${params.toString()}`);
    saveDownloadedFile(exported.blob, exported.filename);
    const rows = exported.headers.get('x-jkannel-export-row-count') ?? 'filtered';
    notice.value = dlrAppliedFilters.value
      ? `Exported ${rows} delivery reports matching ${dlrAppliedFilters.value}.`
      : `Exported ${rows} delivery reports (no filters applied).`;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The export failed.';
  } finally {
    loading.value = false;
  }
}
async function exportSimple(base: string, format: 'csv' | 'pdf') {
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    const exported = await apiDownloadFile(`${base}.${format}`);
    saveDownloadedFile(exported.blob, exported.filename);
    notice.value = `Exported ${exported.headers.get('x-jkannel-export-row-count') ?? 'all'} rows as ${format.toUpperCase()}.`;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The export failed.';
  } finally {
    loading.value = false;
  }
}
/** Any change to the question invalidates both the keyset and the offset. */
function applyDlrFilter() {
  resetCursor();
  dlrOffset.value = 0;
  void load();
}
/** A group IS a set of statuses, so the two selections are mutually exclusive. */
function toggleDlrStatus(status: string) {
  dlrGroup.value = '';
  dlrStatuses.value = dlrStatuses.value.includes(status)
    ? dlrStatuses.value.filter((entry) => entry !== status)
    : [...dlrStatuses.value, status];
  applyDlrFilter();
}
function toggleDlrGroup(token: string) {
  dlrStatuses.value = [];
  dlrGroup.value = dlrGroup.value === token ? '' : token;
  applyDlrFilter();
}
function clearDlrFilters() {
  dlrStatuses.value = [];
  dlrGroup.value = '';
  dlrSmscId.value = '';
  dlrFrom.value = '';
  dlrTo.value = '';
  query.value = '';
  applyDlrFilter();
}
/**
 * Server-side sort. A third click on the same column returns to the API's own
 * ordering, which is also the only ordering the `sql_id` keyset can page —
 * so it is worth being able to get back to.
 */
function sortDlrBy(field: string) {
  if (dlrSortField.value !== field) {
    dlrSortField.value = field;
    dlrSortDir.value = 'asc';
  } else if (dlrSortDir.value === 'asc') {
    dlrSortDir.value = 'desc';
  } else {
    dlrSortField.value = '';
    dlrSortDir.value = 'desc';
  }
  applyDlrFilter();
}
/** Offset paging, used only in the mode a non-default sort puts the API into. */
function turnDlrOffsetPage(direction: number) {
  const next = Math.max(0, dlrOffset.value + direction * dlrLimit.value);
  if (direction > 0 && dlrOffset.value + dlrLimit.value >= dlrTotal.value) return;
  if (next === dlrOffset.value) return;
  dlrOffset.value = next;
  void load();
}
/** One control for both modes, so the operator never has to know which is live. */
function turnDlrPage(direction: number) {
  if (dlrOffsetMode.value) turnDlrOffsetPage(direction);
  else turnCursor(direction);
}
const dlrHasPrev = computed(() =>
  dlrOffsetMode.value ? dlrOffset.value > 0 : cursorHistory.value.length > 0,
);
const dlrHasNext = computed(() =>
  dlrOffsetMode.value
    ? dlrOffset.value + dlrLimit.value < dlrTotal.value
    : Boolean(cursorNext.value),
);
const dlrRangeLabel = computed(() => {
  if (!cursorItems.value.length) return 'No delivery reports on this page';
  if (!dlrOffsetMode.value)
    return `${cursorItems.value.length} receipt(s) · page ${cursorHistory.value.length + 1} (keyset)`;
  return `Showing ${dlrOffset.value + 1}–${dlrOffset.value + cursorItems.value.length} of ${dlrTotal.value}`;
});

async function loadDeliverySummary() {
  deliveryUnavailable.value = false;
  try {
    const report = await apiRequest<RecordValue>('/reports/delivery');
    deliverySummary.value = report;
    const source = report.source as RecordValue | undefined;
    deliveryUnavailable.value = source?.status === 'unavailable';
  } catch {
    deliverySummary.value = null;
    deliveryUnavailable.value = true;
  }
}

async function generateReports() {
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    await apiRequest('/reports/volume/run', { method: 'POST', body: '{}' });
    notice.value = 'Volume report generation completed.';
    await load(true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    loading.value = false;
  }
}

async function openSendForm() {
  showSendForm.value = true;
  smscOptionsError.value = '';
  try {
    const page = normalize(await apiRequest<unknown>('/smscs?limit=500&offset=0'));
    smscOptions.value = page.items
      .map((row) => ({
        value: text(row.raw.engine_id ?? row.raw.engineId, ''),
        label: `${row.name} (${text(row.raw.engine_id ?? row.raw.engineId)})`,
      }))
      .filter((option) => option.value);
    if (!smscOptions.value.length)
      smscOptionsError.value = 'No SMSC connections are available for message submission.';
  } catch (reason) {
    smscOptions.value = [];
    smscOptionsError.value =
      reason instanceof Error ? reason.message : 'SMSC connections could not be loaded.';
  }
}

/** Rejected in the UI before submitting; '' when the schedule is fine or unused. */
const sendScheduleError = computed(() =>
  sendLater.value && SCHEDULING_SUPPORTED ? sendScheduleValidationError(sendSchedule.value) : '',
);
/** Live segment accounting for the composed body — see SegmentCounter.vue. */
const sendSegments = computed(() => describeComposerText(sendText.value).segments);
const canSubmitSend = computed(
  () =>
    !loading.value &&
    Boolean(sendSmscId.value) &&
    Boolean(sendSender.value.trim()) &&
    Boolean(sendReceiver.value.trim()) &&
    Boolean(sendText.value.trim()) &&
    !sendScheduleError.value,
);

async function sendMessage() {
  if (!canSubmitSend.value) return;
  loading.value = true;
  error.value = '';
  try {
    const body: Record<string, unknown> = {
      sender: sendSender.value.trim(),
      receiver: sendReceiver.value.trim(),
      text: sendText.value,
      smscId: sendSmscId.value,
    };
    // Adds nothing at all when the operator expressed no preference: `priority`
    // must be ABSENT, not 0, because 0 is the lowest real SMPP level.
    Object.assign(body, priorityFields(sendPriority.value));
    // Only attached when the API can honour it — see utils/send-scheduling.ts.
    if (sendLater.value && SCHEDULING_SUPPORTED)
      Object.assign(body, scheduledSendFields(sendSchedule.value));
    await apiRequest('/messages', { method: 'POST', body: JSON.stringify(body) });
    const segments = sendSegments.value;
    showSendForm.value = false;
    sendSender.value = '';
    sendReceiver.value = '';
    sendText.value = '';
    sendSmscId.value = '';
    sendLater.value = false;
    sendSchedule.value = emptySchedule();
    sendPriority.value = PRIORITY_UNSET;
    // Say where it went: a submitted message leaves the spool immediately, so
    // "it is not in the queue" is the expected, healthy outcome.
    notice.value =
      `Message submitted for delivery (${segments} segment${segments === 1 ? '' : 's'}). ` +
      'It is already past the pending spool — track it in this message log and in Delivery Reports.';
    await load(true);
  } catch (reason) {
    // The API's 400 is surfaced verbatim; it names the field it rejected.
    error.value = reason instanceof Error ? reason.message : 'The message could not be sent.';
  } finally {
    loading.value = false;
  }
}

async function markNotificationRead(row: Row) {
  loading.value = true;
  error.value = '';
  try {
    await apiRequest(`/notifications/${row.id}/read`, { method: 'POST', body: '{}' });
    notice.value = 'Notification marked as read.';
    await load(true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    loading.value = false;
  }
}

/**
 * Acknowledge and re-notify, the two actions worth having inline on a triage
 * grid. The rest of the lifecycle — resolve, assign, suppress, reopen, close
 * and the comment thread — needs the single-alert context that the Alert
 * Lifecycle workspace provides, so this row links there rather than growing a
 * six-button cell whose legal transitions depend on the row's own state.
 */
async function acknowledgeAlert(row: Row) {
  if (!canAcknowledgeAlerts.value) return;
  const note = window.prompt(
    `Acknowledge “${row.raw.summary ?? row.name}”?\n\nOptional note recorded with the acknowledgement (it stops escalation):`,
    '',
  );
  if (note === null) return;
  loading.value = true;
  error.value = '';
  try {
    await apiRequest(`/alerts/${row.id}/acknowledgements`, {
      method: 'POST',
      body: JSON.stringify(note.trim() ? { note: note.trim() } : {}),
    });
    notice.value = 'Alert acknowledged; escalation for it stops here.';
    await load(true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The alert could not be acknowledged.';
  } finally {
    loading.value = false;
  }
}

async function notifyAlert(row: Row) {
  if (!canAcknowledgeAlerts.value) return;
  loading.value = true;
  error.value = '';
  try {
    const result = await apiRequest<{ attempts?: unknown[] }>(`/alerts/${row.id}/notifications`, {
      method: 'POST',
      body: '{}',
    });
    const attempts = Array.isArray(result.attempts) ? result.attempts.length : 0;
    notice.value = attempts
      ? `Alert re-sent to ${attempts} notification channel(s).`
      : 'No notification channels are configured, so nothing was sent.';
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The notification could not be sent.';
  } finally {
    loading.value = false;
  }
}

async function primaryAction() {
  const value = workspace.value;
  if (!value) return;
  if (key.value === 'api-gateway') {
    openApiClientForm();
    return;
  }
  if (key.value === 'backup') {
    openBackupModal();
    return;
  }
  if (key.value === 'customers') {
    await openCreateCustomer();
    return;
  }
  if (!value.actionEndpoint) {
    await load();
    return;
  }
  if (value.creatable) {
    showComposer.value = true;
    if (key.value === 'routing') void loadRouteSmscOptions();
    return;
  }

  loading.value = true;
  error.value = '';
  try {
    await apiRequest(value.actionEndpoint, { method: value.actionMethod ?? 'POST', body: '{}' });
    notice.value = `${value.action} request accepted.`;
    await load(true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    loading.value = false;
  }
}

async function createRecord() {
  const value = workspace.value;
  const name = draftName.value.trim();
  if (!value?.actionEndpoint || !name) return;

  loading.value = true;
  error.value = '';
  try {
    let payload: RecordValue = { name };

    if (value.createKind === 'smsc') {
      // Everything the operator set, and nothing they did not. An empty string
      // or null means "leave the directive out", which is not the same as
      // sending a default the engine would then render.
      const draft = Object.fromEntries(
        Object.entries(smscDraft.value).filter(
          ([, v]) => v !== '' && v !== null && v !== undefined,
        ),
      );
      payload = {
        ...draft,
        name,
        engineId:
          String(smscDraft.value.engineId ?? '').trim() ||
          name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-'),
        tps: Number(smscDraft.value.tps ?? 10),
      };
    }

    if (value.createKind === 'route') {
      if (!draftTarget.value.trim()) return;
      payload = {
        name,
        priority: 100,
        targetSmscId: draftTarget.value.trim(),
        ...(routeDestinationPrefix.value.trim()
          ? { destinationPrefix: routeDestinationPrefix.value.trim() }
          : {}),
        ...(routeSender.value.trim() ? { sender: routeSender.value.trim() } : {}),
        ...(routeFallback.value.trim() ? { fallbackSmscId: routeFallback.value.trim() } : {}),
      };
    }

    if (value.createKind === 'configuration' && configPrefillContent.value) {
      payload = {
        scope: name,
        reason: 'Saved from a baseline/edit prefill in the JKANNEL console',
        content: configPrefillContent.value,
      };
    } else if (value.createKind === 'configuration') {
      const model = {
        adminPort: configAdminPort.value,
        smsboxPort: configSmsboxPort.value,
        adminSecretRef: 'secret://kamex/admin',
        logLevel: 1,
        sqlbox: {
          enabled: configSqlbox.value,
          host: 'postgres',
          port: 5432,
          database: 'jkannel',
          usernameEnv: 'POSTGRES_USER',
          passwordEnv: 'POSTGRES_PASSWORD',
        },
        smsc: [{ id: 'development-fake', type: 'fake', enabled: true }],
      };
      const generated = await apiRequest<{ content: string; checksum: string }>(
        '/configurations/generate',
        {
          method: 'POST',
          body: JSON.stringify(model),
        },
      );
      payload = {
        scope: name,
        reason: 'Generated and validated from the JKANNEL console',
        content: { model, rendered: generated.content, renderedChecksum: generated.checksum },
      };
    }

    if (value.createKind === 'invitation') payload = { email: name };

    await apiRequest(value.actionEndpoint, {
      method: value.actionMethod ?? 'POST',
      body: JSON.stringify(payload),
    });
    showComposer.value = false;
    draftName.value = '';
    draftTarget.value = '';
    routeDestinationPrefix.value = '';
    routeSender.value = '';
    routeFallback.value = '';
    configBaseline.value = null;
    configPrefillContent.value = null;
    notice.value = `${value.noun} created.`;
    await load(true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    loading.value = false;
  }
}

/**
 * SAFE CONTROL FOR THE SMSC GRID (PLAN.md 5.1–5.3, UC-SMSC-01, UC-SMSC-02).
 *
 * Every SMSC verb now goes through the impact dialog rather than firing on
 * click. `reconnect`, `disable` and `enable` used to be one-click actions on a
 * row — a reconnect cycles every parallel connection on that SMSC and pauses
 * every route pointed at it, and nothing on the row said so.
 *
 * `suspend` and `resume` are both always offered, and neither is hidden based on
 * a guess about the current state: no read endpoint in this build exposes
 * `traffic_suspended_at`, so the console does not know which of the two applies.
 * The impact preview does, and it answers with a `blockedReason` — "Traffic on
 * this SMSC is already suspended." — which disables the confirm button. An
 * operator therefore learns the state from the dialog instead of from a button
 * that was quietly missing.
 */
const pendingSmsc = ref<{ row: Row; operation: ControlOperation } | null>(null);
const smscActionBusy = ref(false);

function requestSmscAction(row: Row, operation: ControlOperation) {
  pendingSmsc.value = { row, operation };
}

/**
 * The open record as a `Row`, so the sheet can drive the same control path the
 * register row does.
 *
 * The impact dialog is keyed on the SMSC's id and nothing else, so this carries
 * the id and the record — rather than reaching for the register row, which is
 * not guaranteed to still be loaded behind a sheet opened from a deep link.
 */
const detailRow = computed<Row>(() => ({
  id: String(detail.value?.id ?? ''),
  name: text(detail.value?.name, ''),
  detail: '',
  status: text(detail.value?.lifecycle_state ?? detail.value?.status, ''),
  updated: '',
  raw: (detail.value ?? {}) as RecordValue,
}));

async function confirmSmscAction(reason: string) {
  const pending = pendingSmsc.value;
  if (!pending) return;
  const { row, operation } = pending;
  smscActionBusy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const suspension = operation === 'suspend' || operation === 'resume';
    await apiRequest(controlEndpoint(operation, row.id), {
      method: 'POST',
      // The suspension endpoints read `{reason}` and record it. The legacy
      // action endpoint reads only the idempotency key; the reason is sent for
      // when it grows one, and the dialog already told the operator it is not
      // stored today.
      headers: suspension ? undefined : { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ reason }),
    });
    notice.value = `${operationVerb(operation)} completed for ${row.name}. Reason: ${reason}`;
    pendingSmsc.value = null;
    await load(true);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'The operation failed.';
    pendingSmsc.value = null;
  } finally {
    smscActionBusy.value = false;
  }
}

async function rowAction(row: Row, operation: string) {
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    if (key.value === 'smsc') {
      await apiRequest(`/smscs/${row.id}/actions/${operation}`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: '{}',
      });
    } else if (key.value === 'routing') {
      await apiRequest(`/routes/${row.id}/${operation}`, {
        method: 'POST',
        body: JSON.stringify({ reason: `${operation} requested from console` }),
      });
    } else if (operation === 'validate') {
      await apiRequest(`/configurations/${row.id}/validate`, {
        method: 'POST',
        body: JSON.stringify({ reason: `${operation} requested from console` }),
      });
    } else {
      await apiRequest(`/configurations/${operation}`, {
        method: 'POST',
        body: JSON.stringify({ id: row.id, reason: `${operation} requested from console` }),
      });
    }
    notice.value = `${operation} completed for ${row.name}.`;
    await load(true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    loading.value = false;
  }
}

async function compareConfigurations() {
  if (!configDiffFrom.value.trim() || !configDiffTo.value.trim()) return;
  loading.value = true;
  error.value = '';
  notice.value = '';
  configDiffResult.value = null;
  try {
    configDiffResult.value = await apiRequest<RecordValue>(
      `/configurations/diff/${configDiffFrom.value.trim()}/${configDiffTo.value.trim()}`,
    );
    notice.value = 'Configuration diff generated.';
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    loading.value = false;
  }
}

async function simulateRoute() {
  loading.value = true;
  error.value = '';
  notice.value = '';
  simulationResult.value = null;
  try {
    simulationResult.value = await apiRequest<RecordValue>('/routes/simulate', {
      method: 'POST',
      body: JSON.stringify({
        destination: simulationDestination.value,
        ...(simulationSender.value.trim() ? { sender: simulationSender.value.trim() } : {}),
      }),
    });
    notice.value = 'Route simulation completed.';
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    loading.value = false;
  }
}

async function exportMessages(format: 'csv' | 'pdf' = 'csv') {
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    // The export carries the same filter set the grid is showing.
    const params = messageParams(5000);
    const exported = await apiDownloadFile(`/messages/export.${format}?${params.toString()}`);
    saveDownloadedFile(exported.blob, exported.filename);
    notice.value = `Exported ${exported.headers.get('x-jkannel-export-row-count') ?? 'filtered'} SQLBox rows.`;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    loading.value = false;
  }
}

async function checkRetention(apply = false) {
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    const path = apply
      ? '/messages/retention/apply'
      : `/messages/retention/status?olderThanDays=${retentionDays.value}`;
    retentionStatus.value = await apiRequest<RecordValue>(
      path,
      apply
        ? {
            method: 'POST',
            body: JSON.stringify({ olderThanDays: retentionDays.value, dryRun: false }),
          }
        : {},
    );
    notice.value = apply
      ? `Retention applied; ${retentionStatus.value.deletedRows ?? 0} SQLBox rows removed.`
      : 'Retention dry-run completed.';
    await load(true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    loading.value = false;
  }
}

// --- Backup schedules & retention (GET/POST /backup-dr/schedules) -----------
async function loadBackupSchedules() {
  backupSchedulesError.value = '';
  backupSchedulesMissing.value = false;
  try {
    const payload = await apiRequest<RecordValue>('/backup-dr/schedules?limit=100&offset=0');
    backupSchedules.value = Array.isArray(payload.items)
      ? (payload.items as RecordValue[])
      : Array.isArray(payload)
        ? (payload as unknown as RecordValue[])
        : [];
  } catch (reason) {
    backupSchedules.value = [];
    backupSchedulesMissing.value =
      reason instanceof ApiError && (reason.status === 404 || reason.status === 501);
    backupSchedulesError.value =
      reason instanceof Error ? reason.message : 'Backup schedules could not be loaded.';
  }
}

function openScheduleForm() {
  showScheduleForm.value = true;
  scheduleError.value = '';
  scheduleName.value = '';
  scheduleMode.value = 'interval';
  scheduleCron.value = '0 2 * * *';
  scheduleIntervalMinutes.value = 1440;
  scheduleKind.value = 'full';
  scheduleRetention.value = 'daily';
  scheduleEnabled.value = true;
}

async function submitSchedule() {
  scheduleError.value = '';
  const name = scheduleName.value.trim();
  if (!name) {
    scheduleError.value = 'A schedule name is required.';
    return;
  }
  if (scheduleMode.value === 'cron' && !scheduleCron.value.trim()) {
    scheduleError.value = 'A cron expression is required.';
    return;
  }
  if (
    scheduleMode.value === 'interval' &&
    (!Number.isInteger(scheduleIntervalMinutes.value) || scheduleIntervalMinutes.value <= 0)
  ) {
    scheduleError.value = 'The interval must be a positive whole number of minutes.';
    return;
  }
  loading.value = true;
  notice.value = '';
  error.value = '';
  try {
    await apiRequest('/backup-dr/schedules', {
      method: 'POST',
      body: JSON.stringify({
        name,
        kind: scheduleKind.value,
        retentionClass: scheduleRetention.value,
        enabled: scheduleEnabled.value,
        ...(scheduleMode.value === 'cron'
          ? { cron: scheduleCron.value.trim() }
          : { intervalMinutes: scheduleIntervalMinutes.value }),
      }),
    });
    showScheduleForm.value = false;
    notice.value = `Backup schedule “${name}” created.`;
    await loadBackupSchedules();
  } catch (reason) {
    scheduleError.value =
      reason instanceof Error ? reason.message : 'The backup schedule could not be created.';
  } finally {
    loading.value = false;
  }
}

async function applyBackupRetention() {
  if (
    !confirm(
      'Apply retention now?\n\nEvery backup older than its retention class window is expired and its artifact removed. This cannot be undone.',
    )
  )
    return;
  loading.value = true;
  error.value = '';
  notice.value = '';
  retentionSweep.value = null;
  try {
    const result = await apiRequest<unknown>('/backup-dr/retention/apply', {
      method: 'POST',
      body: '{}',
    });
    const summary = Array.isArray(result) ? (result as RecordValue[]) : [];
    retentionSweep.value = summary;
    const removed = summary.reduce((total, entry) => total + Number(entry.removed ?? 0), 0);
    notice.value = `Retention applied; ${removed} backup(s) expired.`;
    await load(true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'Retention could not be applied.';
  } finally {
    loading.value = false;
  }
}

/**
 * Live refresh for the surfaces where a stale number actively misleads: the
 * alert list, SMSC connection health, and the engine monitoring row. Everything
 * else stays manual — polling a grid an operator is editing is worse than
 * stale. The composable owns the timer, overlap and hidden-tab guards; the
 * pause guard here keeps a poll from reloading rows underneath an open drawer
 * or dialog.
 */
const LIVE_MODULES = ['alerts', 'smsc', 'monitoring'];
const isLiveModule = computed(() => LIVE_MODULES.includes(key.value));
const liveChoices = [10, 30, 60, 300];
const {
  autoRefresh: liveAuto,
  intervalSeconds: liveInterval,
  refreshing: liveRefreshing,
  lastRefreshedAt: liveLastRefreshed,
  refreshNow: liveRefreshNow,
} = useLiveResource(() => load(true), {
  intervalSeconds: 30,
  enabled: false,
  immediate: false,
  pauseWhen: () =>
    loading.value ||
    detailOpen.value ||
    messageOpen.value ||
    snapshotOpen.value ||
    showComposer.value ||
    showBackupModal.value ||
    restoreRow.value !== null,
});

watch(query, (value) => {
  // Only debounce-and-reload where the term is a server parameter; elsewhere
  // `visibleRows` filters what is already loaded and no request is needed.
  if (!serverSideSearch.value) return;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (value === appliedSearch) return;
    offset.value = 0;
    resetCursor();
    void load();
  }, 300);
});

watch(
  key,
  () => {
    if (searchTimer) clearTimeout(searchTimer);
    query.value = '';
    appliedSearch = '';
    state.value = 'All';
    showComposer.value = false;
    showSendForm.value = false;
    showCreateUser.value = false;
    showApiClientForm.value = false;
    showCreateCustomer.value = false;
    showBackupModal.value = false;
    detailOpen.value = false;
    detail.value = null;
    editing.value = false;
    messageOpen.value = false;
    messageRow.value = null;
    messageTrace.value = null;
    traceId.value = '';
    opResult.value = null;
    opError.value = '';
    showCloneForm.value = false;
    snapshotOpen.value = false;
    snapshotDetail.value = null;
    dlrOpen.value = false;
    dlrRecord.value = null;
    configBaseline.value = null;
    configPrefillContent.value = null;
    configTemplates.value = [];
    configTemplatesError.value = '';
    templateView.value = null;
    instantiateResult.value = null;
    driftResult.value = null;
    driftError.value = '';
    routeSmscOptions.value = [];
    routeSmscError.value = '';
    revealedSecret.value = '';
    restoreRow.value = null;
    restoreReason.value = '';
    dlrSmscId.value = '';
    dlrStatuses.value = [];
    dlrGroup.value = '';
    dlrFrom.value = '';
    dlrTo.value = '';
    dlrLimit.value = 50;
    dlrSortField.value = '';
    dlrSortDir.value = 'desc';
    dlrOffset.value = 0;
    dlrTotal.value = 0;
    dlrFilterError.value = '';
    deliverySummary.value = null;
    deliveryUnavailable.value = false;
    sourceUnavailable.value = false;
    sourceMessage.value = '';
    sourceCode.value = '';
    resetCursor();
    gridFilters.value = {};
    const defaultSort = workspace.value?.grid?.defaultSort ?? '';
    sortField.value = defaultSort.replace(/^-/, '');
    sortDirection.value = defaultSort.startsWith('-') ? 'desc' : 'asc';
    limit.value = 50;
    offset.value = 0;
    total.value = 0;
    msgStatus.value = '';
    msgDirection.value = '';
    msgSmscId.value = '';
    msgFrom.value = '';
    msgTo.value = '';
    backupSchedules.value = [];
    backupSchedulesError.value = '';
    showScheduleForm.value = false;
    retentionSweep.value = null;
    // Only the live modules poll; everything else stays on manual refresh.
    liveAuto.value = isLiveModule.value;
    // The Target SMSC filter is a select over these, so they have to be there
    // before the operator opens it — not only once the route composer is used.
    if (key.value === 'routing') void loadRouteSmscOptions();
    void load();
  },
  { immediate: true },
);

onUnmounted(() => {
  if (searchTimer) clearTimeout(searchTimer);
});
</script>

<template>
  <section v-if="workspace" :aria-busy="loading" data-testid="module-workspace">
    <!--
      COUNTRY SCOPE CHIPS, as `SmscsScreen.jsx` has above its register.

      A gateway's connections group by market before they group by anything
      else — "is Uganda healthy" is the question an operator asks first, and
      answering it from a flat list of forty binds means reading forty rows.
      Each chip carries the count and, when any are down, how many, so the
      answer is legible before anything is clicked.

      Derived from the rows already on screen: `carrier_country` is on every
      SMSC row the grid returns, so this counts what is loaded rather than
      asking the server for a second, possibly disagreeing, summary.
    -->
    <section
      v-if="key === 'smsc' && countryChips.length"
      class="grid-toolbar country-chips"
      data-testid="smsc-country-chips"
      aria-label="Filter by country"
    >
      <button
        v-for="chip in countryChips"
        :key="chip.country"
        class="chip"
        :class="{ 'chip-active': countryFilter === chip.country }"
        type="button"
        :aria-pressed="countryFilter === chip.country"
        :data-testid="`smsc-country-${chip.country}`"
        @click="countryFilter = countryFilter === chip.country ? '' : chip.country"
      >
        <strong>{{ chip.code }}</strong>
        <template v-if="chip.label">{{ chip.label }}</template>
        <span :class="{ 'chip-warn': chip.down > 0 }">
          {{ chip.total }} SMSC{{ chip.total === 1 ? '' : 's'
          }}<template v-if="chip.down"> · {{ chip.down }} not connected</template>
        </span>
      </button>
    </section>

    <section class="toolbar panel" :class="{ 'grid-toolbar': Boolean(grid) }">
      <label v-if="searchIsLive" class="filter-search">
        <span class="sr-only">Search {{ workspace.noun }} records</span>
        <input v-model="query" :placeholder="workspace.search" data-testid="workspace-search" />
      </label>
      <label v-if="grid" class="filter-select">
        <span>Sort</span>
        <select v-model="sortField" data-testid="grid-sort" @change="applyGrid">
          <option value="">Default</option>
          <option v-for="field in grid.sortFields" :key="field" :value="field">{{ field }}</option>
        </select>
      </label>
      <button
        v-if="grid"
        class="secondary-button sort-direction"
        data-testid="grid-sort-direction"
        :disabled="loading || !sortField"
        :aria-label="`Sort ${sortDirection === 'asc' ? 'ascending' : 'descending'}`"
        @click="toggleSortDirection"
      >
        {{ sortDirection === 'asc' ? 'Asc ↑' : 'Desc ↓' }}
      </button>
      <!--
        Only offered where it is wired to something: `visibleRows` is what
        applies it, and the custom-render workspaces (queues, delivery reports,
        docker, system) render their own tables straight from their own state
        and never consult it. Delivery Reports has its own real status chips,
        and Messages has a real server-side "Delivery status" select — this
        client-side one filtered the coarse legacy status against a completely
        different vocabulary, so two Status controls disagreed on one screen.
      -->
      <label v-if="!grid && !customRender && key !== 'messages'" class="filter-select">
        <span>Status</span>
        <select v-model="state" data-testid="status-filter">
          <option v-for="option in states" :key="option">{{ option }}</option>
        </select>
      </label>
      <!--
        Teleported to the page-actions slot beside the page title, which is
        where the design system puts a register's primary action (AppShell.jsx
        `PageAction`). Fusing "Add SMSC" to the toolbar of the table it adds to
        reads as a filter control; beside the heading it reads as the thing the
        page is for.

        Rendered in place as a fallback when the slot is absent — a view mounted
        outside AppShell, which is how the unit tests mount this workspace, must
        still show its action rather than silently losing it.
      -->
      <Teleport v-if="pageActionsSlot" to="#page-actions">
        <button
          class="primary-button"
          data-testid="primary-action"
          :disabled="loading"
          @click="primaryAction"
        >
          {{ loading ? 'Working…' : workspace.action }}
        </button>
      </Teleport>
      <button
        v-else
        class="primary-button"
        data-testid="primary-action"
        :disabled="loading"
        @click="primaryAction"
      >
        {{ loading ? 'Working…' : workspace.action }}
      </button>
      <button
        v-if="key === 'reports' && canGenerateReports"
        class="secondary-button"
        data-testid="generate-reports"
        :disabled="loading"
        @click="generateReports"
      >
        Generate now
      </button>
      <button
        v-if="key === 'messages'"
        class="secondary-button"
        data-testid="open-send-message"
        :disabled="loading"
        @click="openSendForm"
      >
        Send message
      </button>
      <button
        v-if="key === 'configuration'"
        class="secondary-button"
        data-testid="load-baseline"
        :disabled="loading"
        @click="loadBaseline"
      >
        Load baseline
      </button>
      <button
        v-if="key === 'plugins'"
        class="secondary-button"
        data-testid="download-sample-plugin"
        :disabled="loading"
        @click="downloadSamplePlugin"
      >
        Download sample plugin
      </button>
      <template v-if="grid?.exportBase">
        <button
          class="secondary-button"
          data-testid="export-csv"
          :disabled="loading"
          @click="exportGrid('csv')"
        >
          Export CSV
        </button>
        <button
          class="secondary-button"
          data-testid="export-pdf"
          :disabled="loading"
          @click="exportGrid('pdf')"
        >
          Export PDF
        </button>
      </template>
      <template v-if="key === 'messages'">
        <button
          class="secondary-button"
          data-testid="export-messages"
          :disabled="loading"
          @click="exportMessages('csv')"
        >
          Export CSV
        </button>
        <button
          class="secondary-button"
          data-testid="export-messages-pdf"
          :disabled="loading"
          @click="exportMessages('pdf')"
        >
          Export PDF
        </button>
      </template>
      <button
        v-if="key === 'users' && canManageUsers"
        class="secondary-button"
        data-testid="create-user"
        :disabled="loading"
        @click="openCreateUser"
      >
        Create user
      </button>
      <template v-if="key === 'backup'">
        <button
          class="secondary-button"
          data-testid="export-backup-csv"
          :disabled="loading"
          @click="exportSimple('/backup-dr/export', 'csv')"
        >
          Export CSV
        </button>
        <!--
          No PDF button: `/backup-dr/export.pdf` does not exist — the controller
          defines `export.csv` only. (`/backups/export.pdf` on the legacy catalog
          controller is a different resource this console never reads.) Stating
          the gap the way the Reports page does beats a button that 404s.
        -->
        <small class="source-note" data-testid="export-backup-csv-only"
          >CSV only — the API has no PDF route for the backup catalog.</small
        >
      </template>
      <template v-if="key === 'api-gateway'">
        <button
          class="secondary-button"
          data-testid="export-api-csv"
          :disabled="loading"
          @click="exportSimple('/api-gateway/clients/export', 'csv')"
        >
          Export CSV
        </button>
        <button
          class="secondary-button"
          data-testid="export-api-pdf"
          :disabled="loading"
          @click="exportSimple('/api-gateway/clients/export', 'pdf')"
        >
          Export PDF
        </button>
      </template>
      <div v-if="grid?.filters.length" class="grid-filters">
        <label v-for="field in grid.filters" :key="field.field" class="filter-select">
          <span>{{ field.label }}</span>
          <select
            v-if="field.options"
            v-model="gridFilters[field.field]"
            :data-testid="`grid-filter-${field.field}`"
            @change="applyGrid"
          >
            <option value="">All</option>
            <option v-for="option in field.options" :key="option" :value="option">
              {{ option }}
            </option>
          </select>
          <select
            v-else-if="field.choices === 'routeSmsc'"
            v-model="gridFilters[field.field]"
            :data-testid="`grid-filter-${field.field}`"
            @change="applyGrid"
          >
            <option value="">All</option>
            <option v-for="option in routeSmscOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
          <input
            v-else
            v-model="gridFilters[field.field]"
            :data-testid="`grid-filter-${field.field}`"
            :placeholder="field.label"
            @change="applyGrid"
            @keyup.enter="applyGrid"
          />
        </label>
      </div>
    </section>

    <!-- Live refresh (alerts / SMSC / monitoring) ------------------------------ -->
    <section
      v-if="isLiveModule"
      class="toolbar panel grid-toolbar"
      aria-label="Live refresh controls"
      data-testid="live-controls"
    >
      <label class="filter-select">
        <span>Auto refresh</span>
        <select v-model="liveAuto" data-testid="live-auto-toggle">
          <option :value="true">On</option>
          <option :value="false">Off</option>
        </select>
      </label>
      <label class="filter-select">
        <span>Every</span>
        <select v-model.number="liveInterval" data-testid="live-interval">
          <option v-for="choice in liveChoices" :key="choice" :value="choice">{{ choice }}s</option>
        </select>
      </label>
      <button
        class="secondary-button"
        data-testid="live-refresh"
        :disabled="liveRefreshing || loading"
        @click="liveRefreshNow(true)"
      >
        {{ liveRefreshing ? 'Refreshing…' : 'Refresh now' }}
      </button>
      <span class="source-note" data-testid="live-last-refreshed">
        {{
          liveLastRefreshed
            ? `Last updated ${liveLastRefreshed}`
            : 'Showing the snapshot loaded when this workspace opened.'
        }}{{ liveAuto ? '' : ' — auto refresh is off' }}
      </span>
    </section>

    <!-- Message search (G13) ---------------------------------------------------- -->
    <section
      v-if="key === 'messages'"
      class="toolbar panel grid-toolbar"
      aria-label="Message search filters"
      data-testid="message-filters"
    >
      <label class="filter-select">
        <span>Delivery status</span>
        <select v-model="msgStatus" data-testid="message-status" @change="applyMessageFilters">
          <option
            v-for="choice in MESSAGE_STATUS_CHOICES"
            :key="choice.value"
            :value="choice.value"
          >
            {{ choice.label }}
          </option>
        </select>
      </label>
      <label class="filter-select">
        <span>Direction</span>
        <select
          v-model="msgDirection"
          data-testid="message-direction"
          @change="applyMessageFilters"
        >
          <option value="">Any</option>
          <option value="MT">MT (outbound)</option>
          <option value="MO">MO (inbound)</option>
          <option value="DLR">DLR (receipt)</option>
        </select>
      </label>
      <label class="filter-select">
        <span>SMSC</span>
        <input
          v-model="msgSmscId"
          data-testid="message-smsc"
          type="text"
          placeholder="Engine SMSC id"
          @keyup.enter="applyMessageFilters"
        />
      </label>
      <label class="filter-select">
        <span>From</span>
        <input v-model="msgFrom" data-testid="message-from" type="datetime-local" />
      </label>
      <label class="filter-select">
        <span>To</span>
        <input v-model="msgTo" data-testid="message-to" type="datetime-local" />
      </label>
      <label class="filter-select">
        <span>Rows</span>
        <select v-model.number="msgLimit" data-testid="message-limit" @change="applyMessageFilters">
          <option :value="50">50</option>
          <option :value="100">100</option>
          <option :value="250">250</option>
          <option :value="500">500</option>
        </select>
      </label>
      <button class="secondary-button" data-testid="message-apply" @click="applyMessageFilters">
        Apply filters
      </button>
      <span class="source-note" data-testid="message-filter-scope">
        Delivery status, direction, SMSC, the date range and the free-text search are all applied by
        the message store, and the CSV/PDF exports use the identical filter set — an export always
        matches what is on screen.
      </span>
      <p
        v-if="messageRangeInverted"
        class="form-error"
        role="alert"
        data-testid="message-range-error"
      >
        The “From” date is after the “To” date, so this range matches nothing. Swap them before
        searching.
      </p>
      <p
        v-else-if="messageFilterError"
        class="form-error"
        role="alert"
        data-testid="message-filter-error"
      >
        {{ messageFilterError }}
      </p>
      <p
        v-else-if="messageAppliedFilters"
        class="source-note"
        data-testid="message-applied-filters"
      >
        Applied by the message store: <span class="mono">{{ messageAppliedFilters }}</span>
      </p>
      <p v-else-if="messageDateFiltered" class="source-note" data-testid="message-date-note">
        The date range is inclusive and is evaluated over the whole message store, not just the
        {{ rows.length }} row(s) loaded here.
      </p>
    </section>

    <p v-if="notice" class="notice" role="status" data-testid="operation-success">{{ notice }}</p>

    <section v-if="error" class="panel empty-state" role="alert" data-testid="api-state">
      <h2>{{ unavailable ? 'Workspace API not available yet' : 'Unable to load workspace' }}</h2>
      <p>{{ error }}</p>
      <p v-if="unavailable">
        Expected endpoint: <code>GET {{ workspace.endpoint }}</code>
      </p>
      <button class="secondary-button" :disabled="loading" @click="load()">Retry</button>
    </section>

    <section
      v-if="sourceUnavailable"
      class="panel help-box"
      :role="sourceIsOutage ? 'alert' : 'status'"
      data-testid="source-unavailable"
    >
      <template v-if="sourceIsOutage">
        <h2>Message store unreachable</h2>
        <p>
          The SQLBox message store is not answering, so this workspace has no data to show. This is
          an outage, not a missing feature — the rows exist, the console cannot read them right now.
        </p>
        <p class="mono" data-testid="source-unavailable-evidence">{{ sourceMessage }}</p>
        <p>
          Check the SQLBox container on
          <RouterLink class="text-link" to="/docker">Runtime Containers</RouterLink>, then retry.
        </p>
        <button class="secondary-button" :disabled="loading" @click="load()">Retry</button>
      </template>
      <template v-else>
        <h2>Data source unavailable</h2>
        <p>{{ sourceMessage }}</p>
      </template>
    </section>

    <!--
      Rendered above the grid, not below it: an operator has to know the values
      are masked BEFORE reading them, not after they have copied one out.
    -->
    <PrivacyReveal
      :privacy="privacy"
      :can-reveal="canReveal"
      testid="workspace-privacy"
      @changed="onRevealChanged"
    />

    <section v-if="revealedSecret" class="panel secret-box" role="alert" data-testid="secret-box">
      <h2>Save this secret now</h2>
      <p class="secret-warning">
        The client secret for “{{ revealedSecretLabel }}” is shown only once and cannot be retrieved
        again.
      </p>
      <div class="secret-value">
        <code data-testid="secret-value">{{ revealedSecret }}</code>
        <button class="secondary-button" data-testid="secret-copy" @click="copySecret">Copy</button>
      </div>
      <button class="secondary-button" data-testid="secret-dismiss" @click="revealedSecret = ''">
        Dismiss
      </button>
    </section>

    <!--
      The design system puts this above Engine Configuration, and it is the
      framing the whole screen depends on: what is rendered here is generated
      from the operational objects, so editing it is not how anything changes.
      The ownership table below says where to go instead.
    -->
    <p
      v-if="key === 'configuration' && !error"
      class="stale-banner"
      data-testid="configuration-readonly-banner"
    >
      Engineering diagnostics. This is the configuration the gateway generated from your operational
      objects — read-only on purpose. Change the object, not the file.
    </p>

    <section
      v-if="key === 'configuration' && !error"
      class="panel help-box"
      data-testid="configuration-help"
    >
      <h2>How to fill in a configuration</h2>
      <p>
        A configuration renders the Kamex engine files JKANNEL deploys. The <strong>scope</strong>
        decides which part of the estate a version applies to.
      </p>
      <ul>
        <li>
          <code>gateway</code> — the whole engine (bearerbox + smsbox); use for global settings.
        </li>
        <li>
          <code>smsc:&lt;engine-id&gt;</code> — an override scoped to a single SMSC connection.
        </li>
        <li>
          <strong>Admin port</strong> (default <code>13000</code>) — the Kannel admin/status
          interface.
        </li>
        <li>
          <strong>Bearerbox/SMSBox port</strong> (default <code>13001</code>) — the sendsms/smsbox
          interface.
        </li>
        <li>
          <strong>SQLBox</strong> toggle — store and forward through PostgreSQL SQLBox for auditing
          and retention.
        </li>
      </ul>
      <p>Secrets are referenced by environment variables only; plaintext is never stored.</p>
    </section>

    <section v-if="key === 'plugins' && !error" class="panel help-box" data-testid="plugins-help">
      <h2>How plugins work</h2>
      <p>
        Plugins run out-of-process with least-privilege permissions and only receive the events they
        declare.
      </p>
      <!--
        This list previously promised Install and Uninstall as if they were
        controls on this screen. `POST /plugins/install` exists but nothing in
        the console calls it, and uninstall has no route at all — the plugins
        controller defines no DELETE. Enable and disable are the only actions
        this screen can perform, so that is what it now claims.
      -->
      <ul>
        <li>
          <strong>Enable</strong> to start receiving events; <strong>disable</strong> to pause it.
          These are the two actions available on this screen.
        </li>
        <li>Each plugin is limited to the permissions and events listed below.</li>
        <li>
          <strong>Installing</strong> a signed bundle is an API operation (<code
            >POST /plugins/install</code
          >, which validates the manifest); there is no upload control here yet.
          <strong>Uninstalling</strong> has no API at all — removing a plugin is an operator task on
          the host.
        </li>
      </ul>
    </section>

    <section v-if="key === 'backup' && !error" class="panel help-box" data-testid="backup-help">
      <h2>Backup &amp; restore</h2>
      <p>
        The disaster-recovery job produces binary backup artifacts.
        <strong>Create backup</strong> opens a dialog where you name the backup and pick its
        <strong>scope</strong>.
      </p>
      <ul>
        <li><strong>Database</strong> — the PostgreSQL data store (messages, config, audit).</li>
        <li><strong>Configurations</strong> — rendered engine configuration versions.</li>
        <li>Application code is not backed up here: it lives in version control.</li>
        <li>Recovery time objective (RTO): under 1 hour; RPO: under 15 minutes.</li>
        <li><strong>Verify</strong> checks a backup's checksum before you rely on it.</li>
        <li>
          <strong>Restore</strong> requires a reason and restores into an isolated verify database —
          never the live system inline.
        </li>
      </ul>
    </section>

    <!-- Backup schedules & retention ------------------------------------------ -->
    <section
      v-if="key === 'backup' && !error"
      class="panel"
      data-testid="backup-schedules"
      aria-label="Backup schedules and retention"
    >
      <header class="panel-header">
        <div>
          <h2>Schedules &amp; retention</h2>
          <p aria-live="polite">{{ backupSchedules.length }} schedule(s) defined</p>
        </div>
        <div class="detail-actions">
          <button
            v-if="canManageSystem"
            class="secondary-button"
            data-testid="schedule-new"
            :disabled="loading"
            @click="openScheduleForm"
          >
            New schedule
          </button>
          <button
            v-if="canManageSystem"
            class="secondary-button danger-button"
            data-testid="retention-apply"
            :disabled="loading"
            @click="applyBackupRetention"
          >
            Apply retention now
          </button>
        </div>
      </header>
      <p v-if="!canManageSystem" class="source-note">
        Creating schedules and running the retention sweep requires the system.manage permission.
      </p>

      <ModalDialog
        :open="showScheduleForm"
        title="New backup schedule"
        testid="schedule-form"
        wide
        @close="showScheduleForm = false"
      >
        <label class="filter-select filter-search">
          <span>Name</span>
          <input v-model="scheduleName" data-testid="schedule-name" placeholder="Nightly full" />
        </label>
        <label class="filter-select">
          <span>Trigger</span>
          <select v-model="scheduleMode" data-testid="schedule-mode">
            <option value="interval">Every N minutes</option>
            <option value="cron">Cron expression</option>
          </select>
        </label>
        <label v-if="scheduleMode === 'interval'" class="filter-select">
          <span>Interval (minutes)</span>
          <input
            v-model.number="scheduleIntervalMinutes"
            data-testid="schedule-interval"
            type="number"
            min="1"
          />
        </label>
        <label v-else class="filter-select">
          <span>Cron</span>
          <input v-model="scheduleCron" data-testid="schedule-cron" placeholder="0 2 * * *" />
        </label>
        <label class="filter-select">
          <span>Kind</span>
          <select v-model="scheduleKind" data-testid="schedule-kind">
            <option v-for="kind in BACKUP_KINDS" :key="kind" :value="kind">{{ kind }}</option>
          </select>
        </label>
        <label class="filter-select">
          <span>Retention class</span>
          <select v-model="scheduleRetention" data-testid="schedule-retention">
            <option v-for="cls in RETENTION_CLASSES" :key="cls" :value="cls">{{ cls }}</option>
          </select>
        </label>
        <label class="filter-select">
          <span>Enabled</span>
          <select v-model="scheduleEnabled" data-testid="schedule-enabled">
            <option :value="true">Yes</option>
            <option :value="false">No</option>
          </select>
        </label>
        <p v-if="scheduleError" class="form-error" role="alert" data-testid="schedule-error">
          {{ scheduleError }}
        </p>
        <template #footer>
          <button
            class="secondary-button"
            data-testid="schedule-cancel"
            @click="showScheduleForm = false"
          >
            Cancel
          </button>
          <button
            class="primary-button"
            data-testid="schedule-submit"
            :disabled="loading"
            @click="submitSchedule"
          >
            Create schedule
          </button>
        </template>
      </ModalDialog>

      <p
        v-if="backupSchedulesError"
        class="chart-empty"
        role="alert"
        data-testid="schedule-load-error"
      >
        {{
          backupSchedulesMissing
            ? 'The backup schedule API is not available in this deployment.'
            : backupSchedulesError
        }}
      </p>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Schedule</th>
              <th scope="col">Trigger</th>
              <th scope="col">Kind</th>
              <th scope="col">Retention</th>
              <th scope="col">Enabled</th>
              <th scope="col">Last run</th>
              <th scope="col">Next run</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in backupSchedules"
              :key="text(row.id)"
              :data-testid="`schedule-row-${text(row.id)}`"
            >
              <td>
                <strong>{{ text(row.name) }}</strong>
                <small class="row-id mono">{{ text(row.id) }}</small>
              </td>
              <td class="mono">
                {{
                  row.cron
                    ? String(row.cron)
                    : (row.interval_minutes ?? row.intervalMinutes)
                      ? `every ${text(row.interval_minutes ?? row.intervalMinutes)} min`
                      : '—'
                }}
              </td>
              <td>{{ text(row.kind) }}</td>
              <td>{{ text(row.retention_class ?? row.retentionClass) }}</td>
              <td>
                <span class="status-badge" :class="row.enabled === false ? '' : 'good'">
                  {{ row.enabled === false ? 'disabled' : 'enabled' }}
                </span>
              </td>
              <td>{{ text(row.last_run_at ?? row.lastRunAt) }}</td>
              <td>{{ text(row.next_run_at ?? row.nextRunAt) }}</td>
            </tr>
            <tr v-if="!backupSchedules.length">
              <td colspan="7" class="empty-cell" data-testid="schedule-empty">
                No backup schedules are defined — backups only happen when somebody clicks Create
                backup.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <ul v-if="retentionSweep" class="sample-list" data-testid="retention-sweep">
        <li v-for="entry in retentionSweep" :key="text(entry.retentionClass)">
          <span class="mono">{{ text(entry.retentionClass) }}</span>
          <span>{{ text(entry.removed, '0') }} expired</span>
        </li>
      </ul>
      <p class="source-note">
        Retention windows are fixed per class in the backup service (hourly through yearly);
        <code>manual</code> backups are never expired. Verified backups show a “Verified” timestamp
        in the grid above once <strong>Verify</strong> has re-checked their checksum.
      </p>
    </section>

    <section
      v-if="key === 'customers' && !error"
      class="panel help-box"
      data-testid="customers-help"
    >
      <h2>What is a customer?</h2>
      <p>
        A customer is an organization or account that consumes messaging on the platform. Each
        customer owns the routes, sender IDs, and quotas that govern its traffic.
      </p>
      <ul>
        <li><strong>Code</strong> — a short unique identifier used in routing and billing.</li>
        <li><strong>Daily quota</strong> — the maximum messages the customer may send per day.</li>
        <li><strong>Rate limit / min</strong> — the per-minute submission ceiling.</li>
        <li>
          <strong>Allowed sender IDs</strong> — the sender strings this customer is permitted to
          use.
        </li>
        <li><strong>Status</strong> — active, suspended, or archived.</li>
      </ul>
    </section>

    <section
      v-if="key === 'api-gateway' && !error"
      class="panel help-box"
      data-testid="api-gateway-docs"
    >
      <h2>Using the JKANNEL API</h2>
      <p>
        API clients let external systems call the platform programmatically. Create a client, then
        authenticate every request with its key.
      </p>
      <ul>
        <li>
          <strong>Create a client</strong> with the button above and grant only the scopes it needs.
        </li>
        <li>
          The <strong>client secret is shown exactly once</strong> at creation (and on rotate). Copy
          it immediately — it cannot be retrieved again.
        </li>
        <!--
          This used to say "send the key as a bearer token". It is not a bearer
          token: ApiKeyAuthGuard reads X-API-Key, or an Authorization header
          whose scheme is literally `ApiKey`. Sent as `Bearer`, the key is
          treated as a JWT and rejected, which is a genuinely baffling 401.
        -->
        <li>
          <strong>Authenticate</strong> with the key in its own header:
          <code>X-API-Key: &lt;client-key&gt;</code> — or
          <code>Authorization: ApiKey &lt;client-key&gt;</code> — against
          <code>{{ apiBaseUrl }}/gateway</code>. It is not a bearer token; sending it as
          <code>Bearer</code> fails authentication.
        </li>
        <li>
          <!--
            The four real scopes, named. This used to read "for example
            messages.send, reports.read" — neither of which the gateway
            enforces, so anyone who copied the example minted a key that
            authenticated and was then refused on every business route.
          -->
          <strong>Scopes</strong> restrict what each client may do. There are exactly four:
          <code>sms.send</code>, <code>sms.read</code>, <code>routing.read</code> and
          <code>audit.read</code>. They are deliberately <em>not</em> console permission codes, so a
          value like <code>messages.view</code> here grants nothing.
        </li>
        <li>
          <strong>Rate limits</strong> are enforced per client per minute; exceeding them returns
          <code>429</code>.
        </li>
        <li>
          The full reference — every route, the permission it needs, and its parameters — is on the
          <RouterLink class="text-link" to="/api-reference">API Reference</RouterLink> screen, which
          renders the live <code>{{ openApiUrl }}</code> document (OpenAPI 3.1).
        </li>
      </ul>
    </section>

    <section
      v-if="key === 'plugins' && !error"
      class="panel help-box"
      data-testid="plugins-developer"
    >
      <h2>Plugin developer portal</h2>
      <p>
        Use <strong>Download sample plugin</strong> above to get a working
        <code>plugin.json</code> manifest to start from. A plugin is a signed bundle with a manifest
        and a small handler.
      </p>
      <ul>
        <li>
          <strong>Manifest fields</strong>: <code>pluginId</code>, <code>name</code>,
          <code>version</code> (semver), <code>publisher</code>, <code>permissions</code> (what it
          may read), and <code>events</code> (what it subscribes to).
        </li>
        <li>
          <strong>Lifecycle</strong>: install → validate → enable → disable. Enabling starts event
          delivery; disabling pauses it without removing the plugin. Install runs over the API only
          (<code>POST /plugins/install</code>), and there is no uninstall endpoint today.
        </li>
        <li>
          <strong>Permission &amp; event model</strong>: plugins run out-of-process with
          least-privilege and only receive the events they declare — nothing else.
        </li>
        <li>
          <strong>Build &amp; package</strong>: implement the handler, fill in the manifest, then
          zip the bundle and sign it before uploading for validation.
        </li>
      </ul>
    </section>

    <ModalDialog
      :open="showCreateUser"
      title="Create user"
      testid="create-user-form"
      @close="showCreateUser = false"
    >
      <label>
        Username
        <input v-model="newUsername" data-testid="new-username" />
      </label>
      <label>
        Password (min 12 characters)
        <input v-model="newPassword" type="password" data-testid="new-password" />
      </label>
      <p v-if="newPassword && newPassword.length < 12" class="form-hint">
        Password must be at least 12 characters.
      </p>
      <fieldset class="role-checkboxes" data-testid="new-roles">
        <legend>Roles</legend>
        <label
          v-for="role in roleOptions"
          :key="String(role.id)"
          class="role-option"
          :data-testid="`new-role-${role.id}`"
        >
          <input v-model="newRoleIds" type="checkbox" :value="String(role.id)" />
          <span class="role-text">
            <strong>{{ text(role.name) }}</strong>
            <small>{{ text(role.description) }}</small>
          </span>
        </label>
        <p v-if="!roleOptions.length" class="form-hint">No roles are available to assign.</p>
      </fieldset>
      <template #footer>
        <button class="secondary-button" @click="showCreateUser = false">Cancel</button>
        <button
          class="primary-button"
          data-testid="create-user-submit"
          :disabled="loading || !newUsername.trim() || newPassword.length < 12"
          @click="createUser"
        >
          Create user
        </button>
      </template>
    </ModalDialog>

    <ModalDialog
      :open="showApiClientForm"
      title="Create API client"
      testid="api-client-form"
      @close="showApiClientForm = false"
    >
      <label>
        Name
        <input v-model="apiClientName" data-testid="api-client-name" />
      </label>
      <ScopePicker v-model="apiClientScopes" />
      <template #footer>
        <button class="secondary-button" @click="showApiClientForm = false">Cancel</button>
        <button
          class="primary-button"
          data-testid="api-client-submit"
          :disabled="loading || !apiClientName.trim()"
          @click="createApiClient"
        >
          Create client
        </button>
      </template>
    </ModalDialog>

    <ModalDialog
      :open="Boolean(restoreRow)"
      :title="restoreRow ? `Restore from ${restoreRow.name}` : ''"
      testid="restore-form"
      @close="restoreRow = null"
    >
      <p class="form-hint">
        The backup is restored into an isolated verify database, not the live system. Provide a
        reason for the audit trail.
      </p>
      <label>
        Reason
        <input v-model="restoreReason" data-testid="restore-reason" />
      </label>
      <template #footer>
        <button class="secondary-button" @click="restoreRow = null">Cancel</button>
        <button
          class="primary-button danger-button"
          data-testid="restore-submit"
          :disabled="loading || !restoreReason.trim()"
          @click="confirmRestore"
        >
          Request restore
        </button>
      </template>
    </ModalDialog>

    <ModalDialog
      :open="showBackupModal"
      title="Create backup"
      testid="backup-modal"
      @close="showBackupModal = false"
    >
      <label>
        Backup name (label)
        <input
          v-model="backupLabel"
          data-testid="backup-label"
          placeholder="e.g. pre-upgrade snapshot"
        />
      </label>
      <label class="filter-select">
        <span>Kind</span>
        <select v-model="backupKind" data-testid="backup-kind">
          <option v-for="kind in BACKUP_KINDS" :key="kind" :value="kind">{{ kind }}</option>
        </select>
      </label>
      <label class="filter-select">
        <span>Retention class</span>
        <select v-model="backupRetention" data-testid="backup-retention">
          <option v-for="cls in RETENTION_CLASSES" :key="cls" :value="cls">{{ cls }}</option>
        </select>
      </label>
      <p class="form-hint">
        The retention class decides how long the backup survives the retention sweep;
        <code>manual</code> is never expired automatically.
      </p>
      <fieldset class="scope-fieldset">
        <legend>Scope</legend>
        <label class="checkbox-row">
          <input
            v-model="backupScope"
            type="radio"
            value="full"
            name="backup-scope"
            data-testid="backup-scope-full"
          />
          Full (database + configurations)
        </label>
        <label class="checkbox-row">
          <input
            v-model="backupScope"
            type="radio"
            value="database"
            name="backup-scope"
            data-testid="backup-scope-database"
          />
          Database only
        </label>
        <label class="checkbox-row">
          <input
            v-model="backupScope"
            type="radio"
            value="configurations"
            name="backup-scope"
            data-testid="backup-scope-configurations"
          />
          Configurations only
        </label>
      </fieldset>
      <p class="form-hint">Application code is not included — it lives in version control.</p>
      <template #footer>
        <button class="secondary-button" @click="showBackupModal = false">Cancel</button>
        <button
          class="primary-button"
          data-testid="backup-submit"
          :disabled="loading"
          @click="submitBackup"
        >
          Create backup
        </button>
      </template>
    </ModalDialog>

    <ModalDialog
      :open="showCreateCustomer"
      title="Create customer"
      testid="create-customer-form"
      wide
      @close="showCreateCustomer = false"
    >
      <div class="dialog-grid">
        <label>
          Name
          <input v-model="custName" data-testid="customer-name" />
        </label>
        <label>
          Code
          <input v-model="custCode" data-testid="customer-code" placeholder="Optional short code" />
        </label>
        <label>
          Contact email
          <input v-model="custEmail" type="email" data-testid="customer-email" />
        </label>
        <label>
          Daily quota
          <input
            v-model.number="custQuotaDaily"
            type="number"
            min="0"
            data-testid="customer-quota"
          />
        </label>
        <label>
          Rate limit / min
          <input v-model.number="custRateLimit" type="number" min="0" data-testid="customer-rate" />
        </label>
        <label class="dialog-span">
          Allowed sender IDs (comma-separated)
          <input
            v-model="custSenderIds"
            data-testid="customer-senders"
            placeholder="JKANNEL, INFO"
          />
        </label>
        <label class="dialog-span">
          Notes
          <input v-model="custNotes" data-testid="customer-notes" />
        </label>
        <label>
          Status
          <select v-model="custStatus" data-testid="customer-status">
            <option value="active">active</option>
            <option value="suspended">suspended</option>
            <option value="archived">archived</option>
          </select>
        </label>
      </div>
      <template #footer>
        <button class="secondary-button" @click="showCreateCustomer = false">Cancel</button>
        <button
          class="primary-button"
          data-testid="customer-submit"
          :disabled="loading || !custName.trim()"
          @click="createCustomer"
        >
          Create customer
        </button>
      </template>
    </ModalDialog>

    <!--
      A MESSAGE OPENED FROM THE REGISTER IS A DRAWER, NOT A PANEL BELOW IT.

      This was a `.detail-panel` that appeared underneath the message list, so
      clicking a row scrolled the list away and the operator lost the row they
      came from. The design system opens a record from a register in a sheet
      precisely so the list stays behind it — see `DetailDrawer.vue`.

      `wide`, because the trace holds an events list and a JSON block of what
      would be re-sent, which are unreadable at the 50vw default.
    -->
    <DetailDrawer
      :open="messageOpen"
      title="Message trace"
      eyebrow="Message"
      :subtitle="messageRow ? text(messageRow.id ?? messageRow.messageId) : undefined"
      wide
      @close="closeMessageTrace"
    >
      <div data-testid="message-trace-panel">
        <p v-if="messageLoading" class="form-hint" data-testid="message-trace-loading">Loading…</p>
        <p v-else-if="messageError" class="form-error" role="alert">{{ messageError }}</p>
        <template v-else>
          <dl v-if="messageRow" class="detail-grid">
            <dt>Message ID</dt>
            <dd class="mono">{{ text(messageRow.id ?? messageRow.messageId) }}</dd>
            <dt>Direction</dt>
            <dd>{{ text(messageRow.direction) }}</dd>
            <dt>Status</dt>
            <dd>{{ text(messageRow.status ?? messageRow.state) }}</dd>
            <dt>Sender</dt>
            <dd>{{ text(messageRow.sender ?? messageRow.from) }}</dd>
            <dt>Receiver</dt>
            <dd>{{ text(messageRow.receiver ?? messageRow.recipient ?? messageRow.to) }}</dd>
            <dt>SMSC</dt>
            <dd>{{ text(messageRow.smsc ?? messageRow.smsc_id ?? messageRow.smscId) }}</dd>
            <dt>Created</dt>
            <dd>
              {{ text(messageRow.created_at ?? messageRow.createdAt ?? messageRow.timestamp) }}
            </dd>
            <dt>Updated</dt>
            <dd>{{ text(messageRow.updated_at ?? messageRow.updatedAt) }}</dd>
            <!--
            Encoding / segmentation / scheduling / billing. These columns have
            always existed in the engine's store but were invisible in the
            console, so "why did one SMS bill as three?" had no answer here.
          -->
            <dt>Segments</dt>
            <dd data-testid="message-segments">{{ segmentCount(messageRow) }}</dd>
            <dt>Encoding</dt>
            <dd data-testid="message-encoding">{{ codingLabel(messageRow) }}</dd>
            <dt>UDH</dt>
            <dd class="mono">{{ text(messageRow.udhData) }}</dd>
            <dt>Validity</dt>
            <dd>{{ text(messageRow.validity) }}</dd>
            <dt>Deferred</dt>
            <dd>{{ text(messageRow.deferred) }}</dd>
            <dt>Message class</dt>
            <dd>{{ text(messageRow.mclass) }}</dd>
            <dt>PID</dt>
            <dd>{{ text(messageRow.pid) }}</dd>
            <dt>Billing info</dt>
            <dd class="mono">{{ text(messageRow.binfo) }}</dd>
            <dt>Metadata</dt>
            <dd class="mono">{{ text(messageRow.metaData) }}</dd>
          </dl>
          <p v-if="messageTrace?.summary" class="form-hint" data-testid="message-trace-summary">
            {{ prettyJson(messageTrace.summary) }}
          </p>
          <h3>Trace events</h3>
          <ul class="sample-list" data-testid="message-trace-events">
            <li v-for="(event, index) in messageTraceEvents" :key="index">
              <span class="dot" :class="healthDotClass(event.status ?? event.state)"></span>
              {{ text(event.type ?? event.event ?? event.status ?? event.state) }} —
              {{ text(event.detail ?? event.description ?? event.message) }}
              <small>{{
                text(event.at ?? event.timestamp ?? event.created_at ?? event.observed_at)
              }}</small>
            </li>
            <li v-if="!messageTraceEvents.length">No trace events recorded for this message.</li>
          </ul>

          <template v-if="canManageConfig">
            <h3>Message operations</h3>
            <p class="form-hint">
              Re-submit this message through the engine. Each action creates a new, independently
              traceable message.
            </p>

            <!--
            What a replay would actually put on the wire, before it does.
            Clone lets fields be overridden and requeue does not, so an operator
            about to press either needs to see the body and the addressing they
            are re-sending — not the trace of what happened to the original.
          -->
            <div class="detail-actions">
              <button
                class="secondary-button"
                type="button"
                data-testid="message-source"
                :disabled="opBusy"
                @click="loadMessageSource"
              >
                {{ messageSource ? 'Refresh what would be sent' : 'Show what would be sent' }}
              </button>
            </div>
            <pre v-if="messageSource" class="json-block" data-testid="message-source-json">{{
              JSON.stringify(messageSource, null, 2)
            }}</pre>
            <p v-if="messageSourceError" class="form-error" role="alert">
              {{ messageSourceError }}
            </p>

            <div class="detail-actions" data-testid="message-ops">
              <button
                class="secondary-button"
                data-testid="message-replay"
                :disabled="opBusy"
                @click="messageOp('replay')"
              >
                Replay
              </button>
              <button
                class="secondary-button"
                data-testid="message-clone"
                :disabled="opBusy"
                @click="openCloneForm"
              >
                Clone…
              </button>
              <button
                class="secondary-button"
                data-testid="message-requeue"
                :disabled="opBusy"
                @click="messageOp('requeue')"
              >
                Requeue
              </button>
            </div>
            <div v-if="showCloneForm" class="composer" data-testid="message-clone-form">
              <p class="form-hint">Leave a field blank to keep the original value.</p>
              <label>
                Sender override
                <input
                  v-model="cloneSender"
                  data-testid="clone-sender"
                  placeholder="Original sender"
                />
              </label>
              <label>
                Recipient override
                <input
                  v-model="cloneReceiver"
                  data-testid="clone-receiver"
                  placeholder="Original recipient"
                />
              </label>
              <label>
                Message text override
                <input v-model="cloneText" data-testid="clone-text" placeholder="Original text" />
              </label>
              <div>
                <button
                  class="primary-button"
                  data-testid="clone-submit"
                  :disabled="opBusy"
                  @click="submitClone"
                >
                  Submit clone
                </button>
                <button class="secondary-button" @click="showCloneForm = false">Cancel</button>
              </div>
            </div>
            <p v-if="opError" class="form-error" role="alert" data-testid="message-op-error">
              {{ opError }}
            </p>
            <div v-if="opResult" class="baseline-info" data-testid="message-op-result">
              <p class="form-hint">
                {{ text(opResult.action, 'operation') }} accepted — new SQLBox id
                <strong>{{
                  text(
                    (opResult.queued as RecordValue | undefined)?.sqlId ??
                      (opResult.queued as RecordValue | undefined)?.sql_id,
                  )
                }}</strong>
                (foreign id {{ text(opResult.foreignId) }}).
              </p>
            </div>
          </template>
        </template>
      </div>
    </DetailDrawer>

    <DetailDrawer
      :open="snapshotOpen"
      title="Volume snapshot detail"
      eyebrow="Snapshot"
      wide
      @close="closeSnapshot"
    >
      <div data-testid="snapshot-panel">
        <p v-if="snapshotLoading" class="form-hint" data-testid="snapshot-loading">Loading…</p>
        <p v-else-if="snapshotError" class="form-error" role="alert">{{ snapshotError }}</p>
        <template v-else-if="snapshotDetail">
          <h3>Snapshot</h3>
          <pre class="json-block" data-testid="snapshot-summary">{{
            prettyJson(snapshotDetail.snapshot)
          }}</pre>
          <h3>Related breakdown</h3>
          <ul class="sample-list" data-testid="snapshot-related">
            <li v-for="(item, index) in snapshotRelated" :key="index">
              {{ text(item.scope ?? item.label ?? item.smsc ?? item.route ?? item.type) }} —
              {{
                text(item.message_count ?? item.messageCount ?? item.messages ?? item.total, '0')
              }}
              messages
              <small>{{ text(item.dlr_count ?? item.dlrCount ?? item.dlrs, '') }}</small>
            </li>
            <li v-if="!snapshotRelated.length">No related breakdown for this period.</li>
          </ul>
        </template>
      </div>
    </DetailDrawer>

    <!--
      Record detail as a SHEET, not a panel appended after the register.

      Appending it meant the detail for row 40 of a 50-row grid rendered below
      row 50 — off-screen, with the row you clicked scrolled away, so clicking
      appeared to do nothing. The design system's answer is a right-hand sheet:
      the list stays exactly where it was behind the scrim, so you keep your
      place in it, and the detail opens where you are looking.
    -->
    <DetailDrawer
      :open="detailOpen"
      :eyebrow="detailEyebrow"
      :title="detailTitle"
      :subtitle="detailSubtitle"
      @close="closeDetail"
    >
      <div class="detail-panel" data-testid="detail-panel">
        <p v-if="detailLoading" class="form-hint" data-testid="detail-loading">Loading…</p>
        <p v-else-if="detailError" class="form-error" role="alert">{{ detailError }}</p>
        <template v-else-if="detail">
          <template v-if="key === 'users'">
            <dl class="detail-grid">
              <dt>Username</dt>
              <dd>{{ text(detail.username) }}</dd>
              <dt>Status</dt>
              <dd data-testid="user-detail-status">{{ text(detail.status) }}</dd>
              <dt>Roles</dt>
              <dd>
                <span class="chip-list">
                  <span v-for="role in detailArray('roles')" :key="String(role.id)" class="chip">{{
                    text(role.name)
                  }}</span>
                  <span v-if="!detailArray('roles').length">—</span>
                </span>
              </dd>
              <dt>Permissions</dt>
              <dd>
                <span class="chip-list">
                  <span
                    v-for="permission in stringArray('permissions')"
                    :key="permission"
                    class="chip muted"
                    >{{ permission }}</span
                  >
                  <span v-if="!stringArray('permissions').length">—</span>
                </span>
              </dd>
              <dt>Created</dt>
              <dd>{{ text(detail.created_at ?? detail.createdAt) }}</dd>
            </dl>
            <div v-if="canManageUsers && !editing" class="detail-actions">
              <button class="secondary-button" data-testid="detail-edit" @click="editing = true">
                Edit
              </button>
              <button
                class="secondary-button danger-button"
                data-testid="user-archive"
                @click="archiveUser"
              >
                Archive
              </button>
            </div>
            <div v-if="canManageUsers && editing" class="composer" data-testid="user-edit-form">
              <label>
                Status
                <select v-model="editUserStatus" data-testid="user-status">
                  <option value="active">active</option>
                  <option value="disabled">disabled</option>
                  <option value="locked">locked</option>
                  <option value="archived">archived</option>
                </select>
              </label>
              <fieldset class="role-checkboxes" data-testid="user-roles">
                <legend>Roles</legend>
                <label
                  v-for="role in roleOptions"
                  :key="String(role.id)"
                  class="role-option"
                  :data-testid="`user-role-${role.id}`"
                >
                  <input v-model="editUserRoleIds" type="checkbox" :value="String(role.id)" />
                  <span class="role-text">
                    <strong>{{ text(role.name) }}</strong>
                    <small>{{ text(role.description) }}</small>
                  </span>
                </label>
                <p v-if="!roleOptions.length" class="form-hint">
                  No roles are available to assign.
                </p>
              </fieldset>
              <label>
                Reset password (optional, min 12)
                <input
                  v-model="editUserPassword"
                  type="password"
                  data-testid="user-reset-password"
                />
              </label>
              <div>
                <button
                  class="primary-button"
                  data-testid="user-save"
                  :disabled="loading"
                  @click="saveUser"
                >
                  Save changes
                </button>
                <button class="secondary-button" @click="editing = false">Cancel</button>
              </div>
            </div>
          </template>

          <template v-else-if="key === 'smsc'">
            <dl class="detail-grid">
              <dt>Name</dt>
              <dd>{{ text(detail.name) }}</dd>
              <dt>Host</dt>
              <dd>{{ text(detail.host) }}</dd>
              <dt>Port</dt>
              <dd>{{ text(detail.port) }}</dd>
              <dt>TPS</dt>
              <dd>{{ text(detail.tps) }}</dd>
              <dt>Enabled</dt>
              <dd>{{ text(detail.enabled) }}</dd>
              <dt>Lifecycle</dt>
              <dd>{{ text(detail.lifecycle_state ?? detail.lifecycleState) }}</dd>
            </dl>
            <h3>Recent health</h3>
            <ul class="sample-list" data-testid="smsc-health">
              <li v-for="(sample, index) in detailArray('health')" :key="index">
                <span class="dot" :class="healthDotClass(sample.state)"></span>
                {{ text(sample.state) }} — {{ text(sample.detail) }}
                <small
                  >{{ text(sample.latency_ms ?? sample.latencyMs) }} ms ·
                  {{ text(sample.observed_at ?? sample.observedAt) }}</small
                >
              </li>
              <li v-if="!detailArray('health').length">No health samples recorded.</li>
            </ul>
            <h3>Recent operations</h3>
            <ul class="sample-list" data-testid="smsc-deployments">
              <li v-for="(op, index) in detailArray('deployments')" :key="index">
                {{ text(op.operation) }} — {{ text(op.status) }}: {{ text(op.detail) }}
                <small>{{ text(op.created_at ?? op.createdAt) }}</small>
              </li>
              <li v-if="!detailArray('deployments').length">No recent operations.</li>
            </ul>
            <div v-if="canManageSystem && !editing" class="detail-actions">
              <button class="secondary-button" data-testid="smsc-edit" @click="editing = true">
                Edit
              </button>
              <!-- Moved here from the register row. Each one goes through the
                   impact dialog, which is already on this record. -->
              <button
                class="secondary-button"
                :data-testid="`smsc-detail-toggle`"
                @click="requestSmscAction(detailRow, smscEnabled(detail) ? 'disable' : 'enable')"
              >
                {{ smscEnabled(detail) ? 'Disable' : 'Enable' }}
              </button>
              <button
                class="secondary-button"
                data-testid="smsc-detail-suspend"
                @click="requestSmscAction(detailRow, 'suspend')"
              >
                Suspend traffic
              </button>
              <button
                class="secondary-button"
                data-testid="smsc-detail-resume"
                @click="requestSmscAction(detailRow, 'resume')"
              >
                Resume traffic
              </button>
              <button
                class="secondary-button danger-button"
                data-testid="smsc-archive"
                @click="archiveSmsc"
              >
                Delete / Archive
              </button>
            </div>
            <div v-if="canManageSystem && editing" data-testid="smsc-edit-form">
              <SmscConfigForm v-model="editSmscDraft" mode="edit" testid="smsc-edit" />
              <div class="detail-actions">
                <button
                  class="primary-button"
                  data-testid="smsc-save"
                  :disabled="loading"
                  @click="saveSmsc"
                >
                  Save changes
                </button>
                <button class="secondary-button" @click="editing = false">Cancel</button>
              </div>
            </div>
          </template>

          <template v-else-if="key === 'customers'">
            <dl class="detail-grid">
              <dt>Name</dt>
              <dd>{{ text(detail.name) }}</dd>
              <dt>Code</dt>
              <dd>{{ text(detail.code) }}</dd>
              <dt>Status</dt>
              <dd data-testid="customer-detail-status">{{ text(detail.status) }}</dd>
              <dt>Contact</dt>
              <dd>{{ text(detail.contact_email ?? detail.contactEmail) }}</dd>
              <dt>Daily quota</dt>
              <dd>{{ text(detail.quota_daily ?? detail.quotaDaily) }}</dd>
              <dt>Rate limit / min</dt>
              <dd>{{ text(detail.rate_limit_per_min ?? detail.rateLimitPerMin) }}</dd>
              <dt>Sender IDs</dt>
              <dd>{{ list(detail.allowed_sender_ids ?? detail.allowedSenderIds) }}</dd>
              <dt>Notes</dt>
              <dd>{{ text(detail.notes) }}</dd>
              <dt>Created</dt>
              <dd>{{ text(detail.created_at ?? detail.createdAt) }}</dd>
            </dl>
            <!--
              The record above is what a customer IS. Quota, credit, sender IDs
              and route bindings are what an operator DOES to one, and they have
              their own screen — fifteen endpoints' worth, which is more than a
              drawer should try to hold.
            -->
            <div class="detail-actions">
              <RouterLink
                class="primary-button"
                data-testid="customer-open-account"
                :to="`/customers/${text(detail.id, '')}`"
              >
                Quota, credit and sender IDs
              </RouterLink>
              <template v-if="canManageSystem && !editing">
                <button
                  class="secondary-button"
                  data-testid="customer-edit"
                  @click="editing = true"
                >
                  Edit
                </button>
                <button
                  class="secondary-button danger-button"
                  data-testid="customer-archive"
                  @click="archiveCustomer"
                >
                  Archive
                </button>
              </template>
            </div>
            <div
              v-if="canManageSystem && editing"
              class="composer"
              data-testid="customer-edit-form"
            >
              <label>
                Name
                <input v-model="editCustName" data-testid="customer-edit-name" />
              </label>
              <label>
                Contact email
                <input v-model="editCustEmail" type="email" data-testid="customer-edit-email" />
              </label>
              <label>
                Daily quota
                <input
                  v-model.number="editCustQuotaDaily"
                  type="number"
                  min="0"
                  data-testid="customer-edit-quota"
                />
              </label>
              <label>
                Rate limit / min
                <input
                  v-model.number="editCustRateLimit"
                  type="number"
                  min="0"
                  data-testid="customer-edit-rate"
                />
              </label>
              <label>
                Allowed sender IDs (comma-separated)
                <input v-model="editCustSenderIds" data-testid="customer-edit-senders" />
              </label>
              <label>
                Notes
                <input v-model="editCustNotes" data-testid="customer-edit-notes" />
              </label>
              <label>
                Status
                <select v-model="editCustStatus" data-testid="customer-edit-status">
                  <option value="active">active</option>
                  <option value="suspended">suspended</option>
                  <option value="archived">archived</option>
                </select>
              </label>
              <div>
                <button
                  class="primary-button"
                  data-testid="customer-save"
                  :disabled="loading"
                  @click="saveCustomer"
                >
                  Save changes
                </button>
                <button class="secondary-button" @click="editing = false">Cancel</button>
              </div>
            </div>
          </template>

          <template v-else-if="key === 'routing'">
            <dl class="detail-grid">
              <dt>Name</dt>
              <dd data-testid="route-detail-name">{{ text(detail.name) }}</dd>
              <dt>Priority</dt>
              <dd class="mono">{{ text(detail.priority) }}</dd>
              <dt>Enabled</dt>
              <dd>{{ text(detail.enabled) }}</dd>
              <dt>Destination prefix</dt>
              <dd class="mono">
                {{ text(detail.destination_prefix ?? detail.destinationPrefix) }}
              </dd>
              <dt>Sender</dt>
              <dd class="mono">{{ text(detail.sender) }}</dd>
              <dt>Target SMSC</dt>
              <dd class="mono" data-testid="route-detail-target">
                {{ text(detail.target_smsc_id ?? detail.targetSmscId ?? detail.smsc_id) }}
              </dd>
              <dt>Fallback SMSC</dt>
              <dd class="mono">
                {{ text(detail.fallback_smsc_id ?? detail.fallbackSmscId) }}
              </dd>
              <dt>Updated</dt>
              <dd>{{ text(detail.updated_at ?? detail.updatedAt) }}</dd>
            </dl>
            <!--
              The whole stored definition, raw. A route carries optional shapes
              this build's grid does not name — weighted target lists, time
              windows, cost fields — and a fixed field list here would silently
              drop whichever of them a given route happens to use, which on a
              routing table is the difference between reading the rule and
              guessing at it.
            -->
            <h3>Stored definition</h3>
            <pre class="json-block" data-testid="route-detail-json">{{ prettyJson(detail) }}</pre>
            <p class="source-note">
              From <span class="mono">GET /routes/{{ text(detail.id, '') }}</span
              >, which nothing in the console was calling. Validate, deploy and rollback stay on the
              row: they act on the route without needing it open.
            </p>
          </template>

          <template v-else-if="key === 'plugins'">
            <dl class="detail-grid">
              <dt>Plugin</dt>
              <dd class="mono" data-testid="plugin-detail-id">{{ text(detail.plugin_id) }}</dd>
              <dt>Name</dt>
              <dd>{{ text(detail.name) }}</dd>
              <dt>Version</dt>
              <dd class="mono">{{ text(detail.version) }}</dd>
              <dt>Publisher</dt>
              <dd>{{ text(detail.publisher) }}</dd>
              <dt>Status</dt>
              <dd data-testid="plugin-detail-status">{{ text(detail.status) }}</dd>
              <dt>Installed by</dt>
              <dd class="mono">{{ text(detail.installed_by ?? detail.installedBy) }}</dd>
              <dt>Installed</dt>
              <dd>{{ text(detail.installed_at ?? detail.installedAt) }}</dd>
              <dt>Detail</dt>
              <dd>{{ text(detail.detail) }}</dd>
            </dl>
            <!--
              Permissions and events are the whole reason to open a plugin: a
              plugin receives ONLY the events it declares and holds ONLY the
              permissions it declares, so this is the list that says what it can
              reach. It was in the API and on no screen.
            -->
            <h3>Declared permissions</h3>
            <span class="chip-list" data-testid="plugin-detail-permissions">
              <span v-for="code in stringArray('permissions')" :key="code" class="chip mono">{{
                code
              }}</span>
              <span v-if="!stringArray('permissions').length" class="chip muted"
                >none declared</span
              >
            </span>
            <h3>Subscribed events</h3>
            <span class="chip-list" data-testid="plugin-detail-events">
              <span v-for="name in stringArray('events')" :key="name" class="chip mono">{{
                name
              }}</span>
              <span v-if="!stringArray('events').length" class="chip muted">none declared</span>
            </span>
            <p class="source-note">
              Straight from <span class="mono">GET /plugins/{{ text(detail.id, '') }}</span
              >. There is no uninstall endpoint in this build, so a plugin can be disabled here but
              not removed.
            </p>
          </template>

          <template v-else-if="key === 'api-gateway'">
            <dl class="detail-grid">
              <dt>Name</dt>
              <dd data-testid="client-detail-name">{{ text(detail.name) }}</dd>
              <dt>Client key</dt>
              <dd class="mono">{{ text(detail.client_key ?? detail.clientKey) }}</dd>
              <dt>Status</dt>
              <dd>{{ text(detail.status) }}</dd>
              <dt>Rate limit</dt>
              <dd class="mono">
                {{ text(detail.rate_limit_per_min ?? detail.rateLimitPerMin) }} / min
              </dd>
              <dt>Last used</dt>
              <dd>{{ text(detail.last_used_at ?? detail.lastUsedAt, 'never') }}</dd>
              <dt>Created</dt>
              <dd>{{ text(detail.created_at ?? detail.createdAt) }}</dd>
            </dl>
            <!-- The reason to open a client at all: what it is permitted to do,
                 which is the question somebody asks before revoking it. -->
            <h3>Scopes</h3>
            <span class="chip-list" data-testid="client-detail-scopes">
              <span v-for="scope in stringArray('scopes')" :key="scope" class="chip mono">{{
                scope
              }}</span>
              <span v-if="!stringArray('scopes').length" class="chip muted">none granted</span>
            </span>
            <h3>Allowed routes</h3>
            <span class="chip-list" data-testid="client-detail-routes">
              <span v-for="route in stringArray('allowed_routes')" :key="route" class="chip mono">{{
                route
              }}</span>
              <span v-if="!stringArray('allowed_routes').length" class="chip muted">
                unrestricted — every route this client's scopes permit
              </span>
            </span>
            <p class="source-note">
              The secret is not shown and cannot be: it is displayed once at creation and only its
              hash is stored. Rotate it if it has been lost.
            </p>
          </template>

          <template v-else-if="key === 'backup'">
            <dl class="detail-grid">
              <dt>Label</dt>
              <dd data-testid="backup-detail-label">{{ text(detail.label) }}</dd>
              <dt>Kind</dt>
              <dd>{{ text(detail.kind) }}</dd>
              <dt>Status</dt>
              <dd data-testid="backup-detail-status">{{ text(detail.status) }}</dd>
              <dt>Size</dt>
              <dd class="mono">{{ text(detail.size_bytes ?? detail.sizeBytes) }}</dd>
              <dt>Checksum</dt>
              <dd class="mono">{{ text(detail.checksum) }}</dd>
              <dt>Encrypted</dt>
              <dd>{{ text(detail.encrypted) }}</dd>
              <dt>Location</dt>
              <dd class="mono" data-testid="backup-detail-location">
                {{ text(detail.location) }}
              </dd>
              <dt>Started</dt>
              <dd>{{ text(detail.started_at ?? detail.startedAt) }}</dd>
              <dt>Completed</dt>
              <dd>{{ text(detail.completed_at ?? detail.completedAt) }}</dd>
            </dl>
            <p class="source-note">
              Restore is the most consequential control in this console, and the decision behind it
              is here: how old the artifact is, whether it completed, whether anything has verified
              it since, and whether it is somewhere that survives losing this host. A location that
              reads <span class="mono">file://</span> is on the host itself.
            </p>
          </template>

          <template v-else-if="key === 'notifications'">
            <dl class="detail-grid">
              <dt>Category</dt>
              <dd data-testid="notification-detail-category">{{ text(detail.category) }}</dd>
              <dt>Title</dt>
              <dd>{{ text(detail.title) }}</dd>
              <dt>Raised</dt>
              <dd>{{ text(detail.created_at ?? detail.createdAt) }}</dd>
              <dt>Read</dt>
              <dd data-testid="notification-detail-read">
                {{ text(detail.read_at ?? detail.readAt) }}
              </dd>
            </dl>
            <h3>Body</h3>
            <p data-testid="notification-detail-body">{{ text(detail.body) }}</p>
            <!-- The payload is the part the list cannot show: it carries the
                 ids that say WHICH connection or message the notice is about. -->
            <h3>Payload</h3>
            <pre class="json-block" data-testid="notification-detail-data">{{
              prettyJson(detail.data)
            }}</pre>
            <p class="source-note">
              Opening a notification marks it read —
              <span class="mono">GET /notifications/:id</span> sets
              <span class="mono">read_at</span> as part of the read. That is the endpoint's
              behaviour, not something this screen adds, and it is stated here because a read that
              writes is not what a reader expects.
            </p>
          </template>

          <template v-else>
            <dl class="detail-grid">
              <dt>When</dt>
              <dd>{{ text(detail.created_at ?? detail.createdAt) }}</dd>
              <dt>Actor</dt>
              <dd>{{ text(detail.actor_id ?? detail.actorId) }}</dd>
              <dt>Action</dt>
              <dd>{{ text(detail.action) }}</dd>
              <dt>Entity</dt>
              <dd>
                {{ text(detail.entity_type ?? detail.entityType) }}
                {{ text(detail.entity_id ?? detail.entityId, '') }}
              </dd>
              <dt>Reason</dt>
              <dd>{{ text(detail.reason) }}</dd>
              <dt>Correlation</dt>
              <dd>{{ text(detail.correlation_id ?? detail.correlationId) }}</dd>
              <dt>Source IP</dt>
              <dd>{{ text(detail.source_ip ?? detail.sourceIp) }}</dd>
            </dl>
            <h3>Old value</h3>
            <pre class="json-block" data-testid="audit-old">{{
              prettyJson(detail.old_value ?? detail.oldValue)
            }}</pre>
            <h3>New value</h3>
            <pre class="json-block" data-testid="audit-new">{{
              prettyJson(detail.new_value ?? detail.newValue)
            }}</pre>
          </template>
        </template>
      </div>
    </DetailDrawer>

    <ModalDialog
      :open="showSendForm"
      title="Send message"
      testid="send-form"
      wide
      @close="showSendForm = false"
    >
      <label>
        SMSC connection
        <select v-model="sendSmscId" data-testid="send-smsc" required>
          <option value="" disabled>Select an SMSC connection</option>
          <option v-for="option in smscOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <p v-if="smscOptionsError" class="form-hint" role="alert">{{ smscOptionsError }}</p>
      <label>
        Sender
        <input v-model="sendSender" data-testid="send-sender" placeholder="JKANNEL" />
      </label>
      <label>
        Recipient
        <input v-model="sendReceiver" data-testid="send-receiver" placeholder="+256700000000" />
      </label>
      <label>
        Message text
        <textarea
          v-model="sendText"
          data-testid="send-text"
          rows="3"
          placeholder="Message body"
        ></textarea>
      </label>
      <SegmentCounter :text="sendText" testid="send-segment" />

      <h3>Send priority</h3>
      <MessagePriority v-model="sendPriority" testid="send-priority" :busy="loading" />

      <h3>When to send</h3>
      <SendSchedule
        v-model:later="sendLater"
        v-model:draft="sendSchedule"
        testid="send-schedule"
        :busy="loading"
      />

      <template #footer>
        <button class="secondary-button" @click="showSendForm = false">Cancel</button>
        <button
          class="primary-button"
          data-testid="send-submit"
          :disabled="!canSubmitSend"
          @click="sendMessage"
        >
          Send
        </button>
      </template>
    </ModalDialog>

    <!--
      THE SHARED CREATE FORM, AS A DIALOG.

      One composer serves five workspaces — SMSC, route, customer, user
      invitation and configuration — so this single change is what turns "Add
      SMSC", "Create route", "Add customer", "Invite user" and "Create
      configuration" into the pop-up the design system specifies. It used to
      unfold as a panel below the register, which on a screen listing every
      connection on the gateway meant the form opened below the fold and the
      button appeared to do nothing at all.

      `wide`, because these are two-column field grids like the kit's own Add
      SMSC dialog.
    -->
    <ModalDialog
      :open="showComposer"
      :title="`Create ${workspace.noun}`"
      testid="workspace-composer"
      wide
      @close="showComposer = false"
    >
      <div class="dialog-grid">
        <label class="dialog-span">
          {{
            workspace.createKind === 'invitation'
              ? 'Email'
              : workspace.createKind === 'configuration'
                ? 'Scope'
                : 'Name'
          }}
          <input
            v-model="draftName"
            data-testid="draft-name"
            :type="workspace.createKind === 'invitation' ? 'email' : 'text'"
            @keyup.enter="createRecord"
          />
        </label>

        <label v-if="workspace.createKind === 'route'">
          Target SMSC
          <select v-model="draftTarget" data-testid="draft-target">
            <option value="" disabled>Select a target SMSC</option>
            <option v-for="option in routeSmscOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <template v-if="workspace.createKind === 'route'">
          <p
            v-if="routeSmscError"
            class="form-hint dialog-span"
            role="alert"
            data-testid="route-smsc-error"
          >
            {{ routeSmscError }}
          </p>
          <label>
            Destination prefix
            <input v-model="routeDestinationPrefix" placeholder="+256" />
          </label>
          <label>
            Sender ID
            <input v-model="routeSender" placeholder="Optional sender match" />
          </label>
          <label>
            Fallback SMSC
            <select v-model="routeFallback" data-testid="draft-fallback">
              <option value="">None</option>
              <option v-for="option in routeSmscOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
          <p class="form-hint dialog-span">
            Routes are validated and dry-run before deployment; duplicate priorities within a scope
            are rejected.
          </p>
        </template>

        <!--
          The full connection form, not a four-field summary of it. The Name box
          above is the composer's shared field; everything a carrier's onboarding
          sheet carries is in here, grouped as that sheet is and collapsed until
          it is wanted.
        -->
        <template v-if="workspace.createKind === 'smsc'">
          <div class="dialog-span">
            <SmscConfigForm v-model="smscDraft" mode="create" testid="smsc-create" />
          </div>
        </template>

        <template v-if="workspace.createKind === 'configuration'">
          <div
            v-if="configBaseline"
            class="baseline-info dialog-span"
            data-testid="configuration-baseline-info"
          >
            <p class="form-hint">{{ text(configBaseline.description) }}</p>
            <ul v-if="Array.isArray(configBaseline.notes) && configBaseline.notes.length">
              <li v-for="(note, index) in configBaseline.notes as unknown[]" :key="index">
                {{ String(note) }}
              </li>
            </ul>
            <pre class="json-block" data-testid="configuration-baseline-content">{{
              prettyJson(configPrefillContent)
            }}</pre>
          </div>
          <template v-if="!configPrefillContent">
            <label>
              Admin port
              <input v-model.number="configAdminPort" type="number" min="1" max="65535" />
            </label>
            <label>
              Bearerbox/SMSBox port
              <input v-model.number="configSmsboxPort" type="number" min="1" max="65535" />
            </label>
            <label class="checkbox-row dialog-span">
              <input v-model="configSqlbox" type="checkbox" />
              Enable PostgreSQL SQLBox integration
            </label>
            <p class="form-hint dialog-span">
              JKANNEL validates and renders deterministic Kamex configuration with environment-only
              secrets.
            </p>
          </template>
        </template>
      </div>

      <template #footer>
        <button class="secondary-button" @click="showComposer = false">Cancel</button>
        <button
          class="primary-button"
          data-testid="save-draft"
          :disabled="
            loading ||
            !draftName.trim() ||
            (workspace.createKind === 'route' && !draftTarget.trim()) ||
            (workspace.createKind === 'smsc' &&
              smscDraft.type !== 'fake' &&
              !String(smscDraft.host ?? '').trim())
          "
          @click="createRecord"
        >
          Create
        </button>
      </template>
    </ModalDialog>

    <section v-if="key === 'routing' && !error" class="panel composer" aria-label="Route simulator">
      <h2>Route simulator</h2>
      <label>
        Destination
        <input
          v-model="simulationDestination"
          data-testid="simulation-destination"
          placeholder="+256700000000"
        />
      </label>
      <label>
        Sender ID
        <input v-model="simulationSender" placeholder="Optional sender" />
      </label>
      <button
        class="primary-button"
        data-testid="simulate-route"
        :disabled="loading || !simulationDestination.trim()"
        @click="simulateRoute"
      >
        Simulate route
      </button>
      <p v-if="simulationResult" class="form-hint" data-testid="simulation-result">
        Selected SMSC {{ simulationResult.smscId }} by rule {{ simulationResult.ruleId }} —
        {{ simulationResult.reason }}
      </p>
    </section>

    <section
      v-if="key === 'messages' && !error"
      class="panel composer"
      aria-label="SQLBox retention"
    >
      <h2>SQLBox retention</h2>
      <label>
        Keep sent message rows for days
        <input
          v-model.number="retentionDays"
          type="number"
          min="1"
          max="3650"
          data-testid="retention-days"
        />
      </label>
      <div>
        <button
          class="secondary-button"
          data-testid="retention-dry-run"
          :disabled="loading"
          @click="checkRetention(false)"
        >
          Dry-run cleanup
        </button>
        <button
          class="secondary-button danger-button"
          data-testid="retention-apply"
          :disabled="loading"
          @click="checkRetention(true)"
        >
          Apply retention
        </button>
      </div>
      <p v-if="retentionStatus" class="form-hint" data-testid="retention-result">
        {{ retentionStatus.eligibleRows ?? 0 }} of {{ retentionStatus.totalRows ?? 0 }} SQLBox rows
        are older than {{ retentionStatus.retentionDays ?? retentionDays }} days.
      </p>
    </section>

    <section
      v-if="key === 'configuration' && !error"
      class="panel composer"
      aria-label="Configuration approval workflow"
    >
      <h2>Configuration workflow</h2>
      <p class="form-hint">
        Validate generated output, approve the immutable version, then deploy. Rollback creates a
        new approved rollback version before deployment.
      </p>
      <div class="split-fields">
        <label>
          Compare from version ID
          <input v-model="configDiffFrom" data-testid="config-diff-from" placeholder="UUID" />
        </label>
        <label>
          Compare to version ID
          <input v-model="configDiffTo" data-testid="config-diff-to" placeholder="UUID" />
        </label>
      </div>
      <button
        class="secondary-button"
        data-testid="compare-configurations"
        :disabled="loading || !configDiffFrom.trim() || !configDiffTo.trim()"
        @click="compareConfigurations"
      >
        Compare versions
      </button>
      <div v-if="configDiffResult" class="diff-preview" data-testid="configuration-diff">
        <p>
          {{ Array.isArray(configDiffResult.lines) ? configDiffResult.lines.length : 0 }} changed
          lines detected.
        </p>
        <pre>{{ JSON.stringify(configDiffResult.lines ?? [], null, 2) }}</pre>
      </div>
    </section>

    <section
      v-if="key === 'configuration' && !error"
      class="panel"
      data-testid="configuration-drift"
      aria-label="Configuration drift"
    >
      <header class="panel-header">
        <div>
          <h2>Configuration drift</h2>
          <p>Compare the deployed configuration against what is live on the engine.</p>
        </div>
        <button
          class="secondary-button"
          data-testid="drift-check"
          :disabled="driftLoading"
          @click="checkDrift"
        >
          {{ driftLoading ? 'Checking…' : 'Check now' }}
        </button>
      </header>
      <p v-if="driftError" class="form-error" role="alert" data-testid="drift-error">
        {{ driftError }}
      </p>
      <template v-else-if="driftResult">
        <div class="summary-strip">
          <div class="metric">
            <strong data-testid="drift-status">
              <span class="dot" :class="driftResult.inSync ? 'good' : 'bad'"></span>
              {{ driftResult.inSync ? 'In sync' : 'Drift detected' }}
            </strong>
            <small>Deployed vs live</small>
          </div>
          <div class="metric">
            <strong class="mono">{{ text(driftResult.deployedVersion) }}</strong>
            <small>Deployed version</small>
          </div>
        </div>
        <dl class="detail-grid">
          <dt>Deployed checksum</dt>
          <dd class="mono">{{ text(driftResult.deployedChecksum) }}</dd>
          <dt>Live checksum</dt>
          <dd class="mono">{{ text(driftResult.liveChecksum) }}</dd>
          <dt>Config path</dt>
          <dd class="mono">{{ text(driftResult.configPath) }}</dd>
        </dl>
        <template v-if="Array.isArray(driftResult.differences) && driftResult.differences.length">
          <h3>Differences</h3>
          <pre class="json-block" data-testid="drift-differences">{{
            JSON.stringify(driftResult.differences, null, 2)
          }}</pre>
        </template>
        <p v-if="driftResult.note" class="source-note">{{ text(driftResult.note) }}</p>
      </template>
      <p v-else class="form-hint">Loading drift status…</p>
    </section>

    <section
      v-if="key === 'configuration' && !error"
      class="panel"
      data-testid="configuration-owners"
      aria-label="Directive ownership"
    >
      <header class="panel-header">
        <div>
          <h2>Who owns each directive</h2>
          <p>Where to make the change instead of editing the generated file</p>
        </div>
      </header>
      <!--
        The design system's EngineConfigScreen panel, and the most useful thing
        on this screen: the generated config is read-only, so an operator who
        needs a directive changed has to know which OBJECT owns it. Without
        this the honest answer "edit the object, not the file" is unactionable —
        it says what not to do and not where to go.

        Static because ownership is a property of the generator, not of a
        deployment. It changes when configuration-model.builder.ts changes, and
        that is a code change, not data.
      -->
      <div class="table-wrap">
        <table data-testid="directive-owners">
          <thead>
            <tr>
              <th scope="col">Directive</th>
              <th scope="col">Owned by</th>
              <th scope="col">Change it in</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in DIRECTIVE_OWNERS" :key="row.directive">
              <td class="mono">{{ row.directive }}</td>
              <td>{{ row.owner }}</td>
              <td>
                <RouterLink v-if="row.to" class="text-link" :to="row.to">{{
                  row.where
                }}</RouterLink>
                <span v-else class="cell-health">{{ row.where }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- GENERATED CONFIGURATION -------------------------------------------------
      The file the engine would actually be given, rendered from THIS tenant's
      SMSC definitions by the same generator the deploy path uses. Not a preview
      of a draft the composer is holding: `?source=database` reads the live
      objects, so what is on screen is what a deploy would write.

      Fetched on demand rather than on page load. It resolves secret references
      as it renders, so it is the one read on this screen with a cost, and an
      operator who came to look at the version list should not pay it.
    -->
    <section
      v-if="key === 'configuration' && !error"
      class="panel"
      data-testid="generated-configuration"
      aria-label="Generated configuration"
    >
      <header class="panel-header">
        <div>
          <h2>Generated configuration</h2>
          <p>
            What the engine would be given right now, rendered from this tenant's own connections.
            Read-only — the objects are the source, and the panel above says which one owns each
            directive.
          </p>
        </div>
        <button
          v-if="canManageConfig"
          class="secondary-button"
          type="button"
          data-testid="generated-config-load"
          :disabled="generatedBusy"
          @click="loadGeneratedConfig"
        >
          {{ generatedBusy ? 'Rendering…' : generatedConfig ? 'Re-render' : 'Render it' }}
        </button>
      </header>

      <p v-if="!canManageConfig" class="source-note" data-testid="generated-config-denied">
        Rendering the configuration needs the <span class="mono">configuration.manage</span>
        permission. It resolves secret references while it renders, which is why reading it is gated
        with the permission that deploys it rather than the one that lists versions.
      </p>

      <p
        v-else-if="generatedError"
        class="form-error"
        role="alert"
        data-testid="generated-config-error"
      >
        {{ generatedError }}
      </p>

      <template v-else-if="generatedConfig">
        <p class="source-note" data-testid="generated-config-meta">
          {{ generatedConfig.engine ?? 'kamex' }} ·
          {{ generatedConfig.content?.split('\n').length ?? 0 }} lines · checksum
          <span class="mono">{{ generatedConfig.checksum ?? 'not reported' }}</span>
        </p>
        <pre class="json-block" data-testid="generated-config-content">{{
          generatedConfig.content
        }}</pre>
        <p class="source-note">
          Secret references are resolved to render this, but the values are never returned — a
          reference that cannot be resolved fails the render and names the environment variable it
          needed, rather than emitting a file with a blank password in it.
        </p>
      </template>

      <p v-else class="chart-empty" data-testid="generated-config-idle">
        Not rendered yet. This is the only read on this screen that resolves secrets, so it is asked
        for rather than fetched on arrival.
      </p>
    </section>

    <section
      v-if="key === 'configuration' && !error"
      class="panel"
      data-testid="configuration-templates"
      aria-label="Configuration templates"
    >
      <header class="panel-header">
        <div>
          <h2>Configuration templates</h2>
          <p>Reusable starting points. Built-in templates are read-only; instantiate to reuse.</p>
        </div>
      </header>
      <p v-if="configTemplatesError" class="form-error" role="alert" data-testid="templates-error">
        {{ configTemplatesError }}
      </p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Engine</th>
              <th scope="col">Description</th>
              <th scope="col">Kind</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <!-- The row shows the template, which is what View does. -->
            <tr
              v-for="tpl in configTemplates"
              :key="String(tpl.id)"
              class="selectable"
              tabindex="0"
              :data-testid="`template-${tpl.id}`"
              @click="viewTemplate(tpl)"
              @keydown.enter="viewTemplate(tpl)"
              @keydown.space.prevent="viewTemplate(tpl)"
            >
              <td>
                <strong>{{ text(tpl.name) }}</strong>
              </td>
              <td>{{ text(tpl.engine) }}</td>
              <td>{{ text(tpl.description) }}</td>
              <td>
                <span
                  class="status-badge"
                  :class="tpl.builtIn || tpl.built_in ? 'muted' : 'good'"
                  >{{ tpl.builtIn || tpl.built_in ? 'built-in' : 'custom' }}</span
                >
              </td>
              <td class="row-actions">
                <button
                  class="secondary-button"
                  :data-testid="`template-view-${tpl.id}`"
                  @click.stop="viewTemplate(tpl)"
                >
                  View
                </button>
                <button
                  v-if="canManageConfig"
                  class="secondary-button"
                  :data-testid="`template-instantiate-${tpl.id}`"
                  :disabled="loading"
                  @click.stop="instantiateTemplate(tpl)"
                >
                  Instantiate
                </button>
              </td>
            </tr>
            <tr v-if="!configTemplates.length && !configTemplatesError">
              <td colspan="5" class="empty-cell" data-testid="templates-empty">
                No configuration templates are available.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- A sheet: the template list stays behind it, and an 80-column config
           sample is unreadable in a block wedged under the table. -->
      <DetailDrawer
        :open="Boolean(templateView)"
        :title="`${text(templateView?.name)} — content`"
        eyebrow="Configuration template"
        wide
        @close="closeTemplateView"
      >
        <div v-if="templateView" data-testid="template-view">
          <p v-if="templateViewLoading" class="form-hint">Loading…</p>
          <template v-else>
            <pre class="json-block" data-testid="template-view-content">{{
              prettyJson(templateView.content)
            }}</pre>
            <button
              class="secondary-button"
              data-testid="template-view-copy"
              @click="copyText(prettyJson(templateView.content))"
            >
              Copy content
            </button>
          </template>
        </div>
      </DetailDrawer>

      <div v-if="instantiateResult" class="baseline-info" data-testid="instantiate-result">
        <header class="panel-header">
          <div>
            <h3>Instantiated: {{ text(instantiateResult.name) }}</h3>
          </div>
          <button
            class="secondary-button"
            data-testid="instantiate-close"
            @click="closeInstantiate"
          >
            Close
          </button>
        </header>
        <p v-if="instantiateResult.note" class="form-hint">{{ text(instantiateResult.note) }}</p>
        <pre class="json-block" data-testid="instantiate-content">{{
          prettyJson(instantiateResult.content)
        }}</pre>
        <div>
          <button
            class="secondary-button"
            data-testid="instantiate-copy"
            @click="copyText(prettyJson(instantiateResult.content))"
          >
            Copy content
          </button>
          <button
            class="primary-button"
            data-testid="instantiate-use"
            @click="useInstantiatedInComposer"
          >
            Use in create form
          </button>
        </div>
      </div>
    </section>

    <section
      v-if="key === 'reports' && !error"
      class="panel composer"
      aria-label="Delivery report summary"
    >
      <h2>Delivery reports</h2>
      <p v-if="deliveryUnavailable" class="form-hint" data-testid="delivery-summary-unavailable">
        Delivery report data is unavailable; the SQLBox message store could not be reached.
      </p>
      <p v-else-if="deliverySummary" class="form-hint" data-testid="delivery-summary">
        {{ (deliverySummary.summary as RecordValue | null)?.total ?? 0 }} delivery receipts
        available from the SQLBox message store.
      </p>
      <p v-else class="form-hint">Loading delivery report summary…</p>
    </section>

    <section v-if="!error && !customRender" class="panel">
      <header class="panel-header">
        <div>
          <h2>{{ route.meta.title }}</h2>
          <p aria-live="polite">
            {{ loading ? 'Loading records…' : `${visibleRows.length} records shown` }}
          </p>
        </div>
      </header>
      <p v-if="key === 'alerts'" class="source-note" data-testid="alert-actions-note">
        Acknowledging an alert records who took it and stops its escalation; “Re-notify” resends it
        to the configured notification channels. The rule evaluator also resolves an alert on its
        own once the condition clears. For the rest of the lifecycle — resolve, assign, suppress,
        reopen, close and the comment thread — open the row in
        <RouterLink class="text-link" to="/alert-lifecycle">Alert Lifecycle</RouterLink>, which has
        the single-alert context those actions need. To silence alerting for planned work across
        many alerts at once, schedule a
        <RouterLink class="text-link" to="/alert-response">maintenance window</RouterLink> instead.
      </p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <template v-if="columns">
                <th v-for="column in columns" :key="column.header" scope="col">
                  {{ column.header }}
                </th>
              </template>
              <template v-else>
                <th scope="col">Name</th>
                <th scope="col">Details</th>
                <th scope="col">Status</th>
                <th scope="col">Updated</th>
              </template>
              <th v-if="hasRowActions" scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <!--
              `selectable` is the design system's class for a row that opens
              something (`SmscsScreen.jsx` uses it on exactly this table), and
              it brings a focus ring with it — which is the half `clickable-row`
              never had. `tabindex` and the Enter/Space handlers are what make
              the row reachable at all without a mouse; a register that can only
              be opened by clicking is not operable from the keyboard.
            -->
            <tr
              v-for="row in visibleRows"
              :key="row.id"
              :data-testid="`record-${row.id}`"
              :class="{ selectable: clickableRow }"
              :tabindex="clickableRow ? 0 : undefined"
              @click="onRowClick(row)"
              @keydown.enter="clickableRow && onRowClick(row)"
              @keydown.space.prevent="clickableRow && onRowClick(row)"
            >
              <template v-if="columns">
                <td v-for="column in columns" :key="column.header" :class="{ mono: column.mono }">
                  <div class="cell-status">
                    <span
                      v-if="column.dot"
                      class="dot"
                      :class="column.dot(row.raw)"
                      :data-testid="key === 'smsc' ? `smsc-dot-${row.id}` : undefined"
                    ></span>
                    <span v-if="column.badge" class="status-badge" :class="column.badge(row.raw)">
                      {{ column.value(row.raw) }}
                    </span>
                    <span v-else>{{ column.value(row.raw) }}</span>
                  </div>
                  <small v-if="column.hint && column.hint(row.raw)" class="row-id">
                    {{ column.hint(row.raw) }}
                  </small>
                </td>
              </template>
              <template v-else>
                <td>
                  <strong>{{ row.name }}</strong>
                  <small class="row-id">{{ row.id }}</small>
                </td>
                <td>{{ row.detail }}</td>
                <td>
                  <div class="cell-status">
                    <span
                      v-if="key === 'smsc'"
                      class="dot"
                      :class="smscDotClass(row.raw)"
                      :data-testid="`smsc-dot-${row.id}`"
                    ></span>
                    <span class="status-badge">{{ row.status }}</span>
                    <small v-if="key === 'smsc' && smscHealthText(row.raw)" class="cell-health">{{
                      smscHealthText(row.raw)
                    }}</small>
                  </div>
                </td>
                <td>{{ row.updated }}</td>
              </template>
              <!--
                TWO ACTIONS INLINE, THE STATE CHANGES ON THE RECORD.

                Five buttons in this cell made the register unreadable: fifteen
                columns and a 400px action group left every other cell wrapping,
                and rows measured 221px tall against 70px on a register without
                them. `SmscsScreen.jsx` has no row actions at all — the row
                opens the connection and the actions live there.

                Test and Reconnect stay, because they are diagnostic, safe, and
                the reason somebody scans this list during an incident. Disable,
                Suspend and Resume moved to the sheet the row opens: they change
                whether traffic flows, their impact dialog already lives on the
                record, and a destructive control one careless click away in a
                dense grid is the wrong place for them.
              -->
              <!--
                OPEN AND EDIT ARE IN THE ROW; DELETE IS NOT.

                The reasoning below — that a destructive control one careless
                click away in a dense grid is in the wrong place — still holds,
                and Delete / Archive stays on the record with its impact review.
                What it got wrong was leaving nothing in the row to say the
                record HAS more actions. Reported from the running console:
                "there is no ability to modify the smsc, there is just add smsc,
                test and reconnect". Edit and Delete were both there, in the
                sheet, and the register gave no sign of it — a capability
                nobody can find is not a capability. The Carriers register has
                had Open / Edit / Delete in the row throughout, so the two
                registers also disagreed about how a record is reached.

                Open is explicit rather than relying on the row being clickable,
                which is discoverable only by trying it. Edit is safe and is the
                thing an operator came to do.
              -->
              <td v-if="key === 'smsc'" class="row-actions" @click.stop>
                <button
                  class="secondary-button"
                  :data-testid="`smsc-open-${row.id}`"
                  @click="openDetail(row)"
                >
                  Open
                </button>
                <button
                  class="secondary-button"
                  :data-testid="`smsc-edit-${row.id}`"
                  @click="openDetail(row).then(() => (editing = true))"
                >
                  Edit
                </button>
                <button class="secondary-button" @click="testSmsc(row)">Test</button>
                <button
                  class="secondary-button"
                  :data-testid="`smsc-reconnect-${row.id}`"
                  @click="requestSmscAction(row, 'reconnect')"
                >
                  Reconnect
                </button>
              </td>
              <td v-else-if="key === 'routing'" class="row-actions" @click.stop>
                <button class="secondary-button" @click="rowAction(row, 'validate')">
                  Validate
                </button>
                <button class="secondary-button" @click="rowAction(row, 'deploy')">Deploy</button>
                <button class="secondary-button" @click="rowAction(row, 'rollback')">
                  Rollback
                </button>
              </td>
              <td v-else-if="key === 'configuration'" class="row-actions" @click.stop>
                <button
                  class="secondary-button"
                  :data-testid="`config-edit-${row.id}`"
                  @click="editConfiguration(row)"
                >
                  Edit
                </button>
                <button class="secondary-button" @click="rowAction(row, 'validate')">
                  Validate
                </button>
                <button class="secondary-button" @click="rowAction(row, 'approve')">Approve</button>
                <button class="secondary-button" @click="rowAction(row, 'deploy')">Deploy</button>
                <button class="secondary-button" @click="rowAction(row, 'rollback')">
                  Rollback
                </button>
              </td>
              <td v-else-if="key === 'notifications'" class="row-actions" @click.stop>
                <button
                  v-if="!row.raw.read_at"
                  class="secondary-button"
                  :data-testid="`mark-read-${row.id}`"
                  @click="markNotificationRead(row)"
                >
                  Mark read
                </button>
              </td>
              <td v-else-if="key === 'alerts'" class="row-actions" @click.stop>
                <template v-if="canAcknowledgeAlerts">
                  <button
                    v-if="row.raw.status === 'open'"
                    class="secondary-button"
                    :data-testid="`alert-ack-${row.id}`"
                    :disabled="loading"
                    @click="acknowledgeAlert(row)"
                  >
                    Acknowledge
                  </button>
                  <span v-else-if="row.raw.status === 'acknowledged'" class="cell-health">
                    acknowledged
                  </span>
                  <button
                    v-if="row.raw.status !== 'resolved'"
                    class="secondary-button"
                    :data-testid="`alert-notify-${row.id}`"
                    :disabled="loading"
                    @click="notifyAlert(row)"
                  >
                    Re-notify
                  </button>
                </template>
                <span v-else class="cell-health">Requires alerts.acknowledge</span>
                <RouterLink
                  class="text-link"
                  :data-testid="`alert-lifecycle-${row.id}`"
                  :to="`/alert-lifecycle?alert=${row.id}`"
                  @click.stop
                >
                  Lifecycle
                </RouterLink>
              </td>
              <td v-else-if="key === 'plugins'" class="row-actions" @click.stop>
                <template v-if="canManageSystem">
                  <button
                    class="secondary-button"
                    :data-testid="`plugin-enable-${row.id}`"
                    @click="pluginAction(row, 'enable')"
                  >
                    Enable
                  </button>
                  <button
                    class="secondary-button"
                    :data-testid="`plugin-disable-${row.id}`"
                    @click="pluginAction(row, 'disable')"
                  >
                    Disable
                  </button>
                </template>
                <span v-else class="cell-health">Requires system.manage</span>
              </td>
              <td v-else-if="key === 'backup'" class="row-actions">
                <button
                  class="secondary-button"
                  :data-testid="`backup-verify-${row.id}`"
                  @click="verifyBackup(row)"
                >
                  Verify
                </button>
                <button
                  class="secondary-button"
                  :data-testid="`backup-restore-${row.id}`"
                  @click="openRestore(row)"
                >
                  Restore
                </button>
              </td>
              <td v-else-if="key === 'api-gateway'" class="row-actions">
                <button
                  class="secondary-button"
                  :data-testid="`client-rotate-${row.id}`"
                  @click="rotateSecret(row)"
                >
                  Rotate secret
                </button>
                <button
                  class="secondary-button danger-button"
                  :data-testid="`client-revoke-${row.id}`"
                  @click="revokeClient(row)"
                >
                  Revoke
                </button>
              </td>
            </tr>
            <tr v-if="!loading && !visibleRows.length">
              <td :colspan="columnCount" class="empty-cell" data-testid="empty-state">
                {{
                  query || state !== 'All'
                    ? 'No records match these filters.'
                    : `No ${workspace.noun} records are available.`
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <!-- `key === 'messages'` as well as `grid`: the messages endpoint pages
           on limit/offset and reports a real total, it simply was not built on
           the shared grid config. -->
      <footer v-if="grid || key === 'messages'" class="pager">
        <span data-testid="grid-range">{{ rangeLabel }}</span>
        <div class="pager-buttons">
          <button
            class="secondary-button"
            data-testid="grid-prev"
            :disabled="loading || offset === 0"
            @click="turnPage(-1)"
          >
            Previous
          </button>
          <button
            class="secondary-button"
            data-testid="grid-next"
            :disabled="loading || offset + pageSize >= total"
            @click="turnPage(1)"
          >
            Next
          </button>
        </div>
      </footer>
    </section>

    <!--
      PLAN.md 3.1 / spec §7. The rates panel goes ABOVE the message grid, not on
      a screen of its own: the grid below lists rows in the SQLBox spool, the
      panel describes bearerbox's internal per-bind queue, and an operator who
      met those two numbers on separate pages would have no way to know they are
      different queues. The panel owns its own fetch and its own states.
    -->
    <QueueRatesPanel v-if="isQueue" />

    <section v-if="isQueue && !error" class="panel" data-testid="queue-panel">
      <header class="panel-header">
        <div>
          <h2>Message queue</h2>
          <p aria-live="polite">
            {{
              loading ? 'Loading queued messages…' : `${cursorItems.length} queued messages shown`
            }}
          </p>
        </div>
        <button
          class="secondary-button"
          data-testid="queue-export"
          :disabled="loading || !cursorItems.length"
          @click="exportQueueCsv"
        >
          Export CSV
        </button>
      </header>
      <div class="summary-strip">
        <div class="metric">
          <strong data-testid="queue-depth">{{ (cursorSummary?.queued as number) ?? 0 }}</strong>
          <small>Queue depth</small>
        </div>
        <div class="metric">
          <strong>{{ text(cursorSummary?.oldestEpoch) }}</strong>
          <small>Oldest (epoch)</small>
        </div>
      </div>
      <p v-if="cursorSourceUnavailable" class="source-note" data-testid="queue-source-note">
        Queue data is unavailable; the message store could not be reached.
      </p>
      <p v-else class="source-note">Source: {{ cursorSourceLabel }}</p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th v-for="column in queueColumns" :key="column.label" scope="col">
                {{ column.label }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(item, index) in cursorItems"
              :key="String(item.id ?? index)"
              :data-testid="`queue-row-${index}`"
            >
              <td v-for="column in queueColumns" :key="column.label">{{ column.value(item) }}</td>
            </tr>
            <tr v-if="!loading && !cursorItems.length">
              <!-- An empty send queue is the healthy steady state, not a fault. -->
              <td :colspan="queueColumns.length" class="empty-cell">
                The send queue is empty.
                <small class="empty-cell-hint"
                  >That is the normal state for a healthy gateway — messages leave the spool as fast
                  as the binds accept them. Anything already handed to an SMSC has moved on to
                  Messages and Delivery Reports.</small
                >
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <footer class="cursor-pager">
        <button
          class="secondary-button"
          data-testid="cursor-prev"
          :disabled="loading || !cursorHistory.length"
          @click="turnCursor(-1)"
        >
          Previous
        </button>
        <button
          class="secondary-button"
          data-testid="cursor-next"
          :disabled="loading || !cursorNext"
          @click="turnCursor(1)"
        >
          Load more
        </button>
      </footer>
    </section>

    <section v-if="isDlr && !error" class="panel" data-testid="dlr-panel">
      <header class="panel-header">
        <div>
          <h2>Delivery reports</h2>
          <p aria-live="polite">
            {{
              loading ? 'Loading delivery reports…' : `${cursorItems.length} delivery reports shown`
            }}
          </p>
        </div>
        <div class="pager-buttons">
          <button
            class="secondary-button"
            data-testid="dlr-clear-filters"
            :disabled="loading || !dlrFiltered"
            @click="clearDlrFilters"
          >
            Clear filters
          </button>
          <button
            class="secondary-button"
            data-testid="dlr-export"
            :disabled="loading"
            @click="exportDlrCsv"
          >
            Export CSV
          </button>
        </div>
      </header>

      <!-- Status vocabulary, as chips. Same tokens the API accepts. -->
      <div class="status-chips" role="group" aria-label="Filter by delivery status">
        <button
          v-for="status in DELIVERY_STATUSES"
          :key="status"
          type="button"
          :data-testid="`dlr-status-${status}`"
          :aria-pressed="dlrStatuses.includes(status)"
          :disabled="loading"
          @click="toggleDlrStatus(status)"
        >
          {{ status }}
        </button>
        <button
          v-for="group in DELIVERY_STATUS_GROUPS"
          :key="group.token"
          type="button"
          :data-testid="`dlr-group-${group.token}`"
          :aria-pressed="dlrGroup === group.token"
          :disabled="loading"
          :title="`${group.label}: ${group.members.join(' + ')}`"
          @click="toggleDlrGroup(group.token)"
        >
          {{ group.label }}
        </button>
      </div>

      <div class="grid-toolbar">
        <label class="filter-select">
          <span>SMSC</span>
          <input
            v-model="dlrSmscId"
            data-testid="dlr-smsc-filter"
            placeholder="SMSC id"
            @change="applyDlrFilter"
            @keyup.enter="applyDlrFilter"
          />
        </label>
        <label class="filter-select">
          <span>From</span>
          <input
            v-model="dlrFrom"
            type="datetime-local"
            data-testid="dlr-from"
            @change="applyDlrFilter"
          />
        </label>
        <label class="filter-select">
          <span>To</span>
          <input
            v-model="dlrTo"
            type="datetime-local"
            data-testid="dlr-to"
            @change="applyDlrFilter"
          />
        </label>
        <label class="filter-select">
          <span>Per page</span>
          <select v-model.number="dlrLimit" data-testid="dlr-limit" @change="applyDlrFilter">
            <option :value="25">25</option>
            <option :value="50">50</option>
            <option :value="100">100</option>
            <option :value="250">250</option>
            <option :value="500">500</option>
          </select>
        </label>
      </div>

      <p v-if="dlrFilterError" class="form-error" role="alert" data-testid="dlr-filter-error">
        {{ dlrFilterError }}
      </p>
      <p v-if="dlrAppliedFilters" class="source-note" data-testid="dlr-applied-filters">
        Filters applied to this grid and to the CSV export: {{ dlrAppliedFilters }}.
      </p>

      <div class="summary-strip">
        <div class="metric">
          <strong data-testid="dlr-total">{{ cursorItems.length }}</strong>
          <small>Receipts on this page</small>
        </div>
        <div v-if="dlrOffsetMode" class="metric">
          <strong data-testid="dlr-matching">{{ dlrTotal }}</strong>
          <small>Matching the filters</small>
        </div>
      </div>
      <p v-if="cursorSourceUnavailable" class="source-note" data-testid="dlr-source-note">
        Delivery report data is unavailable; the SQLBox message store could not be reached.
      </p>
      <p v-else class="source-note">Source: {{ cursorSourceLabel }}</p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th
                v-for="column in dlrColumns"
                :key="column.key"
                scope="col"
                :aria-sort="dlrAriaSort(column.sort)"
              >
                <button
                  v-if="column.sort"
                  type="button"
                  class="column-sort"
                  :data-testid="`dlr-sort-${column.key}`"
                  @click="sortDlrBy(column.sort)"
                >
                  {{ column.label }}
                  <span v-if="dlrSortField === column.sort">{{
                    dlrSortDir === 'asc' ? '▲' : '▼'
                  }}</span>
                </button>
                <template v-else>{{ column.label }}</template>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(item, index) in cursorItems"
              :key="String(item.id ?? index)"
              class="selectable"
              :data-testid="`dlr-row-${index}`"
              tabindex="0"
              @click="openDlrDetail(item)"
              @keydown.enter="openDlrDetail(item)"
              @keydown.space.prevent="openDlrDetail(item)"
            >
              <td v-for="column in dlrColumns" :key="column.key" :class="{ mono: column.mono }">
                <span
                  v-if="column.badge"
                  class="status-badge"
                  :class="badgeTone(column.value(item))"
                  >{{ column.value(item) || '—' }}</span
                >
                <template v-else>{{ column.value(item) || '—' }}</template>
                <small v-if="column.hint && column.hint(item)" class="row-id">{{
                  column.hint(item)
                }}</small>
              </td>
            </tr>
            <tr v-if="!loading && !cursorItems.length">
              <td :colspan="dlrColumns.length" class="empty-cell" data-testid="dlr-empty">
                {{
                  dlrFiltered
                    ? 'No delivery reports match these filters. Clear them to see the whole report.'
                    : 'No delivery reports.'
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="source-note" data-testid="dlr-paging-note">
        <template v-if="cursorItems.length"
          >Select a delivery report to view the full receipt.
        </template>
        <template v-if="dlrOffsetMode">
          Sorted by {{ dlrSortField }} ({{ dlrSortDir }}). A custom sort has no keyset, so the API
          pages this by offset and returns a row count; click the column a third time to return to
          newest-first keyset paging.
        </template>
        <template v-else>
          Newest first, paged by keyset — no row count is computed, which is what keeps a
          continuously growing receipt table cheap to page.
        </template>
      </p>
      <footer class="cursor-pager">
        <span class="source-note" data-testid="dlr-range">{{ dlrRangeLabel }}</span>
        <button
          class="secondary-button"
          data-testid="cursor-prev"
          :disabled="loading || !dlrHasPrev"
          @click="turnDlrPage(-1)"
        >
          Previous
        </button>
        <button
          class="secondary-button"
          data-testid="cursor-next"
          :disabled="loading || !dlrHasNext"
          @click="turnDlrPage(1)"
        >
          {{ dlrOffsetMode ? 'Next' : 'Load more' }}
        </button>
      </footer>
    </section>

    <DetailDrawer
      :open="dlrOpen && Boolean(dlrRecord)"
      title="Delivery report detail"
      eyebrow="Delivery report"
      wide
      @close="closeDlrDetail"
    >
      <dl v-if="dlrRecord" class="detail-grid" data-testid="dlr-detail-panel">
        <dt>Record ID</dt>
        <dd class="mono">
          {{ text(dlrRecord.id ?? dlrRecord.message_id ?? dlrRecord.messageId) }}
        </dd>
        <dt>External reference</dt>
        <dd class="mono">{{ text(dlrRecord.externalRef ?? dlrRecord.foreign_id) }}</dd>
        <dt>Direction</dt>
        <dd>{{ text(dlrRecord.direction ?? dlrRecord.momt) }}</dd>
        <dt>Delivery status</dt>
        <dd>
          <span
            class="status-badge"
            :class="badgeTone(dlrRecord.deliveryStatus ?? dlrRecord.delivery_status)"
            data-testid="dlr-detail-delivery-status"
            >{{
              text(dlrRecord.deliveryStatus ?? dlrRecord.delivery_status ?? dlrRecord.dlr_status)
            }}</span
          >
        </dd>
        <dt>DLR event</dt>
        <dd data-testid="dlr-detail-event">{{ dlrEventLabel(dlrRecord) }}</dd>
        <dt>DLR mask</dt>
        <dd>{{ text(dlrRecord.dlrMask ?? dlrRecord.dlr_mask) }}</dd>
        <dt>DLR callback URL</dt>
        <dd class="mono">{{ text(dlrRecord.dlrUrl ?? dlrRecord.dlr_url) }}</dd>
        <dt>Record status</dt>
        <dd>{{ text(dlrRecord.status ?? dlrRecord.state) }}</dd>
        <dt>Sender</dt>
        <dd class="mono">{{ text(dlrRecord.sender ?? dlrRecord.from) }}</dd>
        <dt>Receiver</dt>
        <dd class="mono">
          {{ text(dlrRecord.receiver ?? dlrRecord.recipient ?? dlrRecord.to) }}
        </dd>
        <dt>SMSC</dt>
        <dd class="mono">{{ text(dlrRecord.smscId ?? dlrRecord.smsc_id ?? dlrRecord.smsc) }}</dd>
        <dt>Service</dt>
        <dd>{{ text(dlrRecord.service) }}</dd>
        <dt>Account</dt>
        <dd>{{ text(dlrRecord.account) }}</dd>
        <dt>Box connection</dt>
        <dd class="mono">{{ text(dlrRecord.boxcId ?? dlrRecord.boxc_id) }}</dd>
        <dt>Received</dt>
        <dd>{{ text(dlrRecord.timestamp ?? dlrRecord.created_at ?? dlrRecord.time) }}</dd>
        <dt>Reported at</dt>
        <dd>{{ text(dlrRecord.dlrAt ?? dlrRecord.dlr_at) }}</dd>
        <dt>Report text</dt>
        <dd>{{ text(dlrRecord.text ?? dlrRecord.msgdata) }}</dd>
        <dt>Segments</dt>
        <dd>{{ segmentCount(dlrRecord) }}</dd>
        <dt>Encoding</dt>
        <dd>{{ codingLabel(dlrRecord) }}</dd>
        <dt>UDH</dt>
        <dd class="mono">{{ text(dlrRecord.udhData ?? dlrRecord.udhdata) }}</dd>
        <dt>Store</dt>
        <dd>{{ text(dlrRecord.source) }}</dd>
        <dt>Billing info</dt>
        <dd class="mono">{{ text(dlrRecord.binfo) }}</dd>
        <dt>Metadata</dt>
        <dd class="mono">{{ text(dlrRecord.metaData ?? dlrRecord.meta_data) }}</dd>
      </dl>
      <p class="source-note">
        Fields the SQLBox message store did not supply for this receipt read “—”; nothing here is
        inferred. There is no per-receipt endpoint — this is the complete row the report returned.
      </p>
    </DetailDrawer>

    <section v-if="isDocker && !error" class="panel" data-testid="docker-panel">
      <header class="panel-header">
        <div>
          <h2>Runtime containers</h2>
          <p aria-live="polite">
            {{ loading ? 'Probing containers…' : `${containers.length} containers` }}
            <template v-if="containersObservedAt"> · observed {{ containersObservedAt }}</template>
          </p>
        </div>
      </header>
      <p class="source-note">
        Services the API cannot probe are reported as “unknown” rather than assumed healthy.
      </p>
      <div class="container-grid">
        <article
          v-for="(container, index) in containers"
          :key="String(container.name ?? index)"
          class="container-card"
          :data-testid="`container-${index}`"
        >
          <header>
            <span class="dot" :class="containerDotClass(container)"></span>
            <strong>{{ text(container.name) }}</strong>
            <span
              class="observe-badge"
              :class="container.observed ? 'live' : 'declared'"
              :data-testid="`container-observe-${index}`"
            >
              {{ container.observed ? 'observed live' : 'declared' }}
            </span>
          </header>
          <dl>
            <dt>Service</dt>
            <dd>{{ text(container.service) }}</dd>
            <dt>Image</dt>
            <dd>{{ text(container.image) }}</dd>
            <dt>Network</dt>
            <dd>{{ text(container.network) }}</dd>
            <dt>Status</dt>
            <dd>{{ text(container.status) }}</dd>
            <dt>Health</dt>
            <dd>{{ text(container.health) }}</dd>
            <dt v-if="container.detail">Detail</dt>
            <dd v-if="container.detail">{{ text(container.detail) }}</dd>
          </dl>
        </article>
        <!--
          "No containers reported" was indistinguishable from "the Docker probe
          failed", which matters because the panel's own note says unprobeable
          services come back as `unknown` rather than vanishing.
        -->
        <p v-if="!loading && !containers.length" class="empty-cell">
          The container inventory came back empty.
          <small class="empty-cell-hint"
            >A running deployment normally reports at least one service here, and services the probe
            cannot reach are listed as <code>unknown</code> rather than omitted — so an empty list
            usually means the Docker probe itself could not enumerate anything.</small
          >
        </p>
      </div>
    </section>

    <!-- MAINTENANCE -------------------------------------------------------------
      Two operations that belong to the platform rather than to any workspace:
      what the engine says it can do, and the message-store indexes the message
      grid's own queries depend on.
    -->
    <section v-if="isSystem && !error" class="panel" data-testid="system-maintenance">
      <header class="panel-header">
        <div>
          <h2>Maintenance</h2>
          <p>What the engine reports it supports, and the message-store indexes.</p>
        </div>
      </header>

      <div class="detail-actions">
        <button
          class="secondary-button"
          type="button"
          :disabled="Boolean(maintenanceBusy)"
          data-testid="engine-capabilities"
          @click="loadCapabilities"
        >
          {{ maintenanceBusy === 'capabilities' ? 'Asking…' : 'Read engine capabilities' }}
        </button>
        <button
          v-if="canManageSystem"
          class="secondary-button"
          type="button"
          :disabled="Boolean(maintenanceBusy)"
          data-testid="ensure-indexes"
          @click="ensureIndexes"
        >
          {{ maintenanceBusy === 'indexes' ? 'Creating…' : 'Ensure message indexes' }}
        </button>
      </div>

      <p v-if="maintenanceNotice" class="notice" role="status" data-testid="maintenance-notice">
        {{ maintenanceNotice }}
      </p>
      <p v-if="maintenanceError" class="form-error" role="alert" data-testid="maintenance-error">
        {{ maintenanceError }}
      </p>

      <!--
        Rendered verbatim. Capabilities are how the console decides what to
        offer, and paraphrasing them here would let this panel disagree with the
        screens that act on them.
      -->
      <pre v-if="capabilities" class="json-block" data-testid="capabilities-json">{{
        JSON.stringify(capabilities, null, 2)
      }}</pre>

      <p class="source-note">
        Ensuring indexes is safe to run repeatedly — it creates what is missing and leaves what is
        there. It is worth running after a restore, when the message store has data but not
        necessarily the indexes the message grid's queries rely on.
      </p>
    </section>

    <section v-if="isSystem && !error" class="panel" data-testid="system-panel">
      <header class="panel-header">
        <div>
          <h2>System settings</h2>
          <p aria-live="polite">
            {{ loading ? 'Loading settings…' : `${settingItems.length} settings` }}
          </p>
        </div>
      </header>
      <div
        v-for="group in settingGroups"
        :key="group.name"
        class="settings-group"
        :data-testid="`settings-group-${group.name}`"
      >
        <h3>{{ group.name }}</h3>
        <div
          v-for="item in group.items"
          :key="String(item.key)"
          class="setting-row"
          :data-testid="`setting-${item.key}`"
        >
          <div class="setting-meta">
            <strong>{{ text(item.key) }}</strong>
            <small>{{ text(item.description) }}</small>
            <div class="setting-value">
              Current: {{ item.is_secret || item.isSecret ? '••••••' : text(item.value) }}
            </div>
          </div>
          <div v-if="item.editable" class="setting-control">
            <select
              v-if="item.type === 'boolean'"
              v-model="settingDrafts[String(item.key)]"
              :data-testid="`setting-input-${item.key}`"
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
            <input
              v-else
              v-model="settingDrafts[String(item.key)]"
              :type="item.type === 'number' ? 'number' : 'text'"
              :data-testid="`setting-input-${item.key}`"
            />
            <button
              class="secondary-button"
              :data-testid="`setting-save-${item.key}`"
              :disabled="loading"
              @click="saveSetting(item)"
            >
              Save
            </button>
          </div>
          <div v-else class="setting-readonly" :data-testid="`setting-readonly-${item.key}`">
            Read-only
          </div>
        </div>
      </div>
      <p v-if="!loading && !settingItems.length" class="empty-cell">No settings available.</p>
    </section>

    <!--
      IMPACT BEFORE THE VERB. One dialog for all five SMSC operations; the
      operation it is confirming decides which impact is fetched, what the
      button says, and whether the reason it captures is actually recorded.
    -->
    <ConfirmAction
      v-if="pendingSmsc"
      :open="true"
      :smsc-id="pendingSmsc.row.id"
      :operation="pendingSmsc.operation"
      :busy="smscActionBusy"
      :danger="pendingSmsc.operation === 'disable' || pendingSmsc.operation === 'suspend'"
      testid="smsc-confirm"
      @close="pendingSmsc = null"
      @confirm="confirmSmscAction"
    />
  </section>
  <section v-else class="panel empty-state" data-testid="restricted-state">
    <h2>Access restricted</h2>
    <p>Your current role does not permit this workspace.</p>
  </section>
</template>
