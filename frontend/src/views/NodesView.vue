<script setup lang="ts">
/**
 * NODES AND PERFORMANCE (PLAN.md 7.2, spec §14).
 *
 * THIS SCREEN IS SMALLER THAN THE SPECIFICATION ASKED FOR, ON PURPOSE.
 * ---------------------------------------------------------------------------
 * §14 and the design kit draw a Nodes table: several hosts, each with CPU,
 * memory, disk, network I/O, load average and a software version, plus a
 * Performance page with submit-latency percentiles and headroom.
 *
 * JKANNEL cannot produce that table. There is no node inventory in the schema,
 * no agent on the hosts, and the backend has no Docker socket — its only
 * volumes are the Kamex runtime directory and the migrations directory. Every
 * column of that table would be a number nobody measured.
 *
 * PLAN.md 7.2 gave two options: add a collector, or state the limit honestly
 * rather than ship an empty screen. Adding a host agent means putting a process
 * on a VPS that also runs an unrelated production stack, which is not a change
 * to make quietly. So this screen reports the one node it can genuinely
 * measure — the container this backend runs in, via cgroup v2 accounting — and
 * renders everything it cannot measure as first-class content.
 *
 * Notably absent, and deliberately: `os.cpus()`, `os.totalmem()` and
 * `os.loadavg()`. None is namespaced to the container, so inside Docker they
 * report the HOST's figures. On the shared VPS that would mean showing the
 * neighbouring stack's load as JKANNEL's — a number wrong in a way the reader
 * cannot detect, which is worse than no number.
 *
 * Backend contract:
 *   GET /nodes    one measurable node, plus `notMeasured` and `inventoryLimit`
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ApiError, apiRequest } from '../api';
import DataState from '../components/DataState.vue';
import { setBreadcrumbTrail } from '../stores/breadcrumbs';
import type { DataState as State } from '../utils/data-state';
import {
  formatBytes,
  formatPercent,
  formatUptime,
  pressureTone,
  type NodeReading,
} from '../utils/platform-health';
import { formatMoment } from '../utils/connectivity';

interface NodesPayload {
  items: NodeReading[];
  inventoryComplete: boolean;
  inventoryLimit: string;
  notMeasured: string[];
  observedAt: string;
}

const route = useRoute();
const payload = ref<NodesPayload | null>(null);
const state = ref<State>('loading');
const error = ref('');
const node = computed(() => payload.value?.items[0] ?? null);

async function load() {
  if (state.value !== 'live') state.value = 'loading';
  try {
    payload.value = await apiRequest<NodesPayload>('/nodes');
    // `partial` and not `live`: one measurable node out of an unknown number is
    // by definition an incomplete picture, and the state model has a word for
    // that. Calling it `live` would imply the inventory is the whole estate.
    state.value = 'partial';
    error.value = '';
  } catch (reason) {
    payload.value = null;
    error.value = reason instanceof Error ? reason.message : 'Resource usage could not be read.';
    state.value =
      reason instanceof ApiError && reason.status === 403 ? 'permission-denied' : 'error';
  }
}

/**
 * Polled, because CPU is a rate and the backend needs two samples before it can
 * report one at all. A screen that never refreshed would show "unknown" for CPU
 * forever and look broken.
 */
let timer: number | undefined;
onMounted(() => {
  setBreadcrumbTrail(route.path, [{ label: 'Nodes' }]);
  void load();
  timer = window.setInterval(() => void load(), 10_000);
});
onUnmounted(() => window.clearInterval(timer));
</script>

<template>
  <!--
    No <h1> and no page description: the app shell renders both from the
    route meta. This view repeated them, so the title appeared twice with two
    different descriptions under it. Every other view leaves the heading to
    the shell and opens with its first panel.
  -->
  <div data-testid="nodes-view">

    <DataState
      :state="state"
      :detail="error || undefined"
      subject="node resource usage"
      testid="nodes-state"
      :on-retry="load"
    />

    <template v-if="payload && node">
      <!--
        Not a footnote and not dismissible. A one-row Nodes table with no
        explanation reads as "this deployment has one host", which is a
        statement about the estate that nobody verified.
      -->
      <section class="panel inventory-panel" data-testid="nodes-inventory-limit" role="note">
        <h2>This is not a full inventory</h2>
        <p>{{ payload.inventoryLimit }}</p>
      </section>

      <section class="panel" aria-labelledby="node-heading">
        <div class="panel-head">
          <h2 id="node-heading">{{ node.name }}</h2>
          <span class="row-id mono">{{ node.role }} · observed {{ formatMoment(node.observedAt) }}</span>
        </div>

        <p class="pressure" data-testid="node-pressure">{{ node.pressure }}</p>

        <p
          v-if="node.unavailableReason"
          class="warn-notice"
          data-testid="node-unavailable"
          role="note"
        >
          {{ node.unavailableReason }}
        </p>

        <div class="gauges">
          <div class="gauge" data-testid="node-memory">
            <div class="gauge-head">
              <span>Memory</span>
              <!-- The word "unknown", never a zero that reads as idle (§17). -->
              <strong :class="`tone-${pressureTone(node.memory.percent)}`">{{
                formatPercent(node.memory.percent)
              }}</strong>
            </div>
            <span class="breakdown-track">
              <span
                class="breakdown-fill"
                :class="`tone-${pressureTone(node.memory.percent)}`"
                :style="{ width: `${node.memory.percent ?? 0}%` }"
              />
            </span>
            <small class="mono">
              {{ formatBytes(node.memory.usedBytes) }} of
              {{ node.memory.limitBytes === null ? 'no configured limit' : formatBytes(node.memory.limitBytes) }}
            </small>
          </div>

          <div class="gauge" data-testid="node-cpu">
            <div class="gauge-head">
              <span>CPU</span>
              <strong :class="`tone-${pressureTone(node.cpu.percent)}`">{{
                formatPercent(node.cpu.percent)
              }}</strong>
            </div>
            <span class="breakdown-track">
              <span
                class="breakdown-fill"
                :class="`tone-${pressureTone(node.cpu.percent)}`"
                :style="{ width: `${node.cpu.percent ?? 0}%` }"
              />
            </span>
            <small class="mono">
              {{
                node.cpu.limitCores === null
                  ? 'uncapped — a percentage has no denominator'
                  : `of a ${node.cpu.limitCores}-core quota`
              }}
            </small>
          </div>
        </div>

        <dl class="detail-list">
          <dt>Scope</dt>
          <dd class="mono">
            {{
              node.scope === 'container'
                ? 'this container’s own cgroup accounting'
                : 'this process only — container accounting unreadable'
            }}
          </dd>
          <dt>Uptime</dt>
          <dd class="mono">{{ formatUptime(node.process.uptimeSeconds) }}</dd>
          <dt>Resident memory</dt>
          <dd class="mono">{{ formatBytes(node.process.rssBytes) }}</dd>
          <dt>Heap</dt>
          <dd class="mono">
            {{ formatBytes(node.process.heapUsedBytes) }} of
            {{ formatBytes(node.process.heapTotalBytes) }}
          </dd>
        </dl>
      </section>

      <section class="panel limits-panel" data-testid="nodes-not-measured">
        <h2>What is not measured here</h2>
        <p>
          The specification asks for the figures below. Nothing in this deployment collects them, so
          this screen has no gauges for them — an absent figure means
          <strong>not observable</strong>, never zero.
        </p>
        <ul class="limits-list">
          <li v-for="entry in payload.notMeasured" :key="entry">{{ entry }}</li>
        </ul>
        <p class="source-note">
          Adding them means putting a collector on each host. That is a deployment decision, not a
          console one — and on a shared machine it is not a change to make quietly.
        </p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.inventory-panel {
  border-left: 3px solid var(--warn);
}
.inventory-panel h2,
.limits-panel h2 {
  margin: 0 0 8px;
  font-size: 15px;
}
.limits-panel {
  border-left: 3px solid var(--warn);
}
.limits-list {
  margin: 8px 0 10px;
  padding-left: 20px;
  display: grid;
  gap: 4px;
  color: var(--muted);
  font-size: 13px;
}
.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}
.pressure {
  margin: 12px 0 0;
  color: var(--text-strong);
  font-size: 14px;
  line-height: 1.6;
}
.gauges {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 18px;
  margin: 18px 0 0;
}
.gauge {
  display: grid;
  gap: 6px;
}
.gauge-head {
  display: flex;
  justify-content: space-between;
  font-size: 13.5px;
  color: var(--muted);
}
.gauge-head strong {
  font-variant-numeric: tabular-nums;
}
.tone-bad {
  color: var(--bad);
  background: var(--bad);
}
.gauge-head .tone-bad {
  background: none;
}
.tone-warn {
  color: var(--warn);
  background: var(--warn);
}
.gauge-head .tone-warn {
  background: none;
}
.tone-good {
  background: var(--brand);
}
.gauge-head .tone-good {
  background: none;
  color: var(--text-strong);
}
.tone-muted {
  background: var(--border);
}
.gauge-head .tone-muted {
  background: none;
  color: var(--muted);
}
.detail-list {
  display: grid;
  grid-template-columns: minmax(140px, auto) minmax(0, 1fr);
  gap: 8px 16px;
  margin: 20px 0 0;
}
.detail-list dt {
  color: var(--muted);
  font-size: 13.5px;
}
.detail-list dd {
  margin: 0;
  color: var(--text-strong);
}
</style>
