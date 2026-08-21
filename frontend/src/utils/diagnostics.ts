/**
 * The Diagnostics vocabulary shared by Message Trace, SMPP Errors and Events
 * (PLAN.md Phase 4, spec §10 §11 §12).
 *
 * `connectivity.ts` holds the Carrier → SMSC → bind words and `traffic.ts` the
 * rate and duration words; both are imported here rather than copied. This file
 * adds only what the three diagnostics screens need on top of them, and it
 * exists mainly to keep four rules that are easy to break one screen at a time:
 *
 * - **A latency nobody measured is an em dash, never `0ms`.** `latencyMs` is
 *   null on the first stage and on every stage whose neighbour has no timestamp
 *   — which is exactly the pending-receipt case. `0ms` there would read as an
 *   instantaneous delivery. `formatLatency` goes through `displayValue` so the
 *   §17 rule is enforced by the same function every other screen uses.
 * - **`pending` is not a failure.** The backend's own copy for a missing receipt
 *   says so in words; `stageTone` keeps that meaning in the colour by refusing
 *   to give `pending` a warning or danger tone, and `stageWord` gives it a word
 *   that describes waiting rather than breaking.
 * - **An undecoded SMPP status stays undecoded.** The decoder sets `name` to the
 *   hex value precisely when it has nothing to say; `isUndecodedStatus` detects
 *   that so the screen can say "only the carrier can say what this means"
 *   instead of dressing the row up like a known code.
 * - **A correlation id the API will reject is caught before the request.** The
 *   controller 400s on anything that is not a 36-character UUID, and a red
 *   "Request failed (400)" tells an operator nothing about what they typed.
 */
import { displayValue, type DataState } from './data-state';
import type { Tone } from './connectivity';
import { formatDuration } from './traffic';

// --- GET /diagnostics/messages/:id/lifecycle --------------------------------

export type StageKind = 'accepted' | 'routed' | 'spooled' | 'submitted' | 'receipt' | 'retry';
export type StageStatus = 'ok' | 'warning' | 'failed' | 'pending';

export interface TraceStage {
  kind: StageKind;
  label: string;
  status: StageStatus;
  at: string | null;
  /** Milliseconds since the previous stage. Null on the first, or if unknown. */
  latencyMs: number | null;
  detail: string;
  facts: Record<string, string | number | null>;
}

export interface AssembledTrace {
  stages: TraceStage[];
  totalMs: number | null;
  /** The first stage that is not `ok`. §10 asks for it to be highlighted. */
  firstProblem: { kind: StageKind; label: string; detail: string } | null;
  inFlight: boolean;
}

export interface MessageTrace {
  id: string;
  lifecycle: AssembledTrace;
  /** The raw engine rows, so the evidence is not hidden behind the reading. */
  events: Record<string, unknown>[];
  /** False when the engine message store could not be reached at all. */
  available: boolean;
  detail: string;
}

// --- GET /diagnostics/smpp-statuses -----------------------------------------

export interface SmppStatus {
  code: number;
  name: string;
  meaning: string;
  /** What to look at next. Guidance, never a root cause. */
  guidance: string;
  retryable: boolean;
}

export interface SmppStatusTable {
  statuses: SmppStatus[];
  /** Why guidance is guidance. Rendered verbatim; never paraphrased. */
  note: string;
}

// --- GET /diagnostics/events and /diagnostics/correlations/:id --------------

export interface OperationalEvent {
  id: string;
  kind: string;
  severity: string;
  summary: string;
  detail: Record<string, unknown> | null;
  subject_type: string | null;
  subject_id: string | null;
  correlation_id?: string | null;
  observed_at: string;
}

export interface CorrelatedAlert {
  id: string;
  dedup_key: string | null;
  severity: string;
  summary: string;
  opened_at: string;
  resolved_at: string | null;
}

export interface CorrelatedAudit {
  id: string;
  actor_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  created_at: string;
}

export interface CorrelationBundle {
  correlationId: string;
  events: OperationalEvent[];
  alerts: CorrelatedAlert[];
  audit: CorrelatedAudit[];
  /** The log caveat. Rendered verbatim on the drill-down; see EventsView. */
  note: string;
}

/** Severities the API stores, worst first — the order the filter offers them. */
export const EVENT_SEVERITIES = ['critical', 'warning', 'info'] as const;

/**
 * The §12.1 event vocabulary, mirroring `EVENT_KINDS` in
 * `backend/src/diagnostics/operational-events.service.ts`.
 *
 * Offered as suggestions on a free-text field rather than as a closed select:
 * the API matches `kind` as a PREFIX, so `smsc.` is a legitimate query that no
 * enumeration of full kinds would contain, and a deployment that emits a kind
 * this build has not heard of must still be reachable.
 */
export const EVENT_KIND_SUGGESTIONS = [
  'smsc.',
  'smsc.bind.lost',
  'smsc.bind.restored',
  'smsc.bind.failed',
  'smsc.session.flapping',
  'smsc.suspended',
  'smsc.resumed',
  'route.failover',
  'queue.',
  'queue.threshold.crossed',
  'queue.threshold.recovered',
  'dlr.quality.degraded',
  'dlr.quality.recovered',
  'service.restarted',
  'control.failure',
] as const;

/** Subject types the emitters actually write, for the subject-type filter. */
export const EVENT_SUBJECT_TYPES = ['smsc', 'route', 'queue', 'service'] as const;

// --- Formatters -------------------------------------------------------------

/**
 * A duration in milliseconds, at a resolution an operator can act on.
 *
 * Sub-second stays in milliseconds because that is where submit latency lives;
 * anything longer hands off to `formatDuration`, so a trace and a queue drain
 * estimate read in the same units.
 */
export function formatMilliseconds(value: number): string {
  const rounded = Math.round(value);
  if (Math.abs(rounded) < 1000) return `${rounded}ms`;
  const seconds = value / 1000;
  if (Math.abs(seconds) < 60) return `${Math.round(seconds * 10) / 10}s`;
  return formatDuration(seconds);
}

/**
 * Per-stage latency, or the em dash.
 *
 * Null is the common case, not the exception: the first stage has nothing to
 * measure from, and any stage next to one without a timestamp cannot be timed
 * either. Rendering that as `0ms` would claim the gateway did the work
 * instantaneously — which is precisely the reading an operator would act on.
 */
export function formatLatency(value: number | null | undefined, state: DataState = 'live'): string {
  return displayValue(value, state, formatMilliseconds);
}

/**
 * Tone for a stage.
 *
 * `pending` is deliberately `muted` and not `warn`. The backend's copy for a
 * missing receipt already says "that is not a failure"; painting the row amber
 * next to a genuinely failed stage would contradict the sentence underneath it,
 * and colour is what gets read first on a NOC screen.
 */
export function stageTone(status: StageStatus | null | undefined): Tone {
  switch (status) {
    case 'ok':
      return 'good';
    case 'warning':
      return 'warn';
    case 'failed':
      return 'bad';
    case 'pending':
    default:
      return 'muted';
  }
}

/**
 * The word beside the badge — health is never colour alone (§17.1).
 *
 * The `default` arm is not dead code despite the union: a deployment running a
 * newer backend can send a status this build has never heard of, and `unknown`
 * is the only honest thing to print for it.
 */
export function stageWord(status: StageStatus | null | undefined): string {
  switch (status) {
    case 'ok':
      return 'completed';
    case 'warning':
      return 'needs attention';
    case 'failed':
      return 'failed';
    case 'pending':
      return 'still waiting';
    default:
      return 'unknown';
  }
}

/**
 * When a stage happened.
 *
 * A pending stage has no timestamp because it has not happened yet, which is
 * different from a stage whose timestamp was not recorded. `formatMoment`
 * renders both as "never", and "never" is wrong for a receipt that may still
 * arrive in the next second.
 */
export function formatStageMoment(at: string | null | undefined, status: StageStatus): string {
  if (at) {
    const parsed = new Date(at);
    return Number.isNaN(parsed.getTime()) ? at : parsed.toLocaleString();
  }
  return status === 'pending' ? 'not yet' : 'not recorded';
}

/** `chosenBind` → `chosen bind`. Fact keys come from the API in camelCase. */
export function factLabel(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, (_match, before: string, after: string) => {
      // Sentence case, not title case: "Chosen bind" reads as a label, whereas
      // "Chosen Bind" reads as a proper noun the operator should recognise.
      return `${before} ${after.toLowerCase()}`;
    })
    .replace(/^./, (character) => character.toUpperCase());
}

/** Facts that name an SMSC, and can therefore link to its connection page. */
const BIND_FACTS = new Set(['bind', 'chosenBind', 'requestedBind']);

export function bindFactTarget(key: string, value: string | number | null): string {
  if (!BIND_FACTS.has(key)) return '';
  const id = typeof value === 'string' ? value.trim() : '';
  return id ? `/smsc/${encodeURIComponent(id)}` : '';
}

// --- SMPP status ------------------------------------------------------------

/** The eight-digit hex form, exactly as the decoder writes an unknown name. */
export function formatSmppCode(code: number): string {
  return `0x${Math.max(0, Math.trunc(code)).toString(16).padStart(8, '0')}`;
}

/** Both notations, because a carrier's docs and its logs rarely agree. */
export function formatSmppCodeBoth(code: number): string {
  return `${formatSmppCode(code)} · ${Math.trunc(code)}`;
}

/**
 * Whether the API had no description for this status.
 *
 * The decoder returns the hex string AS the name in exactly that case, so this
 * is a read of the contract rather than a guess. It is what lets the screen say
 * "only the carrier can say what this means" instead of presenting an invented
 * row that looks like the seventeen real ones above it.
 */
export function isUndecodedStatus(status: Pick<SmppStatus, 'code' | 'name'>): boolean {
  return status.name.trim().toLowerCase() === formatSmppCode(status.code);
}

/** The SMPP-defined vendor range. The one thing that IS known about an unknown code. */
export function isVendorSpecific(code: number): boolean {
  return code >= 0x0400 && code <= 0x04ff;
}

/** Retryable, in words. Never a bare boolean and never a colour on its own. */
export function retryWord(retryable: boolean): string {
  return retryable ? 'retry may succeed' : 'retrying will not help';
}

export function retryTone(retryable: boolean): Tone {
  return retryable ? 'warn' : 'muted';
}

export interface CodeParse {
  code: number | null;
  /** Empty when `code` is set. Mirrors the controller's own rejection reason. */
  error: string;
}

/**
 * Parses what the operator typed, the same way the controller does.
 *
 * The API accepts decimal or `0x`-prefixed hex and 400s on anything else. Doing
 * the parse here as well is not duplication for its own sake: a bare
 * "Request failed (400)" does not tell someone who pasted `ESME_RTHROTTLED`
 * what the box wanted.
 */
export function parseSmppCodeInput(raw: string): CodeParse {
  const value = String(raw ?? '').trim();
  if (!value) return { code: null, error: 'Enter a command status to look up.' };
  const hex = /^0x[0-9a-f]+$/i.test(value);
  const decimal = /^\d+$/.test(value);
  if (!hex && !decimal)
    return {
      code: null,
      error:
        'Enter the number, not the name: 88 in decimal or 0x58 in hex. The reference table below is searchable by name.',
    };
  const parsed = hex ? Number.parseInt(value, 16) : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff)
    return { code: null, error: 'A command status is a 32-bit integer, so 0 to 4294967295.' };
  return { code: parsed, error: '' };
}

/**
 * Whether a reference row matches what was typed in the table's search box.
 *
 * Matches the symbolic name, the plain meaning, and the code in either
 * notation, so `throttl`, `0x58` and `88` all find the same row.
 */
export function matchesStatusQuery(status: SmppStatus, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (status.name.toLowerCase().includes(needle)) return true;
  if (status.meaning.toLowerCase().includes(needle)) return true;
  if (String(status.code) === needle) return true;
  // Hex, in whatever width it was typed: `0x58`, `58` and `0x00000058` are all
  // the same status, and padding is what makes a naive substring test fail.
  if (!/^(0x)?[0-9a-f]+$/i.test(needle)) return false;
  const digits = needle.replace(/^0x/i, '').replace(/^0+/, '') || '0';
  return digits === status.code.toString(16);
}

// --- Events -----------------------------------------------------------------

export function severityTone(severity: string | null | undefined): Tone {
  switch ((severity ?? '').toLowerCase()) {
    case 'critical':
      return 'bad';
    case 'warning':
      return 'warn';
    case 'info':
      return 'good';
    default:
      return 'muted';
  }
}

/** Never blank: an event whose severity did not come back is not an `info`. */
export function severityWord(severity: string | null | undefined): string {
  return severity && String(severity).trim() ? String(severity) : 'unrecorded';
}

/** The subject an event is about, as one label. */
export function subjectLabel(event: Pick<OperationalEvent, 'subject_type' | 'subject_id'>): string {
  if (!event.subject_type && !event.subject_id) return 'the platform';
  return [event.subject_type, event.subject_id].filter(Boolean).join(' ');
}

/**
 * The controller's own guard: `/^[0-9a-f-]{36}$/i`.
 *
 * Deliberately the same loose shape rather than a strict UUID pattern — a
 * stricter check here would reject ids the API would have accepted, which is a
 * worse failure than passing one through and letting the API answer.
 */
export const CORRELATION_ID_PATTERN = /^[0-9a-f-]{36}$/i;

// --- GET /messages — finding the message before tracing it -------------------

/**
 * One row of the message search grid.
 *
 * This is the SQLBox projection `KamexSqlboxRepository.normalize()` returns,
 * narrowed to the fields the grid renders. It is deliberately NOT
 * {@link MessageTrace}: searching answers *which message did you mean*, tracing
 * answers *what happened to it*. Only the second assembles per-stage evidence,
 * so only the second is expensive — collapsing them would make every search pay
 * a lifecycle assembly for rows the operator is about to scroll past.
 *
 * Every field is nullable because the engine writes them at different points in
 * a message's life. `dlrAt` in particular is null for every message whose
 * receipt has not arrived, which is the ordinary state of a recent send rather
 * than a hole in the data — hence `formatFinal` below rather than a bare dash.
 */
export interface TraceSearchRow {
  id: string;
  externalRef: string | null;
  sender: string | null;
  receiver: string | null;
  smscId: string | null;
  deliveryStatus: string | null;
  timestamp: string | null;
  dlrAt: string | null;
  direction?: string | null;
  text?: string | null;
}

/**
 * The statuses the grid filter offers.
 *
 * These are the values `DELIVERY_STATUS_SQL` can actually produce, not a
 * superset: offering a filter that can never match anything teaches an operator
 * that the search is broken. `delivery_report` is excluded because a receipt row
 * is not a message an operator traces — it is evidence attached to one.
 */
export const TRACE_STATUS_FILTERS = [
  'delivered',
  'failed',
  'pending',
  'buffered',
  'accepted',
  'rejected',
] as const;

/**
 * Tone for a derived delivery status.
 *
 * `pending` is muted for the same reason it is muted on a stage: no receipt yet
 * is not a failure, and on a grid of forty rows the colour is the only thing
 * most people read.
 */
export function deliveryTone(status: string | null | undefined): Tone {
  switch ((status ?? '').toLowerCase()) {
    case 'delivered':
      return 'good';
    case 'failed':
    case 'rejected':
      return 'bad';
    case 'buffered':
      return 'warn';
    case 'accepted':
      return 'good';
    default:
      return 'muted';
  }
}

/**
 * The "Final" column: when the message reached a terminal outcome.
 *
 * Null means no receipt has been correlated. That is reported as *awaiting
 * receipt* rather than as an em dash, because the dash on this screen means "we
 * looked and there is nothing", and here we looked and found a message that is
 * simply not finished yet.
 */
export function formatFinal(dlrAt: string | null | undefined): string {
  if (!dlrAt) return 'awaiting receipt';
  const parsed = new Date(dlrAt);
  return Number.isNaN(parsed.getTime()) ? String(dlrAt) : parsed.toLocaleString();
}

/**
 * The kit's "Diagnostic summary" — the trace as text an operator can paste into
 * a carrier ticket.
 *
 * A line is emitted only for a fact that was actually recorded. The kit's mock
 * prints an em dash for everything it does not have; doing that here would put
 * "Carrier message ID: —" into a ticket, and the carrier reading it cannot tell
 * that from a message we failed to submit. Absent means absent.
 */
export function buildDiagnosticSummary(
  trace: MessageTrace,
  row: TraceSearchRow | null = null,
  carrier: string | null = null,
): string {
  const lines: string[] = [`Message ${trace.id}`];
  const push = (label: string, value: string | null | undefined) => {
    if (value !== null && value !== undefined && String(value).trim()) lines.push(`${label}: ${value}`);
  };

  push('Carrier message ID', row?.externalRef);
  push('Destination', row?.receiver ? `${row.receiver}${carrier ? ` (${carrier})` : ''}` : null);
  push('Sender', row?.sender);
  push('SMSC', row?.smscId);
  push('Submitted', row?.timestamp ? new Date(row.timestamp).toLocaleString() : null);
  push('Final', row?.dlrAt ? new Date(row.dlrAt).toLocaleString() : null);
  push('Outcome', row?.deliveryStatus);

  const total = trace.lifecycle?.totalMs;
  push('Elapsed across recorded stages', typeof total === 'number' ? formatMilliseconds(total) : null);
  push('Stages recorded', String(trace.lifecycle?.stages?.length ?? 0));

  const problem = trace.lifecycle?.firstProblem;
  lines.push(
    problem
      ? `First abnormal stage: ${problem.label} — ${problem.detail}`
      : 'All recorded stages completed normally.',
  );

  // Without this line a summary assembled while SQLBox was down looks identical
  // to one assembled from a complete read, and it is the half-read that gets
  // pasted into a ticket and argued over.
  if (trace.available === false)
    lines.push(`NOTE: the engine message store could not be read — ${trace.detail}`);

  return lines.join('\n');
}

export function isCorrelationId(value: string | null | undefined): boolean {
  return CORRELATION_ID_PATTERN.test(String(value ?? '').trim());
}
