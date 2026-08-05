import { BadRequestException } from '@nestjs/common';
import { DLR_EVENT_FAILED, DLR_EVENT_REJECTED } from '../engine/kamex-sqlbox.repository';

/**
 * The decision layer of delivery-failure retry, kept free of I/O so every rule
 * in it is a pure function with a test rather than an assertion about a query.
 *
 * Nothing here talks to the database or the engine: {@link DeliveryRetryService}
 * loads the policy rows, the bind health and the recent-attempt counts and hands
 * them in.
 */

/** A resolved policy — the answer to "what should happen to THIS failure?". */
export interface DeliveryRetryPolicy {
  /** The row that decided it; null when nothing matched and defaults applied. */
  policyId: string | null;
  scope: 'default' | 'tenant' | 'smsc' | 'customer';
  enabled: boolean;
  maxAttempts: number;
  retryOnFailed: boolean;
  retryOnRejected: boolean;
  minDelaySeconds: number;
  maxAgeSeconds: number;
  requireDifferentBind: boolean;
  chargeCreditOnRetry: boolean;
  maxRetriesPerMinute: number;
  bindRetriesPerMinute: number;
}

/** A `delivery_retry_policies` row, as selected. */
export interface DeliveryRetryPolicyRow {
  id: string;
  scope: 'tenant' | 'smsc' | 'customer';
  smsc_id: string | null;
  customer_id: string | null;
  enabled: boolean;
  max_attempts: number;
  retry_on_failed: boolean;
  retry_on_rejected: boolean;
  min_delay_seconds: number;
  max_age_seconds: number;
  require_different_bind: boolean;
  charge_credit_on_retry: boolean;
  max_retries_per_minute: number;
  bind_retries_per_minute: number;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
}

/**
 * What applies when no policy row matches. `enabled: false` is the important
 * one: a deployment that has never configured delivery retry does not silently
 * start re-sending traffic and spending carrier credit after an upgrade.
 *
 * These mirror the column defaults in migration 047 and are asserted against
 * them by delivery-retry.policy.spec.ts, so the two cannot drift.
 */
export const DELIVERY_RETRY_DEFAULTS: DeliveryRetryPolicy = {
  policyId: null,
  scope: 'default',
  enabled: false,
  maxAttempts: 1,
  retryOnFailed: true,
  retryOnRejected: false,
  minDelaySeconds: 60,
  maxAgeSeconds: 3600,
  requireDifferentBind: true,
  chargeCreditOnRetry: true,
  maxRetriesPerMinute: 60,
  bindRetriesPerMinute: 30,
};

function fromRow(row: DeliveryRetryPolicyRow, tenantCap: number): DeliveryRetryPolicy {
  return {
    policyId: row.id,
    scope: row.scope,
    enabled: row.enabled,
    maxAttempts: Number(row.max_attempts),
    retryOnFailed: row.retry_on_failed,
    retryOnRejected: row.retry_on_rejected,
    minDelaySeconds: Number(row.min_delay_seconds),
    maxAgeSeconds: Number(row.max_age_seconds),
    requireDifferentBind: row.require_different_bind,
    chargeCreditOnRetry: row.charge_credit_on_retry,
    // Deliberately NOT taken from `row`: see resolveRetryPolicy.
    maxRetriesPerMinute: tenantCap,
    bindRetriesPerMinute: Number(row.bind_retries_per_minute),
  };
}

/**
 * Resolves the policy for one failed message.
 *
 * PRECEDENCE IS MOST-SPECIFIC-WINS AND THE WINNING ROW IS USED WHOLE: customer
 * scope, else the SMSC scope matching the bind that failed, else the tenant row,
 * else {@link DELIVERY_RETRY_DEFAULTS}. Columns are not merged across scopes,
 * because every column is NOT NULL and there would be no way to express
 * "inherit this one" — a merge would silently attribute the tenant row's values
 * to a scoped row that never asked for them.
 *
 * THE ONE EXCEPTION is `maxRetriesPerMinute`, which is always read from the
 * TENANT row (or the default). It is a storm cap protecting every bind the
 * tenant owns, and a per-customer row able to raise it would not be an override,
 * it would be a hole.
 */
export function resolveRetryPolicy(
  rows: DeliveryRetryPolicyRow[],
  context: { smscId?: string | null; customerId?: string | null },
): DeliveryRetryPolicy {
  const tenantRow = rows.find((row) => row.scope === 'tenant');
  const tenantCap = tenantRow
    ? Number(tenantRow.max_retries_per_minute)
    : DELIVERY_RETRY_DEFAULTS.maxRetriesPerMinute;

  const customerRow = context.customerId
    ? rows.find((row) => row.scope === 'customer' && row.customer_id === context.customerId)
    : undefined;
  if (customerRow) return fromRow(customerRow, tenantCap);

  const smscRow = context.smscId
    ? rows.find((row) => row.scope === 'smsc' && row.smsc_id === context.smscId)
    : undefined;
  if (smscRow) return fromRow(smscRow, tenantCap);

  if (tenantRow) return fromRow(tenantRow, tenantCap);
  return { ...DELIVERY_RETRY_DEFAULTS, maxRetriesPerMinute: tenantCap };
}

/**
 * The DLR events any enabled policy in this tenant would act on — the set the
 * scanner asks the engine for. A per-message policy still has the final say;
 * this only avoids reading receipts nobody could ever act on.
 *
 * Returns an empty array when the tenant has no enabled policy at all, which the
 * scanner treats as "do not run".
 */
export function scannableEvents(rows: DeliveryRetryPolicyRow[]): number[] {
  const events = new Set<number>();
  for (const row of rows) {
    if (!row.enabled) continue;
    if (row.retry_on_failed) events.add(DLR_EVENT_FAILED);
    if (row.retry_on_rejected) events.add(DLR_EVENT_REJECTED);
  }
  return [...events].sort((a, b) => a - b);
}

export type RetryVerdict = { retry: true } | { retry: false; recordable: boolean; reason: string };

/**
 * Should this delivery report open a retry chain?
 *
 * `recordable` distinguishes the two kinds of "no". A DISABLED policy declines
 * silently — recording a chain for every failure of a tenant that has the
 * feature off would fill the table with rows describing nothing having
 * happened. A policy that is ON but declines this particular failure (wrong
 * event, too old) IS recorded as a terminal chain, because "why was this not
 * retried?" is then a real operator question with a real answer.
 */
export function classifyReport(
  policy: DeliveryRetryPolicy,
  report: { dlrEvent: number; dlrAt: string | null },
  nowMs: number,
): RetryVerdict {
  if (!policy.enabled)
    return {
      retry: false,
      recordable: false,
      reason: `delivery retry is not enabled for this ${policy.scope === 'default' ? 'tenant' : policy.scope} scope`,
    };

  if (report.dlrEvent === DLR_EVENT_FAILED && !policy.retryOnFailed)
    return { retry: false, recordable: true, reason: 'policy does not retry failed (DLR 2)' };
  if (report.dlrEvent === DLR_EVENT_REJECTED && !policy.retryOnRejected)
    return { retry: false, recordable: true, reason: 'policy does not retry rejected (DLR 16)' };
  if (report.dlrEvent !== DLR_EVENT_FAILED && report.dlrEvent !== DLR_EVENT_REJECTED)
    return {
      retry: false,
      // Not recordable: trigger_dlr_event only accepts 2 and 16, and a row
      // claiming a delivered/buffered/accepted message failed would be a lie in
      // the table. Reaching here at all means the engine query was widened.
      recordable: false,
      reason: `DLR event ${report.dlrEvent} is not a delivery failure`,
    };

  const at = report.dlrAt ? Date.parse(report.dlrAt) : NaN;
  if (Number.isFinite(at)) {
    const ageSeconds = Math.floor((nowMs - at) / 1000);
    if (ageSeconds > policy.maxAgeSeconds)
      return {
        retry: false,
        recordable: true,
        reason: `failure is ${ageSeconds}s old, past the ${policy.maxAgeSeconds}s retry window`,
      };
  }
  return { retry: true };
}

export interface BindSelectionInput {
  /** Healthy, enabled binds for the tenant, as engine ids. */
  available: string[];
  /** Binds this message has already been submitted on, original first. */
  tried: string[];
  /** Binds the customer is entitled to; null when unconstrained. */
  entitled: string[] | null;
  /** Retries already aimed at each bind inside the breaker window. */
  recentByBind: Readonly<Record<string, number>>;
  bindRetriesPerMinute: number;
  /** The routing engine's own choice for this message, when it made one. */
  routed: string | null;
  requireDifferentBind: boolean;
}

export interface BindSelection {
  smscId: string | null;
  selection: 'route' | 'least-loaded' | 'same-bind' | null;
  /** Binds considered and ruled out, so the attempt row can say who and why. */
  excluded: string[];
  reason: string;
}

/**
 * Picks the bind a retry goes out on, or reports that there is none.
 *
 * THE ORDER, and why:
 *
 *   1. The ROUTING ENGINE's choice, when it is untried and passes the filters.
 *      Route configuration (cost, priority, time-of-day, the customer's
 *      bindings) is the operator's expressed intent about where traffic should
 *      go, and a retry has no business overriding it just because it is a retry.
 *   2. Otherwise the LEAST-LOADED untried candidate — fewest retries aimed at it
 *      in the breaker window, ties broken by engine id so the choice is
 *      deterministic and testable. Under a carrier outage this is what spreads
 *      the surviving traffic instead of piling it onto one bind.
 *   3. Otherwise, and only when the policy allows it, the bind that failed. This
 *      is off by default; it exists for single-carrier deployments where a
 *      transient failure is still worth one more attempt.
 *
 * THE BREAKER. A bind that has already absorbed `bindRetriesPerMinute` retries
 * inside the window is excluded outright. That is the circuit breaker: it is
 * per-target rather than global, because the failure mode being prevented is
 * "the carrier outage that failed everything now takes down the one bind that
 * was still up". A tripped breaker with no alternative ends the chain rather
 * than queueing behind itself, which is the correct behaviour under a storm —
 * the operator sees `no_bind` and the reason, not a silent backlog.
 */
export function selectRetryBind(input: BindSelectionInput): BindSelection {
  const tried = new Set(input.tried);
  const entitled = input.entitled ? new Set(input.entitled) : null;
  const excluded: string[] = [];
  const notes: string[] = [];

  const overBudget = (bind: string): boolean =>
    (input.recentByBind[bind] ?? 0) >= input.bindRetriesPerMinute;

  const candidates = input.available.filter((bind) => {
    if (tried.has(bind)) {
      excluded.push(bind);
      return false;
    }
    if (entitled && !entitled.has(bind)) {
      excluded.push(bind);
      return false;
    }
    if (overBudget(bind)) {
      excluded.push(bind);
      notes.push(`${bind} is over its ${input.bindRetriesPerMinute}/min retry budget`);
      return false;
    }
    return true;
  });

  if (input.routed && candidates.includes(input.routed))
    return {
      smscId: input.routed,
      selection: 'route',
      excluded,
      reason: `routing engine selected ${input.routed}, untried for this message`,
    };

  if (candidates.length) {
    const chosen = [...candidates].sort((a, b) => {
      const load = (input.recentByBind[a] ?? 0) - (input.recentByBind[b] ?? 0);
      return load !== 0 ? load : a.localeCompare(b);
    })[0];
    const why = input.routed
      ? `routing engine selected ${input.routed}, which this message has already been tried on`
      : 'routing engine selected no bind';
    return {
      smscId: chosen,
      selection: 'least-loaded',
      excluded,
      reason: `${why}; fell back to the least-loaded untried healthy bind ${chosen}`,
    };
  }

  if (!input.requireDifferentBind) {
    // The original bind is `tried[0]`. Reusing it is only honest when it is
    // currently healthy, entitled and not itself over budget.
    const origin = input.tried[0];
    if (
      origin &&
      input.available.includes(origin) &&
      (!entitled || entitled.has(origin)) &&
      !overBudget(origin)
    )
      return {
        smscId: origin,
        selection: 'same-bind',
        excluded,
        reason: `no untried bind is available; policy permits re-using ${origin}`,
      };
  }

  const detail = notes.length ? `; ${notes.join('; ')}` : '';
  return {
    smscId: null,
    selection: null,
    excluded,
    reason:
      `no healthy bind is available that this message has not already been tried on ` +
      `(tried: ${input.tried.join(', ') || 'none'}; healthy: ${input.available.join(', ') || 'none'})${detail}`,
  };
}

// ---------------------------------------------------------------------------
// Write-side validation for the policy endpoints
// ---------------------------------------------------------------------------

export interface PolicyInput {
  scope: 'tenant' | 'smsc' | 'customer';
  smscId: string | null;
  customerId: string | null;
  enabled: boolean;
  maxAttempts: number;
  retryOnFailed: boolean;
  retryOnRejected: boolean;
  minDelaySeconds: number;
  maxAgeSeconds: number;
  requireDifferentBind: boolean;
  chargeCreditOnRetry: boolean;
  maxRetriesPerMinute: number;
  bindRetriesPerMinute: number;
}

const bool = (value: unknown, fallback: boolean, name: string): boolean => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new BadRequestException(`${name} must be a boolean`);
  return value;
};

const integer = (value: unknown, fallback: number, name: string, min: number, max: number) => {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new BadRequestException(`${name} must be an integer between ${min} and ${max}`);
  return parsed;
};

/**
 * Parses a policy write. The bounds duplicate the CHECK constraints in migration
 * 047 on purpose: a 400 naming the field is a better answer than a 500 carrying
 * a constraint name, and the spec asserts the two agree.
 */
export function parsePolicyInput(body: Record<string, unknown>): PolicyInput {
  const scope = String(body.scope ?? 'tenant').trim();
  if (scope !== 'tenant' && scope !== 'smsc' && scope !== 'customer')
    throw new BadRequestException("scope must be one of 'tenant', 'smsc', 'customer'");

  const smscId = typeof body.smscId === 'string' && body.smscId.trim() ? body.smscId.trim() : null;
  const customerId =
    typeof body.customerId === 'string' && body.customerId.trim() ? body.customerId.trim() : null;

  if (scope === 'smsc' && !smscId)
    throw new BadRequestException("smscId is required when scope is 'smsc'");
  if (scope === 'customer' && !customerId)
    throw new BadRequestException("customerId is required when scope is 'customer'");
  if (scope === 'tenant' && (smscId || customerId))
    throw new BadRequestException(
      "a 'tenant' scope policy must not carry smscId or customerId; use the matching scope instead",
    );

  const defaults = DELIVERY_RETRY_DEFAULTS;
  return {
    scope,
    smscId: scope === 'smsc' ? smscId : null,
    customerId: scope === 'customer' ? customerId : null,
    enabled: bool(body.enabled, defaults.enabled, 'enabled'),
    maxAttempts: integer(body.maxAttempts, defaults.maxAttempts, 'maxAttempts', 1, 5),
    retryOnFailed: bool(body.retryOnFailed, defaults.retryOnFailed, 'retryOnFailed'),
    retryOnRejected: bool(body.retryOnRejected, defaults.retryOnRejected, 'retryOnRejected'),
    minDelaySeconds: integer(
      body.minDelaySeconds,
      defaults.minDelaySeconds,
      'minDelaySeconds',
      0,
      3600,
    ),
    maxAgeSeconds: integer(body.maxAgeSeconds, defaults.maxAgeSeconds, 'maxAgeSeconds', 60, 604800),
    requireDifferentBind: bool(
      body.requireDifferentBind,
      defaults.requireDifferentBind,
      'requireDifferentBind',
    ),
    chargeCreditOnRetry: bool(
      body.chargeCreditOnRetry,
      defaults.chargeCreditOnRetry,
      'chargeCreditOnRetry',
    ),
    maxRetriesPerMinute: integer(
      body.maxRetriesPerMinute,
      defaults.maxRetriesPerMinute,
      'maxRetriesPerMinute',
      1,
      10000,
    ),
    bindRetriesPerMinute: integer(
      body.bindRetriesPerMinute,
      defaults.bindRetriesPerMinute,
      'bindRetriesPerMinute',
      1,
      10000,
    ),
  };
}
