import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobHandlerRegistry, PermanentJobError } from '../platform/job-registry';
import {
  DELIVERY_RETRY_DISPATCH_JOB_TYPE,
  DELIVERY_RETRY_DISPATCH_MAX_ATTEMPTS,
  DELIVERY_RETRY_SCAN_JOB_TYPE,
  DELIVERY_RETRY_SCAN_MAX_ATTEMPTS,
  DeliveryRetryService,
} from './delivery-retry.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The two job types delivery-failure retry runs on. No scheduler and no timer
 * are introduced: the platform queue is both, exactly as it is for MO ingest and
 * scheduled send.
 *
 *   `delivery.retry.scan`      one sweep of the engine's negative delivery
 *     reports and, while any policy is enabled, the next sweep enqueued at
 *     `now() + pollIntervalSeconds`. `next_attempt_at` is the poll clock, so a
 *     restart loses nothing and a second replica does not start a second poller.
 *
 *   `delivery.retry.dispatch`  ONE re-send of ONE message, stamped with
 *     `runAt = now + minDelaySeconds` — which is also the window in which a late
 *     `delivered` report can still cancel it.
 *
 *     `maxAttempts` here is the QUEUE's budget for infrastructural failures
 *     (SQLBox briefly unreachable, a connection dropped mid-deploy), NOT the
 *     retry budget. The message's own budget is the chain's `max_attempts`, and
 *     the chain increments `attempts` in a committed transaction BEFORE the
 *     send, so a queue-level retry cannot smuggle an extra submission past it.
 *
 * Registration lives here rather than in the platform layer, matching
 * mo.handlers.ts, so `platform/` never imports a domain module.
 */
@Injectable()
export class DeliveryRetryJobHandlers implements OnModuleInit {
  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly retries: DeliveryRetryService,
  ) {}

  onModuleInit(): void {
    this.register();
  }

  /** Idempotent so a second module init does not throw. */
  register(): void {
    if (!this.registry.has(DELIVERY_RETRY_SCAN_JOB_TYPE))
      this.registry.register({
        type: DELIVERY_RETRY_SCAN_JOB_TYPE,
        description:
          "Sweeps the engine's negative delivery reports (sent_sms rows with momt='DLR' and a " +
          'dlr_mask of 2 or 16) past the tenant watermark and opens a retry chain for each one ' +
          'the retry policy accepts. While any policy is enabled the run enqueues its own ' +
          'successor, so the job queue is the poll timer.',
        maxAttempts: DELIVERY_RETRY_SCAN_MAX_ATTEMPTS,
        handler: async (context) => {
          await context.progress(10);
          const outcome = await this.retries.runScheduledScan(
            { tenantId: context.actor.tenantId, userId: context.actor.userId },
            // This job is `status='running'` for the whole handler. Without
            // telling the scheduler which row that is, the "one scan in flight"
            // guard would match this very job and no successor would ever be
            // enqueued — the poll chain would run exactly once.
            { currentJobId: context.jobId },
          );
          await context.progress(100);
          return outcome;
        },
      });

    if (!this.registry.has(DELIVERY_RETRY_DISPATCH_JOB_TYPE))
      this.registry.register({
        type: DELIVERY_RETRY_DISPATCH_JOB_TYPE,
        description:
          'Re-sends one message that a carrier failed to deliver, on a bind it has not already ' +
          'been tried on. Re-checks the engine for a late "delivered" report immediately before ' +
          'submitting, and cancels rather than double-delivering.',
        maxAttempts: DELIVERY_RETRY_DISPATCH_MAX_ATTEMPTS,
        handler: async (context) => {
          const id = context.input.retryId;
          if (typeof id !== 'string' || !UUID.test(id))
            throw new PermanentJobError('input.retryId must be a delivery retry UUID');
          await context.progress(10);
          const outcome = await this.retries.dispatch(
            { tenantId: context.actor.tenantId, userId: context.actor.userId },
            id,
          );
          await context.progress(100);
          return outcome;
        },
      });
  }
}
