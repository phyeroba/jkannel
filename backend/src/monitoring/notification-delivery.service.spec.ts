import { NotificationDeliveryService } from './notification-delivery.service';

describe('NotificationDeliveryService', () => {
  const service = new NotificationDeliveryService();
  const alert = { id: 'a1', summary: 'Queue depth high', status: 'open', severity: 'critical' };
  it('records dashboard notifications without external IO', async () => {
    await expect(
      service.deliver(alert, {
        id: 'c1',
        name: 'Dashboard',
        type: 'dashboard',
        enabled: true,
        config: {},
      }),
    ).resolves.toMatchObject({ status: 'succeeded', target: 'dashboard' });
  });
  it('fails unsafe webhook targets instead of sending', async () => {
    await expect(
      service.deliver(alert, {
        id: 'c2',
        name: 'Bad hook',
        type: 'webhook',
        enabled: true,
        config: { url: 'file:///tmp/hook' },
      }),
    ).resolves.toMatchObject({ status: 'failed' });
  });
  it('skips email honestly when SMTP is not configured', async () => {
    const previous = process.env.SMTP_URL;
    delete process.env.SMTP_URL;
    const fresh = new NotificationDeliveryService();
    await expect(
      fresh.deliver(alert, {
        id: 'c3',
        name: 'Email',
        type: 'email',
        enabled: true,
        config: { to: 'ops@example.com' },
      }),
    ).resolves.toMatchObject({ status: 'skipped' });
    if (previous) process.env.SMTP_URL = previous;
  });
  it('skips channels whose severity filter excludes the payload', async () => {
    await expect(
      service.deliver(
        { ...alert, severity: 'info' },
        {
          id: 'c4',
          name: 'Critical only',
          type: 'webhook',
          enabled: true,
          config: { url: 'https://example.com/hook' },
          severities: ['critical'],
        },
      ),
    ).resolves.toMatchObject({ status: 'skipped' });
  });
  it('delivers a generic report payload to a webhook', async () => {
    const calls: any[] = [];
    const originalFetch = global.fetch;
    global.fetch = (async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, statusText: 'OK' } as any;
    }) as any;
    try {
      const result = await service.deliverPayload(
        {
          category: 'report',
          subject: 'Daily report',
          body: '10 messages',
          data: { messages: 10 },
        },
        {
          id: 'c5',
          name: 'Hook',
          type: 'webhook',
          enabled: true,
          config: { url: 'https://example.com/hook' },
        },
      );
      expect(result.status).toBe('succeeded');
      expect(calls[0].body).toMatchObject({
        category: 'report',
        subject: 'Daily report',
        messages: 10,
      });
    } finally {
      global.fetch = originalFetch;
    }
  });
});
