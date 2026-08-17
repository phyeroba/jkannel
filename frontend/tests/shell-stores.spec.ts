import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearBreadcrumbTrail,
  resolveBreadcrumbs,
  setBreadcrumbTrail,
} from '../src/stores/breadcrumbs';
import {
  RANGE_PRESETS,
  rangeDays,
  resolveWindow,
  selectedRange,
  setRangePreset,
} from '../src/stores/time-range';

const routeAt = (path: string, breadcrumb?: unknown[]) =>
  ({ path, meta: breadcrumb ? { breadcrumb } : {} }) as never;

describe('breadcrumb trail', () => {
  beforeEach(() => clearBreadcrumbTrail());

  it('falls back to the route’s static crumbs, unlinked', () => {
    const crumbs = resolveBreadcrumbs(routeAt('/smsc', ['Messaging', 'SMSC Connections']));
    expect(crumbs.map((c) => c.label)).toEqual(['Messaging', 'SMSC Connections']);
    // Inventing hrefs for static crumbs would produce links to routes that may
    // not exist.
    expect(crumbs.every((c) => c.to === undefined)).toBe(true);
  });

  it('renders a published hierarchy with navigable ancestors', () => {
    setBreadcrumbTrail('/carriers/mtn-ug/smsc/mtn-p1', [
      { label: 'Carriers', to: '/carriers' },
      { label: 'MTN Uganda', to: '/carriers/mtn-ug' },
      { label: 'MTN-P1' },
    ]);
    const crumbs = resolveBreadcrumbs(routeAt('/carriers/mtn-ug/smsc/mtn-p1'));
    expect(crumbs.map((c) => c.label)).toEqual(['Carriers', 'MTN Uganda', 'MTN-P1']);
    expect(crumbs[1].to).toBe('/carriers/mtn-ug');
    // The page you are on is not a link to itself.
    expect(crumbs[2].to).toBeUndefined();
  });

  /**
   * A stale trail is worse than none: `MTN Uganda / MTN-P1` sitting above an
   * unrelated screen is a wrong answer to "where am I", not a missing one.
   */
  it('ignores a trail published for a different route', () => {
    setBreadcrumbTrail('/carriers/mtn-ug', [{ label: 'Carriers' }, { label: 'MTN Uganda' }]);
    const crumbs = resolveBreadcrumbs(routeAt('/queues', ['Queues']));
    expect(crumbs.map((c) => c.label)).toEqual(['Queues']);
  });

  it('returns nothing when the route declares no crumbs', () => {
    expect(resolveBreadcrumbs(routeAt('/help'))).toEqual([]);
  });
});

describe('shared time range', () => {
  beforeEach(() => {
    sessionStorage.clear();
    setRangePreset('24h');
  });

  it('defaults to a window that contains a shift but is still about now', () => {
    expect(selectedRange.value.id).toBe('24h');
  });

  it('is shared, so a range picked on one screen holds on the next', () => {
    // §6: "Preserve selected time range when navigating between Traffic, SMSC
    // and Diagnostics." Two panels describing different hours is how an
    // incident gets misread.
    setRangePreset('15m');
    expect(selectedRange.value.minutes).toBe(15);
    expect(rangeDays.value).toBe(1);
  });

  it('ignores an unknown preset rather than falling back to a silent default', () => {
    setRangePreset('15m');
    setRangePreset('nonsense');
    expect(selectedRange.value.id).toBe('15m');
  });

  it('resolves relatively at call time, so a live window keeps following the clock', () => {
    setRangePreset('1h');
    const now = Date.parse('2026-08-06T12:00:00.000Z');
    const first = resolveWindow(now);
    const later = resolveWindow(now + 600_000);
    expect(first.from.toISOString()).toBe('2026-08-06T11:00:00.000Z');
    // Freezing from/to at selection would turn "last hour" into a historical
    // window without the operator noticing.
    expect(later.from.toISOString()).toBe('2026-08-06T11:10:00.000Z');
    expect(later.minutes).toBe(60);
  });

  it('converts to whole days for the report endpoints that take one', () => {
    setRangePreset('7d');
    expect(rangeDays.value).toBe(7);
    setRangePreset('6h');
    // Sub-day windows must not round down to zero days.
    expect(rangeDays.value).toBe(1);
  });

  it('offers short operational windows before long analytical ones', () => {
    expect(RANGE_PRESETS[0].minutes).toBeLessThan(RANGE_PRESETS[RANGE_PRESETS.length - 1].minutes);
  });
});
