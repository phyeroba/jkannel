import { ReadModelsController } from '../console/console.controllers';
import { MoController } from '../messaging-depth/mo.controller';

/**
 * The point of Phase 6.1 is not that a masking function exists — it is that
 * every path which returns subscriber data USES it, and uses it by default.
 * A module nobody calls protects nobody, so these tests drive the real
 * controllers and read what actually comes back.
 */

const request: any = {
  principal: {
    tenantId: '1',
    userId: 'u-1',
    username: 'ops',
    permissions: ['messages.view', 'messages.export', 'messages.reveal'],
  },
};

const ROW = {
  id: 91,
  smscId: 'kololo',
  sender: 'JKANNEL',
  receiver: '+256772000118',
  text: 'Your OTP is 448120',
  deliveryStatus: 'delivered',
};

function sqlboxStub(overrides: Record<string, any> = {}) {
  return {
    probe: jest.fn().mockResolvedValue({ available: true }),
    list: jest.fn().mockResolvedValue({ items: [{ ...ROW }], nextCursor: null }),
    listQueue: jest.fn().mockResolvedValue({ items: [{ ...ROW }], nextCursor: null }),
    queueSummary: jest.fn().mockResolvedValue({ queued: 1 }),
    exportCsv: jest.fn(),
    ...overrides,
  };
}

const repository: any = { listTenantSmscEngineIds: jest.fn().mockResolvedValue(['kololo']) };

/** A reveal service that behaves as if no grant has been requested. */
const noGrant = () => ({
  resolve: jest.fn().mockResolvedValue({ permitted: false, grant: null, refusal: 'no window' }),
  recordUse: jest.fn(),
});

/** A reveal service that behaves as if a live grant is in force. */
const withGrant = () => ({
  resolve: jest.fn().mockResolvedValue({ permitted: true, grant: { id: 'g-1' }, refusal: null }),
  recordUse: jest.fn().mockResolvedValue(undefined),
});

describe('GET /messages', () => {
  it('masks the subscriber number and the body when no reveal was asked for', async () => {
    const sqlbox = sqlboxStub();
    const privacy = noGrant();
    const controller = new ReadModelsController(
      sqlbox as any,
      undefined,
      repository,
      undefined,
      undefined,
      undefined,
      privacy as any,
    );

    const page: any = await controller.messages(request, {});

    expect(page.items[0].receiver).toBe('+2567••••••18');
    expect(page.items[0].text).toBe('[18 characters hidden]');
    // The OTP is the thing that must not survive.
    expect(JSON.stringify(page.items)).not.toContain('448120');
    expect(page.privacy.masked).toBe(true);
    expect(page.privacy.notice).toContain('masked by default');
  });

  it('returns the real values under a live grant, and records the use', async () => {
    const privacy = withGrant();
    const controller = new ReadModelsController(
      sqlboxStub() as any,
      undefined,
      repository,
      undefined,
      undefined,
      undefined,
      privacy as any,
    );

    const page: any = await controller.messages(request, { reveal: 'true' });

    expect(page.items[0].receiver).toBe('+256772000118');
    expect(page.privacy.masked).toBe(false);
    expect(page.privacy.revealedUnder).toBe('g-1');
    // Audited with the number of rows actually disclosed, not merely "once".
    expect(privacy.recordUse).toHaveBeenCalledWith(
      { tenantId: '1', userId: 'u-1' },
      'g-1',
      1,
      'messages',
    );
  });

  it('masks when no reveal service is wired at all', async () => {
    // Failing closed matters more than failing loudly: a privacy control whose
    // dependency is missing must not degrade into disclosure.
    const controller = new ReadModelsController(sqlboxStub() as any, undefined, repository);
    const page: any = await controller.messages(request, { reveal: 'true' });
    expect(page.items[0].receiver).toBe('+2567••••••18');
    expect(page.privacy.masked).toBe(true);
  });
});

describe('GET /queues', () => {
  it('masks the spooled rows too', async () => {
    const controller = new ReadModelsController(
      sqlboxStub() as any,
      undefined,
      repository,
      undefined,
      undefined,
      undefined,
      noGrant() as any,
    );
    const page: any = await controller.queues(request, {});
    expect(page.items[0].receiver).toBe('+2567••••••18');
    expect(page.privacy.masked).toBe(true);
    // The queue's own numbers are not PII and must survive masking.
    expect(page.summary).toEqual({ queued: 1 });
  });
});

describe('GET /messages/export.csv', () => {
  function response() {
    const headers: Record<string, string> = {};
    return {
      headers,
      setHeader: (k: string, v: string) => {
        headers[k] = v;
      },
      send: jest.fn(),
    };
  }

  it('asks the repository for a masked export by default', async () => {
    const exportCsv = jest
      .fn()
      .mockResolvedValue({ filename: 'x.csv', rowCount: 1, masked: true, content: 'a', nextCursor: null });
    const controller = new ReadModelsController(
      sqlboxStub({ exportCsv }) as any,
      undefined,
      repository,
      undefined,
      undefined,
      undefined,
      noGrant() as any,
    );
    const res = response();
    await controller.exportMessages(request, {}, res);
    expect(exportCsv.mock.calls[0][0].reveal).toBe(false);
    expect(res.headers['x-jkannel-masked']).toBe('true');
  });

  it('audits the export with the row count, once the count is known', async () => {
    const exportCsv = jest.fn().mockResolvedValue({
      filename: 'x.csv',
      rowCount: 4000,
      masked: false,
      content: 'a',
      nextCursor: null,
    });
    const privacy = withGrant();
    const controller = new ReadModelsController(
      sqlboxStub({ exportCsv }) as any,
      undefined,
      repository,
      undefined,
      undefined,
      undefined,
      privacy as any,
    );
    await controller.exportMessages(request, { reveal: 'true' }, response());

    expect(exportCsv.mock.calls[0][0].reveal).toBe(true);
    // Exactly one audit entry, carrying the real size of the disclosure.
    expect(privacy.recordUse).toHaveBeenCalledTimes(1);
    expect(privacy.recordUse).toHaveBeenCalledWith(
      { tenantId: '1', userId: 'u-1' },
      'g-1',
      4000,
      'messages.export',
    );
  });
});

describe('GET /mo/messages', () => {
  const inbound: any = {
    listMessages: jest.fn().mockResolvedValue({
      items: [{ id: 'm-1', sender: '+256772000118', sender_digits: '256772000118', body: 'STOP' }],
      nextCursor: null,
    }),
    getMessage: jest.fn().mockResolvedValue({
      id: 'm-1',
      sender: '+256772000118',
      sender_digits: '256772000118',
      body: 'STOP',
      deliveries: [],
    }),
  };

  it('masks inbound senders and what the subscriber typed', async () => {
    const controller = new MoController({} as any, inbound, noGrant() as any);
    const page: any = await controller.listMessages(request, {});
    expect(page.items[0].sender).toBe('+2567••••••18');
    // The normalised digit copy is masked too, or the mask is cosmetic.
    expect(page.items[0].sender_digits).toBe('2567••••••18');
    expect(page.items[0].body).toBe('[4 characters hidden]');
    expect(page.privacy.masked).toBe(true);
  });

  it('scopes a single-message reveal to that message id', async () => {
    const privacy = withGrant();
    const controller = new MoController({} as any, inbound, privacy as any);
    await controller.getMessage(request, '3f2504e0-4f89-11d3-9a0c-0305e82c3301', {
      reveal: 'true',
    });
    expect(privacy.resolve).toHaveBeenCalledWith(
      { tenantId: '1', userId: 'u-1' },
      expect.any(Set),
      true,
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    );
  });
});
