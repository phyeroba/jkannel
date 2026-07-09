import { Injectable } from '@nestjs/common';

/**
 * Minimal in-process Prometheus metrics registry. Deliberately dependency-free:
 * an HTTP request counter, a latency histogram, and named gauges/counters other
 * services (e.g. the report scheduler) can update. Multi-replica scrapes are
 * aggregated by Prometheus, so per-process counters are correct.
 */
@Injectable()
export class MetricsRegistry {
  private readonly httpRequests = new Map<string, number>();
  private readonly latencyBuckets = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
  private readonly latencyCounts = new Array(this.latencyBuckets.length + 1).fill(0);
  private latencySum = 0;
  private latencyTotal = 0;
  private readonly counters = new Map<string, number>();

  recordHttpRequest(method: string, statusCode: number, durationMs: number): void {
    const statusClass = `${Math.floor(statusCode / 100)}xx`;
    const key = `${method.toUpperCase()}|${statusClass}`;
    this.httpRequests.set(key, (this.httpRequests.get(key) ?? 0) + 1);
    this.latencySum += durationMs;
    this.latencyTotal += 1;
    const bucket = this.latencyBuckets.findIndex((upper) => durationMs <= upper);
    this.latencyCounts[bucket === -1 ? this.latencyBuckets.length : bucket] += 1;
  }

  incrementCounter(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  render(): string {
    const lines: string[] = [];
    lines.push('# HELP jkannel_http_requests_total HTTP requests by method and status class.');
    lines.push('# TYPE jkannel_http_requests_total counter');
    for (const [key, value] of this.httpRequests) {
      const [method, statusClass] = key.split('|');
      lines.push(
        `jkannel_http_requests_total{method="${method}",status="${statusClass}"} ${value}`,
      );
    }

    lines.push('# HELP jkannel_http_request_duration_ms Request latency histogram (milliseconds).');
    lines.push('# TYPE jkannel_http_request_duration_ms histogram');
    let cumulative = 0;
    this.latencyBuckets.forEach((upper, index) => {
      cumulative += this.latencyCounts[index];
      lines.push(`jkannel_http_request_duration_ms_bucket{le="${upper}"} ${cumulative}`);
    });
    cumulative += this.latencyCounts[this.latencyBuckets.length];
    lines.push(`jkannel_http_request_duration_ms_bucket{le="+Inf"} ${cumulative}`);
    lines.push(`jkannel_http_request_duration_ms_sum ${this.latencySum.toFixed(1)}`);
    lines.push(`jkannel_http_request_duration_ms_count ${this.latencyTotal}`);

    if (this.counters.size) {
      lines.push('# HELP jkannel_events_total Named platform event counters.');
      lines.push('# TYPE jkannel_events_total counter');
      for (const [name, value] of this.counters) {
        lines.push(`jkannel_events_total{event="${name}"} ${value}`);
      }
    }
    return lines.join('\n');
  }
}
