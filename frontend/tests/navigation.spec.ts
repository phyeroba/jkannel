import { describe, expect, it } from 'vitest';
import { documentationUrl, navigation, userGuides } from '../src/navigation';

const documentationRoot = 'https://github.com/phyeroba/jkannel';

describe('primary navigation contract', () => {
  it('covers every operations workspace with unique routes and permissions', () => {
    expect(navigation.map((item) => item.to)).toEqual(
      expect.arrayContaining([
        '/dashboard/operations',
        '/messages',
        '/live-queue',
        '/live-traffic',
        '/queues',
        '/dlr-performance',
        '/delivery-reports',
        '/bulk-send',
        '/smsc',
        '/carriers',
        '/sessions-smpp',
        '/routing',
        '/failover',
        '/route-simulator',
        '/configuration',
        '/test-tools',
        '/message-trace',
        '/smpp-errors',
        '/events',
        '/monitoring',
        '/alerts',
        '/notifications',
        '/reports',
        '/customers',
        '/api-gateway',
        '/api-reference',
        '/services',
        '/nodes',
        '/docker',
        '/logs-audit',
        '/plugins',
        '/backup',
        '/users',
        '/system',
        '/copilot',
        '/sessions',
        '/alert-response',
        '/alert-lifecycle',
        '/log-explorer',
        '/routing-advanced',
        '/content-rules',
        '/mo-routing',
        '/roles',
        '/help',
      ]),
    );
    // 48: Messaging gained Recipient Policy and Scheduled Sends, Traffic
    // gained Delivery Retries, System gained Performance — 44 before those
    // four. The count is asserted so a route cannot appear in the sidebar
    // without someone deciding it should.
    expect(navigation).toHaveLength(48);
    expect(new Set(navigation.map((item) => item.to)).size).toBe(navigation.length);
    expect(
      navigation.every(
        (item) => item.permission === undefined || /\.(view|sessions)$/.test(item.permission),
      ),
    ).toBe(true);
  });

  it('keeps SMPP Sessions distinct from operator login sessions', () => {
    // Two different things called "Sessions" in one sidebar is a trap: one is
    // SMPP binds, the other is who is signed in.
    const smpp = navigation.find((item) => item.to === '/sessions-smpp');
    const logins = navigation.find((item) => item.to === '/sessions');
    expect(smpp?.label).toBe('SMPP Sessions');
    expect(smpp?.group).toBe('Connectivity');
    expect(smpp?.permission).toBe('smsc.view');
    expect(logins?.label).toBe('Sessions');
    expect(logins?.group).toBe('Platform');
  });

  it('orders Connectivity as Carrier -> SMSC -> Session', () => {
    const connectivity = navigation
      .filter((item) => item.group === 'Connectivity')
      .map((item) => item.to);
    expect(connectivity).toEqual(['/carriers', '/smsc', '/sessions-smpp']);
  });

  it('orders Traffic as the specification does, and gates DLR on the permission its API checks', () => {
    const traffic = navigation.filter((item) => item.group === 'Traffic').map((item) => item.to);
    // §2's three observational screens first; Live Queue is JKANNEL's own
    // recovery workflow and sits after them.
    // Delivery Retries sits last: it answers what was DONE about the failures
    // the three observational screens and Live Queue surface.
    expect(traffic).toEqual([
      '/live-traffic',
      '/queues',
      '/dlr-performance',
      '/live-queue',
      '/delivery-retries',
    ]);
    // The funnel is served by the reporting controller, which requires
    // reports.view — not messages.view like the rest of the group.
    expect(navigation.find((item) => item.to === '/dlr-performance')?.permission).toBe(
      'reports.view',
    );
  });

  it('orders Diagnostics as the specification does, and gates each screen on the permission its API checks', () => {
    const diagnostics = navigation
      .filter((item) => item.group === 'Diagnostics')
      .map((item) => item.to);
    // §2: one message, the protocol vocabulary, the system-wide stream, the raw
    // log buffer, the tools that answer a question on demand, then the
    // configuration those answers are read against.
    expect(diagnostics).toEqual([
      '/message-trace',
      '/smpp-errors',
      '/events',
      '/log-explorer',
      '/test-tools',
      '/configuration',
    ]);
    const permission = (to: string) => navigation.find((item) => item.to === to)?.permission;
    // Each one names the permission its own controller enforces; a mismatch
    // here is a link in the sidebar that 403s the moment it is clicked.
    expect(permission('/message-trace')).toBe('messages.view');
    expect(permission('/smpp-errors')).toBe('smsc.view');
    expect(permission('/events')).toBe('monitoring.view');
  });

  it('orders Routing as the specification does, and keeps failover readable without change rights', () => {
    const routing = navigation.filter((item) => item.group === 'Routing').map((item) => item.to);
    // §2, §9, §13: the rules, the depth behind them, the override that suspends
    // them, and the non-transmitting tool that explains a decision.
    expect(routing).toEqual(['/routing', '/routing-advanced', '/failover', '/route-simulator']);
    // Reading which routes are on a manual override must not require the
    // permission to change one — that is the operator most likely to be caught
    // out by an override nobody remembered.
    expect(navigation.find((item) => item.to === '/failover')?.permission).toBe('routes.view');
    expect(navigation.find((item) => item.to === '/route-simulator')?.permission).toBe(
      'routes.view',
    );
    // The number/prefix lookup is the endpoint that decides Test Tools' gate.
    expect(navigation.find((item) => item.to === '/test-tools')?.permission).toBe('routes.view');
  });

  it('puts Services above Runtime Containers in System', () => {
    const system = navigation.filter((item) => item.group === 'System').map((item) => item.to);
    // §14. Services answers "which component is broken and why", which is the
    // question an operator arrives with; Runtime Containers answers "what is
    // declared in Compose", which is a deployment question.
    expect(system.indexOf('/services')).toBeLessThan(system.indexOf('/docker'));
    expect(system).toContain('/nodes');
    expect(navigation.find((item) => item.to === '/services')?.permission).toBe('system.view');
    expect(navigation.find((item) => item.to === '/nodes')?.permission).toBe('system.view');
  });

  it('keeps the API reference reachable for every authenticated user', () => {
    const reference = navigation.find((item) => item.to === '/api-reference');
    expect(reference).toBeDefined();
    expect(reference?.group).toBe('Platform');
    // Documentation, and the OpenAPI document itself is served unauthenticated.
    expect(reference?.permission).toBeUndefined();
  });

  it('keeps notifications reachable for every authenticated user', () => {
    const notifications = navigation.find((item) => item.to === '/notifications');
    expect(notifications).toBeDefined();
    expect(notifications?.permission).toBeUndefined();
  });

  it('offers documentation to every role and links guides that exist in the repository', () => {
    const help = navigation.find((item) => item.to === '/help');
    expect(help).toBeDefined();
    expect(help?.group).toBe('Platform');
    // Help is for whoever is lost, whatever their role.
    expect(help?.permission).toBeUndefined();

    expect(userGuides).toHaveLength(14);
    expect(userGuides.map((guide) => guide.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);
    for (const guide of userGuides) {
      expect(guide.url.startsWith(`${documentationRoot}/blob/main/docs/user-guides/`)).toBe(true);
      expect(guide.url).toMatch(/\/\d{2}-[a-z0-9-]+\.md$/);
      // Every deep-link names a real console route.
      if (guide.route) expect(navigation.some((item) => item.to === guide.route)).toBe(true);
    }
    expect(documentationUrl).toBe(`${documentationRoot}/tree/main/docs/user-guides`);
  });
});
