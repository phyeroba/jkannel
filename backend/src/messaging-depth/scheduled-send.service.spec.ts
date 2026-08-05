import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { PermanentJobError } from '../platform/job-registry';
import { ScheduledSendService, isPermanentReleaseRefusal } from './scheduled-send.service';
import { parseMessageSchedule } from './message-scheduling';

/**
 * Tests for REAL "send later".
 *
 * The thing under test is not "does a column get written" — it is the set of
 * promises a scheduler makes and usually breaks: it releases at the right
 * instant and not before; it charges the customer for the moment of DELIVERY
 * rather than the moment of scheduling; a crash neither loses nor duplicates
 * the message; two replicas cannot both send it; a missed window has a decided,
 * recorded outcome rather than a stale surprise; and a message that is gone
 * says so.
 *
 * The database is faked at the row level rather than the call level so state
 * transitions actually happen: the claim really does move `pending` ->
 * `releasing`, and the fencing token really does move, which is what lets the
 * concurrency and crash cases be exercised instead of asserted.
 */

const TENANT = '7';
const ACTOR = { tenantId: TENANT, userId: 'operator-1' };
const HOLD_ID = '11111111-1111-4111-8111-111111111111';
const BULK_ID = '22222222-2222-4222-8222-222222222222';
const MINUTE = 60_000;

interface FakeHold {
  id: string;
  kind: 'message' | 'bulk';
  status: string;
  scheduled_at: Date;
  validity_minutes: number | null;
  payload: Record<string, unknown> | null;
  bulk_job_id: string | null;
  job_id: string | null;
  release_attempts: number;
  claimed_at: Date | null;
  claimed_by: string | null;
  released_at: Date | null;
  released_late: boolean;
  lateness_ms: number | null;
  message_ref: string | null;
  decision_id: string | null;
  failure_reason: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

function hold(overrides: Partial<FakeHold> = {}): FakeHold {
  return {
    id: HOLD_ID,
    kind: 'message',
    status: 'pending',
    scheduled_at: new Date(Date.now() + 60 * MINUTE),
    validity_minutes: null,
    payload: { sender: 'ACME', receiver: '+256700000000', text: 'hi', channel: 'console' },
    bulk_job_id: null,
    job_id: 'job-1',
    release_attempts: 0,
    claimed_at: null,
    claimed_by: null,
    released_at: null,
    released_late: false,
    lateness_ms: null,
    message_ref: null,
    decision_id: null,
    failure_reason: null,
    created_by: 'operator-1',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

/**
 * A row-level fake of the two tables this service writes. Statements are
 * matched on the distinctive fragment of each query, and every guarded UPDATE
 * evaluates its guard for real — including the `release_attempts` fencing
 * token — so a test can genuinely race two releases.
 */
function makeDatabase(seed: FakeHold[] = []) {
  const holds = new Map<string, FakeHold>(seed.map((row) => [row.id, row]));
  const bulkJobs = new Map<string, { id: string; status: string; detail?: string }>();
  const audit: Array<{ action: string; entityId: string; detail: any }> = [];
  const sql: string[] = [];

  const query = async (text: string, params: any[] = []) => {
    sql.push(text);
    const one = (row: any) => ({ rows: [row], rowCount: 1 });
    const none = () => ({ rows: [], rowCount: 0 });

    if (text.includes('INSERT INTO audit_log')) {
      audit.push({ action: params[2], entityId: params[3], detail: JSON.parse(params[4]) });
      return none();
    }
    if (text.includes('INSERT INTO scheduled_messages')) {
      // Matched on the VALUES clause, not the column list: the RETURNING clause
      // names every column, `bulk_job_id` included, on both statements.
      const bulk = text.includes("'bulk','pending'");
      const row = hold({
        id: bulk ? BULK_ID : HOLD_ID,
        kind: bulk ? 'bulk' : 'message',
        scheduled_at: new Date(params[1]),
        validity_minutes: params[2] ?? null,
        payload: JSON.parse(params[3]),
        bulk_job_id: bulk ? params[4] : null,
        job_id: null,
        created_by: bulk ? params[5] : params[4],
      });
      holds.set(row.id, row);
      return one({ ...row });
    }
    if (text.includes('SET job_id=')) {
      const row = holds.get(params[0])!;
      row.job_id = params[1];
      return one({ ...row });
    }
    if (text.includes("SET status='releasing'")) {
      const row = holds.get(params[0]);
      if (!row || !['pending', 'releasing'].includes(row.status)) return none();
      row.status = 'releasing';
      row.release_attempts += 1;
      row.claimed_at = new Date();
      row.claimed_by = params[1];
      return one({ ...row });
    }
    if (text.includes("SET status='expired'")) {
      const row = holds.get(params[0]);
      if (!row || row.status !== 'releasing' || row.release_attempts !== params[3]) return none();
      row.status = 'expired';
      row.failure_reason = params[1];
      row.lateness_ms = params[2];
      row.released_late = true;
      return one({ ...row });
    }
    if (text.includes("SET status='released'")) {
      const row = holds.get(params[0]);
      const fence = text.includes('message_ref=$4') ? params[5] : params[3];
      if (!row || row.status !== 'releasing' || row.release_attempts !== fence) return none();
      row.status = 'released';
      row.released_at = new Date();
      row.released_late = params[1];
      row.lateness_ms = params[2];
      if (text.includes('message_ref=$4')) {
        row.message_ref = params[3];
        row.decision_id = params[4];
      }
      return one({ ...row });
    }
    if (text.includes('SET status=$2,failure_reason=$3')) {
      const row = holds.get(params[0]);
      if (!row || row.status !== 'releasing' || row.release_attempts !== params[3]) return none();
      row.status = params[1];
      row.failure_reason = params[2];
      return one({ ...row });
    }
    if (text.includes("SET status='cancelled'")) {
      const row = holds.get(params[0]);
      if (!row || row.status !== 'pending') return none();
      row.status = 'cancelled';
      row.failure_reason = params[1];
      return one({ ...row });
    }
    if (text.includes('SET scheduled_at=$2')) {
      const row = holds.get(params[0]);
      if (!row || row.status !== 'pending') return none();
      row.scheduled_at = params[1];
      return one({ ...row });
    }
    if (text.includes("WHERE status='releasing'") && text.includes('claimed_at IS NOT NULL'))
      return none(); // the stalled sweep; nothing stalled in these fixtures
    if (text.includes('FROM scheduled_messages WHERE id=$1')) {
      const row = holds.get(params[0]);
      return row ? one({ ...row }) : none();
    }
    if (text.includes('UPDATE bulk_send_jobs')) {
      const job = bulkJobs.get(params[0]);
      if (!job) return none();
      if (text.includes("status='queued'")) {
        if (job.status !== 'scheduled') return none();
        job.status = 'queued';
      } else if (text.includes("status='failed'")) {
        if (job.status !== 'scheduled') return none();
        job.status = 'failed';
        job.detail = params[1];
      }
      return one({ ...job });
    }
    return none();
  };

  return {
    holds,
    bulkJobs,
    audit,
    sql,
    /** The client a caller's in-transaction hook is handed. */
    client: { query } as any,
    database: { tenantTransaction: (_t: string, work: any) => work({ query }) } as any,
  };
}

function makeService(
  fake: ReturnType<typeof makeDatabase>,
  overrides: { send?: any; bulk?: any; jobs?: any } = {},
) {
  const send = overrides.send ?? {
    send: jest.fn(async (_actor: any, request: any) => {
      // A real send commits the caller's hook inside its own transaction.
      if (request.onSubmitted)
        await request.onSubmitted(fake.client, {
          sqlId: '9001',
          decisionId: '33333333-3333-4333-8333-333333333333',
        });
      return { sqlId: '9001', smscId: 'carrier-a', decisionId: 'd1', charged: 1 };
    }),
  };
  const bulk = overrides.bulk ?? {
    createJob: jest.fn(),
    processJob: jest.fn(async () => ({ submitted: 2, failed: 0, status: 'completed' })),
  };
  const jobs = overrides.jobs ?? {
    createOn: jest.fn(async () => ({ id: 'job-1' })),
    cancelOn: jest.fn(async () => ({ id: 'job-1', status: 'cancelled' })),
    rescheduleOn: jest.fn(async () => ({ id: 'job-1', status: 'queued' })),
  };
  return {
    service: new ScheduledSendService(fake.database, jobs, send, bulk),
    send,
    bulk,
    jobs,
  };
}

/**
 * Whole seconds: `parseInstant` resolves to epoch SECONDS, so a millisecond
 * component would be truncated and the round-trip assertions below would be
 * comparing an artefact rather than the schedule.
 */
const future = (minutes: number) =>
  new Date(Math.ceil((Date.now() + minutes * MINUTE) / 1000) * 1000).toISOString();

// ===========================================================================
// Scheduling: hold, do not send
// ===========================================================================
describe('ScheduledSendService.submitMessage', () => {
  it('holds a future send instead of submitting it, and stamps the release job with the scheduled instant', async () => {
    const fake = makeDatabase();
    const { service, send, jobs } = makeService(fake);
    const scheduledAt = future(90);
    const result: any = await service.submitMessage(ACTOR, {
      sender: 'ACME',
      receiver: '+256700000000',
      text: 'hi',
      channel: 'console',
      schedule: parseMessageSchedule({ scheduledAt }),
    });

    // Nothing reached the engine. This is the whole point.
    expect(send.send).not.toHaveBeenCalled();
    expect(result.status).toBe('scheduled');
    expect(result.held).toBe(true);
    // No engine row exists, so no id may be reported for one.
    expect(result.sqlId).toBeNull();
    expect(result.scheduledAt).toBe(new Date(Date.parse(scheduledAt)).toISOString());

    // The release is a job DUE AT the scheduled instant: that is the mechanism.
    const submitted = jobs.createOn.mock.calls[0][2];
    expect(submitted.type).toBe('message.scheduled.release');
    expect((submitted.runAt as Date | undefined)!.getTime()).toBe(Date.parse(scheduledAt));
    expect(submitted.idempotencyKey).toBe(`scheduled-message:${result.scheduledMessageId}`);
    expect(fake.holds.get(HOLD_ID)!.status).toBe('pending');
  });

  it('sends immediately when there is nothing to wait for, honouring the 60s past grace', async () => {
    const fake = makeDatabase();
    const { service, send, jobs } = makeService(fake);
    // 30 seconds ago: inside the grace, so this is an ordinary immediate send.
    const almostNow = new Date(Date.now() - 30_000).toISOString();
    await service.submitMessage(ACTOR, {
      sender: 'ACME',
      receiver: '+256700000000',
      text: 'hi',
      channel: 'console',
      schedule: parseMessageSchedule({ scheduledAt: almostNow }),
    });
    expect(send.send).toHaveBeenCalledTimes(1);
    expect(jobs.createOn).not.toHaveBeenCalled();
    expect(fake.holds.size).toBe(0);
  });

  it('refuses an instant more than the grace in the past, before anything is written', async () => {
    const fake = makeDatabase();
    const { service } = makeService(fake);
    expect(() =>
      parseMessageSchedule({ scheduledAt: new Date(Date.now() - 90_000).toISOString() }),
    ).toThrow(BadRequestException);
    expect(fake.holds.size).toBe(0);
    expect(service).toBeDefined();
  });

  it('refuses an unusable destination at schedule time rather than at 09:00 tomorrow', async () => {
    const fake = makeDatabase();
    const { service, jobs } = makeService(fake);
    await expect(
      service.submitMessage(ACTOR, {
        sender: 'ACME',
        receiver: 'not-a-number',
        text: 'hi',
        channel: 'console',
        schedule: parseMessageSchedule({ scheduledAt: future(60) }),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(jobs.createOn).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Release: entitlements are evaluated NOW, not when the message was scheduled
// ===========================================================================
describe('ScheduledSendService.release — entitlements at release time', () => {
  const due = () => hold({ scheduled_at: new Date(Date.now() - 10_000) });

  it('replays the held request through THE send path at release', async () => {
    const fake = makeDatabase([due()]);
    const { service, send } = makeService(fake);
    const outcome: any = await service.release(TENANT, HOLD_ID, {
      workerId: 'w1',
      attempt: 1,
      maxAttempts: 4,
    });
    expect(outcome).toMatchObject({ outcome: 'released', sqlId: '9001', late: false });
    // Routing, blocklist, quota, credit and the decision record all live inside
    // MessageSendService.send — going through it is what makes them apply.
    expect(send.send).toHaveBeenCalledTimes(1);
    const request = send.send.mock.calls[0][1];
    expect(request.receiver).toBe('+256700000000');
    // The deferral has collapsed: this is a send-now submission carrying only
    // the validity the carrier actually honours.
    expect(request.schedule.validityMinutes).toBeNull();
    expect(fake.holds.get(HOLD_ID)!.status).toBe('released');
    expect(fake.holds.get(HOLD_ID)!.message_ref).toBe('9001');
  });

  /**
   * THE test that proves quota is read at release, not at schedule.
   *
   * The customer's quota is only ever consulted inside MessageSendService, and
   * the service is invoked exactly once — here, at release. So when the send
   * path refuses for quota AT RELEASE, the scheduled message must be refused
   * too, with the reason recorded, and nothing may be reported as sent.
   */
  it('refuses the send when entitlements fail AT RELEASE, and records why', async () => {
    const fake = makeDatabase([due()]);
    const quotaExhausted = new ForbiddenException(
      'daily quota exhausted: 500 of 500 messages used',
    );
    const send = { send: jest.fn().mockRejectedValue(quotaExhausted) };
    const { service } = makeService(fake, { send });

    await expect(
      service.release(TENANT, HOLD_ID, { workerId: 'w1', attempt: 1, maxAttempts: 4 }),
    ).rejects.toBeInstanceOf(PermanentJobError);

    const row = fake.holds.get(HOLD_ID)!;
    expect(row.status).toBe('failed');
    expect(row.failure_reason).toContain('daily quota exhausted');
    expect(row.message_ref).toBeNull();
    // The refusal is auditable, not just a log line.
    expect(fake.audit.map((entry) => entry.action)).toContain('message.schedule.failed');
    // Nothing was scheduled-time-reserved that would now need unwinding: the
    // only quota interaction in the whole lifecycle is the one that just failed.
    expect(send.send).toHaveBeenCalledTimes(1);
  });

  it('classifies a 4xx refusal as permanent and a transport failure as retryable', () => {
    expect(isPermanentReleaseRefusal(new ForbiddenException('insufficient credit'))).toBe(true);
    expect(isPermanentReleaseRefusal(new BadRequestException('no route'))).toBe(true);
    // A per-customer rate limit really is transient; so is a dropped socket.
    expect(isPermanentReleaseRefusal({ getStatus: () => 429 })).toBe(false);
    expect(isPermanentReleaseRefusal(new Error('ECONNREFUSED'))).toBe(false);
  });

  it('returns a transient failure to pending so the queue can retry it and an operator can still cancel', async () => {
    const fake = makeDatabase([due()]);
    const send = { send: jest.fn().mockRejectedValue(new Error('SQLBox unavailable')) };
    const { service } = makeService(fake, { send });
    await expect(
      service.release(TENANT, HOLD_ID, { workerId: 'w1', attempt: 1, maxAttempts: 4 }),
    ).rejects.toThrow('SQLBox unavailable');
    const row = fake.holds.get(HOLD_ID)!;
    expect(row.status).toBe('pending');
    expect(row.failure_reason).toMatch(/will be retried/);
  });

  it('marks the hold failed rather than perpetually pending on the last attempt', async () => {
    const fake = makeDatabase([due()]);
    const send = { send: jest.fn().mockRejectedValue(new Error('SQLBox unavailable')) };
    const { service } = makeService(fake, { send });
    await expect(
      service.release(TENANT, HOLD_ID, { workerId: 'w1', attempt: 4, maxAttempts: 4 }),
    ).rejects.toThrow('SQLBox unavailable');
    const row = fake.holds.get(HOLD_ID)!;
    expect(row.status).toBe('failed');
    expect(row.failure_reason).toMatch(/not retried further/);
  });
});

// ===========================================================================
// Concurrency and crash safety
// ===========================================================================
describe('ScheduledSendService.release — exactly once', () => {
  it('lets only one of two racing workers release the message', async () => {
    const fake = makeDatabase([hold({ scheduled_at: new Date(Date.now() - 10_000) })]);
    // Both workers reach the send path before either commits, which is the
    // worst case the fencing token exists for.
    let gate: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      gate = resolve;
    });
    let entered = 0;
    const send = {
      send: jest.fn(async (_actor: any, request: any) => {
        entered += 1;
        if (entered === 2) gate();
        await barrier;
        await request.onSubmitted(fake.client, {
          sqlId: '9001',
          decisionId: '33333333-3333-4333-8333-333333333333',
        });
        return { sqlId: '9001', smscId: 'carrier-a', decisionId: 'd1', charged: 1 };
      }),
    };
    const { service } = makeService(fake, { send });

    const results = await Promise.allSettled([
      service.release(TENANT, HOLD_ID, { workerId: 'w1', attempt: 1, maxAttempts: 4 }),
      service.release(TENANT, HOLD_ID, { workerId: 'w2', attempt: 1, maxAttempts: 4 }),
    ]);

    const released = results.filter(
      (r) => r.status === 'fulfilled' && (r.value as any).outcome === 'released',
    );
    // Exactly one release. The loser's send was rolled back by its own guard,
    // so it never delivered a second copy.
    expect(released).toHaveLength(1);
    expect(fake.holds.get(HOLD_ID)!.status).toBe('released');
    expect(fake.holds.get(HOLD_ID)!.message_ref).toBe('9001');
  });

  /**
   * A worker that dies between claiming the hold and committing the send leaves
   * the row `releasing` — and, because the released-marker is written inside
   * the send's own transaction, the send did NOT happen. The retry must
   * therefore be able to pick the row back up and must produce exactly one
   * message, not two and not zero.
   */
  it('recovers a hold abandoned mid-release without duplicating the message', async () => {
    const fake = makeDatabase([hold({ scheduled_at: new Date(Date.now() - 10_000) })]);
    const sent: string[] = [];
    let crashNext = true;
    const send = {
      send: jest.fn(async (_actor: any, request: any) => {
        if (crashNext) {
          crashNext = false;
          // Killed before the transaction committed: the hook never ran, so
          // nothing — not the spool row, not the debit, not the released
          // marker — was persisted.
          throw new Error('worker terminated');
        }
        await request.onSubmitted(fake.client, {
          sqlId: '9001',
          decisionId: '33333333-3333-4333-8333-333333333333',
        });
        sent.push('9001');
        return { sqlId: '9001', smscId: 'carrier-a', decisionId: 'd1', charged: 1 };
      }),
    };
    const { service } = makeService(fake, { send });

    await expect(
      service.release(TENANT, HOLD_ID, { workerId: 'w1', attempt: 1, maxAttempts: 4 }),
    ).rejects.toThrow('worker terminated');
    expect(fake.holds.get(HOLD_ID)!.status).toBe('pending');
    expect(sent).toHaveLength(0);

    const outcome: any = await service.release(TENANT, HOLD_ID, {
      workerId: 'w2',
      attempt: 2,
      maxAttempts: 4,
    });
    expect(outcome.outcome).toBe('released');
    expect(sent).toEqual(['9001']);
    expect(fake.holds.get(HOLD_ID)!.status).toBe('released');
  });

  it('treats an already-released or cancelled hold as a no-op instead of sending again', async () => {
    const released = makeDatabase([hold({ status: 'released', message_ref: '9001' })]);
    const a = makeService(released);
    await expect(
      a.service.release(TENANT, HOLD_ID, { workerId: 'w1', attempt: 1, maxAttempts: 4 }),
    ).resolves.toMatchObject({ outcome: 'already_released' });
    expect(a.send.send).not.toHaveBeenCalled();

    const cancelled = makeDatabase([hold({ status: 'cancelled' })]);
    const b = makeService(cancelled);
    await expect(
      b.service.release(TENANT, HOLD_ID, { workerId: 'w1', attempt: 1, maxAttempts: 4 }),
    ).resolves.toMatchObject({ outcome: 'cancelled' });
    expect(b.send.send).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Missed windows
// ===========================================================================
describe('ScheduledSendService.release — missed windows', () => {
  const original = process.env.SCHEDULED_SEND_MAX_LATENESS_MINUTES;
  afterEach(() => {
    if (original === undefined) delete process.env.SCHEDULED_SEND_MAX_LATENESS_MINUTES;
    else process.env.SCHEDULED_SEND_MAX_LATENESS_MINUTES = original;
  });

  it('releases late inside the ceiling and records that it was late', async () => {
    process.env.SCHEDULED_SEND_MAX_LATENESS_MINUTES = '120';
    // The platform was down for 45 minutes across the scheduled instant.
    const fake = makeDatabase([hold({ scheduled_at: new Date(Date.now() - 45 * MINUTE) })]);
    const { service, send } = makeService(fake);
    const outcome: any = await service.release(TENANT, HOLD_ID, {
      workerId: 'w1',
      attempt: 1,
      maxAttempts: 4,
    });
    expect(outcome).toMatchObject({ outcome: 'released', late: true });
    expect(send.send).toHaveBeenCalledTimes(1);
    const row = fake.holds.get(HOLD_ID)!;
    expect(row.status).toBe('released');
    expect(row.released_late).toBe(true);
    expect(row.lateness_ms).toBeGreaterThan(44 * MINUTE);
  });

  it('refuses to deliver something wildly stale beyond the ceiling, with a reason', async () => {
    process.env.SCHEDULED_SEND_MAX_LATENESS_MINUTES = '120';
    // Three days late: the message almost certainly no longer means what it said.
    const fake = makeDatabase([
      hold({ scheduled_at: new Date(Date.now() - 3 * 24 * 60 * MINUTE) }),
    ]);
    const { service, send } = makeService(fake);
    const outcome: any = await service.release(TENANT, HOLD_ID, {
      workerId: 'w1',
      attempt: 1,
      maxAttempts: 4,
    });
    expect(outcome.outcome).toBe('expired');
    expect(send.send).not.toHaveBeenCalled();
    const row = fake.holds.get(HOLD_ID)!;
    expect(row.status).toBe('expired');
    expect(row.failure_reason).toMatch(/staleness ceiling/);
    expect(row.failure_reason).toMatch(/was NOT sent/);
    expect(row.message_ref).toBeNull();
    expect(fake.audit.map((entry) => entry.action)).toContain('message.schedule.expired');
  });

  it('honours a raised ceiling, so catch-up is a deployment decision', async () => {
    process.env.SCHEDULED_SEND_MAX_LATENESS_MINUTES = String(3 * 24 * 60);
    const fake = makeDatabase([hold({ scheduled_at: new Date(Date.now() - 10 * 60 * MINUTE) })]);
    const { service, send } = makeService(fake);
    const outcome: any = await service.release(TENANT, HOLD_ID, {
      workerId: 'w1',
      attempt: 1,
      maxAttempts: 4,
    });
    expect(outcome).toMatchObject({ outcome: 'released', late: true });
    expect(send.send).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// Cancel and reschedule
// ===========================================================================
describe('ScheduledSendService cancel / reschedule', () => {
  it('cancels a pending hold and cancels its release job with it', async () => {
    const fake = makeDatabase([hold()]);
    const { service, jobs } = makeService(fake);
    const row: any = await service.cancel(ACTOR, HOLD_ID, 'wrong recipient list');
    expect(row.status).toBe('cancelled');
    expect(jobs.cancelOn).toHaveBeenCalledWith(
      expect.anything(),
      'job-1',
      expect.stringContaining('wrong recipient list'),
    );
    expect(fake.audit.map((entry) => entry.action)).toContain('message.schedule.cancelled');
  });

  it('reschedules a pending hold and moves its release job in the same transaction', async () => {
    const fake = makeDatabase([hold()]);
    const { service, jobs } = makeService(fake);
    const when = future(600);
    const row: any = await service.reschedule(ACTOR, HOLD_ID, when);
    expect(new Date(row.scheduled_at).toISOString()).toBe(new Date(Date.parse(when)).toISOString());
    expect(jobs.rescheduleOn.mock.calls[0][2].getTime()).toBe(Date.parse(when));
  });

  it('refuses to reschedule once the release job has been claimed', async () => {
    const fake = makeDatabase([hold()]);
    // rescheduleOn returns nothing when the job is no longer `queued`.
    const jobs = {
      createOn: jest.fn(),
      cancelOn: jest.fn(),
      rescheduleOn: jest.fn(async () => undefined),
    };
    const { service } = makeService(fake, { jobs });
    await expect(service.reschedule(ACTOR, HOLD_ID, future(600))).rejects.toBeInstanceOf(
      ConflictException,
    );
    // The hold's own instant must not have moved either.
    expect(fake.holds.get(HOLD_ID)!.status).toBe('pending');
  });

  it('rejects a past instant on reschedule, with the same grace as the original request', async () => {
    const fake = makeDatabase([hold()]);
    const { service } = makeService(fake);
    await expect(
      service.reschedule(ACTOR, HOLD_ID, new Date(Date.now() - 5 * MINUTE).toISOString()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('says a released message is gone rather than reporting a successful cancel', async () => {
    const fake = makeDatabase([hold({ status: 'released', message_ref: '9001' })]);
    const { service, jobs } = makeService(fake);
    await expect(service.cancel(ACTOR, HOLD_ID)).rejects.toThrow(
      /has already been released into the send path and is gone/,
    );
    await expect(service.reschedule(ACTOR, HOLD_ID, future(600))).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(jobs.cancelOn).not.toHaveBeenCalled();
  });

  it('refuses to cancel or reschedule a hold that is mid-release', async () => {
    const fake = makeDatabase([hold({ status: 'releasing', release_attempts: 1 })]);
    const { service } = makeService(fake);
    await expect(service.cancel(ACTOR, HOLD_ID)).rejects.toThrow(/being released right now/);
    await expect(service.reschedule(ACTOR, HOLD_ID, future(600))).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

// ===========================================================================
// Bulk campaigns
// ===========================================================================
describe('ScheduledSendService bulk campaigns', () => {
  it('writes the hold inside the campaign transaction, so a campaign can never be stranded', async () => {
    const fake = makeDatabase();
    const created = { id: 'campaign-1', name: 'Promo', total: 2, status: 'scheduled' };
    const bulk = {
      createJob: jest.fn(async (_actor: any, input: any) => {
        await input.onCreated(fake.client, created);
        return created;
      }),
      processJob: jest.fn(),
    };
    const { service, jobs } = makeService(fake, { bulk });
    const scheduledAt = future(240);
    const result: any = await service.submitBulk(ACTOR, {
      name: 'Promo',
      message: 'hi',
      recipients: ['+256700000000', '+256711111111'],
      schedule: parseMessageSchedule({ scheduledAt }),
    });
    expect(result.held).toBe(true);
    expect(result.scheduledMessageId).toBe(BULK_ID);
    expect(bulk.processJob).not.toHaveBeenCalled();
    expect((jobs.createOn.mock.calls[0][2].runAt as Date).getTime()).toBe(Date.parse(scheduledAt));
  });

  it('dispatches every recipient through the normal path when the campaign is released', async () => {
    const fake = makeDatabase([
      hold({
        id: BULK_ID,
        kind: 'bulk',
        bulk_job_id: 'campaign-1',
        payload: { name: 'Promo', total: 2 },
        scheduled_at: new Date(Date.now() - 10_000),
      }),
    ]);
    fake.bulkJobs.set('campaign-1', { id: 'campaign-1', status: 'scheduled' });
    const { service, bulk } = makeService(fake);
    const outcome: any = await service.release(TENANT, BULK_ID, {
      workerId: 'w1',
      attempt: 1,
      maxAttempts: 4,
    });
    expect(outcome).toMatchObject({ outcome: 'released', kind: 'bulk', submitted: 2, failed: 0 });
    // The campaign is handed back to the ORDINARY runner, which is what makes
    // per-recipient routing, blocklist and entitlements behave identically to
    // an unscheduled campaign.
    expect(fake.bulkJobs.get('campaign-1')!.status).toBe('queued');
    expect(bulk.processJob).toHaveBeenCalledWith(TENANT, 'campaign-1');
    expect(fake.holds.get(BULK_ID)!.status).toBe('released');
  });

  it('cancelling a held campaign also stops the campaign itself', async () => {
    const fake = makeDatabase([
      hold({ id: BULK_ID, kind: 'bulk', bulk_job_id: 'campaign-1', payload: {} }),
    ]);
    fake.bulkJobs.set('campaign-1', { id: 'campaign-1', status: 'scheduled' });
    const { service } = makeService(fake);
    await service.cancel(ACTOR, BULK_ID, 'no longer running the promo');
    expect(fake.holds.get(BULK_ID)!.status).toBe('cancelled');
    expect(fake.bulkJobs.get('campaign-1')!.status).toBe('failed');
    expect(fake.bulkJobs.get('campaign-1')!.detail).toContain('no longer running the promo');
  });
});
