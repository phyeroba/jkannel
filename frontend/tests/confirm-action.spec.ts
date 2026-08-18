import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import ConfirmAction from '../src/components/ConfirmAction.vue';
import type { ActionImpact } from '../src/utils/safe-control';

const envelope = (data: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify({ success: status < 400, data }), { status }));

/** Mirrors `describeImpact` in backend/src/connectivity/safe-control.service.ts. */
const impact = (overrides: Partial<ActionImpact> = {}): ActionImpact => ({
  operation: 'reconnect',
  subject: 'MTN Primary',
  summary: 'Reconnect MTN Primary: the bind is dropped and re-established.',
  consequences: [
    'All 3 parallel connections on this SMSC are cycled together — the engine cannot restart one of them.',
    '412 message(s) are queued on this bind. Messages already handed to the carrier and awaiting acknowledgement may be re-sent, so duplicates are possible.',
    '2 route(s) target this SMSC. Traffic on them pauses until the bind is back.',
  ],
  queuedMessages: 412,
  reasonRequired: true,
  blockedReason: null,
  ...overrides,
});

async function mountDialog(payload: ActionImpact | Response, props: Record<string, unknown> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      payload instanceof Response ? Promise.resolve(payload.clone()) : envelope(payload),
    ),
  );
  const wrapper = mount(ConfirmAction, {
    props: { open: true, operation: 'reconnect', smscId: 'abc-123', ...props },
  });
  await vi.waitFor(() => expect(wrapper.find('[data-state="loading"]').exists()).toBe(false));
  return wrapper;
}

describe('the dialog states impact instead of asking "are you sure?"', () => {
  it('renders the backend’s summary and every consequence verbatim, in order', async () => {
    const wrapper = await mountDialog(impact());
    expect(wrapper.get('[data-testid="confirm-action-summary"]').text()).toBe(impact().summary);

    const rendered = wrapper
      .get('[data-testid="confirm-action-consequences"]')
      .findAll('li')
      .map((item) => item.text());
    // Verbatim: these were computed from live state, and a client-side
    // paraphrase would be a warning nobody measured.
    expect(rendered).toEqual(impact().consequences);
    // And nowhere is the generic question the specification forbids.
    expect(wrapper.text()).not.toContain('Are you sure');
  });

  it('shows the queue depth behind the object', async () => {
    const wrapper = await mountDialog(impact());
    expect(wrapper.get('[data-testid="confirm-action-queued"]').text()).toBe('412');
  });

  it('renders an unreported queue depth as an em dash and says it is not zero', async () => {
    const wrapper = await mountDialog(impact({ queuedMessages: null }));
    expect(wrapper.get('[data-testid="confirm-action-queued"]').text()).toBe('—');
    expect(wrapper.get('[data-testid="confirm-action-queue-unknown"]').text()).toContain(
      'It is not zero',
    );
  });

  it('says so when the API computed no consequence, rather than showing an empty list', async () => {
    const wrapper = await mountDialog(impact({ consequences: [] }));
    expect(wrapper.find('[data-testid="confirm-action-consequences"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="confirm-action-no-consequences"]').text()).toContain(
      'not a guarantee that nothing changes',
    );
  });
});

describe('blockedReason disables the verb', () => {
  it('disables confirm outright and states the reason', async () => {
    const wrapper = await mountDialog(
      impact({
        operation: 'suspend',
        blockedReason: 'Traffic on this SMSC is already suspended.',
      }),
      { operation: 'suspend' },
    );
    const blocked = wrapper.get('[data-testid="confirm-action-blocked"]');
    expect(blocked.text()).toContain('Traffic on this SMSC is already suspended.');
    expect(blocked.text()).toContain('blocked and cannot be confirmed');

    const confirm = wrapper.get('[data-testid="confirm-action-confirm"]');
    // Disabled, not merely warned about: a live button next to "cannot proceed"
    // is a button an operator presses.
    expect(confirm.attributes('disabled')).toBeDefined();
  });

  it('stays disabled even once a perfectly good reason has been typed', async () => {
    const wrapper = await mountDialog(
      impact({ operation: 'resume', blockedReason: 'Traffic on this SMSC is not suspended.' }),
      { operation: 'resume' },
    );
    await wrapper.get('[data-testid="confirm-action-reason"]').setValue('carrier asked us to');
    expect(
      wrapper.get('[data-testid="confirm-action-confirm"]').attributes('disabled'),
    ).toBeDefined();
    await wrapper.get('[data-testid="confirm-action-confirm"]').trigger('click');
    expect(wrapper.emitted('confirm')).toBeUndefined();
  });
});

describe('the reason is required and validated before the request', () => {
  it('holds the verb closed until the reason meets the API’s own minimum', async () => {
    const wrapper = await mountDialog(impact());
    const confirm = wrapper.get('[data-testid="confirm-action-confirm"]');
    expect(confirm.attributes('disabled')).toBeDefined();

    await wrapper.get('[data-testid="confirm-action-reason"]').setValue('ab');
    expect(confirm.attributes('disabled')).toBeDefined();

    await wrapper.get('[data-testid="confirm-action-reason"]').setValue('  cycling per runbook  ');
    expect(confirm.attributes('disabled')).toBeUndefined();
    await confirm.trigger('click');
    // Trimmed, exactly as the service trims it before storing.
    expect(wrapper.emitted('confirm')).toEqual([['cycling per runbook']]);
  });

  it('explains the rejection once the operator has left the box', async () => {
    const wrapper = await mountDialog(impact());
    const box = wrapper.get('[data-testid="confirm-action-reason"]');
    // Nothing is scolded before it has been typed in.
    expect(wrapper.find('[data-testid="confirm-action-reason-error"]').exists()).toBe(false);
    await box.setValue('x');
    await box.trigger('blur');
    expect(wrapper.get('[data-testid="confirm-action-reason-error"]').text()).toContain(
      'at least 3 characters',
    );
  });

  it('does not ask for a reason the API does not require', async () => {
    const wrapper = await mountDialog(
      impact({ operation: 'enable', reasonRequired: false, consequences: [] }),
      { operation: 'enable' },
    );
    expect(wrapper.find('[data-testid="confirm-action-reason"]').exists()).toBe(false);
    expect(
      wrapper.get('[data-testid="confirm-action-confirm"]').attributes('disabled'),
    ).toBeUndefined();
  });

  it('refuses to promise an audit entry the action endpoint will not write', async () => {
    const wrapper = await mountDialog(impact());
    // /smscs/:id/actions/reconnect reads no body in this build.
    expect(wrapper.get('[data-testid="confirm-action-reason-note"]').text()).toContain(
      'accepts no reason',
    );
  });

  it('does promise one where the control API really records it', async () => {
    const wrapper = await mountDialog(
      impact({ operation: 'suspend', consequences: ['The bind stays connected.'] }),
      { operation: 'suspend' },
    );
    expect(wrapper.get('[data-testid="confirm-action-reason-note"]').text()).toContain(
      'Recorded in the audit trail',
    );
  });
});

describe('an impact that could not be read', () => {
  it('keeps the verb closed rather than offering an unexplained action', async () => {
    const wrapper = await mountDialog(
      new Response(JSON.stringify({ success: false, message: 'SMSC not found' }), { status: 404 }),
    );
    expect(
      wrapper.get('[data-testid="confirm-action-confirm"]').attributes('disabled'),
    ).toBeDefined();
    expect(wrapper.get('[data-testid="confirm-action-state"]').text()).toContain(
      'it will not offer to do it',
    );
  });
});

describe('a caller-supplied impact', () => {
  it('is rendered without any fetch, for actions with no preview endpoint', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const supplied = impact({
      operation: 'failover',
      subject: 'MTN national',
      summary: 'Move MTN national traffic from MTN Primary to MTN Secondary.',
      consequences: ['Route “MTN national” is configured to target MTN Primary.'],
      queuedMessages: null,
    });
    const wrapper = mount(ConfirmAction, {
      props: { open: true, operation: 'failover', impact: supplied, verb: 'Fail over' },
    });
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="confirm-action-summary"]').exists()).toBe(true),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="confirm-action-consequences"]').findAll('li')).toHaveLength(
      1,
    );
    expect(wrapper.get('[data-testid="confirm-action-confirm"]').text()).toBe('Fail over');
  });
});
