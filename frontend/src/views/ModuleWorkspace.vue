<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ApiError, apiDownloadFile, apiRequest, saveDownloadedFile } from '../api';
import { canAccess, session } from '../stores/session';
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
    columns: [
      { header: 'Label', value: (raw) => text(raw.label) },
      { header: 'Scope', value: (raw) => text(raw.scope) },
      { header: 'Kind', value: (raw) => text(raw.kind) },
      { header: 'Status', value: (raw) => text(raw.status) },
      { header: 'Size', value: (raw) => formatBytes(raw.size_bytes ?? raw.sizeBytes) },
      { header: 'Checksum', value: (raw) => text(raw.checksum), mono: true },
      { header: 'Started', value: (raw) => text(raw.started_at ?? raw.startedAt) },
      { header: 'Completed', value: (raw) => text(raw.completed_at ?? raw.completedAt) },
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

/* Honest "planned / unavailable" source handling (e.g. customers). */
const sourceUnavailable = ref(false);
const sourceMessage = ref('');

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
const editSmscName = ref('');
const editSmscHost = ref('');
const editSmscPort = ref(2775);
const editSmscTps = ref(10);
const editSmscEnabled = ref(true);

/* Cursor-paginated modules (queues, delivery reports). */
const cursorItems = ref<RecordValue[]>([]);
const cursorNext = ref<string | null>(null);
const cursorSummary = ref<RecordValue | null>(null);
const cursorSource = ref<RecordValue | string | null>(null);
const cursorCurrent = ref<string | null>(null);
const cursorHistory = ref<Array<string | null>>([]);
const dlrSmscId = ref('');

/* Runtime containers. */
const containers = ref<RecordValue[]>([]);
const containersObservedAt = ref('');

/* System settings. */
const settingItems = ref<RecordValue[]>([]);
const settingDrafts = ref<Record<string, string>>({});

/* API gateway one-time secret + client composer. */
const showApiClientForm = ref(false);
const apiClientName = ref('');
const apiClientScopes = ref('');
const revealedSecret = ref('');
const revealedSecretLabel = ref('');

/* Backup restore composer. */
const restoreRow = ref<Row | null>(null);
const restoreReason = ref('');

/* Backup create modal (label + scope). */
const showBackupModal = ref(false);
const backupLabel = ref('');
const backupScope = ref<'full' | 'database' | 'configurations'>('full');

/* Message trace drawer. */
const messageOpen = ref(false);
const messageLoading = ref(false);
const messageError = ref('');
const messageRow = ref<RecordValue | null>(null);
const messageTrace = ref<RecordValue | null>(null);

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
    key.value === 'notifications' ||
    key.value === 'plugins' ||
    key.value === 'backup' ||
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

const isQueue = computed(() => key.value === 'queues');
const isDlr = computed(() => key.value === 'delivery-reports');
const isCursor = computed(() => isQueue.value || isDlr.value);
const isDocker = computed(() => key.value === 'docker');
const isSystem = computed(() => key.value === 'system');
const customRender = computed(() => isCursor.value || isDocker.value || isSystem.value);
const detailModule = computed(
  () =>
    key.value === 'users' ||
    key.value === 'smsc' ||
    key.value === 'logs-audit' ||
    key.value === 'customers',
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

function detectUnavailableSource(payload: unknown) {
  if (!payload || typeof payload !== 'object') return;
  const source = (payload as RecordValue).source;
  if (source && typeof source === 'object' && (source as RecordValue).status === 'unavailable') {
    sourceUnavailable.value = true;
    sourceMessage.value = text(
      (source as RecordValue).message,
      'This module is planned and not yet available.',
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
  if (!preserveNotice) notice.value = '';
  appliedSearch = query.value;

  try {
    if (isCursor.value) {
      await loadCursorPage();
    } else if (isDocker.value) {
      await loadContainers();
    } else if (isSystem.value) {
      await loadSettings();
    } else {
      const path = grid.value
        ? `${workspace.value.endpoint}?${buildGridQuery().toString()}`
        : workspace.value.endpoint;
      const payload = await apiRequest<unknown>(path);
      const page = normalize(payload);
      rows.value = page.items;
      total.value = page.total;
      detectUnavailableSource(payload);
    }
  } catch (reason) {
    rows.value = [];
    total.value = 0;
    cursorItems.value = [];
    containers.value = [];
    settingItems.value = [];
    unavailable.value =
      reason instanceof ApiError && (reason.status === 404 || reason.status === 501);
    error.value = reason instanceof Error ? reason.message : 'The service could not be reached.';
  } finally {
    loading.value = false;
  }
  if (key.value === 'reports') void loadDeliverySummary();
}

async function loadCursorPage() {
  const endpoint = isDlr.value ? '/reports/delivery' : '/queues';
  const params = new URLSearchParams();
  if (query.value.trim()) params.set('query', query.value.trim());
  if (isDlr.value && dlrSmscId.value.trim()) params.set('smscId', dlrSmscId.value.trim());
  if (cursorCurrent.value) params.set('cursor', cursorCurrent.value);
  params.set('limit', '50');
  const payload = await apiRequest<RecordValue>(`${endpoint}?${params.toString()}`);
  cursorItems.value = Array.isArray(payload.items) ? (payload.items as RecordValue[]) : [];
  cursorNext.value = (payload.nextCursor as string | null) ?? null;
  cursorSummary.value = (payload.summary as RecordValue) ?? null;
  cursorSource.value = (payload.source as RecordValue | string) ?? null;
  detectUnavailableSource(payload);
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

const dlrColumns = [
  {
    label: 'Message ID',
    value: (raw: RecordValue) => text(raw.id ?? raw.message_id ?? raw.messageId, ''),
  },
  {
    label: 'Recipient',
    value: (raw: RecordValue) => text(raw.recipient ?? raw.receiver ?? raw.to, ''),
  },
  {
    label: 'Status',
    value: (raw: RecordValue) => text(raw.status ?? raw.dlr_status ?? raw.state, ''),
  },
  { label: 'SMSC', value: (raw: RecordValue) => text(raw.smsc ?? raw.smsc_id ?? raw.smscId, '') },
  {
    label: 'Timestamp',
    value: (raw: RecordValue) => text(raw.timestamp ?? raw.created_at ?? raw.updated_at, ''),
  },
];

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
            : `/audit-events/${row.id}`;
    const record = await apiRequest<RecordValue>(endpoint);
    detail.value = record;
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
      editSmscName.value = text(record.name, '') === '—' ? '' : String(record.name ?? '');
      editSmscHost.value = text(record.host, '') === '—' ? '' : String(record.host ?? '');
      editSmscPort.value = Number(record.port ?? 2775);
      editSmscTps.value = Number(record.tps ?? 10);
      editSmscEnabled.value = record.enabled === true || record.enabled === 'true';
    }
  } catch (reason) {
    detailError.value =
      reason instanceof Error ? reason.message : 'The record could not be loaded.';
  } finally {
    detailLoading.value = false;
  }
}
function closeDetail() {
  detailOpen.value = false;
  detail.value = null;
  editing.value = false;
}

const clickableRow = computed(
  () => detailModule.value || key.value === 'messages' || key.value === 'reports',
);
const messageTraceEvents = computed<RecordValue[]>(() => {
  const events = messageTrace.value?.events;
  return Array.isArray(events) ? (events as RecordValue[]) : [];
});
const snapshotRelated = computed<RecordValue[]>(() => {
  const related = snapshotDetail.value?.related;
  return Array.isArray(related) ? (related as RecordValue[]) : [];
});
function onRowClick(row: Row) {
  if (key.value === 'messages') void openMessageTrace(row);
  else if (key.value === 'reports') void openSnapshot(row);
  else if (detailModule.value) void openDetail(row);
}

async function openMessageTrace(row: Row) {
  if (key.value !== 'messages') return;
  messageOpen.value = true;
  messageLoading.value = true;
  messageError.value = '';
  messageRow.value = row.raw;
  messageTrace.value = null;
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
      body: JSON.stringify({
        name: editSmscName.value.trim(),
        host: editSmscHost.value.trim(),
        port: editSmscPort.value,
        tps: editSmscTps.value,
        enabled: editSmscEnabled.value,
      }),
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
}
async function submitBackup() {
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    await apiRequest('/backup-dr', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'full',
        retentionClass: 'manual',
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
    const result = await apiRequest<RecordValue>(`/backup-dr/${row.id}/verify`);
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
  apiClientScopes.value = '';
}
async function createApiClient() {
  if (!apiClientName.value.trim()) return;
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    const scopes = apiClientScopes.value
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean);
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
async function exportDlrCsv() {
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    const params = new URLSearchParams();
    if (query.value.trim()) params.set('query', query.value.trim());
    if (dlrSmscId.value.trim()) params.set('smscId', dlrSmscId.value.trim());
    params.set('limit', '5000');
    const exported = await apiDownloadFile(`/reports/delivery/export.csv?${params.toString()}`);
    saveDownloadedFile(exported.blob, exported.filename);
    notice.value = `Exported ${exported.headers.get('x-jkannel-export-row-count') ?? 'filtered'} delivery reports.`;
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
function applyDlrFilter() {
  resetCursor();
  void load();
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
  if (!grid.value && !isCursor.value) return;
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
    snapshotOpen.value = false;
    snapshotDetail.value = null;
    configBaseline.value = null;
    configPrefillContent.value = null;
    routeSmscOptions.value = [];
    routeSmscError.value = '';
    revealedSecret.value = '';
    restoreRow.value = null;
    restoreReason.value = '';
    dlrSmscId.value = '';
    deliverySummary.value = null;
    deliveryUnavailable.value = false;
    sourceUnavailable.value = false;
    sourceMessage.value = '';
    resetCursor();
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
        <button
          class="secondary-button"
          data-testid="export-backup-pdf"
          :disabled="loading"
          @click="exportSimple('/backup-dr/export', 'pdf')"
        >
          Export PDF
        </button>
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

    <section
      v-if="sourceUnavailable"
      class="panel help-box"
      role="status"
      data-testid="source-unavailable"
    >
      <h2>Planned — not yet available</h2>
      <p>{{ sourceMessage }}</p>
    </section>

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
      <ul>
        <li>
          <strong>Install</strong> the signed bundle, then <strong>validate</strong> its manifest.
        </li>
        <li>
          <strong>Enable</strong> to start receiving events; <strong>disable</strong> to pause it.
        </li>
        <li><strong>Uninstall</strong> to remove it entirely.</li>
        <li>Each plugin is limited to the permissions and events listed below.</li>
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
        <li>
          <strong>Authenticate</strong> by sending the key as a bearer token:
          <code>Authorization: Bearer &lt;client-key&gt;</code> against <code>{{ apiBaseUrl }}</code
          >.
        </li>
        <li>
          <strong>Scopes</strong> (for example <code>messages.send</code>,
          <code>reports.read</code>) restrict what each client may do.
        </li>
        <li>
          <strong>Rate limits</strong> are enforced per client per minute; exceeding them returns
          <code>429</code>.
        </li>
        <li>
          The full machine-readable reference is at
          <code>{{ openApiUrl }}</code> (OpenAPI 3).
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
          <strong>Lifecycle</strong>: install → validate → enable → disable → uninstall. Enabling
          starts event delivery; disabling pauses it without removing the plugin.
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

    <section
      v-if="showCreateUser"
      class="panel composer"
      aria-label="Create user"
      data-testid="create-user-form"
    >
      <h2>Create user</h2>
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
      <div>
        <button
          class="primary-button"
          data-testid="create-user-submit"
          :disabled="loading || !newUsername.trim() || newPassword.length < 12"
          @click="createUser"
        >
          Create user
        </button>
        <button class="secondary-button" @click="showCreateUser = false">Cancel</button>
      </div>
    </section>

    <section
      v-if="showApiClientForm"
      class="panel composer"
      aria-label="Create API client"
      data-testid="api-client-form"
    >
      <h2>Create API client</h2>
      <label>
        Name
        <input v-model="apiClientName" data-testid="api-client-name" />
      </label>
      <label>
        Scopes (comma-separated)
        <input
          v-model="apiClientScopes"
          data-testid="api-client-scopes"
          placeholder="messages.read, messages.send"
        />
      </label>
      <div>
        <button
          class="primary-button"
          data-testid="api-client-submit"
          :disabled="loading || !apiClientName.trim()"
          @click="createApiClient"
        >
          Create client
        </button>
        <button class="secondary-button" @click="showApiClientForm = false">Cancel</button>
      </div>
    </section>

    <section
      v-if="restoreRow"
      class="panel composer"
      aria-label="Restore backup"
      data-testid="restore-form"
    >
      <h2>Restore from {{ restoreRow.name }}</h2>
      <p class="form-hint">
        The backup is restored into an isolated verify database, not the live system. Provide a
        reason for the audit trail.
      </p>
      <label>
        Reason
        <input v-model="restoreReason" data-testid="restore-reason" />
      </label>
      <div>
        <button
          class="primary-button danger-button"
          data-testid="restore-submit"
          :disabled="loading || !restoreReason.trim()"
          @click="confirmRestore"
        >
          Request restore
        </button>
        <button class="secondary-button" @click="restoreRow = null">Cancel</button>
      </div>
    </section>

    <section
      v-if="showBackupModal"
      class="panel composer backup-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Create backup"
      data-testid="backup-modal"
    >
      <h2>Create backup</h2>
      <label>
        Backup name (label)
        <input
          v-model="backupLabel"
          data-testid="backup-label"
          placeholder="e.g. pre-upgrade snapshot"
        />
      </label>
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
      <div>
        <button
          class="primary-button"
          data-testid="backup-submit"
          :disabled="loading"
          @click="submitBackup"
        >
          Create backup
        </button>
        <button class="secondary-button" @click="showBackupModal = false">Cancel</button>
      </div>
    </section>

    <section
      v-if="showCreateCustomer"
      class="panel composer"
      aria-label="Create customer"
      data-testid="create-customer-form"
    >
      <h2>Create customer</h2>
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
        <input v-model.number="custQuotaDaily" type="number" min="0" data-testid="customer-quota" />
      </label>
      <label>
        Rate limit / min
        <input v-model.number="custRateLimit" type="number" min="0" data-testid="customer-rate" />
      </label>
      <label>
        Allowed sender IDs (comma-separated)
        <input v-model="custSenderIds" data-testid="customer-senders" placeholder="JKANNEL, INFO" />
      </label>
      <label>
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
      <div>
        <button
          class="primary-button"
          data-testid="customer-submit"
          :disabled="loading || !custName.trim()"
          @click="createCustomer"
        >
          Create customer
        </button>
        <button class="secondary-button" @click="showCreateCustomer = false">Cancel</button>
      </div>
    </section>

    <section
      v-if="messageOpen"
      class="panel detail-panel"
      data-testid="message-trace-panel"
      aria-label="Message trace"
    >
      <header>
        <h2>Message trace</h2>
        <button
          class="secondary-button"
          data-testid="message-trace-close"
          @click="closeMessageTrace"
        >
          Close
        </button>
      </header>
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
          <dd>{{ text(messageRow.created_at ?? messageRow.createdAt ?? messageRow.timestamp) }}</dd>
          <dt>Updated</dt>
          <dd>{{ text(messageRow.updated_at ?? messageRow.updatedAt) }}</dd>
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
      </template>
    </section>

    <section
      v-if="snapshotOpen"
      class="panel detail-panel"
      data-testid="snapshot-panel"
      aria-label="Volume snapshot detail"
    >
      <header>
        <h2>Volume snapshot detail</h2>
        <button class="secondary-button" data-testid="snapshot-close" @click="closeSnapshot">
          Close
        </button>
      </header>
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
            {{ text(item.message_count ?? item.messageCount ?? item.messages ?? item.total, '0') }}
            messages
            <small>{{ text(item.dlr_count ?? item.dlrCount ?? item.dlrs, '') }}</small>
          </li>
          <li v-if="!snapshotRelated.length">No related breakdown for this period.</li>
        </ul>
      </template>
    </section>

    <section v-if="detailOpen" class="panel detail-panel" data-testid="detail-panel">
      <header>
        <h2>
          {{
            key === 'users'
              ? 'User detail'
              : key === 'smsc'
                ? 'SMSC detail'
                : key === 'customers'
                  ? 'Customer detail'
                  : 'Audit event'
          }}
        </h2>
        <button class="secondary-button" data-testid="detail-close" @click="closeDetail">
          Close
        </button>
      </header>
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
              <p v-if="!roleOptions.length" class="form-hint">No roles are available to assign.</p>
            </fieldset>
            <label>
              Reset password (optional, min 12)
              <input v-model="editUserPassword" type="password" data-testid="user-reset-password" />
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
            <button
              class="secondary-button danger-button"
              data-testid="smsc-archive"
              @click="archiveSmsc"
            >
              Delete / Archive
            </button>
          </div>
          <div v-if="canManageSystem && editing" class="composer" data-testid="smsc-edit-form">
            <label>
              Name
              <input v-model="editSmscName" data-testid="smsc-edit-name" />
            </label>
            <label>
              Host
              <input v-model="editSmscHost" data-testid="smsc-edit-host" />
            </label>
            <label>
              Port
              <input v-model.number="editSmscPort" type="number" data-testid="smsc-edit-port" />
            </label>
            <label>
              TPS
              <input v-model.number="editSmscTps" type="number" data-testid="smsc-edit-tps" />
            </label>
            <label class="checkbox-row">
              <input v-model="editSmscEnabled" type="checkbox" data-testid="smsc-edit-enabled" />
              Enabled
            </label>
            <div>
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
          <div v-if="canManageSystem && !editing" class="detail-actions">
            <button class="secondary-button" data-testid="customer-edit" @click="editing = true">
              Edit
            </button>
            <button
              class="secondary-button danger-button"
              data-testid="customer-archive"
              @click="archiveCustomer"
            >
              Archive
            </button>
          </div>
          <div v-if="canManageSystem && editing" class="composer" data-testid="customer-edit-form">
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
        Target SMSC
        <select v-model="draftTarget" data-testid="draft-target">
          <option value="" disabled>Select a target SMSC</option>
          <option v-for="option in routeSmscOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <template v-if="workspace.createKind === 'route'">
        <p v-if="routeSmscError" class="form-hint" role="alert" data-testid="route-smsc-error">
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
        <div v-if="configBaseline" class="baseline-info" data-testid="configuration-baseline-info">
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
          <label class="checkbox-row">
            <input v-model="configSqlbox" type="checkbox" />
            Enable PostgreSQL SQLBox integration
          </label>
          <p class="form-hint">
            JKANNEL validates and renders deterministic Kamex configuration with environment-only
            secrets.
          </p>
        </template>
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

    <section v-if="!error && !customRender" class="panel">
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
            <tr
              v-for="row in visibleRows"
              :key="row.id"
              :data-testid="`record-${row.id}`"
              :class="{ 'clickable-row': clickableRow }"
              @click="onRowClick(row)"
            >
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
              <td v-if="key === 'smsc'" class="row-actions" @click.stop>
                <button class="secondary-button" @click="testSmsc(row)">Test</button>
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
              <td v-else-if="key === 'plugins'" class="row-actions">
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
              <td :colspan="queueColumns.length" class="empty-cell">No queued messages.</td>
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
      <div class="summary-strip">
        <div class="metric">
          <strong data-testid="dlr-total">{{ (cursorSummary?.total as number) ?? 0 }}</strong>
          <small>Delivery receipts</small>
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
              <th v-for="column in dlrColumns" :key="column.label" scope="col">
                {{ column.label }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(item, index) in cursorItems"
              :key="String(item.id ?? index)"
              :data-testid="`dlr-row-${index}`"
            >
              <td v-for="column in dlrColumns" :key="column.label">{{ column.value(item) }}</td>
            </tr>
            <tr v-if="!loading && !cursorItems.length">
              <td :colspan="dlrColumns.length" class="empty-cell">No delivery reports.</td>
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
        <p v-if="!loading && !containers.length" class="empty-cell">No containers reported.</p>
      </div>
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
  </section>
  <section v-else class="panel empty-state" data-testid="restricted-state">
    <h2>Access restricted</h2>
    <p>Your current role does not permit this workspace.</p>
  </section>
</template>
