import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MoInboundService, prepareIngest } from './mo-inbound.service';
import { MoRulesService } from './mo-rules.service';
import { MoDestinationRow, MoRuleRow } from './mo-routing';

const actor = { tenantId: '1', userId: 'u1' };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function ruleRow(overrides: Partial<MoRuleRow> = {}): MoRuleRow {
  return {
    id: id(1),
    name: 'rule',
    description: null,
    enabled: true,
    priority: 100,
    match_smsc_id: null,
    match_destination: null,
    match_destination_type: 'any',
    match_sender_prefix: null,
    match_keyword: null,
    match_keyword_type: 'any',
    case_sensitive: false,
    continue_after_match: false,
    customer_id: null,
    created_by: 'u1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function destinationRow(overrides: Partial<MoDestinationRow> = {}): MoDestinationRow {
  return {
    id: id(50),
    rule_id: id(1),
    kind: 'webhook',
    target: 'https://hooks.example.com/mo',
    enabled: true,
    config: {},
    max_attempts: 5,
    created_by: 'u1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface Fixture {
  rules?: MoRuleRow[];
  destinations?: MoDestinationRow[];
  smscs?: string[];
  /** Engine MO rows the sweep will see, newest-first as the engine returns them. */
  engineRows?: Array<{
    id: string;
    sender: string;
    receiver: string;
    text: string;
    smscId: string | null;
    timestamp?: string;
  }>;
  engineAvailable?: boolean;
  watermark?: string;
  pollingEnabled?: boolean;
}

function makeStack(fixture: Fixture = {}) {
  const state = {
    messages: [] as any[],
    deliveries: [] as any[],
    audits: [] as string[],
    ingestState: {
      id: id(900),
      watermark_sql_id: fixture.watermark ?? '0',
      polling_enabled: fixture.pollingEnabled ?? false,
      poll_interval_seconds: 30,
      last_polled_at: null,
      last_error: null as string | null,
      ingested_total: '0',
      created_at: 'now',
      updated_at: 'now',
    },
    jobs: [] as Array<{ id: string; type: string; input: unknown }>,
  };
  let sequence = 0;

  const client = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      const text = sql.trim();
      if (text.startsWith('INSERT INTO mo_messages')) {
        const dedupe = params[2] as string | null;
        if (dedupe && state.messages.some((m) => m.dedupe_key === dedupe)) return { rows: [] };
        sequence += 1;
        const row = {
          id: id(200 + sequence),
          source: params[1],
          dedupe_key: dedupe,
          engine_message_id: params[3],
          external_ref: params[4],
          smsc_id: params[5],
          sender: params[6],
          receiver: params[7],
          sender_digits: params[8],
          receiver_digits: params[9],
          body: params[10],
          received_at: params[11],
          matched_rule_ids: [],
          fanout_count: 0,
          status: 'no_match',
          created_at: 'now',
        };
        state.messages.push(row);
        return { rows: [row] };
      }
      if (text.startsWith('SELECT') && text.includes('FROM mo_messages')) {
        if (text.includes('WHERE dedupe_key'))
          return { rows: state.messages.filter((m) => m.dedupe_key === params[0]) };
        return { rows: state.messages.filter((m) => m.id === params[0]) };
      }
      if (text.startsWith('UPDATE mo_messages')) {
        const row = state.messages.find((m) => m.id === params[0]);
        if (row) {
          row.matched_rule_ids = params[1];
          row.fanout_count = params[2];
          row.status = params[3];
        }
        return { rows: [] };
      }
      if (text.includes('FROM mo_routing_rules')) return { rows: fixture.rules ?? [] };
      if (text.includes('FROM mo_rule_destinations')) return { rows: fixture.destinations ?? [] };
      if (text.startsWith('INSERT INTO mo_deliveries')) {
        sequence += 1;
        const row = {
          id: id(300 + sequence),
          mo_message_id: params[1],
          rule_id: params[2],
          rule_name: params[3],
          destination_id: params[4],
          kind: params[5],
          target: params[6],
          config: JSON.parse(String(params[7])),
          status: 'pending',
          attempts: 0,
          max_attempts: params[8],
          manual_retries: 0,
          last_error: null,
          response_code: null,
          response_detail: null,
          job_id: null,
          delivered_at: null,
          created_at: 'now',
          updated_at: 'now',
        };
        state.deliveries.push(row);
        return { rows: [row] };
      }
      if (text.startsWith('SELECT') && text.includes('FROM mo_deliveries'))
        return { rows: state.deliveries.filter((d) => d.id === params[0] || !params.length) };
      if (text.startsWith('UPDATE mo_deliveries')) {
        const row = state.deliveries.find((d) => d.id === params[0]);
        if (row) {
          if (text.includes('job_id=$2') && text.includes('SET job_id')) row.job_id = params[1];
          else if (text.includes("status='pending'")) {
            row.status = 'pending';
            row.attempts = 0;
            row.manual_retries += 1;
            row.job_id = params[1];
          }
        }
        return { rows: row ? [row] : [] };
      }
      if (text.includes('FROM mo_ingest_state') || text.includes('INTO mo_ingest_state')) {
        if (text.includes('polling_enabled = $2')) {
          state.ingestState.polling_enabled = Boolean(params[1]);
          if (params[2]) state.ingestState.poll_interval_seconds = Number(params[2]);
          return { rows: [state.ingestState] };
        }
        if (text.startsWith('INSERT') && text.includes('watermark_sql_id = GREATEST')) {
          if (params[1] !== null && params[1] !== undefined)
            state.ingestState.watermark_sql_id = String(params[1]);
          state.ingestState.last_error = (params[2] ?? null) as string | null;
          return { rows: [state.ingestState] };
        }
        return { rows: [state.ingestState] };
      }
      if (text.includes('SELECT engine_id FROM smsc_definitions'))
        return { rows: (fixture.smscs ?? ['mtn-ug']).map((engine_id) => ({ engine_id })) };
      if (text.includes('FROM api_jobs')) return { rows: state.jobs.length ? [{ exists: 1 }] : [] };
      if (text.includes('INSERT INTO audit_log')) {
        state.audits.push(String(params[2]));
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };

  const database: any = { tenantTransaction: (_t: string, work: any) => work(client) };
  const jobs: any = {
    createOn: jest.fn(async (_client: unknown, _actor: unknown, value: any) => {
      sequence += 1;
      const job = { id: id(400 + sequence), type: value.type, input: value.input };
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
    list: jest.fn(async () => ({
      items: (fixture.engineRows ?? []).map((row) => ({
        id: row.id,
        sender: row.sender,
        receiver: row.receiver,
        text: row.text,
        smscId: row.smscId,
        timestamp: row.timestamp ?? '2026-08-01T00:00:00.000Z',
      })),
      nextCursor: null,
      total: null,
      limit: 200,
    })),
  };

  const service = new MoInboundService(database, new MoRulesService(database), jobs, sqlbox);
  return { service, state, jobs, sqlbox, client };
}

describe('MO ingest — fan-out', () => {
  const inbound = { sender: '+256700123456', receiver: '8080', text: 'BAL please' };

  it('delivers ONE inbound message to SEVERAL destinations, one job each', async () => {
    const { service, state, jobs } = makeStack({
      rules: [ruleRow({ name: 'crm' })],
      destinations: [
        destinationRow({ id: id(50), kind: 'webhook', target: 'https://hooks.example.com/mo' }),
        destinationRow({ id: id(51), kind: 'email', target: 'ops@example.com' }),
        destinationRow({ id: id(52), kind: 'sms', target: '256711111111' }),
      ],
    });

    const outcome = await service.ingest(actor, { ...inbound, externalRef: 'm-1' });

    expect(outcome.status).toBe('matched');
    expect(outcome.deliveries.map((d) => d.kind)).toEqual(['webhook', 'email', 'sms']);
    expect(state.deliveries).toHaveLength(3);
    // Independence is structural: three separate queue items, not one batch.
    expect(jobs.createOn).toHaveBeenCalledTimes(3);
    expect(state.jobs.every((j) => j.type === 'mo.delivery.dispatch')).toBe(true);
    expect(new Set(state.jobs.map((j) => (j.input as any).deliveryId)).size).toBe(3);
    expect(state.deliveries.every((d) => d.job_id)).toBe(true);
  });

  it('fans out across SEVERAL rules when one of them is non-terminal', async () => {
    const { service, state } = makeStack({
      rules: [
        ruleRow({ id: id(1), name: 'audit', priority: 10, continue_after_match: true }),
        ruleRow({ id: id(2), name: 'crm', priority: 20 }),
      ],
      destinations: [
        destinationRow({ id: id(50), rule_id: id(1), target: 'https://audit.example.com' }),
        destinationRow({ id: id(51), rule_id: id(2), target: 'https://crm.example.com' }),
      ],
    });
    const outcome = await service.ingest(actor, { ...inbound, externalRef: 'm-2' });
    expect(outcome.matchedRules.map((r) => r.ruleName)).toEqual(['audit', 'crm']);
    expect(state.deliveries.map((d) => d.target)).toEqual([
      'https://audit.example.com',
      'https://crm.example.com',
    ]);
  });

  it('records a message that matched NOTHING instead of discarding it', async () => {
    const { service, state } = makeStack({
      rules: [ruleRow({ match_keyword: 'STOP', match_keyword_type: 'first_word' })],
      destinations: [destinationRow()],
    });
    const outcome = await service.ingest(actor, { ...inbound, externalRef: 'm-3' });
    expect(outcome.status).toBe('no_match');
    expect(outcome.deliveries).toHaveLength(0);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].status).toBe('no_match');
    expect(state.audits).toContain('mo_message.no_match');
  });

  it('is idempotent: the same message twice is one record and one fan-out', async () => {
    const { service, state, jobs } = makeStack({
      rules: [ruleRow()],
      destinations: [destinationRow()],
    });
    const first = await service.ingest(actor, { ...inbound, externalRef: 'dup-1' });
    const second = await service.ingest(actor, { ...inbound, externalRef: 'dup-1' });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.moMessageId).toBe(first.moMessageId);
    expect(state.messages).toHaveLength(1);
    expect(jobs.createOn).toHaveBeenCalledTimes(1);
  });

  it('audits the inbound message and what it fanned out to', async () => {
    const { service, state } = makeStack({
      rules: [ruleRow({ name: 'crm' })],
      destinations: [destinationRow()],
    });
    await service.ingest(actor, { ...inbound, externalRef: 'm-4' });
    expect(state.audits).toContain('mo_message.matched');
  });

  it('rejects an inbound message with no sender or receiver rather than storing a stub', () => {
    expect(() => prepareIngest({ sender: '', receiver: '8080', text: 'x' }, 'http')).toThrow(
      BadRequestException,
    );
    expect(() => prepareIngest({ sender: '256700', receiver: '', text: 'x' }, 'http')).toThrow(
      BadRequestException,
    );
  });

  it('keeps a short code and an alphanumeric originator, storing the digits alongside', () => {
    const prepared = prepareIngest({ sender: 'MyBank', receiver: '8080', text: 'hello' }, 'http');
    expect(prepared.sender).toBe('MyBank');
    expect(prepared.senderDigits).toBeNull();
    expect(prepared.receiverDigits).toBe('8080');
  });
});

describe('MO ingest — engine sweep', () => {
  const engineRows = [
    { id: '31', sender: '256700000003', receiver: '8080', text: 'THREE', smscId: 'mtn-ug' },
    { id: '30', sender: '256700000002', receiver: '8080', text: 'TWO', smscId: 'mtn-ug' },
    { id: '29', sender: '256700000001', receiver: '8080', text: 'ONE', smscId: 'mtn-ug' },
  ];

  it('ingests every engine MO row past the watermark and advances it', async () => {
    const { service, state } = makeStack({
      engineRows,
      watermark: '29',
      rules: [ruleRow()],
      destinations: [destinationRow()],
    });
    const result = await service.sweep(actor);
    expect(result).toMatchObject({ scanned: 2, ingested: 2, duplicates: 0, watermark: '31' });
    // Oldest-first, so received order and the watermark advance together.
    expect(state.messages.map((m) => m.body)).toEqual(['TWO', 'THREE']);
    expect(state.messages.map((m) => m.dedupe_key)).toEqual(['sqlbox:30', 'sqlbox:31']);
  });

  it('re-reading the same rows ingests nothing twice — the unique key, not the watermark, is the guarantee', async () => {
    const { service, state } = makeStack({
      engineRows,
      watermark: '0',
      rules: [ruleRow()],
      destinations: [destinationRow()],
    });
    expect((await service.sweep(actor)).ingested).toBe(3);
    // Wind the watermark back, as a restored database or a manual reset would:
    // correctness must not depend on it. The dedupe_key unique index is what
    // actually prevents a second fan-out.
    state.ingestState.watermark_sql_id = '0';
    const second = await service.sweep(actor);
    expect(second.ingested).toBe(0);
    expect(second.duplicates).toBe(3);
    expect(state.messages).toHaveLength(3);
  });

  it('restricts the read to the tenant’s own binds, because sent_sms has no tenant column', async () => {
    const { service, sqlbox } = makeStack({ engineRows: [], smscs: ['mtn-ug', 'airtel-ug'] });
    await service.sweep(actor);
    expect(sqlbox.list).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'MO', allowedSmscIds: ['mtn-ug', 'airtel-ug'] }),
    );
  });

  it('reads NOTHING for a tenant with no SMSCs, rather than everything', async () => {
    const { service, sqlbox } = makeStack({ engineRows, smscs: [] });
    const result = await service.sweep(actor);
    expect(sqlbox.list).not.toHaveBeenCalled();
    expect(result.ingested).toBe(0);
  });

  it('reports an unavailable engine instead of pretending the sweep succeeded', async () => {
    const { service } = makeStack({ engineAvailable: false });
    const result = await service.sweep(actor);
    expect(result.available).toBe(false);
    expect(result.evidence).toContain('SQLBox tables');
  });
});

describe('MO ingest — polling and manual retry', () => {
  it('enqueues exactly one poll job when polling is turned on', async () => {
    const { service, state, jobs } = makeStack();
    await service.setPolling(actor, true, 60);
    expect(state.ingestState.polling_enabled).toBe(true);
    expect(state.ingestState.poll_interval_seconds).toBe(60);
    expect(jobs.createOn).toHaveBeenCalledTimes(1);
    expect(state.jobs[0].type).toBe('mo.ingest.poll');
  });

  it('never runs two self-perpetuating poll chains at once', async () => {
    const { service, state, jobs } = makeStack();
    await service.setPolling(actor, true);
    await service.setPolling(actor, true);
    // The second call sees a queued job and does not add another.
    expect(jobs.createOn).toHaveBeenCalledTimes(1);
    expect(state.jobs).toHaveLength(1);
  });

  it('the scheduled sweep does nothing when polling has been turned off', async () => {
    const { service, sqlbox } = makeStack({ pollingEnabled: false });
    const result = await service.runScheduledSweep(actor);
    expect(result).toMatchObject({ skipped: true });
    expect(sqlbox.list).not.toHaveBeenCalled();
  });

  it('a scheduled sweep runs and schedules its own successor', async () => {
    const { service, state } = makeStack({ pollingEnabled: true, engineRows: [] });
    const result = await service.runScheduledSweep(actor);
    expect(result).toMatchObject({ skipped: false, nextPollScheduled: true });
    expect(state.jobs.map((j) => j.type)).toEqual(['mo.ingest.poll']);
  });

  it('refuses to retry a delivery that is still pending, which would deliver twice', async () => {
    const { service, state } = makeStack();
    state.deliveries.push({
      id: id(301),
      status: 'pending',
      kind: 'webhook',
      target: 'https://x',
      max_attempts: 5,
      attempts: 1,
      manual_retries: 0,
    });
    await expect(service.retryDelivery(actor, id(301))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('re-queues a failed delivery with a fresh job and a recorded manual retry', async () => {
    const { service, state, jobs } = makeStack();
    state.deliveries.push({
      id: id(302),
      status: 'failed',
      kind: 'webhook',
      target: 'https://x',
      max_attempts: 5,
      attempts: 5,
      manual_retries: 0,
    });
    await service.retryDelivery(actor, id(302));
    expect(jobs.createOn).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      expect.objectContaining({ type: 'mo.delivery.dispatch', input: { deliveryId: id(302) } }),
    );
    expect(state.deliveries[0]).toMatchObject({
      status: 'pending',
      attempts: 0,
      manual_retries: 1,
    });
    expect(state.audits).toContain('mo_delivery.retried');
  });

  it('retrying a delivery that does not exist is a 404', async () => {
    const { service } = makeStack();
    await expect(service.retryDelivery(actor, id(999))).rejects.toBeInstanceOf(NotFoundException);
  });
});

/**
 * `mo_deliveries.config` is a fan-out-time snapshot of the destination's
 * settings, and for a webhook that includes `secret` — the value sent verbatim
 * as the `x-jkannel-signature` header. Every read path over that table is
 * reachable by any `messages.view` holder, so selecting the column raw handed
 * an outbound credential to callers who have no business seeing it.
 *
 * These assert on the emitted SQL rather than on returned rows because the
 * redaction is done IN SQL, deliberately: the column is read from four places
 * and a TypeScript-side delete would leave the next reader to leak again. The
 * SQL text is therefore where the invariant actually lives.
 */
describe('MO deliveries — the webhook secret must not leave through a read path', () => {
  const configSelects = (client: { query: jest.Mock }) =>
    client.query.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => /FROM mo_deliveries|RETURNING/.test(sql) && sql.includes('config'));

  it('redacts the secret on the deliveries grid and never selects it raw', async () => {
    const { service, client } = makeStack();
    await service.listDeliveries(actor, {});
    const selects = configSelects(client);
    expect(selects.length).toBeGreaterThan(0);
    for (const sql of selects) {
      expect(sql).toContain('__redacted__');
      expect(sql).not.toMatch(/,\s*config\s*,/);
    }
  });

  it('redacts on the per-message detail read as well', async () => {
    const { service, state, client } = makeStack();
    state.messages.push({ id: id(400) } as never);
    await service.getMessage(actor, id(400)).catch(() => undefined);
    for (const sql of configSelects(client)) expect(sql).toContain('__redacted__');
  });

  it('REPLACES the secret rather than dropping the key, so "set" stays distinguishable from "unset"', async () => {
    // Removing the key (`config - 'secret'`) would render identically to a
    // destination that never had a secret, and an operator reading "no secret"
    // would re-enter one that was already there. jsonb_set keeps the fact.
    const { service, client } = makeStack();
    await service.listDeliveries(actor, {});
    const [sql] = configSelects(client);
    expect(sql).toContain('jsonb_set');
    expect(sql).not.toMatch(/config\s*-\s*'secret'/);
  });

  it('redacts on the retry path too, which reads and returns the row', async () => {
    const { service, state, client } = makeStack();
    state.deliveries.push({
      id: id(401),
      status: 'failed',
      kind: 'webhook',
      target: 'https://x',
      max_attempts: 5,
      attempts: 5,
      manual_retries: 0,
    } as never);
    await service.retryDelivery(actor, id(401)).catch(() => undefined);
    const selects = configSelects(client);
    expect(selects.length).toBeGreaterThan(0);
    for (const sql of selects) expect(sql).toContain('__redacted__');
  });
});
