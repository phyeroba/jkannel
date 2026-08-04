import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { KamexSqlboxRepository } from '../engine/kamex-sqlbox.repository';
import { MessageSendService } from './message-send.service';

export interface Actor {
  tenantId: string;
  userId: string;
}

export interface MessageOverrides {
  receiver?: string;
  text?: string;
  sender?: string;
}

/** The original message content resolved from the engine trace. */
export interface ResolvedMessage {
  id: string;
  sender: string;
  receiver: string;
  text: string;
  smscId: string;
  dlrMask: number | null;
  dlrUrl: string | null;
  externalRef: string | null;
  status: string;
}

/**
 * Message replay / clone / requeue: re-submits an existing (tenant-owned) SQLBox
 * message through the engine. The source message is resolved through
 * {@link KamexSqlboxRepository.trace}, which is already tenant-scoped to the
 * caller's SMSC engine ids, so a message that does not belong to the tenant is
 * indistinguishable from one that does not exist (404). Every action is written
 * to audit_log inside a tenant transaction (RLS enforced).
 */
@Injectable()
export class MessageOperationsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sqlbox: KamexSqlboxRepository,
    private readonly send: MessageSendService,
  ) {}

  /** Engine-level SMSC ids owned by the tenant (RLS-scoped smsc_definitions). */
  private tenantSmscScope(tenantId: string): Promise<string[]> {
    return this.database.tenantTransaction(tenantId, async (client) =>
      (
        await client.query<{ engine_id: string }>('SELECT engine_id FROM smsc_definitions')
      ).rows.map((row) => row.engine_id),
    );
  }

  private audit(
    client: PoolClient,
    actor: Actor,
    action: string,
    entityId: string,
    newValue: unknown,
  ) {
    return client.query(
      'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,new_value) VALUES($1,$2,$3,$4,$5,$6)',
      [
        actor.tenantId,
        actor.userId,
        action,
        'message',
        entityId,
        newValue ? JSON.stringify(newValue) : null,
      ],
    );
  }

  /**
   * Resolves the source message for `id` restricted to the tenant's SMSCs.
   * Throws ServiceUnavailableException when SQLBox is not reachable and
   * NotFoundException when the id is not owned by / visible to the tenant.
   */
  async resolve(actor: Actor, id: string): Promise<ResolvedMessage> {
    const probe = await this.sqlbox.probe();
    if (!probe.available)
      throw new ServiceUnavailableException(`SQLBox is not available: ${probe.evidence}`);
    const allowed = await this.tenantSmscScope(actor.tenantId);
    const trace = await this.sqlbox.trace(id, allowed);
    if (!trace.events.length) throw new NotFoundException('Message not found');
    // Prefer the actual message (MT/MO) over a delivery-report event whose text
    // is a status string rather than the original payload.
    const source =
      trace.events.find((event) => event.direction !== 'DLR' && event.text) ?? trace.events[0];
    if (!source.smscId)
      throw new BadRequestException(
        'Original message has no SMSC assigned and cannot be resubmitted',
      );
    if (!allowed.includes(source.smscId))
      throw new BadRequestException('Original message SMSC is not owned by your tenant');
    return {
      id,
      sender: source.sender,
      receiver: source.receiver,
      text: source.text,
      smscId: source.smscId,
      dlrMask: source.dlrMask,
      dlrUrl: source.dlrUrl,
      externalRef: source.externalRef,
      status: source.status,
    };
  }

  private async resubmit(
    actor: Actor,
    id: string,
    action: 'message.replayed' | 'message.cloned' | 'message.requeued',
    overrides: MessageOverrides = {},
  ) {
    const source = await this.resolve(actor, id);
    const submission = {
      sender: overrides.sender?.trim() || source.sender,
      receiver: overrides.receiver?.trim() || source.receiver,
      text: overrides.text ?? source.text,
      smscId: source.smscId,
      dlrMask: source.dlrMask ?? undefined,
      dlrUrl: source.dlrUrl ?? undefined,
      // New correlation id so the resubmission is independently traceable and
      // its delivery reports do not collide with the original message.
      foreignId: randomUUID(),
    };
    // Re-submitting a message keeps its original bind, EXCEPT when that bind is
    // no longer healthy: a replay after an SMSC failure used to be re-spooled
    // straight back onto the dead SMSC. `rerouteIfUnavailable` hands those to
    // the routing engine instead, and the choice is recorded either way.
    const queued = await this.send.send(actor, {
      ...submission,
      channel: 'replay',
      reference: id,
      rerouteIfUnavailable: true,
    });
    await this.database.tenantTransaction(actor.tenantId, async (client) => {
      await this.audit(client, actor, action, id, {
        replayOf: id,
        newSqlId: queued.sqlId,
        foreignId: submission.foreignId,
        smscId: queued.smscId,
        originalSmscId: submission.smscId,
        rerouted: queued.smscId !== submission.smscId,
        routeId: queued.routeId,
        reason: queued.reason,
        overrides,
      });
    });
    return {
      action: action.split('.')[1],
      replayOf: id,
      foreignId: submission.foreignId,
      queued,
      submission: {
        sender: submission.sender,
        receiver: submission.receiver,
        smscId: queued.smscId,
      },
    };
  }

  /** Re-submit an identical copy of a message. */
  replay(actor: Actor, id: string) {
    return this.resubmit(actor, id, 'message.replayed');
  }

  /** Re-submit a message with sender/receiver/text overrides applied. */
  clone(actor: Actor, id: string, overrides: MessageOverrides) {
    return this.resubmit(actor, id, 'message.cloned', overrides);
  }

  /**
   * Re-enqueue a stuck/failed message. Mechanically identical to a replay (a new
   * send_sms row), but recorded distinctly so the intent is auditable.
   */
  requeue(actor: Actor, id: string) {
    return this.resubmit(actor, id, 'message.requeued');
  }
}
