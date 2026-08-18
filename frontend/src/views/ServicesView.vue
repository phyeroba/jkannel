<script setup lang="ts">
/**
 * SERVICES â€” the component register (PLAN.md 7.1, spec Â§14, UC-SYS-01).
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
 * look â€” which is the exact inversion Â§17 exists to prevent.
 *
 * Rows sort worst-first, and **not observed sorts above healthy**. A blind spot
 * is a gap to close; burying it under the green rows is how it stays a blind
 * spot.
 *
 * Backend contract:
 *   GET /services         board + summary + root-cause attribution
 *   GET /services/:name   one component, with its dependencies resolved
 */
import { computed, onMounted, ref } from 'vue';
import { ApiError, apiRequest } from '../api';
import DataState from '../components/DataState.vue';
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

const route = useRoute();
const board = ref<ServiceBoard | null>(null);
const state = ref<State>('loading');
const error = ref('');
const selected = ref<string | null>(null);
const filter = ref<'any' | 'attention' | 'unobserved'>('any');

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
  <section class="workspace-stack">
    <header class="workspace-head">
      <div>
        <h1>Services</h1>
        <p class="lede">
          Every component this gateway depends on, what state it is in, and â€” where a dependency
          explains it â€” which one to fix first.
        </p>
      </div>
      <button class="secondary-button" :disabled="state === 'loading'" @click="load">
        Refresh
      </button>
    </header>

    <DataState
      :state="state"
      :detail="error || undefined"
      subject="the service register"
      testid="services-state"
      :on-retry="load"
    />

    <template v-if="board && state === 'live'">
      <!--
        The board's verdict, in a sentence. Rendered verbatim from the API,
        which counted the states and did the root-cause attribution â€” a
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
          {{ board.summary.healthy }} healthy Â· {{ board.summary.degraded }} degraded Â·
          {{ board.summary.critical }} failing Â·
          <!--
            Counted apart from healthy, and always shown even at zero, so the
            board's silence about a component is never mistaken for a pass.
          -->
          <strong>{{ board.summary.unknown }} not observed</strong>
          â€” last probed {{ formatMoment(board.observedAt) }}
        </p>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Component</th>
                <th>Responsibility</th>
                <th>State</th>
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
                <td class="muted-cell evidence">{{ row.detail }}</td>
                <td class="mono">{{ row.rootCause ?? 'â€”' }}</td>
              </tr>
              <tr v-if="!rows.length">
                <td class="empty-cell" colspan="5">No component matches this filter.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="chosen" class="split-grid">
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
            Root failure or downstream symptom â€” the distinction that decides where to start.
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
          <p v-else class="source-note">Nothing â€” this is a root service.</p>

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
        There is no restart button here, and that is deliberate rather than
        unfinished. The backend has no Docker socket, so it cannot restart a
        container; a button that opened a dialog and then failed would be worse
        than its absence. Â§1.1 forbids controls that do not map to something the
        backend honours.
      -->
      <p class="panel source-note" data-testid="services-no-restart">
        Components are not restarted from this console. The backend has no Docker socket, so it can
        observe these processes but not act on them â€” restarts stay with whoever operates the host.
        This screen tells you which one to restart and why; it does not pretend it can do it.
      </p>
    </template>
  </section>
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
