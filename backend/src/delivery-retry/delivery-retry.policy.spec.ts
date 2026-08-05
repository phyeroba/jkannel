import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import {
  DELIVERY_RETRY_DEFAULTS,
  DeliveryRetryPolicyRow,
  classifyReport,
  parsePolicyInput,
  resolveRetryPolicy,
  scannableEvents,
  selectRetryBind,
} from './delivery-retry.policy';

const MIGRATION = resolve(
  __dirname,
  '../../../database/migrations/047_delivery_failure_retry.up.sql',
);

function policyRow(overrides: Partial<DeliveryRetryPolicyRow> = {}): DeliveryRetryPolicyRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    scope: 'tenant',
    smsc_id: null,
    customer_id: null,
    enabled: true,
    max_attempts: 1,
    retry_on_failed: true,
    retry_on_rejected: false,
    min_delay_seconds: 60,
    max_age_seconds: 3600,
    require_different_bind: true,
    charge_credit_on_retry: true,
    max_retries_per_minute: 60,
    bind_retries_per_minute: 30,
    created_by: 'u1',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('policy defaults', () => {
  it('is OFF when nothing is configured', () => {
    // The whole feature spends the operator's carrier credit. An upgrade must
    // not start doing that on its own.
    expect(resolveRetryPolicy([], {})).toEqual(DELIVERY_RETRY_DEFAULTS);
    expect(DELIVERY_RETRY_DEFAULTS.enabled).toBe(false);
  });

  it('does not retry a rejection by default', () => {
    // A rejection is usually the carrier refusing the submission itself, so
    // retrying it elsewhere burns credit and reads as spam to the operator.
    expect(DELIVERY_RETRY_DEFAULTS.retryOnRejected).toBe(false);
    expect(DELIVERY_RETRY_DEFAULTS.retryOnFailed).toBe(true);
  });

  it('matches the column defaults in migration 047', () => {
    // Two homes for the same number is two numbers waiting to disagree.
    const sql = readFileSync(MIGRATION, 'utf8');
    const columnDefault = (column: string): string => {
      const match = sql.match(
        new RegExp(`^\\s*${column}\\s+[a-z]+\\s+NOT NULL DEFAULT (\\S+)`, 'm'),
      );
      if (!match) throw new Error(`no default found for ${column} in migration 047`);
      return match[1].replace(/,$/, '');
    };
    expect(columnDefault('enabled')).toBe('false');
    expect(columnDefault('max_attempts')).toBe('1');
    expect(columnDefault('retry_on_failed')).toBe('true');
    expect(columnDefault('retry_on_rejected')).toBe('false');
    expect(columnDefault('min_delay_seconds')).toBe('60');
    expect(columnDefault('max_age_seconds')).toBe('3600');
    expect(columnDefault('require_different_bind')).toBe('true');
    expect(columnDefault('charge_credit_on_retry')).toBe('true');
    expect(columnDefault('max_retries_per_minute')).toBe('60');
    expect(columnDefault('bind_retries_per_minute')).toBe('30');
  });
});

describe('policy precedence', () => {
  const rows = [
    policyRow({ id: 'p-tenant', scope: 'tenant', max_attempts: 2, max_retries_per_minute: 100 }),
    policyRow({ id: 'p-smsc', scope: 'smsc', smsc_id: 'mtn-ug', max_attempts: 3 }),
    policyRow({ id: 'p-cust', scope: 'customer', customer_id: 'cust-1', max_attempts: 4 }),
  ];

  it('prefers customer, then smsc, then tenant', () => {
    expect(resolveRetryPolicy(rows, { smscId: 'mtn-ug', customerId: 'cust-1' }).policyId).toBe(
      'p-cust',
    );
    expect(resolveRetryPolicy(rows, { smscId: 'mtn-ug', customerId: 'other' }).policyId).toBe(
      'p-smsc',
    );
    expect(resolveRetryPolicy(rows, { smscId: 'airtel-ug' }).policyId).toBe('p-tenant');
  });

  it('takes the winning row WHOLE rather than merging columns', () => {
    // Every column is NOT NULL, so there is no way to say "inherit this one";
    // merging would attribute the tenant row's values to a scoped row.
    const resolved = resolveRetryPolicy(rows, { smscId: 'mtn-ug' });
    expect(resolved.maxAttempts).toBe(3);
    expect(resolved.scope).toBe('smsc');
  });

  it('always reads the storm cap from the TENANT row', () => {
    // A per-customer override of a tenant-wide cap would not be an override, it
    // would be a hole in the protection.
    const greedy = [
      policyRow({ id: 'p-tenant', scope: 'tenant', max_retries_per_minute: 10 }),
      policyRow({
        id: 'p-cust',
        scope: 'customer',
        customer_id: 'cust-1',
        max_retries_per_minute: 9999,
      }),
    ];
    expect(resolveRetryPolicy(greedy, { customerId: 'cust-1' }).maxRetriesPerMinute).toBe(10);
  });
});

describe('scannable events', () => {
  it('asks the engine only for events some enabled policy would act on', () => {
    expect(scannableEvents([policyRow()])).toEqual([2]);
    expect(scannableEvents([policyRow({ retry_on_rejected: true })])).toEqual([2, 16]);
    expect(
      scannableEvents([
        policyRow({ retry_on_failed: false, retry_on_rejected: true }),
        policyRow({ id: 'p2', scope: 'smsc', smsc_id: 'a' }),
      ]),
    ).toEqual([2, 16]);
  });

  it('returns nothing when every policy is disabled, so the scanner stands down', () => {
    expect(scannableEvents([policyRow({ enabled: false })])).toEqual([]);
    expect(scannableEvents([])).toEqual([]);
  });
});

describe('classifyReport — the MT-vs-DLR mask distinction', () => {
  const policy = resolveRetryPolicy([policyRow({ retry_on_rejected: true })], {});
  const now = Date.parse('2026-08-01T12:00:00.000Z');
  const at = (iso: string) => ({ dlrAt: iso });

  it('retries a DLR row reporting event 2 (failed)', () => {
    expect(classifyReport(policy, { dlrEvent: 2, ...at('2026-08-01T11:59:00.000Z') }, now)).toEqual(
      { retry: true },
    );
  });

  it('NEVER treats 31 as a failure', () => {
    // 31 is what an MT row carries: the mask the SENDER REQUESTED ("report every
    // event"), a subscription and not a status. Verified on the running stack:
    // every sent_sms MT row there has dlr_mask = 31. A retry path that read it
    // as an event would re-send the entire outbox.
    const verdict = classifyReport(
      policy,
      { dlrEvent: 31, ...at('2026-08-01T11:59:00.000Z') },
      now,
    );
    expect(verdict).toEqual({
      retry: false,
      recordable: false,
      reason: 'DLR event 31 is not a delivery failure',
    });
  });

  it('never retries a positive event', () => {
    for (const event of [1, 4, 8])
      expect(
        classifyReport(policy, { dlrEvent: event, ...at('2026-08-01T11:59:00.000Z') }, now),
      ).toMatchObject({ retry: false });
  });

  it('declines a rejection when the policy says so, and records the decision', () => {
    const strict = resolveRetryPolicy([policyRow({ retry_on_rejected: false })], {});
    expect(
      classifyReport(strict, { dlrEvent: 16, ...at('2026-08-01T11:59:00.000Z') }, now),
    ).toEqual({
      retry: false,
      recordable: true,
      reason: 'policy does not retry rejected (DLR 16)',
    });
  });

  it('declines a stale failure past the retry window', () => {
    const verdict = classifyReport(policy, { dlrEvent: 2, ...at('2026-08-01T10:00:00.000Z') }, now);
    expect(verdict).toMatchObject({ retry: false, recordable: true });
    expect((verdict as any).reason).toContain('7200s old');
  });

  it('declines silently when the policy is off, so the table is not filled with non-events', () => {
    const off = resolveRetryPolicy([policyRow({ enabled: false })], {});
    expect(
      classifyReport(off, { dlrEvent: 2, ...at('2026-08-01T11:59:00.000Z') }, now),
    ).toMatchObject({ retry: false, recordable: false });
  });
});

describe('bind selection', () => {
  const base = {
    available: ['mtn-ug', 'airtel-ug', 'utl-ug'],
    tried: ['mtn-ug'],
    entitled: null,
    recentByBind: {},
    bindRetriesPerMinute: 30,
    routed: null as string | null,
    requireDifferentBind: true,
  };

  it('never picks a bind the message has already been tried on', () => {
    const chosen = selectRetryBind({ ...base, tried: ['mtn-ug', 'airtel-ug'] });
    expect(chosen.smscId).toBe('utl-ug');
    expect(chosen.excluded).toEqual(expect.arrayContaining(['mtn-ug', 'airtel-ug']));
  });

  it('cannot ping-pong between two binds', () => {
    // Both binds tried, nothing else healthy: the chain stops rather than going
    // back to a bind that has already failed this message.
    const chosen = selectRetryBind({
      ...base,
      available: ['mtn-ug', 'airtel-ug'],
      tried: ['mtn-ug', 'airtel-ug'],
    });
    expect(chosen.smscId).toBeNull();
    expect(chosen.reason).toContain('not already been tried on');
  });

  it("honours the routing engine's choice when it is untried", () => {
    const chosen = selectRetryBind({ ...base, routed: 'airtel-ug' });
    expect(chosen).toMatchObject({ smscId: 'airtel-ug', selection: 'route' });
  });

  it('falls back to the least-loaded untried bind when the route is already tried', () => {
    const chosen = selectRetryBind({
      ...base,
      routed: 'mtn-ug',
      recentByBind: { 'airtel-ug': 12, 'utl-ug': 3 },
    });
    expect(chosen).toMatchObject({ smscId: 'utl-ug', selection: 'least-loaded' });
    expect(chosen.reason).toContain('already been tried on');
  });

  it('breaks the circuit on a bind that is absorbing too many retries', () => {
    const chosen = selectRetryBind({
      ...base,
      bindRetriesPerMinute: 10,
      recentByBind: { 'airtel-ug': 10, 'utl-ug': 4 },
    });
    expect(chosen.smscId).toBe('utl-ug');
    expect(chosen.excluded).toContain('airtel-ug');
    expect(chosen.reason).toContain('utl-ug');
  });

  it('gives up rather than piling onto a bind whose breaker has tripped', () => {
    const chosen = selectRetryBind({
      ...base,
      available: ['mtn-ug', 'airtel-ug'],
      bindRetriesPerMinute: 5,
      recentByBind: { 'airtel-ug': 5 },
    });
    expect(chosen.smscId).toBeNull();
    expect(chosen.reason).toContain('over its 5/min retry budget');
  });

  it('respects the customer route bindings', () => {
    const chosen = selectRetryBind({ ...base, entitled: ['utl-ug'] });
    expect(chosen.smscId).toBe('utl-ug');
    expect(chosen.excluded).toContain('airtel-ug');
  });

  it('re-uses the original bind only when the policy allows it', () => {
    const input = { ...base, available: ['mtn-ug'], tried: ['mtn-ug'] };
    expect(selectRetryBind(input).smscId).toBeNull();
    expect(selectRetryBind({ ...input, requireDifferentBind: false })).toMatchObject({
      smscId: 'mtn-ug',
      selection: 'same-bind',
    });
  });

  it('will not re-use the original bind when it is no longer healthy', () => {
    const chosen = selectRetryBind({
      ...base,
      available: [],
      tried: ['mtn-ug'],
      requireDifferentBind: false,
    });
    expect(chosen.smscId).toBeNull();
  });

  it('is deterministic when several binds are equally loaded', () => {
    const chosen = selectRetryBind({ ...base, tried: [] });
    expect(chosen.smscId).toBe('airtel-ug');
  });
});

describe('policy write validation', () => {
  it('defaults every unspecified field to the built-in default', () => {
    expect(parsePolicyInput({ scope: 'tenant', enabled: true })).toMatchObject({
      enabled: true,
      maxAttempts: DELIVERY_RETRY_DEFAULTS.maxAttempts,
      retryOnRejected: false,
      chargeCreditOnRetry: true,
    });
  });

  it('requires the scoping key its scope names', () => {
    expect(() => parsePolicyInput({ scope: 'smsc' })).toThrow(BadRequestException);
    expect(() => parsePolicyInput({ scope: 'customer' })).toThrow(BadRequestException);
    expect(() => parsePolicyInput({ scope: 'tenant', smscId: 'mtn-ug' })).toThrow(
      BadRequestException,
    );
  });

  it('rejects out-of-range values with the field name, matching the CHECK constraints', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    expect(sql).toContain(
      'max_attempts integer NOT NULL DEFAULT 1 CHECK (max_attempts BETWEEN 1 AND 5)',
    );
    expect(() => parsePolicyInput({ scope: 'tenant', maxAttempts: 6 })).toThrow(
      /maxAttempts must be an integer between 1 and 5/,
    );
    expect(() => parsePolicyInput({ scope: 'tenant', maxAgeSeconds: 5 })).toThrow(/maxAgeSeconds/);
    expect(() => parsePolicyInput({ scope: 'tenant', enabled: 'yes' })).toThrow(
      /enabled must be a boolean/,
    );
  });
});
