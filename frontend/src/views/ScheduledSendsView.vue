<script setup lang="ts">
/**
 * SCHEDULED SENDS — messages held for a future instant, and the two things you
 * can do to one before it goes.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `ScheduledSendController` has four operations with no surface. A message
 * could be scheduled through the send path and then neither seen, cancelled nor
 * moved from the console — the only way to stop one was to call the API by
 * hand, against a deadline.
 *
 * THE ONE THING THIS SCREEN MUST GET RIGHT
 * ---------------------------------------------------------------------------
 * A RELEASED MESSAGE IS GONE. Cancel and reschedule answer 409 once the hold
 * has left `pending`, and the screen offers those controls only on rows that
 * are still cancellable — a live Cancel button beside a message that has
 * already gone out is a promise the platform cannot keep, and the operator
 * pressing it believes they stopped something.
 *
 * The lateness policy is read from the server rather than written here. The
 * ceiling is deployment configuration (`SCHEDULED_SEND_MAX_LATENESS_MINUTES`)
 * and a number hard-coded into this screen would drift from the worker's
 * behaviour without anybody noticing.
 *
 * Backend contract:
 *   GET  /scheduled-messages?filter.status&sort   (messages.view)
 *   GET  /scheduled-messages/policy
 *   GET  /scheduled-messages/:id
 *   POST /scheduled-messages/:id/cancel           (messages.send)
 *   POST /scheduled-messages/:id/reschedule
 */
import { computed, onMounted, ref } from 'vue';
import { ApiError, apiRequest } from '../api';
import DataState from '../components/DataState.vue';
import { canAccess, session } from '../stores/session';
import { type DataState as State } from '../utils/data-state';
import { formatMoment } from '../utils/connectivity';

type RecordValue = Record<string, unknown>;

/** Statuses the API documents. `pending` is the only cancellable one. */
const STATUSES = ['pending', 'releasing', 'released', 'released_late', 'cancelled', 'expired'];

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

function statusOf(row: RecordValue): string {
  return text(row.status, '').toLowerCase();
}

/** Only a hold that has not been released can be stopped or moved. */
function isPending(row: RecordValue): boolean {
  return statusOf(row) === 'pending';
}

function statusTone(status: string): string {
  if (status === 'pending') return 'warn';
  if (status === 'released') return 'good';
  if (status === 'released_late') return 'warn';
  if (status === 'expired' || status === 'cancelled') return 'muted';
  return '';
}

// --- The list ------------------------------------------------------------------
const holds = ref<RecordValue[]>([]);
const listState = ref<State>('loading');
const listError = ref('');
const filterStatus = ref('pending');
const busy = ref('');
const notice = ref('');

async function loadHolds() {
  listState.value = 'loading';
  const params = new URLSearchParams({ limit: '100', offset: '0', sort: 'scheduledAt' });
  if (filterStatus.value) params.set('filter.status', filterStatus.value);
  try {
    holds.value = asItems(await apiRequest(`/scheduled-messages?${params.toString()}`));
    listError.value = '';
    listState.value = holds.value.length ? 'live' : 'empty';
  } catch (cause) {
    holds.value = [];
    listError.value = messageFrom(cause, 'Scheduled sends could not be read.');
    listState.value =
      cause instanceof ApiError && cause.status === 403 ? 'permission-denied' : 'error';
  }
}

// --- The deployment's lateness policy -------------------------------------------
const policy = ref<RecordValue | null>(null);

async function loadPolicy() {
  try {
    policy.value = await apiRequest<RecordValue>('/scheduled-messages/policy');
  } catch {
    // The list is still usable without it; the panel simply does not claim a
    // ceiling it could not read.
    policy.value = null;
  }
}

// --- Cancel ---------------------------------------------------------------------
const cancelReason = ref('');

async function cancelHold(row: RecordValue) {
  const id = text(row.id, '');
  if (!id || id === '—') return;
  busy.value = id;
  listError.value = '';
  notice.value = '';
  try {
    await apiRequest(`/scheduled-messages/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify(cancelReason.value.trim() ? { reason: cancelReason.value.trim() } : {}),
    });
    notice.value = 'The hold was cancelled. Nothing was sent.';
    cancelReason.value = '';
    await loadHolds();
  } catch (cause) {
    // A 409 here is the message having gone out between the page loading and
    // the button being pressed. Saying so plainly matters more than the status
    // code: the operator needs to know the message IS on its way.
    listError.value =
      cause instanceof ApiError && cause.status === 409
        ? 'Too late — this message has already been released and is on its way. It cannot be recalled.'
        : messageFrom(cause, 'The hold could not be cancelled.');
    await loadHolds();
  } finally {
    busy.value = '';
  }
}

// --- Reschedule -------------------------------------------------------------------
const reschedulingId = ref('');
const newInstant = ref('');

async function reschedule(row: RecordValue) {
  const id = text(row.id, '');
  if (!id || id === '—') return;
  if (!newInstant.value) {
    listError.value = 'Choose the new instant first.';
    return;
  }
  busy.value = id;
  listError.value = '';
  notice.value = '';
  try {
    await apiRequest(`/scheduled-messages/${id}/reschedule`, {
      method: 'POST',
      body: JSON.stringify({ scheduledAt: new Date(newInstant.value).toISOString() }),
    });
    notice.value = 'The hold was moved.';
    reschedulingId.value = '';
    newInstant.value = '';
    await loadHolds();
  } catch (cause) {
    listError.value =
      cause instanceof ApiError && cause.status === 409
        ? 'Too late — this message has already been released. It cannot be moved.'
        : messageFrom(cause, 'The hold could not be moved.');
    await loadHolds();
  } finally {
    busy.value = '';
  }
}

onMounted(() => {
  void loadHolds();
  void loadPolicy();
});
</script>

<template>
  <div data-testid="scheduled-sends-view">
    <!--
      The lateness rule, from the server. It is the surprising part of this
      feature: a message released far outside its window is NOT sent, and an
      operator who assumes "late but sent" will be wrong about what happened.
    -->
    <section v-if="policy" class="panel scope-note" data-testid="scheduled-policy">
      <h2>What happens if a release runs late</h2>
      <p data-testid="scheduled-policy-text">{{ text(policy.behaviour) }}</p>
      <p class="source-note">
        The ceiling is {{ text(policy.maxLatenessMinutes) }} minute(s), set by
        <span class="mono">{{ text(policy.configuredBy) }}</span> on this deployment. Read from the
        server rather than written into this screen, so it cannot drift from what the release worker
        actually does.
      </p>
    </section>

    <section class="panel" data-testid="scheduled-list" aria-labelledby="scheduled-heading">
      <header class="panel-header">
        <div>
          <h2 id="scheduled-heading">Scheduled sends</h2>
          <p>Soonest first — the question this screen answers is what is about to go out.</p>
        </div>
        <label class="filter-select">
          <span>Status</span>
          <select v-model="filterStatus" data-testid="scheduled-filter" @change="loadHolds">
            <option value="">any status</option>
            <option v-for="status in STATUSES" :key="status" :value="status">{{ status }}</option>
          </select>
        </label>
      </header>

      <p v-if="notice" class="notice" role="status" data-testid="scheduled-notice">{{ notice }}</p>
      <p v-if="listError" class="form-error" role="alert" data-testid="scheduled-error">
        {{ listError }}
      </p>

      <DataState
        :state="listState"
        subject="scheduled sends"
        skeleton="table"
        :skeleton-rows="4"
        :detail="
          listState === 'empty'
            ? filterStatus === 'pending'
              ? 'Nothing is held for a future instant. That is the normal state — messages sent without a schedule go immediately and never appear here.'
              : 'No scheduled send matches this status.'
            : undefined
        "
        permission="messages.view"
        testid="scheduled-state"
        :on-retry="loadHolds"
      >
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Scheduled for</th>
                <th scope="col">Destination</th>
                <th scope="col">Sender</th>
                <th scope="col">Status</th>
                <th scope="col">Created</th>
                <th v-if="canManage" scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="hold in holds" :key="text(hold.id)">
                <tr :data-testid="`hold-${text(hold.id)}`">
                  <td class="mono">
                    {{ formatMoment(text(hold.scheduled_at ?? hold.scheduledAt, '')) }}
                  </td>
                  <td class="mono">{{ text(hold.receiver) }}</td>
                  <td>{{ text(hold.sender) }}</td>
                  <td>
                    <span class="status-badge" :class="statusTone(statusOf(hold))">{{
                      text(hold.status)
                    }}</span>
                  </td>
                  <td class="mono cell-tight">
                    {{ formatMoment(text(hold.created_at ?? hold.createdAt, '')) }}
                  </td>
                  <!--
                    Controls only where they can act. A live Cancel beside a
                    released message is a promise the platform cannot keep, and
                    the operator pressing it believes they stopped something.
                  -->
                  <td v-if="canManage" class="row-actions">
                    <template v-if="isPending(hold)">
                      <button
                        class="secondary-button danger-button"
                        type="button"
                        :disabled="Boolean(busy)"
                        :data-testid="`hold-cancel-${text(hold.id)}`"
                        @click="cancelHold(hold)"
                      >
                        Cancel
                      </button>
                      <button
                        class="secondary-button"
                        type="button"
                        :disabled="Boolean(busy)"
                        :data-testid="`hold-move-${text(hold.id)}`"
                        @click="
                          reschedulingId = reschedulingId === text(hold.id) ? '' : text(hold.id, '')
                        "
                      >
                        Move
                      </button>
                    </template>
                    <span v-else class="cell-health">already released</span>
                  </td>
                </tr>
                <tr v-if="reschedulingId === text(hold.id)">
                  <td :colspan="canManage ? 6 : 5">
                    <div class="field-grid">
                      <label class="filter-select">
                        <span>New instant</span>
                        <input
                          v-model="newInstant"
                          type="datetime-local"
                          :data-testid="`hold-instant-${text(hold.id)}`"
                        />
                      </label>
                      <button
                        class="primary-button"
                        type="button"
                        :disabled="Boolean(busy)"
                        :data-testid="`hold-move-save-${text(hold.id)}`"
                        @click="reschedule(hold)"
                      >
                        Move it
                      </button>
                    </div>
                    <p class="source-note">
                      The same rules the send path applies: not in the past beyond a minute's grace,
                      not more than a year out, and not after the message's own validity would have
                      expired.
                    </p>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </DataState>

      <div v-if="canManage" class="field-grid" data-testid="cancel-reason-row">
        <label class="filter-select filter-search">
          <span>Reason for the next cancellation (optional)</span>
          <input v-model="cancelReason" type="text" data-testid="cancel-reason" />
        </label>
      </div>
      <p v-else class="source-note" data-testid="scheduled-readonly">
        Cancelling and moving a hold need <span class="mono">messages.send</span>. The list above is
        readable without it.
      </p>
    </section>
  </div>
</template>

<style scoped>
/* The margin is the shared `.panel` rule's — this only adds the accent. */
.scope-note {
  border-left: 3px solid var(--brand);
}
.field-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
  align-items: end;
  margin-top: 12px;
}
.cell-tight {
  font-size: 12.5px;
}
</style>
<style src="./workspace-extras.css"></style>
