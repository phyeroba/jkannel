import { mount } from '@vue/test-utils';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import PrivacyReveal from '../src/components/PrivacyReveal.vue';

const envelope = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));

const MASKED = {
  masked: true,
  notice: 'Subscriber numbers and message bodies are masked by default.',
  refusal: null,
};

const grant = (expiresInMs = 15 * 60_000) => ({
  id: 'g-1',
  reason: 'ticket 4412 — customer reports the OTP never arrived',
  scopeMessageRef: null,
  grantedAt: new Date(Date.now()).toISOString(),
  expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  revealCount: 0,
});

/** Lets the component's `void loadGrant()` settle before assertions. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  localStorage.setItem('jkannel.accessToken', 'token');
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('the masking notice', () => {
  it('renders nothing at all when the payload carries no subscriber data', () => {
    const wrapper = mount(PrivacyReveal, { props: { privacy: null } });
    // A screen with nothing to mask must not grow a privacy panel.
    expect(wrapper.find('[data-testid="privacy-reveal"]').exists()).toBe(false);
  });

  it('states the masked state in words, never by colour alone (§17.1)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => envelope({ grant: null }));
    const wrapper = mount(PrivacyReveal, { props: { privacy: MASKED, canReveal: true } });
    await settle();
    expect(wrapper.find('[data-testid="privacy-reveal-state"]').text()).toContain('Masked');
    expect(wrapper.find('[data-testid="privacy-reveal-detail"]').text()).toBe(MASKED.notice);
  });

  it('renders the API notice verbatim rather than a console paraphrase', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => envelope({ grant: null }));
    const notice = 'A completely different sentence from the server.';
    const wrapper = mount(PrivacyReveal, {
      props: { privacy: { masked: true, notice }, canReveal: true },
    });
    await settle();
    expect(wrapper.find('[data-testid="privacy-reveal-detail"]').text()).toBe(notice);
  });

  it('offers no reveal control to an operator without the permission', async () => {
    const wrapper = mount(PrivacyReveal, { props: { privacy: MASKED, canReveal: false } });
    await settle();
    expect(wrapper.find('[data-testid="privacy-reveal-ask"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="privacy-reveal-detail"]').text()).toContain(
      'messages.reveal',
    );
  });

  it('shows the refusal the API gave, when one was given', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => envelope({ grant: null }));
    const wrapper = mount(PrivacyReveal, {
      props: {
        privacy: { ...MASKED, refusal: 'No active reveal window. Request one at POST …' },
        canReveal: true,
      },
    });
    await settle();
    expect(wrapper.find('[data-testid="privacy-reveal-refusal"]').text()).toContain(
      'No active reveal window',
    );
  });
});

describe('requesting a window', () => {
  it('will not submit without a usable reason', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => envelope({ grant: null }));
    const wrapper = mount(PrivacyReveal, { props: { privacy: MASKED, canReveal: true } });
    await settle();
    await wrapper.find('[data-testid="privacy-reveal-ask"]').trigger('click');

    const submit = wrapper.find('[data-testid="privacy-reveal-submit"]');
    expect(submit.attributes('disabled')).toBeDefined();

    await wrapper.find('[data-testid="privacy-reveal-reason-input"]').setValue('x');
    expect(wrapper.find('[data-testid="privacy-reveal-reason-problem"]').exists()).toBe(true);
    expect(
      wrapper.find('[data-testid="privacy-reveal-submit"]').attributes('disabled'),
    ).toBeDefined();
  });

  it('sends the reason, the window and the message scope, then tells the parent', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return url.includes('/privacy/reveal') && init?.method === 'POST'
        ? envelope(grant())
        : envelope({ grant: null });
    });

    const wrapper = mount(PrivacyReveal, {
      props: { privacy: MASKED, canReveal: true, messageRef: 'msg-77' },
    });
    await settle();
    await wrapper.find('[data-testid="privacy-reveal-ask"]').trigger('click');
    await wrapper.find('[data-testid="privacy-reveal-reason-input"]').setValue('ticket 4412');
    await wrapper.find('[data-testid="privacy-reveal-form"]').trigger('submit');
    await settle();

    const post = calls.find((call) => call.body !== null);
    expect(post?.body).toEqual({ reason: 'ticket 4412', minutes: 15, messageRef: 'msg-77' });
    // The parent has to re-fetch: the unmasked values were never sent, so there
    // is nothing on screen to un-mask locally.
    expect(wrapper.emitted('changed')?.at(-1)).toEqual([true]);
  });

  it('clamps a window the API would refuse instead of letting it 400', async () => {
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return init?.method === 'POST' ? envelope(grant()) : envelope({ grant: null });
    });

    const wrapper = mount(PrivacyReveal, { props: { privacy: MASKED, canReveal: true } });
    await settle();
    await wrapper.find('[data-testid="privacy-reveal-ask"]').trigger('click');
    await wrapper.find('[data-testid="privacy-reveal-reason-input"]').setValue('ticket 4412');
    await wrapper.find('[data-testid="privacy-reveal-minutes-input"]').setValue(9999);
    await wrapper.find('[data-testid="privacy-reveal-form"]').trigger('submit');
    await settle();

    expect((bodies[0] as { minutes: number }).minutes).toBe(60);
  });

  it('reports a failure instead of leaving the operator to guess', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
      init?.method === 'POST'
        ? Promise.resolve(
            new Response(
              JSON.stringify({ success: false, error: { message: 'Reason too short' } }),
              {
                status: 400,
              },
            ),
          )
        : envelope({ grant: null }),
    );

    const wrapper = mount(PrivacyReveal, { props: { privacy: MASKED, canReveal: true } });
    await settle();
    await wrapper.find('[data-testid="privacy-reveal-ask"]').trigger('click');
    await wrapper.find('[data-testid="privacy-reveal-reason-input"]').setValue('ticket 4412');
    await wrapper.find('[data-testid="privacy-reveal-form"]').trigger('submit');
    await settle();

    expect(wrapper.find('[data-testid="privacy-reveal-failure"]').exists()).toBe(true);
    expect(wrapper.emitted('changed')).toBeUndefined();
  });
});

describe('a window already in force', () => {
  it('picks up a grant opened elsewhere and asks the parent to reveal', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => envelope({ grant: grant() }));
    const wrapper = mount(PrivacyReveal, { props: { privacy: MASKED, canReveal: true } });
    await settle();
    // The operator is already authorised; making them request a second grant to
    // see what they may already see would be theatre, and would double-count in
    // the audit trail.
    expect(wrapper.emitted('changed')?.at(-1)).toEqual([true]);
  });

  it('shows the countdown and the reason on record while revealed', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => envelope({ grant: grant() }));
    const wrapper = mount(PrivacyReveal, {
      props: { privacy: { masked: false, notice: null }, canReveal: true },
    });
    await settle();
    expect(wrapper.find('[data-testid="privacy-reveal-state"]').text()).toContain('Revealed');
    expect(wrapper.find('[data-testid="privacy-reveal-countdown"]').text()).toMatch(
      /\d+m \d+s left/,
    );
    expect(wrapper.find('[data-testid="privacy-reveal-grant-reason"]').text()).toContain(
      'ticket 4412',
    );
  });

  it('closes the window on request and tells the parent to re-mask', async () => {
    const methods: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      methods.push(init?.method ?? 'GET');
      return init?.method === 'DELETE' ? envelope({ revoked: true }) : envelope({ grant: grant() });
    });

    const wrapper = mount(PrivacyReveal, {
      props: { privacy: { masked: false, notice: null }, canReveal: true },
    });
    await settle();
    await wrapper.find('[data-testid="privacy-reveal-revoke"]').trigger('click');
    await settle();

    expect(methods).toContain('DELETE');
    expect(wrapper.emitted('changed')?.at(-1)).toEqual([false]);
  });

  it('does not treat an already-expired grant as live', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => envelope({ grant: grant(-1000) }));
    const wrapper = mount(PrivacyReveal, { props: { privacy: MASKED, canReveal: true } });
    await settle();
    expect(wrapper.emitted('changed')).toBeUndefined();
    // Still offers the control, because asking again is the correct next step.
    expect(wrapper.find('[data-testid="privacy-reveal-ask"]').exists()).toBe(true);
  });
});
