<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ApiError, apiRequest } from '../api';

interface CopilotTool {
  name: string;
  description: string;
}
interface ToolRun {
  tool: string;
  ok: boolean;
  note?: string;
}
interface CopilotAnswer {
  answer: string;
  provider: string;
  model: string;
  citations: unknown[];
  toolsRun: ToolRun[];
  question: string;
  createdAt: string;
}
interface ChatEntry {
  question: string;
  answer: CopilotAnswer;
}

const OPT_IN_KEY = 'jkannel-copilot-optin-ack';

const question = ref('');
const entries = ref<ChatEntry[]>([]);
const tools = ref<CopilotTool[]>([]);
const toolsError = ref('');
const loading = ref(false);
const error = ref('');
const disabled = ref(false);
const optInAck = ref(localStorage.getItem(OPT_IN_KEY) === 'true');

function acknowledgeOptIn() {
  optInAck.value = true;
  localStorage.setItem(OPT_IN_KEY, 'true');
}

function citationText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return String(record.title ?? record.label ?? record.source ?? JSON.stringify(record));
  }
  return String(value);
}

async function loadTools() {
  toolsError.value = '';
  try {
    const result = await apiRequest<{ tools?: CopilotTool[] }>('/ai/copilot/tools');
    tools.value = Array.isArray(result.tools) ? result.tools : [];
  } catch (reason) {
    tools.value = [];
    if (reason instanceof ApiError && reason.status === 400) {
      disabled.value = true;
      toolsError.value = 'AI Operations is disabled for this environment.';
    } else {
      toolsError.value =
        reason instanceof Error ? reason.message : 'The assistant tools could not be loaded.';
    }
  }
}

async function send() {
  const asked = question.value.trim();
  if (!asked || loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    const answer = await apiRequest<CopilotAnswer>('/ai/copilot', {
      method: 'POST',
      headers: { 'x-jkannel-ai-opt-in': 'true' },
      body: JSON.stringify({ question: asked }),
    });
    entries.value.push({ question: asked, answer });
    question.value = '';
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 400) {
      disabled.value = true;
      error.value =
        reason.message ||
        'AI Operations is disabled. The assistant is unavailable in this environment.';
    } else {
      error.value = reason instanceof Error ? reason.message : 'The assistant could not respond.';
    }
  } finally {
    loading.value = false;
  }
}

onMounted(() => void loadTools());
</script>

<template>
  <section class="copilot" data-testid="copilot-view">
    <section
      v-if="!optInAck"
      class="panel copilot-optin"
      role="note"
      data-testid="copilot-optin"
      aria-label="Assistant opt-in notice"
    >
      <h2>AI Operations Copilot is opt-in and read-only</h2>
      <p>
        This assistant is advisory only. It reads platform telemetry to answer questions and never
        changes configuration, sends messages, or takes any action on your behalf. Each request you
        submit explicitly opts in to AI processing for that question.
      </p>
      <button class="primary-button" data-testid="copilot-optin-dismiss" @click="acknowledgeOptIn">
        I understand
      </button>
    </section>

    <section v-if="disabled" class="panel empty-state" role="alert" data-testid="copilot-disabled">
      <h2>AI Operations is disabled</h2>
      <p>
        The copilot is not enabled for this environment. Ask your administrator to enable AI
        Operations to use the assistant.
      </p>
    </section>

    <section class="panel copilot-log" aria-live="polite">
      <p v-if="!entries.length" class="copilot-empty" data-testid="copilot-empty">
        Ask about queue depth, delivery rates, alerts, or engine health. Answers are advisory and
        read-only.
      </p>
      <article
        v-for="(entry, index) in entries"
        :key="index"
        class="copilot-turn"
        :data-testid="`copilot-turn-${index}`"
      >
        <p class="copilot-question" data-testid="copilot-question-bubble">
          <strong>You</strong><span>{{ entry.question }}</span>
        </p>
        <div class="copilot-answer" data-testid="copilot-answer">
          <div class="copilot-answer-head">
            <strong>Copilot</strong>
            <span class="copilot-badge" data-testid="copilot-provider"
              >{{ entry.answer.provider }} · {{ entry.answer.model }}</span
            >
          </div>
          <p class="copilot-answer-body">{{ entry.answer.answer }}</p>
          <div
            v-if="entry.answer.toolsRun && entry.answer.toolsRun.length"
            class="copilot-citations"
            data-testid="copilot-tools"
          >
            <p class="copilot-citations-label">Tools used</p>
            <span
              v-for="(run, runIndex) in entry.answer.toolsRun"
              :key="runIndex"
              class="status-badge"
              :class="run.ok ? 'good' : 'bad'"
              data-testid="copilot-citation"
              :title="run.note ?? ''"
            >
              {{ run.tool }}{{ run.note ? ` — ${run.note}` : '' }}
            </span>
          </div>
          <div
            v-if="entry.answer.citations && entry.answer.citations.length"
            class="copilot-citations"
            data-testid="copilot-references"
          >
            <p class="copilot-citations-label">References</p>
            <span
              v-for="(citation, citationIndex) in entry.answer.citations"
              :key="citationIndex"
              class="status-badge"
              data-testid="copilot-reference"
            >
              {{ citationText(citation) }}
            </span>
          </div>
          <p class="copilot-advisory">Read-only, advisory response — no changes were made.</p>
        </div>
      </article>
    </section>

    <p v-if="error" class="form-error" role="alert" data-testid="copilot-error">{{ error }}</p>

    <section class="panel composer copilot-composer" aria-label="Ask the copilot">
      <label>
        <span class="sr-only">Ask the AI Operations Copilot</span>
        <input
          v-model="question"
          data-testid="copilot-question"
          placeholder="Ask about queues, delivery, alerts, or engine health"
          :disabled="disabled"
          @keyup.enter="send"
        />
      </label>
      <div>
        <button
          class="primary-button"
          data-testid="copilot-send"
          :disabled="loading || disabled || !question.trim()"
          @click="send"
        >
          {{ loading ? 'Thinking…' : 'Send' }}
        </button>
      </div>
      <p class="form-hint">
        The assistant is opt-in and read-only; it can read telemetry but never changes the platform.
      </p>
    </section>

    <section v-if="tools.length" class="panel copilot-tools-panel" aria-label="Available tools">
      <h2>What the copilot can read</h2>
      <ul class="copilot-tool-list">
        <li v-for="tool in tools" :key="tool.name">
          <strong>{{ tool.name }}</strong
          ><small>{{ tool.description }}</small>
        </li>
      </ul>
    </section>
    <p v-else-if="toolsError" class="form-hint" data-testid="copilot-tools-error">
      {{ toolsError }}
    </p>
  </section>
</template>
