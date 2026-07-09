import { MetricsRegistry } from './metrics.registry';

describe('MetricsRegistry', () => {
  it('renders HTTP counters, latency histogram and named counters in Prometheus format', () => {
    const registry = new MetricsRegistry();
    registry.recordHttpRequest('GET', 200, 12);
    registry.recordHttpRequest('GET', 200, 300);
    registry.recordHttpRequest('POST', 500, 40);
    registry.incrementCounter('report_job_generated', 2);

    const out = registry.render();
    expect(out).toContain('jkannel_http_requests_total{method="GET",status="2xx"} 2');
    expect(out).toContain('jkannel_http_requests_total{method="POST",status="5xx"} 1');
    expect(out).toContain('jkannel_http_request_duration_ms_count 3');
    expect(out).toContain('jkannel_http_request_duration_ms_bucket{le="+Inf"} 3');
    expect(out).toContain('jkannel_events_total{event="report_job_generated"} 2');
    // 12ms and 40ms fall at or under 50ms; 300ms does not.
    expect(out).toContain('jkannel_http_request_duration_ms_bucket{le="50"} 2');
  });
});
