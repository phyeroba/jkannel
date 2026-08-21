import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import TabStrip from '../src/components/TabStrip.vue';

const TABS = [
  { id: 'one', label: 'First' },
  { id: 'two', label: 'Second', count: 4 },
  { id: 'three', label: 'Third' },
];

const mountStrip = (modelValue = 'one') =>
  mount(TabStrip, { props: { tabs: TABS, modelValue, label: 'Example tabs', testid: 'demo' } });

/**
 * The kit's Tabs renders the ARIA roles and stops there, which is worse than
 * rendering none: once an element claims to be a tab, screen readers and
 * keyboard users expect a single tab stop and arrow-key navigation. These tests
 * exist because that promise is easy to break silently — the component looks
 * identical either way.
 */
describe('TabStrip', () => {
  it('puts only the selected tab in the document tab order', () => {
    const wrapper = mountStrip('two');
    const tabs = wrapper.findAll('[role="tab"]');
    expect(tabs.map((tab) => tab.attributes('tabindex'))).toEqual(['-1', '0', '-1']);
    expect(tabs.map((tab) => tab.attributes('aria-selected'))).toEqual(['false', 'true', 'false']);
  });

  it('labels each tab with the panel it controls', () => {
    const wrapper = mountStrip();
    expect(wrapper.get('[data-testid="demo-one"]').attributes('aria-controls')).toBe(
      'demo-panel-one',
    );
  });

  it('moves with the arrow keys and wraps at both ends', async () => {
    const wrapper = mountStrip('one');
    await wrapper.get('[data-testid="demo-one"]').trigger('keydown', { key: 'ArrowRight' });
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['two']);

    // Wrapping backwards off the first tab lands on the last, not nowhere.
    await wrapper.get('[data-testid="demo-one"]').trigger('keydown', { key: 'ArrowLeft' });
    expect(wrapper.emitted('update:modelValue')?.[1]).toEqual(['three']);
  });

  it('jumps to the ends with Home and End', async () => {
    const wrapper = mountStrip('two');
    await wrapper.get('[data-testid="demo-two"]').trigger('keydown', { key: 'End' });
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['three']);
    await wrapper.get('[data-testid="demo-two"]').trigger('keydown', { key: 'Home' });
    expect(wrapper.emitted('update:modelValue')?.[1]).toEqual(['one']);
  });

  it('ignores keys that are not navigation, so typing is not swallowed', async () => {
    const wrapper = mountStrip();
    await wrapper.get('[data-testid="demo-one"]').trigger('keydown', { key: 'a' });
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('does not re-emit when the selected tab is clicked again', async () => {
    const wrapper = mountStrip('one');
    await wrapper.get('[data-testid="demo-one"]').trigger('click');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('renders a count only where one was supplied', () => {
    const wrapper = mountStrip();
    expect(wrapper.get('[data-testid="demo-two"]').text()).toContain('4');
    // A tab with no count must not render a stray zero.
    expect(wrapper.get('[data-testid="demo-one"]').text().trim()).toBe('First');
  });
});
