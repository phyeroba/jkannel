import { Injectable } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';
import { DatabaseService } from '../database/database.service';
import { PermanentJobError } from '../platform/job-registry';
import { Actor, MessageSendService } from './message-send.service';
import { MoDeliveryRow, MoMessageRow } from './mo-inbound.service';
import { allowPrivateWebhookTargets, isPrivateHost } from './mo-routing';

export interface DeliveryAttemptResult {
  status: 'delivered' | 'failed';
  responseCode: number | null;
  detail: string;
}

const DELIVERY_COLUMNS =
  'id::text,mo_message_id::text,rule_id::text,rule_name,destination_id::text,kind,target,config,' +
  'status,attempts,max_attempts,manual_retries,last_error,response_code,response_detail,' +
  'job_id::text,delivered_at,created_at,updated_at';

const MESSAGE_COLUMNS =
  'id::text,source,dedupe_key,engine_message_id,external_ref,smsc_id,sender,receiver,' +
  'sender_digits,receiver_digits,body,received_at,matched_rule_ids,fanout_count,status,created_at';

/** Webhook request timeout. Bounded so a hung receiver cannot pin a worker. */
function webhookTimeoutMs(): number {
  const parsed = Number(process.env.MO_WEBHOOK_TIMEOUT_MS ?? 8000);
  if (!Number.isFinite(parsed) || parsed < 500) return 8000;
  return Math.min(Math.floor(parsed), 30_000);
}

/**
 * PERFORMS ONE MO FAN-OUT DELIVERY.
 *
 * One delivery, one job, one row. This class knows nothing about the other
 * destinations of the same inbound message, which is precisely why a failing
 * webhook cannot stop an email: they never share a code path, a transaction or
 * a queue item.
 *
 * EVERY OUTCOME IS WRITTEN DOWN. `delivered` carries the response code;
 * `failed` carries the error and the attempt count; exhausting the
 * destination's `max_attempts` moves the row to `dead_letter`. There is no path
 * that leaves a delivery in `running`, and no path that reports success without
 * a response from the far side.
 *
 * TRANSPORTS
 *   webhook  POST/PUT JSON with the inbound message and its matching rule. The
 *            target was validated at write time (http(s), not a private/
 *            metadata address unless MO_WEBHOOK_ALLOW_PRIVATE=true) and is
 *            re-checked HERE, because a rule stored before that guard existed —
 *            or a DNS name that has since been repointed — must not be trusted
 *            on the strength of a past validation.
 *   email    nodemailer over SMTP_URL, as the platform's existing notification
 *            delivery does. Unconfigured SMTP is a FAILURE, not a skip: an
 *            operator who configured an email destination is entitled to know
 *            it is not working.
 *   sms      forwarded through {@link MessageSendService}, so a forwarded MO is
 *            an ordinary outbound message — routed, entitlement-checked,
 *            content-filtered and recorded like any other. Forwarding must not
 *            be a back door around the platform's own rules.
 */
@Injectable()
export class MoDeliveryService {
  private transporter?: Transporter | null;

  constructor(
    private readonly database: DatabaseService,
    private readonly sender: MessageSendService,
  ) {}

  /**
   * Executes the delivery named by a job, recording the attempt whatever
   * happens. Throws to signal the queue that a retry is wanted; returns
   * normally when the delivery succeeded or is permanently done.
   */
  async dispatch(actor: Actor, deliveryId: string, attempt: number) {
    const loaded = await this.database.tenantTransaction(actor.tenantId, async (client) => {
      const delivery = (
        await client.query<MoDeliveryRow>(
          `SELECT ${DELIVERY_COLUMNS} FROM mo_deliveries WHERE id=$1 FOR UPDATE`,
          [deliveryId],
        )
      ).rows[0];
      if (!delivery) return null;
      if (delivery.status === 'delivered' || delivery.status === 'cancelled')
        return { delivery, message: null, terminal: true as const };
      const message = (
        await client.query<MoMessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM mo_messages WHERE id=$1`, [
          delivery.mo_message_id,
        ])
      ).rows[0];
      await client.query(
        "UPDATE mo_deliveries SET status='running', attempts=$2, updated_at=now() WHERE id=$1",
        [deliveryId, attempt],
      );
      return { delivery, message, terminal: false as const };
    });

    if (!loaded) throw new PermanentJobError(`MO delivery ${deliveryId} no longer exists`);
    if (loaded.terminal)
      return { deliveryId, status: loaded.delivery.status, skipped: true as const };
    if (!loaded.message)
      throw new PermanentJobError(`MO delivery ${deliveryId} has no inbound message`);

    const result = await this.attempt(actor, loaded.delivery, loaded.message);
    const exhausted = attempt >= Number(loaded.delivery.max_attempts);
    const status =
      result.status === 'delivered' ? 'delivered' : exhausted ? 'dead_letter' : 'failed';

    await this.database.tenantTransaction(actor.tenantId, (client) =>
      client.query(
        `UPDATE mo_deliveries
            SET status=$2, last_error=$3, response_code=$4, response_detail=$5,
                delivered_at = CASE WHEN $2='delivered' THEN now() ELSE delivered_at END,
                updated_at=now()
          WHERE id=$1`,
        [
          deliveryId,
          status,
          result.status === 'delivered' ? null : result.detail.slice(0, 2000),
          result.responseCode,
          result.detail.slice(0, 2000),
        ],
      ),
    );

    if (result.status === 'delivered')
      return {
        deliveryId,
        status: 'delivered' as const,
        responseCode: result.responseCode,
        detail: result.detail,
      };

    // A destination that has used its own attempt budget is DONE, whatever the
    // queue's type-wide ceiling says: dead-letter it now rather than retrying
    // past the limit the operator set on that destination.
    if (exhausted)
      throw new PermanentJobError(
        `MO delivery to ${loaded.delivery.kind} ${loaded.delivery.target} failed after ` +
          `${attempt}/${loaded.delivery.max_attempts} attempts: ${result.detail}`,
      );
    throw new Error(
      `MO delivery to ${loaded.delivery.kind} ${loaded.delivery.target} failed ` +
        `(attempt ${attempt}/${loaded.delivery.max_attempts}): ${result.detail}`,
    );
  }

  /** Performs one attempt. Never throws: every failure becomes a result. */
  async attempt(
    actor: Actor,
    delivery: MoDeliveryRow,
    message: MoMessageRow,
  ): Promise<DeliveryAttemptResult> {
    try {
      switch (delivery.kind) {
        case 'webhook':
          return await this.deliverWebhook(delivery, message);
        case 'email':
          return await this.deliverEmail(delivery, message);
        default:
          return await this.deliverSms(actor, delivery, message);
      }
    } catch (error) {
      return {
        status: 'failed',
        responseCode: null,
        detail: String((error as Error).message ?? error),
      };
    }
  }

  private payload(delivery: MoDeliveryRow, message: MoMessageRow) {
    return {
      source: 'jkannel',
      event: 'mo.received',
      moMessageId: message.id,
      deliveryId: delivery.id,
      rule: { id: delivery.rule_id, name: delivery.rule_name },
      message: {
        sender: message.sender,
        receiver: message.receiver,
        text: message.body,
        smscId: message.smsc_id,
        receivedAt:
          message.received_at instanceof Date
            ? message.received_at.toISOString()
            : message.received_at,
        externalRef: message.external_ref,
        engineMessageId: message.engine_message_id,
      },
    };
  }

  private async deliverWebhook(
    delivery: MoDeliveryRow,
    message: MoMessageRow,
  ): Promise<DeliveryAttemptResult> {
    const config = delivery.config ?? {};
    let url: URL;
    try {
      url = new URL(delivery.target);
    } catch {
      return { status: 'failed', responseCode: null, detail: 'target is not a valid URL' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return { status: 'failed', responseCode: null, detail: 'target must be http or https' };
    if (!allowPrivateWebhookTargets() && isPrivateHost(url.hostname))
      return {
        status: 'failed',
        responseCode: null,
        detail: `refusing to POST to private host ${url.hostname}`,
      };

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    for (const [key, value] of Object.entries((config.headers ?? {}) as Record<string, unknown>))
      headers[key.toLowerCase()] = String(value);
    if (typeof config.secret === 'string' && config.secret)
      headers['x-jkannel-signature'] = config.secret;

    const response = await fetch(url.toString(), {
      method: String(config.method ?? 'POST'),
      headers,
      body: JSON.stringify(this.payload(delivery, message)),
      signal: AbortSignal.timeout(webhookTimeoutMs()),
    });
    return {
      status: response.ok ? 'delivered' : 'failed',
      responseCode: response.status,
      detail: `${response.status} ${response.statusText}`,
    };
  }

  private async deliverEmail(
    delivery: MoDeliveryRow,
    message: MoMessageRow,
  ): Promise<DeliveryAttemptResult> {
    const transporter = this.emailTransporter();
    if (!transporter)
      return {
        status: 'failed',
        responseCode: null,
        detail: 'SMTP_URL is not configured, so this email destination cannot deliver',
      };
    const config = delivery.config ?? {};
    const subject =
      typeof config.subject === 'string' && config.subject
        ? config.subject
        : `Inbound SMS from ${message.sender} to ${message.receiver}`;
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM ?? 'jkannel@localhost',
      to: delivery.target,
      subject,
      text:
        `From: ${message.sender}\nTo: ${message.receiver}\n` +
        `SMSC: ${message.smsc_id ?? 'unknown'}\nRule: ${delivery.rule_name}\n\n${message.body}`,
    });
    return {
      status: 'delivered',
      responseCode: null,
      detail: `messageId=${info.messageId ?? 'unknown'} accepted=${info.accepted?.length ?? 0}`,
    };
  }

  /**
   * Forwards the inbound message as an outbound SMS through THE send path.
   *
   * The forwarded text carries the original sender, because a forward that
   * looks like it came from the platform loses the only piece of information
   * the recipient needs to reply to the right person.
   */
  private async deliverSms(
    actor: Actor,
    delivery: MoDeliveryRow,
    message: MoMessageRow,
  ): Promise<DeliveryAttemptResult> {
    const config = delivery.config ?? {};
    const sender =
      typeof config.sender === 'string' && config.sender
        ? config.sender
        : (message.receiver ?? 'JKANNEL').slice(0, 20);
    const text = `From ${message.sender}: ${message.body}`.slice(0, 1000);
    const result = await this.sender.send(actor, {
      sender,
      receiver: delivery.target,
      text,
      smscId: typeof config.smscId === 'string' ? config.smscId : null,
      customerId: typeof config.customerId === 'string' ? config.customerId : null,
      channel: 'system',
      reference: `mo:${message.id}`,
      foreignId: `mo-${delivery.id}`,
    });
    return {
      status: 'delivered',
      responseCode: null,
      detail: `forwarded as ${result.sqlId} via ${result.smscId}`,
    };
  }

  private emailTransporter(): Transporter | null {
    if (this.transporter !== undefined) return this.transporter;
    const url = process.env.SMTP_URL;
    this.transporter = url ? createTransport(url) : null;
    return this.transporter;
  }
}
