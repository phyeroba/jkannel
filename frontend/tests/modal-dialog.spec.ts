import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import ModalDialog from '../src/components/ModalDialog.vue';

/**
 * The dialog is the console's answer to "clicking Add must open a pop-up", so
 * what is tested here is the behaviour that separates a real modal from a div
 * that happens to be centred:
 *
 *  - it is teleported OUT of the panel that opened it, or it inherits that
 *    panel's stacking context and renders behind the next one;
 *  - Escape and the backdrop close it, but a click inside does not — a form
 *    that vanishes when you click a label is worse than no dialog;
 *  - focus moves in, stays in, and comes back, or a keyboard user tabs into
 *    the register behind the scrim and cannot see where they are.
 *
 * The geometry is not tested: it comes from the vendored `components.css` and
 * asserting on it here would only restate the design system to itself.
 */
const factory = (props: Record<string, unknown> = {}) =>
  mount(ModalDialog, {
    attachTo: document.body,
    props: { open: true, title: 'New carrier', ...props },
    slots: {
      default: '<input data-testid="first" /><input data-testid="last" />',
      footer: '<button data-testid="save">Save</button>',
    },
  });

const card = () => document.body.querySelector('[role="dialog"]');
const backdrop = () => document.body.querySelector('.dialog-backdrop');

describe('ModalDialog', () => {
  it('renders outside the component, on a backdrop, as a labelled modal', () => {
    const wrapper = factory();
    // Teleported: findable in the document, absent from the component subtree.
    expect(wrapper.find('.dialog-backdrop').exists()).toBe(false);
    expect(backdrop()).not.toBeNull();
    expect(card()?.getAttribute('aria-modal')).toBe('true');
    expect(card()?.getAttribute('aria-label')).toBe('New carrier');
    expect(card()?.querySelector('h2')?.textContent).toBe('New carrier');
    expect(document.body.querySelector('[data-testid="save"]')).not.toBeNull();
    wrapper.unmount();
  });

  it('is absent entirely when closed, rather than hidden', () => {
    const wrapper = factory({ open: false });
    expect(backdrop()).toBeNull();
    wrapper.unmount();
  });

  it('closes on Escape, on the backdrop and on Close — but not on a click inside', () => {
    const wrapper = factory();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(wrapper.emitted('close')).toHaveLength(1);

    (card() as HTMLElement).click();
    expect(wrapper.emitted('close')).toHaveLength(1); // still one: inside does not close

    (backdrop() as HTMLElement).click();
    expect(wrapper.emitted('close')).toHaveLength(2);

    (document.body.querySelector('[data-testid="modal-dialog-close"]') as HTMLElement).click();
    expect(wrapper.emitted('close')).toHaveLength(3);
    wrapper.unmount();
  });

  it('moves focus to the first field and keeps Tab inside the dialog', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();

    const wrapper = mount(ModalDialog, {
      attachTo: document.body,
      props: { open: false, title: 'New carrier' },
      slots: {
        default: '<input data-testid="first" /><input data-testid="last" />',
        footer: '<button data-testid="save">Save</button>',
      },
    });
    await wrapper.setProps({ open: true });
    await nextTick();

    // The first field, so a create form is typeable without a Tab first.
    expect((document.activeElement as HTMLElement)?.dataset.testid).toBe('first');

    // Tab off the LAST control wraps to the first, rather than escaping into
    // the register that is still sitting behind the scrim, still focusable and
    // no longer visible.
    const save = document.body.querySelector('[data-testid="save"]') as HTMLElement;
    save.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    expect((document.activeElement as HTMLElement)?.dataset.testid).toBe('modal-dialog-close');

    // And Shift+Tab off the first wraps backwards to the last.
    (document.body.querySelector('[data-testid="modal-dialog-close"]') as HTMLElement).focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }));
    expect((document.activeElement as HTMLElement)?.dataset.testid).toBe('save');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(wrapper.emitted('close')).toHaveLength(1);

    // Closing hands focus back to whatever opened it.
    await wrapper.setProps({ open: false });
    expect(document.activeElement).toBe(opener);
    wrapper.unmount();
    opener.remove();
  });

  it('stops listening for Escape once unmounted', () => {
    const wrapper = factory();
    wrapper.unmount();
    // No dialog left in the document, and no handler left to fire into a
    // destroyed component.
    expect(backdrop()).toBeNull();
    expect(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
    ).not.toThrow();
  });
});
