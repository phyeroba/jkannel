<script setup lang="ts">
/**
 * SERVICES — the component register (PLAN.md 7.1, spec §14, UC-SYS-01).
 *
 * WHAT THIS SCREEN IS FOR
 * ---------------------------------------------------------------------------
 * When submissions stop, the operator's question is "which component, and is it
 * the cause or a symptom". Before this screen there was no way to ask it:
 * `/monitoring` covered bearerbox alone, `/health` covered PostgreSQL and
 * Redis, and `/docker/containers` was a hardcoded Compose catalogue with three
 * probes bolted on. Nobody put them together, and nothing said which components
 * were not being watched at all.
 *
 * THE ONE RULE
 * ---------------------------------------------------------------------------
 * A component nobody probes renders as **not observed**, visibly distinct from
 * healthy, and is counted in its own column. If "unknown" folded into the green
 * count, then the fewer probes the deployment had the healthier the board would
 * look — which is the exact inversion §17 exists to prevent.
 *
 * Rows sort worst-first, and **not observed sorts above healthy**. A blind spot
 * is a gap to close; burying it under the green rows is how it stays a blind
 * spot.
 *
 * Backend contract:
 *   GET /services         board + summary + root-cause attribution
 *   GET /services/:name   one component, with its dependencies resolved
 */
import { computed, onMounted, ref, watch } from 'vue';
import { ApiError, apiRequest } from '../api';
import DataState from '../components/DataState.vue';
import EventTimeline from '../components/EventTimeline.vue';
import { severityTone, type OperationalEvent } from '../utils/diagnostics';
import { setBreadcrumbTrail } from '../stores/breadcrumbs';
import { useRoute } from 'vue-router';
import type { DataState as State } from '../utils/data-state';
import {
  advise,
  byUrgency,
  stateTone,
  stateWord,
  type ServiceBoard,
  type ServiceReading,
} from '../utils/platform-health';
import { formatMoment } from '../utils/connectivity';
import { formatDuration } from '../utils/traffic';

const route = useRoute();
const board = ref<ServiceBoard | null>(null);
const state = ref<State>('loading');
const error = ref('');
const selected = ref<string | null>(null);
const filter = ref<'any' | 'attention' | 'unobserved'>('any');

/**
 * When the board stops being a reading and becomes a photograph.
 *
 * This page probes on open and does not poll. Three minutes is long enough that
 * a page just loaded never shows the banner, and short enough that a tab left
 * open on a wall display stops passing itself off as live.
 */
const BOARD_STALE_AFTER_SECONDS = 180;

const boardAgeSeconds = computed<number | null>(() => {
  const at = board.value?.observedAt;
  if (!at) return null;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? Math.max(0, Math.round((Date.now() - parsed) / 1000)) : null;
});

const boardStale = computed(
  () => boardAgeSeconds.value !== null && boardAgeSeconds.value > BOARD_STALE_AFTER_SECONDS,
);

const rows = computed(() => {
  const all = [...(board.value?.services ?? [])].sort(byUrgency);
  if (filter.value === 'attention')
    return all.filter((s) => s.state === 'critical' || s.state === 'degraded');
  if (filter.value === 'unobserved') return all.filter((s) => s.observation === 'unobserved');
  return all;
});

const chosen = computed<ServiceReading | null>(
  () => rows.value.find((s) => s.name === selected.value) ?? rows.value[0] ?? null,
);
const dependencies = computed(() =>
  (board.value?.services ?? []).filter((s) => chosen.value?.dependsOn.includes(s.name)),
);
const dependents = computed(() =>
  (board.value?.services ?? []).filter((s) => chosen.value?.affects.includes(s.name)),
);

/* --- ONE COMPONENT -----------------------------------------------------------
 *
 * Selecting a row reads `GET /services/:name`, which resolves that component's
 * dependencies and dependents server-side. It had no console surface at all
 * before this — the panel below was assembled from the board, which meant the
 * console was re-deriving an answer the API already gives, and a deep link to a
 * component that does not exist had nothing to say.
 */
const detail = ref<(ServiceReading & { dependencies?: ServiceReading[]; dependents?: ServiceReading[] }) | null>(null);
const detailMissing = ref(false);
const serviceEvents = ref<OperationalEvent[]>([]);

async function loadService(name: string) {
  detailMissing.value = false;
  serviceEvents.value = [];
  try {
    detail.value = await apiRequest(`/services/${encodeURIComponent(name)}`);
  } catch (reason) {
    detail.value = null;
    // 404 is a real answer — the name is not in the register — and gets its own
    // panel rather than an error banner that reads as a broken screen.
    detailMissing.value = reason instanceof ApiError && reason.status === 404;
  }
  try {
    const page = await apiRequest<{ items?: OperationalEvent[] }>(
      `/diagnostics/events?limit=20&subjectType=service&subjectId=${encodeURIComponent(name)}`,
    );
    serviceEvents.value = Array.isArray(page?.items) ? page.items : [];
  } catch {
    // Events need monitoring.view, which system.view does not imply. The panel
    // says nothing was recorded only when it genuinely read nothing.
    serviceEvents.value = [];
  }
}

watch(
  () => chosen.value?.name,
  (name) => {
    if (name) void loadService(name);
  },
  { immediate: true },
);

const serviceTimeline = computed(() =>
  serviceEvents.value.map((event) => ({
    at: formatMoment(event.observed_at),
    label: event.kind,
    detail: event.summary,
    state: (severityTone(event.severity) === 'bad'
      ? 'error'
      : severityTone(event.severity) === 'warn'
        ? 'warn'
        : 'info') as 'ok' | 'warn' | 'error' | 'missing' | 'info',
  })),
);

async function load() {
  state.value = 'loading';
  try {
    board.value = await apiRequest<ServiceBoard>('/services');
    // `empty` would be wrong here: the register is a constant, so no rows means
    // the endpoint answered with something unexpected, not that there is
    // nothing to show.
    state.value = board.value.services.length ? 'live' : 'error';
    error.value = '';
  } catch (reason) {
    board.value = null;
    error.value = reason instanceof Error ? reason.message : 'The service register could not be read.';
    state.value =
      reason instanceof ApiError && reason.status === 403 ? 'permission-denied' : 'error';
  }
}

onMounted(() => {
  setBreadcrumbTrail(route.path, [{ label: 'Services' }]);
  void load();
});
</script>

<template>
  <!--
    No <h1> and no page description here: the app shell already renders both
    from the route's `title` and `description` meta. This view originally
    repeated them, so "Services" appeared twice down the page with two different
    descriptions underneath. Every other view leaves the heading to the shell
    and starts straight at its first panel; this now matches.
  -->
  <div data-testid="services-view">
    <DataState
      :state="state"
      :detail="error || undefined"
      subject="the service register"
      testid="services-state"
      :on-retry="load"
    />

    <template v-if="board && state === 'live'">
      <!--
        This board is probed when the page is opened, not continuously. Left
        open on a wall display it silently becomes a photograph, and every state
        on it reads as current — so once the probe is older than a few minutes
        the page says so before the operator reads a single row.
      -->
      <p v-if="boardStale" class="stale-banner" role="status" data-testid="services-stale">
        <strong>These states were probed {{ formatDuration(boardAgeSeconds ?? 0) }} ago.</strong>
        Nothing below is a live reading. Refresh before acting on it.
      </p>

      <!--
        The board's verdict, in a sentence. Rendered verbatim from the API,
        which counted the states and did the root-cause attribution — a
        client-side recount could disagree with the rows below it.
      -->
      <p
        class="panel summary-line"
        :class="`tone-${stateTone(board.summary.worst)}`"
        data-testid="services-summary"
        role="status"
      >
        {{ board.summary.statement }}
      </p>

      <section class="panel" aria-labelledby="services-table-heading">
        <div class="panel-head">
          <h2 id="services-table-heading">Components</h2>
          <label class="filter-select">
            Show
            <select v-model="filter" data-testid="services-filter">
              <option value="any">all components</option>
              <option value="attention">needing attention</option>
              <option value="unobserved">not observed</option>
            </select>
          </label>
        </div>

        <p class="source-note" data-testid="services-counts">
          {{ board.summary.healthy }} healthy · {{ board.summary.degraded }} degraded ·
          {{ board.summary.critical }} failing ·
          <!--
            Counted apart from healthy, and always shown even at zero, so the
            board's silence about a component is never mistaken for a pass.
          -->
          <strong>{{ board.summary.unknown }} not observed</strong>
          — last probed {{ formatMoment(board.observedAt) }}
        </p>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Component</th>
                <th>Responsibility</th>
                <th>State</th>
                <th>Uptime</th>
                <th>Evidence</th>
                <th>Explained by</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in rows"
                :key="row.name"
                class="selectable"
                :class="{ selected: row.name === chosen?.name }"
                :data-testid="`service-row-${row.name}`"
                @click="selected = row.name"
              >
                <td class="mono">{{ row.name }}</td>
                <td class="muted-cell">{{ row.role }}</td>
                <td>
                  <!-- Word first; the dot is decoration, never the signal. -->
                  <span class="status-badge" :class="stateTone(row.state)">
                    {{ stateWord(row) }}
                  </span>
                </td>
                <!--
                  Only where a component actually reports one. bearerbox
                  publishes its own; the poller and the job worker run inside
                  this API process and share its uptime. A separate process this
                  container can reach but not interrogate reads "not reported" —
                  never a zero, which would look like it had just restarted.
                -->
                <td class="mono" :data-testid="`service-uptime-${row.name}`">
                  {{
                    typeof row.uptimeSeconds === 'number'
                      ? formatDuration(row.uptimeSeconds)
                      : 'not reported'
                  }}
                </td>
                <td class="muted-cell evidence">{{ row.detail }}</td>
                <td class="mono">{{ row.rootCause ?? '—' }}</td>
              </tr>
              <tr v-if="!rows.length">
                <td class="empty-cell" colspan="6">No component matches this filter.</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!--
          The design's table has CPU and Memory columns. They are not here and
          this says why, because an operator who has seen them in the design
          will otherwise assume the columns broke rather than that the figures
          do not exist.
        -->
        <p class="source-note" data-testid="services-resource-note">
          There are no CPU or memory columns. Per-component usage would need a Docker socket, and
          this container deliberately has none — an API process that can inspect and control its
          own siblings is a much larger blast radius than a console needs. What
          <em>is</em> measured is this container's own accounting, read from its cgroup and shown
          on <RouterLink class="text-link" to="/system">System</RouterLink>; attributing that one
          figure to each of the components hosted inside it would be an invention.
        </p>
      </section>

      <!--
        A name the register does not hold is a real answer, not a broken screen.
        It happens from a stale bookmark or a component removed from the
        catalogue, and an error banner would send someone looking for a fault in
        the console instead of in their link.
      -->
      <section v-if="detailMissing" class="panel" data-testid="service-not-found">
        <h2>Service not found</h2>
        <p>
          No component named <span class="mono">{{ selected }}</span> is in the register. The
          register is a fixed catalogue of what JKANNEL can say anything about, so this is not a
          component that is down — it is one that does not exist here.
        </p>
        <button class="secondary-button" type="button" @click="selected = null">
          Back to the component list
        </button>
      </section>

      <section v-if="chosen && !detailMissing" class="split-grid">
        <article class="panel" :data-testid="`service-detail-${chosen.name}`">
          <h2>{{ chosen.name }}</h2>
          <p class="lede">{{ chosen.role }}</p>
          <dl class="detail-list">
            <dt>State</dt>
            <dd>
              <span class="status-badge" :class="stateTone(chosen.state)">{{
                stateWord(chosen)
              }}</span>
            </dd>
            <dt>How we know</dt>
            <dd class="mono">
              {{
                chosen.observation === 'probed'
                  ? 'live probe'
                  : chosen.observation === 'derived'
                    ? 'derived from another probe'
                    : 'nothing probes this'
              }}
            </dd>
            <dt>Last probed</dt>
            <dd class="mono">
              {{ chosen.observedAt ? formatMoment(chosen.observedAt) : 'never' }}
            </dd>
            <dt>Evidence</dt>
            <dd>{{ chosen.detail }}</dd>
          </dl>
          <p class="advice" data-testid="service-advice">{{ advise(chosen) }}</p>
        </article>

        <article class="panel" data-testid="service-dependencies">
          <h2>Dependencies</h2>
          <p class="lede">
            Root failure or downstream symptom — the distinction that decides where to start.
          </p>

          <h3 class="t-caps">Depends on</h3>
          <ul v-if="dependencies.length" class="health-list">
            <li
              v-for="dep in dependencies"
              :key="dep.name"
              class="selectable"
              @click="selected = dep.name"
            >
              <span class="status-badge" :class="stateTone(dep.state)">{{ stateWord(dep) }}</span>
              <span><strong>{{ dep.name }}</strong><small>{{ dep.role }}</small></span>
            </li>
          </ul>
          <p v-else class="source-note">Nothing — this is a root service.</p>

          <h3 class="t-caps">Affected if this fails</h3>
          <ul v-if="dependents.length" class="health-list">
            <li
              v-for="dep in dependents"
              :key="dep.name"
              class="selectable"
              @click="selected = dep.name"
            >
              <span class="status-badge" :class="stateTone(dep.state)">{{ stateWord(dep) }}</span>
              <span><strong>{{ dep.name }}</strong><small>{{ dep.role }}</small></span>
            </li>
          </ul>
          <p v-else class="source-note">No other component depends on it.</p>
        </article>
      </section>

      <!--
        The component's own history. `service.restarted` and its siblings are
        recorded as operational events, so a component that has bounced three
        times this morning shows a rhythm here — which is the thing a single
        current state cannot say, and the reason this is a timeline.
      -->
      <section
        v-if="chosen && !detailMissing"
        class="panel"
        data-testid="service-events"
        aria-labelledby="service-events-heading"
      >
        <div class="panel-head">
          <h2 id="service-events-heading">Recent events for {{ chosen.name }}</h2>
          <RouterLink class="text-button" to="/events">All events</RouterLink>
        </div>
        <EventTimeline
          v-if="serviceTimeline.length"
          dense
          :items="serviceTimeline"
          data-testid="service-event-timeline"
        />
        <p v-else class="source-note" data-testid="service-events-empty">
          No operational event has been recorded against this component. Reading them needs the
          monitoring.view permission, so an empty timeline can also mean this role cannot see them.
        </p>
      </section>

      <!--
        There is no restart button here, and that is deliberate rather than
        unfinished. The backend has no Docker socket, so it cannot restart a
        container; a button that opened a dialog and then failed would be worse
        than its absence. §1.1 forbids controls that do not map to something the
        backend honours.
      -->
      <p class="panel source-note" data-testid="services-no-restart">
        Components are not restarted from this console. The backend has no Docker socket, so it can
        observe these processes but not act on them — restarts stay with whoever operates the host.
        This screen tells you which one to restart and why; it does not pretend it can do it.
      </p>
    </template>
  </div>
</template>

<style scoped>
.summary-line {
  margin: 0;
  font-size: 14.5px;
  color: var(--text-strong);
  border-left: 3px solid var(--border);
}
.summary-line.tone-bad {
  border-left-color: var(--bad);
}
.summary-line.tone-warn {
  border-left-color: var(--warn);
}
.summary-line.tone-good {
  border-left-color: var(--good);
}
.summary-line.tone-muted {
  border-left-color: var(--muted);
}
.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}
.evidence {
  max-width: 42ch;
}
.muted-cell {
  color: var(--muted);
}
.detail-list {
  display: grid;
  grid-template-columns: minmax(120px, auto) minmax(0, 1fr);
  gap: 8px 16px;
  margin: 14px 0 0;
}
.detail-list dt {
  color: var(--muted);
  font-size: 13.5px;
}
.detail-list dd {
  margin: 0;
  color: var(--text-strong);
}
.advice {
  margin: 16px 0 0;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--text);
}
.t-caps {
  margin: 18px 0 8px;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
</style>
