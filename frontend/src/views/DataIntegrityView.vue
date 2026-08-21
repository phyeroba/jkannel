<script setup lang="ts">
/**
 * DATA INTEGRITY — is the audit trail intact, and what is retention doing.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `DataModelController` has eight operations and none had a surface. Two of
 * them matter more than the rest: the audit trail carries a tamper-evidence
 * chain, and nothing in the console could verify it. An audit trail nobody can
 * check is a record you are asked to take on trust, which is the opposite of
 * what it is for.
 *
 * WHAT "VERIFIED" MEANS HERE, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 * The chain proves that no entry has been altered or removed BETWEEN the
 * entries either side of it. It cannot prove that an action was audited in the
 * first place — an actor with database access who never wrote an entry leaves a
 * chain that verifies perfectly. The screen says so, because "verified" on its
 * own invites the stronger reading.
 *
 * Backend contract:
 *   GET  /data-model/audit-chain/verify   (system.view)
 *   GET  /data-model/retention
 *   POST /data-model/retention/run        (system.manage)
 *   GET/POST/PATCH/DELETE /data-model/records
 */
import { computed, onMounted, ref } from 'vue';
import { ApiError, apiRequest } from '../api';
import DataState from '../components/DataState.vue';
import { canAccess, session } from '../stores/session';
import { type DataState as State } from '../utils/data-state';
import { formatMoment } from '../utils/connectivity';

type RecordValue = Record<string, unknown>;

const canManage = computed(() => canAccess(session.value, 'system.manage'));

function text(value: unknown, fallback = '—') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}
function messageFrom(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}
function stateFor(cause: unknown): State {
  return cause instanceof ApiError && cause.status === 403 ? 'permission-denied' : 'error';
}
function asItems(payload: unknown): RecordValue[] {
  const source = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as RecordValue).items)
      ? ((payload as RecordValue).items as unknown[])
      : [];
  return source.filter((item): item is RecordValue => Boolean(item) && typeof item === 'object');
}

// --- Audit chain ----------------------------------------------------------------
const chain = ref<RecordValue | null>(null);
const chainState = ref<State>('empty');
const chainError = ref('');

async function verifyChain() {
  chainState.value = 'loading';
  chainError.value = '';
  try {
    chain.value = await apiRequest<RecordValue>('/data-model/audit-chain/verify');
    chainState.value = 'live';
  } catch (cause) {
    chain.value = null;
    chainError.value = messageFrom(cause, 'The audit chain could not be verified.');
    chainState.value = stateFor(cause);
  }
}

/**
 * The verdict, read from the response rather than inferred from its absence.
 *
 * `null` when the endpoint answered in a shape this build does not recognise —
 * which must NOT render as "intact". An unrecognised answer about tamper
 * evidence is the one case where silence has to look like a problem.
 */
const chainIntact = computed<boolean | null>(() => {
  const result = chain.value;
  if (!result) return null;
  if (typeof result.valid === 'boolean') return result.valid;
  if (typeof result.intact === 'boolean') return result.intact;
  if (typeof result.ok === 'boolean') return result.ok;
  const broken = result.brokenAt ?? result.broken_at ?? result.firstBrokenId;
  if (broken !== undefined) return !broken;
  return null;
});

// --- Retention -------------------------------------------------------------------
const retention = ref<RecordValue | null>(null);
const retentionRows = ref<RecordValue[]>([]);
const retentionState = ref<State>('loading');
const retentionError = ref('');
const retentionBusy = ref(false);
const retentionNotice = ref('');

async function loadRetention() {
  retentionState.value = 'loading';
  try {
    const payload = await apiRequest<RecordValue>('/data-model/retention');
    retention.value = payload;
    retentionRows.value = asItems(payload?.tables ?? payload?.items ?? payload);
    retentionError.value = '';
    retentionState.value = retentionRows.value.length ? 'live' : 'empty';
  } catch (cause) {
    retention.value = null;
    retentionRows.value = [];
    retentionError.value = messageFrom(cause, 'Retention status could not be read.');
    retentionState.value = stateFor(cause);
  }
}

async function runRetention() {
  retentionBusy.value = true;
  retentionError.value = '';
  retentionNotice.value = '';
  try {
    const result = await apiRequest<RecordValue>('/data-model/retention/run', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    // The job's own counts. "Archived 0, pruned 0" is a real answer — nothing
    // was old enough — and reads differently from the job not having run.
    retentionNotice.value = `Retention ran. ${text(result?.archived, '0')} archived, ${text(
      result?.pruned ?? result?.deleted,
      '0',
    )} pruned.`;
    await loadRetention();
  } catch (cause) {
    retentionError.value = messageFrom(cause, 'Retention could not be run.');
  } finally {
    retentionBusy.value = false;
  }
}

// --- Reference records ------------------------------------------------------------
const records = ref<RecordValue[]>([]);
const recordState = ref<State>('loading');
const recordError = ref('');
const recordBusy = ref('');
const draftKey = ref('');
const draftValue = ref('{}');

async function loadRecords() {
  recordState.value = 'loading';
  try {
    records.value = asItems(await apiRequest('/data-model/records'));
    recordError.value = '';
    recordState.value = records.value.length ? 'live' : 'empty';
  } catch (cause) {
    records.value = [];
    recordError.value = messageFrom(cause, 'Reference records could not be read.');
    recordState.value = stateFor(cause);
  }
}

function parseValue(): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(draftValue.value || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function createRecord() {
  const key = draftKey.value.trim();
  if (!key) {
    recordError.value = 'Enter a key.';
    return;
  }
  const value = parseValue();
  if (!value) {
    recordError.value = 'The value must be a JSON object, for example {"note":"example"}.';
    return;
  }
  recordBusy.value = 'new';
  recordError.value = '';
  try {
    await apiRequest('/data-model/records', {
      method: 'POST',
      body: JSON.stringify({ key, value }),
    });
    draftKey.value = '';
    draftValue.value = '{}';
    await loadRecords();
  } catch (cause) {
    recordError.value = messageFrom(cause, 'The record could not be created.');
  } finally {
    recordBusy.value = '';
  }
}

/**
 * Updates carry the version the operator was looking at.
 *
 * That is the whole point of the optimistic lock: if somebody else changed the
 * row since this page loaded, the API refuses rather than overwriting their
 * change, and the message below says which happened instead of retrying
 * silently.
 */
async function updateRecord(row: RecordValue) {
  const id = text(row.id, '');
  if (!id || id === '—') return;
  const value = parseValue();
  if (!value) {
    recordError.value = 'The value must be a JSON object before it can be applied.';
    return;
  }
  recordBusy.value = id;
  recordError.value = '';
  try {
    await apiRequest(`/data-model/records/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ expectedVersion: Number(row.version ?? 0), value }),
    });
    await loadRecords();
  } catch (cause) {
    recordError.value =
      cause instanceof ApiError && cause.status === 409
        ? 'Somebody else changed this record since the page loaded, so it was not overwritten. Reload and reapply your change.'
        : messageFrom(cause, 'The record could not be updated.');
    await loadRecords();
  } finally {
    recordBusy.value = '';
  }
}

async function removeRecord(id: string) {
  recordBusy.value = id;
  recordError.value = '';
  try {
    await apiRequest(`/data-model/records/${id}`, { method: 'DELETE' });
    await loadRecords();
  } catch (cause) {
    recordError.value = messageFrom(cause, 'The record could not be removed.');
  } finally {
    recordBusy.value = '';
  }
}

onMounted(() => {
  void loadRetention();
  void loadRecords();
});
</script>

<template>
  <div data-testid="data-integrity-view">
    <!-- AUDIT CHAIN -------------------------------------------------------- -->
    <section class="panel" data-testid="audit-chain" aria-labelledby="audit-chain-heading">
      <header class="panel-header">
        <div>
          <h2 id="audit-chain-heading">Audit chain</h2>
          <p>
            Every audit entry is signed against the one before it. Verifying walks that chain and
            reports the first place it breaks.
          </p>
        </div>
        <button
          class="primary-button"
          type="button"
          :disabled="chainState === 'loading'"
          data-testid="audit-verify"
          @click="verifyChain"
        >
          {{ chainState === 'loading' ? 'Verifying…' : 'Verify now' }}
        </button>
      </header>

      <p v-if="chainError" class="form-error" role="alert" data-testid="audit-error">
        {{ chainError }}
      </p>

      <template v-else-if="chain">
        <p
          class="notice"
          role="status"
          :class="chainIntact === false ? 'broken' : chainIntact === null ? 'unclear' : ''"
          data-testid="audit-verdict"
        >
          <strong>{{
            chainIntact === true
              ? 'The chain verifies.'
              : chainIntact === false
                ? 'The chain is BROKEN.'
                : 'The verifier answered in a form this console does not recognise.'
          }}</strong>
          {{ text(chain.detail ?? chain.message, '') }}
        </p>
        <details data-testid="audit-raw">
          <summary>The verifier's full answer</summary>
          <pre class="json-block">{{ JSON.stringify(chain, null, 2) }}</pre>
        </details>
      </template>

      <p v-else class="chart-empty" data-testid="audit-idle">
        Not verified in this session. Verification walks the whole trail, so it is asked for rather
        than run on arrival.
      </p>

      <!--
        The limit of the guarantee, stated where the verdict is read. "Verified"
        alone invites the stronger reading, and the stronger reading is wrong.
      -->
      <p class="source-note" data-testid="audit-caveat">
        A verifying chain proves no entry has been altered or removed between the entries either
        side of it. It does <strong>not</strong> prove that an action was audited at all — someone
        with direct database access who never wrote an entry leaves a chain that verifies
        perfectly. This is tamper evidence, not proof of completeness.
      </p>
    </section>

    <!-- RETENTION ---------------------------------------------------------- -->
    <section class="panel" data-testid="retention" aria-labelledby="retention-heading">
      <header class="panel-header">
        <div>
          <h2 id="retention-heading">Retention</h2>
          <p>What is archived and pruned, per source table, and when it last ran.</p>
        </div>
        <button
          v-if="canManage"
          class="secondary-button"
          type="button"
          :disabled="retentionBusy"
          data-testid="retention-run"
          @click="runRetention"
        >
          {{ retentionBusy ? 'Running…' : 'Run now' }}
        </button>
      </header>

      <p v-if="retentionNotice" class="notice" role="status" data-testid="retention-notice">
        {{ retentionNotice }}
      </p>
      <p v-if="retentionError" class="form-error" role="alert" data-testid="retention-error">
        {{ retentionError }}
      </p>

      <DataState
        :state="retentionState"
        subject="retention status"
        skeleton="table"
        :skeleton-rows="3"
        :detail="
          retentionState === 'empty'
            ? 'No table is under retention management. Nothing is being archived or pruned by this job.'
            : undefined
        "
        permission="system.view"
        testid="retention-state"
        :on-retry="loadRetention"
      >
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Table</th>
                <th scope="col">Keeps</th>
                <th scope="col">Rows</th>
                <th scope="col">Eligible</th>
                <th scope="col">Last run</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in retentionRows"
                :key="text(row.table ?? row.source_table ?? row.name)"
                :data-testid="`retention-${text(row.table ?? row.source_table ?? row.name)}`"
              >
                <td class="mono">{{ text(row.table ?? row.source_table ?? row.name) }}</td>
                <td class="mono">
                  {{ text(row.retentionDays ?? row.retention_days ?? row.keepDays, 'not set') }}
                </td>
                <td class="mono">{{ text(row.rows ?? row.total, 'unknown') }}</td>
                <td class="mono">{{ text(row.eligible ?? row.expired, 'unknown') }}</td>
                <td class="mono cell-tight">
                  {{
                    row.lastRunAt || row.last_run_at
                      ? formatMoment(text(row.lastRunAt ?? row.last_run_at, ''))
                      : 'never run'
                  }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </DataState>

      <p v-if="!canManage" class="source-note" data-testid="retention-readonly">
        Running retention needs <span class="mono">system.manage</span>. It deletes rows, so it is
        gated with the permission that changes the platform rather than the one that reads it.
      </p>
    </section>

    <!-- REFERENCE RECORDS --------------------------------------------------- -->
    <section class="panel" data-testid="records" aria-labelledby="records-heading">
      <header class="panel-header">
        <div>
          <h2 id="records-heading">Reference records</h2>
          <p>
            A small key/value table that demonstrates the platform's soft-delete and
            optimistic-locking conventions. Editing one here exercises the same version check every
            other record in the system uses.
          </p>
        </div>
      </header>

      <p v-if="recordError" class="form-error" role="alert" data-testid="records-error">
        {{ recordError }}
      </p>

      <DataState
        :state="recordState"
        subject="reference records"
        skeleton="table"
        :skeleton-rows="3"
        :detail="recordState === 'empty' ? 'No reference record exists.' : undefined"
        permission="system.view"
        testid="records-state"
        :on-retry="loadRecords"
      >
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Value</th>
                <th scope="col">Version</th>
                <th scope="col">Updated</th>
                <th v-if="canManage" scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in records"
                :key="text(row.id)"
                :data-testid="`record-${text(row.id)}`"
              >
                <td class="mono">{{ text(row.key) }}</td>
                <td class="mono cell-tight">{{ JSON.stringify(row.value ?? {}) }}</td>
                <td class="mono">{{ text(row.version) }}</td>
                <td class="mono cell-tight">
                  {{ formatMoment(text(row.updated_at ?? row.updatedAt, '')) }}
                </td>
                <td v-if="canManage" class="row-actions">
                  <button
                    class="secondary-button"
                    type="button"
                    :disabled="Boolean(recordBusy)"
                    :data-testid="`record-apply-${text(row.id)}`"
                    @click="updateRecord(row)"
                  >
                    Apply value below
                  </button>
                  <button
                    class="secondary-button danger-button"
                    type="button"
                    :disabled="Boolean(recordBusy)"
                    :data-testid="`record-remove-${text(row.id)}`"
                    @click="removeRecord(text(row.id, ''))"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </DataState>

      <div v-if="canManage" class="field-grid" data-testid="record-form">
        <label class="filter-select">
          <span>Key</span>
          <input v-model="draftKey" type="text" data-testid="record-key" />
        </label>
        <label class="filter-select filter-search">
          <span>Value (JSON object)</span>
          <input v-model="draftValue" type="text" data-testid="record-value" />
        </label>
        <button
          class="primary-button"
          type="button"
          :disabled="Boolean(recordBusy)"
          data-testid="record-create"
          @click="createRecord"
        >
          Create
        </button>
      </div>
      <p v-if="canManage" class="source-note">
        “Apply value below” sends the version the row was rendered at. If somebody else changed it
        in the meantime the API refuses rather than overwriting them, and this screen says so — it
        does not retry silently.
      </p>
    </section>
  </div>
</template>

<style scoped>
.field-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  align-items: end;
  margin-top: 12px;
}
.notice.broken {
  border-left: 3px solid var(--bad);
  color: var(--bad);
}
.notice.unclear {
  border-left: 3px solid var(--warn);
  color: var(--warn);
}
.cell-tight {
  font-size: 12.5px;
}
details summary {
  cursor: pointer;
  color: var(--brand);
  font-size: 13px;
  margin-top: 10px;
}
</style>
<style src="./workspace-extras.css"></style>
