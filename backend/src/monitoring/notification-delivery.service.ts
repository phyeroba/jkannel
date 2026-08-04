import { Injectable, Optional } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';
import { KamexSqlboxRepository } from '../engine/kamex-sqlbox.repository';

export interface NotificationChannel {
  id: string;
  name: string;
  type: 'dashboard' | 'webhook' | 'email' | 'sms';
  enabled: boolean;
  config: Record<string, unknown>;
  severities?: string[];
}
export interface AlertNotification {
  id: string;
  summary: string;
  status: string;
  severity?: string;
  details?: unknown;
  opened_at?: string;
}
export interface NotificationAttempt {
  channelId: string;
  channelType: string;
  status: 'succeeded' | 'failed' | 'skipped';
  target?: string;
  response: Record<string, unknown>;
}

/**
 * A transport-neutral notification payload. Alerts and scheduled reports both
 * deliver through the same channels; `subject`/`body` render for email, and the
 * full `data` object is posted to webhooks.
 */
export interface DeliverablePayload {
  category: 'alert' | 'report';
  subject: string;
  body: string;
  severity?: string;
  data: Record<string, unknown>;
}

/** Loosely validates an MSISDN: optional +, 6–15 digits (E.164 upper bound). */
const MSISDN_PATTERN = /^\+?[0-9]{6,15}$/;

@Injectable()
export class NotificationDeliveryService {
  private transporter?: Transporter | null;

  /**
   * Optional so the three modules that provide this service without importing
   * EngineModule keep constructing. Where it is absent, `sms` delivery reports
   * `failed` with the reason — never a silent success.
   */
  constructor(@Optional() private readonly sqlbox?: KamexSqlboxRepository) {}

  /** Backward-compatible alert delivery; delegates to the generic path. */
  deliver(alert: AlertNotification, channel: NotificationChannel): Promise<NotificationAttempt> {
    return this.deliverPayload(
      {
        category: 'alert',
        subject: `[JKANNEL ${alert.severity ?? 'alert'}] ${alert.summary}`,
        body: `Alert ${alert.summary} is ${alert.status}.`,
        severity: alert.severity,
        data: { alert },
      },
      channel,
    );
  }

  async deliverPayload(
    payload: DeliverablePayload,
    channel: NotificationChannel,
  ): Promise<NotificationAttempt> {
    const base = { channelId: channel.id, channelType: channel.type };
    if (!channel.enabled)
      return {
        ...base,
        status: 'skipped',
        target: channel.name,
        response: { reason: 'channel disabled' },
      };
    if (
      channel.severities?.length &&
      payload.severity &&
      !channel.severities.includes(payload.severity)
    )
      return {
        ...base,
        status: 'skipped',
        target: channel.name,
        response: { reason: 'severity not selected' },
      };

    if (channel.type === 'dashboard')
      return {
        ...base,
        status: 'succeeded',
        target: 'dashboard',
        response: { message: 'dashboard notification recorded' },
      };
    if (channel.type === 'webhook') return this.deliverWebhook(payload, channel, base);
    if (channel.type === 'email') return this.deliverEmail(payload, channel, base);
    if (channel.type === 'sms') return this.deliverSms(payload, channel, base);
    // Unknown transports fail loudly rather than reporting a quiet 'skipped':
    // a channel that accepts alerts and drops them is worse than no channel.
    return {
      ...base,
      status: 'failed',
      target: channel.type,
      response: { error: `channel transport '${channel.type}' is not implemented` },
    };
  }

  /**
   * Delivers an alert as an SMS through the platform's own send path.
   *
   * `notification_channels` has accepted `type='sms'` since migration 008 and
   * this service used to answer `status:'skipped'` for it — on an SMS gateway.
   * An operator could configure the one channel type the product is actually
   * built to deliver, and every alert would be silently discarded. It now goes
   * out through `KamexSqlboxRepository.submit`, the same SQLBox spool the rest
   * of the platform submits MT traffic to.
   *
   * Every failure mode is explicit: no SQLBox wiring, no recipient, a malformed
   * recipient and a rejected insert all return `failed` with a reason. Nothing
   * here can report success without a `sql_id` coming back.
   */
  private async deliverSms(
    payload: DeliverablePayload,
    channel: NotificationChannel,
    base: { channelId: string; channelType: string },
  ): Promise<NotificationAttempt> {
    const recipient = String(
      channel.config?.msisdn ?? channel.config?.to ?? channel.config?.recipient ?? '',
    ).trim();
    if (!this.sqlbox)
      return {
        ...base,
        status: 'failed',
        target: recipient || channel.name,
        response: {
          error:
            'SMS delivery path is unavailable in this process (SQLBox repository not injected)',
        },
      };
    if (!MSISDN_PATTERN.test(recipient))
      return {
        ...base,
        status: 'failed',
        target: recipient || channel.name,
        response: { error: 'channel config.msisdn must be an MSISDN (6-15 digits, optional +)' },
      };
    const sender = String(
      channel.config?.sender ?? process.env.ALERT_SMS_SENDER ?? 'JKANNEL',
    ).slice(0, 20);
    const smscId = channel.config?.smscId ? String(channel.config.smscId) : undefined;
    // Alert SMS are operational, not billable traffic: no DLR is requested, and
    // the text is capped so a long alert body cannot become a 10-part message.
    const text = `${payload.subject} - ${payload.body}`.replace(/\s+/g, ' ').slice(0, 320);
    try {
      const submission = await this.sqlbox.submit({
        sender,
        receiver: recipient,
        text,
        smscId,
        dlrMask: 0,
      });
      return {
        ...base,
        status: 'succeeded',
        target: recipient,
        response: { sqlId: submission.sqlId, via: submission.source },
      };
    } catch (error) {
      return {
        ...base,
        status: 'failed',
        target: recipient,
        response: { error: (error as Error).message },
      };
    }
  }

  private async deliverWebhook(
    payload: DeliverablePayload,
    channel: NotificationChannel,
    base: { channelId: string; channelType: string },
  ): Promise<NotificationAttempt> {
    const url = String(channel.config?.url ?? '');
    if (!/^https?:\/\//i.test(url))
      return {
        ...base,
        status: 'failed',
        target: url,
        response: { error: 'webhook url must be http or https' },
      };
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // Optional shared-secret header for the receiver to authenticate the hook.
    const secret = channel.config?.secret;
    if (typeof secret === 'string' && secret) headers['x-jkannel-signature'] = secret;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source: 'jkannel',
          category: payload.category,
          subject: payload.subject,
          body: payload.body,
          ...payload.data,
        }),
        signal: AbortSignal.timeout(5000),
      });
      return {
        ...base,
        status: res.ok ? 'succeeded' : 'failed',
        target: url,
        response: { status: res.status, statusText: res.statusText },
      };
    } catch (error) {
      return {
        ...base,
        status: 'failed',
        target: url,
        response: { error: (error as Error).message },
      };
    }
  }

  private async deliverEmail(
    payload: DeliverablePayload,
    channel: NotificationChannel,
    base: { channelId: string; channelType: string },
  ): Promise<NotificationAttempt> {
    const transporter = this.emailTransporter();
    const to = String(channel.config?.to ?? '');
    if (!transporter)
      return {
        ...base,
        status: 'skipped',
        target: to || channel.name,
        response: { reason: 'SMTP_URL is not configured; email delivery unavailable' },
      };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to))
      return {
        ...base,
        status: 'failed',
        target: to,
        response: { error: 'channel config.to must be an email address' },
      };
    try {
      const info = await transporter.sendMail({
        from: process.env.SMTP_FROM ?? 'jkannel@localhost',
        to,
        subject: payload.subject,
        text: payload.body,
      });
      return {
        ...base,
        status: 'succeeded',
        target: to,
        response: { messageId: info.messageId, accepted: info.accepted?.length ?? 0 },
      };
    } catch (error) {
      return {
        ...base,
        status: 'failed',
        target: to,
        response: { error: (error as Error).message },
      };
    }
  }

  private emailTransporter(): Transporter | null {
    if (this.transporter !== undefined) return this.transporter;
    const url = process.env.SMTP_URL;
    // Cache the resolution (including the null "unconfigured" case) so we don't
    // rebuild a transport per delivery.
    this.transporter = url ? createTransport(url) : null;
    return this.transporter;
  }
}
