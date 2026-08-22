import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { overlay, overlayHas } from './overlay';

const mocks = vi.hoisted(() => ({ permissions: new Set<string>(['monitoring.view']) }));

vi.mock('../src/stores/session', async () => {
  const { ref } = await import('vue');
  return {
    session: ref({ displayName: 'Amina Operator', permissions: mocks.permissions }),
    canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
      !permission || Boolean(value?.permissions.has(permission)),
  };
});

import EventsView from '../src/views/EventsView.vue';

const envelope = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));

const CORRELATION = '0e3b1f2a-1111-2222-3333-444455556666';

const NOTE =
  `Structured logs for this correlation id are at GET /observability/logs?correlationId=${CORRELATION}. ` +
  'They are process-local and do not survive a restart, so an older incident may have events and ' +
  'audit entries here with no log lines.';

const bindLost = {
  id: 'e1',
  kind: 'smsc.bind.lost',
  severity: 'critical',
  summary: 'MTN primary bind went down.',
  detail: { engineId: 'mtn-p1', previousState: 'bound' },
  subject_type: 'smsc',
  subject_id: 'mtn-p1',
  correlation_id: CORRELATION,
  observed_at: '2026-08-17T09:00:00.000Z',
};
const queueWarning = {
  id: 'e2',
  kind: 'queue.threshold.crossed',
  severity: 'warning',
  summary: 'Queue depth crossed 5000.',
  detail: {},
  subject_type: 'queue',
  subject_id: 'mtn-p1',
  correlation_id: null,
  observed_at: '2026-08-17T09:01:00.000Z',
};

interface Options {
  items?: unknown[];
  bundle?: Record<string, unknown> | null;
  logs?: unknown[] | 'forbidden' | 'error';
  permissions?: string[];
}

const mountView = async (options: Options = {}) => {
  const calls: string[] = [];
  mocks.permissions.clear();
  for (const permission of options.permissions ?? ['monitoring.view'])
    mocks.permissions.add(permission);

  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/observability/logs')) {
        if (options.logs === 'forbidden')
          return Promise.resolve(
            new Response(JSON.stringify({ success: false, message: 'no' }), { status: 403 }),
          );
        if (options.logs === 'error')
          return Promise.resolve(
            new Response(JSON.stringify({ success: false, message: 'buffer gone' }), {
              status: 500,
            }),
          );
        return envelope({ items: options.logs ?? [] });
      }
      if (url.includes('/diagnostics/correlations/'))
        return envelope(
          options.bundle ?? {
            correlationId: CORRELATION,
            events: [bindLost],
            alerts: [],
            audit: [],
            note: NOTE,
          },
        );
      return envelope({ items: options.items ?? [bindLost, queueWarning], limit: 100 });
    }),
  );
  const wrapper = mount(EventsView);
  await vi.waitFor(() => expect(overlayHas(wrapper, '[data-state="loading"]')).toBe(false));
  return { wrapper, calls };
};

describe('Events — the stream and its filters', () => {
  it('sends every filter the API supports, and the shared time range as `since`', async () => {
    const { wrapper, calls } = await mountView();
    const first = calls[0];
    expect(first).toContain('/diagnostics/events?');
    expect(first).toContain('limit=100');
    expect(first).toContain('since=');

    await overlay(wrapper, '[data-testid="events-filter-kind"]').setValue('smsc.');
    await overlay(wrapper, '[data-testid="events-filter-severity"]').setValue('critical');
    await overlay(wrapper, '[data-testid="events-filter-subject-type"]').setValue('smsc');
    await overlay(wrapper, '[data-testid="events-filter-subject-id"]').setValue('mtn-p1');
    await overlay(wrapper, '[data-testid="events-limit"]').setValue('250');
    await overlay(wrapper, '[data-testid="events-apply"]').trigger('click');

    await vi.waitFor(() => expect(calls.some((url) => url.includes('limit=250'))).toBe(true));
    const latest = calls[calls.length - 1];
    expect(latest).toContain('kind=smsc.');
    expect(latest).toContain('severity=critical');
    expect(latest).toContain('subjectType=smsc');
    expect(latest).toContain('subjectId=mtn-p1');
  });

  it('states that the API has no upper bound on the window', async () => {
    const { wrapper } = await mountView();
    expect(overlay(wrapper, '[data-testid="events-scope-note"]').text()).toContain(
      'the API takes no upper bound',
    );
  });

  it('names severity in words as well as colour', async () => {
    const { wrapper } = await mountView();
    const badge = overlay(wrapper, '[data-testid="event-severity-e1"]');
    expect(badge.text()).toBe('critical');
    expect(badge.classes()).toContain('bad');
    expect(overlay(wrapper, '[data-testid="event-severity-e2"]').classes()).toContain('warn');
  });

  it('refuses to send a malformed correlation id the API would reject', async () => {
    const { wrapper, calls } = await mountView();
    const before = calls.length;
    await overlay(wrapper, '[data-testid="events-filter-correlation"]').setValue('0e3b1f2a');
    expect(overlay(wrapper, '[data-testid="events-correlation-invalid"]').text()).toContain(
      '36 characters',
    );
    await overlay(wrapper, '[data-testid="events-apply"]').trigger('click');
    expect(calls.length).toBe(before);
    expect(overlay(wrapper, '[data-testid="events-state"]').attributes('data-state')).toBe('error');
  });

  it('narrows the stream to one correlation id when asked', async () => {
    const { wrapper, calls } = await mountView();
    await overlay(wrapper, '[data-testid="event-filter-e1"]').trigger('click');
    await vi.waitFor(() =>
      expect(calls.some((url) => url.includes(`correlationId=${CORRELATION}`))).toBe(true),
    );
  });

  it('warns that a full page is the newest slice, not the whole window', async () => {
    const { wrapper } = await mountView({
      items: Array.from({ length: 100 }, (_, index) => ({ ...bindLost, id: `e${index}` })),
    });
    expect(overlay(wrapper, '[data-testid="events-trimmed"]').text()).toContain(
      'newest slice of the window',
    );
  });

  it('reads a quiet window as a normal reading rather than a monitoring gap', async () => {
    const { wrapper } = await mountView({ items: [] });
    const state = overlay(wrapper, '[data-testid="events-state"]');
    expect(state.attributes('data-state')).toBe('empty');
    expect(state.text()).toContain('a quiet window is a normal reading');
  });
});

describe('Events — the correlation drill-down', () => {
  it('shows events, alerts and audit entries together', async () => {
    const { wrapper } = await mountView({
      bundle: {
        correlationId: CORRELATION,
        events: [bindLost],
        alerts: [
          {
            id: 'a1',
            dedup_key: 'bind-mtn-p1',
            severity: 'critical',
            summary: 'MTN primary is down',
            opened_at: '2026-08-17T09:00:05.000Z',
            resolved_at: null,
          },
        ],
        audit: [
          {
            id: 'au1',
            actor_id: 'u1',
            action: 'smsc.reconnect',
            entity_type: 'smsc',
            entity_id: 'mtn-p1',
            created_at: '2026-08-17T09:03:00.000Z',
          },
        ],
        note: NOTE,
      },
      logs: [{ timestamp: '2026-08-17T09:00:01.000Z', level: 'error', message: 'bind dropped' }],
      permissions: ['monitoring.view', 'system.view'],
    });
    await overlay(wrapper, '[data-testid="event-thread-e1"]').trigger('click');
    // DataState renders nothing once the read succeeds, so the thread's own
    // content — not the banner — is what proves it settled.
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="correlation-metric-events"]')).toBe(true),
    );
    expect(overlayHas(wrapper, '[data-testid="correlation-state"]')).toBe(false);
    expect(overlay(wrapper, '[data-testid="correlation-metric-events"]').text()).toBe('1');
    expect(overlay(wrapper, '[data-testid="correlation-metric-alerts"]').text()).toBe('1');
    expect(overlay(wrapper, '[data-testid="correlation-metric-audit"]').text()).toBe('1');
    expect(overlay(wrapper, '[data-testid="correlation-alerts"]').text()).toContain('still open');
    expect(overlay(wrapper, '[data-testid="correlation-audit"]').text()).toContain(
      'smsc.reconnect',
    );
    await vi.waitFor(() =>
      expect(overlay(wrapper, '[data-testid="correlation-logs"]').text()).toContain('bind dropped'),
    );
  });

  it('renders the log caveat verbatim, above the log section', async () => {
    const { wrapper } = await mountView({ permissions: ['monitoring.view', 'system.view'] });
    await overlay(wrapper, '[data-testid="event-thread-e1"]').trigger('click');
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="correlation-logs-empty"]')).toBe(true),
    );
    // The API's own sentence, word for word.
    expect(overlay(wrapper, '[data-testid="correlation-note"]').text()).toBe(NOTE);
    const caveat = overlay(wrapper, '[data-testid="correlation-log-caveat"]').text();
    expect(caveat).toContain('process-local and do not survive a restart');
    expect(caveat).toContain('events and audit entries here with no log lines');
    // The thread is a teleported sheet, so the order has to be read off the
    // document rather than off the component's own markup.
    const html = document.body.innerHTML;
    expect(html.indexOf('correlation-log-caveat')).toBeGreaterThan(-1);
    expect(html.indexOf('correlation-log-caveat')).toBeLessThan(
      html.indexOf('correlation-logs-empty'),
    );
  });

  it('never shows an empty log section silently', async () => {
    const { wrapper } = await mountView({
      logs: [],
      permissions: ['monitoring.view', 'system.view'],
    });
    await overlay(wrapper, '[data-testid="event-thread-e1"]').trigger('click');
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="correlation-logs-empty"]')).toBe(true),
    );
    const empty = overlay(wrapper, '[data-testid="correlation-logs-empty"]').text();
    expect(empty).toContain('not retained here');
    expect(empty).toContain('not as “nothing happened”');
  });

  it('says the logs were not requested when the operator lacks system.view', async () => {
    const { wrapper, calls } = await mountView({ permissions: ['monitoring.view'] });
    await overlay(wrapper, '[data-testid="event-thread-e1"]').trigger('click');
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="correlation-logs-forbidden"]')).toBe(true),
    );
    expect(overlay(wrapper, '[data-testid="correlation-logs-forbidden"]').text()).toContain(
      'system.view',
    );
    // No pointless 403 was provoked.
    expect(calls.some((url) => url.includes('/observability/logs'))).toBe(false);
  });

  it('calls a failed log read unread, not empty', async () => {
    const { wrapper } = await mountView({
      logs: 'error',
      permissions: ['monitoring.view', 'system.view'],
    });
    await overlay(wrapper, '[data-testid="event-thread-e1"]').trigger('click');
    await vi.waitFor(() =>
      expect(overlayHas(wrapper, '[data-testid="correlation-logs-error"]')).toBe(true),
    );
    expect(overlay(wrapper, '[data-testid="correlation-logs-error"]').text()).toContain(
      'unread rather than empty',
    );
  });

  it('offers no thread control for an event that carries no correlation id', async () => {
    const { wrapper } = await mountView();
    expect(overlayHas(wrapper, '[data-testid="event-thread-e2"]')).toBe(false);
    expect(overlay(wrapper, '[data-testid="event-nothread-e2"]').text()).toBe('not correlated');
  });
});
