import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/session', () => ({
  session: ref({ displayName: 'Amina Operator', permissions: new Set(['smsc.view']) }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import SmppErrorsView from '../src/views/SmppErrorsView.vue';

const envelope = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));

const NOTE =
  'Guidance is a suggested check, not a diagnosis. A command status says what the carrier ' +
  'refused, never why. Codes in 0x400-0x4FF are vendor-specific and only the carrier can define them.';

const THROTTLED = {
  code: 0x58,
  name: 'ESME_RTHROTTLED',
  meaning: 'Messages are being sent faster than this account is allowed to send them.',
  guidance: 'Compare observed throughput against the contracted rate.',
  retryable: true,
};
const BAD_PASSWORD = {
  code: 0x0e,
  name: 'ESME_RINVPASWD',
  meaning: 'The password was wrong.',
  guidance: 'Check the credential this SMSC resolves.',
  retryable: false,
};

/** What the decoder returns for a code it has no description for. */
const VENDOR_UNKNOWN = {
  code: 0x401,
  name: '0x00000401',
  meaning:
    'A vendor-specific status. The SMPP specification reserves this range for the carrier to define.',
  guidance:
    'Only the carrier can say what this means — check their integration documentation for 0x00000401.',
  retryable: false,
};
const OUT_OF_RANGE_UNKNOWN = {
  code: 0x777,
  name: '0x00000777',
  meaning: 'This status is not one JKANNEL has a description for.',
  guidance: "Look 0x00000777 up in the carrier's documentation.",
  retryable: false,
};

const mountView = async (lookups: Record<string, unknown> = {}) => {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      calls.push(url);
      const single = url.match(/\/diagnostics\/smpp-statuses\/(.+)$/);
      if (single) {
        const found = lookups[decodeURIComponent(single[1])];
        return found
          ? envelope(found)
          : Promise.resolve(
              new Response(JSON.stringify({ success: false, message: 'nope' }), { status: 400 }),
            );
      }
      return envelope({ statuses: [BAD_PASSWORD, THROTTLED], note: NOTE });
    }),
  );
  const wrapper = mount(SmppErrorsView);
  await vi.waitFor(() => expect(wrapper.find('[data-state="loading"]').exists()).toBe(false));
  return { wrapper, calls };
};

describe('SMPP Errors — guidance is labelled as guidance', () => {
  it('renders the API note verbatim under its own heading', async () => {
    const { wrapper } = await mountView();
    expect(wrapper.get('[data-testid="smpp-note"]').text()).toBe(NOTE);
    expect(wrapper.get('[data-testid="smpp-note-panel"]').text()).toContain(
      'Guidance, not a diagnosis',
    );
  });

  it('labels the guidance column as guidance, not as a cause', async () => {
    const { wrapper } = await mountView();
    const headings = wrapper
      .get('[data-testid="smpp-table"]')
      .findAll('th')
      .map((th) => th.text().toLowerCase());
    expect(headings.some((heading) => heading.includes('guidance'))).toBe(true);
    expect(headings.some((heading) => heading.includes('cause'))).toBe(false);
    expect(headings.some((heading) => heading.includes('diagnosis'))).toBe(false);
  });

  it('says up front that it has no counts, rates or trend, because nothing records them', async () => {
    const { wrapper } = await mountView();
    const scope = wrapper.get('[data-testid="smpp-scope"]').text();
    expect(scope).toContain('no counts, no rates, no first-seen or last-seen and no trend');
    expect(scope).toContain('never happened');
    const headings = wrapper
      .get('[data-testid="smpp-table"]')
      .findAll('th')
      .map((th) => th.text().toLowerCase());
    // No column exists for a figure this build cannot produce.
    for (const forbidden of ['count', 'rate', 'first seen', 'last seen', 'trend'])
      expect(headings.some((heading) => heading.includes(forbidden))).toBe(false);
  });
});

describe('SMPP Errors — the reference table', () => {
  it('shows both notations and says in words whether a retry helps', async () => {
    const { wrapper } = await mountView();
    const row = wrapper.get('[data-testid="smpp-row-88"]').text();
    expect(row).toContain('0x00000058 · 88');
    expect(row).toContain('ESME_RTHROTTLED');
    expect(row).toContain('retry may succeed');
    expect(wrapper.get('[data-testid="smpp-row-14"]').text()).toContain('retrying will not help');
  });

  it('filters by name, by decimal code and by hex code', async () => {
    const { wrapper } = await mountView();
    const search = wrapper.get('[data-testid="smpp-search"]');

    await search.setValue('throttl');
    expect(wrapper.find('[data-testid="smpp-row-88"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="smpp-row-14"]').exists()).toBe(false);

    await search.setValue('0x0e');
    expect(wrapper.find('[data-testid="smpp-row-14"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="smpp-row-88"]').exists()).toBe(false);

    await search.setValue('88');
    expect(wrapper.find('[data-testid="smpp-row-88"]').exists()).toBe(true);

    await search.setValue('nothing-like-this');
    expect(wrapper.get('[data-testid="smpp-no-match"]').text()).toContain(
      'only the carrier can define it',
    );
  });

  it('explains why filtering in the browser is honest here', async () => {
    const { wrapper } = await mountView();
    expect(wrapper.get('[data-testid="smpp-search-note"]').text()).toContain(
      'returns the complete decoder in one response',
    );
  });
});

describe('SMPP Errors — looking a code up', () => {
  it('accepts hex and decimal and sends what was typed', async () => {
    const { wrapper, calls } = await mountView({ '0x58': THROTTLED, '88': THROTTLED });
    await wrapper.get('[data-testid="smpp-lookup-input"]').setValue('0x58');
    await wrapper.get('[data-testid="smpp-lookup-submit"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="smpp-lookup-result"]').exists()).toBe(true),
    );
    expect(calls.some((url) => url.endsWith('/diagnostics/smpp-statuses/0x58'))).toBe(true);
    expect(wrapper.get('[data-testid="smpp-lookup-name"]').text()).toBe('ESME_RTHROTTLED');
    expect(wrapper.get('[data-testid="smpp-lookup-code"]').text()).toBe('0x00000058 · 88');
    expect(wrapper.get('[data-testid="smpp-lookup-guidance"]').text()).toBe(THROTTLED.guidance);
  });

  it('rejects a symbolic name locally instead of showing a bare 400', async () => {
    const { wrapper, calls } = await mountView();
    const before = calls.length;
    await wrapper.get('[data-testid="smpp-lookup-input"]').setValue('ESME_RTHROTTLED');
    await wrapper.get('[data-testid="smpp-lookup-submit"]').trigger('click');
    expect(wrapper.get('[data-testid="smpp-lookup-error"]').text()).toContain('88 in decimal');
    // No request was made, so no unexplained 400 reaches the operator.
    expect(calls.length).toBe(before);
  });

  it('renders an unknown vendor code by its hex name and refuses to interpret it', async () => {
    const { wrapper } = await mountView({ '0x401': VENDOR_UNKNOWN });
    await wrapper.get('[data-testid="smpp-lookup-input"]').setValue('0x401');
    await wrapper.get('[data-testid="smpp-lookup-submit"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="smpp-lookup-unknown"]').exists()).toBe(true),
    );
    // The hex value IS the name; nothing plausible-sounding is invented for it.
    expect(wrapper.get('[data-testid="smpp-lookup-name"]').text()).toBe('0x00000401');
    const unknown = wrapper.get('[data-testid="smpp-lookup-unknown"]').text();
    expect(unknown).toContain('JKANNEL has no description for this status');
    expect(unknown).toContain('only the carrier can say what this means');
    expect(unknown).toContain('0x00000401');
  });

  it('says the same thing for an unknown code outside the vendor range', async () => {
    const { wrapper } = await mountView({ '0x777': OUT_OF_RANGE_UNKNOWN });
    await wrapper.get('[data-testid="smpp-lookup-input"]').setValue('0x777');
    await wrapper.get('[data-testid="smpp-lookup-submit"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="smpp-lookup-unknown"]').exists()).toBe(true),
    );
    const unknown = wrapper.get('[data-testid="smpp-lookup-unknown"]').text();
    expect(unknown).toContain('only the carrier can say what this means');
    expect(unknown).toContain('rather than assuming it matches a nearby standard code');
  });

  it('does not mark a known code as unknown', async () => {
    const { wrapper } = await mountView({ '88': THROTTLED });
    await wrapper.get('[data-testid="smpp-lookup-input"]').setValue('88');
    await wrapper.get('[data-testid="smpp-lookup-submit"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="smpp-lookup-result"]').exists()).toBe(true),
    );
    expect(wrapper.find('[data-testid="smpp-lookup-unknown"]').exists()).toBe(false);
  });
});
