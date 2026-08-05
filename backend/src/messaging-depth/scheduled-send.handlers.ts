import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobHandlerRegistry, PermanentJobError } from '../platform/job-registry';
import {
  SCHEDULED_RELEASE_JOB_TYPE,
  SCHEDULED_RELEASE_MAX_ATTEMPTS,
  ScheduledSendService,
} from './scheduled-send.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The job type that makes "send later" real.
 *
 * There is no scheduler here and no timer. A held message is an ordinary
 * `api_jobs` row whose `next_attempt_at` is the scheduled instant, so the
 * existing worker claims it — with `FOR UPDATE SKIP LOCKED`, under the
 * worker's advisory lock, exactly once across every replica — at the moment it
 * falls due, and this handler is what runs. Everything the queue already does
 * (bounded attempts, exponential backoff, dead-lettering, reaping a claim left
 * by a crashed worker) applies unchanged.
 *
 * Registration lives in the owning module, matching backup-job.handlers.ts, so
 * the platform layer never imports a domain module.
 *
 * ATTEMPTS. Four, rather than the default three. A release is safe to repeat —
 * see ScheduledSendService's crash-safety note on why a `releasing` hold
 * provably has not been sent — and the failures worth retrying (SQLBox
 * momentarily unavailable, a connection dropped during a deploy) are exactly
 * the ones a couple of extra backed-off attempts clear. A refusal that is a
 * DECISION (quota, credit, sender ID, blocklist, no route) does not consume
 * attempts at all: it is raised as a {@link PermanentJobError} and dead-letters
 * at once, because retrying it could not change the answer.
 */
@Injectable()
export class ScheduledSendJobHandlers implements OnModuleInit {
  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly scheduling: ScheduledSendService,
  ) {}

  onModuleInit(): void {
    this.register();
  }

  /** Idempotent so a second module init does not throw. */
  register(): void {
    if (this.registry.has(SCHEDULED_RELEASE_JOB_TYPE)) return;
    this.registry.register({
      type: SCHEDULED_RELEASE_JOB_TYPE,
      description:
        'Releases a scheduled message or campaign into the normal send path at its scheduled ' +
        'instant. Entitlements, blocklist and routing are evaluated at release, not at schedule ' +
        'time; a release later than the staleness ceiling expires the message instead of ' +
        'delivering it stale.',
      maxAttempts: SCHEDULED_RELEASE_MAX_ATTEMPTS,
      handler: async (context) => {
        const id = context.input.scheduledMessageId;
        if (typeof id !== 'string' || !UUID.test(id))
          throw new PermanentJobError('input.scheduledMessageId must be a scheduled message UUID');
        await context.progress(10);
        const outcome = await this.scheduling.release(context.actor.tenantId, id, {
          workerId: `job:${context.jobId}`,
          attempt: context.attempt,
          maxAttempts: context.maxAttempts,
        });
        await context.progress(100);
        return outcome;
      },
    });
  }
}
