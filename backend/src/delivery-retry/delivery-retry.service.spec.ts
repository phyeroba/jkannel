import { NegativeDeliveryReport } from '../engine/kamex-sqlbox.repository';
import { DeliveryRetryPolicyRow } from './delivery-retry.policy';
import { DeliveryRetryService } from './delivery-retry.service';

const actor = { tenantId: '1', userId: 'u1' };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function policyRow(overrides: Partial<DeliveryRetryPolicyRow> = {}): DeliveryRetryPolicyRow {
  return {
    id: id(1),
    scope: 'tenant',
    smsc_id: null,
    customer_id: null,
    enabled: true,
    max_attempts: 1,
    retry_on_failed: true,
    retry_on_rejected: false,
    // 0 so a dispatch in a test is due immediately; the production default of
    // 60s is asserted in delivery-retry.policy.spec.ts.
    min_delay_seconds: 0,
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

function report(overrides: Partial<NegativeDeliveryReport> = {}): NegativeDeliveryReport {
  return {
    dlrSqlId: '500',
    foreignId: '42',
    dlrEvent: 2,
    dlrAt: new Date().toISOString(),
    detail: 'ACK/undeliverable',
    sender: 'JKANNEL',
    receiver: '256700000001',
    text: 'your code is 1234',
    smscId: 'mtn-ug',
    requestedDlrMask: 31,
    dlrUrl: null,
    sentAt: new Date().toISOString(),
    ...overrides,
  };
}

interface Fixture {
  policies?: DeliveryRetryPolicyRow[];
  reports?: NegativeDeliveryReport[];
  /** message_route_decisions rows, keyed by message_ref. */
  decisions?: Record<
    string,
    { id: string; customer_id: string | null; channel: string; sender: string; destination: string }
  >;
  smscs?: string[];
  available?: string[];
  routed?: string | null;
  /** Engine DLR events by foreign_id, for the late-positive-report checks. */
  latestEvents?: Record<string, { event: number; at: string | null }>;
  customerBindings?: Array<{ engine_id: string | null; route_target: string | null }>;
  engineAvailable?: boolean;
  /** Makes MessageSendService.send throw, simulating a refusal. */
  sendThrows?: string;
  watermark?: string;
}

function makeStack(fixture: Fixture = {}) {
  const state = {
    chains: [] as any[],
    attempts: [] as any[],
    jobs: [] as Array<{ id: string; type: string; input: any; key: string | null; runAt: any }>,
    audits: [] as Array<{ action: string; value: any }>,
    sends: [] as any[],
    scanState: {
      id: id(900),
      watermark_sql_id: fixture.watermark ?? '0',
      poll_interval_seconds: 60,
      last_scanned_at: null as any,
      last_error: null as string | null,
      reports_seen: '0',
      chains_opened: '0',
      created_at: 'now',
      updated_at: 'now',
    },
    policies: fixture.policies ?? [policyRow()],
  };
  let sequence = 0;

  const chainById = (value: string) => state.chains.find((row) => row.id === value);

  const client: any = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      const text = sql.trim();

      // ---- policies --------------------------------------------------------
      if (text.startsWith('SELECT') && text.includes('FROM delivery_retry_policies'))
        return { rows: state.policies };
      if (text.startsWith('INSERT INTO delivery_retry_policies')) {
        const row = policyRow({
          id: id(10 + state.policies.length),
          scope: params[1],
          smsc_id: params[2],
          customer_id: params[3],
          enabled: params[4],
          max_attempts: params[5],
          retry_on_failed: params[6],
          retry_on_rejected: params[7],
          min_delay_seconds: params[8],
          max_age_seconds: params[9],
          require_different_bind: params[10],
          charge_credit_on_retry: params[11],
          max_retries_per_minute: params[12],
          bind_retries_per_minute: params[13],
        });
        const existing = state.policies.findIndex(
          (p) =>
            p.scope === row.scope && p.smsc_id === row.smsc_id && p.customer_id === row.customer_id,
        );
        if (existing >= 0) state.policies[existing] = { ...state.policies[existing], ...row };
        else state.policies.push(row);
        return { rows: [row] };
      }
      if (text.startsWith('DELETE FROM delivery_retry_policies')) {
        const index = state.policies.findIndex((p) => p.id === params[0]);
        if (index < 0) return { rows: [] };
        const [removed] = state.policies.splice(index, 1);
        return { rows: [{ id: removed.id, scope: removed.scope }] };
      }

      // ---- attempts (most specific predicates first) ------------------------
      if (text.includes('FROM message_delivery_retry_attempts WHERE message_ref=$1')) {
        const found = state.attempts.find((a) => a.message_ref === params[0]);
        return { rows: found ? [{ id: found.id, retry_id: found.retry_id }] : [] };
      }
      if (text.includes('SELECT message_ref FROM message_delivery_retry_attempts'))
        return {
          rows: state.attempts
            .filter((a) => a.retry_id === params[0] && a.message_ref)
            .map((a) => ({ message_ref: a.message_ref })),
        };
      if (
        text.startsWith('SELECT smsc_id, count(*)::text count FROM message_delivery_retry_attempts')
      ) {
        const byBind = new Map<string, number>();
        for (const attempt of state.attempts)
          if (attempt.smsc_id) byBind.set(attempt.smsc_id, (byBind.get(attempt.smsc_id) ?? 0) + 1);
        return { rows: [...byBind].map(([smsc_id, count]) => ({ smsc_id, count: String(count) })) };
      }
      if (text.includes('count(*)::text count FROM message_delivery_retry_attempts'))
        return { rows: [{ count: String(state.attempts.length) }] };
      if (text.startsWith('INSERT INTO message_delivery_retry_attempts')) {
        const guarded = text.includes('WHERE EXISTS');
        const [, retryId, attemptNo] = params;
        // UNIQUE (tenant_id, retry_id, attempt_no).
        if (state.attempts.some((a) => a.retry_id === retryId && a.attempt_no === attemptNo))
          return { rows: [] };
        if (guarded) {
          const chain = chainById(retryId);
          if (!chain || chain.status !== 'retrying' || chain.attempts !== attemptNo)
            return { rows: [] };
        }
        sequence += 1;
        const row = {
          id: id(300 + sequence),
          retry_id: retryId,
          attempt_no: attemptNo,
          smsc_id: params[3],
          excluded_smsc_ids: params[4],
          selection: params[5],
          // The guarded INSERT ... SELECT hard-codes 'submitted'; the plain
          // VALUES form carries the outcome in $7.
          outcome: guarded ? 'submitted' : params[6],
          message_ref: params[7],
          decision_id: params[8],
          charged: params[9],
          dlr_event: null,
          dlr_at: null,
          reason: params[10],
          created_at: 'now',
        };
        state.attempts.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (text.startsWith('UPDATE message_delivery_retry_attempts SET dlr_event=$2')) {
        const row = state.attempts.find((a) => a.id === params[0]);
        if (row) {
          row.dlr_event = params[1];
          row.dlr_at = params[2];
        }
        return { rows: [] };
      }
      if (text.startsWith('UPDATE message_delivery_retry_attempts SET dlr_event=$3')) {
        const row = state.attempts.find(
          (a) => a.retry_id === params[0] && a.attempt_no === params[1],
        );
        if (row) {
          row.dlr_event = params[2];
          row.dlr_at = params[3];
        }
        return { rows: [] };
      }
      if (text.startsWith('UPDATE message_delivery_retry_attempts SET charged=$3')) {
        const row = state.attempts.find(
          (a) => a.retry_id === params[0] && a.attempt_no === params[1],
        );
        if (row) row.charged = params[2];
        return { rows: [] };
      }
      if (
        text.includes('FROM message_delivery_retry_attempts') &&
        text.includes('ORDER BY attempt_no')
      )
        return { rows: state.attempts.filter((a) => a.retry_id === params[0]) };

      // ---- chains ----------------------------------------------------------
      if (text.startsWith('INSERT INTO message_delivery_retries')) {
        // UNIQUE (tenant_id, origin_message_ref) — the duplicate-retry guard.
        if (state.chains.some((c) => c.origin_message_ref === params[1])) return { rows: [] };
        sequence += 1;
        const row = {
          id: id(200 + sequence),
          origin_message_ref: params[1],
          origin_decision_id: params[2],
          customer_id: params[3],
          origin_channel: params[4],
          sender: params[5],
          destination: params[6],
          body: params[7],
          origin_smsc_id: params[8],
          tried_smsc_ids: [params[8]],
          trigger_dlr_event: params[9],
          trigger_dlr_sql_id: params[10],
          trigger_dlr_at: params[11],
          trigger_detail: params[12],
          status: params[13],
          attempts: 0,
          max_attempts: params[14],
          policy_id: params[15],
          job_id: null,
          last_error: null,
          terminal_reason: params[16],
          resolved_at: params[17],
          created_at: 'now',
          updated_at: 'now',
        };
        state.chains.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (text.includes("SET status='retrying'")) {
        const chain = chainById(params[0]);
        if (
          !chain ||
          !['pending', 'retrying'].includes(chain.status) ||
          chain.attempts >= chain.max_attempts
        )
          return { rows: [] };
        chain.status = 'retrying';
        chain.attempts += 1;
        return { rows: [{ attempts: chain.attempts }] };
      }
      if (text.includes("SET status='resent'")) {
        const chain = chainById(params[0]);
        if (chain && chain.attempts === params[2]) {
          chain.status = 'resent';
          chain.tried_smsc_ids = [...chain.tried_smsc_ids, params[1]];
          chain.job_id = null;
        }
        return { rows: [] };
      }
      if (text.includes("SET status='pending', last_error=$2")) {
        const chain = chainById(params[0]);
        if (chain) {
          chain.status = 'pending';
          chain.last_error = params[1];
        }
        return { rows: [] };
      }
      if (text.includes('SET status=$2, terminal_reason=$3')) {
        const chain = chainById(params[0]);
        if (chain) {
          chain.status = params[1];
          chain.terminal_reason = params[2];
          chain.resolved_at = 'now';
          chain.job_id = null;
        }
        return { rows: [] };
      }
      if (text.startsWith('UPDATE message_delivery_retries SET job_id=$2')) {
        const chain = chainById(params[0]);
        if (chain) chain.job_id = params[1];
        return { rows: [] };
      }
      if (text.includes('FROM message_delivery_retries c')) {
        // settle: chains in `resent` whose newest attempt has no report yet
        return {
          rows: state.chains
            .filter((c) => c.status === 'resent')
            .map((c) => {
              const attempt = state.attempts.find(
                (a) => a.retry_id === c.id && a.attempt_no === c.attempts,
              );
              return attempt && attempt.message_ref && attempt.dlr_event === null
                ? {
                    id: c.id,
                    message_ref: attempt.message_ref,
                    attempt_no: attempt.attempt_no,
                    smsc_id: attempt.smsc_id,
                  }
                : null;
            })
            .filter(Boolean),
        };
      }
      if (text.includes('FROM message_delivery_retries WHERE id=$1')) {
        const chain = chainById(params[0]);
        return { rows: chain ? [chain] : [] };
      }

      // ---- everything else --------------------------------------------------
      if (text.includes('FROM message_route_decisions')) {
        const decision = (fixture.decisions ?? {
          '42': {
            id: id(700),
            customer_id: null,
            channel: 'api',
            sender: 'JKANNEL',
            destination: '256700000001',
          },
        })[params[0]];
        return { rows: decision ? [{ ...decision, smsc_id: 'mtn-ug' }] : [] };
      }
      if (text.includes('FROM customer_routes cr')) return { rows: fixture.customerBindings ?? [] };
      if (text.includes('SELECT engine_id FROM smsc_definitions'))
        return {
          rows: (fixture.smscs ?? ['mtn-ug', 'airtel-ug']).map((engine_id) => ({ engine_id })),
        };
      if (
        text.includes('FROM delivery_retry_state') ||
        text.includes('INTO delivery_retry_state')
      ) {
        if (text.includes('watermark_sql_id = GREATEST')) {
          if (params[1] !== null && params[1] !== undefined)
            state.scanState.watermark_sql_id = String(params[1]);
          state.scanState.last_error = (params[2] ?? null) as string | null;
          return { rows: [state.scanState] };
        }
        if (text.includes('poll_interval_seconds=$2')) {
          state.scanState.poll_interval_seconds = Number(params[1]);
          return { rows: [state.scanState] };
        }
        return { rows: [state.scanState] };
      }
      if (text.includes('FROM api_jobs')) {
        // Models the real predicate, including the self-exclusion: the job
        // asking the question is itself `running` while it asks.
        const exclude = params[1] ?? null;
        const inFlight = state.jobs.some(
          (j) => j.type === 'delivery.retry.scan' && j.id !== exclude,
        );
        return { rows: inFlight ? [{ exists: 1 }] : [] };
      }
      if (text.startsWith('INSERT INTO audit_log')) {
        state.audits.push({ action: String(params[2]), value: JSON.parse(String(params[5])) });
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };

  const database: any = { tenantTransaction: (_t: string, work: any) => work(client) };
  const jobs: any = {
    createOn: jest.fn(async (_client: unknown, _actor: unknown, value: any) => {
      const key = value.idempotencyKey ?? null;
      const replayed = key ? state.jobs.find((j) => j.type === value.type && j.key === key) : null;
      if (replayed) return { ...replayed, replayed: true };
      sequence += 1;
      const job = {
        id: id(400 + sequence),
        type: value.type,
        input: value.input,
        key,
        runAt: value.runAt ?? null,
      };
      state.jobs.push(job);
      return job;
    }),
  };
  const sqlbox: any = {
    probe: jest.fn(async () => ({
      available: fixture.engineAvailable ?? true,
      evidence:
        fixture.engineAvailable === false ? 'SQLBox tables have not been created yet' : 'ok',
    })),
    findNegativeDeliveryReports: jest.fn(async () => fixture.reports ?? []),
    latestDeliveryEvents: jest.fn(
      async (ids: string[]) =>
        new Map(
          ids
            .map((ref) => [ref, (fixture.latestEvents ?? {})[ref]] as const)
            .filter(([, value]) => Boolean(value)) as Array<
            [string, { event: number; at: string | null }]
          >,
        ),
    ),
  };
  const routing: any = {
    availability: jest.fn(async () => ({
      byId: new Map(),
      available: fixture.available ?? ['mtn-ug', 'airtel-ug'],
      healthAssumed: false,
    })),
    resolveInClient: jest.fn(async () => ({ smscId: fixture.routed ?? null })),
  };
  const send: any = {
    send: jest.fn(async (_actor: unknown, request: any) => {
      if (fixture.sendThrows) throw new Error(fixture.sendThrows);
      sequence += 1;
      const sqlId = String(1000 + sequence);
      state.sends.push({ ...request, sqlId });
      if (request.onSubmitted)
        await request.onSubmitted(client, { sqlId, decisionId: id(800 + sequence) });
      return {
        sqlId,
        smscId: request.smscId,
        charged: request.cost === 0 ? 0 : 1.5,
        routeId: null,
        reason: 'explicit smscId supplied by the caller (system)',
      };
    }),
  };

  const service = new DeliveryRetryService(database, sqlbox, jobs, send, routing);
  return { service, state, client, jobs, sqlbox, routing, send };
}

describe('scan — finding a delivery failure', () => {
  it('opens a chain and queues a dispatch for a DLR reporting event 2', async () => {
    const { service, state } = makeStack({ reports: [report()] });
    const outcome = await service.scan(actor);

    expect(outcome).toMatchObject({ reportsScanned: 1, chainsOpened: 1, watermark: '500' });
    expect(state.chains).toHaveLength(1);
    expect(state.chains[0]).toMatchObject({
      origin_message_ref: '42',
      origin_smsc_id: 'mtn-ug',
      tried_smsc_ids: ['mtn-ug'],
      trigger_dlr_event: 2,
      status: 'pending',
      body: 'your code is 1234',
    });
    const dispatch = state.jobs.find((j) => j.type === 'delivery.retry.dispatch');
    expect(dispatch?.key).toBe(`delivery-retry:${state.chains[0].id}:1`);
  });

  it('asks the engine only for the events an enabled policy would act on', async () => {
    const { service, sqlbox } = makeStack({ policies: [policyRow({ retry_on_rejected: true })] });
    await service.scan(actor);
    expect(sqlbox.findNegativeDeliveryReports).toHaveBeenCalledWith(
      expect.objectContaining({ events: [2, 16], allowedSmscIds: ['mtn-ug', 'airtel-ug'] }),
    );
  });

  it('does not read the engine at all when every policy is disabled', async () => {
    const { service, sqlbox } = makeStack({ policies: [policyRow({ enabled: false })] });
    const outcome = await service.scan(actor);
    expect(outcome.enabled).toBe(false);
    expect(sqlbox.findNegativeDeliveryReports).not.toHaveBeenCalled();
  });

  it('records a terminal chain when an ENABLED policy declines the failure', async () => {
    // "Why was this not retried?" must be answerable from the row.
    const { service, state } = makeStack({
      policies: [policyRow({ retry_on_rejected: false })],
      reports: [report({ dlrEvent: 16 })],
    });
    await service.scan(actor);
    expect(state.chains[0]).toMatchObject({
      status: 'abandoned',
      terminal_reason: 'policy does not retry rejected (DLR 16)',
    });
    expect(state.jobs.some((j) => j.type === 'delivery.retry.dispatch')).toBe(false);
  });
});

describe('tenant isolation', () => {
  it('never retries a message this tenant did not send', async () => {
    // message_route_decisions is RLS-scoped: no visible decision row means the
    // message is not ours, so it is skipped rather than re-sent onto our binds.
    const { service, state } = makeStack({
      reports: [report({ foreignId: '999' })],
      decisions: {},
    });
    const outcome = await service.scan(actor);
    expect(outcome).toMatchObject({ reportsScanned: 1, chainsOpened: 0, skipped: 1 });
    expect(state.chains).toHaveLength(0);
  });

  it('only ever considers binds the tenant owns', async () => {
    const { service, state, routing, sqlbox } = makeStack({
      reports: [report()],
      available: ['mtn-ug', 'airtel-ug'],
    });
    await service.scan(actor);
    await service.dispatch(actor, state.chains[0].id);
    // Bind health is read through RLS-scoped smsc_definitions, and the engine
    // read is restricted to the tenant's engine ids.
    expect(routing.availability).toHaveBeenCalled();
    expect(sqlbox.findNegativeDeliveryReports).toHaveBeenCalledWith(
      expect.objectContaining({ allowedSmscIds: ['mtn-ug', 'airtel-ug'] }),
    );
    expect(state.sends[0].smscId).toBe('airtel-ug');
  });
});

describe('duplicate retry', () => {
  it('opens ONE chain when the same failure is seen twice', async () => {
    const { service, state } = makeStack({ reports: [report(), report({ dlrSqlId: '501' })] });
    const outcome = await service.scan(actor);
    expect(outcome).toMatchObject({ chainsOpened: 1, duplicates: 1 });
    expect(state.chains).toHaveLength(1);
  });

  it('opens ONE chain when the watermark goes backwards and the scan re-reads', async () => {
    const { service, state } = makeStack({ reports: [report()] });
    await service.scan(actor);
    state.scanState.watermark_sql_id = '0';
    const second = await service.scan(actor);
    expect(second).toMatchObject({ chainsOpened: 0, duplicates: 1 });
    expect(state.chains).toHaveLength(1);
  });

  it('gives an attempt exactly one dispatch job, whatever re-enqueues', async () => {
    const { service, state, jobs } = makeStack({ reports: [report()] });
    await service.scan(actor);
    const chainId = state.chains[0].id;
    // api_jobs carries UNIQUE (tenant_id, type, idempotency_key), so a second
    // enqueue for the same attempt returns the existing job.
    await (service as any).database.tenantTransaction(actor.tenantId, (client: any) =>
      (service as any).enqueueDispatch(client, actor, chainId, 1, 0),
    );
    expect(jobs.createOn).toHaveBeenCalledTimes(2);
    expect(state.jobs.filter((j) => j.type === 'delivery.retry.dispatch')).toHaveLength(1);
  });

  it('records ONE attempt when a second dispatcher races the first', async () => {
    const { service, state, client } = makeStack({ reports: [report()] });
    await service.scan(actor);
    const chainId = state.chains[0].id;
    await service.dispatch(actor, chainId);
    expect(state.attempts).toHaveLength(1);

    // Force the chain back to a claimable state with the SAME attempt number,
    // as a torn claim would. The attempt insert is guarded on the fence and by
    // UNIQUE (tenant_id, retry_id, attempt_no), so nothing is recorded twice.
    const chain = state.chains[0];
    chain.status = 'retrying';
    chain.attempts = 0;
    client.query.mockClear();
    await service.dispatch(actor, chainId);
    expect(state.attempts).toHaveLength(1);
  });
});

describe('dispatch — choosing another connection', () => {
  it('re-sends on a DIFFERENT bind than the one that failed', async () => {
    const { service, state } = makeStack({ reports: [report()] });
    await service.scan(actor);
    const outcome = await service.dispatch(actor, state.chains[0].id);

    expect(outcome).toMatchObject({ outcome: 'submitted', attemptNo: 1, smscId: 'airtel-ug' });
    expect(state.sends[0]).toMatchObject({
      smscId: 'airtel-ug',
      receiver: '256700000001',
      text: 'your code is 1234',
      channel: 'system',
    });
    expect(state.chains[0]).toMatchObject({
      status: 'resent',
      attempts: 1,
      tried_smsc_ids: ['mtn-ug', 'airtel-ug'],
    });
    expect(state.attempts[0]).toMatchObject({ outcome: 'submitted', smsc_id: 'airtel-ug' });
  });

  it('stops and records why when there is no untried healthy bind', async () => {
    const { service, state } = makeStack({ reports: [report()], available: ['mtn-ug'] });
    await service.scan(actor);
    const outcome = await service.dispatch(actor, state.chains[0].id);

    expect(outcome.outcome).toBe('exhausted');
    expect(state.sends).toHaveLength(0);
    expect(state.attempts[0]).toMatchObject({ outcome: 'no_bind', smsc_id: null });
    expect(state.chains[0].status).toBe('exhausted');
    expect(state.chains[0].terminal_reason).toContain('not already been tried on');
  });

  it("honours the routing engine's bind when it is untried", async () => {
    const { service, state } = makeStack({
      reports: [report()],
      available: ['mtn-ug', 'airtel-ug', 'utl-ug'],
      routed: 'utl-ug',
    });
    await service.scan(actor);
    await service.dispatch(actor, state.chains[0].id);
    expect(state.attempts[0]).toMatchObject({ smsc_id: 'utl-ug', selection: 'route' });
  });

  it('restricts candidates to the binds the customer is entitled to', async () => {
    const { service, state } = makeStack({
      reports: [report()],
      decisions: {
        '42': {
          id: id(700),
          customer_id: id(600),
          channel: 'api',
          sender: 'JKANNEL',
          destination: '256700000001',
        },
      },
      available: ['mtn-ug', 'airtel-ug', 'utl-ug'],
      customerBindings: [{ engine_id: 'utl-ug', route_target: null }],
    });
    await service.scan(actor);
    await service.dispatch(actor, state.chains[0].id);
    expect(state.attempts[0]).toMatchObject({ smsc_id: 'utl-ug' });
    expect(state.attempts[0].excluded_smsc_ids).toContain('airtel-ug');
  });
});

describe('max attempts and loops', () => {
  it('does not exceed the policy budget however many times dispatch is called', async () => {
    const { service, state } = makeStack({
      reports: [report()],
      available: ['mtn-ug', 'airtel-ug', 'utl-ug'],
    });
    await service.scan(actor);
    const chainId = state.chains[0].id;

    await service.dispatch(actor, chainId);
    expect(state.sends).toHaveLength(1);

    // A chain in `resent` is not claimable at all...
    expect((await service.dispatch(actor, chainId)).outcome).toBe('skipped');
    // ...and even forced back to `pending`, the committed attempts counter caps
    // submissions at max_attempts.
    state.chains[0].status = 'pending';
    expect((await service.dispatch(actor, chainId)).outcome).toBe('exhausted');
    expect(state.sends).toHaveLength(1);
    expect(state.chains[0]).toMatchObject({ status: 'exhausted', attempts: 1 });
  });

  it('continues the SAME chain when a retry itself fails, instead of starting a new one', async () => {
    const { service, state } = makeStack({
      policies: [policyRow({ max_attempts: 2 })],
      reports: [report()],
      available: ['mtn-ug', 'airtel-ug', 'utl-ug'],
    });
    await service.scan(actor);
    const chainId = state.chains[0].id;
    await service.dispatch(actor, chainId);
    const retryRef = state.attempts[0].message_ref;

    // The retry's own DLR carries the retry's sql_id as its foreign_id.
    (service as any).sqlbox.findNegativeDeliveryReports = jest.fn(async () => [
      report({ dlrSqlId: '600', foreignId: retryRef, smscId: 'airtel-ug' }),
    ]);
    const outcome = await service.scan(actor);

    expect(outcome).toMatchObject({ continuations: 1, chainsOpened: 0 });
    expect(state.chains).toHaveLength(1);
    expect(state.chains[0].status).toBe('pending');
    expect(state.attempts[0].dlr_event).toBe(2);
  });

  it('exhausts the chain when the last permitted retry also fails', async () => {
    const { service, state } = makeStack({
      reports: [report()],
      available: ['mtn-ug', 'airtel-ug'],
    });
    await service.scan(actor);
    await service.dispatch(actor, state.chains[0].id);
    const retryRef = state.attempts[0].message_ref;

    (service as any).sqlbox.findNegativeDeliveryReports = jest.fn(async () => [
      report({ dlrSqlId: '600', foreignId: retryRef, smscId: 'airtel-ug' }),
    ]);
    await service.scan(actor);

    expect(state.chains[0]).toMatchObject({ status: 'exhausted' });
    expect(state.chains[0].terminal_reason).toContain('no attempts left');
  });
});

describe('a late positive delivery report', () => {
  it('cancels a queued retry rather than delivering the message twice', async () => {
    const { service, state } = makeStack({
      reports: [report()],
      latestEvents: { '42': { event: 1, at: '2026-08-01T12:00:00.000Z' } },
    });
    await service.scan(actor);
    const outcome = await service.dispatch(actor, state.chains[0].id);

    expect(outcome.outcome).toBe('delivered');
    expect(state.sends).toHaveLength(0);
    expect(state.chains[0]).toMatchObject({ status: 'delivered', attempts: 0 });
    expect(state.chains[0].terminal_reason).toContain('delivered report arrived');
  });

  it('settles a resent chain once the retry is reported delivered', async () => {
    const { service, state } = makeStack({ reports: [report()] });
    await service.scan(actor);
    await service.dispatch(actor, state.chains[0].id);
    const retryRef = state.attempts[0].message_ref;

    (service as any).sqlbox.findNegativeDeliveryReports = jest.fn(async () => []);
    (service as any).sqlbox.latestDeliveryEvents = jest.fn(
      async () => new Map([[retryRef, { event: 1, at: '2026-08-01T12:05:00.000Z' }]]),
    );
    const outcome = await service.scan(actor);

    expect(outcome.settled).toBe(1);
    expect(state.chains[0]).toMatchObject({ status: 'delivered' });
    expect(state.attempts[0].dlr_event).toBe(1);
  });

  it('leaves a chain in `resent` while the outcome is genuinely unknown', async () => {
    // `resent` means exactly "a retry was submitted, its outcome is not known
    // yet". Nothing here pretends to know more than the engine has reported.
    const { service, state } = makeStack({ reports: [report()] });
    await service.scan(actor);
    await service.dispatch(actor, state.chains[0].id);
    (service as any).sqlbox.findNegativeDeliveryReports = jest.fn(async () => []);
    const outcome = await service.scan(actor);
    expect(outcome.settled).toBe(0);
    expect(state.chains[0].status).toBe('resent');
  });
});

describe('billing', () => {
  it('bills a retry like any other submission by default', async () => {
    const { service, state } = makeStack({ reports: [report()] });
    await service.scan(actor);
    await service.dispatch(actor, state.chains[0].id);
    // cost null = the route's own price applies, exactly as a first send.
    expect(state.sends[0].cost).toBeNull();
    expect(Number(state.attempts[0].charged)).toBe(1.5);
  });

  it('suppresses only the credit debit when the policy says not to charge', async () => {
    const { service, state } = makeStack({
      policies: [policyRow({ charge_credit_on_retry: false })],
      reports: [report()],
    });
    await service.scan(actor);
    await service.dispatch(actor, state.chains[0].id);
    // cost 0 stops the debit. Quota is still consumed by the shared send path,
    // which is what the policy column's comment says and all it claims.
    expect(state.sends[0].cost).toBe(0);
    expect(Number(state.attempts[0].charged)).toBe(0);
  });
});

describe('storms', () => {
  it('stops opening chains at the tenant cap and leaves the rest for the next scan', async () => {
    const { service, state } = makeStack({
      policies: [policyRow({ max_retries_per_minute: 2 })],
      reports: [
        report({ dlrSqlId: '501', foreignId: '51' }),
        report({ dlrSqlId: '502', foreignId: '52' }),
        report({ dlrSqlId: '503', foreignId: '53' }),
      ],
      decisions: Object.fromEntries(
        ['51', '52', '53'].map((ref) => [
          ref,
          {
            id: id(700),
            customer_id: null,
            channel: 'api',
            sender: 'JKANNEL',
            destination: `25670000000${ref}`,
          },
        ]),
      ),
    });
    const outcome = await service.scan(actor);

    expect(outcome.chainsOpened).toBe(2);
    expect(outcome.evidence).toContain('storm cap reached (2/min)');
    // The watermark did NOT advance past the deferred report: backpressure, not
    // discard.
    expect(outcome.watermark).toBe('502');
    expect(state.chains).toHaveLength(2);
  });

  it('excludes a bind that has absorbed its per-minute retry budget', async () => {
    const { service, state } = makeStack({
      policies: [policyRow({ bind_retries_per_minute: 1 })],
      reports: [report()],
      available: ['mtn-ug', 'airtel-ug', 'utl-ug'],
    });
    await service.scan(actor);
    // One retry already aimed at airtel-ug inside the window.
    state.attempts.push({
      id: id(999),
      retry_id: id(998),
      attempt_no: 1,
      smsc_id: 'airtel-ug',
      message_ref: null,
      dlr_event: null,
    });
    await service.dispatch(actor, state.chains[0].id);
    expect(state.attempts.at(-1)).toMatchObject({ smsc_id: 'utl-ug' });
  });
});

describe('a refused retry', () => {
  it('ends the chain instead of burning its budget on the same refusal', async () => {
    const { service, state } = makeStack({
      policies: [policyRow({ max_attempts: 3 })],
      reports: [report()],
      sendThrows: 'insufficient credit: 1.5 required, balance 0',
      available: ['mtn-ug', 'airtel-ug', 'utl-ug'],
    });
    await service.scan(actor);
    const outcome = await service.dispatch(actor, state.chains[0].id);

    expect(outcome.outcome).toBe('refused');
    expect(state.chains[0]).toMatchObject({ status: 'failed' });
    expect(state.chains[0].terminal_reason).toContain('insufficient credit');
    expect(state.attempts[0]).toMatchObject({ outcome: 'refused' });
  });
});

describe('engine availability', () => {
  it('records the reason and changes nothing when SQLBox is down', async () => {
    const { service, state } = makeStack({ engineAvailable: false, reports: [report()] });
    const outcome = await service.scan(actor);
    expect(outcome).toMatchObject({ available: false, chainsOpened: 0 });
    expect(state.chains).toHaveLength(0);
    expect(state.scanState.last_error).toContain('engine unavailable');
  });
});

describe('policy administration', () => {
  it('starts the scanner when retrying is switched on', async () => {
    const { service, state } = makeStack({ policies: [] });
    await service.upsertPolicy(actor, {
      scope: 'tenant',
      smscId: null,
      customerId: null,
      enabled: true,
      maxAttempts: 2,
      retryOnFailed: true,
      retryOnRejected: false,
      minDelaySeconds: 60,
      maxAgeSeconds: 3600,
      requireDifferentBind: true,
      chargeCreditOnRetry: true,
      maxRetriesPerMinute: 60,
      bindRetriesPerMinute: 30,
    });
    expect(state.jobs.some((j) => j.type === 'delivery.retry.scan')).toBe(true);
    expect(state.audits.map((a) => a.action)).toContain('delivery_retry.policy.saved');
  });

  it('keeps the poll chain alive by not mistaking itself for an in-flight scan', async () => {
    // The scan job is `status='running'` for the whole of its own handler. A
    // guard that did not exclude it would find itself, decline to enqueue a
    // successor, and the chain would run exactly once and stop.
    const { service, state } = makeStack();
    const runningJob = {
      id: id(4321),
      type: 'delivery.retry.scan',
      input: {},
      key: null,
      runAt: null,
    };
    state.jobs.push(runningJob);

    expect((await service.runScheduledScan(actor)).nextScanScheduled).toBe(false);
    const withSelf = await service.runScheduledScan(actor, { currentJobId: runningJob.id });
    expect(withSelf.nextScanScheduled).toBe(true);
    expect(state.jobs.filter((j) => j.type === 'delivery.retry.scan')).toHaveLength(2);
  });

  it('stands down when the last policy is switched off', async () => {
    const { service, state } = makeStack({ policies: [policyRow({ enabled: false })] });
    const outcome = await service.runScheduledScan(actor, { currentJobId: id(4321) });
    expect(outcome.nextScanScheduled).toBe(false);
    expect(state.jobs).toHaveLength(0);
  });

  it('resolves the effective policy for a bind and customer', async () => {
    const { service } = makeStack({
      policies: [
        policyRow({ id: id(1), scope: 'tenant', max_attempts: 1 }),
        policyRow({ id: id(2), scope: 'smsc', smsc_id: 'mtn-ug', max_attempts: 3 }),
      ],
    });
    expect(await service.effectivePolicy(actor, { smscId: 'mtn-ug' })).toMatchObject({
      policyId: id(2),
      maxAttempts: 3,
      scope: 'smsc',
    });
  });
});
