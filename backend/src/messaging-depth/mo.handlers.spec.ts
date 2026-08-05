import { JobHandlerRegistry, PermanentJobError } from '../platform/job-registry';
import {
  MO_DELIVERY_JOB_TYPE,
  MO_DELIVERY_MAX_ATTEMPTS,
  MO_INGEST_JOB_TYPE,
} from './mo-inbound.service';
import { MoJobHandlers } from './mo.handlers';

const ID = '11111111-1111-4111-8111-111111111111';

function context(type: string, input: Record<string, unknown>, attempt = 1) {
  return {
    jobId: 'job-1',
    type,
    actor: { tenantId: '7', userId: 'operator-1' },
    input,
    attempt,
    maxAttempts: MO_DELIVERY_MAX_ATTEMPTS,
    progress: jest.fn(async () => undefined),
  } as any;
}

function setup() {
  const registry = new JobHandlerRegistry();
  const inbound: any = {
    runScheduledSweep: jest.fn(async () => ({ skipped: false, ingested: 2 })),
  };
  const delivery: any = { dispatch: jest.fn(async () => ({ status: 'delivered' })) };
  new MoJobHandlers(registry, inbound, delivery).onModuleInit();
  return { registry, inbound, delivery };
}

describe('MoJobHandlers', () => {
  it('registers both types, so a fan-out job can actually be enqueued', () => {
    const { registry } = setup();
    expect(registry.has(MO_DELIVERY_JOB_TYPE)).toBe(true);
    expect(registry.has(MO_INGEST_JOB_TYPE)).toBe(true);
    expect(registry.get(MO_DELIVERY_JOB_TYPE)!.maxAttempts).toBe(MO_DELIVERY_MAX_ATTEMPTS);
  });

  it('is idempotent, so a second module init does not throw', () => {
    const { registry } = setup();
    const handlers = new MoJobHandlers(registry, {} as any, {} as any);
    expect(() => handlers.register()).not.toThrow();
  });

  it('dispatches one delivery, passing the attempt number the queue is on', async () => {
    const { registry, delivery } = setup();
    const result = await registry
      .get(MO_DELIVERY_JOB_TYPE)!
      .handler(context(MO_DELIVERY_JOB_TYPE, { deliveryId: ID }, 3));
    expect(result).toMatchObject({ status: 'delivered' });
    expect(delivery.dispatch).toHaveBeenCalledWith({ tenantId: '7', userId: 'operator-1' }, ID, 3);
  });

  it('dead-letters a malformed job at once instead of burning retries on it', async () => {
    const { registry, delivery } = setup();
    await expect(
      registry
        .get(MO_DELIVERY_JOB_TYPE)!
        .handler(context(MO_DELIVERY_JOB_TYPE, { deliveryId: 'x' })),
    ).rejects.toBeInstanceOf(PermanentJobError);
    expect(delivery.dispatch).not.toHaveBeenCalled();
  });

  it('runs a sweep for the ingest type', async () => {
    const { registry, inbound } = setup();
    const result = await registry.get(MO_INGEST_JOB_TYPE)!.handler(context(MO_INGEST_JOB_TYPE, {}));
    expect(result).toMatchObject({ ingested: 2 });
    expect(inbound.runScheduledSweep).toHaveBeenCalledWith({
      tenantId: '7',
      userId: 'operator-1',
    });
  });
});
