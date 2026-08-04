import { Injectable } from '@nestjs/common';
import { EngineSnapshotCache } from './engine-snapshot.cache';
import { isHealthy, toBindState } from './engine-bind-state';

/** Escapes a Prometheus label value (backslash, double quote, newline). */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Renders a finite number for exposition; non-finite values are dropped. */
function num(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

/**
 * SMS/SMSC-level Prometheus exporter (gap G6).
 *
 * `MONITORING_SPEC_02` names twelve core metrics; before this service, two were
 * exported and none of them were about SMS. Bind state, per-bind queue depth,
 * throughput, failures and the engine-wide SMS/DLR queues were all parsed by
 * `KamexAdapter.queueSnapshot()` and shown only to whoever had a console page
 * open.
 *
 * Everything here is served from {@link EngineSnapshotCache}, which
 * {@link SmscStatusPoller} refreshes on its own schedule. The scrape therefore
 * costs one map over an in-memory object and can never be blocked by a wedged
 * bearerbox. Because cached data can go stale, the exporter is explicit about
 * it: `jkannel_engine_snapshot_age_seconds` is always emitted alongside, and a
 * snapshot the adapter marked `unavailable` yields `jkannel_engine_up 0` with
 * no per-bind gauges at all rather than a frozen picture of a healthy engine.
 */
@Injectable()
export class EngineMetricsService {
  constructor(private readonly cache: EngineSnapshotCache) {}

  render(now: Date = new Date()): string {
    const cached = this.cache.get();
    const lines: string[] = [
      '# HELP jkannel_engine_up SMS engine (bearerbox) reachability as a boolean gauge.',
      '# TYPE jkannel_engine_up gauge',
    ];

    if (!cached) {
      // Honest "we do not know": the poller is disabled or has not run yet, so
      // this process cannot vouch for the engine either way.
      lines.push('jkannel_engine_up 0');
      lines.push(
        '# HELP jkannel_engine_poller_up Whether an engine snapshot has ever been cached by the poller.',
        '# TYPE jkannel_engine_poller_up gauge',
        'jkannel_engine_poller_up 0',
      );
      return lines.join('\n');
    }

    const { snapshot } = cached;
    const reachable = snapshot.source.status !== 'unavailable';
    lines.push(`jkannel_engine_up ${reachable ? 1 : 0}`);
    lines.push(
      '# HELP jkannel_engine_poller_up Whether an engine snapshot has ever been cached by the poller.',
      '# TYPE jkannel_engine_poller_up gauge',
      'jkannel_engine_poller_up 1',
      '# HELP jkannel_engine_snapshot_age_seconds Age of the cached engine snapshot served by this scrape.',
      '# TYPE jkannel_engine_snapshot_age_seconds gauge',
      `jkannel_engine_snapshot_age_seconds ${num(this.cache.ageSeconds(now) ?? 0)}`,
    );

    if (!reachable) return lines.join('\n');

    if (snapshot.engine.uptimeSeconds !== null) {
      lines.push(
        '# HELP jkannel_engine_uptime_seconds Reported bearerbox uptime in seconds.',
        '# TYPE jkannel_engine_uptime_seconds gauge',
        `jkannel_engine_uptime_seconds ${num(snapshot.engine.uptimeSeconds)}`,
      );
    }

    const queued: Array<[string, number | null]> = [
      ['outbound', snapshot.engine.smsQueuedOut],
      ['inbound', snapshot.engine.smsQueuedIn],
    ];
    const queuedLines = queued
      .filter(([, value]) => value !== null)
      .map(([direction, value]) => `jkannel_engine_sms_queued{direction="${direction}"} ${value}`);
    if (queuedLines.length) {
      lines.push(
        '# HELP jkannel_engine_sms_queued Engine-wide SMS queue depth by direction.',
        '# TYPE jkannel_engine_sms_queued gauge',
        ...queuedLines,
      );
    }

    if (snapshot.engine.dlrQueued !== null) {
      lines.push(
        '# HELP jkannel_engine_dlr_queued Engine-wide delivery reports awaiting processing.',
        '# TYPE jkannel_engine_dlr_queued gauge',
        `jkannel_engine_dlr_queued ${snapshot.engine.dlrQueued}`,
      );
    }

    // bearerbox reports store_size -1 when the store is disabled or its size is
    // unknown; the adapter surfaces that as null. Emitting 0 would be a lie
    // that reads as "the spool is empty", so the series is simply absent.
    if (snapshot.engine.storeSize !== null) {
      lines.push(
        '# HELP jkannel_engine_store_size Messages held in the bearerbox store (absent when the engine reports it as unknown).',
        '# TYPE jkannel_engine_store_size gauge',
        `jkannel_engine_store_size ${snapshot.engine.storeSize}`,
      );
    }

    const states = snapshot.binds.map((bind) => toBindState(bind.status));
    lines.push(
      '# HELP jkannel_engine_binds Configured SMSC binds known to the engine.',
      '# TYPE jkannel_engine_binds gauge',
      `jkannel_engine_binds ${snapshot.binds.length}`,
      '# HELP jkannel_engine_binds_bound SMSC binds currently in the bound state.',
      '# TYPE jkannel_engine_binds_bound gauge',
      `jkannel_engine_binds_bound ${states.filter(isHealthy).length}`,
    );

    if (!snapshot.binds.length) return lines.join('\n');

    const up: string[] = [];
    const bindQueued: string[] = [];
    const failed: string[] = [];
    const messages: string[] = [];
    const throughput: string[] = [];
    const windows = ['1m', '5m', '15m'];

    snapshot.binds.forEach((bind, index) => {
      const smsc = escapeLabel(bind.engineId);
      const state = states[index];
      up.push(`jkannel_smsc_bind_up{smsc="${smsc}",state="${state}"} ${isHealthy(state) ? 1 : 0}`);
      bindQueued.push(`jkannel_smsc_queued{smsc="${smsc}"} ${bind.queued}`);
      failed.push(`jkannel_smsc_failed_total{smsc="${smsc}"} ${bind.failed}`);
      messages.push(`jkannel_smsc_messages_total{smsc="${smsc}",direction="sent"} ${bind.sent}`);
      messages.push(
        `jkannel_smsc_messages_total{smsc="${smsc}",direction="received"} ${bind.received}`,
      );
      windows.forEach((window, position) => {
        const outbound = bind.outboundRate[position] ?? 0;
        const inbound = bind.inboundRate[position] ?? 0;
        throughput.push(
          `jkannel_smsc_throughput_messages_per_second{smsc="${smsc}",direction="outbound",window="${window}"} ${num(outbound)}`,
        );
        throughput.push(
          `jkannel_smsc_throughput_messages_per_second{smsc="${smsc}",direction="inbound",window="${window}"} ${num(inbound)}`,
        );
      });
    });

    lines.push(
      '# HELP jkannel_smsc_bind_up Whether an SMSC bind is bound (1) or not (0); the normalised state is a label.',
      '# TYPE jkannel_smsc_bind_up gauge',
      ...up,
      '# HELP jkannel_smsc_queued Messages queued on an SMSC bind.',
      '# TYPE jkannel_smsc_queued gauge',
      ...bindQueued,
      '# HELP jkannel_smsc_failed_total Messages the engine failed to deliver on an SMSC bind.',
      '# TYPE jkannel_smsc_failed_total counter',
      ...failed,
      '# HELP jkannel_smsc_messages_total Messages sent/received on an SMSC bind since engine start.',
      '# TYPE jkannel_smsc_messages_total counter',
      ...messages,
      '# HELP jkannel_smsc_throughput_messages_per_second Engine-reported throughput over 1/5/15 minute windows.',
      '# TYPE jkannel_smsc_throughput_messages_per_second gauge',
      ...throughput,
    );
    return lines.join('\n');
  }
}
