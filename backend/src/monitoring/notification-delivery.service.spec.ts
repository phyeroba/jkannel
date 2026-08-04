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

describe('NotificationDeliveryService sms channel', () => {
  const alert = { id: 'a1', summary: 'Bind local-fake is disconnected', status: 'open' };
  const channel = (config: Record<string, unknown>): any => ({
    id: 'c9',
    name: 'Duty phone',
    type: 'sms',
    enabled: true,
    config,
  });

  it('submits through the platform send path instead of silently dropping the alert', async () => {
    const submit = jest.fn(async (_value: any) => ({
      sqlId: '4711',
      status: 'queued',
      source: 'kamex-sqlbox',
    }));
    const service = new NotificationDeliveryService({ submit } as any);
    const result = await service.deliver(alert, channel({ msisdn: '+256700000000' }));
    expect(result).toMatchObject({ status: 'succeeded', target: '+256700000000' });
    expect(result.response).toMatchObject({ sqlId: '4711' });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        receiver: '+256700000000',
        // Operational SMS: no DLR requested.
        dlrMask: 0,
      }),
    );
    expect(submit.mock.calls[0][0].text).toContain('Bind local-fake is disconnected');
  });

  it('fails loudly when the SMS send path is not wired into this process', async () => {
    const service = new NotificationDeliveryService();
    const result = await service.deliver(alert, channel({ msisdn: '+256700000000' }));
    expect(result.status).toBe('failed');
    expect(String(result.response.error)).toContain('SMS delivery path is unavailable');
  });

  it('fails a channel with a missing or malformed recipient', async () => {
    const service = new NotificationDeliveryService({ submit: jest.fn() } as any);
    await expect(service.deliver(alert, channel({}))).resolves.toMatchObject({ status: 'failed' });
    await expect(
      service.deliver(alert, channel({ msisdn: 'not-a-number' })),
    ).resolves.toMatchObject({ status: 'failed' });
  });

  it('reports a rejected submission as failed rather than succeeded', async () => {
    const service = new NotificationDeliveryService({
      submit: jest.fn().mockRejectedValue(new Error('KAMEX_SQLBOX_DATABASE_URL is not configured')),
    } as any);
    const result = await service.deliver(alert, channel({ msisdn: '+256700000000' }));
    expect(result.status).toBe('failed');
    expect(String(result.response.error)).toContain('KAMEX_SQLBOX_DATABASE_URL');
  });

  it('still honours the channel severity filter before sending', async () => {
    const submit = jest.fn();
    const service = new NotificationDeliveryService({ submit } as any);
    const result = await service.deliver(
      { ...alert, severity: 'info' },
      { ...channel({ msisdn: '+256700000000' }), severities: ['critical'] },
    );
    expect(result.status).toBe('skipped');
    expect(submit).not.toHaveBeenCalled();
  });
});
