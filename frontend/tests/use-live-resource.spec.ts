import { mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useLiveResource, type LiveResourceOptions } from '../src/composables/useLiveResource';

/**
 * Hosts the composable in a trivial component so the onMounted/onUnmounted
 * hooks it registers behave exactly as they do in a real view.
 */
const host = (load: () => unknown, options: LiveResourceOptions = {}) => {
  let api!: ReturnType<typeof useLiveResource>;
  const component = defineComponent({
    setup() {
      api = useLiveResource(load, options);
      return () => h('div');
    },
  });
  const wrapper = mount(component);
  return { wrapper, api };
};

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('useLiveResource', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads immediately, then polls on the configured interval', async () => {
    const load = vi.fn().mockResolvedValue(undefined);
    const { wrapper, api } = host(load, { intervalSeconds: 0.3 });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(2));
    expect(api.lastRefreshedAt.value).not.toBe('');
    wrapper.unmount();
  });

  it('honours immediate:false and enabled:false — no load and no timer', async () => {
    const load = vi.fn().mockResolvedValue(undefined);
    const { wrapper } = host(load, { intervalSeconds: 0.3, immediate: false, enabled: false });
    await settle(900);
    expect(load).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('never overlaps two loads of the same resource', async () => {
    let release!: () => void;
    const load = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { wrapper, api } = host(load, { intervalSeconds: 0.3 });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    // Ticks keep firing while the first load hangs; none of them start a second.
    await settle(900);
    expect(load).toHaveBeenCalledTimes(1);
    expect(api.refreshing.value).toBe(true);
    // Stop the timer first, so the flag settling to false is not immediately
    // flipped back by the next tick.
    api.autoRefresh.value = false;
    await wrapper.vm.$nextTick();
    release();
    await vi.waitFor(() => expect(api.refreshing.value).toBe(false));
    expect(load).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('drops ticks while the tab is hidden and loads once when it becomes visible', async () => {
    const load = vi.fn().mockResolvedValue(undefined);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const { wrapper } = host(load, { intervalSeconds: 0.3, immediate: false });
    await settle(900);
    expect(load).not.toHaveBeenCalled();

    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    wrapper.unmount();
  });

  it('suppresses automatic ticks while pauseWhen is true but still allows a manual refresh', async () => {
    const load = vi.fn().mockResolvedValue(undefined);
    let paused = true;
    const { wrapper, api } = host(load, {
      intervalSeconds: 0.3,
      immediate: false,
      pauseWhen: () => paused,
    });
    await settle(900);
    expect(load).not.toHaveBeenCalled();

    await api.refreshNow(true);
    expect(load).toHaveBeenCalledTimes(1);

    paused = false;
    await vi.waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(1));
    wrapper.unmount();
  });

  it('rebuilds exactly one timer when the toggle or interval changes, and clears it on unmount', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const load = vi.fn().mockResolvedValue(undefined);
    const { wrapper, api } = host(load, { intervalSeconds: 0.3, immediate: false });
    await vi.waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(0));

    api.autoRefresh.value = false;
    await wrapper.vm.$nextTick();
    const whileOff = load.mock.calls.length;
    await settle(900);
    expect(load).toHaveBeenCalledTimes(whileOff);

    api.autoRefresh.value = true;
    api.intervalSeconds.value = 0.01;
    await wrapper.vm.$nextTick();
    await vi.waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(whileOff));

    wrapper.unmount();
    expect(clearSpy).toHaveBeenCalled();
    const afterUnmount = load.mock.calls.length;
    await settle(900);
    expect(load).toHaveBeenCalledTimes(afterUnmount);
  });
});
