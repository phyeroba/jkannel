import { NotificationReadinessService } from './notification-readiness.service';

function serviceWith(handlers: (sql: string, params: unknown[]) => any) {
  const recorded: Array<{ sql: string; params: unknown[] }> = [];
  const client: any = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      recorded.push({ sql, params });
      return handlers(sql, params) ?? { rows: [], rowCount: 0 };
    }),
  };
  const database: any = {
    query: jest.fn(async (sql: string) => handlers(sql, []) ?? { rows: [] }),
    tenantTransaction: jest.fn((_tenant: string, work: any) => work(client)),
  };
  return { service: new NotificationReadinessService(database), recorded, database };
}

describe('NotificationReadinessService.describeChannel', () => {
  const service = new NotificationReadinessService({} as any);

  it('treats a dashboard channel as always deliverable', () => {
    expect(
      service.describeChannel({
        id: 'c1',
        name: 'Default dashboard',
        type: 'dashboard',
        enabled: true,
      }),
    ).toEqual(expect.objectContaining({ deliverable: true }));
  });

  it('does not call an email channel deliverable without SMTP', () => {
    delete process.env.SMTP_URL;
    const described = service.describeChannel({
      id: 'c2',
      name: 'Ops email',
      type: 'email',
      enabled: true,
      config: { to: 'ops@example.com' },
    });
    expect(described.deliverable).toBe(false);
    expect(described.reason).toContain('SMTP_URL');
  });

  it('accepts an email channel once SMTP and a recipient exist', () => {
    process.env.SMTP_URL = 'smtp://localhost:1025';
    try {
      expect(
        service.describeChannel({
          id: 'c2',
          name: 'Ops email',
          type: 'email',
          enabled: true,
          config: { to: 'ops@example.com' },
        }).deliverable,
      ).toBe(true);
    } finally {
      delete process.env.SMTP_URL;
    }
  });

  it('rejects a webhook without an http(s) url and an sms without an msisdn', () => {
    expect(
      service.describeChannel({
        id: 'c3',
        name: 'Hook',
        type: 'webhook',
        enabled: true,
        config: {},
      }).reason,
    ).toContain('config.url');
    expect(
      service.describeChannel({ id: 'c4', name: 'Pager', type: 'sms', enabled: true, config: {} })
        .reason,
    ).toContain('config.msisdn');
  });

  it('reports a disabled channel as undeliverable regardless of type', () => {
    expect(
      service.describeChannel({ id: 'c5', name: 'Dash', type: 'dashboard', enabled: false })
        .deliverable,
    ).toBe(false);
  });
});

describe('NotificationReadinessService.warningFor', () => {
  const service = new NotificationReadinessService({} as any);

  it('warns loudly when open alerts exist and nothing can deliver', () => {
    const warning = service.warningFor({
      deliverableChannels: 0,
      openAlerts: 3,
      undeliverableAlerts: 0,
      escalationPolicies: 1,
    });
    expect(warning).toContain('3 open alert(s)');
    expect(warning).toContain('nobody is being told');
  });

  it('still warns when nothing can deliver even with no alerts yet', () => {
    expect(
      service.warningFor({
        deliverableChannels: 0,
        openAlerts: 0,
        undeliverableAlerts: 0,
        escalationPolicies: 1,
      }),
    ).toContain('would reach nobody');
  });

  it('warns when there is no enabled escalation policy', () => {
    expect(
      service.warningFor({
        deliverableChannels: 1,
        openAlerts: 0,
        undeliverableAlerts: 0,
        escalationPolicies: 0,
      }),
    ).toContain('No enabled escalation policy');
  });

  it('warns when deliveries were attempted and failed', () => {
    expect(
      service.warningFor({
        deliverableChannels: 1,
        openAlerts: 2,
        undeliverableAlerts: 2,
        escalationPolicies: 1,
      }),
    ).toContain('could not be delivered');
  });

  it('is silent when a deliverable channel and a policy exist', () => {
    expect(
      service.warningFor({
        deliverableChannels: 1,
        openAlerts: 5,
        undeliverableAlerts: 0,
        escalationPolicies: 1,
      }),
    ).toBeNull();
  });
});

describe('NotificationReadinessService.ensureTenantDefaults', () => {
  it('seeds a dashboard channel and an escalation policy only when missing', async () => {
    const { service, recorded } = serviceWith(() => ({ rows: [], rowCount: 1 }));
    const seeded = await service.ensureTenantDefaults('1');
    expect(seeded).toEqual({ channel: true, policy: true });
    const channelInsert = recorded.find((entry) => entry.sql.includes('notification_channels'))!;
    // The guard is what makes the boot-time repair idempotent.
    expect(channelInsert.sql).toContain('WHERE NOT EXISTS');
    expect(channelInsert.params).toContain('Default dashboard');
    const policyInsert = recorded.find((entry) => entry.sql.includes('escalation_policies'))!;
    expect(String(policyInsert.params[2])).toContain('"channelType":"dashboard"');
  });

  it('reports nothing seeded when the tenant already has both', async () => {
    const { service } = serviceWith(() => ({ rows: [], rowCount: 0 }));
    expect(await service.ensureTenantDefaults('1')).toEqual({ channel: false, policy: false });
  });
});

describe('NotificationReadinessService.readinessForTenant', () => {
  it('counts deliverable channels and open/undeliverable alerts', async () => {
    const { service } = serviceWith((sql) => {
      if (sql.includes('FROM notification_channels'))
        return {
          rows: [
            { id: 'c1', name: 'Default dashboard', type: 'dashboard', enabled: true, config: {} },
            { id: 'c2', name: 'Ops email', type: 'email', enabled: true, config: {} },
          ],
        };
      if (sql.includes('FROM alert_instances'))
        return { rows: [{ open_alerts: '4', undeliverable: '1', unnotified: '2' }] };
      if (sql.includes('FROM escalation_policies')) return { rows: [{ count: '1' }] };
      return { rows: [] };
    });
    const readiness = await service.readinessForTenant('1');
    expect(readiness.deliverableChannels).toBe(1);
    expect(readiness.openAlerts).toBe(4);
    expect(readiness.undeliverableAlerts).toBe(1);
    expect(readiness.unnotifiedAlerts).toBe(2);
    expect(readiness.warning).toContain('could not be delivered');
    expect(readiness.channels.find((c) => c.type === 'email')?.deliverable).toBe(false);
  });

  it('fires the "nobody is being told" warning at startup for a mute tenant', async () => {
    const { service } = serviceWith((sql) => {
      if (sql.includes('FROM tenants')) return { rows: [{ id: '1' }] };
      if (sql.includes('FROM notification_channels')) return { rows: [] };
      if (sql.includes('FROM alert_instances'))
        return { rows: [{ open_alerts: '2', undeliverable: '0', unnotified: '2' }] };
      if (sql.includes('FROM escalation_policies')) return { rows: [{ count: '1' }] };
      return { rows: [], rowCount: 0 };
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const results = await service.runStartupCheck();
      expect(results).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(warn.mock.calls[0][0] as string);
      expect(logged.level).toBe('warn');
      expect(logged.tenantId).toBe('1');
      expect(logged.message).toContain('nobody is being told');
    } finally {
      warn.mockRestore();
    }
  });

  it('says nothing at startup when the tenant can notify someone', async () => {
    const { service } = serviceWith((sql) => {
      if (sql.includes('FROM tenants')) return { rows: [{ id: '1' }] };
      if (sql.includes('FROM notification_channels'))
        return {
          rows: [
            { id: 'c1', name: 'Default dashboard', type: 'dashboard', enabled: true, config: {} },
          ],
        };
      if (sql.includes('FROM alert_instances'))
        return { rows: [{ open_alerts: '1', undeliverable: '0', unnotified: '0' }] };
      if (sql.includes('FROM escalation_policies')) return { rows: [{ count: '1' }] };
      return { rows: [], rowCount: 0 };
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await service.runStartupCheck();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
