import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import DataState from '../src/components/DataState.vue';
import { describeState, displayValue, isMeasured } from '../src/utils/data-state';

/**
 * §17's first rule — "do not show zero values that look real" — is the reason
 * this module exists. A tile bound to `count ?? 0` renders a confident `0`
 * before its request resolves, and `0 queued` is a plausible reading for a
 * healthy gateway. The operator cannot tell that apart from a measurement.
 */
describe('displayValue', () => {
  it('refuses to render a zero that has not been measured', () => {
    expect(displayValue(0, 'loading')).toBe('—');
    expect(displayValue(0, 'error')).toBe('—');
    expect(displayValue(0, 'permission-denied')).toBe('—');
  });

  it('renders a genuine zero once it IS a measurement', () => {
    // The distinction is the whole point: an empty queue is real news.
    expect(displayValue(0, 'live')).toBe('0');
    expect(displayValue(0, 'empty')).toBe('0');
  });

  it('passes stale and partial figures through rather than blanking the screen', () => {
    // There is a real measurement behind both; hiding it is the worse failure.
    expect(displayValue(1234, 'stale')).toBe('1,234');
    expect(displayValue(42, 'partial')).toBe('42');
  });

  it('renders absent and non-finite values as the no-value dash', () => {
    expect(displayValue(null, 'live')).toBe('—');
    expect(displayValue(undefined, 'live')).toBe('—');
    expect(displayValue(Number.NaN, 'live')).toBe('—');
    expect(displayValue(Number.POSITIVE_INFINITY, 'live')).toBe('—');
  });

  it('applies a caller format only to measured numbers', () => {
    const percent = (value: number) => `${value.toFixed(1)}%`;
    expect(displayValue(98.72, 'live', percent)).toBe('98.7%');
    expect(displayValue(98.72, 'loading', percent)).toBe('—');
  });

  it('reports which states carry a measurement', () => {
    expect(isMeasured('live')).toBe(true);
    expect(isMeasured('stale')).toBe(true);
    expect(isMeasured('loading')).toBe(false);
  });
});

describe('describeState', () => {
  it('names the subject in an empty state instead of saying "no data"', () => {
    expect(describeState('empty', { subject: 'alert instances' }).title).toBe(
      'No alert instances recorded.',
    );
  });

  it('states the age of a stale reading and that it is historical', () => {
    const copy = describeState('stale', { subject: 'bind states', ageSeconds: 240 });
    expect(copy.title).toContain('240s ago');
    expect(copy.detail).toMatch(/historical/);
    // An operator must not be able to miss it.
    expect(copy.role).toBe('alert');
  });

  it('lists what is missing in a partial state and confirms the rest is real', () => {
    const copy = describeState('partial', {
      subject: 'dashboard panels',
      missing: ['queue depth', 'DLR latency'],
    });
    expect(copy.detail).toContain('queue depth, DLR latency');
    expect(copy.detail).toMatch(/read successfully/);
  });

  it('names the required permission without describing the data behind it', () => {
    const copy = describeState('permission-denied', {
      subject: 'audit entries',
      permission: 'audit.view',
    });
    expect(copy.detail).toContain('audit.view');
    expect(copy.title).not.toMatch(/\d/);
  });

  it('does not treat an unknown-age stale reading as zero seconds old', () => {
    expect(describeState('stale', { subject: 'x', ageSeconds: null }).title).toContain(
      'some time ago',
    );
  });
});

describe('DataState', () => {
  const mountState = (props: Record<string, unknown>) =>
    mount(DataState, {
      props: { subject: 'alerts', ...props } as never,
      slots: { default: '<p class="content">real content</p>' },
    });

  it('renders a skeleton while loading, and hides the content', () => {
    const wrapper = mountState({ state: 'loading', skeleton: 'table', skeletonRows: 3 });
    expect(wrapper.findAll('.skeleton-row')).toHaveLength(3);
    expect(wrapper.find('.content').exists()).toBe(false);
    // The visual skeleton is decorative; the state still has to be announced.
    expect(wrapper.get('.sr-only').text()).toBe('Loading alerts…');
  });

  it('shows content ALONGSIDE the banner when data is stale or partial', () => {
    for (const state of ['stale', 'partial'] as const) {
      const wrapper = mountState({ state });
      expect(wrapper.find('.content').exists()).toBe(true);
      expect(wrapper.get('.data-state').classes()).toContain('data-state-banner');
    }
  });

  it('replaces content entirely when there is nothing truthful to show', () => {
    for (const state of ['loading', 'empty', 'error', 'permission-denied'] as const) {
      const wrapper = mountState({ state });
      expect(wrapper.find('.content').exists()).toBe(false);
    }
  });

  it('renders nothing at all when live, so the caller wraps rather than branches', () => {
    const wrapper = mountState({ state: 'live' });
    expect(wrapper.find('.data-state').exists()).toBe(false);
    expect(wrapper.find('.content').exists()).toBe(true);
  });

  it('marks states an operator must not miss as assertive alerts', () => {
    expect(mountState({ state: 'error' }).get('.data-state').attributes('role')).toBe('alert');
    expect(mountState({ state: 'empty' }).get('.data-state').attributes('role')).toBe('status');
  });

  it('offers a retry only on error, and only when the caller supplied one', () => {
    const onRetry = vi.fn();
    const wrapper = mountState({ state: 'error', onRetry });
    wrapper.get('.ghost-button').trigger('click');
    expect(onRetry).toHaveBeenCalled();
    expect(mountState({ state: 'empty', onRetry }).find('.ghost-button').exists()).toBe(false);
  });
});
