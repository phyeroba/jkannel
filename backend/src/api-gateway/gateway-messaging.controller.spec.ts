import { BadRequestException, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY, PermissionsGuard } from '../security/permissions.guard';
import { GatewayMessagingController } from './gateway-messaging.controller';
import { GATEWAY_SCOPES } from './gateway-scopes';

function gatewayRequest(scopes: string[], customerId: string | null = 'cust-1') {
  const client = {
    apiKeyId: 'key-1',
    keyPrefix: 'abcd1234',
    tenantId: '7',
    userId: 'user-1',
    scopes,
    allowedIps: [],
    rateLimit: null,
    customerId,
  };
  return {
    headers: {},
    method: 'POST',
    url: '/gateway/messages',
    gatewayClient: client,
    // Exactly what ApiKeyAuthGuard publishes: the key's scopes ARE the
    // principal's permissions, which is the bridge PermissionsGuard enforces.
    principal: {
      tenantId: client.tenantId,
      userId: client.userId,
      sessionId: `apikey:${client.apiKeyId}`,
      username: `apikey:${client.keyPrefix}`,
      roles: [],
      permissions: scopes,
    },
  };
}

/** Minimal ExecutionContext for the real PermissionsGuard. */
function contextFor(request: unknown, handlerName: string) {
  const handler = (GatewayMessagingController.prototype as never as Record<string, unknown>)[
    handlerName
  ];
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => GatewayMessagingController,
  } as unknown as ExecutionContext;
}

function makeController(overrides: { send?: jest.Mock; rows?: any[] } = {}) {
  const send = overrides.send ?? jest.fn(async () => ({ sqlId: '900', smscId: 'local-fake' }));
  const sqlbox: any = {
    probe: jest.fn(async () => ({ available: true, evidence: 'ok' })),
    list: jest.fn(async () => ({ items: [], nextCursor: null })),
  };
  const client = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('smsc_definitions')) return { rows: [{ engine_id: 'local-fake' }] };
      return { rows: overrides.rows ?? [] };
    }),
  };
  const database: any = { tenantTransaction: (_t: string, work: any) => work(client) };
  return {
    controller: new GatewayMessagingController({ send } as never, sqlbox, database),
    send,
    sqlbox,
    client,
  };
}

describe('GatewayMessagingController — scope enforcement', () => {
  const guard = new PermissionsGuard(new Reflector());

  it('declares the sms.send scope on the submit handler', () => {
    const required = Reflect.getMetadata(
      PERMISSIONS_KEY,
      GatewayMessagingController.prototype.submit,
    );
    expect(required).toEqual([GATEWAY_SCOPES.smsSend]);
  });

  it('lets a key WITH sms.send through the permissions guard', () => {
    expect(guard.canActivate(contextFor(gatewayRequest(['sms.send']), 'submit'))).toBe(true);
  });

  it('403s a key WITHOUT sms.send — read-only keys cannot submit', () => {
    expect(() => guard.canActivate(contextFor(gatewayRequest(['sms.read']), 'submit'))).toThrow(
      ForbiddenException,
    );
  });

  it('403s a key with no scopes at all', () => {
    expect(() => guard.canActivate(contextFor(gatewayRequest([]), 'submit'))).toThrow(
      ForbiddenException,
    );
  });

  it('gates the read endpoints on their own scopes', () => {
    expect(guard.canActivate(contextFor(gatewayRequest(['sms.read']), 'messages'))).toBe(true);
    expect(() => guard.canActivate(contextFor(gatewayRequest(['sms.send']), 'messages'))).toThrow(
      ForbiddenException,
    );
    expect(guard.canActivate(contextFor(gatewayRequest(['routing.read']), 'decisions'))).toBe(true);
    expect(() => guard.canActivate(contextFor(gatewayRequest(['sms.read']), 'decisions'))).toThrow(
      ForbiddenException,
    );
  });
});

describe('GatewayMessagingController — submit', () => {
  it('submits through the send path with the KEY’s customer identity', async () => {
    const { controller, send } = makeController();
    const request = gatewayRequest(['sms.send'], 'cust-1');
    const result = await controller.submit(request as never, {
      sender: 'JKANNEL',
      receiver: '+256700000000',
      text: 'hello',
    });

    expect(result).toMatchObject({ sqlId: '900' });
    expect(send).toHaveBeenCalledWith(
      { tenantId: '7', userId: 'user-1' },
      expect.objectContaining({
        sender: 'JKANNEL',
        receiver: '+256700000000',
        text: 'hello',
        smscId: null,
        customerId: 'cust-1',
        channel: 'api',
      }),
    );
  });

  it('never lets a caller submit as another customer', async () => {
    const { controller, send } = makeController();
    const request = gatewayRequest(['sms.send'], 'cust-1');
    await controller.submit(request as never, {
      sender: 'JKANNEL',
      receiver: '+256700000000',
      text: 'hello',
      // A body-supplied customerId must be ignored entirely.
      customerId: 'cust-victim',
    });
    expect(send.mock.calls[0][1].customerId).toBe('cust-1');
  });

  it('passes an explicit smscId through when the caller pins one', async () => {
    const { controller, send } = makeController();
    await controller.submit(gatewayRequest(['sms.send']) as never, {
      sender: 'JKANNEL',
      receiver: '+256700000000',
      text: 'hello',
      smscId: 'local-fake',
    });
    expect(send.mock.calls[0][1].smscId).toBe('local-fake');
  });

  it('validates the request body', async () => {
    const { controller } = makeController();
    const request = gatewayRequest(['sms.send']) as never;
    await expect(
      controller.submit(request, { receiver: '+256700000000', text: 'x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.submit(request, { sender: 'A', text: 'x' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      controller.submit(request, { sender: 'A', receiver: '+256700000000' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.submit(request, {
        sender: 'A',
        receiver: '+256700000000',
        text: 'x'.repeat(1531),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('scopes message reads to the key’s own tenant SMSCs', async () => {
    const { controller, sqlbox } = makeController();
    await controller.messages(gatewayRequest(['sms.read']) as never, { limit: '10' });
    expect(sqlbox.list).toHaveBeenCalledWith(
      expect.objectContaining({ allowedSmscIds: ['local-fake'], limit: 10 }),
    );
  });

  it('states unavailable SQLBox explicitly rather than erroring', async () => {
    const { controller, sqlbox } = makeController();
    sqlbox.probe.mockResolvedValueOnce({ available: false, evidence: 'not configured' });
    const result = await controller.messages(gatewayRequest(['sms.read']) as never);
    expect(result).toMatchObject({
      items: [],
      source: expect.objectContaining({ code: 'SQLBOX_NOT_AVAILABLE' }),
    });
  });

  it('scopes routing-decision reads to the key’s own customer', async () => {
    const { controller } = makeController({ rows: [] });
    const result = await controller.decisions(gatewayRequest(['routing.read']) as never, {});
    expect(result).toMatchObject({ items: [], total: 0, limit: 50, offset: 0 });
  });

  /**
   * The content-rule columns were written by the send path and indexed, but no
   * read selected them — so the rule that blocked a message could only be
   * recovered by parsing the prose `reason`. String-scraping a human sentence is
   * exactly what this table exists to eliminate, which makes a write-only
   * column a silent gap rather than a missing nicety.
   */
  it('returns the content rule that blocked a message, and can filter by it', async () => {
    const { controller, client } = makeController({ rows: [] });
    await controller.decisions(gatewayRequest(['routing.read']) as never, {
      contentRuleId: '11111111-1111-4111-8111-111111111111',
    });
    const sql = client.query.mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).toContain('content_rule_id');
    expect(sql).toContain('content_rule_name');
    expect(sql).toMatch(/content_rule_id = \$5::uuid/);
  });

  it('rejects a malformed contentRuleId rather than silently returning everything', async () => {
    const { controller } = makeController({ rows: [] });
    await expect(
      controller.decisions(gatewayRequest(['routing.read']) as never, {
        contentRuleId: 'not-a-uuid',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
