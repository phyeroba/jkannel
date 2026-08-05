import { JobHandlerRegistry } from '../platform/job-registry';
import { ScheduledSendJobHandlers } from './scheduled-send.handlers';
import { SCHEDULED_RELEASE_JOB_TYPE } from './scheduled-send.service';

const ID = '11111111-1111-4111-8111-111111111111';

function context(input: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    jobId: 'job-1',
    type: SCHEDULED_RELEASE_JOB_TYPE,
    actor: { tenantId: '7', userId: 'operator-1' },
    input,
    attempt: 1,
    maxAttempts: 4,
    progress: jest.fn(async () => undefined),
    ...overrides,
  } as any;
}

describe('ScheduledSendJobHandlers', () => {
  function setup() {
    const registry = new JobHandlerRegistry();
    const scheduling: any = {
      release: jest.fn(async () => ({ outcome: 'released', scheduledMessageId: ID })),
    };
    new ScheduledSendJobHandlers(registry, scheduling).onModuleInit();
    return { registry, scheduling };
  }

  /**
   * A job type with no executor is refused at submission and dead-lettered on
   * sight by the worker. Registration is therefore what makes a scheduled send
   * acceptable at all — without it, `POST /messages` with a future
   * `scheduledAt` would 400 rather than silently never sending, which is the
   * correct failure but not the intended one.
   */
  it('registers the release type so a hold can actually be enqueued', () => {
    const { registry } = setup();
    expect(registry.has(SCHEDULED_RELEASE_JOB_TYPE)).toBe(true);
    expect(registry.get(SCHEDULED_RELEASE_JOB_TYPE)!.maxAttempts).toBe(4);
    expect(registry.get(SCHEDULED_RELEASE_JOB_TYPE)!.description).toMatch(/at release/);
  });

  it('is idempotent, so a second module init does not throw', () => {
    const { registry } = setup();
    const handlers = new ScheduledSendJobHandlers(registry, { release: jest.fn() } as any);
    expect(() => handlers.onModuleInit()).not.toThrow();
  });

  it('hands the worker’s attempt bookkeeping to the release, which decides when to give up', async () => {
    const { registry, scheduling } = setup();
    await registry
      .get(SCHEDULED_RELEASE_JOB_TYPE)!
      .handler(
        context({ scheduledMessageId: ID }, { attempt: 3, maxAttempts: 4, jobId: 'job-42' }),
      );
    expect(scheduling.release).toHaveBeenCalledWith('7', ID, {
      workerId: 'job:job-42',
      attempt: 3,
      maxAttempts: 4,
    });
  });

  it('dead-letters a malformed input immediately instead of burning retries on it', async () => {
    const { registry, scheduling } = setup();
    const handler = registry.get(SCHEDULED_RELEASE_JOB_TYPE)!.handler;
    await expect(handler(context({}))).rejects.toMatchObject({ permanent: true });
    await expect(handler(context({ scheduledMessageId: 'nope' }))).rejects.toMatchObject({
      permanent: true,
    });
    expect(scheduling.release).not.toHaveBeenCalled();
  });

  it('returns the release outcome as the job result, so the queue records what happened', async () => {
    const { registry, scheduling } = setup();
    scheduling.release.mockResolvedValue({
      outcome: 'expired',
      scheduledMessageId: ID,
      latenessMs: 999,
    });
    await expect(
      registry.get(SCHEDULED_RELEASE_JOB_TYPE)!.handler(context({ scheduledMessageId: ID })),
    ).resolves.toMatchObject({ outcome: 'expired' });
  });
});
