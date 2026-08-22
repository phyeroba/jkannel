<script setup lang="ts">
/**
 * RECIPIENT POLICY — the blacklist, whitelist and DND list the send path
 * evaluates before it chooses a route.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `MessagingPolicyController` has four operations and none had a surface. The
 * send path has been consulting these lists since migration 032, so a number
 * could be silently blocked with no screen anywhere that would say so — the
 * message simply did not arrive and the trace said it was never submitted.
 *
 * THE CHECK IS THE POINT
 * ---------------------------------------------------------------------------
 * "Would this number be accepted right now, and if not why" is the question
 * support actually arrives with, and `GET check` answers it against the same
 * evaluation the send path runs. Reading the list by eye cannot: an entry can
 * be scoped to one customer, or expired, and either makes a number that appears
 * on the list perfectly sendable.
 *
 * THREE LISTS, NOT ONE
 * ---------------------------------------------------------------------------
 * They are not synonyms and the screen refuses to blur them. A blacklist entry
 * refuses a number. A whitelist, once any entry exists, refuses everything NOT
 * on it. DND is a regulatory refusal and is the one nobody may quietly bypass.
 *
 * Backend contract:
 *   GET    /messaging/blocklist?listType&customerId   (messages.view)
 *   GET    /messaging/blocklist/check?msisdn&customerId
 *   POST   /messaging/blocklist                        (messages.send)
 *   DELETE /messaging/blocklist/:id
 */
import { computed, onMounted, ref } from 'vue';
import { ApiError, apiRequest } from '../api';
import DataState from '../components/DataState.vue';
import ModalDialog from '../components/ModalDialog.vue';
import { canAccess, session } from '../stores/session';
import { type DataState as State } from '../utils/data-state';
import { formatMoment } from '../utils/connectivity';

type RecordValue = Record<string, unknown>;

const LIST_TYPES = ['blacklist', 'whitelist', 'dnd'] as const;

/** What each list DOES, in the send path's terms rather than in the abstract. */
const LIST_MEANING: Record<string, string> = {
  blacklist: 'Refuses this destination. Everything else is unaffected.',
  whitelist:
    'Once ANY whitelist entry exists, every destination not on it is refused. Adding one entry is therefore a decision about the whole estate, not about one number.',
  dnd: 'A regulatory refusal. It is not a preference and it is not bypassed by a whitelist.',
};

const canManage = computed(() => canAccess(session.value, 'messages.send'));

function text(value: unknown, fallback = '—') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}
function messageFrom(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}
function asItems(payload: unknown): RecordValue[] {
  const source = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as RecordValue).items)
      ? ((payload as RecordValue).items as unknown[])
      : [];
  return source.filter((item): item is RecordValue => Boolean(item) && typeof item === 'object');
}

// --- The list ------------------------------------------------------------------
const entries = ref<RecordValue[]>([]);
const listState = ref<State>('loading');
const listError = ref('');
const filterType = ref('');
const busy = ref('');

async function loadEntries() {
  listState.value = 'loading';
  const params = new URLSearchParams({ limit: '200', offset: '0' });
  if (filterType.value) params.set('listType', filterType.value);
  try {
    entries.value = asItems(await apiRequest(`/messaging/blocklist?${params.toString()}`));
    listError.value = '';
    listState.value = entries.value.length ? 'live' : 'empty';
  } catch (cause) {
    entries.value = [];
    listError.value = messageFrom(cause, 'The recipient policy could not be read.');
    listState.value =
      cause instanceof ApiError && cause.status === 403 ? 'permission-denied' : 'error';
  }
}

/** Counts per list, so the whitelist warning below can be true or absent. */
const counts = computed(() => {
  const out: Record<string, number> = { blacklist: 0, whitelist: 0, dnd: 0 };
  for (const entry of entries.value) {
    const type = text(entry.list_type ?? entry.listType, '');
    if (type in out) out[type] += 1;
  }
  return out;
});

/**
 * True only when a whitelist entry exists AND no list filter is hiding the
 * rest. A count taken from a filtered view would claim the estate is in
 * whitelist mode on the strength of one visible row.
 */
const whitelistActive = computed(() => !filterType.value && counts.value.whitelist > 0);

// --- Add an entry ---------------------------------------------------------------
const showForm = ref(false);
const draftMsisdn = ref('');
const draftType = ref<string>('blacklist');
const draftReason = ref('');
const draftCustomerId = ref('');
const draftExpiresAt = ref('');

async function addEntry() {
  const msisdn = draftMsisdn.value.trim();
  if (!msisdn) {
    listError.value = 'Enter the destination number to add.';
    return;
  }
  busy.value = 'new';
  listError.value = '';
  try {
    await apiRequest('/messaging/blocklist', {
      method: 'POST',
      body: JSON.stringify({
        msisdn,
        listType: draftType.value,
        reason: draftReason.value.trim() || undefined,
        customerId: draftCustomerId.value.trim() || undefined,
        expiresAt: draftExpiresAt.value ? new Date(draftExpiresAt.value).toISOString() : undefined,
      }),
    });
    draftMsisdn.value = '';
    draftReason.value = '';
    draftExpiresAt.value = '';
    // The dialog closes only on success. A failed add leaves the operator's
    // input on screen next to the reason it was refused.
    showForm.value = false;
    await loadEntries();
  } catch (cause) {
    listError.value = messageFrom(cause, 'The entry could not be added.');
  } finally {
    busy.value = '';
  }
}

async function removeEntry(id: string) {
  busy.value = id;
  listError.value = '';
  try {
    await apiRequest(`/messaging/blocklist/${id}`, { method: 'DELETE' });
    await loadEntries();
  } catch (cause) {
    listError.value = messageFrom(cause, 'The entry could not be removed.');
  } finally {
    busy.value = '';
  }
}

// --- Would this number be accepted? ---------------------------------------------
const probeMsisdn = ref('');
const probeCustomerId = ref('');
const probeResult = ref<RecordValue | null>(null);
const probeError = ref('');
const probeBusy = ref(false);

async function checkNumber() {
  const msisdn = probeMsisdn.value.trim();
  if (!msisdn) {
    probeError.value = 'Enter a destination number to check.';
    return;
  }
  probeBusy.value = true;
  probeError.value = '';
  probeResult.value = null;
  const params = new URLSearchParams({ msisdn });
  if (probeCustomerId.value.trim()) params.set('customerId', probeCustomerId.value.trim());
  try {
    probeResult.value = await apiRequest<RecordValue>(
      `/messaging/blocklist/check?${params.toString()}`,
    );
  } catch (cause) {
    probeError.value = messageFrom(cause, 'The check could not be run.');
  } finally {
    probeBusy.value = false;
  }
}

/** The evaluator's own verdict, read rather than re-derived from the list. */
const probeAllowed = computed(() => {
  const result = probeResult.value;
  if (!result) return null;
  if (typeof result.allowed === 'boolean') return result.allowed;
  if (typeof result.blocked === 'boolean') return !result.blocked;
  return null;
});

onMounted(loadEntries);
</script>

<template>
  <div data-testid="recipient-policy-view">
    <section class="panel scope-note" data-testid="policy-scope">
      <h2>These lists refuse messages before a route is chosen</h2>
      <p>
        The send path evaluates them on every submission. A number refused here never reaches a
        carrier and never produces a delivery receipt — so a message that "vanished" with no trace
        is exactly what a blocked destination looks like, and this screen is where to confirm it.
      </p>
    </section>

    <!-- WOULD THIS NUMBER BE ACCEPTED? -------------------------------------- -->
    <section class="panel" data-testid="policy-check" aria-labelledby="policy-check-heading">
      <header class="panel-header">
        <div>
          <h2 id="policy-check-heading">Would this number be accepted?</h2>
          <p>
            Runs the same evaluation the send path runs. Reading the list by eye cannot answer this:
            an entry may be scoped to one customer or already expired, and either makes a listed
            number perfectly sendable.
          </p>
        </div>
      </header>

      <div class="field-grid">
        <label class="filter-select filter-search">
          <span>Destination</span>
          <input
            v-model="probeMsisdn"
            type="search"
            data-testid="check-msisdn"
            placeholder="+256772000118"
            @keyup.enter="checkNumber"
          />
        </label>
        <label class="filter-select">
          <span>As customer (optional)</span>
          <input v-model="probeCustomerId" type="text" data-testid="check-customer" />
        </label>
        <button
          class="primary-button"
          type="button"
          :disabled="probeBusy"
          data-testid="check-run"
          @click="checkNumber"
        >
          {{ probeBusy ? 'Checking…' : 'Check' }}
        </button>
      </div>

      <p v-if="probeError" class="form-error" role="alert" data-testid="check-error">
        {{ probeError }}
      </p>

      <template v-else-if="probeResult">
        <p
          class="notice"
          role="status"
          :class="probeAllowed === false ? 'refused' : ''"
          data-testid="check-result"
        >
          <strong>{{
            probeAllowed === false
              ? 'Refused.'
              : probeAllowed === true
                ? 'Accepted.'
                : 'The evaluator gave no verdict.'
          }}</strong>
          {{ text(probeResult.reason ?? probeResult.detail, 'No reason was given.') }}
        </p>
        <!--
          The raw verdict is kept because "why" matters more than "whether" on
          this screen, and the evaluator says more than a boolean.
        -->
        <details data-testid="check-raw">
          <summary>The evaluator's full answer</summary>
          <pre class="json-block">{{ JSON.stringify(probeResult, null, 2) }}</pre>
        </details>
      </template>
    </section>

    <!-- THE LIST ------------------------------------------------------------ -->
    <section class="panel" data-testid="policy-list" aria-labelledby="policy-list-heading">
      <header class="panel-header">
        <div>
          <h2 id="policy-list-heading">Recipient lists</h2>
          <p>
            {{ counts.blacklist }} blacklisted · {{ counts.whitelist }} whitelisted ·
            {{ counts.dnd }} on DND
          </p>
        </div>
        <!-- Two controls in the header slot, which `.panel-header` lays out as
             a single flex child — hence the wrapper rather than two siblings
             that would be pushed to opposite ends by `space-between`. -->
        <div class="header-controls">
          <label class="filter-select">
            <span>List</span>
            <select v-model="filterType" data-testid="policy-filter" @change="loadEntries">
              <option value="">all lists</option>
              <option v-for="type in LIST_TYPES" :key="type" :value="type">{{ type }}</option>
            </select>
          </label>
          <button
            v-if="canManage"
            class="primary-button"
            type="button"
            data-testid="policy-new"
            @click="showForm = true"
          >
            New entry
          </button>
        </div>
      </header>

      <!--
        The whitelist inverts the default for the WHOLE estate the moment one
        entry exists, which is the single most surprising thing on this screen.
        Shown only on the unfiltered view — a count taken from a filtered list
        would make this claim on the strength of one visible row.
      -->
      <p
        v-if="whitelistActive"
        class="warn-notice"
        role="status"
        data-testid="policy-whitelist-warning"
      >
        <strong>A whitelist is in force.</strong> With {{ counts.whitelist }} entr(y/ies) present,
        every destination NOT on the whitelist is refused. Removing the last entry restores normal
        sending.
      </p>

      <p v-if="listError" class="form-error" role="alert" data-testid="policy-error">
        {{ listError }}
      </p>

      <DataState
        :state="listState"
        subject="recipient policy entries"
        skeleton="table"
        :skeleton-rows="4"
        :detail="
          listState === 'empty'
            ? 'No recipient is listed, so nothing is refused on this basis. That is the normal state — an empty list is not a misconfiguration.'
            : undefined
        "
        permission="messages.view"
        testid="policy-state"
        :on-retry="loadEntries"
      >
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Destination</th>
                <th scope="col">List</th>
                <th scope="col">Scope</th>
                <th scope="col">Reason</th>
                <th scope="col">Expires</th>
                <th scope="col">Added</th>
                <th v-if="canManage" scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="entry in entries"
                :key="text(entry.id)"
                :data-testid="`policy-entry-${text(entry.id)}`"
              >
                <td class="mono">{{ text(entry.msisdn) }}</td>
                <td>
                  <span
                    class="status-badge"
                    :class="
                      text(entry.list_type ?? entry.listType) === 'dnd'
                        ? 'bad'
                        : text(entry.list_type ?? entry.listType) === 'whitelist'
                          ? 'good'
                          : 'warn'
                    "
                    :title="LIST_MEANING[text(entry.list_type ?? entry.listType, '')] ?? ''"
                    >{{ text(entry.list_type ?? entry.listType) }}</span
                  >
                </td>
                <!--
                  A customer-scoped entry refuses that customer only. Rendering
                  it the same as an estate-wide one would make a targeted block
                  look total.
                -->
                <td class="mono cell-tight">
                  {{
                    entry.customer_id || entry.customerId
                      ? `customer ${text(entry.customer_id ?? entry.customerId)}`
                      : 'whole estate'
                  }}
                </td>
                <td>{{ text(entry.reason, 'none given') }}</td>
                <!--
                  "does not expire" rather than a dash: a permanent entry is a
                  decision, and it reads differently from one whose expiry
                  nobody recorded.
                -->
                <td class="mono cell-tight">
                  {{
                    entry.expires_at || entry.expiresAt
                      ? formatMoment(text(entry.expires_at ?? entry.expiresAt, ''))
                      : 'does not expire'
                  }}
                </td>
                <td class="mono cell-tight">
                  {{ formatMoment(text(entry.created_at ?? entry.createdAt, '')) }}
                </td>
                <td v-if="canManage" class="row-actions">
                  <button
                    class="secondary-button danger-button"
                    type="button"
                    :disabled="Boolean(busy)"
                    :data-testid="`policy-remove-${text(entry.id)}`"
                    @click="removeEntry(text(entry.id, ''))"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </DataState>

      <!--
        A Dialog behind a "New entry" control, like every other create form in
        the console. This was a permanently-open field grid under the register:
        the screen offered a half-filled form nobody had asked for, and the
        control that submitted it read "Add", which looks like a disclosure and
        is not.
      -->
      <ModalDialog
        :open="showForm && canManage"
        title="Add an entry"
        testid="policy-form"
        wide
        @close="showForm = false"
      >
        <p class="source-note" data-testid="policy-meaning">
          {{ LIST_MEANING[draftType] }}
        </p>
        <div class="dialog-grid">
          <label class="filter-select">
            <span>Destination</span>
            <input v-model="draftMsisdn" type="text" data-testid="entry-msisdn" />
          </label>
          <label class="filter-select">
            <span>List</span>
            <select v-model="draftType" data-testid="entry-type">
              <option v-for="type in LIST_TYPES" :key="type" :value="type">{{ type }}</option>
            </select>
          </label>
          <label class="filter-select">
            <span>Customer (optional)</span>
            <input v-model="draftCustomerId" type="text" data-testid="entry-customer" />
          </label>
          <label class="filter-select">
            <span>Reason</span>
            <input v-model="draftReason" type="text" data-testid="entry-reason" />
          </label>
          <label class="filter-select">
            <span>Expires (optional)</span>
            <input v-model="draftExpiresAt" type="datetime-local" data-testid="entry-expires" />
          </label>
        </div>
        <!-- The panel's own error banner is behind the scrim while this is
             open, so a refused add has to say so in here. -->
        <p v-if="listError" class="form-error" role="alert" data-testid="policy-form-error">
          {{ listError }}
        </p>
        <template #footer>
          <button class="secondary-button" type="button" @click="showForm = false">Cancel</button>
          <button
            class="primary-button"
            type="button"
            :disabled="Boolean(busy)"
            data-testid="entry-add"
            @click="addEntry"
          >
            Add
          </button>
        </template>
      </ModalDialog>
      <p v-if="!canManage" class="source-note" data-testid="policy-readonly">
        Adding and removing entries needs <span class="mono">messages.send</span> — refusing a
        destination changes what the platform will transmit, so it is gated with the permission that
        transmits.
      </p>
    </section>
  </div>
</template>

<style scoped>
/* The margin is the shared `.panel` rule's — this only adds the accent. */
.scope-note {
  border-left: 3px solid var(--warn);
}
.field-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  align-items: end;
  margin-top: 12px;
}
/* The filter and the create control share the header's right-hand slot. */
.header-controls {
  display: flex;
  align-items: flex-end;
  gap: var(--sp-3);
  flex-wrap: wrap;
}
.notice.refused {
  border-left: 3px solid var(--bad);
  color: var(--bad);
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
