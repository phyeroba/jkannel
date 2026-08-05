import { PermanentJobError } from '../platform/job-registry';
import { MoDeliveryService } from './mo-delivery.service';
import { MoDeliveryRow, MoMessageRow } from './mo-inbound.service';

const actor = { tenantId: '1', userId: 'u1' };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const message: MoMessageRow = {
  id: id(200),
  source: 'sqlbox',
  dedupe_key: 'sqlbox:31',
  engine_message_id: '31',
  external_ref: null,
  smsc_id: 'mtn-ug',
  sender: '256700123456',
  receiver: '8080',
  sender_digits: '256700123456',
  receiver_digits: '8080',
  body: 'BAL please',
  received_at: '2026-08-01T00:00:00.000Z',
  matched_rule_ids: [id(1)],
  fanout_count: 3,
  status: 'matched',
  created_at: 'now',
};

function delivery(overrides: Partial<MoDeliveryRow> = {}): MoDeliveryRow {
  return {
    id: id(300),
    mo_message_id: message.id,
    rule_id: id(1),
    rule_name: 'crm',
    destination_id: id(50),
    kind: 'webhook',
    target: 'https://hooks.example.com/mo',
    config: {},
    status: 'pending',
    attempts: 0,
    max_attempts: 3,
    manual_retries: 0,
    last_error: null,
    response_code: null,
    response_detail: null,
    job_id: id(400),
    delivered_at: null,
    created_at: 'now',
    updated_at: 'now',
    ...overrides,
  };
}

function makeStack(rows: MoDeliveryRow[], sendImpl?: jest.Mock) {
  const store = new Map(rows.map((row) => [row.id, { ...row }]));
  const client = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      const text = sql.trim();
      if (text.startsWith('SELECT') && text.includes('FROM mo_deliveries')) {
        const found = store.get(String(params[0]));
        return { rows: found ? [found] : [] };
      }
      if (text.startsWith('SELECT') && text.includes('FROM mo_messages'))
        return { rows: [message] };
      if (text.startsWith('UPDATE mo_deliveries')) {
        const row = store.get(String(params[0]));
        if (row) {
          if (text.includes("status='running'")) {
            row.status = 'running';
            row.attempts = Number(params[1]);
          } else {
            row.status = params[1];
            row.last_error = params[2];
            row.response_code = params[3];
            row.response_detail = params[4];
          }
        }
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
  const database: any = { tenantTransaction: (_t: string, work: any) => work(client) };
  const send = sendImpl ?? jest.fn(async () => ({ sqlId: '900', smscId: 'mtn-ug' }));
  const service = new MoDeliveryService(database, { send } as any);
  return { service, store, send, client };
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.SMTP_URL;
  delete process.env.MO_WEBHOOK_ALLOW_PRIVATE;
});

describe('MoDeliveryService — a single delivery', () => {
  it('POSTs the inbound message to a webhook and records the response', async () => {
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200, statusText: 'OK' }));
    global.fetch = fetchMock as never;

    const { service, store } = makeStack([delivery()]);
    const outcome = await service.dispatch(actor, id(300), 1);

    expect(outcome).toMatchObject({ status: 'delivered', responseCode: 200 });
    expect(store.get(id(300))).toMatchObject({ status: 'delivered' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, any];
    expect(url).toBe('https://hooks.example.com/mo');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      event: 'mo.received',
      moMessageId: message.id,
      rule: { name: 'crm' },
      message: { sender: '256700123456', receiver: '8080', text: 'BAL please' },
    });
  });

  it('sends the configured shared secret and headers, and never lets a rule rewrite Host', async () => {
    const fetchMock = jest.fn(async () => ({ ok: true, status: 202, statusText: 'Accepted' }));
    global.fetch = fetchMock as never;
    const { service } = makeStack([
      delivery({ config: { method: 'PUT', secret: 's3cret', headers: { 'X-Tenant': 'acme' } } }),
    ]);
    await service.dispatch(actor, id(300), 1);
    const init = (fetchMock.mock.calls[0] as unknown as [string, any])[1];
    expect(init.method).toBe('PUT');
    expect(init.headers['x-jkannel-signature']).toBe('s3cret');
    expect(init.headers['x-tenant']).toBe('acme');
    expect(init.headers.host).toBeUndefined();
  });

  it('refuses at delivery time to POST to a private host, even if the row says so', async () => {
    // A row can predate the write-time guard, or its DNS name can be repointed.
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, statusText: 'OK' })) as never;
    const { service, store } = makeStack([delivery({ target: 'http://169.254.169.254/latest' })]);
    await expect(service.dispatch(actor, id(300), 3)).rejects.toBeInstanceOf(PermanentJobError);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(store.get(id(300))!.last_error).toContain('private host');
  });

  it('forwards as an SMS through THE send path, so routing and entitlements still apply', async () => {
    const send = jest.fn(async () => ({ sqlId: '901', smscId: 'mtn-ug' }));
    const { service, store } = makeStack([delivery({ kind: 'sms', target: '256711111111' })], send);
    const outcome = await service.dispatch(actor, id(300), 1);
    expect(outcome.status).toBe('delivered');
    expect(send).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        receiver: '256711111111',
        channel: 'system',
        text: 'From 256700123456: BAL please',
        reference: `mo:${message.id}`,
      }),
    );
    expect(store.get(id(300))!.response_detail).toContain('901');
  });

  it('fails an email destination loudly when SMTP is not configured', async () => {
    const { service, store } = makeStack([
      delivery({ kind: 'email', target: 'ops@example.com', max_attempts: 1 }),
    ]);
    await expect(service.dispatch(actor, id(300), 1)).rejects.toBeInstanceOf(PermanentJobError);
    expect(store.get(id(300))).toMatchObject({ status: 'dead_letter' });
    expect(store.get(id(300))!.last_error).toContain('SMTP_URL is not configured');
  });
});

describe('MoDeliveryService — retry and independence', () => {
  it('retries a failed attempt while the destination has budget, then dead-letters it', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    })) as never;
    const { service, store } = makeStack([delivery({ max_attempts: 3 })]);

    // Attempts 1 and 2 throw an ORDINARY error -> the queue backs off and retries.
    for (const attempt of [1, 2]) {
      await expect(service.dispatch(actor, id(300), attempt)).rejects.toThrow(/failed/);
      expect(store.get(id(300))).toMatchObject({ status: 'failed', attempts: attempt });
    }
    // Attempt 3 exhausts the destination's own budget -> permanent, dead-lettered.
    await expect(service.dispatch(actor, id(300), 3)).rejects.toBeInstanceOf(PermanentJobError);
    expect(store.get(id(300))).toMatchObject({ status: 'dead_letter', response_code: 503 });
  });

  it('ONE FAILING DESTINATION DOES NOT PREVENT THE OTHERS', async () => {
    // The three destinations of one inbound message, dispatched as the three
    // independent jobs the queue would run them as.
    global.fetch = jest.fn(async (url: string) =>
      String(url).includes('broken')
        ? { ok: false, status: 500, statusText: 'Internal Server Error' }
        : { ok: true, status: 200, statusText: 'OK' },
    ) as never;

    const rows = [
      delivery({ id: id(301), kind: 'webhook', target: 'https://hooks.example.com/ok' }),
      delivery({ id: id(302), kind: 'webhook', target: 'https://hooks.example.com/broken' }),
      delivery({ id: id(303), kind: 'sms', target: '256711111111' }),
    ];
    const { service, store, send } = makeStack(rows);

    const results = await Promise.allSettled(rows.map((row) => service.dispatch(actor, row.id, 1)));

    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
    expect(results[2].status).toBe('fulfilled');
    expect(store.get(id(301))).toMatchObject({ status: 'delivered' });
    expect(store.get(id(302))).toMatchObject({ status: 'failed', response_code: 500 });
    expect(store.get(id(303))).toMatchObject({ status: 'delivered' });
    // The SMS forward happened despite the webhook failure beside it.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('records a transport exception as a failure rather than escaping as a 500', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('ETIMEDOUT');
    }) as never;
    const { service, store } = makeStack([delivery({ max_attempts: 1 })]);
    await expect(service.dispatch(actor, id(300), 1)).rejects.toBeInstanceOf(PermanentJobError);
    expect(store.get(id(300))!.last_error).toContain('ETIMEDOUT');
  });

  it('does not re-deliver an already delivered row', async () => {
    global.fetch = jest.fn() as never;
    const { service } = makeStack([delivery({ status: 'delivered' })]);
    expect(await service.dispatch(actor, id(300), 1)).toMatchObject({ skipped: true });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('treats a vanished delivery as permanent, not as something to retry forever', async () => {
    const { service } = makeStack([]);
    await expect(service.dispatch(actor, id(999), 1)).rejects.toBeInstanceOf(PermanentJobError);
  });
});
