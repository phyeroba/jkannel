import { KamexAdapter } from './kamex.adapter';

/** Real captured /status.json payload from a running Kamex bearerbox 1.8.3. */
const liveStatus = {
  version: '1.8.3',
  status: 'running',
  uptime: { days: 0, hours: 0, minutes: 3, seconds: 17 },
  sms: {
    received: { total: 0, queued: 2 },
    sent: { total: 9, queued: 4 },
    store_size: -1,
    inbound_rate: [0.0, 0.0, 0.0],
    outbound_rate: [1.5, 0.5, 0.25],
  },
  dlr: {
    received: 0,
    sent: 0,
    queued: 3,
    storage: 'internal',
    inbound_rate: [0, 0, 0],
    outbound_rate: [0, 0, 0],
  },
  boxes: [{ type: 'smsbox', id: 'jkannel-sqlbox', ip: '172.25.0.4', http_port: -1, queue: 0 }],
  smscs: [
    {
      id: 'local-fake',
      admin_id: 'local-fake',
      name: 'FAKE:10000',
      status: 'connecting',
      failed: 2,
      queued: 7,
      sms: {
        received: 1,
        sent: 5,
        inbound_rate: [0, 0, 0],
        outbound_rate: [2, 1, 0],
      },
      dlr: { received: 0, sent: 0, inbound_rate: [0, 0, 0], outbound_rate: [0, 0, 0] },
    },
  ],
  logging: { queue_depth: 0 },
};

/** Installs a fetch stub and returns a restore function. */
function stubFetch(handler: (url: string) => any) {
  const original = global.fetch;
  global.fetch = (async (url: any) => handler(String(url))) as any;
  return () => {
    global.fetch = original;
  };
}
const jsonResponse = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
});

describe('KamexAdapter.queueSnapshot', () => {
  const env = { ...process.env };
  let restoreFetch = () => {};
  beforeEach(() => {
    process.env.KAMEX_BASE_URL = 'http://kamex-bearerbox:13000';
    process.env.KAMEX_STATUS_PASSWORD = 'status-secret';
  });
  afterEach(() => {
    restoreFetch();
    restoreFetch = () => {};
    process.env = { ...env };
  });

  it('parses a live status payload into engine totals and binds', async () => {
    let requested = '';
    restoreFetch = stubFetch((url) => {
      requested = url;
      return jsonResponse(liveStatus);
    });
    const snapshot = await new KamexAdapter().queueSnapshot();

    expect(requested).toContain('/status.json');
    expect(requested).toContain('password=status-secret');
    expect(snapshot.source.status).toBe('ok');
    expect(snapshot.engine).toEqual({
      status: 'running',
      version: '1.8.3',
      // 3m17s
      uptimeSeconds: 197,
      smsQueuedOut: 4,
      smsQueuedIn: 2,
      dlrQueued: 3,
      // store_size -1 is bearerbox's "unknown" sentinel
      storeSize: null,
    });
    expect(snapshot.binds).toEqual([
      {
        engineId: 'local-fake',
        name: 'FAKE:10000',
        status: 'connecting',
        queued: 7,
        failed: 2,
        sent: 5,
        received: 1,
        outboundRate: [2, 1, 0],
        inboundRate: [0, 0, 0],
      },
    ]);
  });

  it('maps store_size 0 and positive values through unchanged', async () => {
    restoreFetch = stubFetch(() =>
      jsonResponse({ ...liveStatus, sms: { ...liveStatus.sms, store_size: 0 } }),
    );
    expect((await new KamexAdapter().queueSnapshot()).engine.storeSize).toBe(0);
  });

  it('collapses only online/running to online and passes other states through', async () => {
    restoreFetch = stubFetch(() =>
      jsonResponse({
        ...liveStatus,
        smscs: [
          { id: 'a', status: 'online 0d 1h 2m 3s' },
          { id: 'b', status: 'DEAD' },
          { id: 'c', status: 're-connecting' },
          { id: 'd' },
          { id: 'e', status: 42 },
        ],
      }),
    );
    const snapshot = await new KamexAdapter().queueSnapshot();
    expect(snapshot.binds.map((bind) => [bind.engineId, bind.status])).toEqual([
      ['a', 'online'],
      ['b', 'dead'],
      ['c', 're-connecting'],
      ['d', 'unknown'],
      ['e', 'unknown'],
    ]);
  });

  it('defaults missing and garbage fields instead of throwing', async () => {
    restoreFetch = stubFetch(() =>
      jsonResponse({
        smscs: [
          {
            admin_id: 'fallback-bind',
            queued: 'not-a-number',
            sms: 'garbage',
          },
        ],
      }),
    );
    const snapshot = await new KamexAdapter().queueSnapshot();
    expect(snapshot.engine).toEqual({
      status: 'unknown',
      version: null,
      uptimeSeconds: null,
      smsQueuedOut: 0,
      smsQueuedIn: 0,
      dlrQueued: 0,
      storeSize: null,
    });
    expect(snapshot.binds).toEqual([
      {
        // falls back to admin_id, and to the id for a missing name
        engineId: 'fallback-bind',
        name: 'fallback-bind',
        status: 'unknown',
        queued: 0,
        failed: 0,
        sent: 0,
        received: 0,
        outboundRate: [0, 0, 0],
        inboundRate: [0, 0, 0],
      },
    ]);
  });

  it('drops bind entries with no usable identifier', async () => {
    restoreFetch = stubFetch(() =>
      jsonResponse({ smscs: [null, 'nonsense', { name: 'no id' }, { id: 'keeper' }] }),
    );
    const snapshot = await new KamexAdapter().queueSnapshot();
    expect(snapshot.binds.map((bind) => bind.engineId)).toEqual(['keeper']);
  });

  it('reports degraded when the payload carries no smscs array', async () => {
    restoreFetch = stubFetch(() => jsonResponse({ version: '1.8.3', status: 'running' }));
    const snapshot = await new KamexAdapter().queueSnapshot();
    expect(snapshot.source.status).toBe('degraded');
    expect(snapshot.binds).toEqual([]);
    expect(snapshot.engine.version).toBe('1.8.3');
  });

  it('reports unavailable rather than throwing when the engine is unreachable', async () => {
    restoreFetch = stubFetch(() => {
      throw new Error('connect ECONNREFUSED 172.25.0.3:13000');
    });
    const snapshot = await new KamexAdapter().queueSnapshot();
    expect(snapshot.source.status).toBe('unavailable');
    expect(snapshot.source.detail).toContain('ECONNREFUSED');
    expect(snapshot.binds).toEqual([]);
    // Counters are null, never zero: an unreachable engine is not an idle engine.
    expect(snapshot.engine).toEqual({
      status: 'unknown',
      version: null,
      uptimeSeconds: null,
      smsQueuedOut: null,
      smsQueuedIn: null,
      dlrQueued: null,
      storeSize: null,
    });
  });

  it('reports unavailable on a non-2xx status response', async () => {
    restoreFetch = stubFetch(() => jsonResponse('Denied', false, 403));
    const snapshot = await new KamexAdapter().queueSnapshot();
    expect(snapshot.source).toEqual({
      status: 'unavailable',
      detail: 'Kamex status returned HTTP 403',
    });
  });

  it('reports unavailable when the body is not a JSON object', async () => {
    restoreFetch = stubFetch(() => jsonResponse(['unexpected array']));
    expect((await new KamexAdapter().queueSnapshot()).source.status).toBe('unavailable');
  });

  it('reports unavailable when the engine endpoint is not configured', async () => {
    delete process.env.KAMEX_BASE_URL;
    restoreFetch = stubFetch(() => {
      throw new Error('fetch must not be attempted');
    });
    const snapshot = await new KamexAdapter().queueSnapshot();
    expect(snapshot.source.status).toBe('unavailable');
    expect(snapshot.source.detail).toContain('not configured');
  });

  it('leaves the raw coreDiagnostics contract untouched', async () => {
    restoreFetch = stubFetch(() => jsonResponse(liveStatus));
    const diagnostics = await new KamexAdapter().coreDiagnostics();
    expect(JSON.parse(diagnostics.messages[0]).version).toBe('1.8.3');
  });
});
