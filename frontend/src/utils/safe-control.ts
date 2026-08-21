/**
 * The safe-control vocabulary shared by the confirmation dialog, the failover
 * screen, the route simulator and the test tools (PLAN.md Phase 5, spec §1.1,
 * §9, §15, §16).
 *
 * Four rules live here rather than in four screens:
 *
 * - **The impact of an action is the backend's to state, not the console's.**
 *   `ActionImpact` is transported verbatim. There is deliberately no helper that
 *   summarises, shortens or re-tones `consequences`: they were computed from
 *   live state (queue depth, route count, connection count) and a client-side
 *   paraphrase would be a claim nobody measured. The only thing this file adds
 *   is the *verb*, which is a label and not a statement about the system.
 * - **A reason is validated the way the API validates it, before the request.**
 *   `SafeControlService.requireReason` demands 3–500 characters and answers a
 *   400 otherwise. Re-stating the rule here is not duplication for its own sake:
 *   a red "Request failed (400)" after the dialog has already closed tells an
 *   operator nothing, and the reason they typed is gone.
 * - **Not every endpoint keeps the reason it is given.** `/control/*` records it
 *   in the audit trail and in an operational event. `/smscs/:id/actions/*` takes
 *   no body at all in this build, so the reason is captured and then dropped.
 *   {@link reasonIsRecorded} exists so the dialog can say which of the two is
 *   happening instead of promising an audit entry that will not exist.
 * - **A manual override is never implicit.** {@link activePathOf} returns the
 *   route's real current target AND whether an override put it there, as one
 *   value, so a screen cannot render the target without the mode (UC-RTE-02).
 */
import type { Tone } from './connectivity';

// --- GET /control/smscs/:id/impact/:operation --------------------------------

/** Mirrors `ActionImpact` in backend/src/connectivity/safe-control.service.ts. */
export interface ActionImpact {
  operation: string;
  subject: string;
  /** One sentence stating what will happen. Rendered verbatim. */
  summary: string;
  /** Specific consequences, each already true of this system. Verbatim. */
  consequences: string[];
  /** Messages queued behind this object, or null when the engine said nothing. */
  queuedMessages: number | null;
  reasonRequired: boolean;
  /** Set when the action cannot proceed at all. Disables confirm outright. */
  blockedReason: string | null;
}

/** Exactly the five the controller accepts; anything else is a 400. */
export const CONTROL_OPERATIONS = ['reconnect', 'disable', 'enable', 'suspend', 'resume'] as const;
export type ControlOperation = (typeof CONTROL_OPERATIONS)[number];

/** The button label. A verb, never a description of what will happen. */
const OPERATION_VERBS: Record<ControlOperation, string> = {
  reconnect: 'Reconnect',
  disable: 'Disable',
  enable: 'Enable',
  suspend: 'Suspend traffic',
  resume: 'Resume traffic',
};

export function operationVerb(operation: string): string {
  return OPERATION_VERBS[operation as ControlOperation] ?? operation;
}

/**
 * Operations whose endpoint actually persists the reason.
 *
 * `suspend` and `resume` go to `POST /control/smscs/:id/{suspend,resume}`, which
 * writes an `audit_log` row and an operational event inside the same
 * transaction as the change. `reconnect`, `disable` and `enable` go to
 * `POST /smscs/:id/actions/:operation`, whose handler declares only an
 * `Idempotency-Key` header — it does not read a body, so a reason sent to it is
 * discarded. The dialog says so rather than claiming an audit entry.
 */
const REASON_RECORDED: Record<ControlOperation, boolean> = {
  reconnect: false,
  disable: false,
  enable: false,
  suspend: true,
  resume: true,
};

export function reasonIsRecorded(operation: string): boolean {
  return REASON_RECORDED[operation as ControlOperation] ?? false;
}

/** The path a confirmed operation posts to. */
export function controlEndpoint(operation: ControlOperation, smscId: string): string {
  return operation === 'suspend' || operation === 'resume'
    ? `/control/smscs/${smscId}/${operation}`
    : `/smscs/${smscId}/actions/${operation}`;
}

// --- Reasons ------------------------------------------------------------------

/** `MIN_REASON` in safe-control.service.ts. */
export const MIN_REASON_LENGTH = 3;
/** The controller's upper bound, so a 501-character reason fails here first. */
export const MAX_REASON_LENGTH = 500;

/**
 * The API's own rejection, applied before the request.
 *
 * Returns an empty string when the reason is acceptable. The wording deliberately
 * says what the reason is FOR — a box that only says "required" gets filled with
 * "x", which passes the length check and explains nothing six hours later.
 */
export function reasonProblem(reason: string, required: boolean): string {
  const text = String(reason ?? '').trim();
  if (!required) return text.length > MAX_REASON_LENGTH ? tooLong() : '';
  if (!text)
    return 'A reason is required. It is what makes this action explicable to whoever reads the incident afterwards.';
  if (text.length < MIN_REASON_LENGTH)
    return `A reason must be at least ${MIN_REASON_LENGTH} characters.`;
  return text.length > MAX_REASON_LENGTH ? tooLong() : '';
}

const tooLong = () => `A reason must be at most ${MAX_REASON_LENGTH} characters.`;

// --- GET /control/failovers ----------------------------------------------------

/** One row of `activeFailovers` in safe-control.service.ts. */
export interface ActiveFailover {
  id: string;
  route_id: string;
  route_name: string | null;
  from_smsc_id: string | null;
  to_smsc_id: string | null;
  to_engine_id: string | null;
  to_name: string | null;
  reason: string | null;
  started_by: string | null;
  started_at: string;
}

/** A row of `GET /routes` (console.repository.ts `listRoutes`). */
export interface RouteRow {
  id: string;
  name: string;
  priority: number | null;
  enabled: boolean;
  destination_prefix: string | null;
  sender: string | null;
  target_smsc_id: string | null;
  target_smsc_name: string | null;
  fallback_smsc_id: string | null;
  fallback_smsc_name: string | null;
}

/**
 * Where a route's traffic is actually going, and why it is going there.
 *
 * UC-RTE-02's UI requirement is that the console "always shows the current
 * active path and never hides that a manual override is in effect". Returning
 * the target and the mode as ONE value is how that is enforced: a screen cannot
 * render `activePathOf(...).targetName` without having the `overridden` flag in
 * hand, so there is no shape of this data that shows the target alone.
 */
export interface ActivePath {
  /** The SMSC id traffic is on now — the override's target when one is active. */
  targetId: string | null;
  /** A human label for it. Never blank; says what is missing when it is. */
  targetName: string;
  /** True when a manual failover, not the route's configuration, decided this. */
  overridden: boolean;
  /** The route's own configured target, whatever the override says. */
  configuredName: string;
  /** The active override, when there is one. */
  failover: ActiveFailover | null;
  /** `manual override` / `automatic`. Health is never colour alone (§17.1). */
  modeWord: string;
  modeTone: Tone;
}

export function activePathOf(route: RouteRow, failovers: readonly ActiveFailover[]): ActivePath {
  const failover = failovers.find((entry) => entry.route_id === route.id) ?? null;
  const configuredName = route.target_smsc_name ?? route.target_smsc_id ?? 'no target configured';
  if (!failover)
    return {
      targetId: route.target_smsc_id,
      targetName: configuredName,
      overridden: false,
      configuredName,
      failover: null,
      modeWord: 'automatic',
      modeTone: 'muted',
    };
  return {
    targetId: failover.to_smsc_id,
    targetName:
      failover.to_name ?? failover.to_engine_id ?? failover.to_smsc_id ?? 'unknown target',
    overridden: true,
    configuredName,
    failover,
    // `warn`, not `bad`: an override is a deliberate operator decision, not a
    // fault. It is highlighted because it is easy to forget, not because it is
    // wrong.
    modeWord: 'manual override',
    modeTone: 'warn',
  };
}

/** Who started an override. Never blank — an unattributed change says so. */
export function actorLabel(value: string | null | undefined): string {
  const text = String(value ?? '').trim();
  return text || 'not recorded';
}

// --- POST /routing/resolve -----------------------------------------------------

/** `SelectionResult` + the two fields routing-depth.service.ts adds. */
export interface ResolveResult {
  msisdn?: string;
  smscId: string | null;
  routeId: string | null;
  routeName: string | null;
  strategy: string | null;
  fallbackUsed: boolean;
  reason: string;
  trace: string[];
  candidatesConsidered: number;
}

/** An option in the SMSC pickers, and the id/name map the screens read from. */
export interface SmscOption {
  /** `smsc_definitions.id` — the UUID every control endpoint takes. */
  id: string;
  engineId: string;
  name: string;
  label: string;
  /**
   * Operational fields, present when the caller read them from `GET /smscs`
   * (which returns them all) and absent when it did not.
   *
   * Optional rather than required because several screens use this map purely
   * to turn a uuid into a name and have no business asserting anything about
   * a bind's health. `null` means the register carried the field and it was
   * unmeasured; `undefined` means this caller never asked.
   */
  priority?: number | null;
  bindState?: string | null;
  /** Per-connection ceiling. Kannel enforces `throughput` per bind. */
  tps?: number | null;
  connections?: number;
  outboundRate?: number | null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function smscOptionsFrom(
  rows: readonly Record<string, unknown>[],
): SmscOption[] {
  return rows
    .map((row) => {
      const id = typeof row.id === 'string' ? row.id : '';
      const engineId = typeof row.engine_id === 'string' ? row.engine_id : '';
      const name = typeof row.name === 'string' && row.name ? row.name : engineId;
      return {
        id,
        engineId,
        name,
        label: engineId ? `${name} (${engineId})` : name,
        priority: numberOrNull(row.priority),
        bindState: typeof row.bind_state === 'string' ? row.bind_state : null,
        tps: numberOrNull(row.tps),
        connections: Math.max(1, numberOrNull(row.connection_count) ?? 1),
        outboundRate: numberOrNull(row.outbound_rate),
      };
    })
    .filter((option) => option.id);
}

/**
 * Spare capacity on a connection, in messages per second.
 *
 * Null when either side is unknown, and that is two different unknowns held
 * apart deliberately: no declared ceiling means Kannel imposes no limit we know
 * of, and no observed rate means the poller has not seen this bind. Returning 0
 * for either would read as "this connection is full", which is the reading that
 * would divert traffic away from a perfectly healthy bind.
 */
export function smscHeadroom(option: SmscOption): number | null {
  if (option.tps === null || option.tps === undefined) return null;
  if (option.outboundRate === null || option.outboundRate === undefined) return null;
  return Math.max(0, option.tps * (option.connections ?? 1) - option.outboundRate);
}

/** The label for an SMSC uuid, or the uuid itself when it is not in the map. */
export function smscLabel(id: string | null | undefined, options: readonly SmscOption[]): string {
  if (!id) return 'none';
  return options.find((option) => option.id === id)?.label ?? id;
}

// --- GET /diagnostics/number-lookup --------------------------------------------

/** A configured prefix that matches, from `test-tools.service.ts`. */
export interface PrefixMatch {
  id: string;
  name: string | null;
  match_prefix: string | null;
  priority: number | null;
  enabled: boolean;
  deployment_state: string | null;
  target_engine_id: string | null;
}

export interface NumberLookup {
  input: string;
  normalized: string | null;
  digits: string;
  valid: boolean;
  problem: string | null;
  matchingPrefixes: PrefixMatch[];
  /**
   * Why this answer is the shape it is. Rendered VERBATIM and in full: the first
   * entry states that JKANNEL has no prefix-to-operator database, which is the
   * one thing an operator reading a number lookup assumes it does have.
   */
  limits: string[];
}

// --- GET /diagnostics/test-sends -----------------------------------------------

export interface TestSend {
  id: string;
  foreign_id: string;
  destination: string | null;
  reason: string | null;
  sent_by: string | null;
  created_at: string;
  engine_id: string | null;
}

// --- POST /smscs/:id/actions/test -----------------------------------------------

/**
 * How far a connectivity test actually got — `ConnectivityVerification` in
 * backend/src/smsc/smsc-connectivity.service.ts.
 *
 * `verified` is the field that matters and the reason this is typed at all:
 * `tcp_socket` proves a socket opened and nothing else, while `smpp_bind` proves
 * the credentials. A screen that renders only pass/fail turns the first into the
 * second, which is how a carrier password that was never accepted gets recorded
 * as a working connection.
 */
export interface ConnectivityVerification {
  verified: string;
  passed: boolean;
  reachable: boolean;
  bound: boolean | null;
  latencyMs: number;
  /** The operator-facing sentence. Rendered verbatim; it names its own level. */
  detail: string;
  /** Why the stronger bind check was not attempted, when it was not. */
  bindSkippedReason?: string | null;
  commandStatus?: number | null;
}

/** `POST /smscs/:id/actions/test` — the deployment row plus the verification. */
export interface ConnectivityTestResult {
  id?: string;
  status?: string | null;
  detail?: string | null;
  verification?: ConnectivityVerification | null;
  /** True when the idempotency key replayed an earlier attempt. */
  replayed?: boolean;
}

const VERIFICATION_WORDS: Record<string, string> = {
  smpp_bind: 'a real SMPP bind was accepted — the credentials are proven',
  tcp_socket: 'a TCP socket opened — the credentials were never exercised',
  bind_cycled: 'the bind was cycled',
  command_accepted: 'the engine accepted the command',
  not_applicable: 'this operation makes no verification claim',
};

/** The verification level in words. An unknown level stays unexplained. */
export function verificationWord(level: string | null | undefined): string {
  const key = String(level ?? '').trim();
  if (!key) return 'the engine reported no verification level for this attempt';
  return VERIFICATION_WORDS[key] ?? `reported as ${key}, which this console cannot explain`;
}

/**
 * Tone for a verification level.
 *
 * `tcp_socket` is deliberately `warn` even though the test passed: a green tick
 * next to "connectivity verified" is exactly how a socket check gets read as
 * proof that a bind would succeed.
 */
export function verificationTone(level: string | null | undefined, passed: boolean): Tone {
  if (!passed) return 'bad';
  switch (String(level ?? '').trim()) {
    case 'smpp_bind':
      return 'good';
    case 'tcp_socket':
      return 'warn';
    case '':
      return 'muted';
    default:
      return 'warn';
  }
}
