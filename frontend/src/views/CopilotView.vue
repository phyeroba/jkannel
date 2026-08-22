<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, apiRequest } from '../api';
import { canAccess, session } from '../stores/session';

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

/* --- ADVISORY ASSISTANCE -------------------------------------------------------
 *
 * A different thing from the chat above, and the difference matters.
 *
 * The copilot ANSWERS: it reads telemetry and tells you what it found, and
 * nothing follows from it. Assistance ANALYSES a described situation and may
 * return a RECOMMENDATION, which a human then approves or rejects — and that
 * decision is recorded against the record with a reason.
 *
 * So the two are separated on the screen rather than merged into one box. A
 * recommendation that arrived in a chat log would be acted on without anybody
 * deciding to; here approving is a deliberate act with its own permission
 * (`system.manage`, where asking needs only `monitoring.view`).
 *
 * `allowRecommendation` is opt-in per request. Asked without it, the service
 * analyses and stops — which is the right default for a question somebody is
 * exploring rather than acting on.
 */
interface AssistanceRecord {
  id: string;
  question: string;
  observedBehaviour: string;
  reasoning: string[];
  recommendation: string | null;
  confidence: number;
  risk: 'none' | 'low' | 'medium' | 'high';
  status: string;
  approvedBy?: string;
  createdAt: string;
}

const situation = ref('');
const evidenceText = ref('');
const allowRecommendation = ref(false);
const assistance = ref<AssistanceRecord | null>(null);
const assistanceBusy = ref(false);
const assistanceError = ref('');
const decisionReason = ref('');

const canDecide = computed(() => canAccess(session.value, 'system.manage'));

async function askAssistance() {
  const question = situation.value.trim();
  if (!question) {
    assistanceError.value = 'Describe the situation you want analysed.';
    return;
  }
  assistanceBusy.value = true;
  assistanceError.value = '';
  assistance.value = null;
  try {
    assistance.value = await apiRequest<AssistanceRecord>('/ai/assistance', {
      method: 'POST',
      // The service only produces a recommendation when the caller opts in,
      // per request. Sending the header unconditionally would make every
      // exploratory question capable of producing one.
      headers: { 'x-jkannel-ai-opt-in': allowRecommendation.value ? 'true' : 'false' },
      body: JSON.stringify({
        question,
        evidence: evidenceText.value.trim()
          ? evidenceText.value
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean)
              .map((line) => ({ kind: 'note', detail: line }))
          : [],
        allowRecommendation: allowRecommendation.value,
      }),
    });
  } catch (reason) {
    assistanceError.value =
      reason instanceof Error ? reason.message : 'The analysis could not be produced.';
  } finally {
    assistanceBusy.value = false;
  }
}

async function decide(decision: 'approve' | 'reject') {
  const record = assistance.value;
  if (!record) return;
  if (!decisionReason.value.trim()) {
    assistanceError.value = 'Give a reason. It is recorded against the decision.';
    return;
  }
  assistanceBusy.value = true;
  assistanceError.value = '';
  try {
    assistance.value = await apiRequest<AssistanceRecord>(`/ai/assistance/${record.id}/decisions`, {
      method: 'POST',
      body: JSON.stringify({ decision, reason: decisionReason.value.trim() }),
    });
    decisionReason.value = '';
  } catch (reason) {
    assistanceError.value =
      reason instanceof Error ? reason.message : 'The decision could not be recorded.';
  } finally {
    assistanceBusy.value = false;
  }
}

/** Re-reads one record, so a decision made elsewhere is visible here. */
async function refreshAssistance() {
  const record = assistance.value;
  if (!record) return;
  try {
    assistance.value = await apiRequest<AssistanceRecord>(`/ai/assistance/${record.id}`);
  } catch {
    // Keep what is on screen: the last successful read is still the truest
    // thing available, and blanking it would lose the recommendation.
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

    <!-- ADVISORY ASSISTANCE --------------------------------------------------
      Kept apart from the chat below, because they end differently. The chat
      answers a question and nothing follows. This analyses a situation, may
      return a recommendation, and that recommendation is approved or rejected
      by a person — with a reason, recorded against the record.
    -->
    <section
      v-if="!disabled"
      class="panel"
      data-testid="assistance-panel"
      aria-labelledby="assistance-heading"
    >
      <header class="panel-header">
        <div>
          <h2 id="assistance-heading">Advisory analysis</h2>
          <p>
            Describe a situation and the platform analyses it. A recommendation is produced only if
            you ask for one, and it does nothing until a person approves it.
          </p>
        </div>
      </header>

      <label class="analyzer-field">
        <span>What is happening</span>
        <textarea
          v-model="situation"
          rows="3"
          data-testid="assistance-question"
          placeholder="MTN queue has been growing for twenty minutes while throughput looks normal."
        ></textarea>
      </label>
      <label class="analyzer-field">
        <span>Evidence — one observation per line (optional)</span>
        <textarea
          v-model="evidenceText"
          rows="3"
          data-testid="assistance-evidence"
          placeholder="queue depth 4,200 and rising&#10;bind state bound since 09:12&#10;no DLRs received since 09:30"
        ></textarea>
      </label>

      <label class="toggle">
        <input
          v-model="allowRecommendation"
          type="checkbox"
          data-testid="assistance-allow-recommendation"
        />
        <span>
          Also recommend an action. Left off, the analysis stops at what it observed — which is the
          right default for a question you are exploring rather than acting on.
        </span>
      </label>

      <footer class="detail-actions">
        <button
          class="primary-button"
          type="button"
          :disabled="assistanceBusy"
          data-testid="assistance-submit"
          @click="askAssistance"
        >
          {{ assistanceBusy ? 'Analysing…' : 'Analyse' }}
        </button>
      </footer>

      <p v-if="assistanceError" class="form-error" role="alert" data-testid="assistance-error">
        {{ assistanceError }}
      </p>

      <template v-if="assistance">
        <dl class="detail-grid" data-testid="assistance-result">
          <dt>Observed</dt>
          <dd>{{ assistance.observedBehaviour }}</dd>
          <dt>Reasoning</dt>
          <dd>
            <ul class="reasoning-list">
              <li v-for="(step, index) in assistance.reasoning" :key="index">{{ step }}</li>
            </ul>
          </dd>
          <dt>Confidence</dt>
          <!--
            A number and a risk band together. Confidence alone reads as
            authority; risk is what says how much a wrong answer would cost.
          -->
          <dd class="mono">
            {{ Math.round((assistance.confidence ?? 0) * 100) }}% · {{ assistance.risk }} risk
          </dd>
          <dt>Status</dt>
          <dd>
            <span
              class="status-badge"
              :class="assistance.status === 'approved' ? 'good' : 'warn'"
              >{{ assistance.status }}</span
            >
          </dd>
        </dl>

        <p
          v-if="assistance.recommendation"
          class="warn-notice"
          role="note"
          data-testid="assistance-recommendation"
        >
          <strong>Recommended:</strong> {{ assistance.recommendation }}
          <br />
          Nothing has been done. This is a suggestion recorded for a person to accept or refuse.
        </p>
        <p v-else class="source-note" data-testid="assistance-no-recommendation">
          No recommendation was produced — either none was asked for, or the analysis did not reach
          one. The observation above stands on its own.
        </p>

        <template v-if="assistance.recommendation && canDecide">
          <label class="analyzer-field">
            <span>Reason for your decision</span>
            <input v-model="decisionReason" type="text" data-testid="assistance-reason" />
          </label>
          <footer class="detail-actions">
            <button
              class="primary-button"
              type="button"
              :disabled="assistanceBusy"
              data-testid="assistance-approve"
              @click="decide('approve')"
            >
              Approve
            </button>
            <button
              class="secondary-button danger-button"
              type="button"
              :disabled="assistanceBusy"
              data-testid="assistance-reject"
              @click="decide('reject')"
            >
              Reject
            </button>
            <button
              class="secondary-button"
              type="button"
              data-testid="assistance-refresh"
              @click="refreshAssistance"
            >
              Re-read
            </button>
          </footer>
          <p class="source-note">
            Approving records the decision and who made it. It does not execute anything — this
            platform has no path by which an analysis acts on its own.
          </p>
        </template>
        <p
          v-else-if="assistance.recommendation"
          class="source-note"
          data-testid="assistance-cannot-decide"
        >
          Accepting or refusing a recommendation needs the
          <span class="mono">system.manage</span> permission. Asking for one needs only
          <span class="mono">monitoring.view</span>.
        </p>
      </template>
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

<style scoped>
.analyzer-field {
  display: grid;
  gap: 6px;
  margin-top: 12px;
  font-size: 13.5px;
}
.analyzer-field textarea,
.analyzer-field input {
  width: 100%;
}
.toggle {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 12px;
  font-size: 13.5px;
  line-height: 1.5;
}
.reasoning-list {
  margin: 0;
  padding-left: 18px;
  display: grid;
  gap: 3px;
}
</style>
<style src="./workspace-extras.css"></style>
