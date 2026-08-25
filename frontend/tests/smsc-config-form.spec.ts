import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import SmscConfigForm from '../src/components/SmscConfigForm.vue';

/**
 * The form exists because 32 of 38 settable SMSC fields had no control at all,
 * so what is tested here is the properties that keep it that way:
 *
 *  - the deep settings are REACHABLE, not merely present in the source;
 *  - a field that applies to one driver is hidden for the others, which is the
 *    thing a config file cannot do and the reason this is easier than one;
 *  - an untouched numeric stays ABSENT rather than becoming a default, because
 *    a rendered directive and an omitted one are different instructions;
 *  - the secret reference resolves to a named environment variable on screen,
 *    which is the step that used to be invisible.
 */
const stubFetch = (payload: unknown, ok = true) =>
  vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(ok ? { success: true, data: payload } : payload), {
        status: ok ? 200 : 500,
      }),
    ),
  );

const factory = (modelValue: Record<string, unknown> = { type: 'smpp' }) => {
  const wrapper = mount(SmscConfigForm, {
    props: {
      modelValue,
      mode: 'create' as const,
      testid: 'f',
      'onUpdate:modelValue': (next: Record<string, unknown>) =>
        wrapper.setProps({ modelValue: next }),
    },
  });
  return wrapper;
};

describe('SmscConfigForm', () => {
  it('shows only the settings that apply to the chosen driver', async () => {
    const wrapper = factory({ type: 'smpp' });
    // SMPP has a bind mode and a system id; it has no send URL.
    expect(wrapper.find('[data-testid="f-bindMode"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="f-systemId"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="f-sendUrl"]').exists()).toBe(false);

    await wrapper.setProps({ modelValue: { type: 'http' } });
    expect(wrapper.find('[data-testid="f-sendUrl"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="f-bindMode"]').exists()).toBe(false);

    // A fake SMSC reaches no carrier, so it has no credentials at all.
    await wrapper.setProps({ modelValue: { type: 'fake' } });
    expect(wrapper.find('[data-testid="f-credentialSecretRef"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="f-host"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="f-port"]').exists()).toBe(true);
  });

  it('reveals the carrier-sheet settings behind their group, not by default', async () => {
    const wrapper = factory({ type: 'smpp' });
    // Closed to begin with: thirty-eight inputs at once would be worse than the
    // config file this replaces.
    expect(wrapper.find('[data-testid="f-addressRange"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="f-sourceAddrTon"]').exists()).toBe(false);

    await wrapper.get('[data-testid="f-toggle-addressing"]').trigger('click');
    expect(wrapper.find('[data-testid="f-addressRange"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="f-sourceAddrTon"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="f-systemType"]').exists()).toBe(true);

    await wrapper.get('[data-testid="f-toggle-throughput"]').trigger('click');
    expect(wrapper.find('[data-testid="f-windowSize"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="f-keepaliveSeconds"]').exists()).toBe(true);

    await wrapper.get('[data-testid="f-toggle-routing"]').trigger('click');
    expect(wrapper.find('[data-testid="f-allowedPrefixes"]').exists()).toBe(true);
  });

  it('names the engine directive on every setting, so the manual is searchable', async () => {
    const wrapper = factory({ type: 'smpp' });
    await wrapper.get('[data-testid="f-toggle-addressing"]').trigger('click');
    const text = wrapper.text();
    for (const directive of [
      'smsc-id',
      'address-range',
      'source-addr-ton',
      'interface-version',
      'system-type',
      'alt-charset',
    ])
      expect(text).toContain(directive);
  });

  it('leaves a cleared number unset rather than sending a default', async () => {
    const wrapper = factory({ type: 'smpp', windowSize: 10 });
    await wrapper.get('[data-testid="f-toggle-throughput"]').trigger('click');
    await wrapper.get('[data-testid="f-windowSize"]').setValue('');
    // null, not 0 and not 10: an omitted directive lets the engine's own
    // default apply, which is a different instruction from pinning a number.
    expect(wrapper.props('modelValue').windowSize).toBeNull();
  });

  it('types a routing list as the engine spells it, and stores it as an array', async () => {
    const wrapper = factory({ type: 'smpp' });
    await wrapper.get('[data-testid="f-toggle-routing"]').trigger('click');
    await wrapper.get('[data-testid="f-allowedPrefixes"]').setValue('256772; 256782 ;');
    // Semicolons so a value pastes straight from a carrier's instructions;
    // blanks dropped so a trailing separator is not a member.
    expect(wrapper.props('modelValue').allowedPrefixes).toEqual(['256772', '256782']);
  });

  it('names the environment variable a secret reference resolves to, and whether it is set', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch({
        references: [
          {
            reference: 'secret://carrier/mtn-ug',
            envName: 'CARRIER_MTN_UG',
            present: false,
            valid: true,
          },
        ],
      }),
    );
    const wrapper = factory({ type: 'smpp', credentialSecretRef: 'secret://carrier/mtn-ug' });
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="f-credentialSecretRef-status"]').exists()).toBe(true),
    );
    const status = wrapper.get('[data-testid="f-credentialSecretRef-status"]').text();
    // The derivation, which previously lived only in the backend: an operator
    // invented a reference and had no way to learn which variable to set.
    expect(status).toContain('CARRIER_MTN_UG');
    expect(status).toContain('not set');
    vi.unstubAllGlobals();
  });

  it('says the check failed rather than leaving the reference silently unverified', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network down'))),
    );
    const wrapper = factory({ type: 'smpp', credentialSecretRef: 'secret://carrier/x' });
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="f-secret-error"]').exists()).toBe(true),
    );
    // And it must not become a gate: the operator can still save.
    expect(wrapper.get('[data-testid="f-secret-error"]').text()).toContain('not a gate');
    vi.unstubAllGlobals();
  });

  it('fixes the engine id once a connection exists, because routes reference it', async () => {
    const wrapper = mount(SmscConfigForm, {
      props: { modelValue: { type: 'smpp', engineId: 'mtn-ug' }, mode: 'edit', testid: 'e' },
    });
    await nextTick();
    expect(wrapper.get('[data-testid="e-engineId"]').attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('cannot be changed');
  });
});
