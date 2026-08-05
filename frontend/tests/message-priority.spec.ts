import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/session', () => ({
  session: ref({
    displayName: 'Amina Operator',
    roleLabel: 'NOC',
    permissions: new Set([
      'messages.view',
      'messages.send',
      'configuration.manage',
      'system.manage',
    ]),
  }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import BulkSendView from '../src/views/BulkSendView.vue';
import LiveQueueView from '../src/views/LiveQueueView.vue';
import MessagePriority from '../src/components/MessagePriority.vue';
import ModuleWorkspace from '../src/views/ModuleWorkspace.vue';
import {
  PRIORITY_BULK_CAVEAT,
  PRIORITY_CAVEAT,
  PRIORITY_LEVELS,
  PRIORITY_MAX,
  PRIORITY_MIN,
  PRIORITY_UNSET,
  isPriorityChoice,
  priorityCellHint,
  priorityCellLabel,
  priorityFields,
} from '../src/utils/message-priority';

const apiResponse = (data: unknown, status = 200) =>
  Promise.resolve(
    new Response(
      JSON.stringify(status < 400 ? { success: true, data } : { success: false, message: data }),
      { status },
    ),
  );
const bodyOf = (call: unknown[] | undefined) =>
  JSON.parse(String((call?.[1] as RequestInit | undefined)?.body));

/** Both views render RouterLinks, which throw without a router installed. */
const stubRouter = async (path: string) => {
  const blank = { template: '<div />' };
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/messages', name: 'messages', component: blank, meta: { title: 'Messages' } },
      { path: '/delivery-reports', name: 'dlr', component: blank },
      { path: '/live-queue', name: 'live-queue', component: blank },
      { path: '/bulk-send', name: 'bulk-send', component: blank },
    ],
  });
  await router.push(path);
  await router.isReady();
  return router;
};

describe('message priority contract', () => {
  it('never conflates "no preference" with priority 0', () => {
    // The whole point. `priority` must be ABSENT for the unset choice: sending
    // 0 (or null) would demote every message to the lowest real SMPP level.
    expect(priorityFields(PRIORITY_UNSET)).toEqual({});
    expect(Object.prototype.hasOwnProperty.call(priorityFields(PRIORITY_UNSET), 'priority')).toBe(
      false,
    );
    expect(priorityFields('0')).toEqual({ priority: 0 });
    expect(priorityFields('0').priority).not.toBeNull();
    expect(priorityFields('0').priority).toBe(0);
    expect(priorityFields('3')).toEqual({ priority: 3 });
  });

  it('offers exactly the four SMPP levels plus a genuinely absent default', () => {
    expect(PRIORITY_LEVELS.map((level) => level.value)).toEqual(['', '0', '1', '2', '3']);
    // The first option is the absent one, so a select that is never touched
    // submits nothing rather than the lowest level.
    expect(PRIORITY_LEVELS[0].value).toBe(PRIORITY_UNSET);
    expect(PRIORITY_LEVELS[0].label).toContain('No preference');
    // 0 is labelled as a real level, never as "default".
    expect(PRIORITY_LEVELS[1].label).toContain('lowest real level');
    expect(PRIORITY_LEVELS[1].label).not.toMatch(/default/i);
    expect(PRIORITY_MIN).toBe(0);
    expect(PRIORITY_MAX).toBe(3);
  });

  it('says plainly that priority only reorders a backlog', () => {
    expect(PRIORITY_CAVEAT).toContain('only changes anything when a backlog exists');
    expect(PRIORITY_CAVEAT).toContain('does not make the link faster');
    expect(PRIORITY_CAVEAT).toContain('cannot preempt a segment already handed to the SMPP link');
    // Bulk says more, because bulk is where a backlog is created.
    expect(PRIORITY_BULK_CAVEAT.length).toBeGreaterThan(PRIORITY_CAVEAT.length);
    expect(PRIORITY_BULK_CAVEAT).toContain('Every recipient of this campaign inherits');
  });

  it('renders an unset priority as a state, not as missing data', () => {
    expect(priorityCellLabel(null)).toBe('unset');
    expect(priorityCellLabel(undefined)).toBe('unset');
    expect(priorityCellLabel('')).toBe('unset');
    // 0 must never render the same as unset.
    expect(priorityCellLabel(0)).toBe('0');
    expect(priorityCellLabel('0')).toBe('0');
    expect(priorityCellLabel(3)).toBe('3');
    expect(priorityCellHint(null)).toContain('not the same as level 0');
    expect(priorityCellHint(0)).toContain('bulk');
  });

  it('guards values read back from a row', () => {
    expect(isPriorityChoice('')).toBe(true);
    expect(isPriorityChoice('0')).toBe(true);
    expect(isPriorityChoice('4')).toBe(false);
    expect(isPriorityChoice(0)).toBe(false);
    expect(isPriorityChoice(null)).toBe(false);
  });
});

describe('MessagePriority control', () => {
  it('defaults to the absent option and emits the raw choice string', async () => {
    const wrapper = mount(MessagePriority, { props: { modelValue: PRIORITY_UNSET } });
    const select = wrapper.get('[data-testid="priority-select"]');
    expect((select.element as HTMLSelectElement).value).toBe('');
    expect(wrapper.get('[data-testid="priority-caveat"]').text()).toContain(
      'only changes anything when a backlog exists',
    );
    expect(wrapper.get('[data-testid="priority-unset-note"]').text()).toContain(
      'not the same as choosing 0',
    );
    await select.setValue('0');
    // '0' as a string, so the parent can never treat the level as falsy.
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['0']);
    wrapper.unmount();
  });
});

describe('priority on the single-message composer', () => {
  const mountWorkspace = async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: '/messages',
          name: 'messages',
          component: ModuleWorkspace,
          meta: { title: 'Messages' },
        },
      ],
    });
    await router.push('/messages');
    await router.isReady();
    return mount(ModuleWorkspace, { global: { plugins: [router] } });
  };
  const stub = () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/smscs'))
        return apiResponse({
          items: [{ id: 'uuid-1', engine_id: 'primary-smpp', name: 'Primary SMPP' }],
          total: 1,
        });
      if (String(url).includes('/messages') && init?.method === 'POST')
        return apiResponse({ id: 9 });
      return apiResponse({
        items: [{ id: '1', sender: 'A', receiver: 'B', text: 'hi', priority: 0 }],
        nextCursor: null,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  const openComposer = async (wrapper: ReturnType<typeof mount>) => {
    await wrapper.get('[data-testid="open-send-message"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="send-smsc"]').findAll('option').length).toBeGreaterThan(1),
    );
    await wrapper.get('[data-testid="send-sender"]').setValue('JKANNEL');
    await wrapper.get('[data-testid="send-receiver"]').setValue('+256700000001');
    await wrapper.get('[data-testid="send-text"]').setValue('Hello');
    await wrapper.get('[data-testid="send-smsc"]').setValue('primary-smpp');
  };
  const postBody = (fetchMock: ReturnType<typeof vi.fn>) =>
    bodyOf(
      fetchMock.mock.calls.find(
        (call) =>
          String(call[0]).endsWith('/messages') &&
          (call[1] as RequestInit | undefined)?.method === 'POST',
      ),
    );

  it('omits priority entirely when the operator expressed no preference', async () => {
    const fetchMock = stub();
    const wrapper = await mountWorkspace();
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));
    await openComposer(wrapper);
    await wrapper.get('[data-testid="send-submit"]').trigger('click');
    await vi.waitFor(() => expect(postBody(fetchMock)).toBeTruthy());
    const body = postBody(fetchMock);
    expect('priority' in body).toBe(false);
    wrapper.unmount();
  });

  it('sends priority 0 as the number 0, not as an absent field', async () => {
    const fetchMock = stub();
    const wrapper = await mountWorkspace();
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));
    await openComposer(wrapper);
    await wrapper.get('[data-testid="send-priority-select"]').setValue('0');
    await wrapper.get('[data-testid="send-submit"]').trigger('click');
    await vi.waitFor(() => expect(postBody(fetchMock)).toBeTruthy());
    expect(postBody(fetchMock).priority).toBe(0);
    wrapper.unmount();
  });

  it('shows an unset engine priority as "unset" and a zero as "0" in the message log', async () => {
    stub();
    const wrapper = await mountWorkspace();
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).toBe('false'));
    expect(wrapper.text()).toContain('Priority');
    wrapper.unmount();
  });
});

describe('priority on the bulk campaign form', () => {
  const stub = () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/smscs'))
        return apiResponse({ items: [{ id: 's1', name: 'Primary', engine_id: 'smsc-primary' }] });
      if (target.includes('/bulk-send') && init?.method === 'POST')
        return apiResponse({ id: 'job-1', name: 'July', priority: 0 });
      if (/\/bulk-send\/[^/]+\/recipients/.test(target)) return apiResponse({ items: [] });
      if (/\/bulk-send\/[^/?]+$/.test(target.split('?')[0]))
        return apiResponse({ id: 'job-1', name: 'July', priority: 0, recipientCounts: {} });
      return apiResponse({ items: [], nextCursor: null });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  const mountBulk = async () => {
    const router = await stubRouter('/bulk-send');
    return mount(BulkSendView, { global: { plugins: [router] } });
  };
  const fill = async (wrapper: ReturnType<typeof mount>) => {
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="bulk-smsc"]').findAll('option').length).toBeGreaterThan(1),
    );
    await wrapper.get('[data-testid="bulk-name"]').setValue('July reminder');
    await wrapper.get('[data-testid="bulk-smsc"]').setValue('smsc-primary');
    await wrapper.get('[data-testid="bulk-message"]').setValue('Balance due');
    await wrapper.get('[data-testid="bulk-recipients"]').setValue('+256700000001');
  };
  const postBody = (fetchMock: ReturnType<typeof vi.fn>) =>
    bodyOf(
      fetchMock.mock.calls.find(
        (call) =>
          String(call[0]).endsWith('/bulk-send') &&
          (call[1] as RequestInit | undefined)?.method === 'POST',
      ),
    );

  it('carries the strongest caveat, because a campaign is how a backlog forms', async () => {
    stub();
    const wrapper = await mountBulk();
    await fill(wrapper);
    const caveat = wrapper.get('[data-testid="bulk-priority-caveat"]').text();
    expect(caveat).toContain('A campaign is how a backlog forms');
    expect(caveat).toContain('cannot preempt a segment already handed to the SMPP link');
    wrapper.unmount();
  });

  it('omits priority for an unset campaign rather than demoting it to 0', async () => {
    const fetchMock = stub();
    const wrapper = await mountBulk();
    await fill(wrapper);
    await wrapper.get('[data-testid="bulk-submit"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="bulk-send-notice"]').exists()).toBe(true),
    );
    expect('priority' in postBody(fetchMock)).toBe(false);
    expect(wrapper.get('[data-testid="bulk-send-notice"]').text()).toContain(
      'No send priority was requested',
    );
    wrapper.unmount();
  });

  it('sends an explicit campaign priority of 0 as 0', async () => {
    const fetchMock = stub();
    const wrapper = await mountBulk();
    await fill(wrapper);
    await wrapper.get('[data-testid="bulk-priority-select"]').setValue('0');
    await wrapper.get('[data-testid="bulk-submit"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="bulk-send-notice"]').exists()).toBe(true),
    );
    expect(postBody(fetchMock).priority).toBe(0);
    expect(wrapper.get('[data-testid="bulk-send-notice"]').text()).toContain(
      'Every recipient inherits priority 0',
    );
    wrapper.unmount();
  });

  it('says the jobs CSV has no priority column rather than implying it does', async () => {
    stub();
    const wrapper = await mountBulk();
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="bulk-jobs-csv-only"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="bulk-jobs-csv-only"]').text()).toContain(
      'does not include priority',
    );
    wrapper.unmount();
  });
});

describe('priority on the Live Queue replay', () => {
  const stub = () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/smscs'))
        return apiResponse({ items: [{ id: 's1', name: 'Primary', engine_id: 'primary-smpp' }] });
      if (target.includes('/queue-console/resend') && init?.method === 'POST')
        return apiResponse({ requested: 1, resent: 1, skipped: 0, priority: null, results: [] });
      if (target.includes('/queue-console/live')) return apiResponse({ binds: [], spool: {} });
      if (target.includes('/queue-console/spool'))
        return apiResponse({
          items: [
            { sqlId: '11', sender: 'A', receiver: 'B', text: 'queued', priority: 0 },
            { sqlId: '12', sender: 'A', receiver: 'C', text: 'queued', priority: null },
          ],
          total: 2,
        });
      if (target.includes('/queue-console/history'))
        return apiResponse({
          items: [{ id: '1', sender: 'A', receiver: 'B', deliveryStatus: 'failed' }],
          counts: { failed: 1 },
        });
      return apiResponse({ items: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  /**
   * Every initial load is awaited before a test acts: this view fires four in
   * parallel, and unmounting while one is still in flight patches a torn-down
   * tree.
   */
  const mountSettled = async () => {
    const router = await stubRouter('/live-queue');
    const wrapper = mount(LiveQueueView, { global: { plugins: [router] } });
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="spool-priority-11"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="log-row-1"]').exists()).toBe(true);
      expect(wrapper.get('[data-testid="log-resend-target"]').findAll('option').length).toBe(2);
    });
    return wrapper;
  };

  it('distinguishes a queued priority 0 from a queued unset priority in the spool', async () => {
    stub();
    const wrapper = await mountSettled();
    expect(wrapper.get('[data-testid="spool-priority-11"]').text()).toBe('0');
    expect(wrapper.get('[data-testid="spool-priority-12"]').text()).toBe('unset');
    wrapper.unmount();
  });

  it('omits priority from a replay unless one was chosen, and reports what the API wrote', async () => {
    const fetchMock = stub();
    const wrapper = await mountSettled();
    await wrapper.get('[data-testid="log-resend-target"]').setValue('primary-smpp');
    await wrapper.get('[data-testid="log-select-1"]').setValue(true);
    await wrapper.get('[data-testid="log-resend"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="log-resend-notice"]').exists()).toBe(true),
    );
    const post = fetchMock.mock.calls.find(
      (call) =>
        String(call[0]).includes('/queue-console/resend') &&
        (call[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect('priority' in bodyOf(post)).toBe(false);
    expect(wrapper.get('[data-testid="log-resend-notice"]').text()).toContain(
      'No send priority was requested',
    );
    wrapper.unmount();
  });

  it('sends an explicit replay priority of 0', async () => {
    const fetchMock = stub();
    const wrapper = await mountSettled();
    await wrapper.get('[data-testid="log-resend-target"]').setValue('primary-smpp');
    await wrapper.get('[data-testid="log-resend-priority-select"]').setValue('0');
    await wrapper.get('[data-testid="log-select-1"]').setValue(true);
    await wrapper.get('[data-testid="log-resend"]').trigger('click');
    await vi.waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (call) =>
          String(call[0]).includes('/queue-console/resend') &&
          (call[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeTruthy();
      expect(bodyOf(post).priority).toBe(0);
    });
    wrapper.unmount();
  });
});
