import { onMounted, onUnmounted, ref, watch, type Ref } from 'vue';

export interface LiveResourceOptions {
  /** Seconds between polls. Also the initial value of the exposed `intervalSeconds` ref. */
  intervalSeconds?: number;
  /** Whether polling starts on mount. */
  enabled?: boolean;
  /** Run one load as soon as the component mounts. Defaults to true. */
  immediate?: boolean;
  /**
   * Extra "not now" guard evaluated before every automatic tick — used to hold
   * polling off while a bulk action or an open editor would be disturbed by a
   * grid that reloads underneath the operator. Manual refreshes ignore it.
   */
  pauseWhen?: () => boolean;
}

export interface LiveResource {
  /** Bound to the On/Off control; toggling restarts (or clears) the timer. */
  autoRefresh: Ref<boolean>;
  /** Bound to the interval select; changing it restarts the timer. */
  intervalSeconds: Ref<number>;
  /** True while a load is in flight — also the overlap guard. */
  refreshing: Ref<boolean>;
  /** Local time string of the last completed load, or '' before the first one. */
  lastRefreshedAt: Ref<string>;
  /** Runs the loader. `refreshNow(true)` is a manual refresh and skips every guard. */
  refreshNow: (manual?: boolean) => Promise<void>;
  /** Imperative timer control, for callers that start polling after some setup. */
  start: () => void;
  stop: () => void;
}

/**
 * Visibility-aware polling for a single loader function — the one live-update
 * mechanism in the console, factored out of LiveQueueView so that every screen
 * behaves identically.
 *
 * Four guarantees, all of which an ad-hoc `setInterval` in a view tends to miss:
 *
 *  - **No overlap.** A tick is dropped while the previous load is still in
 *    flight, so a slow endpoint cannot queue up a backlog of requests.
 *  - **No work while hidden.** Ticks are dropped when `document.hidden` is true;
 *    a `visibilitychange` listener fires one immediate load when the operator
 *    comes back, so the screen is never stale on return.
 *  - **Caller-defined pauses.** `pauseWhen()` suppresses automatic ticks (an
 *    open dialog, a bulk action) without stopping the timer.
 *  - **Deterministic cleanup.** The interval is cleared and the listener removed
 *    on unmount, and the timer is rebuilt whenever the toggle or interval
 *    changes, so exactly one timer exists at any moment.
 *
 * A manual `refreshNow(true)` bypasses the hidden and pause guards but still
 * respects the overlap guard, because two concurrent loads of the same resource
 * can resolve out of order.
 */
export function useLiveResource(
  load: () => unknown,
  options: LiveResourceOptions = {},
): LiveResource {
  const autoRefresh = ref(options.enabled ?? true);
  const intervalSeconds = ref(options.intervalSeconds ?? 15);
  const refreshing = ref(false);
  const lastRefreshedAt = ref('');
  let timer: ReturnType<typeof setInterval> | undefined;

  async function refreshNow(manual = false) {
    if (refreshing.value) return;
    if (!manual && typeof document !== 'undefined' && document.hidden) return;
    if (!manual && options.pauseWhen?.()) return;
    refreshing.value = true;
    try {
      await load();
      lastRefreshedAt.value = new Date().toLocaleTimeString();
    } finally {
      refreshing.value = false;
    }
  }

  function stop() {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  function start() {
    stop();
    if (!autoRefresh.value) return;
    // 250 ms floor: a misconfigured 0 must not become a busy loop.
    timer = setInterval(
      () => {
        void refreshNow();
      },
      Math.max(250, intervalSeconds.value * 1000),
    );
  }

  function onVisibilityChange() {
    if (typeof document !== 'undefined' && !document.hidden && autoRefresh.value) void refreshNow();
  }

  watch([autoRefresh, intervalSeconds], () => start());

  onMounted(() => {
    if (options.immediate !== false) void refreshNow(true);
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', onVisibilityChange);
    start();
  });

  onUnmounted(() => {
    stop();
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', onVisibilityChange);
  });

  return { autoRefresh, intervalSeconds, refreshing, lastRefreshedAt, refreshNow, start, stop };
}
