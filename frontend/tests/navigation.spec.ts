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
        '/configuration',
        '/monitoring',
        '/alerts',
        '/notifications',
        '/reports',
        '/customers',
        '/api-gateway',
        '/api-reference',
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
    expect(navigation).toHaveLength(36);
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
    expect(traffic).toEqual(['/live-traffic', '/queues', '/dlr-performance', '/live-queue']);
    // The funnel is served by the reporting controller, which requires
    // reports.view — not messages.view like the rest of the group.
    expect(navigation.find((item) => item.to === '/dlr-performance')?.permission).toBe(
      'reports.view',
    );
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

    expect(userGuides).toHaveLength(11);
    expect(userGuides.map((guide) => guide.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    for (const guide of userGuides) {
      expect(guide.url.startsWith(`${documentationRoot}/blob/main/docs/user-guides/`)).toBe(true);
      expect(guide.url).toMatch(/\/\d{2}-[a-z0-9-]+\.md$/);
      // Every deep-link names a real console route.
      if (guide.route) expect(navigation.some((item) => item.to === guide.route)).toBe(true);
    }
    expect(documentationUrl).toBe(`${documentationRoot}/tree/main/docs/user-guides`);
  });
});
