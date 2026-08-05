import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobHandlerRegistry, PermanentJobError } from '../platform/job-registry';
import { MoDeliveryService } from './mo-delivery.service';
import {
  MO_DELIVERY_JOB_TYPE,
  MO_DELIVERY_MAX_ATTEMPTS,
  MO_INGEST_JOB_TYPE,
  MO_INGEST_MAX_ATTEMPTS,
  MoInboundService,
} from './mo-inbound.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The two job types MO fan-out runs on.
 *
 * There is no dispatcher and no scheduler here — the platform queue is both.
 *
 *   `mo.delivery.dispatch`  ONE destination of ONE inbound message. Independent
 *     claim (`FOR UPDATE SKIP LOCKED`), independent exponential backoff,
 *     independent dead-letter. That independence IS the requirement that one
 *     failing destination must not prevent the others: they are separate rows in
 *     the queue and never touch each other.
 *
 *     The registry's `maxAttempts` is a per-TYPE ceiling, but each destination
 *     carries its OWN `max_attempts` (1-20). MoDeliveryService enforces the
 *     per-destination budget by raising a {@link PermanentJobError} once it is
 *     spent, which dead-letters that job immediately. The type ceiling is the
 *     upper bound of what any destination may ask for.
 *
 *   `mo.ingest.poll`  one sweep of the engine's MO rows, then — while the tenant
 *     has polling enabled — the next sweep enqueued at `now() + interval`. The
 *     queue's `next_attempt_at` is the clock, exactly as it is for a scheduled
 *     send, so there is no timer to lose on restart and no second poller when a
 *     replica joins.
 */
@Injectable()
export class MoJobHandlers implements OnModuleInit {
  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly inbound: MoInboundService,
    private readonly delivery: MoDeliveryService,
  ) {}

  onModuleInit(): void {
    this.register();
  }

  /** Idempotent so a second module init does not throw. */
  register(): void {
    if (!this.registry.has(MO_DELIVERY_JOB_TYPE))
      this.registry.register({
        type: MO_DELIVERY_JOB_TYPE,
        description:
          'Delivers one inbound (MO) message to one fan-out destination: a webhook, an email ' +
          'address, or a forwarded SMS. Each destination is its own job, so a failing ' +
          'destination retries and dead-letters on its own without affecting the others.',
        maxAttempts: MO_DELIVERY_MAX_ATTEMPTS,
        handler: async (context) => {
          const id = context.input.deliveryId;
          if (typeof id !== 'string' || !UUID.test(id))
            throw new PermanentJobError('input.deliveryId must be an MO delivery UUID');
          await context.progress(10);
          const outcome = await this.delivery.dispatch(
            { tenantId: context.actor.tenantId, userId: context.actor.userId },
            id,
            context.attempt,
          );
          await context.progress(100);
          return outcome;
        },
      });

    if (!this.registry.has(MO_INGEST_JOB_TYPE))
      this.registry.register({
        type: MO_INGEST_JOB_TYPE,
        description:
          "Sweeps the engine's MO rows (sent_sms where momt='MO') into the platform, matching " +
          "each against the tenant's MO routing rules and fanning it out. While polling is " +
          'enabled the run enqueues its own successor, so the job queue is the poll timer.',
        maxAttempts: MO_INGEST_MAX_ATTEMPTS,
        handler: async (context) => {
          await context.progress(10);
          const outcome = await this.inbound.runScheduledSweep({
            tenantId: context.actor.tenantId,
            userId: context.actor.userId,
          });
          await context.progress(100);
          return outcome;
        },
      });
  }
}
