import { Injectable } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';

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

@Injectable()
export class NotificationDeliveryService {
  private transporter?: Transporter | null;

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
    return {
      ...base,
      status: 'skipped',
      target: channel.type,
      response: { reason: `channel transport '${channel.type}' not implemented` },
    };
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
