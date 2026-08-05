<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { apiRequest, saveDownloadedFile } from '../api';
import AppIcon from '../components/AppIcon.vue';

/**
 * The in-console API reference.
 *
 * The backend already publishes `GET /api/v1/openapi.json`, derived at request
 * time from the controllers actually registered in the running application
 * (backend/src/platform/openapi-generator.ts). Until now nothing rendered it,
 * so the only way to read the API was to fetch the raw JSON.
 *
 * Why this renders the document by hand rather than embedding Swagger UI or
 * Redoc: this console ships four runtime dependencies (vue, vue-router and the
 * two tailwind packages) and is served from a strict origin with no CDN access,
 * so a renderer would have to be bundled locally. Swagger UI and Redoc are both
 * an order of magnitude larger than everything else in the bundle combined, and
 * neither knows what `x-required-permissions` means or that this document's
 * body schemas are deliberately generic. The document is small, we own the
 * styling, and the caveats are the most important thing on the page — so it is
 * rendered here, with zero new dependencies.
 *
 * The generator is explicit about what it cannot reflect (`x-generation.
 * limitations`). Those limits are surfaced as first-class content, both as a
 * standing panel and inline on the operations they actually affect, because the
 * dangerous failure mode of a generated reference is a reader concluding "no
 * body schema" means "takes no body".
 */

type LoadState = 'loading' | 'ok' | 'error';

interface SchemaLike {
  type?: string | string[];
  description?: string;
  properties?: Record<string, SchemaLike>;
  items?: SchemaLike;
  minimum?: number;
  minLength?: number;
  maxLength?: number;
  const?: unknown;
  $ref?: string;
}

interface ParameterObject {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: SchemaLike;
  $ref?: string;
}

interface MediaTypeObject {
  schema?: SchemaLike;
}

interface BodyObject {
  description?: string;
  required?: boolean;
  content?: Record<string, MediaTypeObject>;
}

interface ResponseObject {
  description?: string;
  content?: Record<string, MediaTypeObject>;
}

interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  security?: Record<string, unknown>[];
  parameters?: ParameterObject[];
  requestBody?: BodyObject;
  responses?: Record<string, ResponseObject>;
  'x-required-permissions'?: string[];
}

interface GenerationInfo {
  strategy?: string;
  routeCount?: number;
  derived?: string[];
  limitations?: string[];
}

interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  servers?: { url?: string; description?: string }[];
  'x-generation'?: GenerationInfo;
  components?: {
    parameters?: Record<string, ParameterObject>;
    schemas?: Record<string, SchemaLike>;
    headers?: Record<string, { description?: string; schema?: SchemaLike }>;
    securitySchemes?: Record<string, Record<string, unknown>>;
  };
  paths?: Record<string, Record<string, OperationObject>>;
}

/** A flattened operation: one row per method+path. */
interface Endpoint {
  id: string;
  method: string;
  path: string;
  summary: string;
  tag: string;
  operationId: string;
  secured: boolean;
  permissions: string[];
  parameters: ParameterObject[];
  /** Parameters that arrived as $ref into components.parameters. */
  sharedParameterNames: string[];
  requestBody?: BodyObject;
  responses: { status: string; description: string; schema?: SchemaLike }[];
  operation: OperationObject;
}

const METHOD_ORDER = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const HTTP_METHODS = new Set(METHOD_ORDER);

function text(value: unknown, fallback = '—') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}
function messageFrom(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}
/** Last segment of a local `#/components/x/Name` pointer. */
function refName(ref: string): string {
  return ref.split('/').filter(Boolean).pop() ?? ref;
}
function schemaLabel(schema?: SchemaLike): string {
  if (!schema) return 'unspecified';
  if (schema.$ref) return refName(schema.$ref);
  const type = Array.isArray(schema.type) ? schema.type.join(' | ') : schema.type;
  if (type === 'array') return `array of ${schemaLabel(schema.items)}`;
  if (schema.const !== undefined) return `const ${JSON.stringify(schema.const)}`;
  return type ?? 'unspecified';
}
/** True for `{ "type": "object" }` with nothing else — the generator's placeholder. */
function isOpaqueObject(schema?: SchemaLike): boolean {
  if (!schema) return false;
  if (schema.type !== 'object') return false;
  return !schema.properties && !schema.$ref;
}

// --- Document -----------------------------------------------------------------
const doc = ref<OpenApiDocument | null>(null);
const state = ref<LoadState>('loading');
const error = ref('');

const generation = computed<GenerationInfo>(() => doc.value?.['x-generation'] ?? {});
const limitations = computed(() => generation.value.limitations ?? []);
const derived = computed(() => generation.value.derived ?? []);
const serverUrl = computed(() => text(doc.value?.servers?.[0]?.url, '/api/v1'));
const securitySchemes = computed(() => doc.value?.components?.securitySchemes ?? {});
const sharedParameters = computed(() => doc.value?.components?.parameters ?? {});
const sharedSchemas = computed(() => doc.value?.components?.schemas ?? {});

function resolveParameter(param: ParameterObject): {
  resolved: ParameterObject;
  shared: string | null;
} {
  if (!param.$ref) return { resolved: param, shared: null };
  const name = refName(param.$ref);
  const target = sharedParameters.value[name];
  return { resolved: target ? { ...target } : { name, in: 'query' }, shared: name };
}

const endpoints = computed<Endpoint[]>(() => {
  const paths = doc.value?.paths ?? {};
  const rows: Endpoint[] = [];
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods ?? {})) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      const parameters: ParameterObject[] = [];
      const sharedParameterNames: string[] = [];
      for (const raw of operation.parameters ?? []) {
        const { resolved, shared } = resolveParameter(raw);
        parameters.push(resolved);
        if (shared) sharedParameterNames.push(shared);
      }
      const responses = Object.entries(operation.responses ?? {}).map(([status, response]) => ({
        status,
        description: text(response?.description, ''),
        schema: response?.content?.['application/json']?.schema,
      }));
      rows.push({
        id: operation.operationId || `${method}_${path}`,
        method: method.toLowerCase(),
        path,
        summary: text(operation.summary, ''),
        tag: operation.tags?.[0] ?? path.split('/').filter(Boolean)[0] ?? 'root',
        operationId: text(operation.operationId, ''),
        secured: Array.isArray(operation.security) && operation.security.length > 0,
        permissions: operation['x-required-permissions'] ?? [],
        parameters,
        sharedParameterNames,
        requestBody: operation.requestBody,
        responses,
        operation,
      });
    }
  }
  return rows.sort(
    (a, b) =>
      a.tag.localeCompare(b.tag) ||
      a.path.localeCompare(b.path) ||
      METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method),
  );
});

// --- Per-operation caveats ------------------------------------------------------
// Each caveat is derived from the document itself, never assumed, and each one
// exists because its absence would let a reader draw a false conclusion.
function caveatsFor(endpoint: Endpoint): string[] {
  const notes: string[] = [];
  const bodySchema = endpoint.requestBody?.content?.['application/json']?.schema;
  if (endpoint.requestBody && isOpaqueObject(bodySchema)) {
    notes.push(
      'The request body is declared as a generic object. This endpoint does take a JSON body, but its fields could not be reflected — the backend validates bodies imperatively rather than with DTO classes. Read the controller or the operator guide for the field list.',
    );
  }
  if (!endpoint.requestBody && ['post', 'put', 'patch'].includes(endpoint.method)) {
    notes.push(
      'No request body is declared. The generator records a body only when the handler binds one with @Body(), so treat this as "not reflected" rather than proof the endpoint accepts no payload.',
    );
  }
  if (endpoint.sharedParameterNames.length) {
    notes.push(
      'This is a grid list endpoint. The search / sort / filter / fields parameters below are the shared grid contract; the fields each one actually accepts are a per-resource whitelist that is not reflected here, and an unwhitelisted value is rejected or ignored rather than honoured.',
    );
  }
  if (endpoint.responses.every((response) => !response.schema)) {
    notes.push(
      'No response schema is reflected. Successful responses are the platform envelope ({ success, data }); failures use the ErrorEnvelope component schema.',
    );
  }
  if (!endpoint.secured && endpoint.permissions.length) {
    notes.push(
      'This operation requires permissions but declares no security scheme. The generator detects only the bearer AuthGuard by name, so API-key-guarded routes (the /gateway submission API) appear unauthenticated here. Read this as "auth not reflected", not "public".',
    );
  }
  return notes;
}

const anyBodyCaveat = computed(() =>
  endpoints.value.some((endpoint) => caveatsFor(endpoint).length > 0),
);

// --- Filters ---------------------------------------------------------------------
const search = ref('');
const activeMethods = ref<string[]>([]);
const permissionFilter = ref('');
const authFilter = ref('');
const selectedId = ref('');

const availableMethods = computed(() => {
  const found = new Set(endpoints.value.map((endpoint) => endpoint.method));
  return METHOD_ORDER.filter((method) => found.has(method));
});
const availablePermissions = computed(() =>
  [...new Set(endpoints.value.flatMap((endpoint) => endpoint.permissions))].sort(),
);

function toggleMethod(method: string) {
  activeMethods.value = activeMethods.value.includes(method)
    ? activeMethods.value.filter((entry) => entry !== method)
    : [...activeMethods.value, method];
}

const filtered = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return endpoints.value.filter((endpoint) => {
    if (activeMethods.value.length && !activeMethods.value.includes(endpoint.method)) return false;
    if (permissionFilter.value === '__none__' && endpoint.permissions.length) return false;
    if (
      permissionFilter.value &&
      permissionFilter.value !== '__none__' &&
      !endpoint.permissions.includes(permissionFilter.value)
    )
      return false;
    if (authFilter.value === 'bearer' && !endpoint.secured) return false;
    if (authFilter.value === 'open' && endpoint.secured) return false;
    if (!needle) return true;
    const haystack = [
      endpoint.path,
      endpoint.method,
      endpoint.summary,
      endpoint.operationId,
      endpoint.tag,
      ...endpoint.permissions,
      ...endpoint.parameters.map((param) => text(param.name, '')),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });
});

const groups = computed(() => {
  const byTag = new Map<string, Endpoint[]>();
  for (const endpoint of filtered.value) {
    const bucket = byTag.get(endpoint.tag);
    if (bucket) bucket.push(endpoint);
    else byTag.set(endpoint.tag, [endpoint]);
  }
  return [...byTag.entries()]
    .map(([tag, items]) => ({ tag, items }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
});

const collapsed = ref<Set<string>>(new Set());
function toggleGroup(tag: string) {
  const next = new Set(collapsed.value);
  if (next.has(tag)) next.delete(tag);
  else next.add(tag);
  collapsed.value = next;
}
const isCollapsed = (tag: string) => collapsed.value.has(tag);

const filtersActive = computed(
  () =>
    Boolean(search.value.trim()) ||
    activeMethods.value.length > 0 ||
    Boolean(permissionFilter.value) ||
    Boolean(authFilter.value),
);
function resetFilters() {
  search.value = '';
  activeMethods.value = [];
  permissionFilter.value = '';
  authFilter.value = '';
}

const selected = computed(
  () => endpoints.value.find((endpoint) => endpoint.id === selectedId.value) ?? null,
);
const selectedCaveats = computed(() => (selected.value ? caveatsFor(selected.value) : []));

// --- Deep links -------------------------------------------------------------------
// Every filter and the open operation live in the URL, so a link to
// "?op=MessagesController_list" or "?q=alerts&method=post" reopens exactly the
// same view. replace() rather than push() keeps the browser Back button useful.
const route = useRoute();
const router = useRouter();
let restoring = false;

function syncQuery() {
  if (restoring) return;
  const query: Record<string, string> = {};
  if (search.value.trim()) query.q = search.value.trim();
  if (activeMethods.value.length) query.method = activeMethods.value.join(',');
  if (permissionFilter.value) query.permission = permissionFilter.value;
  if (authFilter.value) query.auth = authFilter.value;
  if (selectedId.value) query.op = selectedId.value;
  void router.replace({ query });
}

function readQuery() {
  restoring = true;
  const single = (value: unknown) => (Array.isArray(value) ? (value[0] ?? '') : (value ?? ''));
  search.value = String(single(route.query.q) ?? '');
  const methods = String(single(route.query.method) ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => HTTP_METHODS.has(entry));
  activeMethods.value = methods;
  permissionFilter.value = String(single(route.query.permission) ?? '');
  authFilter.value = String(single(route.query.auth) ?? '');
  selectedId.value = String(single(route.query.op) ?? '');
  restoring = false;
}

watch([search, activeMethods, permissionFilter, authFilter, selectedId], syncQuery, { deep: true });

function selectEndpoint(endpoint: Endpoint) {
  selectedId.value = selectedId.value === endpoint.id ? '' : endpoint.id;
}

// --- Download ---------------------------------------------------------------------
const downloadNotice = ref('');
function downloadDocument() {
  if (!doc.value) return;
  const body = JSON.stringify(doc.value, null, 2);
  saveDownloadedFile(
    new Blob([body], { type: 'application/json' }),
    `jkannel-openapi-${text(doc.value.info?.version, '0')}.json`,
  );
  downloadNotice.value = 'Downloaded the document this page is rendering.';
}

async function load() {
  state.value = 'loading';
  try {
    // Public route: the document names no secrets, only the shape of the API.
    doc.value = await apiRequest<OpenApiDocument>('/openapi.json');
    error.value = '';
    state.value = 'ok';
    readQuery();
  } catch (reason) {
    doc.value = null;
    error.value = messageFrom(reason, 'The OpenAPI document could not be loaded.');
    state.value = 'error';
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="api-reference" data-testid="api-reference-view">
    <!-- Overview ------------------------------------------------------------- -->
    <section class="panel" data-testid="api-reference-overview" aria-label="API overview">
      <header class="panel-header">
        <div>
          <h2>{{ text(doc?.info?.title, 'JKANNEL API') }}</h2>
          <p aria-live="polite">
            {{
              state === 'loading'
                ? 'Loading the OpenAPI document…'
                : state === 'error'
                  ? 'The document could not be loaded.'
                  : `Version ${text(doc?.info?.version)} · OpenAPI ${text(doc?.openapi)} · ${endpoints.length} operations`
            }}
          </p>
        </div>
        <button
          class="primary-button"
          type="button"
          data-testid="api-reference-download"
          :disabled="state !== 'ok'"
          @click="downloadDocument"
        >
          Download OpenAPI<AppIcon name="db" :size="15" />
        </button>
      </header>

      <p
        v-if="state === 'error'"
        class="chart-empty"
        role="alert"
        data-testid="api-reference-error"
      >
        {{ error }}
      </p>
      <template v-else-if="state === 'ok'">
        <p>{{ text(doc?.info?.description, '') }}</p>
        <div class="summary-strip">
          <div class="metric">
            <strong data-testid="api-reference-count">{{ endpoints.length }}</strong>
            <small>Operations</small>
          </div>
          <div class="metric">
            <strong>{{ groups.length }}</strong>
            <small>Groups shown</small>
          </div>
          <div class="metric">
            <strong>{{ availablePermissions.length }}</strong>
            <small>Distinct permissions</small>
          </div>
          <div class="metric">
            <strong class="mono" data-testid="api-reference-server">{{ serverUrl }}</strong>
            <small>Base path</small>
          </div>
        </div>
        <p class="source-note" data-testid="api-reference-source">
          Served live from <span class="mono">GET {{ serverUrl }}/openapi.json</span>, which the
          backend derives at request time from the controllers actually registered in the running
          application — not from a hand-maintained file. Strategy:
          <span class="mono">{{ text(generation.strategy, 'unknown') }}</span
          >.
        </p>
        <p
          v-if="downloadNotice"
          class="notice"
          role="status"
          data-testid="api-reference-downloaded"
        >
          {{ downloadNotice }}
        </p>
      </template>
    </section>

    <!-- What is and is not reflected ------------------------------------------ -->
    <!--
      This panel is the reason the page can be trusted. A generated reference is
      only useful if the reader knows which parts are reflected from the running
      route table (and therefore cannot drift) and which parts the generator
      openly cannot see. The generator publishes both lists; both are rendered
      verbatim rather than paraphrased.
    -->
    <section
      v-if="state === 'ok'"
      class="panel"
      data-testid="api-reference-caveats"
      aria-label="Coverage and limitations"
    >
      <header class="panel-header">
        <div>
          <h2>What this document does and does not know</h2>
          <p>Published by the generator itself, under <span class="mono">x-generation</span>.</p>
        </div>
      </header>

      <div class="coverage-grid">
        <div>
          <h3>Reflected from the running routes</h3>
          <p class="source-note">
            These cannot drift: they are read from the same decorator metadata Nest uses to build
            its router, every time the document is requested.
          </p>
          <ul class="chip-list" data-testid="api-reference-derived">
            <li v-for="item in derived" :key="item" class="chip">{{ item }}</li>
            <li v-if="!derived.length" class="chip muted">not declared</li>
          </ul>
        </div>
        <div>
          <h3>Documented limitations</h3>
          <p class="source-note">
            Absence of detail below is a limit of the generator, not a statement about the endpoint.
          </p>
          <ul class="limitation-list" data-testid="api-reference-limitations">
            <li v-for="item in limitations" :key="item">{{ item }}</li>
            <li v-if="!limitations.length">The document declares no limitations.</li>
          </ul>
        </div>
      </div>

      <p v-if="anyBodyCaveat" class="warn-notice" data-testid="api-reference-body-warning">
        Read a missing body or response schema as <strong>“not reflected”</strong>, never as “this
        endpoint takes no body”. Bodies in this codebase are validated imperatively, so there is no
        DTO class for the generator to read. Each operation below repeats the caveat that applies to
        it.
      </p>
    </section>

    <!-- Authentication ---------------------------------------------------------- -->
    <section
      v-if="state === 'ok'"
      class="panel"
      data-testid="api-reference-auth"
      aria-label="Authentication"
    >
      <header class="panel-header">
        <div>
          <h2>Authenticating</h2>
          <p>Two credentials reach this API, and they are not interchangeable.</p>
        </div>
      </header>

      <div class="auth-grid">
        <div class="auth-card">
          <h3>Operator bearer token</h3>
          <p>
            Console and administrative routes — everything marked
            <span class="status-badge good">bearer</span> below. Sign in at
            <span class="mono">POST {{ serverUrl }}/auth/login</span>, then send the access token on
            every request. Refresh at <span class="mono">POST {{ serverUrl }}/auth/refresh</span>
            when it expires.
          </p>
          <pre class="json-block" data-testid="api-reference-bearer-sample">
curl -H "Authorization: Bearer $ACCESS_TOKEN" \
     {{ serverUrl }}/messages</pre>
          <p class="source-note">
            The permission column is enforced on top of the token: a valid token without the listed
            permission is rejected with 403, not 401.
          </p>
        </div>
        <div class="auth-card">
          <h3>Gateway API key</h3>
          <p>
            Machine submission routes under <span class="mono">{{ serverUrl }}/gateway</span> are
            authenticated by an API key issued on the API Gateway screen, not by a bearer token. The
            key carries its own scopes, per-key rate limit and IP allowlist.
          </p>
          <pre class="json-block" data-testid="api-reference-apikey-sample">
curl -H "X-API-Key: $JKANNEL_API_KEY" \
     -H "content-type: application/json" \
     -d '{"receiver":"+256700000000","text":"hello"}' \
     {{ serverUrl }}/gateway/messages</pre>
          <p class="source-note" data-testid="api-reference-apikey-caveat">
            <span class="mono">Authorization: ApiKey &lt;key&gt;</span> is accepted as an
            alternative. Note that the generator detects only the bearer guard by name, so
            key-authenticated routes are listed below without a bearer badge — that means “auth not
            reflected”, not “open to anyone”.
          </p>
        </div>
      </div>

      <p v-if="Object.keys(securitySchemes).length" class="source-note">
        Declared security schemes:
        <span class="mono">{{ Object.keys(securitySchemes).join(', ') }}</span>
      </p>
    </section>

    <!-- Endpoints ---------------------------------------------------------------- -->
    <section
      v-if="state === 'ok'"
      class="panel"
      data-testid="api-reference-endpoints"
      aria-label="Endpoints"
    >
      <header class="panel-header">
        <div>
          <h2>Endpoints</h2>
          <p aria-live="polite" data-testid="api-reference-result-count">
            {{ filtered.length }} of {{ endpoints.length }} operations
            {{ filtersActive ? 'match these filters' : 'in this API' }}
          </p>
        </div>
      </header>

      <div class="grid-toolbar">
        <label class="filter-select filter-search">
          <span>Search</span>
          <input
            v-model="search"
            data-testid="api-reference-search"
            type="search"
            placeholder="Path, summary, operation id, parameter or permission"
          />
        </label>
        <label class="filter-select">
          <span>Permission</span>
          <select v-model="permissionFilter" data-testid="api-reference-permission">
            <option value="">Any permission</option>
            <option value="__none__">No permission declared</option>
            <option
              v-for="permission in availablePermissions"
              :key="permission"
              :value="permission"
            >
              {{ permission }}
            </option>
          </select>
        </label>
        <label class="filter-select">
          <span>Auth</span>
          <select v-model="authFilter" data-testid="api-reference-auth-filter">
            <option value="">Any</option>
            <option value="bearer">Bearer required</option>
            <option value="open">No bearer declared</option>
          </select>
        </label>
        <button
          class="secondary-button"
          type="button"
          data-testid="api-reference-reset"
          :disabled="!filtersActive"
          @click="resetFilters"
        >
          Clear filters
        </button>
      </div>

      <div class="status-chips" role="group" aria-label="Filter by HTTP method">
        <button
          v-for="method in availableMethods"
          :key="method"
          type="button"
          :data-testid="`api-reference-method-${method}`"
          :aria-pressed="activeMethods.includes(method)"
          @click="toggleMethod(method)"
        >
          {{ method.toUpperCase() }}
        </button>
      </div>

      <p v-if="!filtered.length" class="chart-empty" data-testid="api-reference-empty">
        No operation matches these filters. Clear them to see all
        {{ endpoints.length }} operations.
      </p>

      <div v-for="group in groups" :key="group.tag" class="tag-group">
        <h3>
          <button
            type="button"
            class="column-sort"
            :data-testid="`api-reference-group-${group.tag}`"
            :aria-expanded="!isCollapsed(group.tag)"
            @click="toggleGroup(group.tag)"
          >
            <AppIcon name="chevron" :size="14" />
            /{{ group.tag }}
            <span class="preset-count">{{ group.items.length }}</span>
          </button>
        </h3>
        <div v-show="!isCollapsed(group.tag)" class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Method</th>
                <th scope="col">Path</th>
                <th scope="col">Summary</th>
                <th scope="col">Permission</th>
                <th scope="col">Auth</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="endpoint in group.items"
                :key="endpoint.id"
                :data-testid="`api-reference-row-${endpoint.id}`"
                :class="{ 'row-selected': endpoint.id === selectedId }"
              >
                <td>
                  <span class="method-badge" :class="`method-${endpoint.method}`">{{
                    endpoint.method.toUpperCase()
                  }}</span>
                </td>
                <td class="mono">
                  <button
                    type="button"
                    class="path-button"
                    :data-testid="`api-reference-open-${endpoint.id}`"
                    :aria-expanded="endpoint.id === selectedId"
                    @click="selectEndpoint(endpoint)"
                  >
                    {{ endpoint.path }}
                  </button>
                </td>
                <td>{{ endpoint.summary || '—' }}</td>
                <td>
                  <span v-if="!endpoint.permissions.length" class="cell-health">none declared</span>
                  <span
                    v-for="permission in endpoint.permissions"
                    :key="permission"
                    class="chip mono"
                    >{{ permission }}</span
                  >
                </td>
                <td>
                  <span v-if="endpoint.secured" class="status-badge good">bearer</span>
                  <span v-else class="status-badge muted">not reflected</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- Selected operation ---------------------------------------------------------- -->
    <section
      v-if="selected"
      class="panel detail-panel"
      data-testid="api-reference-detail"
      aria-label="Operation detail"
    >
      <header>
        <h2>
          <span class="method-badge" :class="`method-${selected.method}`">{{
            selected.method.toUpperCase()
          }}</span>
          <span class="mono">{{ selected.path }}</span>
        </h2>
        <button
          class="secondary-button"
          type="button"
          data-testid="api-reference-detail-close"
          @click="selectedId = ''"
        >
          Close
        </button>
      </header>

      <dl class="detail-grid">
        <dt>Summary</dt>
        <dd>{{ selected.summary || '—' }}</dd>
        <dt>Operation ID</dt>
        <dd class="mono">{{ selected.operationId || '—' }}</dd>
        <dt>Full URL</dt>
        <dd class="mono">{{ serverUrl }}{{ selected.path }}</dd>
        <dt>Group</dt>
        <dd class="mono">{{ selected.tag }}</dd>
        <dt>Bearer auth</dt>
        <dd data-testid="api-reference-detail-auth">
          <span v-if="selected.secured" class="status-badge good">required</span>
          <span v-else class="status-badge muted">not reflected</span>
        </dd>
        <dt>Permission required</dt>
        <dd data-testid="api-reference-detail-permissions">
          <template v-if="selected.permissions.length">
            <span v-for="permission in selected.permissions" :key="permission" class="chip mono">{{
              permission
            }}</span>
          </template>
          <span v-else class="cell-health">none declared</span>
        </dd>
      </dl>

      <p
        v-for="caveat in selectedCaveats"
        :key="caveat"
        class="warn-notice"
        data-testid="api-reference-detail-caveat"
      >
        {{ caveat }}
      </p>

      <h3>Parameters</h3>
      <div v-if="selected.parameters.length" class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">In</th>
              <th scope="col">Required</th>
              <th scope="col">Type</th>
              <th scope="col">Notes</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="param in selected.parameters"
              :key="`${param.in}-${param.name}`"
              :data-testid="`api-reference-param-${param.name}`"
            >
              <td class="mono">{{ text(param.name) }}</td>
              <td>{{ text(param.in) }}</td>
              <td>{{ param.required ? 'yes' : 'no' }}</td>
              <td class="mono">{{ schemaLabel(param.schema) }}</td>
              <td>{{ text(param.description, '—') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="source-note" data-testid="api-reference-no-params">
        No path, query or header parameter was reflected for this operation.
      </p>

      <h3>Request body</h3>
      <template v-if="selected.requestBody">
        <p class="source-note">
          Content type:
          <span class="mono">{{
            Object.keys(selected.requestBody.content ?? {}).join(', ') || 'application/json'
          }}</span>
        </p>
        <pre class="json-block" data-testid="api-reference-request-body">{{
          JSON.stringify(selected.requestBody.content?.['application/json']?.schema ?? {}, null, 2)
        }}</pre>
      </template>
      <p v-else class="source-note" data-testid="api-reference-no-body">
        No request body is declared for this operation.
      </p>

      <h3>Responses</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Status</th>
              <th scope="col">Description</th>
              <th scope="col">Schema</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="response in selected.responses"
              :key="response.status"
              :data-testid="`api-reference-response-${response.status}`"
            >
              <td class="mono">{{ response.status }}</td>
              <td>{{ response.description || '—' }}</td>
              <td class="mono">
                {{ response.schema ? schemaLabel(response.schema) : 'not reflected' }}
              </td>
            </tr>
            <tr v-if="!selected.responses.length">
              <td colspan="3" class="empty-cell">No response is declared for this operation.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Shared components ------------------------------------------------------------- -->
    <section
      v-if="state === 'ok' && Object.keys(sharedSchemas).length"
      class="panel"
      data-testid="api-reference-schemas"
      aria-label="Shared schemas"
    >
      <header class="panel-header">
        <div>
          <h2>Shared shapes</h2>
          <p>
            The envelopes every list and error response uses. These are the schemas the generator
            <em>can</em> describe.
          </p>
        </div>
      </header>
      <div
        v-for="(schema, name) in sharedSchemas"
        :key="name"
        :data-testid="`api-reference-schema-${name}`"
      >
        <h3 class="mono">{{ name }}</h3>
        <p v-if="schema.description" class="source-note">{{ schema.description }}</p>
        <pre class="json-block">{{ JSON.stringify(schema, null, 2) }}</pre>
      </div>
    </section>
  </div>
</template>

<style src="./workspace-extras.css"></style>

<style scoped>
.api-reference {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
}
.coverage-grid,
.auth-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 18px;
}
.coverage-grid h3,
.auth-grid h3 {
  margin: 0 0 4px;
  font-size: 13.5px;
  color: var(--text-strong);
}
.limitation-list {
  margin: 8px 0 0;
  padding-left: 18px;
  display: grid;
  gap: 8px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.6;
}
.auth-card p {
  font-size: 13px;
  line-height: 1.65;
}
.auth-card .json-block {
  white-space: pre-wrap;
  word-break: break-word;
}
.tag-group {
  margin-top: 18px;
}
.tag-group h3 {
  margin: 0 0 8px;
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}
.tag-group .column-sort[aria-expanded='false'] svg {
  transform: rotate(-90deg);
}
.tag-group .column-sort svg {
  transition: transform 0.15s ease;
}
.method-badge {
  display: inline-block;
  min-width: 58px;
  text-align: center;
  padding: 3px 8px;
  border-radius: 5px;
  border: 1px solid var(--border);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  font-family: ui-monospace, monospace;
  background: var(--surface-2);
  color: var(--muted);
}
/* Method colours are conveyed by the label text too, never by hue alone. */
.method-get {
  border-color: color-mix(in srgb, var(--brand) 55%, transparent);
  background: color-mix(in srgb, var(--brand) 14%, transparent);
  color: var(--brand);
}
.method-post {
  border-color: color-mix(in srgb, var(--good, #16a34a) 55%, transparent);
  background: color-mix(in srgb, var(--good, #16a34a) 14%, transparent);
  color: var(--good, #16a34a);
}
.method-put,
.method-patch {
  border-color: color-mix(in srgb, var(--warn, #d97706) 55%, transparent);
  background: color-mix(in srgb, var(--warn, #d97706) 14%, transparent);
  color: var(--warn, #d97706);
}
.method-delete {
  border-color: color-mix(in srgb, var(--bad, #dc2626) 55%, transparent);
  background: color-mix(in srgb, var(--bad, #dc2626) 14%, transparent);
  color: var(--bad, #dc2626);
}
.path-button {
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  color: var(--text-strong);
  text-align: left;
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--brand) 45%, transparent);
  text-underline-offset: 3px;
}
.path-button:hover,
.path-button:focus-visible {
  color: var(--brand);
}
.row-selected {
  background: color-mix(in srgb, var(--brand) 8%, transparent);
}
.detail-panel h2 {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.detail-panel h3 {
  margin: 18px 0 6px;
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}
.detail-grid dd .chip + .chip {
  margin-left: 6px;
}
</style>
