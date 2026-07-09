<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ApiError, apiDownloadFile, apiRequest, saveDownloadedFile } from '../api';
import { canAccess, session } from '../stores/session';

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

const definitions: Record<string, Workspace> = {
  messages: {
    noun: 'message',
    search: 'Message ID, sender, recipient, or status',
    endpoint: '/messages',
    action: 'Refresh',
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
        { field: 'targetSmscId', label: 'Target SMSC' },
      ],
      exportBase: '/routes/export',
    },
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
        { field: 'status', label: 'Status', options: ['open', 'acknowledged', 'resolved'] },
        { field: 'severity', label: 'Severity', options: ['info', 'warning', 'critical'] },
        { field: 'ruleId', label: 'Rule ID' },
      ],
      exportBase: '/alerts/export',
    },
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
    creatable: true,
  },
  'api-gateway': {
    noun: 'API client',
    search: 'Client, credential, route, or state',
    endpoint: '/api-gateway/clients',
    action: 'Add API client',
    actionEndpoint: '/api-gateway/clients',
    actionMethod: 'POST',
    creatable: true,
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
  },
  backup: {
    noun: 'backup',
    search: 'Backup name, date, type, or status',
    endpoint: '/backups',
    action: 'Create backup',
    actionEndpoint: '/backups',
    actionMethod: 'POST',
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
const smscType = ref<'fake' | 'smpp' | 'http' | 'at'>('fake');
const smscHost = ref('');
const smscPort = ref(2775);
const smscTps = ref(10);

/* Server-side grid state (search is shared with the legacy client filter). */
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
const smscOptions = ref<Array<{ value: string; label: string }>>([]);
const smscOptionsError = ref('');

/* Reports extras: delivery summary + on-demand generation. */
const deliverySummary = ref<RecordValue | null>(null);
const deliveryUnavailable = ref(false);

const key = computed(() => String(route.name));
const workspace = computed(() => definitions[key.value]);
const grid = computed(() => workspace.value?.grid);
const columns = computed(() => workspace.value?.columns);
const states = computed(() => [
  'All',
  ...new Set(rows.value.map((row) => row.status).filter(Boolean)),
]);
const visibleRows = computed(() => {
  if (grid.value) return rows.value;
  return rows.value
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
    key.value === 'notifications',
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

async function load(preserveNotice = false) {
  if (!workspace.value) return;
  loading.value = true;
  error.value = '';
  unavailable.value = false;
  if (!preserveNotice) notice.value = '';
  appliedSearch = query.value;

  try {
    const path = grid.value
      ? `${workspace.value.endpoint}?${buildGridQuery().toString()}`
      : workspace.value.endpoint;
    const page = normalize(await apiRequest<unknown>(path));
    rows.value = page.items;
    total.value = page.total;
  } catch (reason) {
    rows.value = [];
    total.value = 0;
    unavailable.value =
      reason instanceof ApiError && (reason.status === 404 || reason.status === 501);
    error.value = reason instanceof Error ? reason.message : 'The service could not be reached.';
  } finally {
    loading.value = false;
  }
  if (key.value === 'reports') void loadDeliverySummary();
}

function applyGrid() {
  offset.value = 0;
  void load();
}

function toggleSortDirection() {
  sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc';
  if (sortField.value) applyGrid();
}

function turnPage(direction: number) {
  const next = Math.max(0, offset.value + direction * limit.value);
  if (direction > 0 && offset.value + limit.value >= total.value) return;
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

async function sendMessage() {
  if (
    !sendSmscId.value ||
    !sendSender.value.trim() ||
    !sendReceiver.value.trim() ||
    !sendText.value.trim()
  )
    return;
  loading.value = true;
  error.value = '';
  try {
    await apiRequest('/messages', {
      method: 'POST',
      body: JSON.stringify({
        sender: sendSender.value.trim(),
        receiver: sendReceiver.value.trim(),
        text: sendText.value,
        smscId: sendSmscId.value,
      }),
    });
    showSendForm.value = false;
    sendSender.value = '';
    sendReceiver.value = '';
    sendText.value = '';
    sendSmscId.value = '';
    notice.value = 'Message submitted for delivery.';
    await load(true);
  } catch (reason) {
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

async function primaryAction() {
  const value = workspace.value;
  if (!value) return;
  if (!value.actionEndpoint) {
    await load();
    return;
  }
  if (value.creatable) {
    showComposer.value = true;
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
      payload = {
        name,
        engineId: name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-'),
        type: smscType.value,
        tps: smscTps.value,
        ...(smscType.value === 'fake' ? {} : { host: smscHost.value, port: smscPort.value }),
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

    if (value.createKind === 'configuration') {
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
    notice.value = `${value.noun} created.`;
    await load(true);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The operation failed.';
  } finally {
    loading.value = false;
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
    const params = new URLSearchParams();
    if (query.value.trim()) params.set('query', query.value.trim());
    if (state.value !== 'All') params.set('status', state.value);
    params.set('limit', '5000');
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

watch(query, (value) => {
  if (!grid.value) return;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (value === appliedSearch) return;
    offset.value = 0;
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
    deliverySummary.value = null;
    deliveryUnavailable.value = false;
    gridFilters.value = {};
    const defaultSort = workspace.value?.grid?.defaultSort ?? '';
    sortField.value = defaultSort.replace(/^-/, '');
    sortDirection.value = defaultSort.startsWith('-') ? 'desc' : 'asc';
    limit.value = 50;
    offset.value = 0;
    total.value = 0;
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
    <section class="toolbar panel" :class="{ 'grid-toolbar': Boolean(grid) }">
      <label class="filter-search">
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
      <label v-if="!grid" class="filter-select">
        <span>Status</span>
        <select v-model="state" data-testid="status-filter">
          <option v-for="option in states" :key="option">{{ option }}</option>
        </select>
      </label>
      <button
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

    <p v-if="notice" class="notice" role="status" data-testid="operation-success">{{ notice }}</p>

    <section v-if="error" class="panel empty-state" role="alert" data-testid="api-state">
      <h2>{{ unavailable ? 'Workspace API not available yet' : 'Unable to load workspace' }}</h2>
      <p>{{ error }}</p>
      <p v-if="unavailable">
        Expected endpoint: <code>GET {{ workspace.endpoint }}</code>
      </p>
      <button class="secondary-button" :disabled="loading" @click="load()">Retry</button>
    </section>

    <section v-if="showSendForm" class="panel composer" aria-label="Send message">
      <h2>Send message</h2>
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
        <input v-model="sendText" data-testid="send-text" placeholder="Message body" />
      </label>
      <div>
        <button
          class="primary-button"
          data-testid="send-submit"
          :disabled="
            loading || !sendSmscId || !sendSender.trim() || !sendReceiver.trim() || !sendText.trim()
          "
          @click="sendMessage"
        >
          Send
        </button>
        <button class="secondary-button" @click="showSendForm = false">Cancel</button>
      </div>
    </section>

    <section v-if="showComposer" class="panel composer" :aria-label="`Create ${workspace.noun}`">
      <h2>Create {{ workspace.noun }}</h2>
      <label>
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
        Target SMSC ID
        <input v-model="draftTarget" data-testid="draft-target" placeholder="UUID" />
      </label>
      <template v-if="workspace.createKind === 'route'">
        <label>
          Destination prefix
          <input v-model="routeDestinationPrefix" placeholder="+256" />
        </label>
        <label>
          Sender ID
          <input v-model="routeSender" placeholder="Optional sender match" />
        </label>
        <label>
          Fallback SMSC ID
          <input v-model="routeFallback" placeholder="Optional UUID" />
        </label>
        <p class="form-hint">
          Routes are validated and dry-run before deployment; duplicate priorities within a scope
          are rejected.
        </p>
      </template>

      <template v-if="workspace.createKind === 'smsc'">
        <label>
          Protocol
          <select v-model="smscType">
            <option value="fake">Fake SMSC</option>
            <option value="smpp">SMPP client</option>
            <option value="http">HTTP SMS</option>
            <option value="at">AT modem</option>
          </select>
        </label>
        <label v-if="smscType !== 'fake'">
          Host
          <input v-model="smscHost" />
        </label>
        <label v-if="smscType !== 'fake'">
          Port
          <input v-model.number="smscPort" type="number" min="1" max="65535" />
        </label>
        <label>
          TPS limit
          <input v-model.number="smscTps" type="number" min="1" max="100000" />
        </label>
        <p class="form-hint">
          Credentials use secret references; plaintext passwords are never stored here.
        </p>
      </template>

      <template v-if="workspace.createKind === 'configuration'">
        <label>
          Admin port
          <input v-model.number="configAdminPort" type="number" min="1" max="65535" />
        </label>
        <label>
          Bearerbox/SMSBox port
          <input v-model.number="configSmsboxPort" type="number" min="1" max="65535" />
        </label>
        <label class="checkbox-row">
          <input v-model="configSqlbox" type="checkbox" />
          Enable PostgreSQL SQLBox integration
        </label>
        <p class="form-hint">
          JKANNEL validates and renders deterministic Kamex configuration with environment-only
          secrets.
        </p>
      </template>

      <div>
        <button
          class="primary-button"
          data-testid="save-draft"
          :disabled="
            loading ||
            !draftName.trim() ||
            (workspace.createKind === 'route' && !draftTarget.trim()) ||
            (workspace.createKind === 'smsc' && smscType !== 'fake' && !smscHost.trim())
          "
          @click="createRecord"
        >
          Create
        </button>
        <button class="secondary-button" @click="showComposer = false">Cancel</button>
      </div>
    </section>

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

    <section v-if="!error" class="panel">
      <header class="panel-header">
        <div>
          <h2>{{ route.meta.title }}</h2>
          <p aria-live="polite">
            {{ loading ? 'Loading records…' : `${visibleRows.length} records shown` }}
          </p>
        </div>
      </header>
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
            <tr v-for="row in visibleRows" :key="row.id" :data-testid="`record-${row.id}`">
              <template v-if="columns">
                <td v-for="column in columns" :key="column.header" :class="{ mono: column.mono }">
                  {{ column.value(row.raw) }}
                </td>
              </template>
              <template v-else>
                <td>
                  <strong>{{ row.name }}</strong>
                  <small class="row-id">{{ row.id }}</small>
                </td>
                <td>{{ row.detail }}</td>
                <td>
                  <span class="status-badge">{{ row.status }}</span>
                </td>
                <td>{{ row.updated }}</td>
              </template>
              <td v-if="key === 'smsc'" class="row-actions">
                <button class="secondary-button" @click="rowAction(row, 'test')">Test</button>
                <button class="secondary-button" @click="rowAction(row, 'reconnect')">
                  Reconnect
                </button>
                <button
                  class="secondary-button"
                  @click="rowAction(row, row.status === 'disabled' ? 'enable' : 'disable')"
                >
                  {{ row.status === 'disabled' ? 'Enable' : 'Disable' }}
                </button>
              </td>
              <td v-else-if="key === 'routing'" class="row-actions">
                <button class="secondary-button" @click="rowAction(row, 'validate')">
                  Validate
                </button>
                <button class="secondary-button" @click="rowAction(row, 'deploy')">Deploy</button>
                <button class="secondary-button" @click="rowAction(row, 'rollback')">
                  Rollback
                </button>
              </td>
              <td v-else-if="key === 'configuration'" class="row-actions">
                <button class="secondary-button" @click="rowAction(row, 'validate')">
                  Validate
                </button>
                <button class="secondary-button" @click="rowAction(row, 'approve')">Approve</button>
                <button class="secondary-button" @click="rowAction(row, 'deploy')">Deploy</button>
                <button class="secondary-button" @click="rowAction(row, 'rollback')">
                  Rollback
                </button>
              </td>
              <td v-else-if="key === 'notifications'" class="row-actions">
                <button
                  v-if="!row.raw.read_at"
                  class="secondary-button"
                  :data-testid="`mark-read-${row.id}`"
                  @click="markNotificationRead(row)"
                >
                  Mark read
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
      <footer v-if="grid" class="pager">
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
            :disabled="loading || offset + limit >= total"
            @click="turnPage(1)"
          >
            Next
          </button>
        </div>
      </footer>
    </section>
  </section>
  <section v-else class="panel empty-state" data-testid="restricted-state">
    <h2>Access restricted</h2>
    <p>Your current role does not permit this workspace.</p>
  </section>
</template>
