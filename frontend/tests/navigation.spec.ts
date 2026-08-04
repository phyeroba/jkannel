import { describe, expect, it } from 'vitest';
import { navigation } from '../src/navigation';

describe('primary navigation contract', () => {
  it('covers every operations workspace with unique routes and permissions', () => {
    expect(navigation.map((item) => item.to)).toEqual(
      expect.arrayContaining([
        '/dashboard/operations',
        '/messages',
        '/live-queue',
        '/queues',
        '/delivery-reports',
        '/bulk-send',
        '/smsc',
        '/routing',
        '/configuration',
        '/monitoring',
        '/alerts',
        '/notifications',
        '/reports',
        '/customers',
        '/api-gateway',
        '/docker',
        '/logs-audit',
        '/plugins',
        '/backup',
        '/users',
        '/system',
        '/copilot',
        '/sessions',
        '/alert-response',
        '/routing-advanced',
        '/roles',
      ]),
    );
    expect(navigation).toHaveLength(26);
    expect(new Set(navigation.map((item) => item.to)).size).toBe(navigation.length);
    expect(
      navigation.every(
        (item) => item.permission === undefined || /\.(view|sessions)$/.test(item.permission),
      ),
    ).toBe(true);
  });

  it('keeps notifications reachable for every authenticated user', () => {
    const notifications = navigation.find((item) => item.to === '/notifications');
    expect(notifications).toBeDefined();
    expect(notifications?.permission).toBeUndefined();
  });
});
