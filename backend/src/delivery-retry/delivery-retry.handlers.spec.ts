import { JobHandlerRegistry, PermanentJobError } from '../platform/job-registry';
import { DeliveryRetryJobHandlers } from './delivery-retry.handlers';
import {
  DELIVERY_RETRY_DISPATCH_JOB_TYPE,
  DELIVERY_RETRY_SCAN_JOB_TYPE,
} from './delivery-retry.service';

const ID = '11111111-1111-4111-8111-111111111111';

function makeHandlers() {
  const registry = new JobHandlerRegistry();
  const retries: any = {
    runScheduledScan: jest.fn(async () => ({ chainsOpened: 1, nextScanScheduled: true })),
    dispatch: jest.fn(async () => ({ retryId: ID, outcome: 'submitted' })),
  };
  new DeliveryRetryJobHandlers(registry, retries).onModuleInit();
  return { registry, retries };
}

const context = (input: Record<string, unknown>, jobId = 'job-1') => ({
  jobId,
  type: 'x',
  actor: { tenantId: '7', userId: 'operator-1' },
  input,
  attempt: 1,
  maxAttempts: 4,
  progress: jest.fn(async () => undefined),
});

describe('DeliveryRetryJobHandlers', () => {
  it('registers both job types, so neither can sit queued with no executor', () => {
    const { registry } = makeHandlers();
    expect(registry.types()).toEqual([
      DELIVERY_RETRY_DISPATCH_JOB_TYPE,
      DELIVERY_RETRY_SCAN_JOB_TYPE,
    ]);
    // The dispatch budget is the QUEUE's, for infrastructural failures. The
    // message's own retry budget is the chain's max_attempts.
    expect(registry.get(DELIVERY_RETRY_DISPATCH_JOB_TYPE)!.maxAttempts).toBe(4);
    expect(registry.get(DELIVERY_RETRY_SCAN_JOB_TYPE)!.maxAttempts).toBe(3);
  });

  it('is idempotent, so a second module init does not throw', () => {
    const { registry } = makeHandlers();
    expect(() => new DeliveryRetryJobHandlers(registry, {} as any).register()).not.toThrow();
  });

  it('tells the scan which job row is itself, or the poll chain would stop', async () => {
    const { registry, retries } = makeHandlers();
    await registry.get(DELIVERY_RETRY_SCAN_JOB_TYPE)!.handler(context({}, 'scan-job-9'));
    expect(retries.runScheduledScan).toHaveBeenCalledWith(
      { tenantId: '7', userId: 'operator-1' },
      { currentJobId: 'scan-job-9' },
    );
  });

  it('dead-letters a dispatch with a malformed id rather than retrying it', async () => {
    const { registry, retries } = makeHandlers();
    const handler = registry.get(DELIVERY_RETRY_DISPATCH_JOB_TYPE)!.handler;
    await expect(handler(context({ retryId: 'nope' }) as any)).rejects.toThrow(PermanentJobError);
    await expect(handler(context({}) as any)).rejects.toThrow(PermanentJobError);
    expect(retries.dispatch).not.toHaveBeenCalled();

    await handler(context({ retryId: ID }));
    expect(retries.dispatch).toHaveBeenCalledWith({ tenantId: '7', userId: 'operator-1' }, ID);
  });
});
