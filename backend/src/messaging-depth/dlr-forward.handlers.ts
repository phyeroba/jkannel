import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobHandlerRegistry, PermanentJobError } from '../platform/job-registry';
import { JobsService } from '../platform/jobs.service';
import {
  DLR_FORWARD_JOB_TYPE,
  DLR_FORWARD_MAX_ATTEMPTS,
  DLR_FORWARD_POLL_JOB_TYPE,
  DLR_FORWARD_POLL_MAX_ATTEMPTS,
  DlrForwardService,
} from './dlr-forward.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The two job types receipt forwarding runs on. No dispatcher and no
 * scheduler here — the platform queue is both, exactly as MO fan-out does it.
 *
 *   `dlr.forward.poll`      one sweep of new DLR rows into attempt rows, then
 *                           its own successor at `now() + interval`. The
 *                           queue's `next_attempt_at` is the clock, so there
 *                           is no timer to lose on restart and no second
 *                           poller when a replica joins.
 *
 *   `dlr.forward.dispatch`  ONE HTTP call for ONE receipt. Independent claim,
 *                           independent backoff, independent dead-letter —
 *                           so a caller whose endpoint is down cannot hold up
 *                           receipts for anyone else. Twelve attempts on the
 *                           platform's exponential backoff spans a little
 *                           over the 24 hours CPaaS asked us to keep trying
 *                           for.
 */
@Injectable()
export class DlrForwardJobHandlers implements OnModuleInit {
  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly forwarder: DlrForwardService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit(): void {
    this.register();
  }

  /** Idempotent so a second module init does not throw. */
  register(): void {
    if (!this.registry.has(DLR_FORWARD_JOB_TYPE))
      this.registry.register({
        type: DLR_FORWARD_JOB_TYPE,
        description:
          'Forwards one delivery receipt to the dlr_url the caller submitted with the message, ' +
          'with %d replaced by the receipt type and every other byte left alone. Only to hosts ' +
          'on DLR_FORWARD_ALLOWED_HOSTS: a dlr_url is attacker-controllable, so an unrestricted ' +
          'fetcher would be a server-side request forgery engine.',
        maxAttempts: DLR_FORWARD_MAX_ATTEMPTS,
        handler: async (context) => {
          const id = context.input.attemptId;
          if (typeof id !== 'string' || !UUID.test(id))
            throw new PermanentJobError('input.attemptId must be a DLR forward attempt UUID');
          await context.progress(10);
          const outcome = await this.forwarder.dispatch(
            { tenantId: context.actor.tenantId, userId: context.actor.userId },
            id,
            context.attempt,
          );
          await context.progress(100);
          return outcome;
        },
      });

    if (!this.registry.has(DLR_FORWARD_POLL_JOB_TYPE))
      this.registry.register({
        type: DLR_FORWARD_POLL_JOB_TYPE,
        description:
          "Sweeps the engine's new DLR rows that carry a dlr_url into forward attempts and " +
          'enqueues one dispatch job each, then enqueues its own successor so the job queue ' +
          'is the poll timer.',
        maxAttempts: DLR_FORWARD_POLL_MAX_ATTEMPTS,
        handler: async (context) => {
          const actor = { tenantId: context.actor.tenantId, userId: context.actor.userId };
          await context.progress(10);
          // context.jobId is REQUIRED, not decorative: this job is already
          // `status='running'` while its own handler executes, so without
          // excluding itself the successor check matches this row and the
          // chain ends after one sweep.
          const outcome = await this.forwarder.runScheduledSweep(actor, context.jobId);
          if ('skipped' in outcome) {
            await context.progress(100);
            return outcome;
          }
          const { claimed, scanned } = outcome;
          for (const attemptId of claimed)
            await this.jobs.create(actor, {
              type: DLR_FORWARD_JOB_TYPE,
              input: { attemptId },
              // One dispatch per attempt row, forever: the attempt id is
              // already unique per receipt, so a replayed sweep cannot
              // enqueue a second call for the same one.
              idempotencyKey: `dlr-forward:${attemptId}`,
            });
          await context.progress(100);
          return { claimed: claimed.length, scanned, nextSweepScheduled: outcome.nextSweepScheduled };
        },
      });
  }
}
