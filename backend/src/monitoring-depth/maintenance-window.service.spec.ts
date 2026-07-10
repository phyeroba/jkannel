import { MaintenanceWindowService, MaintenanceWindow } from './maintenance-window.service';

const service = new MaintenanceWindowService();

function window(partial: Partial<MaintenanceWindow>): MaintenanceWindow {
  return {
    id: 'w1',
    name: 'test',
    starts_at: '2026-07-10T00:00:00Z',
    ends_at: '2026-07-10T06:00:00Z',
    scope: {},
    ...partial,
  };
}

describe('MaintenanceWindowService', () => {
  const inside = new Date('2026-07-10T03:00:00Z');
  const outside = new Date('2026-07-10T09:00:00Z');

  it('treats a window as active only within [starts_at, ends_at)', () => {
    const w = window({});
    expect(service.isActive(w, inside)).toBe(true);
    expect(service.isActive(w, outside)).toBe(false);
    // Exclusive upper bound.
    expect(service.isActive(w, new Date('2026-07-10T06:00:00Z'))).toBe(false);
  });

  it('all-scope suppresses any target while active', () => {
    const windows = [window({ scope: { all: true } })];
    expect(service.isSuppressed(inside, { smsc: 'carrier-a' }, windows)).toBe(true);
    expect(service.isSuppressed(inside, { route: 'r1' }, windows)).toBe(true);
    // But not once the window has ended.
    expect(service.isSuppressed(outside, { smsc: 'carrier-a' }, windows)).toBe(false);
  });

  it('scoped window suppresses only listed smscs/routes', () => {
    const windows = [window({ scope: { smscs: ['carrier-a'], routes: ['r1'] } })];
    expect(service.isSuppressed(inside, { smsc: 'carrier-a' }, windows)).toBe(true);
    expect(service.isSuppressed(inside, { smsc: 'carrier-b' }, windows)).toBe(false);
    expect(service.isSuppressed(inside, { route: 'r1' }, windows)).toBe(true);
    expect(service.isSuppressed(inside, { route: 'r2' }, windows)).toBe(false);
  });

  it('is not suppressed with an empty scope', () => {
    expect(service.isSuppressed(inside, { smsc: 'carrier-a' }, [window({ scope: {} })])).toBe(
      false,
    );
  });
});
